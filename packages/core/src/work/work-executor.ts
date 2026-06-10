import type { WorkJob } from "./work-job.ts";
import { validateWorkOperation } from "./work-operations.ts";
import type { WorkExecutorStepSummary, WorkPlannerPort } from "./work-planner.ts";
import type {
  WorkOperationResult,
  WorkPostConditionResult,
  WorkSurfaceObservation,
  WorkSurfacePort,
} from "./work-surface.ts";

export type WorkJobStatus = "done" | "blocked" | "failed";

export interface WorkExecutorStep extends WorkExecutorStepSummary {
  observationDigestUrl: string;
  plannedAt: string;
  durationMs: number;
  retried: boolean;
}

export interface WorkJobResult {
  schema: "oneesama.work_job_result.v1";
  jobId: string;
  status: WorkJobStatus;
  summary: string;
  blocker: string;
  steps: WorkExecutorStep[];
  postConditions: WorkPostConditionResult[];
  extracted: string;
  startedAt: string;
  finishedAt: string;
  totalMs: number;
}

export interface WorkExecutorEvent {
  type: "observation" | "operation" | "operation_result" | "job_result";
  jobId: string;
  step?: number;
  observation?: WorkSurfaceObservation;
  operation?: WorkExecutorStep["operation"];
  result?: WorkOperationResult;
  jobResult?: WorkJobResult;
}

export interface WorkExecutorOptions {
  surface: WorkSurfacePort;
  planner: WorkPlannerPort;
  maxSteps?: number;
  onEvent?: (event: WorkExecutorEvent) => void;
}

export interface WorkExecutor {
  run(job: WorkJob): Promise<WorkJobResult>;
}

/**
 * Stepwise loop (RFC D5): observe → planner decides ONE operation → execute
 * → re-observe. A failed operation gets exactly one retry after a fresh
 * observation; a second failure ends the job as failed (clean blocker,
 * never silent flailing).
 */
export function createWorkExecutor(options: WorkExecutorOptions): WorkExecutor {
  const surface = options.surface;
  const planner = options.planner;
  const maxSteps = Math.max(1, Number(options.maxSteps || 12));
  const emit = (event: WorkExecutorEvent) => options.onEvent?.(event);

  async function run(job: WorkJob): Promise<WorkJobResult> {
    const startedAtMs = Date.now();
    const startedAt = new Date().toISOString();
    const steps: WorkExecutorStep[] = [];
    const extractedParts: string[] = [];
    let status: WorkJobStatus = "failed";
    let summary = "";
    let blocker = "";

    while (steps.length < maxSteps) {
      const observation = await surface.observe();
      emit({ type: "observation", jobId: job.id, step: steps.length, observation });
      const decided = await planner.decide({ job, observation, steps });
      const validation = validateWorkOperation(decided);
      if (!validation.ok || !validation.operation) {
        blocker = `planner_operation_invalid:${validation.errors.join(",")}`;
        break;
      }
      const operation = validation.operation;
      emit({ type: "operation", jobId: job.id, step: steps.length, operation });

      if (operation.type === "done") {
        status = "done";
        summary = operation.summary || "";
        steps.push({
          step: steps.length,
          operation,
          ok: true,
          observationDigestUrl: observation.url,
          plannedAt: new Date().toISOString(),
          durationMs: 0,
          retried: false,
        });
        break;
      }
      if (operation.type === "blocked") {
        status = "blocked";
        blocker = operation.blocker || "planner_blocked";
        steps.push({
          step: steps.length,
          operation,
          ok: true,
          observationDigestUrl: observation.url,
          plannedAt: new Date().toISOString(),
          durationMs: 0,
          retried: false,
        });
        break;
      }

      let result = await surface.perform(operation);
      let retried = false;
      if (!result.ok && !result.blocked) {
        // One bounded retry against a fresh observation (refs may be stale).
        await surface.observe();
        retried = true;
        result = await surface.perform(operation);
      }
      emit({ type: "operation_result", jobId: job.id, step: steps.length, result });
      if (result.extracted) extractedParts.push(result.extracted);
      steps.push({
        step: steps.length,
        operation,
        ok: result.ok,
        ...(result.error ? { error: result.error } : {}),
        ...(result.blocked ? { blocked: result.blocked } : {}),
        ...(result.extracted ? { extracted: result.extracted } : {}),
        observationDigestUrl: observation.url,
        plannedAt: new Date().toISOString(),
        durationMs: result.durationMs,
        retried,
      });
      if (result.blocked) {
        status = "blocked";
        blocker = result.blocked;
        break;
      }
      if (!result.ok) {
        status = "failed";
        blocker = result.error || "operation_failed";
        break;
      }
    }

    if (status === "failed" && !blocker && steps.length >= maxSteps) {
      blocker = `max_steps_reached:${maxSteps}`;
    }

    // "Done" is only reported after every post-condition verifies (RFC P2.1).
    const postConditions: WorkPostConditionResult[] = [];
    if (status === "done") {
      for (const condition of job.postConditions) {
        postConditions.push(await surface.checkPostCondition(condition));
      }
      if (postConditions.some((entry) => !entry.ok)) {
        status = "failed";
        blocker = "post_conditions_failed";
      }
    }

    const jobResult: WorkJobResult = {
      schema: "oneesama.work_job_result.v1",
      jobId: job.id,
      status,
      summary,
      blocker,
      steps,
      postConditions,
      extracted: extractedParts.join("\n\n").slice(0, 4000),
      startedAt,
      finishedAt: new Date().toISOString(),
      totalMs: Date.now() - startedAtMs,
    };
    emit({ type: "job_result", jobId: job.id, jobResult });
    return jobResult;
  }

  return { run };
}
