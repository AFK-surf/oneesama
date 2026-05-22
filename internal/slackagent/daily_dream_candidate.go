package slackagent

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"strings"
)

const (
	slackDreamCandidateReviewPending  = "pending"
	slackDreamCandidateProposalIgnore = "ignore"
)

type SlackDreamSignal struct {
	Source         string   `json:"source"`
	Surface        string   `json:"surface,omitempty"`
	Verdict        string   `json:"verdict,omitempty"`
	Refs           []string `json:"refs,omitempty"`
	ReasonCode     string   `json:"reason_code,omitempty"`
	ProposedAction string   `json:"proposed_action,omitempty"`
	Subject        string   `json:"subject,omitempty"`
	SourceType     string   `json:"source_type,omitempty"`
	Content        string   `json:"content,omitempty"`
	Timestamp      string   `json:"timestamp,omitempty"`
}

type SlackDreamCandidate struct {
	ID               string             `json:"id"`
	Date             string             `json:"date"`
	ClusterKey       string             `json:"cluster_key"`
	InputRefs        []string           `json:"input_refs"`
	ProposalType     string             `json:"proposal_type"`
	Proposal         string             `json:"proposal"`
	Confidence       float64            `json:"confidence"`
	RequiredCanaries []string           `json:"required_canaries,omitempty"`
	ReviewStatus     string             `json:"review_status"`
	ReviewNotes      string             `json:"review_notes,omitempty"`
	Signals          []SlackDreamSignal `json:"signals,omitempty"`
}

type SlackDreamCandidateOptions struct {
	Date                          string
	MinSignalsForNormalConfidence int
}

