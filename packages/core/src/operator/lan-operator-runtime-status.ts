import {
  buildRuntimeStatusSnapshot,
  type AvatarRuntimeSessionConfig,
  type RuntimeEvent,
  type RuntimeHealth,
} from "../avatar-runtime/contracts.ts";
import type { DebugState } from "./lan-operator-debug-state.ts";
import { buildLanOperatorMeetHudTelemetry } from "./lan-operator-hud-telemetry.ts";

type TimelineRow = DebugState["timeline"]["rows"][number];
type PrimaryBlockerLayer =
  | "transport"
  | "audio_input"
  | "conversation_engine"
  | "tool_routing"
  | "kwwk_planner"
  | "kwwk_execution"
  | "verification"
  | "output_audio"
  | "meet_adapter";

export function cloneDebugState(debug: DebugState): DebugState {
  return JSON.parse(JSON.stringify(debug)) as DebugState;
}

function lowerText(...values: Array<unknown>) {
  return values
    .map((value) => {
      if (value && typeof value === "object") {
        try {
          return JSON.stringify(value).toLowerCase();
        } catch {
          return "";
        }
      }
      return String(value || "").toLowerCase();
    })
    .join(" ");
}

function kwwkPrimaryBlockerLayer(row: TimelineRow): PrimaryBlockerLayer {
  const text = lowerText(row.event, row.blocker);
  if (text.includes("verification") || text.includes("verifying") || text.includes("verify")) {
    return "verification";
  }
  if (
    text.includes("execution") ||
    text.includes("executing") ||
    text.includes("executor") ||
    text.includes("surface")
  ) {
    return "kwwk_execution";
  }
  if (text.includes("planner") || text.includes("planning")) return "kwwk_planner";
  const detailText = lowerText(row.detail);
  if (
    detailText.includes("verification") ||
    detailText.includes("verifying") ||
    detailText.includes("verify")
  ) {
    return "verification";
  }
  if (
    detailText.includes("execution") ||
    detailText.includes("executing") ||
    detailText.includes("executor") ||
    detailText.includes("surface")
  ) {
    return "kwwk_execution";
  }
  if (detailText.includes("planner") || detailText.includes("planning")) return "kwwk_planner";
  return "kwwk_execution";
}

function primaryBlockerLayer(row: TimelineRow): PrimaryBlockerLayer {
  if (row.layer === "kwwk") return kwwkPrimaryBlockerLayer(row);
  if (row.layer === "visual" || row.layer === "operator") {
    const text = lowerText(row.event, row.blocker, row.detail);
    return text.includes("meet") ? "meet_adapter" : "transport";
  }
  return row.layer;
}

export function buildPrimaryBlockerSummary(debug: DebugState) {
  const blockerRows = debug.timeline.rows.filter((row) => row.blocker);
  if (!blockerRows.length) return null;
  const latestBadTurn = [...debug.timeline.turns]
    .reverse()
    .find((turn) => turn.status === "blocked" || turn.status === "failed" || turn.blocker);
  const turnBlockers = latestBadTurn
    ? blockerRows.filter((row) => row.turnId === latestBadTurn.turnId)
    : [];
  const candidates = turnBlockers.length ? turnBlockers : blockerRows;
  const primaryRow = candidates.at(-1);
  if (!primaryRow) return null;
  const layer = primaryBlockerLayer(primaryRow);
  return {
    schemaVersion: 1,
    policy: "latest_blocker_row_in_latest_bad_turn",
    layer,
    timelineLayer: primaryRow.layer,
    event: primaryRow.event,
    blocker: primaryRow.blocker,
    turnId: primaryRow.turnId,
    responseId: primaryRow.responseId,
    rowId: primaryRow.id,
    at: primaryRow.at,
    candidateCount: candidates.length,
    candidates: candidates.slice(-8).map((row) => ({
      at: row.at,
      rowId: row.id,
      layer: primaryBlockerLayer(row),
      timelineLayer: row.layer,
      event: row.event,
      blocker: row.blocker,
      turnId: row.turnId,
      responseId: row.responseId,
    })),
  };
}

function conversationTurnSummary(config: Readonly<AvatarRuntimeSessionConfig>, debug: DebugState) {
  const latestTurn = debug.timeline.turns.at(-1) || null;
  const currentTurnId = latestTurn?.turnId || debug.timeline.currentTurnId || null;
  const currentResponseId =
    latestTurn?.responseIds.at(-1) || debug.output.assistantText.lastResponseId || null;
  const turnEvents = currentTurnId
    ? debug.conversation.canonicalEvents.filter((event) => event.turnId === currentTurnId)
    : debug.conversation.canonicalEvents;
  const transcriptCompleted = [...turnEvents]
    .reverse()
    .find((event) => event.type === "transcript_completed" && event.text);
  const transcriptDeltas = turnEvents
    .filter((event) => event.type === "transcript_delta" && event.text)
    .map((event) => event.text)
    .join("");
  const assistantCompleted = [...turnEvents]
    .reverse()
    .find((event) => event.type === "assistant_text_completed" && event.text);
  const assistantDeltas = turnEvents
    .filter((event) => event.type === "assistant_text_delta" && event.text)
    .map((event) => event.text)
    .join("");
  const interruption = [...debug.conversation.canonicalEvents]
    .reverse()
    .find((event) => event.type === "interrupted");
  return {
    engineId: debug.conversation.engineId,
    transport: config.conversationTransport,
    sessionId: config.sessionId,
    status: debug.conversation.status,
    currentTurnId,
    currentResponseId,
    latestEvent: latestTurn?.latestEvent || debug.conversation.canonicalEvents.at(-1)?.type || null,
    userTranscript: transcriptCompleted?.text || transcriptDeltas || "",
    assistantTranscript:
      assistantCompleted?.text ||
      assistantDeltas ||
      debug.output.assistantText.completedText ||
      debug.output.assistantText.currentText ||
      "",
    speechStartCount: Number(debug.conversation.eventCounts.speech_started || 0),
    interruption: interruption
      ? {
          at: interruption.ts,
          responseId: interruption.responseId || null,
          reason: String(
            interruption.detail?.reason || interruption.detail?.control || "interrupted",
          ),
        }
      : null,
    control: debug.conversation.control,
  };
}

