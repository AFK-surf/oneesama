package slackagent

import (
	"math"
	"testing"
	"time"
)

func TestSlackMemoryFactFromRelatedMemoryRecordAssignsTrustScopeAndStaleness(t *testing.T) {
	now := time.Date(2026, 5, 22, 0, 0, 0, 0, time.UTC)
	foreground := SlackMemoryFactFromRelatedMemoryRecord(SlackRelatedMemoryRecord{
		Kind:       "team_fact",
		SourcePath: "memory/team/facts/oneesama-identity.md",
		UpdatedAt:  now.Format(time.RFC3339),
		Content:    "kind: foreground_identity\nscope: foreground\nOneesama foreground identity is Oneesama Pi agent.",
	}, now)
	if foreground.Kind != slackMemoryFactKindForegroundIdentity || foreground.Scope != slackMemoryFactScopeForeground {
		t.Fatalf("foreground fact = %#v, want foreground_identity/foreground", foreground)
	}
	if foreground.Trust.Score != 0.95 || foreground.Trust.Reason != "foreground_identity" {
		t.Fatalf("foreground trust = %#v, want high trust foreground identity", foreground.Trust)
	}
	if foreground.Staleness.Status != slackMemoryStalenessFresh {
		t.Fatalf("foreground staleness = %#v, want fresh", foreground.Staleness)
	}

	legacy := SlackMemoryFactFromRelatedMemoryRecord(SlackRelatedMemoryRecord{
		Kind:       "legacy_triage_archive",
		SourcePath: "memory/legacy/slack-agent-d/workspace/memory/triage-archive/2026-04-01.md",
		UpdatedAt:  "2026-04-01T00:00:00Z",
		Content:    "Old slack-agent-d archive mentioned a triage behavior.",
	}, now)
	if legacy.Trust.Score >= slackMemoryLowTrustThreshold || legacy.Trust.Reason != "legacy_until_corroborated" {
		t.Fatalf("legacy trust = %#v, want low legacy trust", legacy.Trust)
	}
	if legacy.Staleness.Status != slackMemoryStalenessStale {
		t.Fatalf("legacy staleness = %#v, want stale", legacy.Staleness)
	}

	worker := SlackMemoryFactFromRelatedMemoryRecord(SlackRelatedMemoryRecord{
		Kind:      "worker_result",
		Source:    "agent_runner/job_123",
		UpdatedAt: "2026-05-01T00:00:00Z",
		Content:   "Worker completed a demo task.",
	}, now)
	if worker.Scope != slackMemoryFactScopeWorker || worker.Trust.Score != 0.55 {
		t.Fatalf("worker fact = %#v, want medium-trust worker scope", worker)
	}
	if worker.Staleness.Status != slackMemoryStalenessAging {
		t.Fatalf("worker staleness = %#v, want aging", worker.Staleness)
	}
}

func TestBuildSlackMemoryQualityAuditSummaryReportsKindTrustAndStaleness(t *testing.T) {
	now := time.Date(2026, 5, 22, 0, 0, 0, 0, time.UTC)
	records := []SlackRelatedMemoryRecord{
		{
			Kind:       "team_fact",
			SourcePath: "memory/team/facts/oneesama-identity.md",
			UpdatedAt:  now.Format(time.RFC3339),
			Content:    "kind: foreground_identity\nscope: foreground\nOneesama foreground identity is Oneesama Pi agent.",
		},
		{
			Kind:       "legacy_triage_archive",
			SourcePath: "memory/legacy/slack-agent-d/workspace/memory/triage-archive/2026-04-01.md",
			UpdatedAt:  "2026-04-01T00:00:00Z",
			Content:    "Legacy archive triage note.",
		},
		{
			Kind:      "worker_result",
			Source:    "agent_runner/job_123",
			UpdatedAt: "2026-05-01T00:00:00Z",
			Content:   "Worker completed a demo task.",
		},
	}

	summary := BuildSlackMemoryQualityAuditSummary(records, now)
	if summary.TotalCount != 3 || summary.LowTrustCount != 1 || summary.StaleCount != 1 || summary.ExpiredCount != 0 {
		t.Fatalf("summary = %#v, want total=3 low=1 stale=1 expired=0", summary)
	}
	if math.Abs(summary.MeanTrust-0.5833333333) > 0.0001 {
		t.Fatalf("summary mean trust = %f, want ~0.5833", summary.MeanTrust)
	}
	legacy := slackMemoryQualityKindSummary(summary.ByKind, slackMemoryFactKindEpisode)
	if legacy == nil || legacy.LowTrustCount != 1 || legacy.StaleCount != 1 {
		t.Fatalf("episode kind summary = %#v, want low-trust stale legacy episode", legacy)
	}
	identity := slackMemoryQualityKindSummary(summary.ByKind, slackMemoryFactKindForegroundIdentity)
	if identity == nil || identity.Count != 1 || identity.LowTrustCount != 0 {
		t.Fatalf("identity kind summary = %#v, want one high-trust identity fact", identity)
	}
}

func slackMemoryQualityKindSummary(summaries []SlackMemoryQualityKindSummary, kind string) *SlackMemoryQualityKindSummary {
	for index := range summaries {
		if summaries[index].Kind == kind {
			return &summaries[index]
		}
	}
	return nil
}
