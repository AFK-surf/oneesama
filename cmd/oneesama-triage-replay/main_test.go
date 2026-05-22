package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/AFK-surf/oneesama/internal/persona"
	"github.com/AFK-surf/oneesama/internal/slackagent"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
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

// TestRunLiveModeRequiresChannel ensures the operator can't trip over
// a silent zero-output --live run.
func TestRunLiveModeRequiresChannel(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := run([]string{"--live"}, strings.NewReader(""), &stdout, &stderr)
	if code == 0 {
		t.Fatal("expected non-zero exit when --live lacks --channel")
	}
	if !strings.Contains(stderr.String(), "--channel") {
		t.Errorf("stderr = %q, want --channel hint", stderr.String())
	}
}

// TestRunLiveModeRequiresToken catches another silent-failure path.
func TestRunLiveModeRequiresToken(t *testing.T) {
	t.Setenv("ONEESAMA_SLACK_BOT_TOKEN", "")
	var stdout, stderr bytes.Buffer
	code := run([]string{"--live", "--channel", "C1"}, strings.NewReader(""), &stdout, &stderr)
	if code == 0 {
		t.Fatal("expected non-zero exit when --live lacks token")
	}
	if !strings.Contains(stderr.String(), "ONEESAMA_SLACK_BOT_TOKEN") {
		t.Errorf("stderr = %q, want token env hint", stderr.String())
	}
}

// TestRunLiveModeEndToEndAgainstFakeSlack is the headline test for
// slice 2: CLI in --live mode hits a fake Slack server, scans 2
// channels, renders a Markdown report with per-channel coverage table.
func TestRunLiveModeEndToEndAgainstFakeSlack(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/conversations.history", func(w http.ResponseWriter, r *http.Request) {
		channel := r.URL.Query().Get("channel")
		w.Header().Set("Content-Type", "application/json")
		switch channel {
		case "C1":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok": true,
				"messages": []map[string]any{
					{"ts": "1779000300.000", "user": "U_PENG", "text": "我们要不要先回滚 canvas writes 的发布？"},
				},
			})
		case "C2":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok":       true,
				"messages": []map[string]any{},
			})
		default:
			t.Fatalf("unexpected channel %q", channel)
		}
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	// Reuse the same hook the unit tests use to redirect to fake server.
	previous := slackagent.SlackBackfillLiveBaseURL
	slackagent.SlackBackfillLiveBaseURL = server.URL
	t.Cleanup(func() { slackagent.SlackBackfillLiveBaseURL = previous })

	t.Setenv("ONEESAMA_SLACK_BOT_TOKEN", "xoxb-fake")

	var stdout, stderr bytes.Buffer
	code := run(
		[]string{"--live", "--channel", "C1,C2", "--since", "24h", "--bot-user-ids", "U_BOT"},
		strings.NewReader(""), &stdout, &stderr,
	)
	if code != 0 {
		t.Fatalf("exit code = %d, stderr = %q", code, stderr.String())
	}
	out := stdout.String()
	if !strings.Contains(out, "**Channel**: `C1`") {
		t.Errorf("output missing C1 candidate channel field:\n%s", out)
	}
	if !strings.Contains(out, "## Live scan coverage") {
		t.Errorf("output missing live scan coverage section:\n%s", out)
	}
	if !strings.Contains(out, "| `C1` |") || !strings.Contains(out, "| `C2` |") {
		t.Errorf("coverage table missing per-channel rows:\n%s", out)
	}
}

// TestRunLiveAutoChannelDiscoveryFallsBackBeforeZero verifies the
// 2026-05-18 live failure mode: `users.conversations` returned zero
// channels for the bot token, but `conversations.list` still exposed
// joined channels via `is_member=true`. Auto-discovery must fall back
// before declaring the scan empty.
func TestRunLiveAutoChannelDiscoveryFallsBackBeforeZero(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/users.conversations", func(w http.ResponseWriter, r *http.Request) {
		writeFakeSlackJSON(t, w, map[string]any{"ok": true, "channels": []any{}})
	})
	mux.HandleFunc("/conversations.list", func(w http.ResponseWriter, r *http.Request) {
		writeFakeSlackJSON(t, w, map[string]any{"ok": true, "channels": []map[string]any{
			{"id": "C_FALLBACK", "is_member": true},
			{"id": "C_LEFT", "is_member": false},
		}})
	})
	mux.HandleFunc("/conversations.history", func(w http.ResponseWriter, r *http.Request) {
		writeFakeSlackJSON(t, w, map[string]any{"ok": true, "messages": []any{}})
	})
	server := httptest.NewServer(mux)
	defer server.Close()
	previous := slackagent.SlackBackfillLiveBaseURL
	slackagent.SlackBackfillLiveBaseURL = server.URL
	t.Cleanup(func() { slackagent.SlackBackfillLiveBaseURL = previous })

	t.Setenv("ONEESAMA_SLACK_BOT_TOKEN", "xoxb-fake")
	var stdout, stderr bytes.Buffer
	code := run(
		[]string{"--live", "--channel", "auto"},
		strings.NewReader(""), &stdout, &stderr,
	)
	if code != 0 {
		t.Fatalf("exit code = %d, stderr = %q", code, stderr.String())
	}
	if !strings.Contains(stderr.String(), "discovered 1 channel(s)") {
		t.Errorf("stderr = %q, want fallback discovery summary", stderr.String())
	}
	if !strings.Contains(stdout.String(), "| `C_FALLBACK` |") {
		t.Errorf("stdout missing fallback channel coverage row:\n%s", stdout.String())
	}
}

