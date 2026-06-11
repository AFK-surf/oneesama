import { useMemo, useState } from "react";

import type { DebugState } from "../lan-operator-debug-state.ts";
import type { OperatorRuntimeState } from "./useOperatorRuntime.ts";

type DiagnosticsTab = "telemetry" | "sources" | "timeline" | "raw";

export function DiagnosticsPanel({ runtime }: { runtime: OperatorRuntimeState }) {
  const [open, setOpen] = useState(true);
  const [tab, setTab] = useState<DiagnosticsTab>("telemetry");
  const [filter, setFilter] = useState("");
  const debug = runtime.debug;
  const visual = debug.visual as DebugState["visual"] | undefined;
  const voice = debug.voice as DebugState["voice"] | undefined;
  const transport = debug.transport as DebugState["transport"] | undefined;
  const timeline = debug.timeline as DebugState["timeline"] | undefined;
  const toolRouting = debug.toolRouting as DebugState["toolRouting"] | undefined;
  const kwwk = debug.kwwk as DebugState["kwwk"] | undefined;
  const filteredRows = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const rows = timeline?.rows || [];
    if (!needle) return rows.slice(-40);
    return rows
      .filter((row) =>
        [row.layer, row.event, row.blocker, JSON.stringify(row.detail || {})]
          .join(" ")
          .toLowerCase()
          .includes(needle),
      )
      .slice(-40);
  }, [filter, timeline?.rows]);

  return (
    <aside className={`op-diagnostics ${open ? "open" : "closed"}`}>
      <div className="op-panel-head">
        <div>
          <h2>Diagnostics</h2>
          <p>{runtime.recentEvents.at(-1)?.event || "no recent event"}</p>
        </div>
        <button className="btn" onClick={() => setOpen((value) => !value)} type="button">
          {open ? "Hide" : "Show"}
        </button>
      </div>

      {open ? (
        <>
          <div className="op-diagnostic-tabs">
            {(["telemetry", "sources", "timeline", "raw"] as const).map((nextTab) => (
              <button
                key={nextTab}
                className={tab === nextTab ? "active" : ""}
                onClick={() => setTab(nextTab)}
                type="button"
              >
                {nextTab}
              </button>
            ))}
          </div>

          {tab === "telemetry" ? (
            <div className="op-diagnostic-body">
              <MetricGrid
                rows={[
                  ["events ws", transport?.events?.state || "-"],
                  ["voice ws", transport?.voice?.state || "-"],
                  ["visual ws", transport?.visual?.state || "-"],
                  ["mic", voice?.captureStatus || "-"],
                  ["voice chunks", String(voice?.chunksReceived || 0)],
                  ["voice forwarded", String(voice?.forwardedChunks || 0)],
                  ["assistant audio", debug.output?.assistantAudio?.status || "-"],
                  ["audio chunks", String(debug.output?.assistantAudio?.chunksPlayed || 0)],
                  ["tool status", toolRouting?.status || "-"],
                  ["tool", toolRouting?.actualTool || toolRouting?.expectedTool || "-"],
                  ["kwwk", kwwk?.status || "-"],
                  ["kwwk actions", String(kwwk?.actionCount || 0)],
                ]}
              />
              {toolRouting?.errors?.length ? (
                <div className="op-alert-list">
                  {toolRouting.errors.slice(-3).map((error, index) => (
                    <div key={index} className="op-alert">
                      {error.error}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {tab === "sources" ? (
            <div className="op-diagnostic-body">
              {(visual?.sources || []).map((source) => (
                <div className="op-source-row" key={source.id}>
                  <div>
                    <strong>{source.label || source.id}</strong>
                    <span>{source.kind}</span>
                  </div>
                  <div>
                    <span>{source.state}</span>
                    <span>
                      {source.width || 0}x{source.height || 0}
                    </span>
                    <span>{source.captureStatus || source.trackReadyState || "-"}</span>
                  </div>
                </div>
              ))}
              {!visual?.sources?.length ? (
                <div className="op-empty small">No sources yet.</div>
              ) : null}
            </div>
          ) : null}

          {tab === "timeline" ? (
            <div className="op-diagnostic-body">
              <input
                className="op-filter"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filter timeline"
              />
              <div className="op-timeline-list">
                {filteredRows.map((row) => (
                  <div key={row.id || `${row.at}-${row.event}`} className={row.ok ? "" : "bad"}>
                    <span>{row.layer}</span>
                    <strong>{row.event}</strong>
                    <em>{row.durationMs == null ? "" : `${row.durationMs}ms`}</em>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {tab === "raw" ? (
            <div className="op-diagnostic-body">
              <div className="op-raw-actions">
                <button
                  className="btn"
                  onClick={() => void runtime.copyReport().catch(() => undefined)}
                  type="button"
                >
                  Copy JSON
                </button>
                <button
                  className="btn"
                  onClick={() => void runtime.downloadReport().catch(() => undefined)}
                  type="button"
                >
                  Download
                </button>
                <button className="btn" onClick={() => runtime.markInteresting()} type="button">
                  Mark
                </button>
              </div>
              <pre className="op-raw" id="debug-json">
                {JSON.stringify(
                  {
                    snapshot: runtime.snapshot,
                    provider: runtime.providerConfig,
                    debug,
                    recentEvents: runtime.recentEvents,
                  },
                  null,
                  2,
                )}
              </pre>
            </div>
          ) : null}
        </>
      ) : null}
    </aside>
  );
}

function MetricGrid({ rows }: { rows: Array<[string, string]> }) {
  return (
    <div className="op-metric-grid">
      {rows.map(([label, value]) => (
        <div key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  );
}
