package slackagent

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
)

const (
	slackWorkerToolRequestStart   = "<oneesama_tool_request>"
	slackWorkerToolRequestEnd     = "</oneesama_tool_request>"
	slackWorkerToolLoopContextKey = "slack_worker_tool_loop_count"
	slackWorkerToolLoopMax        = 2
	slackWorkerToolCallsMax       = 4
)

type slackWorkerToolBridgeRequest struct {
	Calls  []SlackToolCallRequest `json:"calls"`
	Reason string                 `json:"reason,omitempty"`
}

func (s *Service) handleSlackWorkerToolRequest(ctx context.Context, job agentrunner.Job) bool {
	if job.Status != agentrunner.StatusCompleted {
		return false
	}
	request, ok := parseSlackWorkerToolBridgeRequest(job.Result)
	if !ok {
		return false
	}
	if s.runner == nil {
		s.postSlackWorkerToolBridgeFailure(ctx, job, "runner_not_available")
		return true
	}
	if slackWorkerToolLoopCount(job.Context) >= slackWorkerToolLoopMax {
		s.postSlackWorkerToolBridgeFailure(ctx, job, "tool_loop_limit_reached")
		return true
	}
	evidence := s.executeSlackWorkerToolBridgeRequest(ctx, request, job.Context)
	nextContext := slackWorkerToolContinuationContext(job.Context, evidence)
	nextTask := slackWorkerToolContinuationTask(job, request)
	_, err := s.runner.StartTask(ctx, agentrunner.WithSessionCapabilities(agentrunner.StartInput{
		Task:             nextTask,
		Context:          nextContext,
		Mode:             job.Mode,
		AllowCodeChanges: job.AllowCodeChanges,
	}, agentrunner.SessionKindSlack))
	if err != nil {
		s.postSlackWorkerToolBridgeFailure(ctx, job, err.Error())
		return true
	}
	if ref, refOK := slackRefForWorkerJob(job); refOK {
		s.scheduleAssistantThreadStatus(ctx, ref, "Working with tool evidence...", false)
	}
	return true
}

func parseSlackWorkerToolBridgeRequest(text string) (slackWorkerToolBridgeRequest, bool) {
	text = strings.TrimSpace(text)
	start := strings.Index(text, slackWorkerToolRequestStart)
	if start < 0 {
		return slackWorkerToolBridgeRequest{}, false
	}
	start += len(slackWorkerToolRequestStart)
	end := strings.Index(text[start:], slackWorkerToolRequestEnd)
	if end < 0 {
		return slackWorkerToolBridgeRequest{}, false
	}
	raw := strings.TrimSpace(text[start : start+end])
	if raw == "" {
		return slackWorkerToolBridgeRequest{}, false
	}
	var request slackWorkerToolBridgeRequest
	if err := json.Unmarshal([]byte(raw), &request); err != nil {
		return slackWorkerToolBridgeRequest{}, false
	}
	if len(request.Calls) == 0 {
		return slackWorkerToolBridgeRequest{}, false
	}
	if len(request.Calls) > slackWorkerToolCallsMax {
		request.Calls = request.Calls[:slackWorkerToolCallsMax]
	}
	return request, true
}

func (s *Service) executeSlackWorkerToolBridgeRequest(ctx context.Context, request slackWorkerToolBridgeRequest, workerContext map[string]any) []SlackAppMentionToolEvidence {
	out := make([]SlackAppMentionToolEvidence, 0, len(request.Calls))
	for _, call := range request.Calls {
		call.Tool = firstNonEmpty(call.Tool, call.Name)
		call.Tool = strings.TrimSpace(call.Tool)
		call.Role = firstNonEmpty(call.Role, slackAPIRoleAssistant)
		if call.Args == nil {
			call.Args = map[string]any{}
		}
		evidence := SlackAppMentionToolEvidence{
			Tool: call.Tool,
			Args: call.Args,
		}
		if reason := slackWorkerToolBridgeRequestRejection(call); reason != "" {
			evidence.Error = reason
			out = append(out, evidence)
			continue
		}
		response, err := s.ExecuteSlackTool(ctx, call)
		evidence.OK = response.OK && err == nil
		if err != nil {
			evidence.Error = err.Error()
			out = append(out, evidence)
			continue
		}
		if !response.OK {
			evidence.Error = firstNonEmpty(response.Error, response.Text, "tool_failed")
		}
		evidence.Summary = slackToolEvidenceSummary(response)
		evidence.Text = response.Text
		out = append(out, evidence)
	}
	s.recordAppMentionMultimodalMemory(ctx, slackAppMentionFromContextMap(workerContext), out, "worker_tool_bridge")
	return out
}

