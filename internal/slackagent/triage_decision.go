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
	var contextBlocks []string
	if input.ChannelBrain != nil && strings.TrimSpace(input.ChannelBrain.Summary) != "" {
		contextBlocks = append(contextBlocks, "Existing channel brain:\n"+input.ChannelBrain.Summary)
	}
	if recentMemory != "" {
		contextBlocks = append(contextBlocks, "Relevant local memory:\n"+recentMemory)
	}
	if relatedMemory := formatSlackRelatedMemoryEvidence(input.RelatedMemory, 5); relatedMemory != "" {
		contextBlocks = append(contextBlocks, "Related memory evidence (cite source path/lines when using; ignore weak or irrelevant hits):\n"+relatedMemory)
	}
	if input.PreviousTriage != "" {
		contextBlocks = append(contextBlocks, input.PreviousTriage)
	}
	if externalLinks := formatSlackExternalLinkContexts(input.ExternalLinks); externalLinks != "" {
		contextBlocks = append(contextBlocks, "Fetched external links:\n"+externalLinks)
	}
	if threadContexts := formatSlackTriageThreadContexts(input.ThreadContexts); threadContexts != "" {
		contextBlocks = append(contextBlocks, "Fetched Slack thread context:\n"+threadContexts)
	}
	if input.IgnoreExistingBotReply {
		contextBlocks = append(contextBlocks, "Dev rerun override:\nThis is an internal acceptance rerun. Ignore bot-authored replies already present in the fetched thread context as a reason to skip or stay silent. Human replies and safety/freshness still apply.")
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

	sections := []string{
		cueboardTriageSystemPrompt,
		"Channel: " + input.ChannelID,
	}
	if len(contextBlocks) > 0 {
		sections = append(sections, "Context:\n"+strings.Join(contextBlocks, "\n\n"))
	}
	sections = append(sections,
		"Digest:",
		messageBlock,
		"",
		"Runtime output adapter:",
		"The legacy tools are represented as JSON in this Go runtime. Preserve the cueboard policy above; only translate the action you would have taken into the JSON action list below.",
		"- slack.postThreadReply maps to type post_thread_reply with requiresConfirmation=false.",
		"- suggest_action(action_type=\"join_meeting\") maps to type join_meeting.",
		"- suggest_action for create_issue, add_comment, create_event, create_channel, create_task, follow_up, or ask_user maps to the matching type and requiresConfirmation=true.",
		"- If the cueboard policy says no action, return an empty actions array.",
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
	)
	return strings.Join(sections, "\n")
}

