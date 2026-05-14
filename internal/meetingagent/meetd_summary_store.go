package meetingagent

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/AFK-surf/oneesama/internal/persistence"
)

const meetdSummariesCollection = "meetd_summaries"

func (s *Service) SetMeetdMeetingSummary(ctx context.Context, id int64, summary MeetdSummaryData) error {
	store, err := s.meetdSummaryCollection()
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	record := MeetdMeetingSummaryRecord{
		MeetingID: id,
		Summary:   summary,
		CreatedAt: now,
		UpdatedAt: now,
	}
	if existing, ok, err := store.Get(ctx, meetdMeetingKey(id)); err != nil {
		return fmt.Errorf("get meeting summary: %w", err)
	} else if ok {
		record.CreatedAt = existing.CreatedAt
	}
	if err := store.Set(ctx, meetdMeetingKey(id), record); err != nil {
		return fmt.Errorf("set meeting summary: %w", err)
	}
	return nil
}

func (s *Service) meetdMeetingSummary(ctx context.Context, id int64) (*MeetdMeetingSummaryRecord, error) {
	store, err := s.meetdSummaryCollection()
	if err != nil {
		return nil, err
	}
	record, ok, err := store.Get(ctx, strconv.FormatInt(id, 10))
	if err != nil {
		return nil, fmt.Errorf("get meeting summary: %w", err)
	}
	if !ok {
		return nil, nil
	}
	return &record, nil
}

func (s *Service) meetdSummaryCollection() (*persistence.TypedCollection[MeetdMeetingSummaryRecord], error) {
	s.meetdMu.Lock()
	defer s.meetdMu.Unlock()
	if s.meetdSummaryStore != nil {
		return s.meetdSummaryStore, nil
	}
	store, err := persistence.OpenTyped[MeetdMeetingSummaryRecord](persistence.Options{
		Provider:   persistence.NormalizeProvider(s.persistence.Provider),
		Collection: meetdSummariesCollection,
		DataDir:    s.persistence.DataDir,
		SQLitePath: s.persistence.SQLitePath,
	})
	if err != nil {
		s.logger.Warn("meetd summary store init failed", "error", err)
		return nil, fmt.Errorf("open meetd summary store: %w", err)
	}
	s.meetdSummaryStore = store
	return store, nil
}
