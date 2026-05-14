package slackstartup

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

var validationHTTPClient = &http.Client{Timeout: 5 * time.Second}

func Validate(ctx context.Context, cfg appconfig.Config) error {
	if strings.TrimSpace(cfg.Slack.BotToken) == "" {
		return fmt.Errorf("slack bot token is required")
	}
	if !strings.HasPrefix(strings.TrimSpace(cfg.Slack.BotToken), "xoxb-") {
		return fmt.Errorf("slack bot token must start with xoxb-")
	}
	if strings.TrimSpace(cfg.Slack.AppToken) == "" {
		return fmt.Errorf("slack app token is required")
	}
	if !strings.HasPrefix(strings.TrimSpace(cfg.Slack.AppToken), "xapp-") {
		return fmt.Errorf("slack app token must start with xapp-")
	}
	if err := ValidateMeetdHealth(ctx, LocalServiceURL(cfg.MeetingAgent.Listen)); err != nil {
		return err
	}
	if err := ValidateWebhookListen(cfg.SlackAgent.Listen); err != nil {
		return err
	}
	if err := agentrunner.Preflight(ctx, cfg.AgentRunner); err != nil {
		return err
	}
	return nil
}

func ValidateMeetdHealth(ctx context.Context, meetAgentdURL string) error {
	meetAgentdURL = strings.TrimRight(strings.TrimSpace(meetAgentdURL), "/")
	if meetAgentdURL == "" {
		return nil
	}

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, meetAgentdURL+"/health", nil)
	if err != nil {
		return fmt.Errorf("build meetd health probe request: %w", err)
	}
	response, err := validationHTTPClient.Do(request)
	if err != nil {
		return fmt.Errorf("meetd health probe request failed: %w", err)
	}
	defer response.Body.Close()

	if response.StatusCode == http.StatusOK {
		return nil
	}
	body, _ := io.ReadAll(io.LimitReader(response.Body, 512))
	bodyText := strings.TrimSpace(string(body))
	if bodyText == "" {
		bodyText = http.StatusText(response.StatusCode)
	}
	return fmt.Errorf("meetd health probe failed with status %d: %s", response.StatusCode, bodyText)
}

func ValidateWebhookListen(addr string) error {
	addr = strings.TrimSpace(addr)
	if addr == "" {
		return nil
	}
	listener, err := net.Listen("tcp", NormalizeListenAddress(addr))
	if err != nil {
		return fmt.Errorf("webhook listen probe failed for %s: %w", addr, err)
	}
	return listener.Close()
}

func NormalizeListenAddress(value string) string {
	raw := strings.TrimSpace(value)
	switch {
	case raw == "":
		return ""
	case strings.HasPrefix(raw, ":"):
		return "127.0.0.1" + raw
	case strings.Contains(raw, ":"):
		return raw
	default:
		return "127.0.0.1:" + raw
	}
}

func LocalServiceURL(listen string) string {
	address := strings.TrimSpace(listen)
	switch {
	case address == "":
		return ""
	case strings.HasPrefix(address, ":"):
		return fmt.Sprintf("http://127.0.0.1%s", address)
	case strings.HasPrefix(address, "0.0.0.0:"):
		return "http://127.0.0.1:" + strings.TrimPrefix(address, "0.0.0.0:")
	case strings.HasPrefix(address, "http://") || strings.HasPrefix(address, "https://"):
		return strings.TrimRight(address, "/")
	default:
		return "http://" + address
	}
}
