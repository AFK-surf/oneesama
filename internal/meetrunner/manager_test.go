package meetrunner

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func requireMeetRunnerRuntime(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node not available")
	}
	if _, err := os.Stat(filepath.Join("..", "..", "node_modules", "typescript", "package.json")); err != nil {
		t.Skip("meet-runner JS deps missing; run npm install")
	}
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func TestManagerPing(t *testing.T) {
	t.Parallel()
	requireMeetRunnerRuntime(t)

	manager := New(Config{Dir: filepath.Join("..", "..", "meet-runner")})
	status, err := manager.Ping(context.Background())
	if err != nil {
		t.Fatalf("Ping() error = %v", err)
	}
	if !status.OK || status.Name != "meet-runner" || status.BridgeMode != "persistent-session" {
		t.Fatalf("status = %#v, want persistent-session meet-runner", status)
	}
	if !containsString(status.Capabilities, "realtime.event") || !containsString(status.Capabilities, "realtime.text_turn") {
		t.Fatalf("capabilities = %#v, want realtime event and text turn control-plane methods", status.Capabilities)
	}
}

func TestManagerPrepareRejectsInvalidMeetURL(t *testing.T) {
	t.Parallel()
	requireMeetRunnerRuntime(t)

	manager := New(Config{Dir: filepath.Join("..", "..", "meet-runner")})
	_, err := manager.PrepareGoogleMeet(context.Background(), PrepareGoogleMeetInput{
		SessionID:  "session_invalid",
		MeetingURL: "https://example.com/not-meet",
		DryRun:     true,
	})
	if err == nil {
		t.Fatal("PrepareGoogleMeet() error = nil, want invalid meet url")
	}
}

func TestManagerPrepareRejectsInlineRealtimePlacement(t *testing.T) {
	t.Parallel()
	requireMeetRunnerRuntime(t)

	manager := New(Config{Dir: filepath.Join("..", "..", "meet-runner")})
	_, err := manager.PrepareGoogleMeet(context.Background(), PrepareGoogleMeetInput{
		SessionID:                "session_inline_rejected",
		MeetingURL:               "https://meet.google.com/abc-defg-hij",
		DryRun:                   true,
		InstallRealtimeBridge:    true,
		RealtimeRuntimePlacement: "inline",
	})
	if err == nil {
		t.Fatal("PrepareGoogleMeet() error = nil, want inline placement rejection")
	}
	if !strings.Contains(err.Error(), "inline Realtime SDK on Meet has been removed") {
		t.Fatalf("PrepareGoogleMeet() error = %v, want inline removal guard", err)
	}
}

