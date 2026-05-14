package meetingagent

import (
	"errors"
	"net/http"
	"strings"

	"github.com/AFK-surf/oneesama/internal/httputil"
	"github.com/gin-gonic/gin"
)

func (h *Handler) handleJoinGoogleMeet(c *gin.Context) {
	var request JoinGoogleMeetRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		httputil.AbortWithError(c, httputil.InvalidRequestError("invalid join body", gin.H{"reason": err.Error()}))
		return
	}
	result, err := h.service.JoinGoogleMeet(c.Request.Context(), request)
	if err != nil {
		httputil.AbortWithError(c, httputil.InternalServerError("join google meet failed", gin.H{"reason": err.Error()}))
		return
	}
	c.JSON(http.StatusOK, result)
}

func (h *Handler) handleJoinStatus(c *gin.Context) {
	result, err := h.service.JoinStatus(c.Request.Context(), c.Query("session_id"))
	if err != nil {
		httputil.AbortWithError(c, httputil.InternalServerError("join status failed", gin.H{"reason": err.Error()}))
		return
	}
	c.JSON(http.StatusOK, result)
}

func (h *Handler) handleJoinStop(c *gin.Context) {
	var request StopJoinRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		httputil.AbortWithError(c, httputil.InvalidRequestError("invalid stop body", gin.H{"reason": err.Error()}))
		return
	}
	result, err := h.service.StopJoin(c.Request.Context(), request)
	if err != nil {
		httputil.AbortWithError(c, httputil.InternalServerError("stop join failed", gin.H{"reason": err.Error()}))
		return
	}
	c.JSON(http.StatusOK, result)
}

type JoinRedeliverRequest struct {
	SessionID string `json:"session_id,omitempty"`
	ID        string `json:"id,omitempty"`
}

func (h *Handler) handleJoinRedeliver(c *gin.Context) {
	var request JoinRedeliverRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		httputil.AbortWithError(c, httputil.InvalidRequestError("invalid redeliver body", gin.H{"reason": err.Error()}))
		return
	}
	sessionID := strings.TrimSpace(firstNonEmpty(request.SessionID, request.ID))
	if sessionID == "" {
		httputil.AbortWithError(c, httputil.InvalidRequestError("session_id is required", nil))
		return
	}
	if err := h.service.RedeliverJoinSession(c.Request.Context(), sessionID); err != nil {
		switch {
		case errors.Is(err, errJoinSessionNotFound):
			httputil.AbortWithError(c, httputil.NotFoundError("join session not found", gin.H{"session_id": sessionID}))
		case errors.Is(err, errJoinSessionNotRedeliverable):
			httputil.AbortWithError(c, httputil.InvalidRequestError(err.Error(), gin.H{"session_id": sessionID}))
		default:
			httputil.AbortWithError(c, httputil.InternalServerError("redeliver join session failed", gin.H{"reason": err.Error(), "session_id": sessionID}))
		}
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "redelivered", "session_id": sessionID})
}
