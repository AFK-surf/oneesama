import { useMemo, useState } from "react";

import {
  DIAGNOSTICS_TABS,
  diagnosticsPanelView,
  type DiagnosticsTab,
} from "./diagnosticsPanelView.ts";
import type { OperatorRuntimeState } from "./useOperatorRuntime.ts";

export function DiagnosticsPanel({ runtime }: { runtime: OperatorRuntimeState }) {
  const [open, setOpen] = useState(true);
  const [tab, setTab] = useState<DiagnosticsTab>("telemetry");
  const [filter, setFilter] = useState("");
  const view = useMemo(
    () => diagnosticsPanelView(runtime, filter, { includeRawJson: tab === "raw" }),
    [filter, runtime.debug, runtime.providerConfig, runtime.recentEvents, runtime.snapshot, tab],
  );

  return (
    <aside className={`op-diagnostics ${open ? "open" : "closed"}`}>
      <div className="op-panel-head">
        <div>
          <h2>Diagnostics</h2>
          <p>{view.latestEventLabel}</p>
        </div>
        <button className="btn" onClick={() => setOpen((value) => !value)} type="button">
          {open ? "Hide" : "Show"}
        </button>
      </div>

      {open ? (
        <>
          <div className="op-diagnostic-tabs">
            {DIAGNOSTICS_TABS.map((nextTab) => (
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
              <MetricGrid rows={view.telemetryRows} />
              {view.alerts.length ? (
                <div className="op-alert-list">
                  {view.alerts.map((alert) => (
                    <div key={alert.key} className="op-alert">
                      {alert.text}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {tab === "sources" ? (
            <div className="op-diagnostic-body">
              {view.sources.map((source) => (
                <div className="op-source-row" key={source.id}>
                  <div>
                    <strong>{source.label}</strong>
                    <span>{source.kind}</span>
                  </div>
                  <div>
                    <span>{source.state}</span>
                    <span>{source.sizeLabel}</span>
                    <span>{source.statusLabel}</span>
                  </div>
                </div>
              ))}
              {view.sourcesEmpty ? <div className="op-empty small">No sources yet.</div> : null}
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
                {view.timelineRows.map((row) => (
                  <div key={row.key} className={row.className}>
                    <span>{row.layer}</span>
                    <strong>{row.event}</strong>
                    <em>{row.durationLabel}</em>
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
                {view.rawJson}
              </pre>
            </div>
          ) : null}
        </>
      ) : null}
    </aside>
  );
}

function MetricGrid({ rows }: { rows: Array<{ label: string; value: string }> }) {
  return (
    <div className="op-metric-grid">
      {rows.map((row) => (
        <div key={row.label}>
          <span>{row.label}</span>
          <strong>{row.value}</strong>
        </div>
      ))}
    </div>
  );
}