func TestManagerPrepareAndStop(t *testing.T) {
	t.Parallel()
	requireMeetRunnerRuntime(t)

	manager := New(Config{Dir: filepath.Join("..", "..", "meet-runner")})
	prepare, err := manager.PrepareGoogleMeet(context.Background(), PrepareGoogleMeetInput{
		SessionID:                  "session_live",
		MeetingURL:                 "https://meet.google.com/abc-defg-hij",
		DisplayName:                "Onee-sama",
		Title:                      "Dry Run",
		DryRun:                     true,
		CollectFixtureState:        true,
		CaptureCaptions:            true,
		CaptionLanguage:            "English",
		BrowserUserDataDir:         "/tmp/session_live_profile",
		MeetProfileMode:            "persistent",
		MeetUIInteractionMode:      "humanized",
		MeetJoinLane:               "macos_test_humanized",
		MeetBrowserControlMode:     "playwright",
		InstallRealtimeBridge:      true,
		RealtimeBridgeMode:         "webrtc",
		AutoConnectRealtime:        true,
		SendRealtimeSessionUpdate:  true,
		ForwardMeetAudioToRealtime: true,
		InstallLocalDialogBridge:   true,
		InstallWorkerResultBridge:  true,
		InstallScreenShareBridge:   true,
		AutoStartScreenShare:       true,
	})
	if err != nil {
		t.Fatalf("PrepareGoogleMeet() error = %v", err)
	}
	if !prepare.Accepted || prepare.Session.Status != "prepared" {
		t.Fatalf("prepare = %#v, want accepted prepared", prepare)
	}
	if !prepare.Plan.CollectFixtureState || !prepare.Plan.CaptureCaptions ||
		prepare.Plan.CaptionLanguage != "English" || !prepare.Plan.InstallRealtimeBridge ||
		prepare.Plan.MeetProfileMode != "persistent" ||
		prepare.Plan.BrowserUserDataDir != "/tmp/session_live_profile" ||
		prepare.Plan.MeetUIInteractionMode != "humanized" ||
		prepare.Plan.MeetJoinLane != "macos_test_humanized" ||
		prepare.Plan.MeetBrowserControlMode != "playwright" ||
		!prepare.Plan.InstallAvatar || prepare.Plan.DisableLive2D ||
		prepare.Plan.RealtimeBridgeMode != "webrtc" || !prepare.Plan.AutoConnectRealtime ||
		!prepare.Plan.SendRealtimeSessionUpdate || !prepare.Plan.ForwardMeetAudioToRealtime ||
		!prepare.Plan.InstallLocalDialogBridge || !prepare.Plan.InstallWorkerResultBridge ||
		!prepare.Plan.InstallScreenShareBridge || !prepare.Plan.AutoStartScreenShare {
		t.Fatalf("prepare plan = %#v, want explicit browser-island flags preserved", prepare.Plan)
	}

	status, err := manager.StatusSession(context.Background(), StatusSessionInput{SessionID: "session_live"})
	if err != nil {
		t.Fatalf("StatusSession() error = %v", err)
	}
	if !status.OK || status.Session == nil || status.Session.ID != "session_live" {
		t.Fatalf("status = %#v, want session_live status", status)
	}

	stop, err := manager.StopSession(context.Background(), StopSessionInput{
		SessionID: "session_live",
		Reason:    "test_done",
	})
	if err != nil {
		t.Fatalf("StopSession() error = %v", err)
	}
	if !stop.OK || stop.Session.Status != "stopped" {
		t.Fatalf("stop = %#v, want ok stopped", stop)
	}
}

func TestManagerRealtimeEventAllowsSyntheticTranscript(t *testing.T) {
	t.Parallel()
	requireMeetRunnerRuntime(t)

	manager := New(Config{Dir: filepath.Join("..", "..", "meet-runner")})
	sessionID := "session_realtime_synthetic_transcript"
	if _, err := manager.PrepareGoogleMeet(context.Background(), PrepareGoogleMeetInput{
		SessionID:                 sessionID,
		MeetingURL:                "https://meet.google.com/abc-defg-hij",
		DryRun:                    true,
		InstallRealtimeBridge:     true,
		RealtimeRuntimePlacement:  "sidecar",
		SendRealtimeSessionUpdate: true,
	}); err != nil {
		t.Fatalf("PrepareGoogleMeet() error = %v", err)
	}
	t.Cleanup(func() {
		_, _ = manager.StopSession(context.Background(), StopSessionInput{
			SessionID: sessionID,
			Reason:    "test_done",
		})
	})

	result, err := manager.SendRealtimeEvent(context.Background(), RealtimeEventInput{
		SessionID: sessionID,
		Event: map[string]any{
			"type":       "conversation.item.input_audio_transcription.completed",
			"item_id":    "synthetic_item",
			"transcript": "Codex build Gomoku web game with sync",
		},
	})
	if err != nil {
		t.Fatalf("SendRealtimeEvent() error = %v", err)
	}
	if result["error"] == "realtime_event_type_not_allowed" {
		t.Fatalf("SendRealtimeEvent() result = %#v, synthetic transcript should pass runner allowlist", result)
	}

	result, err = manager.SendRealtimeEvent(context.Background(), RealtimeEventInput{
		SessionID: sessionID,
		Event: map[string]any{
			"type":    "conversation.item.input_audio_transcription.completed",
			"item_id": "synthetic_item",
		},
	})
	if err == nil {
		t.Fatalf("SendRealtimeEvent() error = nil, result = %#v, want transcript-required rejection", result)
	}
	if !strings.Contains(err.Error(), "realtime_transcript_required") {
		t.Fatalf("SendRealtimeEvent() error = %v, want realtime_transcript_required", err)
	}
}

