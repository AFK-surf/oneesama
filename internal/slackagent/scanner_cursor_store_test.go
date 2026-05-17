package slackagent

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestSlackScannerCursorStorePersistsAcrossServiceRestart(t *testing.T) {
	t.Parallel()

	dataDir := t.TempDir()
	cfg := Config{
		Persistence: appconfig.PersistenceConfig{Provider: "json-file", DataDir: dataDir},
		Slack: appconfig.SlackConfig{
			EventBuffer: appconfig.SlackEventBufferConfig{Enabled: true},
		},
	}
	ctx := context.Background()

	first := NewService(cfg)
	first.setInboundCursor(ctx, "C123", "1778765800.000000")
	first.setInboundCursor(ctx, "C123", "1778765700.000000")
	if got := first.inbound.Cursor("C123"); got != "1778765800.000000" {
		t.Fatalf("first service cursor = %q, want latest timestamp", got)
	}

	second := NewService(cfg)
	if got := second.inbound.Cursor("C123"); got != "1778765800.000000" {
		t.Fatalf("reopened service cursor = %q, want persisted timestamp", got)
	}
	second.setInboundCursor(ctx, "C123", "1778765900.000000")

	third := NewService(cfg)
	if got := third.inbound.Cursor("C123"); got != "1778765900.000000" {
		t.Fatalf("third service cursor = %q, want advanced persisted timestamp", got)
	}
	if _, err := os.Stat(filepath.Join(dataDir, slackScannerCursorsCollection+".json")); err != nil {
		t.Fatalf("scanner cursor collection file missing: %v", err)
	}
	if stats := third.scannerCursors.Stats(ctx); stats.Channels != 1 {
		t.Fatalf("scanner cursor stats = %+v, want one channel", stats)
	}
}

func TestSweepSlackScannerPersistsCursor(t *testing.T) {
	t.Parallel()

	dataDir := t.TempDir()
	cfg := Config{
		Persistence: appconfig.PersistenceConfig{Provider: "json-file", DataDir: dataDir},
		Slack: appconfig.SlackConfig{
			EventBuffer: appconfig.SlackEventBufferConfig{Enabled: true},
		},
	}
	ctx := context.Background()
	first := NewService(cfg)
	result := first.SweepSlackScanner(ctx, SlackScannerSweepRequest{
		WorkspaceID: "T123",
		Flush:       boolPtr(false),
		Channels: []SlackScannerChannel{{
			ID: "C123",
			Messages: []SlackInboundMessage{
				{TS: "1778765800.000000", UserID: "U1", Text: "hello"},
				{TS: "1778765900.000000", UserID: "U1", Text: "again"},
			},
		}},
	})
	if !result.OK || len(result.Sweeps) != 1 {
		t.Fatalf("sweep result = %+v", result)
	}
	if got := result.Sweeps[0].NextCursor; got != "1778765900.000000" {
		t.Fatalf("next cursor = %q, want latest message ts", got)
	}

	second := NewService(cfg)
	if got := second.inbound.Cursor("C123"); got != "1778765900.000000" {
		t.Fatalf("reopened service cursor = %q, want scanner sweep timestamp", got)
	}
}
