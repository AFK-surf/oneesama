package slackagent

func buildSlackDailyTriageMetrics(source string, runs []SlackTriageContext, customEmoji []string) SlackDailyTriageMetrics {
	custom := map[string]struct{}{}
	for _, name := range normalizeWorkspaceCustomEmojiNames(customEmoji) {
		custom[name] = struct{}{}
	}
	metrics := SlackDailyTriageMetrics{
		Source:         source,
		Available:      true,
		TopEmoji:       map[string]int{},
		TopCustomEmoji: map[string]int{},
	}
	for _, run := range runs {
		metrics.Runs++
		recoveredProviderFailure := false
		if _, ok := triageQualityRunRecoveredProviderFailure(run, runs); ok {
			recoveredProviderFailure = true
			metrics.RecoveredProviderFailures++
		}
		if slackTriageRunFailed(run) && !recoveredProviderFailure {
			metrics.FailedRuns++
			metrics.FailedSamples = appendLimitedString(metrics.FailedSamples, slackDailyReportRunSample(run, firstNonEmpty(run.Error, run.Summary, "failed")), 8)
		}
		if run.Mutations > 0 {
			metrics.MutatingRuns++
		}
		metrics.Mutations += run.Mutations
		if len(run.Actions) == 0 && run.Mutations == 0 {
			metrics.NoActionRuns++
			metrics.SkippedSamples = appendLimitedString(metrics.SkippedSamples, slackDailyReportRunSample(run, firstNonEmpty(run.Summary, "no visible action")), 8)
		}
		if slackTriageRunParseFallback(run) {
			metrics.ParseFallbacks++
		}
		if slackDailyReportPlaceholderSummary(run) {
			metrics.PlaceholderSummaries++
		}
		if slackDailyReportInvalidPersonaJSON(run) {
			metrics.InvalidPersonaJSON++
		}
		inputChars := intFromAny(run.Metadata["input_context_chars"])
		if value := intFromAny(run.Metadata["context_budget_total_tokens"]); value > metrics.MaxContextBudgetTokens {
			metrics.MaxContextBudgetTokens = value
		}
		if value := intFromAny(run.Metadata["context_budget_dynamic_tokens"]); value > metrics.MaxDynamicContextTokens {
			metrics.MaxDynamicContextTokens = value
		}
		if value := intFromAny(run.Metadata["context_budget_worker_result_tokens"]); value > metrics.MaxWorkerResultTokens {
			metrics.MaxWorkerResultTokens = value
		}
		if value := intFromAny(run.Metadata["context_budget_memory_evidence_tokens"]); value > metrics.MaxMemoryEvidenceTokens {
			metrics.MaxMemoryEvidenceTokens = value
		}
		externalLinks := intFromAny(run.Metadata["external_links_fetched"])
		if externalLinks > 0 {
			metrics.LinkContextRuns++
		}
		// Task #285 follow-up #3: when the no-action summary describes another
		// agent already handling the thread, count it under the info-tier
		// HandledByOtherNoAction bucket and skip the review-tier high-context
		// / link-context / low-confidence / intent-mismatch buckets so review
		// queues stay focused on real "something might be wrong" candidates.
		directedToActiveAgent := false
		if len(run.Actions) == 0 && run.Mutations == 0 {
			_, directedToActiveAgent = triageQualityRunDirectedToActiveAgent(run)
		}
		handledByOther := len(run.Actions) == 0 && run.Mutations == 0 && !directedToActiveAgent && triageQualityRunIsHandledByOther(run.Summary) != ""
		dynamicContextIssue := len(run.Actions) == 0 && run.Mutations == 0
		if _, ok := triageQualityRunDynamicContextIssue(run); !ok {
			dynamicContextIssue = false
		}
		delegateStartedPending := false
		if evidence, ok := triageQualityRunDelegateNoVisibleAction(run); ok && !triageQualityDelegateNeedsOperatorReview(evidence) {
			delegateStartedPending = true
		}
		if dynamicContextIssue {
			metrics.DynamicContextIssues++
		}
		if handledByOther {
			metrics.HandledByOtherNoAction++
		}
		if directedToActiveAgent {
			metrics.DirectedToActiveAgentNoAction++
		}
		if !dynamicContextIssue && !directedToActiveAgent && !handledByOther && !delegateStartedPending && !recoveredProviderFailure {
			if inputChars >= triageQualityHighContextInputCharsThreshold && len(run.Actions) == 0 && run.Mutations == 0 {
				metrics.HighContextNoAction++
			}
			if externalLinks > 0 && len(run.Actions) == 0 && run.Mutations == 0 {
				metrics.LinkContextNoAction++
			}
			if slackDailyReportLowConfidenceNoAction(run) {
				metrics.LowConfidenceNoAction++
			}
			if len(run.Actions) == 0 && run.Mutations == 0 {
				// Bucket precedence matches buildSlackTriageReviewBuckets:
				// delegate_no_visible_action takes priority over the
				// summary-narrative intent_action_mismatch bucket.
				if evidence, ok := triageQualityRunDelegateNoVisibleAction(run); ok && triageQualityDelegateNeedsOperatorReview(evidence) {
					metrics.DelegateNoVisibleAction++
				} else if triageQualityIntentActionMismatchMatch(run.Summary) != "" {
					metrics.IntentActionMismatch++
				}
			}
		}
		if raw, ok := mapFromAny(run.Metadata["persona_foreground"]); ok {
			metrics.PersonaRuns++
			if !boolFromAny(raw["success"], false) && !recoveredProviderFailure {
				metrics.PersonaFailures++
			}
		}
		metrics.DelegateWorkerJobs += intFromAny(run.Metadata["delegate_worker_jobs_started"])
		replyRun := false
		reactionRun := false
		customReactionRun := false
		for _, action := range run.Actions {
			if slackDailyReportActionIsReply(action.Tool) {
				replyRun = true
				metrics.ReplySamples = appendLimitedString(metrics.ReplySamples, slackDailyReportRunSample(run, firstNonEmpty(action.Brief, run.Summary, "posted reply")), 8)
			}
			if slackDailyReportActionIsReaction(action.Tool) {
				reactionRun = true
				metrics.ReactionSamples = appendLimitedString(metrics.ReactionSamples, slackDailyReportRunSample(run, firstNonEmpty(action.Brief, run.Summary, "added reaction")), 8)
				for _, emoji := range slackDailyReportExtractEmoji(action.Brief) {
					metrics.ReactionMutations++
					metrics.TopEmoji[emoji]++
					if _, ok := custom[emoji]; ok {
						customReactionRun = true
						metrics.CustomEmojiUses++
						metrics.TopCustomEmoji[emoji]++
					}
				}
			}
		}
		for _, call := range run.ToolCalls {
			metrics.ToolCalls++
			if slackDailyReportToolCallIsMemoryLookup(call) {
				metrics.MemoryLookups++
			}
			if slackDailyReportToolCallIsExternalSearch(call) {
				metrics.ExternalSearches++
			}
			if slackDailyReportToolCallIsThreadFetch(call) {
				metrics.ThreadFetches++
			}
			if slackDailyReportActionIsReply(firstNonEmpty(call.Action, call.Tool)) {
				replyRun = true
				metrics.ReplySamples = appendLimitedString(metrics.ReplySamples, slackDailyReportRunSample(run, firstNonEmpty(call.Brief, run.Summary, "posted reply")), 8)
			}
			if slackDailyReportActionIsReaction(firstNonEmpty(call.Action, call.Tool)) && call.Success {
				reactionRun = true
				metrics.ReactionSamples = appendLimitedString(metrics.ReactionSamples, slackDailyReportRunSample(run, firstNonEmpty(call.Brief, call.Result, run.Summary, "added reaction")), 8)
				emojis := slackDailyReportExtractEmoji(call.Brief)
				if len(emojis) == 0 {
					emojis = slackDailyReportExtractEmoji(call.Result)
				}
				for _, emoji := range emojis {
					metrics.ReactionMutations++
					metrics.TopEmoji[emoji]++
					if _, ok := custom[emoji]; ok {
						customReactionRun = true
						metrics.CustomEmojiUses++
						metrics.TopCustomEmoji[emoji]++
					}
				}
			}
		}
		if replyRun {
			metrics.ReplyRuns++
			if externalLinks > 0 {
				metrics.LinkReplies++
			}
		}
		if reactionRun {
			metrics.ReactionRuns++
		}
		if customReactionRun {
			metrics.CustomEmojiRuns++
		}
	}
	metrics.TopEmoji = topNStringInt(metrics.TopEmoji, 8)
	metrics.TopCustomEmoji = topNStringInt(metrics.TopCustomEmoji, 8)
	return metrics
}

