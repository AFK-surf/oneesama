import type { Browser, BrowserContext, CDPSession, Page } from "playwright";

import { createWorkAxSurface, type KwwkTransport } from "../work/work-ax-surface.ts";
import { createWorkBrowserSurface } from "../work/work-browser-surface.ts";
import { createWorkExecutor, type WorkExecutorEvent } from "../work/work-executor.ts";
import { startWorkFixtureServer, type WorkFixtureServer } from "../work/work-fixture-server.ts";
import { compileWorkIntent } from "../work/work-intent-compiler.ts";
import { createOpenAIWorkPlanner } from "../work/work-openai-planner.ts";
import type { WorkPlannerPort } from "../work/work-planner.ts";
import type { WorkSurfacePort } from "../work/work-surface.ts";

export type WorkBackendKind = "cdp" | "ax";

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
  /** Executor backend: cdp work browser (test/dev) or kwwk-cu native AX (production). */
  backend?: WorkBackendKind;
  /** CDP: base URL of the work site (defaults to the committed fixture server). */
  baseUrl?: string;
  allowedHosts?: string[];
  /** AX: target app kwwk-cu drives (workspace isolation). */
  axApp?: string;
  onEvent: (event: LanOperatorWorkEvent) => void;
  onFrame: (frame: LanOperatorWorkFrame) => void;
  /** Injectable for tests / alternate providers; default = OpenAI stepwise planner. */
  createPlanner?: (hint: string) => WorkPlannerPort;
  /** Injectable for tests; default spawns the persistent kwwk-cu --stdio helper. */
  createAxTransport?: () => Promise<KwwkTransport>;
}

export interface LanOperatorWorkRuntime {
  run(command: string): Promise<{ status: string }>;
  busy(): boolean;
  close(): Promise<void>;
}

/** A prepared executor surface plus its frame lifecycle for one backend. */
interface PreparedBackend {
  surface: WorkSurfacePort;
  plannerHint: string;
  startFrames(): Promise<void>;
  stopFrames(): Promise<void>;
}

function resolveBackend(options: LanOperatorWorkRuntimeOptions): WorkBackendKind {
  if (options.backend) return options.backend;
  const env = String(process.env.MAB_LAN_OPERATOR_WORK_BACKEND || "").trim();
  return env === "ax" ? "ax" : "cdp";
}

/**
 * Server-side runner that exposes the work pipeline to the operator web
 * surface. Backend-selectable (RFC AX2): the kwwk-cu native AX backend is the
 * production/real-screen executor; the CDP work browser remains the
 * deterministic test/dev backend until it is retired. The stepwise executor +
 * step narration are shared across backends.
 */
export function createLanOperatorWorkRuntime(
  options: LanOperatorWorkRuntimeOptions,
): LanOperatorWorkRuntime {
  const backend = resolveBackend(options);
  const createPlanner =
    options.createPlanner ?? ((hint: string) => createOpenAIWorkPlanner({ baseUrlHint: hint }));
  let running = false;

  // --- CDP backend state ---
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  let cdp: CDPSession | null = null;
  let fixture: WorkFixtureServer | null = null;
  let baseUrl = options.baseUrl || "";
  let screencasting = false;

  // --- AX backend state ---
  let axTransport: KwwkTransport | null = null;

  async function prepareCdp(surfaceId: string): Promise<PreparedBackend> {
    if (!browser || !page) {
      const { chromium } = await import("playwright");
      if (!baseUrl) {
        fixture = await startWorkFixtureServer(
          new URL("../../../../test/fixtures/work", import.meta.url).pathname,
        );
        baseUrl = fixture.url;
      }
      browser = await chromium.launch({ headless: true });
      context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      page = await context.newPage();
      cdp = await context.newCDPSession(page);
      cdp.on("Page.screencastFrame", (frame: { data: string; sessionId: number }) => {
        if (screencasting) options.onFrame({ dataBase64: frame.data, width: 1280, height: 720 });
        void cdp?.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
      });
    }
    const surface = createWorkBrowserSurface({
      page: page as Page,
      surfaceId,
      allowedHosts: options.allowedHosts ?? [new URL(baseUrl).hostname, "localhost", "127.0.0.1"],
      onCursor: (cursor) => options.onEvent({ type: "cursor", detail: { ...cursor } }),
    });
    return {
      surface,
      plannerHint: baseUrl,
      startFrames: async () => {
        screencasting = true;
        await cdp
          ?.send("Page.startScreencast", {
            format: "jpeg",
            quality: 55,
            maxWidth: 1280,
            maxHeight: 720,
            everyNthFrame: 1,
          })
          .catch(() => {});
      },
      stopFrames: async () => {
        screencasting = false;
        await cdp?.send("Page.stopScreencast").catch(() => {});
      },
    };
  }

  async function prepareAx(surfaceId: string): Promise<PreparedBackend> {
    const app = options.axApp || process.env.MAB_LAN_OPERATOR_WORK_AX_APP || "Google Chrome";
    if (!axTransport) {
      const factory =
        options.createAxTransport ??
        (async () => {
          const { createKwwkStdioTransport } = await import("../work/work-ax-transport.ts");
          return createKwwkStdioTransport();
        });
      axTransport = await factory();
    }
    const surface = createWorkAxSurface({ app, surfaceId, transport: axTransport });
    // Live screen-capture frames for the AX backend need Screen Recording TCC
    // and are wired separately (AX3); for now frames are not streamed.
    return { surface, plannerHint: app, startFrames: async () => {}, stopFrames: async () => {} };
  }

  async function run(command: string) {
    if (running) {
      options.onEvent({ type: "error", detail: { reason: "work_runtime_busy" } });
      return { status: "busy" };
    }
    running = true;
    let prepared: PreparedBackend | null = null;
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
          backend,
          intent: job.intent,
          matchedBy: compilation.matchedBy,
          query: compilation.query,
          postConditions: job.postConditions,
          riskLevel: job.riskLevel,
        },
      });

      try {
        prepared =
          backend === "ax" ? await prepareAx(job.surfaceId) : await prepareCdp(job.surfaceId);
      } catch (error) {
        options.onEvent({
          type: "error",
          detail: {
            reason: backend === "ax" ? "work_ax_backend_unavailable" : "work_browser_launch_failed",
            hint:
              backend === "ax"
                ? "kwwk-cu helper must build and have Accessibility permission"
                : "run `vp run setup:browsers` to install the Playwright browser",
            error: String(error instanceof Error ? error.message : error).slice(0, 200),
          },
        });
        return { status: "error" };
      }

      await prepared.startFrames();
      const executor = createWorkExecutor({
        surface: prepared.surface,
        planner: createPlanner(prepared.plannerHint),
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
        },
      });
      const result = await executor.run(job);
      await prepared.stopFrames();
      options.onEvent({
        type: "result",
        detail: {
          status: result.status,
          backend,
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
      await prepared?.stopFrames().catch(() => {});
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
    screencasting = false;
    await cdp?.send("Page.stopScreencast").catch(() => {});
    await page?.close().catch(() => {});
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await fixture?.close().catch(() => {});
    await axTransport?.close().catch(() => {});
    browser = null;
    context = null;
    page = null;
    cdp = null;
    fixture = null;
    axTransport = null;
  }

  return { run, busy: () => running, close };
}
