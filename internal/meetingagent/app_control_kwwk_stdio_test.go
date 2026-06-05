package meetingagent

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestKWWKStdioAppControlBackendCallsPersistentJSONRPCHelper(t *testing.T) {
	t.Parallel()

	helper := writeKWWKAppControlHelper(t)
	backend := NewKWWKStdioAppControlBackend(KWWKStdioAppControlConfig{
		Command: "node " + shellQuote(helper),
		Timeout: time.Second,
	})
	t.Cleanup(func() {
		_ = backend.Shutdown(context.Background())
	})

	req := AppControlRequest{
		SessionID:   "meet_session",
		Instruction: "draw a snake mockup",
		Timeout:     time.Second,
		Target: AppControlTarget{
			ApplicationName: "Pencil",
			WindowID:        991,
			ProcessID:       4242,
		},
	}
	first, err := backend.ControlSharedApp(context.Background(), req)
	if err != nil {
		t.Fatalf("ControlSharedApp(first) error = %v", err)
	}
	second, err := backend.ControlSharedApp(context.Background(), req)
	if err != nil {
		t.Fatalf("ControlSharedApp(second) error = %v", err)
	}

	if !first.OK || first.Provider != "kwwk" || first.Summary != "kwwk observed instruction-only request: draw a snake mockup" {
		t.Fatalf("first = %#v, want KWWK success with instruction-only target", first)
	}
	if second.Summary != "kwwk observed instruction-only request: draw a snake mockup" {
		t.Fatalf("second = %#v, want persistent helper to handle second call", second)
	}
	if len(first.Actions) != 1 || first.Actions[0] != "observe" {
		t.Fatalf("actions = %#v, want observe", first.Actions)
	}
	raw, ok := first.Raw.(map[string]any)
	if !ok {
		t.Fatalf("raw = %#v, want metadata map", first.Raw)
	}
	metadata, ok := raw["metadata"].(map[string]any)
	if !ok || metadata["method"] != kwwkAppControlMethod {
		t.Fatalf("metadata = %#v, want method %s", raw["metadata"], kwwkAppControlMethod)
	}
}

func TestKWWKStdioAppControlBackendForwardsInstructionOnlyRequests(t *testing.T) {
	t.Parallel()

	helper := writeKWWKAppControlHelper(t)
	backend := NewKWWKStdioAppControlBackend(KWWKStdioAppControlConfig{
		Command: "node " + shellQuote(helper),
		Timeout: time.Second,
	})
	t.Cleanup(func() {
		_ = backend.Shutdown(context.Background())
	})

	result, err := backend.ControlSharedApp(context.Background(), AppControlRequest{
		SessionID:     "meet_session",
		Instruction:   "observe the shared app through instruction-only KWWK direct mode",
		Timeout:       time.Second,
		ExecutionMode: appControlExecutionModeDirect,
		Target: AppControlTarget{
			ApplicationName: "Pencil",
			WindowID:        991,
			ProcessID:       4242,
		},
	})
	if err != nil {
		t.Fatalf("ControlSharedApp() error = %v", err)
	}
	if !result.OK || result.Provider != "kwwk" || result.Summary != "kwwk observed instruction-only request: observe the shared app through instruction-only KWWK direct mode" {
		t.Fatalf("result = %#v, want instruction-only KWWK request success", result)
	}
	if len(result.Actions) != 1 || result.Actions[0] != "observe" {
		t.Fatalf("actions = %#v, want observe", result.Actions)
	}
}

func TestKWWKStdioAppControlBackendPreservesBackgroundAgentStatus(t *testing.T) {
	t.Parallel()

	helper := writeKWWKAppControlHelper(t)
	backend := NewKWWKStdioAppControlBackend(KWWKStdioAppControlConfig{
		Command: "node " + shellQuote(helper),
		Timeout: time.Second,
	})
	t.Cleanup(func() {
		_ = backend.Shutdown(context.Background())
	})

	result, err := backend.ControlSharedApp(context.Background(), AppControlRequest{
		SessionID:   "meet_session",
		Instruction: "redesign the product roadmap in the shared document",
		Timeout:     time.Second,
		Target:      AppControlTarget{ApplicationName: "Docs"},
	})
	if err != nil {
		t.Fatalf("ControlSharedApp() error = %v", err)
	}
	if result.OK || result.Provider != "kwwk" || result.Status != "needs_background_agent" || result.Blocker != "needs_background_agent" {
		t.Fatalf("result = %#v, want preserved needs_background_agent status", result)
	}
}

