//go:build cueboardparity

package slackagent

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestCueboardParityMentionTextHelpers(t *testing.T) {
	if got := stripSlackBotMentions("<@U123BOT> summarize this thread"); got != "summarize this thread" {
		t.Fatalf("strip start = %q", got)
	}
	if got := stripSlackBotMentions("hey <@U123BOT> what do you think?"); got != "hey  what do you think?" {
		t.Fatalf("strip middle = %q", got)
	}
	if got := stripSlackBotMentions("<@U123BOT> and <@U123BOT> again"); got != "and  again" {
		t.Fatalf("strip multiple = %q", got)
	}
	if got := stripSlackUserMention("<@UBOT> ask <@UOTHER> to check", "UBOT"); got != "ask <@UOTHER> to check" {
		t.Fatalf("strip exact bot mention = %q", got)
	}
	if got := eventTextToAvatarCommandForBot(SlackEventPayload{Text: "<@UBOT> ask <@UOTHER> to check"}, "UBOT"); got != "work ask <@UOTHER> to check" {
		t.Fatalf("command = %q, want other mentions preserved", got)
	}
}

func TestCueboardParityMentionTranscriptFormatting(t *testing.T) {
	tests := []struct {
		name string
		msgs []SlackMessage
		want string
	}{
		{
			name: "basic messages",
			msgs: []SlackMessage{
				{User: "U1", Text: "hello", TS: "1.0"},
				{User: "U2", Text: "world", TS: "2.0"},
			},
			want: "[ts:1.0] <@U1>: hello\n[ts:2.0] <@U2>: world",
		},
		{
			name: "assistant self messages are tagged",
			msgs: []SlackMessage{
				{User: "U1", Text: "question?", TS: "1.0"},
				{User: "UBOT", Text: "bot reply", TS: "2.0"},
				{User: "U2", Text: "answer", TS: "3.0"},
			},
			want: "[ts:1.0] <@U1>: question?\n[ts:2.0] <@UBOT> [assistant]: bot reply\n[ts:3.0] <@U2>: answer",
		},
		{
			name: "filters subtype messages",
			msgs: []SlackMessage{
				{User: "U1", Text: "hello", TS: "1.0"},
				{User: "U2", Text: "joined", Subtype: "channel_join", TS: "2.0"},
				{User: "U3", Text: "bye", TS: "3.0"},
			},
			want: "[ts:1.0] <@U1>: hello\n[ts:3.0] <@U3>: bye",
		},
		{
			name: "image files are referenced",
			msgs: []SlackMessage{{
				User: "U1", Text: "看这个图", TS: "1.0",
				Files: []SlackFile{{ID: "F123", Name: "screenshot.png", Mimetype: "image/png", Size: 12345, OriginalW: 1280, OriginalH: 720, Permalink: "https://example.com/file"}},
			}},
			want: "[ts:1.0] <@U1>: 看这个图\n  [image: screenshot.png file_id=F123 type=image/png size=12345 1280x720 <https://example.com/file>]",
		},
		{
			name: "assistant block replies prefer rendered blocks",
			msgs: []SlackMessage{{
				User: "UBOT", Text: "hello **world**", TS: "1.0",
				Blocks: []SlackBlock{
					{Type: "section", Text: &SlackBlockText{Type: "mrkdwn", Text: "hello *world*"}},
					{Type: "section", BlockID: replyFeedbackBlockID, Text: &SlackBlockText{Type: "mrkdwn", Text: "_Onee Sama_"}},
				},
			}},
			want: "[ts:1.0] <@UBOT> [assistant]: hello *world*",
		},
		{
			name: "canvas comment excerpt is kept",
			msgs: []SlackMessage{
				{User: "USLACKBOT", Subtype: "document_comment_root", Text: "分类筛选: 按场景、应用、人物等维度分类", TS: "1.0", Blocks: []SlackBlock{{Type: "rich_text", BlockID: "temp:C:LMUb9aef60bff3b83850d267c649"}}},
				{User: "U1", Text: "你觉得这里怎么弄", TS: "2.0"},
			},
			want: "[ts:1.0] <@USLACKBOT>: 分类筛选: 按场景、应用、人物等维度分类\n  [slack canvas comment excerpt section_id=temp:C:LMUb9aef60bff3b83850d267c649; original canvas_id is not present in this thread payload]\n[ts:2.0] <@U1>: 你觉得这里怎么弄",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := formatSlackThreadTranscriptForBot(tt.msgs, "UBOT"); got != tt.want {
				t.Fatalf("transcript = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestCueboardParityMentionCanvasIDsAndOutstandingRequests(t *testing.T) {
	transcript := `see <https://cue-3kl2780.slack.com/docs/T09LH8NN1QR/F0B21MPDR7W|canvas>
  [canvas: "Spec" canvas_id=F123ABC]
  duplicate canvas_id=F123ABC`
	if got, want := fmt.Sprint(extractCanvasIDsFromSlackTranscript(transcript)), "[F123ABC F0B21MPDR7W]"; got != want {
		t.Fatalf("canvas ids = %s, want %s", got, want)
	}

	msgs := []SlackMessage{
		{User: "U1", Text: "最开始的请求", TS: "1.0"},
		{User: "UBOT", Text: "我先看一下", TS: "2.0"},
		{User: "U1", Text: "<@UBOT> 先帮我看看有没有相关 issue", TS: "3.0"},
		{User: "U2", Text: "路过说一句", TS: "4.0"},
		{User: "U1", Text: "如果没有的话顺手建一个", TS: "5.0"},
		{User: "U1", Text: "如果没有的话顺手建一个", TS: "6.0"},
		{User: "U1", Text: "那现在谁来推进？", TS: "7.0"},
	}
	got := collectOutstandingSlackUserRequests(msgs, "U1", "7.0", "UBOT", func(uid string) string { return uid })
	want := []string{"先帮我看看有没有相关 issue", "如果没有的话顺手建一个"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("outstanding requests = %v, want %v", got, want)
	}
}

func TestCueboardParityMentionQueueAndCompaction(t *testing.T) {
	queue := newSlackMentionQueue()
	first := SlackEventPayload{Channel: "C1", User: "U1", TS: "100.1", Text: "<@BOT> first"}
	second := SlackEventPayload{Channel: "C1", User: "U1", TS: "100.2", Text: "<@BOT> second"}
	if start, ack := queue.enqueue("W1", "C1", "123.456", first); !start || ack {
		t.Fatalf("first enqueue = (%v,%v), want (true,false)", start, ack)
	}
	if start, ack := queue.enqueue("W1", "C1", "123.456", second); start || !ack {
		t.Fatalf("second enqueue = (%v,%v), want (false,true)", start, ack)
	}
	batch, ok := queue.dequeueOrStop("W1", "C1", "123.456")
	if !ok || len(batch) != 2 || batch[1].event.TS != "100.2" {
		t.Fatalf("batch = %#v ok=%v", batch, ok)
	}
	if _, ok := queue.dequeueOrStop("W1", "C1", "123.456"); ok || queue.hasQueued("W1", "C1", "123.456") {
		t.Fatal("queue should stop when idle")
	}

	msgs := []SlackMessage{{User: "U0", Text: "parent", TS: "1.0"}, {User: "U1", Text: "m2", TS: "2.0"}, {User: "U1", Text: "m3", TS: "3.0"}, {User: "U1", Text: "m4", TS: "4.0"}, {User: "U1", Text: "m5", TS: "5.0"}}
	compacted, omitted := compactSlackThreadTranscriptMessages(msgs, true, 2)
	if omitted != 2 || len(compacted) != 3 || compacted[1].TS != "4.0" {
		t.Fatalf("compacted=%#v omitted=%d", compacted, omitted)
	}
	annotated := annotateCompactedSlackTranscript("[ts:1.0] parent", "C123", "123.456", 7)
	if !strings.Contains(annotated, "7 earlier thread messages omitted") || !strings.Contains(annotated, "conversations.replies") {
		t.Fatalf("annotated transcript = %q", annotated)
	}
}

func TestCueboardParityMentionReplyRenderingAndFeedbackSummary(t *testing.T) {
	footer := buildReplyFooterBlocks("abc12345678")
	if len(footer) != 0 {
		t.Fatalf("footer = %#v, want no proactive feedback footer", footer)
	}
	if got := softenSlackThreadReplyMarkdown("可以，Linear 里对应的是 *subscriber*。\n- 最稳的是 *轮询脚本*"); got != "可以，Linear 里对应的是 subscriber。\n- 最稳的是 轮询脚本" {
		t.Fatalf("softened = %q", got)
	}
	blocks := buildSlackThreadReplyBlocks("可以，Linear 里对应的是 *subscriber*。", "", nil)
	if len(blocks) != 1 || strings.Contains(slackBlockText(blocks[0]), "_subscriber_") || !strings.Contains(slackBlockText(blocks[0]), "subscriber") {
		t.Fatalf("blocks = %#v", blocks)
	}
	summary := messageSummaryForFeedback(SlackMessage{Blocks: []SlackBlock{
		{Type: "context", Elements: []SlackBlockElement{{Text: &SlackBlockText{Text: ":thought_balloon: _brief thinking_"}}}},
		{Type: "section", Text: &SlackBlockText{Text: "final answer"}},
		{Type: "section", BlockID: replyFeedbackBlockID, Text: &SlackBlockText{Text: "footer"}},
	}})
	if summary != ":thought_balloon: _brief thinking_\nfinal answer" {
		t.Fatalf("feedback summary = %q", summary)
	}
}

func TestCueboardParityMentionFailureCompactionAndLatestAssistantText(t *testing.T) {
	if got := mentionFailureReply(context.DeadlineExceeded, "deadline exceeded"); !strings.Contains(got, "timed out after") {
		t.Fatalf("deadline reply = %q", got)
	}
	if got := mentionFailureReply(context.Canceled, "context canceled"); !strings.Contains(got, "interrupted before completion") || strings.Contains(got, "timed out after") {
		t.Fatalf("cancel reply = %q", got)
	}
	if got := mentionCompactionReply(); !strings.Contains(got, "compressing") || !strings.Contains(got, "Context is getting long") {
		t.Fatalf("compaction reply = %q", got)
	}
	if err := mentionLoopError(errors.New("transport failed"), AvatarCommandResponse{OK: false, Text: "loop failed"}); err == nil || err.Error() != "transport failed" {
		t.Fatalf("mentionLoopError send = %v", err)
	}
	if err := mentionLoopError(nil, AvatarCommandResponse{OK: false, Text: "loop failed"}); err == nil || err.Error() != "loop failed" {
		t.Fatalf("mentionLoopError response = %v", err)
	}
	since := time.Date(2026, 3, 20, 16, 52, 0, 0, time.UTC)
	history := []slackHistoryMessage{
		{Type: slackHistoryMessageTypeMessage, Role: slackHistoryRoleUser, Timestamp: since, Content: []slackHistoryMessageContent{{Type: slackHistoryContentTypeText, Text: "关联方式错了"}}},
		{Type: slackHistoryMessageTypeMessage, Role: slackHistoryRoleAssistant, Timestamp: since.Add(5 * time.Second), Content: []slackHistoryMessageContent{{Type: slackHistoryContentTypeText, Text: "先查一下 attachment API。"}}},
		{Type: slackHistoryMessageTypeMessage, Role: slackHistoryRoleAssistant, Timestamp: since.Add(10 * time.Second), Content: []slackHistoryMessageContent{{Type: slackHistoryContentTypeText, Text: "已通过 attachment 正确关联了 Slack thread 到 CUE-1257。"}}},
	}
	if got := latestAssistantTextSince(history, since); got != "已通过 attachment 正确关联了 Slack thread 到 CUE-1257。" {
		t.Fatalf("latest assistant = %q", got)
	}
}

func TestCueboardParityMentionUserAllowanceAndRichPrompt(t *testing.T) {
	service := NewService(Config{})
	if !service.allowMentionUser("U-pilot") || !service.allowMentionUser("U-other") || service.allowMentionUser("") {
		t.Fatal("allowMentionUser should allow any non-empty user")
	}
	context := buildSlackAppMentionContext(SlackEventPayload{
		User: "U1", Text: "<@UBOT> summarize", Channel: "C123", TS: "123.456",
		Replies: []SlackMessage{{User: "U0", Text: "parent", TS: "123.000"}, {User: "U1", Text: "<@UBOT> summarize", TS: "123.456"}},
	})
	for _, want := range []string{"Thread metadata:", "- channel: C123", "Thread context:", "User <@U1> says:", "summarize"} {
		if !strings.Contains(context.Prompt, want) {
			t.Fatalf("rich prompt missing %q:\n%s", want, context.Prompt)
		}
	}
}

func slackBlockText(block map[string]any) string {
	if text, ok := block["text"].(map[string]any); ok {
		return stringFromAny(text["text"])
	}
	if elements, ok := block["elements"].([]map[string]any); ok {
		var parts []string
		for _, element := range elements {
			parts = append(parts, stringFromAny(element["text"]))
		}
		return strings.Join(parts, "\n")
	}
	return ""
}
