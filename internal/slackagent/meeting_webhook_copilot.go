package slackagent

import (
	"encoding/json"
	"fmt"
	"strings"
)

const meetingCopilotMaxFinalLineLen = 240

type meetingCopilotToolResult struct {
	Success bool
	Text    string
}

type meetingCopilotToolEffects struct {
	sentMeetingChatText string
	notifiedSlack       bool
	otherSideEffects    []string
	checkedSources      []string
}

func (e meetingCopilotToolEffects) hasSideEffects() bool {
	return strings.TrimSpace(e.sentMeetingChatText) != "" || e.notifiedSlack || len(e.otherSideEffects) > 0
}

func (e *meetingCopilotToolEffects) addCheckedSource(label string) {
	label = strings.TrimSpace(label)
	if label == "" {
		return
	}
	for _, existing := range e.checkedSources {
		if existing == label {
			return
		}
	}
	e.checkedSources = append(e.checkedSources, label)
}

func (e *meetingCopilotToolEffects) addOtherSideEffect(summary string) {
	summary = strings.TrimSpace(summary)
	if summary == "" {
		return
	}
	for _, existing := range e.otherSideEffects {
		if existing == summary {
			return
		}
	}
	e.otherSideEffects = append(e.otherSideEffects, summary)
}

func incrementalTranscript(previous, current string) string {
	current = strings.TrimSpace(current)
	if current == "" {
		return ""
	}
	previous = strings.TrimSpace(previous)
	if previous == "" {
		return current
	}
	if previous == current {
		return ""
	}

	seen := make(map[string]struct{})
	for _, line := range strings.Split(previous, "\n") {
		line = strings.TrimSpace(line)
		if line != "" {
			seen[line] = struct{}{}
		}
	}

	var delta []string
	for _, line := range strings.Split(current, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if _, ok := seen[line]; ok {
			continue
		}
		delta = append(delta, line)
	}
	return strings.Join(delta, "\n")
}

type meetingCopilotTranscriptFilterStats struct {
	SelfLines     int
	SelfEchoLines int
	FilteredLines int
}

func filterMeetingCopilotTranscriptDelta(delta string) (string, meetingCopilotTranscriptFilterStats) {
	delta = strings.TrimSpace(delta)
	if delta == "" {
		return "", meetingCopilotTranscriptFilterStats{}
	}

	var stats meetingCopilotTranscriptFilterStats
	kept := make([]string, 0)
	for _, rawLine := range strings.Split(delta, "\n") {
		line := strings.TrimSpace(rawLine)
		if line == "" {
			continue
		}
		_, speaker, text, ok := meetingCopilotTranscriptLineParts(line)
		if ok && meetingCopilotSpeakerIsSelf(speaker) {
			stats.SelfLines++
			stats.FilteredLines++
			continue
		}
		if meetingCopilotLooksLikeSelfEchoText(text) {
			stats.SelfEchoLines++
			stats.FilteredLines++
			continue
		}
		kept = append(kept, line)
	}
	return strings.Join(kept, "\n"), stats
}

func meetingCopilotTranscriptLineParts(line string) (prefix string, speaker string, text string, ok bool) {
	line = strings.TrimSpace(line)
	if line == "" {
		return "", "", "", false
	}
	rest := line
	if strings.HasPrefix(rest, "[") {
		if end := strings.Index(rest, "]"); end >= 0 {
			prefix = strings.TrimSpace(rest[:end+1])
			rest = strings.TrimSpace(rest[end+1:])
		}
	}
	colon := strings.Index(rest, ":")
	if colon <= 0 {
		return prefix, "", rest, false
	}
	speaker = strings.TrimSpace(rest[:colon])
	text = strings.TrimSpace(rest[colon+1:])
	return prefix, speaker, text, true
}

func meetingCopilotSpeakerIsSelf(speaker string) bool {
	normalized := strings.ToLower(strings.TrimSpace(speaker))
	switch normalized {
	case "you", "oneesama", "onee-sama", "onee sama", "meeting", "meeting avatar bot":
		return true
	default:
		return false
	}
}

func meetingCopilotLooksLikeSelfEchoText(text string) bool {
	text = strings.TrimSpace(text)
	if text == "" {
		return false
	}
	lower := strings.ToLower(text)
	for _, marker := range []string{
		"后台结果是当前没有需要执行",
		"当前没有额外需要执行",
		"当前没有需要执行的会议动作",
		"收到不再给代码",
	} {
		if strings.Contains(text, marker) {
			return true
		}
	}
	if strings.Contains(text, "你好，老大") && strings.Contains(text, "如果这个名字不对") {
		return true
	}
	if strings.Contains(lower, "asr") && strings.Contains(text, "回环") && strings.Contains(text, "排查") && strings.Contains(text, "我可以") {
		return true
	}
	return false
}

func meetingCopilotCompletionSummary(effects meetingCopilotToolEffects) string {
	var parts []string
	if strings.TrimSpace(effects.sentMeetingChatText) != "" {
		parts = append(parts, "sent meeting chat: "+truncateSlackContextText(strings.TrimSpace(effects.sentMeetingChatText), 80))
	}
	if effects.notifiedSlack {
		parts = append(parts, "notified linked Slack thread")
	}
	parts = append(parts, effects.otherSideEffects...)
	if len(parts) > 0 {
		return strings.Join(parts, "; ")
	}
	if len(effects.checkedSources) > 0 {
		return "checked without chat via " + strings.Join(effects.checkedSources, ", ")
	}
	return "no action"
}