type SlackTriagePromptInput struct {
	ChannelID      string
	Messages       []SlackInboundMessage
	Digest         string
	ChannelBrain   *SlackChannelBrain
	LocalMemory    []SlackTriageMemoryEntry
	RelatedMemory  []SlackRelatedMemoryRecord
	PreviousTriage string
	ExternalLinks  []SlackExternalLinkContext
	ThreadContexts []SlackTriageThreadContext

	// Dev-only acceptance rerun override. Normal live triage should still avoid
	// duplicate bot replies.
	IgnoreExistingBotReply bool
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

func formatSlackRelatedMemoryEvidence(records []SlackRelatedMemoryRecord, limit int) string {
	if len(records) == 0 || limit <= 0 {
		return ""
	}
	lines := make([]string, 0, limit)
	for index, record := range records {
		if index >= limit {
			break
		}
		content := truncateSlackContextText(strings.TrimSpace(record.Content), 420)
		if content == "" {
			continue
		}
		citation := slackRelatedMemoryCitation(record)
		if citation == "" {
			continue
		}
		kind := strings.TrimSpace(record.Kind)
		if kind != "" {
			kind = " [" + kind + "]"
		}
		lines = append(lines, strconv.Itoa(len(lines)+1)+". "+citation+kind+": "+content)
	}
	return strings.Join(lines, "\n")
}

func slackRelatedMemoryCitation(record SlackRelatedMemoryRecord) string {
	source := strings.TrimSpace(firstNonEmpty(record.SourcePath, record.Source, record.SourceRef))
	if source == "" {
		return ""
	}
	if record.StartLine > 0 {
		if record.EndLine > 0 && record.EndLine != record.StartLine {
			return source + ":" + strconv.Itoa(record.StartLine) + "-" + strconv.Itoa(record.EndLine)
		}
		return source + ":" + strconv.Itoa(record.StartLine)
	}
	return source
}

func formatSlackTriageThreadContexts(contexts []SlackTriageThreadContext) string {
	var blocks []string
	for _, context := range contexts {
		if !context.FetchOK && strings.TrimSpace(context.FetchError) != "" {
			blocks = append(blocks, "thread "+context.ChannelID+"/"+context.ThreadTS+": fetch failed: "+context.FetchError)
			continue
		}
		transcript := strings.TrimSpace(context.Transcript)
		if transcript == "" {
			continue
		}
		blocks = append(blocks, "thread "+context.ChannelID+"/"+context.ThreadTS+" ("+strconv.Itoa(context.MessageCount)+" messages):\n"+transcript)
	}
	return strings.Join(blocks, "\n\n")
}

func parseSlackTriageDecision(rawOutput string, fallback slackTriageFallback) SlackTriageDecision {
	parsed, ok := firstSlackTriageJSONObject(rawOutput)
	if !ok {
		parsed, ok = repairSlackTriagePlainNoAction(rawOutput)
	}
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
	normalizedActions := normalizeSlackTriageActions(actions, fallback)
	if len(normalizedActions) == 0 {
		if stripped, ok := stripSlackTriageNoActionPrefix(summary); ok && stripped != "" {
			summary = stripped
		}
	}
	return SlackTriageDecision{
		Summary: summary,
		Actions: normalizedActions,
		Raw:     parsed,
		ParseOK: ok,
	}
}

func repairSlackTriagePlainNoAction(raw string) (map[string]any, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, false
	}
	normalized := strings.ToLower(raw)
	noActionHints := []string{
		"no action",
		"no-action",
		"no further action",
		"nothing to do",
		"无需操作",
		"无需行动",
		"不需要操作",
		"不需要行动",
		"不用操作",
		"不用行动",
		"无需接话",
		"不用接话",
		"跳过",
	}
	matched := false
	for _, hint := range noActionHints {
		if strings.Contains(normalized, strings.ToLower(hint)) {
			matched = true
			break
		}
	}
	if !matched {
		return nil, false
	}
	return map[string]any{
		"summary": slackTriagePlainNoActionSummary(raw),
		"actions": []any{},
	}, true
}

func slackTriagePlainNoActionSummary(raw string) string {
	lines := strings.Split(strings.TrimSpace(raw), "\n")
	for _, line := range lines {
		line = strings.TrimSpace(strings.Trim(line, "`"))
		if line == "" {
			continue
		}
		if stripped, ok := stripSlackTriageNoActionPrefix(line); ok {
			if stripped == "" {
				continue
			}
			return truncateSlackContextText(stripped, 300)
		}
		normalized := strings.ToLower(strings.Trim(line, ".。:： \t"))
		switch normalized {
		case "no action", "no action needed", "no further action", "nothing to do":
			continue
		}
		return truncateSlackContextText(line, 300)
	}
	return "No action needed."
}

func stripSlackTriageNoActionPrefix(line string) (string, bool) {
	trimmed := strings.TrimSpace(line)
	lower := strings.ToLower(trimmed)
	prefixes := []string{
		"no further action needed",
		"no action needed",
		"no further action",
		"nothing to do",
		"no action",
		"no-action",
		"无需操作",
		"无需行动",
		"不需要操作",
		"不需要行动",
		"不用操作",
		"不用行动",
		"无需接话",
		"不用接话",
		"跳过",
	}
	for _, prefix := range prefixes {
		if !strings.HasPrefix(lower, strings.ToLower(prefix)) {
			continue
		}
		rest := strings.TrimSpace(trimmed[len(prefix):])
		rest = strings.TrimLeft(rest, ".。:：,，;；-— \t")
		return strings.TrimSpace(rest), true
	}
	return "", false
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
	return slackTriageFallback{
		Summary:  summary,
		Channel:  channelID,
		ThreadTS: firstNonEmpty(latest.ThreadTS, latest.TS),
	}
}

