package slackagent

import (
	"regexp"
	"strings"
)

var slackMeetURLPattern = regexp.MustCompile(`https://meet\.google\.com/[a-z]{3}-[a-z]{4}-[a-z]{3}(?:[/?#][^\s<>]*)?`)
var slackBotMentionPattern = regexp.MustCompile(`<@[A-Z0-9]+>`)

func eventTextToAvatarCommand(event SlackEventPayload) string {
	return eventTextToAvatarCommandForBot(event, "")
}

func eventTextToAvatarCommandForBot(event SlackEventPayload, botUserID string) string {
	if strings.TrimSpace(botUserID) == "" {
		return eventTextToAvatarCommandForBotIDs(event, nil)
	}
	return eventTextToAvatarCommandForBotIDs(event, []string{botUserID})
}

func eventTextToAvatarCommandForBotIDs(event SlackEventPayload, botUserIDs []string) string {
	text := strings.TrimSpace(stripSlackUserMentions(event.Text, botUserIDs))
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
	return strings.TrimRight(match, ".,;:!?])}>")
}

func stripSlackBotMentions(text string) string {
	return stripSlackUserMention(text, "")
}

func stripSlackUserMention(text string, userID string) string {
	if userID != "" {
		return stripSlackUserMentions(text, []string{userID})
	}
	return stripSlackUserMentions(text, nil)
}

func stripSlackUserMentions(text string, userIDs []string) string {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return ""
	}
	if len(userIDs) > 0 {
		for _, userID := range userIDs {
			userID = strings.TrimSpace(userID)
			if userID == "" {
				continue
			}
			trimmed = strings.ReplaceAll(trimmed, "<@"+userID+">", "")
		}
		return strings.TrimSpace(trimmed)
	}
	return strings.TrimSpace(slackBotMentionPattern.ReplaceAllString(trimmed, ""))
}
