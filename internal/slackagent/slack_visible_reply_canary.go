package slackagent

import "strings"

type slackVisibleReplyAllowListCanaryFixture struct {
	Name           string
	Action         SlackTriageDecisionAction
	ExpectedAllow  bool
	ExpectedReason string
}

func buildSlackVisibleReplyAllowListCanarySummary() SlackVisibleReplyAllowListCanarySummary {
	fixtures := slackVisibleReplyAllowListCanaryFixtures()
	out := SlackVisibleReplyAllowListCanarySummary{
		Total: len(fixtures),
		Cases: make([]SlackVisibleReplyAllowListCanaryCase, 0, len(fixtures)),
	}
	for _, fixture := range fixtures {
		verdict := slackVisibleReplyAllowListVerdictForAction(fixture.Action)
		actualReason := strings.TrimSpace(verdict.Reason)
		expectedReason := strings.TrimSpace(fixture.ExpectedReason)
		passed := verdict.Allowed == fixture.ExpectedAllow
		if expectedReason != "" && actualReason != expectedReason {
			passed = false
		}
		if passed {
			out.Passed++
		} else {
			out.Failed++
		}
		out.Cases = append(out.Cases, SlackVisibleReplyAllowListCanaryCase{
			Name:           fixture.Name,
			ExpectedAllow:  fixture.ExpectedAllow,
			ActualAllow:    verdict.Allowed,
			ExpectedReason: expectedReason,
			ActualReason:   actualReason,
			Passed:         passed,
		})
	}
	return out
}

func slackVisibleReplyAllowListCanaryFixtures() []slackVisibleReplyAllowListCanaryFixture {
	return []slackVisibleReplyAllowListCanaryFixture{
		{
			Name: "source_backed_hn_identity_lookup_allows",
			Action: SlackTriageDecisionAction{
				Type:    slackActionTypeThreadReply,
				Message: "Johnson8053 是队友 HN 小号；HN profile 显示 2024-09 注册、karma 33，历史发帖也集中在 affine/bridge 相关内容。",
				EvidenceAnchors: []SlackVisibleEvidenceAnchor{{
					Kind:      slackVisibleEvidenceKindFetchedLink,
					SourceRef: "https://news.ycombinator.com/user?id=Johnson8053",
					Quote:     "created: 2024-09 / karma: 33",
				}, {
					Kind:      slackVisibleEvidenceKindWorkspaceMemory,
					SourceRef: "memory/legacy/slack-agent-d/people/zanwei.md",
					Quote:     "Johnson8053 posts affine/bridge links",
				}},
			},
			ExpectedAllow:  true,
			ExpectedReason: slackVisibleReplyAllowReasonAllowed,
		},
		{
			Name: "source_backed_product_link_comment_allows",
			Action: SlackTriageDecisionAction{
				Type:    slackActionTypeThreadReply,
				Message: "这篇文章主要在讲 Agent harness 的 cache locality 和稳定工具面，跟 Oneesama 近期的 stable-prefix / dynamic envelope 工作直接相关。",
				EvidenceAnchors: []SlackVisibleEvidenceAnchor{{
					Kind:      slackVisibleEvidenceKindFetchedLink,
					SourceRef: "https://www.openclacky.com/benchmark",
					Quote:     "Cache locality and tool-set stability are the core harness decisions.",
				}},
			},
			ExpectedAllow:  true,
			ExpectedReason: slackVisibleReplyAllowReasonAllowed,
		},
		{
			Name: "explicit_user_command_smoke_allows",
			Action: SlackTriageDecisionAction{
				Type:    slackActionTypeThreadReply,
				Message: "收到，这是一次 approval smoke，按原文发出。",
				EvidenceAnchors: []SlackVisibleEvidenceAnchor{{
					Kind:      slackVisibleEvidenceKindExplicitUserCommand,
					SourceRef: "slack://channel/C123/thread/1779450000.000000",
					Quote:     "请回复这句话用于 smoke",
				}},
			},
			ExpectedAllow:  true,
			ExpectedReason: slackVisibleReplyAllowReasonAllowed,
		},
		{
			Name: "routing_handoff_with_thread_anchor_allows",
			Action: SlackTriageDecisionAction{
				Type:    slackActionTypeThreadReply,
				Message: "这条应转给项目 owner 处理；Oneesama 不直接下场查 repo。",
				EvidenceAnchors: []SlackVisibleEvidenceAnchor{{
					Kind:      slackVisibleEvidenceKindSlackThread,
					SourceRef: "slack://channel/C123/thread/1779450000.000000",
					Quote:     "用户要求的是外部 repo debugging",
				}},
			},
			ExpectedAllow:  true,
			ExpectedReason: slackVisibleReplyAllowReasonAllowed,
		},
		{
			Name: "no_anchor_polite_reply_blocks",
			Action: SlackTriageDecisionAction{
				Type:    slackActionTypeThreadReply,
				Message: "我看了一下，这里应该可以继续按原计划推进。",
			},
			ExpectedAllow:  false,
			ExpectedReason: slackVisibleReplyAllowReasonMissingEvidenceAnchor,
		},
		{
			Name: "thread_anchor_without_routing_blocks",
			Action: SlackTriageDecisionAction{
				Type:    slackActionTypeThreadReply,
				Message: "我觉得这条讨论挺有意思，可以继续看看。",
				EvidenceAnchors: []SlackVisibleEvidenceAnchor{{
					Kind:      slackVisibleEvidenceKindSlackThread,
					SourceRef: "slack://channel/C123/thread/1779450000.000000",
					Quote:     "thread text",
				}},
			},
			ExpectedAllow:  false,
			ExpectedReason: slackVisibleReplyAllowReasonMissingEvidenceAnchor,
		},
		{
			Name: "handled_by_other_blocks",
			Action: SlackTriageDecisionAction{
				Type:    slackActionTypeThreadReply,
				Message: "这个已经处理了，无需再补充。",
				EvidenceAnchors: []SlackVisibleEvidenceAnchor{{
					Kind:      slackVisibleEvidenceKindFetchedLink,
					SourceRef: "https://example.com/thread",
					Quote:     "already answered",
				}},
			},
			ExpectedAllow:  false,
			ExpectedReason: slackVisibleReplyAllowReasonDuplicateHandled,
		},
		{
			Name: "internal_meta_blocks",
			Action: SlackTriageDecisionAction{
				Type:    slackActionTypeThreadReply,
				Message: "The persona already classified this thread as no visible output.",
				EvidenceAnchors: []SlackVisibleEvidenceAnchor{{
					Kind:      slackVisibleEvidenceKindFetchedLink,
					SourceRef: "https://example.com/source",
					Quote:     "source excerpt",
				}},
			},
			ExpectedAllow:  false,
			ExpectedReason: slackVisibleReplyAllowReasonInternalMeta,
		},
		{
			Name: "framework_protocol_leak_blocks",
			Action: SlackTriageDecisionAction{
				Type: slackActionTypeThreadReply,
				Message: `<｜｜DSML｜｜tool_calls>
<｜｜DSML｜｜invoke name="openrouter_web_search">
<｜｜DSML｜｜parameter name="query" string="true">nitter.net thet8or</｜｜DSML｜｜parameter>
</｜｜DSML｜｜invoke>
</｜｜DSML｜｜tool_calls>`,
				EvidenceAnchors: []SlackVisibleEvidenceAnchor{{
					Kind:      slackVisibleEvidenceKindFetchedLink,
					SourceRef: "https://nitter.net/thet8or",
					Quote:     "profile excerpt",
				}},
			},
			ExpectedAllow:  false,
			ExpectedReason: slackVisibleReplyAllowReasonInternalMeta,
		},
	}
}

