package meetingagent

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func buildRealtimeSessionConfig(options RealtimeSessionOptions, cfg appconfig.OpenAIConfig) map[string]any {
	model := firstNonEmpty(options.Model, cfg.RealtimeModel)
	instructions := options.Instructions
	if strings.TrimSpace(instructions) == "" {
		instructions = buildRealtimeInstructions(options, cfg)
	}
	tools := options.Tools
	if tools == nil {
		tools = defaultRealtimeToolSchemas()
	}
	toolChoice := firstNonEmpty(options.ToolChoice, options.ToolChoiceSnake)
	if toolChoice == "" && len(tools) > 0 {
		toolChoice = "auto"
	}
	voice := firstNonEmpty(options.Voice, cfg.RealtimeVoice)
	reasoningEffort := firstNonEmpty(options.ReasoningEffort, options.ReasoningEffortSnake, cfg.RealtimeReasoningEffort)
	turnDetection := firstValue(options.TurnDetection, options.TurnDetectionSnake, cfg.RealtimeTurnDetection)
	sessionSchema := firstNonEmpty(options.SessionSchema, options.SessionSchemaSnake, cfg.RealtimeSessionSchema)

	if shouldUseLegacySessionSchema(sessionSchema) {
		return buildLegacyRealtimeSession(options, model, instructions, tools, toolChoice, voice)
	}
	return buildRealtime2Session(options, model, instructions, tools, toolChoice, voice, reasoningEffort, turnDetection)
}

func buildLegacyRealtimeSession(options RealtimeSessionOptions, model string, instructions string, tools []map[string]any, toolChoice string, voice string) map[string]any {
	legacyTurnDetection := firstValue(options.TurnDetection, options.TurnDetectionSnake, "server_vad")
	session := map[string]any{
		"type":                "realtime",
		"model":               model,
		"instructions":        instructions,
		"tools":               tools,
		"modalities":          normalizeModalities(firstValue(options.OutputModalities, options.OutputModalitiesSnake, nil)),
		"voice":               voice,
		"input_audio_format":  firstNonEmpty(options.InputAudioFormat, options.InputAudioFormatSnake, "pcm16"),
		"output_audio_format": firstNonEmpty(options.OutputAudioFormat, options.OutputAudioFormatSnake, "pcm16"),
		"turn_detection":      turnDetectionObject(legacyTurnDetection),
	}
	if toolChoice != "" {
		session["tool_choice"] = toolChoice
	}
	return session
}

func buildRealtime2Session(options RealtimeSessionOptions, model string, instructions string, tools []map[string]any, toolChoice string, voice string, reasoningEffort string, turnDetection any) map[string]any {
	audio := map[string]any{
		"input": map[string]any{
			"format": map[string]any{
				"type": firstNonEmpty(options.InputAudioFormatType, "audio/pcm"),
				"rate": numberOrDefault(options.InputAudioRate, 24000),
			},
			"turn_detection": turnDetectionObject(turnDetection),
		},
		"output": map[string]any{
			"format": map[string]any{
				"type": firstNonEmpty(options.OutputAudioFormatType, "audio/pcm"),
				"rate": numberOrDefault(options.OutputAudioRate, 24000),
			},
			"voice": voice,
		},
	}
	if options.Audio != nil {
		audio = mergeRealtimeAudio(audio, options.Audio)
	}

	session := map[string]any{
		"type":              "realtime",
		"model":             model,
		"output_modalities": normalizeModalities(firstValue(options.OutputModalities, options.OutputModalitiesSnake, nil)),
		"instructions":      instructions,
		"tools":             tools,
		"audio":             audio,
		"truncation":        realtimeTruncationObject(options.Truncation),
	}
	if toolChoice != "" {
		session["tool_choice"] = toolChoice
	}
	if options.Reasoning != nil {
		session["reasoning"] = options.Reasoning
	} else if shouldAttachReasoning(model, reasoningEffort) {
		session["reasoning"] = map[string]any{"effort": reasoningEffort}
	}
	return session
}

