package meetingagent

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

func (h *Handler) handleDemoSurfaceTrail(c *gin.Context) {
	sessionID := strings.TrimSpace(c.Param("id"))
	trail, ok := h.service.DemoSurfaceTrail(sessionID)
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{
			"ok":    false,
			"error": "demo_surface_session_not_found",
		})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"ok":    true,
		"trail": trail,
	})
}