func TestKWWKStdioAppControlBackendPreservesVerificationFailure(t *testing.T) {
	t.Parallel()

	helper := writeKWWKAppControlHelperSource(t, `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
for await (const line of rl) {
  const req = JSON.parse(line);
  console.log(JSON.stringify({
    jsonrpc: "2.0",
    id: req.id,
    result: {
      ok: false,
      status: "failed",
      summary: "post-action verification failed",
      actions: ["click"],
      confidence: 0.2,
      blocker: "failed_verification",
      operations: [{ kind: "click", x: 10, y: 20 }],
      metadata: {
        method: req.method,
        verification: {
          schema: "oneesama.kwwk-cu-verification.v1",
          ok: false,
          status: "failed",
          blocker: "failed_verification"
        }
      }
    }
  }));
}
`)
	backend := NewKWWKStdioAppControlBackend(KWWKStdioAppControlConfig{
		Command: "node " + shellQuote(helper),
		Timeout: time.Second,
	})
	t.Cleanup(func() {
		_ = backend.Shutdown(context.Background())
	})

	result, err := backend.ControlSharedApp(context.Background(), AppControlRequest{
		SessionID:   "meet_session",
		Instruction: "click the visible button",
		Timeout:     time.Second,
		Target:      AppControlTarget{ApplicationName: "Chrome"},
	})
	if err != nil {
		t.Fatalf("ControlSharedApp() error = %v", err)
	}
	if result.OK || result.Provider != "kwwk" || result.Status != appControlStatusFailed || result.Blocker != "failed_verification" {
		t.Fatalf("result = %#v, want preserved failed_verification blocker", result)
	}
	raw, ok := result.Raw.(map[string]any)
	if !ok {
		t.Fatalf("raw = %#v, want raw map", result.Raw)
	}
	metadata, ok := raw["metadata"].(map[string]any)
	if !ok {
		t.Fatalf("metadata = %#v, want metadata map", raw["metadata"])
	}
	verification, ok := metadata["verification"].(map[string]any)
	if !ok || verification["schema"] != "oneesama.kwwk-cu-verification.v1" || verification["blocker"] != "failed_verification" {
		t.Fatalf("verification = %#v, want KWWK verification evidence", metadata["verification"])
	}
}

func TestKWWKStdioAppControlBackendPrewarmsControlFamily(t *testing.T) {
	t.Parallel()

	helper := writeKWWKAppControlHelper(t)
	backend := NewKWWKStdioAppControlBackend(KWWKStdioAppControlConfig{
		Command: "node " + shellQuote(helper),
		Timeout: time.Second,
	})
	t.Cleanup(func() {
		_ = backend.Shutdown(context.Background())
	})

	result := backend.PrewarmAppControl(context.Background(), AppControlPrewarmRequest{
		SessionID: "meet_session",
		Reason:    "meeting_join",
		Timeout:   time.Second,
	})

	if !result.OK || result.Provider != "kwwk" || result.Status != "ready" {
		t.Fatalf("prewarm = %#v, want ready KWWK prewarm", result)
	}
	for _, control := range []string{"ping", "session-status", "mode-help", "planner-prewarm", "cursor-prewarm", "permissions-status"} {
		if result.Evidence[control] == nil {
			t.Fatalf("prewarm evidence missing %q: %#v", control, result.Evidence)
		}
	}
	if result.Duration <= 0 || result.StartedAt.IsZero() || result.FinishedAt.IsZero() {
		t.Fatalf("prewarm timing = duration %s started %s finished %s", result.Duration, result.StartedAt, result.FinishedAt)
	}
}

