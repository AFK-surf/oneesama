package meetingagent

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/AFK-surf/oneesama/internal/persistence"
)

const meetingSessionsCollection = "meeting_sessions"

func (s *Service) ListSessions(ctx context.Context) ([]SessionRecord, error) {
	store, err := s.sessionCollection()
	if err != nil {
		return nil, err
	}
	sessions, err := store.List(ctx)
	if err != nil {
		return nil, fmt.Errorf("list meeting sessions: %w", err)
	}
	sort.SliceStable(sessions, func(i int, j int) bool {
		if sessions[i].UpdatedAt == sessions[j].UpdatedAt {
			return sessions[i].ID > sessions[j].ID
		}
		return sessions[i].UpdatedAt > sessions[j].UpdatedAt
	})
	return sessions, nil
}

func (s *Service) GetSession(ctx context.Context, id string) (*SessionRecord, error) {
	store, err := s.sessionCollection()
	if err != nil {
		return nil, err
	}
	sessionID := strings.TrimSpace(id)
	record, ok, err := store.Get(ctx, sessionID)
	if err != nil {
		return nil, fmt.Errorf("get meeting session %s: %w", sessionID, err)
	}
	if !ok {
		return nil, nil
	}
	return &record, nil
}

func (s *Service) UpsertSession(ctx context.Context, input SessionUpsertInput) (SessionRecord, error) {
	store, err := s.sessionCollection()
	if err != nil {
		return SessionRecord{}, err
	}

	record := SessionRecord{
		ID:               strings.TrimSpace(firstNonEmpty(input.ID, input.MeetingID, newSessionID())),
		MeetingID:        strings.TrimSpace(input.MeetingID),
		MeetingURL:       strings.TrimSpace(input.MeetingURL),
		Status:           firstNonEmpty(strings.TrimSpace(input.Status), joinSessionStatusString(joinSessionStatusQueued)),
		Title:            strings.TrimSpace(input.Title),
		ParticipantCount: input.ParticipantCount,
		StartedAt:        strings.TrimSpace(input.StartedAt),
		EndedAt:          strings.TrimSpace(input.EndedAt),
		Metadata:         cloneMap(input.Metadata),
	}

	now := time.Now().UTC().Format(time.RFC3339Nano)
	record.CreatedAt = now
	record.UpdatedAt = now
	if existing, ok, err := store.Get(ctx, record.ID); err != nil {
		return SessionRecord{}, fmt.Errorf("load meeting session %s: %w", record.ID, err)
	} else if ok {
		record.CreatedAt = existing.CreatedAt
		if strings.TrimSpace(input.Status) == "" {
			record.Status = existing.Status
		}
		if record.MeetingID == "" {
			record.MeetingID = existing.MeetingID
		}
		if record.MeetingURL == "" {
			record.MeetingURL = existing.MeetingURL
		}
		if record.Title == "" {
			record.Title = existing.Title
		}
		if record.StartedAt == "" {
			record.StartedAt = existing.StartedAt
		}
		if record.EndedAt == "" {
			record.EndedAt = existing.EndedAt
		}
		if record.ParticipantCount == 0 {
			record.ParticipantCount = existing.ParticipantCount
		}
		if len(record.Metadata) == 0 {
			record.Metadata = cloneMap(existing.Metadata)
		}
	}

	if err := store.Set(ctx, record.ID, record); err != nil {
		return SessionRecord{}, fmt.Errorf("persist meeting session %s: %w", record.ID, err)
	}
	return record, nil
}

func (s *Service) DeleteSession(ctx context.Context, id string) error {
	store, err := s.sessionCollection()
	if err != nil {
		return err
	}
	sessionID := strings.TrimSpace(id)
	if sessionID == "" {
		return fmt.Errorf("meeting session id is required")
	}
	if err := store.Delete(ctx, sessionID); err != nil {
		return fmt.Errorf("delete meeting session %s: %w", sessionID, err)
	}
	return nil
}

func (s *Service) SessionSummary(ctx context.Context) (SessionSummary, error) {
	sessions, err := s.ListSessions(ctx)
	if err != nil {
		return SessionSummary{}, err
	}
	summary := SessionSummary{
		Total:    len(sessions),
		ByStatus: make(map[string]int),
	}
	for _, session := range sessions {
		summary.ByStatus[firstNonEmpty(session.Status, "unknown")]++
	}
	return summary, nil
}

func (s *Service) sessionCollection() (*persistence.TypedCollection[SessionRecord], error) {
	s.sessionMu.Lock()
	defer s.sessionMu.Unlock()

	if s.sessionStore != nil {
		return s.sessionStore, nil
	}

	store, err := persistence.OpenTyped[SessionRecord](persistence.Options{
		Provider:   persistence.NormalizeProvider(s.persistence.Provider),
		Collection: meetingSessionsCollection,
		DataDir:    s.persistence.DataDir,
		SQLitePath: s.persistence.SQLitePath,
	})
	if err != nil {
		s.logger.Warn("meeting session store init failed", "error", err)
		return nil, fmt.Errorf("open meeting session store: %w", err)
	}
	s.sessionStore = store
	return store, nil
}

func newSessionID() string {
	buffer := make([]byte, 4)
	if _, err := rand.Read(buffer); err != nil {
		return fmt.Sprintf("session_%d", time.Now().UnixNano())
	}
	return "session_" + hex.EncodeToString(buffer)
}

func cloneMap(input map[string]any) map[string]any {
	if len(input) == 0 {
		return nil
	}
	cloned := make(map[string]any, len(input))
	for key, value := range input {
		cloned[key] = value
	}
	return cloned
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
