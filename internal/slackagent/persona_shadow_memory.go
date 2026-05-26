package slackagent

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"github.com/AFK-surf/oneesama/internal/persona"
)

type personaMemoryWritePersistence struct {
	Files                    []string
	ContradictionReviewFiles []string
	Errors                   []string
	Redactions               int
	ContradictionReviews     int
}

func (s *Service) persistPersonaForegroundMemoryWrites(ctx context.Context, result SlackPersonaShadowResult) personaMemoryWritePersistence {
	out := personaMemoryWritePersistence{}
	if !result.Success || len(result.memoryRecords) == 0 {
		return out
	}
	root := s.memoryWriteRoot()
	if strings.TrimSpace(root) == "" {
		out.Errors = append(out.Errors, "memory_disabled")
		return out
	}
	for _, record := range result.memoryRecords {
		if err := ctx.Err(); err != nil {
			out.Errors = append(out.Errors, err.Error())
			return out
		}
		text := strings.TrimSpace(record.Text)
		if text == "" {
			continue
		}
		contradiction := s.personaMemoryWriteContradictionVerdict(ctx, record)
		if contradiction.Outcome == slackMemoryScopeOutcomeContradictionReview {
			body, redactions := renderPersonaMemoryWriteContradictionReview(result, record, contradiction)
			out.Redactions += redactions
			rel := personaMemoryWriteContradictionReviewPath(result, record)
			if err := legacySlackWriteGeneratedFile(root, rel, []byte(body), true); err != nil {
				out.Errors = append(out.Errors, fmt.Sprintf("%s: %v", rel, err))
				continue
			}
			s.notifyMemoryProvidersWrite(ctx, SlackMemoryProviderWriteEvent{
				Action:  "contradiction_review",
				Target:  "persona",
				Path:    filepath.ToSlash(rel),
				Content: body,
				Source:  "persona_memory_write_contradiction_review",
				Metadata: map[string]any{
					"request_id": result.RequestID,
					"channel_id": result.ChannelID,
					"thread_ts":  result.ThreadTS,
					"kind":       record.Kind,
					"source_ref": record.SourceRef,
					"outcome":    contradiction.Outcome,
					"reason":     contradiction.Reason,
					"evidence":   contradiction.Evidence,
				},
			})
			out.ContradictionReviews++
			out.ContradictionReviewFiles = append(out.ContradictionReviewFiles, rel)
			continue
		}
		body, redactions := renderPersonaMemoryWrite(result, record)
		out.Redactions += redactions
		rel := personaMemoryWritePath(result, record)
		if err := legacySlackWriteGeneratedFile(root, rel, []byte(body), true); err != nil {
			out.Errors = append(out.Errors, fmt.Sprintf("%s: %v", rel, err))
			continue
		}
		s.notifyMemoryProvidersWrite(ctx, SlackMemoryProviderWriteEvent{
			Action:  "write",
			Target:  "persona",
			Path:    filepath.ToSlash(rel),
			Content: body,
			Source:  "persona_memory_write",
			Metadata: map[string]any{
				"request_id": result.RequestID,
				"channel_id": result.ChannelID,
				"thread_ts":  result.ThreadTS,
				"kind":       record.Kind,
				"source_ref": record.SourceRef,
			},
		})
		out.Files = append(out.Files, rel)
	}
	return out
}

func (s *Service) personaMemoryWriteContradictionVerdict(ctx context.Context, record persona.MemoryWrite) SlackMemoryScopeCanaryResult {
	if s == nil || !slackMemoryWriteIsIdentityFact(record) || !slackMemoryWriteIsWorkerScoped(record) {
		return SlackMemoryScopeCanaryResult{
			CaseID:  slackMemoryScopeCanaryContradictionCase,
			Pass:    false,
			Outcome: slackMemoryScopeOutcomeActiveMemory,
			Reason:  "candidate_write_is_not_worker_scoped_identity",
		}
	}
	query := personaMemoryWriteContradictionQuery(record)
	related := s.SearchRelatedMemoryContext(ctx, query, SlackRelatedMemorySearchOptions{Limit: 12})
	return evaluateSlackMemoryContradictionCanary(related.Results, record)
}

