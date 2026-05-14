package meetingagent

import (
	"context"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/AFK-surf/oneesama/internal/persistence"
)

const meetdMeetingsCollection = "meetd_meetings"

var meetdListStatuses = []string{"pending", "joining", "active", "processing", "done", "failed", "cancelled"}

func (s *Service) ScheduleMeetdMeeting(ctx context.Context, brief MeetdMeetingBrief) (int64, error) {
	store, err := s.meetdMeetingCollection()
	if err != nil {
		return 0, err
	}
	s.meetdWriteMu.Lock()
	defer s.meetdWriteMu.Unlock()

	meetings, err := store.List(ctx)
	if err != nil {
		return 0, fmt.Errorf("list meetings: %w", err)
	}
	if brief.EventID != "" {
		for _, meeting := range meetings {
			if meeting.CalendarEventID == brief.EventID {
				return meeting.ID, nil
			}
		}
	}

	startTime, endTime, err := parseMeetdMeetingBriefTimes(brief)
	if err != nil {
		return 0, err
	}
	if brief.MeetURL != "" {
		for _, meeting := range meetings {
			if meeting.MeetURL == brief.MeetURL && isMeetdActiveStatus(meeting.Status) && math.Abs(meeting.StartTime.Sub(startTime).Seconds()) < 1800 {
				return meeting.ID, nil
			}
		}
	}

	id := nextMeetdMeetingID(meetings)
	eventID := brief.EventID
	if eventID == "" {
		eventID = fmt.Sprintf("manual-%d", time.Now().UnixNano())
	}
	now := time.Now().UTC()
	record := MeetdMeetingRecord{
		ID:              id,
		CalendarEventID: eventID,
		MeetURL:         brief.MeetURL,
		Title:           brief.Title,
		StartTime:       startTime,
		EndTime:         endTime,
		Status:          firstNonEmpty(brief.Status, "pending"),
		Attendees:       append([]string(nil), brief.Attendees...),
		ErrorMessage:    brief.Error,
		ArtifactsDir:    brief.ArtifactsDir,
		CreatedAt:       now,
		UpdatedAt:       now,
	}
	if brief.SlackRef != nil {
		record.SlackChannelID = brief.SlackRef.ChannelID
		record.SlackThreadTS = brief.SlackRef.ThreadTS
	}
	if err := store.Set(ctx, meetdMeetingKey(id), record); err != nil {
		return 0, fmt.Errorf("create meeting: %w", err)
	}
	for _, caption := range meetdCaptionSeeds(brief) {
		if _, err := s.addMeetdCaptionLocked(ctx, id, caption); err != nil {
			return 0, fmt.Errorf("store caption: %w", err)
		}
	}
	s.wakeMeetdRuntime()
	return id, nil
}

func (s *Service) GetMeetdMeeting(ctx context.Context, id int64) (*MeetdMeetingRecord, error) {
	store, err := s.meetdMeetingCollection()
	if err != nil {
		return nil, err
	}
	record, ok, err := store.Get(ctx, meetdMeetingKey(id))
	if err != nil {
		return nil, fmt.Errorf("get meeting: %w", err)
	}
	if !ok {
		return nil, nil
	}
	return &record, nil
}

func (s *Service) ListMeetdMeetings(ctx context.Context, status string) ([]MeetdMeetingRecord, error) {
	store, err := s.meetdMeetingCollection()
	if err != nil {
		return nil, err
	}
	all, err := store.List(ctx)
	if err != nil {
		return nil, fmt.Errorf("list meetings: %w", err)
	}
	meetings := filterMeetdMeetings(all, status)
	return meetings, nil
}

func (s *Service) CancelMeetdMeeting(ctx context.Context, id int64) (*MeetdMeetingRecord, error) {
	s.meetdWriteMu.Lock()
	defer s.meetdWriteMu.Unlock()

	record, err := s.GetMeetdMeeting(ctx, id)
	if err != nil || record == nil {
		return record, err
	}
	record.Status = "cancelled"
	record.ErrorMessage = "cancelled via API"
	record.UpdatedAt = time.Now().UTC()
	store, err := s.meetdMeetingCollection()
	if err != nil {
		return nil, err
	}
	if err := store.Set(ctx, meetdMeetingKey(id), *record); err != nil {
		return nil, fmt.Errorf("cancel meeting: %w", err)
	}
	return record, nil
}

