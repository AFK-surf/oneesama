import { readdir, readFile, stat } from "node:fs/promises";
import { join as pathJoin } from "node:path";
import { assertSmoke } from "./common.js";

interface CheckResult {
  name: string;
  ok: boolean;
  detail?: unknown;
}

interface RuntimeEvent {
  ts?: string;
  type?: string;
  detail?: Record<string, any>;
}

interface AcceptanceOptions {
  diagnosticsPath: string;
  previousDiagnosticsPath: string;
  diagnosticsDir: string;
  requireSilenceMs: number;
  waitNewerThan: string;
  waitTimeoutMs: number;
  pollMs: number;
  forbidden: RegExp[];
  expectedInput: RegExp[];
  expectedOutput: RegExp[];
}

function optionValue(name: string): string {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : "";
}

function parseOptions(): AcceptanceOptions {
  const diagnosticsPath =
    optionValue("--diagnostics") ||
    process.argv[3] ||
    process.env.MAB_MEET_ACCEPTANCE_DIAGNOSTICS ||
    "";
  const previousDiagnosticsPath =
    optionValue("--previous-diagnostics") ||
    process.env.MAB_MEET_ACCEPTANCE_PREVIOUS_DIAGNOSTICS ||
    "";
  const diagnosticsDir =
    optionValue("--diagnostics-dir") ||
    process.env.MAB_MEET_ACCEPTANCE_DIAGNOSTICS_DIR ||
    "/tmp/meeting-avatar-bot";
  const requireSilenceMs = Number(
    optionValue("--require-silence-ms") || process.env.MAB_MEET_ACCEPTANCE_SILENCE_MS || 0,
  );
  const waitNewerThan =
    optionValue("--wait-newer-than") ||
    process.env.MAB_MEET_ACCEPTANCE_WAIT_NEWER_THAN ||
    "";
  const waitTimeoutMs = Number(
    optionValue("--wait-timeout-ms") ||
      process.env.MAB_MEET_ACCEPTANCE_WAIT_TIMEOUT_MS ||
      0,
  );
  const pollMs = Number(
    optionValue("--poll-ms") || process.env.MAB_MEET_ACCEPTANCE_POLL_MS || 1000,
  );
  const forbidValues = process.argv
    .filter((arg) => arg.startsWith("--forbid="))
    .map((arg) => arg.slice("--forbid=".length))
    .filter(Boolean);
  const useDefaultForbidden = !process.argv.includes("--no-default-forbid");
  const defaultForbidden = useDefaultForbidden
    ? ["assignment", "sky[- ]?blue", "why.*sky.*blue", "天空.*蓝", "瑞利散射", "\\bmath\\b"]
    : [];
  const forbidden = [...defaultForbidden, ...forbidValues].map((pattern) => new RegExp(pattern, "i"));
  const expectedInput = process.argv
    .filter((arg) => arg.startsWith("--expect-input="))
    .map((arg) => new RegExp(arg.slice("--expect-input=".length), "i"));
  const expectedOutput = process.argv
    .filter((arg) => arg.startsWith("--expect-output="))
    .map((arg) => new RegExp(arg.slice("--expect-output=".length), "i"));
  return {
    diagnosticsPath,
    previousDiagnosticsPath,
    diagnosticsDir,
    requireSilenceMs,
    waitNewerThan,
    waitTimeoutMs,
    pollMs,
    forbidden,
    expectedInput,
    expectedOutput,
  };
}

function latestRuntimeEvent(events: RuntimeEvent[]) {
  return events.findLast((event) => event.type === "runtime_state_refresh") || null;
}

function outputText(realtime: any): string {
  return ((realtime?.transcripts?.output || []) as Array<{ text?: string }>)
    .map((entry) => String(entry.text || ""))
    .join("\n");
}

function addCheck(checks: CheckResult[], name: string, ok: boolean, detail?: unknown) {
  checks.push({ name, ok, detail });
}

async function listDiagnosticsFiles(dir: string) {
  const entries = await readdir(dir);
  const files = await Promise.all(
    entries
      .filter((entry) => entry.endsWith("-diagnostics.json"))
      .map(async (entry) => {
        const path = pathJoin(dir, entry);
        const info = await stat(path);
        return { path, mtimeMs: info.mtimeMs };
      }),
  );
  return files.toSorted((a, b) => b.mtimeMs - a.mtimeMs);
}

export async function resolveDiagnosticsPath(
  requestedPath: string,
  diagnosticsDir = "/tmp/meeting-avatar-bot",
  currentPath = "",
) {
  if (!["latest", "previous"].includes(requestedPath)) return requestedPath;
  const files = await listDiagnosticsFiles(diagnosticsDir);
  const candidates = currentPath ? files.filter((file) => file.path !== currentPath) : files;
  const index = requestedPath === "previous" && !currentPath ? 1 : 0;
  return candidates[index]?.path || "";
}

