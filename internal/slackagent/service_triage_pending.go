package slackagent

import (
	"context"
	"fmt"
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
		record, err := s.triage.InsertPendingAction(ctx, SlackPendingAction{
			ChannelID:  effectiveChannel,
			ThreadTS:   effectiveThread,
			ActionType: action.Type,
			Params: map[string]any{
				"source":     "slack-triage",
				"runId":      runID,
				"jobId":      jobID,
				"title":      action.Title,
				"message":    action.Message,
				"reason":     action.Reason,
				"confidence": action.Confidence,
			},
		})
		if err != nil || record == nil {
			s.logger.Warn("slack pending action insert failed", "error", err)
			continue
		}
		if err := s.cognition.RecordAction(ctx, workspaceID, effectiveChannel, effectiveThread, action.Type, "pending"); err != nil {
			s.logger.Warn("slack thread ledger action record failed", "error", err)
		}
		result := SlackTriagePendingResult{Action: action, PendingAction: *record}
		if s.triagePostActions {
			post := s.PostMessage(ctx, PostMessageInput{
				Channel:  effectiveChannel,
				ThreadTS: effectiveThread,
				Text:     buildSlackTriageActionText(action, *record),
				Blocks:   buildSlackTriageActionBlocks(action, *record),
				DedupKey: fmt.Sprintf("slack-triage-action:%d:%d", runID, record.ID),
			})
			result.Post = post
			if post.OK {
				if err := s.triage.SetPendingActionCardTS(ctx, record.ID, firstNonEmpty(post.TS, post.ThreadTS)); err != nil {
					s.logger.Warn("slack pending action card ts update failed", "error", err)
				}
				s.recordSlackTriageActionOutbound(ctx, workspaceID, effectiveChannel, effectiveThread, action)
			}
		}
		pending = append(pending, result)
	}
	return pending
}

func (s *Service) recordSlackTriageActionOutbound(ctx context.Context, workspaceID string, channelID string, threadTS string, action SlackTriageDecisionAction) {
	err := s.cognition.RecordOutbound(ctx, workspaceID, channelID, threadTS, fmt.Sprintf("Triage suggested %s: %s", action.Type, action.Title))
	if err != nil {
		s.logger.Warn("slack thread ledger outbound record failed", "error", err)
	}
}
