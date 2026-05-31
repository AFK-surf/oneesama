package scripts_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestOneesamaLivePreflightReenablesAllexportForEachEnvFile(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	firstEnv := filepath.Join(dir, "live-env.sh")
	secondEnv := filepath.Join(dir, "live-env-from-proc.sh")
	writeFile(t, firstEnv, strings.Join([]string{
		"SLACK_BOT_TOKEN=xoxb-test",
		"SLACK_APP_TOKEN=xapp-test",
		"ONEESAMA_AGENT_RUNNER=codex",
		"ONEESAMA_CODEX_BASE_URL=https://gateway.example.test/openrouter",
		"ONEESAMA_CODEX_ENV_KEY=ONEESAMA_TEST_CODEX_TOKEN",
		"ONEESAMA_SLACK_TRIAGE_FOREGROUND_CHAIN=pi_first_live",
		"ONEESAMA_SLACK_TRIAGE_WORKSPACE_POLICY='AI agent news gets concise workspace-aware comments'",
		"ONEESAMA_PERSONA_RUNTIME=oneesama-pi",
		"ONEESAMA_PERSONA_RUNTIME_MODE=live",
		"ONEESAMA_PERSONA_RUNTIME_SHADOW_ONLY=false",
		"ONEESAMA_PI_API_KEY=test-key",
		"set +a",
		"",
	}, "\n"))
	writeFile(t, secondEnv, "ONEESAMA_TEST_CODEX_TOKEN=secret-token\n")

	output, err := runLiveScript(t, "--env", firstEnv, "--env", secondEnv, "--preflight-only", "slack-agent")
	if err != nil {
		t.Fatalf("oneesama-live preflight failed: %v\n%s", err, output)
	}
	if !strings.Contains(output, "preflight passed") {
		t.Fatalf("output = %s, want preflight passed", output)
	}
	if !strings.Contains(output, "ONEESAMA_TEST_CODEX_TOKEN exported (length 12)") {
		t.Fatalf("output = %s, want provider token length", output)
	}
}

