package slackagent

import (
	"context"
	"fmt"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
)

func (s *Service) TriageStatus(ctx context.Context, limit int) (SlackTriageStatus, error) {
	if limit <= 0 {
		limit = 10
	}
	runs, err := s.triage.ListRuns(ctx, limit)
	if err != nil {
		return SlackTriageStatus{}, err
	}
	actions, err := s.triage.ListPendingActions(ctx, limit)
	if err != nil {
		return SlackTriageStatus{}, err
	}
	brains, err := s.cognition.ListChannelBrains(ctx, limit)
	if err != nil {
		return SlackTriageStatus{}, err
	}
	return SlackTriageStatus{
		Enabled:           s.InboundStatus().EventBuffer.TriageEnabled,
		PostActions:       s.triagePostActions,
		HeuristicFallback: s.triageHeuristicFallback,
		LastTriageJobID:   s.InboundStatus().EventBuffer.LastTriageJobID,
		Runs:              runs,
		PendingActions:    actions,
		ChannelBrains:     brains,
	}, nil
}

func (s *Service) StartSlackTriage(ctx context.Context, channelID string, messages []SlackInboundMessage, digest string) (SlackTriageStartResult, error) {
	if s.runner == nil {
		return SlackTriageStartResult{}, fmt.Errorf("agent runner is not ready: %s", runnerErrorText(s.runnerErr))
	}
	messages = normalizeSlackInboundMessages(messages)
	workspaceID := firstNonEmpty(firstMessageTeamID(messages), "workspace")
	threadTS := firstNonEmpty(lastMessageThreadTS(messages), "channel-root")
	sessionID := fmt.Sprintf("triage:%s:%d", channelID, timeNow().UnixMilli())
	run, err := s.triage.RecordRun(ctx, SlackTriageContext{
		SessionID: sessionID,
		Status:    "pending",
		Summary:   fmt.Sprintf("Triage pending for %d Slack message(s) in %s", len(messages), channelID),
		Digest:    digest,
		Channels:  []string{channelID},
		Steps:     0,
	})
	if err != nil {
		return SlackTriageStartResult{}, err
	}

	channelBrain, _ := s.cognition.GetChannelBrain(ctx, workspaceID, channelID)
	previousRuns, _ := s.triage.ListRuns(ctx, 20)
	previous := filterTriageContextsForChannel(previousRuns, channelID)
	localMemory := slackTriageMemoryFromLocal(s.SearchLocalMemory(digest, 5), digest)
	prompt := buildSlackTriagePrompt(SlackTriagePromptInput{
		ChannelID:      channelID,
		Messages:       messages,
		Digest:         digest,
		ChannelBrain:   channelBrain,
		LocalMemory:    localMemory,
		PreviousTriage: formatTriageContexts(previous),
	})
	contextMap := map[string]any{
		"source":        "slack-triage",
		"sessionId":     sessionID,
		"session_id":    sessionID,
		"channelId":     channelID,
		"channel_id":    channelID,
		"workspaceId":   workspaceID,
		"workspace_id":  workspaceID,
		"threadTs":      threadTS,
		"thread_ts":     threadTS,
		"messageCount":  len(messages),
		"message_count": len(messages),
		"messages":      messages,
		"digest":        digest,
		"triageRunId":   run.ID,
		"triage_run_id": run.ID,
		"localSlackMemory": map[string]any{
			"results": localMemory,
			"query":   digest,
			"limit":   5,
		},
		"domainContext": map[string]any{
			"channelBrain": channelBrain,
			"recentThreads": func() []SlackThreadLedgerRecord {
				records, _ := s.cognition.ListRecentThreadLedgers(ctx, workspaceID, channelID, 8)
				return records
			}(),
		},
		"previousTriage": map[string]any{
			"workspaceId": workspaceID,
			"channelId":   channelID,
			"count":       len(previous),
			"text":        formatTriageContexts(previous),
		},
		"expectedOutput": "JSON triage decision with summary and actions[]",
	}
	job, err := s.runner.StartTask(ctx, agentrunner.WithSessionCapabilities(agentrunner.StartInput{
		Task:             prompt,
		Context:          contextMap,
		Mode:             "analysis",
		AllowCodeChanges: false,
	}, agentrunner.SessionKindTriage))
	if err != nil {
		return SlackTriageStartResult{Run: run}, err
	}
	s.inbound.SetLastTriageJob(job.ID)
	result := SlackTriageStartResult{Run: run, Job: job}
	if isTerminalJobStatus(job.Status) {
		finalization, err := s.finalizeSlackTriageJob(ctx, job)
		if err != nil {
			return result, err
		}
		result.Finalization = finalization
	}
	return result, nil
}

