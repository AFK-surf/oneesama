//go:build cueboardparity

package postmeeting

import (
	"strings"
	"testing"
)

func TestCueboardParityCleanResponseText(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		input string
		want  string
	}{
		{name: "think tags", input: "<think>some reasoning here</think>the actual content", want: "the actual content"},
		{name: "unclosed think tag", input: "before<think>reasoning without closing", want: "before"},
		{name: "json code fence", input: "```json\n{\"title\": \"test\"}\n```", want: `{"title": "test"}`},
		{name: "plain code fence", input: "```\nsome content\n```", want: "some content"},
		{name: "plain text", input: "这是一段普通的中文文本", want: "这是一段普通的中文文本"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := cleanResponseText(tt.input); got != tt.want {
				t.Fatalf("cleanResponseText(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestCueboardParityExtractJSONCandidate(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		input string
		want  string
	}{
		{name: "has braces", input: `Here is the summary: {"title": "test", "key_points": []} end`, want: `{"title": "test", "key_points": []}`},
		{name: "no braces", input: "这是一段纯中文的总结，没有任何JSON结构", want: "这是一段纯中文的总结，没有任何JSON结构"},
		{name: "nested braces", input: `prefix {"title": "test", "nested": {"a": 1}} suffix`, want: `{"title": "test", "nested": {"a": 1}}`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := extractJSONCandidate(tt.input); got != tt.want {
				t.Fatalf("extractJSONCandidate(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestCueboardParityTruncateRunes(t *testing.T) {
	t.Parallel()

	if got := truncateRunes("hello", 10); got != "hello" {
		t.Fatalf("short truncate = %q, want hello", got)
	}
	if got := truncateRunes("这是一段中文文本用于测试", 5); got != "这是一段中..." {
		t.Fatalf("Chinese truncate = %q", got)
	}
	if got := truncateRunes("12345", 5); got != "12345" {
		t.Fatalf("exact truncate = %q", got)
	}
}

func TestCueboardParityParseSummaryJSONValidAndWrapped(t *testing.T) {
	t.Parallel()

	for _, input := range []string{
		`{"title": "Test Meeting", "duration_minutes": 30, "key_points": ["point 1"], "attendees": [], "action_items": [], "decisions": [], "open_questions": [], "blockers": []}`,
		"```json\n{\"title\": \"Wrapped\", \"key_points\": [\"a\"], \"attendees\": [], \"action_items\": [], \"decisions\": [], \"open_questions\": [], \"blockers\": [], \"duration_minutes\": 15}\n```",
	} {
		cleaned := cleanResponseText(input)
		candidate := extractJSONCandidate(cleaned)
		var summary Summary
		if !parseSummaryJSON(candidate, &summary) {
			t.Fatalf("parseSummaryJSON(%q) failed", input)
		}
		if summary.Title == "" || len(summary.Highlights) == 0 {
			t.Fatalf("summary = %#v, want title and key points", summary)
		}
	}
}

func TestCueboardParityParseSummaryJSONRepairsUnescapedQuotesInsideString(t *testing.T) {
	t.Parallel()

	input := "```json\n{\n  \"title\": \"重构上线同步与云端功能规划会议\",\n  \"attendees\": [\"Heyang Zhou\"],\n  \"duration_minutes\": 120,\n  \"key_points\": [\n    \"会议后半段包含了一个关于\"基于双碳目标的居民消费模式转型研究\"的学术课题演示内容，非会议讨论部分\"\n  ],\n  \"action_items\": [],\n  \"decisions\": [],\n  \"open_questions\": [],\n  \"blockers\": []\n}\n```"
	var summary Summary
	if !parseSummaryJSON(extractJSONCandidate(cleanResponseText(input)), &summary) {
		t.Fatal("expected repaired parse to succeed")
	}
	if summary.Title != "重构上线同步与云端功能规划会议" {
		t.Fatalf("title = %q", summary.Title)
	}
	if len(summary.Highlights) != 1 || !strings.Contains(summary.Highlights[0], "基于双碳目标的居民消费模式转型研究") {
		t.Fatalf("highlights = %#v", summary.Highlights)
	}
}

func TestCueboardParityBuildFallbackSummaryFromSummaryText(t *testing.T) {
	t.Parallel()

	result := buildFallbackSummary(PostProcessInput{
		Title:       "Original",
		SummaryText: `{"title":"Parsed","key_points":["point"],"attendees":["Alice"],"action_items":[{"description":"ship notes","owner":"Alice"}],"decisions":["go"]}`,
	}, nil, nil)
	if result.Title != "Parsed" {
		t.Fatalf("title = %q, want Parsed", result.Title)
	}
	if len(result.Highlights) != 1 || result.Highlights[0] != "point" {
		t.Fatalf("highlights = %#v", result.Highlights)
	}
	if len(result.ActionItems) != 1 || !strings.Contains(result.ActionItems[0], "ship notes") || !strings.Contains(result.ActionItems[0], "owner: Alice") {
		t.Fatalf("action items = %#v", result.ActionItems)
	}
}
