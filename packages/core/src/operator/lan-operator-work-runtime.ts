import { createWorkAxSurface, type KwwkTransport } from "../work/work-ax-surface.ts";
import { createWorkExecutor, type WorkExecutorEvent } from "../work/work-executor.ts";
import { compileWorkIntent } from "../work/work-intent-compiler.ts";
import { createOpenAIWorkPlanner } from "../work/work-openai-planner.ts";
import type { WorkPlannerPort } from "../work/work-planner.ts";
import type { WorkSurfacePort } from "../work/work-surface.ts";

export interface LanOperatorWorkEvent {
  type: "intent" | "not_a_command" | "step" | "cursor" | "result" | "error";
  detail: Record<string, unknown>;
}

export interface LanOperatorWorkFrame {
  /** base64 JPEG of the work surface viewport. */
  dataBase64: string;
  width: number;
  height: number;
}

export interface LanOperatorWorkRuntimeOptions {
  /** Target app kwwk-cu drives (workspace isolation: the executor only acts here). */
  axApp?: string;
  onEvent: (event: LanOperatorWorkEvent) => void;
  onFrame: (frame: LanOperatorWorkFrame) => void;
  /** Injectable for tests / alternate providers; default = OpenAI stepwise planner. */
  createPlanner?: (hint: string) => WorkPlannerPort;
  /** Injectable for tests; default spawns the persistent kwwk-cu --stdio helper. */
  createAxTransport?: () => Promise<KwwkTransport>;
  /** Injectable for tests; bypass the helper transport with a ready surface. */
  createSurface?: (surfaceId: string) => WorkSurfacePort;
}

export interface LanOperatorWorkRuntime {
  run(command: string): Promise<{ status: string }>;
  busy(): boolean;
  close(): Promise<void>;
}

/**
 * Server-side runner that exposes the work pipeline to the operator web
 * surface. The single executor backend is kwwk-cu native AX (RFC: CDP work
 * browser dropped as a redundant reimplementation). observe()/perform() run
 * through WorkSurfacePort; the stepwise executor + step narration are shared.
 * Live screen-capture frames need Screen Recording TCC and are wired
 * separately; for now frames are not streamed.
 */
export function createLanOperatorWorkRuntime(
  options: LanOperatorWorkRuntimeOptions,
): LanOperatorWorkRuntime {
  const createPlanner =
    options.createPlanner ?? ((hint: string) => createOpenAIWorkPlanner({ baseUrlHint: hint }));
  let running = false;
  let axTransport: KwwkTransport | null = null;

  async function buildSurface(
    surfaceId: string,
  ): Promise<{ surface: WorkSurfacePort; hint: string }> {
    const app = options.axApp || process.env.MAB_LAN_OPERATOR_WORK_AX_APP || "Google Chrome";
    if (options.createSurface) return { surface: options.createSurface(surfaceId), hint: app };
    if (!axTransport) {
      const factory =
        options.createAxTransport ??
        (async () => {
          const { createKwwkStdioTransport } = await import("../work/work-ax-transport.ts");
          return createKwwkStdioTransport();
        });
      axTransport = await factory();
    }
    return { surface: createWorkAxSurface({ app, surfaceId, transport: axTransport }), hint: app };
  }

  async function run(command: string) {
    if (running) {
      options.onEvent({ type: "error", detail: { reason: "work_runtime_busy" } });
      return { status: "busy" };
    }
    running = true;
    try {
      const compilation = await compileWorkIntent(command);
      if (compilation.decision !== "job" || !compilation.job) {
        options.onEvent({ type: "not_a_command", detail: { command, reason: compilation.reason } });
        return { status: "not_a_command" };
      }
      const job = compilation.job;
      options.onEvent({
        type: "intent",
        detail: {
          command,
          backend: "ax",
          intent: job.intent,
          matchedBy: compilation.matchedBy,
          query: compilation.query,
          postConditions: job.postConditions,
          riskLevel: job.riskLevel,
        },
      });

      let surface: WorkSurfacePort;
      let hint: string;
      try {
        ({ surface, hint } = await buildSurface(job.surfaceId));
      } catch (error) {
        options.onEvent({
          type: "error",
          detail: {
            reason: "work_ax_backend_unavailable",
            hint: "kwwk-cu helper must build and have Accessibility permission",
            error: String(error instanceof Error ? error.message : error).slice(0, 200),
          },
        });
        return { status: "error" };
      }

      const executor = createWorkExecutor({
        surface,
        planner: createPlanner(hint),
        maxSteps: 10,
        onEvent: (event: WorkExecutorEvent) => {
          if (event.type === "operation" && event.operation) {
            options.onEvent({
              type: "step",
              detail: { step: event.step, operation: event.operation },
            });
          }
          if (event.type === "operation_result" && event.result && !event.result.ok) {
            options.onEvent({
              type: "step",
              detail: {
                step: event.step,
                failed: true,
                error: event.result.error || event.result.blocked,
              },
            });
          }
          if (event.type === "operation_result" && event.result?.cursor) {
            options.onEvent({ type: "cursor", detail: { ...event.result.cursor } });
          }
        },
      });
      const result = await executor.run(job);
      options.onEvent({
        type: "result",
        detail: {
          status: result.status,
          backend: "ax",
          steps: result.steps.length,
          totalMs: result.totalMs,
          postConditions: result.postConditions,
          extracted: result.extracted,
          summary: result.summary,
          blocker: result.blocker,
        },
      });
      return { status: result.status };
    } catch (error) {
      options.onEvent({
        type: "error",
        detail: { error: String(error instanceof Error ? error.message : error).slice(0, 300) },
      });
      return { status: "error" };
    } finally {
      running = false;
    }
  }

  async function close() {
    await axTransport?.close().catch(() => {});
    axTransport = null;
  }

  return { run, busy: () => running, close };
}
