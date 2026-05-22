package slackagent

import (
	"context"
	"fmt"
	"strings"
)

func (s *Service) insertSlackTriagePendingActions(ctx context.Context, workspaceID string, channelID string, threadTS string, jobID string, run *SlackTriageContext, actions []SlackTriageDecisionAction) []SlackTriagePendingResult {
	pending := make([]SlackTriagePendingResult, 0, len(actions))
	for _, action := range actions {
		if !action.RequiresConfirmation {
			continue
		}
		effectiveChannel := firstNonEmpty(action.ChannelID, channelID)
		effectiveThread := firstNonEmpty(action.ThreadTS, threadTS)
		runID := valueOrZero(run)
		source := "slack-triage"
		if action.Type == slackActionTypeThreadReply {
			source = "slack-triage-visible-reply-approval"
		}
		params := map[string]any{
			"source":      source,
			"runId":       runID,
			"triageRunId": runID,
			"jobId":       jobID,
			"title":       action.Title,
			"message":     action.Message,
			"reason":      action.Reason,
			"confidence":  action.Confidence,
		}
		if action.Type == slackActionTypeThreadReply {
			params["proposedReplyText"] = action.Message
			params["approvalDecision"] = "pending"
			params["qualityChecklist"] = []string{
				"verified_fact_or_citation",
				"adds_information_beyond_thread_reread",
				"not_speculative_or_vague",
			}
		}
		record, err := s.triage.InsertPendingAction(ctx, SlackPendingAction{
			ChannelID:  effectiveChannel,
			ThreadTS:   effectiveThread,
			ActionType: action.Type,
			Params:     params,
		})
		if err != nil || record == nil {
			s.logger.Warn("slack pending action insert failed", "error", err)
			continue
		}
		if action.Type == slackActionTypeThreadReply {
			updated, err := s.triage.UpdatePendingAction(ctx, record.ID, func(stored *SlackPendingAction) {
				if stored.Params == nil {
					stored.Params = make(map[string]any)
				}
				stored.Params["cardId"] = fmt.Sprintf("pending_action:%d", stored.ID)
			})
			if err != nil {
				s.logger.Warn("slack pending reply card id update failed", "error", err)
			} else if updated != nil {
				record = updated
			}
		}
		if err := s.cognition.RecordAction(ctx, workspaceID, effectiveChannel, effectiveThread, action.Type, "pending"); err != nil {
			s.logger.Warn("slack thread ledger action record failed", "error", err)
		}
		result := SlackTriagePendingResult{Action: action, PendingAction: *record}
		if s.triagePostActions || action.Type == slackActionTypeThreadReply {
			post := s.postSlackTriagePendingActionCard(ctx, action, *record, runID)
			result.Post = post
			if post.OK {
				if err := s.triage.SetPendingActionCardTS(ctx, record.ID, firstNonEmpty(post.TS, post.ThreadTS)); err != nil {
					s.logger.Warn("slack pending action card ts update failed", "error", err)
				}
				if action.Type != slackActionTypeThreadReply {
					s.recordSlackTriageActionOutbound(ctx, workspaceID, effectiveChannel, effectiveThread, action)
				}
			}
		}
		pending = append(pending, result)
	}
	return pending
}

func requireSlackTriageVisibleReplyApproval(actions []SlackTriageDecisionAction) []SlackTriageDecisionAction {
	if len(actions) == 0 {
		return actions
	}
	out := make([]SlackTriageDecisionAction, 0, len(actions))
	for _, action := range actions {
		if strings.TrimSpace(action.Type) == slackActionTypeThreadReply {
			action.Type = slackActionTypeThreadReply
			action.RequiresConfirmation = true
			action.Title = firstNonEmpty(strings.TrimSpace(action.Title), "Review triage reply")
		}
		out = append(out, action)
	}
	return out
}

func (s *Service) postSlackTriagePendingActionCard(ctx context.Context, action SlackTriageDecisionAction, record SlackPendingAction, runID int64) PostMessageResult {
	text := buildSlackTriageActionText(action, record)
	blocks := buildSlackTriageActionBlocks(action, record)
	dedupKey := fmt.Sprintf("slack-triage-action:%d:%d", runID, record.ID)
	if action.Type == slackActionTypeThreadReply {
		if s == nil || s.operatorFallback == nil || s.operatorFallback.DM == nil {
			return PostMessageResult{OK: false, Error: "pilot_dm_not_configured"}
		}
		pilot := strings.TrimSpace(s.operatorFallback.PilotUserID)
		if pilot == "" {
			return PostMessageResult{OK: false, Error: "pilot_user_id_not_configured"}
		}
		channelID, err := s.operatorFallback.DM.openDM(ctx, s.operatorFallback.Client, s.operatorFallback.BotToken, s.operatorFallback.APIBaseURL, pilot)
		if err != nil {
			return PostMessageResult{OK: false, Error: "open_pilot_dm_failed", Detail: err.Error()}
		}
		return s.PostMessage(ctx, PostMessageInput{
			Channel:  channelID,
			Text:     text,
			Blocks:   blocks,
			DedupKey: "pilot_dm:" + channelID + ":" + dedupKey,
		})
	}
	return s.PostMessage(ctx, PostMessageInput{
		Channel:  firstNonEmpty(action.ChannelID, record.ChannelID),
		ThreadTS: firstNonEmpty(action.ThreadTS, record.ThreadTS),
		Text:     text,
		Blocks:   blocks,
		DedupKey: dedupKey,
	})
}

func (s *Service) recordSlackTriageActionOutbound(ctx context.Context, workspaceID string, channelID string, threadTS string, action SlackTriageDecisionAction) {
	err := s.cognition.RecordOutbound(ctx, workspaceID, channelID, threadTS, fmt.Sprintf("Triage suggested %s: %s", action.Type, action.Title))
	if err != nil {
		s.logger.Warn("slack thread ledger outbound record failed", "error", err)
	}
}
