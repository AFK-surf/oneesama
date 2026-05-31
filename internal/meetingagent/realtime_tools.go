package meetingagent

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
)

type realtimeToolSchema struct {
	Type        string
	Name        string
	Description string
	Parameters  realtimeJSONSchema
}

type realtimeJSONSchema struct {
	Type        string
	Description string
	Enum        []string
	Default     any
	HasDefault  bool
	Properties  map[string]realtimeJSONSchema
	Required    []string
	Items       *realtimeJSONSchema
}

func defaultRealtimeToolSchemas() []map[string]any {
	return realtimeToolSchemasAsMaps(defaultRealtimeToolDefinitions())
}

func realtimeToolSchemas(includeDemoSurface bool) []map[string]any {
	return realtimeToolSchemasAsMaps(realtimeToolDefinitions(includeDemoSurface))
}

// RealtimeToolSchemaStableHash returns a deterministic hash of the foreground
// realtime tool schema surface after canonical JSON encoding.
func RealtimeToolSchemaStableHash(includeDemoSurface bool) (string, error) {
	payload, err := json.Marshal(realtimeToolSchemas(includeDemoSurface))
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:]), nil
}

func realtimeToolDefinitions(includeDemoSurface bool) []realtimeToolSchema {
	definitions := defaultRealtimeToolDefinitions()
	if includeDemoSurface {
		return definitions
	}
	out := make([]realtimeToolSchema, 0, len(definitions))
	for _, definition := range definitions {
		switch definition.Name {
		case "open_shared_browser_surface", "create_shared_workspace", "control_shared_browser_surface", "stop_shared_browser_surface":
			continue
		default:
			out = append(out, definition)
		}
	}
	return out
}