async function diagnosticsThresholdMs(requestedPath: string, diagnosticsDir: string) {
  const numeric = Number(requestedPath);
  if (Number.isFinite(numeric) && requestedPath.trim() !== "") return numeric;
  const path = await resolveDiagnosticsPath(requestedPath, diagnosticsDir);
  assertSmoke(Boolean(path), `No diagnostics artifact found for ${requestedPath}`);
  return (await stat(path)).mtimeMs;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForNewerDiagnostics(options: Pick<
  AcceptanceOptions,
  "diagnosticsDir" | "waitNewerThan" | "waitTimeoutMs" | "pollMs"
>) {
  const thresholdMs = await diagnosticsThresholdMs(
    options.waitNewerThan,
    options.diagnosticsDir,
  );
  const deadline = Date.now() + Math.max(0, options.waitTimeoutMs || 0);
  const pollMs = Math.max(50, options.pollMs || 1000);
  do {
    const newest = (await listDiagnosticsFiles(options.diagnosticsDir))[0];
    if (newest && newest.mtimeMs > thresholdMs) return newest.path;
    if (Date.now() >= deadline) break;
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  } while (Date.now() <= deadline);
  assertSmoke(false, "Timed out waiting for a newer diagnostics artifact", {
    diagnosticsDir: options.diagnosticsDir,
    waitNewerThan: options.waitNewerThan,
    waitTimeoutMs: options.waitTimeoutMs,
  });
}

function uniqueTurnCount(entries: Array<Record<string, unknown>>, idFields: string[]) {
  const ids = entries
    .map((entry) => idFields.map((field) => String(entry[field] || "")).find(Boolean) || "")
    .filter(Boolean);
  return ids.length > 0 ? new Set(ids).size : entries.length;
}

function realtimeEventType(entry: any): string {
  return String(entry?.event?.type || entry?.detail?.type || entry?.type || "");
}

function rawAudioInputTurns(realtime: any): number {
  const entries = [
    ...((realtime?.inboundTail || []) as unknown[]),
    ...((realtime?.timelineTail || []) as unknown[]),
  ];
  return entries.filter((entry) => realtimeEventType(entry) === "input_audio_buffer.committed")
    .length;
}

function summarizeCounts(realtime: any) {
  const output = (realtime?.transcripts?.output || []) as Array<Record<string, unknown>>;
  const connection = realtime?.connection || {};
  return {
    outputTranscripts: output.length,
    outputTurns: uniqueTurnCount(output, ["responseId", "response_id", "itemId", "item_id"]),
    rawAudioInputTurns: rawAudioInputTurns(realtime),
    responsesRequested: Number(realtime?.responsesRequested || 0),
    captionTurnsObserved: Number(connection.captionTurnsObserved || 0),
    captionTurnsInjected: Number(connection.captionTurnsInjected || 0),
    blockedUserTextEvents: Number(connection.blockedUserTextEvents || 0),
  };
}

function openaiSessionId(diagnostics: any): string {
  const events = (diagnostics?.events || []) as RuntimeEvent[];
  const realtime = latestRuntimeEvent(events)?.detail?.realtime || null;
  return String(realtime?.connection?.openaiSessionId || "");
}

export function buildChecks(
  diagnostics: any,
  options: AcceptanceOptions,
  previousDiagnostics: any = null,
) {
  const checks: CheckResult[] = [];
  const events = (diagnostics?.events || []) as RuntimeEvent[];
  const runtimeEvent = latestRuntimeEvent(events);
  const realtime = runtimeEvent?.detail?.realtime || null;
  const connection = realtime?.connection || {};
  const feedback = realtime?.feedback || {};
  const recappi = connection.recappiAudioInput || {};
  const counts = summarizeCounts(realtime);

  addCheck(checks, "diagnostics_has_runtime_state", Boolean(runtimeEvent), {
    runtimeStateRefreshCount: events.filter((event) => event.type === "runtime_state_refresh").length,
  });
  addCheck(checks, "realtime_transport_ready", Boolean(realtime?.connected), {
    connected: realtime?.connected,
    feedbackStatus: feedback.status,
    blockers: feedback.blockers || [],
  });
  addCheck(checks, "data_channel_open", connection.dataChannelOpen === true, {
    dataChannelOpen: connection.dataChannelOpen,
    peerConnectionState: connection.peerConnectionState,
  });
  addCheck(checks, "recappi_process_tap_is_input", connection.currentRealtimeInputSource === "recappi_process_audio_tap", {
    currentRealtimeInputSource: connection.currentRealtimeInputSource,
    lastRealtimeInputReplaceReason: connection.lastRealtimeInputReplaceReason,
  });
  addCheck(checks, "recappi_audio_flowing", recappi.connected === true && Number(recappi.chunks || 0) > 0, {
    connected: recappi.connected,
    chunks: recappi.chunks,
    samplesReceived: recappi.samplesReceived,
  });
  addCheck(checks, "gate_and_self_suppression_observed", Number(recappi.noiseSuppressedChunks || 0) > 0 && Number(recappi.selfOutputSuppressedChunks || 0) > 0, {
    noiseSuppressedChunks: recappi.noiseSuppressedChunks,
    selfOutputSuppressedChunks: recappi.selfOutputSuppressedChunks,
  });
  addCheck(checks, "openai_session_id_recorded", Boolean(connection.openaiSessionId), {
    openaiSessionId: connection.openaiSessionId || "",
  });
  if (previousDiagnostics) {
    const currentOpenaiSessionId = String(connection.openaiSessionId || "");
    const previousOpenaiSessionId = openaiSessionId(previousDiagnostics);
    addCheck(
      checks,
      "openai_session_id_is_fresh",
      Boolean(currentOpenaiSessionId) &&
        Boolean(previousOpenaiSessionId) &&
        currentOpenaiSessionId !== previousOpenaiSessionId,
      {
        currentOpenaiSessionId,
        previousOpenaiSessionId,
      },
    );
  }
  addCheck(checks, "captions_not_injected_as_input", counts.captionTurnsInjected === 0 && counts.blockedUserTextEvents === 0, counts);
  addCheck(checks, "outputs_have_raw_audio_turns", counts.outputTurns === 0 || counts.rawAudioInputTurns > 0, counts);
  addCheck(checks, "one_response_per_raw_audio_turn", counts.outputTurns <= counts.rawAudioInputTurns, counts);
  addCheck(
    checks,
    "no_client_transcript_gate_responses",
    counts.responsesRequested === 0,
    counts,
  );
  if (options.requireSilenceMs > 0) {
    const silenceMs = Number(connection.meetAudioEnergy?.silenceMs || 0);
    addCheck(checks, "required_silence_window_observed", silenceMs >= options.requireSilenceMs, {
      silenceMs,
      requiredSilenceMs: options.requireSilenceMs,
    });
  }
  const joinedOutput = outputText(realtime);
  if (options.expectedInput.length > 0) {
    addCheck(checks, "expected_input_text_not_supported", false, {
      reason: "Realtime live acceptance validates raw audio turns, not transcript text.",
      patterns: options.expectedInput.map((regex) => regex.source),
    });
  }
  if (options.expectedOutput.length > 0) {
    const missing = options.expectedOutput
      .map((regex) => ({ pattern: regex.source, matched: regex.test(joinedOutput) }))
      .filter((entry) => !entry.matched);
    addCheck(checks, "expected_output_topics_observed", missing.length === 0, {
      missing,
      outputChars: joinedOutput.length,
    });
  }
  const forbiddenMatches = options.forbidden
    .map((regex) => ({ pattern: regex.source, matched: regex.test(joinedOutput) }))
    .filter((entry) => entry.matched);
  addCheck(checks, "no_forbidden_old_topics_in_output", forbiddenMatches.length === 0, {
    forbiddenMatches,
    outputChars: joinedOutput.length,
  });
  addCheck(checks, "no_realtime_errors", (realtime?.errors || []).length === 0, {
    errors: realtime?.errors || [],
  });
  return { runtimeEvent, realtime, counts, checks };
}

export async function meetLiveAcceptance() {
  const options = parseOptions();
  const waitedDiagnosticsPath = options.waitNewerThan
    ? await waitForNewerDiagnostics(options)
    : "";
  const requestedDiagnosticsPath = waitedDiagnosticsPath
    ? options.diagnosticsPath || "latest"
    : options.diagnosticsPath;
  const diagnosticsPath = waitedDiagnosticsPath && requestedDiagnosticsPath === "latest"
    ? waitedDiagnosticsPath
    : await resolveDiagnosticsPath(
        requestedDiagnosticsPath,
        options.diagnosticsDir,
      );
  const previousDiagnosticsPath = options.previousDiagnosticsPath
    ? await resolveDiagnosticsPath(
        options.previousDiagnosticsPath,
        options.diagnosticsDir,
        diagnosticsPath,
      )
    : "";
  assertSmoke(
    Boolean(diagnosticsPath),
    "meet-live-acceptance requires --diagnostics=<path> or MAB_MEET_ACCEPTANCE_DIAGNOSTICS",
  );
  const diagnostics = JSON.parse(await readFile(diagnosticsPath, "utf8"));
  const previousDiagnostics = previousDiagnosticsPath
    ? JSON.parse(await readFile(previousDiagnosticsPath, "utf8"))
    : null;
  const result = buildChecks(diagnostics, options, previousDiagnostics);
  const failures = result.checks.filter((check) => !check.ok);
  const report = {
    ok: failures.length === 0,
    diagnosticsPath,
    previousDiagnosticsPath,
    sessionId: diagnostics.sessionId || "",
    latestRuntimeStateAt: result.runtimeEvent?.ts || "",
    counts: result.counts,
    checks: result.checks,
    failures,
  };
  if (!report.ok) console.error(JSON.stringify(report, null, 2));
  assertSmoke(report.ok, "Meet live acceptance failed", report);
  console.log(JSON.stringify(report, null, 2));
}
