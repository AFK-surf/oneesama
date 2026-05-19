package slackagent

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestTriageDirectReplySkipsWhenThreadHasNewerHumanActivity(t *testing.T) {
	restore := installSlackRepliesFixture(t, []SlackMessage{
		{TS: "1779086895.918119", User: "U_ASKER", Text: "这种是不是要调一下 skill 或 system prompt"},
		{TS: "1779086957.992489", User: "U_HUMAN", Text: "skill 好点吧，system prompt 不能塞太多"},
	})
	defer restore()

	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack: appconfig.SlackConfig{
			BotToken:  "xoxb-test",
			BotUserID: "U_BOT",
		},
		Poster: poster,
	})

	calls, failures, mutations := service.executeSlackTriageDirectActions(context.Background(), "W1", "C09KVPBMLJ3", "1779086895.918119", 187, []SlackTriageDecisionAction{{
		Type:                 "post_thread_reply",
		Title:                "ask for more context",
		Message:              "链接 404 了，截图我也看不到内容。",
		ChannelID:            "C09KVPBMLJ3",
		ThreadTS:             "1779086895.918119",
		RequiresConfirmation: false,
	}}, []SlackInboundMessage{{
		ChannelID: "C09KVPBMLJ3",
		UserID:    "U_ASKER",
		TS:        "1779086895.918119",
		Text:      "这种是不是要调一下 skill 或 system prompt",
	}})

	if failures != 0 || mutations != 0 || len(calls) != 1 || !calls[0].Success {
		t.Fatalf("calls=%#v failures=%d mutations=%d, want skipped successful no-mutation call", calls, failures, mutations)
	}
	if calls[0].Result != "thread_has_newer_activity" {
		t.Fatalf("call result = %q, want thread_has_newer_activity", calls[0].Result)
	}
	if got := len(poster.Calls()); got != 0 {
		t.Fatalf("poster calls = %d, want stale direct reply suppressed", got)
	}
}

func TestTriageDirectReplySkipsWhenThreadAlreadyHasBotReply(t *testing.T) {
	restore := installSlackRepliesFixture(t, []SlackMessage{
		{TS: "100.000", User: "U_ASKER", Text: "read this"},
		{TS: "101.000", User: "U_BOT", BotID: "B123", Subtype: "bot_message", Text: "bot ack"},
	})
	defer restore()

	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack: appconfig.SlackConfig{
			BotToken:  "xoxb-test",
			BotUserID: "U_BOT",
		},
		Poster: poster,
	})

	calls, failures, mutations := service.executeSlackTriageDirectActions(context.Background(), "W1", "C123", "100.000", 188, []SlackTriageDecisionAction{{
		Type:                 "post_thread_reply",
		Title:                "synthesis",
		Message:              "初步看这个链接值得读。",
		ChannelID:            "C123",
		ThreadTS:             "100.000",
		RequiresConfirmation: false,
	}}, []SlackInboundMessage{{ChannelID: "C123", UserID: "U_ASKER", TS: "100.000", Text: "read this"}})

	if failures != 0 || mutations != 0 || len(calls) != 1 || !calls[0].Success {
		t.Fatalf("calls=%#v failures=%d mutations=%d, want skipped successful no-mutation call", calls, failures, mutations)
	}
	if calls[0].Result != "thread_has_newer_bot_activity" {
		t.Fatalf("call result = %q, want thread_has_newer_bot_activity", calls[0].Result)
	}
	if got := len(poster.Calls()); got != 0 {
		t.Fatalf("poster calls = %d, want duplicate bot reply suppressed", got)
	}
}

func TestTriageDirectReplyForceIgnoresExistingBotReply(t *testing.T) {
	restore := installSlackRepliesFixture(t, []SlackMessage{
		{TS: "100.000", User: "U_ASKER", Text: "read this"},
		{TS: "101.000", User: "U_BOT", BotID: "B123", Subtype: "bot_message", Text: "old bot answer"},
	})
	defer restore()

	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack: appconfig.SlackConfig{
			BotToken:  "xoxb-test",
			BotUserID: "U_BOT",
		},
		Poster: poster,
	})

	calls, failures, mutations := service.executeSlackTriageDirectActionsWithOptions(context.Background(), "W1", "C123", "100.000", 189, []SlackTriageDecisionAction{{
		Type:                 "post_thread_reply",
		Title:                "synthesis",
		Message:              "补一条更具体的判断。",
		ChannelID:            "C123",
		ThreadTS:             "100.000",
		RequiresConfirmation: false,
	}}, slackTriageDirectActionOptions{
		SnapshotMessages:       []SlackInboundMessage{{ChannelID: "C123", UserID: "U_ASKER", TS: "100.000", Text: "read this"}},
		IgnoreExistingBotReply: true,
	})

	if failures != 0 || mutations != 1 || len(calls) != 1 || !calls[0].Success {
		t.Fatalf("calls=%#v failures=%d mutations=%d, want forced post", calls, failures, mutations)
	}
	if got := len(poster.Calls()); got != 1 {
		t.Fatalf("poster calls = %d, want forced reply to post", got)
	}
}

func TestTriageDirectReplyForceStillBlocksHumanActivity(t *testing.T) {
	restore := installSlackRepliesFixture(t, []SlackMessage{
		{TS: "100.000", User: "U_ASKER", Text: "read this"},
		{TS: "101.000", User: "U_HUMAN", Text: "human already answered"},
	})
	defer restore()

	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack: appconfig.SlackConfig{
			BotToken:  "xoxb-test",
			BotUserID: "U_BOT",
		},
		Poster: poster,
	})

	calls, failures, mutations := service.executeSlackTriageDirectActionsWithOptions(context.Background(), "W1", "C123", "100.000", 190, []SlackTriageDecisionAction{{
		Type:                 "post_thread_reply",
		Title:                "synthesis",
		Message:              "补一条更具体的判断。",
		ChannelID:            "C123",
		ThreadTS:             "100.000",
		RequiresConfirmation: false,
	}}, slackTriageDirectActionOptions{
		SnapshotMessages:       []SlackInboundMessage{{ChannelID: "C123", UserID: "U_ASKER", TS: "100.000", Text: "read this"}},
		IgnoreExistingBotReply: true,
	})

	if failures != 0 || mutations != 0 || len(calls) != 1 || !calls[0].Success {
		t.Fatalf("calls=%#v failures=%d mutations=%d, want human freshness skip", calls, failures, mutations)
	}
	if calls[0].Result != "thread_has_newer_activity" {
		t.Fatalf("call result = %q, want thread_has_newer_activity", calls[0].Result)
	}
	if got := len(poster.Calls()); got != 0 {
		t.Fatalf("poster calls = %d, want human activity to suppress forced reply", got)
	}
}

func installSlackRepliesFixture(t *testing.T, messages []SlackMessage) func() {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/conversations.replies" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(slackRepliesResponse{OK: true, Messages: messages})
	}))
	previous := slackThreadFetchAPIBaseURL
	slackThreadFetchAPIBaseURL = server.URL
	return func() {
		slackThreadFetchAPIBaseURL = previous
		server.Close()
	}
}
