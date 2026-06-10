import type { Page } from "playwright";

import type { WorkJobPostCondition } from "./work-job.ts";
import type { WorkOperation } from "./work-operations.ts";
import type {
  WorkCursorPoint,
  WorkObservationRef,
  WorkOperationResult,
  WorkPostConditionResult,
  WorkSurfaceObservation,
  WorkSurfacePort,
} from "./work-surface.ts";

export interface WorkBrowserCursorEvent extends WorkCursorPoint {
  kind: "move" | "click" | "target";
  label: string;
}

export interface WorkBrowserSurfaceOptions {
  page: Page;
  surfaceId?: string;
  /**
   * Workspace isolation (RFC vision: the executor may only act inside its
   * work surface). Navigation and post-operation drift outside these hosts
   * is blocked in the executor, not the prompt.
   */
  allowedHosts?: string[];
  maxRefs?: number;
  navigationTimeoutMs?: number;
  onCursor?: (event: WorkBrowserCursorEvent) => void;
}

interface SnapshotPayload {
  outline: string;
  refs: WorkObservationRef[];
  truncated: boolean;
}

const SNAPSHOT_SCRIPT = (maxRefs: number) => `(() => {
  const maxRefs = ${maxRefs};
  for (const el of document.querySelectorAll("[data-work-ref]")) el.removeAttribute("data-work-ref");
  const lines = [];
  const refs = [];
  let counter = 0;
  let truncated = false;
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  };
  const nameOf = (el) => {
    const aria = el.getAttribute("aria-label") || "";
    const text = (el.innerText || el.value || el.placeholder || "").trim();
    return (aria || text).replace(/\\s+/g, " ").slice(0, 80);
  };
  const roleOf = (el) => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "submit" || type === "button") return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      return "textbox";
    }
    return "";
  };
  const walk = (root) => {
    for (const el of root.querySelectorAll("h1, h2, h3, p, li, a[href], button, input, select, textarea, [role]")) {
      if (!visible(el)) continue;
      const tag = el.tagName.toLowerCase();
      let role = roleOf(el);
      let name = nameOf(el);
      // Headings and leaf text blocks are ref'd too: family-A jobs extract /
      // highlight passages, so text must be a valid operation target.
      if (!role && (tag === "h1" || tag === "h2" || tag === "h3")) role = "heading";
      if (!role && (tag === "p" || tag === "li") && name && el.children.length === 0) {
        role = "text";
        name = name.slice(0, 160);
      }
      if (!role || !name) continue;
      if (counter >= maxRefs) { truncated = true; break; }
      counter += 1;
      const ref = "e" + counter;
      el.setAttribute("data-work-ref", ref);
      const value = "value" in el && typeof el.value === "string" ? el.value : undefined;
      refs.push({ ref, role, name, ...(value !== undefined ? { value } : {}) });
      lines.push("- " + role + " \\"" + name + "\\"" + (value ? " value=\\"" + value.slice(0, 40) + "\\"" : "") + " [ref=" + ref + "]");
    }
  };
  walk(document);
  return { outline: lines.join("\\n"), refs, truncated };
})()`;