func TestKWWKStdioAppControlBackendPrewarmRunsHelperBuildCommand(t *testing.T) {
	t.Parallel()

	helper := writeKWWKAppControlHelper(t)
	marker := filepath.Join(t.TempDir(), "helper-built")
	ensureCommand := fmt.Sprintf(
		"printf '%%s\\n' '{\"ok\":true,\"schema\":\"oneesama.app-control-helper-build.v1\",\"binary\":\"/tmp/kwwk-helper\",\"compiled\":true,\"durationMs\":3}'; touch %s",
		shellQuote(marker),
	)
	backend := NewKWWKStdioAppControlBackend(KWWKStdioAppControlConfig{
		Command:       "node " + shellQuote(helper),
		EnsureCommand: ensureCommand,
		Timeout:       time.Second,
	})
	t.Cleanup(func() {
		_ = backend.Shutdown(context.Background())
	})

	result := backend.PrewarmAppControl(context.Background(), AppControlPrewarmRequest{
		SessionID: "meet_session",
		Reason:    "meeting_join",
		Timeout:   time.Second,
	})

	if !result.OK {
		t.Fatalf("prewarm = %#v, want ready KWWK prewarm", result)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatalf("helper build marker missing: %v", err)
	}
	build, ok := result.Evidence["helper-build"].(map[string]any)
	if !ok || build["configured"] != true || build["status"] != appControlStatusCompleted {
		t.Fatalf("helper-build evidence = %#v, want completed configured build", result.Evidence["helper-build"])
	}
	buildResult, ok := build["result"].(map[string]any)
	if !ok || buildResult["schema"] != "oneesama.app-control-helper-build.v1" || buildResult["compiled"] != true {
		t.Fatalf("helper-build result = %#v, want compiled build report", build["result"])
	}
}

func TestKWWKStdioAppControlBackendPrewarmUsesPrewarmTimeoutNotActionTimeout(t *testing.T) {
	t.Parallel()

	helper := writeKWWKAppControlHelper(t)
	ensureCommand := "sleep 0.05; printf '%s\\n' '{\"ok\":true,\"schema\":\"oneesama.app-control-helper-build.v1\",\"binary\":\"/tmp/kwwk-helper\",\"compiled\":true,\"durationMs\":50}'"
	backend := NewKWWKStdioAppControlBackend(KWWKStdioAppControlConfig{
		Command:       "node " + shellQuote(helper),
		EnsureCommand: ensureCommand,
		Timeout:       time.Millisecond,
	})
	t.Cleanup(func() {
		_ = backend.Shutdown(context.Background())
	})

	result := backend.PrewarmAppControl(context.Background(), AppControlPrewarmRequest{
		SessionID: "meet_session",
		Reason:    "meeting_join",
		Timeout:   500 * time.Millisecond,
	})

	if !result.OK {
		t.Fatalf("prewarm = %#v, want ready KWWK prewarm using request timeout", result)
	}
	build, ok := result.Evidence["helper-build"].(map[string]any)
	if !ok || build["status"] != appControlStatusCompleted {
		t.Fatalf("helper-build evidence = %#v, want completed build within prewarm timeout", result.Evidence["helper-build"])
	}
}

func TestKWWKStdioAppControlBackendInfersHelperBuildCommandForTSLauncher(t *testing.T) {
	t.Parallel()

	backend := NewKWWKStdioAppControlBackend(KWWKStdioAppControlConfig{
		Command: "node --import tsx packages/core/src/meeting/app-control-helper.ts --stdio",
	})
	if backend.ensureCommand != "node --import tsx packages/core/src/meeting/app-control-helper.ts --ensure-binary-json" {
		t.Fatalf("ensureCommand = %q, want inferred TS launcher build command", backend.ensureCommand)
	}

	binaryBackend := NewKWWKStdioAppControlBackend(KWWKStdioAppControlConfig{
		Command: "/usr/local/bin/oneesama-kwwk-helper --stdio",
	})
	if binaryBackend.ensureCommand != "" {
		t.Fatalf("binary ensureCommand = %q, want no inferred build command for binary helper", binaryBackend.ensureCommand)
	}
}

