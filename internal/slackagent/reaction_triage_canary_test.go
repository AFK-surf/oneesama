package slackagent

import (
	"context"
	"testing"

	"github.com/AFK-surf/oneesama/internal/persona"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestReactionTriageCanaryReactOnlyUsesWorkspaceCustomEmoji(t *testing.T) {
	t.Parallel()

	service, poster, reactions := newReactionTriageCanaryService(t, []string{"eyes_bridge", "memo_bridge"})
	result := SlackPersonaShadowResult{
		Success:  true,
		Runtime:  persona.ProviderPi,
		Decision: persona.DecisionReact,
		reactionRecords: []persona.ReactionIntent{{
			Emoji:      "eyes_bridge",
			Confidence: 0.92,
			Reason:     "lightweight acknowledgement",
		}},
	}

	actions := slackPersonaForegroundActions("C123", "100.000", result, persona.Request{})
	if len(actions) != 1 || actions[0].Type != "add_reaction" {
		t.Fatalf("actions = %#v, want one reaction action", actions)
	}
	calls, failures, mutations := service.executeSlackTriageDirectActions(context.Background(), "W1", "C123", "100.000", 286, actions, reactionTriageCanaryMessages())
	if failures != 0 || mutations != 1 || len(calls) != 1 || !calls[0].Success {
		t.Fatalf("calls=%#v failures=%d mutations=%d, want successful reaction-only canary", calls, failures, mutations)
	}
	if got := len(poster.Calls()); got != 0 {
		t.Fatalf("poster calls = %d, want no text reply for react-only canary", got)
	}
	assertReactionCalls(t, reactions.Calls(), []reactionCall{
		{Method: "add", Channel: "C123", Timestamp: "100.123", Name: "eyes_bridge"},
	})
}

func TestReactionTriageCanaryReplyOnlyDoesNotReact(t *testing.T) {
	t.Parallel()

	service, poster, reactions := newReactionTriageCanaryService(t, []string{"eyes_bridge", "memo_bridge"})
	result := SlackPersonaShadowResult{
		Success:     true,
		Runtime:     persona.ProviderPi,
		Decision:    persona.DecisionReply,
		VisibleText: "这个方向值得看，尤其是和我们现在的 triage policy 很近。",
		Confidence:  0.84,
		Reason:      "workspace-relevant commentary",
	}

	actions := slackPersonaForegroundActions("C123", "100.000", result, persona.Request{})
	if len(actions) != 1 || actions[0].Type != "post_thread_reply" {
		t.Fatalf("actions = %#v, want one reply action", actions)
	}
	calls, failures, mutations := service.executeSlackTriageDirectActions(context.Background(), "W1", "C123", "100.000", 286, actions, reactionTriageCanaryMessages())
	if failures != 0 || mutations != 1 || len(calls) != 1 || !calls[0].Success {
		t.Fatalf("calls=%#v failures=%d mutations=%d, want successful reply-only canary", calls, failures, mutations)
	}
	if got := len(poster.Calls()); got != 1 {
		t.Fatalf("poster calls = %d, want one text reply", got)
	}
	assertReactionCalls(t, reactions.Calls(), nil)
}

func TestReactionTriageCanaryReplyPlusReact(t *testing.T) {
	t.Parallel()

	service, poster, reactions := newReactionTriageCanaryService(t, []string{"eyes_bridge", "memo_bridge"})
	result := SlackPersonaShadowResult{
		Success:     true,
		Runtime:     persona.ProviderPi,
		Decision:    persona.DecisionReply,
		VisibleText: "我会把这个记成一个 workspace policy 信号：这类消息适合轻量参与。",
		Confidence:  0.88,
		Reason:      "reply plus lightweight acknowledgement",
		reactionRecords: []persona.ReactionIntent{{
			Emoji:     ":memo_bridge:",
			MessageTS: "100.123",
			Reason:    "memory-policy signal",
		}},
	}

	actions := slackPersonaForegroundActions("C123", "100.000", result, persona.Request{})
	if len(actions) != 2 || actions[0].Type != "post_thread_reply" || actions[1].Type != "add_reaction" {
		t.Fatalf("actions = %#v, want reply then reaction", actions)
	}
	calls, failures, mutations := service.executeSlackTriageDirectActions(context.Background(), "W1", "C123", "100.000", 286, actions, reactionTriageCanaryMessages())
	if failures != 0 || mutations != 2 || len(calls) != 2 || !calls[0].Success || !calls[1].Success {
		t.Fatalf("calls=%#v failures=%d mutations=%d, want successful reply+reaction canary", calls, failures, mutations)
	}
	if got := len(poster.Calls()); got != 1 {
		t.Fatalf("poster calls = %d, want one text reply", got)
	}
	assertReactionCalls(t, reactions.Calls(), []reactionCall{
		{Method: "add", Channel: "C123", Timestamp: "100.123", Name: "memo_bridge"},
	})
}

func TestReactionTriageCanarySkipsHallucinatedWorkspaceCustomEmoji(t *testing.T) {
	t.Parallel()

	service, poster, reactions := newReactionTriageCanaryService(t, []string{"eyes_bridge", "memo_bridge"})
	result := SlackPersonaShadowResult{
		Success:  true,
		Runtime:  persona.ProviderPi,
		Decision: persona.DecisionReact,
		reactionRecords: []persona.ReactionIntent{{
			Emoji:      "done_bridge",
			Confidence: 0.75,
			Reason:     "hallucinated custom emoji should be skipped",
		}},
	}

	actions := slackPersonaForegroundActions("C123", "100.000", result, persona.Request{})
	calls, failures, mutations := service.executeSlackTriageDirectActions(context.Background(), "W1", "C123", "100.000", 286, actions, reactionTriageCanaryMessages())
	if failures != 0 || mutations != 0 || len(calls) != 1 || !calls[0].Success || calls[0].Result != "unknown_workspace_custom_emoji" {
		t.Fatalf("calls=%#v failures=%d mutations=%d, want fail-closed custom emoji skip", calls, failures, mutations)
	}
	if got := len(poster.Calls()); got != 0 {
		t.Fatalf("poster calls = %d, want no fallback text reply for skipped reaction", got)
	}
	assertReactionCalls(t, reactions.Calls(), nil)
}

func TestReactionTriageCanaryAllowsStandardEmojiWhenCustomCacheExists(t *testing.T) {
	t.Parallel()

	service, _, reactions := newReactionTriageCanaryService(t, []string{"eyes_bridge", "memo_bridge"})
	actions := []SlackTriageDecisionAction{{
		Type:      "add_reaction",
		Emoji:     "white_check_mark",
		ChannelID: "C123",
		ThreadTS:  "100.000",
		MessageTS: "100.123",
	}}

	calls, failures, mutations := service.executeSlackTriageDirectActions(context.Background(), "W1", "C123", "100.000", 286, actions, reactionTriageCanaryMessages())
	if failures != 0 || mutations != 1 || len(calls) != 1 || !calls[0].Success {
		t.Fatalf("calls=%#v failures=%d mutations=%d, want standard emoji allowed", calls, failures, mutations)
	}
	assertReactionCalls(t, reactions.Calls(), []reactionCall{
		{Method: "add", Channel: "C123", Timestamp: "100.123", Name: "white_check_mark"},
	})
}

func newReactionTriageCanaryService(t *testing.T, customEmoji []string) (*Service, *recordingPoster, *recordingReactions) {
	t.Helper()
	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	reactions := &recordingReactions{}
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack: appconfig.SlackConfig{
			BotUserID: "U_BOT",
		},
		Poster:    poster,
		Reactions: reactions,
	})
	service.customEmojiMu.Lock()
	service.customEmoji = append([]string(nil), customEmoji...)
	service.customEmojiMu.Unlock()
	return service, poster, reactions
}

func reactionTriageCanaryMessages() []SlackInboundMessage {
	return []SlackInboundMessage{
		{ChannelID: "C123", UserID: "U_ASKER", TS: "100.000", ThreadTS: "100.000", Text: "这个值得轻轻回应一下"},
		{ChannelID: "C123", UserID: "U_ASKER", TS: "100.123", ThreadTS: "100.000", Text: "补充：最好用 workspace 自己的 reaction"},
	}
}
