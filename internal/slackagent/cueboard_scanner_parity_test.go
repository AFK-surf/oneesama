//go:build cueboardparity

package slackagent

import (
	"fmt"
	"testing"
)

func testResolveName(uid string) string { return fmt.Sprintf("<@%s>", uid) }

func TestCueboardParityFormatMessageLine(t *testing.T) {
	tests := []struct {
		name string
		msg  SlackMessage
		want string
	}{
		{
			name: "simple message without thread",
			msg: SlackMessage{
				User: "U123",
				Text: "Hello world",
				TS:   "1709812345.123456",
			},
			want: `• [ref:m1 msg_ts:1709812345.123456] <@U123>: "Hello world"`,
		},
		{
			name: "message with thread",
			msg: SlackMessage{
				User:       "U456",
				Text:       "Let's discuss",
				TS:         "1709812345.654321",
				ReplyCount: 10,
				Replies:    []SlackMessage{{User: "U1"}, {User: "U2"}, {User: "U3"}},
			},
			want: `• [ref:m1 msg_ts:1709812345.654321] <@U456>: "Let's discuss" [thread_ts:1709812345.654321, 10 replies, 3 participants]`,
		},
		{
			name: "reply sent to channel references parent thread",
			msg: SlackMessage{
				User:     "U321",
				Text:     "I agree with this",
				TS:       "1709812400.111111",
				ThreadTS: "1709812345.654321",
			},
			want: `• [ref:m1 msg_ts:1709812400.111111] <@U321>: "I agree with this" [reply in thread_ts:1709812345.654321]`,
		},
		{
			name: "long message truncated",
			msg: SlackMessage{
				User: "U789",
				Text: "This is a very long message that exceeds the two hundred character limit and should be truncated to ensure the digest stays readable. We need to add more text here to actually exceed the limit so let me keep typing until we pass it easily.",
				TS:   "1709812345.999999",
			},
			want: `• [ref:m1 msg_ts:1709812345.999999] <@U789>: "This is a very long message that exceeds the two hundred character limit and should be truncated to ensure the digest stays readable. We need to add more text here to actually exceed the limit so let ..."`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := formatMessageLine(tt.msg, testResolveName, "m1")
			if got != tt.want {
				t.Errorf("formatMessageLine() =\n  %q\nwant:\n  %q", got, tt.want)
			}
		})
	}
}
