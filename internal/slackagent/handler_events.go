package slackagent

import (
	"net/http"

	"github.com/AFK-surf/oneesama/internal/httputil"
	"github.com/gin-gonic/gin"
)

func (h *Handler) handleEvents(c *gin.Context) {
	var envelope SlackEventEnvelope
	if err := c.ShouldBindJSON(&envelope); err != nil {
		httputil.AbortWithError(c, httputil.InvalidRequestError("invalid slack events body", gin.H{"reason": err.Error()}))
		return
	}

	if envelope.Type == "url_verification" && envelope.Challenge != "" {
		c.JSON(http.StatusOK, gin.H{"challenge": envelope.Challenge})
		return
	}

	response := h.service.HandleSlackEvent(c.Request.Context(), envelope, SlackEventHeaders{
		RetryNum:    c.GetHeader("X-Slack-Retry-Num"),
		RetryReason: c.GetHeader("X-Slack-Retry-Reason"),
	})
	c.JSON(http.StatusOK, response)
}