func TestKWWKStdioAppControlBackendIgnoresWrongIDStrayResponse(t *testing.T) {
	t.Parallel()

	helper := writeKWWKAppControlHelperSource(t, `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
for await (const line of rl) {
  const req = JSON.parse(line);
  console.log(JSON.stringify({
    jsonrpc: "2.0",
    id: "stray-" + req.id,
    error: { code: -32000, message: "stale response must be ignored" }
  }));
  console.log(JSON.stringify({
    jsonrpc: "2.0",
    id: req.id,
    result: {
      ok: true,
      summary: "matched response handled",
      actions: ["observe"],
      confidence: 0.7
    }
  }));
}
`)
	backend := NewKWWKStdioAppControlBackend(KWWKStdioAppControlConfig{
		Command: "node " + shellQuote(helper),
		Timeout: time.Second,
	})
	t.Cleanup(func() {
		_ = backend.Shutdown(context.Background())
	})

	result, err := backend.ControlSharedApp(context.Background(), AppControlRequest{
		SessionID:   "meet_session",
		Instruction: "observe active app",
		Timeout:     time.Second,
	})
	if err != nil {
		t.Fatalf("ControlSharedApp() error = %v", err)
	}
	if !result.OK || result.Summary != "matched response handled" {
		t.Fatalf("result = %#v, want matched response success after wrong-id stray", result)
	}
}

func TestKWWKStdioAppControlBackendIgnoresStartupStrayResponse(t *testing.T) {
	t.Parallel()

	helper := writeKWWKAppControlHelperSource(t, `
import readline from "node:readline";
console.log(JSON.stringify({
  jsonrpc: "2.0",
  id: "startup-stray",
  error: { code: -32000, message: "startup response must be ignored" }
}));
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
for await (const line of rl) {
  const req = JSON.parse(line);
  console.log(JSON.stringify({
    jsonrpc: "2.0",
    id: req.id,
    result: {
      ok: true,
      summary: "startup stray ignored",
      actions: ["observe"],
      confidence: 0.7
    }
  }));
}
`)
	backend := NewKWWKStdioAppControlBackend(KWWKStdioAppControlConfig{
		Command: "node " + shellQuote(helper),
		Timeout: time.Second,
	})
	t.Cleanup(func() {
		_ = backend.Shutdown(context.Background())
	})

	result, err := backend.ControlSharedApp(context.Background(), AppControlRequest{
		SessionID:   "meet_session",
		Instruction: "observe active app",
		Timeout:     time.Second,
	})
	if err != nil {
		t.Fatalf("ControlSharedApp() error = %v", err)
	}
	if !result.OK || result.Summary != "startup stray ignored" {
		t.Fatalf("result = %#v, want success after startup stray", result)
	}
}

func TestKWWKStdioSessionConsumesBufferedResponseBeforeEOF(t *testing.T) {
	t.Parallel()

	for range 100 {
		session := &kwwkStdioSession{
			stdin:     discardWriteCloser{},
			stderr:    &bytes.Buffer{},
			responses: make(chan kwwkRPCResponse, 1),
			readErr:   make(chan error, 1),
			waitDone:  make(chan error, 1),
		}
		session.responses <- kwwkRPCResponse{
			ID:     "1",
			Result: []byte(`{"ok":true,"summary":"matched response survived eof","actions":["observe"],"confidence":0.7}`),
		}
		session.readErr <- nil

		var response kwwkAppControlResponse
		if err := session.Call(context.Background(), time.Second, kwwkAppControlMethod, map[string]any{}, &response); err != nil {
			t.Fatalf("Call() error = %v, want buffered response to win before EOF", err)
		}
		if !response.OK || response.Summary != "matched response survived eof" {
			t.Fatalf("response = %#v, want buffered matching response", response)
		}
	}
}

