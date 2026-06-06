import type { DebugState } from "./lan-operator-debug-state.ts";

export type ReportArtifactAction = "copy" | "download" | "mark";

export function recordReportArtifactAction(
  debug: DebugState,
  action: ReportArtifactAction,
  input: { label?: string; note?: string } = {},
) {
  const ts = new Date().toISOString();
  debug.artifacts.lastReportAt = ts;
  debug.artifacts.lastReportAction = action;
  if (action === "copy") debug.artifacts.reportCopyCount += 1;
  if (action === "download") debug.artifacts.reportDownloadCount += 1;
  if (action === "mark") {
    debug.artifacts.interestingMarks = [
      ...debug.artifacts.interestingMarks,
      {
        ts,
        label: String(input.label || "interesting"),
        note: String(input.note || ""),
      },
    ].slice(-40);
  }
}

export function recordLargeArtifactLink(
  debug: DebugState,
  input: {
    label?: unknown;
    kind?: unknown;
    href?: unknown;
    bytes?: unknown;
    contentType?: unknown;
    reason?: unknown;
  },
) {
  const ts = new Date().toISOString();
  const bytes = Number(input.bytes);
  const artifact = {
    ts,
    label: String(input.label || "artifact"),
    kind: String(input.kind || "artifact"),
    href: String(input.href || ""),
    bytes: Number.isFinite(bytes) ? bytes : null,
    contentType: String(input.contentType || "") || null,
    reason: String(input.reason || "large_artifact"),
    policy: "linked_only" as const,
  };
  debug.artifacts.largeArtifacts = [...debug.artifacts.largeArtifacts, artifact]
    .filter((item) => item.href)
    .slice(-40);
  debug.artifacts.lastReportAt = ts;
  debug.artifacts.lastReportAction = "mark";
}

function bundleEntry(input: Record<string, unknown>) {
  const bytes = Number(input.bytes);
  const policy = String(input.policy || "generated");
  const normalizedPolicy = (
    policy === "linked_only" || policy === "inline_report" ? policy : "generated"
  ) as "linked_only" | "inline_report" | "generated";
  return {
    id: String(input.id || input.kind || "entry"),
    kind: String(input.kind || "artifact"),
    label: String(input.label || input.id || "artifact"),
    href: input.href ? String(input.href) : null,
    bytes: Number.isFinite(bytes) ? bytes : null,
    contentType: String(input.contentType || "") || null,
    policy: normalizedPolicy,
  };
}

export function recordDebugBundleManifest(debug: DebugState, input: Record<string, unknown>) {
  const source =
    input.bundle && typeof input.bundle === "object"
      ? (input.bundle as Record<string, unknown>)
      : input;
  const entries = Array.isArray(source.entries)
    ? source.entries
        .filter((entry): entry is Record<string, unknown> =>
          Boolean(entry && typeof entry === "object"),
        )
        .map(bundleEntry)
    : [];
  const ts = new Date().toISOString();
  const manifest = {
    ts: String(source.ts || ts),
    id: String(source.id || input.bundleId || `debug_bundle_${Date.now().toString(36)}`),
    label: String(source.label || input.label || "Local Operator Debug Bundle"),
    href: source.href ? String(source.href) : null,
    entryCount: entries.length,
    entries,
  };
  debug.artifacts.bundleCount += 1;
  debug.artifacts.bundles = [...debug.artifacts.bundles, manifest].slice(-12);
  debug.artifacts.lastReportAt = ts;
  debug.artifacts.lastReportAction = "bundle";
}
