package integration

import (
	"bytes"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/AFK-surf/oneesama/internal/internalauth"
	"github.com/AFK-surf/oneesama/internal/meetingagent"
	"github.com/AFK-surf/oneesama/internal/slackagent"
	"github.com/AFK-surf/oneesama/pkg/config"
)

func TestSlackAndMeetingManagedServersSmoke(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	rootDir := t.TempDir()
	t.Cleanup(func() {
		_ = os.RemoveAll(packagePath(t, "runtime"))
	})

	meetingListener := newListener(t)
	slackListener := newListener(t)
	configPath := filepath.Join(rootDir, "config.json")
	if err := os.WriteFile(configPath, []byte(`{}`), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}
	t.Setenv("ONEESAMA_CONFIG_PATH", configPath)
	t.Setenv("ONEESAMA_MEETING_LISTEN", meetingListener.Addr().String())
	t.Setenv("ONEESAMA_SLACK_LISTEN", slackListener.Addr().String())
	t.Setenv("ONEESAMA_SLACK_SIGNING_SECRET", "secret")
	t.Setenv("ONEESAMA_INTERNAL_AUTH_KEY", "integration-key")
	t.Setenv("ONEESAMA_SLACK_WORKSPACE_DIR", rootDir+"/workspace")
	t.Setenv("ONEESAMA_AGENT_RUNNER", "dry-run")
	t.Setenv("ONEESAMA_DRY_RUN_AGENT", "true")
	t.Setenv("ONEESAMA_STATE_PROVIDER", "json-file")
	t.Setenv("ONEESAMA_STATE_DATA_DIR", rootDir+"/state")
	t.Setenv("ONEESAMA_MEET_RUNNER_DIR", repoPath(t, "meet-runner"))
	t.Setenv("MEET_WEBHOOK_URL", "")
	t.Setenv("MAB_MEET_WEBHOOK_URL", "")
	t.Setenv("ONEESAMA_MEETD_WEBHOOK_URL", "")
	t.Setenv("MEET_WEBHOOK_SECRET", "")
	t.Setenv("MAB_MEET_WEBHOOK_SECRET", "")
	t.Setenv("ONEESAMA_MEETD_WEBHOOK_SECRET", "")
	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}

	meetingServer := meetingagent.NewServer(cfg, logger.With("service", "meeting-agent"))
	meetingBaseURL := serveManagedServer(t, meetingServer, meetingListener)

	slackServer := slackagent.NewServer(cfg, logger.With("service", "slack-agent"))
	slackBaseURL := serveManagedServer(t, slackServer, slackListener)

	validateResponse := postJSON(t, slackBaseURL+"/slack/validate", `{"require_slack_tokens":false}`, map[string]string{
		internalauth.HeaderName: "integration-key",
	})
	if validateResponse.StatusCode != http.StatusOK {
		t.Fatalf("validate status = %d, want 200", validateResponse.StatusCode)
	}
	var validateBody struct {
		OK     bool `json:"ok"`
		Checks []struct {
			Name string `json:"name"`
			OK   bool   `json:"ok"`
			URL  string `json:"url"`
		} `json:"checks"`
	}
	decodeJSON(t, validateResponse, &validateBody)
	if !validateBody.OK {
		t.Fatalf("validate body = %#v, want ok", validateBody)
	}
	if len(validateBody.Checks) == 0 || validateBody.Checks[0].Name != "meeting_agent_health" || !validateBody.Checks[0].OK {
		t.Fatalf("validate checks = %#v, want healthy meeting agent probe", validateBody.Checks)
	}
	if validateBody.Checks[0].URL != meetingBaseURL+"/healthz" {
		t.Fatalf("meeting health url = %q, want %q", validateBody.Checks[0].URL, meetingBaseURL+"/healthz")
	}

	interactionPayload := `{"team":{"id":"T123"},"channel":{"id":"C123"},"user":{"id":"U123","username":"peng"},"message":{"thread_ts":"123.456"},"actions":[{"value":"help"}]}`
	interactionResponse := postSignedForm(t, slackBaseURL+"/slack/interactions", "secret", "payload="+url.QueryEscape(interactionPayload))
	if interactionResponse.StatusCode != http.StatusOK {
		t.Fatalf("interaction status = %d, want 200", interactionResponse.StatusCode)
	}
	interactionBody := readBody(t, interactionResponse)
	if !bytes.Contains(interactionBody, []byte("Onee-sama commands:")) {
		t.Fatalf("interaction body = %s, want avatar help", interactionBody)
	}
	badInteractionResponse := postSignedForm(t, slackBaseURL+"/slack/interactions", "wrong-secret", "payload="+url.QueryEscape(interactionPayload))
	if badInteractionResponse.StatusCode != http.StatusUnauthorized {
		t.Fatalf("bad interaction status = %d, want 401", badInteractionResponse.StatusCode)
	}

	postProcessResponse := postJSON(t, meetingBaseURL+"/meetings/post-process", `{
		"artifact_id":"artifact_integration",
		"title":"Integration Sync",
		"captions":[{"speaker":"Peng","text":"Decision: keep the rewrite incremental."}],
		"chat_messages":[{"sender":"Peng","text":"Spec https://example.com/spec"}]
	}`, map[string]string{
		internalauth.HeaderName: "integration-key",
	})
	if postProcessResponse.StatusCode != http.StatusOK {
		t.Fatalf("post-process status = %d, want 200", postProcessResponse.StatusCode)
	}
	postProcessBody := readBody(t, postProcessResponse)
	if !bytes.Contains(postProcessBody, []byte("artifact_integration")) {
		t.Fatalf("post-process body = %s, want artifact id", postProcessBody)
	}

	artifactsResponse := get(t, meetingBaseURL+"/meetings/artifacts", map[string]string{
		internalauth.HeaderName: "integration-key",
	})
	if artifactsResponse.StatusCode != http.StatusOK {
		t.Fatalf("artifacts status = %d, want 200", artifactsResponse.StatusCode)
	}
	artifactsBody := readBody(t, artifactsResponse)
	if !bytes.Contains(artifactsBody, []byte("artifact_integration")) {
		t.Fatalf("artifacts body = %s, want artifact_integration", artifactsBody)
	}

	t.Run("meetd_webhook_defaults_deliver_to_slack_agent", func(t *testing.T) {
		start := time.Now().UTC().Truncate(time.Second)
		createResponse := postJSON(t, meetingBaseURL+"/meetings", fmt.Sprintf(`{
			"event_id":"webhook-defaults",
			"meet_url":"https://meet.google.com/web-hook-default",
			"title":"Webhook Defaults",
			"start_at":%q,
			"end_at":%q,
			"slack_ref":{"channel_id":"CWEB","thread_ts":"999.111"},
			"status":"processing",
			"captions":[{"speaker":"Peng","text":"Webhook defaults work.","timestamp":%q,"source":"live_caption"}]
		}`, start.Format(time.RFC3339), start.Add(time.Hour).Format(time.RFC3339), start.Add(time.Minute).Format(time.RFC3339)), map[string]string{
			internalauth.HeaderName: "integration-key",
		})
		if createResponse.StatusCode != http.StatusOK {
			t.Fatalf("create meeting status = %d, want 200", createResponse.StatusCode)
		}
		tickResponse := postJSON(t, meetingBaseURL+"/meetings/runtime/tick", `{"now":"`+start.Format(time.RFC3339)+`"}`, map[string]string{
			internalauth.HeaderName: "integration-key",
		})
		if tickResponse.StatusCode != http.StatusOK {
			t.Fatalf("tick status = %d, body = %s", tickResponse.StatusCode, readBody(t, tickResponse))
		}
		waitForCanvasPublished(t, slackBaseURL, `"artifact_id":"meeting-1"`, "meeting-webhook")
	})

	t.Run("join_dry_run", func(t *testing.T) {
		requireMeetRunnerRuntime(t)
		joinResponse := postJSON(t, meetingBaseURL+"/join/google-meet", `{
			"session_id":"session_integration",
			"meeting_url":"https://meet.google.com/abc-defg-hij",
			"display_name":"Onee-sama",
			"title":"Integration Join",
			"dry_run":true
		}`, map[string]string{
			internalauth.HeaderName: "integration-key",
		})
		if joinResponse.StatusCode != http.StatusOK {
			t.Fatalf("join status = %d, want 200", joinResponse.StatusCode)
		}
		joinBody := readBody(t, joinResponse)
		if !bytes.Contains(joinBody, []byte(`"accepted":true`)) || !bytes.Contains(joinBody, []byte(`"session_integration"`)) {
			t.Fatalf("join body = %s, want accepted prepared session", joinBody)
		}

		statusResponse := get(t, meetingBaseURL+"/join/status?session_id=session_integration", map[string]string{
			internalauth.HeaderName: "integration-key",
		})
		if statusResponse.StatusCode != http.StatusOK {
			t.Fatalf("join status lookup = %d, want 200", statusResponse.StatusCode)
		}
		statusBody := readBody(t, statusResponse)
		if !bytes.Contains(statusBody, []byte(`"bridge_mode":"persistent-session"`)) || !bytes.Contains(statusBody, []byte(`"status":"prepared"`)) {
			t.Fatalf("join status body = %s, want persistent prepared session", statusBody)
		}
	})
}
