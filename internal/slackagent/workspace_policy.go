package slackagent

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
	"unicode/utf8"
)

const slackWorkspacePolicySourceConfig = "config.slack.triage.workspace_policy"

func buildSlackWorkspacePolicyStatus(policy string) SlackWorkspacePolicyStatus {
	policy = strings.TrimSpace(policy)
	if policy == "" {
		return SlackWorkspacePolicyStatus{
			Configured: false,
			Source:     "unset",
		}
	}
	sum := sha256.Sum256([]byte(policy))
	hash := hex.EncodeToString(sum[:])
	return SlackWorkspacePolicyStatus{
		Configured:  true,
		Source:      slackWorkspacePolicySourceConfig,
		Version:     "sha256:" + hash[:12],
		Hash:        hash,
		LengthChars: utf8.RuneCountInString(policy),
	}
}

func normalizeSlackWorkspacePolicyStatus(policy string, status SlackWorkspacePolicyStatus) SlackWorkspacePolicyStatus {
	computed := buildSlackWorkspacePolicyStatus(policy)
	if !computed.Configured {
		return computed
	}
	if !status.Configured {
		return computed
	}
	if strings.TrimSpace(status.Source) == "" || status.Source == "unset" {
		status.Source = computed.Source
	}
	if strings.TrimSpace(status.Version) == "" {
		status.Version = computed.Version
	}
	if strings.TrimSpace(status.Hash) == "" {
		status.Hash = computed.Hash
	}
	if status.LengthChars <= 0 {
		status.LengthChars = computed.LengthChars
	}
	return status
}

func (s *Service) slackWorkspacePolicyStatus() SlackWorkspacePolicyStatus {
	if s == nil {
		return buildSlackWorkspacePolicyStatus("")
	}
	return buildSlackWorkspacePolicyStatus(s.triageWorkspacePolicy)
}

func slackWorkspacePolicyMetadataText(status SlackWorkspacePolicyStatus) string {
	if !status.Configured {
		return ""
	}
	parts := []string{
		"source=" + strings.TrimSpace(status.Source),
		"version=" + strings.TrimSpace(status.Version),
	}
	if hash := strings.TrimSpace(status.Hash); hash != "" {
		parts = append(parts, "hash="+hash)
	}
	if status.LengthChars > 0 {
		parts = append(parts, fmt.Sprintf("length_chars=%d", status.LengthChars))
	}
	return strings.Join(parts, " ")
}

func slackWorkspacePolicyMetadataMap(status SlackWorkspacePolicyStatus) map[string]any {
	return map[string]any{
		"workspace_policy_configured":   status.Configured,
		"workspace_policy_source":       status.Source,
		"workspace_policy_version":      status.Version,
		"workspace_policy_hash":         status.Hash,
		"workspace_policy_length_chars": status.LengthChars,
	}
}
