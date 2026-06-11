import { useCallback, useEffect, useState } from "react";

import type { RealtimeState } from "./useRealtime.ts";

export interface WorkStep {
  step: number;
  type?: string;
  ref?: string;
  rationale?: string;
  failed?: boolean;
  error?: string;
}

export interface WorkResult {
  status: string;
  steps?: number;
  totalMs?: number;
  extracted?: string;
  summary?: string;
  blocker?: string;
  postConditions?: Array<{ ok?: boolean; condition?: { kind?: string; value?: string } }>;
}

export type WorkPhase = "idle" | "running" | "done" | "not_a_command" | "error";

export interface WorkState {
  phase: WorkPhase;
  intent: string;
  backend: string;
  steps: WorkStep[];
  result: WorkResult | null;
  error: string;
  run: (command: string) => void;
}

interface WorkEvent {
  type: "intent" | "not_a_command" | "step" | "cursor" | "result" | "error";
  detail?: Record<string, unknown>;
}

/**
 * Work pipeline for the React surface: sends `work_run` over the events WS and
 * folds the runtime's `work_event` envelopes (intent → step* → result) into a
 * single run view. This is the "realtime makes it do work" path — currently a
 * manual command trigger (the realtime model does not yet call it as a tool).
 */
export function useWork(realtime: RealtimeState): WorkState {
  const { send, subscribeRaw } = realtime;
  const [phase, setPhase] = useState<WorkPhase>("idle");
  const [intent, setIntent] = useState("");
  const [backend, setBackend] = useState("");
  const [steps, setSteps] = useState<WorkStep[]>([]);
  const [result, setResult] = useState<WorkResult | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    return subscribeRaw((payload) => {
      if (payload.type !== "work_event" || !payload.event) return;
      const event = payload.event as WorkEvent;
      const detail = event.detail || {};
      if (event.type === "intent") {
        setIntent(String(detail.intent || ""));
        setBackend(String(detail.backend || ""));
        setPhase("running");
      } else if (event.type === "not_a_command") {
        setError(String(detail.reason || "not a command"));
        setPhase("not_a_command");
      } else if (event.type === "step") {
        const op = (detail.operation || {}) as {
          type?: string;
          target?: { ref?: string };
          rationale?: string;
        };
        setSteps((prev) => [
          ...prev,
          {
            step: Number(detail.step || prev.length + 1),
            type: op.type,
            ref: op.target?.ref,
            rationale: op.rationale,
            failed: Boolean(detail.failed),
            error: detail.error ? String(detail.error) : undefined,
          },
        ]);
      } else if (event.type === "result") {
        setResult(detail as unknown as WorkResult);
        setPhase(String(detail.status) === "done" ? "done" : "error");
      } else if (event.type === "error") {
        setError(String(detail.error || detail.reason || "work error"));
        setPhase("error");
      }
    });
  }, [subscribeRaw]);

  const run = useCallback(
    (next: string) => {
      const value = next.trim();
      if (!value) return;
      setIntent("");
      setBackend("");
      setSteps([]);
      setResult(null);
      setError("");
      setPhase("running");
      send({ type: "work_run", command: value });
    },
    [send],
  );

  return { phase, intent, backend, steps, result, error, run };
}
