package slackagent

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestCueboardParityReplyFeedbackPersistsMemoryAndImprovementSignal(t *testing.T) {
	withFeedbackMemoryClock(t, time.Date(2026, 5, 17, 13, 30, 0, 0, shanghaiLocation()))
	workspaceDir := t.TempDir()
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack: appconfig.SlackConfig{
			WorkspaceDir: workspaceDir,
			Memory:       appconfig.SlackMemoryConfig{Enabled: true, Dir: t.TempDir()},
		},
	})

	response := service.HandleSlackInteraction(context.Background(), SlackInteractionPayload{
		Channel: &SlackInteractionChannel{ID: "C123"},
		User:    &SlackInteractionUser{ID: "UFEEDBACK"},
		Message: &SlackInteractionMessage{
			TS:       "1779000000.000001",
			ThreadTS: "1779000000.000001",
			Blocks: []SlackBlock{
				{Type: "section", Text: &SlackBlockText{Text: "This answer missed the memory write path."}},
				{Type: "section", BlockID: replyFeedbackBlockID, Text: &SlackBlockText{Text: "feedback footer"}},
			},
		},
		Actions: []SlackInteractionAction{{
			ActionID:       "reply_feedback",
			SelectedOption: &SlackInteractionSelectedValue{Value: replyFeedbackNotHelpful},
		}},
	})
	if !response.OK || !strings.Contains(response.Text, "Feedback saved") {
		t.Fatalf("response = %#v, want feedback saved acknowledgement", response)
	}

	entries, err := service.feedback.ListEntries(context.Background(), 10)
	if err != nil {
		t.Fatalf("ListEntries: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("entries = %#v, want one feedback entry", entries)
	}
	entry := entries[0]
	if entry.Action != replyFeedbackNotHelpful || entry.ActionType != replyFeedbackActionType || entry.Channel != "C123" || entry.UserID != "UFEEDBACK" {
		t.Fatalf("entry = %#v, want cueboard-style reply feedback row", entry)
	}
	if strings.Contains(entry.Summary, "feedback footer") || !strings.Contains(entry.Summary, "memory write path") {
		t.Fatalf("summary = %q, want assistant reply summary without footer", entry.Summary)
	}

	projection := readFeedbackTestFile(t, filepath.Join(workspaceDir, "memory", "feedback", "2026-05-17.md"))
	for _, want := range []string{"[13:30]", "not_helpful reply_quality #C123", "memory write path", "by UFEEDBACK"} {
		if !strings.Contains(projection, want) {
			t.Fatalf("projection = %q, missing %q", projection, want)
		}
	}

	signals, err := service.improvements.ListSignals(context.Background(), 10, nil, time.Time{})
	if err != nil {
		t.Fatalf("ListSignals: %v", err)
	}
	if len(signals) != 1 || signals[0].Topic != improvementTopicReplyQuality || signals[0].SignalType != improvementSignalTypeDismiss {
		t.Fatalf("signals = %#v, want reply_quality dismiss signal", signals)
	}

	summary := service.MemorySummary()
	if summary.FeedbackEntries != 1 {
		t.Fatalf("summary = %#v, want dynamic feedback count", summary)
	}
	results := service.SearchLocalMemory("memory write path", 5)
	if !memoryResultsContainKind(results, "feedback") || !memoryResultsContainKind(results, "workspace_memory_file") {
		t.Fatalf("results = %#v, want stored feedback and projection searchable", results)
	}
	agentContext := service.buildLocalSlackMemoryContext("unrelated query", 5)
	if !strings.Contains(agentContext.RecentFeedback, "not_helpful reply_quality #C123") {
		t.Fatalf("recent feedback = %q, want cueboard-style feedback injected into memory context", agentContext.RecentFeedback)
	}
}

