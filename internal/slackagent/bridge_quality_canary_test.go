package slackagent

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

// bridgeQualityFixture is the JSON-loadable shape for
// testdata/bridge_quality_fixtures/*.json. Schema is documented in
// testdata/bridge_quality_fixtures/README.md.
type bridgeQualityFixture struct {
	CaseID                 string                          `json:"case_id"`
	Source                 bridgeQualityFixtureSource      `json:"source"`
	Input                  bridgeQualityFixtureInput       `json:"input"`
	ExpectedContractItems  []string                        `json:"expected_contract_items"`
	ExpectedEvidence       []string                        `json:"expected_evidence_anchors"`
	ExpectedTools          []string                        `json:"expected_tools_invoked"`
	ExpectedDecisionShape  bridgeQualityFixtureDecision    `json:"expected_decision_shape"`
}

type bridgeQualityFixtureSource struct {
	OldSlackDBRunID *int   `json:"old_slack_db_run_id"`
	OccurredAt      string `json:"occurred_at"`
	ChannelID       string `json:"channel_id"`
	MentionText     string `json:"mention_text"`
	Notes           string `json:"notes"`
}

type bridgeQualityFixtureInput struct {
	ChannelName         string                        `json:"channel_name"`
	UserName            string                        `json:"user_name"`
	MentionText         string                        `json:"mention_text"`
	Transcript          string                        `json:"transcript"`
	ThreadContextPrompt string                        `json:"thread_context_prompt"`
	ExternalLinks       []SlackExternalLinkContext    `json:"external_links"`
	LinkedSlackThreads  []SlackLinkedThreadContext    `json:"linked_slack_threads"`
	Files               []SlackThreadFile             `json:"files"`
	MemorySeedFiles     []bridgeQualityFixtureSeedMem `json:"memory_seed_files"`
}

type bridgeQualityFixtureSeedMem struct {
	RelPath string `json:"rel_path"`
	Content string `json:"content"`
}

type bridgeQualityFixtureDecision struct {
	MinChars       int      `json:"min_chars"`
	MaxChars       int      `json:"max_chars"`
	MustNotContain []string `json:"must_not_contain"`
}

// TestBridgeQualityCanaries replays representative Bridge production
// cases through the new Oneesama worker pipeline and asserts the
// expected entry-parity contract items still hold.
//
// New fixtures get added under testdata/bridge_quality_fixtures/. See
// the README there for the schema and the contract-item mapping.
func TestBridgeQualityCanaries(t *testing.T) {
	fixtureDir := filepath.Join("testdata", "bridge_quality_fixtures")
	entries, err := os.ReadDir(fixtureDir)
	if err != nil {
		t.Fatalf("read fixture dir: %v", err)
	}

	var fixtures []string
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if !strings.HasPrefix(name, "case_") || !strings.HasSuffix(name, ".json") {
			continue
		}
		fixtures = append(fixtures, filepath.Join(fixtureDir, name))
	}
	if len(fixtures) == 0 {
		t.Fatalf("no bridge quality fixtures found in %s", fixtureDir)
	}

	for _, path := range fixtures {
		path := path
		t.Run(filepath.Base(path), func(t *testing.T) {
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("read fixture: %v", err)
			}
			var fixture bridgeQualityFixture
			if err := json.Unmarshal(data, &fixture); err != nil {
				t.Fatalf("parse fixture: %v", err)
			}
			runBridgeQualityFixture(t, fixture)
		})
	}
}

func runBridgeQualityFixture(t *testing.T, fixture bridgeQualityFixture) {
	t.Helper()
	if fixture.CaseID == "" {
		t.Fatalf("fixture missing case_id")
	}

	workspaceDir := t.TempDir()
	for _, seed := range fixture.Input.MemorySeedFiles {
		writeRelatedMemoryFile(t, workspaceDir, seed.RelPath, seed.Content)
	}

	service := NewService(Config{
		Slack: appconfig.SlackConfig{WorkspaceDir: workspaceDir},
	})

	mention := &SlackAppMentionContext{
		MentionText:        fixture.Input.MentionText,
		Transcript:         fixture.Input.Transcript,
		Prompt:             fixture.Input.ThreadContextPrompt,
		ExternalLinks:      fixture.Input.ExternalLinks,
		LinkedSlackThreads: fixture.Input.LinkedSlackThreads,
		Files:              fixture.Input.Files,
	}

	runnerContext := service.buildAgentRunnerContext(context.Background(), AvatarCommandInput{
		ChannelName:       fixture.Input.ChannelName,
		UserName:          fixture.Input.UserName,
		RichThreadContext: mention,
	}, parsedAvatarCommand{Action: "work"}, nil)

	for _, item := range fixture.ExpectedContractItems {
		switch item {
		case "C4_related_memory_evidence_injected":
			evidence, ok := runnerContext["relatedMemoryEvidence"].(string)
			if !ok || strings.TrimSpace(evidence) == "" {
				t.Fatalf("[%s] expected relatedMemoryEvidence (C4) to be set; got %#v", fixture.CaseID, runnerContext["relatedMemoryEvidence"])
			}
			for _, anchor := range fixture.ExpectedEvidence {
				if !strings.Contains(evidence, anchor) {
					t.Fatalf("[%s] relatedMemoryEvidence missing anchor %q; evidence: %q", fixture.CaseID, anchor, evidence)
				}
			}
		case "C220_media_file_evidence":
			evidence, ok := runnerContext["slackToolEvidence"].(string)
			if !ok || strings.TrimSpace(evidence) == "" {
				t.Fatalf("[%s] expected slackToolEvidence (C220) to be set; got %#v", fixture.CaseID, runnerContext["slackToolEvidence"])
			}
			for _, anchor := range fixture.ExpectedEvidence {
				if !strings.Contains(evidence, anchor) {
					t.Fatalf("[%s] slackToolEvidence missing anchor %q; evidence: %q", fixture.CaseID, anchor, evidence)
				}
			}
			for _, tool := range fixture.ExpectedTools {
				if !strings.Contains(evidence, tool) {
					t.Fatalf("[%s] slackToolEvidence missing tool %q; evidence: %q", fixture.CaseID, tool, evidence)
				}
			}
		default:
			t.Logf("[%s] contract item %q not asserted by this scaffold yet; future fixtures should extend runBridgeQualityFixture", fixture.CaseID, item)
		}
	}

	for _, banned := range fixture.ExpectedDecisionShape.MustNotContain {
		if banned == "" {
			continue
		}
		lower := strings.ToLower(banned)
		if related, _ := runnerContext["relatedMemoryEvidence"].(string); strings.Contains(strings.ToLower(related), lower) {
			t.Fatalf("[%s] relatedMemoryEvidence leaks banned token %q: %q", fixture.CaseID, banned, related)
		}
		if tools, _ := runnerContext["slackToolEvidence"].(string); strings.Contains(strings.ToLower(tools), lower) {
			t.Fatalf("[%s] slackToolEvidence leaks banned token %q: %q", fixture.CaseID, banned, tools)
		}
	}
}
