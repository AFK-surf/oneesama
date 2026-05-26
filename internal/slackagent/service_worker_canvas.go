package slackagent

import (
	"strings"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
)

func slackWorkerTurnUserContent(job agentrunner.Job) string {
	texts := slackAppMentionRequestTexts(job.Context)
	for _, text := range texts {
		if trimmed := strings.TrimSpace(text); trimmed != "" {
			return trimmed
		}
	}
	return strings.TrimSpace(job.Task)
}

func shouldPublishWorkerResultAsCanvas(job agentrunner.Job, text string) bool {
	if job.Status != agentrunner.StatusCompleted {
		return false
	}
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return false
	}
	if len([]rune(trimmed)) > 1800 {
		return true
	}
	if slackWorkerJobRequestsCanvas(job) && (len([]rune(trimmed)) > 20 || looksLikeLongFormMarkdown(trimmed)) {
		return true
	}
	if len(slackAppMentionCanvasFiles(job.Context)) > 0 && (len([]rune(trimmed)) > 700 || looksLikeLongFormMarkdown(trimmed)) {
		return true
	}
	return false
}

func looksLikeLongFormMarkdown(text string) bool {
	normalized := strings.TrimSpace(text)
	return strings.HasPrefix(normalized, "# ") ||
		strings.Contains(normalized, "\n# ") ||
		strings.Contains(normalized, "\n## ") ||
		strings.Count(normalized, "\n\n") >= 4
}

func workerResultCanvasInput(job agentrunner.Job, ref AssistantThreadRef, text string, dedupKey string) CanvasPublishInput {
	files := slackAppMentionCanvasFiles(job.Context)
	revision := len(files) > 0
	title := workerResultCanvasTitle(text, files)
	input := CanvasPublishInput{
		ArtifactID:       "slack-worker-" + firstNonEmpty(job.ID, "result"),
		Title:            title,
		SummaryMarkdown:  text,
		Channel:          ref.ChannelID,
		ThreadTS:         ref.ThreadTS,
		DedupKey:         "slack-worker-canvas:" + dedupKey,
		WorkspaceID:      "workspace",
		SnapshotTS:       slackWorkerFreshnessSnapshotTS(job, ref),
		NotificationText: workerResultCanvasNotification(title, revision),
		ForceSlackCanvas: true,
	}
	if revision {
		input.CanvasID = strings.TrimSpace(files[0].ID)
		input.Operation = "insert_at_end"
	}
	return input
}

func workerResultCanvasTitle(text string, files []SlackThreadFile) string {
	for _, file := range files {
		if title := firstNonEmpty(file.Title, file.Name, file.ID); title != "" {
			return title
		}
	}
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "#") {
			title := strings.TrimSpace(strings.TrimLeft(line, "#"))
			if title != "" {
				return title
			}
		}
	}
	return "Slack thread notes"
}

func workerResultCanvasNotification(title string, revision bool) string {
	title = strings.TrimSpace(title)
	if title == "" {
		title = "文档"
	}
	if revision {
		return "新版 " + title + " 已更新：{{canvas_link}}"
	}
	return title + " 已写成 Canvas：{{canvas_link}}"
}

func slackWorkerJobRequestsCanvas(job agentrunner.Job) bool {
	var texts []string
	if task := strings.TrimSpace(job.Task); task != "" {
		texts = append(texts, task)
	}
	texts = append(texts, slackAppMentionRequestTexts(job.Context)...)
	for _, text := range texts {
		if slackTextRequestsCanvasOutput(text) {
			return true
		}
	}
	return false
}

func slackTextRequestsCanvasOutput(text string) bool {
	normalized := strings.ToLower(strings.TrimSpace(text))
	if normalized == "" {
		return false
	}
	for _, marker := range []string{
		"write canvas",
		"write a canvas",
		"write to canvas",
		"write into canvas",
		"put in canvas",
		"put into canvas",
		"publish canvas",
		"create canvas",
		"make a canvas",
		"update canvas",
		"edit canvas",
		"canvas 里",
		"canvas里",
		"canvas 中",
		"canvas中",
		"写 canvas",
		"写进 canvas",
		"写到 canvas",
		"放到 canvas",
		"放进 canvas",
		"生成 canvas",
		"创建 canvas",
		"更新 canvas",
		"编辑 canvas",
		"写画布",
		"写进画布",
		"写到画布",
		"放到画布",
		"放进画布",
		"生成画布",
		"创建画布",
		"更新画布",
		"编辑画布",
	} {
		if strings.Contains(normalized, marker) {
			return true
		}
	}
	return false
}

func slackAppMentionRequestTexts(context map[string]any) []string {
	if len(context) == 0 {
		return nil
	}
	switch typed := context["slackAppMention"].(type) {
	case *SlackAppMentionContext:
		if typed == nil {
			return nil
		}
		return []string{typed.MentionText, typed.RawMentionText}
	case SlackAppMentionContext:
		return []string{typed.MentionText, typed.RawMentionText}
	case map[string]any:
		return []string{stringFromAny(typed["mentionText"]), stringFromAny(typed["rawMentionText"])}
	case map[string]string:
		return []string{typed["mentionText"], typed["rawMentionText"]}
	}
	return nil
}

func slackAppMentionCanvasFiles(context map[string]any) []SlackThreadFile {
	if len(context) == 0 {
		return nil
	}
	switch typed := context["slackAppMention"].(type) {
	case *SlackAppMentionContext:
		return append([]SlackThreadFile(nil), typed.CanvasFiles...)
	case SlackAppMentionContext:
		return append([]SlackThreadFile(nil), typed.CanvasFiles...)
	case map[string]any:
		return slackThreadFilesFromAny(typed["canvasFiles"])
	case map[string]string:
		if id := strings.TrimSpace(typed["canvasFileID"]); id != "" {
			return []SlackThreadFile{{ID: id, Title: typed["canvasFileTitle"]}}
		}
	}
	return nil
}

func slackThreadFilesFromAny(value any) []SlackThreadFile {
	switch typed := value.(type) {
	case []SlackThreadFile:
		return append([]SlackThreadFile(nil), typed...)
	case []any:
		files := make([]SlackThreadFile, 0, len(typed))
		for _, item := range typed {
			switch file := item.(type) {
			case SlackThreadFile:
				files = append(files, file)
			case map[string]any:
				files = append(files, SlackThreadFile{
					ID:        stringFromAny(file["id"]),
					Name:      stringFromAny(file["name"]),
					Title:     stringFromAny(file["title"]),
					Filetype:  stringFromAny(file["filetype"]),
					Mimetype:  stringFromAny(file["mimetype"]),
					Permalink: stringFromAny(file["permalink"]),
				})
			}
		}
		return files
	default:
		return nil
	}
}
