package meetingagent

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/AFK-surf/oneesama/internal/meetrunner"
)

const defaultRealtimeAppControlTimeout = 2 * time.Second

type RealtimeSharedAppControlRequest struct {
	SessionID        string                    `json:"session_id,omitempty"`
	JobID            string                    `json:"job_id,omitempty"`
	Instruction      string                    `json:"instruction,omitempty"`
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
	instruction := strings.TrimSpace(input.Instruction)
	if instruction == "" && len(input.Operations) == 0 {
		return map[string]any{
			"ok":    false,
			"error": "instruction_required",
		}
	}
	if err := requireAppControlBackend(s.appControlBackend); err != nil {
		return map[string]any{
			"ok":    false,
			"error": err.Error(),
		}
	}
	sessionID, err := s.resolveScreenShareSessionID(ctx, input.SessionID)
	if err != nil {
		return map[string]any{
			"ok":    false,
			"error": err.Error(),
		}
	}
	status := s.realtimeAppControlStatus(ctx, sessionID)
	request := appControlRequestFromRealtime(input, sessionID, status)
	if request.Instruction == "" {
		request.Instruction = "execute structured app-control operations"
	}
	if !input.Wait {
		queued, err := s.enqueueAppControlJob(request, status)
		if err != nil {
			queued["screenShare"] = status
		}
		return queued
	}
	start := time.Now()
	result, err := s.appControlBackend.ControlSharedApp(ctx, request)
	elapsed := time.Since(start)
	if err != nil {
		s.logger.Warn(
			"realtime app-control backend error",
			"provider", s.appControlBackend.Name(),
			"session_id", sessionID,
			"duration", elapsed.String(),
			"error", err.Error(),
		)
		return map[string]any{
			"ok":          false,
			"error":       err.Error(),
			"provider":    s.appControlBackend.Name(),
			"status":      appControlStatusFailed,
			"screenShare": status,
		}
	}
	s.logger.Info(
		"realtime app-control backend result",
		"provider", firstNonEmpty(result.Provider, s.appControlBackend.Name()),
		"session_id", sessionID,
		"ok", result.OK,
		"status", result.Status,
		"duration", elapsed.String(),
		"error", result.Error,
		"blocker", result.Blocker,
		"actions", strings.Join(result.Actions, ","),
	)
	return appControlResultMap(result, status)
}

func buildRealtimeAppControlTask(input RealtimeSharedAppControlRequest, status map[string]any) string {
	payload, _ := json.MarshalIndent(map[string]any{
		"instruction":        strings.TrimSpace(input.Instruction),
		"applicationName":    strings.TrimSpace(input.ApplicationName),
		"bundleIdentifier":   strings.TrimSpace(input.BundleIdentifier),
		"windowTitle":        strings.TrimSpace(input.WindowTitle),
		"windowId":           input.WindowID,
		"processId":          input.ProcessID,
		"operations":         input.Operations,
		"currentShareStatus": status,
	}, "", "  ")
	return strings.Join([]string{
		"Operate the currently shared macOS app/window for the live meeting.",
		"Use the high-level Computer Use capability exposed by the runtime (Codex or KWWK). Do not implement low-level CGEvent, AppleScript, shell, or repository-code UI automation.",
		"Keep the operation bounded to the target app/window. If you cannot access the app or the requested action is unsafe/destructive, return a blocker instead of improvising.",
		`Return exactly one JSON object: {"ok":true,"summary":"what changed or what blocker you hit","actions":["short action list"],"confidence":0.0,"blocker":""}.`,
		"Request:\n" + string(payload),
	}, "\n\n")
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
	context["operations"] = append([]KWWKAppControlOperation(nil), input.Operations...)
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
