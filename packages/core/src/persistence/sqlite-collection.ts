import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const SQLITE_STATE_SCHEMA_VERSION = 1;

export interface CreateSqliteCollectionOptions {
  dbPath: string;
  collection?: string;
}

const SQLITE_BUSY_RETRY_MS = [25, 50, 100, 200, 400, 800];

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isBusyError(error) {
  return (
    error?.code === "SQLITE_BUSY" ||
    error?.code === "SQLITE_LOCKED" ||
    /database is locked/i.test(error?.message || "")
  );
}

function withSqliteBusyRetry(label, fn) {
  let lastError;
  for (let attempt = 0; attempt <= SQLITE_BUSY_RETRY_MS.length; attempt += 1) {
    try {
      return fn();
    } catch (error) {
      if (!isBusyError(error) || attempt === SQLITE_BUSY_RETRY_MS.length) throw error;
      lastError = error;
      sleepSync(SQLITE_BUSY_RETRY_MS[attempt]);
    }
  }

  throw new Error(
    `${label} failed after sqlite busy retries: ${lastError?.message || "unknown sqlite error"}`,
  );
}

function safeParseJson(raw, context) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Failed to parse sqlite state JSON for ${context}: ${error.message}`, {
      cause: error,
    });
  }
}

function migrate(db) {
  withSqliteBusyRetry("sqlite state migration", () => {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE IF NOT EXISTS mab_schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mab_state_collection (
        collection TEXT NOT NULL,
        id TEXT NOT NULL,
        value_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (collection, id)
      );

      CREATE INDEX IF NOT EXISTS idx_mab_state_collection_collection_updated
        ON mab_state_collection(collection, updated_at DESC);
    `);

    db.prepare(
      `
      INSERT OR IGNORE INTO mab_schema_migrations (version, name, applied_at)
      VALUES (?, ?, ?)
    `,
    ).run(SQLITE_STATE_SCHEMA_VERSION, "mab_state_collection", new Date().toISOString());
  });
}

export function createSqliteCollection({
  dbPath,
  collection = "default",
}: CreateSqliteCollectionOptions) {
  if (!dbPath) throw new Error("dbPath is required for sqlite state provider");
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { timeout: 5000 });
  try {
    db.pragma("busy_timeout = 5000");
    migrate(db);
  } catch (error) {
    db.close();
    throw error;
  }

  const getStmt = db.prepare(`
    SELECT value_json
    FROM mab_state_collection
    WHERE collection = ? AND id = ?
  `);
  const setStmt = db.prepare(`
    INSERT INTO mab_state_collection (collection, id, value_json, created_at, updated_at)
    VALUES (@collection, @id, @valueJson, @now, @now)
    ON CONFLICT(collection, id) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = excluded.updated_at
  `);
  const listStmt = db.prepare(`
    SELECT id, value_json
    FROM mab_state_collection
    WHERE collection = ?
    ORDER BY created_at ASC, id ASC
  `);

  return {
    provider: "sqlite",
    path: dbPath,
    collection,
    schemaVersion: SQLITE_STATE_SCHEMA_VERSION,
    get(id) {
      return withSqliteBusyRetry(`sqlite get ${collection}/${id}`, () => {
        const row = getStmt.get(collection, id);
        return row ? safeParseJson(row.value_json, `${collection}/${id}`) : null;
      });
    },
    set(id, value) {
      return withSqliteBusyRetry(`sqlite set ${collection}/${id}`, () => {
        setStmt.run({
          collection,
          id,
          valueJson: JSON.stringify(value),
          now: new Date().toISOString(),
        });
        return value;
      });
    },
    list() {
      return withSqliteBusyRetry(`sqlite list ${collection}`, () =>
        listStmt
          .all(collection)
          .map((row) => safeParseJson(row.value_json, `${collection}/${row.id}`)),
      );
    },
    close() {
      db.close();
    },
  };
}
