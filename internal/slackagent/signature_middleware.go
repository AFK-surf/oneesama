package slackagent

import (
	"bytes"
	"errors"
	"io"
	"net/http"

	"github.com/AFK-surf/oneesama/internal/httputil"
	"github.com/gin-gonic/gin"
)

const (
	slackSignedRequestBodyLimit = 1 << 20
	slackInternalJSONBodyLimit  = 1 << 20
)

func (h *Handler) requireSlackSignature(c *gin.Context) {
	rawBody, ok := readLimitedRequestBody(c, slackSignedRequestBodyLimit, "read request body")
	if !ok {
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

func readLimitedRequestBody(c *gin.Context, limit int64, message string) ([]byte, bool) {
	rawBody, err := io.ReadAll(http.MaxBytesReader(c.Writer, c.Request.Body, limit))
	if err == nil {
		return rawBody, true
	}
	var maxBytesErr *http.MaxBytesError
	if errors.As(err, &maxBytesErr) {
		httputil.AbortWithError(c, requestBodyTooLargeError(message, limit))
		return nil, false
	}
	httputil.AbortWithError(c, httputil.InvalidRequestError(message, gin.H{"reason": err.Error()}))
	return nil, false
}

func requestBodyTooLargeError(message string, limit int64) *httputil.HTTPError {
	return &httputil.HTTPError{
		Status: http.StatusRequestEntityTooLarge,
		Payload: httputil.APIError{
			Code:    httputil.CodeInvalidRequest,
			Message: message,
			Details: gin.H{"reason": "request body too large", "max_bytes": limit},
		},
	}
}

func bindLimitedJSON(c *gin.Context, limit int64, target any) error {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, limit)
	return c.ShouldBindJSON(target)
}

func isRequestBodyTooLarge(err error) bool {
	var maxBytesErr *http.MaxBytesError
	return errors.As(err, &maxBytesErr)
}
