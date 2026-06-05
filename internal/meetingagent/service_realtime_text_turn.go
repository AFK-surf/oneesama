package meetingagent

import (
	"context"
	"errors"
	"strings"

	"github.com/AFK-surf/oneesama/internal/meetrunner"
)

type realtimeTextTurnRunner interface {
	RequestRealtimeTextTurn(context.Context, meetrunner.RealtimeTextTurnInput) (meetrunner.RealtimeTextTurnResult, error)
}

type realtimeEventRunner interface {
	SendRealtimeEvent(context.Context, meetrunner.RealtimeEventInput) (meetrunner.RealtimeEventResult, error)
}

func (s *Service) RequestRealtimeTextTurn(ctx context.Context, input RealtimeTextTurnRequest) (map[string]any, error) {
	text := strings.TrimSpace(input.Text)
	if text == "" {
		return nil, errors.New("text_required")
	}
	session, err := s.resolveActiveJoinSession(ctx, input.SessionID)
	if err != nil {
		return nil, err
	}
	if session == nil {
		return nil, errNoActiveJoin()
	}
	runner, ok := s.meetRunner.(realtimeTextTurnRunner)
	if !ok {
		return nil, errors.New("realtime_text_turn_unsupported")
	}
	result, err := runner.RequestRealtimeTextTurn(ctx, meetrunner.RealtimeTextTurnInput{
		SessionID:    strings.TrimSpace(session.ID),
		Text:         text,
		Instructions: strings.TrimSpace(input.Instructions),
	})
	if err != nil {
		return nil, err
	}
	if result == nil {
		return map[string]any{"ok": false, "error": "empty_realtime_text_turn_result"}, nil
	}
	return map[string]any(result), nil
}

func (s *Service) SendRealtimeEvent(ctx context.Context, input RealtimeEventRequest) (map[string]any, error) {
	if len(input.Event) == 0 {
		return nil, errors.New("event_required")
	}
	if err := validateHostRealtimeEvent(input.Event); err != nil {
		return nil, err
	}
	session, err := s.resolveActiveJoinSession(ctx, input.SessionID)
	if err != nil {
		return nil, err
	}
	if session == nil {
		return nil, errNoActiveJoin()
	}
	runner, ok := s.meetRunner.(realtimeEventRunner)
	if !ok {
		return nil, errors.New("realtime_event_unsupported")
	}
	result, err := runner.SendRealtimeEvent(ctx, meetrunner.RealtimeEventInput{
		SessionID: strings.TrimSpace(session.ID),
		Event:     input.Event,
	})
	if err != nil {
		return nil, err
	}
	if result == nil {
		return map[string]any{"ok": false, "error": "empty_realtime_event_result"}, nil
	}
	return map[string]any(result), nil
}

func validateHostRealtimeEvent(event map[string]any) error {
	eventType := strings.TrimSpace(stringFromAny(event["type"]))
	switch eventType {
	case "":
		return errors.New("realtime_event_type_required")
	case "response.cancel", "input_audio_buffer.clear":
		return nil
	case "conversation.item.input_audio_transcription.completed":
		if strings.TrimSpace(stringFromAny(event["transcript"])) == "" {
			return errors.New("realtime_transcript_required")
		}
		return nil
	default:
		return errors.New("realtime_event_type_not_allowed")
	}
}
