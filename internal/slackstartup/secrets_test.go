package slackstartup

import (
	"os"
	"testing"
)

func TestScrubProcessSecretsMatchesCueboardList(t *testing.T) {
	for _, name := range SlackAgentProcessSecretNames {
		t.Setenv(name, "secret")
	}
	t.Setenv("BACKEND_URL", "http://127.0.0.1:9999")

	ScrubProcessSecrets()

	for _, name := range SlackAgentProcessSecretNames {
		if value := os.Getenv(name); value != "" {
			t.Fatalf("%s was not scrubbed: %q", name, value)
		}
	}
	if value := os.Getenv("BACKEND_URL"); value != "http://127.0.0.1:9999" {
		t.Fatalf("BACKEND_URL should be preserved, got %q", value)
	}
}
