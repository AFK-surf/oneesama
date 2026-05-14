package slackagent

import (
	"errors"
	"net/http"
	"strings"

	"github.com/AFK-surf/oneesama/internal/httputil"
	"github.com/gin-gonic/gin"
)

func (h *Handler) handleInstall(c *gin.Context) {
	flow, err := h.service.BeginInstall()
	if err != nil {
		httputil.AbortWithError(c, httputil.InvalidRequestError("slack oauth install is not configured", gin.H{"reason": err.Error()}))
		return
	}

	if strings.EqualFold(c.Query("format"), "json") {
		if flow.Response.OAuthConfigured {
			setSlackOAuthStateCookie(c, flow.State, h.service.publicBaseURL)
		}
		c.JSON(http.StatusOK, flow.Response)
		return
	}
	if !flow.Response.OAuthConfigured {
		httputil.AbortWithError(c, httputil.InvalidRequestError("slack oauth install is not configured", gin.H{
			"client_id_configured":     flow.Response.ClientIDConfigured,
			"client_secret_configured": flow.Response.ClientSecretConfigured,
		}))
		return
	}
	setSlackOAuthStateCookie(c, flow.State, h.service.publicBaseURL)
	c.Redirect(http.StatusFound, flow.Response.InstallURL)
}

func (h *Handler) handleOAuthCallback(c *gin.Context) {
	if slackError := strings.TrimSpace(c.Query("error")); slackError != "" {
		clearSlackOAuthStateCookie(c, h.service.publicBaseURL)
		httputil.AbortWithError(c, httputil.InvalidRequestError("slack oauth callback returned an error", gin.H{"reason": slackError}))
		return
	}

	code := strings.TrimSpace(c.Query("code"))
	if code == "" {
		httputil.AbortWithError(c, httputil.InvalidRequestError("missing slack oauth code", gin.H{"query": "code"}))
		return
	}

	expectedState, err := c.Cookie(slackOAuthStateCookie)
	if err != nil {
		httputil.AbortWithError(c, httputil.UnauthorizedError("missing slack oauth state cookie", gin.H{"cookie": slackOAuthStateCookie}))
		return
	}
	actualState := strings.TrimSpace(c.Query("state"))
	if !slackOAuthStateMatches(expectedState, actualState) {
		clearSlackOAuthStateCookie(c, h.service.publicBaseURL)
		httputil.AbortWithError(c, httputil.UnauthorizedError("slack oauth state mismatch", gin.H{"cookie": slackOAuthStateCookie}))
		return
	}

	result, err := h.service.CompleteOAuth(c.Request.Context(), code)
	if err != nil {
		clearSlackOAuthStateCookie(c, h.service.publicBaseURL)
		var exchangeErr *SlackOAuthExchangeError
		switch {
		case errors.Is(err, errSlackOAuthNotConfigured):
			httputil.AbortWithError(c, httputil.InvalidRequestError("slack oauth client credentials are not configured", nil))
		case errors.As(err, &exchangeErr):
			httputil.AbortWithError(c, httputil.InvalidRequestError("slack oauth exchange failed", gin.H{"reason": exchangeErr.Reason, "status": exchangeErr.Status}))
		default:
			httputil.AbortWithError(c, httputil.InternalServerError("slack oauth callback failed", gin.H{"reason": err.Error()}))
		}
		return
	}

	clearSlackOAuthStateCookie(c, h.service.publicBaseURL)
	c.JSON(http.StatusOK, result)
}