func compareSlackDailyTriageMetrics(newMetrics SlackDailyTriageMetrics, legacy SlackDailyTriageMetrics) SlackDailyTriageComparison {
	return SlackDailyTriageComparison{
		RunDelta:              newMetrics.Runs - legacy.Runs,
		ReplyRunDelta:         newMetrics.ReplyRuns - legacy.ReplyRuns,
		ReactionRunDelta:      newMetrics.ReactionRuns - legacy.ReactionRuns,
		CustomEmojiUseDelta:   newMetrics.CustomEmojiUses - legacy.CustomEmojiUses,
		FailureDelta:          newMetrics.FailedRuns - legacy.FailedRuns,
		NewReplyRate:          ratioPercent(newMetrics.ReplyRuns, newMetrics.Runs),
		LegacyReplyRate:       ratioPercent(legacy.ReplyRuns, legacy.Runs),
		NewReactionRate:       ratioPercent(newMetrics.ReactionRuns, newMetrics.Runs),
		LegacyReactionRate:    ratioPercent(legacy.ReactionRuns, legacy.Runs),
		NewCustomEmojiRate:    ratioPercent(newMetrics.CustomEmojiUses, maxInt(newMetrics.ReactionMutations, 1)),
		LegacyCustomEmojiRate: ratioPercent(legacy.CustomEmojiUses, maxInt(legacy.ReactionMutations, 1)),
	}
}

