package meetingagent

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/AFK-surf/oneesama/internal/meetrunner"
)

const defaultRealtimeAppControlTimeout = 15 * time.Second

type RealtimeSharedAppControlRequest struct {
	SessionID        string                    `json:"session_id,omitempty"`
	JobID            string                    `json:"job_id,omitempty"`
	Instruction      string                    `json:"instruction,omitempty"`
	ExecutionMode    string                    `json:"executionMode,omitempty"`
	Standalone       bool                      `json:"standalone,omitempty"`
	ApplicationName  string                    `json:"applicationName,omitempty"`
	BundleIdentifier string                    `json:"bundleIdentifier,omitempty"`
	WindowTitle      string                    `json:"windowTitle,omitempty"`
	WindowID         int                       `json:"windowId,omitempty"`
	ProcessID        int                       `json:"processId,omitempty"`
	Operations       []KWWKAppControlOperation `json:"operations,omitempty"`
	TimeoutMs        int                       `json:"timeoutMs,omitempty"`
	Wait             bool                      `json:"wait,omitempty"`
	Context          map[string]any            `json:"context,omitempty"`
}

func (s *Service) ControlRealtimeSharedApp(ctx context.Context, input RealtimeSharedAppControlRequest) map[string]any {
	if strings.TrimSpace(input.JobID) != "" {
		status, ok := s.appControlJobStatus(input.JobID)
		if !ok {
			return map[string]any{
				"ok":     false,
				"error":  "app_control_job_not_found",
				"job_id": strings.TrimSpace(input.JobID),
			}
		}
		return status
	}
	if input.Standalone {
		return map[string]any{
			"ok":    false,
			"error": "standalone_app_control_not_allowed",
		}
	}
	input, strippedOperations := stripRealtimeAppControlPrimitiveOperations(input)
	if strippedOperations > 0 {
		s.logger.Warn(
			"discarding stale realtime app-control primitive operations",
			"operations", strippedOperations,
			"session_id", strings.TrimSpace(input.SessionID),
			"standalone", input.Standalone,
		)
	}
	instruction := strings.TrimSpace(input.Instruction)
	if instruction == "" {
		return map[string]any{
			"ok":    false,
			"error": "instruction_required",
		}
	}
	sessionID := strings.TrimSpace(input.SessionID)
	resolvedSessionID, err := s.resolveScreenShareSessionID(ctx, sessionID)
	if err != nil {
		return map[string]any{
			"ok":    false,
			"error": err.Error(),
		}
	}
	sessionID = resolvedSessionID
	rawStatus := s.realtimeAppControlStatus(ctx, sessionID)
	request := appControlRequestFromRealtime(input, sessionID, rawStatus)
	backend := s.appControlBackendForRequest(request)
	if err := requireAppControlBackend(backend); err != nil {
		return map[string]any{
			"ok":    false,
			"error": err.Error(),
		}
	}
	if !input.Wait {
		queued, err := s.enqueueAppControlJob(request, request.Target.ScreenShare, backend)
		if err != nil {
			queued["screenShare"] = request.Target.ScreenShare
		}
		return queued
	}
	start := time.Now()
	result, err := backend.ControlSharedApp(ctx, request)
	elapsed := time.Since(start)
	if err != nil {
		s.logger.Warn(
			"realtime app-control backend error",
			"provider", backend.Name(),
			"session_id", sessionID,
			"duration", elapsed.String(),
			"error", err.Error(),
		)
		return map[string]any{
			"ok":          false,
			"error":       err.Error(),
			"provider":    backend.Name(),
			"status":      appControlStatusFailed,
			"screenShare": request.Target.ScreenShare,
		}
	}
	s.logger.Info(
		"realtime app-control backend result",
		"provider", firstNonEmpty(result.Provider, backend.Name()),
		"session_id", sessionID,
		"ok", result.OK,
		"status", result.Status,
		"duration", elapsed.String(),
		"error", result.Error,
		"blocker", result.Blocker,
		"actions", strings.Join(result.Actions, ","),
	)
	return appControlResultMap(result, request.Target.ScreenShare)
}