func TestManagerReusesPersistentSession(t *testing.T) {
	t.Parallel()
	requireMeetRunnerRuntime(t)

	manager := New(Config{Dir: filepath.Join("..", "..", "meet-runner")})
	prepareOne, err := manager.PrepareGoogleMeet(context.Background(), PrepareGoogleMeetInput{
		SessionID:  "session_reuse",
		MeetingURL: "https://meet.google.com/abc-defg-hij",
		DryRun:     true,
	})
	if err != nil {
		t.Fatalf("first PrepareGoogleMeet() error = %v", err)
	}
	if prepareOne.BridgeMode != "persistent-session" {
		t.Fatalf("first prepare = %#v, want persistent-session", prepareOne)
	}

	workerOne, ok := manager.session("session_reuse")
	if !ok || workerOne == nil {
		t.Fatal("expected persistent worker after first prepare")
	}

	prepareTwo, err := manager.PrepareGoogleMeet(context.Background(), PrepareGoogleMeetInput{
		SessionID:  "session_reuse",
		MeetingURL: "https://meet.google.com/abc-defg-hij?authuser=0",
		DryRun:     true,
	})
	if err != nil {
		t.Fatalf("second PrepareGoogleMeet() error = %v", err)
	}
	workerTwo, ok := manager.session("session_reuse")
	if !ok || workerTwo == nil {
		t.Fatal("expected persistent worker after second prepare")
	}
	if workerOne != workerTwo {
		t.Fatal("expected PrepareGoogleMeet to reuse the same session worker")
	}
	if prepareTwo.Session.Status != "prepared" {
		t.Fatalf("second prepare = %#v, want prepared session", prepareTwo)
	}

	if _, err := manager.StopSession(context.Background(), StopSessionInput{
		SessionID: "session_reuse",
		Reason:    "test_done",
	}); err != nil {
		t.Fatalf("StopSession() error = %v", err)
	}
	if _, ok := manager.session("session_reuse"); ok {
		t.Fatal("expected StopSession to remove persistent worker")
	}
}

func TestManagerShutdownClosesPersistentSessions(t *testing.T) {
	t.Parallel()
	requireMeetRunnerRuntime(t)

	manager := New(Config{Dir: filepath.Join("..", "..", "meet-runner")})
	for _, sessionID := range []string{"session_shutdown_one", "session_shutdown_two"} {
		if _, err := manager.PrepareGoogleMeet(context.Background(), PrepareGoogleMeetInput{
			SessionID:  sessionID,
			MeetingURL: "https://meet.google.com/abc-defg-hij",
			DryRun:     true,
		}); err != nil {
			t.Fatalf("PrepareGoogleMeet(%s) error = %v", sessionID, err)
		}
	}

	if err := manager.Shutdown(context.Background()); err != nil {
		t.Fatalf("Shutdown() error = %v", err)
	}
	if _, ok := manager.session("session_shutdown_one"); ok {
		t.Fatal("expected Shutdown to remove session_shutdown_one")
	}
	if _, ok := manager.session("session_shutdown_two"); ok {
		t.Fatal("expected Shutdown to remove session_shutdown_two")
	}
}

func TestSessionCallTimeoutDoesNotDeadlock(t *testing.T) {
	t.Parallel()
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node not available")
	}

	dir := t.TempDir()
	srcDir := filepath.Join(dir, "src")
	if err := os.MkdirAll(srcDir, 0o755); err != nil {
		t.Fatalf("MkdirAll() error = %v", err)
	}
	const script = `import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
for await (const _line of rl) {
  // Intentionally never reply. The Go side should time out and close cleanly.
}`
	if err := os.WriteFile(filepath.Join(srcDir, "index.ts"), []byte(script), 0o644); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	session, err := NewSession(SessionConfig{
		ID:      "session_timeout",
		Dir:     dir,
		Command: "node",
		Timeout: 25 * time.Millisecond,
	})
	if err != nil {
		t.Fatalf("NewSession() error = %v", err)
	}

	errCh := make(chan error, 1)
	go func() {
		errCh <- session.Call(context.Background(), "join.google_meet.prepare", map[string]any{
			"session_id":  "session_timeout",
			"meeting_url": "https://meet.google.com/abc-defg-hij",
			"dry_run":     true,
		}, nil)
	}()

	select {
	case err := <-errCh:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("Call() error = %v, want context deadline exceeded", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Call() timed out waiting for timeout result; possible deadlock")
	}
}