func slackWorkerToolBridgeRequestRejection(call SlackToolCallRequest) string {
	switch call.Tool {
	case "read_doc", "memory_search", "memory_get", "memory_write", "person_memory", "exa_search", "exa_contents", "runtime_status", "heartbeat_log", "suggest_action":
		return ""
	case "slack_api":
		method := stringFromAny(call.Args["method"])
		action := stringFromAny(call.Args["action"])
		resolved, _, err := resolveSlackAPIOperation(action, method)
		if err != nil {
			return err.Error()
		}
		switch resolved {
		case "fetch_thread", "fetch_channel_history", "fetch_canvas", "fetch_image", "fetch_file", "create_canvas", "edit_canvas":
			return ""
		default:
			return "slack_api action " + resolved + " is not available through the app_mention worker tool bridge"
		}
	default:
		return "tool " + firstNonEmpty(call.Tool, call.Name, "unknown") + " is not available through the app_mention worker tool bridge"
	}
}

func slackWorkerToolContinuationContext(context map[string]any, evidence []SlackAppMentionToolEvidence) map[string]any {
	next := cloneSlackWorkerContext(context)
	count := slackWorkerToolLoopCount(next) + 1
	next[slackWorkerToolLoopContextKey] = count
	formatted := strings.TrimSpace(formatSlackAppMentionToolEvidence(evidence))
	if formatted == "" {
		formatted = "No dispatcher evidence was returned."
	}
	existing := strings.TrimSpace(stringFromAny(next["slackToolEvidence"]))
	section := fmt.Sprintf("Worker-requested dispatcher evidence (pass %d):\n%s", count, formatted)
	if existing != "" {
		next["slackToolEvidence"] = existing + "\n\n" + section
	} else {
		next["slackToolEvidence"] = section
	}
	if mention, ok := next["slackAppMention"].(*SlackAppMentionContext); ok && mention != nil {
		copied := *mention
		copied.ToolEvidence = append(append([]SlackAppMentionToolEvidence(nil), mention.ToolEvidence...), evidence...)
		next["slackAppMention"] = &copied
	}
	return next
}

func cloneSlackWorkerContext(context map[string]any) map[string]any {
	if len(context) == 0 {
		return map[string]any{}
	}
	next := make(map[string]any, len(context))
	for key, value := range context {
		next[key] = value
	}
	return next
}

func slackWorkerToolContinuationTask(job agentrunner.Job, request slackWorkerToolBridgeRequest) string {
	reason := strings.TrimSpace(request.Reason)
	if reason == "" {
		reason = "the previous worker requested first-class dispatcher evidence"
	}
	return strings.Join([]string{
		"Continue the Slack thread reply using the newly injected dispatcher evidence.",
		"Do not repeat the same tool request unless one additional different tool result is essential.",
		"Reason for tool request: " + reason,
		"Original task: " + strings.TrimSpace(job.Task),
	}, "\n")
}

func slackWorkerToolLoopCount(context map[string]any) int {
	if len(context) == 0 {
		return 0
	}
	return intFromAny(context[slackWorkerToolLoopContextKey])
}

func (s *Service) postSlackWorkerToolBridgeFailure(ctx context.Context, job agentrunner.Job, reason string) {
	ref, ok := slackRefForWorkerJob(job)
	if !ok {
		return
	}
	if strings.TrimSpace(reason) != "" {
		s.logger.Warn("slack worker tool bridge failed", "job_id", job.ID, "reason", reason)
	}
	s.scheduleAssistantThreadStatus(ctx, ref, "", true)
	s.finishMentionReaction(ctx, ref, slackReactionWarn)
}