func (s *Service) recordSlackTriageOnly(ctx context.Context, channelID string, messages []SlackInboundMessage, digest string) (*SlackTriageContext, error) {
	return s.triage.RecordRun(ctx, SlackTriageContext{
		SessionID: fmt.Sprintf("buffer:%s:%d", channelID, s.InboundStatus().EventBuffer.Flushes),
		Status:    "recorded",
		Summary:   fmt.Sprintf("Buffered %d Slack message(s) for %s", len(messages), channelID),
		Digest:    digest,
		Channels:  []string{channelID},
		Steps:     0,
	})
}

func (s *Service) finalizeSlackTriageJob(ctx context.Context, job agentrunner.Job) (*SlackTriageFinalization, error) {
	if job.ID == "" {
		return nil, nil
	}
	s.triageMu.Lock()
	defer s.triageMu.Unlock()
	if result, ok := s.finalizedTriageResults[job.ID]; ok {
		return result, nil
	}
	s.finalizedTriageJobIDs[job.ID] = struct{}{}

	channelID := stringFromContext(job.Context, "channelId", "channel_id")
	workspaceID := firstNonEmpty(stringFromContext(job.Context, "workspaceId", "workspace_id"), "workspace")
	threadTS := firstNonEmpty(stringFromContext(job.Context, "threadTs", "thread_ts"), "channel-root")
	messages := messagesFromContext(job.Context["messages"])
	runID := int64FromContext(job.Context, "triageRunId", "triage_run_id")
	fallback := slackTriageFallback{Summary: fmt.Sprintf("Slack triage finished for %s.", channelID), Channel: channelID, ThreadTS: threadTS}
	if s.triageHeuristicFallback {
		fallback = suggestSlackTriageFallback(channelID, messages)
		fallback.Channel = firstNonEmpty(fallback.Channel, channelID)
		fallback.ThreadTS = firstNonEmpty(fallback.ThreadTS, threadTS)
	}

	rawOutput := firstNonEmpty(job.Result, job.Error)
	decision := parseSlackTriageDecision(rawOutput, fallback)
	ok := job.Status == agentrunner.StatusCompleted
	actions := decision.Actions
	if !ok {
		actions = nil
	}
	mutations, failures := reconcileTriageCounts(&triageCounters{mutations: len(actions)}, nil)
	if ok {
		var reason string
		ok, reason = triageDidSucceed(job.ID, mutations, failures, nil, rawOutput)
		if !ok {
			job.Error = reason
		}
	}
	runPatch := SlackTriageContext{
		ID:        runID,
		SessionID: stringFromContext(job.Context, "sessionId", "session_id"),
		Status:    "success",
		Summary:   decision.Summary,
		RawOutput: rawOutput,
		Digest:    stringFromContext(job.Context, "digest"),
		Channels:  []string{channelID},
		Actions:   triageActionRows(actions),
		ToolCalls: []SlackTriageToolCall{{
			Tool:    "agent_runner",
			Action:  "slack_triage",
			Args:    marshalTriageArgs(job.Provider, job.ID, decision.ParseOK),
			Success: ok,
			Brief:   mapBool(ok, "AgentRunner triage completed", "AgentRunner triage failed"),
			Result:  rawOutput,
		}},
		Steps:     1,
		Mutations: mutations,
		Failures:  failures,
	}
	if !ok {
		runPatch.Status = "failed"
		runPatch.Summary = "Triage failed: " + firstNonEmpty(job.Error, job.Result, string(job.Status))
		runPatch.Error = firstNonEmpty(job.Error, job.Result, string(job.Status), "triage_failed")
		runPatch.Failures = 1
	}
	updatedRun, err := s.triage.UpdateRun(ctx, runPatch)
	if err != nil {
		return nil, err
	}
	if ok && decision.Summary != "" {
		if _, err := s.cognition.UpsertChannelBrainSummary(ctx, workspaceID, channelID, decision.Summary); err != nil {
			s.logger.Warn("slack channel brain summary update failed", "error", err)
		}
	}
	pendingActions := s.insertSlackTriagePendingActions(ctx, workspaceID, channelID, threadTS, job.ID, updatedRun, actions)
	finalization := &SlackTriageFinalization{Run: updatedRun, Decision: decision, PendingActions: pendingActions}
	s.finalizedTriageResults[job.ID] = finalization
	return finalization, nil
}
