package slackagent

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/AFK-surf/oneesama/internal/httputil"
)

const slackInteractionResponseLimit = 1 << 20
const slackInteractionResponseAttempts = 3

type joinSetupInteractionMode string

const (
	joinSetupHTTPMode       joinSetupInteractionMode = "http_response"
	joinSetupSocketMode     joinSetupInteractionMode = "socket_response_url"
	joinSetupThreadPostMode joinSetupInteractionMode = "thread_post"
)

func (s *Service) StartJoinSetupInteraction(ctx context.Context, command AvatarCommandInput, responseURL string) AvatarCommandResponse {
	return s.startJoinSetupInteraction(ctx, command, responseURL, joinSetupHTTPMode)
}

// StartJoinSetupSocketInteraction is the Socket Mode entry point for the
// "join meeting" button. It MUST return before the ack window expires —
// startJoinSetupInteraction may synchronously POST to response_url, which
// can take longer than Slack's ~3s ack budget. LaunchAsyncInteraction
// (service_interaction_async.go) is the standard ack-first wrapper; do
// not inline-call startJoinSetupInteraction here without first
// establishing why the slow path is safe.
func (s *Service) StartJoinSetupSocketInteraction(ctx context.Context, command AvatarCommandInput, responseURL string) AvatarCommandResponse {
	ack := s.joinSetupProgressResponse(command, responseURL, joinSetupSocketMode)
	s.LaunchAsyncInteraction(ctx, "join_setup_socket", func(detached context.Context) {
		_ = s.startJoinSetupInteraction(detached, command, responseURL, joinSetupSocketMode)
	})
	return ack
}

func (s *Service) StartJoinSetupCaptionSocketInteraction(ctx context.Context, response AvatarCommandResponse, responseURL string) {
	if strings.TrimSpace(responseURL) == "" {
		return
	}
	s.LaunchAsyncInteraction(ctx, "join_setup_caption_update", func(detached context.Context) {
		if err := postSlackInteractionResponse(detached, responseURL, response); err != nil {
			s.logger.Warn("slack join setup caption response update failed", "error", err)
		}
	})
}

func (s *Service) startJoinSetupInteraction(ctx context.Context, command AvatarCommandInput, responseURL string, mode joinSetupInteractionMode) AvatarCommandResponse {
	ack := s.joinSetupProgressResponse(command, responseURL, mode)
	parsed := parseAvatarCommand(command.Text)
	cardID := joinSetupProgressCardID(command, parsed)
	s.logger.Info(
		"slack join setup interaction started",
		"card_id", cardID,
		"mode", string(mode),
		"channel", command.ChannelID,
		"thread_ts", command.ThreadTS,
		"response_url_present", strings.TrimSpace(responseURL) != "",
		"meet_url", parsed.MeetURL,
		"realtime", parsed.RealtimeJoin,
		"dry_run", parsed.DryRunJoiner,
	)
	if mode == joinSetupSocketMode && strings.TrimSpace(responseURL) != "" {
		if err := postSlackInteractionResponse(ctx, responseURL, ack); err != nil {
			s.logger.Warn("slack join setup immediate response update failed", "error", err)
		}
	}
	if mode == joinSetupThreadPostMode {
		s.postJoinSetupThreadStatus(ctx, command, parsed, ack.Text, "joining")
	}
	go s.finishJoinSetupInteraction(context.WithoutCancel(ctx), command, responseURL)
	return ack
}

func (s *Service) joinSetupProgressResponse(command AvatarCommandInput, responseURL string, mode joinSetupInteractionMode) AvatarCommandResponse {
	parsed := parseAvatarCommand(command.Text)
	cardID := joinSetupProgressCardID(command, parsed)
	return AvatarCommandResponse{
		OK:              true,
		Text:            joinSetupInProgressText(parsed),
		Blocks:          buildJoinSetupProgressBlocks(parsed),
		ReplaceOriginal: true,
		Metadata: map[string]any{
			"join_setup": map[string]any{
				"meeting_url":      parsed.MeetURL,
				"caption_language": s.effectiveCaptionLanguage(parsed.CaptionLanguage),
				"realtime":         parsed.RealtimeJoin,
				"dry_run":          parsed.DryRunJoiner,
				"status":           "joining",
				"card_id":          cardID,
				"update_transport": string(mode),
			},
		},
	}
}

func joinSetupProgressCardID(command AvatarCommandInput, parsed parsedAvatarCommand) string {
	return strings.Join([]string{
		"join-card",
		firstNonEmpty(strings.TrimSpace(command.ChannelID), "channel"),
		firstNonEmpty(strings.TrimSpace(command.ThreadTS), "thread"),
		sanitizeJoinSetupIDPart(parsed.MeetURL),
	}, ":")
}

func joinSetupInProgressText(parsed parsedAvatarCommand) string {
	realtime := "off"
	if parsed.RealtimeJoin {
		realtime = "on"
	}
	mode := "real join"
	if parsed.DryRunJoiner {
		mode = "dry-run"
	}
	return fmt.Sprintf("Bot is joining *Google Meet*\nCaptions: %s · realtime %s · %s.", firstNonEmpty(parsed.CaptionLanguage, defaultCaptionLanguage), realtime, mode)
}

