package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
	"github.com/AFK-surf/oneesama/internal/slackagent"
)

func serveBenchmarkReview(ctx context.Context, listen string, reviewOutput string, report benchmarkReport, detail benchmarkDetail, stderr io.Writer) error {
	listen = firstNonEmpty(listen, "127.0.0.1:0")
	ln, err := net.Listen("tcp", listen)
	if err != nil {
		return err
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = io.WriteString(w, benchmarkReviewHTML)
	})
	mux.HandleFunc("/detail.json", func(w http.ResponseWriter, r *http.Request) {
		writeReviewServerJSON(w, detail)
	})
	mux.HandleFunc("/summary.json", func(w http.ResponseWriter, r *http.Request) {
		writeReviewServerJSON(w, report)
	})
	mux.HandleFunc("/human-review", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, 10<<20))
		if err != nil {
			http.Error(w, "read review: "+err.Error(), http.StatusBadRequest)
			return
		}
		if !json.Valid(body) {
			http.Error(w, "review JSON is invalid", http.StatusBadRequest)
			return
		}
		path := firstNonEmpty(reviewOutput, defaultReviewOutputPath())
		if err := os.WriteFile(path, append(body, '\n'), 0o644); err != nil {
			http.Error(w, "write review: "+err.Error(), http.StatusInternalServerError)
			return
		}
		cases, err := decodeBenchmarkGoldCases(body)
		if err != nil {
			http.Error(w, "decode review as gold input: "+err.Error(), http.StatusBadRequest)
			return
		}
		gold := newBenchmarkGoldStoreFromCases(cases)
		summary := benchmarkGoldReplaySummary(report.Rows, gold)
		writeReviewServerJSON(w, map[string]any{
			"ok":      true,
			"path":    path,
			"gold":    summary,
			"message": "saved human review and replayed current rows against submitted gold labels",
		})
	})
	server := &http.Server{Handler: mux}
	addr := ln.Addr().String()
	if strings.HasPrefix(addr, "127.0.0.1:") || strings.HasPrefix(addr, "[::1]:") {
		fmt.Fprintf(stderr, "oneesama-triage-benchmark: review UI listening at http://%s/\n", addr)
	} else {
		fmt.Fprintf(stderr, "oneesama-triage-benchmark: review UI listening at %s\n", addr)
	}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
	}()
	err = server.Serve(ln)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func writeReviewServerJSON(w http.ResponseWriter, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	_ = enc.Encode(body)
}

func defaultReviewOutputPath() string {
	stamp := time.Now().Format("20060102-150405")
	return "oneesama-triage-human-review-" + stamp + ".json"
}

func defaultWorkerJobsInput() string {
	if path := strings.TrimSpace(os.Getenv("ONEESAMA_AGENT_RUNNER_JOBS_PATH")); path != "" {
		return path
	}
	for _, env := range []string{
		"ONEESAMA_STATE_DATA_DIR",
		"ONEESAMA_PERSISTENCE_DATA_DIR",
		"ONEESAMA_DATA_DIR",
		"MAB_DATA_DIR",
	} {
		if dir := strings.TrimSpace(os.Getenv(env)); dir != "" {
			return filepath.Join(dir, "agent_runner_jobs.json")
		}
	}
	return ""
}

