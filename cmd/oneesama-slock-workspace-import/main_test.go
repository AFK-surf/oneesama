package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRunRequiresSourceAgentsRoot(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := run([]string{"--target-workspace", t.TempDir()}, &stdout, &stderr)
	if code != 1 {
		t.Fatalf("exit code = %d, want 1", code)
	}
	if !strings.Contains(stderr.String(), "source agents root is required") {
		t.Fatalf("stderr = %q, want missing source error", stderr.String())
	}
}

func TestRunDryRunReport(t *testing.T) {
	sourceRoot := t.TempDir()
	targetWorkspace := t.TempDir()
	writeFixtureFile(t, sourceRoot, "agent-alpha", "MEMORY.md", "# Alpha\n\nSlock D memory")

	var stdout, stderr bytes.Buffer
	code := run([]string{
		"--source-agents-root", sourceRoot,
		"--target-workspace", targetWorkspace,
	}, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("exit code = %d stderr = %q", code, stderr.String())
	}
	out := stdout.String()
	for _, want := range []string{
		"# Slock D workspace import report",
		"- Mode: dry-run",
		"- Agents scanned: 1",
		"memory/legacy/slock-d/agents/agent-alpha/MEMORY.md",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("stdout = %q, want %q", out, want)
		}
	}
	if _, err := os.Stat(filepath.Join(targetWorkspace, "memory", "legacy", "slock-d")); !os.IsNotExist(err) {
		t.Fatalf("dry-run wrote target directory, stat err = %v", err)
	}
}

func TestRunWriteCreatesFiles(t *testing.T) {
	sourceRoot := t.TempDir()
	targetWorkspace := t.TempDir()
	writeFixtureFile(t, sourceRoot, "agent-alpha", "MEMORY.md", "# Alpha\n\nSlock D memory")

	var stdout, stderr bytes.Buffer
	code := run([]string{
		"--source-agents-root", sourceRoot,
		"--target-workspace", targetWorkspace,
		"--write",
	}, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("exit code = %d stderr = %q", code, stderr.String())
	}
	if !strings.Contains(stdout.String(), "- Mode: write") {
		t.Fatalf("stdout = %q, want write mode", stdout.String())
	}
	if _, err := os.Stat(filepath.Join(targetWorkspace, "memory", "legacy", "slock-d", "agents", "agent-alpha", "MEMORY.md")); err != nil {
		t.Fatalf("expected generated file: %v", err)
	}
}

func writeFixtureFile(t *testing.T, root, agentID, rel, content string) {
	t.Helper()
	path := filepath.Join(root, agentID, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("MkdirAll(%s): %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("WriteFile(%s): %v", path, err)
	}
}
