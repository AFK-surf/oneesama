package config

import (
	"strings"
	"testing"
)

// TestDecodeStrictAcceptsKnownSchema is the happy path: the runtime
// loader is willing to accept a small but valid config. Pinning this
// guards against accidentally over-tightening (e.g. a future bug that
// rejects empty config bodies).
func TestDecodeStrictAcceptsKnownSchema(t *testing.T) {
	jsonBytes := []byte(`{"slack_agent": {"listen": ":9000"}, "meetd": {"watch_interval": "30s"}}`)
	if err := DecodeStrict(jsonBytes); err != nil {
		t.Fatalf("DecodeStrict: %v", err)
	}
}

// TestDecodeStrictRejectsUnknownTopLevelKey is the core promise of the
// strict-policy upgrade: a typo or dead cueboard-era key at the top
// level fails loudly with a precise field name, instead of being
// silently ignored.
func TestDecodeStrictRejectsUnknownTopLevelKey(t *testing.T) {
	jsonBytes := []byte(`{"slack_agent": {"listen": ":9000"}, "agent_framework_path": "/legacy/path"}`)
	err := DecodeStrict(jsonBytes)
	if err == nil {
		t.Fatal("expected unknown-field rejection, got nil")
	}
	if !strings.Contains(err.Error(), `unknown field "agent_framework_path"`) {
		t.Fatalf("error = %q, want it to name agent_framework_path", err)
	}
}

// TestDecodeStrictRejectsUnknownNestedKey mirrors the top-level test for
// nested config sections. A typo'd `slack.signing_secrets` (plural)
// should fail just as loudly as a typo'd top-level key.
func TestDecodeStrictRejectsUnknownNestedKey(t *testing.T) {
	jsonBytes := []byte(`{"slack": {"signing_secrets": "abc"}}`)
	err := DecodeStrict(jsonBytes)
	if err == nil {
		t.Fatal("expected unknown nested-field rejection, got nil")
	}
	if !strings.Contains(err.Error(), `unknown field "signing_secrets"`) {
		t.Fatalf("error = %q, want it to name signing_secrets", err)
	}
}

// TestDecodeStrictReportsTrailingContent guards against a config file
// that accidentally has two top-level JSON objects concatenated (a
// merge-conflict residue or a botched migration). Without the trailing
// check the loader would only see the first object and silently drop
// the rest.
func TestDecodeStrictReportsTrailingContent(t *testing.T) {
	jsonBytes := []byte(`{"slack_agent": {"listen": ":9000"}}{"meetd": {"watch_interval": "30s"}}`)
	err := DecodeStrict(jsonBytes)
	if err == nil {
		t.Fatal("expected trailing-content rejection, got nil")
	}
	if !strings.Contains(err.Error(), "unexpected trailing content") {
		t.Fatalf("error = %q, want trailing-content diagnostic", err)
	}
}

// TestLooksLikeYAMLDetectsCueboardYAMLConfigs documents what the
// YAML-hint heuristic catches. Each input is something a user
// upgrading from cueboard might accidentally point ONEESAMA_CONFIG_PATH
// at.
func TestLooksLikeYAMLDetectsCueboardYAMLConfigs(t *testing.T) {
	cases := []struct {
		name string
		body string
		want bool
	}{
		{name: "yaml-doc-separator", body: "---\nslack_agent:\n  listen: ':9000'\n", want: true},
		{name: "bare-yaml-mapping", body: "slack_agent:\n  listen: ':9000'\n", want: true},
		{name: "yaml-comment", body: "# cueboard config\nslack_agent:\n  listen: ':9000'\n", want: true},
		{name: "plain-json-object", body: `{"slack_agent": {"listen": ":9000"}}`, want: false},
		{name: "json-with-leading-ws", body: "  \n  {\"slack_agent\": {\"listen\": \":9000\"}}", want: false},
		{name: "empty", body: "", want: false},
		{name: "json-array-top-level", body: `[1, 2, 3]`, want: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := looksLikeYAML([]byte(tc.body)); got != tc.want {
				t.Fatalf("looksLikeYAML(%q) = %v, want %v", tc.body, got, tc.want)
			}
		})
	}
}
