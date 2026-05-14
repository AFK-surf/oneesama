package slackagent

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

type inboundFlushRequest struct {
	Channel   string `json:"channel,omitempty"`
	ChannelID string `json:"channel_id,omitempty"`
}

func (h *Handler) handleInboundStatus(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"ok":      true,
		"inbound": h.service.InboundStatus(),
	})
}

func (h *Handler) handleInboundFlush(c *gin.Context) {
	var request inboundFlushRequest
	if c.Request.Body != nil && c.Request.ContentLength != 0 {
		if err := c.ShouldBindJSON(&request); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": "invalid_request_body: " + err.Error()})
			return
		}
	}
	results, err := h.service.FlushSlackInbound(c.Request.Context(), firstNonEmpty(request.ChannelID, request.Channel))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"ok":      true,
		"flushes": results,
		"inbound": h.service.InboundStatus(),
	})
}

func (h *Handler) handleScannerSweep(c *gin.Context) {
	var request SlackScannerSweepRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": "invalid_request_body: " + err.Error()})
		return
	}
	result := h.service.SweepSlackScanner(c.Request.Context(), request)
	status := http.StatusOK
	if !result.OK && strings.TrimSpace(result.Error) != "" {
		status = http.StatusBadRequest
	}
	c.JSON(status, result)
}