func personaMemoryWritePath(result SlackPersonaShadowResult, record persona.MemoryWrite) string {
	kind := sanitizePersonaMemoryPathComponent(firstNonEmpty(record.Kind, "memory"))
	day := timeNow().UTC().Format("2006-01-02")
	h := sha256.Sum256([]byte(strings.Join([]string{
		result.RequestID,
		result.ChannelID,
		result.ThreadTS,
		record.Kind,
		record.SourceRef,
		record.Text,
	}, "\n")))
	return filepath.ToSlash(filepath.Join("memory", "persona", "writes", day, kind+"-"+hex.EncodeToString(h[:])[:12]+".md"))
}

func personaMemoryWriteContradictionReviewPath(result SlackPersonaShadowResult, record persona.MemoryWrite) string {
	kind := sanitizePersonaMemoryPathComponent(firstNonEmpty(record.Kind, "memory"))
	day := timeNow().UTC().Format("2006-01-02")
	h := sha256.Sum256([]byte(strings.Join([]string{
		"contradiction_review",
		result.RequestID,
		result.ChannelID,
		result.ThreadTS,
		record.Kind,
		record.SourceRef,
		record.Text,
	}, "\n")))
	return filepath.ToSlash(filepath.Join("memory", "persona", "contradiction-review", day, kind+"-"+hex.EncodeToString(h[:])[:12]+".md"))
}

func renderPersonaMemoryWrite(result SlackPersonaShadowResult, record persona.MemoryWrite) (string, int) {
	return renderPersonaMemoryWriteWithReview(result, record, nil)
}

func renderPersonaMemoryWriteContradictionReview(result SlackPersonaShadowResult, record persona.MemoryWrite, review SlackMemoryScopeCanaryResult) (string, int) {
	return renderPersonaMemoryWriteWithReview(result, record, &review)
}

func renderPersonaMemoryWriteWithReview(result SlackPersonaShadowResult, record persona.MemoryWrite, review *SlackMemoryScopeCanaryResult) (string, int) {
	text, redactions := redactSlockWorkspaceSecrets(strings.TrimSpace(record.Text))
	metadata, err := json.MarshalIndent(record.Metadata, "", "  ")
	if err != nil || string(metadata) == "null" {
		metadata = nil
	}
	metadataText := ""
	if len(metadata) > 0 {
		var metadataRedactions int
		metadataText, metadataRedactions = redactSlockWorkspaceSecrets(string(metadata))
		redactions += metadataRedactions
	}
	var b strings.Builder
	if review != nil {
		fmt.Fprintf(&b, "# Persona memory contradiction review: %s\n\n", firstNonEmpty(record.Kind, "memory"))
	} else {
		fmt.Fprintf(&b, "# Persona memory write: %s\n\n", firstNonEmpty(record.Kind, "memory"))
	}
	legacySlackWriteBullet(&b, "Request", result.RequestID)
	legacySlackWriteBullet(&b, "Runtime", result.Runtime)
	legacySlackWriteBullet(&b, "Decision", result.Decision)
	legacySlackWriteBullet(&b, "Channel", result.ChannelID)
	legacySlackWriteBullet(&b, "Thread", result.ThreadTS)
	legacySlackWriteBullet(&b, "Source", record.SourceRef)
	legacySlackWriteBullet(&b, "Imported at", timeNow().UTC().Format(time.RFC3339Nano))
	if review != nil {
		legacySlackWriteBullet(&b, "Status", slackMemoryFactStatusContradictionReview)
		legacySlackWriteBullet(&b, "Review reason", review.Reason)
		if len(review.Evidence) > 0 {
			legacySlackWriteBullet(&b, "Review evidence", strings.Join(review.Evidence, ", "))
		}
	}
	b.WriteString("\n## Memory\n\n")
	b.WriteString(text)
	b.WriteString("\n")
	if strings.TrimSpace(metadataText) != "" {
		b.WriteString("\n## Metadata\n\n```json\n")
		b.WriteString(metadataText)
		b.WriteString("\n```\n")
	}
	return b.String(), redactions
}

