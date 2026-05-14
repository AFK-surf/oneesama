package meetingagent

import (
	"net/http"

	"github.com/AFK-surf/oneesama/internal/httputil"
	"github.com/gin-gonic/gin"
)

func (h *Handler) handleScreenShareStart(c *gin.Context) {
	var input ScreenShareRequest
	if err := c.ShouldBindJSON(&input); err != nil {
		httputil.AbortWithError(c, httputil.InvalidRequestError("parse screen share start", gin.H{"reason": err.Error()}))
		return
	}
	result, err := h.service.StartScreenShare(c.Request.Context(), input)
	writeScreenShareResult(c, result, err)
}

func (h *Handler) handleScreenSharePresent(c *gin.Context) {
	var input ScreenShareRequest
	if err := c.ShouldBindJSON(&input); err != nil {
		httputil.AbortWithError(c, httputil.InvalidRequestError("parse screen share present", gin.H{"reason": err.Error()}))
		return
	}
	result, err := h.service.PresentScreenShare(c.Request.Context(), input)
	writeScreenShareResult(c, result, err)
}

func (h *Handler) handleScreenShareVideo(c *gin.Context) {
	var input VideoStageRequest
	if err := c.ShouldBindJSON(&input); err != nil {
		httputil.AbortWithError(c, httputil.InvalidRequestError("parse screen share video", gin.H{"reason": err.Error()}))
		return
	}
	input.VideoURL = h.stageVideoURL(c.Request, firstNonEmpty(input.VideoURL, input.URL, input.Path))
	result, err := h.service.PresentVideoStage(c.Request.Context(), input)
	writeScreenShareResult(c, result, err)
}

func (h *Handler) handleScreenShareStop(c *gin.Context) {
	var input ScreenShareRequest
	if err := c.ShouldBindJSON(&input); err != nil {
		httputil.AbortWithError(c, httputil.InvalidRequestError("parse screen share stop", gin.H{"reason": err.Error()}))
		return
	}
	result, err := h.service.StopScreenShare(c.Request.Context(), input)
	writeScreenShareResult(c, result, err)
}

func writeScreenShareResult(c *gin.Context, result map[string]any, err error) {
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": err.Error()})
		return
	}
	status := http.StatusBadRequest
	if ok, _ := result["ok"].(bool); ok {
		status = http.StatusOK
	}
	c.JSON(status, result)
}
