package slackagent

import (
	"strings"
	"testing"

	"github.com/AFK-surf/oneesama/internal/persona"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestSlackMemoryIdentityScopeCanaryKeepsCodexWorkerOutOfOneesamaIdentity(t *testing.T) {
	workspaceDir := t.TempDir()
	writeRelatedMemoryFile(t, workspaceDir, "memory/team/facts/oneesama-identity.md", strings.Join([]string{
		"# Oneesama identity",
		"",
		"kind: foreground_identity",
		"scope: foreground",
		"subject: oneesama",
		"Oneesama foreground identity is the Oneesama Pi agent serving Slack and meetings.",
		"当用户问你是谁或是什么模型时，回答 Oneesama / Pi foreground identity, not delegated worker identity.",
	}, "\n"))
	writeRelatedMemoryFile(t, workspaceDir, "memory/legacy/slack-agent-d/workspace/MEMORY.md", strings.Join([]string{
		"# Legacy worker memory",
		"",
		"kind: worker_identity",
		"scope: worker",
		"subject: codex-3720",
		"codex-3720 is an OpenAI Codex worker model used for delegated coding jobs.",
		"这条 worker identity 不能被当成 Oneesama foreground identity 回答用户的你是谁/模型问题。",
	}, "\n"))
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack:       appconfig.SlackConfig{WorkspaceDir: workspaceDir},
	})

	result := service.SearchRelatedMemory("Oneesama foreground_identity codex-3720 你是谁 模型 identity", SlackRelatedMemorySearchOptions{Limit: 8})
	if !slackMemoryTestRecordsContain(result.Results, "codex-3720") {
		t.Fatalf("canary fixture did not surface adversarial worker memory; results = %#v", result.Results)
	}

	canary := evaluateSlackMemoryIdentityScopeCanary(result.Results)
	if !canary.Pass || canary.Outcome != slackMemoryScopeOutcomeForegroundIdentityScoped {
		t.Fatalf("identity canary = %#v, want foreground identity scoped", canary)
	}
	if !slackMemoryTestStringsContain(canary.Evidence, "ignored_worker_identity=") {
		t.Fatalf("identity canary evidence = %#v, want worker identity explicitly ignored", canary.Evidence)
	}
}

func TestSlackMemoryContradictionCanaryRoutesWorkerIdentityWriteToReview(t *testing.T) {
	existing := []SlackRelatedMemoryRecord{{
		Kind:       "team_fact",
		Source:     "memory/team/facts/oneesama-identity.md",
		SourcePath: "memory/team/facts/oneesama-identity.md",
		Content: strings.Join([]string{
			"kind: foreground_identity",
			"scope: foreground",
			"subject: oneesama",
			"Oneesama foreground identity is Oneesama Pi agent.",
		}, "\n"),
	}}
	write := persona.MemoryWrite{
		Kind:      "identity_fact",
		Text:      "kind: worker_identity\nscope: worker\nsubject: oneesama\nOneesama is codex-3720 delegated worker.",
		SourceRef: "slack:C0TEST/1779000000.000001",
		Metadata: map[string]any{
			"kind":    "worker_identity",
			"scope":   "worker",
			"subject": "oneesama",
			"source":  "codex-3720",
		},
	}

	canary := evaluateSlackMemoryContradictionCanary(existing, write)
	if !canary.Pass || canary.Outcome != slackMemoryScopeOutcomeContradictionReview {
		t.Fatalf("contradiction canary = %#v, want contradiction_review", canary)
	}
	if !slackMemoryTestStringsContain(canary.Evidence, "memory/team/facts/oneesama-identity.md") {
		t.Fatalf("contradiction canary evidence = %#v, want foreground identity source", canary.Evidence)
	}
}

func TestSlackMemoryContradictionCanaryDoesNotReviewNonIdentityPreference(t *testing.T) {
	existing := []SlackRelatedMemoryRecord{{
		Kind:       "team_fact",
		SourcePath: "memory/team/facts/oneesama-identity.md",
		Content:    "kind: foreground_identity\nscope: foreground\nOneesama foreground identity is Oneesama Pi agent.",
	}}
	write := persona.MemoryWrite{
		Kind: "preference",
		Text: "Peng prefers concise replies during smoke tests.",
		Metadata: map[string]any{
			"scope": "foreground",
		},
	}

	canary := evaluateSlackMemoryContradictionCanary(existing, write)
	if canary.Pass || canary.Outcome != slackMemoryScopeOutcomeActiveMemory {
		t.Fatalf("non-identity write canary = %#v, want active_memory non-pass control", canary)
	}
}

func slackMemoryTestRecordsContain(records []SlackRelatedMemoryRecord, needle string) bool {
	for _, record := range records {
		if strings.Contains(record.Content, needle) || strings.Contains(record.SourcePath, needle) || strings.Contains(record.Source, needle) {
			return true
		}
	}
	return false
}

func slackMemoryTestStringsContain(values []string, needle string) bool {
	for _, value := range values {
		if strings.Contains(value, needle) {
			return true
		}
	}
	return false
}
