package persistence

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type testRecord struct {
	ID     string `json:"id"`
	Status string `json:"status"`
}

func TestMemoryCollectionIsEphemeral(t *testing.T) {
	ctx := context.Background()

	records, err := OpenTyped[testRecord](Options{
		Provider:   ProviderMemory,
		Collection: "sessions",
	})
	if err != nil {
		t.Fatalf("OpenTyped(memory) error = %v", err)
	}
	defer closeCollection(t, records)

	if err := records.Set(ctx, "session_a", testRecord{ID: "session_a", Status: "created"}); err != nil {
		t.Fatalf("Set() error = %v", err)
	}

	got, ok, err := records.Get(ctx, "session_a")
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if !ok || got.Status != "created" {
		t.Fatalf("Get() = %#v, %v; want created record", got, ok)
	}

	reopened, err := OpenTyped[testRecord](Options{
		Provider:   ProviderMemory,
		Collection: "sessions",
	})
	if err != nil {
		t.Fatalf("OpenTyped(memory reopen) error = %v", err)
	}
	defer closeCollection(t, reopened)

	_, ok, err = reopened.Get(ctx, "session_a")
	if err != nil {
		t.Fatalf("reopened Get() error = %v", err)
	}
	if ok {
		t.Fatalf("memory collection unexpectedly persisted data")
	}
}

func TestJSONFileCollectionPersistsAcrossReopen(t *testing.T) {
	ctx := context.Background()
	tempDir := t.TempDir()

	records, err := OpenTyped[testRecord](Options{
		Provider:   ProviderJSONFile,
		Collection: "sessions",
		DataDir:    tempDir,
	})
	if err != nil {
		t.Fatalf("OpenTyped(json-file) error = %v", err)
	}
	if err := records.Set(ctx, "session_a", testRecord{ID: "session_a", Status: "queued"}); err != nil {
		t.Fatalf("Set() error = %v", err)
	}
	if err := records.Set(ctx, "session_b", testRecord{ID: "session_b", Status: "joined"}); err != nil {
		t.Fatalf("Set() second error = %v", err)
	}
	closeCollection(t, records)

	reopened, err := OpenTyped[testRecord](Options{
		Provider:   ProviderJSONFile,
		Collection: "sessions",
		DataDir:    tempDir,
	})
	if err != nil {
		t.Fatalf("OpenTyped(json-file reopen) error = %v", err)
	}
	defer closeCollection(t, reopened)

	got, ok, err := reopened.Get(ctx, "session_b")
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if !ok || got.Status != "joined" {
		t.Fatalf("Get() = %#v, %v; want joined record", got, ok)
	}

	list, err := reopened.List(ctx)
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("List() len = %d, want 2", len(list))
	}

	if err := reopened.Delete(ctx, "session_a"); err != nil {
		t.Fatalf("Delete() error = %v", err)
	}
	_, ok, err = reopened.Get(ctx, "session_a")
	if err != nil {
		t.Fatalf("Get() after delete error = %v", err)
	}
	if ok {
		t.Fatalf("deleted record still present")
	}
}

func TestJSONFileCollectionLoadsLegacyItems(t *testing.T) {
	ctx := context.Background()
	tempDir := t.TempDir()
	filePath := filepath.Join(tempDir, "sessions.json")

	payload := `{
  "schema": "meeting-avatar-bot.collection.v1",
  "updatedAt": "2026-05-13T00:00:00Z",
  "items": [
    {"id": "session_a", "status": "legacy"}
  ]
}
`
	if err := os.WriteFile(filePath, []byte(payload), 0o644); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	records, err := OpenTyped[testRecord](Options{
		Provider:   ProviderJSONFile,
		Collection: "sessions",
		FilePath:   filePath,
	})
	if err != nil {
		t.Fatalf("OpenTyped(legacy json-file) error = %v", err)
	}
	defer closeCollection(t, records)

	got, ok, err := records.Get(ctx, "session_a")
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if !ok || got.Status != "legacy" {
		t.Fatalf("Get() = %#v, %v; want legacy record", got, ok)
	}
}

func TestSQLiteCollectionPersistsAcrossReopen(t *testing.T) {
	ctx := context.Background()
	tempDir := t.TempDir()
	dbPath := filepath.Join(tempDir, "state.sqlite3")

	records, err := OpenTyped[testRecord](Options{
		Provider:   ProviderSQLite,
		Collection: "worker_reports",
		SQLitePath: dbPath,
	})
	if err != nil {
		t.Fatalf("OpenTyped(sqlite) error = %v", err)
	}
	if err := records.Set(ctx, "job_a", testRecord{ID: "job_a", Status: "completed"}); err != nil {
		t.Fatalf("Set() error = %v", err)
	}
	closeCollection(t, records)

	reopened, err := OpenTyped[testRecord](Options{
		Provider:   ProviderSQLite,
		Collection: "worker_reports",
		SQLitePath: dbPath,
	})
	if err != nil {
		t.Fatalf("OpenTyped(sqlite reopen) error = %v", err)
	}
	defer closeCollection(t, reopened)

	got, ok, err := reopened.Get(ctx, "job_a")
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if !ok || got.Status != "completed" {
		t.Fatalf("Get() = %#v, %v; want completed record", got, ok)
	}

	if err := reopened.Delete(ctx, "job_a"); err != nil {
		t.Fatalf("Delete() error = %v", err)
	}
	_, ok, err = reopened.Get(ctx, "job_a")
	if err != nil {
		t.Fatalf("Get() after delete error = %v", err)
	}
	if ok {
		t.Fatalf("sqlite record still present after delete")
	}
}