func buildSlackDailyReportFlags(report SlackDailyReport) []SlackDailyReportFlag {
	var flags []SlackDailyReportFlag
	if !report.Legacy.Available {
		flags = append(flags, SlackDailyReportFlag{Level: "yellow", Code: "legacy_unavailable", Message: "Legacy slackd source is unavailable; daily comparison is partial."})
	}
	if report.New.FailedRuns > 0 || report.New.InvalidPersonaJSON > 0 || report.New.PlaceholderSummaries > 0 {
		flags = append(flags, SlackDailyReportFlag{Level: "red", Code: "new_triage_quality_red", Message: "New Oneesama had failed/invalid/placeholder triage samples."})
	}
	if report.New.Runs > 0 && report.Legacy.Available && report.Legacy.ReactionRuns > 0 && report.New.ReactionRuns == 0 {
		flags = append(flags, SlackDailyReportFlag{Level: "yellow", Code: "reaction_gap", Message: "Legacy slackd used emoji reactions but new Oneesama did not in this window."})
	}
	if report.New.ReactionRuns > 0 && report.New.CustomEmojiUses == 0 && len(report.New.TopEmoji) > 0 {
		flags = append(flags, SlackDailyReportFlag{Level: "yellow", Code: "custom_emoji_gap", Message: "New Oneesama reacted but did not use workspace custom emoji."})
	}
	if report.New.LinkContextNoAction > 0 {
		flags = append(flags, SlackDailyReportFlag{Level: "yellow", Code: "link_context_no_action", Message: "Some fetched-link triage samples stayed silent; review whether workspace commentary should have fired."})
	}
	if report.New.DynamicContextIssues > 0 {
		flags = append(flags, SlackDailyReportFlag{Level: "yellow", Code: "dynamic_context_issue", Message: "Some persona runs had missing, incomplete, or stale dynamic context envelopes."})
	}
	if report.New.DelegateNoVisibleAction > 0 {
		flags = append(flags, SlackDailyReportFlag{Level: "yellow", Code: "delegate_no_visible_action", Message: "Some persona delegate_worker decisions had no visible downstream worker action in triage audit."})
	}
	return flags
}
