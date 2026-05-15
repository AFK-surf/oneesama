package slackagent

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

func (h *Handler) handleSlackToolsParity(c *gin.Context) {
	c.JSON(http.StatusOK, h.service.SlackToolParityReport())
}

func (h *Handler) handleSlackToolCall(c *gin.Context) {
	var request SlackToolCallRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": "invalid request body: " + err.Error()})
		return
	}
	result, err := h.service.ExecuteSlackTool(c.Request.Context(), request)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": err.Error()})
		return
	}
	status := http.StatusOK
	if !result.OK {
		status = http.StatusBadRequest
	}
	c.JSON(status, result)
}