func TestKWWKStdioAppControlBackendResetsSessionAfterTimeout(t *testing.T) {
	t.Parallel()

	helper := writeKWWKAppControlHelperSource(t, `
import fs from "node:fs";
import readline from "node:readline";
const statePath = process.env.KWWK_TEST_STATE_PATH;
const priorStarts = Number(fs.existsSync(statePath) ? fs.readFileSync(statePath, "utf8") : "0");
fs.writeFileSync(statePath, String(priorStarts + 1));
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
for await (const line of rl) {
  const req = JSON.parse(line);
  if (priorStarts === 0) {
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  console.log(JSON.stringify({
    jsonrpc: "2.0",
    id: req.id,
    result: {
      ok: true,
      summary: priorStarts === 0 ? "late first response" : "fresh session response",
      actions: ["observe"],
      confidence: 0.7
    }
  }));
}
`)
	statePath := filepath.Join(t.TempDir(), "helper-starts.txt")
	backend := NewKWWKStdioAppControlBackend(KWWKStdioAppControlConfig{
		Command: "KWWK_TEST_STATE_PATH=" + shellQuote(statePath) + " node " + shellQuote(helper),
		Timeout: 100 * time.Millisecond,
	})
	t.Cleanup(func() {
		_ = backend.Shutdown(context.Background())
	})

	first, err := backend.ControlSharedApp(context.Background(), AppControlRequest{
		SessionID:   "meet_session",
		Instruction: "observe active app",
		Timeout:     100 * time.Millisecond,
	})
	if err != nil {
		t.Fatalf("ControlSharedApp(first) error = %v", err)
	}
	if first.OK || first.Error != "kwwk_app_control_unavailable" {
		t.Fatalf("first = %#v, want timeout surfaced as KWWK unavailable", first)
	}
	second, err := backend.ControlSharedApp(context.Background(), AppControlRequest{
		SessionID:   "meet_session",
		Instruction: "observe active app",
		Timeout:     time.Second,
	})
	if err != nil {
		t.Fatalf("ControlSharedApp(second) error = %v", err)
	}
	if !second.OK || second.Summary != "fresh session response" {
		t.Fatalf("second = %#v, want fresh helper session after timeout", second)
	}
}

func TestFallbackAppControlBackendFallsBackToCodexOnlyWhenKWWKUnavailable(t *testing.T) {
	t.Parallel()

	primary := &fakeAppControlBackend{
		name:   "kwwk",
		result: AppControlResult{OK: false, Provider: "kwwk", Status: appControlStatusFailed, Error: "kwwk_app_control_unconfigured"},
	}
	fallback := &fakeAppControlBackend{
		name:   "codex",
		result: AppControlResult{OK: true, Provider: "codex", Status: appControlStatusCompleted, Summary: "codex fallback handled it"},
	}
	backend := NewFallbackAppControlBackend(primary, fallback)

	result, err := backend.ControlSharedApp(context.Background(), AppControlRequest{Instruction: "draw"})
	if err != nil {
		t.Fatalf("ControlSharedApp() error = %v", err)
	}
	if !result.OK || result.Provider != "codex" || len(primary.requests) != 1 || len(fallback.requests) != 1 {
		t.Fatalf("result = %#v primary=%d fallback=%d, want Codex fallback after KWWK unavailable", result, len(primary.requests), len(fallback.requests))
	}

	primary.result = AppControlResult{OK: false, Provider: "kwwk", Status: appControlStatusFailed, Error: "app_control_blocked", Blocker: "unsafe_request"}
	fallback.requests = nil
	result, err = backend.ControlSharedApp(context.Background(), AppControlRequest{Instruction: "delete everything"})
	if err != nil {
		t.Fatalf("ControlSharedApp(blocked) error = %v", err)
	}
	if result.Provider != "kwwk" || len(fallback.requests) != 0 {
		t.Fatalf("result = %#v fallback=%d, blocked KWWK result must not fall through to Codex", result, len(fallback.requests))
	}

	primary.result = AppControlResult{OK: false, Provider: "kwwk", Status: appControlStatusFailed, Error: "accessibility_permission_required", Blocker: "accessibility_permission_required"}
	fallback.requests = nil
	result, err = backend.ControlSharedApp(context.Background(), AppControlRequest{Instruction: "open settings"})
	if err != nil {
		t.Fatalf("ControlSharedApp(accessibility) error = %v", err)
	}
	if result.Provider != "kwwk" || result.Error != "accessibility_permission_required" || len(fallback.requests) != 0 {
		t.Fatalf("result = %#v fallback=%d, accessibility blocker must stay explicit and not fall through to Codex", result, len(fallback.requests))
	}

	primary.result = AppControlResult{OK: false, Provider: "kwwk", Status: appControlStatusFailed, Error: "app_control_blocked", Blocker: "start button not found"}
	fallback.requests = nil
	result, err = backend.ControlSharedApp(context.Background(), AppControlRequest{Instruction: "look at Chrome, then click the start button"})
	if err != nil {
		t.Fatalf("ControlSharedApp(ui blocker) error = %v", err)
	}
	if result.Provider != "kwwk" || result.Blocker != "start button not found" || len(fallback.requests) != 0 {
		t.Fatalf("result = %#v fallback=%d, UI blocker must not fall through to Codex", result, len(fallback.requests))
	}

	primary.result = AppControlResult{OK: false, Provider: "kwwk", Status: appControlStatusFailed, Error: "computer_use_unavailable", Blocker: "computer_use_unavailable"}
	fallback.requests = nil
	result, err = backend.ControlSharedApp(context.Background(), AppControlRequest{Instruction: "observe active app"})
	if err != nil {
		t.Fatalf("ControlSharedApp(unrelated unavailable) error = %v", err)
	}
	if result.Provider != "kwwk" || result.Error != "computer_use_unavailable" || len(fallback.requests) != 0 {
		t.Fatalf("result = %#v fallback=%d, non-KWWK availability blocker must not fall through to Codex", result, len(fallback.requests))
	}

	primary.result = AppControlResult{OK: false, Provider: "kwwk", Status: "needs_background_agent", Error: "app_control_blocked", Blocker: "needs_background_agent"}
	fallback.requests = nil
	result, err = backend.ControlSharedApp(context.Background(), AppControlRequest{
		Instruction: "redesign the product roadmap in the shared document",
		Target:      AppControlTarget{ApplicationName: "Docs"},
	})
	if err != nil {
		t.Fatalf("ControlSharedApp(needs background agent) error = %v", err)
	}
	if !result.OK || result.Provider != "codex" || len(fallback.requests) != 1 {
		t.Fatalf("result = %#v fallback=%d, needs_background_agent must delegate to Codex fallback", result, len(fallback.requests))
	}
	if fallback.requests[0].Instruction != "redesign the product roadmap in the shared document" || fallback.requests[0].Target.ApplicationName != "Docs" {
		t.Fatalf("fallback request = %#v, want original instruction and target", fallback.requests[0])
	}
}

