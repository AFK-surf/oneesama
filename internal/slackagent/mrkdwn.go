package slackagent

import (
	"fmt"
	"regexp"
	"strings"
)

var (
	// ***bold+italic***
	mdBoldItalicRe = regexp.MustCompile(`\*\*\*(.+?)\*\*\*`)

	// **bold**
	mdBoldRe = regexp.MustCompile(`\*\*(.+?)\*\*`)

	// *italic* (single asterisk only, after bold/bold-italic have been placeholdered)
	mdItalicRe = regexp.MustCompile(`\*([^*\n]+?)\*`)

	// [text](url) → <url|text>
	mdLinkRe = regexp.MustCompile(`\[([^\]]+)\]\(([^)]+)\)`)

	// ## Header → *Header*
	mdHeaderRe = regexp.MustCompile(`(?m)^#{1,6}\s+(.+)$`)

	// ~~text~~ → ~text~
	mdStrikeRe = regexp.MustCompile(`~~(.+?)~~`)

	// Unordered list item: - item or * item (at line start, with optional leading spaces)
	mdUnorderedListRe = regexp.MustCompile(`(?m)^(\s*)[-*]\s+`)

	// Ordered list item: 1. item, 2. item ...
	mdOrderedListRe = regexp.MustCompile(`(?m)^(\s*)\d+\.\s+`)

	// Table row: | col1 | col2 | col3 |
	mdTableRowRe = regexp.MustCompile(`(?m)^\|(.+)\|$`)

	// Table separator: | --- | --- | or |:---|:---|
	mdTableSepRe = regexp.MustCompile(`(?m)^\|[\s:]*-{2,}[\s:]*(\|[\s:]*-{2,}[\s:]*)*\|$`)

	// Linear issue identifier: CUE-123, PROJ-4567
	// Only matches when not already inside a Slack link (<...>).
	linearIssueRe = regexp.MustCompile(`\b([A-Z]{2,10}-\d+)\b`)

	// Inline-code-wrapped issue ID: `CUE-123` → CUE-123
	inlineCodeIssueRe = regexp.MustCompile("`([A-Z]{2,10}-\\d+)`")

	// URL-ish text that Slack may auto-link even inside inline code spans.
	inlineCodeAutolinkRe = regexp.MustCompile(`(?i)(https?://|www\.|(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[:/]|$))`)
)

var linearWorkspaceSlug string
var linearIssuePrefixes = map[string]struct{}{}

func SetLinearWorkspaceSlug(slug string) {
	linearWorkspaceSlug = slug
	if normalized := strings.ToUpper(strings.TrimSpace(slug)); normalized != "" {
		SetLinearIssuePrefixes(normalized)
	}
}

func SetLinearIssuePrefixes(prefixes ...string) {
	linearIssuePrefixes = make(map[string]struct{}, len(prefixes))
	for _, prefix := range prefixes {
		normalized := strings.ToUpper(strings.TrimSpace(prefix))
		if normalized == "" {
			continue
		}
		linearIssuePrefixes[normalized] = struct{}{}
	}
}

const (
	phBIOpen  = "\x00BI\x01" // bold-italic open  → *_
	phBIClose = "\x00BI\x02" // bold-italic close  → _*
	phBOpen   = "\x00B\x01"  // bold open          → *
	phBClose  = "\x00B\x02"  // bold close          → *
)

// markdownToMrkdwn converts common Markdown patterns to Slack mrkdwn.
// Code blocks and inline code are preserved as-is.
func markdownToMrkdwn(text string) string {
	if linearWorkspaceSlug != "" {
		text = inlineCodeIssueRe.ReplaceAllString(text, "$1")
	}

	segments := splitCodeSegments(text)

	var sb strings.Builder
	for _, seg := range segments {
		if seg.isCode {
			sb.WriteString(sanitizeSlackCodeSegment(seg.text))
		} else {
			sb.WriteString(transformText(seg.text))
		}
	}
	return sb.String()
}

