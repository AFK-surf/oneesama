package slackagent

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"testing"
	"time"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

type fakeRunner struct {
	job           agentrunner.Job
	startInput    agentrunner.StartInput
	cancelCalled  bool
	cancelContext context.Context
}

func (r *fakeRunner) Provider() string { return r.job.Provider }
func (r *fakeRunner) DryRun() bool     { return false }
func (r *fakeRunner) StartTask(_ context.Context, input agentrunner.StartInput) (agentrunner.Job, error) {
	r.startInput = input
	return r.job, nil
}
func (r *fakeRunner) GetJob(context.Context, string) (agentrunner.Job, bool, error) {
	return r.job, true, nil
}
func (r *fakeRunner) ListJobs(context.Context) ([]agentrunner.Job, error) {
	return []agentrunner.Job{r.job}, nil
}
func (r *fakeRunner) Cancel(ctx context.Context, id string) (agentrunner.Job, error) {
	r.cancelCalled = true
	r.cancelContext = ctx
	if id == r.job.ID {
		return r.job, nil
	}
	return agentrunner.Job{}, nil
}

func TestHandleAvatarCommandDoesNotExposeCancelSurface(t *testing.T) {
	runner := &fakeRunner{
		job: agentrunner.Job{
			ID:       "job_cancel_123",
			Provider: "codex",
			Status:   agentrunner.StatusRunning,
			Task:     "Cancel me",
		},
	}
	router := newTestRouter(t, Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack:       appconfig.SlackConfig{SigningSecret: "secret"},
		Runner:      runner,
	})

	payload := signRunnerCommand(t, "secret", url.Values{
		"text": {"cancel job_cancel_123"},
	})
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/slack/commands/avatar", bytes.NewBufferString(payload.body))
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.Header.Set("X-Slack-Request-Timestamp", payload.timestamp)
	request.Header.Set("X-Slack-Signature", payload.signature)
	router.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	var body AvatarCommandResponse
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body.OK || runner.cancelCalled {
		t.Fatalf("body = %#v cancelCalled=%v, want cancel hidden from user command surface", body, runner.cancelCalled)
	}
	if body.Text != "Unknown command: cancel\n\n"+avatarCommandUsage() {
		t.Fatalf("text = %q, want TS unknown-command parity", body.Text)
	}
}

func TestParseAvatarCommandCancel(t *testing.T) {
	parsed := parseAvatarCommand("cancel --job job_123")
	if parsed.Action != "cancel" {
		t.Fatalf("Action = %q, want cancel", parsed.Action)
	}
	if parsed.JobID != "job_123" {
		t.Fatalf("JobID = %q, want job_123", parsed.JobID)
	}
}

type signedRunnerCommand struct {
	body      string
	timestamp string
	signature string
}

func signRunnerCommand(t *testing.T, secret string, form url.Values) signedRunnerCommand {
	t.Helper()

	body := form.Encode()
	timestamp := strconv.FormatInt(time.Now().Unix(), 10)
	return signedRunnerCommand{
		body:      body,
		timestamp: timestamp,
		signature: SignSlackRequestBody(secret, timestamp, body),
	}
}