func writeKWWKAppControlHelper(t *testing.T) string {
	t.Helper()
	source := `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
for await (const line of rl) {
  const req = JSON.parse(line);
  const p = req.params || {};
  if (req.method === "kwwk.cu.control") {
    const control = p.control || "ping";
    console.log(JSON.stringify({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        ok: true,
        schema: "oneesama.kwwk-cu-control.v1",
        status: "ready",
        text: control === "ping" ? "pong" : "",
        methodFamily: "kwwk.cu",
        control
      }
    }));
    continue;
  }
  const operations = p.operations || [];
  if (!operations.length) {
    if (/redesign|路线图|roadmap|开发|debug|research/i.test(p.instruction || "")) {
      console.log(JSON.stringify({
        jsonrpc: "2.0",
        id: req.id,
        result: {
          ok: false,
          status: "needs_background_agent",
          summary: "background agent required for multi-step app task",
          actions: [],
          confidence: 0.4,
          blocker: "needs_background_agent",
          operations,
          metadata: { method: req.method, planner: { provider: "deterministic" } }
        }
      }));
      continue;
    }
    console.log(JSON.stringify({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        ok: true,
        summary: "kwwk observed instruction-only request: " + p.instruction,
        actions: ["observe"],
        confidence: 0.8,
        operations,
        metadata: { method: req.method, process_id: String(p.target.process_id), instruction: p.instruction }
      }
    }));
    continue;
  }
  const result = {
    ok: true,
    summary: "kwwk handled " + operations.length + " ops for window " + p.target.window_id,
    actions: ["state", "click", "drag"],
    confidence: 0.9,
    operations: [
      { kind: "state" },
      { kind: "click", x: 10, y: 20 },
      { kind: "drag", from_x: 20, from_y: 20, to_x: 100, to_y: 20 }
    ],
    metadata: { method: req.method, process_id: String(p.target.process_id) }
  };
  console.log(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }));
}
`
	return writeKWWKAppControlHelperSource(t, source)
}

func writeKWWKAppControlHelperSource(t *testing.T, source string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "kwwk-helper.mjs")
	if err := os.WriteFile(path, []byte(source), 0o755); err != nil {
		t.Fatalf("write helper: %v", err)
	}
	return path
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}

type discardWriteCloser struct{}

func (discardWriteCloser) Write(p []byte) (int, error) {
	return len(p), nil
}

func (discardWriteCloser) Close() error {
	return nil
}
