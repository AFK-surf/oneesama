package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

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
	if len(report.Stats) != 2 || report.Stats[0].ChannelID != "C1" || report.Stats[1].ChannelID != "C2" {
		t.Fatalf("stats = %#v, want all channels scanned before balanced cap selection", report.Stats)
	}
}

func TestSelectBalancedReplayThreadsSpreadsAcrossChannels(t *testing.T) {
	thread := func(channel string, ts string) slackagent.SlackTriageReplayThread {
		return slackagent.SlackTriageReplayThread{ChannelID: channel, ThreadTS: ts}
	}
	selected := selectBalancedReplayThreads([][]slackagent.SlackTriageReplayThread{
		{thread("C1", "1"), thread("C1", "2"), thread("C1", "3")},
		{thread("C2", "1"), thread("C2", "2")},
		{thread("C3", "1")},
	}, 4)
	got := []string{}
	for _, item := range selected {
		got = append(got, item.ChannelID+"/"+item.ThreadTS)
	}
	want := []string{"C1/1", "C2/1", "C3/1", "C1/2"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("selected = %#v, want %#v", got, want)
	}
}

func TestRunLiveBenchmarkHonorsAbsoluteWindowAndWritesDetail(t *testing.T) {
	location := time.FixedZone("Asia/Shanghai", 8*60*60)
	afterTime := time.Date(2026, 5, 22, 9, 0, 0, 0, location)
	beforeTime := time.Date(2026, 5, 22, 20, 0, 0, 0, location)
	slackMux := http.NewServeMux()
	slackMux.HandleFunc("/conversations.history", func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.Query().Get("oldest"); got != "1779411600" {
			t.Fatalf("oldest = %q, want 1779411600", got)
		}
		if got := r.URL.Query().Get("latest"); got != "1779451200" {
			t.Fatalf("latest = %q, want 1779451200", got)
		}
		writeBenchmarkJSON(t, w, map[string]any{
			"ok": true,
			"messages": []map[string]any{
				{"ts": "1779410000.000100", "channel": "C1", "user": "U_PENG", "text": "工作日 triage 样本"},
			},
		})
	})
	slackMux.HandleFunc("/users.conversations", func(w http.ResponseWriter, r *http.Request) {
		writeBenchmarkJSON(t, w, map[string]any{
			"ok": true,
			"channels": []map[string]any{
				{"id": "C1", "name": "meeting-avatar", "is_member": true},
			},
		})
	})
	slackMux.HandleFunc("/users.list", func(w http.ResponseWriter, r *http.Request) {
		writeBenchmarkJSON(t, w, map[string]any{
			"ok": true,
			"members": []map[string]any{
				{"id": "U_PENG", "name": "peng-xiao", "profile": map[string]any{"display_name": "Peng Xiao"}},
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
		writeBenchmarkJSON(t, w, triageRunResponse{
			OK: true,
			DryRun: slackagent.SlackTriageDryRunResult{
				DryRun:        true,
				ChannelID:     request.ChannelID,
				ThreadTS:      request.Messages[0].ThreadTS,
				MessageCount:  len(request.Messages),
				Digest:        "Pi saw the workday triage sample.",
				FinalDecision: "would_stay_silent",
				Persona: slackagent.SlackPersonaShadowResult{
					Decision: persona.DecisionStaySilent,
					Success:  true,
					Reason:   "No action needed.",
				},
			},
		})
	})
	triageServer := httptest.NewServer(triageMux)
	defer triageServer.Close()
	detailPath := t.TempDir() + "/detail.json"

	var stdout, stderr bytes.Buffer
	code := run([]string{
		"--slack-url", triageServer.URL,
		"--token", "xoxb-test",
		"--channel", "C1",
		"--after", afterTime.Format("2006-01-02 15:04"),
		"--before", beforeTime.Format("2006-01-02 15:04"),
		"--detail-output", detailPath,
	}, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("exit code = %d, stderr = %s", code, stderr.String())
	}
	var report benchmarkReport
	if err := json.Unmarshal(stdout.Bytes(), &report); err != nil {
		t.Fatalf("decode report: %v\n%s", err, stdout.String())
	}
	if !strings.Contains(report.Since, "2026-05-22T09:00:00+08:00..2026-05-22T20:00:00+08:00") {
		t.Fatalf("report window = %q, want absolute SHA range", report.Since)
	}
	data, err := os.ReadFile(detailPath)
	if err != nil {
		t.Fatalf("read detail: %v", err)
	}
	var detail benchmarkDetail
	if err := json.Unmarshal(data, &detail); err != nil {
		t.Fatalf("decode detail: %v\n%s", err, string(data))
	}
	if detail.Schema != "oneesama.triage.benchmark_detail.v1" || len(detail.Rows) != 1 || detail.Rows[0].DryRun == nil {
		t.Fatalf("detail = %#v, want one dry-run row", detail)
	}
	if detail.NameMap.Users["U_PENG"] != "Peng Xiao" || detail.NameMap.Channels["C1"] != "meeting-avatar" {
		t.Fatalf("name map = %#v, want friendly user/channel names", detail.NameMap)
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
		"| `current` | `—` | `C1` | `1779450000.000100` | 1 | `—` | `—` | `—` | `stay_silent` | `would_stay_silent` |",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("markdown = %s, want %q", out, want)
		}
	}
}

func TestRunLiveBenchmarkAppliesHumanReviewGoldInput(t *testing.T) {
	slackMux := http.NewServeMux()
	slackMux.HandleFunc("/conversations.history", func(w http.ResponseWriter, r *http.Request) {
		writeBenchmarkJSON(t, w, map[string]any{
			"ok": true,
			"messages": []map[string]any{
				{"ts": "1779450000.000100", "channel": "C1", "user": "U_PENG", "text": "看看这个产品链接，给一句有证据的评论"},
				{"ts": "1779450001.000100", "channel": "C1", "user": "U_PENG", "text": "确认", "thread_ts": "1779450000.000100"},
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
		writeBenchmarkJSON(t, w, triageRunResponse{
			OK: true,
			DryRun: slackagent.SlackTriageDryRunResult{
				DryRun:        true,
				ChannelID:     request.ChannelID,
				ThreadTS:      request.Messages[0].ThreadTS,
				MessageCount:  len(request.Messages),
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
	goldPath := t.TempDir() + "/human_review.json"
	writeFile(t, goldPath, `{
	  "schema": "oneesama.triage.human_review.v1",
	  "cases": [
	    {
	      "dedupKey": "C1+1779450000.000100+current",
	      "channelId": "C1",
	      "threadTs": "1779450000.000100",
	      "variantId": "current",
	      "humanVerdict": "wrong",
	      "notes": "用户明确要求一句评论，应该可见回复",
	      "expected": {"kind": "visible_reply", "valid": true}
	    }
	  ]
	}`)

	var stdout, stderr bytes.Buffer
	code := run([]string{
		"--slack-url", triageServer.URL,
		"--token", "xoxb-test",
		"--channel", "C1",
		"--gold-input", goldPath,
	}, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("exit code = %d, stderr = %s", code, stderr.String())
	}
	var report benchmarkReport
	if err := json.Unmarshal(stdout.Bytes(), &report); err != nil {
		t.Fatalf("decode report: %v\n%s", err, stdout.String())
	}
	if report.Summary.GoldFailures != 1 || report.Summary.ByGoldStatus["fail"] != 1 {
		t.Fatalf("gold summary = %#v, want one failure", report.Summary)
	}
	if len(report.Rows) != 1 {
		t.Fatalf("rows = %d, want 1", len(report.Rows))
	}
	row := report.Rows[0]
	if row.GoldStatus != "fail" || row.GoldExpected != "visible_reply" || row.GoldActual != "would_stay_silent" {
		t.Fatalf("gold row = %#v, want visible_reply failure against silent actual", row)
	}
	if !strings.Contains(row.GoldNotes, "应该可见回复") {
		t.Fatalf("gold notes = %q, want human note carried through", row.GoldNotes)
	}
}

func TestRunLiveBenchmarkMarksGoldUnratedWhenLabelMissing(t *testing.T) {
	slackMux := http.NewServeMux()
	slackMux.HandleFunc("/conversations.history", func(w http.ResponseWriter, r *http.Request) {
		writeBenchmarkJSON(t, w, map[string]any{
			"ok": true,
			"messages": []map[string]any{
				{"ts": "1779450000.000100", "channel": "C1", "user": "U_PENG", "text": "确认"},
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
		writeBenchmarkJSON(t, w, triageRunResponse{
			OK: true,
			DryRun: slackagent.SlackTriageDryRunResult{
				DryRun:        true,
				ChannelID:     request.ChannelID,
				ThreadTS:      request.Messages[0].ThreadTS,
				MessageCount:  len(request.Messages),
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
	goldPath := t.TempDir() + "/human_review.json"
	writeFile(t, goldPath, `{"schema":"oneesama.triage.human_review.v1","cases":[]}`)

	var stdout, stderr bytes.Buffer
	code := run([]string{
		"--slack-url", triageServer.URL,
		"--token", "xoxb-test",
		"--channel", "C1",
		"--gold-input", goldPath,
	}, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("exit code = %d, stderr = %s", code, stderr.String())
	}
	var report benchmarkReport
	if err := json.Unmarshal(stdout.Bytes(), &report); err != nil {
		t.Fatalf("decode report: %v\n%s", err, stdout.String())
	}
	if report.Summary.GoldUnrated != 1 || report.Rows[0].GoldStatus != "unrated" {
		t.Fatalf("gold summary/row = %#v/%#v, want unrated", report.Summary, report.Rows[0])
	}
}

func TestRunFixtureBenchmarkReportsExpectedOutcomes(t *testing.T) {
	triageMux := http.NewServeMux()
	triageMux.HandleFunc("/slack/triage/run", func(w http.ResponseWriter, r *http.Request) {
		var request triageRunRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatalf("decode dry-run request: %v", err)
		}
		if !request.DryRun || !request.IgnoreExistingBotReply || !request.RerunForce {
			t.Fatalf("request = %#v, want side-effect-free rerun", request)
		}
		rootText := ""
		if len(request.Messages) > 0 {
			rootText = request.Messages[0].Text
		}
		result := slackagent.SlackTriageDryRunResult{
			DryRun:       true,
			ChannelID:    request.ChannelID,
			ThreadTS:     request.Messages[0].ThreadTS,
			MessageCount: len(request.Messages),
			Persona: slackagent.SlackPersonaShadowResult{
				Decision: persona.DecisionStaySilent,
				Success:  true,
			},
			FinalDecision:      "would_stay_silent",
			SideEffectsBlocked: []string{"slack_post", "approval_card", "worker_start"},
			VisibleReplyVerdicts: []slackagent.SlackTriageDryRunVisibleReplyVerdict{{
				Allowed: false,
				Reason:  "missing_evidence_anchor",
			}},
		}
		switch {
		case strings.Contains(rootText, "Johnson8053"):
			result.Persona.Decision = persona.DecisionDelegateWorker
			result.FinalDecision = "would_delegate_worker"
			result.WouldDelegateWorkers = []slackagent.SlackTriageDryRunWorker{{
				ID:          "secretary-lookup",
				SessionKind: "secretary_lookup",
				WouldStart:  true,
			}}
		case strings.Contains(rootText, "产品链接"), strings.Contains(rootText, "smoke"):
			result.Persona.Decision = persona.DecisionReply
			result.FinalDecision = "would_request_reply_approval"
			result.VisibleReplyVerdicts = []slackagent.SlackTriageDryRunVisibleReplyVerdict{{
				Allowed: true,
				Reason:  "allowed",
			}}
		case strings.Contains(rootText, "确认"):
			result.VisibleReplyVerdicts = nil
		}
		writeBenchmarkJSON(t, w, triageRunResponse{OK: true, DryRun: result})
	})
	triageServer := httptest.NewServer(triageMux)
	defer triageServer.Close()

	var stdout, stderr bytes.Buffer
	code := run([]string{
		"--slack-url", triageServer.URL,
		"--fixture", "../../internal/slackagent/testdata/triage_benchmark/*.json",
	}, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("exit code = %d, stderr = %s", code, stderr.String())
	}
	var report benchmarkReport
	if err := json.Unmarshal(stdout.Bytes(), &report); err != nil {
		t.Fatalf("decode report: %v\n%s", err, stdout.String())
	}
	if report.Mode != "fixture" || report.ThreadsSeen != 9 || report.ThreadsReplayed != 9 {
		t.Fatalf("mode/threads = %s/%d/%d, want fixture 9/9", report.Mode, report.ThreadsSeen, report.ThreadsReplayed)
	}
	if report.Summary.FixtureFailures != 0 || report.Summary.FixturePasses != 9 {
		t.Fatalf("fixture pass/fail = %d/%d, rows=%#v stderr=%s", report.Summary.FixturePasses, report.Summary.FixtureFailures, report.Rows, stderr.String())
	}
	for _, want := range []string{
		"must_block_pass",
		"must_allow_pass",
		"should_delegate_pass",
		"freely_silent_pass",
	} {
		if report.Summary.ByFixtureOutcome[want] == 0 {
			t.Fatalf("fixture outcomes = %#v, want %s", report.Summary.ByFixtureOutcome, want)
		}
	}
}

func TestRunFixtureBenchmarkReplaysConfigSetVariants(t *testing.T) {
	triageMux := http.NewServeMux()
	triageMux.HandleFunc("/slack/triage/run", func(w http.ResponseWriter, r *http.Request) {
		var request triageRunRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatalf("decode dry-run request: %v", err)
		}
		writeBenchmarkJSON(t, w, triageRunResponse{
			OK: true,
			DryRun: slackagent.SlackTriageDryRunResult{
				DryRun:        true,
				ChannelID:     request.ChannelID,
				ThreadTS:      request.Messages[0].ThreadTS,
				MessageCount:  len(request.Messages),
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
	configDir := t.TempDir()
	writeFile(t, configDir+"/variants.json", `{
	  "variants": [
	    {"variantId": "current", "description": "current shipped config", "knobs": {"visible_reply_gate": "anchor_required"}},
	    {"variantId": "candidate", "description": "candidate prompt", "knobs": {"visible_reply_gate": "candidate"}}
	  ]
	}`)

	var stdout, stderr bytes.Buffer
	code := run([]string{
		"--slack-url", triageServer.URL,
		"--fixture", "../../internal/slackagent/testdata/triage_benchmark/dsml_tool_protocol_leak_must_block.json",
		"--config-set", configDir,
	}, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("exit code = %d, stderr = %s", code, stderr.String())
	}
	var report benchmarkReport
	if err := json.Unmarshal(stdout.Bytes(), &report); err != nil {
		t.Fatalf("decode report: %v\n%s", err, stdout.String())
	}
	if report.VariantID != "multi" || len(report.Variants) != 2 || len(report.Rows) != 2 || len(report.VariantSummaries) != 2 {
		t.Fatalf("variant report = id:%s variants:%d rows:%d summaries:%d\n%s", report.VariantID, len(report.Variants), len(report.Rows), len(report.VariantSummaries), stdout.String())
	}
	seen := map[string]bool{}
	for _, row := range report.Rows {
		seen[row.VariantID] = true
		if row.FinalDecision != "candidate_visible_reply_gate" || row.FixtureReason != "ok" {
			t.Fatalf("row = %#v, want candidate gate pass for each variant", row)
		}
	}
	if !seen["current"] || !seen["candidate"] {
		t.Fatalf("seen variants = %#v, want current and candidate", seen)
	}
}

func TestRunFixtureBenchmarkAddsLLMJudgeSignal(t *testing.T) {
	triageMux := http.NewServeMux()
	triageMux.HandleFunc("/slack/triage/run", func(w http.ResponseWriter, r *http.Request) {
		var request triageRunRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatalf("decode dry-run request: %v", err)
		}
		writeBenchmarkJSON(t, w, triageRunResponse{
			OK: true,
			DryRun: slackagent.SlackTriageDryRunResult{
				DryRun:        true,
				ChannelID:     request.ChannelID,
				ThreadTS:      request.Messages[0].ThreadTS,
				MessageCount:  len(request.Messages),
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
	judgeMux := http.NewServeMux()
	judgeMux.HandleFunc("/chat/completions", func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer judge-key" {
			t.Fatalf("Authorization = %q, want bearer key", got)
		}
		var request struct {
			Model          string `json:"model"`
			ResponseFormat struct {
				Type string `json:"type"`
			} `json:"response_format"`
			Messages []struct {
				Role    string `json:"role"`
				Content string `json:"content"`
			} `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatalf("decode judge request: %v", err)
		}
		if request.Model != "judge-test" || request.ResponseFormat.Type != "json_object" || len(request.Messages) != 2 {
			t.Fatalf("judge request = %#v, want model/json/messages", request)
		}
		if !strings.Contains(request.Messages[1].Content, "direct_smoke_command_must_allow") {
			t.Fatalf("judge user payload = %s, want fixture context", request.Messages[1].Content)
		}
		writeBenchmarkJSON(t, w, map[string]any{
			"choices": []map[string]any{{
				"message": map[string]string{
					"content": `{"score":0.25,"verdict":"BAD","flags":["Missing_Evidence","missing_evidence","under_respond"],"reasoning":"No useful reply."}`,
				},
			}},
		})
	})
	judgeServer := httptest.NewServer(judgeMux)
	defer judgeServer.Close()

	var stdout, stderr bytes.Buffer
	code := run([]string{
		"--slack-url", triageServer.URL,
		"--fixture", "../../internal/slackagent/testdata/triage_benchmark/direct_smoke_command_must_allow.json",
		"--judge-url", judgeServer.URL,
		"--judge-model", "judge-test",
		"--judge-api-key", "judge-key",
	}, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("exit code = %d, stderr = %s", code, stderr.String())
	}
	var report benchmarkReport
	if err := json.Unmarshal(stdout.Bytes(), &report); err != nil {
		t.Fatalf("decode report: %v\n%s", err, stdout.String())
	}
	if !report.Judge.Enabled || report.Judge.Model != "judge-test" || report.Summary.JudgeRows != 1 || report.Summary.JudgeErrors != 0 {
		t.Fatalf("judge summary = config:%#v summary:%#v", report.Judge, report.Summary)
	}
	if report.Summary.ByJudgeVerdict["bad"] != 1 || report.Summary.ByJudgeFlag["missing_evidence"] != 1 || report.Summary.ByJudgeFlag["under_respond"] != 1 {
		t.Fatalf("judge counts = verdict:%#v flags:%#v", report.Summary.ByJudgeVerdict, report.Summary.ByJudgeFlag)
	}
	if len(report.Rows) != 1 || report.Rows[0].Judge == nil || report.Rows[0].Judge.Score != 0.25 || report.Rows[0].Judge.Verdict != "bad" {
		t.Fatalf("judge row = %#v", report.Rows)
	}
}

func writeFile(t *testing.T, path string, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func writeBenchmarkJSON(t *testing.T, w http.ResponseWriter, body any) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(body); err != nil {
		t.Fatalf("encode response: %v", err)
	}
}
