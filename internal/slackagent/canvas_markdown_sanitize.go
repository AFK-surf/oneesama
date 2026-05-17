package slackagent

import (
	"regexp"
	"strings"
)

// Slack canvas markdown sanitize/fallback policy.
//
// Slack's canvas API accepts a restricted Markdown subset. Arbitrary
// summaries (especially LLM-authored ones) can carry features that trigger
// validation errors — embedded HTML, complex GFM tables, fenced code with
// unsupported info strings, footnotes, raw inline scripts, and so on. When
// the first publish fails with what looks like a content/validation error,
// we retry once with this sanitizer to maximize the chance of getting the
// summary surfaced at all. If both attempts fail we surface the original
// error so operators can investigate.

// canvasValidationErrorTokens flags Slack API errors we treat as eligible
// for a sanitize-and-retry attempt. Other errors (auth, permission,
// rate-limit) bypass the retry because the markdown is not the suspect.
var canvasValidationErrorTokens = []string{
	"invalid_markdown",
	"invalid_canvas",
	"markdown_too_long",
	"unsupported_content",
	"invalid_block",
	"validation_failed",
	"invalid_argument",
	"parse_error",
	"could_not_parse",
}

func canvasErrorIsValidationFailure(err string) bool {
	err = strings.ToLower(strings.TrimSpace(err))
	if err == "" {
		return false
	}
	for _, token := range canvasValidationErrorTokens {
		if strings.Contains(err, token) {
			return true
		}
	}
	return false
}

// sanitizeMarkdownForSlackCanvas removes / replaces markdown features Slack's
// canvas validator commonly rejects. The transformation is intentionally
// conservative: we keep the document readable while trimming the constructs
// most likely to cause a re-publish failure.
func sanitizeMarkdownForSlackCanvas(markdown string) string {
	out := markdown
	out = stripHTMLTagsForCanvas(out)
	out = collapseUnsupportedTables(out)
	out = neutralizeCodeFenceLanguages(out)
	out = stripFootnotes(out)
	out = stripHTMLEntities(out)
	out = collapseExcessiveBlankLines(out)
	return strings.TrimSpace(out)
}

var canvasHTMLTagPattern = regexp.MustCompile(`</?[a-zA-Z][a-zA-Z0-9-]*(?:\s+[^>]*)?>`)

func stripHTMLTagsForCanvas(markdown string) string {
	return canvasHTMLTagPattern.ReplaceAllString(markdown, "")
}

// collapseUnsupportedTables takes a markdown table and flattens it into a
// bulleted list. Slack canvas validators accept simple tables but reject
// many GFM table variants (colspan, alignment markers with non-standard
// padding, oversize headers); a plain list is the safest fallback.
func collapseUnsupportedTables(markdown string) string {
	lines := strings.Split(markdown, "\n")
	out := make([]string, 0, len(lines))
	i := 0
	for i < len(lines) {
		line := lines[i]
		trimmed := strings.TrimSpace(line)
		if isCanvasTableHeaderRow(trimmed) && i+1 < len(lines) && isCanvasTableDividerRow(lines[i+1]) {
			headerCells := splitCanvasTableRow(trimmed)
			block := []string{strings.Join(headerCells, " · ")}
			j := i + 2
			for j < len(lines) {
				rowTrim := strings.TrimSpace(lines[j])
				if !isCanvasTableHeaderRow(rowTrim) {
					break
				}
				cells := splitCanvasTableRow(rowTrim)
				block = append(block, "- "+strings.Join(cells, " · "))
				j++
			}
			out = append(out, block...)
			i = j
			continue
		}
		out = append(out, line)
		i++
	}
	return strings.Join(out, "\n")
}

func isCanvasTableHeaderRow(line string) bool {
	return strings.HasPrefix(line, "|") && strings.HasSuffix(line, "|") && strings.Count(line, "|") >= 2
}

func isCanvasTableDividerRow(line string) bool {
	trimmed := strings.TrimSpace(line)
	if !strings.HasPrefix(trimmed, "|") || !strings.HasSuffix(trimmed, "|") {
		return false
	}
	for _, ch := range trimmed {
		if ch != '|' && ch != '-' && ch != ':' && ch != ' ' {
			return false
		}
	}
	return strings.Contains(trimmed, "-")
}

func splitCanvasTableRow(line string) []string {
	trimmed := strings.TrimPrefix(strings.TrimSuffix(strings.TrimSpace(line), "|"), "|")
	parts := strings.Split(trimmed, "|")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		out = append(out, strings.TrimSpace(part))
	}
	return out
}

// neutralizeCodeFenceLanguages strips info strings (the bit after ```) so
// Slack canvas can render the fenced block in plain mode regardless of
// language hint. ``` and ```language both become just ```.
var canvasCodeFencePattern = regexp.MustCompile("(?m)^```[^\n]*$")

func neutralizeCodeFenceLanguages(markdown string) string {
	return canvasCodeFencePattern.ReplaceAllString(markdown, "```")
}

// stripFootnotes removes GFM footnote references and definitions which the
// canvas validator does not understand.
var (
	canvasFootnoteRefPattern = regexp.MustCompile(`\[\^[^\]]+\]`)
	canvasFootnoteDefPattern = regexp.MustCompile(`(?m)^\[\^[^\]]+\]:.*$`)
)

func stripFootnotes(markdown string) string {
	out := canvasFootnoteDefPattern.ReplaceAllString(markdown, "")
	out = canvasFootnoteRefPattern.ReplaceAllString(out, "")
	return out
}

// stripHTMLEntities replaces a small set of named HTML entities the
// canvas validator occasionally rejects with their literal counterparts.
func stripHTMLEntities(markdown string) string {
	replacer := strings.NewReplacer(
		"&nbsp;", " ",
		"&amp;", "&",
		"&lt;", "<",
		"&gt;", ">",
		"&quot;", `"`,
		"&#39;", "'",
		"&apos;", "'",
	)
	return replacer.Replace(markdown)
}

var canvasMultipleBlankLinePattern = regexp.MustCompile(`\n{3,}`)

func collapseExcessiveBlankLines(markdown string) string {
	return canvasMultipleBlankLinePattern.ReplaceAllString(markdown, "\n\n")
}
