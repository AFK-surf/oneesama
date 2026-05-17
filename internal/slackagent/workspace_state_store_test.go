package slackagent

import (
	"context"
	"path/filepath"
	"testing"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func newTestWorkspaceStore(t *testing.T) (*slackWorkspaceStore, func()) {
	t.Helper()
	dir := t.TempDir()
	cfg := appconfig.PersistenceConfig{
		Provider:   "memory",
		DataDir:    dir,
		SQLitePath: filepath.Join(dir, "test.db"),
	}
	store := newSlackWorkspaceStore(cfg, nil)
	if store == nil {
		t.Fatalf("newSlackWorkspaceStore returned nil")
	}
	return store, func() { _ = store.Close() }
}

func newTestThreadCaseStore(t *testing.T) (*slackThreadCaseStore, func()) {
	t.Helper()
	dir := t.TempDir()
	cfg := appconfig.PersistenceConfig{
		Provider:   "memory",
		DataDir:    dir,
		SQLitePath: filepath.Join(dir, "test.db"),
	}
	store := newSlackThreadCaseStore(cfg, nil)
	if store == nil {
		t.Fatalf("newSlackThreadCaseStore returned nil")
	}
	return store, func() { _ = store.Close() }
}

func TestSlackWorkspaceStoreUpsertChannelIsIdempotent(t *testing.T) {
	store, cleanup := newTestWorkspaceStore(t)
	defer cleanup()
	ctx := context.Background()

	first, err := store.UpsertChannel(ctx, SlackChannelRecord{ID: "C123", Name: "xp-test", IsMember: true})
	if err != nil {
		t.Fatalf("first UpsertChannel: %v", err)
	}
	if first == nil || first.ID != "C123" {
		t.Fatalf("first record = %+v, want id=C123", first)
	}
	second, err := store.UpsertChannel(ctx, SlackChannelRecord{ID: "C123", Name: "xp-test-renamed", IsMember: true, IsArchived: true})
	if err != nil {
		t.Fatalf("second UpsertChannel: %v", err)
	}
	if second.Name != "xp-test-renamed" || !second.IsArchived {
		t.Fatalf("second record = %+v, want name updated + IsArchived true", second)
	}

	channels, err := store.ListChannels(ctx)
	if err != nil {
		t.Fatalf("ListChannels: %v", err)
	}
	if len(channels) != 1 {
		t.Fatalf("ListChannels = %d, want 1 unique row after idempotent upsert", len(channels))
	}
}

func TestSlackWorkspaceStoreListChannelIDsSortedDeterministic(t *testing.T) {
	store, cleanup := newTestWorkspaceStore(t)
	defer cleanup()
	ctx := context.Background()

	for _, id := range []string{"C300", "C100", "C200"} {
		if _, err := store.UpsertChannel(ctx, SlackChannelRecord{ID: id, IsMember: true}); err != nil {
			t.Fatalf("UpsertChannel(%q): %v", id, err)
		}
	}
	ids, err := store.ListChannelIDs(ctx)
	if err != nil {
		t.Fatalf("ListChannelIDs: %v", err)
	}
	want := []string{"C100", "C200", "C300"}
	for i, got := range ids {
		if got != want[i] {
			t.Fatalf("ListChannelIDs[%d] = %q, want %q (full=%v)", i, got, want[i], ids)
		}
	}
}

func TestSlackWorkspaceStoreSyncChannelMembersDedupesAndSorts(t *testing.T) {
	store, cleanup := newTestWorkspaceStore(t)
	defer cleanup()
	ctx := context.Background()

	if _, err := store.SyncChannelMembers(ctx, "C42", []string{"U2", "U1", "U2", "  ", "U3"}); err != nil {
		t.Fatalf("SyncChannelMembers: %v", err)
	}
	members, ok, err := store.ListChannelMemberIDs(ctx, "C42")
	if err != nil {
		t.Fatalf("ListChannelMemberIDs: %v", err)
	}
	if !ok {
		t.Fatalf("expected membership row for C42 to exist")
	}
	want := []string{"U1", "U2", "U3"}
	if len(members) != len(want) {
		t.Fatalf("members = %v, want %v", members, want)
	}
	for i, got := range members {
		if got != want[i] {
			t.Fatalf("members[%d] = %q, want %q", i, got, want[i])
		}
	}
}

func TestSlackWorkspaceStoreStatsReportsCounts(t *testing.T) {
	store, cleanup := newTestWorkspaceStore(t)
	defer cleanup()
	ctx := context.Background()

	for _, id := range []string{"C1", "C2", "C3"} {
		if _, err := store.UpsertChannel(ctx, SlackChannelRecord{ID: id, IsMember: true}); err != nil {
			t.Fatalf("UpsertChannel: %v", err)
		}
	}
	if _, err := store.SyncChannelMembers(ctx, "C1", []string{"U1"}); err != nil {
		t.Fatalf("SyncChannelMembers C1: %v", err)
	}
	if _, err := store.SyncChannelMembers(ctx, "C2", []string{"U1", "U2"}); err != nil {
		t.Fatalf("SyncChannelMembers C2: %v", err)
	}
	stats := store.Stats(ctx)
	if stats.Channels != 3 {
		t.Fatalf("Stats.Channels = %d, want 3", stats.Channels)
	}
	if stats.Memberships != 2 {
		t.Fatalf("Stats.Memberships = %d, want 2", stats.Memberships)
	}
}

func TestSlackThreadCaseStoreUpsertAndIsActive(t *testing.T) {
	store, cleanup := newTestThreadCaseStore(t)
	defer cleanup()
	ctx := context.Background()

	record, err := store.UpsertThreadCase(ctx, SlackThreadCase{
		ChannelID: "C1",
		ThreadTS:  "1700000000.000001",
		Owner:     SlackThreadCaseOwnerMention,
		Source:    "app_mention",
	})
	if err != nil {
		t.Fatalf("UpsertThreadCase: %v", err)
	}
	if record == nil || record.Status != SlackThreadCaseStatusActive {
		t.Fatalf("record = %+v, want status=active default", record)
	}
	if !store.IsActive(ctx, "C1", "1700000000.000001") {
		t.Fatalf("IsActive returned false for freshly-claimed thread")
	}
	if store.IsActive(ctx, "C2", "different") {
		t.Fatalf("IsActive returned true for unrelated thread")
	}
}

func TestSlackThreadCaseStoreOwnerSwitchKeepsCreatedAt(t *testing.T) {
	store, cleanup := newTestThreadCaseStore(t)
	defer cleanup()
	ctx := context.Background()

	first, err := store.UpsertThreadCase(ctx, SlackThreadCase{
		ChannelID: "C1",
		ThreadTS:  "1700000000.000001",
		Owner:     SlackThreadCaseOwnerScanner,
		Source:    "scanner_sweep",
	})
	if err != nil {
		t.Fatalf("first UpsertThreadCase: %v", err)
	}
	createdAt := first.CreatedAt
	if createdAt == "" {
		t.Fatalf("expected CreatedAt to be populated on first upsert")
	}
	second, err := store.UpsertThreadCase(ctx, SlackThreadCase{
		ChannelID: "C1",
		ThreadTS:  "1700000000.000001",
		Owner:     SlackThreadCaseOwnerMention,
		Source:    "app_mention",
	})
	if err != nil {
		t.Fatalf("second UpsertThreadCase: %v", err)
	}
	if second.CreatedAt != createdAt {
		t.Fatalf("CreatedAt changed across owner switch: %q -> %q", createdAt, second.CreatedAt)
	}
	if second.Owner != SlackThreadCaseOwnerMention {
		t.Fatalf("owner = %q, want mention", second.Owner)
	}
}

func TestSlackThreadCaseStoreMarkClosedStopsActiveLookup(t *testing.T) {
	store, cleanup := newTestThreadCaseStore(t)
	defer cleanup()
	ctx := context.Background()

	if _, err := store.UpsertThreadCase(ctx, SlackThreadCase{
		ChannelID: "C1",
		ThreadTS:  "1700000000.000001",
		Owner:     SlackThreadCaseOwnerMention,
		Source:    "app_mention",
	}); err != nil {
		t.Fatalf("UpsertThreadCase: %v", err)
	}
	if !store.IsActive(ctx, "C1", "1700000000.000001") {
		t.Fatalf("expected thread to be active before MarkClosed")
	}
	record, err := store.MarkClosed(ctx, "C1", "1700000000.000001", SlackThreadCaseOwnerMention, "manual_close")
	if err != nil {
		t.Fatalf("MarkClosed: %v", err)
	}
	if record.Status != SlackThreadCaseStatusClosed || record.ClosedAt == "" {
		t.Fatalf("MarkClosed record = %+v, want status=closed + closed_at populated", record)
	}
	if store.IsActive(ctx, "C1", "1700000000.000001") {
		t.Fatalf("IsActive must return false after MarkClosed")
	}
}

func TestSlackThreadCaseStoreStatsCountsByStatus(t *testing.T) {
	store, cleanup := newTestThreadCaseStore(t)
	defer cleanup()
	ctx := context.Background()

	upsert := func(channel, ts string, status SlackThreadCaseStatus) {
		_, err := store.UpsertThreadCase(ctx, SlackThreadCase{
			ChannelID: channel,
			ThreadTS:  ts,
			Owner:     SlackThreadCaseOwnerMention,
			Status:    status,
			Source:    "test",
		})
		if err != nil {
			t.Fatalf("UpsertThreadCase: %v", err)
		}
	}
	upsert("C1", "1.000001", SlackThreadCaseStatusActive)
	upsert("C1", "2.000001", SlackThreadCaseStatusActive)
	upsert("C2", "3.000001", SlackThreadCaseStatusExpired)
	if _, err := store.MarkClosed(ctx, "C2", "4.000001", SlackThreadCaseOwnerMention, "close"); err != nil {
		t.Fatalf("MarkClosed: %v", err)
	}

	stats := store.Stats(ctx)
	if stats.Total != 4 {
		t.Fatalf("Stats.Total = %d, want 4", stats.Total)
	}
	if stats.Active != 2 {
		t.Fatalf("Stats.Active = %d, want 2", stats.Active)
	}
	if stats.Closed != 1 {
		t.Fatalf("Stats.Closed = %d, want 1", stats.Closed)
	}
	if stats.Expired != 1 {
		t.Fatalf("Stats.Expired = %d, want 1", stats.Expired)
	}
}

func TestSlackWorkspaceStoreEmptyInputsAreNoOp(t *testing.T) {
	store, cleanup := newTestWorkspaceStore(t)
	defer cleanup()
	ctx := context.Background()

	if rec, err := store.UpsertChannel(ctx, SlackChannelRecord{ID: "  "}); err != nil || rec != nil {
		t.Fatalf("empty UpsertChannel returned err=%v rec=%+v, want both nil", err, rec)
	}
	if rec, err := store.SyncChannelMembers(ctx, "", []string{"U1"}); err != nil || rec != nil {
		t.Fatalf("empty SyncChannelMembers returned err=%v rec=%+v, want both nil", err, rec)
	}
	members, ok, err := store.ListChannelMemberIDs(ctx, "")
	if err != nil || ok || members != nil {
		t.Fatalf("empty ListChannelMemberIDs returned err=%v ok=%v members=%v, want zero values", err, ok, members)
	}
}

func TestSlackThreadCaseStoreEmptyInputsAreNoOp(t *testing.T) {
	store, cleanup := newTestThreadCaseStore(t)
	defer cleanup()
	ctx := context.Background()

	if rec, err := store.UpsertThreadCase(ctx, SlackThreadCase{ChannelID: "", ThreadTS: "ts", Owner: SlackThreadCaseOwnerMention}); err != nil || rec != nil {
		t.Fatalf("empty channel UpsertThreadCase returned err=%v rec=%+v", err, rec)
	}
	if rec, err := store.UpsertThreadCase(ctx, SlackThreadCase{ChannelID: "C1", ThreadTS: "", Owner: SlackThreadCaseOwnerMention}); err != nil || rec != nil {
		t.Fatalf("empty thread UpsertThreadCase returned err=%v rec=%+v", err, rec)
	}
	if rec, ok, err := store.GetThreadCase(ctx, "", ""); err != nil || ok || rec != nil {
		t.Fatalf("empty GetThreadCase returned err=%v ok=%v rec=%+v", err, ok, rec)
	}
}
