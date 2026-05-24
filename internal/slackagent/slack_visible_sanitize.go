package slackagent

import (
	"regexp"
	"strings"
)

var (
	slackVisibleMsgBreakPattern       = regexp.MustCompile(`(?i)\[\[\s*MSG_?BREAK\s*\]\]|\[\s*MSG_?BREAK\s*\]`)
	slackVisibleReactPattern          = regexp.MustCompile(`(?is)\[\[\s*REACT\s*\]\]\s*(.*?)\s*\[\[\s*/REACT\s*\]\]`)
	slackVisibleWorldBriefPattern     = regexp.MustCompile(`(?is)\[\[\s*WORLD_BRIEF\s*\]\].*?\[\[\s*/WORLD_BRIEF\s*\]\]`)
	slackVisibleKnowledgeBriefPattern = regexp.MustCompile(`(?is)\[\[\s*KNOWLEDGE_BRIEF\s*\]\].*?\[\[\s*/KNOWLEDGE_BRIEF\s*\]\]`)
	slackVisibleKnownMarkerPattern    = regexp.MustCompile(`(?i)\[\[\s*/?(?:REACT|WORLD_BRIEF|KNOWLEDGE_BRIEF)\s*\]\]`)
	slackVisibleBlankRunsPattern      = regexp.MustCompile(`\n{3,}`)
	slackVisibleBareUserMentionRe     = regexp.MustCompile(`(^|[^<[:alnum:]_])@((?:U|W)[A-Z0-9]{6,})\b`)
	slackVisibleBareChannelMentionRe  = regexp.MustCompile(`(^|[^<[:alnum:]_])@((?:C|G)[A-Z0-9]{6,})\b`)
)

func sanitizeSlackVisibleText(text string) string {
	if text == "" || (!strings.Contains(text, "[[") && !strings.Contains(text, "[MSG")) {
		return text
	}
	out := strings.ReplaceAll(text, "\r\n", "\n")
	out = strings.ReplaceAll(out, "\r", "\n")
	out = slackVisibleWorldBriefPattern.ReplaceAllString(out, "")
	out = slackVisibleKnowledgeBriefPattern.ReplaceAllString(out, "")
	out = slackVisibleReactPattern.ReplaceAllStringFunc(out, func(match string) string {
		parts := slackVisibleReactPattern.FindStringSubmatch(match)
		if len(parts) < 2 {
			return ""
		}
		inner := strings.TrimSpace(parts[1])
		if inner == "" {
			return ""
		}
		return inner + " "
	})
	out = slackVisibleMsgBreakPattern.ReplaceAllString(out, "\n\n")
	out = slackVisibleKnownMarkerPattern.ReplaceAllString(out, "")
	out = slackVisibleBlankRunsPattern.ReplaceAllString(out, "\n\n")
	return strings.TrimSpace(out)
}

func sanitizeSlackOutgoingText(text string) string {
	return renderSlackVisibleMentionIDs(sanitizeSlackVisibleText(text))
}

func renderSlackVisibleMentionIDs(text string) string {
	if text == "" || !strings.Contains(text, "@") {
		return text
	}
	out := slackVisibleBareUserMentionRe.ReplaceAllString(text, `${1}<@${2}>`)
	out = slackVisibleBareChannelMentionRe.ReplaceAllString(out, `${1}<#${2}>`)
	return out
}

func sanitizeSlackPostMessageInput(input PostMessageInput) PostMessageInput {
	input.Text = sanitizeSlackOutgoingText(input.Text)
	if len(input.Blocks) > 0 {
		input.Blocks = sanitizeSlackVisibleBlockMaps(input.Blocks)
	}
	return input
}

func sanitizeSlackVisibleBlockMaps(blocks []map[string]any) []map[string]any {
	if len(blocks) == 0 {
		return blocks
	}
	out := make([]map[string]any, 0, len(blocks))
	for _, block := range blocks {
		out = append(out, sanitizeSlackVisibleMap(block))
	}
	return out
}

func sanitizeSlackVisibleAny(value any) any {
	switch typed := value.(type) {
	case string:
		return sanitizeSlackOutgoingText(typed)
	case map[string]any:
		return sanitizeSlackVisibleMap(typed)
	case []map[string]any:
		return sanitizeSlackVisibleBlockMaps(typed)
	case []any:
		out := make([]any, 0, len(typed))
		for _, item := range typed {
			out = append(out, sanitizeSlackVisibleAny(item))
		}
		return out
	default:
		return value
	}
}

func sanitizeSlackVisibleMap(value map[string]any) map[string]any {
	if len(value) == 0 {
		return value
	}
	out := make(map[string]any, len(value))
	for key, item := range value {
		out[key] = sanitizeSlackVisibleAny(item)
	}
	return out
}
