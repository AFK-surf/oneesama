import { useEffect } from "react";

import type { DebugState } from "../lan-operator-debug-state.ts";
import {
  legacyLocalVadView,
  legacySurfaceStateProxy,
  legacySurfaceStateView,
  legacyVoiceCaptureView,
} from "./legacySurfaceBridgeView.ts";
import { authSuffix } from "./protocol.ts";
import type { EngineControlType } from "./useOperatorRuntime.ts";
import type { OperatorRuntimeState } from "./useOperatorRuntime.ts";
import type { RealtimeState } from "./useRealtime.ts";
import type { VoiceState } from "./useVoice.ts";
import type { SyntheticVoiceChunkInput } from "./useVoice.ts";
import { workRunMessage } from "./workCommands.ts";

type LegacySurfaceWindow = Window &
  typeof globalThis & {
    MAB_LAN_OPERATOR_SURFACE?: Record<string, unknown>;
  };

export interface LegacySurfaceBridgeInput {
  realtime: RealtimeState;
  runtime: OperatorRuntimeState;
  voice: VoiceState;
}

export function useLegacySurfaceBridge({ realtime, runtime, voice }: LegacySurfaceBridgeInput) {
  useEffect(() => {
    const surface = buildLegacySurfaceBridge({ realtime, runtime, voice });
    (window as LegacySurfaceWindow).MAB_LAN_OPERATOR_SURFACE = surface;
  }, [
    realtime.send,
    realtime.sendText,
    realtime.wsOpen,
    runtime.debug,
    runtime.downloadReport,
    runtime.markInteresting,
    runtime.providerConfig,
    runtime.sendEngineControl,
    runtime.switchProvider,
    voice.chunksSent,
    voice.devices,
    voice.energy,
    voice.localVadActive,
    voice.localVadEnabled,
    voice.micOn,
    voice.muted,
    voice.refreshDevices,
    voice.selectedDeviceId,
    voice.sendSyntheticVoiceChunk,
    voice.setLocalVadEnabled,
    voice.setSelectedDeviceId,
    voice.setVoiceMuted,
    voice.startMic,
    voice.stopMic,
    voice.syntheticVoiceReady,
  ]);
}

