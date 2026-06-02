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

func normalizeAppControlStatus(status string) string {
	return strings.ToLower(strings.TrimSpace(status))
}

func appControlStatusIsSuccess(status string) bool {
	switch normalizeAppControlStatus(status) {
	case appControlStatusCompleted, "done":
		return true
	default:
		return false
	}
}

func appControlStatusIsFailure(status string) bool {
	switch normalizeAppControlStatus(status) {
	case appControlStatusFailed, string(agentrunner.StatusTimeout), "blocked", "error", "stale", "canceled", "cancelled":
		return true
	default:
		return false
	}
}

func appControlStatusIsPending(status string) bool {
	switch normalizeAppControlStatus(status) {
	case "", appControlStatusQueued, appControlStatusRunning:
		return true
	default:
		return false
	}
}

func appControlStatusIsTerminalFailure(status string) bool {
	normalized := normalizeAppControlStatus(status)
	if appControlStatusIsFailure(normalized) {
		return true
	}
	if appControlStatusIsSuccess(normalized) || appControlStatusIsPending(normalized) {
		return false
	}
	return true
}

type AppControlBackend interface {
	Name() string
	ControlSharedApp(ctx context.Context, req AppControlRequest) (AppControlResult, error)
}

type AppControlRequest struct {
	SessionID     string
	Instruction   string
	ExecutionMode string
	Target        AppControlTarget
	Operations    []KWWKAppControlOperation
	Context       map[string]any
	Timeout       time.Duration
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
	target := appControlTargetFromRealtime(input, status)
	target.ScreenShare = compactRealtimeAppControlStatus(status, target)
	return AppControlRequest{
		SessionID:     strings.TrimSpace(sessionID),
		Instruction:   strings.TrimSpace(input.Instruction),
		ExecutionMode: normalizeAppControlExecutionMode(input.ExecutionMode),
		Target:        target,
		Operations:    append([]KWWKAppControlOperation(nil), input.Operations...),
		Context:       context,
		Timeout:       realtimeAppControlTimeout(input.TimeoutMs),
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
	status := normalizeAppControlStatus(result.Status)
	if status == "" {
		if result.OK {
			status = appControlStatusCompleted
		} else {
			status = appControlStatusFailed
		}
	}
	ok := result.OK
	if appControlStatusIsTerminalFailure(status) {
		ok = false
	}
	errorText := strings.TrimSpace(result.Error)
	blockerText := strings.TrimSpace(result.Blocker)
	if status == string(agentrunner.StatusTimeout) && errorText == "" && blockerText == "" {
		errorText = "app_control_timeout"
		blockerText = "app_control_timeout"
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
	if blockerText != "" {
		out["blocker"] = blockerText
	}
	if errorText != "" {
		out["error"] = errorText
	}
	if displayText := appControlResultDisplayTextZh(ok, status, blockerText, errorText); displayText != "" {
		out["displayText"] = displayText
		out["answer_hint_zh"] = displayText
	}
	if result.Job != nil {
		out["job"] = result.Job
	}
	if result.Report != nil {
		out["report"] = result.Report
	}
	if result.Raw != nil {
		raw := sanitizeAppControlBackendResult(result.Raw)
		out["backendResult"] = raw
		if provider == "codex" {
			out["workerResult"] = raw
		}
	}
	return out
}

func appControlResultDisplayTextZh(ok bool, status string, blocker string, errorText string) string {
	if ok && !appControlStatusIsTerminalFailure(status) {
		return ""
	}
	reason := strings.ToLower(strings.TrimSpace(strings.Join([]string{blocker, errorText, status}, " ")))
	switch {
	case strings.Contains(reason, "blocked_permission"),
		strings.Contains(reason, "permission"),
		strings.Contains(reason, "accessibility"),
		strings.Contains(reason, "screen_recording"):
		return "需要权限"
	case strings.Contains(reason, "blocked_ambiguous_target"),
		strings.Contains(reason, "ambiguous"):
		return "目标不明确"
	case strings.Contains(reason, "blocked_no_target_app"),
		strings.Contains(reason, "no_target"),
		strings.Contains(reason, "target_app"),
		strings.Contains(reason, "window_not_found"),
		strings.Contains(reason, "shared_window_not_found"):
		return "找不到窗口"
	case strings.Contains(reason, "needs_background_agent"):
		return "交给后台"
	case strings.Contains(reason, "blocked_unsupported_instruction"),
		strings.Contains(reason, "instruction_not_directly_executable"),
		strings.Contains(reason, "unsupported_instruction"),
		strings.Contains(reason, "unsupported_operation"):
		return "暂不支持"
	case strings.Contains(reason, "failed_verification"):
		return "验证失败"
	default:
		return "操作失败"
	}
}

func sanitizeAppControlBackendResult(value any) any {
	switch raw := value.(type) {
	case []KWWKAppControlOperation:
		return map[string]any{
			"operationsSuppressed": len(raw),
		}
	case []map[string]any:
		if appControlOperationMapSlice(raw) {
			return map[string]any{
				"operationsSuppressed": len(raw),
			}
		}
		out := make([]map[string]any, 0, len(raw))
		for _, entry := range raw {
			sanitized, ok := sanitizeAppControlBackendResult(entry).(map[string]any)
			if ok {
				out = append(out, sanitized)
			}
		}
		return out
	case []any:
		if appControlOperationAnySlice(raw) {
			return map[string]any{
				"operationsSuppressed": len(raw),
			}
		}
		out := make([]any, 0, len(raw))
		for _, entry := range raw {
			out = append(out, sanitizeAppControlBackendResult(entry))
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(raw))
		for key, nested := range raw {
			if key == "operations" {
				out["operationsSuppressed"] = suppressedOperationCount(nested)
				continue
			}
			out[key] = sanitizeAppControlBackendResult(nested)
		}
		return out
	default:
		return value
	}
}

func appControlOperationMapSlice(values []map[string]any) bool {
	if len(values) == 0 {
		return false
	}
	for _, value := range values {
		if !validKWWKAppControlOperationKind(firstMapString(value, "kind")) {
			return false
		}
	}
	return true
}

func appControlOperationAnySlice(values []any) bool {
	if len(values) == 0 {
		return false
	}
	for _, value := range values {
		switch entry := value.(type) {
		case KWWKAppControlOperation:
			continue
		case map[string]any:
			if validKWWKAppControlOperationKind(firstMapString(entry, "kind")) {
				continue
			}
		}
		return false
	}
	return true
}

func validKWWKAppControlOperationKind(kind string) bool {
	switch KWWKAppControlOperationKind(strings.TrimSpace(kind)) {
	case KWWKAppControlState,
		KWWKAppControlClick,
		KWWKAppControlTypeText,
		KWWKAppControlPressKey,
		KWWKAppControlScroll,
		KWWKAppControlDrag,
		KWWKAppControlPerformSecondaryAction:
		return true
	default:
		return false
	}
}

func suppressedOperationCount(value any) int {
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
