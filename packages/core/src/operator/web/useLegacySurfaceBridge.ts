import { useEffect } from "react";

import type { DebugState } from "../lan-operator-debug-state.ts";
import type { OperatorRuntimeState } from "./useOperatorRuntime.ts";
import type { VoiceState } from "./useVoice.ts";

type LegacySurfaceWindow = Window &
  typeof globalThis & {
    MAB_LAN_OPERATOR_SURFACE?: Record<string, unknown>;
  };

export function useLegacySurfaceBridge({
  runtime,
  voice,
}: {
  runtime: OperatorRuntimeState;
  voice: VoiceState;
}) {
  useEffect(() => {
    const debug = runtime.debug;
    const voiceDebug = debug.voice as DebugState["voice"] | undefined;
    const visual = debug.visual as DebugState["visual"] | undefined;
    const kwwk = debug.kwwk as DebugState["kwwk"] | undefined;
    const state = new Proxy(
      {
        ready: true,
        voiceCapture: {
          status: voice.micOn ? "capturing" : "idle",
          lastEnergy: voice.energy,
          availableDeviceCount: voice.devices.length,
          deviceId: voice.selectedDeviceId,
        },
        voiceLocalVad: {
          enabled: voice.localVadEnabled,
          role: voice.localVadEnabled ? "telemetry" : "disabled",
          active: voice.localVadActive,
          threshold: 0.02,
          lastEnergy: voice.energy,
        },
        voiceDeviceId: voice.selectedDeviceId,
        voiceDevices: voice.devices,
        voiceChunksSent: voice.chunksSent,
        voiceMuted: voice.muted,
        voice: voiceDebug || {},
        visual: visual || {},
        sources: visual?.sources || [],
        kwwk: kwwk || {},
        conversation: debug.conversation || {},
        liveProviderConfig: runtime.providerConfig,
      },
      {
        set(target, property, value) {
          if (property === "voiceDeviceId") {
            voice.setSelectedDeviceId(String(value || ""));
          }
          return Reflect.set(target, property, value);
        },
      },
    );
    const surface = {
      state,
      refreshVoiceDevices: voice.refreshDevices,
      configureLocalVad: (enabled: boolean) => {
        voice.setLocalVadEnabled(Boolean(enabled));
        return {
          enabled: Boolean(enabled),
          role: enabled ? "telemetry" : "disabled",
          active: false,
          threshold: 0.02,
          lastEnergy: voice.energy,
        };
      },
      markInterestingRun: runtime.markInteresting,
      copyDiagnostics: runtime.copyReport,
      liveProviderConfig: () => structuredClone(runtime.providerConfig || {}),
      currentComposition: () => structuredClone(visual?.composition || {}),
      currentDebug: () => structuredClone(debug || {}),
    };
    (window as LegacySurfaceWindow).MAB_LAN_OPERATOR_SURFACE = surface;
  }, [runtime, voice]);
}
