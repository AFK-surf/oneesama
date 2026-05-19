package slackagent

import (
	"context"
	"fmt"
	"strings"
)

// Canvas-action confirmation executors.
//
// This file implements the suggest_action confirmation flow for Canvas writes:
// the model proposes a canvas write, a user clicks confirm on the Slack card,
// and the bot then calls Slack's canvases API. The direct slack_api
// create_canvas / edit_canvas tools are also active for old Agent D parity; this
// confirmation path remains the safer consent-first route for autonomous
// suggestions.
//
// Guardrails applied to every confirmed canvas action:
//   - sanitize+retry on validation-class errors (reusing the helper from
//     canvas_markdown_sanitize.go shipped in commit a353b79).
//   - edit_canvas REQUIRES an explicit `file_id` — we refuse to "guess"
//     which canvas to mutate.
//   - edit_canvas op is restricted to insert_at_end (default),
//     insert_at_start, or replace; arbitrary Slack-side ops are blocked.
//   - Successful writes are logged into the cognition outbound ledger via
//     recordSlackOutboundLedger (shipped in c550bb0) so canvas mutations
//     show up in thread durable context.
//   - Failures post a structured failure card back into the thread
//     instead of dying silently.

// executeCreateCanvasPendingAction is the confirmation-time executor for
// action_type=create_canvas. It is spawned as a goroutine from
// HandlePendingActionInteraction once the user clicks "confirm" on the
// suggest_action card, so the interaction handler can ack Slack fast and
// the canvas write happens in the background.
func (s *Service) executeCreateCanvasPendingAction(ctx context.Context, action SlackPendingAction, interaction SlackPendingActionInteraction) {
	response := s.runCreateCanvasPendingAction(ctx, action, interaction)
	resultText := strings.TrimSpace(response.Text)
	if resultText == "" {
		if response.OK {
			resultText = "create_canvas executed"
		} else {
			resultText = "create_canvas failed"
		}
	}
	if _, err := s.triage.UpdatePendingAction(ctx, action.ID, func(record *SlackPendingAction) {
		record.Result = resultText
	}); err != nil {
		s.logger.Warn("slack pending create_canvas result update failed", "pending_action_id", action.ID, "error", err)
	}
}

// executeEditCanvasPendingAction mirrors executeCreateCanvasPendingAction
// for the edit path.
func (s *Service) executeEditCanvasPendingAction(ctx context.Context, action SlackPendingAction, interaction SlackPendingActionInteraction) {
	response := s.runEditCanvasPendingAction(ctx, action, interaction)
	resultText := strings.TrimSpace(response.Text)
	if resultText == "" {
		if response.OK {
			resultText = "edit_canvas executed"
		} else {
			resultText = "edit_canvas failed"
		}
	}
	if _, err := s.triage.UpdatePendingAction(ctx, action.ID, func(record *SlackPendingAction) {
		record.Result = resultText
	}); err != nil {
		s.logger.Warn("slack pending edit_canvas result update failed", "pending_action_id", action.ID, "error", err)
	}
}

func (s *Service) runCreateCanvasPendingAction(ctx context.Context, action SlackPendingAction, interaction SlackPendingActionInteraction) AvatarCommandResponse {
	markdown := strings.TrimSpace(stringFromAny(action.Params["markdown"]))
	title := strings.TrimSpace(firstNonEmpty(
		stringFromAny(action.Params["canvas_title"]),
		stringFromAny(action.Params["canvasTitle"]),
		stringFromAny(action.Params["title"]),
	))
	if markdown == "" || title == "" {
		response := AvatarCommandResponse{
			OK:           false,
			ResponseType: "ephemeral",
			Text:         "create_canvas failed: pending action did not carry a markdown body and title.",
		}
		s.postPendingCanvasResult(ctx, action, interaction.ResponseURL, response, "create_canvas")
		return response
	}
	channel := firstNonEmpty(stringFromAny(action.Params["channel"]), action.ChannelID)
	publisher, err := s.getCanvasPublisher()
	if err != nil || publisher == nil {
		response := AvatarCommandResponse{
			OK:           false,
			ResponseType: "ephemeral",
			Text:         "create_canvas failed: canvas publisher unavailable.",
		}
		s.postPendingCanvasResult(ctx, action, interaction.ResponseURL, response, "create_canvas")
		return response
	}
	manifest, err := publisher.Publish(ctx, CanvasPublishInput{
		Title:            title,
		SummaryMarkdown:  markdown,
		Channel:          channel,
		ThreadTS:         action.ThreadTS,
		DedupKey:         canvasPendingActionDedupKey(action),
		ForceSlackCanvas: true,
	})
	if err != nil {
		response := AvatarCommandResponse{
			OK:           false,
			ResponseType: "ephemeral",
			Text:         fmt.Sprintf("create_canvas failed: %s", err.Error()),
		}
		s.postPendingCanvasResult(ctx, action, interaction.ResponseURL, response, "create_canvas")
		return response
	}
	canvasID := ""
	permalink := ""
	if manifest.Canvas != nil {
		canvasID = strings.TrimSpace(manifest.Canvas.CanvasID)
		permalink = strings.TrimSpace(manifest.Canvas.Permalink)
	}
	successText := fmt.Sprintf("Canvas created: %q", title)
	if permalink != "" {
		successText = fmt.Sprintf("Canvas created: <%s|%s>", permalink, title)
	} else if canvasID != "" {
		successText = fmt.Sprintf("Canvas created (id %s): %q", canvasID, title)
	}
	response := AvatarCommandResponse{
		OK:              manifest.OK,
		ResponseType:    "ephemeral",
		Text:            successText,
		ReplaceOriginal: true,
	}
	if manifest.OK {
		if err := s.cognition.RecordOutbound(ctx, "workspace", action.ChannelID, action.ThreadTS, fmt.Sprintf("created canvas %q", title)); err != nil {
			s.logger.Warn("slack pending create_canvas outbound record failed", "pending_action_id", action.ID, "error", err)
		}
	}
	s.postPendingCanvasResult(ctx, action, interaction.ResponseURL, response, "create_canvas")
	return response
}

