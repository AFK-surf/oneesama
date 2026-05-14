import crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const VALID_MODES = new Set(["new", "shadow", "canary", "rollback"]);

type CutoverMode = "new" | "shadow" | "canary" | "rollback";

interface CutoverControllerOptions {
  mode?: string;
  canaryPercent?: number | string;
  reportPath?: string;
  seed?: string;
}

interface CutoverDecideInput {
  workspaceId?: string;
  channelId?: string;
  userId?: string;
  sessionId?: string;
  command?: string;
}

function clampPercent(value: unknown): number {
  const number = Number.parseFloat(String(value));
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, number));
}

function normalizeMode(mode: unknown): CutoverMode {
  return VALID_MODES.has(String(mode)) ? (String(mode) as CutoverMode) : "new";
}

export function stableBucket(input: unknown): number {
  const digest = crypto
    .createHash("sha256")
    .update(String(input || "meeting-avatar-bot"))
    .digest();
  return (digest.readUInt32BE(0) / 0xffffffff) * 100;
}

export function createCutoverController(options: CutoverControllerOptions = {}) {
  const mode = normalizeMode(options.mode || "new");
  const canaryPercent = clampPercent(options.canaryPercent || 0);
  const reportPath = options.reportPath || "";
  const seed = options.seed || "meeting-avatar-bot";

  function decide(input: CutoverDecideInput = {}) {
    const workspaceId = input.workspaceId || "";
    const channelId = input.channelId || "";
    const userId = input.userId || "";
    const sessionId = input.sessionId || "";
    const command = input.command || "unknown";
    const bucket = stableBucket(
      [seed, workspaceId, channelId, userId, sessionId, command].join(":"),
    );

    if (mode === "rollback") {
      return {
        mode,
        primaryStack: "old",
        shadowStack: "",
        shouldRunNewStack: false,
        shouldRecordShadow: true,
        bucket,
        canaryPercent,
        reason: "rollback_forces_old_stack",
      };
    }

    if (mode === "shadow") {
      return {
        mode,
        primaryStack: "old",
        shadowStack: "new",
        shouldRunNewStack: false,
        shouldRecordShadow: true,
        bucket,
        canaryPercent,
        reason: "shadow_keeps_old_primary",
      };
    }

    if (mode === "canary") {
      const canaryHit = bucket < canaryPercent;
      return {
        mode,
        primaryStack: canaryHit ? "new" : "old",
        shadowStack: canaryHit ? "" : "new",
        shouldRunNewStack: canaryHit,
        shouldRecordShadow: true,
        bucket,
        canaryPercent,
        reason: canaryHit ? "canary_bucket_selected_new_stack" : "canary_bucket_keeps_old_primary",
      };
    }

    return {
      mode,
      primaryStack: "new",
      shadowStack: "",
      shouldRunNewStack: true,
      shouldRecordShadow: false,
      bucket,
      canaryPercent,
      reason: "new_stack_primary",
    };
  }

  async function record(event: Record<string, unknown> = {}) {
    const entry = {
      ts: new Date().toISOString(),
      mode,
      ...event,
    };
    if (reportPath) {
      await mkdir(dirname(reportPath), { recursive: true });
      await writeFile(reportPath, `${JSON.stringify(entry)}\n`, { flag: "a" });
    }
    return entry;
  }

  async function readReport() {
    if (!reportPath) return [];
    try {
      const raw = await readFile(reportPath, "utf8");
      return raw
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return [];
      }
      throw error;
    }
  }

  return { mode, canaryPercent, reportPath, decide, record, readReport };
}