function conversationPortSummary(debug: DebugState) {
  return {
    canonicalEventCounts: debug.conversation.eventCounts,
    latestCanonicalEvent: debug.conversation.canonicalEvents.at(-1)?.type || null,
    providerAdapterKind: debug.conversation.provider.adapterKind || debug.conversation.engineId,
    rawEventDrilldownAvailable: debug.conversation.provider.rawEventDrilldownAvailable,
    latestProviderEventType: debug.conversation.provider.latestProviderEventType,
    providerEventCounts: debug.conversation.provider.providerEventCounts,
    recentProviderEvents: debug.conversation.provider.recentEvents,
  };
}

function artifactPolicySummary(debug: DebugState) {
  const links = debug.artifacts.largeArtifacts || [];
  return {
    schemaVersion: 1,
    policy: "small_report_links_large_artifacts",
    inlineByteLimit: 64_000,
    linkedCount: links.length,
    totalLinkedBytes: links.reduce((total, artifact) => total + Number(artifact.bytes || 0), 0),
    links,
  };
}

function artifactBundleSummary(debug: DebugState) {
  const bundles = debug.artifacts.bundles || [];
  const latest = bundles.at(-1) || null;
  return {
    schemaVersion: 1,
    bundleCount: debug.artifacts.bundleCount,
    latest,
    latestEntryIds: latest?.entries?.map((entry) => entry.id) || [],
    linkedOnlyEntryCount:
      latest?.entries?.filter((entry) => entry.policy === "linked_only").length || 0,
  };
}

export function runtimeStatusBody(
  config: Readonly<AvatarRuntimeSessionConfig>,
  events: RuntimeEvent[],
  debug: DebugState,
  health: RuntimeHealth,
) {
  return {
    ok: health !== "failed",
    snapshot: buildRuntimeStatusSnapshot({
      config,
      health,
      events,
      warnings: [],
      errors: [],
    }),
    inputPolicy: config.inputPolicy,
    outputPolicy: config.outputPolicy,
    debug: cloneDebugState(debug),
    recentEvents: events.slice(-40),
  };
}

export function buildLanOperatorDebugReport(
  config: Readonly<AvatarRuntimeSessionConfig>,
  events: RuntimeEvent[],
  debug: DebugState,
  health: RuntimeHealth,
) {
  const eventSummary: Record<string, number> = {};
  const severitySummary: Record<string, number> = {};
  const phaseSummary: Record<string, number> = {};
  for (const event of events) {
    eventSummary[event.event] = Number(eventSummary[event.event] || 0) + 1;
    severitySummary[event.severity] = Number(severitySummary[event.severity] || 0) + 1;
    phaseSummary[event.phase] = Number(phaseSummary[event.phase] || 0) + 1;
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    reportKind: "lan_operator_debug_report",
    sessionId: config.sessionId,
    botName: config.botName,
    health,
    snapshot: buildRuntimeStatusSnapshot({ config, health, events, warnings: [], errors: [] }),
    inputPolicy: config.inputPolicy,
    outputPolicy: config.outputPolicy,
    debug: cloneDebugState(debug),
    summaries: {
      events: eventSummary,
      severities: severitySummary,
      phases: phaseSummary,
      canonicalConversationEvents: debug.conversation.eventCounts,
      surfaceContext: debug.surfaceContext,
      conversationTurn: conversationTurnSummary(config, debug),
      conversationPort: conversationPortSummary(debug),
      artifactPolicy: artifactPolicySummary(debug),
      artifactBundle: artifactBundleSummary(debug),
      primaryBlocker: buildPrimaryBlockerSummary(debug),
      meetHudTelemetry: buildLanOperatorMeetHudTelemetry(debug),
      toolRouting: {
        expectedTool: debug.toolRouting.expectedTool,
        actualTool: debug.toolRouting.actualTool,
        status: debug.toolRouting.status,
        functionOutputDelivered: debug.toolRouting.functionOutputDelivered,
        argumentSafety: debug.toolRouting.argumentSafety,
      },
      timelineRows: debug.timeline.rows.length,
      turns: {
        count: debug.timeline.turns.length,
        latest: debug.timeline.turns.at(-1) || null,
        blocked: debug.timeline.turns
          .filter((turn) => turn.status === "blocked" || turn.status === "failed" || turn.blocker)
          .map((turn) => ({
            turnId: turn.turnId,
            status: turn.status,
            blocker: turn.blocker,
            latestEvent: turn.latestEvent,
          })),
      },
      blockers: debug.timeline.rows
        .filter((row) => row.blocker)
        .map((row) => ({
          at: row.at,
          layer: row.layer,
          event: row.event,
          blocker: row.blocker,
        })),
    },
    timeline: debug.timeline.rows,
    recentEvents: events.slice(-120),
  };
}