// TestRunLiveRejectsMixedAutoAndExplicitChannel pins the
// audit-required user-error guard from driver's review: an operator
// passing `--channel auto,C1` must be told "pick one mode" instead of
// having the tool silently union the two.
func TestRunLiveRejectsMixedAutoAndExplicitChannel(t *testing.T) {
	t.Setenv("ONEESAMA_SLACK_BOT_TOKEN", "xoxb-fake")
	var stdout, stderr bytes.Buffer
	code := run(
		[]string{"--live", "--channel", "auto,C1"},
		strings.NewReader(""), &stdout, &stderr,
	)
	if code == 0 {
		t.Fatal("expected non-zero exit when --channel mixes auto with explicit ids")
	}
	if !strings.Contains(stderr.String(), "cannot mix 'auto' with explicit channel ids") {
		t.Errorf("stderr = %q, want explicit mixing diagnostic", stderr.String())
	}
}

// TestRunLiveAutoChannelDiscoveryHappyPath confirms the end-to-end
// auto path: users.conversations returns N joined channels, they get
// scanned, the coverage table includes each.
func TestRunLiveAutoChannelDiscoveryHappyPath(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/users.conversations", func(w http.ResponseWriter, r *http.Request) {
		writeFakeSlackJSON(t, w, map[string]any{
			"ok": true,
			"channels": []map[string]any{
				{"id": "C_AUTO_1", "is_member": true},
				{"id": "C_AUTO_2", "is_member": true},
			},
		})
	})
	mux.HandleFunc("/conversations.history", func(w http.ResponseWriter, r *http.Request) {
		// Empty pages keep the test focused on the discovery path.
		writeFakeSlackJSON(t, w, map[string]any{"ok": true, "messages": []any{}})
	})
	server := httptest.NewServer(mux)
	defer server.Close()
	previous := slackagent.SlackBackfillLiveBaseURL
	slackagent.SlackBackfillLiveBaseURL = server.URL
	t.Cleanup(func() { slackagent.SlackBackfillLiveBaseURL = previous })

	t.Setenv("ONEESAMA_SLACK_BOT_TOKEN", "xoxb-fake")
	var stdout, stderr bytes.Buffer
	code := run(
		[]string{"--live", "--channel", "auto"},
		strings.NewReader(""), &stdout, &stderr,
	)
	if code != 0 {
		t.Fatalf("exit code = %d, stderr = %q", code, stderr.String())
	}
	if !strings.Contains(stderr.String(), "discovered 2 channel(s)") {
		t.Errorf("stderr = %q, want discovery summary", stderr.String())
	}
	out := stdout.String()
	if !strings.Contains(out, "| `C_AUTO_1` |") || !strings.Contains(out, "| `C_AUTO_2` |") {
		t.Errorf("coverage table missing auto-discovered channels:\n%s", out)
	}
}

func writeFakeSlackJSON(t *testing.T, w http.ResponseWriter, body any) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(body); err != nil {
		t.Fatalf("encode fake response: %v", err)
	}
}