function hostnameOf(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export function createWorkBrowserSurface(options: WorkBrowserSurfaceOptions): WorkSurfacePort {
  const page = options.page;
  const surfaceId = options.surfaceId || "work-browser";
  const allowedHosts = options.allowedHosts ?? ["localhost", "127.0.0.1"];
  const maxRefs = Math.max(10, Number(options.maxRefs || 120));
  const navigationTimeoutMs = Math.max(1000, Number(options.navigationTimeoutMs || 10_000));

  function hostAllowed(url: string) {
    if (!url || url === "about:blank") return true;
    const host = hostnameOf(url);
    return allowedHosts.some((allowed) => host === allowed);
  }

  async function emitCursor(ref: string, kind: WorkBrowserCursorEvent["kind"], label: string) {
    try {
      const box = await page.locator(`[data-work-ref="${ref}"]`).boundingBox({ timeout: 1000 });
      const viewport = page.viewportSize();
      if (!box || !viewport) return undefined;
      const point = {
        x: Math.min(1, Math.max(0, (box.x + box.width / 2) / viewport.width)),
        y: Math.min(1, Math.max(0, (box.y + box.height / 2) / viewport.height)),
      };
      options.onCursor?.({ ...point, kind, label });
      return point;
    } catch {
      return undefined;
    }
  }

  async function observe(): Promise<WorkSurfaceObservation> {
    const payload = (await page.evaluate(SNAPSHOT_SCRIPT(maxRefs))) as SnapshotPayload;
    return {
      schema: "oneesama.work_observation.v1",
      surfaceId,
      url: page.url(),
      title: await page.title().catch(() => ""),
      outline: payload.outline,
      refs: payload.refs,
      truncated: payload.truncated,
      capturedAt: new Date().toISOString(),
    };
  }

  async function performInner(operation: WorkOperation): Promise<Partial<WorkOperationResult>> {
    const ref = operation.target?.ref || "";
    const label = operation.rationale || operation.type;
    switch (operation.type) {
      case "navigate": {
        const url = String(operation.value || "");
        if (!hostAllowed(url)) return { ok: false, blocked: "navigation_outside_allowed_hosts" };
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: navigationTimeoutMs });
        return { ok: true };
      }
      case "click": {
        const cursor = await emitCursor(ref, "click", label);
        await page.locator(`[data-work-ref="${ref}"]`).click({ timeout: 3000 });
        await page.waitForLoadState("domcontentloaded", { timeout: 1500 }).catch(() => {});
        return { ok: true, cursor };
      }
      case "type-text":
      case "set-value": {
        const cursor = await emitCursor(ref, "move", label);
        await page.locator(`[data-work-ref="${ref}"]`).fill(String(operation.value || ""), {
          timeout: 3000,
        });
        return { ok: true, cursor };
      }
      case "press-key": {
        const key = String(operation.value || "Enter");
        if (ref) await page.locator(`[data-work-ref="${ref}"]`).press(key, { timeout: 3000 });
        else await page.keyboard.press(key);
        await page.waitForLoadState("domcontentloaded", { timeout: 1500 }).catch(() => {});
        return { ok: true };
      }
      case "scroll": {
        await page.mouse.wheel(0, operation.value === "up" ? -600 : 600);
        return { ok: true };
      }
      case "wait-for": {
        const text = String(operation.value || "");
        await page.waitForFunction(
          (needle) => document.body?.innerText?.includes(needle) === true,
          text,
          { timeout: 5000 },
        );
        return { ok: true };
      }
      case "extract": {
        const cursor = await emitCursor(ref, "target", label);
        const extracted = (
          await page.locator(`[data-work-ref="${ref}"]`).innerText({ timeout: 3000 })
        )
          .trim()
          .slice(0, 2000);
        return { ok: true, extracted, cursor };
      }
      case "get-app-state": {
        const title = await page.title().catch(() => "");
        return { ok: true, extracted: `${title} | ${page.url()}` };
      }
      case "done":
      case "blocked":
        return { ok: true };
      default:
        return { ok: false, error: `operation_unsupported:${String(operation.type)}` };
    }
  }

  async function perform(operation: WorkOperation): Promise<WorkOperationResult> {
    const startedAt = Date.now();
    try {
      const partial = await performInner(operation);
      // Workspace isolation: if an interaction navigated outside the allowed
      // hosts, step back and report it as blocked rather than continuing.
      if (partial.ok && !hostAllowed(page.url())) {
        await page.goBack({ timeout: navigationTimeoutMs }).catch(() => {});
        return {
          ok: false,
          operation,
          blocked: "left_allowed_hosts",
          durationMs: Date.now() - startedAt,
        };
      }
      return {
        ok: partial.ok === true,
        operation,
        ...(partial.error ? { error: partial.error } : {}),
        ...(partial.blocked ? { blocked: partial.blocked } : {}),
        ...(partial.extracted ? { extracted: partial.extracted } : {}),
        ...(partial.cursor ? { cursor: partial.cursor } : {}),
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        ok: false,
        operation,
        error: String(error instanceof Error ? error.message : error).slice(0, 300),
        durationMs: Date.now() - startedAt,
      };
    }
  }

  async function checkPostCondition(
    condition: WorkJobPostCondition,
  ): Promise<WorkPostConditionResult> {
    try {
      if (condition.kind === "url_includes") {
        const url = page.url();
        return { condition, ok: url.includes(condition.value), detail: url };
      }
      if (condition.kind === "text_present" || condition.kind === "text_absent") {
        const text = await page.evaluate(() => document.body?.innerText || "");
        const present = text.includes(condition.value);
        const ok = condition.kind === "text_present" ? present : !present;
        return { condition, ok, detail: `text_${present ? "present" : "absent"}` };
      }
      // element_present matches against the backend-agnostic observation
      // outline, so jobs never embed CSS/AX specifics.
      const observation = await observe();
      return {
        condition,
        ok: observation.outline.includes(condition.value),
        detail: "outline_match",
      };
    } catch (error) {
      return {
        condition,
        ok: false,
        detail: String(error instanceof Error ? error.message : error).slice(0, 200),
      };
    }
  }

  return {
    id: surfaceId,
    kind: "cdp_browser",
    observe,
    perform,
    checkPostCondition,
    close: async () => {
      await page.close().catch(() => {});
    },
  };
}
