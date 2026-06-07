import type { CanonicalConversationEvent } from "./lan-operator-conversation-engine.ts";
import type { DebugState } from "./lan-operator-debug-state.ts";
import type { LanOperatorVoiceChunk } from "./lan-operator-voice.ts";

type TimelineRow = DebugState["timeline"]["rows"][number];
type TurnSummary = DebugState["timeline"]["turns"][number];
type TurnMilestone = keyof TurnSummary["milestones"];

const TURN_MILESTONES: TurnMilestone[] = [
  "heard",
  "speechStarted",
  "transcript",
  "tool",
  "kwwk",
  "verification",
  "output",
];

function rowId(debug: DebugState) {
  return `timeline_${Date.now().toString(36)}_${debug.timeline.rows.length.toString(36)}`;
}

function durationFromTurnStartMs(debug: DebugState, at: string, turnId: string | null) {
  if (!turnId) return null;
  const first = debug.timeline.rows.find((row) => row.turnId === turnId);
  if (!first) return null;
  const startedAt = Date.parse(first.at);
  const endedAt = Date.parse(at);
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) return null;
  return Math.max(0, endedAt - startedAt);
}

function uniqueStrings(values: Array<string | null | undefined>) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function turnStatus(rows: TimelineRow[]): TurnSummary["status"] {
  if (rows.some((row) => !row.ok && row.event === "engine_error")) return "failed";
  if (rows.some((row) => !row.ok || row.blocker)) return "blocked";
  if (
    rows.some((row) =>
      [
        "assistant_text_completed",
        "assistant_audio_stopped",
        "tool_result_accepted",
        "kwwk_completed",
      ].includes(row.event),
    )
  ) {
    return "completed";
  }
  return "active";
}

function milestoneForRow(row: TimelineRow): TurnMilestone | null {
  if (row.event === "operator_voice_chunk_received") return "heard";
  if (row.event === "speech_started") return "speechStarted";
  if (row.event === "transcript_delta" || row.event === "transcript_completed") {
    return "transcript";
  }
  if (row.layer === "tool_routing" || row.event.startsWith("tool_")) return "tool";
  if (row.layer === "kwwk" || row.event.startsWith("kwwk_")) {
    return hasVerificationEvidence(row) ? "verification" : "kwwk";
  }
  if (
    row.layer === "output_audio" ||
    row.event === "assistant_text_delta" ||
    row.event === "assistant_text_completed" ||
    row.event.startsWith("assistant_audio")
  ) {
    return "output";
  }
  return null;
}

function milestoneFlags(rows: TimelineRow[]): TurnSummary["milestones"] {
  return {
    heard: rows.some((row) => row.event === "operator_voice_chunk_received"),
    speechStarted: rows.some((row) => row.event === "speech_started"),
    transcript: rows.some(
      (row) => row.event === "transcript_delta" || row.event === "transcript_completed",
    ),
    tool: rows.some((row) => row.layer === "tool_routing" || row.event.startsWith("tool_")),
    kwwk: rows.some((row) => row.layer === "kwwk" || row.event.startsWith("kwwk_")),
    verification: rows.some((row) => row.layer === "kwwk" && hasVerificationEvidence(row)),
    output: rows.some(
      (row) =>
        row.layer === "output_audio" ||
        row.event === "assistant_text_delta" ||
        row.event === "assistant_text_completed" ||
        row.event.startsWith("assistant_audio"),
    ),
  };
}

function milestoneAts(rows: TimelineRow[]) {
  const ats: TurnSummary["milestoneAts"] = {};
  for (const row of rows) {
    const milestone = milestoneForRow(row);
    if (milestone && !ats[milestone]) ats[milestone] = row.at;
  }
  return ats;
}

function milestoneDurationsMs(rows: TimelineRow[]) {
  const durations: TurnSummary["milestoneDurationsMs"] = {};
  for (const row of rows) {
    const milestone = milestoneForRow(row);
    if (milestone && !(milestone in durations)) durations[milestone] = row.durationMs;
  }
  return durations;
}

function mergeMilestones(
  previous: TurnSummary | null,
  current: TurnSummary["milestones"],
): TurnSummary["milestones"] {
  const merged = { ...current };
  for (const milestone of TURN_MILESTONES) {
    merged[milestone] = Boolean(previous?.milestones?.[milestone] || current[milestone]);
  }
  return merged;
}

function mergeMilestoneRecord<T>(
  previous: Partial<Record<TurnMilestone, T>> | undefined,
  current: Partial<Record<TurnMilestone, T>>,
) {
  const merged: Partial<Record<TurnMilestone, T>> = { ...previous };
  for (const milestone of TURN_MILESTONES) {
    if (merged[milestone] == null && current[milestone] != null) {
      merged[milestone] = current[milestone];
    }
  }
  return merged;
}

function hasVerificationEvidence(row: TimelineRow) {
  if (row.event === "kwwk_verifying") return true;
  const verification = row.detail.verification;
  if (!verification || typeof verification !== "object" || Array.isArray(verification)) {
    return false;
  }
  const compact = verification as Record<string, unknown>;
  return Boolean(
    compact.ok === true ||
    compact.status ||
    compact.reason ||
    compact.blocker ||
    Number(compact.checkCount || 0) > 0,
  );
}