func TestSessionNoCloseTimeoutKeepsSessionUsableAndSkipsLateResponse(t *testing.T) {
	t.Parallel()
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node not available")
	}

	dir := t.TempDir()
	srcDir := filepath.Join(dir, "src")
	if err := os.MkdirAll(srcDir, 0o755); err != nil {
		t.Fatalf("MkdirAll() error = %v", err)
	}
	const script = `import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
for await (const line of rl) {
  const request = JSON.parse(line);
  if (request.method === "join.session.status") {
    setTimeout(() => {
      console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ok: true, late_status: true } }));
    }, 50);
    continue;
  }
  if (request.method === "runner.ping") {
    setTimeout(() => {
      console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ok: true, pong: true } }));
    }, 80);
  }
}`
	if err := os.WriteFile(filepath.Join(srcDir, "index.ts"), []byte(script), 0o644); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	session, err := NewSession(SessionConfig{
		ID:      "session_status_timeout",
		Dir:     dir,
		Command: "node",
		Timeout: time.Second,
	})
	if err != nil {
		t.Fatalf("NewSession() error = %v", err)
	}
	t.Cleanup(func() { _ = session.Close() })

	err = session.CallWithTimeoutNoClose(context.Background(), 10*time.Millisecond, "join.session.status", nil, nil)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("status timeout error = %v, want context deadline exceeded", err)
	}

	var result struct {
		OK   bool `json:"ok"`
		Pong bool `json:"pong"`
	}
	if err := session.CallWithTimeout(context.Background(), time.Second, "runner.ping", nil, &result); err != nil {
		t.Fatalf("runner.ping after status timeout error = %v", err)
	}
	if !result.OK || !result.Pong {
		t.Fatalf("runner.ping result = %+v, want fresh ping response", result)
	}
}

func TestSessionCallSkipsStdoutLogLines(t *testing.T) {
	t.Parallel()
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node not available")
	}

	dir := t.TempDir()
	srcDir := filepath.Join(dir, "src")
	if err := os.MkdirAll(srcDir, 0o755); err != nil {
		t.Fatalf("MkdirAll() error = %v", err)
	}
	const script = `import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
for await (const line of rl) {
  const request = JSON.parse(line);
  console.log("[meeting-awareness] stdout log line should not break the JSON-RPC stream");
  console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ok: true, skipped_log_line: true } }));
}`
	if err := os.WriteFile(filepath.Join(srcDir, "index.ts"), []byte(script), 0o644); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	session, err := NewSession(SessionConfig{
		ID:      "session_stdout_log",
		Dir:     dir,
		Command: "node",
		Timeout: time.Second,
	})
	if err != nil {
		t.Fatalf("NewSession() error = %v", err)
	}
	t.Cleanup(func() { _ = session.Close() })

	var result struct {
		OK             bool `json:"ok"`
		SkippedLogLine bool `json:"skipped_log_line"`
	}
	if err := session.Call(context.Background(), "runner.ping", nil, &result); err != nil {
		t.Fatalf("Call() error = %v", err)
	}
	if !result.OK || !result.SkippedLogLine {
		t.Fatalf("result = %+v, want JSON-RPC response after skipped stdout log", result)
	}
	if stderr := session.stderr.String(); !strings.Contains(stderr, "[meet-runner stdout] [meeting-awareness]") {
		t.Fatalf("stderr = %q, want skipped stdout log captured", stderr)
	}
}

func TestSessionCallSkipsCarriageReturnProgressLogs(t *testing.T) {
	t.Parallel()
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node not available")
	}

	dir := t.TempDir()
	srcDir := filepath.Join(dir, "src")
	if err := os.MkdirAll(srcDir, 0o755); err != nil {
		t.Fatalf("MkdirAll() error = %v", err)
	}
	const script = `import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
for await (const line of rl) {
  const request = JSON.parse(line);
  for (let i = 0; i < 200; i += 1) {
    process.stdout.write("[meeting-recorder] ffmpeg progress frame=" + i + "\r");
  }
  console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ok: true, progress_logs_skipped: true } }));
}`
	if err := os.WriteFile(filepath.Join(srcDir, "index.ts"), []byte(script), 0o644); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	session, err := NewSession(SessionConfig{
		ID:      "session_stdout_progress_log",
		Dir:     dir,
		Command: "node",
		Timeout: time.Second,
	})
	if err != nil {
		t.Fatalf("NewSession() error = %v", err)
	}
	t.Cleanup(func() { _ = session.Close() })

	var result struct {
		OK                  bool `json:"ok"`
		ProgressLogsSkipped bool `json:"progress_logs_skipped"`
	}
	if err := session.Call(context.Background(), "runner.ping", nil, &result); err != nil {
		t.Fatalf("Call() error = %v", err)
	}
	if !result.OK || !result.ProgressLogsSkipped {
		t.Fatalf("result = %+v, want JSON-RPC response after carriage-return progress logs", result)
	}
	if stderr := session.stderr.String(); !strings.Contains(stderr, "[meet-runner stdout] [meeting-recorder] ffmpeg progress") {
		t.Fatalf("stderr = %q, want skipped progress log captured", stderr)
	}
}

