package slackagent

import "strings"

func buildSlackTriageAuditFixtures() []SlackTriageAuditFixture {
	type fixture struct {
		name     string
		expected string
		raw      string
	}
	fixtures := []fixture{
		{
			name:     "act_post_thread_reply",
			expected: "ACT",
			raw:      `{"summary":"用户明确 @ bot 请求一个短回复。","actions":[{"type":"post_thread_reply","title":"短回复","message":"收到，我来跟进。","channelId":"C_AUDIT","threadTs":"123.456","confidence":0.9,"requiresConfirmation":false}]}`,
		},
		{
			name:     "maybe_follow_up",
			expected: "MAYBE",
			raw:      `{"summary":"用户提出需要后续确认的事项。","actions":[{"type":"follow_up","title":"确认 owner","message":"确认 owner 并跟进阻塞事项。","channelId":"C_AUDIT","threadTs":"123.456","confidence":0.8,"requiresConfirmation":true}]}`,
		},
		{
			name:     "synthesis_link_reply",
			expected: "ACT",
			raw:      `{"summary":"分享的长文链接值得轻量读后感。","actions":[{"type":"post_thread_reply","title":"链接初步看法","message":"我粗读了一下，这篇文章的核心是把模型能力和可验证机制分开看。","channelId":"C_AUDIT","threadTs":"123.456","confidence":0.7,"requiresConfirmation":false}]}`,
		},
		{
			name:     "skip_no_action",
			expected: "SKIP",
			raw:      "No action.\n\n闲聊自然收尾，无需助手介入。",
		},
		{
			name:     "skip_malformed_no_action_unescaped_cjk_quotes",
			expected: "SKIP",
			raw:      `{"summary":"No action. 用户只是说"蹲"一下，暂时不用接话。","actions":[]}`,
		},
		{
			name:     "skip_no_action_cjk_punctuation",
			expected: "SKIP",
			raw:      "【无需操作】这条只是“蹲一下 / 围观”，没有明确请求；继续观察。",
		},
	}
	results := make([]SlackTriageAuditFixture, 0, len(fixtures))
	for _, item := range fixtures {
		decision := parseSlackTriageDecision(item.raw, slackTriageFallback{Summary: "fixture fallback", Channel: "C_AUDIT", ThreadTS: "123.456"})
		outcome, mutations := slackTriageAuditFixtureOutcome(decision.Actions)
		results = append(results, SlackTriageAuditFixture{
			Name:             item.name,
			Expected:         item.expected,
			Outcome:          outcome,
			Pass:             decision.ParseOK && outcome == item.expected,
			ParseOK:          decision.ParseOK,
			Actions:          len(decision.Actions),
			Mutations:        mutations,
			SuppressedReason: slackTriageSuppressedReason(decision, decision.Actions, true),
			Summary:          decision.Summary,
		})
	}
	results = append(results, buildSlackMemoryBackedTriageAuditFixtures()...)
	return results
}

