package slackagent

import (
	"regexp"
	"strconv"
	"strings"
)

var slackTriageActionablePattern = regexp.MustCompile(`(?i)\b(todo|follow.?up|fix|bug|blocked|need|needs|should|please|明天|跟进|修|问题|阻塞|需要)\b`)

var slackPendingActionTypes = map[string]struct{}{
	"follow_up":      {},
	"create_task":    {},
	"ask_user":       {},
	"delegate":       {},
	"create_issue":   {},
	"add_comment":    {},
	"create_event":   {},
	"join_meeting":   {},
	"create_channel": {},
	"none":           {},
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
		"Read buffered Slack activity and decide whether the bot should surface an action card.",
		"Do not call Slack/Linear/Notion tools directly here. If a tool is needed, propose a pending action for user confirmation.",
		"",
		"Channel: " + input.ChannelID,
		existingBrain + memoryBlock + previousBlock,
		"Policy rails:",
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
		`      "type": "follow_up | create_task | ask_user | delegate | create_issue | add_comment | create_event | join_meeting | create_channel | none",`,
		`      "title": "short action title",`,
		`      "message": "what the user should confirm or what the agent should do",`,
		`      "channelId": "Slack channel id, optional",`,
		`      "threadTs": "Slack thread ts, optional",`,
		`      "confidence": 0.0,`,
		`      "reason": "why this action is justified",`,
		`      "requiresConfirmation": true`,
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
		if _, ok := slackPendingActionTypes[typ]; !ok {
			typ = "follow_up"
		}
		if typ == "none" {
			continue
		}
		title := truncateSlackContextText(firstNonEmpty(action.Title, "Review Slack activity"), 160)
		message := truncateSlackContextText(firstNonEmpty(action.Message, action.Reason, title), 2000)
		requires := true
		if action.RequiresConfirmation == false {
			requires = false
		}
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
