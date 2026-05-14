package slackagent

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
)

func (h *Handler) handleFollowupStatus(c *gin.Context) {
	limit, _ := strconv.Atoi(c.Query("limit"))
	status, err := h.service.SlackFollowupStatus(c.Request.Context(), c.Query("status"), limit)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, status)
}

func (h *Handler) handleFollowupCreate(c *gin.Context) {
	var request SlackFollowupCreateRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": "invalid request body: " + err.Error()})
		return
	}
	result, err := h.service.CreateSlackFollowupSurface(c.Request.Context(), request)
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

func (h *Handler) handleFollowupSurface(c *gin.Context) {
	var request SlackFollowupSurfaceRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": "invalid request body: " + err.Error()})
		return
	}
	result, err := h.service.SurfaceSlackFollowups(c.Request.Context(), request)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, result)
}