func meetingCopilotHasVerboseFinalText(content string) bool {
	content = strings.TrimSpace(content)
	return content != "" && (len(content) > meetingCopilotMaxFinalLineLen || strings.ContainsAny(content, "\r\n"))
}

func meetingCopilotLinearMutationSummary(args map[string]any, result meetingCopilotToolResult) string {
	body, _ := args["body"].(string)
	query := strings.ToLower(body)
	if !strings.Contains(query, "mutation") {
		return ""
	}

	switch {
	case strings.Contains(query, "issuecreate"):
		if result.Success {
			if identifiers := extractCreatedLinearIssueIdentifiers(result.Text); len(identifiers) > 0 {
				return fmt.Sprintf("created Linear issue %s", strings.Join(identifiers, ", "))
			}
		}
		return "created Linear issue"
	case strings.Contains(query, "commentcreate"):
		return "commented on Linear issue"
	case strings.Contains(query, "attachmentcreate"):
		return "attached context to Linear issue"
	default:
		return "updated Linear"
	}
}

func meetingCopilotCalendarMutationSummary(args map[string]any) string {
	method, _ := args["method"].(string)
	method = strings.ToUpper(strings.TrimSpace(method))
	if method == "" {
		method = "GET"
	}
	if method == "GET" {
		return ""
	}
	return "updated Google Calendar"
}

func meetingCopilotRunCommandSummary(args map[string]any) string {
	command, _ := args["command"].(string)
	command = strings.TrimSpace(command)
	if command == "" {
		return "run_command"
	}
	fields := strings.Fields(command)
	if len(fields) == 0 {
		return "run_command"
	}
	switch fields[0] {
	case "gh":
		return "GitHub"
	case "curl":
		return "public API"
	case "date":
		return "date/time"
	default:
		return fields[0]
	}
}

func recordMeetingCopilotToolExecution(effects *meetingCopilotToolEffects, toolName string, args map[string]any, result meetingCopilotToolResult) {
	if effects == nil || !result.Success {
		return
	}

	switch toolName {
	case "send_meeting_chat":
		if text, _ := args["text"].(string); strings.TrimSpace(text) != "" {
			effects.sentMeetingChatText = strings.TrimSpace(text)
		} else {
			effects.sentMeetingChatText = "meeting chat sent"
		}
	case "notify_meeting_slack":
		effects.notifiedSlack = true
	case "linear_api":
		recordMeetingToolMutation(effects, meetingCopilotLinearMutationSummary(args, result), "Linear")
	case "google_calendar_api":
		recordMeetingToolMutation(effects, meetingCopilotCalendarMutationSummary(args), "Google Calendar")
	case "run_command":
		effects.addCheckedSource(meetingCopilotRunCommandSummary(args))
	default:
		effects.addCheckedSource(toolName)
	}
}

func recordMeetingToolMutation(effects *meetingCopilotToolEffects, summary, checkedSource string) {
	if summary != "" {
		effects.addOtherSideEffect(summary)
		return
	}
	effects.addCheckedSource(checkedSource)
}

func containsExplicitMeetingFollowUp(transcript string) bool {
	text := strings.ToLower(strings.TrimSpace(transcript))
	if text == "" {
		return false
	}

	requestPhrases := []string{
		"帮我", "帮忙", "查一下", "看一下", "问一下", "记一下", "同步一下", "发一下",
		"什么状态", "有没有", "能不能", "可以帮", "look up", "check", "status",
		"can you", "could you", "please", "note this", "follow up", "remind",
		"你来", "你弄一下", "你设计一下", "我来", "我去弄", "负责", "跟进", "action item",
		"owner", "周三再对一下", "明天跟进", "后续同步",
	}
	for _, phrase := range requestPhrases {
		if strings.Contains(text, phrase) {
			return true
		}
	}

	wakePhrases := []string{
		"notetaker", "note taker", "cueboard", "onee_sama", "onee-sama",
		"assistant", "记录员", "机器人", "小助手", "bot",
	}
	for _, wake := range wakePhrases {
		if strings.Contains(text, wake) && strings.ContainsAny(text, "?？") {
			return true
		}
	}
	return false
}

func extractCreatedLinearIssueIdentifiers(resultText string) []string {
	var payload struct {
		Data map[string]json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal([]byte(resultText), &payload); err != nil {
		return nil
	}
	var identifiers []string
	for _, raw := range payload.Data {
		identifiers = append(identifiers, extractLinearIdentifiersFromJSON(raw)...)
	}
	return dedupeStrings(identifiers)
}

func extractLinearIdentifiersFromJSON(raw json.RawMessage) []string {
	var node any
	if err := json.Unmarshal(raw, &node); err != nil {
		return nil
	}
	var identifiers []string
	var walk func(any)
	walk = func(value any) {
		switch typed := value.(type) {
		case map[string]any:
			if ident, _ := typed["identifier"].(string); strings.TrimSpace(ident) != "" {
				identifiers = append(identifiers, strings.TrimSpace(ident))
			}
			for _, child := range typed {
				walk(child)
			}
		case []any:
			for _, child := range typed {
				walk(child)
			}
		}
	}
	walk(node)
	return identifiers
}

func dedupeStrings(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result
}