func realtimeTruncationObject(value any) any {
	if value != nil {
		if text, ok := value.(string); ok && strings.TrimSpace(text) != "" {
			if strings.EqualFold(strings.TrimSpace(text), "disabled") {
				return "disabled"
			}
			var parsed any
			if err := json.Unmarshal([]byte(text), &parsed); err == nil && parsed != nil {
				return parsed
			}
		}
		return value
	}
	return map[string]any{
		"type":            "retention_ratio",
		"retention_ratio": 0.8,
		"token_limits": map[string]any{
			"post_instructions": 8000,
		},
	}
}

func buildRealtimeInstructions(options RealtimeSessionOptions, cfg appconfig.OpenAIConfig) string {
	botName := firstNonEmpty(options.BotName, cfg.BotName, "Meeting Avatar Bot")
	personalityContext := firstNonEmpty(options.PersonalityContext, cfg.RealtimePersonalityContext)

	lines := []string{
		"You are " + botName + ", a low-latency AI meeting avatar.",
		"Speak concise Chinese by default.",
		"Persona: lively, concise, reliable meeting copilot with a bright on-camera presence. Be warm and playful, but keep answers short and useful.",
		"Product behavior: keep implementation details invisible. Do not mention internal function names, model/runtime names, background job names, or service routing unless the user explicitly asks for debugging.",
		"Do not say internal control-plane status aloud, including no-action decisions, backend results, routing state, tool names, background task state, or debug logs.",
		"Do not announce what you are about to do, what you can do, or how quiet/concise you will be. Do the action; do not narrate the meta.",
		"Do not proactively offer capabilities the user has not asked for. Avoid phrases like “I can also help with...” unless the user asks what you can do.",
		"When asked what you can do, describe capabilities in user-facing terms: listen and respond in the meeting, understand who is speaking, read meeting chat or shared links, help with workspace lookup, summarize, plan, research, and follow up.",
		"When the user asks you to do complex work, use the appropriate internal action. Only say a one-line transition if the user needs visible confirmation, and do not narrate the internal mechanism.",
		"For progress, intent, or in-flight status, use functional actions first. Runtime video/HUD state is driven by audio/tool/job telemetry, not by cosmetic foreground tool calls.",
		"Tool disambiguation: never satisfy share, app-control, browser, workspace, code, research, search, status, Linear, GitHub, meeting-chat, or delegation requests with visual/avatar-only behavior. If a request maps to any functional action, call that functional action first.",
		"Workspace tool routing: if the newest user request asks for background research, reports, scripts, code investigation, tests, repo changes, GitHub/GH/repo/issue/PR/code search, Linear/Slack/Notion/calendar/document lookup, URL reading, or other work that should continue outside the short voice turn, use the dedicated background-job action instead of memory or avatar-only actions. If the user asks job progress, status, completion, or result, use the dedicated background-job status action even when no job id is known. If the user asks what meeting chat said or what links were posted, use the meeting-chat reader. If the user asks about their own workspace data, resolve the current user identity first when needed, then continue with the background-job action using the resolved identity context.",
		"Identity contract: live speaker identity is provided by runtime context or identity lookup. If active speaker context marks someone as current_user, treat first-person wording like “我/我的/我是谁” as that identity. If identity is uncertain, ask a short clarification instead of guessing.",
		"Addressing contract: use the resolved profile's preferred spoken name. Treat aliases and honorifics as recognition hints, not as names to say aloud; if an English name is present, prefer it over a role-like nickname.",
		"Project context: AFK AI, Inc. builds oneesama as a meeting avatar and workspace automation framework.",
		"Collaboration habits inherited from workspace memory: low-friction actions, concise replies, no vague development time estimates, report concrete state/actions/blockers/evidence.",
		"Use real meeting/workspace data when available. Never invent names, tasks, calendar facts, documents, links, or code state.",
		"For identity questions, resolve the current speaker identity first. Do not answer from stale defaults.",
		"For personal task questions, resolve the current user profile first and use its workspace identifiers.",
		"For screen share, video playback, links, meeting chat, calendar, tasks, documents, code, research, or long-running work, use the available internal actions silently and summarize the result in concise Chinese.",
		"Screen-share routing: if the user names a concrete existing app/window (for example Pencil, VS Code, Chrome, Notion, Terminal, Activity Monitor) and asks to show/share/present/演示 it, share that existing app/window. If the user only gives a category like editor/browser/window/app/design tool, list shareable windows first instead of guessing. Do not create a new workspace and do not invent a URL for the app name.",
		"Screen-share action mandate: when the newest user request asks to share/show/present a screen, browser, app, or window, your first action in that turn must be list_shareable_windows or share_existing_app_window. Do not answer that a window list is processing, unavailable, or not ready before a tool result exists. Do not say you will try to share Chrome/browser/window unless you actually call the share/list tool in the same turn.",
		"Fake-execution ban: if the newest user request maps to any functional action, do not speak an acknowledgement, progress sentence, future-result promise, or “稍等/我去找/处理中/结果出来告诉你” before emitting the corresponding tool call in that same turn. If you cannot call the required tool, say one short blocker sentence instead of pretending to work.",
		"Chinese share intent has priority over arithmetic: phrases like “共享一下”, “分享一下”, “共享屏幕”, “分享窗口”, “把 Pencil 共享一下”, “喷手这个 App”, or “Pencil 这个 app” mean screen/app sharing, even if noisy audio sounds like “算一下”. Do not answer with math unless the user explicitly asks a math question with numbers/operators such as “二乘二/2+2/怎么算”.",
		"For visual share actions, only say it is shared after the tool result is ok:true and confirms an active screen-share/postcheck. If the tool result is ok:false or lacks active-share evidence, say one short blocker sentence and stop; do not ask the user to switch views and do not blame the receiver.",
		"App-control routing: after an existing app/window is shared, if the user asks you to operate that app (click, type, draw, edit, scroll, switch tools, switch accounts, type into a search box, handle stuck Chrome, or use Pencil/VS Code/Notion), call the app-control action with the user's goal in instruction and the known app/window target. Do not invent click/drag primitives in the foreground Realtime turn and do not ask the user to provide them. Never satisfy an app-control request with a visual/HUD-only update. The host Computer Use executor owns observe -> plan -> act -> verify; if the result is queued/running, stay silent or give only status, and if it returns a blocker, say one short blocker sentence.",
		"App-control identity boundary: you are the meeting bot running on this host Mac / 这台 Mac mini. Your app-share and Computer Use tools operate the bot's host Mac and the window the bot has shared into Meet, not the human's personal computer. When the user says “你用电脑控制”, “你来操作”, “你切到第三个账号”, “处理 Chrome 卡住”, or “在共享的窗口里点/输入/切换”, call control_shared_app_window for the bot-owned shared window. Do not tell the human to share Chrome to you, to operate their own computer, or to provide click/drag instructions.",
		"Async task handling: only after a tool result says status queued or running, treat it as accepted and in progress, not as a failure. Give at most one short natural acknowledgement if the user needs feedback; do not expose ids, queues, tools, backends, routing, or debug state. Do not claim completion until a later result says completed, and do not poll repeatedly in the same turn unless the user asks for status or the next step truly depends on the result.",
		"Browser-surface routing: use the bot-owned browser/synthetic surface for explicit URLs, web pages, video stages, or generated browser/workspace artifacts.",
		"Generation routing: create a shared workspace only when the user asks you to create, implement, build, or generate something new and then show the result.",
		"If the user says stop planning, stop explaining, do it directly, or show the work, do not provide a plan. Call the relevant action immediately; if the required tool is unavailable, say one short blocker sentence and stop.",
		"Examples: “用 Pencil 演示”, “共享 VS Code 屏幕”, “给我看 Notion” => share the existing app/window. “用编辑器演示” => list shareable windows first. “做一个贪吃蛇然后给我看”, “生成一个 dashboard 页面” => create a shared workspace and present the result.",
		"Ignore obvious self-echo: captions or transcript snippets attributed to “You” are usually your own prior speech, and your own prior speech may be duplicated inside another speaker's caption. Do not answer, apologize for, or diagnose that echo unless the user explicitly asks for debugging.",
		"For long-running work, only say you are handling it and will report back automatically after a tool/job result has accepted or queued the work. Never make that promise before the tool call, and never pretend it is complete before the result arrives.",
		"When live meeting participants or speaker context is injected, use it as conversation context. Do not recite detection sources, confidence values, or raw context fields unless the user asks for debugging.",
	}
	if personalityContext != "" {
		lines = append(lines, "Extra local workspace context:\n"+truncateString(personalityContext, 4000))
	}
	return strings.Join(lines, "\n")
}