func defaultRealtimeToolDefinitions() []realtimeToolSchema {
	return []realtimeToolSchema{
		realtimeTool("delegate_to_worker", "Start a background workspace job for complex work that should not be improvised in the realtime voice conversation.", objectSchema([]string{"task"}, map[string]realtimeJSONSchema{
			"task":             stringSchema("Clear task, including URLs, file paths, expected output, and any user wording that matters."),
			"context":          stringSchema("Useful meeting/workspace context. Include Meet chat links or prior results when relevant."),
			"mode":             enumStringSchema("analysis", "analysis", "code", "research", "debug", "plan"),
			"allowCodeChanges": boolSchema(false),
		})),
		realtimeTool("worker_status", "Check status/result of a background workspace job.", objectSchema(nil, map[string]realtimeJSONSchema{
			"jobId": {Type: "string"},
		})),
		realtimeTool("delegate_to_codex", "Compatibility alias for starting a background workspace job for links, files, code, debugging, planning, or multi-step research.", objectSchema([]string{"task"}, map[string]realtimeJSONSchema{
			"task":               stringSchema("Clear task. Include exact URLs/file paths/commands and what to report back."),
			"context":            stringSchema("Useful meeting/workspace context. Include Meet chat links or prior results when relevant."),
			"mode":               enumStringSchema("analysis", "analysis", "code", "research", "debug", "plan"),
			"allow_code_changes": boolSchema(false),
			"wait_for_result":    boolSchema(false),
		})),
		realtimeTool("delegate_status", "Compatibility alias for checking status/result of a background workspace job.", objectSchema(nil, map[string]realtimeJSONSchema{
			"job_id": {Type: "string"},
		})),
		realtimeTool("send_meet_chat", "Send a short visible message into the current Google Meet chat.", objectSchema([]string{"text"}, map[string]realtimeJSONSchema{
			"text": stringSchema("The exact chat message to send to the current Meet."),
		})),
		realtimeTool("present_video_stage", "Open a controlled synthetic video/stage tab and make Google Meet share that stage. Use immediately when the user says 放视频 / 分享视频 / 播放视频 / share screen with a video / open video stage / present video. Do not ask the user to choose a local app/window. For non-direct video links, first resolve a playable file or URL in the background, then present the resulting video file or URL.", objectSchema(nil, map[string]realtimeJSONSchema{
			"videoUrl": stringSchema("Direct video URL, data URL, file URL, or local file path. Optional: without it, a placeholder stage is shared."),
			"title":    stringSchema("Visible title on the shared stage."),
			"subtitle": stringSchema("Visible subtitle on the shared stage."),
			"muted":    boolSchema(true),
		})),
		realtimeTool("stop_video_stage", "Stop the current Google Meet video-stage/screen-share presentation. Use immediately when the user says 停止分享 / stop sharing / 关掉分享 / stop video stage.", objectSchema(nil, map[string]realtimeJSONSchema{})),
		realtimeTool("list_shareable_windows", "List existing macOS applications/windows that the meeting avatar can share through the native app-share path. Use when the user asks to share a generic category like editor/browser/window/app/design tool/应用/窗口/屏幕/设计工具, or when a named app has multiple possible matches.", objectSchema(nil, map[string]realtimeJSONSchema{
			"session_id": stringSchema("Current meeting session id when known."),
		})),
		realtimeTool("share_existing_app_window", "Share a specific existing macOS app/window in the current Meet using the native app-share path. Use immediately when the user says 共享/分享/共享一下/分享一下/共享屏幕/分享屏幕/共享窗口/分享窗口/共享 app/分享 app and names a concrete app/window title such as Pencil/喷手/铅笔, VS Code, Chrome, Notion, Terminal, or Activity Monitor. If the user only says a generic category like editor/browser/window/app/design tool/应用/窗口/屏幕/设计工具, call list_shareable_windows first instead of guessing. Do not use browser/workspace tools for existing app/window requests.", objectSchema(nil, map[string]realtimeJSONSchema{
			"applicationName":  stringSchema("Spoken app name to share, e.g. Pencil/喷手/铅笔, Notion, Chrome, Terminal, Activity Monitor."),
			"bundleIdentifier": stringSchema("Optional macOS bundle identifier when known."),
			"windowTitle":      stringSchema("Optional visible window title when the app has multiple windows."),
			"processId":        integerSchema("Optional process id from list_shareable_windows.", nil),
			"session_id":       stringSchema("Current meeting session id when known."),
			"title":            stringSchema("Visible share title."),
			"subtitle":         stringSchema("Visible share subtitle."),
			"mode":             stringSchema("Native app-share mode. Usually omit; the service defaults to native."),
		})),
		realtimeTool("control_shared_app_window", "Operate the currently shared existing macOS app/window through the host Computer Use executor. Use when the user asks you to click, type, draw, edit, scroll, switch tools, switch accounts, handle a stuck Chrome/browser window, or otherwise manipulate an already shared app such as Pencil, VS Code, Chrome, Notion, or Terminal. This tool operates the bot host's shared window, not the human's personal computer. Pass the user's goal as instruction; the host executor owns the observe -> plan -> act -> verify loop, including unfamiliar apps. By default this queues the app-control work asynchronously and returns a job_id immediately so voice turns do not block; call again with job_id to check status. Do not invent click/drag primitives in the foreground Realtime turn, do not ask the user to share/control their own computer, and do not use this to create a new browser workspace.", objectSchema(nil, map[string]realtimeJSONSchema{
			"job_id":           stringSchema("Existing app-control job id to check. When set, instruction and operations are not required."),
			"instruction":      stringSchema("Concrete user-facing operation to perform in the shared app/window. Preserve important wording. Optional when operations fully describe the action."),
			"applicationName":  stringSchema("Target app name when known, e.g. Pencil, VS Code, Chrome, Notion, Terminal."),
			"bundleIdentifier": stringSchema("Optional macOS bundle identifier when known."),
			"windowTitle":      stringSchema("Optional visible window title when known."),
			"windowId":         integerSchema("Optional macOS window id from the active app share, preferred over app-name guessing when known.", nil),
			"processId":        integerSchema("Optional process id from list_shareable_windows.", nil),
			"operations": arraySchema("Optional low-level app-control operations for debug, harnesses, or direct-adapter cases. Prefer instruction-only user goals so the host executor can observe, plan, act, and verify internally.", objectSchema([]string{"kind"}, map[string]realtimeJSONSchema{
				"kind":      enumStringSchema("", "state", "click", "type_text", "press_key", "scroll", "drag"),
				"text":      stringSchema("Text to type for type_text."),
				"key":       stringSchema("Key name for press_key, e.g. Return, Tab, Escape, Space, ArrowUp, or a single character."),
				"direction": enumStringSchema("", "up", "down", "left", "right"),
				"x":         numberSchema("Window-local x coordinate for click."),
				"y":         numberSchema("Window-local y coordinate for click."),
				"from_x":    numberSchema("Window-local drag start x coordinate."),
				"from_y":    numberSchema("Window-local drag start y coordinate."),
				"to_x":      numberSchema("Window-local drag end x coordinate."),
				"to_y":      numberSchema("Window-local drag end y coordinate."),
			})),
			"session_id": stringSchema("Current meeting session id when known."),
			"timeoutMs":  integerSchema("Maximum time for the queued backend task, not for the Realtime tool call.", float64(2000)),
			"wait":       boolSchema(false),
		})),
		realtimeTool("open_shared_browser_surface", "Share a bot-owned browser/synthetic surface for a URL, web page, or generated visual workspace. Use for explicit URL/page/browser-surface requests. Do not use for named local macOS app/window requests.", objectSchema(nil, map[string]realtimeJSONSchema{
			"url":             stringSchema("HTTP(S) URL to open in the bot-owned workspace."),
			"goal":            stringSchema("Short user-facing goal for the shared surface, e.g. 'show the dashboard trend'."),
			"instruction":     stringSchema("Internal instruction for the Computer Use adapter. Do not include secrets."),
			"title":           stringSchema("Visible title for the shared surface."),
			"subtitle":        stringSchema("Visible subtitle for the shared surface."),
			"session_id":      stringSchema("Current meeting session id when known."),
			"demo_session_id": stringSchema("Optional stable shared-surface session id for audit/reuse."),
		})),
		realtimeTool("create_shared_workspace", "Generate/build a new artifact or code result, then present the result on the shared browser surface. Use only when the user asks you to create, build, implement, or generate something new and show the result. Never use this for showing an existing app/window.", objectSchema([]string{"task"}, map[string]realtimeJSONSchema{
			"task":                stringSchema("The exact user task to execute, preserving wording such as no-planning or show-the-work constraints."),
			"task_url":            stringSchema("Optional Linear/task/GitHub URL that identifies the work item."),
			"demo_url":            stringSchema("Optional initial URL to show on the shared surface while the worker starts."),
			"title":               stringSchema("Visible title for the shared surface."),
			"issue_id":            stringSchema("Optional fixture or external issue id. External writes still require approval."),
			"issue_url":           stringSchema("Optional fixture or external issue URL. External writes still require approval."),
			"request_issue_close": boolSchema(false),
			"session_id":          stringSchema("Current meeting session id when known."),
			"demo_session_id":     stringSchema("Optional stable shared-surface session id for audit/reuse."),
			"user_instruction":    stringSchema("Additional user constraints, e.g. concise, don't narrate, show progress visually."),
		})),
		realtimeTool("control_shared_browser_surface", "Continue controlling the active shared browser/synthetic surface. Use after open_shared_browser_surface to change the shared content, observe/capture the page, scroll, highlight, click approved UI, or type approved text without restarting the meeting share.", objectSchema([]string{"action"}, map[string]realtimeJSONSchema{
			"action":          enumStringSchema("capture", "open_url", "capture", "scroll", "highlight", "click", "type"),
			"url":             stringSchema("HTTP(S) URL to open in the active shared browser when action is open_url."),
			"instruction":     stringSchema("Short internal instruction for this step. Do not include secrets."),
			"direction":       enumStringSchema("down", "down", "up", "left", "right"),
			"amount":          integerSchema("Scroll amount in pixels when action is scroll.", float64(500)),
			"text":            stringSchema("Visible text/ref to highlight or click, or text to type when action is type."),
			"session_id":      stringSchema("Current meeting session id when known."),
			"demo_session_id": stringSchema("Active shared-surface session id. Omit to use the active shared surface."),
		})),
		realtimeTool("stop_shared_browser_surface", "Cancel and stop the active bot-owned browser/synthetic share surface.", objectSchema(nil, map[string]realtimeJSONSchema{
			"session_id":      stringSchema("Current meeting session id when known."),
			"demo_session_id": stringSchema("Shared-surface session id to cancel. Omit to cancel the active shared surface."),
			"reason":          stringSchema("Short cancellation reason."),
		})),
		realtimeTool("read_meet_chat", "Read recent visible Google Meet chat messages and links from the current meeting.", objectSchema(nil, map[string]realtimeJSONSchema{
			"limit":     integerSchema("", float64(10)),
			"onlyLinks": boolSchema(false),
		})),
		realtimeTool("meet_participants", "Return the current Google Meet participant list and best-effort active/recent speaker state from live Meet DOM/captions.", objectSchema(nil, map[string]realtimeJSONSchema{})),
		realtimeTool("active_speaker", "Return the current or most recent Google Meet speaker, with source/confidence metadata. This is best-effort and may come from captions or Meet DOM speaker indicators.", objectSchema(nil, map[string]realtimeJSONSchema{})),
		realtimeTool("fetch_url", "Read a public URL and return extracted text/markdown. Uses a reader service by default, which is useful for X/Twitter links and pages that are hard to read directly. If this fails or the request needs deeper browsing, continue in the background.", objectSchema([]string{"url"}, map[string]realtimeJSONSchema{
			"url":      stringSchema("The exact http(s) URL to read."),
			"useJina":  boolSchemaWithDescription(true, "Use the Jina reader service instead of direct fetch."),
			"maxChars": integerSchema("Maximum returned text characters.", float64(8000)),
		})),
		realtimeTool("current_user_identity", "Return the current meeting speaker/user identity. Use whenever the user asks who they are, says 'my/me/I', or asks for their own workspace data.", objectSchema(nil, map[string]realtimeJSONSchema{})),
		realtimeTool("resolve_speaker_identity", "Resolve a live meeting speaker display name to the current workspace identity profile when possible. Falls back to the display name with low confidence instead of guessing.", objectSchema([]string{"display_name"}, map[string]realtimeJSONSchema{
			"display_name": stringSchema("Raw speaker or participant display name from Meet, captions, Slack, or another surface."),
			"source":       enumStringSchema("unknown", "meet_dom", "caption", "slack_event", "manual", "unknown"),
			"channel":      {Type: "string"},
			"workspace":    {Type: "string"},
			"meeting_url":  stringSchema("Current Google Meet URL when available, used to reconcile calendar attendees."),
			"calendar_attendees": arraySchema("Optional attendee hints from a matched calendar event.", objectSchema(nil, map[string]realtimeJSONSchema{
				"name":         {Type: "string"},
				"display_name": {Type: "string"},
				"email":        {Type: "string"},
				"aliases":      arraySchema("", realtimeJSONSchema{Type: "string"}),
				"role":         {Type: "string"},
			})),
			"learn": objectSchemaWithDescription("Optional user-corrected identity memory to persist for future speaker resolution.", nil, map[string]realtimeJSONSchema{
				"canonical_name":       {Type: "string"},
				"preferred_name":       {Type: "string"},
				"honorific_preference": {Type: "string"},
				"role":                 {Type: "string"},
				"aliases":              arraySchema("", realtimeJSONSchema{Type: "string"}),
				"meet_display_names":   arraySchema("", realtimeJSONSchema{Type: "string"}),
				"slack_user_id":        {Type: "string"},
				"slack_team_id":        {Type: "string"},
				"email":                {Type: "string"},
				"calendar_emails":      arraySchema("", realtimeJSONSchema{Type: "string"}),
				"linear":               {Type: "string"},
				"github":               {Type: "string"},
			}),
		})),
		realtimeTool("search_team_members", "Search Linear users/team members and return fuzzy candidates. Use before assignee-specific Linear lookups if the spoken name is ambiguous.", objectSchema([]string{"query"}, map[string]realtimeJSONSchema{
			"query": stringSchema("Name, nickname, email, or spoken partial name."),
		})),
		realtimeTool("linear_query", "Search Linear issues by free text in title/description. Use for issue keyword lookups.", objectSchema([]string{"query"}, map[string]realtimeJSONSchema{
			"query": {Type: "string"},
			"limit": integerSchema("", float64(5)),
		})),
		realtimeTool("linear_user_issues", "List incomplete Linear issues assigned to a user. Use for 'my tasks', 'tasks on someone's plate', or assignee questions.", objectSchema([]string{"user"}, map[string]realtimeJSONSchema{
			"user": stringSchema("Email, display name, handle, or username. Prefer the current workspace user's email when available, for example user@example.com."),
		})),
		realtimeTool("google_calendar", "Search Google Calendar events.", objectSchema(nil, map[string]realtimeJSONSchema{
			"time_min":    {Type: "string"},
			"time_max":    {Type: "string"},
			"max_results": integerSchema("", float64(10)),
		})),
		realtimeTool("calendar_attendees", "Look up the calendar event matching the current Meet URL and return attendees.", objectSchema(nil, map[string]realtimeJSONSchema{
			"meet_url": stringSchema("Google Meet URL. Defaults to the current meeting when omitted."),
		})),
		realtimeTool("slack_search", "Search Cue Slack messages.", objectSchema([]string{"query"}, map[string]realtimeJSONSchema{
			"query": {Type: "string"},
			"count": integerSchema("", float64(5)),
		})),
		realtimeTool("notion_search", "Search Cue Notion documents.", objectSchema([]string{"query"}, map[string]realtimeJSONSchema{
			"query": {Type: "string"},
		})),
		realtimeTool("github_search", "Search GitHub issues, repos, or code.", objectSchema([]string{"query"}, map[string]realtimeJSONSchema{
			"query": {Type: "string"},
			"kind":  enumStringSchema("issues", "issues", "repos", "code"),
		})),
		realtimeTool("memory_write", "Write session memory for this meeting avatar.", objectSchema([]string{"key"}, map[string]realtimeJSONSchema{
			"key":   {Type: "string"},
			"value": {},
		})),
		realtimeTool("memory_read", "Read session memory. Omit key to return all memory.", objectSchema(nil, map[string]realtimeJSONSchema{
			"key": {Type: "string"},
		})),
		realtimeTool("now", "Return the current date/time in Asia/Shanghai.", objectSchema(nil, map[string]realtimeJSONSchema{})),
		realtimeTool("set_avatar_expression", "Set the Live2D avatar's visible mood before or during an answer.", objectSchema([]string{"mood"}, map[string]realtimeJSONSchema{
			"mood": enumStringSchema("", "neutral", "happy", "surprised", "thinking", "sad", "shy"),
		})),
		realtimeTool("set_avatar_action", "Trigger a visible Live2D head/body action. Use nod for agreement, shake for disagreement, wave for greetings, think for reasoning, speak while talking, and emphasize for conclusions.", objectSchema([]string{"action"}, map[string]realtimeJSONSchema{
			"action":    enumStringSchema("", "idle", "nod", "shake", "wave", "think", "lean_forward", "emphasize", "shrug", "speak"),
			"intensity": numberSchema("0.2 to 1.2 is the normal visible range."),
		})),
		realtimeTool("update_avatar_state", "Set the avatar mood/action and optional visual HUD status together. Use status_text/status_kind for progress that should be visible but not spoken.", objectSchema(nil, map[string]realtimeJSONSchema{
			"mood":           enumStringSchema("", "neutral", "happy", "surprised", "thinking", "sad", "shy"),
			"action":         enumStringSchema("", "idle", "nod", "shake", "wave", "think", "lean_forward", "emphasize", "shrug", "speak"),
			"intensity":      numberSchema("0.2 to 1.2 is the normal visible range."),
			"status_text":    stringSchema("Short visual-only status shown on the avatar video frame, e.g. 'Writing code'. Do not include internal logs, tool names, or secrets."),
			"status_kind":    enumStringSchema("thinking", "thinking", "writing_code", "opening_preview", "blocked", "done", "idle"),
			"status_hold_ms": integerSchema("How long to keep the visual status visible.", float64(12000)),
		})),
	}
}

