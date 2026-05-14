//go:build cueboardparity

package slackagent

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestCueboardParitySlackSessionDurableStateSurvivesColdStart(t *testing.T) {
	ctx := context.Background()
	dataDir := t.TempDir()
	now := time.Date(2026, 3, 20, 10, 0, 0, 0, time.UTC)
	withCueboardParityClock(t, now)

	first := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "json-file", DataDir: dataDir},
		Runner:      &fakeRunner{job: agentrunner.Job{ID: "job_a", Provider: "dry-run", Status: agentrunner.StatusCompleted}},
	})
	if err := first.cognition.RecordInbound(ctx, "W1", SlackInboundMessage{
		ChannelID: "C1",
		ThreadTS:  "123.456",
		UserID:    "U-requester",
		TS:        "123.456",
		Text:      "Open loop: launch blocker needs an owner",
	}); err != nil {
		t.Fatalf("RecordInbound: %v", err)
	}
	if err := first.cognition.RecordOutbound(ctx, "W1", "C1", "123.456", "Open loop: launch blocker needs an owner"); err != nil {
		t.Fatalf("RecordOutbound: %v", err)
	}
	if first.cognition.brains != nil {
		_ = first.cognition.brains.Close()
	}
	if first.cognition.ledgers != nil {
		_ = first.cognition.ledgers.Close()
	}

	reopened := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "json-file", DataDir: dataDir},
		Runner:      &fakeRunner{job: agentrunner.Job{ID: "job_b", Provider: "dry-run", Status: agentrunner.StatusCompleted}},
	})
	t.Cleanup(func() {
		if reopened.cognition.brains != nil {
			_ = reopened.cognition.brains.Close()
		}
		if reopened.cognition.ledgers != nil {
			_ = reopened.cognition.ledgers.Close()
		}
	})

	ledger, err := reopened.cognition.GetThreadLedger(ctx, "W1", "C1", "123.456")
	if err != nil {
		t.Fatalf("GetThreadLedger: %v", err)
	}
	if ledger == nil || ledger.OwnerUserID != "U-requester" || ledger.Summary == "" {
		t.Fatalf("ledger after cold start = %#v, want durable owner and summary", ledger)
	}
	brain, err := reopened.cognition.GetChannelBrain(ctx, "W1", "C1")
	if err != nil {
		t.Fatalf("GetChannelBrain: %v", err)
	}
	if brain == nil || !strings.Contains(brain.Summary, "launch blocker needs an owner") {
		t.Fatalf("channel brain after cold start = %#v, want rebuilt durable summary", brain)
	}
}

func TestCueboardParitySlackSessionReusesLatestMeetingContextAcrossCommands(t *testing.T) {
	ctx := context.Background()
	store := newSlackContextStore(appconfig.PersistenceConfig{Provider: "memory"}, cueboardParityDiscardLogger())

	first, err := store.Remember(ctx, AvatarCommandInput{
		TeamID:    "W1",
		ChannelID: "C1",
		ThreadTS:  "123.456",
		UserID:    "U1",
		Text:      "join https://meet.google.com/abc-defg-hij",
	}, parsedAvatarCommand{
		Action:  "join",
		MeetURL: "https://meet.google.com/abc-defg-hij",
	}, &meetingAgentSession{ID: "session_a", MeetingURL: "https://meet.google.com/abc-defg-hij"})
	if err != nil {
		t.Fatalf("first Remember: %v", err)
	}
	second, err := store.Remember(ctx, AvatarCommandInput{
		TeamID:    "W1",
		ChannelID: "C1",
		ThreadTS:  "123.456",
		UserID:    "U2",
		Text:      "status",
	}, parsedAvatarCommand{Action: "status"}, nil)
	if err != nil {
		t.Fatalf("second Remember: %v", err)
	}

	if first.ID != second.ID {
		t.Fatalf("context id changed = %q -> %q", first.ID, second.ID)
	}
	if second.ThreadLedger.LatestSessionID != "session_a" || second.ThreadLedger.LatestMeetURL != "https://meet.google.com/abc-defg-hij" {
		t.Fatalf("thread ledger = %#v, want previous session/meet URL reused", second.ThreadLedger)
	}
	if second.CommandCount != 2 || len(second.RecentCommands) != 2 {
		t.Fatalf("history = count %d len %d, want two commands", second.CommandCount, len(second.RecentCommands))
	}
}

