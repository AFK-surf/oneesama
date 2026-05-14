package meetingagent

import (
	"errors"
	"io"
	"net/http"

	"github.com/AFK-surf/oneesama/internal/httputil"
	"github.com/gin-gonic/gin"
)

func (h *Handler) handleDialogProviders(c *gin.Context) {
	c.JSON(http.StatusOK, h.service.DialogProviders())
}

func (h *Handler) handleTTSSynthesize(c *gin.Context) {
	var input TTSSynthesizeRequest
	if err := c.ShouldBindJSON(&input); err != nil && !errors.Is(err, io.EOF) {
		httputil.AbortWithError(c, httputil.InvalidRequestError("invalid request body", gin.H{"reason": err.Error()}))
		return
	}
	result, status := h.service.SynthesizeTTS(c.Request.Context(), input)
	c.JSON(status, result)
}

func (h *Handler) handleDialogTurn(c *gin.Context) {
	var input DialogTurnRequest
	if err := c.ShouldBindJSON(&input); err != nil && !errors.Is(err, io.EOF) {
		httputil.AbortWithError(c, httputil.InvalidRequestError("invalid request body", gin.H{"reason": err.Error()}))
		return
	}
	result := h.service.RunDialogTurn(c.Request.Context(), input)
	if result["error"] == "utterance_required" {
		c.JSON(http.StatusBadRequest, result)
		return
	}
	c.JSON(http.StatusOK, result)
}
