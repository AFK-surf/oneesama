package agentrunner

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestCommandProviderCapsStdout(t *testing.T) {
	t.Parallel()

	provider := commandProvider{
		provider: "codex",
		bin:      "/bin/sh",
		argsBuilder: func(StartInput) []string {
			return []string{"-c", "yes x | head -c 1100000"}
		},
	}

	result, err := provider.Run(context.Background(), StartInput{Task: "overflow"})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if result.Status != StatusCompleted {
		t.Fatalf("result.Status = %q, want completed", result.Status)
	}
	if len(result.Result) <= maxCommandOutputBytes {
		t.Fatalf("len(result.Result) = %d, want > %d with truncation marker", len(result.Result), maxCommandOutputBytes)
	}
	if !strings.Contains(result.Result, "[output truncated]") {
		t.Fatalf("result.Result missing truncation marker")
	}
}

func TestCommandProviderCancelKillsChildProcessGroup(t *testing.T) {
	t.Parallel()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	provider := commandProvider{
		provider: "codex",
		bin:      "/bin/sh",
		argsBuilder: func(StartInput) []string {
			return []string{"-c", "cat >/dev/null; sleep 5"}
		},
		promptBuilder: func(StartInput) string {
			return "prompt"
		},
		stdinPrompt: true,
	}

	go func() {
		time.Sleep(50 * time.Millisecond)
		cancel()
	}()

	startedAt := time.Now()
	result, err := provider.Run(ctx, StartInput{Task: "cancel me"})
	elapsed := time.Since(startedAt)
	if err == nil {
		t.Fatalf("Run() error = nil, want cancel error")
	}
	if elapsed > time.Second {
		t.Fatalf("Run() elapsed = %s, want < 1s", elapsed)
	}
	if result.Status != StatusFailed {
		t.Fatalf("result.Status = %q, want failed", result.Status)
	}
	if result.Error != "job canceled" {
		t.Fatalf("result.Error = %q, want job canceled", result.Error)
	}
}
