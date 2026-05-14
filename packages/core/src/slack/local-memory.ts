import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const DEFAULT_LIMIT = 8;
const MAX_SNIPPET_CHARS = 900;
const SQLITE_EXPORT_LIMIT = 200;

export interface LegacySlackMemorySeedOptions {
  targetDir?: string;
  sourceWorkspaceDir?: string;
  sourceDbPath?: string;
}

export interface LocalSlackMemoryProviderOptions {
  enabled?: boolean;
  rootDir?: string;
}

function nowIso() {
  return new Date().toISOString();
}

function safeText(value) {
  return String(value || "").trim();
}

function safeJsonParse(raw, fallback = {}) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function toSlash(path) {
  return String(path || "").replaceAll("\\", "/");
}

function isAllowedMemoryPath(path) {
  const rel = toSlash(path);
  return rel === "MEMORY.md" || (rel.startsWith("memory/") && rel.endsWith(".md"));
}

function assertInside(root, path) {
  const rootAbs = resolve(root);
  const pathAbs = resolve(path);
  if (pathAbs !== rootAbs && relative(rootAbs, pathAbs).startsWith("..")) {
    throw new Error(`path escapes memory root: ${path}`);
  }
  return pathAbs;
}

function walkFiles(root, prefix = "") {
  const dir = join(root, prefix);
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const rel = toSlash(join(prefix, entry.name));
    if (entry.isDirectory()) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      files.push(...walkFiles(root, rel));
      continue;
    }
    if (entry.isFile()) files.push(rel);
  }
  return files;
}

function listWorkspaceMemoryFiles(workspaceDir) {
  if (!workspaceDir || !existsSync(workspaceDir)) return [];
  return walkFiles(workspaceDir)
    .filter(isAllowedMemoryPath)
    .sort((a, b) => a.localeCompare(b));
}

function copyPrivateMemoryFiles({ sourceWorkspaceDir, targetWorkspaceDir }) {
  const copied = [];
  for (const relPath of listWorkspaceMemoryFiles(sourceWorkspaceDir)) {
    const sourcePath = assertInside(sourceWorkspaceDir, join(sourceWorkspaceDir, relPath));
    const targetPath = assertInside(targetWorkspaceDir, join(targetWorkspaceDir, relPath));
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, readFileSync(sourcePath));
    copied.push(relPath);
  }
  return copied;
}

function hasTable(db, table) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
  return Boolean(row);
}

function selectRows(db, table, columns, orderBy = "", limit = SQLITE_EXPORT_LIMIT) {
  if (!hasTable(db, table)) return [];
  const available = new Set(
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => row.name),
  );
  const selected = columns.filter((column) => available.has(column));
  if (!selected.length) return [];
  const order = orderBy && available.has(orderBy) ? ` ORDER BY ${orderBy} DESC` : "";
  return db.prepare(`SELECT ${selected.join(", ")} FROM ${table}${order} LIMIT ?`).all(limit);
}

function exportLegacySlackDb(sourceDbPath) {
  if (!sourceDbPath || !existsSync(sourceDbPath)) {
    return {
      ok: false,
      sourceDbPath: sourceDbPath || "",
      error: "source_db_missing",
      tables: {},
    };
  }
  const db = new Database(sourceDbPath, { readonly: true, fileMustExist: true });
  try {
    const tableNames = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((row) => row.name);
    const tableCounts = Object.fromEntries(
      tableNames.map((table) => {
        try {
          return [table, db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count];
        } catch {
          return [table, null];
        }
      }),
    );
    return {
      ok: true,
      sourceDbPath,
      exportedAt: nowIso(),
      tableCounts,
      channelBrain: selectRows(
        db,
        "channel_brain",
        [
          "workspace_id",
          "channel_id",
          "summary",
          "summary_version",
          "last_session_id",
          "last_thread_ts",
          "updated_at",
        ],
        "updated_at",
      ),
      threadLedger: selectRows(
        db,
        "thread_ledger",
        [
          "workspace_id",
          "channel_id",
          "thread_ts",
          "status",
          "owner_user_id",
          "last_user_id",
          "last_action_type",
          "last_action_status",
          "summary",
          "updated_at",
        ],
        "updated_at",
      ),
      channels: selectRows(db, "channel", ["id", "name", "type", "updated_at"], "updated_at"),
      meetingThreads: selectRows(
        db,
        "meeting_thread",
        ["dedupe_key", "remote_meeting_id", "slack_channel_id", "slack_thread_ts", "created_at"],
        "created_at",
      ),
      feedbackEntries: selectRows(
        db,
        "feedback_entry",
        ["entry_date", "entry_time", "action", "channel", "action_type", "summary", "user_id"],
        "created_at",
      ),
      triageRuns: selectRows(
        db,
        "triage_run",
        [
          "id",
          "occurred_at",
          "status",
          "summary",
          "digest",
          "steps",
          "duration_seconds",
          "mutations",
          "failures",
        ],
        "occurred_at",
      ),
    };
  } finally {
    db.close();
  }
}

