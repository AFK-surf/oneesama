import { useCallback, useEffect, useMemo, useState } from "react";

import type { DebugState } from "../lan-operator-debug-state.ts";
import type {
  LanOperatorLiveProviderConfig,
  LanOperatorLiveProviderEntry,
} from "../lan-operator-live-provider-config.ts";
import { authSuffix } from "./protocol.ts";
import type { OperatorBoot, RealtimeState } from "./useRealtime.ts";

export type OperatorDebug = Partial<DebugState> & Record<string, unknown>;

export interface RuntimeEventView {
  id?: string;
  ts?: string;
  phase?: string;
  event?: string;
  severity?: string;
  summary?: string;
  detail?: Record<string, unknown>;
}

export interface RuntimeStatusBody {
  ok?: boolean;
  snapshot?: Record<string, unknown>;
  inputPolicy?: Record<string, unknown>;
  outputPolicy?: Record<string, unknown>;
  debug?: OperatorDebug;
  recentEvents?: RuntimeEventView[];
  liveProviderConfig?: LanOperatorLiveProviderConfig;
  conversationTransport?: string;
  report?: unknown;
  error?: string;
}

export type EngineControlType =
  | "connect"
  | "disconnect"
  | "cancel_response"
  | "clear_audio_buffer"
  | "drain_events"
  | "set_voice_armed"
  | "set_voice_muted"
  | "reset_session"
  | "reconnect";

export interface ProviderSwitchState {
  status: "idle" | "switching" | "active" | "failed";
  targetTransport: string;
  lastError: string;
}

export interface OperatorRuntimeState {
  debug: OperatorDebug;
  snapshot: Record<string, unknown> | null;
  inputPolicy: Record<string, unknown> | null;
  outputPolicy: Record<string, unknown> | null;
  recentEvents: RuntimeEventView[];
  providerConfig: LanOperatorLiveProviderConfig | null;
  selectedProvider: LanOperatorLiveProviderEntry | null;
  runtimeError: string;
  providerSwitch: ProviderSwitchState;
  refreshStatus: () => Promise<RuntimeStatusBody | null>;
  switchProvider: (transport: string) => Promise<RuntimeStatusBody | null>;
  sendEngineControl: (type: EngineControlType, detail?: Record<string, unknown>) => void;
  cancelTool: (reason?: string) => void;
  copyReport: () => Promise<number>;
  downloadReport: () => Promise<void>;
  markInteresting: (input?: { label?: string; note?: string }) => void;
}

function extractLiveProviderConfig(body: RuntimeStatusBody): LanOperatorLiveProviderConfig | null {
  const direct = body.liveProviderConfig;
  if (direct) return direct;
  const fromDebug = body.debug?.surfaceContext as
    | { liveProviderConfig?: LanOperatorLiveProviderConfig }
    | undefined;
  return fromDebug?.liveProviderConfig || null;
}

async function jsonRequest(
  token: string | undefined,
  path: string,
  init?: RequestInit,
): Promise<RuntimeStatusBody> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(authSuffix(token, path), {
    cache: "no-store",
    ...init,
    headers,
  });
  const body = (await response.json().catch(() => ({}))) as RuntimeStatusBody;
  if (!response.ok || body.ok === false) {
    throw new Error(body.error || `runtime_request_failed:${response.status}`);
  }
  return body;
}

