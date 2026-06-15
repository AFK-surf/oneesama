import type { DebugState } from "../lan-operator-debug-state.ts";
import type { OperatorRuntimeState } from "./useOperatorRuntime.ts";
import type { VoiceState } from "./useVoice.ts";

export const LEGACY_LOCAL_VAD_THRESHOLD = 0.02;

export interface LegacyVoiceCaptureView {
  status: "capturing" | "idle";
  lastEnergy: number;
  availableDeviceCount: number;
  deviceId: string;
}

export interface LegacyLocalVadView {
  enabled: boolean;
  role: "telemetry" | "disabled";
  active: boolean;
  threshold: number;
  lastEnergy: number;
}

export interface LegacySurfaceStateView {
  ready: boolean;
  voiceCapture: LegacyVoiceCaptureView;
  voiceLocalVad: LegacyLocalVadView;
  voiceDeviceId: string;
  voiceDevices: VoiceState["devices"];
  voiceChunksSent: number;
  voiceMuted: boolean;
  voice: DebugState["voice"] | Record<string, never>;
  visual: DebugState["visual"] | Record<string, never>;
  sources: DebugState["visual"]["sources"];
  overlays: Array<Record<string, unknown>>;
  eventsWsState: string;
  voiceWsState: string;
  sourceRects: DebugState["visual"]["composition"]["sourceRects"] | Record<string, never>;
  focusedSourceId: string | null;
  kwwk: DebugState["kwwk"] | Record<string, never>;
  conversation: DebugState["conversation"] | Record<string, never>;
  toolRouting: DebugState["toolRouting"] | Record<string, never>;
  timeline: DebugState["timeline"] | Record<string, never>;
  output: DebugState["output"] | Record<string, never>;
  liveProviderConfig: OperatorRuntimeState["providerConfig"];
}

export function legacySurfaceStateView(
  runtime: Pick<OperatorRuntimeState, "debug" | "providerConfig">,
  voice: Pick<
    VoiceState,
    | "chunksSent"
    | "devices"
    | "energy"
    | "localVadActive"
    | "localVadEnabled"
    | "micOn"
    | "muted"
    | "selectedDeviceId"
    | "syntheticVoiceReady"
  >,
  ready = true,
): LegacySurfaceStateView {
  const debug = runtime.debug;
  const voiceDebug = debug.voice as DebugState["voice"] | undefined;
  const visual = debug.visual as DebugState["visual"] | undefined;
  const kwwk = debug.kwwk as DebugState["kwwk"] | undefined;
  const conversation = debug.conversation as DebugState["conversation"] | undefined;
  const toolRouting = debug.toolRouting as DebugState["toolRouting"] | undefined;
  const timeline = debug.timeline as DebugState["timeline"] | undefined;
  const output = debug.output as DebugState["output"] | undefined;
  const transport = debug.transport as DebugState["transport"] | undefined;
  const composition = visual?.composition;

  return {
    ready,
    voiceCapture: legacyVoiceCaptureView(voice),
    voiceLocalVad: legacyLocalVadView({
      active: voice.localVadActive,
      enabled: voice.localVadEnabled,
      lastEnergy: voice.energy,
    }),
    voiceDeviceId: voice.selectedDeviceId,
    voiceDevices: voice.devices,
    voiceChunksSent: voice.chunksSent,
    voiceMuted: voice.muted,
    voice: voiceDebug || {},
    visual: visual || {},
    sources: visual?.sources || [],
    overlays: [],
    eventsWsState: transport?.events?.state || "closed",
    voiceWsState:
      voice.syntheticVoiceReady || voice.micOn ? "open" : transport?.voice?.state || "closed",
    sourceRects: composition?.sourceRects || {},
    focusedSourceId: composition?.focusedSourceId || null,
    kwwk: kwwk || {},
    conversation: conversation || {},
    toolRouting: toolRouting || {},
    timeline: timeline || {},
    output: output || {},
    liveProviderConfig: runtime.providerConfig,
  };
}

export function legacyVoiceCaptureView(
  voice: Pick<VoiceState, "devices" | "energy" | "micOn" | "selectedDeviceId">,
): LegacyVoiceCaptureView {
  return {
    status: voice.micOn ? "capturing" : "idle",
    lastEnergy: voice.energy,
    availableDeviceCount: voice.devices.length,
    deviceId: voice.selectedDeviceId,
  };
}

export function legacyLocalVadView({
  active,
  enabled,
  lastEnergy,
}: {
  active: boolean;
  enabled: boolean;
  lastEnergy: number;
}): LegacyLocalVadView {
  return {
    enabled,
    role: enabled ? "telemetry" : "disabled",
    active,
    threshold: LEGACY_LOCAL_VAD_THRESHOLD,
    lastEnergy,
  };
}

export function legacySurfaceStateProxy(
  state: LegacySurfaceStateView,
  setSelectedDeviceId: (deviceId: string) => void,
): LegacySurfaceStateView {
  return new Proxy(state, {
    set(target, property, value) {
      if (property === "voiceDeviceId") {
        setSelectedDeviceId(String(value || ""));
      }
      return Reflect.set(target, property, value);
    },
  });
}
