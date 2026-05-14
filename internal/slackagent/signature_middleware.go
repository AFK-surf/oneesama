package slackagent

import (
	"bytes"
	"io"

	"github.com/AFK-surf/oneesama/internal/httputil"
	"github.com/gin-gonic/gin"
)

func (h *Handler) requireSlackSignature(c *gin.Context) {
	rawBody, err := io.ReadAll(c.Request.Body)
	if err != nil {
		httputil.AbortWithError(c, httputil.InvalidRequestError("read request body", gin.H{"reason": err.Error()}))
		return
	}
	c.Request.Body = io.NopCloser(bytes.NewReader(rawBody))

	verification := h.service.VerifyRequest(
		string(rawBody),
		c.GetHeader("X-Slack-Request-Timestamp"),
		c.GetHeader("X-Slack-Signature"),
	)
	c.Set("slack_raw_body", string(rawBody))
	c.Set("slack_verification", verification)

	if !verification.OK {
		httputil.AbortWithError(c, httputil.UnauthorizedError(
			"slack signature verification failed",
			gin.H{"reason": verification.Reason},
		))
		return
	}
	c.Next()
}
