package meetingagent

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

func (s *Service) SendMeetdWebhook(ctx context.Context, event string, meeting MeetdMeetingRecord, result MeetdMeetingResult) error {
	payload := buildMeetdWebhookPayload(event, meeting, &result)
	err := sendMeetdWebhook(ctx, s.meetdWebhookURL, s.meetdWebhookSecret, payload)
	if err != nil {
		_ = s.UpdateMeetdWebhookState(context.WithoutCancel(ctx), meeting.ID, "failed", err.Error(), 5, event)
		return err
	}
	_ = s.UpdateMeetdWebhookState(context.WithoutCancel(ctx), meeting.ID, "delivered", "", 0, event)
	return nil
}

func (s *Service) NotifyMeetdWebhook(ctx context.Context, event string, meeting MeetdMeetingRecord, result *MeetdMeetingResult) {
	if s.meetdWebhookURL == "" {
		return
	}
	payload := buildMeetdWebhookPayload(event, meeting, result)
	err := sendMeetdWebhook(ctx, s.meetdWebhookURL, s.meetdWebhookSecret, payload)
	if err != nil {
		s.logger.Warn("meetd webhook failed", "event", event, "meeting_id", meeting.ID, "error", err)
		_ = s.UpdateMeetdWebhookState(context.WithoutCancel(ctx), meeting.ID, "failed", err.Error(), 5, event)
		return
	}
	_ = s.UpdateMeetdWebhookState(context.WithoutCancel(ctx), meeting.ID, "delivered", "", 0, event)
}

func buildMeetdWebhookPayload(event string, meeting MeetdMeetingRecord, result *MeetdMeetingResult) MeetdWebhookPayload {
	payload := MeetdWebhookPayload{
		Event:     event,
		MeetingID: meeting.ID,
		Title:     meeting.Title,
		TimeFrom:  formatMeetdWebhookTime(meeting.StartTime),
		TimeTo:    formatMeetdWebhookTime(meeting.EndTime),
	}
	if meeting.SlackChannelID != "" && meeting.SlackThreadTS != "" {
		payload.SlackRef = &MeetdSlackRef{ChannelID: meeting.SlackChannelID, ThreadTS: meeting.SlackThreadTS}
	}
	if result != nil {
		payload.Status = result.Status
		payload.Summary = result.Summary
		payload.Artifacts = result.Artifacts
		payload.Error = result.Error
		payload.ForceDelivery = result.ForceDelivery
	}
	return payload
}

func formatMeetdWebhookTime(value time.Time) string {
	if value.IsZero() {
		return ""
	}
	return value.UTC().Format(time.RFC3339Nano)
}

func sendMeetdWebhook(ctx context.Context, webhookURL, secret string, payload MeetdWebhookPayload) error {
	if webhookURL == "" {
		return fmt.Errorf("webhook URL not configured")
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal webhook payload: %w", err)
	}
	signature := meetdHMAC(body, secret)
	var lastErr error
	backoff := time.Second
	for attempt := 1; attempt <= 5; attempt++ {
		if err := ctx.Err(); err != nil {
			return fmt.Errorf("context cancelled: %w", err)
		}
		requestCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
		request, err := http.NewRequestWithContext(requestCtx, http.MethodPost, webhookURL, bytes.NewReader(body))
		if err != nil {
			cancel()
			return fmt.Errorf("create webhook request: %w", err)
		}
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("X-Webhook-Signature", signature)
		response, err := http.DefaultClient.Do(request)
		cancel()
		if err == nil {
			_, _ = io.Copy(io.Discard, response.Body)
			_ = response.Body.Close()
			if response.StatusCode >= 200 && response.StatusCode < 300 {
				return nil
			}
			lastErr = fmt.Errorf("webhook returned status %d", response.StatusCode)
		} else {
			lastErr = err
		}
		if attempt < 5 {
			select {
			case <-time.After(backoff):
			case <-ctx.Done():
				return fmt.Errorf("context cancelled during retry: %w", ctx.Err())
			}
			backoff *= 2
		}
	}
	return fmt.Errorf("webhook failed after 5 attempts: %w", lastErr)
}

func meetdHMAC(data []byte, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(data)
	return hex.EncodeToString(mac.Sum(nil))
}