func TestEmojiReactionFeedbackPersistsMemoryAndImprovementSignal(t *testing.T) {
	withFeedbackMemoryClock(t, time.Date(2026, 5, 17, 14, 20, 0, 0, shanghaiLocation()))
	workspaceDir := t.TempDir()
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack: appconfig.SlackConfig{
			BotUserID:    "UBOT",
			WorkspaceDir: workspaceDir,
			Memory:       appconfig.SlackMemoryConfig{Enabled: true, Dir: t.TempDir()},
		},
	})

	response := service.HandleSlackEvent(context.Background(), SlackEventEnvelope{
		Type:    "event_callback",
		EventID: "EvEmojiFeedback",
		TeamID:  "T123",
		Event: SlackEventPayload{
			Type:     "reaction_added",
			User:     "UFEEDBACK",
			Reaction: "thumbsdown",
			ItemUser: "UBOT",
			Item:     &SlackReactionItem{Type: "message", Channel: "C123", TS: "1779000020.000003"},
			Message: &SlackMessage{
				TS:       "1779000020.000003",
				ThreadTS: "1779000000.000001",
				Text:     "I incorrectly claimed memory feedback was fully wired.",
			},
		},
	}, SlackEventHeaders{})
	if !response.OK || !response.Handled || response.Mode != "emoji_feedback" {
		t.Fatalf("response = %#v, want handled emoji feedback", response)
	}

	entries, err := service.feedback.ListEntries(context.Background(), 10)
	if err != nil {
		t.Fatalf("ListEntries: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("entries = %#v, want one feedback entry", entries)
	}
	entry := entries[0]
	if entry.Action != replyFeedbackNotHelpful || entry.ActionType != replyFeedbackActionType || entry.Channel != "C123" || entry.ThreadTS != "1779000000.000001" {
		t.Fatalf("entry = %#v, want emoji-derived reply feedback row", entry)
	}
	if !strings.Contains(entry.Summary, ":thumbsdown:") || !strings.Contains(entry.Summary, "memory feedback") {
		t.Fatalf("summary = %q, want emoji key and target summary", entry.Summary)
	}

	projection := readFeedbackTestFile(t, filepath.Join(workspaceDir, "memory", "feedback", "2026-05-17.md"))
	for _, want := range []string{"[14:20]", "not_helpful reply_quality #C123", ":thumbsdown:", "by UFEEDBACK"} {
		if !strings.Contains(projection, want) {
			t.Fatalf("projection = %q, missing %q", projection, want)
		}
	}

	signals, err := service.improvements.ListSignals(context.Background(), 10, nil, time.Time{})
	if err != nil {
		t.Fatalf("ListSignals: %v", err)
	}
	if len(signals) != 1 || signals[0].Topic != improvementTopicReplyQuality || signals[0].SignalType != improvementSignalTypeDismiss {
		t.Fatalf("signals = %#v, want emoji reply_quality dismiss signal", signals)
	}
	if signals[0].Metadata["source"] != "emoji_feedback" || signals[0].Metadata["emoji"] != "thumbsdown" {
		t.Fatalf("signal metadata = %#v, want emoji provenance", signals[0].Metadata)
	}
}

func TestPositiveReactionOnHumanThreadReplyPersistsLearningSignal(t *testing.T) {
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack:       appconfig.SlackConfig{BotUserID: "UBOT"},
	})

	response := service.HandleSlackEvent(context.Background(), SlackEventEnvelope{
		Type:    "event_callback",
		EventID: "EvHumanConclusion",
		Event: SlackEventPayload{
			Type:     "reaction_added",
			User:     "UREVIEWER",
			Reaction: "white_check_mark",
			ItemUser: "UANSWER",
			Item:     &SlackReactionItem{Type: "message", Channel: "C123", TS: "1779000030.000004"},
			Message: &SlackMessage{
				TS:       "1779000030.000004",
				ThreadTS: "1779000000.000001",
				User:     "UANSWER",
				Text:     "结论：Johnson8053 是队友 HN 小号；证据是他发过 affine/bridge 相关内容。",
			},
		},
	}, SlackEventHeaders{})
	if !response.OK || !response.Handled || response.Mode != "reaction_backed_human_conclusion" {
		t.Fatalf("response = %#v, want handled reaction-backed human conclusion", response)
	}

	entries, err := service.feedback.ListEntries(context.Background(), 10)
	if err != nil {
		t.Fatalf("ListEntries: %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("entries = %#v, want no assistant feedback entry for human conclusion", entries)
	}

	signals, err := service.learning.List(context.Background(), 10, time.Time{})
	if err != nil {
		t.Fatalf("ListSignals: %v", err)
	}
	if len(signals) != 1 {
		t.Fatalf("signals = %#v, want one learning signal", signals)
	}
	signal := signals[0]
	if signal.Source != slackLearningSourceReactionBackedConclusion || signal.Verdict != "confirm" || signal.Subject != "reaction_backed_human_conclusion" {
		t.Fatalf("signal = %#v, want reaction-backed confirmation signal", signal)
	}
	if signal.ProposedAction != "memory_candidate" || signal.Target != "persona_triage_quality" || signal.ReasonCode != "positive_reaction_on_human_thread_reply" {
		t.Fatalf("signal = %#v, want review-gated memory candidate signal", signal)
	}
	for _, want := range []string{"slack:C123/1779000000.000001", "slack_message:C123/1779000030.000004"} {
		if !slackMemoryFactContainsString(signal.Refs, want) {
			t.Fatalf("refs = %#v, missing %q", signal.Refs, want)
		}
	}
	if !strings.Contains(signal.Content, "Johnson8053") || signal.Metadata["emoji"] != "white_check_mark" || signal.Metadata["message_user"] != "UANSWER" {
		t.Fatalf("signal = %#v, want conclusion content and reaction provenance", signal)
	}

	candidates := BuildSlackDreamCandidates(SlackDreamSignalsFromLearningSignals(signals), SlackDreamCandidateOptions{Date: "2026-05-23"})
	if len(candidates) != 1 || candidates[0].ProposalType != "memory_candidate" || !strings.Contains(candidates[0].Proposal, "Johnson8053") {
		t.Fatalf("candidates = %#v, want review-gated memory candidate from human conclusion", candidates)
	}
}

