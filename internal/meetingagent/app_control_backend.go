package meetingagent

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
)

const (
	appControlStatusCompleted = "completed"
	appControlStatusFailed    = "failed"
)

type AppControlBackend interface {
	Name() string
	ControlSharedApp(ctx context.Context, req AppControlRequest) (AppControlResult, error)
}

type AppControlRequest struct {
	SessionID   string
	Instruction string
	Target      AppControlTarget
	Operations  []KWWKAppControlOperation
	Context     map[string]any
	Timeout     time.Duration
}

type AppControlTarget struct {
	ApplicationName  string
	BundleIdentifier string
	WindowTitle      string
	WindowID         int
	ProcessID        int
	ScreenShare      map[string]any
}

type AppControlResult struct {
	OK           bool
	Provider     string
	Status       string
	ResponseText string
	Summary      string
	Actions      []string
	Confidence   float64
	Blocker      string
	Error        string
	Job          any
	Report       *WorkerReport
	Raw          any
}

func appControlRequestFromRealtime(input RealtimeSharedAppControlRequest, sessionID string, status map[string]any) AppControlRequest {
	context := cloneMap(input.Context)
	if context == nil {
		context = map[string]any{}
	}
	if input.Standalone {
		context["standalone_app_control"] = true
	}
	return AppControlRequest{
		SessionID:   strings.TrimSpace(sessionID),
		Instruction: strings.TrimSpace(input.Instruction),
		Target:      appControlTargetFromRealtime(input, status),
		Operations:  append([]KWWKAppControlOperation(nil), input.Operations...),
		Context:     context,
		Timeout:     realtimeAppControlTimeout(input.TimeoutMs),
	}
}

func appControlTargetFromRealtime(input RealtimeSharedAppControlRequest, status map[string]any) AppControlTarget {
	target := AppControlTarget{
		ApplicationName:  strings.TrimSpace(input.ApplicationName),
		BundleIdentifier: strings.TrimSpace(input.BundleIdentifier),
		WindowTitle:      strings.TrimSpace(input.WindowTitle),
		WindowID:         input.WindowID,
		ProcessID:        input.ProcessID,
		ScreenShare:      status,
	}
	for _, candidate := range appControlStatusTargetMaps(status) {
		if target.ApplicationName == "" {
			target.ApplicationName = firstMapString(candidate, "applicationName", "appName", "name")
		}
		if target.BundleIdentifier == "" {
			target.BundleIdentifier = firstMapString(candidate, "bundleIdentifier", "bundleID", "bundleId")
		}
		if target.WindowTitle == "" {
			target.WindowTitle = firstMapString(candidate, "windowTitle", "title")
		}
		if target.WindowID == 0 {
			target.WindowID = firstMapInt(candidate, "windowId", "windowID")
		}
		if target.ProcessID == 0 {
			target.ProcessID = firstMapInt(candidate, "processId", "pid")
		}
	}
	return target
}

func appControlStatusTargetMaps(status map[string]any) []map[string]any {
	maps := make([]map[string]any, 0, 4)
	appendMap := func(value any) {
		if candidate, ok := value.(map[string]any); ok {
			maps = append(maps, candidate)
		}
	}
	appendMap(status)
	appendMap(status["screenShare"])
	if active, ok := status["active"].(map[string]any); ok {
		appendMap(active)
		appendMap(active["screenShare"])
	}
	return maps
}

func firstMapString(values map[string]any, keys ...string) string {
	for _, key := range keys {
		switch value := values[key].(type) {
		case string:
			if trimmed := strings.TrimSpace(value); trimmed != "" {
				return trimmed
			}
		}
	}
	return ""
}

func firstMapInt(values map[string]any, keys ...string) int {
	for _, key := range keys {
		switch value := values[key].(type) {
		case int:
			return value
		case int64:
			return int(value)
		case float64:
			return int(value)
		case json.Number:
			if parsed, err := value.Int64(); err == nil {
				return int(parsed)
			}
		}
	}
	return 0
}