// markdownToSlackFallbackText converts Markdown source into the mrkdwn/plain-text
// fallback Slack uses for notifications and compact previews when blocks are present.
func markdownToSlackFallbackText(text string) string {
	fallback := strings.TrimSpace(markdownToMrkdwn(text))
	if fallback == "" {
		return text
	}
	return fallback
}

// markdownishToMrkdwn normalizes ad hoc Slack message text that may already
// contain mrkdwn. It converts Markdown-only constructs without rewriting
// existing Slack emphasis like *bold* into italic.
func markdownishToMrkdwn(text string) string {
	if linearWorkspaceSlug != "" {
		text = inlineCodeIssueRe.ReplaceAllString(text, "$1")
	}

	segments := splitCodeSegments(text)

	var sb strings.Builder
	for _, seg := range segments {
		if seg.isCode {
			sb.WriteString(sanitizeSlackCodeSegment(seg.text))
		} else {
			sb.WriteString(transformTextPreservingMrkdwn(seg.text))
		}
	}
	return sb.String()
}

func sanitizeSlackCodeSegment(text string) string {
	if strings.HasPrefix(text, "```") {
		return text
	}
	if len(text) < 2 || text[0] != '`' || text[len(text)-1] != '`' {
		return text
	}

	inner := text[1 : len(text)-1]
	if !inlineCodeAutolinkRe.MatchString(inner) {
		return text
	}

	inner = breakSlackAutolink(inner)
	return "`" + inner + "`"
}

func breakSlackAutolink(text string) string {
	if strings.Contains(text, "://") {
		return strings.Replace(text, "://", "://\u200B", 1)
	}
	if idx := strings.Index(text, "/"); idx >= 0 {
		return text[:idx+1] + "\u200B" + text[idx+1:]
	}
	if idx := strings.Index(text, "."); idx >= 0 {
		return text[:idx+1] + "\u200B" + text[idx+1:]
	}
	return text
}

type segment struct {
	text   string
	isCode bool
}

func splitCodeSegments(text string) []segment {
	var segments []segment
	i := 0
	for i < len(text) {
		if i+2 < len(text) && text[i:i+3] == "```" {
			end := strings.Index(text[i+3:], "```")
			if end >= 0 {
				segments = append(segments, segment{text: text[i : i+3+end+3], isCode: true})
				i = i + 3 + end + 3
				continue
			}
			segments = append(segments, segment{text: text[i:], isCode: true})
			return segments
		}
		if text[i] == '`' {
			end := strings.IndexByte(text[i+1:], '`')
			if end >= 0 {
				segments = append(segments, segment{text: text[i : i+1+end+1], isCode: true})
				i = i + 1 + end + 1
				continue
			}
		}
		next := len(text)
		for j := i + 1; j < len(text); j++ {
			if text[j] == '`' {
				next = j
				break
			}
		}
		segments = append(segments, segment{text: text[i:next], isCode: false})
		i = next
	}
	return segments
}

func transformText(text string) string {
	text = convertEmphasis(text)
	text = convertCommonMarkdown(text)
	return text
}

func transformTextPreservingMrkdwn(text string) string {
	text = convertStrongEmphasis(text)
	text = convertCommonMarkdown(text)
	return text
}

func convertCommonMarkdown(text string) string {
	text = convertMarkdownTable(text)
	text = mdLinkRe.ReplaceAllString(text, "<$2|$1>")
	text = mdHeaderRe.ReplaceAllString(text, "*$1*")
	text = mdStrikeRe.ReplaceAllString(text, "~$1~")
	text = mdUnorderedListRe.ReplaceAllString(text, "${1}• ")
	text = mdOrderedListRe.ReplaceAllString(text, "${1}• ")
	text = strings.ReplaceAll(text, "\n---\n", "\n———\n")
	text = strings.ReplaceAll(text, "\n***\n", "\n———\n")
	text = strings.ReplaceAll(text, "\n___\n", "\n———\n")

	if linearWorkspaceSlug != "" {
		text = linkifyLinearIssues(text)
	}

	return text
}

