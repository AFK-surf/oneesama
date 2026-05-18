package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

// Cueboard-era YAML configs were structurally identical to the JSON
// shape oneesama-go-rewrite expects, just in YAML syntax. The migration
// tool's job is to translate format faithfully while applying the same
// `DisallowUnknownFields` rule the runtime enforces. These tests pin
// that contract: a clean YAML round-trips, an unknown field fails
// loudly, and bad YAML reports a parse error with context.

func TestConvertYAMLToJSONRoundTripsSlackAgentConfig(t *testing.T) {
	yamlInput := []byte(`---
slack_agent:
  listen: ":9000"
  allowed_origins:
    - "https://example.com"
slack:
  signing_secret: "abc"
  bot_token: "xoxb-test"
meetd:
  watch_interval: "30s"
logging:
  level: "debug"
  format: "json"
`)
	out, err := convertYAMLToJSON(yamlInput)
	if err != nil {
		t.Fatalf("convertYAMLToJSON: %v", err)
	}

	var parsed map[string]any
	if err := json.Unmarshal(out, &parsed); err != nil {
		t.Fatalf("output is not valid JSON: %v\n%s", err, out)
	}
	if got, _ := parsed["slack_agent"].(map[string]any); got["listen"] != ":9000" {
		t.Fatalf("slack_agent.listen = %v, want :9000\n%s", got["listen"], out)
	}
	if slack, _ := parsed["slack"].(map[string]any); slack["bot_token"] != "xoxb-test" {
		t.Fatalf("slack.bot_token = %v, want xoxb-test\n%s", slack["bot_token"], out)
	}
	// Indented output is required so a human can review the migrated
	// file before checking it in.
	if !bytes.Contains(out, []byte("\n  ")) {
		t.Fatalf("output is not indented (likely flat JSON):\n%s", out)
	}
}

func TestConvertYAMLToJSONRejectsUnknownFieldsFromCueboardEra(t *testing.T) {
	// `agent_framework_path` is a hypothetical cueboard-era key that the
	// oneesama-go-rewrite loader does NOT recognize. Migration must
	// fail with a precise unknown-field error, not silently strip it.
	yamlInput := []byte(`---
slack_agent:
  listen: ":9000"
agent_framework_path: "/legacy/path"
`)
	_, err := convertYAMLToJSON(yamlInput)
	if err == nil {
		t.Fatal("expected unknown-field rejection, got nil error")
	}
	if !strings.Contains(err.Error(), `unknown field`) {
		t.Fatalf("error = %q, want it to name the unknown field", err)
	}
	if !strings.Contains(err.Error(), "agent_framework_path") {
		t.Fatalf("error = %q, want it to name agent_framework_path", err)
	}
}

func TestConvertYAMLToJSONReportsYAMLParseErrors(t *testing.T) {
	// Invalid YAML — unbalanced quote — should surface as parse YAML,
	// not a downstream JSON error that confuses the user.
	yamlInput := []byte(`slack:
  bot_token: "missing-close
`)
	_, err := convertYAMLToJSON(yamlInput)
	if err == nil {
		t.Fatal("expected YAML parse error, got nil")
	}
	if !strings.Contains(err.Error(), "parse YAML") {
		t.Fatalf("error = %q, want a 'parse YAML' prefix", err)
	}
}

func TestRunReadsStdinAndWritesStdoutByDefault(t *testing.T) {
	stdin := strings.NewReader("---\nslack_agent:\n  listen: \":9000\"\n")
	var stdout, stderr bytes.Buffer
	code := run(nil, stdin, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("exit code = %d, stderr = %q", code, stderr.String())
	}
	var parsed map[string]any
	if err := json.Unmarshal(stdout.Bytes(), &parsed); err != nil {
		t.Fatalf("stdout is not valid JSON: %v\n%s", err, stdout.Bytes())
	}
	if got, _ := parsed["slack_agent"].(map[string]any); got["listen"] != ":9000" {
		t.Fatalf("slack_agent.listen = %v, want :9000", got["listen"])
	}
	if !strings.Contains(stderr.String(), "migrated stdin → stdout") {
		t.Fatalf("stderr did not include status line, got %q", stderr.String())
	}
}

func TestRunQuietSuppressesStderrStatus(t *testing.T) {
	stdin := strings.NewReader("slack_agent:\n  listen: \":9000\"\n")
	var stdout, stderr bytes.Buffer
	code := run([]string{"--quiet"}, stdin, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("exit code = %d, stderr = %q", code, stderr.String())
	}
	if strings.Contains(stderr.String(), "migrated") {
		t.Fatalf("--quiet should suppress migration status, got %q", stderr.String())
	}
}

func TestRunEmptyInputIsAnError(t *testing.T) {
	stdin := strings.NewReader("")
	var stdout, stderr bytes.Buffer
	code := run(nil, stdin, &stdout, &stderr)
	if code == 0 {
		t.Fatal("expected non-zero exit on empty input")
	}
	if !strings.Contains(stderr.String(), "input is empty") {
		t.Fatalf("stderr = %q, want 'input is empty' diagnostic", stderr.String())
	}
}

func TestRunInvalidFlagReturnsTwo(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := run([]string{"--not-a-real-flag"}, strings.NewReader(""), &stdout, &stderr)
	if code != 2 {
		t.Fatalf("invalid flag exit = %d, want 2", code)
	}
}