func normalizeSlackTriageActions(values []any, fallback slackTriageFallback) []SlackTriageDecisionAction {
	actions := make([]SlackTriageDecisionAction, 0, len(values))
	for _, value := range values {
		action := triageActionFromAny(value)
		typ := strings.ToLower(firstNonEmpty(action.Type, "follow_up"))
		typ = strings.TrimPrefix(typ, "slack.")
		if typ == "reply" || typ == "answer" {
			typ = "post_thread_reply"
		}
		if typ == "postthreadreply" {
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

func filterSlackTriageActionsForMessages(actions []SlackTriageDecisionAction, messages []SlackInboundMessage, botUserID string) []SlackTriageDecisionAction {
	if len(actions) == 0 {
		return actions
	}
	if slackMessagesMentionOtherUsersWithoutBot(messages, botUserID) {
		return nil
	}
	if slackMessagesAreBareInternalPermalinks(messages) && !explicitlyRequestsSlackPermalinkHandling(joinSlackMessageTexts(messages)) {
		return nil
	}
	if slackMessagesAreBareFetchableExternalLinks(messages) {
		actions = filterSlackTriageReadConfirmationActions(actions)
		if len(actions) == 0 {
			return nil
		}
	}
	if slackTriageDirectRepliesShouldStaySilent(messages, botUserID) {
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

func slackTriageDirectRepliesShouldStaySilent(messages []SlackInboundMessage, botUserID string) bool {
	if slackTriageThreadContinuationShouldStaySilent(messages) {
		return true
	}
	text := latestSlackInboundMessageText(messages)
	if text == "" {
		return false
	}
	if slackTextMentionsUser(text, botUserID) {
		return false
	}
	if explicitlyRequestsSlackPermalinkHandling(text) {
		return false
	}
	if slackMessagesHaveFetchableExternalLinks(messages) {
		return false
	}
	if slackTriageUnaddressedBotDiscussion(text) {
		return true
	}
	if strings.ContainsAny(text, "?？") {
		return false
	}
	for _, keyword := range []string{"什么", "怎么", "咋", "为啥", "为什么", "吗", "么", "啥", "how", "what", "why", "can you", "could you"} {
		if strings.Contains(strings.ToLower(text), keyword) {
			return false
		}
	}
	return true
}

func slackTriageUnaddressedBotDiscussion(text string) bool {
	normalized := strings.ToLower(strings.TrimSpace(text))
	if normalized == "" {
		return false
	}
	for _, explicit := range []string{"oneesama", "onee-sama", "imoutochan", "onibaba", "欧尼", "欧尼桑玛"} {
		if strings.Contains(normalized, explicit) {
			return false
		}
	}
	for _, keyword := range []string{"agent", "bot", "机器人", "小机器人", "助手"} {
		if strings.Contains(normalized, keyword) {
			return true
		}
	}
	return false
}

func slackMessagesMentionOtherUsersWithoutBot(messages []SlackInboundMessage, botUserID string) bool {
	text := latestSlackInboundMessageText(messages)
	if text == "" || !strings.Contains(text, "<@") {
		return false
	}
	mentions := slackMentionedUserIDs(text)
	if len(mentions) == 0 {
		return false
	}
	for _, userID := range mentions {
		if botUserID != "" && userID == botUserID {
			return false
		}
	}
	return true
}

func filterSlackTriageReadConfirmationActions(actions []SlackTriageDecisionAction) []SlackTriageDecisionAction {
	filtered := make([]SlackTriageDecisionAction, 0, len(actions))
	for _, action := range actions {
		if slackTriageReadConfirmationAction(action) {
			continue
		}
		filtered = append(filtered, action)
	}
	return filtered
}

func slackTriageReadConfirmationAction(action SlackTriageDecisionAction) bool {
	if slackTriageDirectReplyAction(action) {
		return false
	}
	joined := strings.ToLower(strings.Join([]string{action.Type, action.Title, action.Message, action.Reason}, "\n"))
	for _, keyword := range []string{
		"是否读取", "要不要", "需不需要", "核实并总结", "读取", "读一下", "总结", "概括",
		"should i read", "whether to read", "read this", "fetch this", "summarize this",
	} {
		if strings.Contains(joined, keyword) {
			return true
		}
	}
	return false
}

func latestSlackInboundMessageText(messages []SlackInboundMessage) string {
	for index := len(messages) - 1; index >= 0; index-- {
		if text := strings.TrimSpace(messages[index].Text); text != "" {
			return text
		}
	}
	return ""
}

func slackMentionedUserIDs(text string) []string {
	matches := slackBotMentionPattern.FindAllString(strings.TrimSpace(text), -1)
	ids := make([]string, 0, len(matches))
	for _, match := range matches {
		id := strings.TrimSuffix(strings.TrimPrefix(match, "<@"), ">")
		if id != "" {
			ids = append(ids, id)
		}
	}
	return ids
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

func slackMessagesHaveFetchableExternalLinks(messages []SlackInboundMessage) bool {
	return len(extractSlackExternalLinkURLs(messages)) > 0
}

func slackMessagesAreBareFetchableExternalLinks(messages []SlackInboundMessage) bool {
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
			if !isFetchableSlackExternalURL(rawURL) {
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
