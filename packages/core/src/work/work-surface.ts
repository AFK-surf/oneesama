import type { WorkJobPostCondition } from "./work-job.ts";
import type { WorkOperation } from "./work-operations.ts";

export interface WorkObservationRef {
  ref: string;
  role: string;
  name: string;
  value?: string;
}

export interface WorkSurfaceObservation {
  schema: "oneesama.work_observation.v1";
  surfaceId: string;
  url: string;
  title: string;
  /** Human/model-readable outline; each actionable line carries [ref=eN]. */
  outline: string;
  refs: WorkObservationRef[];
  truncated: boolean;
  capturedAt: string;
}

export interface WorkCursorPoint {
  /** Normalized [0,1] viewport coordinates of the acted-on element center. */
  x: number;
  y: number;
}

export interface WorkOperationResult {
  ok: boolean;
  operation: WorkOperation;
  error?: string;
  blocked?: string;
  /** extract: the pulled text; get-app-state: a state summary. */
  extracted?: string;
  cursor?: WorkCursorPoint;
  durationMs: number;
}

export interface WorkPostConditionResult {
  condition: WorkJobPostCondition;
  ok: boolean;
  detail: string;
}

/**
 * Backend port (RFC D10): the CDP work browser implements this first;
 * the native kwwk-cu AX helper is the planned second backend. Everything
 * above this interface (jobs, planner, executor, harness) must stay
 * backend-agnostic.
 */
export interface WorkSurfacePort {
  id: string;
  kind: "cdp_browser" | "native_ax";
  observe(): Promise<WorkSurfaceObservation>;
  perform(operation: WorkOperation): Promise<WorkOperationResult>;
  checkPostCondition(condition: WorkJobPostCondition): Promise<WorkPostConditionResult>;
  close(): Promise<void>;
}