export function useOperatorRuntime(
  boot: OperatorBoot,
  realtime: RealtimeState,
): OperatorRuntimeState {
  const { send, subscribeRaw, transport } = realtime;
  const [debug, setDebug] = useState<OperatorDebug>({});
  const [snapshot, setSnapshot] = useState<Record<string, unknown> | null>(null);
  const [inputPolicy, setInputPolicy] = useState<Record<string, unknown> | null>(null);
  const [outputPolicy, setOutputPolicy] = useState<Record<string, unknown> | null>(null);
  const [recentEvents, setRecentEvents] = useState<RuntimeEventView[]>([]);
  const [providerConfig, setProviderConfig] = useState<LanOperatorLiveProviderConfig | null>(
    boot.liveProviderConfig || null,
  );
  const [runtimeError, setRuntimeError] = useState("");
  const [providerSwitch, setProviderSwitch] = useState<ProviderSwitchState>({
    status: "idle",
    targetTransport: "",
    lastError: "",
  });

  const applyRuntimeBody = useCallback((body: RuntimeStatusBody) => {
    if (body.snapshot) setSnapshot(body.snapshot);
    if (body.inputPolicy) setInputPolicy(body.inputPolicy);
    if (body.outputPolicy) setOutputPolicy(body.outputPolicy);
    if (body.debug) setDebug(body.debug);
    if (body.recentEvents) setRecentEvents(body.recentEvents.slice(-80));
    const nextProviderConfig = extractLiveProviderConfig(body);
    if (nextProviderConfig) setProviderConfig(nextProviderConfig);
    setRuntimeError("");
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const body = await jsonRequest(boot.token, "/runtime/status");
      applyRuntimeBody(body);
      return body;
    } catch (error) {
      setRuntimeError(String((error as Error)?.message || error));
      return null;
    }
  }, [applyRuntimeBody, boot.token]);

  useEffect(() => {
    void refreshStatus();
    const interval = window.setInterval(() => void refreshStatus(), 2500);
    return () => window.clearInterval(interval);
  }, [refreshStatus]);

  useEffect(() => {
    return subscribeRaw((payload) => {
      const body: RuntimeStatusBody = {};
      if (payload.debug && typeof payload.debug === "object") {
        body.debug = payload.debug as OperatorDebug;
      }
      if (payload.event && typeof payload.event === "object") {
        setRecentEvents((prev) => [...prev, payload.event as RuntimeEventView].slice(-80));
      }
      if (body.debug) applyRuntimeBody(body);
    });
  }, [applyRuntimeBody, subscribeRaw]);

  const switchProvider = useCallback(
    async (nextTransport: string) => {
      const targetTransport = String(nextTransport || "").trim();
      if (!targetTransport) return null;
      setProviderSwitch({ status: "switching", targetTransport, lastError: "" });
      try {
        const body = await jsonRequest(boot.token, "/runtime/provider", {
          method: "POST",
          body: JSON.stringify({ transport: targetTransport, connect: true }),
        });
        applyRuntimeBody(body);
        setProviderSwitch({
          status: "active",
          targetTransport: String(body.conversationTransport || targetTransport),
          lastError: "",
        });
        return body;
      } catch (error) {
        const message = String((error as Error)?.message || error);
        setRuntimeError(message);
        setProviderSwitch({ status: "failed", targetTransport, lastError: message });
        return null;
      }
    },
    [applyRuntimeBody, boot.token],
  );

  const sendEngineControl = useCallback(
    (type: EngineControlType, detail: Record<string, unknown> = {}) => {
      send({
        type: "engine_control",
        sessionId: boot.sessionId,
        control: {
          type,
          reason: `operator_web_${type}`,
          responseId: String(
            detail.responseId ||
              (debug.output as DebugState["output"] | undefined)?.assistantText?.lastResponseId ||
              "",
          ),
          detail: { source: "operator_web", ...detail },
        },
      });
    },
    [boot.sessionId, debug.output, send],
  );

  const cancelTool = useCallback(
    (reason = "operator_cancelled") => {
      const toolRouting = debug.toolRouting as DebugState["toolRouting"] | undefined;
      const kwwk = debug.kwwk as DebugState["kwwk"] | undefined;
      const timeline = debug.timeline as DebugState["timeline"] | undefined;
      const output = debug.output as DebugState["output"] | undefined;
      send({
        type: "tool_cancel",
        callId: toolRouting?.callId || "",
        itemId: toolRouting?.itemId || "",
        toolName: toolRouting?.actualTool || "kwwk_computer_use",
        jobId: kwwk?.currentJobId || "",
        turnId: timeline?.currentTurnId || "",
        responseId: output?.assistantText?.lastResponseId || "",
        reason,
      });
    },
    [debug.kwwk, debug.output, debug.timeline, debug.toolRouting, send],
  );

  const fetchReportText = useCallback(async () => {
    const body = await jsonRequest(boot.token, "/runtime/report");
    return JSON.stringify(body.report || body, null, 2);
  }, [boot.token]);

  const markInteresting = useCallback(
    (input: { label?: string; note?: string } = {}) => {
      send({
        type: "debug_report_artifact",
        action: "mark",
        label: input.label || "operator_web_mark",
        note: input.note || "",
      });
    },
    [send],
  );

  const copyReport = useCallback(async () => {
    const text = await fetchReportText();
    await navigator.clipboard?.writeText?.(text).catch(() => undefined);
    send({ type: "debug_report_artifact", action: "copy", label: "operator_web" });
    return text.length;
  }, [fetchReportText, send]);

  const downloadReport = useCallback(async () => {
    const text = await fetchReportText();
    const blob = new Blob([text], { type: "application/json" });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = `lan-operator-report-${Date.now()}.json`;
    anchor.click();
    URL.revokeObjectURL(href);
    send({ type: "debug_report_artifact", action: "download", label: "operator_web" });
  }, [fetchReportText, send]);

  const selectedProvider = useMemo(() => {
    if (!providerConfig) return null;
    const selectedTransport =
      providerConfig.selectedLiveTransport || providerConfig.selectedTransport || transport;
    return (
      providerConfig.providers.find((provider) => provider.transport === selectedTransport) ||
      providerConfig.providers.find((provider) => provider.selected) ||
      null
    );
  }, [providerConfig, transport]);

  return {
    debug,
    snapshot,
    inputPolicy,
    outputPolicy,
    recentEvents,
    providerConfig,
    selectedProvider,
    runtimeError,
    providerSwitch,
    refreshStatus,
    switchProvider,
    sendEngineControl,
    cancelTool,
    copyReport,
    downloadReport,
    markInteresting,
  };
}
