package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/AFK-surf/oneesama/internal/persona"
	"github.com/AFK-surf/oneesama/internal/slackagent"
)

func TestRunLiveBenchmarkReplaysThreadsThroughDryRunEndpoint(t *testing.T) {
	slackMux := http.NewServeMux()
	slackMux.HandleFunc("/conversations.history", func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.Query().Get("channel"); got != "C1" {
			t.Fatalf("channel = %q, want C1", got)
		}
		writeBenchmarkJSON(t, w, map[string]any{
			"ok": true,
			"messages": []map[string]any{
				{"ts": "1779450000.000100", "channel": "C1", "user": "U_PENG", "text": "帮我看看这个 HN profile 是谁"},
			},
		})
	})
	slackServer := httptest.NewServer(slackMux)
	defer slackServer.Close()
	previousSlackURL := slackagent.SlackBackfillLiveBaseURL
	slackagent.SlackBackfillLiveBaseURL = slackServer.URL
	t.Cleanup(func() { slackagent.SlackBackfillLiveBaseURL = previousSlackURL })

	triageMux := http.NewServeMux()
	triageMux.HandleFunc("/slack/triage/run", func(w http.ResponseWriter, r *http.Request) {
		var request triageRunRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatalf("decode dry-run request: %v", err)
		}
		if !request.DryRun || !request.IgnoreExistingBotReply || !request.RerunForce {
			t.Fatalf("request = %#v, want side-effect-free rerun", request)
		}
		if request.ChannelID != "C1" || len(request.Messages) != 1 {
			t.Fatalf("request = %#v, want C1 single-message thread", request)
		}
		writeBenchmarkJSON(t, w, triageRunResponse{
			OK: true,
			DryRun: slackagent.SlackTriageDryRunResult{
				DryRun:        true,
				ChannelID:     "C1",
				ThreadTS:      "1779450000.000100",
				MessageCount:  1,
				FinalDecision: "would_request_reply_approval",
				Persona: slackagent.SlackPersonaShadowResult{
					Decision: persona.DecisionReply,
					Success:  true,
				},
				VisibleReplyVerdicts: []slackagent.SlackTriageDryRunVisibleReplyVerdict{{
					Allowed: true,
					Reason:  "allowed",
				}},
				PipelineSmellSignals: []string{"high_gate_block_rate"},
			},
		})
	})
	triageServer := httptest.NewServer(triageMux)
	defer triageServer.Close()

	var stdout, stderr bytes.Buffer
	code := run([]string{
		"--slack-url", triageServer.URL,
		"--token", "xoxb-test",
		"--channel", "C1",
		"--since", "24h",
	}, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("exit code = %d, stderr = %s", code, stderr.String())
	}
	var report benchmarkReport
	if err := json.Unmarshal(stdout.Bytes(), &report); err != nil {
		t.Fatalf("decode report: %v\n%s", err, stdout.String())
	}
	if report.ThreadsReplayed != 1 || len(report.Rows) != 1 {
		t.Fatalf("report threads = %d rows=%d, want 1/1", report.ThreadsReplayed, len(report.Rows))
	}
	row := report.Rows[0]
	if row.FinalDecision != "would_request_reply_approval" || row.PersonaDecision != persona.DecisionReply || !row.VisibleReplyAllowed {
		t.Fatalf("row = %#v, want reply approval dry-run", row)
	}
	if report.Summary.ByFinalDecision["would_request_reply_approval"] != 1 ||
		report.Summary.ByVisibleReplyReason["allowed"] != 1 ||
		report.Summary.ByPipelineSmell["high_gate_block_rate"] != 1 {
		t.Fatalf("summary = %#v, want decision/reason/smell counts", report.Summary)
	}
	if !strings.Contains(stderr.String(), "replayed 1 thread") {
		t.Fatalf("stderr = %q, want replay summary", stderr.String())
	}
}

func TestRunLiveBenchmarkCountsDryRunErrors(t *testing.T) {
	slackMux := http.NewServeMux()
	slackMux.HandleFunc("/conversations.history", func(w http.ResponseWriter, r *http.Request) {
		writeBenchmarkJSON(t, w, map[string]any{
			"ok": true,
			"messages": []map[string]any{
				{"ts": "1779450000.000100", "channel": "C1", "user": "U_PENG", "text": "这个怎么处理？"},
			},
		})
	})
	slackServer := httptest.NewServer(slackMux)
	defer slackServer.Close()
	previousSlackURL := slackagent.SlackBackfillLiveBaseURL
	slackagent.SlackBackfillLiveBaseURL = slackServer.URL
	t.Cleanup(func() { slackagent.SlackBackfillLiveBaseURL = previousSlackURL })

	triageMux := http.NewServeMux()
	triageMux.HandleFunc("/slack/triage/run", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		writeBenchmarkJSON(t, w, map[string]any{"ok": false, "error": "persona runtime unavailable"})
	})
	triageServer := httptest.NewServer(triageMux)
	defer triageServer.Close()

	var stdout, stderr bytes.Buffer
	code := run([]string{
		"--slack-url", triageServer.URL,
		"--token", "xoxb-test",
		"--channel", "C1",
	}, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("exit code = %d, stderr = %s", code, stderr.String())
	}
	var report benchmarkReport
	if err := json.Unmarshal(stdout.Bytes(), &report); err != nil {
		t.Fatalf("decode report: %v\n%s", err, stdout.String())
	}
	if report.Summary.Errors != 1 || len(report.Rows) != 1 {
		t.Fatalf("summary/rows = %#v/%d, want one dry-run error row", report.Summary, len(report.Rows))
	}
	if report.Rows[0].Error != "persona runtime unavailable" {
		t.Fatalf("row error = %q, want persona runtime unavailable", report.Rows[0].Error)
	}
}

