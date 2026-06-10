import type { Browser, BrowserContext, CDPSession, Page } from "playwright";

import { createWorkBrowserSurface } from "../work/work-browser-surface.ts";
import { createWorkExecutor, type WorkExecutorEvent } from "../work/work-executor.ts";
import { startWorkFixtureServer, type WorkFixtureServer } from "../work/work-fixture-server.ts";
import { compileWorkIntent } from "../work/work-intent-compiler.ts";
import { createOpenAIWorkPlanner } from "../work/work-openai-planner.ts";

export interface LanOperatorWorkEvent {
  type: "intent" | "not_a_command" | "step" | "cursor" | "result" | "error";
  detail: Record<string, unknown>;
}

export interface LanOperatorWorkFrame {
  /** base64 JPEG of the work browser viewport. */
  dataBase64: string;
  width: number;
  height: number;
}

export interface LanOperatorWorkRuntimeOptions {
  /** Base URL of the work site. Defaults to a self-contained committed fixture server. */
  baseUrl?: string;
  allowedHosts?: string[];
  onEvent: (event: LanOperatorWorkEvent) => void;
  onFrame: (frame: LanOperatorWorkFrame) => void;
}

export interface LanOperatorWorkRuntime {
  run(command: string): Promise<{ status: string }>;
  busy(): boolean;
  close(): Promise<void>;
}

/**
 * Server-side runner that exposes the work pipeline to the operator web
 * surface: it owns a headless Playwright "work browser" (the bot's working
 * surface), screencasts it to the UI, and narrates each planner step. By
 * default it serves the committed fixture site so web-UI acceptance is
 * self-contained and deterministic (RFC D8); point baseUrl elsewhere for a
 * live demo.
 */
export function createLanOperatorWorkRuntime(
  options: LanOperatorWorkRuntimeOptions,
): LanOperatorWorkRuntime {
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  let cdp: CDPSession | null = null;
  let fixture: WorkFixtureServer | null = null;
  let baseUrl = options.baseUrl || "";
  let running = false;
  let screencasting = false;

  async function ensureBrowser() {
    if (browser && page) return;
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
      if (screencasting) {
        options.onFrame({ dataBase64: frame.data, width: 1280, height: 720 });
      }
      void cdp?.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
    });
  }

  async function startScreencast() {
    if (!cdp) return;
    screencasting = true;
    await cdp
      .send("Page.startScreencast", {
        format: "jpeg",
        quality: 55,
        maxWidth: 1280,
        maxHeight: 720,
        everyNthFrame: 1,
      })
      .catch(() => {});
  }

  async function stopScreencast() {
    screencasting = false;
    await cdp?.send("Page.stopScreencast").catch(() => {});
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
        options.onEvent({
          type: "not_a_command",
          detail: { command, reason: compilation.reason },
        });
        return { status: "not_a_command" };
      }
      options.onEvent({
        type: "intent",
        detail: {
          command,
          intent: compilation.job.intent,
          matchedBy: compilation.matchedBy,
          query: compilation.query,
          postConditions: compilation.job.postConditions,
          riskLevel: compilation.job.riskLevel,
        },
      });

      try {
        await ensureBrowser();
      } catch (error) {
        options.onEvent({
          type: "error",
          detail: {
            reason: "work_browser_launch_failed",
            hint: "run `vp run setup:browsers` to install the Playwright browser",
            error: String(error instanceof Error ? error.message : error).slice(0, 200),
          },
        });
        return { status: "error" };
      }

      const surface = createWorkBrowserSurface({
        page: page as Page,
        surfaceId: compilation.job.surfaceId,
        allowedHosts: options.allowedHosts ?? [new URL(baseUrl).hostname, "localhost", "127.0.0.1"],
        onCursor: (cursor) => {
          options.onEvent({ type: "cursor", detail: { ...cursor } });
        },
      });
      await startScreencast();

      const executor = createWorkExecutor({
        surface,
        planner: createOpenAIWorkPlanner({ baseUrlHint: baseUrl }),
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

      const result = await executor.run(compilation.job);
      await stopScreencast();
      options.onEvent({
        type: "result",
        detail: {
          status: result.status,
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
      await stopScreencast();
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
    await stopScreencast();
    await page?.close().catch(() => {});
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await fixture?.close().catch(() => {});
    browser = null;
    context = null;
    page = null;
    cdp = null;
    fixture = null;
  }

  return { run, busy: () => running, close };
}