func attachHistoricalWorkerResults(ctx context.Context, detail *benchmarkDetail, path string, stderr io.Writer) {
	if detail == nil || len(detail.Rows) == 0 {
		return
	}
	path = strings.TrimSpace(path)
	if path == "" {
		return
	}
	jobs, err := readHistoricalWorkerJobs(path)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			fmt.Fprintf(stderr, "oneesama-triage-benchmark: read historical worker jobs: %v\n", err)
		}
		return
	}
	byThread := make(map[string][]benchmarkHistoricalWorkerResult)
	for _, job := range jobs {
		select {
		case <-ctx.Done():
			return
		default:
		}
		if !historicalJobIsPersonaDelegate(job) {
			continue
		}
		channelID, threadTS := historicalJobSlackTarget(job)
		if channelID == "" || threadTS == "" {
			continue
		}
		key := benchmarkThreadKey(channelID, threadTS)
		byThread[key] = append(byThread[key], buildHistoricalWorkerResult(job))
	}
	for key := range byThread {
		sort.SliceStable(byThread[key], func(i, j int) bool {
			return historicalWorkerResultSortTime(byThread[key][i]).After(historicalWorkerResultSortTime(byThread[key][j]))
		})
		if len(byThread[key]) > 8 {
			byThread[key] = byThread[key][:8]
		}
	}
	for i := range detail.Rows {
		key := benchmarkThreadKey(detail.Rows[i].ChannelID, detail.Rows[i].ThreadTS)
		if results := byThread[key]; len(results) > 0 {
			detail.Rows[i].HistoricalWorkerResults = append([]benchmarkHistoricalWorkerResult(nil), results...)
		}
	}
}

func readHistoricalWorkerJobs(path string) ([]agentrunner.Job, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 {
		return nil, nil
	}
	if trimmed[0] == '[' {
		var jobs []agentrunner.Job
		if err := json.Unmarshal(trimmed, &jobs); err != nil {
			return nil, err
		}
		return jobs, nil
	}
	var collection struct {
		Items []struct {
			ID    string          `json:"id"`
			Value agentrunner.Job `json:"value"`
		} `json:"items"`
		Jobs []agentrunner.Job `json:"jobs"`
	}
	if err := json.Unmarshal(trimmed, &collection); err != nil {
		return nil, err
	}
	jobs := make([]agentrunner.Job, 0, len(collection.Items)+len(collection.Jobs))
	for _, item := range collection.Items {
		job := item.Value
		if strings.TrimSpace(job.ID) == "" {
			job.ID = strings.TrimSpace(item.ID)
		}
		jobs = append(jobs, job)
	}
	jobs = append(jobs, collection.Jobs...)
	return jobs, nil
}

func historicalJobIsPersonaDelegate(job agentrunner.Job) bool {
	return strings.EqualFold(contextString(job.Context, "source"), "persona_delegate_worker")
}

func historicalJobSlackTarget(job agentrunner.Job) (string, string) {
	slack := contextMap(job.Context, "slack")
	channelID := firstNonEmpty(
		contextString(slack, "channel_id", "channelId", "channel"),
		contextString(job.Context, "channel_id", "channelId", "channel"),
	)
	threadTS := firstNonEmpty(
		contextString(slack, "thread_ts", "threadTs", "thread"),
		contextString(job.Context, "thread_ts", "threadTs", "thread"),
	)
	if channelID != "" && threadTS != "" {
		return channelID, threadTS
	}
	if parsedChannel, parsedThread := parseHistoricalTriageRequestID(firstNonEmpty(
		contextString(contextMap(job.Context, "persona"), "request_id", "requestId"),
		contextString(job.Context, "request_id", "requestId", "sessionId", "session_id"),
		contextString(contextMap(job.Context, "worker_context"), "request_id", "requestId", "sessionId", "session_id"),
	)); parsedChannel != "" && parsedThread != "" {
		if channelID == "" {
			channelID = parsedChannel
		}
		if threadTS == "" {
			threadTS = parsedThread
		}
	}
	return channelID, threadTS
}

func parseHistoricalTriageRequestID(value string) (string, string) {
	parts := strings.Split(strings.TrimSpace(value), ":")
	if len(parts) != 3 || parts[0] != "triage" {
		return "", ""
	}
	channelID := strings.TrimSpace(parts[1])
	threadTS := strings.TrimSpace(parts[2])
	if channelID == "" || threadTS == "" {
		return "", ""
	}
	return channelID, threadTS
}

