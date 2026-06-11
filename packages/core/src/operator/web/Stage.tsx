import { useMemo, useState } from "react";

import type { DebugState, VisualState } from "../lan-operator-debug-state.ts";
import { authSuffix } from "./protocol.ts";
import type { OperatorDebug } from "./useOperatorRuntime.ts";
import type { OperatorBoot } from "./useRealtime.ts";

type StageSource = VisualState["sources"][number];

const FALLBACK_SOURCES: StageSource[] = [
  { id: "avatar", label: "Avatar", kind: "avatar", state: "synthetic" },
  { id: "host-app", label: "App view", kind: "desktop_app", state: "synthetic" },
];

function stageUrl(
  boot: OperatorBoot,
  source: StageSource,
  avatarPreset: string,
  refreshKey: number,
) {
  const params = new URLSearchParams({
    embed: "1",
    sourceId: source.id,
    label: source.label || source.id,
    kind: source.kind || "desktop_app",
    refresh: String(refreshKey),
  });
  if (source.kind === "avatar" || source.id === "avatar") {
    params.set("avatar", "1");
    params.set("avatarPreset", source.avatarPreset || avatarPreset);
  }
  return authSuffix(boot.token, `/host-visual?${params.toString()}`);
}

/**
 * Stage shows the embodied bot and app/source lanes. It still reuses the
 * existing /host-visual renderer, but the React shell now treats visual state
 * as a first-class domain instead of a decorative preview.
 */
export function Stage({ boot, debug }: { boot: OperatorBoot; debug: OperatorDebug }) {
  const visual = debug.visual as DebugState["visual"] | undefined;
  const sources = visual?.sources?.length ? visual.sources : FALLBACK_SOURCES;
  const [activeSourceId, setActiveSourceId] = useState("avatar");
  const [refreshKey, setRefreshKey] = useState(0);
  const avatarPreset =
    new URLSearchParams(location.search).get("avatarPreset") || "fallback-canvas";

  const activeSource = sources.find((source) => source.id === activeSourceId) || sources[0];
  const frames = useMemo(
    () =>
      sources.map((source) => ({
        source,
        src: stageUrl(boot, source, avatarPreset, refreshKey),
      })),
    [avatarPreset, boot, refreshKey, sources],
  );
  const composition = visual?.composition;

  return (
    <section className="op-stage">
      <div className="op-panel-head">
        <div>
          <h2>Stage</h2>
          <p>
            {visual?.connectionState || "not_connected"} / {visual?.trackCount || 0} tracks
          </p>
        </div>
        <div className="op-stage-actions">
          <button className="btn" onClick={() => setRefreshKey((key) => key + 1)} type="button">
            Refresh
          </button>
        </div>
      </div>

      <div className="op-stage-tabs">
        {sources.map((source) => (
          <button
            key={source.id}
            className={source.id === activeSource.id ? "active" : ""}
            onClick={() => setActiveSourceId(source.id)}
            type="button"
          >
            <span>{source.label || source.id}</span>
            <em>{source.state || source.kind}</em>
          </button>
        ))}
      </div>

      <div className="op-stage-frame">
        {frames.map(({ source, src }) => (
          <iframe
            key={source.id}
            title={source.label || source.id}
            src={src}
            style={{ display: source.id === activeSource.id ? "block" : "none" }}
            allow="autoplay; camera; microphone; display-capture"
          />
        ))}
      </div>

      <div className="op-stage-telemetry">
        <Metric label="visual ws" value={visual?.receiverWebSocketState || "closed"} />
        <Metric
          label="webrtc"
          value={visual?.peerConnectionState || visual?.connectionState || "-"}
        />
        <Metric label="layout" value={`rev ${composition?.layoutRevision || 0}`} />
        <Metric
          label="canvas"
          value={`${composition?.width || 0}x${composition?.height || 0}@${composition?.targetFps || 0}`}
        />
        <Metric label="focus" value={composition?.focusedSourceId || "-"} />
        <Metric label="overlays" value={String(composition?.overlayCount || 0)} />
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
