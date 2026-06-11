import { useCallback, useEffect, useMemo, useReducer } from "react";

import {
  createOperatorRuntimeClient,
  type LanOperatorLiveProviderEntry,
  type OperatorDebug,
  type RuntimeEventView,
  type RuntimeStatusBody,
} from "./operatorRuntimeClient.ts";
import {
  foldRuntimeBody,
  foldRuntimeRawPayload,
  initialOperatorRuntimeViewState,
  providerSwitchFailed,
  providerSwitchStarted,
  providerSwitchSucceeded,
  runtimeRequestFailed,
  selectRuntimeProvider,
} from "./runtimeState.ts";
import type { OperatorRuntimeViewState } from "./runtimeState.ts";
import {
  debugReportArtifactMessage,
  engineControlMessage,
  toolCancelMessage,
} from "./operatorRuntimeCommands.ts";
import type { OperatorBoot, RealtimeState } from "./useRealtime.ts";

export type { OperatorDebug, RuntimeEventView, RuntimeStatusBody };

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

export interface OperatorRuntimeState extends OperatorRuntimeViewState {
  selectedProvider: LanOperatorLiveProviderEntry | null;
  refreshStatus: () => Promise<RuntimeStatusBody | null>;
  switchProvider: (transport: string) => Promise<RuntimeStatusBody | null>;
  sendEngineControl: (type: EngineControlType, detail?: Record<string, unknown>) => void;
  cancelTool: (reason?: string) => void;
  copyReport: () => Promise<number>;
  downloadReport: () => Promise<void>;
  markInteresting: (input?: { label?: string; note?: string }) => void;
}

type OperatorRuntimeAction =
  | { type: "body"; body: RuntimeStatusBody }
  | { type: "raw_payload"; payload: Record<string, unknown> }
  | { type: "request_failed"; error: unknown }
  | { type: "provider_switch_started"; targetTransport: string }
  | { type: "provider_switch_succeeded"; targetTransport: string }
  | { type: "provider_switch_failed"; targetTransport: string; error: unknown };

function operatorRuntimeReducer(
  state: OperatorRuntimeViewState,
  action: OperatorRuntimeAction,
): OperatorRuntimeViewState {
  if (action.type === "body") return foldRuntimeBody(state, action.body);
  if (action.type === "raw_payload") return foldRuntimeRawPayload(state, action.payload);
  if (action.type === "request_failed") return runtimeRequestFailed(state, action.error);
  if (action.type === "provider_switch_started") {
    return providerSwitchStarted(state, action.targetTransport);
  }
  if (action.type === "provider_switch_succeeded") {
    return providerSwitchSucceeded(state, action.targetTransport);
  }
  return providerSwitchFailed(state, action.targetTransport, action.error);
}

export function useOperatorRuntime(
  boot: OperatorBoot,
  realtime: RealtimeState,
): OperatorRuntimeState {
  const { send, subscribeRaw, transport } = realtime;
  const client = useMemo(() => createOperatorRuntimeClient(boot.token), [boot.token]);
  const [state, dispatch] = useReducer(
    operatorRuntimeReducer,
    boot.liveProviderConfig || null,
    initialOperatorRuntimeViewState,
  );

  const applyRuntimeBody = useCallback((body: RuntimeStatusBody) => {
    dispatch({ type: "body", body });
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const body = await client.refreshStatus();
      applyRuntimeBody(body);
      return body;
    } catch (error) {
      dispatch({ type: "request_failed", error });
      return null;
    }
  }, [applyRuntimeBody, client]);

  useEffect(() => {
    void refreshStatus();
    const interval = window.setInterval(() => void refreshStatus(), 2500);
    return () => window.clearInterval(interval);
  }, [refreshStatus]);

  useEffect(() => {
    return subscribeRaw((payload) => {
      dispatch({ type: "raw_payload", payload });
    });
  }, [subscribeRaw]);

  const switchProvider = useCallback(
    async (nextTransport: string) => {
      const targetTransport = String(nextTransport || "").trim();
      if (!targetTransport) return null;
      dispatch({ type: "provider_switch_started", targetTransport });
      try {
        const body = await client.switchProvider(targetTransport);
        applyRuntimeBody(body);
        dispatch({
          type: "provider_switch_succeeded",
          targetTransport: String(body.conversationTransport || targetTransport),
        });
        return body;
      } catch (error) {
        dispatch({ type: "provider_switch_failed", targetTransport, error });
        return null;
      }
    },
    [applyRuntimeBody, client],
  );

  const sendEngineControl = useCallback(
    (type: EngineControlType, detail: Record<string, unknown> = {}) => {
      send(engineControlMessage({ debug: state.debug, detail, sessionId: boot.sessionId, type }));
    },
    [boot.sessionId, state.debug, send],
  );

  const cancelTool = useCallback(
    (reason = "operator_cancelled") => {
      send(toolCancelMessage(state.debug, reason));
    },
    [send, state.debug],
  );

  const markInteresting = useCallback(
    (input: { label?: string; note?: string } = {}) => {
      send(
        debugReportArtifactMessage({
          action: "mark",
          label: input.label || "operator_web_mark",
          note: input.note || "",
        }),
      );
    },
    [send],
  );

  const copyReport = useCallback(async () => {
    const text = await client.fetchReportText();
    await navigator.clipboard?.writeText?.(text).catch(() => undefined);
    send(debugReportArtifactMessage({ action: "copy", label: "operator_web" }));
    return text.length;
  }, [client, send]);

  const downloadReport = useCallback(async () => {
    const text = await client.fetchReportText();
    const blob = new Blob([text], { type: "application/json" });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = `lan-operator-report-${Date.now()}.json`;
    anchor.click();
    URL.revokeObjectURL(href);
    send(debugReportArtifactMessage({ action: "download", label: "operator_web" }));
  }, [client, send]);

  const selectedProvider = useMemo(() => {
    return selectRuntimeProvider(state.providerConfig, transport);
  }, [state.providerConfig, transport]);

  return {
    ...state,
    selectedProvider,
    refreshStatus,
    switchProvider,
    sendEngineControl,
    cancelTool,
    copyReport,
    downloadReport,
    markInteresting,
  };
}
