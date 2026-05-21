package slackagent

import (
	"fmt"
	"strings"
	"time"
)

type channelBrainNoteKind string

const (
	channelBrainSectionLimit = 4
	channelBrainNoteMaxLen   = 180

	channelBrainNoteOpenLoop channelBrainNoteKind = "open_loop"
	channelBrainNoteFact     channelBrainNoteKind = "fact"
)

var channelBrainFactPrefixes = []string{
	"decision:", "decided:", "shared:", "convention:", "policy:", "standard:",
	"决定：", "共享：", "约定：", "规则：",
}

var channelBrainOpenLoopPrefixes = []string{
	"open loop:", "follow-up:", "follow up:", "todo:", "owner:", "next step:",
	"待跟进：", "后续：", "负责人：", "下一步：",
}

var channelBrainOpenLoopKeywords = []string{
	"blocker", "blocked", "follow up", "follow-up", "next step", "owner",
	"waiting on", "launch", "incident", "pending", "needs follow-up",
	"待跟进", "阻塞", "负责人", "下一步",
}

var channelBrainFactKeywords = []string{
	"decision", "decided", "prefer", "preferred", "use ", "convention",
	"policy", "standard", "always", "决定", "约定", "规则", "统一使用",
}

type channelBrainNote struct {
	Kind      channelBrainNoteKind
	ThreadTS  string
	OwnerUser string
	Text      string
	UpdatedAt *time.Time
}

func buildChannelBrainSummary(records []SlackThreadLedgerRecord) string {
	if len(records) == 0 {
		return ""
	}

	var openLoops []string
	var facts []string
	seen := make(map[string]struct{})
	for _, record := range records {
		for _, note := range extractChannelBrainNotes(record) {
			key := string(note.Kind) + "|" + strings.ToLower(note.Text)
			if _, exists := seen[key]; exists {
				continue
			}
			seen[key] = struct{}{}
			switch note.Kind {
			case channelBrainNoteOpenLoop:
				openLoops = append(openLoops, formatChannelBrainOpenLoop(note))
			case channelBrainNoteFact:
				facts = append(facts, "- "+note.Text)
			}
			if len(openLoops) >= channelBrainSectionLimit && len(facts) >= channelBrainSectionLimit {
				break
			}
		}
	}

	if len(openLoops) == 0 && len(facts) == 0 {
		return ""
	}
	var sections []string
	if len(openLoops) > 0 {
		sections = append(sections, "Shared open loops:\n"+strings.Join(openLoops, "\n"))
	}
	if len(facts) > 0 {
		sections = append(sections, "Shared facts and conventions:\n"+strings.Join(facts, "\n"))
	}
	return strings.Join(sections, "\n\n")
}

func extractChannelBrainNotes(record SlackThreadLedgerRecord) []channelBrainNote {
	rawSummary := strings.TrimSpace(record.Summary)
	if rawSummary == "" {
		return nil
	}
	if strings.EqualFold(record.Status, "awaiting_confirmation") || strings.EqualFold(record.LastActionStatus, "pending") {
		return nil
	}
	if channelBrainLooksLikeNoActionRationale(record, rawSummary) {
		return nil
	}
	if notes := extractStructuredChannelBrainNotes(record, rawSummary); len(notes) > 0 {
		return notes
	}

	summary := normalizeChannelBrainSummary(rawSummary)
	kind, ok := classifyFallbackChannelBrainSummary(summary)
	if !ok {
		return nil
	}
	return []channelBrainNote{{
		Kind:      kind,
		ThreadTS:  record.ThreadTS,
		OwnerUser: record.OwnerUserID,
		Text:      truncateSlackContextText(summary, channelBrainNoteMaxLen),
		UpdatedAt: latestThreadLedgerActivityTime(record),
	}}
}

func channelBrainLooksLikeNoActionRationale(record SlackThreadLedgerRecord, summary string) bool {
	actionStatus := strings.ToLower(strings.TrimSpace(record.LastActionStatus))
	if actionStatus != "no_action" && actionStatus != "observed" {
		return false
	}
	return channelBrainTextLooksLikeNoActionRationale(summary)
}

func channelBrainTextLooksLikeNoActionRationale(summary string) bool {
	lower := strings.ToLower(normalizeChannelBrainSummary(summary))
	for _, phrase := range []string{
		"no action",
		"stay_silent",
		"pure link",
		"outside workspace policy",
		"not covered by workspace policy",
		"非 workspace policy",
		"不触发回复",
		"不需要回复",
		"无需回复",
		"暂不回复",
		"纯链接",
		"无评论",
		"无协调需求",
		"无 @",
		"无@",
		"无会议链接",
		"foreground triage pending",
		"pi-first foreground triage pending",
		"不直接下场查 repo",
		"项目 owner 处理",
		"明确授权我查 oneesama",
		"整理成 brief",
		"not directly inspect the repo",
		"project owner",
		"explicitly authorize me",
	} {
		if strings.Contains(lower, phrase) || strings.Contains(summary, phrase) {
			return true
		}
	}
	return false
}