func stripRealtimeAppControlPrimitiveOperations(input RealtimeSharedAppControlRequest) (RealtimeSharedAppControlRequest, int) {
	stripped := len(input.Operations)
	input.Operations = nil
	if input.Context == nil {
		return input, stripped
	}
	context := cloneMap(input.Context)
	if operations, ok := context["operations"]; ok {
		stripped += appControlOperationCount(operations)
		delete(context, "operations")
	}
	input.Context = context
	return input, stripped
}

func appControlOperationCount(value any) int {
	switch operations := value.(type) {
	case []KWWKAppControlOperation:
		return len(operations)
	case []map[string]any:
		return len(operations)
	case []any:
		return len(operations)
	default:
		return 0
	}
}

func (s *Service) appControlBackendForRequest(req AppControlRequest) AppControlBackend {
	if s == nil {
		return nil
	}
	if normalizeAppControlExecutionMode(req.ExecutionMode) == appControlExecutionModeDelegate {
		return NewCodexAppControlBackend(s)
	}
	return s.appControlBackend
}

const (
	appControlExecutionModeDirect   = "direct"
	appControlExecutionModeDelegate = "delegate"
)

func normalizeAppControlExecutionMode(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "delegate", "codex", "worker", "complex":
		return appControlExecutionModeDelegate
	default:
		return appControlExecutionModeDirect
	}
}

func buildRealtimeAppControlTask(input RealtimeSharedAppControlRequest, status map[string]any) string {
	payload, _ := json.MarshalIndent(map[string]any{
		"instruction":        strings.TrimSpace(input.Instruction),
		"executionMode":      normalizeAppControlExecutionMode(input.ExecutionMode),
		"applicationName":    strings.TrimSpace(input.ApplicationName),
		"bundleIdentifier":   strings.TrimSpace(input.BundleIdentifier),
		"windowTitle":        strings.TrimSpace(input.WindowTitle),
		"windowId":           input.WindowID,
		"processId":          input.ProcessID,
		"currentShareStatus": status,
	}, "", "  ")
	scope := "Operate the currently shared macOS app/window for the live meeting."
	return strings.Join([]string{
		scope,
		"Use the high-level Computer Use capability exposed by the runtime. Keep the observe -> plan -> act -> verify loop inside this executor, including unfamiliar apps. Do not ask the foreground Realtime model or the user for click/drag primitives.",
		"Observe the current shared window first when needed, plan a short bounded action sequence, act through Computer Use, then verify the visible outcome with the app/window state or screenshot before returning success.",
		"Do not implement low-level CGEvent, AppleScript, shell, or repository-code UI automation.",
		"Keep the operation bounded to the target app/window. If you cannot access the app or the requested action is unsafe/destructive, return a blocker instead of improvising.",
		`Return exactly one JSON object: {"ok":true,"summary":"what changed or what blocker you hit","actions":["short action list"],"confidence":0.0,"blocker":""}. Use ok:false with a concise blocker if verification fails.`,
		"Request:\n" + string(payload),
	}, "\n\n")
}

func compactRealtimeAppControlStatus(status map[string]any, target AppControlTarget) map[string]any {
	out := map[string]any{}
	if value, ok := status["ok"].(bool); ok {
		out["ok"] = value
	}
	if value := strings.TrimSpace(firstNonEmpty(firstMapString(status, "session_id", "sessionId"), targetSessionID(status))); value != "" {
		out["session_id"] = value
	}
	active := false
	if value, ok := status["active"].(bool); ok {
		active = value
	} else if _, ok := status["active"].(map[string]any); ok {
		active = true
	}
	if active {
		out["active"] = true
	}
	if value := strings.TrimSpace(firstMapString(status, "error")); value != "" {
		out["error"] = value
	}

	share := compactRealtimeAppControlShare(status, target)
	if len(share) > 0 {
		out["screenShare"] = share
		for _, key := range []string{
			"applicationName",
			"bundleIdentifier",
			"windowTitle",
			"title",
			"subtitle",
			"windowId",
			"processId",
		} {
			if value, ok := share[key]; ok {
				out[key] = value
			}
		}
	}
	return out
}