func realtimeTool(name, description string, parameters realtimeJSONSchema) realtimeToolSchema {
	if parameters.Type == "object" && parameters.Required == nil {
		parameters.Required = []string{}
	}
	return realtimeToolSchema{
		Type:        "function",
		Name:        name,
		Description: description,
		Parameters:  parameters,
	}
}

func stringSchema(description string) realtimeJSONSchema {
	return realtimeJSONSchema{Type: "string", Description: description}
}

func numberSchema(description string) realtimeJSONSchema {
	return realtimeJSONSchema{Type: "number", Description: description}
}

func integerSchema(description string, defaultValue any) realtimeJSONSchema {
	schema := realtimeJSONSchema{Type: "integer", Description: description}
	if defaultValue != nil {
		schema.Default = defaultValue
		schema.HasDefault = true
	}
	return schema
}

func boolSchema(defaultValue bool) realtimeJSONSchema {
	return boolSchemaWithDescription(defaultValue, "")
}

func boolSchemaWithDescription(defaultValue bool, description string) realtimeJSONSchema {
	return realtimeJSONSchema{Type: "boolean", Description: description, Default: defaultValue, HasDefault: true}
}

func enumStringSchema(defaultValue string, values ...string) realtimeJSONSchema {
	schema := realtimeJSONSchema{Type: "string", Enum: values}
	if defaultValue != "" {
		schema.Default = defaultValue
		schema.HasDefault = true
	}
	return schema
}

