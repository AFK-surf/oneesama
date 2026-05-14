//go:build cueboardparity

package slackagent

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestCueboardParityMarkdownToBlocks(t *testing.T) {
	tests := []struct {
		name     string
		markdown string
	}{
		{
			name: "usage dashboard",
			markdown: `# Usage Dashboard

## Credits
**Available**: 89.9M
**Plan**: unlimited

---

## Daily Breakdown
- **2026-03-17**: 1.2M tokens
- **2026-03-16**: 3.4M tokens
- **2026-03-15**: 2.1M tokens

---

## Notes
Everything is running smoothly. No action items.`,
		},
		{
			name: "simple report",
			markdown: `# Project Status

Core features are done. Two blockers remaining:

1. Auth token refresh fails silently
2. Meeting bot leaves early on short meetings

Next steps:
- Fix auth flow
- Add 5-min minimum meeting duration`,
		},
		{name: "plain text", markdown: "Just a simple message with no headers."},
		{
			name: "schedule list",
			markdown: `# Scheduled Tasks

## Check bot token usage
- **Schedule**: every 2 hours
- **Timezone**: Asia/Shanghai
- **Next run**: 2026-03-17 14:00 CST
- **Thread**: https://slack.com/archives/C0AK914ULBE/p1773663177605519

## Daily standup reminder
- **Schedule**: weekdays at 9:00 AM
- **Timezone**: Asia/Shanghai
- **Next run**: 2026-03-18 09:00 CST`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			blocks := markdownToBlocks(tt.markdown)
			if len(blocks) == 0 {
				t.Fatal("expected blocks, got none")
			}
			if strings.Contains(tt.markdown, "## ") {
				headerCount := 0
				for _, block := range blocks {
					if block["type"] == "header" {
						headerCount++
					}
				}
				if headerCount < 2 {
					t.Fatalf("expected nested headings to produce multiple header blocks, got %d", headerCount)
				}
			}

			data, _ := json.MarshalIndent(blocks, "", "  ")
			t.Logf("%s (%d blocks): %s", tt.name, len(blocks), string(data))
		})
	}
}
