package slackagent

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
	"github.com/AFK-surf/oneesama/internal/persona"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

// bridgeQualityFixture is the JSON-loadable shape for
// testdata/bridge_quality_fixtures/*.json. Schema is documented in
// testdata/bridge_quality_fixtures/README.md.
type bridgeQualityFixture struct {
	CaseID                  string                       `json:"case_id"`
	Source                  bridgeQualityFixtureSource   `json:"source"`
	Input                   bridgeQualityFixtureInput    `json:"input"`
	Pending                 bool                         `json:"pending"`
	PendingReason           string                       `json:"pending_reason"`
	ExpectedContractItems   []string                     `json:"expected_contract_items"`
	ExpectedEvidence        []string                     `json:"expected_evidence_anchors"`
	ExpectedTools           []string                     `json:"expected_tools_invoked"`
	ExpectedDecisionShape   bridgeQualityFixtureDecision `json:"expected_decision_shape"`
	IntendedProviderSignals []string                     `json:"intended_provider_signals"`
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
	if fixture.Pending {
		t.Logf("[%s] fixture marked pending (%s); skipping assertions", fixture.CaseID, fixture.PendingReason)
		return
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
		case "C222_memory_recall_ranking_parity":
			evidence, ok := runnerContext["relatedMemoryEvidence"].(string)
			if !ok || strings.TrimSpace(evidence) == "" {
				t.Fatalf("[%s] expected relatedMemoryEvidence (C222) to be set; got %#v", fixture.CaseID, runnerContext["relatedMemoryEvidence"])
			}
			firstLine := firstNonEmptyLine(evidence)
			if len(fixture.ExpectedEvidence) > 0 && !strings.Contains(firstLine, fixture.ExpectedEvidence[0]) {
				t.Fatalf("[%s] top related-memory evidence = %q, want anchor %q first; full evidence: %q", fixture.CaseID, firstLine, fixture.ExpectedEvidence[0], evidence)
			}
			for _, anchor := range fixture.ExpectedEvidence {
				if !strings.Contains(evidence, anchor) {
					t.Fatalf("[%s] relatedMemoryEvidence missing anchor %q; evidence: %q", fixture.CaseID, anchor, evidence)
				}
			}
		case "C220_media_file_evidence", "C223_workflow_intent_recognition":
			evidence, ok := runnerContext["slackToolEvidence"].(string)
			if !ok || strings.TrimSpace(evidence) == "" {
				t.Fatalf("[%s] expected slackToolEvidence (%s) to be set; got %#v", fixture.CaseID, item, runnerContext["slackToolEvidence"])
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
		case "C241_link_commentary_synthesis":
			assertBridgeQualityLinkCommentarySynthesis(t, fixture, runnerContext)
		case "C237_pi_first_foreground_no_pre_pi_runner":
			assertBridgeQualityPiFirstForeground(t, fixture)
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

func assertBridgeQualityLinkCommentarySynthesis(t *testing.T, fixture bridgeQualityFixture, runnerContext map[string]any) {
	t.Helper()
	evidence, ok := runnerContext["relatedMemoryEvidence"].(string)
	if !ok || strings.TrimSpace(evidence) == "" {
		t.Fatalf("[%s] expected relatedMemoryEvidence for link commentary synthesis; got %#v", fixture.CaseID, runnerContext["relatedMemoryEvidence"])
	}
	mention, ok := runnerContext["slackAppMention"].(*SlackAppMentionContext)
	if !ok || mention == nil || len(mention.ExternalLinks) == 0 {
		t.Fatalf("[%s] expected slackAppMention external link context; got %#v", fixture.CaseID, runnerContext["slackAppMention"])
	}
	linkContext := formatSlackExternalLinkContexts(mention.ExternalLinks)
	if strings.TrimSpace(linkContext) == "" {
		t.Fatalf("[%s] expected formatted fetched external link context; links=%#v", fixture.CaseID, mention.ExternalLinks)
	}
	for _, anchor := range fixture.ExpectedEvidence {
		if strings.Contains(evidence, anchor) || strings.Contains(linkContext, anchor) {
			continue
		}
		t.Fatalf("[%s] link commentary synthesis missing anchor %q; related=%q external=%q", fixture.CaseID, anchor, evidence, linkContext)
	}
	combined := strings.ToLower(evidence + "\n" + linkContext)
	if strings.Contains(combined, "headline-only") || strings.Contains(combined, "headline only") {
		t.Fatalf("[%s] canary fixture should not pass with headline-only evidence: %q", fixture.CaseID, combined)
	}
}

func assertBridgeQualityPiFirstForeground(t *testing.T, fixture bridgeQualityFixture) {
	t.Helper()
	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	runner := &fakeRunner{job: agentrunner.Job{
		ID:       "job_unexpected_pre_pi",
		Provider: "codex",
		Status:   agentrunner.StatusCompleted,
		Result:   `{"summary":"Codex should not run first","actions":[]}`,
	}}
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack: appconfig.SlackConfig{
			WorkspaceDir: t.TempDir(),
			Triage:       appconfig.SlackTriageConfig{ForegroundChain: "pi_first_live"},
		},
		PersonaRuntime: appconfig.PersonaRuntimeConfig{
			Provider: persona.ProviderFake,
			Mode:     persona.ModeLive,
			Timeout:  time.Second,
		},
		Poster: poster,
		Runner: runner,
	})
	runtime := &capturePersonaRuntime{response: persona.Response{
		Runtime:     persona.ProviderPi,
		Decision:    persona.DecisionReply,
		VisibleText: "Pi-first canary reply.",
		Reason:      "Pi owns the foreground decision",
		Confidence:  0.9,
		ShadowOnly:  false,
	}}
	service.personaRuntime = runtime
	service.personaRuntimeErr = nil
	service.personaRuntimeConfig.Provider = persona.ProviderPi
	service.personaRuntimeConfig.Mode = persona.ModeLive
	service.personaRuntimeConfig.ShadowOnly = false

	channelID := firstNonEmpty(fixture.Source.ChannelID, "CPIFIRST")
	threadTS := "1779196000.000000"
	started, err := service.StartSlackTriage(context.Background(), channelID, []SlackInboundMessage{{
		TeamID:         "TBRIDGE",
		ChannelIDSnake: channelID,
		UserIDSnake:    "UASK",
		Text:           fixture.Input.MentionText,
		TS:             threadTS,
	}}, fixture.Input.Transcript)
	if err != nil {
		t.Fatalf("[%s] StartSlackTriage: %v", fixture.CaseID, err)
	}
	if started.Job != nil || runner.startCount != 0 {
		t.Fatalf("[%s] started=%#v runner.startCount=%d, want no pre-Pi agent_runner", fixture.CaseID, started, runner.startCount)
	}
	poster.WaitForCalls(t, 1)
	if runner.startCount != 0 {
		t.Fatalf("[%s] runner.startCount after Pi reply = %d, want 0", fixture.CaseID, runner.startCount)
	}
	updated := waitForPersonaForegroundRun(t, service, started.Run.ID)
	if updated.Metadata["foreground_chain"] != slackTriageForegroundChainPiFirstLive || boolFromAny(updated.Metadata["pre_pi_agent_runner_started"], true) {
		t.Fatalf("[%s] metadata = %#v, want pi_first_live + no pre-Pi runner", fixture.CaseID, updated.Metadata)
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if len(runtime.requests) != 1 {
		t.Fatalf("[%s] persona requests = %#v, want one Pi request", fixture.CaseID, runtime.requests)
	}
}

func firstNonEmptyLine(text string) string {
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line != "" {
			return line
		}
	}
	return ""
}