func buildSlackMemoryBackedTriageAuditFixtures() []SlackTriageAuditFixture {
	const category = "memory_backed_triage"
	fixtures := []SlackTriageAuditFixture{}

	ahaRecord := SlackRelatedMemoryRecord{
		Kind:       "team_question",
		SourcePath: "memory/team/questions/bridge-memory.md",
		StartLine:  3,
		EndLine:    5,
		Content:    "Bridge memory Aha moments should answer with related-topic recall evidence and cite the source lines.",
		Score:      0.72,
	}
	ahaPrompt := buildSlackTriagePrompt(SlackTriagePromptInput{
		ChannelID:     "C_AUDIT",
		Digest:        "为什么 bridge memory 没接住 Aha Moment?",
		RelatedMemory: []SlackRelatedMemoryRecord{ahaRecord},
	})
	ahaCitation := slackRelatedMemoryCitation(ahaRecord)
	ahaPass := strings.Contains(ahaPrompt, "Related memory evidence") &&
		strings.Contains(ahaPrompt, "cite source path/lines") &&
		strings.Contains(ahaPrompt, ahaCitation)
	fixtures = append(fixtures, SlackTriageAuditFixture{
		Name:     "aha_unanswered_question_with_recent_memory",
		Category: category,
		Expected: "prompt_cites_related_memory",
		Outcome:  boolOutcome(ahaPass, "prompt_cites_related_memory", "missing_related_memory_citation"),
		Pass:     ahaPass,
		ParseOK:  true,
		Summary:  "Aha-style unanswered questions must enter the triage prompt with source-cited related memory evidence.",
		Evidence: []string{ahaCitation},
	})

	delayedEvidence := formatSlackRelatedMemoryEvidence([]SlackRelatedMemoryRecord{ahaRecord}, 3)
	delayedFooter := renderRelatedMemoryEvidenceFooter(delayedEvidence, "这个问题等了一阵子还没人接，我补一个相关记忆。")
	delayedPass := strings.Contains(delayedFooter, ahaCitation) && strings.Contains(delayedFooter, "记忆")
	fixtures = append(fixtures, SlackTriageAuditFixture{
		Name:     "delayed_no_reply_uses_memory_before_reply",
		Category: category,
		Expected: "footer_cites_related_memory",
		Outcome:  boolOutcome(delayedPass, "footer_cites_related_memory", "missing_delayed_memory_footer"),
		Pass:     delayedPass,
		ParseOK:  true,
		Summary:  "Delayed no-reply surfaces must attach cited memory evidence when memory exists.",
		Evidence: []string{ahaCitation},
	})

	readyCandidate := SlackBackfillCandidate{
		ChannelID:      "C_AUDIT",
		ThreadTS:       "123.456",
		OriginatorTS:   "123.456",
		Classification: "unanswered_question",
		Title:          "unanswered architecture question",
		OriginalText:   "Pi-style persona runtime 和 Go 周边应该怎么切边界？",
		Draft:          "可以先把 persona runtime 做成 sidecar，Go 保留 IO 和调度。",
	}
	noMemory := EnrichBackfillCandidatesWithRelatedMemory([]SlackBackfillCandidate{readyCandidate}, nil, 3)
	noMemoryOutcome := ""
	if len(noMemory) > 0 {
		noMemoryOutcome = noMemory[0].ReviewStatus
	}
	fixtures = append(fixtures, SlackTriageAuditFixture{
		Name:     "backfill_review_ready_requires_memory_or_agent_read",
		Category: category,
		Expected: BackfillReviewNeedsContext,
		Outcome:  noMemoryOutcome,
		Pass:     noMemoryOutcome == BackfillReviewNeedsContext,
		ParseOK:  true,
		Summary:  "Backfill must not mark a reply review_ready without related memory evidence or delegated agent read evidence.",
	})

	weakMemory := EnrichBackfillCandidatesWithRelatedMemory([]SlackBackfillCandidate{readyCandidate}, func(string) SlackRelatedMemorySearchResult {
		return SlackRelatedMemorySearchResult{
			Status: "ok",
			Results: []SlackRelatedMemoryRecord{{
				Kind:       "daily_note",
				SourcePath: "memory/2026-05-01.md",
				StartLine:  10,
				Content:    "A weak unrelated note about flaky tests.",
				Score:      0.1,
			}},
		}
	}, 3)
	weakOutcome := ""
	if len(weakMemory) > 0 {
		weakOutcome = weakMemory[0].ReviewStatus
	}
	fixtures = append(fixtures, SlackTriageAuditFixture{
		Name:     "weak_memory_hit_stays_needs_context",
		Category: category,
		Expected: BackfillReviewNeedsContext,
		Outcome:  weakOutcome,
		Pass:     weakOutcome == BackfillReviewNeedsContext,
		ParseOK:  true,
		Summary:  "Weak lexical memory hits are not enough to turn a backfill lead into a postable reply.",
	})

	personRecord := SlackRelatedMemoryRecord{
		Kind:       "person_profile",
		SourcePath: "memory/people/he-jiachen.md",
		StartLine:  2,
		EndLine:    6,
		Content:    "He Jiachen previously asked about related-topic recall; answer with evidence rather than a generic opinion.",
		Score:      0.81,
		Reasons:    []string{"family_boost:person_profile"},
	}
	withMemory := EnrichBackfillCandidatesWithRelatedMemory([]SlackBackfillCandidate{readyCandidate}, func(string) SlackRelatedMemorySearchResult {
		return SlackRelatedMemorySearchResult{Status: "ok", Results: []SlackRelatedMemoryRecord{personRecord}}
	}, 3)
	personCitation := slackRelatedMemoryCitation(personRecord)
	personOutcome := ""
	personEvidenceOK := false
	if len(withMemory) > 0 {
		personOutcome = withMemory[0].ReviewStatus
		personEvidenceOK = len(withMemory[0].RelatedMemory) == 1 &&
			strings.Contains(formatSlackRelatedMemoryEvidence(withMemory[0].RelatedMemory, 3), personCitation)
	}
	personPass := personOutcome == BackfillReviewReady && personEvidenceOK
	fixtures = append(fixtures, SlackTriageAuditFixture{
		Name:     "person_project_memory_cites_source",
		Category: category,
		Expected: BackfillReviewReady,
		Outcome:  personOutcome,
		Pass:     personPass,
		ParseOK:  true,
		Summary:  "Person/project memory can make a candidate review_ready only when the report carries source path and line citations.",
		Evidence: []string{personCitation},
	})

	return fixtures
}

func boolOutcome(pass bool, success string, failure string) string {
	if pass {
		return success
	}
	return failure
}

func slackTriageAuditFixtureOutcome(actions []SlackTriageDecisionAction) (string, int) {
	if len(actions) == 0 {
		return "SKIP", 0
	}
	mutations := 0
	for _, action := range actions {
		if slackTriageDirectReplyAction(action) || slackTriageDirectReactionAction(action) {
			mutations++
		}
	}
	if mutations > 0 {
		return "ACT", mutations
	}
	return "MAYBE", 0
}
