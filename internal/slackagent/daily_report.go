package slackagent

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/AFK-surf/oneesama/internal/persistence"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
	_ "modernc.org/sqlite"
)

const (
	slackDailyReportsCollection = "slack_daily_reports"
	slackDailyReportDefaultTime = "18:00"
	slackDailyReportDefaultTZ   = "Asia/Shanghai"
)

var slackEmojiNamePattern = regexp.MustCompile(`:([a-zA-Z0-9_+\-]+):`)
var slackDailyReportTodoPlaceholderPattern = regexp.MustCompile(`\bTODO\b`)

type SlackDailyReportStatus struct {
	Enabled          bool   `json:"enabled"`
	Running          bool   `json:"running"`
	ChannelID        string `json:"channel_id,omitempty"`
	TimeOfDay        string `json:"time_of_day"`
	Timezone         string `json:"timezone"`
	WindowSeconds    int64  `json:"window_seconds"`
	NextRunAt        string `json:"next_run_at,omitempty"`
	LastTickAt       string `json:"last_tick_at,omitempty"`
	LastPostedAt     string `json:"last_posted_at,omitempty"`
	LastChannelID    string `json:"last_channel_id,omitempty"`
	LastError        string `json:"last_error,omitempty"`
	TicksLastWindow  int    `json:"ticks_last_window"`
	LegacyDBPath     string `json:"legacy_db_path,omitempty"`
	LegacyArchiveDir string `json:"legacy_archive_dir,omitempty"`
}

type SlackDailyReportRunRequest struct {
	ChannelID  string `json:"channel_id,omitempty"`
	ReportDate string `json:"report_date,omitempty"`
	Window     string `json:"window,omitempty"`
	DryRun     bool   `json:"dry_run,omitempty"`
	Force      bool   `json:"force,omitempty"`
}

type SlackDailyReportRunResponse struct {
	OK      bool                    `json:"ok"`
	Report  SlackDailyReport        `json:"report"`
	Post    *PostMessageResult      `json:"post,omitempty"`
	Skipped bool                    `json:"skipped,omitempty"`
	Reason  string                  `json:"reason,omitempty"`
	Record  *SlackDailyReportRecord `json:"record,omitempty"`
}

type SlackDailyReport struct {
	GeneratedAt string                     `json:"generated_at"`
	ReportDate  string                     `json:"report_date"`
	WindowStart string                     `json:"window_start"`
	WindowEnd   string                     `json:"window_end"`
	WindowHours float64                    `json:"window_hours"`
	New         SlackDailyTriageMetrics    `json:"new_oneesama"`
	Legacy      SlackDailyTriageMetrics    `json:"legacy_slackd"`
	Comparison  SlackDailyTriageComparison `json:"comparison"`
	Diary       SlackDailyDiary            `json:"diary"`
	Flags       []SlackDailyReportFlag     `json:"flags,omitempty"`
	Text        string                     `json:"text"`
}

type SlackDailyDiary struct {
	Intro     string                     `json:"intro"`
	Themes    []SlackDailyDiaryTheme     `json:"themes,omitempty"`
	Watchlist []string                   `json:"watchlist,omitempty"`
	Sources   SlackDailyDiarySourceCount `json:"sources"`
}

type SlackDailyDiaryTheme struct {
	Title string                `json:"title"`
	Items []SlackDailyDiaryItem `json:"items,omitempty"`
}

type SlackDailyDiaryItem struct {
	Channel string `json:"channel,omitempty"`
	Time    string `json:"time,omitempty"`
	Text    string `json:"text"`
	Source  string `json:"source"`
}

type SlackDailyDiarySourceCount struct {
	NewRuns    int `json:"new_runs"`
	LegacyRuns int `json:"legacy_runs"`
}

type SlackDailyTriageMetrics struct {
	Source                        string         `json:"source"`
	Available                     bool           `json:"available"`
	Error                         string         `json:"error,omitempty"`
	Runs                          int            `json:"runs"`
	FailedRuns                    int            `json:"failed_runs"`
	MutatingRuns                  int            `json:"mutating_runs"`
	Mutations                     int            `json:"mutations"`
	ReplyRuns                     int            `json:"reply_runs"`
	ReactionRuns                  int            `json:"reaction_runs"`
	ReactionMutations             int            `json:"reaction_mutations"`
	CustomEmojiRuns               int            `json:"custom_emoji_runs"`
	CustomEmojiUses               int            `json:"custom_emoji_uses"`
	NoActionRuns                  int            `json:"no_action_runs"`
	ParseFallbacks                int            `json:"parse_fallbacks"`
	PlaceholderSummaries          int            `json:"placeholder_summaries"`
	InvalidPersonaJSON            int            `json:"invalid_persona_json"`
	HighContextNoAction           int            `json:"high_context_no_action"`
	LinkContextRuns               int            `json:"link_context_runs"`
	LinkContextNoAction           int            `json:"link_context_no_action"`
	LinkReplies                   int            `json:"link_replies"`
	LowConfidenceNoAction         int            `json:"low_confidence_no_action"`
	DynamicContextIssues          int            `json:"dynamic_context_issues"`
	MaxContextBudgetTokens        int            `json:"max_context_budget_tokens,omitempty"`
	MaxDynamicContextTokens       int            `json:"max_dynamic_context_tokens,omitempty"`
	MaxWorkerResultTokens         int            `json:"max_worker_result_tokens,omitempty"`
	MaxMemoryEvidenceTokens       int            `json:"max_memory_evidence_tokens,omitempty"`
	IntentActionMismatch          int            `json:"intent_action_mismatch"`
	DelegateNoVisibleAction       int            `json:"delegate_no_visible_action"`
	HandledByOtherNoAction        int            `json:"handled_by_other_no_action"`
	DirectedToActiveAgentNoAction int            `json:"directed_to_active_agent_no_action"`
	ToolCalls                     int            `json:"tool_calls"`
	MemoryLookups                 int            `json:"memory_lookups"`
	ExternalSearches              int            `json:"external_searches"`
	ThreadFetches                 int            `json:"thread_fetches"`
	PersonaRuns                   int            `json:"persona_runs,omitempty"`
	PersonaFailures               int            `json:"persona_failures,omitempty"`
	DelegateWorkerJobs            int            `json:"delegate_worker_jobs,omitempty"`
	TopEmoji                      map[string]int `json:"top_emoji,omitempty"`
	TopCustomEmoji                map[string]int `json:"top_custom_emoji,omitempty"`
	ReplySamples                  []string       `json:"reply_samples,omitempty"`
	ReactionSamples               []string       `json:"reaction_samples,omitempty"`
	SkippedSamples                []string       `json:"skipped_samples,omitempty"`
	FailedSamples                 []string       `json:"failed_samples,omitempty"`
}

type SlackDailyTriageComparison struct {
	RunDelta              int     `json:"run_delta"`
	ReplyRunDelta         int     `json:"reply_run_delta"`
	ReactionRunDelta      int     `json:"reaction_run_delta"`
	CustomEmojiUseDelta   int     `json:"custom_emoji_use_delta"`
	FailureDelta          int     `json:"failure_delta"`
	NewReplyRate          float64 `json:"new_reply_rate"`
	LegacyReplyRate       float64 `json:"legacy_reply_rate"`
	NewReactionRate       float64 `json:"new_reaction_rate"`
	LegacyReactionRate    float64 `json:"legacy_reaction_rate"`
	NewCustomEmojiRate    float64 `json:"new_custom_emoji_rate"`
	LegacyCustomEmojiRate float64 `json:"legacy_custom_emoji_rate"`
}

