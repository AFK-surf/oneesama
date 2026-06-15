import type { DebugState } from "../lan-operator-debug-state.ts";
import type { OperatorRuntimeState } from "./useOperatorRuntime.ts";

export type DiagnosticsTab = "telemetry" | "sources" | "timeline" | "raw";

export const DIAGNOSTICS_TABS: DiagnosticsTab[] = ["telemetry", "sources", "timeline", "raw"];

export interface DiagnosticMetricRow {
  label: string;
  value: string;
}

export interface DiagnosticAlertView {
  key: string;
  text: string;
}

export interface DiagnosticSourceView {
  id: string;
  label: string;
  kind: string;
  state: string;
  sizeLabel: string;
  statusLabel: string;
}

export interface DiagnosticTimelineRowView {
  key: string;
  className: string;
  layer: string;
  event: string;
  durationLabel: string;
}

export interface DiagnosticsPanelView {
  latestEventLabel: string;
  telemetryRows: DiagnosticMetricRow[];
  alerts: DiagnosticAlertView[];
  sources: DiagnosticSourceView[];
  sourcesEmpty: boolean;
  timelineRows: DiagnosticTimelineRowView[];
  rawJson: string;
}

export interface DiagnosticsPanelViewOptions {
  includeRawJson?: boolean;
}

export function diagnosticsPanelView(
  runtime: Pick<OperatorRuntimeState, "debug" | "providerConfig" | "recentEvents" | "snapshot">,
  filter: string,
  options: DiagnosticsPanelViewOptions = {},
): DiagnosticsPanelView {
  const debug = runtime.debug;
  const includeRawJson = options.includeRawJson !== false;
  const visual = debug.visual as DebugState["visual"] | undefined;
  const voice = debug.voice as DebugState["voice"] | undefined;
  const transport = debug.transport as DebugState["transport"] | undefined;
  const timeline = debug.timeline as DebugState["timeline"] | undefined;
  const toolRouting = debug.toolRouting as DebugState["toolRouting"] | undefined;
  const kwwk = debug.kwwk as DebugState["kwwk"] | undefined;

  return {
    latestEventLabel: runtime.recentEvents.at(-1)?.event || "no recent event",
    telemetryRows: [
      { label: "events ws", value: transport?.events?.state || "-" },
      { label: "voice ws", value: transport?.voice?.state || "-" },
      { label: "visual ws", value: transport?.visual?.state || "-" },
      { label: "mic", value: voice?.captureStatus || "-" },
      { label: "voice chunks", value: String(voice?.chunksReceived || 0) },
      { label: "voice forwarded", value: String(voice?.forwardedChunks || 0) },
      { label: "assistant audio", value: debug.output?.assistantAudio?.status || "-" },
      {
        label: "audio chunks",
        value: String(debug.output?.assistantAudio?.chunksPlayed || 0),
      },
      { label: "tool status", value: toolRouting?.status || "-" },
      { label: "tool", value: toolRouting?.actualTool || toolRouting?.expectedTool || "-" },
      { label: "kwwk", value: kwwk?.status || "-" },
      { label: "kwwk actions", value: String(kwwk?.actionCount || 0) },
    ],
    alerts: (toolRouting?.errors || []).slice(-3).map((error, index) => ({
      key: `${error.ts || "error"}-${index}`,
      text: error.error,
    })),
    sources: (visual?.sources || []).map((source) => ({
      id: source.id,
      label: source.label || source.id,
      kind: source.kind,
      state: source.state,
      sizeLabel: `${source.width || 0}x${source.height || 0}`,
      statusLabel: source.captureStatus || source.trackReadyState || "-",
    })),
    sourcesEmpty: !visual?.sources?.length,
    timelineRows: timelineRowsView(timeline?.rows || [], filter),
    rawJson: includeRawJson
      ? JSON.stringify(
          {
            snapshot: runtime.snapshot,
            provider: runtime.providerConfig,
            debug,
            recentEvents: runtime.recentEvents,
          },
          null,
          2,
        )
      : "",
  };
}

export function timelineRowsView(
  rows: DebugState["timeline"]["rows"],
  filter: string,
): DiagnosticTimelineRowView[] {
  const needle = filter.trim().toLowerCase();
  const visibleRows = needle
    ? rows.filter((row) =>
        [row.layer, row.event, row.blocker, JSON.stringify(row.detail || {})]
          .join(" ")
          .toLowerCase()
          .includes(needle),
      )
    : rows;

  return visibleRows.slice(-40).map((row) => ({
    key: row.id || `${row.at}-${row.event}`,
    className: row.ok ? "" : "bad",
    layer: row.layer,
    event: row.event,
    durationLabel: row.durationMs == null ? "" : `${row.durationMs}ms`,
  }));
}
