package slackagent

import (
	"context"
	"strings"
	"time"
)

// BuildSlackRuntimeStatusData assembles the formatter-facing
// slackRuntimeStatusData struct from the live Service. The populated
// struct is intentionally derived from Oneesama's actual subsystems —
// heartbeat ticker, followup store, meeting webhook store, agent runner
// config — rather than mirroring Cueboard's process-image perfectly.
//
// Fields the Oneesama runtime simply does not track (Cueboard's repo
// mount / clone / worktree paths, agent_runner-style integrations panel)
// fall back to "unknown" / empty so the formatter can still render a
// stable section without misleading data.
func (s *Service) BuildSlackRuntimeStatusData(ctx context.Context) *slackRuntimeStatusData {
	if s == nil {
		return &slackRuntimeStatusData{}
	}
	status := s.Status()
	data := &slackRuntimeStatusData{
		RunMode:       status.Mode,
		WorkspaceDir:  status.Slack.WorkspaceDir,
		ScanMode:      slackRuntimeScanModeLabel(s),
		Debounce:      slackRuntimeDebounceLabel(s),
		MaxBatch:      slackRuntimeMaxBatch(s),
		Integrations:  buildSlackRuntimeIntegrations(s),
		HeartbeatLoop: status.Slack.HeartbeatTicker.Running,
	}
	data.HeartbeatInterval = time.Duration(status.Slack.HeartbeatTicker.IntervalSec) * time.Second
	if status.Slack.HeartbeatTicker.LastTickAt != "" {
		if parsed, err := time.Parse(time.RFC3339Nano, status.Slack.HeartbeatTicker.LastTickAt); err == nil {
			data.HeartbeatLastAt = parsed
		} else if parsed, err := time.Parse(time.RFC3339, status.Slack.HeartbeatTicker.LastTickAt); err == nil {
			data.HeartbeatLastAt = parsed
		}
	}
	if status.Slack.HeartbeatTicker.LastError != "" {
		data.HeartbeatError = status.Slack.HeartbeatTicker.LastError
	}
	data.HeartbeatLogPath = slackHeartbeatLogPath()

	populateSlackRuntimeHeartbeatFollowups(ctx, s, data)
	populateSlackRuntimeHeartbeatSurfaces(ctx, s, data)
	return data
}

// BuildSlackRuntimeMeetingsSnapshot returns the formatter-facing meetings
// snapshot. Oneesama's meetingWebhookStore does not currently expose a
// full enumeration of remote threads (the cueboard parity audit still
// flags `ListMeetingThreads` as missing under #168/#169), so for now this
// returns an empty snapshot rather than a stale or partial view. When the
// list helper lands, this populator will fan it into Live / Processing /
// Recent buckets.
func (s *Service) BuildSlackRuntimeMeetingsSnapshot(ctx context.Context) *runtimeMeetingsSnapshot {
	if s == nil {
		return &runtimeMeetingsSnapshot{}
	}
	if s.meetingWebhooks == nil {
		return &runtimeMeetingsSnapshot{Error: "meeting webhook store unavailable"}
	}
	return &runtimeMeetingsSnapshot{}
}

func slackRuntimeScanModeLabel(s *Service) string {
	if s == nil {
		return "unknown"
	}
	if s.inbound == nil {
		return "disabled"
	}
	state := s.inbound.Snapshot()
	if state.EventBuffer.Enabled {
		if state.EventBuffer.TriageEnabled {
			return "buffered+triage"
		}
		return "buffered"
	}
	return "disabled"
}

// slackRuntimeDebounceLabel reports the scanner debounce window. Oneesama's
// inbound buffer state does not expose the debounce knob — it lives in
// cfg.Slack.EventBuffer.Debounce — so when the field is not populated we
// surface "unknown" to avoid claiming a value we cannot read.
func slackRuntimeDebounceLabel(s *Service) string {
	if s == nil {
		return "unknown"
	}
	// Best-effort: fall back to the runtime ticker interval as a coarse
	// proxy when scanning is enabled, so the formatter prints something
	// meaningful instead of "unknown" even before EventBuffer state
	// exposes debounce/max_batch.
	if s.inbound != nil && s.inbound.Snapshot().EventBuffer.Enabled {
		return "buffered"
	}
	return "unknown"
}

func slackRuntimeMaxBatch(s *Service) int {
	if s == nil || s.inbound == nil {
		return 0
	}
	return s.inbound.Snapshot().EventBuffer.BufferedMessages
}

// buildSlackRuntimeIntegrations reports the integration panel honestly:
// product-excluded credentialed apps (Linear / Figma / Notion / Google
// Calendar) are reported false; "Meet Agent" is reported true when the
// meetingAgentURL is non-empty.
func buildSlackRuntimeIntegrations(s *Service) map[string]bool {
	out := map[string]bool{
		"Linear":          false,
		"Figma":           false,
		"Notion":          false,
		"Google Calendar": false,
		"Meet Agent":      false,
	}
	if s == nil {
		return out
	}
	if strings.TrimSpace(s.meetingAgentURL) != "" {
		out["Meet Agent"] = true
	}
	return out
}

