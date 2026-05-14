package slackagent

import (
	"github.com/AFK-surf/oneesama/internal/httputil"
	"github.com/AFK-surf/oneesama/internal/internalauth"
	"github.com/gin-gonic/gin"
)

const internalAuthHeader = internalauth.HeaderName

func (h *Handler) requireInternalAuth(c *gin.Context) {
	if internalauth.IsAuthorized(c.Request.RemoteAddr, h.service.internalAuthKey, c.GetHeader(internalauth.HeaderName)) {
		c.Next()
		return
	}
	httputil.AbortWithError(c, httputil.UnauthorizedError(
		"internal auth required",
		gin.H{"header": internalauth.HeaderName},
	))
}