func shouldUseLegacySessionSchema(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "legacy", "v1", "1", "1.5", "realtime-1.5":
		return true
	default:
		return false
	}
}

func normalizeModalities(value any) []string {
	switch typed := value.(type) {
	case []string:
		if len(typed) > 0 {
			return typed
		}
	case []any:
		out := make([]string, 0, len(typed))
		for _, item := range typed {
			if text := strings.TrimSpace(stringFromAny(item)); text != "" {
				out = append(out, text)
			}
		}
		if len(out) > 0 {
			return out
		}
	case string:
		if strings.TrimSpace(typed) != "" {
			return splitCSV(typed)
		}
	}
	return []string{"audio"}
}

func mergeRealtimeAudio(base map[string]any, override map[string]any) map[string]any {
	merged := cloneMap(base)
	for key, value := range override {
		merged[key] = value
	}
	for _, key := range []string{"input", "output"} {
		baseNested, _ := base[key].(map[string]any)
		overrideNested, _ := override[key].(map[string]any)
		if len(overrideNested) > 0 {
			merged[key] = mergeMap(baseNested, overrideNested)
		}
	}
	return merged
}

func turnDetectionObject(value any) any {
	switch typed := value.(type) {
	case nil:
		return nil
	case map[string]any:
		if len(typed) == 0 {
			return nil
		}
		return cloneMap(typed)
	}
	normalized := strings.TrimSpace(stringFromAny(value))
	if normalized == "" || normalized == "none" {
		return nil
	}
	if strings.HasPrefix(normalized, "{") {
		var parsed map[string]any
		if err := json.Unmarshal([]byte(normalized), &parsed); err == nil && len(parsed) > 0 {
			return parsed
		}
	}
	switch strings.ToLower(normalized) {
	case "steady":
		return map[string]any{
			"type":               "semantic_vad",
			"eagerness":          "low",
			"create_response":    true,
			"interrupt_response": true,
		}
	case "balanced":
		return map[string]any{
			"type":               "semantic_vad",
			"eagerness":          "auto",
			"create_response":    true,
			"interrupt_response": true,
		}
	case "fast":
		return map[string]any{
			"type":               "semantic_vad",
			"eagerness":          "high",
			"create_response":    true,
			"interrupt_response": true,
		}
	case "server_vad":
		return map[string]any{
			"type":                "server_vad",
			"threshold":           0.72,
			"prefix_padding_ms":   300,
			"silence_duration_ms": 500,
			"create_response":     true,
			"interrupt_response":  true,
		}
	}
	return map[string]any{"type": normalized}
}

