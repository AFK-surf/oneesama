//go:build cueboardparity

package meetrunner

import (
	"context"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/AFK-surf/oneesama/internal/processutil"
)

func TestCueboardParityRunnerCommandUsesNodeEntrypoint(t *testing.T) {
	t.Parallel()

	path, args, err := resolveRunnerCommand("/tmp/meet-runner", "")
	if err != nil {
		t.Fatalf("resolveRunnerCommand() error = %v", err)
	}
	if filepath.Base(path) != "node" {
		t.Fatalf("command path = %q, want node runtime", path)
	}
	if len(args) != 1 || args[0] != "src/index.ts" {
		t.Fatalf("args = %#v, want src/index.ts entrypoint", args)
	}
}

func TestCueboardParityRunnerCommandOverrideKeepsEntrypointArg(t *testing.T) {
	t.Parallel()

	path, args, err := resolveRunnerCommand("/tmp/meet-runner", "/usr/local/bin/node")
	if err != nil {
		t.Fatalf("resolveRunnerCommand() error = %v", err)
	}
	if path != "/usr/local/bin/node" {
		t.Fatalf("command path = %q, want override", path)
	}
	if len(args) != 1 || args[0] != "src/index.ts" {
		t.Fatalf("args = %#v, want src/index.ts entrypoint", args)
	}
}

func TestCueboardParityPrepareCommandSetsProcessGroupOnUnix(t *testing.T) {
	t.Parallel()

	command := exec.Command("node", "src/index.ts")
	processutil.PrepareGroup(command)
	if command.SysProcAttr == nil || !command.SysProcAttr.Setpgid {
		t.Fatalf("SysProcAttr = %#v, want process group isolation", command.SysProcAttr)
	}
}

func TestCueboardParityTerminateCommandNilIsNoop(t *testing.T) {
	t.Parallel()

	if err := processutil.KillGroup("meet-runner", nil); err != nil {
		t.Fatalf("KillGroup(nil) error = %v", err)
	}
}

func TestCueboardParityManagerPreservesJoinerFlagsInPlan(t *testing.T) {
	t.Parallel()
	requireMeetRunnerRuntime(t)

	manager := New(Config{Dir: filepath.Join("..", "..", "meet-runner"), Timeout: 3 * time.Second})
	result, err := manager.PrepareGoogleMeet(testContext(t), PrepareGoogleMeetInput{
		SessionID:                 "session_joiner_parity",
		MeetingURL:                "https://meet.google.com/abc-defg-hij",
		DryRun:                    true,
		CollectFixtureState:       true,
		CaptureCaptions:           true,
		CaptionLanguage:           "English",
		RecordMeeting:             true,
		ArtifactsDir:              "/tmp/session_joiner_parity",
		MeetAudioBackend:          "none",
		InstallRealtimeBridge:     true,
		InstallWorkerResultBridge: true,
		AutoStartScreenShare:      true,
	})
	if err != nil {
		t.Fatalf("PrepareGoogleMeet() error = %v", err)
	}
	if !result.Plan.CollectFixtureState || !result.Plan.CaptureCaptions || result.Plan.CaptionLanguage != "English" ||
		!result.Plan.RecordMeeting || result.Plan.ArtifactsDir != "/tmp/session_joiner_parity" || result.Plan.MeetAudioBackend != "none" ||
		!result.Plan.InstallAvatar || result.Plan.DisableLive2D || !result.Plan.InstallRealtimeBridge ||
		!result.Plan.InstallWorkerResultBridge || !result.Plan.AutoStartScreenShare {
		t.Fatalf("plan = %#v, want browser-island joiner flags preserved", result.Plan)
	}
	_, _ = manager.StopSession(testContext(t), StopSessionInput{SessionID: "session_joiner_parity", Reason: "test_done"})
}

func testContext(t *testing.T) context.Context {
	t.Helper()
	return context.Background()
}