func buildSlackVisibleReplyAllowListShadowSummary(samples []SlackVisibleReplyQualitySample, limit int) SlackVisibleReplyAllowListShadowSummary {
	out := SlackVisibleReplyAllowListShadowSummary{Total: len(samples)}
	for _, sample := range samples {
		action := SlackTriageDecisionAction{
			Type:            slackActionTypeThreadReply,
			Message:         sample.ProposedMessage,
			ChannelID:       sample.ChannelID,
			ThreadTS:        sample.ThreadTS,
			EvidenceAnchors: sample.EvidenceAnchors,
		}
		verdict := slackVisibleReplyAllowListVerdictForAction(action)
		denyReason := slackVisibleReplyQualityBlockReason(sample.ProposedMessage)
		if denyReason != "" {
			out.DenyListWouldBlock++
			out.SafetyNetBlocks++
		}
		if verdict.Allowed {
			out.AllowListWouldAllow++
		} else {
			out.AllowListWouldBlock++
			if denyReason == "" {
				out.AllowListBlocksDenyListWouldPass++
			}
		}
		if limit > 0 && len(out.Samples) >= limit {
			continue
		}
		if denyReason != "" || !verdict.Allowed {
			out.Samples = append(out.Samples, SlackVisibleReplyAllowListShadowSample{
				ChannelID:        sample.ChannelID,
				ThreadTS:         sample.ThreadTS,
				ApprovalDecision: sample.ApprovalDecision,
				AllowListReason:  verdict.Reason,
				DenyListReason:   denyReason,
				EvidenceKinds:    slackVisibleReplyEvidenceKinds(sample.EvidenceAnchors),
			})
		}
	}
	return out
}

func slackVisibleReplyEvidenceKinds(anchors []SlackVisibleEvidenceAnchor) []string {
	anchors = normalizeSlackVisibleEvidenceAnchors(anchors)
	out := make([]string, 0, len(anchors))
	for _, anchor := range anchors {
		if strings.TrimSpace(anchor.Kind) != "" {
			out = append(out, strings.TrimSpace(anchor.Kind))
		}
	}
	return out
}
