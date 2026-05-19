package slackagent

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

const legacySlackAgentDTargetRoot = "memory/legacy/slack-agent-d"

type LegacySlackMemoryImportOptions struct {
	SourceWorkspaceDir string
	SourceDBPath       string
	TargetWorkspaceDir string
	Write              bool
	MaxTriageRuns      int
}

type LegacySlackMemoryImportReport struct {
	DryRun                    bool
	SourceWorkspaceDir        string
	SourceDBPath              string
	TargetWorkspaceDir        string
	WorkspaceFilesScanned     int
	WorkspaceFilesWritten     int
	TriageArchiveFilesScanned int
	TriageArchiveFilesWritten int
	DatabaseFilesWritten      int
	ChannelBrainRows          int
	ThreadLedgerRows          int
	FeedbackRows              int
	TriageRunRows             int
	GeneratedFiles            []string
	Warnings                  []string
}

func ImportLegacySlackAgentDMemory(ctx context.Context, opts LegacySlackMemoryImportOptions) (LegacySlackMemoryImportReport, error) {
	report := LegacySlackMemoryImportReport{
		DryRun:             !opts.Write,
		SourceWorkspaceDir: strings.TrimSpace(opts.SourceWorkspaceDir),
		SourceDBPath:       strings.TrimSpace(opts.SourceDBPath),
		TargetWorkspaceDir: strings.TrimSpace(opts.TargetWorkspaceDir),
	}
	if report.TargetWorkspaceDir == "" {
		return report, errors.New("target workspace dir is required")
	}
	if report.SourceWorkspaceDir == "" && report.SourceDBPath == "" {
		return report, errors.New("source workspace dir or source db path is required")
	}

	if report.SourceWorkspaceDir != "" {
		files, err := legacySlackWorkspaceMemoryFiles(report.SourceWorkspaceDir)
		if err != nil {
			report.Warnings = append(report.Warnings, fmt.Sprintf("read source workspace: %v", err))
		}
		report.WorkspaceFilesScanned = len(files)
		for _, rel := range files {
			if err := ctx.Err(); err != nil {
				return report, err
			}
			sourcePath := filepath.Join(report.SourceWorkspaceDir, filepath.FromSlash(rel))
			raw, err := os.ReadFile(sourcePath)
			if err != nil {
				report.Warnings = append(report.Warnings, fmt.Sprintf("read %s: %v", rel, err))
				continue
			}
			targetRel := filepath.ToSlash(filepath.Join(legacySlackAgentDTargetRoot, "workspace", filepath.FromSlash(rel)))
			if err := legacySlackWriteGeneratedFile(report.TargetWorkspaceDir, targetRel, raw, opts.Write); err != nil {
				report.Warnings = append(report.Warnings, fmt.Sprintf("write %s: %v", targetRel, err))
				continue
			}
			report.GeneratedFiles = append(report.GeneratedFiles, targetRel)
			report.WorkspaceFilesWritten++
		}

		archiveFiles, err := legacySlackWorkspaceTriageArchiveFiles(report.SourceWorkspaceDir)
		if err != nil {
			report.Warnings = append(report.Warnings, fmt.Sprintf("read source triage archive: %v", err))
		}
		report.TriageArchiveFilesScanned = len(archiveFiles)
		for _, rel := range archiveFiles {
			if err := ctx.Err(); err != nil {
				return report, err
			}
			sourcePath := filepath.Join(report.SourceWorkspaceDir, filepath.FromSlash(rel))
			raw, err := os.ReadFile(sourcePath)
			if err != nil {
				report.Warnings = append(report.Warnings, fmt.Sprintf("read %s: %v", rel, err))
				continue
			}
			body, err := legacySlackRenderTriageArchiveJSON(rel, raw)
			if err != nil {
				report.Warnings = append(report.Warnings, fmt.Sprintf("render %s: %v", rel, err))
				continue
			}
			targetRel := filepath.ToSlash(filepath.Join(legacySlackAgentDTargetRoot, "workspace", strings.TrimSuffix(filepath.FromSlash(rel), filepath.Ext(rel))+".md"))
			if err := legacySlackWriteGeneratedFile(report.TargetWorkspaceDir, targetRel, []byte(body), opts.Write); err != nil {
				report.Warnings = append(report.Warnings, fmt.Sprintf("write %s: %v", targetRel, err))
				continue
			}
			report.GeneratedFiles = append(report.GeneratedFiles, targetRel)
			report.TriageArchiveFilesWritten++
		}
	}

	if report.SourceDBPath != "" {
		dbFiles, counts, warnings, err := legacySlackRenderDBMarkdown(ctx, report.SourceDBPath, opts.MaxTriageRuns)
		report.Warnings = append(report.Warnings, warnings...)
		if err != nil {
			report.Warnings = append(report.Warnings, fmt.Sprintf("read source db: %v", err))
		}
		report.ChannelBrainRows = counts.ChannelBrain
		report.ThreadLedgerRows = counts.ThreadLedger
		report.FeedbackRows = counts.Feedback
		report.TriageRunRows = counts.TriageRun
		for relSuffix, body := range dbFiles {
			targetRel := filepath.ToSlash(filepath.Join(legacySlackAgentDTargetRoot, "db", filepath.FromSlash(relSuffix)))
			if err := legacySlackWriteGeneratedFile(report.TargetWorkspaceDir, targetRel, []byte(body), opts.Write); err != nil {
				report.Warnings = append(report.Warnings, fmt.Sprintf("write %s: %v", targetRel, err))
				continue
			}
			report.GeneratedFiles = append(report.GeneratedFiles, targetRel)
			report.DatabaseFilesWritten++
		}
	}

	sort.Strings(report.GeneratedFiles)
	return report, nil
}

