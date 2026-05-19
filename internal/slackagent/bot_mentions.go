package slackagent

import "strings"

func slackBotMentionUserIDs(primary string, aliases []string) []string {
	ids := make([]string, 0, 1+len(aliases))
	if trimmed := strings.TrimSpace(primary); trimmed != "" {
		ids = append(ids, trimmed)
	}
	for _, alias := range aliases {
		if trimmed := strings.TrimSpace(alias); trimmed != "" {
			ids = append(ids, trimmed)
		}
	}
	return compactUniqueStrings(ids)
}

func slackTextMentionsAnyUser(text string, userIDs []string) bool {
	for _, userID := range userIDs {
		if slackTextMentionsUser(text, userID) {
			return true
		}
	}
	return false
}
