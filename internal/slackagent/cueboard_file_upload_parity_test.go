//go:build cueboardparity

package slackagent

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCueboardParityUploadPathParamPrefersCanonicalPathOverLegacyAlias(t *testing.T) {
	params := map[string]any{
		"path":      "workspace/result.png",
		"file_path": "/tmp/result.png",
	}
	if got := uploadPathParam(params); got != "workspace/result.png" {
		t.Fatalf("uploadPathParam() = %q, want canonical path", got)
	}
}

func TestCueboardParityUploadPathParamFallsBackToLegacyFilePathAlias(t *testing.T) {
	params := map[string]any{
		"file_path": "/tmp/result.png",
	}
	if got := uploadPathParam(params); got != "/tmp/result.png" {
		t.Fatalf("uploadPathParam() = %q, want legacy alias fallback", got)
	}
}

func TestCueboardParityEnsurePathWithinWorkspaceAllowsWorkspaceFiles(t *testing.T) {
	workspaceDir := t.TempDir()
	filePath := filepath.Join(workspaceDir, "artifacts", "result.txt")
	if err := os.MkdirAll(filepath.Dir(filePath), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filePath, []byte("ok"), 0o644); err != nil {
		t.Fatalf("write file: %v", err)
	}

	resolver := slackWorkspaceFileResolver{workspaceDir: workspaceDir}
	if err := resolver.ensurePathWithinWorkspace(filePath); err != nil {
		t.Fatalf("ensurePathWithinWorkspace(%q): %v", filePath, err)
	}
}

func TestCueboardParityEnsurePathWithinWorkspaceRejectsOutsideFiles(t *testing.T) {
	baseDir := t.TempDir()
	workspaceDir := filepath.Join(baseDir, "workspace")
	if err := os.MkdirAll(workspaceDir, 0o755); err != nil {
		t.Fatalf("mkdir workspace: %v", err)
	}
	outsideFile := filepath.Join(baseDir, "outside.txt")
	if err := os.WriteFile(outsideFile, []byte("nope"), 0o644); err != nil {
		t.Fatalf("write outside file: %v", err)
	}

	resolver := slackWorkspaceFileResolver{workspaceDir: workspaceDir}
	if err := resolver.ensurePathWithinWorkspace(outsideFile); err == nil {
		t.Fatalf("expected outside file %q to be rejected", outsideFile)
	}
}

func TestCueboardParityEnsurePathWithinWorkspaceRejectsSymlinkEscapes(t *testing.T) {
	baseDir := t.TempDir()
	workspaceDir := filepath.Join(baseDir, "workspace")
	if err := os.MkdirAll(workspaceDir, 0o755); err != nil {
		t.Fatalf("mkdir workspace: %v", err)
	}
	outsideFile := filepath.Join(baseDir, "outside.txt")
	if err := os.WriteFile(outsideFile, []byte("secret"), 0o644); err != nil {
		t.Fatalf("write outside file: %v", err)
	}
	linkPath := filepath.Join(workspaceDir, "leak.txt")
	if err := os.Symlink(outsideFile, linkPath); err != nil {
		t.Fatalf("create symlink: %v", err)
	}

	resolver := slackWorkspaceFileResolver{workspaceDir: workspaceDir}
	if err := resolver.ensurePathWithinWorkspace(linkPath); err == nil {
		t.Fatalf("expected symlink escape %q to be rejected", linkPath)
	}
}

func TestCueboardParityResolveLocalUploadPathRejectsOutsideAbsolutePaths(t *testing.T) {
	baseDir := t.TempDir()
	workspaceDir := filepath.Join(baseDir, "workspace")
	if err := os.MkdirAll(workspaceDir, 0o755); err != nil {
		t.Fatalf("mkdir workspace: %v", err)
	}
	outsideFile := filepath.Join(baseDir, "outside.txt")
	if err := os.WriteFile(outsideFile, []byte("nope"), 0o644); err != nil {
		t.Fatalf("write outside file: %v", err)
	}

	resolver := slackWorkspaceFileResolver{workspaceDir: workspaceDir}
	if _, err := resolver.resolveLocalUploadPath(outsideFile); err == nil {
		t.Fatalf("expected outside path %q to be rejected", outsideFile)
	}
}

func TestCueboardParityResolveLocalUploadPathStagesTmpArtifactsIntoWorkspace(t *testing.T) {
	workspaceDir := filepath.Join(t.TempDir(), "workspace")
	if err := os.MkdirAll(workspaceDir, 0o755); err != nil {
		t.Fatalf("mkdir workspace: %v", err)
	}

	tmpFile, err := os.CreateTemp("/tmp", "cueboard-upload-*.png")
	if err != nil {
		t.Fatalf("create temp file: %v", err)
	}
	tmpPath := tmpFile.Name()
	t.Cleanup(func() { _ = os.Remove(tmpPath) })
	if _, err := tmpFile.WriteString("png-bytes"); err != nil {
		t.Fatalf("write temp file: %v", err)
	}
	if err := tmpFile.Close(); err != nil {
		t.Fatalf("close temp file: %v", err)
	}

	resolver := slackWorkspaceFileResolver{workspaceDir: workspaceDir}
	got, err := resolver.resolveLocalUploadPath(tmpPath)
	if err != nil {
		t.Fatalf("resolveLocalUploadPath(%q): %v", tmpPath, err)
	}
	if got == tmpPath {
		t.Fatalf("expected temp file to be staged into workspace, got original path %q", got)
	}
	wantRoot := filepath.Join(workspaceDir, ".tmp", "slack-upload-staging") + string(filepath.Separator)
	if !strings.HasPrefix(got, wantRoot) {
		t.Fatalf("expected staged path under %q, got %q", wantRoot, got)
	}
	body, err := os.ReadFile(got)
	if err != nil {
		t.Fatalf("read staged file: %v", err)
	}
	if string(body) != "png-bytes" {
		t.Fatalf("unexpected staged file body: %q", string(body))
	}
}
