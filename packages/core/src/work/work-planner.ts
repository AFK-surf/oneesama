import type { WorkJob } from "./work-job.ts";
import type { WorkOperation } from "./work-operations.ts";
import type { WorkSurfaceObservation } from "./work-surface.ts";

export interface WorkExecutorStepSummary {
  step: number;
  operation: WorkOperation;
  ok: boolean;
  error?: string;
  blocked?: string;
  extracted?: string;
}

export interface WorkPlannerDecideInput {
  job: WorkJob;
  observation: WorkSurfaceObservation;
  steps: WorkExecutorStepSummary[];
}

export interface WorkPlannerPort {
  id: string;
  decide(input: WorkPlannerDecideInput): Promise<WorkOperation>;
}

export interface WorkPlannerRecord {
  step: number;
  operation: WorkOperation;
  observationDigest: string;
}

/** Stable short digest of an observation, for drift visibility in replays. */
export function digestObservation(observation: WorkSurfaceObservation): string {
  const text = `${observation.url}\n${observation.outline}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Deterministic planner for offline tests: returns the scripted operation per step. */
export function createScriptedWorkPlanner(operations: WorkOperation[]): WorkPlannerPort {
  return {
    id: "scripted_work_planner",
    async decide(input) {
      const index = input.steps.length;
      const operation = operations[index];
      if (!operation) {
        return {
          schema: "oneesama.work_operation.v1",
          type: "blocked",
          blocker: `scripted_planner_exhausted_at_step_${index}`,
        };
      }
      return operation;
    },
  };
}

/**
 * Records every decision of the inner planner at the LLM boundary (RFC D4).
 * The sink receives one record per step; persist them and feed
 * createReplayWorkPlanner for the deterministic CI gate.
 */
export function createRecordingWorkPlanner(
  inner: WorkPlannerPort,
  sink: (record: WorkPlannerRecord) => void,
): WorkPlannerPort {
  return {
    id: `recording(${inner.id})`,
    async decide(input) {
      const operation = await inner.decide(input);
      sink({
        step: input.steps.length,
        operation,
        observationDigest: digestObservation(input.observation),
      });
      return operation;
    },
  };
}

/** Replays recorded decisions in order; plumbing-only determinism (RFC D4). */
export function createReplayWorkPlanner(records: WorkPlannerRecord[]): WorkPlannerPort {
  return {
    id: "replay_work_planner",
    async decide(input) {
      const index = input.steps.length;
      const record = records[index];
      if (!record) {
        return {
          schema: "oneesama.work_operation.v1",
          type: "blocked",
          blocker: `replay_exhausted_at_step_${index}`,
        };
      }
      return record.operation;
    },
  };
}