func legacySlackWorkspaceMemoryFiles(workspaceDir string) ([]string, error) {
	var files []string
	err := filepath.WalkDir(workspaceDir, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if entry.IsDir() {
			if entry.Name() == ".git" || entry.Name() == "node_modules" {
				return filepath.SkipDir
			}
			return nil
		}
		rel, err := filepath.Rel(workspaceDir, path)
		if err != nil {
			return nil
		}
		rel = filepath.ToSlash(rel)
		if isAllowedMemoryPath(rel) {
			files = append(files, rel)
		}
		return nil
	})
	sort.Strings(files)
	return files, err
}

func legacySlackWorkspaceTriageArchiveFiles(workspaceDir string) ([]string, error) {
	archiveDir := filepath.Join(workspaceDir, filepath.FromSlash("memory/triage-archive"))
	entries, err := os.ReadDir(archiveDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var files []string
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(strings.ToLower(entry.Name()), ".json") {
			continue
		}
		files = append(files, filepath.ToSlash(filepath.Join("memory/triage-archive", entry.Name())))
	}
	sort.Strings(files)
	return files, nil
}

type legacySlackTriageArchiveRun struct {
	SessionID string `json:"session_id"`
	Timestamp string `json:"timestamp"`
	Status    string `json:"status"`
	Summary   string `json:"summary"`
	Digest    string `json:"digest"`
	RawOutput string `json:"raw_output"`
	Actions   any    `json:"actions"`
	Channels  any    `json:"channels"`
}

func legacySlackRenderTriageArchiveJSON(rel string, raw []byte) (string, error) {
	var runs []legacySlackTriageArchiveRun
	if err := json.Unmarshal(raw, &runs); err != nil {
		return "", err
	}
	var b strings.Builder
	fmt.Fprintf(&b, "# Legacy Slack Agent D triage archive %s\n\n", strings.TrimSuffix(filepath.Base(rel), filepath.Ext(rel)))
	b.WriteString("Imported from old Slack Agent D workspace `memory/triage-archive` JSON. This preserves old tool outputs as line-citable memory evidence.\n\n")
	for index, run := range runs {
		title := firstNonEmpty(run.SessionID, run.Timestamp, fmt.Sprintf("run-%d", index+1))
		fmt.Fprintf(&b, "## Triage archive run %s\n\n", title)
		legacySlackWriteBullet(&b, "Timestamp", run.Timestamp)
		legacySlackWriteBullet(&b, "Status", run.Status)
		if channels := legacySlackCompactJSON(run.Channels); channels != "" {
			legacySlackWriteBullet(&b, "Channels", channels)
		}
		if actions := legacySlackCompactJSON(run.Actions); actions != "" {
			legacySlackWriteBlock(&b, "Actions", legacySlackTruncateRunText(actions, 2400))
		}
		legacySlackWriteBlock(&b, "Summary", run.Summary)
		legacySlackWriteBlock(&b, "Digest", legacySlackTruncateRunText(run.Digest, 3600))
		legacySlackWriteBlock(&b, "Raw output", legacySlackTruncateRunText(run.RawOutput, 12000))
	}
	return b.String(), nil
}

