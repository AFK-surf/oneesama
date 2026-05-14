package slackagent

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

func (h *Handler) handleScannerCompact(c *gin.Context) {
	var request SlackScannerCompactRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": "invalid request body: " + err.Error()})
		return
	}
	result, err := h.service.CompactSlackDailyNotes(c.Request.Context(), request)
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
