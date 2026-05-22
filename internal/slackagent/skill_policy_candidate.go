package slackagent

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"
)

const slackSkillPolicyCandidateReviewPending = "pending"

type SlackSkillPolicyCandidate struct {
	ID               string             `json:"id"`
	Date             string             `json:"date"`
	ClusterKey       string             `json:"cluster_key"`
	SourceSignalRefs []string           `json:"source_signal_refs,omitempty"`
	Target           string             `json:"target"`
	Proposal         string             `json:"proposal"`
	WhyReusable      string             `json:"why_reusable"`
	DoNotCapture     string             `json:"do_not_capture,omitempty"`
	Confidence       float64            `json:"confidence"`
	RequiredCanaries []string           `json:"required_canaries,omitempty"`
	ReviewStatus     string             `json:"review_status"`
	Signals          []SlackDreamSignal `json:"signals,omitempty"`
}

type SlackSkillPolicyCandidateOptions struct {
	Date                          string
	MinSignalsForNormalConfidence int
}

func BuildSlackSkillPolicyCandidates(signals []SlackDreamSignal, options SlackSkillPolicyCandidateOptions) []SlackSkillPolicyCandidate {
	date := strings.TrimSpace(options.Date)
	if date == "" {
		date = timeNow().In(shanghaiLocation()).Format("2006-01-02")
	}
	minSignals := options.MinSignalsForNormalConfidence
	if minSignals <= 0 {
		minSignals = 2
	}
	clusters := map[string][]SlackDreamSignal{}
	targets := map[string]string{}
	for _, signal := range signals {
		normalized := normalizeSlackDreamSignal(signal)
		target := slackSkillPolicySignalTarget(normalized)
		if target == "" {
			continue
		}
		normalized.Target = target
		key := slackSkillPolicySignalClusterKey(normalized)
		clusters[key] = append(clusters[key], normalized)
		targets[key] = target
	}
	keys := make([]string, 0, len(clusters))
	for key := range clusters {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	candidates := make([]SlackSkillPolicyCandidate, 0, len(keys))
	for _, key := range keys {
		clusterSignals := clusters[key]
		sort.SliceStable(clusterSignals, func(i, j int) bool {
			return slackDreamSignalSortKey(clusterSignals[i]) < slackDreamSignalSortKey(clusterSignals[j])
		})
		sourceRefs := slackDreamCandidateInputRefs(clusterSignals)
		doNotCapture := slackSkillPolicyDoNotCaptureReason(clusterSignals)
		confidence := 0.35
		if len(clusterSignals) >= minSignals && doNotCapture == "" {
			confidence = slackDreamMinFloat(0.9, 0.55+0.1*float64(len(clusterSignals)-minSignals))
		}
		candidates = append(candidates, SlackSkillPolicyCandidate{
			ID:               slackSkillPolicyCandidateID(date, key, sourceRefs),
			Date:             date,
			ClusterKey:       key,
			SourceSignalRefs: sourceRefs,
			Target:           targets[key],
			Proposal:         slackSkillPolicyCandidateProposal(clusterSignals),
			WhyReusable:      slackSkillPolicyWhyReusable(clusterSignals),
			DoNotCapture:     doNotCapture,
			Confidence:       confidence,
			RequiredCanaries: slackSkillPolicyRequiredCanaries(targets[key]),
			ReviewStatus:     slackSkillPolicyCandidateReviewPending,
			Signals:          clusterSignals,
		})
	}
	return candidates
}

func RenderSlackSkillPolicyCandidatesMarkdown(candidates []SlackSkillPolicyCandidate) string {
	var b strings.Builder
	b.WriteString("# Oneesama Skill/Policy Candidates\n\n")
	if len(candidates) == 0 {
		b.WriteString("No skill/policy candidates.\n")
		return b.String()
	}
	for _, candidate := range candidates {
		fmt.Fprintf(&b, "## %s\n\n", candidate.ID)
		legacySlackWriteBullet(&b, "Date", candidate.Date)
		legacySlackWriteBullet(&b, "Cluster", candidate.ClusterKey)
		legacySlackWriteBullet(&b, "Target", candidate.Target)
		legacySlackWriteBullet(&b, "Confidence", fmt.Sprintf("%.2f", candidate.Confidence))
		legacySlackWriteBullet(&b, "Review status", candidate.ReviewStatus)
		legacySlackWriteBullet(&b, "Why reusable", candidate.WhyReusable)
		if candidate.DoNotCapture != "" {
			legacySlackWriteBullet(&b, "Do not capture", candidate.DoNotCapture)
		}
		if len(candidate.RequiredCanaries) > 0 {
			legacySlackWriteBullet(&b, "Required canaries", strings.Join(candidate.RequiredCanaries, ", "))
		}
		b.WriteString("\n### Proposal\n\n")
		b.WriteString(candidate.Proposal)
		b.WriteString("\n\n### Source signal refs\n\n")
		if len(candidate.SourceSignalRefs) == 0 {
			b.WriteString("- -\n")
		} else {
			for _, ref := range candidate.SourceSignalRefs {
				fmt.Fprintf(&b, "- %s\n", ref)
			}
		}
		b.WriteString("\n")
	}
	return b.String()
}

func RenderSlackDailyDreamMarkdown(memoryCandidates []SlackDreamCandidate, skillPolicyCandidates []SlackSkillPolicyCandidate) string {
	memory := strings.TrimRight(RenderSlackDreamCandidatesMarkdown(memoryCandidates), "\n")
	skillPolicy := strings.TrimRight(RenderSlackSkillPolicyCandidatesMarkdown(skillPolicyCandidates), "\n")
	return memory + "\n\n" + skillPolicy + "\n"
}

func slackSkillPolicySignalTarget(signal SlackDreamSignal) string {
	if strings.TrimSpace(signal.Target) != "" {
		return strings.TrimSpace(signal.Target)
	}
	action := strings.ToLower(strings.TrimSpace(signal.ProposedAction))
	text := strings.ToLower(strings.Join([]string{signal.Subject, signal.ReasonCode, signal.SourceType, signal.Content}, " "))
	switch action {
	case "prompt_candidate", "policy_candidate":
		if strings.Contains(text, "triage_sweep") || strings.Contains(text, "bucket") || strings.Contains(text, "sweep") {
			return "triage_sweep_bucket"
		}
		return "prompt_policy"
	case "gate_fixture":
		if strings.Contains(text, "visible") || strings.Contains(text, "reply") || strings.Contains(text, "anchor") || strings.Contains(text, "internal_meta") {
			return "visible_reply_gate"
		}
		return "canary_fixture"
	case "benchmark_case":
		return "benchmark_case"
	case "skill_candidate", "runbook_candidate", "playbook_candidate":
		return "runbook"
	default:
		return ""
	}
}

func slackSkillPolicySignalClusterKey(signal SlackDreamSignal) string {
	return strings.Join([]string{
		strings.ToLower(signal.Target),
		strings.ToLower(signal.Subject),
		strings.ToLower(signal.ReasonCode),
		strings.ToLower(signal.ProposedAction),
	}, "|")
}

func slackSkillPolicyDoNotCaptureReason(signals []SlackDreamSignal) string {
	text := strings.ToLower(slackSkillPolicyJoinedText(signals))
	transientMarkers := []string{
		"transient", "network", "ssl", "timeout", "rate limit", "fresh_pending", "stale pending",
		"socket mode", "env-only", "environment", "local machine", "一次性", "环境", "临时",
	}
	for _, marker := range transientMarkers {
		if strings.Contains(text, marker) {
			return "environment_or_transient_failure"
		}
	}
	return ""
}

func slackSkillPolicyWhyReusable(signals []SlackDreamSignal) string {
	if len(signals) >= 2 {
		return fmt.Sprintf("repeated_pattern_across_%d_signals", len(signals))
	}
	return "single_signal_review_required"
}

func slackSkillPolicyCandidateProposal(signals []SlackDreamSignal) string {
	first := signals[0]
	return strings.TrimSpace(fmt.Sprintf(
		"Review %d `%s` signal(s) for `%s` target `%s`: %s",
		len(signals),
		first.ReasonCode,
		first.Subject,
		first.Target,
		firstNonEmpty(first.Content, "no content"),
	))
}

func slackSkillPolicyRequiredCanaries(target string) []string {
	switch strings.TrimSpace(target) {
	case "visible_reply_gate":
		return []string{"visible_reply_allow_list_canary"}
	case "prompt_policy":
		return []string{"stable_prompt_hash_canary"}
	case "triage_sweep_bucket":
		return []string{"triage_quality_sweep_canary"}
	case "canary_fixture":
		return []string{"focused_canary_fixture"}
	case "benchmark_case":
		return []string{"triage_replay_benchmark"}
	case "runbook":
		return []string{"operator_runbook_review"}
	default:
		return nil
	}
}

func slackSkillPolicyCandidateID(date string, clusterKey string, refs []string) string {
	sum := sha256.Sum256([]byte(strings.Join([]string{date, clusterKey, strings.Join(refs, "\n")}, "\n")))
	return "skill-policy-" + date + "-" + hex.EncodeToString(sum[:])[:12]
}

func slackSkillPolicyJoinedText(signals []SlackDreamSignal) string {
	var parts []string
	for _, signal := range signals {
		parts = append(parts, signal.Subject, signal.ReasonCode, signal.SourceType, signal.Content)
	}
	return strings.Join(parts, " ")
}
