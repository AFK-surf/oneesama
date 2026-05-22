package meetingagent

const (
	RealtimeToolClassStableForeground   = "stable_foreground"
	RealtimeToolClassOptionalForeground = "optional_foreground"
	RealtimeToolClassDeprecatedAlias    = "deprecated_alias"
	RealtimeToolClassWorkerOnly         = "worker_only"
)

type RealtimeForegroundToolInventoryItem struct {
	Name  string `json:"name"`
	Class string `json:"class"`
	Gate  string `json:"gate"`
	Notes string `json:"notes,omitempty"`
}

var realtimeForegroundToolInventoryByName = map[string]RealtimeForegroundToolInventoryItem{
	"delegate_to_worker": {
		Class: RealtimeToolClassStableForeground,
		Gate:  "session_capabilities",
		Notes: "stable bounded-worker boundary for non-realtime work; worker scratch must stay behind result envelopes",
	},
	"worker_status": {
		Class: RealtimeToolClassStableForeground,
		Gate:  "session_capabilities",
		Notes: "reads bounded worker result/status envelopes",
	},
	"delegate_to_codex": {
		Class: RealtimeToolClassDeprecatedAlias,
		Gate:  "compat_alias_delegate_to_worker",
		Notes: "compatibility alias; new flows should use delegate_to_worker",
	},
	"delegate_status": {
		Class: RealtimeToolClassDeprecatedAlias,
		Gate:  "compat_alias_worker_status",
		Notes: "compatibility alias; new flows should use worker_status",
	},
	"send_meet_chat": {
		Class: RealtimeToolClassStableForeground,
		Gate:  "active_meeting_session",
		Notes: "meeting-local visible write; not available to demo-surface workers",
	},
	"present_video_stage": {
		Class: RealtimeToolClassStableForeground,
		Gate:  "active_meeting_session",
		Notes: "presentation control over existing screen-share bridge",
	},
	"stop_video_stage": {
		Class: RealtimeToolClassStableForeground,
		Gate:  "active_meeting_session",
		Notes: "presentation stop control over existing screen-share bridge",
	},
	"list_shareable_apps": {
		Class: RealtimeToolClassStableForeground,
		Gate:  "host_shareable_app_inventory",
		Notes: "read-only local app/window inventory for presentation selection",
	},
	"present_app_share": {
		Class: RealtimeToolClassStableForeground,
		Gate:  "active_meeting_session",
		Notes: "presentation control; browser/meeting client may still require confirmation",
	},
	"start_demo_surface": {
		Class: RealtimeToolClassOptionalForeground,
		Gate:  "demo_surface_enabled",
		Notes: "bot-owned Browser/CU surface; hidden when demo surface bridge is disabled",
	},
	"start_demo_execution": {
		Class: RealtimeToolClassOptionalForeground,
		Gate:  "demo_surface_enabled_and_worker_runner",
		Notes: "end-to-end do-and-show execution boundary; starts visual surface plus code-capable worker with external-write approval gate",
	},
	"control_demo_surface": {
		Class: RealtimeToolClassOptionalForeground,
		Gate:  "demo_surface_enabled_and_policy",
		Notes: "single stable Browser/CU control boundary; active click/type requires policy approval",
	},
	"cancel_demo_surface": {
		Class: RealtimeToolClassOptionalForeground,
		Gate:  "demo_surface_enabled",
		Notes: "stops active bot-owned Browser/CU surface",
	},
	"read_meet_chat": {
		Class: RealtimeToolClassStableForeground,
		Gate:  "active_meeting_session",
		Notes: "read-only meeting context",
	},
	"meet_participants": {
		Class: RealtimeToolClassStableForeground,
		Gate:  "active_meeting_session",
		Notes: "read-only meeting roster/speaker context",
	},
	"active_speaker": {
		Class: RealtimeToolClassStableForeground,
		Gate:  "active_meeting_session",
		Notes: "read-only best-effort speaker signal",
	},
	"fetch_url": {
		Class: RealtimeToolClassStableForeground,
		Gate:  "public_url_read",
		Notes: "read-only URL extraction; deeper browsing should delegate or use demo surface",
	},
	"current_user_identity": {
		Class: RealtimeToolClassStableForeground,
		Gate:  "workspace_identity_read",
		Notes: "read-only current speaker/user identity",
	},
	"resolve_speaker_identity": {
		Class: RealtimeToolClassStableForeground,
		Gate:  "workspace_identity_read",
		Notes: "identity read/write boundary; learn payload is scoped to speaker-resolution memory",
	},
	"search_team_members": {
		Class: RealtimeToolClassStableForeground,
		Gate:  "workspace_connector_read",
		Notes: "read-only team member search",
	},
	"linear_query": {
		Class: RealtimeToolClassStableForeground,
		Gate:  "workspace_connector_read",
		Notes: "read-only Linear issue search; mutations require Browser/CU approval task",
	},
	"linear_user_issues": {
		Class: RealtimeToolClassStableForeground,
		Gate:  "workspace_connector_read",
		Notes: "read-only Linear assignee lookup",
	},
	"google_calendar": {
		Class: RealtimeToolClassStableForeground,
		Gate:  "workspace_connector_read",
		Notes: "read-only Calendar search",
	},
	"calendar_attendees": {
		Class: RealtimeToolClassStableForeground,
		Gate:  "workspace_connector_read",
		Notes: "read-only attendee lookup for current Meet URL",
	},
	"slack_search": {
		Class: RealtimeToolClassStableForeground,
		Gate:  "workspace_connector_read",
		Notes: "read-only Slack search from realtime",
	},
	"notion_search": {
		Class: RealtimeToolClassStableForeground,
		Gate:  "workspace_connector_read",
		Notes: "read-only Notion search from realtime",
	},
	"github_search": {
		Class: RealtimeToolClassStableForeground,
		Gate:  "workspace_connector_read",
		Notes: "read-only GitHub search from realtime; mutations require Browser/CU approval task",
	},
	"memory_write": {
		Class: RealtimeToolClassStableForeground,
		Gate:  "session_memory",
		Notes: "writes meeting-avatar session memory, not external systems",
	},
	"memory_read": {
		Class: RealtimeToolClassStableForeground,
		Gate:  "session_memory",
		Notes: "read-only meeting-avatar session memory",
	},
	"now": {
		Class: RealtimeToolClassStableForeground,
		Gate:  "dynamic_value_tool",
		Notes: "dynamic output behind stable schema; must not enter stable prompt bytes",
	},
	"set_avatar_expression": {
		Class: RealtimeToolClassStableForeground,
		Gate:  "avatar_local_control",
		Notes: "local avatar expression only",
	},
	"set_avatar_action": {
		Class: RealtimeToolClassStableForeground,
		Gate:  "avatar_local_control",
		Notes: "local avatar action only",
	},
	"update_avatar_state": {
		Class: RealtimeToolClassStableForeground,
		Gate:  "avatar_local_control",
		Notes: "local avatar expression/action only",
	},
}

func RealtimeForegroundToolInventory(includeDemoSurface bool) []RealtimeForegroundToolInventoryItem {
	definitions := realtimeToolDefinitions(includeDemoSurface)
	out := make([]RealtimeForegroundToolInventoryItem, 0, len(definitions))
	for _, definition := range definitions {
		item := realtimeForegroundToolInventoryByName[definition.Name]
		item.Name = definition.Name
		out = append(out, item)
	}
	return out
}
