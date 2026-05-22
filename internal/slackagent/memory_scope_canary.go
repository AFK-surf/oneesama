package slackagent

import (
	"fmt"
	"strings"

	"github.com/AFK-surf/oneesama/internal/persona"
)

const (
	slackMemoryScopeCanaryIdentityCase      = "case_identity_scope_codex3720_not_oneesama"
	slackMemoryScopeCanaryContradictionCase = "case_contradiction_routes_to_review"

	slackMemoryScopeOutcomeForegroundIdentityScoped  = "foreground_identity_scoped"
	slackMemoryScopeOutcomeWorkerIdentityLeaked      = "worker_identity_leaked"
	slackMemoryScopeOutcomeMissingForegroundIdentity = "missing_foreground_identity"
	slackMemoryScopeOutcomeContradictionReview       = "contradiction_review"
	slackMemoryScopeOutcomeActiveMemory              = "active_memory"
)

type SlackMemoryScopeCanaryResult struct {
	CaseID   string   `json:"caseId"`
	Pass     bool     `json:"pass"`
	Outcome  string   `json:"outcome"`
	Reason   string   `json:"reason,omitempty"`
	Evidence []string `json:"evidence,omitempty"`
}

func evaluateSlackMemoryIdentityScopeCanary(records []SlackRelatedMemoryRecord) SlackMemoryScopeCanaryResult {
	var foregroundEvidence []string
	var workerEvidence []string
	for _, record := range records {
		if slackMemoryRecordIsForegroundIdentity(record) {
			foregroundEvidence = append(foregroundEvidence, slackMemoryRecordEvidenceRef(record))
			continue
		}
		if slackMemoryRecordIsWorkerIdentity(record) {
			workerEvidence = append(workerEvidence, slackMemoryRecordEvidenceRef(record))
		}
	}
	if len(foregroundEvidence) > 0 {
		evidence := append([]string(nil), foregroundEvidence...)
		if len(workerEvidence) > 0 {
			evidence = append(evidence, "ignored_worker_identity="+strings.Join(workerEvidence, ","))
		}
		return SlackMemoryScopeCanaryResult{
			CaseID:   slackMemoryScopeCanaryIdentityCase,
			Pass:     true,
			Outcome:  slackMemoryScopeOutcomeForegroundIdentityScoped,
			Reason:   "foreground_identity_evidence_wins_over_worker_memory",
			Evidence: evidence,
		}
	}
	if len(workerEvidence) > 0 {
		return SlackMemoryScopeCanaryResult{
			CaseID:   slackMemoryScopeCanaryIdentityCase,
			Pass:     false,
			Outcome:  slackMemoryScopeOutcomeWorkerIdentityLeaked,
			Reason:   "worker_identity_memory_would_answer_foreground_identity_question",
			Evidence: workerEvidence,
		}
	}
	return SlackMemoryScopeCanaryResult{
		CaseID:  slackMemoryScopeCanaryIdentityCase,
		Pass:    false,
		Outcome: slackMemoryScopeOutcomeMissingForegroundIdentity,
		Reason:  "no_foreground_identity_memory_found",
	}
}

func evaluateSlackMemoryContradictionCanary(existing []SlackRelatedMemoryRecord, write persona.MemoryWrite) SlackMemoryScopeCanaryResult {
	if !slackMemoryWriteIsIdentityFact(write) || !slackMemoryWriteIsWorkerScoped(write) {
		return SlackMemoryScopeCanaryResult{
			CaseID:  slackMemoryScopeCanaryContradictionCase,
			Pass:    false,
			Outcome: slackMemoryScopeOutcomeActiveMemory,
			Reason:  "candidate_write_is_not_worker_scoped_identity",
		}
	}
	for _, record := range existing {
		if !slackMemoryRecordIsForegroundIdentity(record) {
			continue
		}
		return SlackMemoryScopeCanaryResult{
			CaseID:   slackMemoryScopeCanaryContradictionCase,
			Pass:     true,
			Outcome:  slackMemoryScopeOutcomeContradictionReview,
			Reason:   "worker_identity_write_conflicts_with_foreground_identity_fact",
			Evidence: []string{slackMemoryRecordEvidenceRef(record), slackMemoryWriteEvidenceRef(write)},
		}
	}
	return SlackMemoryScopeCanaryResult{
		CaseID:  slackMemoryScopeCanaryContradictionCase,
		Pass:    false,
		Outcome: slackMemoryScopeOutcomeActiveMemory,
		Reason:  "no_foreground_identity_fact_to_compare",
	}
}

func slackMemoryRecordIsForegroundIdentity(record SlackRelatedMemoryRecord) bool {
	source := strings.ToLower(record.SourcePath + " " + record.Source + " " + record.Kind)
	content := strings.ToLower(record.Content)
	if !strings.Contains(source, "memory/team/facts") && record.Kind != "team_fact" {
		return false
	}
	return strings.Contains(content, "foreground_identity") ||
		strings.Contains(content, "scope: foreground") ||
		strings.Contains(content, "oneesama foreground identity")
}

func slackMemoryRecordIsWorkerIdentity(record SlackRelatedMemoryRecord) bool {
	source := strings.ToLower(record.SourcePath + " " + record.Source + " " + record.Kind)
	content := strings.ToLower(record.Content)
	workerScoped := strings.Contains(source, "memory/legacy/slack-agent-d") ||
		strings.Contains(content, "scope: worker") ||
		strings.Contains(content, "worker_identity")
	identityScoped := strings.Contains(content, "identity") ||
		strings.Contains(content, "模型") ||
		strings.Contains(content, "你是谁")
	return workerScoped && identityScoped
}

func slackMemoryWriteIsIdentityFact(write persona.MemoryWrite) bool {
	kind := strings.ToLower(strings.TrimSpace(write.Kind))
	text := strings.ToLower(write.Text)
	return kind == "identity_fact" ||
		strings.Contains(slackMemoryWriteMetadataString(write, "kind"), "identity") ||
		strings.Contains(text, "foreground identity") ||
		strings.Contains(text, "worker identity") ||
		strings.Contains(text, "身份") ||
		strings.Contains(text, "模型")
}

func slackMemoryWriteIsWorkerScoped(write persona.MemoryWrite) bool {
	scope := slackMemoryWriteMetadataString(write, "scope")
	source := slackMemoryWriteMetadataString(write, "source")
	text := strings.ToLower(write.Text)
	return scope == "worker" ||
		strings.Contains(source, "worker") ||
		strings.Contains(source, "codex") ||
		strings.Contains(text, "scope: worker") ||
		strings.Contains(text, "worker_identity")
}

func slackMemoryWriteMetadataString(write persona.MemoryWrite, key string) string {
	if write.Metadata == nil {
		return ""
	}
	value, ok := write.Metadata[key]
	if !ok {
		return ""
	}
	return strings.ToLower(strings.TrimSpace(fmt.Sprint(value)))
}

func slackMemoryRecordEvidenceRef(record SlackRelatedMemoryRecord) string {
	return firstNonEmpty(record.SourceRef, record.SourcePath, record.Source, record.Kind)
}

func slackMemoryWriteEvidenceRef(write persona.MemoryWrite) string {
	return firstNonEmpty(write.SourceRef, slackMemoryWriteMetadataString(write, "source"), write.Kind)
}
