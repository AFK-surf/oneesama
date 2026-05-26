//go:build cueboardparity

package slackagent

import (
	"regexp"
	"strings"
	"unicode"
)

var slackCanvasDocURLPattern = regexp.MustCompile(`https://(?:app\.slack\.com|[^/\s<>|]+\.slack\.com)/docs/[A-Z0-9]+/(F[A-Z0-9]+)`)

func extractCanvasIDsFromSlackTranscript(transcript string) []string {
	seen := make(map[string]struct{})
	var ids []string
	add := func(id string) {
		id = strings.TrimSpace(id)
		if id == "" {
			return
		}
		if _, exists := seen[id]; exists {
			return
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	for _, field := range strings.Fields(transcript) {
		if id, ok := strings.CutPrefix(strings.Trim(field, ".,;:)]}>\"'`"), "canvas_id="); ok {
			add(id)
		}
	}
	for _, match := range slackCanvasDocURLPattern.FindAllStringSubmatch(transcript, -1) {
		if len(match) > 1 {
			add(match[1])
		}
	}
	return ids
}

func collectOutstandingSlackUserRequests(messages []SlackMessage, userID string, currentTS string, botUserID string, resolveName func(string) string) []string {
	userID = strings.TrimSpace(userID)
	if userID == "" || len(messages) == 0 {
		return nil
	}
	lastAssistantIndex := -1
	for index, message := range messages {
		if firstNonEmpty(message.User, message.UserID, message.UserIDCamel) == botUserID {
			lastAssistantIndex = index
		}
	}
	seen := map[string]struct{}{}
	var requests []string
	for _, message := range messages[lastAssistantIndex+1:] {
		if firstNonEmpty(message.User, message.UserID, message.UserIDCamel) != userID {
			continue
		}
		if currentTS != "" && slackMessageTimestamp(message) == currentTS {
			continue
		}
		text := strings.TrimSpace(stripSlackBotMentions(message.Text))
		text = strings.TrimSpace(resolveTextMentions(text, resolveName))
		if !isMeaningfulOutstandingSlackRequest(text) {
			continue
		}
		key := normalizeSlackComparableText(text)
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		requests = append(requests, text)
	}
	if len(requests) > 3 {
		return requests[len(requests)-3:]
	}
	return requests
}

func isMeaningfulOutstandingSlackRequest(text string) bool {
	meaningful := 0
	for _, r := range strings.TrimSpace(text) {
		if unicode.IsLetter(r) || unicode.IsNumber(r) || unicode.In(r, unicode.Han) {
			meaningful++
		}
	}
	return meaningful >= 3
}
