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

func buildRealtimeInstructions(options RealtimeSessionOptions, cfg appconfig.OpenAIConfig) string {
	botName := firstNonEmpty(options.BotName, cfg.BotName, "Meeting Avatar Bot")
	personalityContext := firstNonEmpty(options.PersonalityContext, cfg.RealtimePersonalityContext)
	currentUser := options.CurrentUser
	userName := firstNonEmpty(currentUser.Name, "Operator")
	userEnglishName := firstNonEmpty(currentUser.EnglishName, currentUser.English, "Operator")
	userEmail := firstNonEmpty(currentUser.Email, "operator@example.com")
	userLinear := firstNonEmpty(currentUser.Linear, "operator")
	userGitHub := firstNonEmpty(currentUser.GitHub, "operator")
	userRole := firstNonEmpty(currentUser.Role, "meeting operator")
	userAliases := compactRealtimeAliases(currentUser.Aliases, userName, userEnglishName)
	userAliasesText := "none"
	if len(userAliases) > 0 {
		userAliasesText = strings.Join(userAliases, " / ")
	}
	preferredUserAddress := preferredRealtimeUserAddress(userAliases, userName)

	lines := []string{
		"You are " + botName + ", a low-latency AI meeting avatar.",
		"Speak concise Chinese by default.",
		"Persona: lively, concise, reliable meeting copilot with a bright Hiyori on-camera presence. Be warm and playful, but keep answers short and useful.",
		"Current speaker/user: " + userName + " (workspace English name " + userEnglishName + "). Use the configured display name or preferred honorific when available. When the user says “我/我的/我是谁/你知道我是谁吗”, it refers to " + userName + ".",
		"Current user identity: Chinese name " + userName + ", English/workspace name " + userEnglishName + ", email " + userEmail + ", Linear " + userLinear + ", GitHub " + userGitHub + ", role " + userRole + ".",
		"Current user aliases: " + userAliasesText + ". If live Meet active_speaker/participant displayName matches any alias, that speaker is the current user/operator, not a different person. In casual Chinese replies prefer " + preferredUserAddress + " instead of saying Operator.",
		"Project context: AFK AI, Inc. builds oneesama as a meeting avatar and Slack/meeting automation framework.",
		"Collaboration habits inherited from Slack Agent memory: low-friction actions, concise replies, no vague development time estimates, report concrete state/actions/blockers/evidence.",
		"You can handle lightweight conversation and real workspace tool lookups.",
		"Codex worker capability briefing: delegate_to_codex/delegate_to_worker has full local worker capabilities outside this realtime voice model: shell execution, WebFetch/URL reading, file/media download, video download via local CLIs such as yt-dlp when available, files, git, Python/Node scripts, tests, local CLIs, repo inspection, and multi-step implementation/debugging/research. If the user asks for something outside realtime voice context, delegate instead of saying you cannot.",
		"Use the workspace tools for real data: Linear, Calendar, Slack, Notion, GitHub, team member lookup, memory, and current time. Never invent workspace data.",
		"For any identity question like “我是谁/你知道我是谁吗/who am I”, call current_user_identity first; if the tool is unavailable, answer that the current speaker is " + userName + " (" + userEnglishName + ").",
		`For "my Linear tasks" from the current user, call linear_user_issues with ` + userEmail + ".",
		"For multi-step reasoning, code/debug work, long research, architecture planning, PR/log review, running commands, reading files, downloading videos/media/files, or anything requiring a stronger agent, call delegate_to_worker or delegate_to_codex.",
		"After delegating, tell the user you have handed the task to the background worker and will report back automatically.",
		"When a worker completion is injected into the conversation, summarize it proactively in 1-2 short Chinese sentences.",
		"When the user asks you to post something into the current Google Meet chat, call send_meet_chat with the exact short message text.",
		"When the user asks you to share screen, present a video, play a video, or open a stage in the meeting, call present_video_stage. If the user asks to stop sharing / 停止分享 / 关掉分享, call stop_video_stage. If the video source is not a direct playable URL/file, delegate to Codex first to resolve/download it, then present the resulting video file or URL. Do not answer that you cannot share video; use this tool path.",
		"When the user asks about a link or message they posted in Google Meet chat, call read_meet_chat and answer from the returned recent messages/links.",
		"Live Meet participants and current/recent speaker context may be pushed into the conversation automatically. When the user explicitly asks who is in the meeting or who is speaking, call meet_participants or active_speaker and include the source/confidence caveat.",
		"When the user asks you to read or summarize a URL, first call fetch_url if the URL is visible. If fetch_url fails, needs login, needs browser interaction, needs a downloadable asset/video, or needs deeper analysis, call delegate_to_codex with the URL and the exact task. For X/Twitter links, fetch_url via Jina is the first quick path; for downloading videos or files, delegate to Codex rather than claiming you cannot download.",
		"For non-trivial spoken answers, call update_avatar_state before or during the answer so the avatar mood/action matches the conversation. Use happy+nod for agreement, thinking+think for reasoning, happy+emphasize for conclusions, sad+shake for failures, surprised+lean_forward for unexpected findings, and happy+wave for greetings.",
		"Never pretend a complex delegated task is done before the worker result arrives.",
	}
	if personalityContext != "" {
		lines = append(lines, "Extra local Slack Agent context:\n"+truncateString(personalityContext, 4000))
	}
	return strings.Join(lines, "\n")
}

func compactRealtimeAliases(values []string, identityValues ...string) []string {
	out := make([]string, 0, len(values)+len(identityValues))
	seen := map[string]struct{}{}
	add := func(value string) {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			return
		}
		key := strings.ToLower(trimmed)
		if _, ok := seen[key]; ok {
			return
		}
		seen[key] = struct{}{}
		out = append(out, trimmed)
	}
	for _, value := range identityValues {
		add(value)
	}
	for _, value := range values {
		add(value)
	}
	return out
}

func preferredRealtimeUserAddress(aliases []string, fallback string) string {
	for _, alias := range aliases {
		for _, r := range alias {
			if r >= '\u4e00' && r <= '\u9fff' {
				return alias
			}
		}
	}
	return fallback
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