// linkifyLinearIssues replaces bare issue identifiers like CUE-123 with Slack links,
// skipping identifiers already inside a Slack link (<...>).
func linkifyLinearIssues(text string) string {
	var result strings.Builder
	i := 0
	for i < len(text) {
		if text[i] == '<' {
			end := strings.IndexByte(text[i:], '>')
			if end >= 0 {
				result.WriteString(text[i : i+end+1])
				i += end + 1
				continue
			}
		}
		next := strings.IndexByte(text[i:], '<')
		segment := text[i:]
		if next >= 0 {
			segment = text[i : i+next]
		}
		result.WriteString(linearIssueRe.ReplaceAllStringFunc(segment, func(match string) string {
			prefix, _, ok := strings.Cut(match, "-")
			if !ok {
				return match
			}
			if _, allowed := linearIssuePrefixes[strings.ToUpper(prefix)]; !allowed {
				return match
			}
			return fmt.Sprintf("<https://linear.app/%s/issue/%s|%s>", linearWorkspaceSlug, match, match)
		}))
		if next >= 0 {
			i += next
		} else {
			break
		}
	}
	return result.String()
}

// convertEmphasis handles ***bold-italic***, **bold**, and *italic* via placeholder passes.
func convertEmphasis(text string) string {
	text = mdBoldItalicRe.ReplaceAllString(text, phBIOpen+"$1"+phBIClose)
	text = mdBoldRe.ReplaceAllString(text, phBOpen+"$1"+phBClose)
	text = mdItalicRe.ReplaceAllString(text, "_${1}_")

	text = strings.ReplaceAll(text, phBIOpen, "*_")
	text = strings.ReplaceAll(text, phBIClose, "_*")
	text = strings.ReplaceAll(text, phBOpen, "*")
	text = strings.ReplaceAll(text, phBClose, "*")

	return text
}

func convertStrongEmphasis(text string) string {
	text = mdBoldItalicRe.ReplaceAllString(text, "*_$1_*")
	text = mdBoldRe.ReplaceAllString(text, "*$1*")
	return text
}

// convertMarkdownTable converts Markdown tables to bulleted lists for Slack rendering.
func convertMarkdownTable(text string) string {
	lines := strings.Split(text, "\n")
	var result []string
	i := 0
	for i < len(lines) {
		// Detect table: current line is a row, next line is separator.
		if i+1 < len(lines) && mdTableRowRe.MatchString(lines[i]) && mdTableSepRe.MatchString(lines[i+1]) {
			headers := parseTableRow(lines[i])
			i += 2 // skip header + separator

			// Process data rows.
			for i < len(lines) && mdTableRowRe.MatchString(lines[i]) {
				cols := parseTableRow(lines[i])
				var parts []string
				for j, col := range cols {
					col = strings.TrimSpace(col)
					if col == "" {
						continue
					}
					if j < len(headers) {
						h := strings.TrimSpace(headers[j])
						if h != "" {
							parts = append(parts, fmt.Sprintf("*%s*: %s", h, col))
							continue
						}
					}
					parts = append(parts, col)
				}
				if len(parts) > 0 {
					result = append(result, "• "+strings.Join(parts, "  ·  "))
				}
				i++
			}
			continue
		}
		result = append(result, lines[i])
		i++
	}
	return strings.Join(result, "\n")
}

// parseTableRow splits "| a | b | c |" into ["a", "b", "c"].
func parseTableRow(line string) []string {
	line = strings.TrimSpace(line)
	line = strings.Trim(line, "|")
	parts := strings.Split(line, "|")
	for i := range parts {
		parts[i] = strings.TrimSpace(parts[i])
	}
	return parts
}
