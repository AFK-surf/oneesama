import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export const DAILY_NOTE_COMPACT_SIZE_THRESHOLD = 4096;
export const DAILY_NOTE_COMPACT_HEADING_THRESHOLD = 10;
export const DAILY_NOTE_COMPACT_SESSION_KIND = "memory_compact";

function text(value, fallback = "") {
  const result = String(value ?? "").trim();
  return result || fallback;
}

function assertInside(rootDir, path) {
  const root = resolve(rootDir);
  const target = resolve(path);
  const rel = relative(root, target);
  if (target === root || (!rel.startsWith("..") && rel !== "..")) return target;
  throw new Error(`daily note compaction path escapes root: ${path}`);
}

export function countLinesWithPrefix(content = "", prefix = "") {
  const wanted = String(prefix);
  if (!wanted) return 0;
  return String(content || "")
    .split("\n")
    .filter((line) => line.startsWith(wanted)).length;
}

export function shouldCompactDailyNote(data = "") {
  const content = Buffer.isBuffer(data) ? data.toString("utf8") : String(data || "");
  return (
    Buffer.byteLength(content, "utf8") >= DAILY_NOTE_COMPACT_SIZE_THRESHOLD &&
    countLinesWithPrefix(content, "## ") >= DAILY_NOTE_COMPACT_HEADING_THRESHOLD
  );
}

export function dailyNoteCompactHash(data = "") {
  const content = Buffer.isBuffer(data) ? data : Buffer.from(String(data || ""), "utf8");
  const digest = createHash("sha256").update(content).digest("hex").slice(0, 16);
  return `${content.length}:${digest}`;
}

export function buildDailyNoteCompactionPrompt(date: unknown): string {
  const today = text(date);
  if (!today) throw new Error("daily note compaction date is required");
  return `You are a memory maintenance worker. Your ONLY job is to compact today's daily notes.

Today's date: ${today}

Instructions:
1. Read the current daily note: memory_get(path="memory/${today}.md")
2. Compact the daily note:
   - Merge duplicate/related topics into single entries
   - Keep each entry to 2-3 lines; record conclusions, not play-by-play
   - Drop trivial items: casual chat, jokes, routine status checks, spam
   - Target: 5-8 entries max
3. Write the compacted daily note: memory_write(path="memory/${today}.md", mode="write", content="...")

Do NOT read or write MEMORY.md. Do NOT add new information. Only compress and organize what is already there.`;
}

export interface BuildDailyNoteCompactionTaskOptions {
  workspaceDir?: string;
  date?: string;
  now?: Date;
}

export function buildDailyNoteCompactionTask({
  workspaceDir,
  date,
  now = new Date(),
}: BuildDailyNoteCompactionTaskOptions = {}) {
  const root = text(workspaceDir);
  if (!root) return { ok: false, eligible: false, error: "workspace_dir_required" };
  const day =
    text(date) ||
    new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  const notePath = assertInside(root, join(root, "memory", `${day}.md`));
  if (!existsSync(notePath)) {
    return { ok: true, eligible: false, reason: "daily_note_missing", date: day, path: notePath };
  }
  const data = readFileSync(notePath, "utf8");
  const sizeBytes = Buffer.byteLength(data, "utf8");
  const headingCount = countLinesWithPrefix(data, "## ");
  const eligible = shouldCompactDailyNote(data);
  return {
    ok: true,
    eligible,
    reason: eligible ? "eligible" : "below_threshold",
    date: day,
    path: notePath,
    sizeBytes,
    headingCount,
    hash: dailyNoteCompactHash(data),
    sessionKind: DAILY_NOTE_COMPACT_SESSION_KIND,
    prompt: eligible ? buildDailyNoteCompactionPrompt(day) : "",
  };
}
