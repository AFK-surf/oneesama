package slackagent

import "testing"

func TestFilterSlackTriageBotInboundMessagesRemovesExistingBotReplies(t *testing.T) {
	filtered, removed := filterSlackTriageBotInboundMessages([]SlackInboundMessage{{
		ChannelID: "C1",
		UserID:    "U_HUMAN",
		Text:      "看看这个链接",
		TS:        "100.000",
	}, {
		ChannelID: "C1",
		UserID:    "U_BOT",
		BotID:     "B123",
		Subtype:   "bot_message",
		Text:      "old low-quality bot reply",
		TS:        "101.000",
		ThreadTS:  "100.000",
	}}, []string{"U_BOT"})

	if removed != 1 || len(filtered) != 1 {
		t.Fatalf("removed=%d filtered=%#v, want one human message", removed, filtered)
	}
	if filtered[0].UserID != "U_HUMAN" || filtered[0].Text != "看看这个链接" {
		t.Fatalf("filtered = %#v, want human message preserved", filtered)
	}
}

func TestFilterSlackTriageBotInboundMessagesPreservesOtherBotSources(t *testing.T) {
	filtered, removed := filterSlackTriageBotInboundMessages([]SlackInboundMessage{{
		ChannelID: "C1",
		UserID:    "U_OTHER_BOT",
		BotID:     "B_OTHER",
		Subtype:   "bot_message",
		Text:      "_2026-05-22 团队日报_ 修复权限审批流并发布。",
		TS:        "100.000",
	}}, []string{"U_ONEESAMA"})

	if removed != 0 || len(filtered) != 1 {
		t.Fatalf("removed=%d filtered=%#v, want other bot source preserved", removed, filtered)
	}
	if filtered[0].UserID != "U_OTHER_BOT" {
		t.Fatalf("filtered = %#v, want other bot message preserved", filtered)
	}
}
