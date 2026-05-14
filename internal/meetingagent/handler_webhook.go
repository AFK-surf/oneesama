package meetingagent

import (
	"net/http"

	"github.com/AFK-surf/oneesama/internal/httputil"
	"github.com/AFK-surf/oneesama/internal/postmeeting"
	"github.com/gin-gonic/gin"
)

func (h *Handler) handleDigestWebhook(c *gin.Context) {
	var body map[string]any
	if err := c.ShouldBindJSON(&body); err != nil {
		httputil.AbortWithError(c, httputil.InvalidRequestError("invalid digest webhook body", gin.H{"reason": err.Error()}))
		return
	}

	request := postmeeting.DigestWebhookRequest{
		URL:          stringValue(body["url"]),
		Secret:       stringValue(body["secret"]),
		MaxAttempts:  intValue(body["max_attempts"]),
		RetryDelayMS: intValue(body["retry_delay_ms"]),
		Payload:      mapValue(body["payload"]),
	}
	if len(request.Payload) == 0 {
		request.Payload = payloadFromDigestBody(body)
	}
	result, err := h.service.SendDigestWebhook(c.Request.Context(), request)
	if err != nil {
		httputil.AbortWithError(c, httputil.InternalServerError("digest webhook send failed", gin.H{"reason": err.Error()}))
		return
	}
	status := http.StatusOK
	if !result.OK {
		status = http.StatusBadGateway
	}
	c.JSON(status, result)
}

func payloadFromDigestBody(body map[string]any) map[string]any {
	payload := make(map[string]any, len(body))
	for key, value := range body {
		switch key {
		case "url", "secret", "max_attempts", "retry_delay_ms", "payload":
			continue
		default:
			payload[key] = value
		}
	}
	return payload
}

func mapValue(value any) map[string]any {
	if raw, ok := value.(map[string]any); ok {
		return raw
	}
	return nil
}

func stringValue(value any) string {
	if raw, ok := value.(string); ok {
		return raw
	}
	return ""
}

func intValue(value any) int {
	switch typed := value.(type) {
	case float64:
		return int(typed)
	case int:
		return typed
	default:
		return 0
	}
}
