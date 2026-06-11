import type { DebugState, VisualState } from "../lan-operator-debug-state.ts";
import { authSuffix } from "./protocol.ts";
import type { OperatorDebug } from "./useOperatorRuntime.ts";

type StageSource = VisualState["sources"][number];

export interface StageSourceTabView {
  id: string;
  label: string;
  stateLabel: string;
  active: boolean;
}

export interface StageFrameView {
  id: string;
  title: string;
  src: string;
  active: boolean;
}

export interface StageMetricView {
  label: string;
  value: string;
}

export interface StageView {
  connectionStateLabel: string;
  trackCountLabel: string;
  sourceTabs: StageSourceTabView[];
  frames: StageFrameView[];
  telemetryRows: StageMetricView[];
}

export const FALLBACK_STAGE_SOURCES: StageSource[] = [
  { id: "avatar", label: "Avatar", kind: "avatar", state: "synthetic" },
  { id: "host-app", label: "App view", kind: "desktop_app", state: "synthetic" },
];

export function stageView({
  activeSourceId,
  avatarPreset,
  debug,
  refreshKey,
  token,
}: {
  activeSourceId: string;
  avatarPreset: string;
  debug: OperatorDebug;
  refreshKey: number;
  token?: string;
}): StageView {
  const visual = debug.visual as DebugState["visual"] | undefined;
  const sources = visual?.sources?.length ? visual.sources : FALLBACK_STAGE_SOURCES;
  const activeSource = sources.find((source) => source.id === activeSourceId) || sources[0];
  const composition = visual?.composition;

  return {
    connectionStateLabel: visual?.connectionState || "not_connected",
    trackCountLabel: String(visual?.trackCount || 0),
    sourceTabs: sources.map((source) => ({
      id: source.id,
      label: source.label || source.id,
      stateLabel: source.state || source.kind,
      active: source.id === activeSource.id,
    })),
    frames: sources.map((source) => ({
      id: source.id,
      title: source.label || source.id,
      src: stageFrameUrl({ avatarPreset, refreshKey, source, token }),
      active: source.id === activeSource.id,
    })),
    telemetryRows: [
      { label: "visual ws", value: visual?.receiverWebSocketState || "closed" },
      {
        label: "webrtc",
        value: visual?.peerConnectionState || visual?.connectionState || "-",
      },
      { label: "layout", value: `rev ${composition?.layoutRevision || 0}` },
      {
        label: "canvas",
        value: `${composition?.width || 0}x${composition?.height || 0}@${
          composition?.targetFps || 0
        }`,
      },
      { label: "focus", value: composition?.focusedSourceId || "-" },
      { label: "overlays", value: String(composition?.overlayCount || 0) },
    ],
  };
}

export function stageFrameUrl({
  avatarPreset,
  refreshKey,
  source,
  token,
}: {
  avatarPreset: string;
  refreshKey: number;
  source: StageSource;
  token?: string;
}): string {
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
  return authSuffix(token, `/host-visual?${params.toString()}`);
}
