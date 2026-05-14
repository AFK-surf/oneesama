package slackagent

import (
	"net/http"

	"github.com/AFK-surf/oneesama/internal/httputil"
	"github.com/gin-gonic/gin"
)

type workspaceBootstrapRequest struct {
	WorkspaceDir string `json:"workspace_dir"`
}

type runtimeValidateRequest struct {
	MeetingAgentURL    string `json:"meeting_agent_url"`
	WebhookListen      string `json:"webhook_listen"`
	RequireSlackTokens bool   `json:"require_slack_tokens"`
}

func (h *Handler) handleWorkspaceBootstrap(c *gin.Context) {
	var request workspaceBootstrapRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		httputil.AbortWithError(c, httputil.InvalidRequestError("invalid workspace bootstrap body", gin.H{"reason": err.Error()}))
		return
	}

	result := h.service.BootstrapWorkspace(WorkspaceBootstrapInput{WorkspaceDir: request.WorkspaceDir})
	c.JSON(http.StatusOK, result)
}

func (h *Handler) handleRuntimeValidate(c *gin.Context) {
	var request runtimeValidateRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		httputil.AbortWithError(c, httputil.InvalidRequestError("invalid runtime validate body", gin.H{"reason": err.Error()}))
		return
	}

	result := h.service.ValidateRuntime(c.Request.Context(), RuntimeValidationInput{
		MeetingAgentURL:    request.MeetingAgentURL,
		WebhookListen:      request.WebhookListen,
		RequireSlackTokens: request.RequireSlackTokens,
	})
	c.JSON(http.StatusOK, result)
}