type SlackDailyReportFlag struct {
	Level   string `json:"level"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

type SlackDailyReportRecord struct {
	ID          string            `json:"id"`
	ReportDate  string            `json:"report_date"`
	ChannelID   string            `json:"channel_id"`
	PostedAt    string            `json:"posted_at"`
	WindowStart string            `json:"window_start"`
	WindowEnd   string            `json:"window_end"`
	Post        PostMessageResult `json:"post"`
	Summary     string            `json:"summary"`
}

type slackDailyReportStore struct {
	reports *persistence.TypedCollection[SlackDailyReportRecord]
}

func newSlackDailyReportStore(cfg appconfig.PersistenceConfig, logger warnLogger) *slackDailyReportStore {
	reports, err := persistence.OpenTyped[SlackDailyReportRecord](persistence.Options{
		Provider:   persistence.NormalizeProvider(cfg.Provider),
		Collection: slackDailyReportsCollection,
		DataDir:    cfg.DataDir,
		SQLitePath: cfg.SQLitePath,
	})
	if err != nil {
		if logger != nil {
			logger.Warn("slack daily report store init failed", "error", err)
		}
		return nil
	}
	return &slackDailyReportStore{reports: reports}
}

func (s *slackDailyReportStore) Get(ctx context.Context, id string) (SlackDailyReportRecord, bool, error) {
	if s == nil || s.reports == nil || strings.TrimSpace(id) == "" {
		return SlackDailyReportRecord{}, false, nil
	}
	return s.reports.Get(ctx, id)
}

func (s *slackDailyReportStore) Set(ctx context.Context, record SlackDailyReportRecord) error {
	if s == nil || s.reports == nil {
		return nil
	}
	if strings.TrimSpace(record.ID) == "" {
		record.ID = dailyReportRecordID(record.ChannelID, record.ReportDate)
	}
	return s.reports.Set(ctx, record.ID, record)
}

func normalizeSlackDailyReportConfig(cfg appconfig.SlackDailyReportConfig) appconfig.SlackDailyReportConfig {
	cfg.ChannelID = strings.TrimSpace(cfg.ChannelID)
	cfg.TimeOfDay = strings.TrimSpace(cfg.TimeOfDay)
	if cfg.TimeOfDay == "" {
		cfg.TimeOfDay = slackDailyReportDefaultTime
	}
	cfg.Timezone = strings.TrimSpace(cfg.Timezone)
	if cfg.Timezone == "" {
		cfg.Timezone = slackDailyReportDefaultTZ
	}
	if cfg.Window <= 0 {
		cfg.Window = 24 * time.Hour
	}
	cfg.LegacySlackDBPath = strings.TrimSpace(cfg.LegacySlackDBPath)
	cfg.LegacyTriageArchiveDir = strings.TrimSpace(cfg.LegacyTriageArchiveDir)
	return cfg
}

func (s *Service) startDailyReportTicker() {
	if s == nil || !s.dailyReportConfig.Enabled || strings.TrimSpace(s.dailyReportConfig.ChannelID) == "" {
		return
	}
	s.dailyReportMu.Lock()
	defer s.dailyReportMu.Unlock()
	if s.dailyReportCancel != nil {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.dailyReportCancel = cancel
	go s.runDailyReportTicker(ctx)
}

func (s *Service) stopDailyReportTicker() {
	if s == nil {
		return
	}
	s.dailyReportMu.Lock()
	cancel := s.dailyReportCancel
	s.dailyReportCancel = nil
	s.dailyReportMu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (s *Service) runDailyReportTicker(ctx context.Context) {
	for {
		next, err := nextSlackDailyReportRun(timeNow().UTC(), s.dailyReportConfig)
		if err != nil {
			s.recordDailyReportTick(timeNow().UTC(), "", err)
			return
		}
		delay := time.Until(next)
		if delay < 0 {
			delay = 0
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
		response, err := s.RunDailyReport(ctx, SlackDailyReportRunRequest{})
		channel := strings.TrimSpace(s.dailyReportConfig.ChannelID)
		if response.Post != nil {
			channel = response.Post.Channel
		}
		s.recordDailyReportTick(timeNow().UTC(), channel, err)
		if err != nil {
			s.logger.Warn("slack daily report failed", "error", err)
		} else if response.Post != nil && response.Post.OK {
			s.logger.Info("slack daily report posted", "channel", response.Post.Channel, "ts", response.Post.TS, "report_date", response.Report.ReportDate)
		}
	}
}

func (s *Service) RunDailyReport(ctx context.Context, request SlackDailyReportRunRequest) (SlackDailyReportRunResponse, error) {
	if s == nil {
		return SlackDailyReportRunResponse{}, fmt.Errorf("service is required")
	}
	cfg := s.dailyReportConfig
	channelID := strings.TrimSpace(firstNonEmpty(request.ChannelID, cfg.ChannelID))
	window := cfg.Window
	if strings.TrimSpace(request.Window) != "" {
		parsed, err := time.ParseDuration(strings.TrimSpace(request.Window))
		if err != nil || parsed <= 0 {
			return SlackDailyReportRunResponse{}, fmt.Errorf("invalid daily report window %q", request.Window)
		}
		window = parsed
	}
	windowStart, windowEnd, reportDate, err := slackDailyReportWindow(timeNow().UTC(), window, cfg.Timezone, request.ReportDate)
	if err != nil {
		return SlackDailyReportRunResponse{}, err
	}
	report, err := s.BuildDailyReport(ctx, windowStart, windowEnd, reportDate)
	if err != nil {
		return SlackDailyReportRunResponse{}, err
	}
	response := SlackDailyReportRunResponse{OK: true, Report: report}
	if request.DryRun {
		return response, nil
	}
	if channelID == "" {
		return response, fmt.Errorf("daily report channel is required")
	}
	recordID := dailyReportRecordID(channelID, reportDate)
	if !request.Force {
		if previous, ok, err := s.dailyReports.Get(ctx, recordID); err != nil {
			return response, err
		} else if ok {
			response.Skipped = true
			response.Reason = "already_posted"
			response.Record = &previous
			return response, nil
		}
	}
	postCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	post := s.poster.PostMessage(postCtx, PostMessageInput{
		Channel:  channelID,
		Text:     report.Text,
		DedupKey: "daily-report:" + recordID,
	})
	response.Post = &post
	if !post.OK {
		s.recordDailyReportPost(timeNow().UTC(), channelID, fmt.Errorf("post daily report: %s", firstNonEmpty(post.Error, post.Detail, "slack_post_failed")))
		return response, fmt.Errorf("post daily report: %s", firstNonEmpty(post.Error, post.Detail, "slack_post_failed"))
	}
	record := SlackDailyReportRecord{
		ID:          recordID,
		ReportDate:  reportDate,
		ChannelID:   channelID,
		PostedAt:    timeNow().UTC().Format(time.RFC3339Nano),
		WindowStart: report.WindowStart,
		WindowEnd:   report.WindowEnd,
		Post:        post,
		Summary:     firstLine(report.Text),
	}
	if err := s.dailyReports.Set(ctx, record); err != nil {
		return response, err
	}
	s.recordDailyReportPost(timeNow().UTC(), channelID, nil)
	response.Record = &record
	return response, nil
}

func (s *Service) BuildDailyReport(ctx context.Context, windowStart time.Time, windowEnd time.Time, reportDate string) (SlackDailyReport, error) {
	if windowEnd.IsZero() {
		windowEnd = timeNow().UTC()
	}
	if windowStart.IsZero() || !windowStart.Before(windowEnd) {
		windowStart = windowEnd.Add(-s.dailyReportConfig.Window)
	}
	runs, err := s.triage.ListRuns(ctx, 10000)
	if err != nil {
		return SlackDailyReport{}, err
	}
	windowRuns := filterTriageRunsSince(runs, windowStart, windowEnd)
	customEmoji := s.workspaceCustomEmojiSnapshot()
	newMetrics := buildSlackDailyTriageMetrics("new_oneesama", windowRuns, customEmoji)
	legacyRuns, legacyErr := loadLegacySlackdDailyTriageRuns(ctx, s.dailyReportConfig, windowStart, windowEnd)
	legacyMetrics := buildSlackDailyTriageMetrics("legacy_slackd", legacyRuns, customEmoji)
	legacyMetrics.Available = legacyErr == nil
	if legacyErr != nil {
		legacyMetrics.Error = legacyErr.Error()
	}
	comparison := compareSlackDailyTriageMetrics(newMetrics, legacyMetrics)
	report := SlackDailyReport{
		GeneratedAt: timeNow().UTC().Format(time.RFC3339Nano),
		ReportDate:  reportDate,
		WindowStart: windowStart.UTC().Format(time.RFC3339Nano),
		WindowEnd:   windowEnd.UTC().Format(time.RFC3339Nano),
		WindowHours: windowEnd.Sub(windowStart).Hours(),
		New:         newMetrics,
		Legacy:      legacyMetrics,
		Comparison:  comparison,
	}
	report.Diary = buildSlackDailyDiary(windowRuns, legacyRuns)
	report.Flags = buildSlackDailyReportFlags(report)
	report.Text = formatSlackDailyReportText(report)
	return report, nil
}

func loadLegacySlackdDailyTriageRuns(ctx context.Context, cfg appconfig.SlackDailyReportConfig, start time.Time, end time.Time) ([]SlackTriageContext, error) {
	if path := strings.TrimSpace(cfg.LegacySlackDBPath); path != "" {
		if _, err := os.Stat(path); err == nil {
			runs, err := loadLegacySlackdTriageRunsFromDB(ctx, path, start, end)
			if err == nil {
				return runs, nil
			}
			if strings.TrimSpace(cfg.LegacyTriageArchiveDir) == "" {
				return nil, err
			}
		}
	}
	if dir := strings.TrimSpace(cfg.LegacyTriageArchiveDir); dir != "" {
		return loadLegacySlackdTriageRunsFromArchive(dir, start, end)
	}
	return nil, errors.New("legacy slackd triage source not configured")
}

func loadLegacySlackdTriageRunsFromDB(ctx context.Context, path string, start time.Time, end time.Time) ([]SlackTriageContext, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	defer db.Close()
	rows, err := db.QueryContext(ctx, `select id, session_id, occurred_at, status, summary, error, digest, steps, duration_seconds, mutations, failures, tokens_used, channels_json, raw_output from triage_run where unixepoch(occurred_at) >= unixepoch(?) and unixepoch(occurred_at) <= unixepoch(?) order by occurred_at asc, id asc`, start.UTC().Format(time.RFC3339Nano), end.UTC().Format(time.RFC3339Nano))
	if err != nil {
		return nil, fmt.Errorf("query legacy triage_run: %w", err)
	}
	defer rows.Close()
	var runs []SlackTriageContext
	runIndexByID := map[int64]int{}
	for rows.Next() {
		var run SlackTriageContext
		var channelsJSON string
		var rawTime string
		if err := rows.Scan(&run.ID, &run.SessionID, &rawTime, &run.Status, &run.Summary, &run.Error, &run.Digest, &run.Steps, &run.DurationSeconds, &run.Mutations, &run.Failures, &run.TokensUsed, &channelsJSON, &run.RawOutput); err != nil {
			return nil, fmt.Errorf("scan legacy triage_run: %w", err)
		}
		run.Timestamp = normalizeLegacyTriageTimestamp(rawTime)
		_ = json.Unmarshal([]byte(channelsJSON), &run.Channels)
		runs = append(runs, run)
		runIndexByID[run.ID] = len(runs) - 1
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(runs) == 0 {
		return runs, nil
	}
	if err := attachLegacyTriageActionsAndTools(ctx, db, runs, runIndexByID); err != nil {
		return nil, err
	}
	return runs, nil
}

func attachLegacyTriageActionsAndTools(ctx context.Context, db *sql.DB, runs []SlackTriageContext, runIndexByID map[int64]int) error {
	actions, err := db.QueryContext(ctx, `select run_id, tool, channel, brief from triage_action order by run_id asc, position asc, id asc`)
	if err != nil {
		return fmt.Errorf("query legacy triage_action: %w", err)
	}
	defer actions.Close()
	for actions.Next() {
		var runID int64
		var action SlackTriageAction
		if err := actions.Scan(&runID, &action.Tool, &action.Channel, &action.Brief); err != nil {
			return err
		}
		if index, ok := runIndexByID[runID]; ok {
			runs[index].Actions = append(runs[index].Actions, action)
		}
	}
	if err := actions.Err(); err != nil {
		return err
	}
	tools, err := db.QueryContext(ctx, `select run_id, tool, action, args, success, brief, result from triage_tool_call order by run_id asc, position asc, id asc`)
	if err != nil {
		return fmt.Errorf("query legacy triage_tool_call: %w", err)
	}
	defer tools.Close()
	for tools.Next() {
		var runID int64
		var call SlackTriageToolCall
		var success int
		if err := tools.Scan(&runID, &call.Tool, &call.Action, &call.Args, &success, &call.Brief, &call.Result); err != nil {
			return err
		}
		call.Success = success != 0
		if index, ok := runIndexByID[runID]; ok {
			runs[index].ToolCalls = append(runs[index].ToolCalls, call)
		}
	}
	return tools.Err()
}

func loadLegacySlackdTriageRunsFromArchive(dir string, start time.Time, end time.Time) ([]SlackTriageContext, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("read legacy triage archive: %w", err)
	}
	var runs []SlackTriageContext
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		path := filepath.Join(dir, entry.Name())
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var fileRuns []SlackTriageContext
		if err := json.Unmarshal(data, &fileRuns); err != nil {
			continue
		}
		for _, run := range fileRuns {
			t := parseLegacyTriageTimestamp(run.Timestamp)
			if t.IsZero() || t.Before(start.UTC()) || t.After(end.UTC()) {
				continue
			}
			run.Timestamp = t.UTC().Format(time.RFC3339Nano)
			runs = append(runs, run)
		}
	}
	sort.SliceStable(runs, func(i, j int) bool {
		return parseTriageTimestamp(runs[i].Timestamp).Before(parseTriageTimestamp(runs[j].Timestamp))
	})
	return runs, nil
}

func buildSlackDailyTriageMetrics(source string, runs []SlackTriageContext, customEmoji []string) SlackDailyTriageMetrics {
	custom := map[string]struct{}{}
	for _, name := range normalizeWorkspaceCustomEmojiNames(customEmoji) {
		custom[name] = struct{}{}
	}
	metrics := SlackDailyTriageMetrics{
		Source:         source,
		Available:      true,
		TopEmoji:       map[string]int{},
		TopCustomEmoji: map[string]int{},
	}
	for _, run := range runs {
		metrics.Runs++
		if slackTriageRunFailed(run) {
			metrics.FailedRuns++
			metrics.FailedSamples = appendLimitedString(metrics.FailedSamples, slackDailyReportRunSample(run, firstNonEmpty(run.Error, run.Summary, "failed")), 8)
		}
		if run.Mutations > 0 {
			metrics.MutatingRuns++
		}
		metrics.Mutations += run.Mutations
		if len(run.Actions) == 0 && run.Mutations == 0 {
			metrics.NoActionRuns++
			metrics.SkippedSamples = appendLimitedString(metrics.SkippedSamples, slackDailyReportRunSample(run, firstNonEmpty(run.Summary, "no visible action")), 8)
		}
		if slackTriageRunParseFallback(run) {
			metrics.ParseFallbacks++
		}
		if slackDailyReportPlaceholderSummary(run) {
			metrics.PlaceholderSummaries++
		}
		if slackDailyReportInvalidPersonaJSON(run) {
			metrics.InvalidPersonaJSON++
		}
		inputChars := intFromAny(run.Metadata["input_context_chars"])
		if value := intFromAny(run.Metadata["context_budget_total_tokens"]); value > metrics.MaxContextBudgetTokens {
			metrics.MaxContextBudgetTokens = value
		}
		if value := intFromAny(run.Metadata["context_budget_dynamic_tokens"]); value > metrics.MaxDynamicContextTokens {
			metrics.MaxDynamicContextTokens = value
		}
		if value := intFromAny(run.Metadata["context_budget_worker_result_tokens"]); value > metrics.MaxWorkerResultTokens {
			metrics.MaxWorkerResultTokens = value
		}
		if value := intFromAny(run.Metadata["context_budget_memory_evidence_tokens"]); value > metrics.MaxMemoryEvidenceTokens {
			metrics.MaxMemoryEvidenceTokens = value
		}
		externalLinks := intFromAny(run.Metadata["external_links_fetched"])
		if externalLinks > 0 {
			metrics.LinkContextRuns++
		}
		// Task #285 follow-up #3: when the no-action summary describes another
		// agent already handling the thread, count it under the info-tier
		// HandledByOtherNoAction bucket and skip the review-tier high-context
		// / link-context / low-confidence / intent-mismatch buckets so review
		// queues stay focused on real "something might be wrong" candidates.
		directedToActiveAgent := false
		if len(run.Actions) == 0 && run.Mutations == 0 {
			_, directedToActiveAgent = triageQualityRunDirectedToActiveAgent(run)
		}
		handledByOther := len(run.Actions) == 0 && run.Mutations == 0 && !directedToActiveAgent && triageQualityRunIsHandledByOther(run.Summary) != ""
		dynamicContextIssue := len(run.Actions) == 0 && run.Mutations == 0
		if _, ok := triageQualityRunDynamicContextIssue(run); !ok {
			dynamicContextIssue = false
		}
		delegateStartedPending := false
		if evidence, ok := triageQualityRunDelegateNoVisibleAction(run); ok && !triageQualityDelegateNeedsOperatorReview(evidence) {
			delegateStartedPending = true
		}
		if dynamicContextIssue {
			metrics.DynamicContextIssues++
		}
		if handledByOther {
			metrics.HandledByOtherNoAction++
		}
		if directedToActiveAgent {
			metrics.DirectedToActiveAgentNoAction++
		}
		if !dynamicContextIssue && !directedToActiveAgent && !handledByOther && !delegateStartedPending {
			if inputChars >= triageQualityHighContextInputCharsThreshold && len(run.Actions) == 0 && run.Mutations == 0 {
				metrics.HighContextNoAction++
			}
			if externalLinks > 0 && len(run.Actions) == 0 && run.Mutations == 0 {
				metrics.LinkContextNoAction++
			}
			if slackDailyReportLowConfidenceNoAction(run) {
				metrics.LowConfidenceNoAction++
			}
			if len(run.Actions) == 0 && run.Mutations == 0 {
				// Bucket precedence matches buildSlackTriageReviewBuckets:
				// delegate_no_visible_action takes priority over the
				// summary-narrative intent_action_mismatch bucket.
				if evidence, ok := triageQualityRunDelegateNoVisibleAction(run); ok && triageQualityDelegateNeedsOperatorReview(evidence) {
					metrics.DelegateNoVisibleAction++
				} else if triageQualityIntentActionMismatchMatch(run.Summary) != "" {
					metrics.IntentActionMismatch++
				}
			}
		}
		if raw, ok := mapFromAny(run.Metadata["persona_foreground"]); ok {
			metrics.PersonaRuns++
			if !boolFromAny(raw["success"], false) {
				metrics.PersonaFailures++
			}
		}
		metrics.DelegateWorkerJobs += intFromAny(run.Metadata["delegate_worker_jobs_started"])
		replyRun := false
		reactionRun := false
		customReactionRun := false
		for _, action := range run.Actions {
			if slackDailyReportActionIsReply(action.Tool) {
				replyRun = true
				metrics.ReplySamples = appendLimitedString(metrics.ReplySamples, slackDailyReportRunSample(run, firstNonEmpty(action.Brief, run.Summary, "posted reply")), 8)
			}
			if slackDailyReportActionIsReaction(action.Tool) {
				reactionRun = true
				metrics.ReactionSamples = appendLimitedString(metrics.ReactionSamples, slackDailyReportRunSample(run, firstNonEmpty(action.Brief, run.Summary, "added reaction")), 8)
				for _, emoji := range slackDailyReportExtractEmoji(action.Brief) {
					metrics.ReactionMutations++
					metrics.TopEmoji[emoji]++
					if _, ok := custom[emoji]; ok {
						customReactionRun = true
						metrics.CustomEmojiUses++
						metrics.TopCustomEmoji[emoji]++
					}
				}
			}
		}
		for _, call := range run.ToolCalls {
			metrics.ToolCalls++
			if slackDailyReportToolCallIsMemoryLookup(call) {
				metrics.MemoryLookups++
			}
			if slackDailyReportToolCallIsExternalSearch(call) {
				metrics.ExternalSearches++
			}
			if slackDailyReportToolCallIsThreadFetch(call) {
				metrics.ThreadFetches++
			}
			if slackDailyReportActionIsReply(firstNonEmpty(call.Action, call.Tool)) {
				replyRun = true
				metrics.ReplySamples = appendLimitedString(metrics.ReplySamples, slackDailyReportRunSample(run, firstNonEmpty(call.Brief, run.Summary, "posted reply")), 8)
			}
			if slackDailyReportActionIsReaction(firstNonEmpty(call.Action, call.Tool)) && call.Success {
				reactionRun = true
				metrics.ReactionSamples = appendLimitedString(metrics.ReactionSamples, slackDailyReportRunSample(run, firstNonEmpty(call.Brief, call.Result, run.Summary, "added reaction")), 8)
				emojis := slackDailyReportExtractEmoji(call.Brief)
				if len(emojis) == 0 {
					emojis = slackDailyReportExtractEmoji(call.Result)
				}
				for _, emoji := range emojis {
					metrics.ReactionMutations++
					metrics.TopEmoji[emoji]++
					if _, ok := custom[emoji]; ok {
						customReactionRun = true
						metrics.CustomEmojiUses++
						metrics.TopCustomEmoji[emoji]++
					}
				}
			}
		}
		if replyRun {
			metrics.ReplyRuns++
			if externalLinks > 0 {
				metrics.LinkReplies++
			}
		}
		if reactionRun {
			metrics.ReactionRuns++
		}
		if customReactionRun {
			metrics.CustomEmojiRuns++
		}
	}
	metrics.TopEmoji = topNStringInt(metrics.TopEmoji, 8)
	metrics.TopCustomEmoji = topNStringInt(metrics.TopCustomEmoji, 8)
	return metrics
}

func compareSlackDailyTriageMetrics(newMetrics SlackDailyTriageMetrics, legacy SlackDailyTriageMetrics) SlackDailyTriageComparison {
	return SlackDailyTriageComparison{
		RunDelta:              newMetrics.Runs - legacy.Runs,
		ReplyRunDelta:         newMetrics.ReplyRuns - legacy.ReplyRuns,
		ReactionRunDelta:      newMetrics.ReactionRuns - legacy.ReactionRuns,
		CustomEmojiUseDelta:   newMetrics.CustomEmojiUses - legacy.CustomEmojiUses,
		FailureDelta:          newMetrics.FailedRuns - legacy.FailedRuns,
		NewReplyRate:          ratioPercent(newMetrics.ReplyRuns, newMetrics.Runs),
		LegacyReplyRate:       ratioPercent(legacy.ReplyRuns, legacy.Runs),
		NewReactionRate:       ratioPercent(newMetrics.ReactionRuns, newMetrics.Runs),
		LegacyReactionRate:    ratioPercent(legacy.ReactionRuns, legacy.Runs),
		NewCustomEmojiRate:    ratioPercent(newMetrics.CustomEmojiUses, maxInt(newMetrics.ReactionMutations, 1)),
		LegacyCustomEmojiRate: ratioPercent(legacy.CustomEmojiUses, maxInt(legacy.ReactionMutations, 1)),
	}
}

func buildSlackDailyReportFlags(report SlackDailyReport) []SlackDailyReportFlag {
	var flags []SlackDailyReportFlag
	if !report.Legacy.Available {
		flags = append(flags, SlackDailyReportFlag{Level: "yellow", Code: "legacy_unavailable", Message: "Legacy slackd source is unavailable; daily comparison is partial."})
	}
	if report.New.FailedRuns > 0 || report.New.InvalidPersonaJSON > 0 || report.New.PlaceholderSummaries > 0 {
		flags = append(flags, SlackDailyReportFlag{Level: "red", Code: "new_triage_quality_red", Message: "New Oneesama had failed/invalid/placeholder triage samples."})
	}
	if report.New.Runs > 0 && report.Legacy.Available && report.Legacy.ReactionRuns > 0 && report.New.ReactionRuns == 0 {
		flags = append(flags, SlackDailyReportFlag{Level: "yellow", Code: "reaction_gap", Message: "Legacy slackd used emoji reactions but new Oneesama did not in this window."})
	}
	if report.New.ReactionRuns > 0 && report.New.CustomEmojiUses == 0 && len(report.New.TopEmoji) > 0 {
		flags = append(flags, SlackDailyReportFlag{Level: "yellow", Code: "custom_emoji_gap", Message: "New Oneesama reacted but did not use workspace custom emoji."})
	}
	if report.New.LinkContextNoAction > 0 {
		flags = append(flags, SlackDailyReportFlag{Level: "yellow", Code: "link_context_no_action", Message: "Some fetched-link triage samples stayed silent; review whether workspace commentary should have fired."})
	}
	if report.New.DynamicContextIssues > 0 {
		flags = append(flags, SlackDailyReportFlag{Level: "yellow", Code: "dynamic_context_issue", Message: "Some persona runs had missing, incomplete, or stale dynamic context envelopes."})
	}
	if report.New.DelegateNoVisibleAction > 0 {
		flags = append(flags, SlackDailyReportFlag{Level: "yellow", Code: "delegate_no_visible_action", Message: "Some persona delegate_worker decisions had no visible downstream worker action in triage audit."})
	}
	return flags
}

type slackDailyDiaryCandidate struct {
	item  SlackDailyDiaryItem
	theme string
	score int
	at    time.Time
	key   string
}

func buildSlackDailyDiary(newRuns []SlackTriageContext, legacyRuns []SlackTriageContext) SlackDailyDiary {
	diary := SlackDailyDiary{
		Sources: SlackDailyDiarySourceCount{NewRuns: len(newRuns), LegacyRuns: len(legacyRuns)},
	}
	candidates := make([]slackDailyDiaryCandidate, 0, len(newRuns)+len(legacyRuns))
	for _, run := range newRuns {
		if candidate, ok := slackDailyDiaryCandidateForRun(run, "new_oneesama"); ok {
			candidates = append(candidates, candidate)
		}
	}
	for _, run := range legacyRuns {
		if candidate, ok := slackDailyDiaryCandidateForRun(run, "legacy_slackd"); ok {
			candidates = append(candidates, candidate)
		}
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		if candidates[i].score == candidates[j].score {
			return candidates[i].at.After(candidates[j].at)
		}
		return candidates[i].score > candidates[j].score
	})
	themeOrder := []string{
		"Oneesama / meeting avatar",
		"Cue / Bridge 工程",
		"Recappi / 音频体验",
		"Bazaar Buddy / simulator",
		"社交自动化 / Linger",
		"团队协作与 review",
	}
	themesByTitle := map[string]*SlackDailyDiaryTheme{}
	seen := map[string]struct{}{}
	for _, candidate := range candidates {
		if len(themesByTitle) >= 5 && themesByTitle[candidate.theme] == nil {
			continue
		}
		if _, ok := seen[candidate.key]; ok {
			continue
		}
		theme := themesByTitle[candidate.theme]
		if theme == nil {
			theme = &SlackDailyDiaryTheme{Title: candidate.theme}
			themesByTitle[candidate.theme] = theme
		}
		if len(theme.Items) >= 3 {
			continue
		}
		theme.Items = append(theme.Items, candidate.item)
		seen[candidate.key] = struct{}{}
	}
	for _, title := range themeOrder {
		if theme := themesByTitle[title]; theme != nil && len(theme.Items) > 0 {
			diary.Themes = append(diary.Themes, *theme)
		}
	}
	for title, theme := range themesByTitle {
		if len(theme.Items) == 0 || slackDailyDiaryThemeInOrder(title, themeOrder) {
			continue
		}
		diary.Themes = append(diary.Themes, *theme)
	}
	if len(diary.Themes) == 0 {
		diary.Intro = "今天我没有观察到足够明确的团队进展，先不硬凑；我会继续看 Slack、GitHub、Linear 里的可见记录。"
	} else {
		diary.Intro = slackDailyDiaryIntro(diary.Themes)
	}
	diary.Watchlist = slackDailyDiaryWatchlist(newRuns, legacyRuns)
	return diary
}

func slackDailyDiaryCandidateForRun(run SlackTriageContext, source string) (slackDailyDiaryCandidate, bool) {
	if slackTriageRunFailed(run) {
		return slackDailyDiaryCandidate{}, false
	}
	detail := slackDailyDiaryDetail(run)
	if detail == "" || slackDailyDiaryLowSignal(detail) {
		return slackDailyDiaryCandidate{}, false
	}
	at := parseTriageTimestamp(run.Timestamp)
	theme := slackDailyDiaryThemeTitle(run, detail)
	item := SlackDailyDiaryItem{
		Channel: slackDailyDiaryChannelLabel(run),
		Time:    slackDailyDiaryTimeLabel(at),
		Text:    detail,
		Source:  source,
	}
	return slackDailyDiaryCandidate{
		item:  item,
		theme: theme,
		score: slackDailyDiaryScore(run, detail),
		at:    at,
		key:   strings.ToLower(theme + "|" + item.Channel + "|" + truncateSlackContextTextRunes(detail, 80)),
	}, true
}

func slackDailyDiaryDetail(run SlackTriageContext) string {
	candidates := []string{run.Summary}
	for _, action := range run.Actions {
		candidates = append(candidates, action.Brief)
	}
	for _, call := range run.ToolCalls {
		candidates = append(candidates, call.Brief, call.Result)
	}
	candidates = append(candidates, slackDailyDiaryDigestSnippet(run.Digest))
	for _, candidate := range candidates {
		detail := slackDailyDiaryCleanDetail(candidate)
		if detail != "" && !slackDailyDiaryLowSignal(detail) {
			return truncateSlackContextTextRunes(detail, 220)
		}
	}
	return ""
}

func slackDailyDiaryCleanDetail(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	value = html.UnescapeString(value)
	replacements := []struct{ from, to string }{
		{"Assistant turn 1 Text:", ""},
		{"Assistant turn 1", ""},
		{"Text:", ""},
		{"**Classification: SKIP**", ""},
		{"Classification: SKIP", ""},
		{"The thread shows that ", ""},
		{"The thread shows ", ""},
		{"The message ", "消息 "},
		{"This is ", ""},
		{"No further action needed.", ""},
		{"No action.", ""},
		{"Stay silent.", ""},
		{"stay_silent", ""},
	}
	for _, replacement := range replacements {
		value = strings.ReplaceAll(value, replacement.from, replacement.to)
	}
	value = slackDailyReportVisibleDetail(value)
	value = strings.ReplaceAll(value, "\n", " ")
	value = strings.Join(strings.Fields(value), " ")
	value = strings.Trim(value, " -—:;,.，。")
	return value
}

func slackDailyDiaryLowSignal(value string) bool {
	text := strings.ToLower(strings.TrimSpace(value))
	if text == "" || text == "no action" || text == "n/a" {
		return true
	}
	if slackDailyDiaryLooksLikeRawPayload(text) {
		return true
	}
	lowSignalMarkers := []string{
		"routine automated daily",
		"automated daily diary",
		"daily notes",
		"candidate task review",
		"pi-first foreground triage pending",
		"persona reaction",
		"persona delegated worker",
		"persona runtime foreground",
		"persona foreground orphaned",
		"decode oneesama pi decision json",
		"call oneesama pi model",
		"context deadline exceeded",
		"not valid persona json",
		"invalid persona json",
		"daily report",
		"approval gate live",
		"approval card live",
		"simplified approval card",
		"is active",
		"repeat '/deploy' commands not directed",
		"not directed at oneesama",
		"out of scope per secretary policy",
		"staying silent",
		"directly answered by",
		"thread is handled",
		"handled and no further action",
		"no direct evidence",
		"delegating to worker",
		"bounded secretary work",
		"from previous discussion",
		"从之前的讨论看",
		"要不要看看",
		"可能",
		"推断",
		"大概",
		"也许",
		"maybe",
		"might",
		"possibly",
		"no explicit question",
		"no explicit request",
		"no question or request",
		"no question or action",
		"no action needed",
		"no reply needed",
		"no need to reply",
		"nothing here calls for",
		"already handled",
		"handled by the speaker",
		"status update on",
		"routine ci/pr",
		"routine ci / pr",
		"casual banter",
		"watercooler",
		"without more context",
		"let me look",
		"tool calls:",
		"slack_api",
		"thread_ts",
		"tool_capab",
		"reaction acknowledges",
		"reply in thread",
		"suggest_acti",
		"未明确请求",
		"没有明确",
		"没有问题",
		"没有提问",
		"无需回复",
		"无需文字回复",
		"无需额外",
		"不需要额外",
		"不需要介入",
		"不需要回复",
		"已自行跟进",
		"自行跟进",
		"已处理",
		"已经处理",
		"轻量确认",
	}
	for _, marker := range lowSignalMarkers {
		if strings.Contains(text, marker) {
			return true
		}
	}
	if strings.HasPrefix(text, "#c0") || strings.HasPrefix(text, "[177") {
		return true
	}
	if len([]rune(strings.TrimSpace(value))) < 12 && !slackDailyDiaryContainsAny(text, "fix", "ship", "release", "pr #", "ci", "修复", "根因", "上线", "发布") {
		return true
	}
	return false
}

func slackDailyDiaryLooksLikeRawPayload(text string) bool {
	trimmed := strings.TrimSpace(text)
	if strings.HasPrefix(trimmed, "{") || strings.HasPrefix(trimmed, "[") {
		return true
	}
	rawMarkers := []string{
		`"query"`,
		`"results"`,
		`"file_path"`,
		`"start_line"`,
		`"end_line"`,
		"reactions.add",
		"chat.postmessage",
		"conversations.replies",
		"tool_calls",
	}
	for _, marker := range rawMarkers {
		if strings.Contains(trimmed, marker) {
			return true
		}
	}
	return false
}

func slackDailyDiaryDigestSnippet(digest string) string {
	for _, line := range strings.Split(digest, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || !strings.Contains(line, ": \"") {
			continue
		}
		_, rest, ok := strings.Cut(line, ": \"")
		if !ok {
			continue
		}
		rest = strings.TrimSuffix(rest, "\"")
		rest = strings.TrimSpace(rest)
		if rest != "" {
			return rest
		}
	}
	return ""
}

func slackDailyDiaryThemeTitle(run SlackTriageContext, detail string) string {
	text := strings.ToLower(strings.Join([]string{detail, run.Summary, run.Digest, strings.Join(run.Channels, " ")}, " "))
	switch {
	case slackDailyDiaryContainsAny(text, "oneesama", "onee", "meeting-avatar", "meeting agent", "realtime", "real time", "google meet", "demo surface", "computer use", "kwwk", "join card", "caption", "avatar hud", "贪吃蛇", "入会", "字幕"):
		return "Oneesama / meeting avatar"
	case slackDailyDiaryContainsAny(text, "recappi", "transcription", "speaker", "audio", "coreaudio", "cloud transcription", "音频", "转写"):
		return "Recappi / 音频体验"
	case slackDailyDiaryContainsAny(text, "bazaar", "simulator", "corpus", "karnok", "potion", "lifesteal", "bazaar-buddy"):
		return "Bazaar Buddy / simulator"
	case slackDailyDiaryContainsAny(text, "bridge", "cue.surf", "cueboard", "willow", "staging", "ci", "pr #", "pull request", "review", "deploy", "traffic", "140 gb", "mp4"):
		return "Cue / Bridge 工程"
	case slackDailyDiaryContainsAny(text, "twitter", "ootd", "linger", "wechat", "like", "social"):
		return "社交自动化 / Linger"
	default:
		return "团队协作与 review"
	}
}

func slackDailyDiaryScore(run SlackTriageContext, detail string) int {
	score := 1
	if run.Mutations > 0 || len(run.Actions) > 0 {
		score += 6
	}
	text := strings.ToLower(detail + " " + run.Summary + " " + run.Digest)
	for _, marker := range []string{"ship", "fix", "root cause", "review", "merge", "ci", "release", "deploy", "bug", "poc", "smoke", "验证", "修", "根因", "上线", "验收"} {
		if strings.Contains(text, marker) {
			score += 2
		}
	}
	if intFromAny(run.Metadata["external_links_fetched"]) > 0 {
		score += 1
	}
	if strings.Contains(text, "already") || strings.Contains(text, "已由") || strings.Contains(text, "已经") {
		score -= 2
	}
	if score < 1 {
		score = 1
	}
	return score
}

func slackDailyDiaryChannelLabel(run SlackTriageContext) string {
	if label := slackDailyDiaryChannelFromDigest(run.Digest); label != "" {
		return label
	}
	if channel := slackDailyReportRunChannel(run); channel != "" {
		if strings.HasPrefix(channel, "C") || strings.HasPrefix(channel, "G") {
			return "<#" + channel + ">"
		}
		return channel
	}
	return ""
}

func slackDailyDiaryChannelFromDigest(digest string) string {
	for _, line := range strings.Split(digest, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "#") || !strings.Contains(line, " (") {
			continue
		}
		name := strings.TrimSpace(strings.TrimPrefix(strings.SplitN(line, " (", 2)[0], "#"))
		if name != "" {
			return "#" + name
		}
	}
	return ""
}

func slackDailyDiaryTimeLabel(value time.Time) string {
	if value.IsZero() {
		return ""
	}
	loc, err := time.LoadLocation(slackDailyReportDefaultTZ)
	if err != nil {
		return value.UTC().Format("15:04Z")
	}
	return value.In(loc).Format("15:04")
}

func slackDailyDiaryContainsAny(text string, markers ...string) bool {
	for _, marker := range markers {
		if strings.Contains(text, strings.ToLower(marker)) {
			return true
		}
	}
	return false
}

func slackDailyDiaryThemeInOrder(title string, order []string) bool {
	for _, entry := range order {
		if entry == title {
			return true
		}
	}
	return false
}

func slackDailyDiaryIntro(themes []SlackDailyDiaryTheme) string {
	titles := make([]string, 0, minInt(len(themes), 3))
	for _, theme := range themes {
		if len(theme.Items) == 0 {
			continue
		}
		titles = append(titles, theme.Title)
		if len(titles) >= 3 {
			break
		}
	}
	if len(titles) == 0 {
		return "今天我没有观察到足够明确的团队进展，先不硬凑；我会继续看 Slack、GitHub、Linear 里的可见记录。"
	}
	return "今天我观察到的主线集中在 " + strings.Join(titles, "、") + "；下面按方向记，不按流水账堆计数。"
}

func slackDailyDiaryWatchlist(newRuns []SlackTriageContext, legacyRuns []SlackTriageContext) []string {
	var watchlist []string
	failedNew := 0
	for _, run := range newRuns {
		if slackTriageRunFailed(run) {
			failedNew++
		}
	}
	if failedNew > 0 {
		watchlist = append(watchlist, fmt.Sprintf("Oneesama 自己今天有 %d 条 triage/runtime 异常，继续走审计面单独跟进，不把日志细节塞进日记。", failedNew))
	}
	if len(legacyRuns) == 0 {
		watchlist = append(watchlist, "旧 slackd 对照源今天不可用或没有样本；这篇日记只基于新 Oneesama 可见记录。")
	}
	return watchlist
}

func formatSlackDailyReportText(report SlackDailyReport) string {
	var b strings.Builder
	fmt.Fprintf(&b, ":clock6: *今日日记 · %s*\n\n", report.ReportDate)
	if strings.TrimSpace(report.Diary.Intro) != "" {
		fmt.Fprintf(&b, "%s\n", report.Diary.Intro)
	}
	if len(report.Diary.Themes) == 0 {
		b.WriteString("\n*我观察到的主线*\n- 今天没有足够明确的团队工作样本，先不编故事。\n")
	} else {
		b.WriteString("\n*我观察到的主线*\n")
		for _, theme := range report.Diary.Themes {
			if len(theme.Items) == 0 {
				continue
			}
			fmt.Fprintf(&b, "\n*%s*\n", theme.Title)
			for _, item := range theme.Items {
				var prefix []string
				if strings.TrimSpace(item.Channel) != "" {
					prefix = append(prefix, item.Channel)
				}
				if strings.TrimSpace(item.Time) != "" {
					prefix = append(prefix, item.Time)
				}
				if len(prefix) > 0 {
					fmt.Fprintf(&b, "- %s：%s\n", strings.Join(prefix, " · "), item.Text)
				} else {
					fmt.Fprintf(&b, "- %s\n", item.Text)
				}
			}
		}
	}
	if len(report.Diary.Watchlist) > 0 {
		b.WriteString("\n*我会继续留意*\n")
		for _, item := range report.Diary.Watchlist {
			fmt.Fprintf(&b, "- %s\n", item)
		}
	}
	fmt.Fprintf(&b, "\n_基于过去 %.0fh 的可见 Slack / 工具记录整理；没录到的会议不写成一手结论。内部审计计数保留在 daily-report JSON，不在频道里展开。_", report.WindowHours)
	return strings.TrimSpace(b.String())
}

func formatDailyAuditBullets(samples []string) string {
	if len(samples) == 0 {
		return "- none"
	}
	var b strings.Builder
	for _, sample := range samples {
		fmt.Fprintf(&b, "- %s\n", sample)
	}
	return strings.TrimRight(b.String(), "\n")
}

func slackDailyReportEmojiSummary(counts map[string]int, reactionRuns int) string {
	if len(counts) > 0 {
		return formatEmojiCounts(counts)
	}
	if reactionRuns > 0 {
		return "none (standard emoji only)"
	}
	return "none"
}

func (s *Service) dailyReportStatus() SlackDailyReportStatus {
	cfg := s.dailyReportConfig
	status := SlackDailyReportStatus{
		Enabled:          cfg.Enabled,
		ChannelID:        cfg.ChannelID,
		TimeOfDay:        cfg.TimeOfDay,
		Timezone:         cfg.Timezone,
		WindowSeconds:    int64(cfg.Window.Seconds()),
		LegacyDBPath:     cfg.LegacySlackDBPath,
		LegacyArchiveDir: cfg.LegacyTriageArchiveDir,
	}
	if next, err := nextSlackDailyReportRun(timeNow().UTC(), cfg); err == nil {
		status.NextRunAt = next.UTC().Format(time.RFC3339Nano)
	}
	if s == nil {
		return status
	}
	s.dailyReportMu.Lock()
	defer s.dailyReportMu.Unlock()
	status.Running = s.dailyReportCancel != nil
	if !s.dailyReportLastTickAt.IsZero() {
		status.LastTickAt = s.dailyReportLastTickAt.UTC().Format(time.RFC3339Nano)
	}
	if !s.dailyReportLastPostedAt.IsZero() {
		status.LastPostedAt = s.dailyReportLastPostedAt.UTC().Format(time.RFC3339Nano)
	}
	status.LastChannelID = s.dailyReportLastChannel
	status.LastError = s.dailyReportLastError
	status.TicksLastWindow = len(s.dailyReportTicks)
	if status.LastPostedAt == "" && strings.TrimSpace(cfg.ChannelID) != "" && s.dailyReports != nil {
		if _, _, reportDate, err := slackDailyReportWindow(timeNow().UTC(), cfg.Window, cfg.Timezone, ""); err == nil {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			if record, ok, err := s.dailyReports.Get(ctx, dailyReportRecordID(cfg.ChannelID, reportDate)); err == nil && ok {
				status.LastPostedAt = strings.TrimSpace(record.PostedAt)
				status.LastChannelID = strings.TrimSpace(record.ChannelID)
			}
		}
	}
	return status
}

func (s *Service) recordDailyReportTick(now time.Time, channel string, err error) {
	if s == nil {
		return
	}
	if now.IsZero() {
		now = timeNow().UTC()
	}
	cutoff := now.Add(-24 * time.Hour)
	s.dailyReportMu.Lock()
	defer s.dailyReportMu.Unlock()
	s.dailyReportLastTickAt = now.UTC()
	s.dailyReportLastChannel = strings.TrimSpace(channel)
	if err != nil {
		s.dailyReportLastError = err.Error()
	} else {
		s.dailyReportLastError = ""
		s.dailyReportLastPostedAt = now.UTC()
	}
	s.dailyReportTicks = append(s.dailyReportTicks, now.UTC())
	kept := s.dailyReportTicks[:0]
	for _, tick := range s.dailyReportTicks {
		if tick.After(cutoff) || tick.Equal(cutoff) {
			kept = append(kept, tick)
		}
	}
	s.dailyReportTicks = kept
}

func (s *Service) recordDailyReportPost(now time.Time, channel string, err error) {
	if s == nil {
		return
	}
	if now.IsZero() {
		now = timeNow().UTC()
	}
	s.dailyReportMu.Lock()
	defer s.dailyReportMu.Unlock()
	s.dailyReportLastChannel = strings.TrimSpace(channel)
	if err != nil {
		s.dailyReportLastError = err.Error()
		return
	}
	s.dailyReportLastError = ""
	s.dailyReportLastPostedAt = now.UTC()
}

func nextSlackDailyReportRun(now time.Time, cfg appconfig.SlackDailyReportConfig) (time.Time, error) {
	cfg = normalizeSlackDailyReportConfig(cfg)
	loc, err := time.LoadLocation(cfg.Timezone)
	if err != nil {
		return time.Time{}, err
	}
	hour, minute, err := parseSlackDailyReportTimeOfDay(cfg.TimeOfDay)
	if err != nil {
		return time.Time{}, err
	}
	localNow := now.In(loc)
	next := time.Date(localNow.Year(), localNow.Month(), localNow.Day(), hour, minute, 0, 0, loc)
	if !next.After(localNow) {
		next = next.AddDate(0, 0, 1)
	}
	return next.UTC(), nil
}

func parseSlackDailyReportTimeOfDay(value string) (int, int, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		value = slackDailyReportDefaultTime
	}
	parsed, err := time.Parse("15:04", value)
	if err != nil {
		return 0, 0, fmt.Errorf("invalid daily report time_of_day %q", value)
	}
	return parsed.Hour(), parsed.Minute(), nil
}

func slackDailyReportWindow(now time.Time, window time.Duration, timezone string, reportDate string) (time.Time, time.Time, string, error) {
	loc, err := time.LoadLocation(stringOrDefaultLocal(timezone, slackDailyReportDefaultTZ))
	if err != nil {
		return time.Time{}, time.Time{}, "", err
	}
	if now.IsZero() {
		now = timeNow().UTC()
	}
	if window <= 0 {
		window = 24 * time.Hour
	}
	if strings.TrimSpace(reportDate) != "" {
		day, err := time.ParseInLocation("2006-01-02", strings.TrimSpace(reportDate), loc)
		if err != nil {
			return time.Time{}, time.Time{}, "", err
		}
		start := day
		end := day.AddDate(0, 0, 1)
		if end.After(now.In(loc)) {
			end = now.In(loc)
		}
		return start.UTC(), end.UTC(), day.Format("2006-01-02"), nil
	}
	end := now.UTC()
	start := end.Add(-window)
	return start, end, end.In(loc).Format("2006-01-02"), nil
}

func dailyReportRecordID(channelID string, reportDate string) string {
	return strings.Join([]string{strings.TrimSpace(channelID), strings.TrimSpace(reportDate)}, ":")
}

func normalizeLegacyTriageTimestamp(value string) string {
	t := parseLegacyTriageTimestamp(value)
	if t.IsZero() {
		return strings.TrimSpace(value)
	}
	return t.UTC().Format(time.RFC3339Nano)
}

func parseLegacyTriageTimestamp(value string) time.Time {
	value = strings.TrimSpace(value)
	if value == "" {
		return time.Time{}
	}
	if t := parseTriageTimestamp(value); !t.IsZero() {
		return t
	}
	layouts := []string{
		"2006-01-02 15:04:05.999999999Z07:00",
		"2006-01-02 15:04:05.999999Z07:00",
		"2006-01-02 15:04:05Z07:00",
		"2006-01-02 15:04:05.999999999-07:00",
		"2006-01-02 15:04:05.999999-07:00",
		"2006-01-02 15:04:05-07:00",
		"2006-01-02 15:04:05.999999999",
		"2006-01-02 15:04:05.999999",
		"2006-01-02 15:04:05",
	}
	for _, layout := range layouts {
		if t, err := time.Parse(layout, value); err == nil {
			return t.UTC()
		}
	}
	return time.Time{}
}

func slackDailyReportActionIsReply(action string) bool {
	action = strings.ToLower(strings.TrimSpace(action))
	return action == "post_thread_reply" || action == "chat.postmessage" || action == "post_message" || action == "send_message"
}

func slackDailyReportActionIsReaction(action string) bool {
	action = strings.ToLower(strings.TrimSpace(action))
	return action == "add_reaction" || action == "reactions.add" || action == "slack.addreaction"
}

func slackDailyReportToolCallIsMemoryLookup(call SlackTriageToolCall) bool {
	tool := strings.ToLower(strings.TrimSpace(call.Tool))
	return tool == "memory_search" || tool == "memory_get" || tool == "person_memory"
}

func slackDailyReportToolCallIsExternalSearch(call SlackTriageToolCall) bool {
	tool := strings.ToLower(strings.TrimSpace(call.Tool))
	return tool == "exa_search" || tool == "exa_contents"
}

func slackDailyReportToolCallIsThreadFetch(call SlackTriageToolCall) bool {
	action := strings.ToLower(strings.TrimSpace(call.Action))
	return action == "fetch_thread" || action == "fetch_channel_history" || action == "conversations.replies" || action == "conversations.history"
}

func slackDailyReportExtractEmoji(text string) []string {
	matches := slackEmojiNamePattern.FindAllStringSubmatch(text, -1)
	if len(matches) == 0 {
		return nil
	}
	out := make([]string, 0, len(matches))
	for _, match := range matches {
		if len(match) > 1 && strings.TrimSpace(match[1]) != "" {
			out = append(out, strings.Trim(strings.TrimSpace(match[1]), ":"))
		}
	}
	return out
}

func slackDailyReportRunSample(run SlackTriageContext, detail string) string {
	var parts []string
	if channel := slackDailyReportRunChannel(run); channel != "" {
		parts = append(parts, channel)
	}
	if ts := parseTriageTimestamp(run.Timestamp); !ts.IsZero() {
		parts = append(parts, ts.UTC().Format("01-02 15:04Z"))
	}
	detail = truncateSlackContextTextRunes(slackDailyReportVisibleDetail(firstLine(firstNonEmpty(detail, compactTriageSummary(run)))), 180)
	if detail != "" {
		parts = append(parts, detail)
	}
	if len(parts) == 0 {
		return "n/a"
	}
	return strings.Join(parts, " · ")
}

func slackDailyReportVisibleDetail(detail string) string {
	detail = strings.TrimSpace(detail)
	if detail == "" {
		return ""
	}
	replacer := strings.NewReplacer(
		"http://127.0.0.1:8799/persona/decide", "persona runtime request",
		"http://localhost:8799/persona/decide", "persona runtime request",
		"https://127.0.0.1:8799/persona/decide", "persona runtime request",
		"https://localhost:8799/persona/decide", "persona runtime request",
		"127.0.0.1:8799", "persona runtime",
		"localhost:8799", "persona runtime",
		"127.0.0.1", "local runtime",
		"localhost", "local runtime",
	)
	return replacer.Replace(detail)
}

func slackDailyReportRunChannel(run SlackTriageContext) string {
	for _, action := range run.Actions {
		if strings.TrimSpace(action.Channel) != "" {
			return strings.TrimSpace(action.Channel)
		}
	}
	for _, channel := range run.Channels {
		if strings.TrimSpace(channel) != "" {
			return strings.TrimSpace(channel)
		}
	}
	return ""
}

func appendLimitedString(values []string, value string, limit int) []string {
	value = strings.TrimSpace(value)
	if value == "" || limit <= 0 || len(values) >= limit {
		return values
	}
	for _, existing := range values {
		if existing == value {
			return values
		}
	}
	return append(values, value)
}

func truncateSlackContextTextRunes(value string, maxLength int) string {
	value = strings.TrimSpace(value)
	if maxLength <= 0 {
		return ""
	}
	runes := []rune(value)
	if len(runes) <= maxLength {
		return value
	}
	return string(runes[:maxLength]) + "..."
}

func slackDailyReportPlaceholderSummary(run SlackTriageContext) bool {
	raw := run.Summary + " " + run.Error
	text := strings.ToLower(raw)
	return strings.Contains(text, "short reason for the shadow decision") ||
		strings.Contains(text, "placeholder") ||
		slackDailyReportTodoPlaceholderPattern.MatchString(raw)
}

func slackDailyReportInvalidPersonaJSON(run SlackTriageContext) bool {
	text := strings.ToLower(run.Summary + " " + run.Error)
	return strings.Contains(text, "not valid persona json") || strings.Contains(text, "invalid persona json")
}

func slackDailyReportLowConfidenceNoAction(run SlackTriageContext) bool {
	if run.Mutations > 0 || len(run.Actions) > 0 {
		return false
	}
	raw, ok := mapFromAny(run.Metadata["persona_foreground"])
	if !ok {
		return false
	}
	return float64FromAny(raw["confidence"]) > 0 && float64FromAny(raw["confidence"]) < triageQualityLowConfidenceCeiling
}

func float64FromAny(value any) float64 {
	switch v := value.(type) {
	case float64:
		return v
	case float32:
		return float64(v)
	case int:
		return float64(v)
	case int64:
		return float64(v)
	case int32:
		return float64(v)
	case json.Number:
		parsed, _ := v.Float64()
		return parsed
	case string:
		parsed, _ := strconv.ParseFloat(strings.TrimSpace(v), 64)
		return parsed
	default:
		return 0
	}
}

func topNStringInt(values map[string]int, limit int) map[string]int {
	if len(values) == 0 || limit <= 0 {
		return nil
	}
	type pair struct {
		Key   string
		Value int
	}
	pairs := make([]pair, 0, len(values))
	for key, value := range values {
		if strings.TrimSpace(key) != "" && value > 0 {
			pairs = append(pairs, pair{Key: key, Value: value})
		}
	}
	sort.SliceStable(pairs, func(i, j int) bool {
		if pairs[i].Value == pairs[j].Value {
			return pairs[i].Key < pairs[j].Key
		}
		return pairs[i].Value > pairs[j].Value
	})
	if len(pairs) > limit {
		pairs = pairs[:limit]
	}
	out := make(map[string]int, len(pairs))
	for _, pair := range pairs {
		out[pair.Key] = pair.Value
	}
	return out
}

func formatEmojiCounts(values map[string]int) string {
	if len(values) == 0 {
		return ""
	}
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, key := range keys {
		parts = append(parts, fmt.Sprintf(":%s:×%d", key, values[key]))
	}
	return strings.Join(parts, ", ")
}

func ratioPercent(part int, total int) float64 {
	if total <= 0 {
		return 0
	}
	return float64(part) / float64(total) * 100
}

func stringOrDefaultLocal(value string, fallback string) string {
	if trimmed := strings.TrimSpace(value); trimmed != "" {
		return trimmed
	}
	return fallback
}
