//go:build cueboardparity

package slackagent

import (
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCueboardParityRefreshPeopleMemoryProjectionBuildsProfilesFromIdentityAndTeamMeetings(t *testing.T) {
	t.Parallel()

	workspaceDir := t.TempDir()
	cueboardParityMustWriteFile(t, filepath.Join(workspaceDir, "MEMORY.md"), `# MEMORY.md

## Cross-Platform Identity Notes

- Peng Xiao: Slack <@U09KNU8QD1V>, Linear pengxiao, GitHub pengx17
- Haowen Sun: Slack <@U02ABC>, Linear l-sun, GitHub L-Sun
`)

	summary := &MeetingSummaryData{
		Title:     "Weekly Product Sync",
		Attendees: []string{"Peng Xiao", "Haowen Sun"},
		KeyPoints: []string{
			"Peng Xiao wants the admin dashboard to behave more like an ops cockpit.",
			"Haowen Sun is leading the first people-memory prototype for persistent person context.",
		},
		ActionItems: []MeetingActionItem{
			{Description: "Prototype people memory projector", Owner: "Haowen", Deadline: "Friday"},
		},
	}
	source := teamMemorySource{
		Title:      "Weekly Product Sync",
		SourceType: "meeting",
		SourceRef:  "meeting:21",
		Timestamp:  time.Date(2026, 3, 26, 17, 5, 0, 0, shanghaiLocation()),
	}

	if err := projectMeetingSummaryToTeamMemory(workspaceDir, 21, summary, source); err != nil {
		t.Fatalf("projectMeetingSummaryToTeamMemory: %v", err)
	}
	if err := RefreshPeopleMemoryProjection(workspaceDir); err != nil {
		t.Fatalf("RefreshPeopleMemoryProjection: %v", err)
	}

	haowenDoc := cueboardParityMustReadFile(t, filepath.Join(workspaceDir, "memory/people/haowen-sun.md"))
	for _, want := range []string{
		"# Person Memory: Haowen Sun",
		"## Identity Map",
		"Linear l-sun",
		"## Durable Context",
		"Haowen Sun is leading the first people-memory prototype",
		"## Current Responsibilities",
		"Prototype people memory projector",
		"## Recent Meetings",
		"Weekly Product Sync",
	} {
		if !strings.Contains(haowenDoc, want) {
			t.Fatalf("Haowen people memory missing %q:\n%s", want, haowenDoc)
		}
	}

	pengDoc := cueboardParityMustReadFile(t, filepath.Join(workspaceDir, "memory/people/peng-xiao.md"))
	for _, want := range []string{
		"# Person Memory: Peng Xiao",
		"GitHub pengx17",
		"admin dashboard to behave more like an ops cockpit",
		"Weekly Product Sync",
	} {
		if !strings.Contains(pengDoc, want) {
			t.Fatalf("Peng people memory missing %q:\n%s", want, pengDoc)
		}
	}
}

func TestCueboardParityCanonicalPersonNameMatchesCompactAndReorderedAliases(t *testing.T) {
	t.Parallel()

	known := []string{"Zijian Zuo", "Darksky", "Haowen Sun"}
	cases := map[string]string{
		"Zuozijian": "Zijian Zuo",
		"sky dark":  "Darksky",
		"Haowen":    "Haowen Sun",
		"enther he": "Enther He",
	}
	for raw, want := range cases {
		if got := canonicalPersonName(raw, known); got != want {
			t.Fatalf("canonicalPersonName(%q) = %q, want %q", raw, got, want)
		}
	}
}

func TestCueboardParityFindPersonMemoryProfilesMatchesAliasAndFormatsBriefing(t *testing.T) {
	t.Parallel()

	workspaceDir := t.TempDir()
	cueboardParityMustWriteFile(t, filepath.Join(workspaceDir, "MEMORY.md"), `# MEMORY.md

## Cross-Platform Identity Notes

- Jiachen He: Slack <@U01JIA>, GitHub jiachenhe
- Haowen Sun: Slack <@U02HAO>, GitHub haowensun
`)
	cueboardParityMustWriteFile(t, filepath.Join(workspaceDir, "memory/team/meetings/meeting-30.md"), `# Team Memory: Investor Prep

- Source ref: meeting:30
- Captured at: 2026-03-26 18:20 CST
- Slack thread permalink: https://example.test/thread
- Participants: Jiachen He, Haowen

## Stable Context
- Jiachen He is coordinating investor-facing product narrative.

## Action Items
- Draft the one-page launch narrative — owner: Jiachen — deadline: Monday
`)

	matches, err := findPersonMemoryProfiles(workspaceDir, "jiachen", 3)
	if err != nil {
		t.Fatalf("findPersonMemoryProfiles: %v", err)
	}
	if len(matches) == 0 || matches[0].Name != "Jiachen He" {
		t.Fatalf("top match = %+v, want Jiachen He", matches)
	}

	contextMatches, err := findPersonMemoryProfiles(workspaceDir, "investor-facing product narrative", 3)
	if err != nil {
		t.Fatalf("findPersonMemoryProfiles by durable context: %v", err)
	}
	if len(contextMatches) == 0 || contextMatches[0].Name != "Jiachen He" {
		t.Fatalf("context top match = %+v, want Jiachen He from durable context", contextMatches)
	}

	briefing := renderPersonMemoryBriefing(matches[0])
	for _, want := range []string{
		"Briefing for Jiachen He",
		"Who they are:",
		"Likely current focus:",
		"Draft the one-page launch narrative",
		"Source: memory/people/jiachen-he.md",
	} {
		if !strings.Contains(briefing, want) {
			t.Fatalf("briefing missing %q:\n%s", want, briefing)
		}
	}
}

func TestCueboardParityPersonMemoryToolLookupListAndCorrect(t *testing.T) {
	t.Parallel()

	workspaceDir := t.TempDir()
	cueboardParityMustWriteFile(t, filepath.Join(workspaceDir, "MEMORY.md"), `# MEMORY.md

## Cross-Platform Identity Notes

- Peng Xiao: Slack <@U09PENG>, GitHub pengx17
- Haowen Sun: Slack <@U02HAO>, GitHub haowensun
- Jiachen He: Slack <@U01JIA>, GitHub jiachenhe
`)
	cueboardParityMustWriteFile(t, filepath.Join(workspaceDir, "memory/team/meetings/meeting-31.md"), `# Team Memory: Launch Ops

- Source ref: meeting:31
- Captured at: 2026-03-26 19:05 CST
- Participants: Peng Xiao, Haowen Sun

## Stable Context
- Peng Xiao wants the bot to feel like a real teammate.

## Action Items
- Polish launch checklist — owner: Peng Xiao — deadline: Friday
`)
	cueboardParityMustWriteFile(t, filepath.Join(workspaceDir, "memory/team/meetings/meeting-33.md"), `# Team Memory: Launch Prep

- Source ref: meeting:33
- Captured at: 2026-03-26 21:10 CST
- Participants: Jiachen He
`)

	tool := &personMemoryTool{workspaceDir: workspaceDir}

	lookup, err := tool.Execute(nil, map[string]any{"action": "lookup", "person": "peng"})
	if err != nil {
		t.Fatalf("lookup Execute: %v", err)
	}
	body := lookup.GetTextOutput()
	for _, want := range []string{"Person: Peng Xiao", "Source: memory/people/peng-xiao.md", "Current responsibilities:", "Polish launch checklist"} {
		if !strings.Contains(body, want) {
			t.Fatalf("lookup missing %q:\n%s", want, body)
		}
	}

	briefing, err := tool.Execute(nil, map[string]any{"action": "briefing", "person": "peng"})
	if err != nil {
		t.Fatalf("briefing Execute: %v", err)
	}
	if got := briefing.GetTextOutput(); !strings.Contains(got, "Briefing for Peng Xiao") || !strings.Contains(got, "Polish launch checklist") {
		t.Fatalf("unexpected briefing output:\n%s", got)
	}

	list, err := tool.Execute(nil, map[string]any{"action": "list", "limit": 5})
	if err != nil {
		t.Fatalf("list Execute: %v", err)
	}
	if got := list.GetTextOutput(); !strings.Contains(got, "Known people") || !strings.Contains(got, "Haowen Sun") {
		t.Fatalf("unexpected list output:\n%s", got)
	}

	result, err := tool.Execute(nil, map[string]any{
		"action": "correct",
		"person": "Jiachen",
		"note":   "He no longer owns the fundraising demo deck.",
		"author": "assistant",
	})
	if err != nil {
		t.Fatalf("correct Execute: %v", err)
	}
	if got := result.GetTextOutput(); !strings.Contains(got, "Saved operator note for Jiachen He") {
		t.Fatalf("unexpected correct output:\n%s", got)
	}
	lookup, err = tool.Execute(nil, map[string]any{"action": "lookup", "person": "Jiachen"})
	if err != nil {
		t.Fatalf("lookup Execute after correct: %v", err)
	}
	if got := lookup.GetTextOutput(); !strings.Contains(got, "Operator notes:") || !strings.Contains(got, "fundraising demo deck") {
		t.Fatalf("lookup should include operator note:\n%s", got)
	}
}
