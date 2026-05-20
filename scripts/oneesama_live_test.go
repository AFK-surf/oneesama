package scripts_test

import (
	"os"
	"os/exec"
	"path/filepath"
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

func TestOneesamaLivePreflightSkipsSlackTokensForMeetingAgent(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	envFile := filepath.Join(dir, "live-env.sh")
	writeFile(t, envFile, "ONEESAMA_AGENT_RUNNER=dry-run\n")

	output, err := runLiveScript(t, "--env", envFile, "--preflight-only", "meeting-agent")
	if err != nil {
		t.Fatalf("oneesama-live meeting-agent preflight failed: %v\n%s", err, output)
	}
	if strings.Contains(output, "Slack bot token is required") {
		t.Fatalf("output = %s, should not require Slack tokens for meeting-agent", output)
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
