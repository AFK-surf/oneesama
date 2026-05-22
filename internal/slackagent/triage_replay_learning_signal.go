package slackagent

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

type SlackTriageReplayBenchmarkVerdict struct {
	CaseID     string         `json:"case_id"`
	Source     string         `json:"source,omitempty"`
	Surface    string         `json:"surface,omitempty"`
	Verdict    string         `json:"verdict"`
	ReasonCode string         `json:"reason_code,omitempty"`
	Summary    string         `json:"summary,omitempty"`
	Refs       []string       `json:"refs,omitempty"`
	ChannelID  string         `json:"channel_id,omitempty"`
	ThreadTS   string         `json:"thread_ts,omitempty"`
	Expected   string         `json:"expected,omitempty"`
	Actual     string         `json:"actual,omitempty"`
	Timestamp  string         `json:"timestamp,omitempty"`
	Metadata   map[string]any `json:"metadata,omitempty"`
}

func SlackLearningSignalsFromTriageReplayBenchmarkVerdicts(verdicts []SlackTriageReplayBenchmarkVerdict) []SlackLearningSignal {
	out := make([]SlackLearningSignal, 0, len(verdicts))
	for _, verdict := range verdicts {
		signal, ok := SlackLearningSignalFromTriageReplayBenchmarkVerdict(verdict)
		if !ok {
			continue
		}
		out = append(out, signal)
	}
	return out
}

func SlackLearningSignalFromTriageReplayBenchmarkVerdict(verdict SlackTriageReplayBenchmarkVerdict) (SlackLearningSignal, bool) {
	verdict.CaseID = strings.TrimSpace(verdict.CaseID)
	verdict.Verdict = strings.TrimSpace(verdict.Verdict)
	if verdict.CaseID == "" || !slackTriageReplayVerdictIsFailure(verdict.Verdict) {
		return SlackLearningSignal{}, false
	}
	reasonCode := firstNonEmpty(strings.TrimSpace(verdict.ReasonCode), "triage_replay_benchmark_failure")
	refs := append([]string(nil), verdict.Refs...)
	if verdict.ChannelID != "" || verdict.ThreadTS != "" {
		refs = append(refs, "slack:"+strings.TrimSpace(verdict.ChannelID)+"/"+strings.TrimSpace(verdict.ThreadTS))
	}
	summary := firstNonEmpty(strings.TrimSpace(verdict.Summary), strings.TrimSpace(verdict.Actual), strings.TrimSpace(verdict.Expected), reasonCode)
	signal := SlackLearningSignalFromBenchmark(verdict.CaseID, verdict.Verdict, reasonCode, refs, summary)
	signal.Surface = firstNonEmpty(strings.TrimSpace(verdict.Surface), "slack")
	signal.SourceType = firstNonEmpty(strings.TrimSpace(verdict.Source), "triage_replay_benchmark")
	signal.Timestamp = strings.TrimSpace(verdict.Timestamp)
	signal.Metadata = compactSlackTriageReplayBenchmarkMetadata(verdict)
	return signal, true
}

func SlackLearningSignalsFromPersonaShadowResults(results []SlackPersonaShadowResult) []SlackLearningSignal {
	out := make([]SlackLearningSignal, 0, len(results))
	for _, result := range results {
		signal, ok := SlackLearningSignalFromPersonaShadowResult(result)
		if !ok {
			continue
		}
		out = append(out, signal)
	}
	return out
}

func SlackLearningSignalFromPersonaShadowResult(result SlackPersonaShadowResult) (SlackLearningSignal, bool) {
	if result.Success {
		return SlackLearningSignal{}, false
	}
	caseID := firstNonEmpty(strings.TrimSpace(result.RequestID), strings.TrimSpace(result.Source))
	if caseID == "" {
		caseID = strings.Trim(strings.Join([]string{result.ChannelID, result.ThreadTS, result.Classification}, ":"), ":")
	}
	if caseID == "" {
		caseID = "persona_shadow_replay"
	}
	refs := []string{"persona_shadow:" + caseID}
	if result.ChannelID != "" || result.ThreadTS != "" {
		refs = append(refs, "slack:"+strings.TrimSpace(result.ChannelID)+"/"+strings.TrimSpace(result.ThreadTS))
	}
	if result.Source != "" {
		refs = append(refs, "triage_replay_source:"+strings.TrimSpace(result.Source))
	}
	content := firstNonEmpty(strings.TrimSpace(result.Error), strings.TrimSpace(result.Reason), strings.TrimSpace(result.VisibleText), "persona shadow replay failed")
	signal := SlackLearningSignalFromBenchmark(caseID, "fail", "persona_shadow_replay_failure", refs, content)
	signal.SourceType = "persona_shadow_replay"
	signal.Target = "persona_shadow_replay"
	signal.Metadata = map[string]any{
		"runtime":        result.Runtime,
		"decision":       result.Decision,
		"classification": result.Classification,
		"latency_ms":     result.LatencyMS,
		"error":          result.Error,
	}
	return signal, true
}