func appControlResultMap(result AppControlResult, screenShare map[string]any) map[string]any {
	provider := strings.TrimSpace(result.Provider)
	if provider == "" {
		provider = "app_control"
	}
	status := strings.TrimSpace(result.Status)
	if status == "" {
		if result.OK {
			status = appControlStatusCompleted
		} else {
			status = appControlStatusFailed
		}
	}
	ok := result.OK
	if status == string(agentrunner.StatusTimeout) {
		ok = false
	}
	out := map[string]any{
		"ok":          ok,
		"provider":    provider,
		"status":      status,
		"screenShare": screenShare,
	}
	if strings.TrimSpace(result.ResponseText) != "" {
		out["responseText"] = strings.TrimSpace(result.ResponseText)
	}
	if strings.TrimSpace(result.Summary) != "" {
		out["summary"] = strings.TrimSpace(result.Summary)
	}
	if len(result.Actions) > 0 {
		out["actions"] = append([]string(nil), result.Actions...)
	}
	if result.Confidence != 0 {
		out["confidence"] = result.Confidence
	}
	if strings.TrimSpace(result.Blocker) != "" {
		out["blocker"] = strings.TrimSpace(result.Blocker)
	}
	if strings.TrimSpace(result.Error) != "" {
		out["error"] = strings.TrimSpace(result.Error)
	}
	if result.Job != nil {
		out["job"] = result.Job
	}
	if result.Report != nil {
		out["report"] = result.Report
	}
	if result.Raw != nil {
		out["backendResult"] = result.Raw
		if provider == "codex" {
			out["workerResult"] = result.Raw
		}
	}
	return out
}

type KWWKAppControlOperationKind string

const (
	KWWKAppControlState                  KWWKAppControlOperationKind = "state"
	KWWKAppControlClick                  KWWKAppControlOperationKind = "click"
	KWWKAppControlTypeText               KWWKAppControlOperationKind = "type_text"
	KWWKAppControlPressKey               KWWKAppControlOperationKind = "press_key"
	KWWKAppControlScroll                 KWWKAppControlOperationKind = "scroll"
	KWWKAppControlDrag                   KWWKAppControlOperationKind = "drag"
	KWWKAppControlPerformSecondaryAction KWWKAppControlOperationKind = "perform_secondary_action"
)

type KWWKAppControlOperation struct {
	Kind      KWWKAppControlOperationKind `json:"kind"`
	Text      string                      `json:"text,omitempty"`
	Key       string                      `json:"key,omitempty"`
	Direction string                      `json:"direction,omitempty"`
	X         float64                     `json:"x,omitempty"`
	Y         float64                     `json:"y,omitempty"`
	FromX     float64                     `json:"from_x,omitempty"`
	FromY     float64                     `json:"from_y,omitempty"`
	ToX       float64                     `json:"to_x,omitempty"`
	ToY       float64                     `json:"to_y,omitempty"`
}

type KWWKAppControlTarget struct {
	ApplicationName  string         `json:"application_name,omitempty"`
	BundleIdentifier string         `json:"bundle_identifier,omitempty"`
	WindowTitle      string         `json:"window_title,omitempty"`
	WindowID         int            `json:"window_id,omitempty"`
	ProcessID        int            `json:"process_id,omitempty"`
	ScreenShare      map[string]any `json:"screen_share,omitempty"`
}

func KWWKTargetFromAppControl(target AppControlTarget) KWWKAppControlTarget {
	return KWWKAppControlTarget(target)
}

func requireAppControlBackend(backend AppControlBackend) error {
	if backend == nil {
		return fmt.Errorf("app_control_backend_unavailable")
	}
	if strings.TrimSpace(backend.Name()) == "" {
		return fmt.Errorf("app_control_backend_missing_name")
	}
	return nil
}
