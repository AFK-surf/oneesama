import type { DebugState } from "../lan-operator-debug-state.ts";
import type { OperatorRuntimeState } from "./useOperatorRuntime.ts";
import { canStopKwwkStatus } from "./operatorKwwkStatus.ts";
import type { WorkState } from "./useWork.ts";

export interface WorkActionView {
  key: string;
  kind: string;
  label: string;
  status: string;
}

export interface WorkPanelView {
  headerStatus: string;
  headerBackend: string;
  runButtonDisabled: boolean;
  stopActionDisabled: boolean;
  kwwkStatus: string;
  kwwkPhaseClass: string;
  jobLabel: string;
  cursorLabel: string;
  actionCountLabel: string;
  verificationLabel: string;
  blockerText: string;
  recentActions: WorkActionView[];
  empty: boolean;
  phaseLabel: string;
  workPhaseClass: string;
  backendLabel: string;
  intentText: string;
  steps: WorkState["steps"];
  result: WorkState["result"];
  errorText: string;
}

const PHASE_LABEL: Record<string, string> = {
  idle: "idle",
  running: "running…",
  done: "done",
  not_a_command: "not a command",
  error: "error",
};

export function workPanelView(
  work: Pick<WorkState, "backend" | "error" | "intent" | "phase" | "result" | "steps">,
  runtime: Pick<OperatorRuntimeState, "debug">,
): WorkPanelView {
  const kwwk = runtime.debug.kwwk as DebugState["kwwk"] | undefined;
  const kwwkStatus = kwwk?.status || "idle";

  return {
    headerStatus: kwwk?.status || work.phase,
    headerBackend: kwwk?.latestActionKind || work.backend || "manual",
    runButtonDisabled: work.phase === "running",
    stopActionDisabled: !canStopKwwk(kwwk?.status),
    kwwkStatus,
    kwwkPhaseClass: "phase-" + kwwkStatus,
    jobLabel: kwwk?.currentJobId || "-",
    cursorLabel: String(kwwk?.cursorEventCount || 0),
    actionCountLabel: String(kwwk?.actionCount || 0),
    verificationLabel: verificationLabel(kwwk?.verification),
    blockerText: kwwk?.blocker ? `blocked: ${kwwk.blocker}` : "",
    recentActions: recentKwwkActions(kwwk?.actions || []),
    empty: work.phase === "idle",
    phaseLabel: PHASE_LABEL[work.phase] || work.phase,
    workPhaseClass: "phase-" + work.phase,
    backendLabel: work.backend,
    intentText: work.intent,
    steps: work.steps,
    result: work.result,
    errorText: work.error,
  };
}

export function canStopKwwk(status: string | null | undefined): boolean {
  return canStopKwwkStatus(status);
}

function verificationLabel(verification: DebugState["kwwk"]["verification"] | undefined): string {
  if (verification?.ok == null) return verification?.status || "-";
  return verification.ok ? "ok" : "failed";
}

function recentKwwkActions(actions: DebugState["kwwk"]["actions"]): WorkActionView[] {
  return actions.slice(-5).map((action, index) => ({
    key: `${action.ts}-${index}`,
    kind: action.kind,
    label: action.label,
    status: action.status,
  }));
}