func ReadSlackTriageReplayBenchmarkVerdictsNDJSON(r io.Reader) ([]SlackTriageReplayBenchmarkVerdict, error) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 1024*1024), 1024*1024)
	var out []SlackTriageReplayBenchmarkVerdict
	lineNo := 0
	for scanner.Scan() {
		lineNo++
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var verdict SlackTriageReplayBenchmarkVerdict
		if err := json.Unmarshal([]byte(line), &verdict); err != nil {
			return nil, fmt.Errorf("line %d: %w", lineNo, err)
		}
		if err := fillSlackTriageReplayBenchmarkAliases([]byte(line), &verdict); err != nil {
			return nil, fmt.Errorf("line %d: %w", lineNo, err)
		}
		verdict = normalizeSlackTriageReplayBenchmarkVerdict(verdict)
		if verdict.CaseID == "" {
			return nil, fmt.Errorf("line %d: case_id is required", lineNo)
		}
		if verdict.Verdict == "" {
			return nil, fmt.Errorf("line %d: verdict is required", lineNo)
		}
		out = append(out, verdict)
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func PersistSlackLearningSignals(ctx context.Context, cfg appconfig.PersistenceConfig, signals []SlackLearningSignal) (int, error) {
	store := newSlackLearningSignalStore(cfg, slackLearningSignalNoopLogger{})
	if store == nil {
		return 0, fmt.Errorf("learning signal store unavailable")
	}
	count := 0
	for _, signal := range signals {
		if _, err := store.Insert(ctx, signal); err != nil {
			return count, err
		}
		count++
	}
	return count, nil
}

func ListSlackLearningSignals(ctx context.Context, cfg appconfig.PersistenceConfig, limit int) ([]SlackLearningSignal, error) {
	store := newSlackLearningSignalStore(cfg, slackLearningSignalNoopLogger{})
	if store == nil {
		return nil, fmt.Errorf("learning signal store unavailable")
	}
	return store.List(ctx, limit, time.Time{})
}

type slackLearningSignalNoopLogger struct{}

func (slackLearningSignalNoopLogger) Warn(string, ...any) {}

func slackTriageReplayVerdictIsFailure(verdict string) bool {
	switch strings.ToLower(strings.TrimSpace(verdict)) {
	case "fail", "failed", "failure", "error", "mismatch", "false_positive", "false_negative", "quality_regression", "under_response", "over_response", "wrong", "incorrect", "reject", "rejected", "block", "blocked":
		return true
	case "", "pass", "passed", "ok", "success", "succeeded", "accept", "accepted", "confirm", "confirmed":
		return false
	default:
		return false
	}
}

func normalizeSlackTriageReplayBenchmarkVerdict(verdict SlackTriageReplayBenchmarkVerdict) SlackTriageReplayBenchmarkVerdict {
	verdict.CaseID = strings.TrimSpace(verdict.CaseID)
	verdict.Source = strings.TrimSpace(verdict.Source)
	verdict.Surface = strings.TrimSpace(verdict.Surface)
	verdict.Verdict = strings.TrimSpace(verdict.Verdict)
	verdict.ReasonCode = strings.TrimSpace(verdict.ReasonCode)
	verdict.Summary = strings.TrimSpace(verdict.Summary)
	verdict.ChannelID = strings.TrimSpace(verdict.ChannelID)
	verdict.ThreadTS = strings.TrimSpace(verdict.ThreadTS)
	verdict.Expected = strings.TrimSpace(verdict.Expected)
	verdict.Actual = strings.TrimSpace(verdict.Actual)
	verdict.Timestamp = strings.TrimSpace(verdict.Timestamp)
	verdict.Refs = compactUniqueStrings(verdict.Refs)
	return verdict
}

func fillSlackTriageReplayBenchmarkAliases(rawLine []byte, verdict *SlackTriageReplayBenchmarkVerdict) error {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(rawLine, &raw); err != nil {
		return err
	}
	if verdict.CaseID == "" {
		verdict.CaseID = stringJSONField(raw, "caseId", "id", "name")
	}
	if verdict.ReasonCode == "" {
		verdict.ReasonCode = stringJSONField(raw, "reasonCode", "reason")
	}
	if verdict.ChannelID == "" {
		verdict.ChannelID = stringJSONField(raw, "channelId")
	}
	if verdict.ThreadTS == "" {
		verdict.ThreadTS = stringJSONField(raw, "threadTs", "thread_ts")
	}
	if len(verdict.Refs) == 0 {
		verdict.Refs = stringSliceJSONField(raw, "source_refs", "sourceRefs")
	}
	return nil
}

func stringJSONField(raw map[string]json.RawMessage, keys ...string) string {
	for _, key := range keys {
		value, ok := raw[key]
		if !ok {
			continue
		}
		var out string
		if err := json.Unmarshal(value, &out); err == nil {
			return strings.TrimSpace(out)
		}
	}
	return ""
}

func stringSliceJSONField(raw map[string]json.RawMessage, keys ...string) []string {
	for _, key := range keys {
		value, ok := raw[key]
		if !ok {
			continue
		}
		var out []string
		if err := json.Unmarshal(value, &out); err == nil {
			return out
		}
	}
	return nil
}

func compactSlackTriageReplayBenchmarkMetadata(verdict SlackTriageReplayBenchmarkVerdict) map[string]any {
	metadata := make(map[string]any)
	for key, value := range verdict.Metadata {
		if strings.TrimSpace(key) == "" {
			continue
		}
		metadata[key] = value
	}
	if verdict.ChannelID != "" {
		metadata["channel_id"] = verdict.ChannelID
	}
	if verdict.ThreadTS != "" {
		metadata["thread_ts"] = verdict.ThreadTS
	}
	if verdict.Expected != "" {
		metadata["expected"] = verdict.Expected
	}
	if verdict.Actual != "" {
		metadata["actual"] = verdict.Actual
	}
	return metadata
}
