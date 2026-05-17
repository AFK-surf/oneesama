package slackagent

import (
	"context"
	"log/slog"
	"path/filepath"
	"strings"
	"testing"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func newRuntimeBuilderTestService(t *testing.T) *Service {
	t.Helper()
	dir := t.TempDir()
	cfg := appconfig.PersistenceConfig{
		Provider:   "memory",
		DataDir:    dir,
		SQLitePath: filepath.Join(dir, "test.db"),
	}
	return &Service{
		logger:          slog.Default(),
		workspaceDir:    "/workspace",
		followups:       newSlackHeartbeatStore(cfg, slog.Default()),
		meetingWebhooks: newMeetingWebhookStore(cfg, slog.Default()),
		inbound:         newSlackInboundBuffer(appconfig.SlackEventBufferConfig{}, nil),
		meetingAgentURL: "http://meet-agent.example",
	}
}

func TestBuildSlackRuntimeStatusDataPopulatesBaseFields(t *testing.T) {
	svc := newRuntimeBuilderTestService(t)
	data := svc.BuildSlackRuntimeStatusData(context.Background())
	if data == nil {
		t.Fatalf("expected non-nil status data")
	}
	if data.WorkspaceDir != "/workspace" {
		t.Errorf("WorkspaceDir = %q, want /workspace", data.WorkspaceDir)
	}
	if data.RunMode == "" {
		t.Errorf("RunMode must be populated from Status()")
	}
	if data.Integrations == nil {
		t.Fatalf("Integrations must be initialized even when none active")
	}
	if !data.Integrations["Meet Agent"] {
		t.Errorf("Meet Agent integration should be reported true when meeting agent URL configured")
	}
	if data.Integrations["Linear"] {
		t.Errorf("Linear must report false (product_excluded)")
	}
}

func TestBuildSlackRuntimeStatusDataNilSafe(t *testing.T) {
	var svc *Service
	got := svc.BuildSlackRuntimeStatusData(context.Background())
	if got == nil {
		t.Fatalf("expected empty struct, got nil")
	}
}

func TestBuildSlackRuntimeMeetingsSnapshotReturnsEmptyWhenStoreReady(t *testing.T) {
	svc := newRuntimeBuilderTestService(t)
	snapshot := svc.BuildSlackRuntimeMeetingsSnapshot(context.Background())
	if snapshot == nil {
		t.Fatalf("expected non-nil snapshot")
	}
	if snapshot.Error != "" {
		t.Fatalf("expected no error when store is initialized, got %q", snapshot.Error)
	}
	if len(snapshot.Live) != 0 || len(snapshot.Processing) != 0 || len(snapshot.Recent) != 0 {
		t.Fatalf("expected empty buckets until ListMeetingThreads ports, got %+v", snapshot)
	}
}

func TestBuildSlackRuntimeMeetingsSnapshotErrorsWhenStoreMissing(t *testing.T) {
	svc := &Service{logger: slog.Default()}
	snapshot := svc.BuildSlackRuntimeMeetingsSnapshot(context.Background())
	if snapshot.Error == "" {
		t.Fatalf("expected error when meeting webhook store is nil")
	}
}

func TestExecuteRuntimeStatusToolEmitsFormattedSectionsAndRawStatus(t *testing.T) {
	svc := newRuntimeBuilderTestService(t)
	result := svc.executeRuntimeStatusTool(context.Background())
	if result == nil {
		t.Fatalf("expected non-nil result")
	}
	for _, key := range []string{"status", "overview", "heartbeat", "repos", "meetings"} {
		if _, ok := result[key]; !ok {
			t.Errorf("result missing %q key", key)
		}
	}
	overview, _ := result["overview"].(string)
	if !strings.Contains(overview, "Run mode:") {
		t.Errorf("overview missing Run mode line: %q", overview)
	}
	if !strings.Contains(overview, "Integrations:") {
		t.Errorf("overview missing Integrations line: %q", overview)
	}
	heartbeat, _ := result["heartbeat"].(string)
	if !strings.Contains(heartbeat, "Scope:") {
		t.Errorf("heartbeat missing Scope line: %q", heartbeat)
	}
	if _, ok := result["status"].(StatusResponse); !ok {
		t.Errorf("expected raw StatusResponse under status key, got %T", result["status"])
	}
}

func TestExecuteHeartbeatLogToolIncludesFormattedView(t *testing.T) {
	svc := newRuntimeBuilderTestService(t)
	result := svc.executeHeartbeatLogTool(context.Background(), 5, true)
	if result == nil {
		t.Fatalf("expected non-nil result")
	}
	if _, ok := result["view"]; !ok {
		t.Errorf("heartbeat_log missing formatted view")
	}
	if _, ok := result["path"]; !ok {
		t.Errorf("heartbeat_log missing path field")
	}
	if _, ok := result["lines"]; !ok {
		t.Errorf("heartbeat_log missing lines field")
	}
}
