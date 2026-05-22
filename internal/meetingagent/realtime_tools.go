package meetingagent

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

func realtimeToolDefinitions(includeDemoSurface bool) []realtimeToolSchema {
	definitions := defaultRealtimeToolDefinitions()
	if includeDemoSurface {
		return definitions
	}
	out := make([]realtimeToolSchema, 0, len(definitions))
	for _, definition := range definitions {
		switch definition.Name {
		case "start_demo_surface", "start_demo_execution", "control_demo_surface", "cancel_demo_surface":
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
		realtimeTool("present_video_stage", "Open a controlled video/stage tab and make Google Meet share that stage. Use immediately when the user says 放视频 / 分享视频 / 播放视频 / share screen with a video / open video stage / present video. For non-direct video links, first resolve a playable file or URL in the background, then present the resulting video file or URL.", objectSchema(nil, map[string]realtimeJSONSchema{
			"videoUrl": stringSchema("Direct video URL, data URL, file URL, or local file path. Optional: without it, a placeholder stage is shared."),
			"title":    stringSchema("Visible title on the shared stage."),
			"subtitle": stringSchema("Visible subtitle on the shared stage."),
			"muted":    boolSchema(true),
		})),
		realtimeTool("stop_video_stage", "Stop the current Google Meet video-stage/screen-share presentation. Use immediately when the user says 停止分享 / stop sharing / 关掉分享 / stop video stage.", objectSchema(nil, map[string]realtimeJSONSchema{})),
		realtimeTool("list_shareable_apps", "List local applications that can be selected for an application/window share in the current meeting.", objectSchema(nil, map[string]realtimeJSONSchema{})),
		realtimeTool("present_app_share", "Request sharing a specific local application/window into the current meeting. The browser or meeting client may still ask the user to confirm the exact window.", objectSchema(nil, map[string]realtimeJSONSchema{
			"processId":        integerSchema("Process id from list_shareable_apps.", nil),
			"bundleIdentifier": stringSchema("Bundle identifier from list_shareable_apps."),
			"applicationName":  stringSchema("Application name from list_shareable_apps."),
			"mode":             enumStringSchema("native", "native", "synthetic"),
		})),
		realtimeTool("start_demo_surface", "Start a bot-owned Computer Use demo surface for show-and-tell work. Use when the user asks you to open a page, demonstrate something visually, or inspect a UI while continuing the meeting conversation.", objectSchema(nil, map[string]realtimeJSONSchema{
			"url":             stringSchema("HTTP(S) URL to open in the bot-owned demo workspace."),
			"goal":            stringSchema("Short user-facing goal for the demo, e.g. 'show the dashboard trend'."),
			"instruction":     stringSchema("Internal instruction for the Computer Use adapter. Do not include secrets."),
			"title":           stringSchema("Visible title for the shared demo surface."),
			"subtitle":        stringSchema("Visible subtitle for the shared demo surface."),
			"session_id":      stringSchema("Current meeting session id when known."),
			"demo_session_id": stringSchema("Optional stable demo session id for audit/reuse."),
		})),
		realtimeTool("start_demo_execution", "Start an end-to-end demo execution: use this when the user asks you to directly do a task and show/share/demo the result, e.g. '做一个贪吃蛇，然后给我看/分享屏幕'. This starts the visual demo surface and a code-capable worker; do not answer with a plan instead.", objectSchema([]string{"task"}, map[string]realtimeJSONSchema{
			"task":                stringSchema("The exact user task to execute, preserving wording such as no-planning or show-the-work constraints."),
			"task_url":            stringSchema("Optional Linear/task/GitHub URL that identifies the work item."),
			"demo_url":            stringSchema("Optional initial URL to show on the demo surface while the worker starts."),
			"title":               stringSchema("Visible title for the shared demo surface."),
			"issue_id":            stringSchema("Optional fixture or external issue id. External writes still require approval."),
			"issue_url":           stringSchema("Optional fixture or external issue URL. External writes still require approval."),
			"request_issue_close": boolSchema(false),
			"session_id":          stringSchema("Current meeting session id when known."),
			"demo_session_id":     stringSchema("Optional stable demo session id for audit/reuse."),
			"user_instruction":    stringSchema("Additional user constraints, e.g. concise, don't narrate, show progress visually."),
		})),
		realtimeTool("control_demo_surface", "Continue controlling the active bot-owned demo surface. Use after start_demo_surface to change the shared content, observe/capture the page, scroll, highlight, click approved UI, or type approved text without restarting the meeting share.", objectSchema([]string{"action"}, map[string]realtimeJSONSchema{
			"action":          enumStringSchema("capture", "open_url", "capture", "scroll", "highlight", "click", "type"),
			"url":             stringSchema("HTTP(S) URL to open in the active demo browser when action is open_url."),
			"instruction":     stringSchema("Short internal instruction for this step. Do not include secrets."),
			"direction":       enumStringSchema("down", "down", "up", "left", "right"),
			"amount":          integerSchema("Scroll amount in pixels when action is scroll.", float64(500)),
			"text":            stringSchema("Visible text/ref to highlight or click, or text to type when action is type."),
			"session_id":      stringSchema("Current meeting session id when known."),
			"demo_session_id": stringSchema("Active demo session id. Omit to use the active demo surface."),
		})),
		realtimeTool("cancel_demo_surface", "Cancel and stop the active bot-owned Computer Use demo surface.", objectSchema(nil, map[string]realtimeJSONSchema{
			"session_id":      stringSchema("Current meeting session id when known."),
			"demo_session_id": stringSchema("Demo session id to cancel. Omit to cancel the active demo session."),
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
		realtimeTool("update_avatar_state", "Set the avatar mood and action together for the current response.", objectSchema(nil, map[string]realtimeJSONSchema{
			"mood":      enumStringSchema("", "neutral", "happy", "surprised", "thinking", "sad", "shy"),
			"action":    enumStringSchema("", "idle", "nod", "shake", "wave", "think", "lean_forward", "emphasize", "shrug", "speak"),
			"intensity": numberSchema("0.2 to 1.2 is the normal visible range."),
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
