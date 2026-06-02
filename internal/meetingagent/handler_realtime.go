package meetingagent

import (
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/AFK-surf/oneesama/internal/httputil"
	"github.com/gin-gonic/gin"
)

func (h *Handler) handleRealtimeConfig(c *gin.Context) {
	c.JSON(http.StatusOK, h.service.RealtimeConfig())
}

func (h *Handler) handleRealtimeContextHealth(c *gin.Context) {
	c.JSON(http.StatusOK, h.service.RealtimeContextHealth(c.Request.Context()))
}

func (h *Handler) handleRealtimeClientSecret(c *gin.Context) {
	var input RealtimeSessionOptions
	if err := c.ShouldBindJSON(&input); err != nil && !errors.Is(err, io.EOF) {
		httputil.AbortWithError(c, httputil.InvalidRequestError("invalid request body", gin.H{"reason": err.Error()}))
		return
	}
	result, status, err := h.service.MintRealtimeClientSecret(c.Request.Context(), input)
	if err != nil {
		if status < http.StatusBadRequest {
			status = http.StatusInternalServerError
		}
		c.AbortWithStatusJSON(status, httputil.ErrorEnvelope{
			Error: httputil.APIError{
				Code:    httputil.CodeInternal,
				Message: "mint realtime client secret failed",
				Details: gin.H{"reason": err.Error()},
			},
		})
		return
	}
	c.JSON(status, result)
}

func (h *Handler) handleRealtimeTextTurn(c *gin.Context) {
	var input RealtimeTextTurnRequest
	if err := c.ShouldBindJSON(&input); err != nil && !errors.Is(err, io.EOF) {
		httputil.AbortWithError(c, httputil.InvalidRequestError("invalid request body", gin.H{"reason": err.Error()}))
		return
	}
	result, err := h.service.RequestRealtimeTextTurn(c.Request.Context(), input)
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

func (h *Handler) handleRealtimeEvent(c *gin.Context) {
	var raw map[string]any
	if err := c.ShouldBindJSON(&raw); err != nil && !errors.Is(err, io.EOF) {
		httputil.AbortWithError(c, httputil.InvalidRequestError("invalid request body", gin.H{"reason": err.Error()}))
		return
	}
	input := RealtimeEventRequest{
		SessionID: strings.TrimSpace(stringFromAny(raw["session_id"])),
		Event:     map[string]any{},
	}
	if event, ok := raw["event"].(map[string]any); ok {
		input.Event = event
	} else {
		input.Event = raw
		delete(input.Event, "session_id")
	}
	result, err := h.service.SendRealtimeEvent(c.Request.Context(), input)
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
