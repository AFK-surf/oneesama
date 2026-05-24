package slackagent

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestCueboardParityImprovementSignalsCreateSelfGrowthFollowupAndMemory(t *testing.T) {
	workspaceDir := t.TempDir()
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack:       appconfig.SlackConfig{WorkspaceDir: workspaceDir},
	})

	service.maybeRecordThreadImprovementSignals(
		context.Background(),
		"C123", "123.456", "123.456", "sess-1",
		"heartbeat 现在没有自动给自己加任务，而且老嘴硬",
		"",
		"我承认 heartbeat 现在的任务摄入和跟进都不够真。",
	)
	service.maybeRecordThreadImprovementSignals(
		context.Background(),
		"C123", "234.567", "234.567", "sess-2",
		"memory 这套还没有真的内化，希望你自己记到长期记忆里，也要能做梦整理",
		"",
		"现在更多还是靠我临场解释，内化链路还不稳。",
	)

	signals, err := service.improvements.ListSignals(context.Background(), 20, nil, time.Time{})
	if err != nil {
		t.Fatalf("ListSignals: %v", err)
	}
	if len(signals) < 2 {
		t.Fatalf("signals len = %d, want >= 2", len(signals))
	}
	topics := map[string]struct{}{}
	clusters := map[string]struct{}{}
	for _, signal := range signals {
		topics[signal.Topic] = struct{}{}
		clusters[signal.ClusterKey] = struct{}{}
	}
	if len(clusters) != 1 {
		t.Fatalf("clusters = %#v, want one autonomy cluster", clusters)
	}
	for _, want := range []string{improvementTopicHeartbeatTasking, improvementTopicMemoryInternal} {
		if _, ok := topics[want]; !ok {
			t.Fatalf("missing improvement topic %q in %#v", want, topics)
		}
	}

	followups, err := service.followups.ListFollowups(context.Background(), "open", 10)
	if err != nil {
		t.Fatalf("ListFollowups: %v", err)
	}
	if len(followups) != 1 {
		t.Fatalf("followups = %#v, want one self-improvement followup", followups)
	}
	followup := followups[0]
	if followup.Kind != heartbeatFollowupKindSelfImprovement {
		t.Fatalf("followup kind = %q, want %q", followup.Kind, heartbeatFollowupKindSelfImprovement)
	}
	for _, want := range []string{improvementTopicHeartbeatTasking, improvementTopicMemoryInternal, "evidence_threads", "123.456", "234.567"} {
		if !strings.Contains(anyMapString(followup.Metadata), want) {
			t.Fatalf("followup metadata missing %q: %#v", want, followup.Metadata)
		}
	}
	if followup.NextCheckAt == "" {
		t.Fatalf("followup = %#v, want next_check_at", followup)
	}

	for _, rel := range []string{
		filepath.Join("memory", "lessons", "candidates", lessonCandidateSlugForTopic(improvementTopicHeartbeatTasking)+".md"),
		filepath.Join("memory", "lessons", "candidates", lessonCandidateSlugForTopic(improvementTopicMemoryInternal)+".md"),
	} {
		if _, err := os.Stat(filepath.Join(workspaceDir, rel)); err != nil {
			t.Fatalf("expected lesson candidate %s: %v", rel, err)
		}
	}
	rawMemory, err := os.ReadFile(filepath.Join(workspaceDir, "MEMORY.md"))
	if err != nil {
		t.Fatalf("read MEMORY.md: %v", err)
	}
	for _, want := range []string{selfGrowthMemoryStart, improvementTopicHeartbeatTasking, improvementTopicMemoryInternal} {
		if !strings.Contains(string(rawMemory), want) {
			t.Fatalf("MEMORY.md missing %q:\n%s", want, string(rawMemory))
		}
	}
}

func TestCueboardParityScannerFeedbackEntersSelfGrowthQueue(t *testing.T) {
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack: appconfig.SlackConfig{
			WorkspaceDir: t.TempDir(),
			EventBuffer:  appconfig.SlackEventBufferConfig{Enabled: true, MaxBatch: 10, Debounce: time.Hour},
		},
	})

	message := SlackInboundMessage{
		TeamID:    "T123",
		ChannelID: "C123",
		UserID:    "U123",
		Text:      "triage 回复太吵了，应该大多时候静默，不要刷屏",
		TS:        "1770000000.000001",
	}
	result := service.BufferSlackInboundEvent(context.Background(), SlackEventEnvelope{TeamID: "T123"}, SlackEventPayload{
		Type:    "message",
		Channel: message.ChannelID,
		User:    message.UserID,
		Text:    message.Text,
		TS:      message.TS,
	})
	if !result.Buffered {
		t.Fatalf("buffer result = %#v, want buffered", result)
	}

	signals, err := service.improvements.ListSignals(context.Background(), 10, nil, time.Time{})
	if err != nil {
		t.Fatalf("ListSignals: %v", err)
	}
	if len(signals) == 0 {
		t.Fatal("expected scanner message to create improvement signal")
	}
	if signals[0].Topic != improvementTopicProgressNoise {
		t.Fatalf("signal topic = %q, want %q", signals[0].Topic, improvementTopicProgressNoise)
	}
	followups, err := service.followups.ListFollowups(context.Background(), "open", 10)
	if err != nil {
		t.Fatalf("ListFollowups: %v", err)
	}
	if len(followups) != 1 || followups[0].Kind != heartbeatFollowupKindSelfImprovement {
		t.Fatalf("followups = %#v, want self-improvement followup", followups)
	}
}

