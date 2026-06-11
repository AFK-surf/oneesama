import { useEffect } from "react";

import {
  legacyLocalVadView,
  legacySurfaceStateProxy,
  legacySurfaceStateView,
} from "./legacySurfaceBridgeView.ts";
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
    const visual = debug.visual;
    const state = legacySurfaceStateProxy(
      legacySurfaceStateView(runtime, voice),
      voice.setSelectedDeviceId,
    );
    const surface = {
      state,
      refreshVoiceDevices: voice.refreshDevices,
      configureLocalVad: (enabled: boolean) => {
        voice.setLocalVadEnabled(Boolean(enabled));
        return legacyLocalVadView({
          enabled: Boolean(enabled),
          active: false,
          lastEnergy: voice.energy,
        });
      },
      markInterestingRun: runtime.markInteresting,
      copyDiagnostics: runtime.copyReport,
      liveProviderConfig: () => structuredClone(runtime.providerConfig || {}),
      currentComposition: () => structuredClone(visual?.composition || {}),
      currentDebug: () => structuredClone(debug || {}),
    };
    (window as LegacySurfaceWindow).MAB_LAN_OPERATOR_SURFACE = surface;
  }, [
    runtime.copyReport,
    runtime.debug,
    runtime.markInteresting,
    runtime.providerConfig,
    voice.chunksSent,
    voice.devices,
    voice.energy,
    voice.localVadActive,
    voice.localVadEnabled,
    voice.micOn,
    voice.muted,
    voice.refreshDevices,
    voice.selectedDeviceId,
    voice.setLocalVadEnabled,
    voice.setSelectedDeviceId,
  ]);
}
