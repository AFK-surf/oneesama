package slackagent

import (
	"regexp"
	"strings"
)

var slackMeetURLPattern = regexp.MustCompile(`https://meet\.google\.com/[a-z]{3}-[a-z]{4}-[a-z]{3}(?:[/?#][^\s<>]*)?`)
var slackBotMentionPattern = regexp.MustCompile(`<@[A-Z0-9]+>`)

func eventTextToAvatarCommand(event SlackEventPayload) string {
	text := strings.TrimSpace(stripSlackBotMentions(event.Text))
	if text == "" {
		return ""
	}

	first := strings.ToLower(strings.Fields(text)[0])
	switch first {
	case "join", "status", "stop", "delegate", "jobs", "help":
		return text
	}

	if meetURL := findSlackMeetURL(text); meetURL != "" {
		return "join " + meetURL
	}

	return "delegate " + text
}

func findSlackMeetURL(text string) string {
	match := slackMeetURLPattern.FindString(text)
	if match == "" {
		return ""
	}
	return strings.TrimRight(match, ".,;:!?])}>")
}

func stripSlackBotMentions(text string) string {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return ""
	}
	return strings.TrimSpace(slackBotMentionPattern.ReplaceAllString(trimmed, ""))
}
