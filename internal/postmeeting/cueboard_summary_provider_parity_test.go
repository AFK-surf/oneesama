//go:build cueboardparity

package postmeeting

import (
	"context"
	"errors"
	"strings"
	"testing"
)

type stubSummaryLLMClient struct {
	chatResp       SummaryLLMResponse
	chatErr        error
	chatStreamResp SummaryLLMResponse
	chatStreamErr  error
	chatMessages   []SummaryLLMMessage
	streamMessages []SummaryLLMMessage
}

func (s *stubSummaryLLMClient) Chat(_ context.Context, messages []SummaryLLMMessage) (SummaryLLMResponse, error) {
	s.chatMessages = append([]SummaryLLMMessage(nil), messages...)
	return s.chatResp, s.chatErr
}

func (s *stubSummaryLLMClient) ChatStream(_ context.Context, messages []SummaryLLMMessage, _ func(string)) (SummaryLLMResponse, error) {
	s.streamMessages = append([]SummaryLLMMessage(nil), messages...)
	return s.chatStreamResp, s.chatStreamErr
}

func TestCueboardParityLLMSummarizerFallsBackToStreaming(t *testing.T) {
	t.Parallel()

	client := &stubSummaryLLMClient{
		chatErr:        errors.New("non-stream path failed"),
		chatStreamResp: SummaryLLMResponse{Content: `{"title":"Recovered","participants":[],"highlights":["ok"],"action_items":[],"decisions":[]}`},
	}
	var gotModel string
	summarizer := &LLMSummarizer{
		SummaryModel: "configured-summary-model",
		NewClient: func(model string) (SummaryLLMClient, error) {
			gotModel = model
			return client, nil
		},
	}

	text, err := summarizer.chatLLM(context.Background(), summarizer.SummaryModel, "system", "user")
	if err != nil {
		t.Fatalf("chatLLM returned error: %v", err)
	}
	if gotModel != "configured-summary-model" {
		t.Fatalf("client model = %q, want configured model", gotModel)
	}
	if !strings.Contains(text, `"title":"Recovered"`) {
		t.Fatalf("chatLLM did not return streamed content: %q", text)
	}
	if len(client.chatMessages) != 2 || len(client.streamMessages) != 2 {
		t.Fatalf("messages chat=%#v stream=%#v, want system+user for both paths", client.chatMessages, client.streamMessages)
	}
}

func TestCueboardParityLLMSummarizerRequiresConfiguredModel(t *testing.T) {
	t.Parallel()

	summarizer := &LLMSummarizer{
		NewClient: func(string) (SummaryLLMClient, error) {
			t.Fatal("client factory should not be called without a configured model")
			return nil, nil
		},
	}
	if _, err := summarizer.chatLLM(context.Background(), "", "system", "user"); err == nil {
		t.Fatal("chatLLM error = nil, want fail-closed missing model error")
	}
}

func TestCueboardParityLLMSummarizerParsesStructuredSummary(t *testing.T) {
	t.Parallel()

	client := &stubSummaryLLMClient{
		chatResp: SummaryLLMResponse{Content: `{"title":"Launch Sync","highlights":["ship it"],"action_items":[{"description":"send notes","owner":"Alice"}],"decisions":["go"]}`},
	}
	summarizer := &LLMSummarizer{
		SummaryModel: "configured-summary-model",
		NewClient: func(string) (SummaryLLMClient, error) {
			return client, nil
		},
	}

	summary, err := summarizer.Summarize(context.Background(), PostProcessInput{
		Title:   "Original title",
		MeetURL: "https://meet.google.com/abc-defg-hij",
	}, []NormalizedSegment{{Speaker: "Alice", Text: "Decision: go"}}, []string{"Alice"})
	if err != nil {
		t.Fatalf("Summarize() error = %v", err)
	}
	if summary.Title != "Launch Sync" {
		t.Fatalf("title = %q, want parsed title", summary.Title)
	}
	if summary.MeetURL != "https://meet.google.com/abc-defg-hij" {
		t.Fatalf("meet url = %q, want input meet url fallback", summary.MeetURL)
	}
	if len(summary.Participants) != 1 || summary.Participants[0] != "Alice" {
		t.Fatalf("participants = %#v, want caption participants fallback", summary.Participants)
	}
	if len(summary.Highlights) != 1 || summary.Highlights[0] != "ship it" {
		t.Fatalf("highlights = %#v", summary.Highlights)
	}
	if len(summary.ActionItems) != 1 || !strings.Contains(summary.ActionItems[0], "send notes") || !strings.Contains(summary.ActionItems[0], "owner: Alice") {
		t.Fatalf("action items = %#v", summary.ActionItems)
	}
}

func TestCueboardParityLLMSummarizerCalibrateUsesSummaryModelFallback(t *testing.T) {
	t.Parallel()

	client := &stubSummaryLLMClient{
		chatResp: SummaryLLMResponse{Content: "[00:00:01] Alice: ship it"},
	}
	var gotModel string
	summarizer := &LLMSummarizer{
		SummaryModel: "configured-summary-model",
		NewClient: func(model string) (SummaryLLMClient, error) {
			gotModel = model
			return client, nil
		},
	}

	text, err := summarizer.Calibrate(context.Background(), "[00:00:01] Alice: ship", "ship it")
	if err != nil {
		t.Fatalf("Calibrate() error = %v", err)
	}
	if gotModel != "configured-summary-model" {
		t.Fatalf("calibrate model = %q, want summary model fallback", gotModel)
	}
	if text != "[00:00:01] Alice: ship it" {
		t.Fatalf("calibrated text = %q", text)
	}
}
