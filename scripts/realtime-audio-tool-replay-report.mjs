function isGoogleMeetPageUrl(value) {
  return /^https:\/\/meet\.google\.com\//i.test(String(value || "").trim());
}

export function audioReplayRuntimeEvidenceProfile(runtime) {
  const normalized = String(runtime || "").toLowerCase();
  if (normalized === "sidecar-audio") {
    return {
      evidenceMode: "sidecar_audio_tool_replay",
      acceptanceGateScope: "sidecar_audio_tool_replay",
      toolExecutionMode: "dry_run_local_tools",
      realAppExecution: false,
      note: "This benchmark proves sidecar audio turn formation, transcript evidence, and matching tool telemetry. Local app/window tools run in dry-run mode; use the strict real-room app-control gate for real app execution evidence.",
    };
  }
  return {
    evidenceMode: `${normalized || "unknown"}_diagnostic_audio_replay`,
    acceptanceGateScope: "diagnostic_only",
    toolExecutionMode:
      normalized === "browser-transport" ? "dry_run_local_tools" : "no_local_tool_execution",
    realAppExecution: false,
    note: "Diagnostic audio replay modes isolate lower layers and are not RFC acceptance gates.",
  };
}

export function browserTransportRuntimeOptions(runtime) {
  const useSidecar = String(runtime || "") === "sidecar-audio";
  return {
    useSidecar,
    realtimeRuntimePlacement: useSidecar ? "sidecar" : "inline",
    realtimePageRole: useSidecar ? "sidecar" : "generic",
    allowInlineAgentsSDKDiagnostic: !useSidecar,
    diagnosticOnly: !useSidecar,
  };
}

export function validateAudioReplayRuntime(args) {
  const runtime = String(args?.runtime || "").trim();
  const browserPageUrl = String(args?.browserPageUrl || "").trim();
  if (!browserPageUrl || !isGoogleMeetPageUrl(browserPageUrl)) return;
  if (runtime === "sidecar-audio") return;
  throw new Error(
    "--browser-page-url https://meet.google.com/... requires --runtime sidecar-audio; non-sidecar audio runtimes are diagnostic-only and must not run inside real Meet pages",
  );
}

export function printAudioReplayReport(report) {
  console.log(
    `Realtime audio tool replay benchmark: runtime=${report.runtime} model=${report.model} segment=${report.startSec}s+${report.durationSec}s pcmBytes=${report.pcmBytes}`,
  );
  if (report.notAcceptanceGate) {
    console.log(`Runtime ${report.runtime} is diagnostic-only and is not an RFC acceptance gate.`);
  }
  if (report.browserPageUrl) console.log(`browserPageUrl=${report.browserPageUrl}`);
  for (const variant of report.variants) {
    const { row } = variant;
    const expected = row.expectedToolNames.join("/");
    const fake = row.fakeExecution ? " fakeExecution=true" : "";
    const errors = row.errors.length
      ? ` errors=${row.errors.map((error) => error.message).join(" | ")}`
      : "";
    console.log(
      `\n${row.ok ? "PASS" : "FAIL"} ${variant.name}: calls=[${row.calls.join(",") || "none"}] want=${expected} reason=${row.reason}${fake}${errors}`,
    );
    console.log(`  transcript=${JSON.stringify(row.transcript)}`);
    if (row.assistantText) console.log(`  assistantText=${JSON.stringify(row.assistantText)}`);
    if (row.browserBridgeRuntime)
      console.log(`  browserBridgeRuntime=${JSON.stringify(row.browserBridgeRuntime)}`);
    console.log(`  events=${JSON.stringify(row.eventTypes)}`);
  }
}
