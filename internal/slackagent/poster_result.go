package slackagent

import (
	"fmt"
	"net/http"
	"strings"
)

func shouldRetrySlackPost(result PostMessageResult) bool {
	if result.Error == "request_failed" || result.Error == "request_cancelled" {
		return true
	}
	switch result.Status {
	case http.StatusTooManyRequests, http.StatusInternalServerError, http.StatusBadGateway, http.StatusServiceUnavailable, http.StatusGatewayTimeout:
		return true
	}
	if result.Body == nil {
		return false
	}
	switch result.Body.Error {
	case "ratelimited", "internal_error", "fatal_error":
		return true
	default:
		return false
	}
}

func slackPostError(status int, body SlackPostMessageBody) string {
	if status >= 200 && status < 300 && body.OK {
		return ""
	}
	if body.Error != "" {
		return body.Error
	}
	if status == 0 {
		return "request_failed"
	}
	return fmt.Sprintf("http_%d", status)
}

func threadTSForResult(fallback string, body *SlackPostMessageBody) string {
	if body != nil && body.Message != nil && strings.TrimSpace(body.Message.ThreadTS) != "" {
		return body.Message.ThreadTS
	}
	return fallback
}
