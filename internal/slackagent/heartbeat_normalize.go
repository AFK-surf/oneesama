package slackagent

import (
	"fmt"
	"strings"
)

func normalizeHeartbeatFollowup(record SlackHeartbeatFollowup) SlackHeartbeatFollowup {
	now := nowRFC3339()
	record.Kind = firstNonEmpty(record.Kind, "reminder")
	record.Title = strings.TrimSpace(record.Title)
	record.Summary = strings.TrimSpace(record.Summary)
	record.ChannelID = strings.TrimSpace(record.ChannelID)
	record.ThreadTS = strings.TrimSpace(record.ThreadTS)
	record.SourceKind = normalizeHeartbeatSourceKind(record.SourceKind, record.ChannelID, record.ThreadTS)
	record.SourceRef = canonicalHeartbeatFollowupSourceRef(record)
	record.Status = firstNonEmpty(record.Status, "open")
	record.Priority = firstNonEmpty(record.Priority, "normal")
	record.CreatedAt = firstNonEmpty(record.CreatedAt, now)
	record.UpdatedAt = now
	if record.Metadata == nil {
		record.Metadata = map[string]any{}
	}
	return record
}

func normalizeHeartbeatSurfaceRecord(record SlackHeartbeatSurface) SlackHeartbeatSurface {
	record.Title = strings.TrimSpace(record.Title)
	record.Summary = strings.TrimSpace(record.Summary)
	record.RequestedSurface = firstNonEmpty(record.RequestedSurface, "slack_thread")
	record.ChannelID = strings.TrimSpace(record.ChannelID)
	record.ThreadTS = strings.TrimSpace(record.ThreadTS)
	record.Status = firstNonEmpty(record.Status, "sent")
	if record.DeliveredSurface == "" && record.Status == "sent" {
		record.DeliveredSurface = "slack_thread"
	}
	record.CreatedAt = firstNonEmpty(record.CreatedAt, nowRFC3339())
	return record
}

func normalizeThreadRecommendation(record SlackThreadRecommendation) SlackThreadRecommendation {
	now := nowRFC3339()
	record.RecommendationType = strings.TrimSpace(record.RecommendationType)
	record.Status = firstNonEmpty(record.Status, "active")
	record.CreatedAt = firstNonEmpty(record.CreatedAt, now)
	record.UpdatedAt = now
	return record
}

func normalizeOutboundAction(record SlackOutboundAction) SlackOutboundAction {
	now := nowRFC3339()
	record.ActionType = strings.TrimSpace(record.ActionType)
	record.Target = strings.TrimSpace(record.Target)
	record.Reference = strings.TrimSpace(record.Reference)
	record.Status = firstNonEmpty(record.Status, "sent")
	record.CreatedAt = firstNonEmpty(record.CreatedAt, now)
	record.UpdatedAt = now
	return record
}

func canonicalHeartbeatFollowupSourceRef(record SlackHeartbeatFollowup) string {
	ref := strings.TrimSpace(record.SourceRef)
	if strings.EqualFold(record.Kind, "commitment") &&
		strings.EqualFold(record.SourceKind, "thread") &&
		record.ChannelID != "" &&
		record.ThreadTS != "" &&
		!heartbeatSourceRefIsDistinctCommitment(ref) {
		return fmt.Sprintf("thread_commitment:%s:%s", record.ChannelID, record.ThreadTS)
	}
	if ref == "" && record.ChannelID != "" && record.ThreadTS != "" {
		return fmt.Sprintf("%s:%s", record.ChannelID, record.ThreadTS)
	}
	return ref
}

func heartbeatSourceRefIsDistinctCommitment(ref string) bool {
	if ref == "" {
		return false
	}
	for _, prefix := range []string{"meeting:", "pending_action:", "action_confirmed:", "improvement_cluster:"} {
		if strings.HasPrefix(ref, prefix) {
			return true
		}
	}
	return strings.HasPrefix(ref, "thread_commitment:")
}
