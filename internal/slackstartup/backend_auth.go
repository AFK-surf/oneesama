package slackstartup

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
)

var backendProbeHTTPClient = http.DefaultClient

func probeBackendAuth(ctx context.Context, backendURL string, apiKey string) (fatal bool, err error) {
	backendURL = strings.TrimRight(strings.TrimSpace(backendURL), "/")
	apiKey = strings.TrimSpace(apiKey)
	if backendURL == "" || apiKey == "" {
		return false, nil
	}

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, backendURL+"/v1/llm/models", nil)
	if err != nil {
		return false, fmt.Errorf("build backend auth probe request: %w", err)
	}
	request.Header.Set("Authorization", "Bearer "+apiKey)

	response, err := backendProbeHTTPClient.Do(request)
	if err != nil {
		return false, fmt.Errorf("backend auth probe request failed: %w", err)
	}
	defer response.Body.Close()

	body, _ := io.ReadAll(io.LimitReader(response.Body, 512))
	bodyText := strings.TrimSpace(string(body))

	switch response.StatusCode {
	case http.StatusOK:
		return false, nil
	case http.StatusUnauthorized, http.StatusForbidden:
		return true, fmt.Errorf("backend auth probe failed with status %d: %s", response.StatusCode, bodyText)
	default:
		if bodyText == "" {
			bodyText = http.StatusText(response.StatusCode)
		}
		return false, fmt.Errorf("backend auth probe returned status %d: %s", response.StatusCode, bodyText)
	}
}
