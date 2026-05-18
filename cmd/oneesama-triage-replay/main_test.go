package main

import (
	"bytes"
	"strings"
	"testing"
)

// TestRunOnFlatNDJSONProducesCandidates covers the happy path: a small
// channel of messages with one stuck-help ping and one open question,
// piped in over stdin, should produce a Markdown report with both
// classifications.
func TestRunOnFlatNDJSONProducesCandidates(t *testing.T) {
	ndjson := strings.Join([]string{
		`{"channelId":"C1","user_id":"U_PENG","ts":"100.000","text":"CI 在 main 分支上整体卡住了，没有任何 build 反应"}`,
		`{"channelId":"C1","user_id":"U_PENG","ts":"200.000","text":"我们要不要回滚 canvas writes?"}`,
		`{"channelId":"C1","user_id":"U_PENG","ts":"300.000","text":"+1"}`,
	}, "\n")

	var stdout, stderr bytes.Buffer
	code := run(nil, strings.NewReader(ndjson), &stdout, &stderr)
	if code != 0 {
		t.Fatalf("exit code = %d, stderr = %q", code, stderr.String())
	}
	out := stdout.String()
	if !strings.Contains(out, "stuck_or_handoff") {
		t.Errorf("output missing stuck_or_handoff section:\n%s", out)
	}
	if !strings.Contains(out, "unanswered_question") {
		t.Errorf("output missing unanswered_question section:\n%s", out)
	}
	// "+1" is low-signal; it must not produce a candidate.
	if strings.Contains(out, `> +1`) {
		t.Errorf("low-signal '+1' message should not be included in candidates:\n%s", out)
	}
	if !strings.Contains(stderr.String(), "produced 2 candidate(s)") {
		t.Errorf("stderr did not include expected count, got %q", stderr.String())
	}
}

// TestRunSkipsMessagesWithHumanReplies confirms that the (root, reply)
// grouping in the CLI correctly hands replies to the classifier, which
// then suppresses candidates that already have human follow-up.
func TestRunSkipsMessagesWithHumanReplies(t *testing.T) {
	ndjson := strings.Join([]string{
		`{"channelId":"C1","user_id":"U_PENG","ts":"100.000","text":"How should we handle the migration?"}`,
		`{"channelId":"C1","user_id":"U_DRIVER","ts":"101.000","thread_ts":"100.000","text":"Looking at it now."}`,
	}, "\n")

	var stdout, stderr bytes.Buffer
	code := run(nil, strings.NewReader(ndjson), &stdout, &stderr)
	if code != 0 {
		t.Fatalf("exit code = %d, stderr = %q", code, stderr.String())
	}
	out := stdout.String()
	if !strings.Contains(out, "No candidate messages found") {
		t.Errorf("expected no candidates (human already replied), got:\n%s", out)
	}
}

// TestRunRespectsBotUserIDFlag verifies that --bot-user-ids excludes
// the bot's own posts and that bot replies don't count as "human
// caught it" (so the bot's parent thread still produces a candidate).
func TestRunRespectsBotUserIDFlag(t *testing.T) {
	ndjson := strings.Join([]string{
		`{"channelId":"C1","user_id":"U_BOT","ts":"100.000","text":"CI 在 main 分支上整体卡住了，没有任何 build 反应"}`,
		`{"channelId":"C1","user_id":"U_PENG","ts":"200.000","text":"是不是应该回滚 canvas writes?"}`,
		`{"channelId":"C1","user_id":"U_BOT","ts":"201.000","thread_ts":"200.000","text":"我先看一下"}`,
	}, "\n")

	var stdout, stderr bytes.Buffer
	code := run([]string{"--bot-user-ids", "U_BOT"}, strings.NewReader(ndjson), &stdout, &stderr)
	if code != 0 {
		t.Fatalf("exit code = %d, stderr = %q", code, stderr.String())
	}
	out := stdout.String()
	if strings.Contains(out, "CI 在 main 分支上整体卡住了") {
		t.Errorf("bot-authored message must not become a candidate:\n%s", out)
	}
	if !strings.Contains(out, "unanswered_question") {
		t.Errorf("Peng's question (bot-only reply) should still surface as a candidate:\n%s", out)
	}
}

// TestRunEmptyInputIsAnError protects against silent zero-output runs.
func TestRunEmptyInputIsAnError(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := run(nil, strings.NewReader(""), &stdout, &stderr)
	if code == 0 {
		t.Fatal("expected non-zero exit on empty input")
	}
	if !strings.Contains(stderr.String(), "no SlackInboundMessage records") {
		t.Errorf("stderr = %q, want diagnostic about empty input", stderr.String())
	}
}

// TestRunRejectsMalformedJSONLine surfaces parse errors with line
// context so the operator can fix their NDJSON quickly.
func TestRunRejectsMalformedJSONLine(t *testing.T) {
	ndjson := "{\"channelId\":\"C1\",\"text\":\"valid\"}\nnot json at all\n"
	var stdout, stderr bytes.Buffer
	code := run(nil, strings.NewReader(ndjson), &stdout, &stderr)
	if code == 0 {
		t.Fatal("expected non-zero exit on malformed line")
	}
	if !strings.Contains(stderr.String(), "line 2") {
		t.Errorf("error did not name offending line: %q", stderr.String())
	}
}

// TestRunQuietSuppressesStderrSummary covers the --quiet flag — useful
// when the CLI runs in a pipeline and the summary line would otherwise
// pollute another tool's stderr.
func TestRunQuietSuppressesStderrSummary(t *testing.T) {
	ndjson := `{"channelId":"C1","user_id":"U_PENG","ts":"100.000","text":"CI 卡住了"}`
	var stdout, stderr bytes.Buffer
	code := run([]string{"--quiet"}, strings.NewReader(ndjson), &stdout, &stderr)
	if code != 0 {
		t.Fatalf("exit code = %d, stderr = %q", code, stderr.String())
	}
	if strings.Contains(stderr.String(), "produced") {
		t.Errorf("--quiet should suppress summary line, got %q", stderr.String())
	}
}

// TestRunNormalizesSnakeCaseChannelID is the regression for the bug
// driver caught in the audit of slice 1 (97f01a7): NDJSON with
// `channel_id` (snake) was not getting aliased to `ChannelID` before
// grouping, so candidates came out with an empty channel field. With
// `NormalizeSlackInboundMessage` applied at read time, snake-case
// inputs should produce the same output as camelCase inputs.
func TestRunNormalizesSnakeCaseChannelID(t *testing.T) {
	ndjson := `{"channel_id":"C1","user_id":"U_PENG","ts":"100.000","text":"CI 在 main 整体卡住了，要不要看一下？"}`
	var stdout, stderr bytes.Buffer
	code := run(nil, strings.NewReader(ndjson), &stdout, &stderr)
	if code != 0 {
		t.Fatalf("exit code = %d, stderr = %q", code, stderr.String())
	}
	out := stdout.String()
	if !strings.Contains(out, "**Channel**: `C1`") {
		t.Errorf("snake_case channel_id should populate Channel field, got:\n%s", out)
	}
	if strings.Contains(out, "**Channel**: ``") {
		t.Errorf("empty Channel render indicates normalization bug:\n%s", out)
	}
}

// TestRunInvalidFlagReturnsTwo guards exit-code contract.
func TestRunInvalidFlagReturnsTwo(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := run([]string{"--not-a-real-flag"}, strings.NewReader(""), &stdout, &stderr)
	if code != 2 {
		t.Fatalf("invalid flag exit = %d, want 2", code)
	}
}