func compactRealtimeAppControlShare(status map[string]any, target AppControlTarget) map[string]any {
	share := map[string]any{}
	candidates := appControlStatusTargetMaps(status)
	if target.ApplicationName != "" {
		share["applicationName"] = target.ApplicationName
	}
	if target.BundleIdentifier != "" {
		share["bundleIdentifier"] = target.BundleIdentifier
	}
	if target.WindowTitle != "" {
		share["windowTitle"] = target.WindowTitle
		share["title"] = target.WindowTitle
	}
	if target.WindowID != 0 {
		share["windowId"] = target.WindowID
	}
	if target.ProcessID != 0 {
		share["processId"] = target.ProcessID
	}
	if value, ok := firstMapBool(candidates, "active", "enabled", "ok"); ok {
		share["active"] = value
	}
	for _, key := range []string{
		"title",
		"subtitle",
		"mode",
		"imageUrl",
		"videoUrl",
		"startedAt",
		"stoppedAt",
		"source",
	} {
		if _, exists := share[key]; exists {
			continue
		}
		if value := firstMapStringFromCandidates(candidates, key); value != "" {
			share[key] = value
		}
	}
	for _, key := range []string{"width", "height", "frames", "fps"} {
		if value, ok := firstMapIntFromCandidates(candidates, key); ok {
			share[key] = value
		}
	}
	if len(share) == 0 && len(status) > 0 {
		share["available"] = true
	}
	return share
}

func targetSessionID(status map[string]any) string {
	if session, ok := status["session"].(map[string]any); ok {
		return firstMapString(session, "id", "session_id", "sessionId")
	}
	if active, ok := status["active"].(map[string]any); ok {
		return firstMapString(active, "sessionId", "session_id", "id")
	}
	return ""
}

func firstMapStringFromCandidates(candidates []map[string]any, keys ...string) string {
	for _, candidate := range candidates {
		if value := firstMapString(candidate, keys...); value != "" {
			return value
		}
	}
	return ""
}

func firstMapIntFromCandidates(candidates []map[string]any, keys ...string) (int, bool) {
	for _, candidate := range candidates {
		for _, key := range keys {
			switch value := candidate[key].(type) {
			case int:
				if value != 0 {
					return value, true
				}
			case int64:
				if value != 0 {
					return int(value), true
				}
			case float64:
				if value != 0 {
					return int(value), true
				}
			case json.Number:
				if parsed, err := value.Int64(); err == nil && parsed != 0 {
					return int(parsed), true
				}
			}
		}
	}
	return 0, false
}

func firstMapBool(candidates []map[string]any, keys ...string) (bool, bool) {
	for _, candidate := range candidates {
		for _, key := range keys {
			if value, ok := candidate[key].(bool); ok {
				return value, true
			}
		}
	}
	return false, false
}

func realtimeAppControlContext(input RealtimeSharedAppControlRequest, sessionID string, status map[string]any) map[string]any {
	context := cloneMap(input.Context)
	if context == nil {
		context = map[string]any{}
	}
	context["source"] = "meeting-realtime-shared-app-control"
	context["meeting_session_id"] = strings.TrimSpace(sessionID)
	context["application_name"] = strings.TrimSpace(input.ApplicationName)
	context["bundle_identifier"] = strings.TrimSpace(input.BundleIdentifier)
	context["window_title"] = strings.TrimSpace(input.WindowTitle)
	context["window_id"] = input.WindowID
	context["process_id"] = input.ProcessID
	context["execution_mode"] = normalizeAppControlExecutionMode(input.ExecutionMode)
	context["screen_share_status"] = status
	context["output_contract"] = map[string]any{
		"format": "json_object_only",
		"fields": []string{"ok", "summary", "actions", "confidence", "blocker"},
	}
	return context
}

func (s *Service) realtimeAppControlStatus(ctx context.Context, sessionID string) map[string]any {
	status := map[string]any{
		"session_id": strings.TrimSpace(sessionID),
	}
	if s.meetRunner == nil {
		status["ok"] = false
		status["error"] = "meet_runner_unavailable"
		return status
	}
	runtime, err := s.meetRunner.StatusSession(ctx, meetrunner.StatusSessionInput{SessionID: sessionID})
	if err != nil {
		status["ok"] = false
		status["error"] = err.Error()
		return status
	}
	status["ok"] = runtime.OK
	status["active"] = runtime.Active
	status["session"] = runtime.Session
	return status
}

func realtimeAppControlTimeout(timeoutMs int) time.Duration {
	if timeoutMs <= 0 {
		return defaultRealtimeAppControlTimeout
	}
	return time.Duration(timeoutMs) * time.Millisecond
}