func (s *Service) UpdateMeetdMeetingState(ctx context.Context, id int64, status, errorMessage string, updatedAt time.Time) (*MeetdMeetingRecord, error) {
	s.meetdWriteMu.Lock()
	defer s.meetdWriteMu.Unlock()

	record, err := s.GetMeetdMeeting(ctx, id)
	if err != nil || record == nil {
		return record, err
	}
	if status != "" {
		record.Status = status
	}
	record.ErrorMessage = errorMessage
	if updatedAt.IsZero() {
		updatedAt = time.Now().UTC()
	}
	record.UpdatedAt = updatedAt.UTC()
	store, err := s.meetdMeetingCollection()
	if err != nil {
		return nil, err
	}
	if err := store.Set(ctx, meetdMeetingKey(id), *record); err != nil {
		return nil, fmt.Errorf("update meeting state: %w", err)
	}
	return record, nil
}

func (s *Service) SetMeetdMeetingArtifactsDir(ctx context.Context, id int64, dir string) (*MeetdMeetingRecord, error) {
	s.meetdWriteMu.Lock()
	defer s.meetdWriteMu.Unlock()

	record, err := s.GetMeetdMeeting(ctx, id)
	if err != nil || record == nil {
		return record, err
	}
	record.ArtifactsDir = dir
	record.UpdatedAt = time.Now().UTC()
	store, err := s.meetdMeetingCollection()
	if err != nil {
		return nil, err
	}
	if err := store.Set(ctx, meetdMeetingKey(id), *record); err != nil {
		return nil, fmt.Errorf("update meeting artifacts: %w", err)
	}
	return record, nil
}

func (s *Service) meetdMeetingCollection() (*persistence.TypedCollection[MeetdMeetingRecord], error) {
	s.meetdMu.Lock()
	defer s.meetdMu.Unlock()
	if s.meetdStore != nil {
		return s.meetdStore, nil
	}
	store, err := persistence.OpenTyped[MeetdMeetingRecord](persistence.Options{
		Provider:   persistence.NormalizeProvider(s.persistence.Provider),
		Collection: meetdMeetingsCollection,
		DataDir:    s.persistence.DataDir,
		SQLitePath: s.persistence.SQLitePath,
	})
	if err != nil {
		s.logger.Warn("meetd meeting store init failed", "error", err)
		return nil, fmt.Errorf("open meetd meeting store: %w", err)
	}
	s.meetdStore = store
	return store, nil
}

func parseMeetdMeetingBriefTimes(brief MeetdMeetingBrief) (time.Time, time.Time, error) {
	startTime, err := time.Parse(time.RFC3339, brief.StartAt)
	if err != nil {
		return time.Time{}, time.Time{}, fmt.Errorf("parse start_at: %w", err)
	}
	endTime, err := time.Parse(time.RFC3339, brief.EndAt)
	if err != nil {
		return time.Time{}, time.Time{}, fmt.Errorf("parse end_at: %w", err)
	}
	return startTime, endTime, nil
}

func filterMeetdMeetings(meetings []MeetdMeetingRecord, status string) []MeetdMeetingRecord {
	status = strings.TrimSpace(status)
	filtered := make([]MeetdMeetingRecord, 0, len(meetings))
	if status != "" {
		for _, meeting := range meetings {
			if meeting.Status == status {
				filtered = append(filtered, meeting)
			}
		}
		sortMeetdMeetingsByStart(filtered)
		return filtered
	}

	for _, listed := range meetdListStatuses {
		group := make([]MeetdMeetingRecord, 0)
		for _, meeting := range meetings {
			if meeting.Status == listed {
				group = append(group, meeting)
			}
		}
		sortMeetdMeetingsByStart(group)
		filtered = append(filtered, group...)
	}
	return filtered
}

func sortMeetdMeetingsByStart(meetings []MeetdMeetingRecord) {
	sort.SliceStable(meetings, func(i int, j int) bool {
		if meetings[i].StartTime.Equal(meetings[j].StartTime) {
			return meetings[i].ID < meetings[j].ID
		}
		return meetings[i].StartTime.Before(meetings[j].StartTime)
	})
}

func isMeetdActiveStatus(status string) bool {
	switch status {
	case "pending", "joining", "active", "processing":
		return true
	default:
		return false
	}
}

func nextMeetdMeetingID(meetings []MeetdMeetingRecord) int64 {
	var maxID int64
	for _, meeting := range meetings {
		if meeting.ID > maxID {
			maxID = meeting.ID
		}
	}
	return maxID + 1
}

func meetdMeetingKey(id int64) string {
	return strconv.FormatInt(id, 10)
}