export function buildLegacySurfaceBridge({ realtime, runtime, voice }: LegacySurfaceBridgeInput) {
  const debug = runtime.debug;
  const visual = debug.visual;
  const state = legacySurfaceStateProxy(
    legacySurfaceStateView(
      runtime,
      voice,
      realtime.wsOpen && (voice.syntheticVoiceReady || voice.micOn),
    ),
    voice.setSelectedDeviceId,
  );
  const currentComposition = () => structuredClone(visual?.composition || {});
  const sendDebugArtifact = (input: Record<string, unknown>) =>
    realtime.send({ type: "debug_report_artifact", ...input });

  return {
    state,
    moveSource: (sourceId: string, rect: Record<string, unknown>) => {
      const composition = compositionWithPatch(debug, {
        focusedSourceId: sourceId,
        sourceRects: {
          ...objectValue((visual?.composition as Record<string, unknown> | undefined)?.sourceRects),
          [sourceId]: rect,
        },
      });
      realtime.send({ type: "composition_state", composition });
      return composition;
    },
    setFocusedSource: (sourceId: string) => {
      const composition = compositionWithPatch(debug, { focusedSourceId: sourceId });
      realtime.send({ type: "composition_state", composition });
      return composition;
    },
    emitKwwkOverlay: (input: Record<string, unknown> = {}) => {
      const overlay = {
        id: "react_overlay_" + Date.now().toString(36),
        ts: new Date().toISOString(),
        sourceId: String(input.sourceId || state.focusedSourceId || "host-app"),
        kind: String(input.kind || "cursor"),
        x: Number(input.x ?? 0.5),
        y: Number(input.y ?? 0.5),
        label: String(input.label || ""),
      };
      realtime.send({ type: "visual_overlay_event", overlay });
      realtime.send({ type: "kwwk_cursor_event", cursor: overlay });
      return overlay;
    },
    runKwwkCursorFixture: (opts: Record<string, unknown> = {}) => {
      const sourceId = String(opts.sourceId || state.focusedSourceId || "host-app");
      const steps = [
        { x: 0.3, y: 0.3, kind: "move", label: "approach" },
        { x: 0.38, y: 0.36, kind: "move", label: "approach" },
        { x: 0.42, y: 0.4, kind: "click", label: "click save" },
        { x: 0.48, y: 0.45, kind: "drag", label: "drag" },
        { x: 0.56, y: 0.52, kind: "drag", label: "drag" },
        { x: 0.62, y: 0.58, kind: "drag", label: "drag selection" },
        { x: 0.62, y: 0.58, kind: "done", label: "done" },
      ];
      for (const step of steps) {
        (window as LegacySurfaceWindow).setTimeout?.(
          () => {
            realtime.send({ type: "kwwk_cursor_event", cursor: { ...step, sourceId } });
          },
          Number(opts.animated === false ? 0 : opts.stepMs || 150),
        );
      }
      return steps.length;
    },
    sendSyntheticVoiceChunk: (input: SyntheticVoiceChunkInput = {}) => {
      const ok = voice.sendSyntheticVoiceChunk(input);
      if (!ok) return false;
      const sequence = finiteNumber(input.sequence, Number(state.voiceChunksSent || 0) + 1);
      state.voiceChunksSent = Math.max(Number(state.voiceChunksSent || 0), sequence);
      return true;
    },
    startMicrophone: async () => {
      await voice.startMic();
      return { ok: true, capture: { ...legacyVoiceCaptureView(voice), status: "capturing" } };
    },
    stopMicrophone: (reason?: string) => {
      voice.stopMic(reason || "operator_disarmed");
      return { ok: true, capture: { ...legacyVoiceCaptureView(voice), status: "idle" } };
    },
    setVoiceMuted: (muted: boolean) => {
      voice.setVoiceMuted(Boolean(muted), muted ? "operator_muted" : "operator_unmuted");
      return { ok: true, muted: Boolean(muted) };
    },
    refreshVoiceDevices: voice.refreshDevices,
    configureLocalVad: (enabled: boolean) => {
      voice.setLocalVadEnabled(Boolean(enabled));
      return legacyLocalVadView({
        enabled: Boolean(enabled),
        active: false,
        lastEnergy: voice.energy,
      });
    },
    emitKwwkJobState: (input: Record<string, unknown> = {}) => {
      const ok = realtime.send({ type: "kwwk_job_state", kwwk: input });
      return ok ? runtime.debug.kwwk || input : false;
    },
    submitToolResult: (input: Record<string, unknown> = {}) => {
      return realtime.send({
        ...toolResultDefaults(debug),
        ...input,
        type: "conversation_tool_result",
      });
    },
    cancelTool: (input: Record<string, unknown> = {}) => {
      runtime.cancelTool(String(input.reason || "operator_cancelled"));
      return true;
    },
    sendEngineControl: (type: EngineControlType, input: Record<string, unknown> = {}) => {
      runtime.sendEngineControl(type, {
        ...objectValue(input.detail),
        ...(input.responseId ? { responseId: input.responseId } : {}),
      });
      return true;
    },
    fetchDebugReport,
    copyDiagnostics: async () => {
      const body = await fetchDebugReport();
      const report = body.report || body;
      const text = JSON.stringify(report, null, 2);
      await Promise.resolve(navigator.clipboard?.writeText?.(text)).catch(() => undefined);
      sendDebugArtifact({ action: "copy", label: "operator_web" });
      return { ok: true, bytes: text.length, report };
    },
    downloadReport: async () => {
      const body = await fetchDebugReport();
      const report = body.report || body;
      const text = JSON.stringify(report, null, 2);
      await runtime.downloadReport();
      return { ok: true, bytes: text.length, report };
    },
    createDebugBundle: async (input: Record<string, unknown> = {}) => {
      const body = await fetchDebugReport();
      const report = body.report || body;
      const text = JSON.stringify(report, null, 2);
      const bundle = {
        id: String(input.bundleId || "react_debug_bundle_" + Date.now().toString(36)),
        label: String(input.label || "Local Operator Debug Bundle"),
        entries: [
          {
            id: "runtime_report",
            kind: "json",
            label: "Runtime report",
            bytes: text.length,
            contentType: "application/json",
            policy: "inline_report",
          },
        ],
      };
      sendDebugArtifact({ action: "bundle", bundle, bundleId: bundle.id, label: bundle.label });
      return { ok: true, bundle, report };
    },
    registerArtifactLink: (input: Record<string, unknown> = {}) => {
      const artifact = {
        label: String(input.label || "artifact"),
        kind: String(input.kind || "artifact"),
        href: String(input.href || ""),
        bytes: input.bytes == null ? null : Number(input.bytes),
        contentType: String(input.contentType || "") || null,
        reason: String(input.reason || "large_artifact"),
      };
      sendDebugArtifact({ action: "link", ...artifact });
      return { ...artifact, policy: "linked_only" };
    },
    markInterestingRun: runtime.markInteresting,
    liveProviderConfig: () => structuredClone(runtime.providerConfig || {}),
    currentComposition,
    currentDebug: () => structuredClone(debug || {}),
    sendTextInput: (text: string) => realtime.sendText(text),
    runWork: (command: string) => {
      const message = workRunMessage(command);
      return message ? realtime.send(message) : false;
    },
    setAudioEnabled: (enabled: boolean) => {
      const output = objectValue(debug.output);
      const audio = objectValue(output.assistantAudio);
      return realtime.send({
        type: "assistant_output_state",
        output: {
          ...output,
          assistantAudio: {
            ...audio,
            enabled: Boolean(enabled),
            status: enabled ? audio.status || "idle" : "blocked",
          },
        },
      });
    },
    outputClient: () => ({
      emitOutputState: () =>
        realtime.send({ type: "assistant_output_state", output: debug.output || {} }),
    }),
    switchConversationProvider: runtime.switchProvider,
    getComposedVideoTrack: () => null,
    openDebugPanel: () => true,
  };
}

