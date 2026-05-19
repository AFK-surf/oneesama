package slackagent

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"time"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

const turnExtractionMemoryProviderName = "turn_extractor"

type turnExtractionMemoryProvider struct {
	SlackMemoryNoopProvider
	enabled      bool
	workspaceDir string
	mu           sync.Mutex
	seen         map[string]struct{}
}

func newTurnExtractionMemoryProvider(cfg appconfig.SlackMemoryConfig) SlackMemoryProvider {
	return &turnExtractionMemoryProvider{
		enabled: cfg.Enabled,
		seen:    make(map[string]struct{}),
	}
}

func (p *turnExtractionMemoryProvider) Name() string { return turnExtractionMemoryProviderName }

func (p *turnExtractionMemoryProvider) Available() bool {
	return p != nil && p.enabled
}

func (p *turnExtractionMemoryProvider) Initialize(_ context.Context, init SlackMemoryProviderInit) error {
	if p == nil || !p.enabled {
		return nil
	}
	p.workspaceDir = strings.TrimSpace(init.WorkspaceDir)
	return nil
}

func (p *turnExtractionMemoryProvider) SyncTurn(_ context.Context, turn SlackMemoryProviderTurn) error {
	if p == nil || !p.enabled || strings.TrimSpace(p.workspaceDir) == "" {
		return nil
	}
	candidate := turnExtractionCandidateText(turn)
	if candidate == "" {
		return nil
	}
	key := sha256sum([]byte(strings.Join([]string{
		turn.SessionID,
		turn.UserContent,
		turn.AssistantContent,
		candidate,
	}, "\n")))
	p.mu.Lock()
	if _, ok := p.seen[key]; ok {
		p.mu.Unlock()
		return nil
	}
	p.seen[key] = struct{}{}
	p.mu.Unlock()

	day := timeNow().UTC().Format("2006-01-02")
	rel := filepath.ToSlash(filepath.Join("memory", "extractions", "candidates", day, "turn-"+key+".md"))
	body := renderTurnExtractionCandidate(rel, candidate, turn)
	return legacySlackWriteGeneratedFile(p.workspaceDir, rel, []byte(body), true)
}

func turnExtractionCandidateText(turn SlackMemoryProviderTurn) string {
	user := strings.TrimSpace(turn.UserContent)
	assistant := strings.TrimSpace(turn.AssistantContent)
	combined := strings.TrimSpace(user + "\n" + assistant)
	if combined == "" {
		return ""
	}
	lower := strings.ToLower(combined)
	if !turnLooksLikeMemoryCandidate(lower) {
		return ""
	}
	if assistant != "" {
		return truncateSlackContextText(assistant, 1200)
	}
	return truncateSlackContextText(user, 1200)
}

func turnLooksLikeMemoryCandidate(lower string) bool {
	for _, marker := range []string{
		"记下来", "记住", "注意一下", "以后", "偏好", "负责人", "联系人", "关联", "属于", "无关",
		"remember", "note that", "keep in mind", "preference", "prefers", "owner", "contact", "relates to", "belongs to", "not related",
	} {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return false
}

func renderTurnExtractionCandidate(rel string, candidate string, turn SlackMemoryProviderTurn) string {
	user, userRedactions := redactSlockWorkspaceSecrets(strings.TrimSpace(turn.UserContent))
	assistant, assistantRedactions := redactSlockWorkspaceSecrets(strings.TrimSpace(turn.AssistantContent))
	candidate, candidateRedactions := redactSlockWorkspaceSecrets(strings.TrimSpace(candidate))
	metadata, _ := json.MarshalIndent(turn.Metadata, "", "  ")
	metadataText, metadataRedactions := redactSlockWorkspaceSecrets(string(metadata))
	redactions := userRedactions + assistantRedactions + candidateRedactions + metadataRedactions

	var b strings.Builder
	b.WriteString("# Memory Extraction Candidate\n\n")
	legacySlackWriteBullet(&b, "Schema", "oneesama.memory-extraction-candidate.v1")
	legacySlackWriteBullet(&b, "Status", "review_candidate")
	legacySlackWriteBullet(&b, "Source", "memory_provider:"+turnExtractionMemoryProviderName)
	legacySlackWriteBullet(&b, "Path", filepath.ToSlash(rel))
	legacySlackWriteBullet(&b, "Session", strings.TrimSpace(turn.SessionID))
	legacySlackWriteBullet(&b, "Created at", timeNow().UTC().Format(time.RFC3339Nano))
	if redactions > 0 {
		legacySlackWriteBullet(&b, "Redactions", fmt.Sprintf("%d", redactions))
	}
	b.WriteString("\n## Candidate Fact Source\n\n")
	b.WriteString(candidate)
	b.WriteString("\n\n## User Turn\n\n")
	b.WriteString(user)
	b.WriteString("\n\n## Assistant Turn\n\n")
	b.WriteString(assistant)
	if strings.TrimSpace(metadataText) != "" && strings.TrimSpace(metadataText) != "null" {
		b.WriteString("\n\n## Metadata\n\n```json\n")
		b.WriteString(metadataText)
		b.WriteString("\n```\n")
	}
	b.WriteString("\n\n## Review Guidance\n\n")
	b.WriteString("This file is a reviewable Memory candidate. Promote it into a stable person/project/team Memory only after validating the source thread.\n")
	return b.String()
}
