import type { WorkJobPostCondition } from "./work-job.ts";
import type { WorkOperation } from "./work-operations.ts";
import type {
  WorkObservationRef,
  WorkOperationResult,
  WorkPostConditionResult,
  WorkSurfaceObservation,
  WorkSurfacePort,
} from "./work-surface.ts";

/**
 * Minimal request/response channel to the kwwk-cu helper. Injected so the
 * adapter is unit-testable with a fake transport; the default spawns the
 * persistent `--stdio` helper process.
 */
export interface KwwkTransport {
  request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

export interface WorkAxSurfaceOptions {
  /** Target app kwwk-cu drives (workspace isolation: the adapter only acts here). */
  app: string;
  transport: KwwkTransport;
  surfaceId?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/**
 * Pull the full formatted state text out of a kwwk.cu.action result
 * (metadata.actionTelemetry[0].target.coreOutputText[0]).
 */
export function kwwkStateText(result: Record<string, unknown>): string {
  const tel = (asRecord(result.metadata).actionTelemetry as unknown[]) || [];
  const target = asRecord(asRecord(tel[0]).target);
  const texts = (target.coreOutputText as unknown[]) || [];
  return typeof texts[0] === "string" ? (texts[0] as string) : "";
}

/**
 * Parse kwwk-cu's `<app_state>` formatted text into addressable refs. Each
 * element line is `<indent><index> <role> <name...> (modifiers)`; the leading
 * integer is the kwwk-cu element index used by click/type/etc.
 */
export function parseAxStateText(text: string): {
  refs: WorkObservationRef[];
  url: string;
  title: string;
} {
  const refs: WorkObservationRef[] = [];
  let url = "";
  let title = "";
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (!title) {
      const windowMatch = line.match(/^Window:\s*"([^"]+)"/u);
      if (windowMatch) title = windowMatch[1];
    }
    if (!url) {
      const urlMatch = line.match(/URL:\s*(\S+)/u);
      if (urlMatch) url = urlMatch[1];
    }
    const elementMatch = line.match(/^(\d+)\s+(.*)$/u);
    if (!elementMatch) continue;
    const ref = elementMatch[1];
    const rest = elementMatch[2].trim();
    if (!rest) continue;
    const roleMatch = rest.match(/^(\S+)/u);
    const role = roleMatch ? roleMatch[1] : "";
    // Strip trailing kwwk modifiers/annotations for a cleaner name.
    const name = rest
      .replace(/\s*\((?:settable|string|number|boolean)[^)]*\)/giu, "")
      .replace(/\s*Secondary Actions:.*$/iu, "")
      .replace(/\s*URL:\s*\S+/iu, "")
      .trim();
    refs.push({ ref, role, name: name || rest });
  }
  return { refs, url, title };
}

const VERB_MAP: Record<string, string> = {
  click: "click",
  "type-text": "type_text",
  "set-value": "set_value",
  "press-key": "press_key",
  scroll: "scroll",
  "get-app-state": "state",
};

function kwwkOperationFor(operation: WorkOperation): Record<string, unknown> | null {
  const kind = VERB_MAP[operation.type];
  if (!kind) return null;
  const op: Record<string, unknown> = { kind };
  const ref = operation.target?.ref;
  if (ref) op.elementIndex = Number(ref);
  if (operation.type === "type-text" || operation.type === "set-value") {
    op.text = operation.value || "";
    op.value = operation.value || "";
  }
  if (operation.type === "press-key") op.key = operation.value || "Return";
  if (operation.type === "scroll") op.direction = operation.value || "down";
  return op;
}

/**
 * kwwk-cu AX backend for `WorkSurfacePort` (RFC AX1b). observe() reads the
 * full formatted state (Chromium-activated for browsers); perform() drives
 * low-level primitives by AX element index (D-AX-1). The operator stepwise
 * planner + harness sit unchanged on top. Native-app + real-cursor backend.
 */
export function createWorkAxSurface(options: WorkAxSurfaceOptions): WorkSurfacePort {
  const app = options.app;
  const surfaceId = options.surfaceId || "kwwk-ax";
  const transport = options.transport;

  async function runState(): Promise<string> {
    const result = await transport.request("kwwk.cu.action", {
      operation: { kind: "state" },
      target: { app },
    });
    return kwwkStateText(result);
  }

  async function observe(): Promise<WorkSurfaceObservation> {
    const text = await runState();
    const parsed = parseAxStateText(text);
    return {
      schema: "oneesama.work_observation.v1",
      surfaceId,
      url: parsed.url,
      title: parsed.title || app,
      outline: text,
      refs: parsed.refs,
      truncated: false,
      capturedAt: new Date().toISOString(),
    };
  }

  async function perform(operation: WorkOperation): Promise<WorkOperationResult> {
    const startedAt = Date.now();
    const base = (extra: Partial<WorkOperationResult>): WorkOperationResult => ({
      ok: false,
      operation,
      durationMs: Date.now() - startedAt,
      ...extra,
    });

    // extract / wait-for are read-side: satisfy them from the live state,
    // not a kwwk action (kwwk-cu has no extract primitive).
    if (operation.type === "extract") {
      const parsed = parseAxStateText(await runState());
      const hit = parsed.refs.find((r) => r.ref === operation.target?.ref);
      return base({ ok: Boolean(hit), extracted: hit?.name || "", cursor: { x: 0.5, y: 0.5 } });
    }
    if (operation.type === "wait-for") {
      const text = await runState();
      return base({ ok: text.includes(String(operation.value || "")) });
    }
    if (operation.type === "navigate") {
      // The AX backend operates whatever the target app already shows; opening
      // a URL/app is out-of-band, not a kwwk primitive.
      return base({ blocked: "navigate_unsupported_on_ax_backend" });
    }
    if (operation.type === "done" || operation.type === "blocked") {
      return base({ ok: true });
    }

    const kwwkOp = kwwkOperationFor(operation);
    if (!kwwkOp) return base({ error: `operation_unsupported:${operation.type}` });
    const result = await transport.request("kwwk.cu.action", {
      operation: kwwkOp,
      target: { app },
    });
    const ok = result.ok === true || String(result.status || "") === "completed";
    const extracted =
      operation.type === "get-app-state" ? kwwkStateText(result).slice(0, 2000) : undefined;
    return base({
      ok,
      ...(ok ? {} : { blocked: String(result.blocker || ""), error: String(result.error || "") }),
      ...(extracted ? { extracted } : {}),
      cursor: { x: 0.5, y: 0.5 },
    });
  }

  async function checkPostCondition(
    condition: WorkJobPostCondition,
  ): Promise<WorkPostConditionResult> {
    const text = await runState();
    const parsed = parseAxStateText(text);
    if (condition.kind === "url_includes") {
      return { condition, ok: parsed.url.includes(condition.value), detail: parsed.url };
    }
    const haystack = text.toLowerCase();
    const present = haystack.includes(condition.value.toLowerCase());
    if (condition.kind === "text_present") return { condition, ok: present, detail: "state_text" };
    if (condition.kind === "text_absent") return { condition, ok: !present, detail: "state_text" };
    return { condition, ok: present, detail: "state_text" };
  }

  return {
    id: surfaceId,
    kind: "native_ax",
    observe,
    perform,
    checkPostCondition,
    close: () => transport.close(),
  };
}