func TestOneesamaLivePreflightLoadsDefaultWorkspacePolicyFile(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	defaultEnvDir := filepath.Join(dir, "tmp")
	if err := os.MkdirAll(defaultEnvDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(defaultEnvDir, "oneesama-r24-a-window"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(defaultEnvDir, "oneesama-r24-a-window", "live-env.sh"), strings.Join([]string{
		"SLACK_BOT_TOKEN=xoxb-test",
		"SLACK_APP_TOKEN=xapp-test",
		"ONEESAMA_AGENT_RUNNER=dry-run",
		"ONEESAMA_PERSONA_RUNTIME=oneesama-pi",
		"ONEESAMA_PERSONA_RUNTIME_MODE=live",
		"ONEESAMA_PERSONA_RUNTIME_SHADOW_ONLY=false",
		"ONEESAMA_PI_API_KEY=test-key",
		"",
	}, "\n"))
	writeFile(t, filepath.Join(defaultEnvDir, "oneesama-workspace-triage-policy.sh"), strings.Join([]string{
		"ONEESAMA_SLACK_TRIAGE_FOREGROUND_CHAIN=pi_first_live",
		"ONEESAMA_SLACK_TRIAGE_WORKSPACE_POLICY='AI agent news gets concise workspace-aware comments'",
		"",
	}, "\n"))

	output, err := runLiveScriptWithEnv(t, []string{
		"PATH=" + os.Getenv("PATH"),
		"ONEESAMA_LIVE_DEFAULT_ENV_DIR=" + defaultEnvDir,
	}, "--preflight-only", "slack-agent")
	if err != nil {
		t.Fatalf("oneesama-live preflight failed: %v\n%s", err, output)
	}
	if !strings.Contains(output, "source env file with allexport: "+filepath.Join(defaultEnvDir, "oneesama-workspace-triage-policy.sh")) {
		t.Fatalf("output = %s, want workspace policy env sourced", output)
	}
	if !strings.Contains(output, "triage foreground chain = pi_first_live") {
		t.Fatalf("output = %s, want foreground chain logged", output)
	}
	if !strings.Contains(output, "workspace triage policy exported") {
		t.Fatalf("output = %s, want workspace policy logged", output)
	}
}

func TestOneesamaLivePreflightDefaultsToPersistentConfigEnvDir(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	home := filepath.Join(dir, "home")
	defaultEnvDir := filepath.Join(home, ".config", "oneesama", "live-env")
	if err := os.MkdirAll(filepath.Join(defaultEnvDir, "oneesama-r24-a-window"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(defaultEnvDir, "oneesama-r24-a-window", "live-env.sh"), strings.Join([]string{
		"SLACK_BOT_TOKEN=xoxb-test",
		"SLACK_APP_TOKEN=xapp-test",
		"ONEESAMA_AGENT_RUNNER=dry-run",
		"ONEESAMA_PERSONA_RUNTIME=oneesama-pi",
		"ONEESAMA_PERSONA_RUNTIME_MODE=live",
		"ONEESAMA_PERSONA_RUNTIME_SHADOW_ONLY=false",
		"ONEESAMA_PI_API_KEY=test-key",
		"",
	}, "\n"))
	writeFile(t, filepath.Join(defaultEnvDir, "oneesama-workspace-triage-policy.sh"), strings.Join([]string{
		"ONEESAMA_SLACK_TRIAGE_FOREGROUND_CHAIN=pi_first_live",
		"ONEESAMA_SLACK_TRIAGE_WORKSPACE_POLICY='AI agent news gets concise workspace-aware comments'",
		"",
	}, "\n"))

	output, err := runLiveScriptWithEnv(t, []string{
		"PATH=" + os.Getenv("PATH"),
		"HOME=" + home,
	}, "--preflight-only", "slack-agent")
	if err != nil {
		t.Fatalf("oneesama-live preflight failed: %v\n%s", err, output)
	}
	if !strings.Contains(output, "source env file with allexport: "+filepath.Join(defaultEnvDir, "oneesama-workspace-triage-policy.sh")) {
		t.Fatalf("output = %s, want persistent default env dir", output)
	}
	if strings.Contains(output, "/tmp/oneesama-") || strings.Contains(output, "/private/tmp/oneesama-") {
		t.Fatalf("output = %s, should not use tmp defaults", output)
	}
}

func TestOneesamaLivePreflightFailsMissingProviderToken(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	envFile := filepath.Join(dir, "live-env.sh")
	writeFile(t, envFile, strings.Join([]string{
		"SLACK_BOT_TOKEN=xoxb-test",
		"SLACK_APP_TOKEN=xapp-test",
		"ONEESAMA_AGENT_RUNNER=codex",
		"ONEESAMA_CODEX_BASE_URL=https://gateway.example.test/openrouter",
		"ONEESAMA_CODEX_ENV_KEY=ONEESAMA_TEST_MISSING_TOKEN",
		"ONEESAMA_SLACK_TRIAGE_FOREGROUND_CHAIN=pi_first_live",
		"ONEESAMA_SLACK_TRIAGE_WORKSPACE_POLICY='AI agent news gets concise workspace-aware comments'",
		"ONEESAMA_PERSONA_RUNTIME=oneesama-pi",
		"ONEESAMA_PERSONA_RUNTIME_MODE=live",
		"ONEESAMA_PERSONA_RUNTIME_SHADOW_ONLY=false",
		"ONEESAMA_PI_API_KEY=test-key",
		"",
	}, "\n"))

	output, err := runLiveScript(t, "--env", envFile, "--preflight-only", "slack-agent")
	if err == nil {
		t.Fatalf("oneesama-live preflight succeeded unexpectedly:\n%s", output)
	}
	if !strings.Contains(output, "ONEESAMA_TEST_MISSING_TOKEN is required but not exported") {
		t.Fatalf("output = %s, want missing provider token", output)
	}
}

func TestOneesamaLivePreflightFailsConflictingWorkspacePolicyAliases(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	firstEnv := filepath.Join(dir, "live-env.sh")
	secondEnv := filepath.Join(dir, "workspace-policy.sh")
	writeFile(t, firstEnv, strings.Join([]string{
		"SLACK_BOT_TOKEN=xoxb-test",
		"SLACK_APP_TOKEN=xapp-test",
		"ONEESAMA_AGENT_RUNNER=dry-run",
		"ONEESAMA_SLACK_TRIAGE_WORKSPACE_POLICY='reply to workspace product links'",
		"",
	}, "\n"))
	writeFile(t, secondEnv, strings.Join([]string{
		"MAB_SLACK_TRIAGE_WORKSPACE_POLICY='legacy office-helper policy'",
		"",
	}, "\n"))

	output, err := runLiveScript(t, "--env", firstEnv, "--env", secondEnv, "--preflight-only", "slack-agent")
	if err == nil {
		t.Fatalf("oneesama-live preflight succeeded unexpectedly:\n%s", output)
	}
	if !strings.Contains(output, "workspace triage policy has conflicting env aliases") ||
		!strings.Contains(output, "ONEESAMA_SLACK_TRIAGE_WORKSPACE_POLICY and MAB_SLACK_TRIAGE_WORKSPACE_POLICY differ") {
		t.Fatalf("output = %s, want workspace policy conflict", output)
	}
	if strings.Contains(output, "legacy office-helper policy") || strings.Contains(output, "reply to workspace product links") {
		t.Fatalf("output = %s, should not print policy values", output)
	}
}

func TestOneesamaLivePreflightAllowsIdenticalAliasValues(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	envFile := filepath.Join(dir, "live-env.sh")
	writeFile(t, envFile, strings.Join([]string{
		"SLACK_BOT_TOKEN=xoxb-test",
		"ONEESAMA_SLACK_BOT_TOKEN=xoxb-test",
		"SLACK_APP_TOKEN=xapp-test",
		"MAB_SLACK_APP_TOKEN=xapp-test",
		"ONEESAMA_AGENT_RUNNER=dry-run",
		"ONEESAMA_SLACK_TRIAGE_FOREGROUND_CHAIN=pi_first_live",
		"MAB_SLACK_TRIAGE_FOREGROUND_CHAIN=pi_first_live",
		"ONEESAMA_SLACK_TRIAGE_WORKSPACE_POLICY='AI agent news gets concise workspace-aware comments'",
		"ONEESAMA_PERSONA_RUNTIME=oneesama-pi",
		"ONEESAMA_PERSONA_RUNTIME_MODE=live",
		"ONEESAMA_PERSONA_RUNTIME_SHADOW_ONLY=false",
		"ONEESAMA_PI_API_KEY=test-key",
		"",
	}, "\n"))

	output, err := runLiveScript(t, "--env", envFile, "--preflight-only", "slack-agent")
	if err != nil {
		t.Fatalf("oneesama-live preflight failed: %v\n%s", err, output)
	}
	for _, want := range []string{
		"Slack bot token aliases agree across 2 env vars",
		"Slack app token aliases agree across 2 env vars",
		"triage foreground chain aliases agree across 2 env vars",
		"preflight passed",
	} {
		if !strings.Contains(output, want) {
			t.Fatalf("output = %s, want %q", output, want)
		}
	}
}

func TestOneesamaLivePreflightFailsConflictingPersonaRuntimeAliases(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	envFile := filepath.Join(dir, "live-env.sh")
	writeFile(t, envFile, strings.Join([]string{
		"SLACK_BOT_TOKEN=xoxb-test",
		"SLACK_APP_TOKEN=xapp-test",
		"ONEESAMA_AGENT_RUNNER=dry-run",
		"ONEESAMA_PERSONA_RUNTIME=oneesama-pi",
		"MAB_PERSONA_RUNTIME=legacy",
		"ONEESAMA_PI_API_KEY=test-key",
		"",
	}, "\n"))

	output, err := runLiveScript(t, "--env", envFile, "--preflight-only", "slack-agent")
	if err == nil {
		t.Fatalf("oneesama-live preflight succeeded unexpectedly:\n%s", output)
	}
	if !strings.Contains(output, "persona runtime provider has conflicting env aliases") ||
		!strings.Contains(output, "ONEESAMA_PERSONA_RUNTIME and MAB_PERSONA_RUNTIME differ") {
		t.Fatalf("output = %s, want persona runtime conflict", output)
	}
}

func TestOneesamaLivePreflightFailsConflictingStateProviderAliases(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	envFile := filepath.Join(dir, "live-env.sh")
	writeFile(t, envFile, strings.Join([]string{
		"ONEESAMA_AGENT_RUNNER=dry-run",
		"ONEESAMA_STATE_PROVIDER=json-file",
		"MAB_STATE_PROVIDER=sqlite",
		"",
	}, "\n"))

	output, err := runLiveScript(t, "--env", envFile, "--preflight-only", "meeting-agent")
	if err == nil {
		t.Fatalf("oneesama-live preflight succeeded unexpectedly:\n%s", output)
	}
	if !strings.Contains(output, "state provider has conflicting env aliases") ||
		!strings.Contains(output, "ONEESAMA_STATE_PROVIDER and MAB_STATE_PROVIDER differ") {
		t.Fatalf("output = %s, want state provider conflict", output)
	}
}

func TestOneesamaLivePreflightRequiresOneesamaPiKey(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	envFile := filepath.Join(dir, "live-env.sh")
	writeFile(t, envFile, strings.Join([]string{
		"SLACK_BOT_TOKEN=xoxb-test",
		"SLACK_APP_TOKEN=xapp-test",
		"ONEESAMA_AGENT_RUNNER=dry-run",
		"ONEESAMA_SLACK_TRIAGE_FOREGROUND_CHAIN=pi_first_live",
		"ONEESAMA_SLACK_TRIAGE_WORKSPACE_POLICY='AI agent news gets concise workspace-aware comments'",
		"ONEESAMA_PERSONA_RUNTIME=oneesama-pi",
		"ONEESAMA_PERSONA_RUNTIME_MODE=live",
		"ONEESAMA_PERSONA_RUNTIME_SHADOW_ONLY=false",
		"",
	}, "\n"))

	output, err := runLiveScript(t, "--env", envFile, "--preflight-only", "slack-agent")
	if err == nil {
		t.Fatalf("oneesama-live preflight succeeded unexpectedly:\n%s", output)
	}
	if !strings.Contains(output, "Oneesama Pi API key is required") {
		t.Fatalf("output = %s, want missing Oneesama Pi API key", output)
	}

	envWithKey := filepath.Join(dir, "live-env-with-key.sh")
	writeFile(t, envWithKey, strings.Join([]string{
		"SLACK_BOT_TOKEN=xoxb-test",
		"SLACK_APP_TOKEN=xapp-test",
		"ONEESAMA_AGENT_RUNNER=dry-run",
		"ONEESAMA_SLACK_TRIAGE_FOREGROUND_CHAIN=pi_first_live",
		"ONEESAMA_SLACK_TRIAGE_WORKSPACE_POLICY='AI agent news gets concise workspace-aware comments'",
		"ONEESAMA_PERSONA_RUNTIME=oneesama-pi",
		"ONEESAMA_PERSONA_RUNTIME_MODE=live",
		"ONEESAMA_PERSONA_RUNTIME_SHADOW_ONLY=false",
		"ONEESAMA_PI_API_KEY=test-key",
		"ONEESAMA_PI_MODEL=test-model",
		"",
	}, "\n"))
	output, err = runLiveScript(t, "--env", envWithKey, "--preflight-only", "slack-agent")
	if err != nil {
		t.Fatalf("oneesama-live preflight failed: %v\n%s", err, output)
	}
	if !strings.Contains(output, "Oneesama Pi runtime provider selected") || !strings.Contains(output, "Oneesama Pi model = test-model") {
		t.Fatalf("output = %s, want Oneesama Pi provider/model logs", output)
	}
}

func TestOneesamaLivePreflightRejectsLegacySlackPosture(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	envFile := filepath.Join(dir, "live-env.sh")
	writeFile(t, envFile, strings.Join([]string{
		"SLACK_BOT_TOKEN=xoxb-test",
		"SLACK_APP_TOKEN=xapp-test",
		"ONEESAMA_AGENT_RUNNER=dry-run",
		"",
	}, "\n"))

	output, err := runLiveScript(t, "--env", envFile, "--preflight-only", "slack-agent")
	if err == nil {
		t.Fatalf("oneesama-live preflight succeeded unexpectedly:\n%s", output)
	}
	if !strings.Contains(output, "triage foreground chain is required; expected pi_first_live") {
		t.Fatalf("output = %s, want missing live foreground posture", output)
	}
}

func TestOneesamaLivePreflightRequiresShadowOnlyFalse(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	envFile := filepath.Join(dir, "live-env.sh")
	writeFile(t, envFile, strings.Join([]string{
		"SLACK_BOT_TOKEN=xoxb-test",
		"SLACK_APP_TOKEN=xapp-test",
		"ONEESAMA_AGENT_RUNNER=dry-run",
		"ONEESAMA_SLACK_TRIAGE_FOREGROUND_CHAIN=pi_first_live",
		"ONEESAMA_SLACK_TRIAGE_WORKSPACE_POLICY='AI agent news gets concise workspace-aware comments'",
		"ONEESAMA_PERSONA_RUNTIME=oneesama-pi",
		"ONEESAMA_PERSONA_RUNTIME_MODE=live",
		"ONEESAMA_PERSONA_RUNTIME_SHADOW_ONLY=true",
		"ONEESAMA_PI_API_KEY=test-key",
		"",
	}, "\n"))

	output, err := runLiveScript(t, "--env", envFile, "--preflight-only", "slack-agent")
	if err == nil {
		t.Fatalf("oneesama-live preflight succeeded unexpectedly:\n%s", output)
	}
	if !strings.Contains(output, "persona runtime shadow-only must be false for live slack-agent") {
		t.Fatalf("output = %s, want shadow-only rejection", output)
	}
}

func TestOneesamaLiveCheckPidRequiresLiveSlackPostureEnv(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	envFile := filepath.Join(dir, "live-env.sh")
	envLines := append([]string{
		"SLACK_BOT_TOKEN=xoxb-test",
		"SLACK_APP_TOKEN=xapp-test",
		"ONEESAMA_AGENT_RUNNER=dry-run",
	}, strictLiveSlackPostureEnv()...)
	envLines = append(envLines, "")
	writeFile(t, envFile, strings.Join(envLines, "\n"))

	goodProcessEnv := append([]string{"PATH=" + os.Getenv("PATH")}, strictLiveSlackPostureEnv()...)
	goodProcessEnv = append(goodProcessEnv,
		"SLACK_BOT_TOKEN=xoxb-test",
		"SLACK_APP_TOKEN=xapp-test",
		"ONEESAMA_AGENT_RUNNER=dry-run",
	)
	good := startSleepWithEnv(t, goodProcessEnv)
	output, err := runLiveScript(t, "--env", envFile, "--check-pid", good, "slack-agent")
	if err != nil {
		t.Fatalf("oneesama-live check-pid failed: %v\n%s", err, output)
	}
	if !strings.Contains(output, "pid env check passed") {
		t.Fatalf("output = %s, want pid env check passed", output)
	}

	badProcessEnv := []string{
		"PATH=" + os.Getenv("PATH"),
		"SLACK_BOT_TOKEN=xoxb-test",
		"SLACK_APP_TOKEN=xapp-test",
		"ONEESAMA_AGENT_RUNNER=dry-run",
		"ONEESAMA_SLACK_TRIAGE_FOREGROUND_CHAIN=pi_first_live",
		"ONEESAMA_SLACK_TRIAGE_WORKSPACE_POLICY=AI agent news gets concise workspace-aware comments",
		"ONEESAMA_PERSONA_RUNTIME=oneesama-pi",
		"ONEESAMA_PERSONA_RUNTIME_SHADOW_ONLY=false",
		"ONEESAMA_PI_API_KEY=test-key",
	}
	bad := startSleepWithEnv(t, badProcessEnv)
	output, err = runLiveScript(t, "--env", envFile, "--check-pid", bad, "slack-agent")
	if err == nil {
		t.Fatalf("oneesama-live check-pid succeeded unexpectedly:\n%s", output)
	}
	if !strings.Contains(output, "does not expose required env ONEESAMA_PERSONA_RUNTIME_MODE") {
		t.Fatalf("output = %s, want missing process env", output)
	}
}

func TestOneesamaLivePreflightFailsKnownSocketModeCompetitor(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	envFile := filepath.Join(dir, "live-env.sh")
	competitorEnv := filepath.Join(dir, "twitter-bot.env")
	writeFile(t, envFile, strings.Join([]string{
		"SLACK_BOT_TOKEN=xoxb-test",
		"SLACK_APP_TOKEN=xapp-1-A0APMCDA89Y-test",
		"ONEESAMA_AGENT_RUNNER=dry-run",
		"ONEESAMA_SOCKET_MODE_COMPETITOR_ENV_FILES=com.openclaw.twitter-reply-bot.live=" + competitorEnv,
		"ONEESAMA_SLACK_TRIAGE_FOREGROUND_CHAIN=pi_first_live",
		"ONEESAMA_SLACK_TRIAGE_WORKSPACE_POLICY='AI agent news gets concise workspace-aware comments'",
		"ONEESAMA_PERSONA_RUNTIME=oneesama-pi",
		"ONEESAMA_PERSONA_RUNTIME_MODE=live",
		"ONEESAMA_PERSONA_RUNTIME_SHADOW_ONLY=false",
		"ONEESAMA_PI_API_KEY=test-key",
		"",
	}, "\n"))
	writeFile(t, competitorEnv, strings.Join([]string{
		"SLACK_APP_TOKEN=xapp-1-A0APMCDA89Y-twitter",
		"",
	}, "\n"))

	binDir := filepath.Join(dir, "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	launchctl := filepath.Join(binDir, "launchctl")
	writeFile(t, launchctl, strings.Join([]string{
		"#!/usr/bin/env bash",
		"if [[ \"$1\" == \"print\" && \"$2\" == gui/*/com.openclaw.twitter-reply-bot.live ]]; then",
		"  exit 0",
		"fi",
		"exit 113",
		"",
	}, "\n"))
	if err := os.Chmod(launchctl, 0o755); err != nil {
		t.Fatal(err)
	}

	output, err := runLiveScriptWithEnv(t, []string{
		"PATH=" + binDir + string(os.PathListSeparator) + os.Getenv("PATH"),
	}, "--env", envFile, "--preflight-only", "slack-agent")
	if err == nil {
		t.Fatalf("oneesama-live preflight succeeded unexpectedly:\n%s", output)
	}
	if !strings.Contains(output, "Slack Socket Mode app conflict: com.openclaw.twitter-reply-bot.live") ||
		!strings.Contains(output, "app_id=A0APMCDA89Y") {
		t.Fatalf("output = %s, want socket mode competitor failure", output)
	}
}

func TestOneesamaLivePreflightAllowsDifferentSocketModeApp(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	envFile := filepath.Join(dir, "live-env.sh")
	competitorEnv := filepath.Join(dir, "twitter-bot.env")
	writeFile(t, envFile, strings.Join([]string{
		"SLACK_BOT_TOKEN=xoxb-test",
		"SLACK_APP_TOKEN=xapp-1-A0APMCDA89Y-test",
		"ONEESAMA_AGENT_RUNNER=dry-run",
		"ONEESAMA_SOCKET_MODE_COMPETITOR_ENV_FILES=com.openclaw.twitter-reply-bot.live=" + competitorEnv,
		"ONEESAMA_SLACK_TRIAGE_FOREGROUND_CHAIN=pi_first_live",
		"ONEESAMA_SLACK_TRIAGE_WORKSPACE_POLICY='AI agent news gets concise workspace-aware comments'",
		"ONEESAMA_PERSONA_RUNTIME=oneesama-pi",
		"ONEESAMA_PERSONA_RUNTIME_MODE=live",
		"ONEESAMA_PERSONA_RUNTIME_SHADOW_ONLY=false",
		"ONEESAMA_PI_API_KEY=test-key",
		"",
	}, "\n"))
	writeFile(t, competitorEnv, strings.Join([]string{
		"SLACK_APP_TOKEN=xapp-1-A0B6DG2GR7A-twitter",
		"",
	}, "\n"))

	binDir := filepath.Join(dir, "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	launchctl := filepath.Join(binDir, "launchctl")
	writeFile(t, launchctl, strings.Join([]string{
		"#!/usr/bin/env bash",
		"if [[ \"$1\" == \"print\" && \"$2\" == gui/*/com.openclaw.twitter-reply-bot.live ]]; then",
		"  exit 0",
		"fi",
		"exit 113",
		"",
	}, "\n"))
	if err := os.Chmod(launchctl, 0o755); err != nil {
		t.Fatal(err)
	}

	output, err := runLiveScriptWithEnv(t, []string{
		"PATH=" + binDir + string(os.PathListSeparator) + os.Getenv("PATH"),
	}, "--env", envFile, "--preflight-only", "slack-agent")
	if err != nil {
		t.Fatalf("oneesama-live preflight failed: %v\n%s", err, output)
	}
	if !strings.Contains(output, "preflight passed") {
		t.Fatalf("output = %s, want preflight passed", output)
	}
	if strings.Contains(output, "Socket Mode app conflict") {
		t.Fatalf("output = %s, should not flag different Slack app id", output)
	}
}

func TestOneesamaLivePreflightCanAllowKnownSocketModeCompetitors(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	envFile := filepath.Join(dir, "live-env.sh")
	writeFile(t, envFile, strings.Join([]string{
		"SLACK_BOT_TOKEN=xoxb-test",
		"SLACK_APP_TOKEN=xapp-test",
		"ONEESAMA_AGENT_RUNNER=dry-run",
		"ONEESAMA_ALLOW_SOCKET_MODE_COMPETITORS=1",
		"ONEESAMA_SLACK_TRIAGE_FOREGROUND_CHAIN=pi_first_live",
		"ONEESAMA_SLACK_TRIAGE_WORKSPACE_POLICY='AI agent news gets concise workspace-aware comments'",
		"ONEESAMA_PERSONA_RUNTIME=oneesama-pi",
		"ONEESAMA_PERSONA_RUNTIME_MODE=live",
		"ONEESAMA_PERSONA_RUNTIME_SHADOW_ONLY=false",
		"ONEESAMA_PI_API_KEY=test-key",
		"",
	}, "\n"))

	binDir := filepath.Join(dir, "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	launchctl := filepath.Join(binDir, "launchctl")
	writeFile(t, launchctl, strings.Join([]string{
		"#!/usr/bin/env bash",
		"exit 0",
		"",
	}, "\n"))
	if err := os.Chmod(launchctl, 0o755); err != nil {
		t.Fatal(err)
	}

	output, err := runLiveScriptWithEnv(t, []string{
		"PATH=" + binDir + string(os.PathListSeparator) + os.Getenv("PATH"),
	}, "--env", envFile, "--preflight-only", "slack-agent")
	if err != nil {
		t.Fatalf("oneesama-live preflight failed: %v\n%s", err, output)
	}
	if !strings.Contains(output, "skipping Slack Socket Mode competitor guard") ||
		!strings.Contains(output, "preflight passed") {
		t.Fatalf("output = %s, want competitor guard opt-out", output)
	}
}

func TestOneesamaLivePreflightSkipsSlackTokensForMeetingAgent(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	envFile := filepath.Join(dir, "live-env.sh")
	writeFile(t, envFile, strings.Join([]string{
		"ONEESAMA_AGENT_RUNNER=dry-run",
		"MAB_OPENAI_API_KEY=test-openai-key",
		"",
	}, "\n"))

	output, err := runLiveScript(t, "--env", envFile, "--preflight-only", "meeting-agent")
	if err != nil {
		t.Fatalf("oneesama-live meeting-agent preflight failed: %v\n%s", err, output)
	}
	if strings.Contains(output, "Slack bot token is required") {
		t.Fatalf("output = %s, should not require Slack tokens for meeting-agent", output)
	}
}

func TestOneesamaLivePreflightRequiresOpenAIForMeetingAgent(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	envFile := filepath.Join(dir, "live-env.sh")
	writeFile(t, envFile, "ONEESAMA_AGENT_RUNNER=dry-run\n")

	output, err := runLiveScript(t, "--env", envFile, "--preflight-only", "meeting-agent")
	if err == nil {
		t.Fatalf("oneesama-live meeting-agent preflight succeeded unexpectedly:\n%s", output)
	}
	if !strings.Contains(output, "OpenAI Realtime API key is required") {
		t.Fatalf("output = %s, want missing OpenAI Realtime API key", output)
	}
}

func runLiveScript(t *testing.T, args ...string) (string, error) {
	t.Helper()
	return runLiveScriptWithEnv(t, []string{"PATH=" + os.Getenv("PATH")}, args...)
}

func runLiveScriptWithEnv(t *testing.T, env []string, args ...string) (string, error) {
	t.Helper()
	root := repoRoot(t)
	script := filepath.Join(root, "scripts", "oneesama-live.sh")
	command := exec.Command("bash", append([]string{script}, args...)...)
	command.Dir = root
	command.Env = env
	output, err := command.CombinedOutput()
	return string(output), err
}

func strictLiveSlackPostureEnv() []string {
	return []string{
		"ONEESAMA_SLACK_TRIAGE_FOREGROUND_CHAIN=pi_first_live",
		"ONEESAMA_SLACK_TRIAGE_WORKSPACE_POLICY=workspace-aware-policy",
		"ONEESAMA_PERSONA_RUNTIME=oneesama-pi",
		"ONEESAMA_PERSONA_RUNTIME_MODE=live",
		"ONEESAMA_PERSONA_RUNTIME_SHADOW_ONLY=false",
		"ONEESAMA_PI_API_KEY=test-key",
	}
}

func startSleepWithEnv(t *testing.T, env []string) string {
	t.Helper()
	command := exec.Command("sleep", "30")
	command.Env = env
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = command.Process.Kill()
		_ = command.Wait()
	})
	return strconv.Itoa(command.Process.Pid)
}

func repoRoot(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	return filepath.Dir(wd)
}

func writeFile(t *testing.T, path string, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}
