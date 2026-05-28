package slackagent

import (
	"regexp"
	"strings"
)

var slackMeetURLPattern = regexp.MustCompile(`(?:https?://)?meet\.google\.com/[a-z]{3}-[a-z]{4}-[a-z]{3}(?:[/?#][^\s<>|]*)?`)
var slackBotMentionPattern = regexp.MustCompile(`<@[A-Z0-9]+>`)

func eventTextToAvatarCommand(event SlackEventPayload) string {
	return eventTextToAvatarCommandForBot(event, "")
}

func eventTextToAvatarCommandForBot(event SlackEventPayload, botUserID string) string {
	text := strings.TrimSpace(stripSlackUserMention(event.Text, botUserID))
	if text == "" {
		return ""
	}

	first := strings.ToLower(strings.Fields(text)[0])
	switch first {
	case "join", "status", "stop", "help":
		return text
	}

	if meetURL := findSlackMeetURL(text); meetURL != "" {
		return "join " + meetURL
	}

	return "work " + text
}

func findSlackMeetURL(text string) string {
	match := slackMeetURLPattern.FindString(text)
	if match == "" {
		return ""
	}
	match = strings.TrimRight(match, ".,;:!?])}>")
	if strings.HasPrefix(match, "http://") {
		return "https://" + strings.TrimPrefix(match, "http://")
	}
	if strings.HasPrefix(match, "https://") {
		return match
	}
	return "https://" + match
}

func stripSlackBotMentions(text string) string {
	return stripSlackUserMention(text, "")
}

func stripSlackUserMention(text string, userID string) string {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return ""
	}
	if userID != "" {
		return strings.TrimSpace(strings.ReplaceAll(trimmed, "<@"+userID+">", ""))
	}
	return strings.TrimSpace(slackBotMentionPattern.ReplaceAllString(trimmed, ""))
}
