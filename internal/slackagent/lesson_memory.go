package slackagent

import (
	"fmt"
	"path/filepath"
	"strings"
)

type lessonCandidate struct {
	Slug         string
	Scope        string
	Title        string
	SourceRef    string
	WhatHappened string
	Impact       string
	Guardrail    string
}

func recordLessonCandidate(workspaceDir string, lesson lessonCandidate) error {
	slug := normalizeMemoryTag(firstNonEmpty(lesson.Slug, lesson.Title))
	if slug == "" {
		return nil
	}
	var sb strings.Builder
	_, _ = fmt.Fprintf(&sb, "# Lesson Candidate: %s\n\n", firstNonEmpty(lesson.Title, slug))
	if lesson.Scope != "" {
		sb.WriteString("- Scope: " + lesson.Scope + "\n")
	}
	if lesson.SourceRef != "" {
		sb.WriteString("- Source ref: " + lesson.SourceRef + "\n")
	}
	if lesson.WhatHappened != "" {
		sb.WriteString("\n## What Happened\n\n")
		sb.WriteString(strings.TrimSpace(lesson.WhatHappened) + "\n")
	}
	if lesson.Impact != "" {
		sb.WriteString("\n## Impact\n\n")
		sb.WriteString(strings.TrimSpace(lesson.Impact) + "\n")
	}
	if lesson.Guardrail != "" {
		sb.WriteString("\n## Proposed Guardrail\n\n")
		sb.WriteString(strings.TrimSpace(lesson.Guardrail) + "\n")
	}
	return writeWorkspaceMemoryFile(workspaceDir, filepath.ToSlash(filepath.Join("memory", "lessons", "candidates", slug+".md")), sb.String())
}