func buildHistoricalWorkerResult(job agentrunner.Job) benchmarkHistoricalWorkerResult {
	envelope := agentrunner.NewWorkerResultEnvelope(job)
	sessionKind := agentrunner.NormalizeSessionKind(firstNonEmpty(
		contextString(job.Context, "session_kind", "sessionKind"),
		contextString(contextMap(job.Context, "worker_context"), "session_kind", "sessionKind"),
	))
	scope := firstNonEmpty(
		contextString(job.Context, "delegation_scope", "delegationScope"),
		contextString(contextMap(job.Context, "worker_context"), "delegation_scope", "delegationScope"),
	)
	result := benchmarkHistoricalWorkerResult{
		JobID:           strings.TrimSpace(job.ID),
		Provider:        strings.TrimSpace(job.Provider),
		Status:          string(job.Status),
		FailureCode:     string(job.FailureCode),
		CreatedAt:       strings.TrimSpace(job.CreatedAt),
		UpdatedAt:       strings.TrimSpace(job.UpdatedAt),
		SessionKind:     sessionKind,
		DelegationScope: scope,
		TaskPreview:     truncateBenchmarkText(job.Task, 900),
		Result:          truncateBenchmarkText(job.Result, 8000),
		Error:           truncateBenchmarkText(job.Error, 1400),
		Envelope:        envelope,
	}
	if job.Status != agentrunner.StatusCompleted {
		result.VisibleGateReason = "worker_status_" + firstNonEmpty(string(job.Status), "unknown")
		result.WouldPostReason = result.VisibleGateReason
		return result
	}
	completedText := agentrunner.WorkerResultEnvelopeCompletedText(envelope)
	if sessionKind == agentrunner.SessionKindSecretaryLookup || strings.EqualFold(scope, "secretary_lookup") {
		visibleText, anchors := parseHistoricalSecretaryLookupResult(completedText)
		result.VisibleText = visibleText
		result.EvidenceAnchors = anchors
		verdict := slackagent.EvaluateSlackVisibleReplyCandidate(slackagent.SlackVisibleReplyCandidate{
			Message:         visibleText,
			EvidenceAnchors: anchors,
		})
		result.VisibleGateAllowed = verdict.Allowed
		result.VisibleGateReason = verdict.Reason
		result.EvidenceAnchors = verdict.EvidenceAnchors
		result.WouldPost = verdict.Allowed
		if verdict.Allowed {
			result.WouldPostReason = "secretary_lookup_visible_reply_allowed"
		} else {
			result.WouldPostReason = "secretary_lookup_visible_reply_blocked:" + firstNonEmpty(verdict.Reason, "unknown")
		}
		return result
	}
	result.VisibleText = completedText
	result.VisibleGateAllowed = true
	result.VisibleGateReason = "normal_worker_result_not_allowlist_gated"
	result.WouldPost = strings.TrimSpace(completedText) != ""
	if result.WouldPost {
		result.WouldPostReason = "normal_worker_result_posted_directly_after_formatting"
	} else {
		result.WouldPostReason = "empty_completed_worker_result"
	}
	return result
}

func parseHistoricalSecretaryLookupResult(text string) (string, []slackagent.SlackVisibleEvidenceAnchor) {
	var mapped map[string]any
	if err := json.Unmarshal([]byte(stripBenchmarkJSONFence(text)), &mapped); err != nil {
		return "", nil
	}
	visibleText := firstNonEmpty(
		anyString(mapped["visible_text"]),
		anyString(mapped["visibleText"]),
		anyString(mapped["message"]),
		anyString(mapped["text"]),
		anyString(mapped["summary"]),
	)
	anchors := evidenceAnchorsFromBenchmarkAny(firstNonEmptyAny(
		mapped["evidence_anchors"],
		mapped["evidenceAnchors"],
		mapped["evidence"],
	))
	return visibleText, anchors
}

