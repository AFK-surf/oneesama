package postmeeting

import (
	"context"
	"fmt"
	"strings"
	"time"
)

const (
	summaryLLMTimeout       = 45 * time.Second
	summaryLLMStreamTimeout = 90 * time.Second
)

const meetingSummarySystemPrompt = `You are a meeting notes assistant. You may receive two transcript sources:

1. Transcript assembled from live captions, usually with better speaker labels but possible caption recognition errors.
2. ASR Transcript from post-meeting audio, usually more coherent text but possibly weaker speaker labels.

Cross-reference both sources. Prefer speaker names from live captions and content corrections from ASR.

Produce ONLY a valid JSON object with:
{
  "title": "concise meeting title",
  "participants": ["name1"],
  "highlights": ["point 1"],
  "decisions": ["decision 1"],
  "action_items": ["action item 1"],
  "summary_text": "short prose summary"
}

Rules:
- Do not invent details not present in the transcript.
- Keep highlights and action items concrete.
- Output in the same language as the majority of the transcript.
- If the transcript is too short or non-substantive, leave highlights/action_items/decisions empty instead of padding.
- Output JSON only; no markdown, commentary, or code fences.`

const meetingCalibrateSystemPrompt = `You are a transcript editor.

Combine live captions and ASR transcript into a single calibrated transcript.
Prefer speaker names and timing from captions, and use ASR text only to fill content gaps.
Output transcript lines only; no commentary.`

type SummaryLLMMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type SummaryLLMResponse struct {
	Content string
}

type SummaryLLMClient interface {
	Chat(ctx context.Context, messages []SummaryLLMMessage) (SummaryLLMResponse, error)
	ChatStream(ctx context.Context, messages []SummaryLLMMessage, onDelta func(string)) (SummaryLLMResponse, error)
}

type SummaryLLMClientFactory func(model string) (SummaryLLMClient, error)

type LLMSummarizer struct {
	SummaryModel   string
	CalibrateModel string
	NewClient      SummaryLLMClientFactory
}

func (s *LLMSummarizer) Summarize(ctx context.Context, input PostProcessInput, segments []NormalizedSegment, participants []string) (Summary, error) {
	transcript := joinSegmentText(segments)
	if strings.TrimSpace(transcript) == "" {
		transcript = strings.TrimSpace(firstNonEmpty(input.Transcript.Text, input.TranscriptText, input.Text))
	}
	userMsg := buildMeetingSummaryUserMessage(input, transcript, participants)
	responseText, err := s.chatLLM(ctx, s.SummaryModel, meetingSummarySystemPrompt, userMsg)
	if err != nil {
		return Summary{}, err
	}
	if parsed := summaryFromText(responseText); parsed != nil {
		parsed.Title = firstNonEmpty(parsed.Title, input.Title, "Meeting summary")
		parsed.MeetURL = firstNonEmpty(parsed.MeetURL, input.MeetURL)
		if len(parsed.Participants) == 0 {
			parsed.Participants = participants
		}
		return *parsed, nil
	}
	fallback := buildFallbackSummary(PostProcessInput{
		Title:   input.Title,
		MeetURL: input.MeetURL,
	}, []NormalizedSegment{{Text: cleanResponseText(responseText)}}, participants)
	return fallback, nil
}

func (s *LLMSummarizer) Calibrate(ctx context.Context, captionTranscript, asrTranscript string) (string, error) {
	model := strings.TrimSpace(s.CalibrateModel)
	if model == "" {
		model = strings.TrimSpace(s.SummaryModel)
	}
	userMsg := "## Live Captions\n" + strings.TrimSpace(captionTranscript) + "\n\n## ASR Transcript\n" + strings.TrimSpace(asrTranscript)
	responseText, err := s.chatLLM(ctx, model, meetingCalibrateSystemPrompt, userMsg)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(responseText), nil
}

func (s *LLMSummarizer) chatLLM(ctx context.Context, model, systemPrompt, userMsg string) (string, error) {
	model = strings.TrimSpace(model)
	if model == "" {
		return "", fmt.Errorf("meeting summary model is not configured")
	}
	if s.NewClient == nil {
		return "", fmt.Errorf("meeting summary LLM client is not configured")
	}
	client, err := s.NewClient(model)
	if err != nil {
		return "", fmt.Errorf("create meeting summary LLM client: %w", err)
	}

	messages := []SummaryLLMMessage{
		{Role: "system", Content: strings.TrimSpace(systemPrompt)},
		{Role: "user", Content: strings.TrimSpace(userMsg)},
	}

	chatCtx, chatCancel := context.WithTimeout(ctx, summaryLLMTimeout)
	response, err := client.Chat(chatCtx, messages)
	chatCancel()
	if err != nil {
		streamCtx, streamCancel := context.WithTimeout(ctx, summaryLLMStreamTimeout)
		streamResponse, streamErr := client.ChatStream(streamCtx, messages, nil)
		streamCancel()
		if streamErr != nil {
			return "", fmt.Errorf("meeting summary LLM chat failed (%v); streaming fallback failed (%w)", err, streamErr)
		}
		response = streamResponse
	}

	text := strings.TrimSpace(response.Content)
	if text == "" {
		return "", fmt.Errorf("empty meeting summary LLM response")
	}
	return text, nil
}

func buildMeetingSummaryUserMessage(input PostProcessInput, transcript string, participants []string) string {
	var b strings.Builder
	b.WriteString("Meeting: ")
	b.WriteString(firstNonEmpty(input.Title, "Meeting summary"))
	if input.MeetURL != "" {
		b.WriteString("\nURL: ")
		b.WriteString(input.MeetURL)
	}
	if len(participants) > 0 {
		b.WriteString("\nParticipants: ")
		b.WriteString(strings.Join(participants, ", "))
	}
	if asr := strings.TrimSpace(input.ASRTranscriptText); asr != "" {
		b.WriteString("\n\n## Transcript (live captions / calibrated)\n")
		b.WriteString(strings.TrimSpace(transcript))
		b.WriteString("\n\n## ASR Transcript")
		if provider := strings.TrimSpace(input.ASRProvider); provider != "" {
			b.WriteString(" (")
			b.WriteString(provider)
			b.WriteString(")")
		}
		b.WriteString("\n")
		b.WriteString(asr)
		return b.String()
	}
	b.WriteString("\n\n## Transcript\n")
	b.WriteString(strings.TrimSpace(transcript))
	return b.String()
}
