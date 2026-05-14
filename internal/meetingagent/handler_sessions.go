package meetingagent

import (
	"net/http"

	"github.com/AFK-surf/oneesama/internal/httputil"
	"github.com/gin-gonic/gin"
)

func (h *Handler) handleListSessions(c *gin.Context) {
	sessions, err := h.service.ListSessions(c.Request.Context())
	if err != nil {
		httputil.AbortWithError(c, httputil.InternalServerError("list sessions failed", gin.H{"reason": err.Error()}))
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "sessions": sessions})
}

func (h *Handler) handleGetSession(c *gin.Context) {
	session, err := h.service.GetSession(c.Request.Context(), c.Query("id"))
	if err != nil {
		httputil.AbortWithError(c, httputil.InternalServerError("read session failed", gin.H{"reason": err.Error()}))
		return
	}
	if session == nil {
		httputil.AbortWithError(c, httputil.NotFoundError("session not found", gin.H{"id": c.Query("id")}))
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "session": session})
}

func (h *Handler) handleUpsertSession(c *gin.Context) {
	var request SessionUpsertInput
	if err := c.ShouldBindJSON(&request); err != nil {
		httputil.AbortWithError(c, httputil.InvalidRequestError("invalid session body", gin.H{"reason": err.Error()}))
		return
	}
	session, err := h.service.UpsertSession(c.Request.Context(), request)
	if err != nil {
		httputil.AbortWithError(c, httputil.InternalServerError("persist session failed", gin.H{"reason": err.Error()}))
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "session": session})
}

func (h *Handler) handleDeleteSession(c *gin.Context) {
	sessionID := c.Query("id")
	if sessionID == "" {
		httputil.AbortWithError(c, httputil.InvalidRequestError("session id is required", nil))
		return
	}
	if err := h.service.DeleteSession(c.Request.Context(), sessionID); err != nil {
		httputil.AbortWithError(c, httputil.InternalServerError("delete session failed", gin.H{"reason": err.Error()}))
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "id": sessionID})
}
