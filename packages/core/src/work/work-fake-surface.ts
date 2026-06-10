import type { WorkJobPostCondition } from "./work-job.ts";
import type { WorkOperation } from "./work-operations.ts";
import type {
  WorkObservationRef,
  WorkOperationResult,
  WorkPostConditionResult,
  WorkSurfaceObservation,
  WorkSurfacePort,
} from "./work-surface.ts";

export interface WorkFakePage {
  url: string;
  title: string;
  refs: WorkObservationRef[];
  /** Body text for text_present / text_absent post-conditions. */
  text: string;
  /** Per-extract-ref text (ref id -> extracted passage). */
  extracts?: Record<string, string>;
}

export interface WorkFakeSurfaceOptions {
  surfaceId?: string;
  /**
   * Pages keyed by url. `navigate` and link `click` move between them; the
   * value of a navigate op or a link ref's `value`/name selects the next url.
   */
  pages: Record<string, WorkFakePage>;
  startUrl: string;
  /** Refs whose click navigates: ref id -> destination url. */
  links?: Record<string, string>;
  allowedHosts?: string[];
}

function hostnameOf(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/**
 * Deterministic in-memory `WorkSurfacePort` test double (RFC G3) — canned
 * pages + scripted navigation. NOT a browser and NOT a computer-use engine:
 * it exists so the executor/planner harness stays deterministic and
 * cross-platform without a real backend. Replaces the CDP fixture browser in
 * unit/replay gates.
 */
export function createWorkFakeSurface(options: WorkFakeSurfaceOptions): WorkSurfacePort {
  const surfaceId = options.surfaceId || "fake-surface";
  const allowedHosts = options.allowedHosts ?? ["localhost", "127.0.0.1"];
  const links = options.links ?? {};
  let currentUrl = options.startUrl;
  const fieldValues = new Map<string, string>();

  function page(): WorkFakePage {
    const p = options.pages[currentUrl];
    if (!p) throw new Error(`fake_surface_unknown_url:${currentUrl}`);
    return p;
  }

  function outlineFor(p: WorkFakePage): string {
    return p.refs
      .map((r) => {
        const value = fieldValues.get(r.ref) ?? r.value;
        return `- ${r.role} "${r.name}"${value ? ` value="${value}"` : ""} [ref=${r.ref}]`;
      })
      .join("\n");
  }

  function hostAllowed(url: string) {
    if (!url || url === "about:blank") return true;
    return allowedHosts.includes(hostnameOf(url));
  }

  async function observe(): Promise<WorkSurfaceObservation> {
    const p = page();
    return {
      schema: "oneesama.work_observation.v1",
      surfaceId,
      url: currentUrl,
      title: p.title,
      outline: outlineFor(p),
      refs: p.refs.map((r): WorkObservationRef => {
        const value = fieldValues.get(r.ref) ?? r.value;
        return value
          ? { ref: r.ref, role: r.role, name: r.name, value }
          : { ref: r.ref, role: r.role, name: r.name };
      }),
      truncated: false,
      capturedAt: "1970-01-01T00:00:00.000Z",
    };
  }

  async function perform(operation: WorkOperation): Promise<WorkOperationResult> {
    const ref = operation.target?.ref || "";
    const base: Omit<WorkOperationResult, "ok"> = { operation, durationMs: 0 };
    switch (operation.type) {
      case "navigate": {
        const url = String(operation.value || "");
        if (!hostAllowed(url))
          return { ...base, ok: false, blocked: "navigation_outside_allowed_hosts" };
        if (!options.pages[url]) return { ...base, ok: false, error: `unknown_url:${url}` };
        currentUrl = url;
        return { ...base, ok: true };
      }
      case "click": {
        const dest = links[ref];
        if (dest) {
          if (!hostAllowed(dest))
            return { ...base, ok: false, blocked: "navigation_outside_allowed_hosts" };
          currentUrl = dest;
        }
        return {
          ...base,
          ok: Boolean(page().refs.find((r) => r.ref === ref)) || Boolean(dest),
          cursor: { x: 0.5, y: 0.5 },
        };
      }
      case "type-text":
      case "set-value": {
        if (!page().refs.find((r) => r.ref === ref))
          return { ...base, ok: false, error: `unknown_ref:${ref}` };
        fieldValues.set(ref, String(operation.value || ""));
        return { ...base, ok: true, cursor: { x: 0.5, y: 0.5 } };
      }
      case "press-key":
      case "scroll":
      case "wait-for":
        return { ...base, ok: true };
      case "extract": {
        const extracted =
          page().extracts?.[ref] ?? page().refs.find((r) => r.ref === ref)?.name ?? "";
        return { ...base, ok: Boolean(extracted), extracted, cursor: { x: 0.5, y: 0.5 } };
      }
      case "get-app-state":
        return { ...base, ok: true, extracted: `${page().title} | ${currentUrl}` };
      case "done":
      case "blocked":
        return { ...base, ok: true };
      default:
        return { ...base, ok: false, error: `operation_unsupported:${String(operation.type)}` };
    }
  }

  async function checkPostCondition(
    condition: WorkJobPostCondition,
  ): Promise<WorkPostConditionResult> {
    const p = page();
    if (condition.kind === "url_includes") {
      return { condition, ok: currentUrl.includes(condition.value), detail: currentUrl };
    }
    if (condition.kind === "text_present" || condition.kind === "text_absent") {
      const present = p.text.toLowerCase().includes(condition.value.toLowerCase());
      const ok = condition.kind === "text_present" ? present : !present;
      return { condition, ok, detail: `text_${present ? "present" : "absent"}` };
    }
    return {
      condition,
      ok: outlineFor(p).toLowerCase().includes(condition.value.toLowerCase()),
      detail: "outline_match",
    };
  }

  return {
    id: surfaceId,
    kind: "native_ax",
    observe,
    perform,
    checkPostCondition,
    close: async () => {},
  };
}
