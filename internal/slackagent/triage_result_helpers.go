package slackagent

import (
	"encoding/json"
	"fmt"
	"strings"
)

type triageCounters struct {
	mutations int
	failures  int
}

type triageAssistantTurn struct {
	Role      string                    `json:"role,omitempty"`
	Content   string                    `json:"content,omitempty"`
	ToolCalls []triageAssistantToolCall `json:"tool_calls,omitempty"`
}

type triageAssistantToolCall struct {
	Name      string         `json:"name,omitempty"`
	Arguments map[string]any `json:"arguments,omitempty"`
}

func hydrateTriageResultContent(sessionID string, content string, history []triageAssistantTurn) string {
	if strings.TrimSpace(content) != "" {
		return content
	}
	for i := len(history) - 1; i >= 0; i-- {
		turn := history[i]
		if strings.EqualFold(turn.Role, "assistant") && strings.TrimSpace(turn.Content) != "" {
			return strings.TrimSpace(turn.Content)
		}
	}
	return ""
}

func triageDidSucceed(sessionID string, mutations int, failures int, recorder *triageActionRecorder, content string) (bool, string) {
	if recorder != nil {
		mutations = maxInt(mutations, recorder.mutationCount())
		failures = maxInt(failures, recorder.failureCount())
	}
	if failures > 0 && mutations == 0 {
		return false, fmt.Sprintf("%d tool call(s) failed with no mutations", failures)
	}
	if mutations == 0 && strings.TrimSpace(content) == "" {
		return false, "empty final response with no mutations"
	}
	return true, ""
}

func reconcileTriageCounts(counters *triageCounters, recorder *triageActionRecorder) (mutations int, failures int) {
	if counters != nil {
		mutations = counters.mutations
		failures = counters.failures
	}
	if recorder != nil {
		mutations = maxInt(mutations, recorder.mutationCount())
		failures = maxInt(failures, recorder.failureCount())
	}
	return mutations, failures
}

func countFailedTriageToolCalls(calls []SlackTriageToolCall) int {
	var failures int
	for _, call := range calls {
		if !call.Success {
			failures++
		}
	}
	return failures
}

func renderTriageAssistantTrace(history []triageAssistantTurn, fallback string) string {
	var lines []string
	var turnIndex int
	for _, turn := range history {
		if !strings.EqualFold(turn.Role, "assistant") {
			continue
		}
		turnIndex++
		lines = append(lines, fmt.Sprintf("Assistant turn %d", turnIndex))
		if strings.TrimSpace(turn.Content) != "" {
			lines = append(lines, strings.TrimSpace(turn.Content))
		}
		if len(turn.ToolCalls) > 0 {
			lines = append(lines, "Tool calls:")
			for _, call := range turn.ToolCalls {
				payload, _ := json.Marshal(call.Arguments)
				lines = append(lines, fmt.Sprintf("- %s %s", call.Name, string(payload)))
			}
		}
	}
	if len(lines) == 0 && strings.TrimSpace(fallback) != "" {
		return strings.TrimSpace(fallback)
	}
	return strings.Join(lines, "\n")
}
