package slackagent

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

func (h *Handler) handleHeartbeatContext(c *gin.Context) {
	contextText, err := h.service.BuildHeartbeatContext(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "context": contextText})
}