function rebuildTurnSummary(debug: DebugState, turnId: string | null) {
  if (!turnId) return;
  const rows = debug.timeline.rows.filter((row) => row.turnId === turnId);
  if (rows.length === 0) return;
  const previous = debug.timeline.turns.find((turn) => turn.turnId === turnId) || null;
  const first = rows[0];
  const last = rows[rows.length - 1];
  const startedAt = previous?.startedAt || first.at;
  const startedAtMs = Date.parse(startedAt);
  const lastAtMs = Date.parse(last.at);
  const currentMilestones = milestoneFlags(rows);
  const summary: TurnSummary = {
    turnId,
    startedAt,
    lastEventAt: last.at,
    durationMs:
      Number.isFinite(startedAtMs) && Number.isFinite(lastAtMs)
        ? Math.max(0, lastAtMs - startedAtMs)
        : null,
    status: turnStatus(rows),
    responseIds: uniqueStrings(rows.map((row) => row.responseId)),
    latestEvent: last.event,
    blocker: rows.findLast((row) => row.blocker)?.blocker || null,
    milestones: mergeMilestones(previous, currentMilestones),
    milestoneAts: mergeMilestoneRecord(previous?.milestoneAts, milestoneAts(rows)),
    milestoneDurationsMs: mergeMilestoneRecord(
      previous?.milestoneDurationsMs,
      milestoneDurationsMs(rows),
    ),
    events: [...(previous?.events || []), ...rows.map((row) => row.event)].slice(-24),
  };
  debug.timeline.turns = [...debug.timeline.turns.filter((turn) => turn.turnId !== turnId), summary]
    .sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt))
    .slice(-40);
}

export function appendTimelineRow(
  debug: DebugState,
  input: Omit<TimelineRow, "id" | "durationMs"> & {
    id?: string;
    durationMs?: number | null;
  },
) {
  const turnId = input.turnId || debug.timeline.currentTurnId;
  const row: TimelineRow = {
    id: input.id || rowId(debug),
    at: input.at,
    layer: input.layer,
    event: input.event,
    ok: input.ok,
    durationMs: input.durationMs ?? durationFromTurnStartMs(debug, input.at, turnId),
    turnId,
    responseId: input.responseId,
    blocker: input.blocker,
    detail: input.detail,
  };
  debug.timeline.currentTurnId = turnId;
  debug.timeline.lastEventAt = row.at;
  debug.timeline.rows = [...debug.timeline.rows, row].slice(-120);
  rebuildTurnSummary(debug, turnId);
  return row;
}

export function recordVoiceChunkTimelineRow(
  debug: DebugState,
  chunk: LanOperatorVoiceChunk,
  input: { bytes: number; shouldRecord?: boolean },
) {
  if (!input.shouldRecord) return null;
  return appendTimelineRow(debug, {
    at: new Date().toISOString(),
    layer: "audio_input",
    event: "operator_voice_chunk_received",
    ok: true,
    turnId: debug.timeline.currentTurnId,
    responseId: null,
    blocker: null,
    detail: {
      sequence: chunk.sequence,
      voiceStreamId: chunk.voiceStreamId,
      voiceStreamGeneration: chunk.voiceStreamGeneration,
      sampleRate: chunk.sampleRate,
      channels: chunk.channels,
      durationMs: chunk.durationMs,
      sentAt: chunk.sentAt,
      receivedAt: chunk.receivedAt,
      receiveLagMs: chunk.receiveLagMs,
      energy: chunk.energy,
      bytes: input.bytes,
      source: chunk.source,
    },
  });
}

function canonicalLayer(event: CanonicalConversationEvent): TimelineRow["layer"] {
  if (event.type === "speech_started" || event.type === "speech_stopped") return "audio_input";
  if (event.type.startsWith("assistant_audio")) return "output_audio";
  if (event.type.startsWith("tool_")) return "tool_routing";
  return "conversation_engine";
}

function canonicalBlocker(event: CanonicalConversationEvent) {
  if (event.type !== "engine_error") return null;
  return String(event.error || event.detail?.error || "engine_error");
}

export function recordCanonicalTimelineRow(debug: DebugState, event: CanonicalConversationEvent) {
  if (
    event.type === "engine_connected" &&
    debug.timeline.rows.some((row) => row.event === event.type)
  ) {
    return null;
  }
  if (event.type === "speech_started" && event.turnId) {
    const pendingAudioRow = [...debug.timeline.rows]
      .reverse()
      .find((row) => row.event === "operator_voice_chunk_received" && !row.turnId);
    if (pendingAudioRow) pendingAudioRow.turnId = event.turnId;
  }
  const turnId = event.turnId || debug.timeline.currentTurnId;
  return appendTimelineRow(debug, {
    at: event.ts,
    layer: canonicalLayer(event),
    event: event.type,
    ok: event.type !== "engine_error",
    turnId,
    responseId: event.responseId || null,
    blocker: canonicalBlocker(event),
    detail: {
      engineId: event.engineId,
      itemId: event.itemId || "",
      text: event.text || "",
      providerEventType: event.detail?.providerEventType || "",
      inputMode: event.detail?.inputMode || "",
      inputId: event.detail?.inputId || "",
      source: event.detail?.source || "",
      callId: event.detail?.callId || "",
      name: event.detail?.name || "",
    },
  });
}
