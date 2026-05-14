package slackagent

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestHandleScannerCompactStartsMemoryCompactJobAndDedupes(t *testing.T) {
	workspace := t.TempDir()
	writeTestFile(t, filepath.Join(workspace, "memory", "2026-05-13.md"), bloatedDailyNote())
	runner := &fakeRunner{job: agentrunner.Job{ID: "job_compact", Provider: "codex", Status: agentrunner.StatusRunning}}
	router := newTestRouter(t, Config{
		Slack:  appconfig.SlackConfig{WorkspaceDir: workspace},
		Runner: runner,
	})

	first := postInternalJSON(t, router, "/slack/scanner/compact", `{"date":"2026-05-13","run":true}`)
	if first.Code != http.StatusOK {
		t.Fatalf("first status = %d, want 200: %s", first.Code, first.Body.String())
	}
	if !strings.Contains(first.Body.String(), `"sessionKind":"memory_compact"`) || runner.startInput.Context["kind"] != dailyNoteCompactSessionKind {
		t.Fatalf("first body/context = %s %#v, want memory compact job", first.Body.String(), runner.startInput.Context)
	}
	second := postInternalJSON(t, router, "/slack/scanner/compact", `{"date":"2026-05-13","run":true}`)
	if !strings.Contains(second.Body.String(), `"reason":"duplicate_hash"`) {
		t.Fatalf("second body = %s, want duplicate hash skip", second.Body.String())
	}
}

func TestMeetingResultProjectsTeamAndPeopleMemory(t *testing.T) {
	workspace := t.TempDir()
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack:       appconfig.SlackConfig{WorkspaceDir: workspace},
		Poster:      &recordingPoster{},
		Assistant:   &recordingAssistant{},
		CanvasPublisherConfig: CanvasPublisherConfig{
			Provider: "file",
			OutDir:   t.TempDir(),
		},
	})
	response := service.HandleMeetingWebhook(context.Background(), MeetingWebhookPayload{
		Event:     "meeting.result",
		MeetingID: float64(42),
		Title:     "Weekly sync",
		SlackRef:  &MeetingWebhookSlackRef{ChannelID: "C123", ThreadTS: "123.456"},
		Summary: &MeetingSummaryData{
			Title:         "Weekly sync",
			KeyPoints:     []string{"Codex rewrite is on track"},
			Decisions:     []string{"Use Go runtime"},
			OpenQuestions: []string{"When to cut over?"},
			ActionItems:   []MeetingActionItem{{Description: "Prepare cutover checklist", Owner: "Peng", Deadline: "tomorrow"}},
		},
	})
	if !response.OK {
		t.Fatalf("response = %#v, want ok", response)
	}
	assertFileContains(t, filepath.Join(workspace, "memory", "team", "meetings", "meeting-42.md"), "Codex rewrite is on track")
	assertFileContains(t, filepath.Join(workspace, "memory", "team", "actions", "meeting-42.md"), "owner: Peng")
	assertFileContains(t, filepath.Join(workspace, "memory", "people", "peng.md"), "Prepare cutover checklist")
}

func bloatedDailyNote() string {
	var builder strings.Builder
	for i := 0; i < 12; i++ {
		builder.WriteString("## Section\n\n")
		builder.WriteString(strings.Repeat("codex deployment details ", 20))
		builder.WriteString("\n\n")
	}
	return builder.String()
}

func assertFileContains(t *testing.T, path string, want string) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	if !strings.Contains(string(data), want) {
		t.Fatalf("%s = %s, want %q", path, string(data), want)
	}
}
