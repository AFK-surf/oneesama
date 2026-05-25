package slackstartup

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
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
	if err := ValidateLiveTriagePosture(cfg); err != nil {
		return err
	}
	if err := ValidateMeetdHealth(ctx, LocalServiceURL(cfg.MeetingAgent.Listen)); err != nil {
		return err
	}
	if err := ValidateWebhookListen(cfg.SlackAgent.Listen); err != nil {
		return err
	}
	if err := ValidateBackendAuth(ctx, os.Getenv("BACKEND_URL"), os.Getenv("API_KEY")); err != nil {
		return err
	}
	if err := agentrunner.Preflight(ctx, cfg.AgentRunner); err != nil {
		return err
	}
	return nil
}

func ValidateLiveTriagePosture(cfg appconfig.Config) error {
	if legacySlackRuntimeAllowed() || slackRuntimeIsDryRun(cfg.AgentRunner) {
		return nil
	}
	if !slackRequiresLiveTriagePosture(cfg) {
		return nil
	}
	if got := normalizeSlackForegroundChain(cfg.Slack.Triage.ForegroundChain); got != "pi_first_live" {
		return fmt.Errorf("live slack-agent requires slack.triage.foreground_chain=pi_first_live; got %q", got)
	}
	if strings.TrimSpace(cfg.Slack.Triage.WorkspacePolicy) == "" {
		return fmt.Errorf("live slack-agent requires slack.triage.workspace_policy")
	}
	if got := normalizeRuntimeName(cfg.PersonaRuntime.Provider); got != "oneesama-pi" {
		return fmt.Errorf("live slack-agent requires persona_runtime.provider=oneesama-pi; got %q", cfg.PersonaRuntime.Provider)
	}
	if got := normalizeRuntimeName(cfg.PersonaRuntime.Mode); got != "live" {
		return fmt.Errorf("live slack-agent requires persona_runtime.mode=live; got %q", cfg.PersonaRuntime.Mode)
	}
	if cfg.PersonaRuntime.ShadowOnly {
		return fmt.Errorf("live slack-agent requires persona_runtime.shadow_only=false")
	}
	if firstEnv("ONEESAMA_PI_API_KEY", "PI_API_KEY", "OPENROUTER_API_KEY") == "" {
		return fmt.Errorf("live slack-agent requires Oneesama Pi API key; set ONEESAMA_PI_API_KEY, PI_API_KEY, or OPENROUTER_API_KEY")
	}
	return nil
}

func slackRequiresLiveTriagePosture(cfg appconfig.Config) bool {
	if normalizeSlackForegroundChain(cfg.Slack.Triage.ForegroundChain) == "pi_first_live" {
		return true
	}
	return cfg.Slack.EventBuffer.Enabled &&
		cfg.Slack.EventBuffer.Triage &&
		slackConfigLooksLikeLiveWorkspace(cfg)
}

func slackConfigLooksLikeLiveWorkspace(cfg appconfig.Config) bool {
	return cfg.Slack.Memory.Enabled &&
		(pathLooksLikeLiveWorkspace(cfg.Slack.WorkspaceDir) || pathLooksLikeLiveState(cfg.Persistence.DataDir))
}

func pathLooksLikeLiveWorkspace(value string) bool {
	normalized := filepath.ToSlash(strings.TrimSpace(value))
	return strings.HasSuffix(normalized, "/runtime/live-workspace") || normalized == "runtime/live-workspace"
}

func pathLooksLikeLiveState(value string) bool {
	normalized := filepath.ToSlash(strings.TrimSpace(value))
	return strings.HasSuffix(normalized, "/runtime/live-state") || normalized == "runtime/live-state"
}

func normalizeSlackForegroundChain(value string) string {
	return strings.NewReplacer("-", "_", " ", "_").Replace(strings.ToLower(strings.TrimSpace(value)))
}

func legacySlackRuntimeAllowed() bool {
	return envBool("ONEESAMA_LIVE_ALLOW_LEGACY_SLACK") ||
		envBool("ONEESAMA_ALLOW_LEGACY_SLACK") ||
		envBool("MAB_ALLOW_LEGACY_SLACK")
}

func slackRuntimeIsDryRun(cfg appconfig.AgentRunnerConfig) bool {
	return cfg.DryRun || normalizeRuntimeName(cfg.Provider) == "dry-run"
}

func normalizeRuntimeName(value string) string {
	return strings.NewReplacer("_", "-", " ", "-").Replace(strings.ToLower(strings.TrimSpace(value)))
}

func firstEnv(names ...string) string {
	for _, name := range names {
		if value := strings.TrimSpace(os.Getenv(name)); value != "" {
			return value
		}
	}
	return ""
}

func envBool(name string) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(name))) {
	case "1", "true", "yes", "y", "on":
		return true
	default:
		return false
	}
}

func ValidateBackendAuth(ctx context.Context, backendURL string, apiKey string) error {
	fatal, err := probeBackendAuth(ctx, backendURL, apiKey)
	if err == nil {
		return nil
	}
	if fatal {
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
