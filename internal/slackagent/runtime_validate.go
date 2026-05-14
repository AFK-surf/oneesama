package slackagent

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/AFK-surf/oneesama/internal/httputil"
)

type RuntimeProbeResult struct {
	Name                    string `json:"name"`
	OK                      bool   `json:"ok"`
	Skipped                 bool   `json:"skipped,omitempty"`
	Reason                  string `json:"reason,omitempty"`
	Status                  int    `json:"status,omitempty"`
	URL                     string `json:"url,omitempty"`
	Body                    string `json:"body,omitempty"`
	Listen                  string `json:"listen,omitempty"`
	Error                   string `json:"error,omitempty"`
	BotTokenConfigured      bool   `json:"bot_token_configured,omitempty"`
	AppTokenConfigured      bool   `json:"app_token_configured,omitempty"`
	SigningSecretConfigured bool   `json:"signing_secret_configured,omitempty"`
	Required                bool   `json:"required,omitempty"`
}

func probeMeetingAgentHealth(ctx context.Context, meetingAgentURL string) RuntimeProbeResult {
	baseURL := strings.TrimRight(strings.TrimSpace(meetingAgentURL), "/")
	if baseURL == "" {
		return RuntimeProbeResult{Name: "meeting_agent_health", OK: true, Skipped: true, Reason: "meeting_agent_url_empty"}
	}

	client := httputil.NewHTTPClient(3 * time.Second)
	var last RuntimeProbeResult
	for _, path := range []string{"/healthz", "/health"} {
		url := baseURL + path
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return RuntimeProbeResult{Name: "meeting_agent_health", OK: false, URL: url, Error: err.Error()}
		}
		response, err := client.Do(request)
		if err != nil {
			if path == "/health" {
				return RuntimeProbeResult{Name: "meeting_agent_health", OK: false, URL: url, Error: err.Error()}
			}
			continue
		}
		bodyBytes, _ := io.ReadAll(io.LimitReader(response.Body, 512))
		_ = response.Body.Close()
		result := RuntimeProbeResult{
			Name:   "meeting_agent_health",
			OK:     response.StatusCode >= 200 && response.StatusCode < 300,
			Status: response.StatusCode,
			URL:    url,
			Body:   string(bodyBytes),
		}
		if result.OK || path == "/health" {
			return result
		}
		last = result
	}

	if last.Name != "" {
		return last
	}
	return RuntimeProbeResult{Name: "meeting_agent_health", OK: false, URL: baseURL, Error: "health_probe_failed"}
}

func probeWebhookListen(rawListen string) RuntimeProbeResult {
	listen := strings.TrimSpace(rawListen)
	if listen == "" {
		return RuntimeProbeResult{Name: "webhook_listen", OK: true, Skipped: true, Reason: "webhook_listen_empty"}
	}

	address, err := normalizeListenAddress(listen)
	if err != nil {
		return RuntimeProbeResult{Name: "webhook_listen", OK: false, Listen: listen, Error: err.Error()}
	}

	listener, err := net.Listen("tcp", address)
	if err != nil {
		return RuntimeProbeResult{Name: "webhook_listen", OK: false, Listen: listen, Error: err.Error()}
	}
	_ = listener.Close()
	return RuntimeProbeResult{Name: "webhook_listen", OK: true, Listen: listen}
}

func normalizeListenAddress(value string) (string, error) {
	raw := strings.TrimSpace(value)
	switch {
	case raw == "":
		return "", fmt.Errorf("listen address is empty")
	case strings.HasPrefix(raw, ":"):
		return "127.0.0.1" + raw, nil
	case strings.Contains(raw, ":"):
		return raw, nil
	default:
		return "127.0.0.1:" + raw, nil
	}
}
