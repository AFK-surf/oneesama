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

export interface WorkViewState {
  phase: WorkPhase;
  intent: string;
  backend: string;
  steps: WorkStep[];
  result: WorkResult | null;
  error: string;
}

export interface WorkEvent {
  type: "intent" | "not_a_command" | "step" | "cursor" | "result" | "error";
  detail?: Record<string, unknown>;
}

export const INITIAL_WORK_VIEW: WorkViewState = {
  phase: "idle",
  intent: "",
  backend: "",
  steps: [],
  result: null,
  error: "",
};

export function resetWorkForRun(): WorkViewState {
  return {
    ...INITIAL_WORK_VIEW,
    phase: "running",
    steps: [],
  };
}

export function workEventFromPayload(payload: Record<string, unknown>): WorkEvent | null {
  if (payload.type !== "work_event") return null;
  if (!isRecord(payload.event)) return null;
  const type = payload.event.type;
  if (!isWorkEventType(type)) return null;
  return {
    type,
    detail: isRecord(payload.event.detail) ? payload.event.detail : undefined,
  };
}

export function foldWorkEvent(state: WorkViewState, event: WorkEvent): WorkViewState {
  const detail = event.detail || {};
  if (event.type === "intent") {
    return {
      ...state,
      intent: String(detail.intent || ""),
      backend: String(detail.backend || ""),
      phase: "running",
    };
  }
  if (event.type === "not_a_command") {
    return {
      ...state,
      error: String(detail.reason || "not a command"),
      phase: "not_a_command",
    };
  }
  if (event.type === "step") {
    return {
      ...state,
      steps: [...state.steps, workStepFromDetail(detail, state.steps.length)],
    };
  }
  if (event.type === "result") {
    return {
      ...state,
      result: detail as unknown as WorkResult,
      phase: String(detail.status) === "done" ? "done" : "error",
    };
  }
  if (event.type === "error") {
    return {
      ...state,
      error: String(detail.error || detail.reason || "work error"),
      phase: "error",
    };
  }
  return state;
}

function workStepFromDetail(detail: Record<string, unknown>, previousStepCount: number): WorkStep {
  const operation = isRecord(detail.operation) ? detail.operation : {};
  const target = isRecord(operation.target) ? operation.target : {};
  return {
    step: Number(detail.step || previousStepCount + 1),
    type: optionalString(operation.type),
    ref: optionalString(target.ref),
    rationale: optionalString(operation.rationale),
    failed: Boolean(detail.failed),
    error: detail.error ? String(detail.error) : undefined,
  };
}

function optionalString(value: unknown): string | undefined {
  return value == null ? undefined : String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isWorkEventType(value: unknown): value is WorkEvent["type"] {
  return (
    value === "intent" ||
    value === "not_a_command" ||
    value === "step" ||
    value === "cursor" ||
    value === "result" ||
    value === "error"
  );
}
