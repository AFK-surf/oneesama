package slackagent

import (
	"regexp"
	"strings"
)

var slackHTMLTagOpenPatterns = map[string]*regexp.Regexp{
	"h1":     regexp.MustCompile(`<h1[^>]*>`),
	"h2":     regexp.MustCompile(`<h2[^>]*>`),
	"h3":     regexp.MustCompile(`<h3[^>]*>`),
	"h4":     regexp.MustCompile(`<h4[^>]*>`),
	"li":     regexp.MustCompile(`<li[^>]*>`),
	"p":      regexp.MustCompile(`<p[^>]*>`),
	"b":      regexp.MustCompile(`<b[^>]*>`),
	"strong": regexp.MustCompile(`<strong[^>]*>`),
	"i":      regexp.MustCompile(`<i[^>]*>`),
	"em":     regexp.MustCompile(`<em[^>]*>`),
	"code":   regexp.MustCompile(`<code[^>]*>`),
}

func htmlToMarkdown(html string) string {
	html = strings.ReplaceAll(html, "\r\n", "\n")
	html = strings.ReplaceAll(html, "\r", "\n")

	html = replaceHTMLTag(html, "h1", "# ", "\n\n")
	html = replaceHTMLTag(html, "h2", "## ", "\n\n")
	html = replaceHTMLTag(html, "h3", "### ", "\n\n")
	html = replaceHTMLTag(html, "h4", "#### ", "\n\n")

	html = strings.ReplaceAll(html, "<br>", "\n")
	html = strings.ReplaceAll(html, "<br/>", "\n")
	html = strings.ReplaceAll(html, "<br />", "\n")
	html = replaceHTMLTag(html, "li", "- ", "\n")
	html = replaceHTMLTag(html, "p", "", "\n\n")

	html = replaceHTMLTag(html, "b", "**", "**")
	html = replaceHTMLTag(html, "strong", "**", "**")
	html = replaceHTMLTag(html, "i", "_", "_")
	html = replaceHTMLTag(html, "em", "_", "_")
	html = replaceHTMLTag(html, "code", "`", "`")

	html = convertHTMLLinksToMarkdown(html)
	html = stripAllHTMLTags(html)

	html = strings.ReplaceAll(html, "&amp;", "&")
	html = strings.ReplaceAll(html, "&lt;", "<")
	html = strings.ReplaceAll(html, "&gt;", ">")
	html = strings.ReplaceAll(html, "&quot;", "\"")
	html = strings.ReplaceAll(html, "&#39;", "'")
	html = strings.ReplaceAll(html, "&nbsp;", " ")

	for strings.Contains(html, "\n\n\n") {
		html = strings.ReplaceAll(html, "\n\n\n", "\n\n")
	}

	return strings.TrimSpace(html)
}

func replaceHTMLTag(html, tag, prefix, suffix string) string {
	openRe, ok := slackHTMLTagOpenPatterns[tag]
	if !ok {
		return html
	}
	html = openRe.ReplaceAllString(html, prefix)
	return strings.ReplaceAll(html, "</"+tag+">", suffix)
}

func convertHTMLLinksToMarkdown(html string) string {
	var out strings.Builder
	for {
		start := strings.Index(html, "<a")
		if start < 0 {
			out.WriteString(html)
			return out.String()
		}

		out.WriteString(html[:start])
		html = html[start:]

		tagEnd := strings.Index(html, ">")
		if tagEnd < 0 {
			out.WriteString(html)
			return out.String()
		}
		openTag := html[:tagEnd+1]
		href := extractAnchorHref(openTag)
		if href == "" {
			out.WriteString(openTag)
			html = html[tagEnd+1:]
			continue
		}

		closeIdx := strings.Index(strings.ToLower(html[tagEnd+1:]), "</a>")
		if closeIdx < 0 {
			out.WriteString(html)
			return out.String()
		}

		linkText := html[tagEnd+1 : tagEnd+1+closeIdx]
		out.WriteString("[")
		out.WriteString(linkText)
		out.WriteString("](")
		out.WriteString(href)
		out.WriteString(")")
		html = html[tagEnd+1+closeIdx+len("</a>"):]
	}
}

func extractAnchorHref(openTag string) string {
	const marker = `href="`
	idx := strings.Index(strings.ToLower(openTag), marker)
	if idx < 0 {
		return ""
	}
	start := idx + len(marker)
	end := strings.Index(openTag[start:], `"`)
	if end < 0 {
		return ""
	}
	return openTag[start : start+end]
}

func stripAllHTMLTags(html string) string {
	var sb strings.Builder
	inTag := false
	for _, r := range html {
		if r == '<' {
			inTag = true
			continue
		}
		if r == '>' {
			inTag = false
			continue
		}
		if !inTag {
			sb.WriteRune(r)
		}
	}
	return sb.String()
}
