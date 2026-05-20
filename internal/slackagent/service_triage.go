package slackagent

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
)

const (
	slackTriageStatusDefaultLimit         = 100
	slackTriageLowContextCharThreshold    = 200
	slackTriageAuditDefaultWindow         = 6 * time.Hour
	slackTriageAuditStaleSampleAfter      = 2 * time.Hour
	slackTriageForegroundQueuedStaleAfter = 2 * time.Minute

	slackTriageForegroundChainCodexOnly   = "codex_only"
	slackTriageForegroundChainCodexThenPi = "codex_then_pi"
	slackTriageForegroundChainPiFirstLive = "pi_first_live"
)

func normalizeSlackTriageForegroundChain(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case slackTriageForegroundChainCodexOnly:
		return slackTriageForegroundChainCodexOnly
	case slackTriageForegroundChainPiFirstLive:
		return slackTriageForegroundChainPiFirstLive
	default:
		return slackTriageForegroundChainCodexThenPi
	}
}

func (s *Service) slackTriageForegroundChain() string {
	if s == nil {
		return slackTriageForegroundChainCodexThenPi
	}
	return normalizeSlackTriageForegroundChain(s.triageForegroundChain)
}

func (s *Service) piFirstForegroundLiveEnabled(probe bool) bool {
	return !probe && s.foregroundPersonaRuntimeEnabled() && s.slackTriageForegroundChain() == slackTriageForegroundChainPiFirstLive
}

func slackTriageForegroundChainAllowsPersona(value string) bool {
	return normalizeSlackTriageForegroundChain(value) != slackTriageForegroundChainCodexOnly
}

type slackTriageStartOptions struct {
	Probe                  bool
	IgnoreExistingBotReply bool
	ExtraMetadata          map[string]any
}

func (s *Service) StartSlackTriage(ctx context.Context, channelID string, messages []SlackInboundMessage, digest string) (SlackTriageStartResult, error) {
	return s.startSlackTriage(ctx, channelID, messages, digest, slackTriageStartOptions{})
}

func (s *Service) StartSlackTriageProbe(ctx context.Context) (SlackTriageStartResult, error) {
	now := timeNow().UTC()
	channelID := "C_TRIAGE_PROBE"
	threadTS := fmt.Sprintf("probe.%d", now.UnixMilli())
	messages := []SlackInboundMessage{{
		TeamID:    "T_TRIAGE_PROBE",
		ChannelID: channelID,
		UserID:    "U_TRIAGE_PROBE",
		Text:      "<@U_BOT> positive probe: please create a follow-up suggestion for verifying triage recall. Do not post a public reply.",
		TS:        threadTS,
	}}
	digest := renderSlackActivityDigest(channelID, messages)
	return s.startSlackTriage(ctx, channelID, messages, digest, slackTriageStartOptions{
		Probe: true,
		ExtraMetadata: map[string]any{
			"live_positive_probe": true,
			"probe_kind":          "maybe_follow_up",
			"skip_reason_bucket":  "",
		},
	})
}

