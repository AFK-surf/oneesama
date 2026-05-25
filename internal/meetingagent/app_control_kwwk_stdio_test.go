package meetingagent

import (
	"context"
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
		Operations: []KWWKAppControlOperation{
			{Kind: KWWKAppControlState},
			{Kind: KWWKAppControlClick, X: 10, Y: 20},
			{Kind: KWWKAppControlDrag, FromX: 20, FromY: 20, ToX: 100, ToY: 20},
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

	if !first.OK || first.Provider != "kwwk" || first.Summary != "kwwk handled 3 ops for window 991" {
		t.Fatalf("first = %#v, want KWWK success with window target", first)
	}
	if second.Summary != "kwwk handled 3 ops for window 991" {
		t.Fatalf("second = %#v, want persistent helper to handle second call", second)
	}
	if len(first.Actions) != 3 || first.Actions[0] != "state" || first.Actions[1] != "click" || first.Actions[2] != "drag" {
		t.Fatalf("actions = %#v, want state/click/drag", first.Actions)
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
}

func writeKWWKAppControlHelper(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "kwwk-helper.mjs")
	source := `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
for await (const line of rl) {
  const req = JSON.parse(line);
  const p = req.params || {};
  const result = {
    ok: true,
    summary: "kwwk handled " + p.operations.length + " ops for window " + p.target.window_id,
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
	if err := os.WriteFile(path, []byte(source), 0o755); err != nil {
		t.Fatalf("write helper: %v", err)
	}
	return path
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}
