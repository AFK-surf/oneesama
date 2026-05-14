package meetingagent

import (
	"context"
	"fmt"
	"time"
)

func (s *Service) ClaimMeetdMeetingForJoin(ctx context.Context, id int64) (*MeetdMeetingRecord, error) {
	s.meetdWriteMu.Lock()
	defer s.meetdWriteMu.Unlock()

	record, err := s.GetMeetdMeeting(ctx, id)
	if err != nil {
		return nil, err
	}
	if record == nil || record.Status != "pending" {
		return nil, fmt.Errorf("meeting %d not in pending state", id)
	}
	record.Status = "joining"
	record.UpdatedAt = time.Now().UTC()
	store, err := s.meetdMeetingCollection()
	if err != nil {
		return nil, err
	}
	if err := store.Set(ctx, meetdMeetingKey(id), *record); err != nil {
		return nil, fmt.Errorf("claim meeting for join: %w", err)
	}
	return record, nil
}

func (s *Service) SetMeetdMeetingSession(ctx context.Context, id int64, sessionID string) (*MeetdMeetingRecord, error) {
	s.meetdWriteMu.Lock()
	defer s.meetdWriteMu.Unlock()

	record, err := s.GetMeetdMeeting(ctx, id)
	if err != nil || record == nil {
		return record, err
	}
	record.SessionID = sessionID
	record.UpdatedAt = time.Now().UTC()
	store, err := s.meetdMeetingCollection()
	if err != nil {
		return nil, err
	}
	if err := store.Set(ctx, meetdMeetingKey(id), *record); err != nil {
		return nil, fmt.Errorf("set meeting session: %w", err)
	}
	return record, nil
}

func (s *Service) CleanupStaleMeetdMeetings(ctx context.Context, olderThan time.Duration, now time.Time) ([]MeetdMeetingRecord, error) {
	meetings, err := s.ListMeetdMeetings(ctx, "")
	if err != nil {
		return nil, err
	}
	cleaned := make([]MeetdMeetingRecord, 0)
	cutoff := now.Add(-olderThan)
	for _, meeting := range meetings {
		if meeting.Status != "joining" && meeting.Status != "active" {
			continue
		}
		if meeting.UpdatedAt.IsZero() || meeting.UpdatedAt.After(cutoff) {
			continue
		}
		updated, err := s.UpdateMeetdMeetingState(ctx, meeting.ID, "failed", "daemon restart", now)
		if err != nil {
			return cleaned, err
		}
		if updated != nil {
			cleaned = append(cleaned, *updated)
		}
	}
	return cleaned, nil
}

func (s *Service) UpdateMeetdWebhookState(ctx context.Context, id int64, state, webhookErr string, attempts int, event string) error {
	s.meetdWriteMu.Lock()
	defer s.meetdWriteMu.Unlock()

	record, err := s.GetMeetdMeeting(ctx, id)
	if err != nil || record == nil {
		return err
	}
	record.WebhookState = state
	record.WebhookError = webhookErr
	record.WebhookAttempts = attempts
	record.WebhookLastAt = time.Now().UTC().Format(time.RFC3339Nano)
	record.WebhookLastEvent = event
	record.UpdatedAt = time.Now().UTC()
	store, err := s.meetdMeetingCollection()
	if err != nil {
		return err
	}
	if err := store.Set(ctx, meetdMeetingKey(id), *record); err != nil {
		return fmt.Errorf("update webhook state: %w", err)
	}
	return nil
}
