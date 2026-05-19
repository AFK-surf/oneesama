package slackagent

import (
	"fmt"
	"strings"
)

const appMentionMediaEvidenceFileLimit = 8

func collectAppMentionMediaEvidence(mention *SlackAppMentionContext) (SlackAppMentionToolEvidence, bool) {
	if mention == nil || len(mention.Files) == 0 || !appMentionRequestsMediaInspection(mention) {
		return SlackAppMentionToolEvidence{}, false
	}
	files := dedupeSlackThreadFiles(mention.Files)
	summary := renderAppMentionMediaEvidenceSummary(files)
	if strings.TrimSpace(summary) == "" {
		return SlackAppMentionToolEvidence{}, false
	}
	return SlackAppMentionToolEvidence{
		Tool: "slack_file_context",
		Args: map[string]any{
			"files":          len(files),
			"media_request":  "true",
			"content_status": "metadata_only_for_non_image_files",
		},
		OK:      true,
		Summary: summary,
	}, true
}

func appMentionRequestsMediaInspection(mention *SlackAppMentionContext) bool {
	text := strings.ToLower(strings.TrimSpace(strings.Join([]string{
		stripSlackBotMentions(mention.MentionText),
		stripSlackBotMentions(mention.RawMentionText),
	}, " ")))
	if text == "" {
		return false
	}
	for _, marker := range []string{
		"视频", "素材", "素材库", "文件", "图片", "截图", "看一下", "看看", "整理", "筛一下", "哪些", "可用", "放到", "thread", "canvas",
		"video", "videos", "media", "asset", "assets", "file", "files", "image", "images", "screenshot", "screenshots", "organize", "review",
	} {
		if strings.Contains(text, marker) {
			return true
		}
	}
	return false
}

func renderAppMentionMediaEvidenceSummary(files []SlackThreadFile) string {
	if len(files) == 0 {
		return ""
	}
	imageCount, videoCount, canvasCount, otherCount := 0, 0, 0, 0
	var lines []string
	for index, file := range files {
		if isSlackCanvasFile(file) {
			canvasCount++
		} else if isSlackImageFile(file) {
			imageCount++
		} else if isSlackVideoFile(file) {
			videoCount++
		} else {
			otherCount++
		}
		if index < appMentionMediaEvidenceFileLimit {
			lines = append(lines, fmt.Sprintf("- %s", formatSlackFileLine(file)))
		}
	}
	if len(files) > appMentionMediaEvidenceFileLimit {
		lines = append(lines, fmt.Sprintf("- ... %d more file(s) omitted from evidence summary", len(files)-appMentionMediaEvidenceFileLimit))
	}
	header := fmt.Sprintf("Slack thread includes %d file(s): %d image(s), %d video(s), %d canvas doc(s), %d other file(s).", len(files), imageCount, videoCount, canvasCount, otherCount)
	guidance := "Evidence boundary: file metadata is available here; image file_ids can be fetched with slack.fetchImage when relevant, but video/binary contents are not decoded by this evidence. Do not claim to have watched videos or read binary file contents unless a separate tool result provides that content. For media inventory requests, summarize metadata-backed candidates and state any content-reading blocker."
	return strings.Join(append([]string{header, guidance, "Files:"}, lines...), "\n")
}

func dedupeSlackThreadFiles(files []SlackThreadFile) []SlackThreadFile {
	seen := map[string]struct{}{}
	out := make([]SlackThreadFile, 0, len(files))
	for _, file := range files {
		key := strings.TrimSpace(firstNonEmpty(file.ID, file.Permalink, file.Name))
		if key == "" {
			continue
		}
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, file)
	}
	return out
}

func isSlackVideoFile(file SlackThreadFile) bool {
	filetype := strings.ToLower(strings.TrimSpace(file.Filetype))
	mimetype := strings.ToLower(strings.TrimSpace(file.Mimetype))
	if strings.HasPrefix(mimetype, "video/") {
		return true
	}
	switch filetype {
	case "mp4", "mov", "m4v", "webm", "avi", "mkv":
		return true
	default:
		return false
	}
}