async function fetchDebugReport() {
  const token = new URLSearchParams(location.search).get("token") || undefined;
  const response = await fetch(authSuffix(token, "/runtime/report"), { cache: "no-store" });
  if (!response.ok) throw new Error("debug_report_fetch_failed:" + String(response.status));
  return (await response.json()) as Record<string, unknown>;
}

function compositionWithPatch(
  debug: OperatorRuntimeState["debug"],
  patch: Record<string, unknown>,
) {
  const visual = debug.visual as DebugState["visual"] | undefined;
  const composition = objectValue(visual?.composition);
  return {
    ...composition,
    ...patch,
    mode: "operator_side",
    layoutRevision: Number(composition.layoutRevision || 0) + 1,
  };
}

function toolResultDefaults(debug: OperatorRuntimeState["debug"]) {
  const toolRouting = debug.toolRouting as DebugState["toolRouting"] | undefined;
  const timeline = debug.timeline as DebugState["timeline"] | undefined;
  const kwwk = debug.kwwk as DebugState["kwwk"] | undefined;
  const output = debug.output as DebugState["output"] | undefined;
  return {
    callId: toolRouting?.callId || "",
    itemId: toolRouting?.itemId || "",
    toolName: toolRouting?.actualTool || "kwwk_computer_use",
    jobId: kwwk?.currentJobId || "",
    turnId: timeline?.currentTurnId || "",
    responseId: output?.assistantText?.lastResponseId || "",
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function finiteNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
