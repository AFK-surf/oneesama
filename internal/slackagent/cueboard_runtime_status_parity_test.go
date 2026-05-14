//go:build cueboardparity

package slackagent

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCueboardParityRuntimeStatusHeartbeatNoResultYet(t *testing.T) {
	t.Parallel()

	body := formatRuntimeStatusHeartbeat(&slackRuntimeStatusData{
		HeartbeatInterval:           15 * time.Minute,
		HeartbeatGlobalPendingCount: 0,
		HeartbeatLogPath:            filepath.Join(t.TempDir(), "heartbeat.log"),
	})

	for _, want := range []string{
		"Scope: global",
		"Loop: stopped",
		"Interval: 15m0s",
		"Next tick: unknown",
		"Last result: none yet",
		"Last status: none yet",
		"Pending follow-ups: 0",
		"Notify delivery: none yet",
		"Log path: ",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("heartbeat output missing %q:\n%s", want, body)
		}
	}
}

func TestCueboardParityRuntimeStatusHeartbeatWithRecordedResult(t *testing.T) {
	t.Parallel()

	body := formatRuntimeStatusHeartbeat(&slackRuntimeStatusData{
		HeartbeatInterval:           15 * time.Minute,
		HeartbeatLastAt:             time.Date(2026, 3, 24, 14, 35, 0, 0, shanghaiLocation()),
		HeartbeatTitle:              "Daily heartbeat",
		HeartbeatSummary:            "Scheduler and scanner look healthy.",
		HeartbeatNotified:           true,
		HeartbeatGlobalPendingCount: 0,
		HeartbeatLogPath:            filepath.Join(t.TempDir(), "heartbeat.log"),
	})

	for _, want := range []string{
		"Scope: global",
		"Loop: stopped",
		"Interval: 15m0s",
		"Next tick: unknown",
		"Title: Daily heartbeat",
		"Summary: Scheduler and scanner look healthy.",
		"Pending follow-ups: 0",
		"Last status: sent",
		"Notify delivery: sent",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("heartbeat output missing %q:\n%s", want, body)
		}
	}
}

func TestCueboardParityRuntimeStatusHeartbeatIncludesNextTickAndRecentSurfaces(t *testing.T) {
	t.Parallel()

	body := formatRuntimeStatusHeartbeat(&slackRuntimeStatusData{
		HeartbeatLoop:     true,
		HeartbeatInterval: 15 * time.Minute,
		HeartbeatNextTickAt: time.Date(2026, 3, 24, 19, 0, 0, 0,
			shanghaiLocation()),
		HeartbeatLastAt: time.Date(2026, 3, 24, 18, 45, 0, 0,
			shanghaiLocation()),
		HeartbeatTitle:              "Queue checked",
		HeartbeatSummary:            "Replied in thread.",
		HeartbeatGlobalPendingCount: 0,
		HeartbeatLogPath:            "/tmp/test-heartbeat.log",
		HeartbeatSurfaces: []runtimeHeartbeatSurfaceView{
			{Title: "Queue checked", RequestedSurface: "auto", DeliveredSurface: "thread", Status: "sent"},
		},
	})

	for _, want := range []string{
		"Scope: global",
		"Next tick: 2026-03-24 19:00:00",
		"Last result: 2026-03-24 18:45:00",
		"Pending follow-ups: 0",
		"Recent surfaces:",
		"Queue checked via thread — sent",
		"Log path: /tmp/test-heartbeat.log",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("formatted heartbeat output missing %q:\n%s", want, body)
		}
	}
}

func TestCueboardParityRuntimeStatusReposMountedRepo(t *testing.T) {
	t.Parallel()

	repoPath, branch, head := cueboardParityInitGitRepo(t)
	body := formatRuntimeStatusRepos(&slackRuntimeStatusData{
		RepoMountedPath: repoPath,
		RepoMounted:     true,
		RepoClonePath:   filepath.Join(t.TempDir(), "repos", "source"),
		RepoCloneReady:  true,
		RepoWorktreeDir: filepath.Join(t.TempDir(), "worktrees"),
		RepoBranch:      branch,
		RepoHEAD:        head,
	})

	for _, want := range []string{
		"Source repo: " + repoPath,
		"Available: yes",
		"Clone ready: yes",
		"Worktree root: ",
		"Host branch: " + branch,
		"Host HEAD: " + head,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("repos output missing %q:\n%s", want, body)
		}
	}
}

func TestCueboardParityRuntimeStatusReposUnavailable(t *testing.T) {
	t.Parallel()

	body := formatRuntimeStatusRepos(&slackRuntimeStatusData{
		RepoWorktreeDir: filepath.Join(t.TempDir(), "worktrees"),
		RepoError:       "no source repo discovered",
	})

	for _, want := range []string{
		"Available: no",
		"Clone ready: no",
		"Repo error: no source repo discovered",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("repos unavailable output missing %q:\n%s", want, body)
		}
	}
}

