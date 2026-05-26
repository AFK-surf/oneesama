package slackagent

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
	"github.com/AFK-surf/oneesama/internal/postmeeting"
	_ "modernc.org/sqlite"
)

const (
	slackEpisodeRecallSourceTriageRun       = "triage_run"
	slackEpisodeRecallSourceApprovalSample  = "approval_sample"
	slackEpisodeRecallSourceWorkerJob       = "worker_job"
	slackEpisodeRecallSourceMeetingArtifact = "meeting_artifact"
)

type SlackEpisodeRecallRecord struct {
	ID         string         `json:"id"`
	Surface    string         `json:"surface"`
	SourceType string         `json:"source_type"`
	SourceRef  string         `json:"source_ref"`
	Title      string         `json:"title,omitempty"`
	Content    string         `json:"content"`
	Timestamp  string         `json:"timestamp,omitempty"`
	Metadata   map[string]any `json:"metadata,omitempty"`
}

type SlackEpisodeRecallSearchOptions struct {
	Limit       int
	Surface     string
	SourceTypes []string
}

type SlackEpisodeRecallSearchResult struct {
	SlackEpisodeRecallRecord
	MatchKind string  `json:"match_kind"`
	Rank      float64 `json:"rank,omitempty"`
}

type SlackEpisodeRecallStore struct {
	db *sql.DB
}

func OpenSlackEpisodeRecallStore(ctx context.Context, dbPath string) (*SlackEpisodeRecallStore, error) {
	dbPath = strings.TrimSpace(dbPath)
	if dbPath == "" {
		dbPath = ":memory:"
	}
	if dbPath != ":memory:" {
		if err := os.MkdirAll(filepath.Dir(dbPath), 0o755); err != nil {
			return nil, fmt.Errorf("create episode recall dir: %w", err)
		}
	}
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, fmt.Errorf("open episode recall sqlite: %w", err)
	}
	store := &SlackEpisodeRecallStore{db: db}
	if err := store.migrate(ctx); err != nil {
		_ = db.Close()
		return nil, err
	}
	return store, nil
}

func (s *SlackEpisodeRecallStore) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	return s.db.Close()
}