func TestCueboardParitySQLiteCollectionQuarantinesCorruptDBAndStartsFresh(t *testing.T) {
	ctx := context.Background()
	tempDir := t.TempDir()
	dbPath := filepath.Join(tempDir, "state.sqlite3")
	if err := os.WriteFile(dbPath, []byte("not a sqlite database"), 0o644); err != nil {
		t.Fatalf("WriteFile(db) error = %v", err)
	}
	if err := os.WriteFile(dbPath+"-wal", []byte("wal"), 0o644); err != nil {
		t.Fatalf("WriteFile(wal) error = %v", err)
	}
	if err := os.WriteFile(dbPath+"-shm", []byte("shm"), 0o644); err != nil {
		t.Fatalf("WriteFile(shm) error = %v", err)
	}

	records, err := OpenTyped[testRecord](Options{
		Provider:   ProviderSQLite,
		Collection: "sessions",
		SQLitePath: dbPath,
	})
	if err != nil {
		t.Fatalf("OpenTyped(sqlite corrupt) error = %v", err)
	}
	defer closeCollection(t, records)

	if err := records.Set(ctx, "session_a", testRecord{ID: "session_a", Status: "fresh"}); err != nil {
		t.Fatalf("Set() error = %v", err)
	}
	got, ok, err := records.Get(ctx, "session_a")
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if !ok || got.Status != "fresh" {
		t.Fatalf("Get() = %#v, %v; want fresh sqlite collection", got, ok)
	}

	entries, err := os.ReadDir(tempDir)
	if err != nil {
		t.Fatalf("ReadDir() error = %v", err)
	}
	var foundDB, foundWAL, foundSHM bool
	for _, entry := range entries {
		name := entry.Name()
		foundDB = foundDB || strings.HasPrefix(name, "state.sqlite3.corrupt-")
		foundWAL = foundWAL || strings.HasPrefix(name, "state.sqlite3-wal.corrupt-")
		foundSHM = foundSHM || strings.HasPrefix(name, "state.sqlite3-shm.corrupt-")
	}
	if !foundDB || !foundWAL || !foundSHM {
		t.Fatalf("quarantined files db/wal/shm = %v/%v/%v; entries=%v", foundDB, foundWAL, foundSHM, entries)
	}
}

func TestCueboardParitySQLiteCollectionRestoresLastKnownGoodSnapshot(t *testing.T) {
	ctx := context.Background()
	tempDir := t.TempDir()
	dbPath := filepath.Join(tempDir, "state.sqlite3")

	records, err := OpenTyped[testRecord](Options{
		Provider:   ProviderSQLite,
		Collection: "sessions",
		SQLitePath: dbPath,
	})
	if err != nil {
		t.Fatalf("OpenTyped(sqlite initial) error = %v", err)
	}
	if err := records.Set(ctx, "session_a", testRecord{ID: "session_a", Status: "restorable"}); err != nil {
		t.Fatalf("Set() error = %v", err)
	}
	closeCollection(t, records)

	if err := os.WriteFile(dbPath, []byte("not a sqlite database"), 0o644); err != nil {
		t.Fatalf("corrupt db error = %v", err)
	}

	reopened, err := OpenTyped[testRecord](Options{
		Provider:   ProviderSQLite,
		Collection: "sessions",
		SQLitePath: dbPath,
	})
	if err != nil {
		t.Fatalf("OpenTyped(sqlite restored) error = %v", err)
	}
	defer closeCollection(t, reopened)

	got, ok, err := reopened.Get(ctx, "session_a")
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if !ok || got.Status != "restorable" {
		t.Fatalf("Get() = %#v, %v; want restored record", got, ok)
	}
}

func TestNormalizeProvider(t *testing.T) {
	cases := map[string]Provider{
		"":               ProviderJSONFile,
		"memory":         ProviderMemory,
		"in_memory":      ProviderMemory,
		"json-file":      ProviderJSONFile,
		"persistent":     ProviderJSONFile,
		"sqlite3":        ProviderSQLite,
		"better-sqlite3": ProviderSQLite,
	}

	for input, want := range cases {
		if got := NormalizeProvider(input); got != want {
			t.Fatalf("NormalizeProvider(%q) = %q, want %q", input, got, want)
		}
	}
}

func closeCollection(t *testing.T, collection interface{ Close() error }) {
	t.Helper()
	if err := collection.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
}
