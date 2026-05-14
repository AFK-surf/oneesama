package slackagent

import (
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

var slackTriageActionablePattern = regexp.MustCompile(`(?i)\b(todo|follow.?up|fix|bug|blocked|need|needs|should|please|明天|跟进|修|问题|阻塞|需要)\b`)
var slackTriageURLPattern = regexp.MustCompile(`https?://[^\s<>()]+`)

var slackTriageActionTypes = map[string]struct{}{
	"follow_up":         {},
	"create_task":       {},
	"ask_user":          {},
	"create_issue":      {},
	"add_comment":       {},
	"create_event":      {},
	"join_meeting":      {},
	"create_channel":    {},
	"post_thread_reply": {},
	"none":              {},
}

var slackTriageMutationActionTypes = map[string]struct{}{
	"follow_up":      {},
	"create_task":    {},
	"ask_user":       {},
	"create_issue":   {},
	"add_comment":    {},
	"create_event":   {},
	"join_meeting":   {},
	"create_channel": {},
}

type slackTriageFallback struct {
	Summary  string
	Actions  []SlackTriageDecisionAction
	Channel  string
	ThreadTS string
}

func buildSlackTriagePrompt(input SlackTriagePromptInput) string {
	recentMemory := formatSlackTriageMemory(input.LocalMemory)
	existingBrain := ""
	if input.ChannelBrain != nil && strings.TrimSpace(input.ChannelBrain.Summary) != "" {
		existingBrain = "Existing channel brain:\n" + input.ChannelBrain.Summary + "\n\n"
	}
	memoryBlock := ""
	if recentMemory != "" {
		memoryBlock = "Relevant local memory:\n" + recentMemory + "\n\n"
	}
	previousBlock := ""
	if input.PreviousTriage != "" {
		previousBlock = input.PreviousTriage + "\n\n"
	}
	messageBlock := strings.TrimSpace(input.Digest)
	if messageBlock == "" {
		lines := make([]string, 0, len(input.Messages))
		for _, message := range input.Messages {
			thread := ""
			if message.ThreadTS != "" {
				thread = " thread=" + message.ThreadTS
			}
			lines = append(lines, "- "+message.TS+" <@"+message.UserID+">"+thread+": "+message.Text)
		}
		messageBlock = strings.Join(lines, "\n")
	}

	return strings.Join([]string{
		"You are porting Legacy Slack Agent triage behavior.",
		"Read buffered Slack activity and decide whether the bot should reply, stay silent, or surface a mutation action card.",
		"Legacy Cueboard behavior is low-friction: most triage cycles reply or stay silent. Confirmation cards are only for external mutations.",
		"",
		"Channel: " + input.ChannelID,
		existingBrain + memoryBlock + previousBlock,
		"Policy rails:",
		"- Use `post_thread_reply` with `requiresConfirmation:false` for read-only answers, summaries, link commentary, and brief synthesis.",
		"- Use pending confirmation only for mutations: create_issue, add_comment, create_event, join_meeting, create_channel, create_task/follow_up/ask_user.",
		"- Do not ask permission to read a public link. If it is worth handling, read it and answer directly; otherwise choose none.",
		"- Bare Slack archive/permalink URLs are not automatically relevant. Ignore them unless the message explicitly asks you to inspect/summarize that Slack thread.",
		"- Casual chat exception: one short reply is allowed only when it adds something new and sounds natural out loud; otherwise choose none.",
		"- Facts for facts. For meaningful external links, read first; do not auto-skip just because nobody asked.",
		"- technical threads that have clearly stalled may need one verified fact or issue hygiene; do not do the debugging yourself in triage.",
		"- Google Meet URL is a strong action signal; prefer a join_meeting pending action when someone appears to be asking for meeting help.",
		"- Product-risk threads are not ordinary chatter; crash, compatibility, and launch-risk discussions are issue-hygiene candidates.",
		"- People talking to each other is not an auto-skip; if you can add issue hygiene, one verified fact, or one short synthesis, act thoughtfully.",
		"- No action is valid when there is truly nothing useful. Do not let concrete follow-ups evaporate.",
		"",
		"Buffered activity:",
		messageBlock,
		"",
		"Return only JSON with this shape:",
		"{",
		`  "summary": "one concise channel-brain update",`,
		`  "actions": [`,
		"    {",
		`      "type": "post_thread_reply | follow_up | create_task | ask_user | create_issue | add_comment | create_event | join_meeting | create_channel | none",`,
		`      "title": "short action title",`,
		`      "message": "reply text for post_thread_reply, or what the user should confirm for a mutation",`,
		`      "channelId": "Slack channel id, optional",`,
		`      "threadTs": "Slack thread ts, optional",`,
		`      "confidence": 0.0,`,
		`      "reason": "why this action is justified",`,
		`      "requiresConfirmation": false`,
		"    }",
		"  ]",
		"}",
	}, "\n")
}

type SlackTriagePromptInput struct {
	ChannelID      string
	Messages       []SlackInboundMessage
	Digest         string
	ChannelBrain   *SlackChannelBrain
	LocalMemory    []SlackTriageMemoryEntry
	PreviousTriage string
}

type SlackTriageMemoryEntry struct {
	Source  string `json:"source,omitempty"`
	Kind    string `json:"kind,omitempty"`
	Content string `json:"content,omitempty"`
}

func formatSlackTriageMemory(entries []SlackTriageMemoryEntry) string {
	var lines []string
	for index, entry := range entries {
		if index >= 5 {
			break
		}
		content := truncateSlackContextText(strings.TrimSpace(entry.Content), 500)
		if content == "" {
			continue
		}
		label := firstNonEmpty(entry.Source, entry.Kind, "memory")
		lines = append(lines, strconv.Itoa(index+1)+". "+label+": "+content)
	}
	return strings.Join(lines, "\n")
}

func parseSlackTriageDecision(rawOutput string, fallback slackTriageFallback) SlackTriageDecision {
	parsed, ok := firstSlackTriageJSONObject(rawOutput)
	source := parsed
	if source == nil {
		source = map[string]any{}
	}
	actions, _ := source["actions"].([]any)
	fallbackActions := make([]any, 0, len(fallback.Actions))
	for _, action := range fallback.Actions {
		fallbackActions = append(fallbackActions, action)
	}
	if len(actions) == 0 {
		actions = fallbackActions
	}
	summary := firstNonEmpty(
		stringFromAny(source["summary"]),
		stringFromAny(source["channelBrain"]),
		stringFromAny(source["brief"]),
		fallback.Summary,
		"Slack activity triage completed.",
	)
	return SlackTriageDecision{
		Summary: summary,
		Actions: normalizeSlackTriageActions(actions, fallback),
		Raw:     parsed,
		ParseOK: ok,
	}
}

func suggestSlackTriageFallback(channelID string, messages []SlackInboundMessage) slackTriageFallback {
	joined := joinSlackMessageTexts(messages)
	latest := SlackInboundMessage{}
	if len(messages) > 0 {
		latest = messages[len(messages)-1]
	}
	summary := "No Slack messages to triage."
	if len(messages) > 0 {
		summary = "Buffered " + strconv.Itoa(len(messages)) + " Slack message(s); latest from <@" + firstNonEmpty(latest.UserID, "unknown") + ">."
	}
	if !slackTriageActionablePattern.MatchString(joined) {
		return slackTriageFallback{Summary: summary, Channel: channelID, ThreadTS: firstNonEmpty(latest.ThreadTS, latest.TS)}
	}
	title := truncateSlackContextText(strings.Join(strings.Fields(firstNonEmpty(latest.Text, joined)), " "), 80)
	if title == "" {
		title = "Follow up on Slack activity"
	}
	return slackTriageFallback{
		Summary:  summary,
		Channel:  channelID,
		ThreadTS: firstNonEmpty(latest.ThreadTS, latest.TS),
		Actions: []SlackTriageDecisionAction{{
			Type:                 "follow_up",
			Title:                title,
			Message:              "Review and follow up on this Slack activity:\n" + truncateSlackContextText(joined, 1200),
			ChannelID:            channelID,
			ThreadTS:             firstNonEmpty(latest.ThreadTS, latest.TS),
			Confidence:           0.65,
			Reason:               "Buffered activity contains actionable wording.",
			RequiresConfirmation: true,
		}},
	}
}

func normalizeSlackTriageActions(values []any, fallback slackTriageFallback) []SlackTriageDecisionAction {
	actions := make([]SlackTriageDecisionAction, 0, len(values))
	for _, value := range values {
		action := triageActionFromAny(value)
		typ := strings.ToLower(firstNonEmpty(action.Type, "follow_up"))
		if typ == "reply" || typ == "answer" {
			typ = "post_thread_reply"
		}
		if typ == "delegate" {
			typ = "create_task"
		}
		if _, ok := slackTriageActionTypes[typ]; !ok {
			typ = "follow_up"
		}
		if typ == "none" {
			continue
		}
		title := truncateSlackContextText(firstNonEmpty(action.Title, "Review Slack activity"), 160)
		message := truncateSlackContextText(firstNonEmpty(action.Message, action.Reason, title), 2000)
		requires := slackTriageActionRequiresConfirmation(typ, action.RequiresConfirmation)
		actions = append(actions, SlackTriageDecisionAction{
			Type:                 typ,
			Title:                title,
			Message:              message,
			ChannelID:            firstNonEmpty(action.ChannelID, fallback.Channel),
			ThreadTS:             firstNonEmpty(action.ThreadTS, fallback.ThreadTS),
			Confidence:           clampFloat(action.Confidence, 0, 1, 0.5),
			Reason:               strings.TrimSpace(action.Reason),
			RequiresConfirmation: requires,
		})
		if len(actions) >= 5 {
			break
		}
	}
	return actions
}

func triageActionFromAny(value any) SlackTriageDecisionAction {
	switch typed := value.(type) {
	case SlackTriageDecisionAction:
		return typed
	case map[string]any:
		return SlackTriageDecisionAction{
			Type:                 firstNonEmpty(stringFromAny(typed["type"]), stringFromAny(typed["actionType"]), stringFromAny(typed["action_type"])),
			Title:                firstNonEmpty(stringFromAny(typed["title"]), stringFromAny(typed["brief"]), stringFromAny(typed["summary"])),
			Message:              firstNonEmpty(stringFromAny(typed["message"]), stringFromAny(typed["text"]), stringFromAny(typed["description"]), stringFromAny(typed["reason"])),
			ChannelID:            firstNonEmpty(stringFromAny(typed["channelId"]), stringFromAny(typed["channel_id"]), stringFromAny(typed["channel"])),
			ThreadTS:             firstNonEmpty(stringFromAny(typed["threadTs"]), stringFromAny(typed["thread_ts"])),
			Confidence:           numberFromAny(typed["confidence"], 0.5),
			Reason:               firstNonEmpty(stringFromAny(typed["reason"]), stringFromAny(typed["rationale"])),
			RequiresConfirmation: boolFromAny(typed["requiresConfirmation"], boolFromAny(typed["requires_confirmation"], true)),
		}
	default:
		return SlackTriageDecisionAction{}
	}
}

func triageActionRows(actions []SlackTriageDecisionAction) []SlackTriageAction {
	rows := make([]SlackTriageAction, 0, len(actions))
	for _, action := range actions {
		rows = append(rows, SlackTriageAction{Tool: action.Type, Channel: action.ChannelID, Brief: action.Title})
	}
	return rows
}

func joinSlackMessageTexts(messages []SlackInboundMessage) string {
	parts := make([]string, 0, len(messages))
	for _, message := range messages {
		if strings.TrimSpace(message.Text) != "" {
			parts = append(parts, strings.TrimSpace(message.Text))
		}
	}
	return strings.Join(parts, "\n")
}

func slackTriageActionRequiresConfirmation(actionType string, modelValue bool) bool {
	if _, ok := slackTriageMutationActionTypes[actionType]; ok {
		return true
	}
	return modelValue && actionType != "post_thread_reply"
}

func filterSlackTriageActionsForMessages(actions []SlackTriageDecisionAction, messages []SlackInboundMessage) []SlackTriageDecisionAction {
	if len(actions) == 0 {
		return actions
	}
	if slackMessagesAreBareInternalPermalinks(messages) && !explicitlyRequestsSlackPermalinkHandling(joinSlackMessageTexts(messages)) {
		return nil
	}
	if slackTriageThreadContinuationShouldStaySilent(messages) {
		filtered := make([]SlackTriageDecisionAction, 0, len(actions))
		for _, action := range actions {
			if slackTriageDirectReplyAction(action) {
				continue
			}
			filtered = append(filtered, action)
		}
		return filtered
	}
	return actions
}

func slackTriageThreadContinuationShouldStaySilent(messages []SlackInboundMessage) bool {
	var sawThreadContinuation bool
	var textParts []string
	for _, message := range messages {
		text := strings.TrimSpace(message.Text)
		if text == "" {
			continue
		}
		if strings.TrimSpace(message.ThreadTS) == "" || strings.TrimSpace(message.ThreadTS) == strings.TrimSpace(message.TS) {
			return false
		}
		sawThreadContinuation = true
		textParts = append(textParts, text)
	}
	if !sawThreadContinuation {
		return false
	}
	text := strings.Join(textParts, "\n")
	if explicitlyRequestsSlackPermalinkHandling(text) {
		return false
	}
	if slackTriageURLPattern.MatchString(text) {
		return false
	}
	if strings.Contains(text, "<@") {
		return false
	}
	if strings.ContainsAny(text, "?？") {
		return false
	}
	return true
}

func slackMessagesAreBareInternalPermalinks(messages []SlackInboundMessage) bool {
	var sawURL bool
	for _, message := range messages {
		text := strings.TrimSpace(message.Text)
		if text == "" {
			continue
		}
		urls := slackTriageURLPattern.FindAllString(text, -1)
		if len(urls) == 0 {
			return false
		}
		for _, rawURL := range urls {
			if !isInternalSlackArchiveURL(rawURL) {
				return false
			}
			sawURL = true
		}
		rest := strings.TrimSpace(slackTriageURLPattern.ReplaceAllString(text, ""))
		rest = strings.Trim(rest, "<>| \t\r\n")
		if rest != "" {
			return false
		}
	}
	return sawURL
}

func isInternalSlackArchiveURL(rawURL string) bool {
	parsed, err := url.Parse(strings.Trim(rawURL, "<>|.,，。)）]】"))
	if err != nil {
		return false
	}
	host := strings.ToLower(parsed.Hostname())
	return strings.HasSuffix(host, ".slack.com") && strings.HasPrefix(parsed.Path, "/archives/")
}

func explicitlyRequestsSlackPermalinkHandling(text string) bool {
	normalized := strings.ToLower(strings.TrimSpace(text))
	for _, keyword := range []string{
		"看看", "看下", "看一下", "读一下", "读下", "总结", "概括", "分析", "解释", "这是啥", "什么情况", "帮我看",
		"read", "summarize", "summary", "check this", "look at", "what is", "what's", "explain",
	} {
		if strings.Contains(normalized, keyword) {
			return true
		}
	}
	return false
}

func slackTriageDirectReplyAction(action SlackTriageDecisionAction) bool {
	return action.Type == "post_thread_reply" && !action.RequiresConfirmation
}
