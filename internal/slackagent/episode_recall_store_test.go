package slackagent

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
	"github.com/AFK-surf/oneesama/internal/postmeeting"
)

func TestEpisodeRecallStoreIndexesTriageAndApprovalSources(t *testing.T) {
	store := newTestEpisodeRecallStore(t)
	err := store.IndexMany(context.Background(), []SlackEpisodeRecallRecord{
		SlackEpisodeRecallRecordFromTriageRun(SlackTriageContext{
			ID:        101,
			Timestamp: "2026-05-22T10:00:00Z",
			Status:    "done",
			Channels:  []string{"C1"},
			Summary:   "Johnson8053 identity lookup used HN profile evidence.",
			Digest:    "HN user Johnson8053 asked who this person is.",
		}),
		SlackEpisodeRecallRecordFromVisibleReplySample(SlackVisibleReplyQualitySample{
			PendingActionID:  7,
			CardID:           "pending_action:7",
			ChannelID:        "C1",
			ThreadTS:         "123.456",
			ProposedMessage:  "Reply lacked a source-backed evidence anchor.",
			ApprovalDecision: "rejected",
			RejectReason:     "no_citation",
			EvidenceAnchors: []SlackVisibleEvidenceAnchor{{
				Kind:      "slack_thread",
				SourceRef: "slack:C1/123.456",
				Quote:     "question asked in thread",
			}},
			UpdatedAt: "2026-05-22T11:00:00Z",
		}),
	})
	if err != nil {
		t.Fatalf("IndexMany: %v", err)
	}

	results, err := store.Search(context.Background(), "Johnson8053 profile", SlackEpisodeRecallSearchOptions{Limit: 5})
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(results) == 0 || results[0].SourceType != slackEpisodeRecallSourceTriageRun || results[0].SourceRef != "triage_run:101" {
		t.Fatalf("results = %#v, want triage run source ref", results)
	}

	results, err = store.Search(context.Background(), "evidence anchor", SlackEpisodeRecallSearchOptions{Limit: 5, SourceTypes: []string{slackEpisodeRecallSourceApprovalSample}})
	if err != nil {
		t.Fatalf("Search approval: %v", err)
	}
	if len(results) != 1 || results[0].SourceRef != "approval_sample:7" {
		t.Fatalf("approval results = %#v, want approval sample only", results)
	}
}

func TestEpisodeRecallStoreIndexesWorkerAndMeetingArtifacts(t *testing.T) {
	store := newTestEpisodeRecallStore(t)
	if err := store.Index(context.Background(), SlackEpisodeRecallRecordFromWorkerJob(agentrunner.Job{
		ID:        "job_snake",
		Provider:  "codex",
		Status:    agentrunner.StatusCompleted,
		Task:      "Build a snake demo.",
		Result:    "Created snake.html and opened the preview.",
		UpdatedAt: "2026-05-22T12:00:00Z",
	})); err != nil {
		t.Fatalf("Index worker: %v", err)
	}
	if err := store.Index(context.Background(), SlackEpisodeRecallRecordFromMeetingArtifact(postmeeting.ArtifactManifest{
		ID:        "meet_1",
		Title:     "Demo review",
		MeetingID: "m-1",
		SessionID: "s-1",
		MeetURL:   "https://meet.google.com/abc-defg-hij",
		UpdatedAt: "2026-05-22T13:00:00Z",
		Summary: struct {
			Highlights  []string `json:"highlights,omitempty"`
			Decisions   []string `json:"decisions,omitempty"`
			ActionItems []string `json:"action_items,omitempty"`
		}{
			Highlights:  []string{"讨论了贪吃蛇小游戏展示。"},
			Decisions:   []string{"Use demo surface for previews."},
			ActionItems: []string{"Add a shared recall canary."},
		},
	})); err != nil {
		t.Fatalf("Index meeting: %v", err)
	}

	workerResults, err := store.Search(context.Background(), "snake preview", SlackEpisodeRecallSearchOptions{Limit: 5, Surface: "worker"})
	if err != nil {
		t.Fatalf("Search worker: %v", err)
	}
	if len(workerResults) != 1 || workerResults[0].SourceRef != "worker_job:job_snake" {
		t.Fatalf("worker results = %#v, want worker job", workerResults)
	}

	meetingResults, err := store.Search(context.Background(), "贪吃蛇", SlackEpisodeRecallSearchOptions{Limit: 5})
	if err != nil {
		t.Fatalf("Search meeting: %v", err)
	}
	if len(meetingResults) != 1 || meetingResults[0].SourceType != slackEpisodeRecallSourceMeetingArtifact || meetingResults[0].MatchKind != "like" {
		t.Fatalf("meeting results = %#v, want CJK LIKE fallback meeting artifact", meetingResults)
	}
}

func TestEpisodeRecallStoreUpsertUpdatesIndexedContent(t *testing.T) {
	store := newTestEpisodeRecallStore(t)
	record := SlackEpisodeRecallRecord{
		ID:         "manual:1",
		Surface:    "slack",
		SourceType: "manual",
		SourceRef:  "manual:1",
		Title:      "Manual note",
		Content:    "old content",
	}
	if err := store.Index(context.Background(), record); err != nil {
		t.Fatalf("Index old: %v", err)
	}
	record.Content = "new recall content"
	if err := store.Index(context.Background(), record); err != nil {
		t.Fatalf("Index new: %v", err)
	}

	results, err := store.Search(context.Background(), "new recall", SlackEpisodeRecallSearchOptions{Limit: 10})
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(results) != 1 || results[0].ID != "manual:1" || results[0].Content != "new recall content" {
		t.Fatalf("results = %#v, want single updated record", results)
	}
}

func TestEpisodeRecallCanaryCoversSharedSlackMeetAndWorkerMeet(t *testing.T) {
	status := BuildSlackEpisodeRecallStatus(context.Background())
	if !status.Ready || status.Error != "" {
		t.Fatalf("status = %#v, want ready canary", status)
	}
	if status.Canary.Total != 2 || status.Canary.Passed != 2 || status.Canary.Failed != 0 {
		t.Fatalf("canary = %#v, want both cases passing", status.Canary)
	}
	byName := map[string]SlackEpisodeRecallCanaryCase{}
	for _, c := range status.Canary.Cases {
		byName[c.Name] = c
	}
	identity := byName["slack_meet_identity_lookup_recall"]
	if !stringSliceContains(identity.ActualSurfaces, "slack") || !stringSliceContains(identity.ActualSurfaces, "meet") {
		t.Fatalf("identity case = %#v, want Slack + Meet surfaces", identity)
	}
	demo := byName["worker_meet_demo_surface_recall"]
	if !stringSliceContains(demo.ActualSourceTypes, slackEpisodeRecallSourceWorkerJob) ||
		!stringSliceContains(demo.ActualSourceTypes, slackEpisodeRecallSourceTriageRun) ||
		!stringSliceContains(demo.ActualSourceTypes, slackEpisodeRecallSourceMeetingArtifact) {
		t.Fatalf("demo case = %#v, want Slack + worker + meeting sources", demo)
	}
	if len(status.Samples) == 0 {
		t.Fatal("expected status samples for operator inspection")
	}
}

func newTestEpisodeRecallStore(t *testing.T) *SlackEpisodeRecallStore {
	t.Helper()
	store, err := OpenSlackEpisodeRecallStore(context.Background(), filepath.Join(t.TempDir(), "episode-recall.sqlite3"))
	if err != nil {
		t.Fatalf("OpenSlackEpisodeRecallStore: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store
}
