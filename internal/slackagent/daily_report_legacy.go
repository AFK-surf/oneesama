package slackagent

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

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
	defer func() { _ = db.Close() }()
	rows, err := db.QueryContext(ctx, `select id, session_id, occurred_at, status, summary, error, digest, steps, duration_seconds, mutations, failures, tokens_used, channels_json, raw_output from triage_run where unixepoch(occurred_at) >= unixepoch(?) and unixepoch(occurred_at) <= unixepoch(?) order by occurred_at asc, id asc`, start.UTC().Format(time.RFC3339Nano), end.UTC().Format(time.RFC3339Nano))
	if err != nil {
		return nil, fmt.Errorf("query legacy triage_run: %w", err)
	}
	defer func() { _ = rows.Close() }()
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
	defer func() { _ = actions.Close() }()
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
	defer func() { _ = tools.Close() }()
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