func objectSchema(required []string, properties map[string]realtimeJSONSchema) realtimeJSONSchema {
	return objectSchemaWithDescription("", required, properties)
}

func objectSchemaWithDescription(description string, required []string, properties map[string]realtimeJSONSchema) realtimeJSONSchema {
	return realtimeJSONSchema{
		Type:        "object",
		Description: description,
		Properties:  properties,
		Required:    required,
	}
}

func arraySchema(description string, items realtimeJSONSchema) realtimeJSONSchema {
	return realtimeJSONSchema{Type: "array", Description: description, Items: &items}
}

func realtimeToolSchemasAsMaps(schemas []realtimeToolSchema) []map[string]any {
	out := make([]map[string]any, 0, len(schemas))
	for _, schema := range schemas {
		out = append(out, map[string]any{
			"type":        schema.Type,
			"name":        schema.Name,
			"description": schema.Description,
			"parameters":  schema.Parameters.Map(),
		})
	}
	return out
}

func (s realtimeJSONSchema) Map() map[string]any {
	out := map[string]any{}
	if s.Type != "" {
		out["type"] = s.Type
	}
	if s.Description != "" {
		out["description"] = s.Description
	}
	if len(s.Enum) > 0 {
		out["enum"] = stringListAsAny(s.Enum)
	}
	if s.HasDefault {
		out["default"] = s.Default
	}
	if s.Properties != nil {
		properties := make(map[string]any, len(s.Properties))
		for key, value := range s.Properties {
			properties[key] = value.Map()
		}
		out["properties"] = properties
	}
	if s.Required != nil {
		out["required"] = stringListAsAny(s.Required)
	}
	if s.Items != nil {
		out["items"] = s.Items.Map()
	}
	return out
}

func stringListAsAny(values []string) []any {
	out := make([]any, 0, len(values))
	for _, value := range values {
		out = append(out, value)
	}
	return out
}