func BuildSlackDreamCandidates(signals []SlackDreamSignal, options SlackDreamCandidateOptions) []SlackDreamCandidate {
	date := strings.TrimSpace(options.Date)
	if date == "" {
		date = timeNow().In(shanghaiLocation()).Format("2006-01-02")
	}
	minSignals := options.MinSignalsForNormalConfidence
	if minSignals <= 0 {
		minSignals = 2
	}
	clusters := map[string][]SlackDreamSignal{}
	for _, signal := range signals {
		normalized := normalizeSlackDreamSignal(signal)
		if normalized.ProposedAction == slackDreamCandidateProposalIgnore {
			continue
		}
		key := slackDreamSignalClusterKey(normalized)
		clusters[key] = append(clusters[key], normalized)
	}
	keys := make([]string, 0, len(clusters))
	for key := range clusters {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	candidates := make([]SlackDreamCandidate, 0, len(keys))
	for _, key := range keys {
		clusterSignals := clusters[key]
		sort.SliceStable(clusterSignals, func(i, j int) bool {
			return slackDreamSignalSortKey(clusterSignals[i]) < slackDreamSignalSortKey(clusterSignals[j])
		})
		inputRefs := slackDreamCandidateInputRefs(clusterSignals)
		proposalType := firstNonEmpty(clusterSignals[0].ProposedAction, "memory_candidate")
		confidence := 0.35
		reviewNotes := "single_signal_low_confidence"
		if len(clusterSignals) >= minSignals {
			confidence = slackDreamMinFloat(0.9, 0.55+0.1*float64(len(clusterSignals)-minSignals))
			reviewNotes = "repeated_pattern"
		}
		candidates = append(candidates, SlackDreamCandidate{
			ID:               slackDreamCandidateID(date, key, inputRefs),
			Date:             date,
			ClusterKey:       key,
			InputRefs:        inputRefs,
			ProposalType:     proposalType,
			Proposal:         slackDreamCandidateProposal(clusterSignals),
			Confidence:       confidence,
			RequiredCanaries: slackDreamCandidateRequiredCanaries(proposalType),
			ReviewStatus:     slackDreamCandidateReviewPending,
			ReviewNotes:      reviewNotes,
			Signals:          clusterSignals,
		})
	}
	return candidates
}

func RenderSlackDreamCandidatesMarkdown(candidates []SlackDreamCandidate) string {
	var b strings.Builder
	b.WriteString("# Oneesama Daily Dream Candidates\n\n")
	if len(candidates) == 0 {
		b.WriteString("No candidates.\n")
		return b.String()
	}
	for _, candidate := range candidates {
		fmt.Fprintf(&b, "## %s\n\n", candidate.ID)
		legacySlackWriteBullet(&b, "Date", candidate.Date)
		legacySlackWriteBullet(&b, "Cluster", candidate.ClusterKey)
		legacySlackWriteBullet(&b, "Proposal type", candidate.ProposalType)
		legacySlackWriteBullet(&b, "Confidence", fmt.Sprintf("%.2f", candidate.Confidence))
		legacySlackWriteBullet(&b, "Review status", candidate.ReviewStatus)
		legacySlackWriteBullet(&b, "Review notes", candidate.ReviewNotes)
		if len(candidate.RequiredCanaries) > 0 {
			legacySlackWriteBullet(&b, "Required canaries", strings.Join(candidate.RequiredCanaries, ", "))
		}
		b.WriteString("\n### Proposal\n\n")
		b.WriteString(candidate.Proposal)
		b.WriteString("\n\n### Input refs\n\n")
		if len(candidate.InputRefs) == 0 {
			b.WriteString("- -\n")
		} else {
			for _, ref := range candidate.InputRefs {
				fmt.Fprintf(&b, "- %s\n", ref)
			}
		}
		b.WriteString("\n### Signals\n\n")
		for _, signal := range candidate.Signals {
			fmt.Fprintf(&b, "- `%s` `%s` `%s`: %s\n",
				firstNonEmpty(signal.Source, "-"),
				firstNonEmpty(signal.ReasonCode, "-"),
				firstNonEmpty(signal.Verdict, "-"),
				firstNonEmpty(signal.Content, "-"),
			)
		}
		b.WriteString("\n")
	}
	return b.String()
}

func ReadSlackDreamSignalsNDJSON(reader io.Reader) ([]SlackDreamSignal, error) {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	var signals []SlackDreamSignal
	lineNo := 0
	for scanner.Scan() {
		lineNo++
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		var signal SlackDreamSignal
		if err := json.Unmarshal([]byte(line), &signal); err != nil {
			return nil, fmt.Errorf("line %d: %w", lineNo, err)
		}
		signals = append(signals, signal)
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return signals, nil
}

func normalizeSlackDreamSignal(signal SlackDreamSignal) SlackDreamSignal {
	signal.Source = strings.TrimSpace(signal.Source)
	signal.Surface = strings.TrimSpace(signal.Surface)
	signal.Verdict = strings.TrimSpace(signal.Verdict)
	signal.ReasonCode = strings.TrimSpace(signal.ReasonCode)
	signal.ProposedAction = strings.TrimSpace(signal.ProposedAction)
	signal.Subject = strings.TrimSpace(signal.Subject)
	signal.SourceType = strings.TrimSpace(signal.SourceType)
	signal.Content = truncateSlackContextText(strings.TrimSpace(signal.Content), 500)
	signal.Timestamp = strings.TrimSpace(signal.Timestamp)
	signal.Refs = compactUniqueStrings(signal.Refs)
	if signal.ProposedAction == "" {
		signal.ProposedAction = "memory_candidate"
	}
	if signal.SourceType == "" {
		signal.SourceType = signal.Source
	}
	if signal.Subject == "" {
		signal.Subject = "unknown"
	}
	if signal.ReasonCode == "" {
		signal.ReasonCode = "unspecified"
	}
	return signal
}

func slackDreamSignalClusterKey(signal SlackDreamSignal) string {
	return strings.Join([]string{
		strings.ToLower(signal.Subject),
		strings.ToLower(signal.ReasonCode),
		strings.ToLower(signal.SourceType),
		strings.ToLower(signal.ProposedAction),
	}, "|")
}

func slackDreamSignalSortKey(signal SlackDreamSignal) string {
	return strings.Join([]string{signal.Timestamp, signal.Source, strings.Join(signal.Refs, ","), signal.Content}, "|")
}

func slackDreamCandidateInputRefs(signals []SlackDreamSignal) []string {
	var refs []string
	for _, signal := range signals {
		for _, ref := range signal.Refs {
			if ref == "" || slackMemoryFactContainsString(refs, ref) {
				continue
			}
			refs = append(refs, ref)
		}
		if len(signal.Refs) == 0 && signal.Source != "" && !slackMemoryFactContainsString(refs, signal.Source) {
			refs = append(refs, signal.Source)
		}
	}
	sort.Strings(refs)
	return refs
}

func slackDreamCandidateProposal(signals []SlackDreamSignal) string {
	first := signals[0]
	return strings.TrimSpace(fmt.Sprintf(
		"Review %d `%s` signal(s) for subject `%s` from `%s`: %s",
		len(signals),
		first.ReasonCode,
		first.Subject,
		first.SourceType,
		firstNonEmpty(first.Content, "no content"),
	))
}

func slackDreamCandidateRequiredCanaries(proposalType string) []string {
	switch proposalType {
	case "contradiction_review":
		return []string{slackMemoryScopeCanaryContradictionCase}
	case "memory_candidate":
		return []string{slackMemoryScopeCanaryIdentityCase}
	case "gate_fixture", "benchmark_case":
		return []string{"visible_reply_allow_list_canary"}
	case "prompt_candidate", "policy_candidate":
		return []string{"stable_prompt_hash_canary"}
	default:
		return nil
	}
}

func slackDreamCandidateID(date string, clusterKey string, refs []string) string {
	sum := sha256.Sum256([]byte(strings.Join([]string{date, clusterKey, strings.Join(refs, "\n")}, "\n")))
	return "dream-" + date + "-" + hex.EncodeToString(sum[:])[:12]
}

func slackDreamMinFloat(a float64, b float64) float64 {
	if a < b {
		return a
	}
	return b
}
