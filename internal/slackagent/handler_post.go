package slackagent

import (
	"net/http"
	"strings"

	"github.com/AFK-surf/oneesama/internal/httputil"
	"github.com/gin-gonic/gin"
)

type postMessageRequest struct {
	Channel  string           `json:"channel"`
	Text     string           `json:"text"`
	ThreadTS string           `json:"thread_ts"`
	DedupKey string           `json:"dedup_key"`
	Blocks   []map[string]any `json:"blocks"`
}

func (h *Handler) handlePostMessage(c *gin.Context) {
	var request postMessageRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		httputil.AbortWithError(c, httputil.InvalidRequestError("invalid post message body", gin.H{"reason": err.Error()}))
		return
	}

	result := h.service.PostMessage(c.Request.Context(), PostMessageInput{
		Channel:  request.Channel,
		Text:     request.Text,
		ThreadTS: request.ThreadTS,
		DedupKey: request.DedupKey,
		Blocks:   request.Blocks,
	})
	c.JSON(postMessageStatus(result), gin.H{
		"ok":     result.OK,
		"posted": result,
	})
}

func postMessageStatus(result PostMessageResult) int {
	if result.OK {
		return http.StatusOK
	}
	if strings.HasPrefix(result.Error, "missing_") {
		return http.StatusBadRequest
	}
	return http.StatusBadGateway
}