func TestRunLiveBenchmarkHonorsTotalThreadCap(t *testing.T) {
	slackMux := http.NewServeMux()
	slackMux.HandleFunc("/conversations.history", func(w http.ResponseWriter, r *http.Request) {
		channel := r.URL.Query().Get("channel")
		writeBenchmarkJSON(t, w, map[string]any{
			"ok": true,
			"messages": []map[string]any{
				{"ts": "1779450000.000100", "channel": channel, "user": "U_PENG", "text": "这个要不要处理？"},
			},
		})
	})
	slackServer := httptest.NewServer(slackMux)
	defer slackServer.Close()
	previousSlackURL := slackagent.SlackBackfillLiveBaseURL
	slackagent.SlackBackfillLiveBaseURL = slackServer.URL
	t.Cleanup(func() { slackagent.SlackBackfillLiveBaseURL = previousSlackURL })

	triageMux := http.NewServeMux()
	triageMux.HandleFunc("/slack/triage/run", func(w http.ResponseWriter, r *http.Request) {
		writeBenchmarkJSON(t, w, triageRunResponse{
			OK: true,
			DryRun: slackagent.SlackTriageDryRunResult{
				DryRun:        true,
				FinalDecision: "would_stay_silent",
				Persona: slackagent.SlackPersonaShadowResult{
					Decision: persona.DecisionStaySilent,
					Success:  true,
				},
			},
		})
	})
	triageServer := httptest.NewServer(triageMux)
	defer triageServer.Close()

	var stdout, stderr bytes.Buffer
	code := run([]string{
		"--slack-url", triageServer.URL,
		"--token", "xoxb-test",
		"--channel", "C1,C2",
		"--max-threads", "1",
	}, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("exit code = %d, stderr = %s", code, stderr.String())
	}
	var report benchmarkReport
	if err := json.Unmarshal(stdout.Bytes(), &report); err != nil {
		t.Fatalf("decode report: %v\n%s", err, stdout.String())
	}
	if report.MaxThreads != 1 || !report.Truncated {
		t.Fatalf("cap fields = max:%d truncated:%v, want 1/true", report.MaxThreads, report.Truncated)
	}
	if report.ThreadsReplayed != 1 || len(report.Rows) != 1 {
		t.Fatalf("threads/rows = %d/%d, want 1/1", report.ThreadsReplayed, len(report.Rows))
	}
	if len(report.Stats) != 1 || report.Stats[0].ChannelID != "C1" {
		t.Fatalf("stats = %#v, want only first channel scanned before cap", report.Stats)
	}
}

func TestRunLiveBenchmarkCanRenderMarkdownTable(t *testing.T) {
	slackMux := http.NewServeMux()
	slackMux.HandleFunc("/conversations.history", func(w http.ResponseWriter, r *http.Request) {
		writeBenchmarkJSON(t, w, map[string]any{
			"ok": true,
			"messages": []map[string]any{
				{"ts": "1779450000.000100", "channel": "C1", "user": "U_PENG", "text": "这个要不要回？"},
			},
		})
	})
	slackServer := httptest.NewServer(slackMux)
	defer slackServer.Close()
	previousSlackURL := slackagent.SlackBackfillLiveBaseURL
	slackagent.SlackBackfillLiveBaseURL = slackServer.URL
	t.Cleanup(func() { slackagent.SlackBackfillLiveBaseURL = previousSlackURL })

	triageMux := http.NewServeMux()
	triageMux.HandleFunc("/slack/triage/run", func(w http.ResponseWriter, r *http.Request) {
		writeBenchmarkJSON(t, w, triageRunResponse{
			OK: true,
			DryRun: slackagent.SlackTriageDryRunResult{
				DryRun:        true,
				ChannelID:     "C1",
				ThreadTS:      "1779450000.000100",
				MessageCount:  1,
				FinalDecision: "would_stay_silent",
				Persona: slackagent.SlackPersonaShadowResult{
					Decision: persona.DecisionStaySilent,
					Success:  true,
				},
			},
		})
	})
	triageServer := httptest.NewServer(triageMux)
	defer triageServer.Close()

	var stdout, stderr bytes.Buffer
	code := run([]string{
		"--slack-url", triageServer.URL,
		"--token", "xoxb-test",
		"--channel", "C1",
		"--format", "markdown",
	}, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("exit code = %d, stderr = %s", code, stderr.String())
	}
	out := stdout.String()
	for _, want := range []string{
		"# Oneesama Triage Benchmark",
		"## Final Decisions",
		"| `would_stay_silent` | 1 |",
		"## Replay Rows",
		"| `C1` | `1779450000.000100` | 1 | `stay_silent` | `would_stay_silent` |",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("markdown = %s, want %q", out, want)
		}
	}
}

func writeBenchmarkJSON(t *testing.T, w http.ResponseWriter, body any) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(body); err != nil {
		t.Fatalf("encode response: %v", err)
	}
}
