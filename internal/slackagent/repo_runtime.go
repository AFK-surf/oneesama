package slackagent

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

type slackRepoRuntimeOptions struct {
	SourceRepoPath string
	RuntimeDir     string
	WorktreeDir    string
}

type slackRepoRuntimeSnapshot struct {
	Mounted            bool
	MountedPath        string
	WritableCloneReady bool
	ClonePath          string
	WorktreeDir        string
	Head               string
	Branch             string
	Error              string
}

func ensureSlackRepoRuntime(options slackRepoRuntimeOptions) (slackRepoRuntimeSnapshot, error) {
	snapshot := collectSlackRepoRuntime(options)
	if !snapshot.Mounted {
		return snapshot, fmt.Errorf("source repo unavailable: %s", snapshot.Error)
	}
	if err := os.MkdirAll(options.RuntimeDir, 0o755); err != nil {
		return snapshot, err
	}
	clonePath := slackRepoRuntimeClonePath(options.RuntimeDir)
	if !slackRepoRuntimeIsGitWorkTree(clonePath) {
		_ = os.RemoveAll(clonePath)
		if _, err := runSlackRepoRuntimeGit("", "clone", options.SourceRepoPath, clonePath); err != nil {
			return snapshot, err
		}
	}
	if _, err := runSlackRepoRuntimeGit(clonePath, "fetch", "origin", snapshot.Branch); err != nil {
		return snapshot, err
	}
	if _, err := runSlackRepoRuntimeGit(clonePath, "checkout", snapshot.Branch); err != nil {
		return snapshot, err
	}
	if _, err := runSlackRepoRuntimeGit(clonePath, "reset", "--hard", snapshot.Head); err != nil {
		return snapshot, err
	}
	return collectSlackRepoRuntime(options), nil
}

func collectSlackRepoRuntime(options slackRepoRuntimeOptions) slackRepoRuntimeSnapshot {
	snapshot := slackRepoRuntimeSnapshot{
		MountedPath: options.SourceRepoPath,
		ClonePath:   slackRepoRuntimeClonePath(options.RuntimeDir),
		WorktreeDir: options.WorktreeDir,
	}
	if !slackRepoRuntimeIsGitWorkTree(options.SourceRepoPath) {
		snapshot.Error = "source repo is not a git worktree"
		return snapshot
	}
	snapshot.Mounted = true
	head, err := runSlackRepoRuntimeGit(options.SourceRepoPath, "rev-parse", "HEAD")
	if err != nil {
		snapshot.Error = err.Error()
		return snapshot
	}
	branch, err := runSlackRepoRuntimeGit(options.SourceRepoPath, "symbolic-ref", "--short", "HEAD")
	if err != nil {
		snapshot.Error = err.Error()
		return snapshot
	}
	snapshot.Head = strings.TrimSpace(string(head))
	snapshot.Branch = strings.TrimSpace(string(branch))
	if slackRepoRuntimeIsGitWorkTree(snapshot.ClonePath) {
		cloneHead, _ := runSlackRepoRuntimeGit(snapshot.ClonePath, "rev-parse", "HEAD")
		snapshot.WritableCloneReady = strings.TrimSpace(string(cloneHead)) == snapshot.Head
	}
	return snapshot
}

func slackRepoRuntimeClonePath(runtimeDir string) string {
	if strings.TrimSpace(runtimeDir) == "" {
		return ""
	}
	return filepath.Join(runtimeDir, "source")
}

func slackRepoRuntimeIsGitWorkTree(path string) bool {
	if strings.TrimSpace(path) == "" {
		return false
	}
	out, err := runSlackRepoRuntimeGit(path, "rev-parse", "--is-inside-work-tree")
	return err == nil && strings.TrimSpace(string(out)) == "true"
}

func runSlackRepoRuntimeGit(dir string, args ...string) ([]byte, error) {
	cmdArgs := make([]string, 0, len(args)+2)
	if strings.TrimSpace(dir) != "" {
		cmdArgs = append(cmdArgs, "-C", dir)
	}
	cmdArgs = append(cmdArgs, args...)
	cmd := exec.Command("git", cmdArgs...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return output, fmt.Errorf("git %s: %w: %s", strings.Join(cmdArgs, " "), err, strings.TrimSpace(string(output)))
	}
	return output, nil
}