func buildJoinSetupProgressBlocks(parsed parsedAvatarCommand) []map[string]any {
	realtime := "off"
	if parsed.RealtimeJoin {
		realtime = "on"
	}
	mode := "real join"
	if parsed.DryRunJoiner {
		mode = "dry-run"
	}
	return []map[string]any{
		{
			"type": "section",
			"text": map[string]any{
				"type": "mrkdwn",
				"text": fmt.Sprintf("*Joining Google Meet*\n<%s|Open meeting>", parsed.MeetURL),
			},
		},
		{
			"type": "context",
			"elements": []map[string]any{{
				"type": "mrkdwn",
				"text": fmt.Sprintf("Captions: %s · realtime %s · %s", firstNonEmpty(parsed.CaptionLanguage, defaultCaptionLanguage), realtime, mode),
			}},
		},
	}
}

func (s *Service) finishJoinSetupInteraction(ctx context.Context, command AvatarCommandInput, responseURL string) {
	response := s.RunAvatarCommand(ctx, command)
	response.ReplaceOriginal = true
	response.ResponseType = ""
	if strings.TrimSpace(response.Text) == "" {
		response.Text = "Join request finished."
	}
	parsed := parseAvatarCommand(command.Text)
	cardID := strings.Join([]string{
		"join-card",
		firstNonEmpty(strings.TrimSpace(command.ChannelID), "channel"),
		firstNonEmpty(strings.TrimSpace(command.ThreadTS), "thread"),
		sanitizeJoinSetupIDPart(parsed.MeetURL),
	}, ":")
	metadata := cloneMetadata(response.Metadata)
	if metadata == nil {
		metadata = map[string]any{}
	}
	metadata["join_setup"] = map[string]any{
		"meeting_url": parsed.MeetURL,
		"status":      "finished",
		"card_id":     cardID,
		"ok":          response.OK,
	}
	response.Metadata = metadata
	s.logger.Info(
		"slack join setup interaction finished",
		"card_id", cardID,
		"channel", command.ChannelID,
		"thread_ts", command.ThreadTS,
		"response_url_present", strings.TrimSpace(responseURL) != "",
		"ok", response.OK,
		"meet_url", parsed.MeetURL,
	)
	if strings.TrimSpace(responseURL) == "" {
		if command.ChannelID != "" {
			_ = s.deliverSlackPublicNotification(ctx, slackPublicNotificationDelivery{
				Source:    slackPublicNotificationSourceJoinSetupStatus,
				Surface:   slackPublicNotificationSurfaceStatusCard,
				ChannelID: command.ChannelID,
				ThreadTS:  command.ThreadTS,
				Text:      response.Text,
				Blocks:    response.Blocks,
				DedupKey:  "join-setup:fallback:" + cardID,
			})
		}
		return
	}
	if err := postSlackInteractionResponse(ctx, responseURL, response); err != nil {
		s.logger.Warn("slack join setup response update failed", "error", err)
	}
}

func (s *Service) postJoinSetupThreadStatus(ctx context.Context, command AvatarCommandInput, parsed parsedAvatarCommand, text string, stage string) {
	if strings.TrimSpace(command.ChannelID) == "" || strings.TrimSpace(command.ThreadTS) == "" || strings.TrimSpace(text) == "" {
		return
	}
	dedupKey := strings.Join([]string{
		"join-setup",
		strings.TrimSpace(stage),
		strings.TrimSpace(command.ChannelID),
		strings.TrimSpace(command.ThreadTS),
		strings.TrimSpace(parsed.MeetURL),
	}, ":")
	result := s.deliverSlackPublicNotification(ctx, slackPublicNotificationDelivery{
		Source:    slackPublicNotificationSourceJoinSetupStatus,
		Surface:   slackPublicNotificationSurfaceStatusCard,
		ChannelID: command.ChannelID,
		ThreadTS:  command.ThreadTS,
		Text:      text,
		DedupKey:  dedupKey,
	}).Post
	if !result.OK {
		s.logger.Warn("slack join setup thread status post failed", "stage", stage, "channel", command.ChannelID, "thread_ts", command.ThreadTS, "error", result.Error, "detail", result.Detail)
	}
}

func postSlackInteractionResponse(ctx context.Context, responseURL string, response AvatarCommandResponse) error {
	raw, err := json.Marshal(response)
	if err != nil {
		return fmt.Errorf("encode slack interaction response: %w", err)
	}
	var lastErr error
	for attempt := 1; attempt <= slackInteractionResponseAttempts; attempt++ {
		lastErr = postSlackInteractionResponseOnce(ctx, responseURL, raw)
		if lastErr == nil {
			return nil
		}
		if attempt == slackInteractionResponseAttempts {
			break
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(250 * time.Millisecond * time.Duration(attempt)):
		}
	}
	return lastErr
}

func postSlackInteractionResponseOnce(ctx context.Context, responseURL string, raw []byte) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, responseURL, bytes.NewReader(raw))
	if err != nil {
		return fmt.Errorf("build slack interaction response request: %w", err)
	}
	request.Header.Set("Content-Type", "application/json")
	httpResponse, err := httputil.NewHTTPClient(10 * time.Second).Do(request)
	if err != nil {
		return fmt.Errorf("post slack interaction response: %w", err)
	}
	defer func() { _ = httpResponse.Body.Close() }()
	body, readErr := io.ReadAll(io.LimitReader(httpResponse.Body, slackInteractionResponseLimit))
	if readErr != nil {
		return fmt.Errorf("read slack interaction response: %w", readErr)
	}
	if httpResponse.StatusCode < 200 || httpResponse.StatusCode >= 300 {
		return fmt.Errorf("slack interaction response returned %d: %s", httpResponse.StatusCode, strings.TrimSpace(string(body)))
	}
	return nil
}
