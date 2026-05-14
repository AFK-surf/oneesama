//go:build cueboardparity

package slackagent

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCueboardParityProjectMeetingSummaryToTeamMemoryWritesStructuredFiles(t *testing.T) {
	t.Parallel()

	workspaceDir := t.TempDir()
	summary := &MeetingSummaryData{
		Title:           "Weekly Product Sync",
		Attendees:       []string{"Peng Xiao", "Haowen Sun"},
		DurationMinutes: 45,
		KeyPoints: []string{
			"Slack admin should feel like an ops cockpit, not a debug dump.",
			"Slack admin should feel like an ops cockpit, not a debug dump.",
		},
		ActionItems: []MeetingActionItem{
			{Description: "Prototype team memory projector", Owner: "Haowen", Deadline: "Wednesday"},
		},
		Decisions: []string{
			"Ship durable meeting memory before broader teammate packaging.",
		},
		OpenQuestions: []string{
			"How much of team memory should be auto-injected into mentions?",
		},
		Blockers: []string{"Need a clean dedupe rule for memory writes."},
	}
	source := teamMemorySource{
		Title:           "Weekly Product Sync",
		SourceType:      "meeting",
		SourceRef:       "meeting:11",
		ChannelID:       "C123",
		ThreadTS:        "1774235307.975039",
		ThreadPermalink: "https://example.com/thread",
		Timestamp:       time.Date(2026, 3, 23, 14, 40, 0, 0, shanghaiLocation()),
		Confidence:      "high",
		Tags:            []string{"meeting", "team-memory"},
	}

	if err := projectMeetingSummaryToTeamMemory(workspaceDir, 11, summary, source); err != nil {
		t.Fatalf("projectMeetingSummaryToTeamMemory: %v", err)
	}

	meetingDoc := cueboardParityMustReadFile(t, filepath.Join(workspaceDir, "memory/team/meetings/meeting-11.md"))
	if !strings.Contains(meetingDoc, "# Team Memory: Weekly Product Sync") {
		t.Fatalf("meeting doc missing title: %s", meetingDoc)
	}
	if !strings.Contains(meetingDoc, "## Decisions") || !strings.Contains(meetingDoc, "Ship durable meeting memory before broader teammate packaging.") {
		t.Fatalf("meeting doc missing decisions: %s", meetingDoc)
	}
	if !strings.Contains(meetingDoc, "## Action Items") || !strings.Contains(meetingDoc, "owner: Haowen") {
		t.Fatalf("meeting doc missing action items: %s", meetingDoc)
	}
	if !strings.Contains(meetingDoc, "## Stable Context") {
		t.Fatalf("meeting doc missing stable context: %s", meetingDoc)
	}

	decisionDoc := cueboardParityMustReadFile(t, filepath.Join(workspaceDir, "memory/team/decisions/meeting-11.md"))
	if !strings.Contains(decisionDoc, "## Decisions") {
		t.Fatalf("decision doc missing section: %s", decisionDoc)
	}

	actionDoc := cueboardParityMustReadFile(t, filepath.Join(workspaceDir, "memory/team/actions/meeting-11.md"))
	if !strings.Contains(actionDoc, "deadline: Wednesday") {
		t.Fatalf("action doc missing deadline: %s", actionDoc)
	}

	questionDoc := cueboardParityMustReadFile(t, filepath.Join(workspaceDir, "memory/team/questions/meeting-11.md"))
	if !strings.Contains(questionDoc, "How much of team memory should be auto-injected into mentions?") {
		t.Fatalf("question doc missing question: %s", questionDoc)
	}

	factsDoc := cueboardParityMustReadFile(t, filepath.Join(workspaceDir, "memory/team/facts/meeting-11.md"))
	if strings.Count(factsDoc, "ops cockpit") != 1 {
		t.Fatalf("facts doc should dedupe duplicate key points: %s", factsDoc)
	}
}

func TestCueboardParityProjectMeetingSummaryToTeamMemoryRemovesEmptyCategoryFiles(t *testing.T) {
	t.Parallel()

	workspaceDir := t.TempDir()
	source := teamMemorySource{
		Title:      "Follow-up",
		SourceType: "meeting",
		SourceRef:  "meeting:12",
		Timestamp:  time.Date(2026, 3, 23, 15, 0, 0, 0, shanghaiLocation()),
	}

	first := &MeetingSummaryData{
		Title:         "Follow-up",
		ActionItems:   []MeetingActionItem{{Description: "Do the thing", Owner: "Peng"}},
		OpenQuestions: []string{"Should we widen rollout?"},
	}
	if err := projectMeetingSummaryToTeamMemory(workspaceDir, 12, first, source); err != nil {
		t.Fatalf("first projection: %v", err)
	}

	second := &MeetingSummaryData{Title: "Follow-up"}
	if err := projectMeetingSummaryToTeamMemory(workspaceDir, 12, second, source); err != nil {
		t.Fatalf("second projection: %v", err)
	}

	if _, err := os.Stat(filepath.Join(workspaceDir, "memory/team/actions/meeting-12.md")); !os.IsNotExist(err) {
		t.Fatalf("expected empty action category file to be removed, stat err=%v", err)
	}
	if _, err := os.Stat(filepath.Join(workspaceDir, "memory/team/questions/meeting-12.md")); !os.IsNotExist(err) {
		t.Fatalf("expected empty question category file to be removed, stat err=%v", err)
	}
}

func TestCueboardParityRecordLessonCandidateWritesStableMarkdown(t *testing.T) {
	t.Parallel()

	workspaceDir := t.TempDir()
	if err := recordLessonCandidate(workspaceDir, lessonCandidate{
		Slug:         "admin-log-tail-missing",
		Scope:        "ops_admin",
		Title:        "Admin log tab should work in Docker",
		SourceRef:    "incident:logs",
		WhatHappened: "The admin log tab still read /tmp/*.log after services moved to Docker stdout.",
		Impact:       "Operators lost near-real-time visibility into the live stack.",
		Guardrail:    "Always keep Docker log tails mirrored into a shared host-visible path before shipping admin diagnostics.",
	}); err != nil {
		t.Fatalf("recordLessonCandidate: %v", err)
	}

	body := cueboardParityMustReadFile(t, filepath.Join(workspaceDir, "memory/lessons/candidates/admin-log-tail-missing.md"))
	for _, want := range []string{
		"# Lesson Candidate: Admin log tab should work in Docker",
		"## What Happened",
		"## Proposed Guardrail",
		"incident:logs",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("lesson candidate missing %q: %s", want, body)
		}
	}
}

func cueboardParityMustReadFile(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(data)
}

func cueboardParityMustWriteFile(t *testing.T, path string, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}