func TestSessionCallSkipsNonRPCJSONStdoutLogs(t *testing.T) {
	t.Parallel()
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node not available")
	}

	dir := t.TempDir()
	srcDir := filepath.Join(dir, "src")
	if err := os.MkdirAll(srcDir, 0o755); err != nil {
		t.Fatalf("MkdirAll() error = %v", err)
	}
	const script = `import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
for await (const line of rl) {
  const request = JSON.parse(line);
  console.log(JSON.stringify({ label: "runtime_state_refresh", observedAt: "now", activeSpeaker: { name: "Peng" } }));
  console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ok: true, json_logs_skipped: true } }));
}`
	if err := os.WriteFile(filepath.Join(srcDir, "index.ts"), []byte(script), 0o644); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	session, err := NewSession(SessionConfig{
		ID:      "session_stdout_json_log",
		Dir:     dir,
		Command: "node",
		Timeout: time.Second,
	})
	if err != nil {
		t.Fatalf("NewSession() error = %v", err)
	}
	t.Cleanup(func() { _ = session.Close() })

	var result struct {
		OK              bool `json:"ok"`
		JSONLogsSkipped bool `json:"json_logs_skipped"`
	}
	if err := session.Call(context.Background(), "runner.ping", nil, &result); err != nil {
		t.Fatalf("Call() error = %v", err)
	}
	if !result.OK || !result.JSONLogsSkipped {
		t.Fatalf("result = %+v, want JSON-RPC response after non-RPC JSON log", result)
	}
	if stderr := session.stderr.String(); !strings.Contains(stderr, "[meet-runner stdout] {\"") {
		t.Fatalf("stderr = %q, want skipped JSON stdout log captured", stderr)
	}
}

func TestSessionCallSkipsMalformedJSONRPCLikeStdoutLogs(t *testing.T) {
	t.Parallel()
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node not available")
	}

	dir := t.TempDir()
	srcDir := filepath.Join(dir, "src")
	if err := os.MkdirAll(srcDir, 0o755); err != nil {
		t.Fatalf("MkdirAll() error = %v", err)
	}
	const script = `import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
for await (const line of rl) {
  const request = JSON.parse(line);
  console.log("{\"jsonrpc\":\"2.0\",\"id\":\"not-a-response\"");
  console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ok: true, malformed_jsonrpc_like_skipped: true } }));
}`
	if err := os.WriteFile(filepath.Join(srcDir, "index.ts"), []byte(script), 0o644); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	session, err := NewSession(SessionConfig{
		ID:      "session_stdout_malformed_jsonrpc_like_log",
		Dir:     dir,
		Command: "node",
		Timeout: time.Second,
	})
	if err != nil {
		t.Fatalf("NewSession() error = %v", err)
	}
	t.Cleanup(func() { _ = session.Close() })

	var result struct {
		OK                          bool `json:"ok"`
		MalformedJSONRPCLikeSkipped bool `json:"malformed_jsonrpc_like_skipped"`
	}
	if err := session.Call(context.Background(), "runner.ping", nil, &result); err != nil {
		t.Fatalf("Call() error = %v", err)
	}
	if !result.OK || !result.MalformedJSONRPCLikeSkipped {
		t.Fatalf("result = %+v, want JSON-RPC response after malformed jsonrpc-like stdout log", result)
	}
	if stderr := session.stderr.String(); !strings.Contains(stderr, "[meet-runner stdout malformed jsonrpc-like]") {
		t.Fatalf("stderr = %q, want malformed jsonrpc-like stdout log captured", stderr)
	}
}
