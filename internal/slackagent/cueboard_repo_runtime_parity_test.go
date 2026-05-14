//go:build cueboardparity

package slackagent

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCueboardParityEnsureRepoRuntimeBootstrapsWritableCloneFromCommittedHead(t *testing.T) {
	repoPath, branch, head := cueboardParityInitGitRepo(t)
	trackedPath := filepath.Join(repoPath, "README.md")
	if err := os.WriteFile(trackedPath, []byte("dirty host change\n"), 0o644); err != nil {
		t.Fatalf("write dirty host file: %v", err)
	}

	baseDir := t.TempDir()
	options := slackRepoRuntimeOptions{
		SourceRepoPath: repoPath,
		RuntimeDir:     filepath.Join(baseDir, "repos"),
		WorktreeDir:    filepath.Join(baseDir, "worktrees"),
	}

	snapshot, err := ensureSlackRepoRuntime(options)
	if err != nil {
		t.Fatalf("ensureSlackRepoRuntime: %v", err)
	}

	clonePath := slackRepoRuntimeClonePath(options.RuntimeDir)
	if !slackRepoRuntimeIsGitWorkTree(clonePath) {
		t.Fatalf("clone path %q is not a git worktree", clonePath)
	}
	cloneContent, err := os.ReadFile(filepath.Join(clonePath, "README.md"))
	if err != nil {
		t.Fatalf("read clone README: %v", err)
	}
	if strings.Contains(string(cloneContent), "dirty host change") {
		t.Fatalf("writable clone should reflect committed HEAD only, got %q", string(cloneContent))
	}
	if got := strings.TrimSpace(string(cueboardParityRunGit(t, clonePath, "rev-parse", "HEAD"))); got != head {
		t.Fatalf("clone HEAD = %q, want %q", got, head)
	}
	if got := strings.TrimSpace(string(cueboardParityRunGit(t, clonePath, "symbolic-ref", "--short", "HEAD"))); got != branch {
		t.Fatalf("clone branch = %q, want %q", got, branch)
	}

	if !snapshot.Mounted {
		t.Fatal("snapshot.Mounted = false, want true")
	}
	if !snapshot.WritableCloneReady {
		t.Fatal("snapshot.WritableCloneReady = false, want true")
	}
	if snapshot.Head != head {
		t.Fatalf("snapshot.Head = %q, want %q", snapshot.Head, head)
	}
	if snapshot.Branch != branch {
		t.Fatalf("snapshot.Branch = %q, want %q", snapshot.Branch, branch)
	}
	if snapshot.WorktreeDir != options.WorktreeDir {
		t.Fatalf("snapshot.WorktreeDir = %q, want %q", snapshot.WorktreeDir, options.WorktreeDir)
	}
}
