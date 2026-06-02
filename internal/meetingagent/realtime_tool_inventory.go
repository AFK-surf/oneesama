package meetingagent

const (
	RealtimeToolClassStableForeground   = "stable_foreground"
	RealtimeToolClassOptionalForeground = "optional_foreground"
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
	"list_shareable_windows": {
		Class: RealtimeToolClassStableForeground,
		Gate:  "active_meeting_session",
		Notes: "read-only native app/window inventory for disambiguating existing-app share requests",
	},
	"share_existing_app_window": {
		Class: RealtimeToolClassStableForeground,
		Gate:  "active_meeting_session",
		Notes: "native macOS app/window share boundary; use for named app/window requests",
	},
	"kwwk_computer_use": {
		Class: RealtimeToolClassStableForeground,
		Gate:  "active_meeting_session_and_host_computer_use",
		Notes: "generic KWWK direct Computer Use boundary for simple bounded app/window operations; accepts natural-language instruction, not primitive arrays",
	},
	"control_shared_app_window": {
		Class: RealtimeToolClassStableForeground,
		Gate:  "active_meeting_session_and_host_computer_use",
		Notes: "compatibility app-control entrypoint retained for old sessions and delegate-mode app-control requests; prefer kwwk_computer_use for direct simple actions",
	},
	"open_shared_browser_surface": {
		Class: RealtimeToolClassOptionalForeground,
		Gate:  "demo_surface_realtime_tools_exposed",
		Notes: "bot-owned Browser/CU surface for URLs or generated browser workspaces; hidden unless demo surface Realtime tools are explicitly exposed",
	},
	"create_shared_workspace": {
		Class: RealtimeToolClassOptionalForeground,
		Gate:  "demo_surface_realtime_tools_exposed_and_worker_runner",
		Notes: "end-to-end build-and-show boundary; starts visual surface plus code-capable worker with external-write approval gate",
	},
	"control_shared_browser_surface": {
		Class: RealtimeToolClassOptionalForeground,
		Gate:  "demo_surface_realtime_tools_exposed_and_policy",
		Notes: "single stable Browser/CU control boundary; active click/type requires policy approval",
	},
	"stop_shared_browser_surface": {
		Class: RealtimeToolClassOptionalForeground,
		Gate:  "demo_surface_realtime_tools_exposed",
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
	"calendar_attendees": {
		Class: RealtimeToolClassStableForeground,
		Gate:  "workspace_connector_read",
		Notes: "read-only attendee lookup for current Meet URL",
	},
	"now": {
		Class: RealtimeToolClassStableForeground,
		Gate:  "dynamic_value_tool",
		Notes: "dynamic output behind stable schema; must not enter stable prompt bytes",
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