func personaMemoryWriteContradictionQuery(record persona.MemoryWrite) string {
	var parts []string
	for _, value := range []string{
		record.Kind,
		record.Text,
		record.SourceRef,
		slackMemoryWriteMetadataString(record, "kind"),
		slackMemoryWriteMetadataString(record, "scope"),
		slackMemoryWriteMetadataString(record, "subject"),
		"foreground_identity oneesama identity",
	} {
		value = strings.TrimSpace(value)
		if value != "" {
			parts = append(parts, value)
		}
	}
	return strings.Join(parts, "\n")
}

func sanitizePersonaMemoryPathComponent(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "" {
		return "memory"
	}
	var b strings.Builder
	for _, r := range value {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
		default:
			b.WriteRune('-')
		}
	}
	out := strings.Trim(b.String(), "-")
	if out == "" {
		return "memory"
	}
	return out
}

func personaWorkerRequestSummaries(requests []persona.WorkerRequest) []string {
	out := make([]string, 0, len(requests))
	for _, request := range requests {
		summary := strings.TrimSpace(firstNonEmpty(request.Kind, request.Prompt))
		if summary == "" {
			continue
		}
		prompt := strings.TrimSpace(request.Prompt)
		if prompt != "" && prompt != summary {
			summary = summary + ": " + truncateSlackContextText(prompt, 160)
		}
		out = append(out, summary)
	}
	return out
}

func personaMemoryWriteSummaries(writes []persona.MemoryWrite) []string {
	out := make([]string, 0, len(writes))
	for _, write := range writes {
		text := strings.TrimSpace(write.Text)
		if text == "" {
			continue
		}
		kind := strings.TrimSpace(write.Kind)
		if kind != "" {
			text = kind + ": " + text
		}
		if source := strings.TrimSpace(write.SourceRef); source != "" {
			text = text + " [" + source + "]"
		}
		out = append(out, truncateSlackContextText(text, 220))
	}
	return out
}

func personaReactionSummaries(reactions []persona.ReactionIntent) []string {
	out := make([]string, 0, len(reactions))
	for _, reaction := range reactions {
		emoji := normalizeSlackReactionName(reaction.Emoji)
		if emoji == "" {
			continue
		}
		text := ":" + emoji + ":"
		if ts := strings.TrimSpace(reaction.MessageTS); ts != "" {
			text += " @" + ts
		}
		if reason := strings.TrimSpace(reaction.Reason); reason != "" {
			text += " — " + truncateSlackContextText(reason, 160)
		}
		out = append(out, text)
	}
	return out
}

func personaCitationsFromRelatedMemory(records []SlackRelatedMemoryRecord) []persona.Citation {
	out := make([]persona.Citation, 0, len(records))
	for _, record := range records {
		out = append(out, persona.Citation{
			Kind:      record.Kind,
			Source:    record.Source,
			SourceRef: firstNonEmpty(record.SourceRef, record.SourcePath),
			LineStart: record.StartLine,
			LineEnd:   record.EndLine,
			Snippet:   truncateSlackContextText(sanitizeSlackVisibleText(record.Content), 240),
		})
	}
	return out
}

func personaMemoryRecordsFromRelatedMemory(records []SlackRelatedMemoryRecord) []persona.MemoryRecord {
	out := make([]persona.MemoryRecord, 0, len(records))
	for _, record := range records {
		out = append(out, persona.MemoryRecord{
			Kind:      record.Kind,
			Text:      sanitizeSlackVisibleText(record.Content),
			SourceRef: firstNonEmpty(record.SourceRef, record.SourcePath),
			Score:     record.Score,
		})
	}
	return out
}

func personaCitationRefs(citations []persona.Citation) []string {
	out := make([]string, 0, len(citations))
	for _, citation := range citations {
		ref := firstNonEmpty(citation.SourceRef, citation.Source)
		if ref == "" {
			continue
		}
		if citation.LineStart > 0 {
			ref = fmt.Sprintf("%s:%d", ref, citation.LineStart)
			if citation.LineEnd > citation.LineStart {
				ref = fmt.Sprintf("%s-%d", ref, citation.LineEnd)
			}
		}
		out = append(out, ref)
	}
	return out
}
