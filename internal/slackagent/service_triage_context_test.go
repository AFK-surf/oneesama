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