func TestSelfGrowthFollowupDoesNotSurfacePublicHeartbeat(t *testing.T) {
	poster := &recordingPoster{}
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack:       appconfig.SlackConfig{WorkspaceDir: t.TempDir()},
		Poster:      poster,
	})

	service.maybeRecordThreadImprovementSignals(
		context.Background(),
		"C123", "123.456", "123.456", "sess-progress-noise",
		"triage 回复太吵了，应该大多时候静默，不要刷屏",
		"",
		"",
	)
	followups, err := service.followups.ListFollowups(context.Background(), "open", 10)
	if err != nil {
		t.Fatalf("ListFollowups: %v", err)
	}
	if len(followups) != 1 || followups[0].Kind != heartbeatFollowupKindSelfImprovement {
		t.Fatalf("followups = %#v, want self-improvement followup", followups)
	}

	response, err := service.SurfaceSlackFollowups(context.Background(), SlackFollowupSurfaceRequest{FollowupID: followups[0].ID})
	if err != nil {
		t.Fatalf("SurfaceSlackFollowups: %v", err)
	}
	if len(poster.Calls()) != 0 {
		t.Fatalf("poster calls = %#v, self-growth followup must not post to user thread", poster.Calls())
	}
	if len(response.Skipped) != 1 || response.Skipped[0].BlockReason != heartbeatSurfaceBlockNotPubliclyAllowed {
		t.Fatalf("response = %#v, want %s", response, heartbeatSurfaceBlockNotPubliclyAllowed)
	}
	updated, err := service.followups.GetFollowup(context.Background(), followups[0].ID)
	if err != nil {
		t.Fatalf("GetFollowup: %v", err)
	}
	if updated == nil || updated.Status != "done" || updated.Metadata["resolution"] != heartbeatSurfaceBlockNotPubliclyAllowed {
		t.Fatalf("updated = %#v, want closed as non-public self-growth followup", updated)
	}
}

func TestSelectImprovementSignalSummaryPrefersSubstantiveFeedback(t *testing.T) {
	summary := selectImprovementSignalSummary(
		"test",
		`[ts:1774425700.976219] Peng Xiao: 还嘴硬
[ts:1774425716.947249] Onee sama [assistant]: 抱歉，我夸大了 heartbeat 的能力。`,
		"我会修 heartbeat 的任务摄入。",
	)
	if summary != "还嘴硬" {
		t.Fatalf("summary = %q, want substantive user feedback", summary)
	}
}

func TestImprovementSignalSummariesFiltersLowSignalNoise(t *testing.T) {
	items := []SlackImprovementSignal{
		{Summary: "test"},
		{Summary: "应该是完成了"},
		{Summary: "heartbeat 没有自动给自己加任务，而且老嘴硬"},
	}
	got := improvementSignalSummaries(items, 2)
	if len(got) == 0 {
		t.Fatal("expected at least one summary")
	}
	if got[0] != "heartbeat 没有自动给自己加任务，而且老嘴硬" {
		t.Fatalf("top summary = %q", got[0])
	}
}

func TestImprovementLessonImpactFallsBackWhenEvidenceIsWeak(t *testing.T) {
	impact := improvementLessonImpact(improvementTopicSpec{Topic: improvementTopicHeartbeatTasking}, []string{
		"> • custom emoji 那条现在还是 unresolved，确实挂在那儿了 :thinking:",
		"应该是完成了",
	})
	if strings.Contains(impact, "custom emoji") || strings.Contains(impact, "应该是完成了") {
		t.Fatalf("expected generic fallback impact, got %q", impact)
	}
	if !strings.Contains(impact, "heartbeat") {
		t.Fatalf("expected heartbeat-specific fallback, got %q", impact)
	}
}

func anyMapString(value map[string]any) string {
	raw, _ := json.Marshal(value)
	return string(raw)
}