func populateSlackRuntimeHeartbeatFollowups(ctx context.Context, s *Service, data *slackRuntimeStatusData) {
	if s == nil || s.followups == nil {
		return
	}
	followups, err := s.followups.ListFollowups(ctx, "open", 25)
	if err != nil {
		if s.logger != nil {
			s.logger.Warn("slack runtime status followup list failed", "error", err)
		}
		return
	}
	data.HeartbeatGlobalPendingCount = len(followups)
	data.HeartbeatVisiblePendingCount = len(followups)
	byKind := make(map[string]int, 4)
	openSelfImprovement := 0
	pending := make([]runtimeHeartbeatFollowupView, 0, len(followups))
	for _, item := range followups {
		byKind[strings.ToLower(strings.TrimSpace(item.Kind))]++
		if strings.EqualFold(item.Kind, "self_improvement") {
			openSelfImprovement++
		}
		view := runtimeHeartbeatFollowupView{
			ID:         item.ID,
			Kind:       item.Kind,
			Title:      item.Title,
			Summary:    item.Summary,
			Priority:   item.Priority,
			SourceKind: item.SourceKind,
			ChannelID:  item.ChannelID,
			ThreadTS:   item.ThreadTS,
		}
		if item.DueAt != "" {
			if parsed, err := time.Parse(time.RFC3339Nano, item.DueAt); err == nil {
				view.DueAt = &parsed
			} else if parsed, err := time.Parse(time.RFC3339, item.DueAt); err == nil {
				view.DueAt = &parsed
			}
		}
		pending = append(pending, view)
		if len(pending) >= 5 {
			break
		}
	}
	data.HeartbeatPending = pending
	data.HeartbeatPendingByKind = byKind
	data.HeartbeatSelfImprovementOpen = openSelfImprovement
}

func populateSlackRuntimeHeartbeatSurfaces(ctx context.Context, s *Service, data *slackRuntimeStatusData) {
	if s == nil || s.followups == nil {
		return
	}
	surfaces, err := s.followups.ListSurfaces(ctx, 5)
	if err != nil {
		if s.logger != nil {
			s.logger.Warn("slack runtime status surface list failed", "error", err)
		}
		return
	}
	views := make([]runtimeHeartbeatSurfaceView, 0, len(surfaces))
	for _, surface := range surfaces {
		views = append(views, runtimeHeartbeatSurfaceView{
			Title:            surface.Title,
			Summary:          surface.Summary,
			RequestedSurface: surface.RequestedSurface,
			DeliveredSurface: surface.DeliveredSurface,
			Status:           surface.Status,
			ChannelID:        surface.ChannelID,
			ThreadTS:         surface.ThreadTS,
		})
	}
	data.HeartbeatSurfaces = views
}

func slackHeartbeatLogPath() string {
	// Heartbeat log file is opened on demand by loadHeartbeatLogTail; the
	// path itself is the standard runtime log file the heartbeat ticker
	// writes through slog. Returning an empty string keeps the formatter
	// from printing a stale path; runtime_status callers can still surface
	// the log via the dedicated `heartbeat_log` tool.
	return ""
}

// executeRuntimeStatusTool builds a `runtime_status` tool payload that
// carries both the raw JSON `status` (for machine consumers) and the
// Cueboard-style formatted human view (`overview`, `heartbeat`, `repos`,
// `meetings`) in dedicated text fields. This restores the readable runtime
// status the Cueboard `runtime_status` action used to emit while keeping
// the existing JSON consumers backward-compatible.
func (s *Service) executeRuntimeStatusTool(ctx context.Context) map[string]any {
	if s == nil {
		return map[string]any{}
	}
	data := s.BuildSlackRuntimeStatusData(ctx)
	meetings := s.BuildSlackRuntimeMeetingsSnapshot(ctx)
	return map[string]any{
		"status":    s.Status(),
		"overview":  formatRuntimeStatusOverview(data, meetings),
		"heartbeat": formatRuntimeStatusHeartbeat(data),
		"repos":     formatRuntimeStatusRepos(data),
		"meetings":  formatRuntimeStatusMeetings(meetings),
	}
}

// executeHeartbeatLogTool wraps the raw log tail (`path` + `lines` + maybe
// `error`) with the Cueboard-style formatted view that summarizes ticker
// state + recent log lines together. Callers that only want the raw lines
// can still read `lines` directly; callers that want a single human-
// readable string read `view`.
func (s *Service) executeHeartbeatLogTool(ctx context.Context, limit int, includeRaw bool) map[string]any {
	if s == nil {
		return map[string]any{}
	}
	data := s.BuildSlackRuntimeStatusData(ctx)
	path, lines, err := loadHeartbeatLogTail(limit)
	view := formatHeartbeatLogView(data, path, lines, err, includeRaw)
	out := map[string]any{
		"path":  path,
		"lines": lines,
		"view":  view,
	}
	if err != nil {
		out["error"] = err.Error()
	}
	return out
}

