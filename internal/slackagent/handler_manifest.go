package slackagent

import (
	"net/http"

	"github.com/AFK-surf/oneesama/internal/httputil"
	"github.com/gin-gonic/gin"
)

type manifestValidateRequest struct {
	Manifest           map[string]any `json:"manifest"`
	AppManifest        map[string]any `json:"app_manifest"`
	RequireRecommended bool           `json:"require_recommended"`
}

func (h *Handler) handleAppManifest(c *gin.Context) {
	manifest := h.service.BuildManifest()
	c.JSON(http.StatusOK, gin.H{
		"ok":       true,
		"manifest": manifest,
	})
}

func (h *Handler) handleValidateAppManifest(c *gin.Context) {
	var request manifestValidateRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		httputil.AbortWithError(c, httputil.InvalidRequestError("invalid manifest validate body", gin.H{"reason": err.Error()}))
		return
	}

	rawManifest := request.Manifest
	if len(rawManifest) == 0 {
		rawManifest = request.AppManifest
	}
	if len(rawManifest) == 0 {
		httputil.AbortWithError(c, httputil.InvalidRequestError("manifest is required", nil))
		return
	}

	manifest, err := parseSlackManifest(rawManifest)
	if err != nil {
		httputil.AbortWithError(c, httputil.InvalidRequestError("parse manifest", gin.H{"reason": err.Error()}))
		return
	}

	validation := h.service.ValidateManifest(manifest, request.RequireRecommended)
	c.JSON(http.StatusOK, gin.H{
		"ok":         validation.OK,
		"validation": validation,
		"expected":   h.service.BuildManifest(),
	})
}
