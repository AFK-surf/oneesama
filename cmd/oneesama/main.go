// Command oneesama is the unified entry point for the slack-agent and
// meeting-agent HTTP services. The first positional argument selects the
// service (currently "slack-agent" or "meeting-agent"); ONEESAMA_* env vars
// and pkg/config control everything else.
//
// Why this exists:
//   - A single binary keeps deployment (`scripts/oneesama-live.sh`) simple
//     and ensures both services link the same revisions of internal packages.
//   - The shared httpserver / config / observability scaffolding is
//     identical, so we collapsed the per-service mains into one.
//
// See docs/architecture.md for the runtime layout and the corresponding
// internal/{slackagent,meetingagent} packages for the service-specific
// boot logic, health, and status endpoints.
package main

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strings"
	"time"

	"github.com/AFK-surf/oneesama/internal/httpserver"
	"github.com/AFK-surf/oneesama/internal/meetingagent"
	"github.com/AFK-surf/oneesama/internal/observability"
	"github.com/AFK-surf/oneesama/internal/slackagent"
	"github.com/AFK-surf/oneesama/internal/slackstartup"
	"github.com/AFK-surf/oneesama/pkg/config"
)

type serverBuilder func(cfg config.Config, logger *slog.Logger) *httpserver.ManagedServer

var subcommands = map[string]serverBuilder{
	"meeting-agent": meetingagent.NewServer,
	"slack-agent":   slackagent.NewServer,
}

func main() {
	os.Exit(run(os.Args[1:], os.Stderr))
}

func run(args []string, stderr io.Writer) int {
	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintf(stderr, "load config: %v\n", err)
		return 1
	}

	logger := observability.InitLogger(cfg.Logging.Level, cfg.Logging.Format).With("service", "oneesama")
	logger.Info("config loaded", "config", config.RedactForLogging(cfg))

	if len(args) < 1 {
		fmt.Fprintln(stderr, "usage: oneesama <slack-agent|meeting-agent>")
		return 1
	}

	subcommand := args[0]
	buildServer, ok := subcommands[subcommand]
	if !ok {
		fmt.Fprintf(stderr, "unknown subcommand: %s\n", subcommand)
		return 1
	}

	subcommandLogger := logger.With("subcommand", subcommand)
	if subcommand == "slack-agent" {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		if err := slackstartup.Validate(ctx, cfg); err != nil {
			subcommandLogger.Error("validate mode failed", "error", err)
			if isSlackValidateMode(args[1:]) {
				fmt.Fprintf(stderr, "validate mode: %v\n", err)
			} else {
				fmt.Fprintf(stderr, "slack-agent startup validation: %v\n", err)
			}
			return 1
		}
		slackstartup.ScrubProcessSecrets()
		if isSlackValidateMode(args[1:]) {
			subcommandLogger.Info("slack-agent validation succeeded; exiting because run mode is validate")
			return 0
		}
	}
	if err := httpserver.Serve(subcommandLogger, buildServer(cfg, subcommandLogger)); err != nil {
		subcommandLogger.Error("subcommand failed", "error", err)
		return 1
	}

	return 0
}

func isSlackValidateMode(args []string) bool {
	for _, arg := range args {
		switch strings.TrimSpace(arg) {
		case "--validate", "validate":
			return true
		}
	}
	return strings.TrimSpace(os.Getenv("SLACK_RUN_MODE")) == "validate" ||
		strings.TrimSpace(os.Getenv("SLACK_VALIDATE_ONLY")) == "1" ||
		strings.TrimSpace(os.Getenv("MAB_SLACK_RUN_MODE")) == "validate" ||
		strings.TrimSpace(os.Getenv("MAB_SLACK_VALIDATE_ONLY")) == "1" ||
		strings.TrimSpace(os.Getenv("ONEESAMA_SLACK_VALIDATE_ONLY")) == "1"
}