func legacySlackCompactJSON(value any) string {
	if value == nil {
		return ""
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(raw))
}

func legacySlackWriteGeneratedFile(workspaceDir string, rel string, body []byte, write bool) error {
	if !isAllowedMemoryPath(rel) {
		return fmt.Errorf("target path is not an allowed workspace memory path: %s", rel)
	}
	if !write {
		return nil
	}
	fullPath := filepath.Join(workspaceDir, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(fullPath), 0o755); err != nil {
		return err
	}
	return os.WriteFile(fullPath, body, 0o644)
}

type legacySlackDBCounts struct {
	ChannelBrain int
	ThreadLedger int
	Feedback     int
	TriageRun    int
}

func legacySlackRenderDBMarkdown(ctx context.Context, dbPath string, maxTriageRuns int) (map[string]string, legacySlackDBCounts, []string, error) {
	files := map[string]string{}
	counts := legacySlackDBCounts{}
	var warnings []string
	if maxTriageRuns <= 0 {
		maxTriageRuns = 200
	}
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return files, counts, warnings, err
	}
	defer db.Close()
	if err := db.PingContext(ctx); err != nil {
		return files, counts, warnings, err
	}

	if body, n, err := legacySlackRenderChannelBrain(ctx, db); err == nil {
		files["channel-brain.md"] = body
		counts.ChannelBrain = n
	} else {
		warnings = append(warnings, fmt.Sprintf("channel_brain: %v", err))
	}
	if body, n, err := legacySlackRenderThreadLedger(ctx, db); err == nil {
		files["thread-ledger.md"] = body
		counts.ThreadLedger = n
	} else {
		warnings = append(warnings, fmt.Sprintf("thread_ledger: %v", err))
	}
	if body, n, err := legacySlackRenderFeedback(ctx, db); err == nil {
		files["feedback.md"] = body
		counts.Feedback = n
	} else {
		warnings = append(warnings, fmt.Sprintf("feedback_entry: %v", err))
	}
	if body, n, err := legacySlackRenderTriageRuns(ctx, db, maxTriageRuns); err == nil {
		files["triage-runs.md"] = body
		counts.TriageRun = n
	} else {
		warnings = append(warnings, fmt.Sprintf("triage_run: %v", err))
	}
	files["manifest.md"] = legacySlackRenderManifest(counts, timeNow())
	return files, counts, warnings, nil
}

func legacySlackRenderManifest(counts legacySlackDBCounts, now time.Time) string {
	return strings.Join([]string{
		"# Legacy Slack Agent D memory import",
		"",
		"These files are a local seed import from the old Slack Agent D runtime.",
		"Oneesama/Pi reads them through workspace related-memory search and cites this path/line as evidence.",
		"",
		fmt.Sprintf("- Imported at: %s", now.UTC().Format(time.RFC3339)),
		fmt.Sprintf("- Channel brain rows: %d", counts.ChannelBrain),
		fmt.Sprintf("- Thread ledger rows: %d", counts.ThreadLedger),
		fmt.Sprintf("- Feedback rows: %d", counts.Feedback),
		fmt.Sprintf("- Triage run rows: %d", counts.TriageRun),
		"",
	}, "\n")
}