func (s *Service) startSlackTriage(ctx context.Context, channelID string, messages []SlackInboundMessage, digest string, options slackTriageStartOptions) (SlackTriageStartResult, error) {
	foregroundChain := s.slackTriageForegroundChain()
	configuredPiFirstLive := !options.Probe && foregroundChain == slackTriageForegroundChainPiFirstLive
	if configuredPiFirstLive && !s.foregroundPersonaRuntimeEnabled() {
		return SlackTriageStartResult{}, fmt.Errorf("persona foreground runtime is not ready for pi_first_live")
	}
	piFirstLive := configuredPiFirstLive
	if !piFirstLive && s.runner == nil {
		return SlackTriageStartResult{}, fmt.Errorf("agent runner is not ready: %s", runnerErrorText(s.runnerErr))
	}
	messages = normalizeSlackInboundMessages(messages)
	workspaceID := firstNonEmpty(firstMessageTeamID(messages), "workspace")
	threadTS := firstNonEmpty(lastMessageThreadTS(messages), "channel-root")
	sessionID := fmt.Sprintf("triage:%s:%d", channelID, timeNow().UnixMilli())
	threadContexts := s.fetchSlackTriageThreadContexts(ctx, channelID, messages)
	var ignoredBotReplyCount int
	if options.IgnoreExistingBotReply {
		threadContexts, ignoredBotReplyCount = filterSlackTriageThreadContextBotReplies(threadContexts, []string{s.botUserID})
	}
	channelContexts := s.fetchSlackTriageChannelContexts(ctx, channelID, messages, digest, threadContexts)
	threadContexts, summaryMetadata := s.maybeSummarizeOversizedSlackTriageThreadContexts(ctx, channelID, threadTS, messages, digest, threadContexts)
	if len(channelContexts) > 0 {
		digest = renderSlackActivityDigestWithContext(channelID, channelContexts, messages)
	}
	if enriched := appendSlackTriageThreadContextDigest(digest, threadContexts); enriched != "" {
		digest = enriched
	}
	externalLinks := fetchSlackExternalLinkContexts(ctx, messages)
	workspacePolicyStatus := s.slackWorkspacePolicyStatus()
	auditMetadata := slackTriageAuditMetadata(digest, messages, threadContexts, channelContexts, externalLinks)
	auditMetadata = mergeStringAnyMaps(auditMetadata, summaryMetadata)
	auditMetadata = mergeStringAnyMaps(auditMetadata, slackWorkspacePolicyMetadataMap(workspacePolicyStatus))
	if options.IgnoreExistingBotReply {
		auditMetadata = mergeStringAnyMaps(auditMetadata, map[string]any{
			"ignore_existing_bot_reply":        true,
			"ignored_existing_bot_reply_count": ignoredBotReplyCount,
		})
	}
	auditMetadata = mergeStringAnyMaps(auditMetadata, map[string]any{
		"foreground_chain":             foregroundChain,
		"workspace_id":                 workspaceID,
		"channel_id":                   channelID,
		"thread_ts":                    threadTS,
		"session_id":                   sessionID,
		"pre_pi_agent_runner_started":  !piFirstLive,
		"persona_foreground_pi_first":  piFirstLive,
		"delegate_worker_jobs_started": 0,
	})
	auditMetadata = mergeStringAnyMaps(auditMetadata, options.ExtraMetadata)
	run, err := s.triage.RecordRun(ctx, SlackTriageContext{
		SessionID: sessionID,
		Status:    "pending",
		Summary:   fmt.Sprintf("Triage pending for %d Slack message(s) in %s", len(messages), channelID),
		Digest:    digest,
		Channels:  []string{channelID},
		Steps:     0,
		Metadata:  auditMetadata,
	})
	if err != nil {
		return SlackTriageStartResult{}, err
	}

	channelBrain, _ := s.cognition.GetChannelBrain(ctx, workspaceID, channelID)
	previousRuns := loadTriageContexts(s.triage, s.workspaceDir)
	previous := filterTriageContextsForChannel(previousRuns, channelID)
	memoryQuery := slackTriageRelatedMemoryQuery(messages, digest)
	localMemory := slackTriageMemoryFromLocal(s.SearchLocalMemory(memoryQuery, 5), memoryQuery)
	relatedMemory := s.searchSlackTriageRelatedMemory(memoryQuery, 5)
	if piFirstLive {
		request := BuildSlackTriagePiFirstForegroundRequest(SlackTriagePiFirstForegroundRequestInput{
			ChannelID:              channelID,
			ThreadTS:               threadTS,
			Messages:               messages,
			RelatedMemory:          relatedMemory.Results,
			Digest:                 digest,
			ExternalLinks:          externalLinks,
			ThreadContexts:         threadContexts,
			ChannelContexts:        channelContexts,
			PreviousTriage:         formatTriageContexts(previous),
			IgnoreExistingBotReply: options.IgnoreExistingBotReply,
			WorkspaceTriagePolicy:  s.triageWorkspacePolicy,
			WorkspacePolicyStatus:  workspacePolicyStatus,
			CustomEmoji:            s.workspaceCustomEmojiSnapshot(),
		})
		runPatch := *run
		runPatch.Summary = fmt.Sprintf("Pi-first foreground triage pending for %d Slack message(s) in %s", len(messages), channelID)
		runPatch.Metadata = mergeStringAnyMaps(run.Metadata, map[string]any{
			"persona_foreground_queued": true,
			"expectedOutput":            "Pi persona decision with optional delegate_worker",
		})
		updatedRun, err := s.triage.UpdateRun(ctx, runPatch)
		if err != nil {
			return SlackTriageStartResult{Run: run}, err
		}
		if updatedRun != nil {
			persistTriageContext(s.workspaceDir, *updatedRun)
			run = updatedRun
		}
		if !s.queueSlackTriagePersonaForegroundRequest(context.WithoutCancel(ctx), workspaceID, run.ID, channelID, threadTS, messages, request, options.IgnoreExistingBotReply) {
			return SlackTriageStartResult{Run: run}, fmt.Errorf("persona foreground runtime is not ready")
		}
		return SlackTriageStartResult{Run: run}, nil
	}
	prompt := buildSlackTriagePrompt(SlackTriagePromptInput{
		ChannelID:              channelID,
		Messages:               messages,
		Digest:                 digest,
		ChannelBrain:           channelBrain,
		LocalMemory:            localMemory,
		RelatedMemory:          relatedMemory.Results,
		PreviousTriage:         formatTriageContexts(previous),
		ExternalLinks:          externalLinks,
		ThreadContexts:         threadContexts,
		IgnoreExistingBotReply: options.IgnoreExistingBotReply,
		WorkspacePolicy:        s.triageWorkspacePolicy,
		WorkspacePolicyStatus:  workspacePolicyStatus,
		CustomEmoji:            s.workspaceCustomEmojiSnapshot(),
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
			"query":   memoryQuery,
			"limit":   5,
		},
		"relatedMemory": relatedMemory,
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
		"externalLinks":               externalLinks,
		"workspaceTriagePolicy":       s.triageWorkspacePolicy,
		"workspace_triage_policy":     s.triageWorkspacePolicy,
		"workspaceTriagePolicyStatus": workspacePolicyStatus,
		"workspace_triage_policy_status": map[string]any{
			"configured":   workspacePolicyStatus.Configured,
			"source":       workspacePolicyStatus.Source,
			"version":      workspacePolicyStatus.Version,
			"hash":         workspacePolicyStatus.Hash,
			"length_chars": workspacePolicyStatus.LengthChars,
		},
		"workspaceTriagePolicySource":     workspacePolicyStatus.Source,
		"workspace_triage_policy_source":  workspacePolicyStatus.Source,
		"workspaceTriagePolicyVersion":    workspacePolicyStatus.Version,
		"workspace_triage_policy_version": workspacePolicyStatus.Version,
		"workspaceTriagePolicyHash":       workspacePolicyStatus.Hash,
		"workspace_triage_policy_hash":    workspacePolicyStatus.Hash,
		"workspaceCustomEmoji":            s.workspaceCustomEmojiSnapshot(),
		"workspace_custom_emoji":          s.workspaceCustomEmojiSnapshot(),
		"threadContexts":                  threadContexts,
		"channelContexts":                 channelContexts,
		"triageAudit":                     auditMetadata,
		"foregroundChain":                 foregroundChain,
		"foreground_chain":                foregroundChain,
		"prePiAgentRunnerStarted":         true,
		"pre_pi_agent_runner_started":     true,
		"triageProbe":                     options.Probe,
		"ignoreExistingBotReply":          options.IgnoreExistingBotReply,
		"ignore_existing_bot_reply":       options.IgnoreExistingBotReply,
		"expectedOutput":                  "JSON triage decision with summary and actions[]",
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
	run, err := s.triage.RecordRun(ctx, SlackTriageContext{
		SessionID: fmt.Sprintf("buffer:%s:%d", channelID, s.InboundStatus().EventBuffer.Flushes),
		Status:    "recorded",
		Summary:   fmt.Sprintf("Buffered %d Slack message(s) for %s", len(messages), channelID),
		Digest:    digest,
		Channels:  []string{channelID},
		Steps:     0,
	})
	if run != nil {
		persistTriageContext(s.workspaceDir, *run)
	}
	return run, err
}

func slackTriageRelatedMemoryQuery(messages []SlackInboundMessage, digest string) string {
	messages = normalizeSlackInboundMessages(messages)
	lines := make([]string, 0, len(messages))
	for _, message := range messages {
		text := strings.TrimSpace(message.Text)
		if text == "" {
			continue
		}
		lines = append(lines, text)
		for _, file := range message.Files {
			fileText := strings.TrimSpace(strings.Join([]string{file.Title, file.Name, file.Mimetype, file.Filetype}, " "))
			if fileText != "" {
				lines = append(lines, fileText)
			}
		}
	}
	if query := strings.TrimSpace(strings.Join(lines, "\n")); query != "" {
		return query
	}
	return strings.TrimSpace(digest)
}