func TestHumanConclusionReactionRequiresSecondHumanThreadReply(t *testing.T) {
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack:       appconfig.SlackConfig{BotUserID: "UBOT"},
	})

	selfReaction := service.HandleSlackEvent(context.Background(), SlackEventEnvelope{
		Type:    "event_callback",
		EventID: "EvHumanConclusionSelf",
		Event: SlackEventPayload{
			Type:     "reaction_added",
			User:     "UANSWER",
			Reaction: "white_check_mark",
			ItemUser: "UANSWER",
			Item:     &SlackReactionItem{Type: "message", Channel: "C123", TS: "1779000030.000004"},
			Message: &SlackMessage{
				TS:       "1779000030.000004",
				ThreadTS: "1779000000.000001",
				User:     "UANSWER",
				Text:     "结论：这条不能靠 self reaction 进入记忆。",
			},
		},
	}, SlackEventHeaders{})
	if !selfReaction.Ignored || selfReaction.Reason != "non_bot_message" {
		t.Fatalf("selfReaction = %#v, want non-bot reaction ignored", selfReaction)
	}

	rootReaction := service.HandleSlackEvent(context.Background(), SlackEventEnvelope{
		Type:    "event_callback",
		EventID: "EvHumanConclusionRoot",
		Event: SlackEventPayload{
			Type:     "reaction_added",
			User:     "UREVIEWER",
			Reaction: "white_check_mark",
			ItemUser: "UANSWER",
			Item:     &SlackReactionItem{Type: "message", Channel: "C123", TS: "1779000040.000005"},
			Message: &SlackMessage{
				TS:   "1779000040.000005",
				User: "UANSWER",
				Text: "根消息被点赞不能直接当作同线程结论。",
			},
		},
	}, SlackEventHeaders{})
	if !rootReaction.Ignored || rootReaction.Reason != "non_bot_message" {
		t.Fatalf("rootReaction = %#v, want root reaction ignored", rootReaction)
	}

	signals, err := service.learning.List(context.Background(), 10, time.Time{})
	if err != nil {
		t.Fatalf("ListSignals: %v", err)
	}
	if len(signals) != 0 {
		t.Fatalf("signals = %#v, want no learning signals for weak reactions", signals)
	}
}

func TestEmojiReactionFeedbackIgnoresNoiseAndNonBotMessages(t *testing.T) {
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack:       appconfig.SlackConfig{BotUserID: "UBOT"},
	})

	noise := service.HandleSlackEvent(context.Background(), SlackEventEnvelope{
		Type:    "event_callback",
		EventID: "EvEmojiNoise",
		Event: SlackEventPayload{
			Type:     "reaction_added",
			User:     "UFEEDBACK",
			Reaction: "eyes",
			ItemUser: "UBOT",
			Item:     &SlackReactionItem{Type: "message", Channel: "C123", TS: "1779000020.000003"},
		},
	}, SlackEventHeaders{})
	if !noise.Ignored || noise.Reason != "unmapped_reaction" {
		t.Fatalf("noise response = %#v, want unmapped reaction ignored", noise)
	}

	nonBot := service.HandleSlackEvent(context.Background(), SlackEventEnvelope{
		Type:    "event_callback",
		EventID: "EvEmojiNonBot",
		Event: SlackEventPayload{
			Type:     "reaction_added",
			User:     "UFEEDBACK",
			Reaction: "white_check_mark",
			ItemUser: "UOTHER",
			Item:     &SlackReactionItem{Type: "message", Channel: "C123", TS: "1779000020.000003"},
		},
	}, SlackEventHeaders{})
	if !nonBot.Ignored || nonBot.Reason != "non_bot_message" {
		t.Fatalf("nonBot response = %#v, want non bot message ignored", nonBot)
	}
}

