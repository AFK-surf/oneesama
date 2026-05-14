package slackagent

import "strings"

func markdownToBlocks(markdown string) []map[string]any {
	markdown = strings.TrimSpace(markdown)
	if markdown == "" {
		return nil
	}

	sections := splitMarkdownSections(markdown)
	if len(sections) == 0 {
		return nil
	}

	var blocks []map[string]any
	for _, sec := range sections {
		switch sec.kind {
		case sectionKindHeader:
			blocks = append(blocks, map[string]any{
				"type": "header",
				"text": map[string]any{"type": "plain_text", "text": sec.text},
			})
		case sectionKindDivider:
			blocks = append(blocks, map[string]any{"type": "divider"})
		case sectionKindBody:
			mrkdwn := strings.TrimSpace(markdownToMrkdwn(sec.text))
			if mrkdwn == "" {
				continue
			}
			for _, chunk := range splitMrkdwnChunks(mrkdwn, 3000) {
				blocks = append(blocks, map[string]any{
					"type": "section",
					"text": map[string]any{"type": "mrkdwn", "text": chunk},
				})
			}
		}
	}

	if len(blocks) == 0 {
		mrkdwn := markdownToMrkdwn(markdown)
		if len(mrkdwn) > 3000 {
			mrkdwn = mrkdwn[:3000]
		}
		blocks = append(blocks, map[string]any{
			"type": "section",
			"text": map[string]any{"type": "mrkdwn", "text": mrkdwn},
		})
	}

	return blocks
}

type sectionKind int

const (
	sectionKindBody sectionKind = iota
	sectionKindHeader
	sectionKindDivider
)

type markdownSection struct {
	kind sectionKind
	text string
}

func splitMarkdownSections(text string) []markdownSection {
	lines := strings.Split(text, "\n")
	var sections []markdownSection
	var bodyLines []string

	flushBody := func() {
		body := strings.TrimSpace(strings.Join(bodyLines, "\n"))
		if body != "" {
			sections = append(sections, markdownSection{kind: sectionKindBody, text: body})
		}
		bodyLines = nil
	}

	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if len(trimmed) >= 3 && (allSameChar(trimmed, '-') || allSameChar(trimmed, '*') || allSameChar(trimmed, '_')) {
			flushBody()
			sections = append(sections, markdownSection{kind: sectionKindDivider})
			continue
		}

		hashCount := leadingHeaderHashes(trimmed)
		if hashCount > 0 && hashCount <= 3 && hashCount < len(trimmed) && trimmed[hashCount] == ' ' {
			flushBody()
			headerText := strings.TrimSpace(trimmed[hashCount+1:])
			sections = append(sections, markdownSection{kind: sectionKindHeader, text: headerText})
			continue
		}

		bodyLines = append(bodyLines, line)
	}
	flushBody()

	return sections
}

func allSameChar(s string, ch byte) bool {
	for i := 0; i < len(s); i++ {
		if s[i] != ch && s[i] != ' ' {
			return false
		}
	}
	return true
}

func leadingHeaderHashes(s string) int {
	count := 0
	for count < len(s) && s[count] == '#' {
		count++
	}
	return count
}

func splitMrkdwnChunks(text string, maxLen int) []string {
	if len(text) <= maxLen {
		return []string{text}
	}
	var chunks []string
	for len(text) > 0 {
		if len(text) <= maxLen {
			chunks = append(chunks, text)
			break
		}
		cut := strings.LastIndex(text[:maxLen], "\n")
		if cut <= 0 {
			cut = maxLen
		}
		chunks = append(chunks, text[:cut])
		text = text[cut:]
		if len(text) > 0 && text[0] == '\n' {
			text = text[1:]
		}
	}
	return chunks
}
