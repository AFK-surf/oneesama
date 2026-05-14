//go:build cueboardparity

package slackagent

import (
	"strings"
	"testing"
)

func TestCueboardParityBuildHeartbeatSurfaceMessageUsesCompactContextBlocks(t *testing.T) {
	t.Parallel()

	message := buildHeartbeatSurfaceMessage(
		"已继续跟进 CUE-1309",
		"我已在 CUE-1309 线程里补发具体剩余检查项，明确要求 Codex 补齐说明和验证缺口后再收尾。",
	)

	if !strings.Contains(message.FallbackText, ":heartbeat: *已继续跟进 CUE-1309*") {
		t.Fatalf("fallback text missing title: %q", message.FallbackText)
	}
	if !strings.Contains(message.FallbackText, "补发具体剩余检查项") {
		t.Fatalf("fallback text missing summary: %q", message.FallbackText)
	}
	if message.LedgerText != message.FallbackText {
		t.Fatalf("ledger text = %q, want fallback text %q", message.LedgerText, message.FallbackText)
	}
	if len(message.Blocks) != 2 {
		t.Fatalf("len(blocks) = %d, want 2", len(message.Blocks))
	}
	if got := heartbeatContextBlockText(message.Blocks[0]); !strings.Contains(got, ":heartbeat: *已继续跟进 CUE-1309*") {
		t.Fatalf("title block text = %q", got)
	}
	if got := heartbeatContextBlockText(message.Blocks[1]); !strings.Contains(got, "补发具体剩余检查项") {
		t.Fatalf("summary block text = %q", got)
	}
}

func TestCueboardParityBuildHeartbeatSurfaceMessageSplitsLongSummaryIntoMultipleContextBlocks(t *testing.T) {
	t.Parallel()

	longSummary := strings.Repeat("还差验证项。", 500)
	message := buildHeartbeatSurfaceMessage("继续跟进", longSummary)

	if len(message.Blocks) < 3 {
		t.Fatalf("len(blocks) = %d, want at least 3", len(message.Blocks))
	}
	for i, block := range message.Blocks {
		if block["type"] != "context" {
			t.Fatalf("block %d type = %#v, want context", i, block["type"])
		}
	}
}

func TestCueboardParityNormalizeSupervisoryHeartbeatNotificationSuppressesDoneSignalClosure(t *testing.T) {
	t.Parallel()

	followup := &SlackHeartbeatFollowup{
		Kind:      "commitment",
		Status:    "done",
		ChannelID: "C123",
		ThreadTS:  "123.456",
		Metadata: map[string]any{
			"issue_identifier": "CUE-1309",
			"assignee_name":    "codex-3720",
		},
	}

	title, summary, suppress := normalizeSupervisoryHeartbeatNotification(
		"CUE-1309 监督已闭环",
		"Codex 已在 CUE-1309 线程给出明确 done signal，并补齐了 PR #1175 的说明/验证缺口。",
		followup,
	)
	if !suppress {
		t.Fatalf("expected done-signal closure to be suppressed, got title=%q summary=%q", title, summary)
	}
}

func TestCueboardParityNormalizeSupervisoryHeartbeatNotificationRewritesClosureTone(t *testing.T) {
	t.Parallel()

	followup := &SlackHeartbeatFollowup{
		Kind:      "commitment",
		Status:    "done",
		ChannelID: "C123",
		ThreadTS:  "123.456",
		Metadata: map[string]any{
			"issue_identifier": "CUE-1309",
			"assignee_name":    "codex-3720",
		},
	}

	title, summary, suppress := normalizeSupervisoryHeartbeatNotification(
		"CUE-1309 监督已闭环",
		"我已独立复查并确认 PR #1175 的说明和验证缺口已补齐。",
		followup,
	)
	if suppress {
		t.Fatal("expected verified completion to stay visible")
	}
	if title != "已复查 CUE-1309" {
		t.Fatalf("title = %q, want %q", title, "已复查 CUE-1309")
	}
	if !strings.Contains(summary, "独立复查") {
		t.Fatalf("summary = %q, want independent verification wording", summary)
	}
}

func heartbeatContextBlockText(block map[string]any) string {
	elements, _ := block["elements"].([]map[string]any)
	if len(elements) == 0 {
		return ""
	}
	return stringFromAny(elements[0]["text"])
}
