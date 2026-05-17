package slackagent

import (
	"context"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"

	"github.com/AFK-surf/oneesama/internal/persistence"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

const slackScannerCursorsCollection = "slack_scanner_cursors"

// SlackScannerCursor is the durable counterpart of Cueboard's event_cursor
// table. It lets scanner history resume from the latest committed Slack
// timestamp after a process restart instead of re-bootstrap scanning.
type SlackScannerCursor struct {
	ChannelID string `json:"channel_id"`
	Cursor    string `json:"cursor"`
	UpdatedAt string `json:"updated_at"`
}

type slackScannerCursorStore struct {
	mu      sync.Mutex
	logger  warnLogger
	cursors *persistence.TypedCollection[SlackScannerCursor]
}

func newSlackScannerCursorStore(cfg appconfig.PersistenceConfig, logger warnLogger) *slackScannerCursorStore {
	if logger == nil {
		logger = slog.Default()
	}
	cursors, err := persistence.OpenTyped[SlackScannerCursor](persistence.Options{
		Provider:   persistence.NormalizeProvider(cfg.Provider),
		Collection: slackScannerCursorsCollection,
		DataDir:    cfg.DataDir,
		SQLitePath: cfg.SQLitePath,
	})
	if err != nil {
		logger.Warn("slack scanner cursor store init failed", "error", err)
		return nil
	}
	return &slackScannerCursorStore{logger: logger, cursors: cursors}
}

func (s *slackScannerCursorStore) Set(ctx context.Context, channelID, cursor string) error {
	if s == nil || s.cursors == nil {
		return nil
	}
	channelID = strings.TrimSpace(channelID)
	cursor = strings.TrimSpace(cursor)
	if channelID == "" || cursor == "" {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	previous, ok, err := s.cursors.Get(ctx, channelID)
	if err != nil {
		return fmt.Errorf("load scanner cursor %s: %w", channelID, err)
	}
	if ok && previous.Cursor != "" && !slackTSGreater(cursor, previous.Cursor) {
		return nil
	}
	record := SlackScannerCursor{
		ChannelID: channelID,
		Cursor:    cursor,
		UpdatedAt: nowRFC3339(),
	}
	if err := s.cursors.Set(ctx, channelID, record); err != nil {
		return fmt.Errorf("persist scanner cursor %s: %w", channelID, err)
	}
	return nil
}

func (s *slackScannerCursorStore) List(ctx context.Context) ([]SlackScannerCursor, error) {
	if s == nil || s.cursors == nil {
		return nil, nil
	}
	records, err := s.cursors.List(ctx)
	if err != nil {
		return nil, fmt.Errorf("list scanner cursors: %w", err)
	}
	sort.Slice(records, func(i, j int) bool { return records[i].ChannelID < records[j].ChannelID })
	return records, nil
}

type SlackScannerCursorStats struct {
	Channels int `json:"channels"`
}

func (s *slackScannerCursorStore) Stats(ctx context.Context) SlackScannerCursorStats {
	if s == nil || s.cursors == nil {
		return SlackScannerCursorStats{}
	}
	records, err := s.cursors.List(ctx)
	if err != nil {
		if s.logger != nil {
			s.logger.Warn("slack scanner cursor stats failed", "error", err)
		}
		return SlackScannerCursorStats{}
	}
	return SlackScannerCursorStats{Channels: len(records)}
}

func (s *slackScannerCursorStore) Close() error {
	if s == nil || s.cursors == nil {
		return nil
	}
	return s.cursors.Close()
}

func (s *Service) loadScannerCursors(ctx context.Context) {
	if s == nil || s.scannerCursors == nil || s.inbound == nil {
		return
	}
	records, err := s.scannerCursors.List(ctx)
	if err != nil {
		if s.logger != nil {
			s.logger.Warn("slack scanner cursor load failed", "error", err)
		}
		return
	}
	for _, record := range records {
		s.inbound.SetCursor(record.ChannelID, record.Cursor)
	}
}

func (s *Service) setInboundCursor(ctx context.Context, channelID, cursor string) {
	if s == nil || s.inbound == nil {
		return
	}
	channelID = strings.TrimSpace(channelID)
	cursor = strings.TrimSpace(cursor)
	if channelID == "" || cursor == "" {
		return
	}
	previous := s.inbound.Cursor(channelID)
	s.inbound.SetCursor(channelID, cursor)
	current := s.inbound.Cursor(channelID)
	if current == "" || current == previous || current != cursor {
		return
	}
	if err := s.scannerCursors.Set(ctx, channelID, current); err != nil && s.logger != nil {
		s.logger.Warn("slack scanner cursor persist failed", "channel", channelID, "error", err)
	}
}
