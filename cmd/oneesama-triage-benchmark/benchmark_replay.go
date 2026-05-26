package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"

	"github.com/AFK-surf/oneesama/internal/slackagent"
)

func dryRunThread(ctx context.Context, client *http.Client, baseURL string, variantID string, thread slackagent.SlackTriageReplayThread) (benchmarkRow, *slackagent.SlackTriageDryRunResult) {
	row := benchmarkRow{
		VariantID:    variantID,
		ChannelID:    thread.ChannelID,
		ThreadTS:     thread.ThreadTS,
		MessageCount: len(thread.Messages),
	}
	payload := triageRunRequest{
		ChannelID:              thread.ChannelID,
		Messages:               thread.Messages,
		DryRun:                 true,
		IgnoreExistingBotReply: true,
		RerunForce:             true,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		row.Error = err.Error()
		return row, nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(baseURL, "/")+"/slack/triage/run", bytes.NewReader(body))
	if err != nil {
		row.Error = err.Error()
		return row, nil
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		row.Error = err.Error()
		return row, nil
	}
	defer func() { _ = resp.Body.Close() }()
	var out triageRunResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		row.Error = fmt.Sprintf("decode HTTP %d: %v", resp.StatusCode, err)
		return row, nil
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 || !out.OK {
		row.Error = firstNonEmpty(out.Error, fmt.Sprintf("HTTP %d", resp.StatusCode))
		return row, nil
	}
	row.FinalDecision = out.DryRun.FinalDecision
	row.PersonaDecision = out.DryRun.Persona.Decision
	row.WorkerRequests = len(out.DryRun.WouldDelegateWorkers)
	row.PipelineSmellSignals = append([]string(nil), out.DryRun.PipelineSmellSignals...)
	row.GateDecision = benchmarkGateDecision(out.DryRun)
	for _, verdict := range out.DryRun.VisibleReplyVerdicts {
		if verdict.Allowed {
			row.VisibleReplyAllowed = true
		}
		row.VisibleReplyReasons = append(row.VisibleReplyReasons, verdict.Reason)
	}
	row.VisibleReplyReasons = uniqueStrings(row.VisibleReplyReasons)
	dryRun := out.DryRun
	return row, &dryRun
}

type benchmarkDryRunResult struct {
	thread slackagent.SlackTriageReplayThread
	row    benchmarkRow
	dryRun *slackagent.SlackTriageDryRunResult
}

func dryRunReplayThreads(ctx context.Context, client *http.Client, baseURL string, variantID string, threads []slackagent.SlackTriageReplayThread, parallel int, stderr io.Writer) []benchmarkDryRunResult {
	if parallel <= 1 || len(threads) <= 1 {
		out := make([]benchmarkDryRunResult, 0, len(threads))
		for index, thread := range threads {
			fmt.Fprintf(stderr, "oneesama-triage-benchmark: dry-run thread %d/%d channel=%s thread=%s variant=%s\n", index+1, len(threads), thread.ChannelID, thread.ThreadTS, variantID)
			row, dryRun := dryRunThread(ctx, client, baseURL, variantID, thread)
			out = append(out, benchmarkDryRunResult{thread: thread, row: row, dryRun: dryRun})
		}
		return out
	}
	if parallel > len(threads) {
		parallel = len(threads)
	}
	out := make([]benchmarkDryRunResult, len(threads))
	jobs := make(chan int)
	var wg sync.WaitGroup
	for worker := 0; worker < parallel; worker++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for index := range jobs {
				thread := threads[index]
				fmt.Fprintf(stderr, "oneesama-triage-benchmark: dry-run thread %d/%d channel=%s thread=%s variant=%s\n", index+1, len(threads), thread.ChannelID, thread.ThreadTS, variantID)
				row, dryRun := dryRunThread(ctx, client, baseURL, variantID, thread)
				out[index] = benchmarkDryRunResult{thread: thread, row: row, dryRun: dryRun}
			}
		}()
	}
	for index := range threads {
		jobs <- index
	}
	close(jobs)
	wg.Wait()
	return out
}

func selectBalancedReplayThreads(buckets [][]slackagent.SlackTriageReplayThread, maxTotal int) []slackagent.SlackTriageReplayThread {
	total := 0
	for _, bucket := range buckets {
		total += len(bucket)
	}
	limit := total
	if maxTotal > 0 && maxTotal < limit {
		limit = maxTotal
	}
	out := make([]slackagent.SlackTriageReplayThread, 0, limit)
	for offset := 0; len(out) < limit; offset++ {
		added := false
		for _, bucket := range buckets {
			if offset >= len(bucket) {
				continue
			}
			out = append(out, bucket[offset])
			added = true
			if len(out) >= limit {
				break
			}
		}
		if !added {
			break
		}
	}
	return out
}

func benchmarkGateDecision(dryRun slackagent.SlackTriageDryRunResult) string {
	if len(dryRun.VisibleReplyVerdicts) == 0 {
		return "no_visible_reply_candidate"
	}
	allowed := false
	for _, verdict := range dryRun.VisibleReplyVerdicts {
		if verdict.Allowed {
			allowed = true
			break
		}
	}
	if !allowed {
		return "visible_reply_blocked"
	}
	for _, action := range dryRun.ActionsAfterGate {
		if strings.TrimSpace(action.Type) == "post_thread_reply" {
			return "visible_reply_requires_approval"
		}
	}
	return "visible_reply_allowed_no_delivery"
}