func TestCueboardParitySlackSessionBoundedRecentCommands(t *testing.T) {
	ctx := context.Background()
	store := newSlackContextStore(appconfig.PersistenceConfig{Provider: "memory"}, cueboardParityDiscardLogger())

	var record *SlackContextRecord
	for i := 0; i < 14; i++ {
		var err error
		record, err = store.Remember(ctx, AvatarCommandInput{
			TeamID:    "W1",
			ChannelID: "C1",
			ThreadTS:  "123.456",
			UserID:    "U1",
			Text:      "command " + string(rune('a'+i)),
		}, parsedAvatarCommand{Action: "status"}, nil)
		if err != nil {
			t.Fatalf("Remember %d: %v", i, err)
		}
	}
	if record.CommandCount != 14 || len(record.RecentCommands) != 12 {
		t.Fatalf("history = count %d len %d, want total count 14 and last 12 retained", record.CommandCount, len(record.RecentCommands))
	}
	if record.RecentCommands[0].Text != "command c" || record.RecentCommands[len(record.RecentCommands)-1].Text != "command n" {
		t.Fatalf("recent commands window = %#v, want last 12 commands", record.RecentCommands)
	}
}

func TestCueboardParityNormalizeObservedChannelType(t *testing.T) {
	t.Parallel()

	cases := []struct {
		in   string
		want string
	}{
		{in: "channel", want: "public_channel"},
		{in: "group", want: "private_channel"},
		{in: "private_channel", want: "private_channel"},
		{in: "im", want: "im"},
		{in: "", want: "public_channel"},
	}
	for _, tc := range cases {
		t.Run(tc.in, func(t *testing.T) {
			if got := normalizeObservedChannelType(tc.in); got != tc.want {
				t.Fatalf("normalizeObservedChannelType(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestCueboardParitySlackRepoRuntimeRefreshesWritableClone(t *testing.T) {
	repoPath, _, initialHead := cueboardParityInitGitRepo(t)
	baseDir := t.TempDir()
	options := slackRepoRuntimeOptions{
		SourceRepoPath: repoPath,
		RuntimeDir:     filepath.Join(baseDir, "repos"),
		WorktreeDir:    filepath.Join(baseDir, "worktrees"),
	}
	if _, err := ensureSlackRepoRuntime(options); err != nil {
		t.Fatalf("initial ensureSlackRepoRuntime: %v", err)
	}

	if err := os.WriteFile(filepath.Join(repoPath, "README.md"), []byte("second commit\n"), 0o644); err != nil {
		t.Fatalf("write updated README: %v", err)
	}
	cueboardParityRunGit(t, repoPath, "add", "README.md")
	cueboardParityRunGit(t, repoPath, "commit", "-m", "second commit")
	updatedHead := strings.TrimSpace(string(cueboardParityRunGit(t, repoPath, "rev-parse", "HEAD")))
	if updatedHead == initialHead {
		t.Fatal("expected source repo HEAD to advance")
	}

	snapshot, err := ensureSlackRepoRuntime(options)
	if err != nil {
		t.Fatalf("refresh ensureSlackRepoRuntime: %v", err)
	}
	clonePath := slackRepoRuntimeClonePath(options.RuntimeDir)
	cloneHead := strings.TrimSpace(string(cueboardParityRunGit(t, clonePath, "rev-parse", "HEAD")))
	if cloneHead != updatedHead {
		t.Fatalf("clone HEAD = %q, want refreshed %q", cloneHead, updatedHead)
	}
	if !snapshot.WritableCloneReady || snapshot.Head != updatedHead {
		t.Fatalf("snapshot = %#v, want refreshed writable clone", snapshot)
	}
}

func withCueboardParityClock(t *testing.T, now time.Time) {
	t.Helper()
	previous := timeNow
	timeNow = func() time.Time { return now }
	t.Cleanup(func() { timeNow = previous })
}
