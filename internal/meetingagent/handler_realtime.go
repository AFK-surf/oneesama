package meetingagent

import (
	"errors"
	"io"
	"net/http"

	"github.com/AFK-surf/oneesama/internal/httputil"
	"github.com/gin-gonic/gin"
)

func (h *Handler) handleRealtimeConfig(c *gin.Context) {
	c.JSON(http.StatusOK, h.service.RealtimeConfig())
}

func (h *Handler) handleRealtimeClientSecret(c *gin.Context) {
	var input RealtimeSessionOptions
	if err := c.ShouldBindJSON(&input); err != nil && !errors.Is(err, io.EOF) {
		httputil.AbortWithError(c, httputil.InvalidRequestError("invalid request body", gin.H{"reason": err.Error()}))
		return
	}
	result, status, err := h.service.MintRealtimeClientSecret(c.Request.Context(), input)
	if err != nil {
		httputil.AbortWithError(c, httputil.InternalServerError("mint realtime client secret failed", gin.H{"reason": err.Error()}))
		return
	}
	c.JSON(status, result)
}
