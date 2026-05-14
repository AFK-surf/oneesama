package slackagent

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

const meetingWebhookBodyLimit = 1 << 20

func (h *Handler) handleMeetingWebhook(c *gin.Context) {
	if h.service.meetWebhookSecret == "" {
		c.String(http.StatusInternalServerError, "webhook secret not configured")
		return
	}
	body, err := io.ReadAll(io.LimitReader(c.Request.Body, meetingWebhookBodyLimit))
	if err != nil {
		c.String(http.StatusBadRequest, "failed to read body")
		return
	}
	if !verifyMeetingWebhookSignature(body, c.GetHeader("X-Webhook-Signature"), h.service.meetWebhookSecret) {
		c.String(http.StatusUnauthorized, "invalid signature")
		return
	}
	var payload MeetingWebhookPayload
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	if err := decoder.Decode(&payload); err != nil {
		c.String(http.StatusBadRequest, "invalid payload")
		return
	}

	ctx, cancel := meetingWebhookRequestContext(c.Request.Context())
	defer cancel()
	result := h.service.HandleMeetingWebhook(ctx, payload)
	status := http.StatusOK
	if result.Event == "meeting.result" || result.Accepted {
		status = http.StatusAccepted
	} else if !result.OK && result.Error != "" {
		status = http.StatusBadRequest
	}
	c.JSON(status, result)
}

func verifyMeetingWebhookSignature(body []byte, signature string, secret string) bool {
	signature = strings.TrimSpace(signature)
	if signature == "" || strings.TrimSpace(secret) == "" {
		return false
	}
	expected := meetingWebhookSignature(body, secret)
	return hmac.Equal([]byte(signature), []byte(expected))
}

func meetingWebhookSignature(body []byte, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}
