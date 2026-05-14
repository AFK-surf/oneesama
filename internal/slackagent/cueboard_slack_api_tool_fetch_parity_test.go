//go:build cueboardparity

package slackagent

import "testing"

func TestCueboardParityNormalizedFetchThreadParamsPrefersThreadTSAcceptsTSAlias(t *testing.T) {
	t.Parallel()

	channel, threadTS := normalizedFetchThreadParams(map[string]any{
		"channel":   "C123",
		"thread_ts": "111.222",
		"ts":        "333.444",
	})
	if channel != "C123" {
		t.Fatalf("channel = %q, want %q", channel, "C123")
	}
	if threadTS != "111.222" {
		t.Fatalf("threadTS = %q, want %q", threadTS, "111.222")
	}

	channel, threadTS = normalizedFetchThreadParams(map[string]any{
		"channel": "C999",
		"ts":      "555.666",
	})
	if channel != "C999" {
		t.Fatalf("channel = %q, want %q", channel, "C999")
	}
	if threadTS != "555.666" {
		t.Fatalf("threadTS = %q, want %q", threadTS, "555.666")
	}
}