export function seedLegacySlackMemory({
  targetDir,
  sourceWorkspaceDir,
  sourceDbPath,
}: LegacySlackMemorySeedOptions = {}) {
  if (!targetDir) throw new Error("targetDir is required for Slack memory seed");
  const rootDir = resolve(targetDir);
  const workspaceDir = join(rootDir, "workspace");
  mkdirSync(workspaceDir, { recursive: true });

  const copiedFiles = sourceWorkspaceDir
    ? copyPrivateMemoryFiles({ sourceWorkspaceDir, targetWorkspaceDir: workspaceDir })
    : [];
  const dbExport = exportLegacySlackDb(sourceDbPath);
  const manifest = {
    schema: "meeting-avatar-bot.slack-memory-seed.v1",
    createdAt: nowIso(),
    rootDir,
    workspaceDir,
    sourceWorkspaceDir: sourceWorkspaceDir || "",
    sourceDbPath: sourceDbPath || "",
    copiedFiles,
    copiedFileCount: copiedFiles.length,
    dbExportPath: join(rootDir, "legacy-slack-agent-seed.json"),
    dbExportOk: dbExport.ok,
    dbExportError: dbExport.error || "",
  };
  writeFileSync(manifest.dbExportPath, `${JSON.stringify(dbExport, null, 2)}\n`);
  writeFileSync(join(rootDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function readSeed(rootDir) {
  const seedPath = join(rootDir, "legacy-slack-agent-seed.json");
  if (!existsSync(seedPath)) return {};
  return safeJsonParse(readFileSync(seedPath, "utf8"), {});
}

function scoreText(content, keywords) {
  const lower = content.toLowerCase();
  let score = 0;
  for (const keyword of keywords) {
    if (lower.includes(keyword)) score += 1;
  }
  return score / Math.max(keywords.length, 1);
}

function snippet(text, maxChars = MAX_SNIPPET_CHARS) {
  const compact = safeText(text).replace(/\n{3,}/g, "\n\n");
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars).trimEnd()}...`;
}

function fileSearchResults({ workspaceDir, query, keywords, limit }) {
  const results = [];
  for (const relPath of listWorkspaceMemoryFiles(workspaceDir)) {
    const content = readFileSync(join(workspaceDir, relPath), "utf8");
    const score = scoreText(content, keywords);
    if (score <= 0) continue;
    results.push({
      kind: "memory_file",
      source: relPath,
      score,
      content: snippet(content),
    });
  }
  return results
    .sort((a, b) => b.score - a.score || a.source.localeCompare(b.source))
    .slice(0, limit);
}

function rowText(row) {
  return Object.values(row || {})
    .map(safeText)
    .filter(Boolean)
    .join("\n");
}

function seedSearchResults({ seed, keywords, limit }) {
  const collections = [
    ["channel_brain", seed.channelBrain || []],
    ["thread_ledger", seed.threadLedger || []],
    ["feedback", seed.feedbackEntries || []],
    ["triage", seed.triageRuns || []],
  ];
  const results = [];
  for (const [kind, rows] of collections) {
    for (const row of rows) {
      const content = rowText(row);
      const score = scoreText(content, keywords);
      if (score <= 0) continue;
      results.push({
        kind,
        source: [row.channel_id, row.thread_ts, row.id].filter(Boolean).join(":") || kind,
        score,
        content: snippet(content),
        row,
      });
    }
  }
  return results.sort((a, b) => b.score - a.score || a.kind.localeCompare(b.kind)).slice(0, limit);
}

export function createLocalSlackMemoryProvider(options: LocalSlackMemoryProviderOptions = {}) {
  const rootDir = resolve(options.rootDir || "");
  const workspaceDir = join(rootDir, "workspace");
  const seed = readSeed(rootDir);

  function summary() {
    const manifestPath = join(rootDir, "manifest.json");
    const manifest = existsSync(manifestPath)
      ? safeJsonParse(readFileSync(manifestPath, "utf8"), {})
      : {};
    return {
      enabled: Boolean(options.enabled),
      rootDir,
      workspaceDir,
      manifest,
      fileCount: listWorkspaceMemoryFiles(workspaceDir).length,
      seed: {
        ok: Boolean(seed.ok),
        channelBrain: seed.channelBrain?.length || 0,
        threadLedger: seed.threadLedger?.length || 0,
        channels: seed.channels?.length || 0,
        feedbackEntries: seed.feedbackEntries?.length || 0,
        triageRuns: seed.triageRuns?.length || 0,
      },
    };
  }

  function search(query, limit = DEFAULT_LIMIT) {
    const text = safeText(query);
    const keywords = [...new Set(text.toLowerCase().split(/\s+/).filter(Boolean))];
    if (!keywords.length) return [];
    const fileResults = fileSearchResults({ workspaceDir, query: text, keywords, limit });
    const dbResults = seedSearchResults({ seed, keywords, limit });
    return [...fileResults, ...dbResults]
      .sort((a, b) => b.score - a.score || a.kind.localeCompare(b.kind))
      .slice(0, limit);
  }

  function buildAgentContext({ query = "", limit = 5 } = {}) {
    if (!options.enabled) return { enabled: false };
    const results = search(query, limit);
    return {
      enabled: true,
      provenance:
        "Local private Slack Agent D memory seed. Content lives in MAB_SLACK_MEMORY_DIR and is intentionally not committed.",
      query,
      resultCount: results.length,
      results,
    };
  }

  return {
    summary,
    search,
    buildAgentContext,
  };
}