func TestCueboardParityRuntimeStatusMeetingsIncludesLiveProcessingAndRecentActivity(t *testing.T) {
	t.Parallel()

	body := formatRuntimeStatusMeetings(&runtimeMeetingsSnapshot{
		Live:       []runtimeMeetingView{{ID: 20, Title: "Team Meeting", Status: "waiting_room"}},
		Processing: []runtimeMeetingView{{ID: 19, Title: "Meeting", Status: "processing"}},
		Recent:     []runtimeMeetingView{{ID: 18, Title: "Ad-hoc meeting", Status: "done"}},
	})

	for _, want := range []string{
		"Live meetings: 1",
		"Post-processing: 1",
		"Recent finished/failed: 1",
		"Live join/listen activity:",
		"#20 Team Meeting (waiting_room",
		"Post-processing activity:",
		"#19 Meeting (processing",
		"Recent finished or failed:",
		"#18 Ad-hoc meeting (done",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("meetings output missing %q:\n%s", want, body)
		}
	}
}

func TestCueboardParityRuntimeStatusOverviewIncludesMeetingsSummary(t *testing.T) {
	t.Parallel()

	body := formatRuntimeStatusOverview(&slackRuntimeStatusData{
		RunMode:       "full",
		WorkspaceDir:  "/tmp/workspace",
		ScanMode:      "event",
		Debounce:      "1m0s",
		MaxBatch:      8,
		HeartbeatLoop: true,
	}, &runtimeMeetingsSnapshot{
		Live: []runtimeMeetingView{{ID: 20, Title: "Team Meeting", Status: "waiting_room"}},
	})

	if !strings.Contains(body, "Meetings: 1 live (Team Meeting=waiting_room)") {
		t.Fatalf("overview output missing meetings summary:\n%s", body)
	}
}

func TestCueboardParityRuntimeStatusHeartbeatScopesFollowupsToCurrentThread(t *testing.T) {
	t.Parallel()

	runtime := &slackRuntimeStatusData{
		HeartbeatInterval:       15 * time.Minute,
		HeartbeatLastAt:         time.Date(2026, 3, 24, 19, 10, 0, 0, shanghaiLocation()),
		HeartbeatLastFollowupID: 2,
		HeartbeatTitle:          "Foreign heartbeat result",
		HeartbeatSummary:        "Should not leak here.",
		HeartbeatNotified:       true,
	}
	scoped := scopedRuntimeHeartbeat(runtime, []SlackHeartbeatFollowup{
		{ID: 1, Title: "Current thread follow-up", Summary: "Need to reply here.", SourceKind: "thread", ChannelID: "C123", ThreadTS: "123.456", Priority: "high"},
		{ID: 2, Title: "Foreign thread follow-up", Summary: "Should stay hidden.", SourceKind: "thread", ChannelID: "C999", ThreadTS: "999.000", Priority: "high"},
	}, []SlackHeartbeatSurface{
		{FollowupID: 1, Title: "Current thread follow-up", Summary: "Replied here.", RequestedSurface: "auto", DeliveredSurface: "thread", ChannelID: "C123", ThreadTS: "123.456", Status: "sent"},
		{FollowupID: 2, Title: "Foreign thread follow-up", Summary: "Replied elsewhere.", RequestedSurface: "auto", DeliveredSurface: "thread", ChannelID: "C999", ThreadTS: "999.000", Status: "sent"},
	}, "C123", "123.456")
	body := formatRuntimeStatusHeartbeat(scoped)

	for _, want := range []string{
		"Scope: thread C123/123.456",
		"Global pending follow-ups: 2",
		"Visible pending follow-ups: 1",
		"Last result: hidden outside this thread",
		"Current thread follow-up",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("expected scoped output to contain %q:\n%s", want, body)
		}
	}
	if strings.Contains(body, "Foreign thread follow-up") || strings.Contains(body, "Foreign heartbeat result") {
		t.Fatalf("scoped runtime output leaked foreign thread data:\n%s", body)
	}
}

func cueboardParityInitGitRepo(t *testing.T) (repoPath string, branch string, head string) {
	t.Helper()

	repoPath = t.TempDir()
	cueboardParityRunGit(t, "", "init", "-b", "main", repoPath)
	cueboardParityRunGit(t, repoPath, "config", "user.name", "Codex Test")
	cueboardParityRunGit(t, repoPath, "config", "user.email", "codex@example.com")
	if err := os.WriteFile(filepath.Join(repoPath, "README.md"), []byte("hello repo\n"), 0o644); err != nil {
		t.Fatalf("write README: %v", err)
	}
	cueboardParityRunGit(t, repoPath, "add", "README.md")
	cueboardParityRunGit(t, repoPath, "commit", "-m", "initial commit")
	branch = strings.TrimSpace(string(cueboardParityRunGit(t, repoPath, "symbolic-ref", "--short", "HEAD")))
	head = strings.TrimSpace(string(cueboardParityRunGit(t, repoPath, "rev-parse", "HEAD")))
	return repoPath, branch, head
}

func cueboardParityRunGit(t *testing.T, repoPath string, args ...string) []byte {
	t.Helper()

	cmdArgs := make([]string, 0, len(args)+2)
	if strings.TrimSpace(repoPath) != "" {
		cmdArgs = append(cmdArgs, "-C", repoPath)
	}
	cmdArgs = append(cmdArgs, args...)
	cmd := exec.Command("git", cmdArgs...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(cmdArgs, " "), err, strings.TrimSpace(string(output)))
	}
	return output
}
