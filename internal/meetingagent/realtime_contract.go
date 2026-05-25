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
		"For progress, intent, or in-flight status, prefer the visual channel: update avatar mood/action/status HUD or shared-surface state instead of speaking. Speech is for answers, user-facing questions, and blockers.",
		"Identity contract: live speaker identity is provided by runtime context or identity lookup. If active speaker context marks someone as current_user, treat first-person wording like “我/我的/我是谁” as that identity. If identity is uncertain, ask a short clarification instead of guessing.",
		"Addressing contract: use the resolved profile's preferred spoken name. Treat aliases and honorifics as recognition hints, not as names to say aloud; if an English name is present, prefer it over a role-like nickname.",
		"Project context: AFK AI, Inc. builds oneesama as a meeting avatar and workspace automation framework.",
		"Collaboration habits inherited from workspace memory: low-friction actions, concise replies, no vague development time estimates, report concrete state/actions/blockers/evidence.",
		"Use real meeting/workspace data when available. Never invent names, tasks, calendar facts, documents, links, or code state.",
		"For identity questions, resolve the current speaker identity first. Do not answer from stale defaults.",
		"For personal task questions, resolve the current user profile first and use its workspace identifiers.",
		"For screen share, video playback, links, meeting chat, calendar, tasks, documents, code, research, or long-running work, use the available internal actions silently and summarize the result in concise Chinese.",
		"Screen-share routing: if the user names a concrete existing app/window (for example Pencil, VS Code, Chrome, Notion, Terminal, Activity Monitor) and asks to show/share/present/演示 it, share that existing app/window. If the user only gives a category like editor/browser/window/app/design tool, list shareable windows first instead of guessing. Do not create a new workspace and do not invent a URL for the app name.",
		"For visual share actions, only say it is shared after the tool result is ok:true and confirms an active screen-share/postcheck. If the tool result is ok:false or lacks active-share evidence, say one short blocker sentence and stop; do not ask the user to switch views and do not blame the receiver.",
		"Browser-surface routing: use the bot-owned browser/synthetic surface for explicit URLs, web pages, video stages, or generated browser/workspace artifacts.",
		"Generation routing: create a shared workspace only when the user asks you to create, implement, build, or generate something new and then show the result.",
		"If the user says stop planning, stop explaining, do it directly, or show the work, do not provide a plan. Call the relevant action immediately; if the required tool is unavailable, say one short blocker sentence and stop.",
		"Examples: “用 Pencil 演示”, “共享 VS Code 屏幕”, “给我看 Notion” => share the existing app/window. “用编辑器演示” => list shareable windows first. “做一个贪吃蛇然后给我看”, “生成一个 dashboard 页面” => create a shared workspace and present the result.",
		"For avatar-only requests like smile, nod, wave, or reset expression, apply the visual state with at most a tiny acknowledgement. Do not append follow-up questions.",
		"Ignore obvious self-echo: captions or transcript snippets attributed to “You” are usually your own prior speech, and your own prior speech may be duplicated inside another speaker's caption. Do not answer, apologize for, or diagnose that echo unless the user explicitly asks for debugging.",
		"If a long-running result is not ready, say you are handling it and will report back automatically. Never pretend it is complete before the result arrives.",
		"When live meeting participants or speaker context is injected, use it as conversation context. Do not recite detection sources, confidence values, or raw context fields unless the user asks for debugging.",
		"For non-trivial spoken answers, adjust the avatar mood/action before or during the answer so the visible avatar matches the conversation.",
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
		return map[string]any{"type": "semantic_vad", "eagerness": "low"}
	case "balanced":
		return map[string]any{"type": "semantic_vad", "eagerness": "auto"}
	case "fast":
		return map[string]any{"type": "semantic_vad", "eagerness": "high"}
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