// TestRunPersistenceMergeFolds186StateIntoReport is the end-to-end
// proof for slice 3 piece A: write a `slack_heartbeat_followups`
// json-file collection (the simplest persistence backend), point the
// CLI at the dir via --persistence-dir, and confirm the persisted
// delayed_no_reply followup appears in the candidate report with
// `FromPersistedState=true` source label.
func TestRunPersistenceMergeFolds186StateIntoReport(t *testing.T) {
	dir := t.TempDir()
	// json-file persistence uses one file per collection at
	// {dataDir}/{collection}.json, with an envelope listing entries.
	// Mirror that layout so the CLI sees a realistic runtime state
	// snapshot when it points --persistence-dir at this temp dir.
	collectionPath := dir + "/slack_heartbeat_followups.json"
	envelope := `{
		"schema": "oneesama.collection.v1",
		"collection": "slack_heartbeat_followups",
		"updated_at": "2026-05-18T05:00:00Z",
		"items": [
			{
				"id": "99",
				"value": {
					"id": 99,
					"kind": "delayed_no_reply",
					"channel_id": "C_PERSISTED",
					"thread_ts": "1779009000.000",
					"title": "补一下这个开放问题",
					"summary": "我理解是在问\"canvas writes 是否安全上线?\"。建议先确认 dry-run 报告...",
					"status": "scheduled",
					"created_at": "2026-05-18T05:00:00Z",
					"updated_at": "2026-05-18T05:00:00Z",
					"metadata": {"classification": "unanswered_question"}
				}
			}
		]
	}`
	if err := os.WriteFile(collectionPath, []byte(envelope), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	// Run the CLI in stdin/NDJSON mode (no live fetch needed; we
	// only care that the persistence merge runs against a known
	// disk state) with one fresh candidate that does NOT match the
	// persisted record's dedupe key.
	ndjson := `{"channelId":"C_FRESH","user_id":"U_PENG","ts":"100.000","text":"为什么 build cache 一直不命中？"}`
	var stdout, stderr bytes.Buffer
	code := run(
		[]string{"--persistence-dir", dir, "--persistence-provider", "json-file", "--persistence-max-age", "0", "--quiet"},
		strings.NewReader(ndjson), &stdout, &stderr,
	)
	if code != 0 {
		t.Fatalf("exit code = %d, stderr = %q", code, stderr.String())
	}
	out := stdout.String()
	if !strings.Contains(out, "C_FRESH") {
		t.Errorf("fresh candidate missing from output:\n%s", out)
	}
	if !strings.Contains(out, "C_PERSISTED") {
		t.Errorf("persisted candidate missing from output:\n%s", out)
	}
	if !strings.Contains(out, "`persisted` (only #186 state") {
		t.Errorf("persisted-only source label missing:\n%s", out)
	}
	if !strings.Contains(out, "**Followup ID**: 99") {
		t.Errorf("FollowupID citation missing:\n%s", out)
	}
	if !strings.Contains(out, "Persisted state merged: 1 candidate(s) carry FromPersistedState=true") {
		t.Errorf("merge footer missing or incorrect count semantics:\n%s", out)
	}
}

// TestRunPersistenceMergeMissingDirFailsGracefully ensures the
// persistence merge is non-fatal: pointing at a non-existent path
// emits a stderr warning but keeps the fresh candidates in the
// output.
func TestRunPersistenceMergeMissingDirFailsGracefully(t *testing.T) {
	ndjson := `{"channelId":"C1","user_id":"U_PENG","ts":"100.000","text":"为什么 build cache 一直不命中？"}`
	var stdout, stderr bytes.Buffer
	code := run(
		[]string{"--persistence-dir", "/nonexistent/path/that/should/not/exist/" + t.Name(), "--persistence-provider", "json-file"},
		strings.NewReader(ndjson), &stdout, &stderr,
	)
	if code != 0 {
		t.Fatalf("exit code = %d, expected 0 (non-fatal); stderr=%q", code, stderr.String())
	}
	if !strings.Contains(stdout.String(), "C1") {
		t.Errorf("fresh candidate missing from output:\n%s", stdout.String())
	}
}

func TestRunPersonaShadowReplayAgainstHTTPRuntime(t *testing.T) {
	var seen persona.Request
	mux := http.NewServeMux()
	mux.HandleFunc("/persona/decide", func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&seen); err != nil {
			t.Fatalf("decode persona request: %v", err)
		}
		writeFakeSlackJSON(t, w, persona.Response{
			Runtime:    persona.ProviderPi,
			Decision:   persona.DecisionStaySilent,
			Reason:     "shadow replay accepted",
			ShadowOnly: true,
		})
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	ndjson := `{"channelId":"C1","user_id":"U_PENG","ts":"100.000","text":"我们要不要把 meeting avatar foreground 切到 Pi sidecar？"}`
	var stdout, stderr bytes.Buffer
	code := run(
		[]string{"--persona-runtime", "pi", "--persona-runtime-base-url", server.URL, "--quiet"},
		strings.NewReader(ndjson), &stdout, &stderr,
	)
	if code != 0 {
		t.Fatalf("exit code = %d, stderr = %q", code, stderr.String())
	}
	if seen.ID == "" || seen.Mode != persona.ModeShadow || seen.Event.Kind != "slack_backfill_candidate" {
		t.Fatalf("seen persona request = %#v, want backfill shadow request", seen)
	}
	if seen.Anchor.ChannelID != "C1" || seen.Anchor.ThreadTS != "100.000" {
		t.Fatalf("seen anchor = %#v, want Slack root anchor", seen.Anchor)
	}
	out := stdout.String()
	if !strings.Contains(out, "## Persona runtime shadow replay") ||
		!strings.Contains(out, "`pi`") ||
		!strings.Contains(out, "`stay_silent`") ||
		!strings.Contains(out, "shadow replay accepted") {
		t.Errorf("output missing persona shadow section:\n%s", out)
	}
}

func TestRunCapturesBenchmarkFailuresAsLearningSignals(t *testing.T) {
	dir := t.TempDir()
	verdictsPath := dir + "/verdicts.ndjson"
	signalsPath := dir + "/signals.ndjson"
	verdicts := strings.Join([]string{
		`{"case_id":"under-response-1","verdict":"fail","reason_code":"missing_visible_reply","summary":"stayed silent on source-backed request","channel_id":"C1","thread_ts":"1779450000.000","expected":"reply","actual":"stay_silent"}`,
		`{"case_id":"clean-1","verdict":"pass","summary":"correct silence"}`,
	}, "\n")
	if err := os.WriteFile(verdictsPath, []byte(verdicts), 0o644); err != nil {
		t.Fatalf("WriteFile verdicts: %v", err)
	}

	ndjson := `{"channelId":"C1","user_id":"U_PENG","ts":"100.000","text":"这个 HN profile 是谁？"}`
	var stdout, stderr bytes.Buffer
	code := run(
		[]string{"--benchmark-verdicts", verdictsPath, "--learning-signal-output", signalsPath, "--quiet"},
		strings.NewReader(ndjson), &stdout, &stderr,
	)
	if code != 0 {
		t.Fatalf("exit code = %d, stderr = %q", code, stderr.String())
	}
	out := stdout.String()
	if !strings.Contains(out, "## Learning signals captured") || !strings.Contains(out, "under-response-1") {
		t.Fatalf("markdown missing learning signal section:\n%s", out)
	}
	signals := readLearningSignalsFile(t, signalsPath)
	if len(signals) != 1 {
		t.Fatalf("signals = %#v, want only the failing verdict", signals)
	}
	if signals[0].Subject != "under-response-1" ||
		signals[0].ReasonCode != "missing_visible_reply" ||
		signals[0].ProposedAction != "benchmark_case" {
		t.Fatalf("signal = %#v", signals[0])
	}
	if !strings.Contains(strings.Join(signals[0].Refs, ","), "slack:C1/1779450000.000") {
		t.Fatalf("refs = %#v, want Slack source ref", signals[0].Refs)
	}
}

func TestRunPersistsBenchmarkFailuresAsLearningSignals(t *testing.T) {
	dir := t.TempDir()
	verdictsPath := dir + "/verdicts.ndjson"
	if err := os.WriteFile(verdictsPath, []byte(`{"case_id":"case-store","verdict":"failed","reason_code":"judge_failed","summary":"judge found a miss"}`), 0o644); err != nil {
		t.Fatalf("WriteFile verdicts: %v", err)
	}
	persistenceDir := dir + "/state"

	ndjson := `{"channelId":"C1","user_id":"U_PENG","ts":"100.000","text":"CI 卡住了，需要看吗？"}`
	var stdout, stderr bytes.Buffer
	code := run(
		[]string{
			"--benchmark-verdicts", verdictsPath,
			"--learning-signal-store",
			"--persistence-dir", persistenceDir,
			"--persistence-provider", "json-file",
			"--quiet",
		},
		strings.NewReader(ndjson), &stdout, &stderr,
	)
	if code != 0 {
		t.Fatalf("exit code = %d, stderr = %q", code, stderr.String())
	}
	signals, err := slackagent.ListSlackLearningSignals(context.Background(), appconfig.PersistenceConfig{Provider: "json-file", DataDir: persistenceDir}, 10)
	if err != nil {
		t.Fatalf("ListSlackLearningSignals: %v", err)
	}
	if len(signals) != 1 || signals[0].Subject != "case-store" || signals[0].ReasonCode != "judge_failed" {
		t.Fatalf("signals = %#v, want persisted benchmark signal", signals)
	}
}

func TestRunPersonaShadowReplayRejectsLiveMode(t *testing.T) {
	_, err := runPersonaShadowReplay(nil, "fake", persona.ModeLive, "", time.Second)
	if err == nil || !strings.Contains(err.Error(), "requires --persona-runtime-mode=shadow") {
		t.Fatalf("err = %v, want shadow-mode guard", err)
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

func readLearningSignalsFile(t *testing.T, path string) []slackagent.SlackLearningSignal {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("Open signals: %v", err)
	}
	defer func() { _ = f.Close() }()
	var out []slackagent.SlackLearningSignal
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		var signal slackagent.SlackLearningSignal
		if err := json.Unmarshal(scanner.Bytes(), &signal); err != nil {
			t.Fatalf("decode signal: %v", err)
		}
		out = append(out, signal)
	}
	if err := scanner.Err(); err != nil {
		t.Fatalf("scan signals: %v", err)
	}
	return out
}
