package meetingagent

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
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
	return realtimeToolSchemas(false)
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
		realtimeTool("delegate_to_worker", "Start a background workspace job for async workspace/code/research/debug/planning work or external workspace lookup that is not handled by a live meeting tool. Use immediately when the user asks to 后台/开个后台任务/跑个调研/写报告/用 Codex/codex/写脚本/处理一批文件/查代码/跑测试/改 repo/GitHub/Linear/Slack/Notion/calendar/docs/URL lookup, or asks to implement/build/create a web app/game such as synced Gomoku/五子棋, or otherwise requests work that should continue outside the short voice turn. For build/implement/create web app/game requests, set mode to code and allowCodeChanges to true. For vague file batches or missing details, still start the background job with the user's wording instead of staying silent or asking for every file up front. Do not use for direct meeting app share, screen/window share, browser/Pencil UI control, avatar visuals, simple spoken answers, or direct Meet-chat read/send requests.", objectSchema([]string{"task"}, map[string]realtimeJSONSchema{
			"task":             stringSchema("Clear task, including URLs, file paths, expected output, and any user wording that matters."),
			"context":          stringSchema("Useful meeting/workspace context. Include Meet chat links or prior results when relevant."),
			"mode":             enumStringSchema("analysis", "analysis", "code", "research", "debug", "plan"),
			"allowCodeChanges": boolSchema(false),
		})),
		realtimeTool("worker_status", "Check status/result of a background workspace job. Use when the user asks 进度/状态/做完了吗/结果呢/那个活儿怎么样/codex 那个活儿, even if the job id is not known; omit jobId or pass null to query the latest relevant worker job.", objectSchema(nil, map[string]realtimeJSONSchema{
			"jobId": stringSchema("Known worker job id. Omit/null when the user refers to the latest or previous background job."),
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
		realtimeTool("kwwk_computer_use", "Use KWWK Computer Use for a simple bounded operation in the bot host's currently shared or named macOS app/window. This is the generic direct app-operation tool: put the user's exact UI goal in instruction, optionally include the target app/window fields, and do not invent click coordinates, screenshots, operation arrays, or low-level primitives. Use it for simple app actions such as click/type/press/scroll/select/switch/change within the shared app. Do not use this for Google Meet's own meeting controls such as muting/unmuting the meeting microphone or camera, leaving the call, toggling captions, admitting/removing people, or changing participant controls. For complex visual goals that require exploration, multi-step planning, unfamiliar UI reasoning, or slow delegated Computer Use, use the long-running background app-control path instead. This tool operates the bot host's shared window, not the human's personal computer.", objectSchema(nil, map[string]realtimeJSONSchema{
			"instruction":      stringSchema("Natural-language app/window operation to perform. Preserve the user's wording and do not translate it into low-level primitives."),
			"applicationName":  stringSchema("Target app name when known, e.g. Pencil, VS Code, Chrome, Notion, Terminal."),
			"bundleIdentifier": stringSchema("Optional macOS bundle identifier when known."),
			"windowTitle":      stringSchema("Optional visible window title when known."),
			"windowId":         integerSchema("Optional macOS window id from the active app share, preferred over app-name guessing when known.", nil),
			"processId":        integerSchema("Optional process id from list_shareable_windows.", nil),
			"session_id":       stringSchema("Current meeting session id when known."),
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
		realtimeTool("read_meet_chat", "Read recent visible Google Meet chat messages and links from the current meeting. Use immediately when the user asks what meeting chat said, what links people posted, or to read/检查/看看/总结最近的会议聊天; do not answer from memory or use avatar-only tools.", objectSchema(nil, map[string]realtimeJSONSchema{
			"limit":     integerSchema("", float64(10)),
			"onlyLinks": boolSchema(false),
		})),
		realtimeTool("meet_participants", "Return the current Google Meet participant list and best-effort active/recent speaker state from live Meet DOM/captions.", objectSchema(nil, map[string]realtimeJSONSchema{})),
		realtimeTool("active_speaker", "Return the current or most recent Google Meet speaker, with source/confidence metadata. This is best-effort and may come from captions or Meet DOM speaker indicators.", objectSchema(nil, map[string]realtimeJSONSchema{})),
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
		realtimeTool("calendar_attendees", "Look up the calendar event matching the current Meet URL and return attendees.", objectSchema(nil, map[string]realtimeJSONSchema{
			"meet_url": stringSchema("Google Meet URL. Defaults to the current meeting when omitted."),
		})),
		realtimeTool("now", "Return the current date/time in Asia/Shanghai.", objectSchema(nil, map[string]realtimeJSONSchema{})),
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

func enumStringSchemaWithDescription(defaultValue string, description string, values ...string) realtimeJSONSchema {
	schema := enumStringSchema(defaultValue, values...)
	schema.Description = description
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
			"parameters":  schema.Parameters.StrictMap(true),
		})
	}
	return out
}

func (s realtimeJSONSchema) Map() map[string]any {
	return s.mapWithOptions(true, false)
}

func (s realtimeJSONSchema) StrictMap(requiredByParent bool) map[string]any {
	return s.mapWithOptions(requiredByParent, true)
}

func (s realtimeJSONSchema) mapWithOptions(requiredByParent bool, strict bool) map[string]any {
	out := map[string]any{}
	if s.Type != "" {
		out["type"] = strictSchemaType(s.Type, requiredByParent, strict)
	}
	if s.Description != "" {
		out["description"] = s.Description
	}
	if len(s.Enum) > 0 {
		out["enum"] = enumListAsAny(s.Enum, !requiredByParent && strict)
	}
	if s.HasDefault {
		out["default"] = s.Default
	}
	if s.Properties != nil {
		properties := make(map[string]any, len(s.Properties))
		requiredSet := stringSet(s.Required)
		keys := sortedSchemaKeys(s.Properties)
		for _, key := range keys {
			properties[key] = s.Properties[key].mapWithOptions(requiredSet[key], strict)
		}
		out["properties"] = properties
		if strict {
			out["additionalProperties"] = false
			out["required"] = stringListAsAny(keys)
		}
	}
	if !strict && s.Required != nil {
		out["required"] = stringListAsAny(s.Required)
	}
	if s.Items != nil {
		out["items"] = s.Items.mapWithOptions(true, strict)
	}
	return out
}

func strictSchemaType(value string, requiredByParent bool, strict bool) any {
	if strict && !requiredByParent && value != "null" {
		return []any{value, "null"}
	}
	return value
}

func enumListAsAny(values []string, includeNull bool) []any {
	out := stringListAsAny(values)
	if includeNull {
		out = append(out, nil)
	}
	return out
}

func sortedSchemaKeys(values map[string]realtimeJSONSchema) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func stringSet(values []string) map[string]bool {
	out := make(map[string]bool, len(values))
	for _, value := range values {
		out[value] = true
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