func evidenceAnchorsFromBenchmarkAny(value any) []slackagent.SlackVisibleEvidenceAnchor {
	if value == nil {
		return nil
	}
	switch typed := value.(type) {
	case []slackagent.SlackVisibleEvidenceAnchor:
		return typed
	case slackagent.SlackVisibleEvidenceAnchor:
		return []slackagent.SlackVisibleEvidenceAnchor{typed}
	}
	data, err := json.Marshal(value)
	if err != nil {
		return nil
	}
	var anchors []slackagent.SlackVisibleEvidenceAnchor
	if err := json.Unmarshal(data, &anchors); err == nil {
		return anchors
	}
	var anchor slackagent.SlackVisibleEvidenceAnchor
	if err := json.Unmarshal(data, &anchor); err == nil {
		return []slackagent.SlackVisibleEvidenceAnchor{anchor}
	}
	return nil
}

func stripBenchmarkJSONFence(text string) string {
	trimmed := strings.TrimSpace(text)
	if strings.HasPrefix(trimmed, "```") {
		trimmed = strings.TrimPrefix(trimmed, "```json")
		trimmed = strings.TrimPrefix(trimmed, "```JSON")
		trimmed = strings.TrimPrefix(trimmed, "```")
		trimmed = strings.TrimSuffix(trimmed, "```")
	}
	return strings.TrimSpace(trimmed)
}

func benchmarkThreadKey(channelID string, threadTS string) string {
	return strings.TrimSpace(channelID) + "\x00" + strings.TrimSpace(threadTS)
}

func historicalWorkerResultSortTime(result benchmarkHistoricalWorkerResult) time.Time {
	for _, value := range []string{result.UpdatedAt, result.CreatedAt} {
		if t, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(value)); err == nil {
			return t
		}
	}
	return time.Time{}
}

func contextString(values map[string]any, keys ...string) string {
	for _, key := range keys {
		if value := anyString(values[key]); value != "" {
			return value
		}
	}
	return ""
}

func contextMap(values map[string]any, key string) map[string]any {
	if values == nil {
		return nil
	}
	switch typed := values[key].(type) {
	case map[string]any:
		return typed
	case map[string]string:
		out := make(map[string]any, len(typed))
		for k, v := range typed {
			out[k] = v
		}
		return out
	default:
		return nil
	}
}

func firstNonEmptyAny(values ...any) any {
	for _, value := range values {
		switch typed := value.(type) {
		case nil:
			continue
		case string:
			if strings.TrimSpace(typed) != "" {
				return value
			}
		case []any:
			if len(typed) > 0 {
				return value
			}
		case []map[string]any:
			if len(typed) > 0 {
				return value
			}
		default:
			return value
		}
	}
	return nil
}

func anyString(value any) string {
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case json.Number:
		return strings.TrimSpace(typed.String())
	case fmt.Stringer:
		return strings.TrimSpace(typed.String())
	default:
		return ""
	}
}

func truncateBenchmarkText(value string, maxRunes int) string {
	trimmed := strings.TrimSpace(value)
	if maxRunes <= 0 || len([]rune(trimmed)) <= maxRunes {
		return trimmed
	}
	return strings.TrimSpace(string([]rune(trimmed)[:maxRunes])) + "\n\n[truncated]"
}

func fetchBenchmarkRuntimeMetadata(ctx context.Context, baseURL string) map[string]any {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if baseURL == "" {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	client := &http.Client{Timeout: 3 * time.Second}
	out := map[string]any{}
	if health := fetchBenchmarkJSONMap(ctx, client, baseURL+"/healthz"); len(health) > 0 {
		out["healthz"] = health
	}
	if status := fetchBenchmarkJSONMap(ctx, client, baseURL+"/slack/status"); len(status) > 0 {
		out["slack_status"] = status
		if personaStatus, ok := status["persona_runtime"].(map[string]any); ok {
			out["persona_runtime"] = personaStatus
		}
		if agentRunner, ok := status["agent_runner"].(map[string]any); ok {
			out["agent_runner"] = agentRunner
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func fetchBenchmarkJSONMap(ctx context.Context, client *http.Client, url string) map[string]any {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil
	}
	var out map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil
	}
	return out
}