func (s *SlackEpisodeRecallStore) Index(ctx context.Context, record SlackEpisodeRecallRecord) error {
	if s == nil || s.db == nil {
		return nil
	}
	record = normalizeSlackEpisodeRecallRecord(record)
	if record.ID == "" {
		return fmt.Errorf("episode recall id is required")
	}
	if record.Content == "" && record.Title == "" {
		return fmt.Errorf("episode recall content is required")
	}
	metadata, err := json.Marshal(record.Metadata)
	if err != nil {
		return fmt.Errorf("marshal episode recall metadata: %w", err)
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin episode recall index: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `DELETE FROM episode_recall_fts WHERE id = ?`, record.ID); err != nil {
		return fmt.Errorf("delete episode recall fts row: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
INSERT OR REPLACE INTO episode_recall_records
(id, surface, source_type, source_ref, title, content, timestamp, metadata_json)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		record.ID, record.Surface, record.SourceType, record.SourceRef, record.Title, record.Content, record.Timestamp, string(metadata)); err != nil {
		return fmt.Errorf("write episode recall record: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO episode_recall_fts(id, surface, source_type, source_ref, title, content)
VALUES (?, ?, ?, ?, ?, ?)`,
		record.ID, record.Surface, record.SourceType, record.SourceRef, record.Title, record.Content); err != nil {
		return fmt.Errorf("write episode recall fts row: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit episode recall index: %w", err)
	}
	return nil
}

func (s *SlackEpisodeRecallStore) IndexMany(ctx context.Context, records []SlackEpisodeRecallRecord) error {
	for _, record := range records {
		if err := s.Index(ctx, record); err != nil {
			return err
		}
	}
	return nil
}

func (s *SlackEpisodeRecallStore) Search(ctx context.Context, query string, options SlackEpisodeRecallSearchOptions) ([]SlackEpisodeRecallSearchResult, error) {
	if s == nil || s.db == nil {
		return nil, nil
	}
	query = strings.TrimSpace(query)
	if query == "" {
		return nil, nil
	}
	limit := options.Limit
	if limit <= 0 {
		limit = 10
	}
	results := make([]SlackEpisodeRecallSearchResult, 0, limit)
	seen := map[string]struct{}{}
	if ftsQuery := slackEpisodeRecallFTSQuery(query); ftsQuery != "" {
		fts, err := s.searchFTS(ctx, ftsQuery, limit, options)
		if err == nil {
			for _, result := range fts {
				if _, ok := seen[result.ID]; ok {
					continue
				}
				seen[result.ID] = struct{}{}
				results = append(results, result)
			}
		}
	}
	if len(results) < limit {
		likeResults, err := s.searchLike(ctx, query, limit-len(results), options, seen)
		if err != nil {
			return nil, err
		}
		results = append(results, likeResults...)
	}
	return results, nil
}

func (s *SlackEpisodeRecallStore) migrate(ctx context.Context) error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS episode_recall_records (
			id TEXT PRIMARY KEY,
			surface TEXT NOT NULL,
			source_type TEXT NOT NULL,
			source_ref TEXT NOT NULL,
			title TEXT NOT NULL,
			content TEXT NOT NULL,
			timestamp TEXT NOT NULL,
			metadata_json TEXT NOT NULL
		)`,
		`CREATE VIRTUAL TABLE IF NOT EXISTS episode_recall_fts USING fts5(
			id UNINDEXED,
			surface,
			source_type,
			source_ref UNINDEXED,
			title,
			content,
			tokenize = 'unicode61'
		)`,
	}
	for _, stmt := range stmts {
		if _, err := s.db.ExecContext(ctx, stmt); err != nil {
			return fmt.Errorf("migrate episode recall: %w", err)
		}
	}
	return nil
}

func (s *SlackEpisodeRecallStore) searchFTS(ctx context.Context, ftsQuery string, limit int, options SlackEpisodeRecallSearchOptions) ([]SlackEpisodeRecallSearchResult, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT r.id, r.surface, r.source_type, r.source_ref, r.title, r.content, r.timestamp, r.metadata_json, bm25(episode_recall_fts) AS rank
FROM episode_recall_fts
JOIN episode_recall_records r ON r.id = episode_recall_fts.id
WHERE episode_recall_fts MATCH ?
ORDER BY rank ASC
LIMIT ?`, ftsQuery, limit*4)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []SlackEpisodeRecallSearchResult
	for rows.Next() {
		result, err := scanSlackEpisodeRecallSearchResult(rows, "fts")
		if err != nil {
			return nil, err
		}
		if !slackEpisodeRecallResultMatchesOptions(result.SlackEpisodeRecallRecord, options) {
			continue
		}
		out = append(out, result)
		if len(out) >= limit {
			break
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func (s *SlackEpisodeRecallStore) searchLike(ctx context.Context, query string, limit int, options SlackEpisodeRecallSearchOptions, seen map[string]struct{}) ([]SlackEpisodeRecallSearchResult, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT id, surface, source_type, source_ref, title, content, timestamp, metadata_json, 0.0 AS rank
FROM episode_recall_records
WHERE lower(title || ' ' || content || ' ' || source_ref) LIKE '%' || lower(?) || '%'
ORDER BY timestamp DESC, id ASC
LIMIT ?`, query, limit*4)
	if err != nil {
		return nil, fmt.Errorf("episode recall like search: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var out []SlackEpisodeRecallSearchResult
	for rows.Next() {
		result, err := scanSlackEpisodeRecallSearchResult(rows, "like")
		if err != nil {
			return nil, err
		}
		if _, ok := seen[result.ID]; ok {
			continue
		}
		if !slackEpisodeRecallResultMatchesOptions(result.SlackEpisodeRecallRecord, options) {
			continue
		}
		out = append(out, result)
		if len(out) >= limit {
			break
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func scanSlackEpisodeRecallSearchResult(rows interface {
	Scan(dest ...any) error
}, matchKind string) (SlackEpisodeRecallSearchResult, error) {
	var record SlackEpisodeRecallRecord
	var metadataJSON string
	var rank float64
	if err := rows.Scan(&record.ID, &record.Surface, &record.SourceType, &record.SourceRef, &record.Title, &record.Content, &record.Timestamp, &metadataJSON, &rank); err != nil {
		return SlackEpisodeRecallSearchResult{}, fmt.Errorf("scan episode recall result: %w", err)
	}
	if strings.TrimSpace(metadataJSON) != "" && strings.TrimSpace(metadataJSON) != "null" {
		_ = json.Unmarshal([]byte(metadataJSON), &record.Metadata)
	}
	return SlackEpisodeRecallSearchResult{SlackEpisodeRecallRecord: record, MatchKind: matchKind, Rank: rank}, nil
}

func SlackEpisodeRecallRecordFromTriageRun(run SlackTriageContext) SlackEpisodeRecallRecord {
	sourceRef := fmt.Sprintf("triage_run:%d", run.ID)
	if run.ID == 0 {
		sourceRef = firstNonEmpty(run.SessionID, "triage_run:unknown")
	}
	content := strings.Join([]string{
		run.Summary,
		run.Digest,
		slackEpisodeRecallActionsText(run.Actions),
		slackEpisodeRecallToolCallsText(run.ToolCalls),
	}, "\n")
	return SlackEpisodeRecallRecord{
		ID:         slackEpisodeRecallID(slackEpisodeRecallSourceTriageRun, sourceRef),
		Surface:    "slack",
		SourceType: slackEpisodeRecallSourceTriageRun,
		SourceRef:  sourceRef,
		Title:      "Slack triage run " + firstNonEmpty(fmt.Sprint(run.ID), run.SessionID),
		Content:    content,
		Timestamp:  run.Timestamp,
		Metadata: map[string]any{
			"status":   run.Status,
			"channels": run.Channels,
		},
	}
}

func SlackEpisodeRecallRecordFromVisibleReplySample(sample SlackVisibleReplyQualitySample) SlackEpisodeRecallRecord {
	sourceRef := fmt.Sprintf("approval_sample:%d", sample.PendingActionID)
	if sample.PendingActionID == 0 {
		sourceRef = firstNonEmpty(sample.CardID, sample.JobID, "approval_sample:unknown")
	}
	return SlackEpisodeRecallRecord{
		ID:         slackEpisodeRecallID(slackEpisodeRecallSourceApprovalSample, sourceRef),
		Surface:    "slack",
		SourceType: slackEpisodeRecallSourceApprovalSample,
		SourceRef:  sourceRef,
		Title:      "Slack visible reply approval " + firstNonEmpty(sample.CardID, fmt.Sprint(sample.PendingActionID)),
		Content: strings.Join([]string{
			sample.ProposedMessage,
			sample.ApprovalDecision,
			sample.RejectReason,
			sample.BlockReason,
			slackEpisodeRecallEvidenceAnchorsText(sample.EvidenceAnchors),
		}, "\n"),
		Timestamp: firstNonEmpty(sample.UpdatedAt, sample.CreatedAt),
		Metadata: map[string]any{
			"channel_id": sample.ChannelID,
			"thread_ts":  sample.ThreadTS,
			"job_id":     sample.JobID,
		},
	}
}

func SlackEpisodeRecallRecordFromWorkerJob(job agentrunner.Job) SlackEpisodeRecallRecord {
	sourceRef := "worker_job:" + strings.TrimSpace(job.ID)
	return SlackEpisodeRecallRecord{
		ID:         slackEpisodeRecallID(slackEpisodeRecallSourceWorkerJob, sourceRef),
		Surface:    "worker",
		SourceType: slackEpisodeRecallSourceWorkerJob,
		SourceRef:  sourceRef,
		Title:      "Worker job " + strings.TrimSpace(job.ID),
		Content: strings.Join([]string{
			job.Task,
			job.Result,
			job.Error,
			job.Debug,
		}, "\n"),
		Timestamp: firstNonEmpty(job.UpdatedAt, job.CreatedAt),
		Metadata: map[string]any{
			"provider":     job.Provider,
			"status":       string(job.Status),
			"failure_code": string(job.FailureCode),
			"mode":         job.Mode,
		},
	}
}

func SlackEpisodeRecallRecordFromMeetingArtifact(manifest postmeeting.ArtifactManifest) SlackEpisodeRecallRecord {
	sourceRef := "meeting_artifact:" + strings.TrimSpace(manifest.ID)
	content := strings.Join([]string{
		manifest.Title,
		manifest.MeetURL,
		strings.Join(manifest.Summary.Highlights, "\n"),
		strings.Join(manifest.Summary.Decisions, "\n"),
		strings.Join(manifest.Summary.ActionItems, "\n"),
		manifest.Files.TranscriptText,
		manifest.Files.Chat,
	}, "\n")
	return SlackEpisodeRecallRecord{
		ID:         slackEpisodeRecallID(slackEpisodeRecallSourceMeetingArtifact, sourceRef),
		Surface:    "meet",
		SourceType: slackEpisodeRecallSourceMeetingArtifact,
		SourceRef:  sourceRef,
		Title:      firstNonEmpty(manifest.Title, manifest.ID),
		Content:    content,
		Timestamp:  firstNonEmpty(manifest.UpdatedAt, manifest.CreatedAt),
		Metadata: map[string]any{
			"meeting_id": manifest.MeetingID,
			"session_id": manifest.SessionID,
			"dir":        manifest.Dir,
		},
	}
}

func normalizeSlackEpisodeRecallRecord(record SlackEpisodeRecallRecord) SlackEpisodeRecallRecord {
	record.Surface = strings.TrimSpace(record.Surface)
	record.SourceType = strings.TrimSpace(record.SourceType)
	record.SourceRef = strings.TrimSpace(record.SourceRef)
	record.Title = truncateSlackContextText(strings.TrimSpace(record.Title), 240)
	record.Content = truncateSlackContextText(strings.TrimSpace(record.Content), 4000)
	record.Timestamp = strings.TrimSpace(record.Timestamp)
	if record.Surface == "" {
		record.Surface = "unknown"
	}
	if record.SourceType == "" {
		record.SourceType = "unknown"
	}
	if record.SourceRef == "" {
		record.SourceRef = record.ID
	}
	if record.ID == "" {
		record.ID = slackEpisodeRecallID(record.SourceType, record.SourceRef)
	}
	if record.Metadata == nil {
		record.Metadata = map[string]any{}
	}
	return record
}

func slackEpisodeRecallID(sourceType string, sourceRef string) string {
	sourceType = strings.TrimSpace(sourceType)
	sourceRef = strings.TrimSpace(sourceRef)
	if strings.HasPrefix(sourceRef, sourceType+":") {
		return sourceRef
	}
	return sourceType + ":" + sourceRef
}

func slackEpisodeRecallFTSQuery(query string) string {
	terms := compactUniqueStrings(strings.Fields(query))
	if len(terms) == 0 && strings.TrimSpace(query) != "" {
		terms = []string{strings.TrimSpace(query)}
	}
	for i, term := range terms {
		terms[i] = `"` + strings.ReplaceAll(term, `"`, `""`) + `"`
	}
	return strings.Join(terms, " AND ")
}

func slackEpisodeRecallResultMatchesOptions(record SlackEpisodeRecallRecord, options SlackEpisodeRecallSearchOptions) bool {
	if strings.TrimSpace(options.Surface) != "" && record.Surface != strings.TrimSpace(options.Surface) {
		return false
	}
	if len(options.SourceTypes) > 0 && !slackMemoryFactContainsString(options.SourceTypes, record.SourceType) {
		return false
	}
	return true
}

func slackEpisodeRecallActionsText(actions []SlackTriageAction) string {
	var parts []string
	for _, action := range actions {
		parts = append(parts, strings.Join([]string{action.Tool, action.Channel, action.Brief}, " "))
	}
	return strings.Join(parts, "\n")
}

func slackEpisodeRecallToolCallsText(calls []SlackTriageToolCall) string {
	var parts []string
	for _, call := range calls {
		parts = append(parts, strings.Join([]string{call.Tool, call.Action, call.Brief, call.Result}, " "))
	}
	return strings.Join(parts, "\n")
}

func slackEpisodeRecallEvidenceAnchorsText(anchors []SlackVisibleEvidenceAnchor) string {
	var parts []string
	for _, anchor := range anchors {
		parts = append(parts, strings.Join([]string{anchor.Kind, anchor.SourceRef, anchor.Quote}, " "))
	}
	sort.Strings(parts)
	return strings.Join(parts, "\n")
}
