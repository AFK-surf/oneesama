package persistence

import (
	"bytes"
	"context"
	"database/sql"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

const sqliteSchemaVersion = 1

var sqliteHeader = []byte("SQLite format 3\x00")

type sqliteCollection struct {
	db         *sql.DB
	collection string
	dbPath     string
}

func newSQLiteCollection(dbPath string, collection string) (Collection, error) {
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o755); err != nil {
		return nil, fmt.Errorf("create sqlite collection directory: %w", err)
	}

	if sqliteDatabaseNeedsRecovery(dbPath) {
		if err := recoverSQLiteDatabase(dbPath); err != nil {
			return nil, fmt.Errorf("recover sqlite database: %w", err)
		}
	}

	db, err := openSQLiteDatabase(dbPath)
	if err != nil {
		if recoverErr := recoverSQLiteDatabase(dbPath); recoverErr != nil {
			return nil, fmt.Errorf("recover sqlite database: %w (original open error: %v)", recoverErr, err)
		}
		db, err = openSQLiteDatabase(dbPath)
		if err != nil {
			return nil, fmt.Errorf("open sqlite database after recovery: %w", err)
		}
	}

	return &sqliteCollection{
		db:         db,
		collection: strings.TrimSpace(collection),
		dbPath:     dbPath,
	}, nil
}

func openSQLiteDatabase(dbPath string) (*sql.DB, error) {
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, fmt.Errorf("open sqlite database: %w", err)
	}

	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)

	if err := initializeSQLite(context.Background(), db); err != nil {
		_ = db.Close()
		return nil, err
	}

	return db, nil
}

func (c *sqliteCollection) Provider() Provider {
	return ProviderSQLite
}

func (c *sqliteCollection) Name() string {
	return c.collection
}

func (c *sqliteCollection) Path() string {
	return c.dbPath
}

func (c *sqliteCollection) Get(ctx context.Context, id string) (Entry, bool, error) {
	row := c.db.QueryRowContext(
		ctx,
		`SELECT value_json FROM mab_state_collection WHERE collection = ? AND id = ?`,
		c.collection,
		id,
	)

	var payload []byte
	if err := row.Scan(&payload); err != nil {
		if err == sql.ErrNoRows {
			return Entry{}, false, nil
		}
		return Entry{}, false, fmt.Errorf("sqlite get %s/%s: %w", c.collection, id, err)
	}

	return Entry{
		ID:    id,
		Value: cloneJSON(payload),
	}, true, nil
}

func (c *sqliteCollection) Put(ctx context.Context, entry Entry) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if _, err := c.db.ExecContext(
		ctx,
		`
		INSERT INTO mab_state_collection (collection, id, value_json, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(collection, id) DO UPDATE SET
			value_json = excluded.value_json,
			updated_at = excluded.updated_at
		`,
		c.collection,
		entry.ID,
		string(entry.Value),
		now,
		now,
	); err != nil {
		return fmt.Errorf("sqlite put %s/%s: %w", c.collection, entry.ID, err)
	}
	return c.refreshRecoverySnapshot(ctx)
}

func (c *sqliteCollection) Delete(ctx context.Context, id string) error {
	if _, err := c.db.ExecContext(
		ctx,
		`DELETE FROM mab_state_collection WHERE collection = ? AND id = ?`,
		c.collection,
		id,
	); err != nil {
		return fmt.Errorf("sqlite delete %s/%s: %w", c.collection, id, err)
	}
	return c.refreshRecoverySnapshot(ctx)
}

func (c *sqliteCollection) List(ctx context.Context) ([]Entry, error) {
	rows, err := c.db.QueryContext(
		ctx,
		`
		SELECT id, value_json
		FROM mab_state_collection
		WHERE collection = ?
		ORDER BY created_at ASC, id ASC
		`,
		c.collection,
	)
	if err != nil {
		return nil, fmt.Errorf("sqlite list %s: %w", c.collection, err)
	}
	defer func() { _ = rows.Close() }()

	entries := make([]Entry, 0)
	for rows.Next() {
		var id string
		var payload []byte
		if err := rows.Scan(&id, &payload); err != nil {
			return nil, fmt.Errorf("sqlite scan %s: %w", c.collection, err)
		}
		entries = append(entries, Entry{
			ID:    id,
			Value: cloneJSON(payload),
		})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("sqlite rows %s: %w", c.collection, err)
	}
	return entries, nil
}

func (c *sqliteCollection) Close() error {
	return c.db.Close()
}

