package meetingagent

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"
	"unicode"

	"github.com/AFK-surf/oneesama/internal/persistence"
)

const meetdCaptionsCollection = "meetd_captions"
const meetdCaptionExactDuplicateWindow = 5 * time.Second
const meetdCaptionIncrementalUpdateWindow = 8 * time.Second
const meetdCaptionStreamReuseWindow = 15 * time.Minute
const meetdTranscriptSpeakerDedupWindow = 15 * time.Minute

func (s *Service) AddMeetdCaption(ctx context.Context, meetingID int64, input MeetdCaptionInput) (int64, error) {
	s.meetdWriteMu.Lock()
	defer s.meetdWriteMu.Unlock()
	return s.addMeetdCaptionLocked(ctx, meetingID, input)
}

func (s *Service) addMeetdCaptionLocked(ctx context.Context, meetingID int64, input MeetdCaptionInput) (int64, error) {
	store, err := s.meetdCaptionCollection()
	if err != nil {
		return 0, err
	}
	captions, err := store.List(ctx)
	if err != nil {
		return 0, fmt.Errorf("list captions: %w", err)
	}
	id := nextMeetdCaptionID(captions)
	now := time.Now().UTC()
	record := MeetdCaptionRecord{
		ID:        id,
		MeetingID: meetingID,
		Speaker:   normalizeMeetdSpeakerName(firstNonEmpty(input.Speaker, input.User, input.Name)),
		Text:      strings.TrimSpace(firstNonEmpty(input.Text, input.Caption)),
		Timestamp: parseMeetdCaptionTime(firstNonEmpty(input.Timestamp, input.TS), now),
		Source:    firstNonEmpty(input.Source, "live_caption"),
		StreamID:  strings.TrimSpace(firstNonEmpty(input.StreamID, input.Stream)),
		CreatedAt: now,
	}
	if record.Speaker == "" {
		record.Speaker = "Unknown"
	}
	if record.Text == "" {
		return 0, nil
	}
	if existing, ok := findMeetdCaptionForUpdate(captions, record); ok {
		existing.Text = record.Text
		existing.Timestamp = record.Timestamp
		existing.Source = record.Source
		if record.StreamID != "" {
			existing.StreamID = record.StreamID
		}
		if err := store.Set(ctx, meetdCaptionKey(meetingID, existing.ID), existing); err != nil {
			return 0, fmt.Errorf("update caption: %w", err)
		}
		return existing.ID, nil
	}
	if err := store.Set(ctx, meetdCaptionKey(meetingID, id), record); err != nil {
		return 0, fmt.Errorf("insert caption: %w", err)
	}
	return id, nil
}

func (s *Service) ListMeetdCaptions(ctx context.Context, meetingID int64, source string) ([]MeetdCaptionRecord, error) {
	store, err := s.meetdCaptionCollection()
	if err != nil {
		return nil, err
	}
	all, err := store.List(ctx)
	if err != nil {
		return nil, fmt.Errorf("list captions: %w", err)
	}
	captions := make([]MeetdCaptionRecord, 0, len(all))
	for _, caption := range all {
		if caption.MeetingID != meetingID {
			continue
		}
		if source == "all" || caption.Source == source {
			captions = append(captions, caption)
		}
	}
	sort.SliceStable(captions, func(i int, j int) bool {
		if captions[i].Timestamp.Equal(captions[j].Timestamp) {
			return captions[i].ID < captions[j].ID
		}
		return captions[i].Timestamp.Before(captions[j].Timestamp)
	})
	return captions, nil
}

func (s *Service) meetdCaptionCollection() (*persistence.TypedCollection[MeetdCaptionRecord], error) {
	s.meetdMu.Lock()
	defer s.meetdMu.Unlock()
	if s.meetdCaptionStore != nil {
		return s.meetdCaptionStore, nil
	}
	store, err := persistence.OpenTyped[MeetdCaptionRecord](persistence.Options{
		Provider:   persistence.NormalizeProvider(s.persistence.Provider),
		Collection: meetdCaptionsCollection,
		DataDir:    s.persistence.DataDir,
		SQLitePath: s.persistence.SQLitePath,
	})
	if err != nil {
		s.logger.Warn("meetd caption store init failed", "error", err)
		return nil, fmt.Errorf("open meetd caption store: %w", err)
	}
	s.meetdCaptionStore = store
	return store, nil
}

func meetdCaptionSeeds(brief MeetdMeetingBrief) []MeetdCaptionInput {
	switch {
	case len(brief.Captions) > 0:
		return brief.Captions
	case len(brief.CaptionSegments) > 0:
		return brief.CaptionSegments
	default:
		return brief.Segments
	}
}

