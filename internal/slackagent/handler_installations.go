package slackagent

import (
	"net/http"
	"strings"

	"github.com/AFK-surf/oneesama/internal/httputil"
	"github.com/gin-gonic/gin"
)

func (h *Handler) handleListInstallations(c *gin.Context) {
	installations, err := h.service.ListInstallations(c.Request.Context())
	if err != nil {
		httputil.AbortWithError(c, httputil.InternalServerError("list slack installations failed", gin.H{"reason": err.Error()}))
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"ok":            true,
		"installations": installations,
	})
}

func (h *Handler) handleResolveInstallation(c *gin.Context) {
	query := SlackInstallationQuery{
		InstallationID: strings.TrimSpace(c.Query("installation_id")),
		TeamID:         strings.TrimSpace(c.Query("team_id")),
		EnterpriseID:   strings.TrimSpace(c.Query("enterprise_id")),
	}
	if query.InstallationID == "" && query.TeamID == "" && query.EnterpriseID == "" {
		httputil.AbortWithError(c, httputil.InvalidRequestError("installation lookup requires installation_id, team_id, or enterprise_id", nil))
		return
	}

	result, err := h.service.ResolveInstallation(c.Request.Context(), query)
	if err != nil {
		httputil.AbortWithError(c, httputil.InternalServerError("resolve slack installation failed", gin.H{"reason": err.Error()}))
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"ok":      true,
		"lookup":  result,
		"routing": gin.H{"multi_team_ready": true},
	})
}