func legacySlackRenderChannelBrain(ctx context.Context, db *sql.DB) (string, int, error) {
	rows, err := db.QueryContext(ctx, `select workspace_id, channel_id, summary, summary_version, last_session_id, last_thread_ts, coalesce(created_at,''), coalesce(updated_at,'') from channel_brain order by updated_at desc, channel_id`)
	if err != nil {
		return "", 0, err
	}
	defer rows.Close()
	var b strings.Builder
	b.WriteString("# Legacy Slack Agent D channel brain\n\n")
	count := 0
	for rows.Next() {
		var workspaceID, channelID, summary, lastSessionID, lastThreadTS, createdAt, updatedAt string
		var version int
		if err := rows.Scan(&workspaceID, &channelID, &summary, &version, &lastSessionID, &lastThreadTS, &createdAt, &updatedAt); err != nil {
			return "", count, err
		}
		count++
		fmt.Fprintf(&b, "## Channel %s\n\n", channelID)
		legacySlackWriteBullet(&b, "Workspace", workspaceID)
		legacySlackWriteBullet(&b, "Summary version", fmt.Sprint(version))
		legacySlackWriteBullet(&b, "Last session", lastSessionID)
		legacySlackWriteBullet(&b, "Last thread", lastThreadTS)
		legacySlackWriteBullet(&b, "Created", createdAt)
		legacySlackWriteBullet(&b, "Updated", updatedAt)
		legacySlackWriteBlock(&b, "Summary", summary)
	}
	return b.String(), count, rows.Err()
}

func legacySlackRenderThreadLedger(ctx context.Context, db *sql.DB) (string, int, error) {
	rows, err := db.QueryContext(ctx, `select workspace_id, channel_id, thread_ts, assistant_session_id, status, owner_user_id, last_user_id, coalesce(last_user_message_at,''), coalesce(last_assistant_message_at,''), last_action_type, last_action_status, summary, coalesce(created_at,''), coalesce(updated_at,'') from thread_ledger order by updated_at desc, channel_id, thread_ts`)
	if err != nil {
		return "", 0, err
	}
	defer rows.Close()
	var b strings.Builder
	b.WriteString("# Legacy Slack Agent D thread ledger\n\n")
	count := 0
	for rows.Next() {
		var workspaceID, channelID, threadTS, sessionID, status, owner, lastUser, lastUserAt, lastAssistantAt, actionType, actionStatus, summary, createdAt, updatedAt string
		if err := rows.Scan(&workspaceID, &channelID, &threadTS, &sessionID, &status, &owner, &lastUser, &lastUserAt, &lastAssistantAt, &actionType, &actionStatus, &summary, &createdAt, &updatedAt); err != nil {
			return "", count, err
		}
		count++
		fmt.Fprintf(&b, "## Thread %s:%s\n\n", channelID, threadTS)
		legacySlackWriteBullet(&b, "Workspace", workspaceID)
		legacySlackWriteBullet(&b, "Status", status)
		legacySlackWriteBullet(&b, "Assistant session", sessionID)
		legacySlackWriteBullet(&b, "Owner user", owner)
		legacySlackWriteBullet(&b, "Last user", lastUser)
		legacySlackWriteBullet(&b, "Last user message at", lastUserAt)
		legacySlackWriteBullet(&b, "Last assistant message at", lastAssistantAt)
		legacySlackWriteBullet(&b, "Last action", strings.TrimSpace(actionType+" "+actionStatus))
		legacySlackWriteBullet(&b, "Created", createdAt)
		legacySlackWriteBullet(&b, "Updated", updatedAt)
		legacySlackWriteBlock(&b, "Summary", summary)
	}
	return b.String(), count, rows.Err()
}

