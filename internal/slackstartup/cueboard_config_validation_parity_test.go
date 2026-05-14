//go:build cueboardparity

package slackstartup

import (
	"context"
	"strings"
	"testing"
	"time"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestCueboardParityValidateRequiresSlackAppToken(t *testing.T) {
	cfg := cueboardConfigValidationBase()
	cfg.Slack.AppToken = ""

	err := Validate(context.Background(), cfg)
	if err == nil || !strings.Contains(err.Error(), "slack app token is required") {
		t.Fatalf("Validate error = %v, want app token required", err)
	}
}

func TestCueboardParityValidateRejectsSlackTokenPrefixes(t *testing.T) {
	t.Run("bot token", func(t *testing.T) {
		cfg := cueboardConfigValidationBase()
		cfg.Slack.BotToken = "bad-token"
		err := Validate(context.Background(), cfg)
		if err == nil || !strings.Contains(err.Error(), "xoxb-") {
			t.Fatalf("Validate error = %v, want xoxb prefix error", err)
		}
	})

	t.Run("app token", func(t *testing.T) {
		cfg := cueboardConfigValidationBase()
		cfg.Slack.AppToken = "bad-token"
		err := Validate(context.Background(), cfg)
		if err == nil || !strings.Contains(err.Error(), "xapp-") {
			t.Fatalf("Validate error = %v, want xapp prefix error", err)
		}
	})
}

func cueboardConfigValidationBase() appconfig.Config {
	return appconfig.Config{
		Slack: appconfig.SlackConfig{
			BotToken: "xoxb-valid-token",
			AppToken: "xapp-valid-token",
		},
		SlackAgent:   appconfig.ServiceConfig{Listen: "127.0.0.1:0"},
		MeetingAgent: appconfig.ServiceConfig{Listen: ""},
		AgentRunner:  appconfig.AgentRunnerConfig{Provider: "dry-run", DryRun: true, JobTimeout: time.Minute},
	}
}
