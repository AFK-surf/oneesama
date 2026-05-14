package slackagent

import (
	"strings"
	"unicode"
)

func canonicalPersonName(raw string, known []string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	rawKey := compactPersonKey(raw)
	rawReverse := compactReverseWordKey(raw)
	for _, name := range known {
		nameKey := compactPersonKey(name)
		if rawKey == nameKey || rawReverse == nameKey || strings.Contains(nameKey, rawKey) {
			return name
		}
		if compactReverseWordKey(name) == rawKey {
			return name
		}
	}
	return titlePersonName(raw)
}

func matchPersonNameForText(text string, known []string) string {
	lower := strings.ToLower(strings.TrimSpace(text))
	for _, name := range known {
		nameLower := strings.ToLower(name)
		if strings.HasPrefix(lower, nameLower) || strings.Contains(lower, nameLower+" ") {
			return name
		}
	}
	return ""
}

func compactPersonKey(value string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(value) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func compactReverseWordKey(value string) string {
	words := strings.FieldsFunc(strings.ToLower(value), func(r rune) bool {
		return !(unicode.IsLetter(r) || unicode.IsDigit(r))
	})
	for i, j := 0, len(words)-1; i < j; i, j = i+1, j-1 {
		words[i], words[j] = words[j], words[i]
	}
	return strings.Join(words, "")
}

func titlePersonName(value string) string {
	words := strings.Fields(value)
	for i, word := range words {
		runes := []rune(strings.ToLower(word))
		if len(runes) > 0 {
			runes[0] = unicode.ToUpper(runes[0])
		}
		words[i] = string(runes)
	}
	return strings.Join(words, " ")
}