func legacySlackRenderFeedback(ctx context.Context, db *sql.DB) (string, int, error) {
	rows, err := db.QueryContext(ctx, `select id, entry_date, entry_time, action, channel, action_type, summary, user_id, coalesce(created_at,'') from feedback_entry order by entry_date desc, entry_time desc, id desc`)
	if err != nil {
		return "", 0, err
	}
	defer rows.Close()
	var b strings.Builder
	b.WriteString("# Legacy Slack Agent D feedback\n\n")
	count := 0
	for rows.Next() {
		var id int64
		var entryDate, entryTime, action, channel, actionType, summary, userID, createdAt string
		if err := rows.Scan(&id, &entryDate, &entryTime, &action, &channel, &actionType, &summary, &userID, &createdAt); err != nil {
			return "", count, err
		}
		count++
		fmt.Fprintf(&b, "## Feedback %d\n\n", id)
		legacySlackWriteBullet(&b, "Date", strings.TrimSpace(entryDate+" "+entryTime))
		legacySlackWriteBullet(&b, "Action", action)
		legacySlackWriteBullet(&b, "Action type", actionType)
		legacySlackWriteBullet(&b, "Channel", channel)
		legacySlackWriteBullet(&b, "User", userID)
		legacySlackWriteBullet(&b, "Created", createdAt)
		legacySlackWriteBlock(&b, "Summary", summary)
	}
	return b.String(), count, rows.Err()
}

func legacySlackRenderTriageRuns(ctx context.Context, db *sql.DB, maxRuns int) (string, int, error) {
	rows, err := db.QueryContext(ctx, `select session_id, occurred_at, status, summary, error, digest, steps, duration_seconds, mutations, failures, tokens_used, channels_json, coalesce(created_at,'') from triage_run order by occurred_at desc, id desc limit ?`, maxRuns)
	if err != nil {
		return "", 0, err
	}
	defer rows.Close()
	var b strings.Builder
	b.WriteString("# Legacy Slack Agent D triage runs\n\n")
	count := 0
	for rows.Next() {
		var sessionID, occurredAt, status, summary, runErr, digest, channelsJSON, createdAt string
		var steps, mutations, failures, tokensUsed int
		var durationSeconds float64
		if err := rows.Scan(&sessionID, &occurredAt, &status, &summary, &runErr, &digest, &steps, &durationSeconds, &mutations, &failures, &tokensUsed, &channelsJSON, &createdAt); err != nil {
			return "", count, err
		}
		count++
		fmt.Fprintf(&b, "## Triage run %s\n\n", firstNonEmpty(sessionID, occurredAt))
		legacySlackWriteBullet(&b, "Occurred", occurredAt)
		legacySlackWriteBullet(&b, "Status", status)
		legacySlackWriteBullet(&b, "Channels", channelsJSON)
		legacySlackWriteBullet(&b, "Steps", fmt.Sprint(steps))
		legacySlackWriteBullet(&b, "Duration seconds", fmt.Sprintf("%.2f", durationSeconds))
		legacySlackWriteBullet(&b, "Mutations", fmt.Sprint(mutations))
		legacySlackWriteBullet(&b, "Failures", fmt.Sprint(failures))
		legacySlackWriteBullet(&b, "Tokens used", fmt.Sprint(tokensUsed))
		legacySlackWriteBullet(&b, "Created", createdAt)
		legacySlackWriteBlock(&b, "Summary", summary)
		legacySlackWriteBlock(&b, "Error", runErr)
		legacySlackWriteBlock(&b, "Digest", legacySlackTruncateRunText(digest, 1800))
	}
	return b.String(), count, rows.Err()
}

func legacySlackWriteBullet(b *strings.Builder, label string, value string) {
	value = strings.TrimSpace(value)
	if value == "" {
		return
	}
	fmt.Fprintf(b, "- %s: %s\n", label, strings.ReplaceAll(value, "\n", " "))
}

func legacySlackWriteBlock(b *strings.Builder, label string, value string) {
	value = strings.TrimSpace(value)
	if value == "" {
		b.WriteString("\n")
		return
	}
	fmt.Fprintf(b, "\n%s:\n\n", label)
	for _, line := range strings.Split(strings.ReplaceAll(value, "\r\n", "\n"), "\n") {
		if strings.TrimSpace(line) == "" {
			b.WriteString(">\n")
			continue
		}
		fmt.Fprintf(b, "> %s\n", line)
	}
	b.WriteString("\n")
}

func legacySlackTruncateRunText(value string, limit int) string {
	value = strings.TrimSpace(value)
	if limit <= 0 || len([]rune(value)) <= limit {
		return value
	}
	runes := []rune(value)
	return strings.TrimSpace(string(runes[:limit])) + "\n[truncated]"
}