func (c *sqliteCollection) refreshRecoverySnapshot(ctx context.Context) error {
	if _, err := c.db.ExecContext(ctx, `PRAGMA wal_checkpoint(TRUNCATE)`); err != nil {
		return fmt.Errorf("checkpoint sqlite recovery snapshot: %w", err)
	}
	if err := copyFileAtomic(c.dbPath, sqliteRecoverySnapshotPath(c.dbPath)); err != nil {
		return fmt.Errorf("write sqlite recovery snapshot: %w", err)
	}
	return nil
}

func initializeSQLite(ctx context.Context, db *sql.DB) error {
	pragmas := []string{
		`PRAGMA busy_timeout = 5000`,
		`PRAGMA journal_mode = WAL`,
		`PRAGMA foreign_keys = ON`,
	}
	for _, pragma := range pragmas {
		if _, err := db.ExecContext(ctx, pragma); err != nil {
			return fmt.Errorf("configure sqlite pragma %q: %w", pragma, err)
		}
	}

	migrationStatements := []string{
		`
		CREATE TABLE IF NOT EXISTS mab_schema_migrations (
			version INTEGER PRIMARY KEY,
			name TEXT NOT NULL,
			applied_at TEXT NOT NULL
		)
		`,
		`
		CREATE TABLE IF NOT EXISTS mab_state_collection (
			collection TEXT NOT NULL,
			id TEXT NOT NULL,
			value_json TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (collection, id)
		)
		`,
		`
		CREATE INDEX IF NOT EXISTS idx_mab_state_collection_collection_updated
		ON mab_state_collection(collection, updated_at DESC)
		`,
	}
	for _, statement := range migrationStatements {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("migrate sqlite state store: %w", err)
		}
	}

	now := time.Now().UTC().Format(time.RFC3339Nano)
	if _, err := db.ExecContext(
		ctx,
		`
		INSERT OR IGNORE INTO mab_schema_migrations (version, name, applied_at)
		VALUES (?, ?, ?)
		`,
		sqliteSchemaVersion,
		"mab_state_collection",
		now,
	); err != nil {
		return fmt.Errorf("record sqlite state migration: %w", err)
	}

	return nil
}

func recoverSQLiteDatabase(dbPath string) error {
	if sqliteFileUsable(sqliteRecoverySnapshotPath(dbPath)) {
		if err := quarantineSQLiteFiles(dbPath); err != nil {
			return err
		}
		if err := copyFileAtomic(sqliteRecoverySnapshotPath(dbPath), dbPath); err != nil {
			return fmt.Errorf("restore sqlite recovery snapshot: %w", err)
		}
		return nil
	}
	return quarantineSQLiteFiles(dbPath)
}

func sqliteDatabaseNeedsRecovery(dbPath string) bool {
	file, err := os.Open(dbPath)
	if err != nil {
		return false
	}
	defer func() { _ = file.Close() }()

	header := make([]byte, len(sqliteHeader))
	n, err := io.ReadFull(file, header)
	if err == io.ErrUnexpectedEOF || err == io.EOF {
		return n > 0
	}
	if err != nil {
		return false
	}
	return !bytes.Equal(header, sqliteHeader)
}

func sqliteRecoverySnapshotPath(dbPath string) string {
	return dbPath + ".last-good"
}

func sqliteFileUsable(dbPath string) bool {
	if strings.TrimSpace(dbPath) == "" {
		return false
	}
	if _, err := os.Stat(dbPath); err != nil {
		return false
	}
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return false
	}
	defer func() { _ = db.Close() }()

	var result string
	if err := db.QueryRow(`PRAGMA quick_check`).Scan(&result); err != nil {
		return false
	}
	return strings.EqualFold(strings.TrimSpace(result), "ok")
}

func quarantineSQLiteFiles(dbPath string) error {
	stamp := time.Now().UTC().Format("20060102T150405.000000000Z")
	for _, path := range []string{dbPath, dbPath + "-wal", dbPath + "-shm"} {
		if _, err := os.Stat(path); err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return fmt.Errorf("stat sqlite file for quarantine %s: %w", path, err)
		}
		target := path + ".corrupt-" + stamp
		if err := os.Rename(path, target); err != nil {
			return fmt.Errorf("quarantine sqlite file %s: %w", path, err)
		}
	}
	return nil
}

func copyFileAtomic(sourcePath string, targetPath string) error {
	source, err := os.Open(sourcePath)
	if err != nil {
		return err
	}
	defer func() { _ = source.Close() }()

	if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
		return err
	}
	temp, err := os.CreateTemp(filepath.Dir(targetPath), filepath.Base(targetPath)+".tmp-*")
	if err != nil {
		return err
	}
	tempPath := temp.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(tempPath)
		}
	}()

	if _, err := io.Copy(temp, source); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tempPath, targetPath); err != nil {
		return err
	}
	cleanup = false
	return nil
}
