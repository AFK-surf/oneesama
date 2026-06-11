import { useCallback, useEffect, useReducer } from "react";

import type { RealtimeState } from "./useRealtime.ts";
import { workRunMessage } from "./workCommands.ts";
import {
  INITIAL_WORK_VIEW,
  foldWorkEvent,
  resetWorkForRun,
  workEventFromPayload,
} from "./workState.ts";
import type { WorkEvent, WorkViewState } from "./workState.ts";
export type { WorkPhase, WorkResult, WorkStep } from "./workState.ts";

export interface WorkState extends WorkViewState {
  run: (command: string) => void;
}

type WorkAction = { type: "event"; event: WorkEvent } | { type: "run" };

function workReducer(state: WorkViewState, action: WorkAction): WorkViewState {
  if (action.type === "run") return resetWorkForRun();
  return foldWorkEvent(state, action.event);
}

/**
 * Work pipeline for the React surface: sends `work_run` over the events WS and
 * folds the runtime's `work_event` envelopes (intent → step* → result) into a
 * single run view. This is the "realtime makes it do work" path — currently a
 * manual command trigger (the realtime model does not yet call it as a tool).
 */
export function useWork(realtime: RealtimeState): WorkState {
  const { send, subscribeRaw } = realtime;
  const [state, dispatch] = useReducer(workReducer, INITIAL_WORK_VIEW);

  useEffect(() => {
    return subscribeRaw((payload) => {
      const event = workEventFromPayload(payload);
      if (event) dispatch({ type: "event", event });
    });
  }, [subscribeRaw]);

  const run = useCallback(
    (next: string) => {
      const message = workRunMessage(next);
      if (!message) return;
      dispatch({ type: "run" });
      send(message);
    },
    [send],
  );

  return { ...state, run };
}