func parseMeetdCaptionTime(value string, fallback time.Time) time.Time {
	if parsed, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(value)); err == nil {
		return parsed
	}
	if parsed, err := time.Parse(time.RFC3339, strings.TrimSpace(value)); err == nil {
		return parsed
	}
	return fallback
}

func nextMeetdCaptionID(captions []MeetdCaptionRecord) int64 {
	var maxID int64
	for _, caption := range captions {
		if caption.ID > maxID {
			maxID = caption.ID
		}
	}
	return maxID + 1
}

func meetdCaptionKey(meetingID, id int64) string {
	return fmt.Sprintf("%d:%d", meetingID, id)
}

func findMeetdCaptionForUpdate(captions []MeetdCaptionRecord, incoming MeetdCaptionRecord) (MeetdCaptionRecord, bool) {
	if incoming.StreamID != "" {
		for i := len(captions) - 1; i >= 0; i-- {
			existing := captions[i]
			if existing.MeetingID != incoming.MeetingID || existing.Source != incoming.Source || existing.Speaker != incoming.Speaker || existing.StreamID != incoming.StreamID {
				continue
			}
			elapsed := incoming.Timestamp.Sub(existing.Timestamp)
			if elapsed >= 0 && elapsed <= meetdCaptionStreamReuseWindow && meetdCaptionCanReplace(existing.Text, incoming.Text) {
				return existing, true
			}
			break
		}
	}
	for i := len(captions) - 1; i >= 0; i-- {
		existing := captions[i]
		if existing.MeetingID != incoming.MeetingID || existing.Source != incoming.Source || existing.Speaker != incoming.Speaker {
			continue
		}
		elapsed := incoming.Timestamp.Sub(existing.Timestamp)
		if existing.StreamID != "" && incoming.StreamID != "" && existing.StreamID != incoming.StreamID && !meetdCaptionCanReplace(existing.Text, incoming.Text) {
			continue
		}
		if elapsed >= 0 && elapsed <= meetdCaptionExactDuplicateWindow && meetdCaptionTextsEquivalent(existing.Text, incoming.Text) {
			return existing, true
		}
		if elapsed >= 0 && elapsed <= meetdCaptionIncrementalUpdateWindow && meetdCaptionCanReplace(existing.Text, incoming.Text) {
			return existing, true
		}
		if incoming.StreamID != "" && elapsed >= 0 && elapsed <= meetdCaptionStreamReuseWindow && meetdCaptionCanReplace(existing.Text, incoming.Text) {
			return existing, true
		}
	}
	return MeetdCaptionRecord{}, false
}

func meetdCaptionCanReplace(oldText, newText string) bool {
	return meetdCaptionTextsEquivalent(oldText, newText) || meetdCaptionIsIncrementalUpdate(oldText, newText)
}

func meetdCaptionTextsEquivalent(oldText, newText string) bool {
	return string(normalizeMeetdCaptionCompareText(oldText)) == string(normalizeMeetdCaptionCompareText(newText))
}

func meetdCaptionIsIncrementalUpdate(oldText, newText string) bool {
	return meetdIsIncrementalRunes(normalizeMeetdCaptionCompareText(oldText), normalizeMeetdCaptionCompareText(newText))
}

func normalizeMeetdCaptionCompareText(text string) []rune {
	var normalized []rune
	for _, r := range strings.ToLower(strings.TrimSpace(text)) {
		switch {
		case unicode.IsSpace(r):
			continue
		case unicode.IsPunct(r):
			continue
		case unicode.IsSymbol(r):
			continue
		default:
			normalized = append(normalized, r)
		}
	}
	return normalized
}

func meetdIsIncrementalRunes(shorter, longer []rune) bool {
	if len(longer) <= len(shorter) {
		return false
	}
	if len(shorter) == 0 {
		return true
	}
	common := 0
	for i := 0; i < len(shorter); i++ {
		if shorter[i] == longer[i] {
			common++
		}
	}
	return common >= len(shorter)/2
}

func normalizeMeetdSpeakerName(speaker string) string {
	speaker = strings.TrimSpace(strings.Join(strings.Fields(speaker), " "))
	if speaker == "" {
		return ""
	}
	lower := strings.ToLower(speaker)
	switch {
	case strings.Contains(lower, "&") && strings.Contains(lower, "other"):
		if idx := strings.IndexAny(speaker, "&＆"); idx > 0 {
			return strings.TrimSpace(speaker[:idx])
		}
	case strings.Contains(lower, " and ") && strings.Contains(lower, "other"):
		if idx := strings.Index(lower, " and "); idx > 0 {
			return strings.TrimSpace(speaker[:idx])
		}
	}
	for _, sep := range []string{" 和 ", " 與 ", " 与 "} {
		if idx := strings.Index(speaker, sep); idx > 0 && strings.Contains(speaker[idx:], "其他") {
			return strings.TrimSpace(speaker[:idx])
		}
	}
	return speaker
}