func shouldAttachReasoning(model string, effort string) bool {
	normalized := strings.ToLower(strings.TrimSpace(effort))
	return strings.Contains(model, "gpt-realtime-2") && normalized != "" && normalized != "off" && normalized != "none"
}

func firstValue(values ...any) any {
	for _, value := range values {
		if stringFromAny(value) != "" {
			return value
		}
	}
	return nil
}

func stringFromAny(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64)
	case int:
		return strconv.Itoa(typed)
	case bool:
		if typed {
			return "true"
		}
		return ""
	default:
		return strings.TrimSpace(fmt.Sprint(typed))
	}
}

func numberOrDefault(value any, fallback int) int {
	switch typed := value.(type) {
	case int:
		if typed != 0 {
			return typed
		}
	case float64:
		if typed != 0 {
			return int(typed)
		}
	case string:
		if parsed, err := strconv.Atoi(strings.TrimSpace(typed)); err == nil && parsed != 0 {
			return parsed
		}
	}
	return fallback
}

func mergeMap(base map[string]any, override map[string]any) map[string]any {
	merged := cloneMap(base)
	if merged == nil {
		merged = map[string]any{}
	}
	for key, value := range override {
		merged[key] = value
	}
	return merged
}

func splitCSV(value string) []string {
	parts := strings.Split(value, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

func truncateString(value string, max int) string {
	runes := []rune(value)
	if len(runes) <= max {
		return value
	}
	return string(runes[:max])
}
