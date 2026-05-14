//go:build cueboardparity

package slackagent

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCueboardParityHeartbeatLogFiltersNoiseAndShowsSurfaces(t *testing.T) {
	logPath := filepath.Join(t.TempDir(), "slack-agentd.log")
	logBody := strings.Join([]string{
		"2026/03/24 18:40:00 heartbeat.go:401: framework heartbeat: tick start at=2026-03-24T10:40:00Z",
		"2026/03/24 18:40:01 mention.go:99: user said Heartbeat 也太可爱了吧",
		"2026/03/24 18:40:02 heartbeat.go:43: slack: heartbeat result: notify=true session=s1 title=\"Queue checked\" summary=\"Replied in thread.\" surface=\"thread\" followup_id=7",
		"2026/03/24 18:40:03 heartbeat.go:77: slack: heartbeat delivery sent via thread",
	}, "\n")
	if err := os.WriteFile(logPath, []byte(logBody), 0o644); err != nil {
		t.Fatalf("write log: %v", err)
	}
	t.Setenv("SLACK_AGENT_LOG_PATH", logPath)

	gotPath, logLines, err := loadHeartbeatLogTail(5)
	if err != nil {
		t.Fatalf("loadHeartbeatLogTail: %v", err)
	}
	body := formatHeartbeatLogView(&slackRuntimeStatusData{
		HeartbeatLastAt:              time.Date(2026, 3, 24, 18, 40, 3, 0, shanghaiLocation()),
		HeartbeatTitle:               "Queue checked",
		HeartbeatSummary:             "Replied in thread.",
		HeartbeatNotified:            true,
		HeartbeatGlobalPendingCount:  0,
		HeartbeatVisiblePendingCount: 0,
		HeartbeatSurfaces: []runtimeHeartbeatSurfaceView{
			{Title: "Queue checked", Summary: "Replied in thread.", RequestedSurface: "auto", DeliveredSurface: "thread", Status: "sent"},
		},
	}, gotPath, logLines, nil, true)

	for _, want := range []string{
		"Scope: global",
		"Loop: stopped",
		"Global pending follow-ups: 0",
		"Visible pending follow-ups: 0",
		"Log path: " + logPath,
		"Recent surfaces:",
		"Queue checked via thread — sent",
		"framework heartbeat: tick start",
		"slack: heartbeat delivery sent via thread",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("heartbeat_log output missing %q:\n%s", want, body)
		}
	}
	if strings.Contains(body, "user said Heartbeat 也太可爱了吧") {
		t.Fatalf("heartbeat_log output should not include noisy non-heartbeat log lines:\n%s", body)
	}
}

func TestCueboardParityHeartbeatLogHandlesMissingLogFile(t *testing.T) {
	logPath := filepath.Join(t.TempDir(), "missing.log")
	t.Setenv("SLACK_AGENT_LOG_PATH", logPath)

	gotPath, _, err := loadHeartbeatLogTail(5)
	body := formatHeartbeatLogView(&slackRuntimeStatusData{}, gotPath, nil, err, true)
	for _, want := range []string{
		"Scope: global",
		"Global pending follow-ups: 0",
		"Visible pending follow-ups: 0",
		"Log path: " + logPath,
		"Log read error:",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("heartbeat_log missing %q:\n%s", want, body)
		}
	}
}

func TestCueboardParityHeartbeatLogPathCandidatesRespectLogDir(t *testing.T) {
	logDir := t.TempDir()
	t.Setenv("LOG_DIR", logDir)
	t.Setenv("SLACK_AGENT_LOG_PATH", "")
	candidates := heartbeatLogPathCandidates()
	if len(candidates) == 0 {
		t.Fatal("expected at least one heartbeat log path candidate")
	}
	want := filepath.Join(logDir, "slack-agentd.log")
	if candidates[0] != want {
		t.Fatalf("first heartbeat log path candidate = %q, want %q", candidates[0], want)
	}
}

func TestCueboardParityHeartbeatLogHidesRawLogsOutsideGlobalScope(t *testing.T) {
	t.Parallel()

	logLines := []string{
		"2026/03/24 18:40:00 heartbeat.go:401: framework heartbeat: tick start at=2026-03-24T10:40:00Z",
		"2026/03/24 18:40:02 heartbeat.go:43: slack: heartbeat result: notify=true session=s1 title=\"Foreign queue checked\" summary=\"Replied elsewhere.\" surface=\"thread\" followup_id=9",
	}
	runtime := scopedRuntimeHeartbeat(&slackRuntimeStatusData{
		HeartbeatLastAt:         time.Date(2026, 3, 24, 18, 40, 3, 0, shanghaiLocation()),
		HeartbeatLastFollowupID: 999,
		HeartbeatTitle:          "Foreign queue checked",
		HeartbeatSummary:        "Replied elsewhere.",
		HeartbeatNotified:       true,
	}, []SlackHeartbeatFollowup{
		{ID: 7, Kind: "commitment", Title: "Current thread queue checked", Summary: "Scoped follow-up", SourceKind: "thread", ChannelID: "C123", ThreadTS: "123.456"},
	}, []SlackHeartbeatSurface{
		{FollowupID: 7, Title: "Current thread queue checked", Summary: "Replied in-thread.", RequestedSurface: "auto", DeliveredSurface: "thread", ChannelID: "C123", ThreadTS: "123.456", Status: "sent"},
	}, "C123", "123.456")
	body := formatHeartbeatLogView(runtime, "/tmp/slack-agentd.log", logLines, nil, false)

	for _, want := range []string{
		"Scope: thread C123/123.456",
		"Last result: hidden outside this thread",
		"Recent heartbeat log lines: hidden outside the global runtime view",
		"Current thread queue checked via thread — sent",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("expected scoped heartbeat log output to contain %q:\n%s", want, body)
		}
	}
	if strings.Contains(body, "Foreign queue checked") {
		t.Fatalf("scoped heartbeat log output leaked foreign log data:\n%s", body)
	}
}
