package meetingagent

import (
	"errors"
	"net/http"

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
		var invalidArtifactsDir InvalidArtifactsDirError
		if errors.As(err, &invalidArtifactsDir) {
			httputil.AbortWithError(c, httputil.InvalidRequestError("invalid join body", gin.H{"reason": err.Error()}))
			return
		}
		h.service.logger.Warn("join google meet failed", "meeting_url", request.MeetingURL, "session_id", request.SessionID, "error", err)
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
