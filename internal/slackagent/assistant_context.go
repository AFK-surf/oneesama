package slackagent

import (
	"context"
	"fmt"
	"strings"
)

func formatSlackDurableContext(ledger *SlackThreadLedgerRecord, brain *SlackChannelBrain, resolveName func(string) string) string {
	var sections []string
	if ledger != nil {
		var lines []string
		lines = append(lines, "Thread ledger:")
		if ledger.Status != "" {
			lines = append(lines, "- thread status: "+ledger.Status)
		}
		if ledger.OwnerUserID != "" {
			lines = append(lines, "- owner: "+resolveSlackContextName(resolveName, ledger.OwnerUserID))
		}
		if ledger.LastUserID != "" {
			lines = append(lines, "- last requester: "+resolveSlackContextName(resolveName, ledger.LastUserID))
		}
		if ledger.LastActionType != "" && slackLedgerActionPending(ledger.LastActionStatus) {
			lines = append(lines, fmt.Sprintf("- last requested action: %s (%s)", ledger.LastActionType, firstNonEmpty(ledger.LastActionStatus, "pending")))
		}
		if summary := strings.TrimSpace(ledger.Summary); summary != "" {
			lines = append(lines, "- recent handled task: "+summary)
		} else if ledger.LastActionType != "" && ledger.LastActionStatus != "" && !slackLedgerActionPending(ledger.LastActionStatus) {
			lines = append(lines, fmt.Sprintf("- recent handled task: %s (%s)", ledger.LastActionType, ledger.LastActionStatus))
		}
		sections = append(sections, strings.Join(lines, "\n"))
	}
	if brain != nil && strings.TrimSpace(brain.Summary) != "" {
		var lines []string
		lines = append(lines, "Channel brain:")
		if brain.SummaryVersion > 0 {
			lines = append(lines, fmt.Sprintf("- version: %d", brain.SummaryVersion))
		}
		lines = append(lines, strings.TrimSpace(brain.Summary))
		sections = append(sections, strings.Join(lines, "\n"))
	}
	return strings.TrimSpace(strings.Join(sections, "\n\n"))
}

func buildSlackAssistantMessage(
	channelID string,
	threadTS string,
	permalink string,
	userID string,
	userText string,
	outstandingRequests []string,
	transcript string,
	meetingContext string,
	botUserID string,
	parent SlackAssistantThreadParentInfo,
	ledger *SlackThreadLedgerRecord,
	brain *SlackChannelBrain,
	resolveName func(string) string,
) string {
	var lines []string
	lines = append(lines, "Thread metadata:")
	lines = append(lines, "- channel: "+firstNonEmpty(channelID, "unknown"))
	lines = append(lines, "- thread_ts: "+firstNonEmpty(threadTS, "unknown"))
	if permalink != "" {
		lines = append(lines, "- thread_permalink: "+permalink)
	}
	parentAuthor := firstNonEmpty(parent.UserName, resolveSlackContextName(resolveName, firstNonEmpty(parent.UserID, parent.User, parent.BotID)), "unknown")
	startedBy := "- thread started by: " + parentAuthor
	if parent.IsBotParent || parent.BotID != "" || (botUserID != "" && firstNonEmpty(parent.UserID, parent.User) == botUserID) {
		startedBy += " (assistant or app message)"
	}
	lines = append(lines, startedBy)

	durable := formatSlackDurableContext(ledger, brain, resolveName)
	if durable != "" {
		filtered := suppressDuplicateLedgerSummary(durable, transcript)
		if filtered != "" {
			lines = append(lines, "", "Durable context:", filtered)
		}
	}
	if len(outstandingRequests) > 0 {
		lines = append(lines, "", fmt.Sprintf("Outstanding user requests from <@%s> earlier in this thread", firstNonEmpty(userID, "unknown")))
		for _, request := range outstandingRequests {
			if trimmed := strings.TrimSpace(request); trimmed != "" {
				lines = append(lines, "- "+trimmed)
			}
		}
	}
	if strings.TrimSpace(transcript) != "" {
		lines = append(lines, "", "Thread context:", "", strings.TrimSpace(transcript))
	}
	if strings.TrimSpace(meetingContext) != "" {
		lines = append(lines, "", "---", "Live meeting status:", strings.TrimSpace(meetingContext))
	}
	lines = append(lines, "", "---", fmt.Sprintf("User <@%s> says:", firstNonEmpty(userID, "unknown")), strings.TrimSpace(userText))
	return strings.TrimSpace(strings.Join(lines, "\n"))
}

func (s *slackCognitionStore) BuildAssistantMessageForThread(
	ctx context.Context,
	workspaceID string,
	channelID string,
	threadTS string,
	userID string,
	userText string,
	outstandingRequests []string,
	transcript string,
	meetingContext string,
	parent SlackAssistantThreadParentInfo,
	resolveName func(string) string,
) string {
	ledger, _ := s.GetThreadLedger(ctx, workspaceID, channelID, threadTS)
	brain, _ := s.GetChannelBrain(ctx, workspaceID, channelID)
	return buildSlackAssistantMessage(channelID, threadTS, "", userID, userText, outstandingRequests, transcript, meetingContext, "", parent, ledger, brain, resolveName)
}

func (s *slackCognitionStore) GetThreadLedger(ctx context.Context, workspaceID string, channelID string, threadTS string) (*SlackThreadLedgerRecord, error) {
	if s == nil || s.ledgers == nil || workspaceID == "" || channelID == "" || threadTS == "" {
		return nil, nil
	}
	record, ok, err := s.ledgers.Get(ctx, threadLedgerID(workspaceID, channelID, threadTS))
	if err != nil || !ok {
		return nil, err
	}
	return &record, nil
}

func resolveSlackContextName(resolveName func(string) string, userID string) string {
	if strings.TrimSpace(userID) == "" {
		return ""
	}
	if resolveName != nil {
		if resolved := strings.TrimSpace(resolveName(userID)); resolved != "" {
			return resolved
		}
	}
	return userID
}

func slackLedgerActionPending(status string) bool {
	return strings.EqualFold(status, "pending") || strings.EqualFold(status, "awaiting_confirmation")
}

func suppressDuplicateLedgerSummary(durableContext string, transcript string) string {
	if strings.TrimSpace(transcript) == "" {
		return durableContext
	}
	var filtered []string
	for _, line := range strings.Split(durableContext, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "- recent handled task:") {
			summary := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), "- recent handled task:"))
			if normalizedTextContains(transcript, summary) {
				continue
			}
		}
		filtered = append(filtered, line)
	}
	return strings.TrimSpace(strings.Join(filtered, "\n"))
}

func normalizedTextContains(haystack string, needle string) bool {
	haystack = normalizeAssistantContextText(haystack)
	needle = normalizeAssistantContextText(needle)
	return needle != "" && strings.Contains(haystack, needle)
}

func normalizeAssistantContextText(value string) string {
	replacer := strings.NewReplacer("*", "", "_", "", "`", "", "[", "", "]", "", "(", "", ")", "")
	value = strings.ToLower(replacer.Replace(value))
	return strings.Join(strings.Fields(value), " ")
}
