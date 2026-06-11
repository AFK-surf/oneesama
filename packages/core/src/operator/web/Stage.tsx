import { useMemo, useState } from "react";

import { stageView } from "./stageView.ts";
import type { OperatorDebug } from "./useOperatorRuntime.ts";
import type { OperatorBoot } from "./useRealtime.ts";

/**
 * Stage shows the embodied bot and app/source lanes. It still reuses the
 * existing /host-visual renderer, but the React shell now treats visual state
 * as a first-class domain instead of a decorative preview.
 */
export function Stage({ boot, debug }: { boot: OperatorBoot; debug: OperatorDebug }) {
  const [activeSourceId, setActiveSourceId] = useState("avatar");
  const [refreshKey, setRefreshKey] = useState(0);
  const avatarPreset =
    new URLSearchParams(location.search).get("avatarPreset") || "fallback-canvas";
  const view = useMemo(
    () => stageView({ activeSourceId, avatarPreset, debug, refreshKey, token: boot.token }),
    [activeSourceId, avatarPreset, boot.token, debug, refreshKey],
  );

  return (
    <section className="op-stage">
      <div className="op-panel-head">
        <div>
          <h2>Stage</h2>
          <p>
            {view.connectionStateLabel} / {view.trackCountLabel} tracks
          </p>
        </div>
        <div className="op-stage-actions">
          <button className="btn" onClick={() => setRefreshKey((key) => key + 1)} type="button">
            Refresh
          </button>
        </div>
      </div>

      <div className="op-stage-tabs">
        {view.sourceTabs.map((source) => (
          <button
            key={source.id}
            className={source.active ? "active" : ""}
            onClick={() => setActiveSourceId(source.id)}
            type="button"
          >
            <span>{source.label}</span>
            <em>{source.stateLabel}</em>
          </button>
        ))}
      </div>

      <div className="op-stage-frame">
        {view.frames.map((frame) => (
          <iframe
            key={frame.id}
            title={frame.title}
            src={frame.src}
            style={{ display: frame.active ? "block" : "none" }}
            allow="autoplay; camera; microphone; display-capture"
          />
        ))}
      </div>

      <div className="op-stage-telemetry">
        {view.telemetryRows.map((metric) => (
          <Metric key={metric.label} label={metric.label} value={metric.value} />
        ))}
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <span className="op-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </span>
  );
}
