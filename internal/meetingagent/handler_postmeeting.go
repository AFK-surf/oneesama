package meetingagent

import (
	"errors"
	"net/http"

	"github.com/AFK-surf/oneesama/internal/httputil"
	"github.com/AFK-surf/oneesama/internal/postmeeting"
	"github.com/gin-gonic/gin"
)

func (h *Handler) handlePostProcess(c *gin.Context) {
	var request postmeeting.PostProcessInput
	if err := c.ShouldBindJSON(&request); err != nil {
		httputil.AbortWithError(c, httputil.InvalidRequestError("invalid post-process body", gin.H{"reason": err.Error()}))
		return
	}

	result, err := h.service.PostProcessMeeting(c.Request.Context(), request)
	if err != nil {
		var invalidID postmeeting.InvalidArtifactIDError
		if errors.As(err, &invalidID) {
			httputil.AbortWithError(c, httputil.InvalidRequestError("invalid artifact id", gin.H{"reason": err.Error()}))
			return
		}
		httputil.AbortWithError(c, httputil.InternalServerError("post-process failed", gin.H{"reason": err.Error()}))
		return
	}
	c.JSON(http.StatusOK, result)
}

func (h *Handler) handleListArtifacts(c *gin.Context) {
	artifacts, err := h.service.ListArtifacts()
	if err != nil {
		httputil.AbortWithError(c, httputil.InternalServerError("list artifacts failed", gin.H{"reason": err.Error()}))
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"ok":           true,
		"artifacts":    artifacts,
		"artifactsDir": h.service.pipeline.RootDir(),
	})
}

func (h *Handler) handleGetArtifact(c *gin.Context) {
	artifact, err := h.service.GetArtifact(c.Query("id"))
	if err != nil {
		var invalidID postmeeting.InvalidArtifactIDError
		if errors.As(err, &invalidID) {
			httputil.AbortWithError(c, httputil.InvalidRequestError("invalid artifact id", gin.H{"reason": err.Error()}))
			return
		}
		httputil.AbortWithError(c, httputil.InternalServerError("read artifact failed", gin.H{"reason": err.Error()}))
		return
	}
	if artifact == nil {
		httputil.AbortWithError(c, httputil.NotFoundError("artifact not found", gin.H{"id": c.Query("id")}))
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "artifact": artifact})
}

func (h *Handler) handleGetArtifactChat(c *gin.Context) {
	chat, err := h.service.GetArtifactChat(c.Query("id"))
	if err != nil {
		var invalidID postmeeting.InvalidArtifactIDError
		if errors.As(err, &invalidID) {
			httputil.AbortWithError(c, httputil.InvalidRequestError("invalid artifact id", gin.H{"reason": err.Error()}))
			return
		}
		httputil.AbortWithError(c, httputil.InternalServerError("read artifact chat failed", gin.H{"reason": err.Error()}))
		return
	}
	if chat == nil {
		httputil.AbortWithError(c, httputil.NotFoundError("artifact chat not found", gin.H{"id": c.Query("id")}))
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "chat": chat})
}