func TestCueboardParityPendingActionChoicePersistsFeedbackMemory(t *testing.T) {
	withFeedbackMemoryClock(t, time.Date(2026, 5, 17, 14, 5, 0, 0, shanghaiLocation()))
	workspaceDir := t.TempDir()
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack: appconfig.SlackConfig{
			WorkspaceDir: workspaceDir,
			Memory:       appconfig.SlackMemoryConfig{Enabled: true, Dir: t.TempDir()},
		},
	})
	record, err := service.triage.InsertPendingAction(context.Background(), SlackPendingAction{
		ChannelID:  "COPS",
		ThreadTS:   "1779000010.000002",
		ActionType: slackActionTypeCreateIssue,
		Params: map[string]any{
			"title": "Record memory feedback parity gap",
		},
		Status: PendingActionStatusPending,
	})
	if err != nil {
		t.Fatalf("InsertPendingAction: %v", err)
	}

	response := service.HandlePendingActionInteraction(context.Background(), SlackPendingActionInteraction{
		ID:        record.ID,
		Status:    "dismissed",
		UserID:    "UOWNER",
		ChannelID: "COPS",
		ThreadTS:  "1779000010.000002",
	})
	if !response.OK || !strings.Contains(response.Text, "marked dismissed") {
		t.Fatalf("response = %#v, want pending action dismissed", response)
	}

	entries, err := service.feedback.ListEntries(context.Background(), 10)
	if err != nil {
		t.Fatalf("ListEntries: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("entries = %#v, want one feedback entry", entries)
	}
	entry := entries[0]
	if entry.Action != "dismissed" || entry.ActionType != slackActionTypeCreateIssue || !strings.Contains(entry.Summary, "Record memory feedback") {
		t.Fatalf("entry = %#v, want pending action feedback summary", entry)
	}
	projection := readFeedbackTestFile(t, filepath.Join(workspaceDir, "memory", "feedback", "2026-05-17.md"))
	if !strings.Contains(projection, "dismissed create_issue #COPS") || !strings.Contains(projection, "by UOWNER") {
		t.Fatalf("projection = %q, want pending action feedback projection", projection)
	}

	signals, err := service.improvements.ListSignals(context.Background(), 10, nil, time.Time{})
	if err != nil {
		t.Fatalf("ListSignals: %v", err)
	}
	if len(signals) != 1 || signals[0].Topic != improvementTopicActionSuggestion || signals[0].SignalType != improvementSignalTypeDismiss {
		t.Fatalf("signals = %#v, want action suggestion dismiss signal", signals)
	}
}

func TestCueboardParityMemoryGetWriteUsesLiveWorkspace(t *testing.T) {
	workspaceDir := t.TempDir()
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack: appconfig.SlackConfig{
			WorkspaceDir: workspaceDir,
			Memory:       appconfig.SlackMemoryConfig{Enabled: true, Dir: t.TempDir()},
		},
	})

	writeResult := service.executeMemoryWriteTool(context.Background(), map[string]any{
		"path":    "memory/team/decisions.md",
		"content": "# Decisions\n\nUse live workspace memory.",
	})
	if !writeResult.OK {
		t.Fatalf("write result = %#v, want ok", writeResult)
	}
	if _, err := os.Stat(filepath.Join(workspaceDir, "memory", "team", "decisions.md")); err != nil {
		t.Fatalf("live workspace memory file not written: %v", err)
	}
	getResult := service.executeMemoryGetTool(map[string]any{"path": "memory/team/decisions.md"})
	resultMap, _ := getResult.Result.(map[string]any)
	if !getResult.OK || !strings.Contains(stringFromAny(resultMap["content"]), "live workspace memory") {
		t.Fatalf("get result = %#v, want live workspace content", getResult)
	}
}

func readFeedbackTestFile(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(raw)
}

func withFeedbackMemoryClock(t *testing.T, now time.Time) {
	t.Helper()
	previous := timeNow
	timeNow = func() time.Time { return now }
	t.Cleanup(func() { timeNow = previous })
}

func memoryResultsContainKind(results []SlackMemoryResult, kind string) bool {
	for _, result := range results {
		if result.Kind == kind {
			return true
		}
	}
	return false
}
