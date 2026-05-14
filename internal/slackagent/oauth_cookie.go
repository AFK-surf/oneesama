package slackagent

import (
	"crypto/subtle"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

func setSlackOAuthStateCookie(c *gin.Context, state string, publicBaseURL string) {
	http.SetCookie(c.Writer, &http.Cookie{
		Name:     slackOAuthStateCookie,
		Value:    state,
		Path:     "/slack/oauth",
		MaxAge:   slackOAuthStateMaxAgeSeconds,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   isSecureCookieRequest(c.Request, publicBaseURL),
	})
}

func clearSlackOAuthStateCookie(c *gin.Context, publicBaseURL string) {
	http.SetCookie(c.Writer, &http.Cookie{
		Name:     slackOAuthStateCookie,
		Value:    "",
		Path:     "/slack/oauth",
		MaxAge:   -1,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   isSecureCookieRequest(c.Request, publicBaseURL),
	})
}

func isSecureCookieRequest(request *http.Request, publicBaseURL string) bool {
	if request != nil {
		if request.TLS != nil {
			return true
		}
		if strings.EqualFold(strings.TrimSpace(request.Header.Get("X-Forwarded-Proto")), "https") {
			return true
		}
	}
	return strings.HasPrefix(strings.ToLower(strings.TrimSpace(publicBaseURL)), "https://")
}

func slackOAuthStateMatches(expected string, actual string) bool {
	if strings.TrimSpace(expected) == "" || strings.TrimSpace(actual) == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(expected), []byte(actual)) == 1
}
