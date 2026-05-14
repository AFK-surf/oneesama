//go:build cueboardparity

package slackagent

import "testing"

func TestMarkdownToMrkdwn_LinkifiesOnlyConfiguredLinearPrefixes(t *testing.T) {
	prevSlug := linearWorkspaceSlug
	prevPrefixes := linearIssuePrefixes
	SetLinearWorkspaceSlug("cue")
	t.Cleanup(func() {
		linearWorkspaceSlug = prevSlug
		linearIssuePrefixes = prevPrefixes
	})

	got := markdownToMrkdwn("Compare CUE-123 with GPT-4 and ABC-9.")
	want := "Compare <https://linear.app/cue/issue/CUE-123|CUE-123> with GPT-4 and ABC-9."
	if got != want {
		t.Fatalf("markdownToMrkdwn() = %q, want %q", got, want)
	}
}

func TestMarkdownToMrkdwn(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{
			name: "bold conversion",
			in:   "this is **bold** text",
			want: "this is *bold* text",
		},
		{
			name: "italic conversion",
			in:   "this is *italic* text",
			want: "this is _italic_ text",
		},
		{
			name: "bold and italic",
			in:   "**bold** and *italic* together",
			want: "*bold* and _italic_ together",
		},
		{
			name: "bold+italic combined",
			in:   "this is ***bold italic*** text",
			want: "this is *_bold italic_* text",
		},
		{
			name: "link conversion",
			in:   "check [Google](https://google.com) out",
			want: "check <https://google.com|Google> out",
		},
		{
			name: "header conversion",
			in:   "## Summary\nsome text",
			want: "*Summary*\nsome text",
		},
		{
			name: "h1 conversion",
			in:   "# Title",
			want: "*Title*",
		},
		{
			name: "strikethrough conversion",
			in:   "this is ~~deleted~~ text",
			want: "this is ~deleted~ text",
		},
		{
			name: "horizontal rule",
			in:   "above\n---\nbelow",
			want: "above\n———\nbelow",
		},
		{
			name: "unordered list with dash",
			in:   "items:\n- first\n- second\n- third",
			want: "items:\n• first\n• second\n• third",
		},
		{
			name: "unordered list with asterisk",
			in:   "items:\n* first\n* second",
			want: "items:\n• first\n• second",
		},
		{
			name: "indented list",
			in:   "  - nested item\n    - deeper",
			want: "  • nested item\n    • deeper",
		},
		{
			name: "combined conversions",
			in:   "## Key Points\n- **Action item**: [link](https://example.com)\n- ~~done~~",
			want: "*Key Points*\n• *Action item*: <https://example.com|link>\n• ~done~",
		},
		{
			name: "ordered list to bullets",
			in:   "steps:\n1. first\n2. second",
			want: "steps:\n• first\n• second",
		},
		{
			name: "code block preserved",
			in:   "before\n```go\nfunc **main**() {}\n```\nafter **bold**",
			want: "before\n```go\nfunc **main**() {}\n```\nafter *bold*",
		},
		{
			name: "inline code preserved",
			in:   "use `**bold**` for bold and **real bold**",
			want: "use `**bold**` for bold and *real bold*",
		},
		{
			name: "inline registry path is protected from slack autolink",
			in:   "Unbox 是一个独立的服务（`ghcr.io/afk-surf/unbox`）。",
			want: "Unbox 是一个独立的服务（`ghcr.io/\u200Bafk-surf/unbox`）。",
		},
		{
			name: "inline registry path with tag is protected from slack autolink",
			in:   "Docker 镜像: `ghcr.io/afk-surf/unbox:<tag>`",
			want: "Docker 镜像: `ghcr.io/\u200Bafk-surf/unbox:<tag>`",
		},
		{
			name: "inline https url is protected from slack autolink",
			in:   "仓库地址：`https://github.com/AFK-surf/unbox`",
			want: "仓库地址：`https://\u200Bgithub.com/AFK-surf/unbox`",
		},
		{
			name: "empty string",
			in:   "",
			want: "",
		},
		{
			name: "no markdown",
			in:   "plain text with no formatting",
			want: "plain text with no formatting",
		},
		{
			name: "slack native italic preserved",
			in:   "_already italic_ and `code`",
			want: "_already italic_ and `code`",
		},
		{
			// Single *text* is treated as Markdown italic → _text_.
			// This is correct because the LLM is instructed to use Markdown,
			// so *text* means italic, not Slack bold. Slack bold should come
			// from **text** → *text* conversion.
			name: "single asterisk becomes italic",
			in:   "this is *important* info",
			want: "this is _important_ info",
		},
		{
			name: "table to bullet list",
			in:   "| Name | Status |\n| --- | --- |\n| Alice | Done |\n| Bob | Pending |",
			want: "• *Name*: Alice  ·  *Status*: Done\n• *Name*: Bob  ·  *Status*: Pending",
		},
		{
			name: "blockquote passthrough",
			in:   "> this is a quote\nnormal text",
			want: "> this is a quote\nnormal text",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := markdownToMrkdwn(tt.in)
			if got != tt.want {
				t.Errorf("markdownToMrkdwn(%q) =\n  %q\nwant:\n  %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestMarkdownishToMrkdwn(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{
			name: "preserves existing slack bold while converting markdown links",
			in:   ":calendar: Upcoming meeting: *Weekly Sync*\n[Open doc](https://example.com/doc)",
			want: ":calendar: Upcoming meeting: *Weekly Sync*\n<https://example.com/doc|Open doc>",
		},
		{
			name: "converts markdown bold and ordered list in ad hoc messages",
			in:   "<@U123> **Please check** this:\n1. [Spec](https://example.com/spec)\n2. ~~Old note~~",
			want: "<@U123> *Please check* this:\n• <https://example.com/spec|Spec>\n• ~Old note~",
		},
		{
			name: "preserves inline code and existing mrkdwn links",
			in:   "Use `rg \"foo\"` and see <https://example.com|existing link>.",
			want: "Use `rg \"foo\"` and see <https://example.com|existing link>.",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := markdownishToMrkdwn(tt.in)
			if got != tt.want {
				t.Errorf("markdownishToMrkdwn(%q) =\n  %q\nwant:\n  %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestMarkdownToSlackFallbackText(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{
			name: "converts markdown links and emphasis for fallback previews",
			in:   "See **status** in [Linear](https://linear.app).",
			want: "See *status* in <https://linear.app|Linear>.",
		},
		{
			name: "preserves code fences and inline code",
			in:   "Files:\n\n```text\nAGENTS.md\nMEMORY.md\n```\n\nUse `ls` first.",
			want: "Files:\n\n```text\nAGENTS.md\nMEMORY.md\n```\n\nUse `ls` first.",
		},
		{
			name: "falls back to original text when conversion becomes empty",
			in:   "   ",
			want: "   ",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := markdownToSlackFallbackText(tt.in)
			if got != tt.want {
				t.Errorf("markdownToSlackFallbackText(%q) =\n  %q\nwant:\n  %q", tt.in, got, tt.want)
			}
		})
	}
}