func sanitizeChannelBrainSummary(summary string) string {
	summary = strings.TrimSpace(summary)
	if summary == "" {
		return ""
	}
	lines := strings.Split(summary, "\n")
	filtered := make([]string, 0, len(lines))
	contentLines := 0
	previousBlank := false
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		text := strings.TrimSpace(strings.TrimLeft(trimmed, "-*• \t"))
		if text != "" && channelBrainTextLooksLikeNoActionRationale(text) {
			continue
		}
		if text != "" && !strings.HasSuffix(text, ":") {
			contentLines++
		}
		if trimmed == "" {
			if previousBlank || len(filtered) == 0 {
				continue
			}
			previousBlank = true
			filtered = append(filtered, "")
			continue
		}
		previousBlank = false
		filtered = append(filtered, line)
	}
	if contentLines == 0 {
		return ""
	}
	for len(filtered) > 0 && strings.TrimSpace(filtered[len(filtered)-1]) == "" {
		filtered = filtered[:len(filtered)-1]
	}
	return pruneEmptyChannelBrainSections(filtered)
}

func pruneEmptyChannelBrainSections(lines []string) string {
	var pruned []string
	for index := 0; index < len(lines); index++ {
		line := lines[index]
		trimmed := strings.TrimSpace(line)
		if !strings.HasSuffix(trimmed, ":") {
			pruned = append(pruned, line)
			continue
		}
		hasContent := false
		for next := index + 1; next < len(lines); next++ {
			nextTrimmed := strings.TrimSpace(lines[next])
			if nextTrimmed == "" {
				continue
			}
			if strings.HasSuffix(nextTrimmed, ":") {
				break
			}
			hasContent = true
			break
		}
		if hasContent {
			pruned = append(pruned, line)
		}
	}
	for len(pruned) > 0 && strings.TrimSpace(pruned[0]) == "" {
		pruned = pruned[1:]
	}
	for len(pruned) > 0 && strings.TrimSpace(pruned[len(pruned)-1]) == "" {
		pruned = pruned[:len(pruned)-1]
	}
	compact := make([]string, 0, len(pruned))
	previousBlank := false
	for _, line := range pruned {
		if strings.TrimSpace(line) == "" {
			if previousBlank || len(compact) == 0 {
				continue
			}
			previousBlank = true
			compact = append(compact, "")
			continue
		}
		previousBlank = false
		compact = append(compact, line)
	}
	return strings.TrimSpace(strings.Join(compact, "\n"))
}

func extractStructuredChannelBrainNotes(record SlackThreadLedgerRecord, summary string) []channelBrainNote {
	var notes []channelBrainNote
	for _, rawLine := range strings.Split(summary, "\n") {
		line := strings.TrimSpace(strings.TrimLeft(rawLine, "-*• \t"))
		if line == "" {
			continue
		}
		kind, text, ok := parseStructuredChannelBrainNote(line)
		if !ok {
			continue
		}
		notes = append(notes, channelBrainNote{
			Kind:      kind,
			ThreadTS:  record.ThreadTS,
			OwnerUser: record.OwnerUserID,
			Text:      text,
			UpdatedAt: latestThreadLedgerActivityTime(record),
		})
	}
	return notes
}

func parseStructuredChannelBrainNote(line string) (channelBrainNoteKind, string, bool) {
	lower := strings.ToLower(line)
	for _, prefix := range channelBrainFactPrefixes {
		if strings.HasPrefix(lower, prefix) || strings.HasPrefix(line, prefix) {
			text := strings.TrimSpace(line[len(prefix):])
			if text == "" {
				return "", "", false
			}
			return channelBrainNoteFact, truncateSlackContextText(text, channelBrainNoteMaxLen), true
		}
	}
	for _, prefix := range channelBrainOpenLoopPrefixes {
		if strings.HasPrefix(lower, prefix) || strings.HasPrefix(line, prefix) {
			text := strings.TrimSpace(line[len(prefix):])
			if text == "" {
				return "", "", false
			}
			return channelBrainNoteOpenLoop, truncateSlackContextText(text, channelBrainNoteMaxLen), true
		}
	}
	return "", "", false
}

func classifyFallbackChannelBrainSummary(summary string) (channelBrainNoteKind, bool) {
	lower := strings.ToLower(summary)
	if strings.Contains(summary, "?") || strings.Contains(summary, "？") {
		return "", false
	}
	for _, keyword := range channelBrainOpenLoopKeywords {
		if strings.Contains(lower, keyword) || strings.Contains(summary, keyword) {
			return channelBrainNoteOpenLoop, true
		}
	}
	for _, keyword := range channelBrainFactKeywords {
		if strings.Contains(lower, keyword) || strings.Contains(summary, keyword) {
			return channelBrainNoteFact, true
		}
	}
	return "", false
}

func normalizeChannelBrainSummary(summary string) string {
	return strings.Join(strings.Fields(strings.TrimSpace(summary)), " ")
}

func latestThreadLedgerActivityTime(record SlackThreadLedgerRecord) *time.Time {
	userAt := parseOptionalTime(record.LastUserMessageAt)
	assistantAt := parseOptionalTime(record.LastAssistantMessageAt)
	switch {
	case userAt == nil:
		return assistantAt
	case assistantAt == nil:
		return userAt
	case assistantAt.After(*userAt):
		return assistantAt
	default:
		return userAt
	}
}

func formatChannelBrainOpenLoop(note channelBrainNote) string {
	parts := []string{fmt.Sprintf("[thread %s]", note.ThreadTS)}
	if note.UpdatedAt != nil && !note.UpdatedAt.IsZero() {
		parts = append(parts, "updated="+note.UpdatedAt.UTC().Format("2006-01-02T15:04:05Z"))
	}
	parts = append(parts, note.Text)
	return "- " + strings.Join(parts, " ")
}

func parseOptionalTime(value string) *time.Time {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	if parsed, err := time.Parse(time.RFC3339Nano, value); err == nil {
		return &parsed
	}
	return nil
}
