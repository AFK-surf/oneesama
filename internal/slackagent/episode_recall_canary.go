package slackagent

import (
	"context"
	"fmt"
	"strings"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
	"github.com/AFK-surf/oneesama/internal/postmeeting"
)

func BuildSlackEpisodeRecallStatus(ctx context.Context) SlackEpisodeRecallStatus {
	status := SlackEpisodeRecallStatus{Store: "sqlite_fts5_in_memory_canary"}
	store, err := OpenSlackEpisodeRecallStore(ctx, ":memory:")
	if err != nil {
		status.Error = err.Error()
		return status
	}
	defer func() { _ = store.Close() }()
	if err := store.IndexMany(ctx, slackEpisodeRecallCanaryRecords()); err != nil {
		status.Error = err.Error()
		return status
	}
	status.Canary, status.Samples = runSlackEpisodeRecallCanaries(ctx, store)
	status.Ready = status.Canary.Total > 0 && status.Canary.Failed == 0
	return status
}

type slackEpisodeRecallCanarySpec struct {
	Name                string
	Query               string
	ExpectedSurfaces    []string
	ExpectedSourceTypes []string
}

func runSlackEpisodeRecallCanaries(ctx context.Context, store *SlackEpisodeRecallStore) (SlackEpisodeRecallCanarySummary, []SlackEpisodeRecallSearchResult) {
	specs := []slackEpisodeRecallCanarySpec{
		{
			Name:                "slack_meet_identity_lookup_recall",
			Query:               "Johnson8053 profile",
			ExpectedSurfaces:    []string{"slack", "meet"},
			ExpectedSourceTypes: []string{slackEpisodeRecallSourceTriageRun, slackEpisodeRecallSourceMeetingArtifact},
		},
		{
			Name:                "worker_meet_demo_surface_recall",
			Query:               "snake preview",
			ExpectedSurfaces:    []string{"slack", "worker", "meet"},
			ExpectedSourceTypes: []string{slackEpisodeRecallSourceTriageRun, slackEpisodeRecallSourceWorkerJob, slackEpisodeRecallSourceMeetingArtifact},
		},
	}
	summary := SlackEpisodeRecallCanarySummary{Total: len(specs)}
	samples := []SlackEpisodeRecallSearchResult{}
	for _, spec := range specs {
		results, err := store.Search(ctx, spec.Query, SlackEpisodeRecallSearchOptions{Limit: 10})
		resultRefs, surfaces, sourceTypes := slackEpisodeRecallCanaryResultFacts(results)
		reason := ""
		passed := err == nil
		if err != nil {
			reason = err.Error()
		}
		if passed && !slackEpisodeRecallContainsAll(surfaces, spec.ExpectedSurfaces) {
			passed = false
			reason = fmt.Sprintf("missing expected surface; got=%s", strings.Join(surfaces, ","))
		}
		if passed && !slackEpisodeRecallContainsAll(sourceTypes, spec.ExpectedSourceTypes) {
			passed = false
			reason = fmt.Sprintf("missing expected source_type; got=%s", strings.Join(sourceTypes, ","))
		}
		if passed {
			summary.Passed++
		} else {
			summary.Failed++
		}
		summary.Cases = append(summary.Cases, SlackEpisodeRecallCanaryCase{
			Name:                spec.Name,
			Query:               spec.Query,
			ExpectedSurfaces:    spec.ExpectedSurfaces,
			ExpectedSourceTypes: spec.ExpectedSourceTypes,
			ActualSurfaces:      surfaces,
			ActualSourceTypes:   sourceTypes,
			ActualSourceRefs:    resultRefs,
			Passed:              passed,
			Reason:              reason,
		})
		for _, result := range results {
			if len(samples) >= 6 {
				break
			}
			samples = append(samples, result)
		}
	}
	return summary, samples
}

func slackEpisodeRecallCanaryRecords() []SlackEpisodeRecallRecord {
	return []SlackEpisodeRecallRecord{
		SlackEpisodeRecallRecordFromTriageRun(SlackTriageContext{
			ID:        901,
			Timestamp: "2026-05-22T10:00:00Z",
			Status:    "done",
			Channels:  []string{"C_RECALL"},
			Summary:   "Johnson8053 profile identity lookup used HN profile evidence and workspace memory.",
			Digest:    "Peng asked who Johnson8053 is; Oneesama should recall the profile lookup and source anchors.",
		}),
		SlackEpisodeRecallRecordFromWorkerJob(agentrunner.Job{
			ID:        "job_recall_snake",
			Provider:  "codex",
			Status:    agentrunner.StatusCompleted,
			Task:      "Build a snake preview for the demo surface.",
			Result:    "Created snake.html preview and opened it for the meeting demo surface.",
			UpdatedAt: "2026-05-22T11:00:00Z",
		}),
		SlackEpisodeRecallRecordFromTriageRun(SlackTriageContext{
			ID:        902,
			Timestamp: "2026-05-22T11:30:00Z",
			Status:    "done",
			Channels:  []string{"C_RECALL"},
			Summary:   "Slack decision: use demo surface for snake preview demos after worker completion.",
			Digest:    "Peng asked to make a snake preview visible in the meeting; Oneesama delegated the work and opened the demo surface.",
		}),
		SlackEpisodeRecallRecordFromMeetingArtifact(postmeeting.ArtifactManifest{
			ID:        "meet_recall_identity",
			Title:     "Johnson8053 profile review",
			MeetingID: "meet-recall-identity",
			SessionID: "session-recall-identity",
			UpdatedAt: "2026-05-22T12:00:00Z",
			Summary: struct {
				Highlights  []string `json:"highlights,omitempty"`
				Decisions   []string `json:"decisions,omitempty"`
				ActionItems []string `json:"action_items,omitempty"`
			}{
				Highlights: []string{"Reviewed the Johnson8053 profile incident and evidence-anchor answer quality."},
				Decisions:  []string{"Episode recall must retrieve both Slack triage and Meet artifacts for identity lookups."},
			},
		}),
		SlackEpisodeRecallRecordFromMeetingArtifact(postmeeting.ArtifactManifest{
			ID:        "meet_recall_snake",
			Title:     "Snake preview demo",
			MeetingID: "meet-recall-snake",
			SessionID: "session-recall-snake",
			UpdatedAt: "2026-05-22T12:30:00Z",
			Summary: struct {
				Highlights  []string `json:"highlights,omitempty"`
				Decisions   []string `json:"decisions,omitempty"`
				ActionItems []string `json:"action_items,omitempty"`
			}{
				Highlights:  []string{"Watched the snake preview on the demo surface."},
				ActionItems: []string{"Keep worker jobs and meeting artifacts discoverable by shared episode recall."},
			},
		}),
	}
}

func slackEpisodeRecallCanaryResultFacts(results []SlackEpisodeRecallSearchResult) ([]string, []string, []string) {
	refs := make([]string, 0, len(results))
	surfaces := make([]string, 0, len(results))
	sourceTypes := make([]string, 0, len(results))
	for _, result := range results {
		refs = append(refs, result.SourceRef)
		surfaces = append(surfaces, result.Surface)
		sourceTypes = append(sourceTypes, result.SourceType)
	}
	return compactUniqueStrings(refs), compactUniqueStrings(surfaces), compactUniqueStrings(sourceTypes)
}

func slackEpisodeRecallContainsAll(actual []string, expected []string) bool {
	for _, want := range expected {
		if !stringSliceContains(actual, want) {
			return false
		}
	}
	return true
}
