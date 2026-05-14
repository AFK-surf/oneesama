package slackagent

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/AFK-surf/oneesama/internal/persistence"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

const (
	meetingThreadsCollection        = "slack_meeting_threads"
	meetingResultDeliveryCollection = "slack_meeting_result_delivery"
	meetingResultReservationTTL     = 10 * time.Minute
)

type MeetingThreadRecord struct {
	ID              string `json:"id"`
	DedupeKey       string `json:"dedupe_key"`
	RemoteMeetingID int64  `json:"remote_meeting_id"`
	SlackChannelID  string `json:"slack_channel_id"`
	SlackThreadTS   string `json:"slack_thread_ts"`
	CreatedAt       string `json:"created_at"`
	UpdatedAt       string `json:"updated_at"`
}

type MeetingResultDeliveryRecord struct {
	ID        string `json:"id"`
	MeetingID int64  `json:"meeting_id"`
	Status    string `json:"status"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
}

type meetingWebhookStore struct {
	logger     *slog.Logger
	threads    *persistence.TypedCollection[MeetingThreadRecord]
	deliveries *persistence.TypedCollection[MeetingResultDeliveryRecord]
}

func newMeetingWebhookStore(cfg appconfig.PersistenceConfig, logger *slog.Logger) *meetingWebhookStore {
	threads, err := persistence.OpenTyped[MeetingThreadRecord](persistence.Options{
		Provider:   persistence.NormalizeProvider(cfg.Provider),
		Collection: meetingThreadsCollection,
		DataDir:    cfg.DataDir,
		SQLitePath: cfg.SQLitePath,
	})
	if err != nil {
		logger.Warn("meeting thread store init failed", "error", err)
		return nil
	}
	deliveries, err := persistence.OpenTyped[MeetingResultDeliveryRecord](persistence.Options{
		Provider:   persistence.NormalizeProvider(cfg.Provider),
		Collection: meetingResultDeliveryCollection,
		DataDir:    cfg.DataDir,
		SQLitePath: cfg.SQLitePath,
	})
	if err != nil {
		logger.Warn("meeting result delivery store init failed", "error", err)
		_ = threads.Close()
		return nil
	}
	return &meetingWebhookStore{logger: logger, threads: threads, deliveries: deliveries}
}

func (s *meetingWebhookStore) GetThreadByRemoteID(ctx context.Context, meetingID int64) (*MeetingThreadRecord, error) {
	if s == nil || s.threads == nil || meetingID == 0 {
		return nil, nil
	}
	records, err := s.threads.List(ctx)
	if err != nil {
		return nil, fmt.Errorf("list meeting threads: %w", err)
	}
	for _, record := range records {
		if record.RemoteMeetingID == meetingID {
			return &record, nil
		}
	}
	return nil, nil
}

func (s *meetingWebhookStore) InsertThread(ctx context.Context, payload NormalizedMeetingWebhookPayload, ref MeetingSlackRef, postTS string) (*MeetingThreadRecord, error) {
	if s == nil || s.threads == nil || payload.MeetingID == 0 || ref.ChannelID == "" {
		return nil, nil
	}
	id := fmt.Sprintf("remote:%d", payload.MeetingID)
	existing, ok, err := s.threads.Get(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("load meeting thread: %w", err)
	}
	if ok {
		return &existing, nil
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	record := MeetingThreadRecord{
		ID:              id,
		DedupeKey:       id,
		RemoteMeetingID: payload.MeetingID,
		SlackChannelID:  ref.ChannelID,
		SlackThreadTS:   firstNonEmpty(ref.ThreadTS, postTS),
		CreatedAt:       now,
		UpdatedAt:       now,
	}
	if err := s.threads.Set(ctx, id, record); err != nil {
		return nil, fmt.Errorf("insert meeting thread: %w", err)
	}
	return &record, nil
}

func (s *meetingWebhookStore) ResolveRef(ctx context.Context, payload NormalizedMeetingWebhookPayload) MeetingSlackRef {
	if payload.SlackRef.ChannelID != "" {
		payload.SlackRef.Source = firstNonEmpty(payload.SlackRef.Source, "payload")
		return payload.SlackRef
	}
	thread, err := s.GetThreadByRemoteID(ctx, payload.MeetingID)
	if err != nil {
		if s != nil && s.logger != nil {
			s.logger.Warn("meeting webhook thread lookup failed", "meeting_id", payload.MeetingID, "error", err)
		}
		return MeetingSlackRef{Source: "missing"}
	}
	if thread == nil {
		return MeetingSlackRef{Source: "missing"}
	}
	return MeetingSlackRef{
		ChannelID: thread.SlackChannelID,
		ThreadTS:  thread.SlackThreadTS,
		Source:    "meeting_thread",
	}
}

func (s *meetingWebhookStore) ReserveResult(ctx context.Context, meetingID int64) (bool, *MeetingResultDeliveryRecord, error) {
	if s == nil || s.deliveries == nil || meetingID == 0 {
		return true, nil, nil
	}
	if _, err := s.CleanupStaleReservations(ctx, meetingResultReservationTTL); err != nil {
		return false, nil, err
	}
	id := meetingResultDeliveryID(meetingID)
	existing, ok, err := s.deliveries.Get(ctx, id)
	if err != nil {
		return false, nil, fmt.Errorf("load meeting result delivery: %w", err)
	}
	if ok {
		return false, &existing, nil
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	record := MeetingResultDeliveryRecord{ID: id, MeetingID: meetingID, Status: "pending", CreatedAt: now, UpdatedAt: now}
	if err := s.deliveries.Set(ctx, id, record); err != nil {
		return false, nil, fmt.Errorf("reserve meeting result delivery: %w", err)
	}
	return true, &record, nil
}

func (s *meetingWebhookStore) ConfirmResult(ctx context.Context, meetingID int64) (*MeetingResultDeliveryRecord, error) {
	return s.setDeliveryState(ctx, meetingID, "processed")
}

func (s *meetingWebhookStore) FailResult(ctx context.Context, meetingID int64) error {
	if s == nil || s.deliveries == nil || meetingID == 0 {
		return nil
	}
	return s.deliveries.Delete(ctx, meetingResultDeliveryID(meetingID))
}

func (s *meetingWebhookStore) ResetResult(ctx context.Context, meetingID int64) error {
	return s.FailResult(ctx, meetingID)
}

func (s *meetingWebhookStore) setDeliveryState(ctx context.Context, meetingID int64, status string) (*MeetingResultDeliveryRecord, error) {
	if s == nil || s.deliveries == nil || meetingID == 0 {
		return nil, nil
	}
	id := meetingResultDeliveryID(meetingID)
	now := time.Now().UTC().Format(time.RFC3339Nano)
	record, ok, err := s.deliveries.Get(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("load meeting result delivery: %w", err)
	}
	if !ok {
		record = MeetingResultDeliveryRecord{ID: id, MeetingID: meetingID, CreatedAt: now}
	}
	record.Status = status
	record.UpdatedAt = now
	if err := s.deliveries.Set(ctx, id, record); err != nil {
		return nil, fmt.Errorf("save meeting result delivery: %w", err)
	}
	return &record, nil
}

func (s *meetingWebhookStore) CleanupStaleReservations(ctx context.Context, olderThan time.Duration) (int, error) {
	if s == nil || s.deliveries == nil {
		return 0, nil
	}
	records, err := s.deliveries.List(ctx)
	if err != nil {
		return 0, fmt.Errorf("list meeting result deliveries: %w", err)
	}
	cutoff := time.Now().Add(-olderThan)
	cleaned := 0
	for _, record := range records {
		if strings.TrimSpace(record.Status) != "pending" {
			continue
		}
		createdAt, err := time.Parse(time.RFC3339Nano, record.CreatedAt)
		if err != nil || createdAt.Before(cutoff) {
			if err := s.deliveries.Delete(ctx, record.ID); err != nil {
				return cleaned, fmt.Errorf("delete stale delivery reservation: %w", err)
			}
			cleaned++
		}
	}
	return cleaned, nil
}

func meetingResultDeliveryID(meetingID int64) string {
	return fmt.Sprintf("%d", meetingID)
}
