package agentrunner

import "strings"

const (
	SessionKindSlack          = "slack_case"
	SessionKindTriage         = "slack_triage"
	SessionKindMeetingCopilot = "meeting_copilot"
	SessionKindCompact        = "memory_compact"
	SessionKindMeetingCalib   = "meeting_calibrate"
	SessionKindMeetingSummary = "meeting_summary"

	SessionRoleAssistant      = "assistant"
	SessionRolePlanner        = "planner"
	SessionRoleMeetingCopilot = "meeting_copilot"
	SessionRoleCompact        = "compact"
	SessionRoleCompletionOnly = "completion_only"
)

type SessionCapabilities struct {
	Kind                  string   `json:"kind"`
	Role                  string   `json:"role"`
	AllowedTools          []string `json:"allowed_tools"`
	BlockedTools          []string `json:"blocked_tools,omitempty"`
	ExternalToolsExcluded bool     `json:"external_tools_excluded"`
	Source                string   `json:"source"`
}

var slackUnsupportedToolNames = []string{
	"ask_question",
	"request_permission",
	"request_secret",
	"send_file",
	"wait_for",
}

var slackPlannerOnlyUnsupportedToolNames = []string{
	"send_message",
}

var compactAllowedToolNames = []string{
	"memory_search",
	"memory_get",
	"memory_write",
}

func CapabilitiesForSessionKind(kind string) SessionCapabilities {
	normalized := NormalizeSessionKind(kind)
	switch normalized {
	case SessionKindMeetingCalib, SessionKindMeetingSummary:
		return newCapabilities(normalized, SessionRoleCompletionOnly, nil, nil)
	case SessionKindMeetingCopilot:
		return newCapabilities(normalized, SessionRoleMeetingCopilot, []string{
			"send_meeting_chat",
			"notify_meeting_slack",
		}, nil)
	case SessionKindTriage:
		return newCapabilities(normalized, SessionRolePlanner, []string{
			"read",
			"write",
			"edit",
			"bash",
			"slack_api",
			"read_doc",
			"person_memory",
			"suggest_action",
			"usage_api",
			"followup_memory",
			"memory_search",
			"memory_get",
			"exa_search",
			"exa_contents",
		}, appendToolNames(slackUnsupportedToolNames, slackPlannerOnlyUnsupportedToolNames...))
	case SessionKindCompact:
		return newCapabilities(normalized, SessionRoleCompact, compactAllowedToolNames, nil)
	default:
		return newCapabilities(SessionKindSlack, SessionRoleAssistant, []string{
			"read",
			"write",
			"edit",
			"bash",
			"send_message",
			"manage_schedule",
			"slack_api",
			"read_doc",
			"memory_write",
			"memory_search",
			"memory_get",
			"person_memory",
			"suggest_action",
			"followup_memory",
			"runtime_status",
			"heartbeat_log",
			"usage_api",
			"exa_search",
			"exa_contents",
		}, slackUnsupportedToolNames)
	}
}

func NormalizeSessionKind(kind string) string {
	switch strings.NewReplacer("_", "-", " ", "-").Replace(strings.ToLower(strings.TrimSpace(kind))) {
	case "slack-triage", "triage":
		return SessionKindTriage
	case "meeting-copilot", "copilot":
		return SessionKindMeetingCopilot
	case "memory-compact", "compact":
		return SessionKindCompact
	case "meeting-calibrate", "calibrate":
		return SessionKindMeetingCalib
	case "meeting-summary", "summary":
		return SessionKindMeetingSummary
	default:
		return SessionKindSlack
	}
}

func WithSessionCapabilities(input StartInput, kind string) StartInput {
	capabilities := CapabilitiesForSessionKind(kind)
	input.Context = cloneMap(input.Context)
	if input.Context == nil {
		input.Context = make(map[string]any)
	}
	input.Context["session_kind"] = capabilities.Kind
	input.Context["session_role"] = capabilities.Role
	input.Context["session_capabilities"] = capabilities
	return input
}

func newCapabilities(kind string, role string, allowed []string, blocked []string) SessionCapabilities {
	return SessionCapabilities{
		Kind:                  kind,
		Role:                  role,
		AllowedTools:          append([]string(nil), allowed...),
		BlockedTools:          append([]string(nil), blocked...),
		ExternalToolsExcluded: true,
		Source:                "cueboard slack-agentd augmentLoopOptions transliteration; credentialed proxy tools excluded by product scope",
	}
}

func appendToolNames(base []string, extra ...string) []string {
	out := append([]string(nil), base...)
	out = append(out, extra...)
	return out
}
