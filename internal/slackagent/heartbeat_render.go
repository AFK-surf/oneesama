package slackagent

import (
	"fmt"
	"strings"
)

type heartbeatSurfaceMessage struct {
	FallbackText string
	LedgerText   string
	Blocks       []map[string]any
}

func buildHeartbeatSurfaceMessage(title string, summary string) heartbeatSurfaceMessage {
	title = firstNonEmpty(strings.TrimSpace(title), "Heartbeat update")
	summary = firstNonEmpty(strings.TrimSpace(summary), "Background work completed.")
	fallback := strings.TrimSpace(fmt.Sprintf(":heartbeat: *%s*\n%s", title, summary))
	blocks := []map[string]any{heartbeatContextBlock(fmt.Sprintf(":heartbeat: *%s*", title))}
	for _, chunk := range splitMrkdwnChunks(summary, 2500) {
		chunk = strings.TrimSpace(chunk)
		if chunk == "" {
			continue
		}
		blocks = append(blocks, heartbeatContextBlock(chunk))
	}
	return heartbeatSurfaceMessage{
		FallbackText: fallback,
		LedgerText:   fallback,
		Blocks:       blocks,
	}
}

func heartbeatContextBlock(text string) map[string]any {
	return map[string]any{
		"type": "context",
		"elements": []map[string]any{
			{"type": "mrkdwn", "text": text},
		},
	}
}

func normalizeSupervisoryHeartbeatNotification(title string, summary string, followup *SlackHeartbeatFollowup) (string, string, bool) {
	title = strings.TrimSpace(title)
	summary = strings.TrimSpace(summary)
	if followup == nil {
		return title, summary, false
	}
	issue := pickString(followup.Metadata, "issue_identifier", "issueIdentifier", "issue")
	if issue == "" {
		return title, summary, false
	}
	lowerSummary := strings.ToLower(summary)
	if followup.Status == "done" && (strings.Contains(lowerSummary, "done signal") || strings.Contains(summary, "明确 done")) {
		return title, summary, true
	}
	if followup.Status == "done" && (strings.Contains(title, "监督已闭环") || strings.Contains(title, "已闭环")) {
		return "已复查 " + issue, summary, false
	}
	return title, summary, false
}
