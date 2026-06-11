import { useEffect } from "react";

import type { DebugState } from "../lan-operator-debug-state.ts";
import { CommandBar } from "./CommandBar.tsx";
import { ConversationPanel } from "./ConversationPanel.tsx";
import { DiagnosticsPanel } from "./DiagnosticsPanel.tsx";
import { Stage } from "./Stage.tsx";
import { VoiceBar } from "./VoiceBar.tsx";
import { WorkPanel } from "./WorkPanel.tsx";
import { useOperatorRuntime } from "./useOperatorRuntime.ts";
import { useRealtime, type OperatorBoot } from "./useRealtime.ts";
import { useVoice } from "./useVoice.ts";
import { useWork } from "./useWork.ts";

type LegacySurfaceWindow = Window &
  typeof globalThis & {
    MAB_LAN_OPERATOR_SURFACE?: Record<string, unknown>;
  };

export function App({ boot }: { boot: OperatorBoot }) {
  const rt = useRealtime(boot);
  const runtime = useOperatorRuntime(boot, rt);
  const voice = useVoice(boot, rt.subscribe, rt.send);
  const work = useWork(rt);
  const connected = String(runtime.debug.conversation?.status || rt.status) === "connected";

  useLegacySurfaceBridge({ runtime, voice });

  const shellClass = `op op-${String(
    runtime.debug.conversation?.status || rt.status || "not_connected",
  )}`;

  return (
    <div className={shellClass}>
      <CommandBar boot={boot} realtime={rt} runtime={runtime} />
      <main className="op-main">
        <div className="op-left-rail">
          <Stage boot={boot} debug={runtime.debug} />
          <VoiceBar voice={voice} connected={connected} />
        </div>
        <div className="op-center-rail">
          <ConversationPanel realtime={rt} runtime={runtime} />
          <WorkPanel work={work} runtime={runtime} />
        </div>
        <DiagnosticsPanel runtime={runtime} />
      </main>
    </div>
  );
}

function useLegacySurfaceBridge({
  runtime,
  voice,
}: {
  runtime: ReturnType<typeof useOperatorRuntime>;
  voice: ReturnType<typeof useVoice>;
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