func (s *Service) runEditCanvasPendingAction(ctx context.Context, action SlackPendingAction, interaction SlackPendingActionInteraction) AvatarCommandResponse {
	fileID := strings.TrimSpace(firstNonEmpty(
		stringFromAny(action.Params["file_id"]),
		stringFromAny(action.Params["fileId"]),
		stringFromAny(action.Params["canvas_id"]),
		stringFromAny(action.Params["canvasId"]),
	))
	markdown := strings.TrimSpace(stringFromAny(action.Params["markdown"]))
	op := strings.TrimSpace(strings.ToLower(stringFromAny(action.Params["op"])))
	if op == "" {
		op = "insert_at_end"
	}
	sectionID := strings.TrimSpace(stringFromAny(action.Params["section_id"]))
	diffSummary := strings.TrimSpace(stringFromAny(action.Params["diff_summary"]))

	if fileID == "" || markdown == "" {
		response := AvatarCommandResponse{
			OK:           false,
			ResponseType: "ephemeral",
			Text:         "edit_canvas failed: pending action missing file_id or markdown.",
		}
		s.postPendingCanvasResult(ctx, action, interaction.ResponseURL, response, "edit_canvas")
		return response
	}
	publisher, err := s.getCanvasPublisher()
	if err != nil || publisher == nil {
		response := AvatarCommandResponse{
			OK:           false,
			ResponseType: "ephemeral",
			Text:         "edit_canvas failed: canvas publisher unavailable.",
		}
		s.postPendingCanvasResult(ctx, action, interaction.ResponseURL, response, "edit_canvas")
		return response
	}
	manifest, err := publisher.Publish(ctx, CanvasPublishInput{
		Title:            firstNonEmpty(stringFromAny(action.Params["title"]), "Canvas edit"),
		SummaryMarkdown:  markdown,
		Channel:          firstNonEmpty(stringFromAny(action.Params["channel"]), action.ChannelID),
		ThreadTS:         action.ThreadTS,
		CanvasID:         fileID,
		Operation:        op,
		SectionID:        sectionID,
		ForceSlackCanvas: true,
		DedupKey:         canvasPendingActionDedupKey(action),
	})
	if err != nil {
		response := AvatarCommandResponse{
			OK:           false,
			ResponseType: "ephemeral",
			Text:         fmt.Sprintf("edit_canvas failed: %s", err.Error()),
		}
		s.postPendingCanvasResult(ctx, action, interaction.ResponseURL, response, "edit_canvas")
		return response
	}
	successDescription := fmt.Sprintf("Canvas %s edited (op=%s)", fileID, op)
	if diffSummary != "" {
		successDescription += ": " + diffSummary
	}
	response := AvatarCommandResponse{
		OK:              manifest.OK,
		ResponseType:    "ephemeral",
		Text:            successDescription,
		ReplaceOriginal: true,
	}
	if manifest.OK {
		if err := s.cognition.RecordOutbound(ctx, "workspace", action.ChannelID, action.ThreadTS, fmt.Sprintf("edited canvas %s (op=%s)", fileID, op)); err != nil {
			s.logger.Warn("slack pending edit_canvas outbound record failed", "pending_action_id", action.ID, "error", err)
		}
	}
	s.postPendingCanvasResult(ctx, action, interaction.ResponseURL, response, "edit_canvas")
	return response
}

// postPendingCanvasResult mirrors postPendingJoinMeetingResult: it routes
// the executor's result back to the user. If a response_url is available
// (Slack Block Kit interaction reply), we update the original card;
// otherwise we post a new message into the canvas's anchoring thread so
// the user sees what happened.
func (s *Service) postPendingCanvasResult(ctx context.Context, action SlackPendingAction, responseURL string, response AvatarCommandResponse, kind string) {
	if strings.TrimSpace(responseURL) != "" {
		if err := postSlackInteractionResponse(ctx, responseURL, response); err != nil {
			s.logger.Warn(
				"slack pending canvas response update failed",
				"pending_action_id", action.ID,
				"kind", kind,
				"error", err,
			)
		}
		return
	}
	if strings.TrimSpace(action.ChannelID) == "" || strings.TrimSpace(action.ThreadTS) == "" {
		return
	}
	text := strings.TrimSpace(response.Text)
	if text == "" {
		text = fmt.Sprintf("Pending %s action %d finished.", kind, action.ID)
	}
	post := s.PostMessage(ctx, PostMessageInput{
		Channel:  action.ChannelID,
		ThreadTS: action.ThreadTS,
		Text:     text,
		Blocks:   response.Blocks,
		DedupKey: fmt.Sprintf("slack-pending-%s-result:%d", kind, action.ID),
	})
	if !post.OK {
		s.logger.Warn(
			"slack pending canvas result post failed",
			"pending_action_id", action.ID,
			"kind", kind,
			"error", post.Error,
			"detail", post.Detail,
		)
	}
}

// canvasPendingActionDedupKey produces a stable dedupe key for the canvas
// publish call so retries from the user (e.g. clicking Confirm twice) do
// not produce duplicate canvases. The key encodes the pending action ID
// which is itself unique per suggested write.
func canvasPendingActionDedupKey(action SlackPendingAction) string {
	return fmt.Sprintf("slack-canvas-pending:%s:%s:%d", action.ChannelID, action.ThreadTS, action.ID)
}
