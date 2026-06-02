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
  expectedTools: string[];
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
    optionValue("--wait-newer-than") || process.env.MAB_MEET_ACCEPTANCE_WAIT_NEWER_THAN || "";
  const waitTimeoutMs = Number(
    optionValue("--wait-timeout-ms") || process.env.MAB_MEET_ACCEPTANCE_WAIT_TIMEOUT_MS || 0,
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
  const forbidden = [...defaultForbidden, ...forbidValues].map(
    (pattern) => new RegExp(pattern, "i"),
  );
  const expectedInput = process.argv
    .filter((arg) => arg.startsWith("--expect-input="))
    .map((arg) => new RegExp(arg.slice("--expect-input=".length), "i"));
  const expectedOutput = process.argv
    .filter((arg) => arg.startsWith("--expect-output="))
    .map((arg) => new RegExp(arg.slice("--expect-output=".length), "i"));
  const expectedTools = [
    ...String(process.env.MAB_MEET_ACCEPTANCE_EXPECT_TOOLS || "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
    ...process.argv
      .filter((arg) => arg.startsWith("--expect-tool="))
      .flatMap((arg) => arg.slice("--expect-tool=".length).split(","))
      .map((entry) => entry.trim())
      .filter(Boolean),
  ];
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
    expectedTools,
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

function inputText(realtime: any): string {
  const transcriptInput = ((realtime?.transcripts?.input || []) as Array<{ text?: string }>)
    .map((entry) => String(entry.text || ""))
    .filter(Boolean);
  const inboundInput = ((realtime?.inboundTail || []) as Array<any>)
    .map((entry) => {
      const event = entry?.event || entry?.detail || entry || {};
      const type = String(event.type || "");
      if (
        type !== "conversation.item.input_audio_transcription.delta" &&
        type !== "conversation.item.input_audio_transcription.completed"
      ) {
        return "";
      }
      return String(event.transcript || event.delta || event.text || "");
    })
    .filter(Boolean);
  const historyInput = ((realtime?.contextHealth?.lastHistoryTail || []) as Array<any>)
    .filter((entry) => entry.role === "user")
    .map((entry) => String(entry.text || ""))
    .filter(Boolean);
  const latestFunctionalUserText = String(
    realtime?.contextHealth?.latestFunctionalTurn?.userText ||
      realtime?.feedback?.checks?.latestFunctionalTurn?.userText ||
      "",
  );
  return [...transcriptInput, ...inboundInput, ...historyInput, latestFunctionalUserText]
    .filter(Boolean)
    .join("\n");
}

function toolNameFromEntry(entry: any): string {
  return String(entry?.name || entry?.toolName || entry?.tool_name || entry?.item?.name || "");
}

function toolNamesFromRealtime(realtime: any): string[] {
  const explicitToolCalls = [
    ...((realtime?.meetTools?.calls || []) as any[]),
    ...((realtime?.workspaceTools?.calls || []) as any[]),
    ...((realtime?.workerTools?.calls || []) as any[]),
    ...((realtime?.avatarTools?.calls || []) as any[]),
  ].map(toolNameFromEntry);
  const historyToolCalls = ((realtime?.contextHealth?.lastHistoryTail || []) as any[])
    .filter((entry) => String(entry.type || entry.itemType || "") === "function_call")
    .map(toolNameFromEntry);
  const latestFunctionalToolNames = [
    ...((realtime?.contextHealth?.latestFunctionalTurn?.toolNames || []) as string[]),
    ...((realtime?.feedback?.checks?.latestFunctionalTurn?.toolNames || []) as string[]),
  ];
  return [...new Set([...explicitToolCalls, ...historyToolCalls, ...latestFunctionalToolNames])]
    .map((name) => String(name || ""))
    .filter(Boolean);
}

function appControlRecordsFromRealtime(realtime: any): any[] {
  const calls = [
    ...((realtime?.meetTools?.calls || []) as any[]),
    ...((realtime?.workspaceTools?.calls || []) as any[]),
    ...((realtime?.workerTools?.calls || []) as any[]),
    ...((realtime?.avatarTools?.calls || []) as any[]),
  ].filter((entry) =>
    ["kwwk_computer_use", "control_shared_app_window"].includes(toolNameFromEntry(entry)),
  );
  const jobs = Object.values(realtime?.turnPolicy?.appControlJobs || {}).filter(
    (entry) => entry && typeof entry === "object",
  );
  const workerResults = ((realtime?.workerResults || []) as any[]).filter((entry) => {
    const kind = String(entry?.kind || entry?.type || entry?.source || "");
    return (
      kind.includes("app_control") ||
      ["kwwk_computer_use", "control_shared_app_window"].includes(String(entry?.toolName || ""))
    );
  });
  return [...calls, ...jobs, ...workerResults];
}

function normalizeAppControlStatus(value: unknown): string {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function appControlRecordStatus(record: any): string {
  const result = record?.result && typeof record.result === "object" ? record.result : {};
  const nested = result?.result && typeof result.result === "object" ? result.result : {};
  const job = result?.job && typeof result.job === "object" ? result.job : {};
  const report =
    result?.report && typeof result.report === "object"
      ? result.report
      : record?.report && typeof record.report === "object"
        ? record.report
        : {};
  return normalizeAppControlStatus(
    firstString(record?.status, result?.status, nested?.status, job?.status, report?.status),
  );
}

function appControlRecordOk(record: any): boolean {
  const result = record?.result && typeof record.result === "object" ? record.result : {};
  const nested = result?.result && typeof result.result === "object" ? result.result : {};
  const report =
    result?.report && typeof result.report === "object"
      ? result.report
      : record?.report && typeof record.report === "object"
        ? record.report
        : {};
  return record?.ok === true || result?.ok === true || nested?.ok === true || report?.ok === true;
}

function appControlRecordBlocker(record: any): string {
  const result = record?.result && typeof record.result === "object" ? record.result : {};
  const nested = result?.result && typeof result.result === "object" ? result.result : {};
  const job = result?.job && typeof result.job === "object" ? result.job : {};
  const report =
    result?.report && typeof result.report === "object"
      ? result.report
      : record?.report && typeof record.report === "object"
        ? record.report
        : {};
  return firstString(
    record?.blocker,
    result?.blocker,
    nested?.blocker,
    job?.blocker,
    report?.blocker,
  );
}

function appControlStatusIsSuccess(status: string): boolean {
  return ["completed", "done", "success", "succeeded"].includes(normalizeAppControlStatus(status));
}

function appControlStatusHasCompactBlocker(status: string, blocker: string, ok: boolean): boolean {
  const normalized = normalizeAppControlStatus(status);
  const normalizedBlocker = blocker.trim().toLowerCase();
  return (
    ["blocked", "failed"].includes(normalized) &&
    ok !== true &&
    Boolean(blocker.trim()) &&
    blocker.trim().length <= 240 &&
    !["app_control_timeout", "timeout", "stale"].includes(normalizedBlocker)
  );
}

function appControlTerminalFlow(realtime: any) {
  const feedback = realtime?.feedback || {};
  const records = appControlRecordsFromRealtime(realtime);
  const terminalRecords = records.map((record) => {
    const status = appControlRecordStatus(record);
    const blocker = appControlRecordBlocker(record);
    return {
      status,
      ok: appControlRecordOk(record),
      blocker,
      success: appControlStatusIsSuccess(status) && appControlRecordOk(record),
      compactBlocker: appControlStatusHasCompactBlocker(
        status,
        blocker,
        appControlRecordOk(record),
      ),
    };
  });
  const toolTurnsReason = String(feedback?.failureMatrix?.toolTurns?.reason || "");
  const feedbackBlockers = (feedback?.blockers || []) as string[];
  const feedbackReasons = [toolTurnsReason, ...feedbackBlockers.map((blocker) => String(blocker))];
  const blockedByFeedback = feedbackReasons.includes("app_control_job_blocked");
  const pendingOrStaleFeedback = feedbackReasons.some((reason) =>
    ["app_control_job_pending", "app_control_job_stale"].includes(reason),
  );
  const pendingOrStaleRecord = terminalRecords.some((record) =>
    ["accepted", "queued", "running", "started", "pending", "stale", "timeout"].includes(
      record.status,
    ),
  );
  const success = terminalRecords.some((record) => record.success);
  const compactBlocker = terminalRecords.some((record) => record.compactBlocker);
  const unresolvedJob = pendingOrStaleFeedback || pendingOrStaleRecord;
  const blockedWithoutCompactBlocker = blockedByFeedback && !compactBlocker;
  return {
    ok: (success || compactBlocker) && !unresolvedJob && !blockedWithoutCompactBlocker,
    success,
    compactBlocker,
    blockedByFeedback,
    blockedWithoutCompactBlocker,
    pendingOrStaleFeedback,
    pendingOrStaleRecord,
    unresolvedJob,
    toolTurnsReason,
    feedbackBlockers,
    records: terminalRecords,
  };
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

export async function waitForNewerDiagnostics(
  options: Pick<AcceptanceOptions, "diagnosticsDir" | "waitNewerThan" | "waitTimeoutMs" | "pollMs">,
) {
  const thresholdMs = await diagnosticsThresholdMs(options.waitNewerThan, options.diagnosticsDir);
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

const LIVE_REALTIME_INPUT_SOURCES = ["recappi_process_audio_tap"];

function acceptedRealtimeInputSource(value: unknown): boolean {
  return LIVE_REALTIME_INPUT_SOURCES.includes(String(value || ""));
}

function realtimeInputFlow(connection: any) {
  const source = String(connection?.currentRealtimeInputSource || "");
  if (source === "host_meet_audio_pcm") {
    const host = connection?.hostMeetAudioInput || {};
    const diagnosticFlowing =
      host.connected === true &&
      Number(host.chunks || 0) > 0 &&
      (Number(host.samplesReceived || 0) > 0 || Number(host.samplesQueued || 0) > 0);
    return {
      ok: false,
      source,
      acceptedRealtimeInputSources: LIVE_REALTIME_INPUT_SOURCES,
      diagnosticFlowing,
      reason: "host_meet_audio_pcm_is_diagnostic_only",
      connected: host.connected,
      chunks: host.chunks,
      samplesReceived: host.samplesReceived,
      samplesQueued: host.samplesQueued,
    };
  }
  if (source === "meet_audio_mix") {
    const energy = connection?.meetAudioEnergy || {};
    const diagnosticFlowing = Number(energy.rms || energy.lastRms || energy.maxRms || 0) > 0;
    return {
      ok: false,
      source,
      acceptedRealtimeInputSources: LIVE_REALTIME_INPUT_SOURCES,
      diagnosticFlowing,
      reason: "meet_audio_mix_is_diagnostic_only",
      rms: energy.rms,
      lastRms: energy.lastRms,
      maxRms: energy.maxRms,
      silenceMs: energy.silenceMs,
    };
  }
  const recappi = connection?.recappiAudioInput || {};
  return {
    ok:
      source === "recappi_process_audio_tap" &&
      recappi.connected === true &&
      Number(recappi.chunks || 0) > 0 &&
      Number(recappi.samplesReceived || 0) > 0,
    source,
    acceptedRealtimeInputSources: LIVE_REALTIME_INPUT_SOURCES,
    connected: recappi.connected,
    chunks: recappi.chunks,
    samplesReceived: recappi.samplesReceived,
    samplesDropped: recappi.samplesDropped,
  };
}

function meetRealtimeSurface(runtimeEvent: RuntimeEvent | null) {
  return runtimeEvent?.detail?.meetPage?.realtimeSurface || {};
}

function avatarAudioOutputFlow(runtimeEvent: RuntimeEvent | null, realtime: any) {
  const connection = realtime?.connection || {};
  const avatarAudio = runtimeEvent?.detail?.avatarAudio || {};
  const outputEnergy = avatarAudio?.outputEnergy || {};
  const senderStats = connection?.primaryMeetAudioSenderStats || {};
  const outputObserved =
    ((realtime?.transcripts?.output || []) as unknown[]).length > 0 ||
    connection.remoteAudioRoutedToAvatarBus === true ||
    outputEnergy.observed === true ||
    Number(avatarAudio?.routedPcmChunks || 0) > 0 ||
    Number(avatarAudio?.routedBuffers || 0) > 0 ||
    Number(avatarAudio?.routedStreams || 0) > 0;
  const usingAvatarBus =
    connection.primaryMeetAudioSenderUsingAvatarBus === true || senderStats.usingAvatarBus === true;
  const senderBytesDelta = Number(senderStats.bytesDelta || 0);
  const senderPacketsDelta = Number(senderStats.packetsDelta || 0);
  const senderFresh = senderBytesDelta > 0 || senderPacketsDelta > 0;
  return {
    required: outputObserved,
    ok:
      !outputObserved ||
      (connection.remoteAudioRoutedToAvatarBus === true &&
        usingAvatarBus &&
        senderStats.trackReadyState === "live" &&
        Number(senderStats.bytesSent || 0) > 0 &&
        senderFresh),
    remoteAudioRoutedToAvatarBus: connection.remoteAudioRoutedToAvatarBus === true,
    primaryMeetAudioSenderUsingAvatarBus: usingAvatarBus,
    trackReadyState: senderStats.trackReadyState || "",
    bytesSent: Number(senderStats.bytesSent || 0),
    bytesDelta: senderBytesDelta,
    packetsSent: Number(senderStats.packetsSent || 0),
    packetsDelta: senderPacketsDelta,
    senderFresh,
    outputEnergyObserved: outputEnergy.observed === true,
    outputEnergyMaxRms: Number(outputEnergy.maxRms || 0),
    routedPcmChunks: Number(avatarAudio?.routedPcmChunks || 0),
    routedPcmSamples: Number(avatarAudio?.routedPcmSamples || 0),
  };
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
  const inputFlow = realtimeInputFlow(connection);
  const meetSurface = meetRealtimeSurface(runtimeEvent);
  const outputFlow = avatarAudioOutputFlow(runtimeEvent, realtime);
  const counts = summarizeCounts(realtime);

  addCheck(checks, "diagnostics_has_runtime_state", Boolean(runtimeEvent), {
    runtimeStateRefreshCount: events.filter((event) => event.type === "runtime_state_refresh")
      .length,
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
  addCheck(
    checks,
    "sidecar_sdk_owner",
    realtime?.realtimeRuntimePlacement === "sidecar" &&
      realtime?.realtimePageRole === "sidecar" &&
      realtime?.sdkOwner === "sidecar",
    {
      realtimeRuntimePlacement: realtime?.realtimeRuntimePlacement || "",
      realtimePageRole: realtime?.realtimePageRole || "",
      sdkOwner: realtime?.sdkOwner || "",
    },
  );
  addCheck(
    checks,
    "meet_surface_has_no_agents_sdk",
    meetSurface.runtimePlacement === "sidecar" &&
      meetSurface.pageRole === "meet-surface" &&
      meetSurface.sdkOwner === "sidecar" &&
      meetSurface.sdkSuppressedOnMeetSurface === true &&
      meetSurface.hasSDKGlobal === false &&
      !meetSurface.bundleGlobal,
    {
      realtimeSurface: meetSurface,
    },
  );
  addCheck(
    checks,
    "live_realtime_input_source",
    acceptedRealtimeInputSource(connection.currentRealtimeInputSource),
    {
      currentRealtimeInputSource: connection.currentRealtimeInputSource,
      lastRealtimeInputReplaceReason: connection.lastRealtimeInputReplaceReason,
      acceptedRealtimeInputSources: LIVE_REALTIME_INPUT_SOURCES,
    },
  );
  addCheck(checks, "live_realtime_input_flowing", inputFlow.ok, inputFlow);
  addCheck(checks, "meet_fake_mic_sender_live", outputFlow.ok, outputFlow);
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
  addCheck(
    checks,
    "captions_not_injected_as_input",
    counts.captionTurnsInjected === 0 && counts.blockedUserTextEvents === 0,
    counts,
  );
  addCheck(
    checks,
    "outputs_have_raw_audio_turns",
    counts.outputTurns === 0 || counts.rawAudioInputTurns > 0,
    counts,
  );
  addCheck(
    checks,
    "one_response_per_raw_audio_turn",
    counts.outputTurns <= counts.rawAudioInputTurns,
    counts,
  );
  addCheck(checks, "no_client_transcript_gate_responses", counts.responsesRequested === 0, counts);
  const latestFunctionalTurn =
    feedback.checks?.latestFunctionalTurn || realtime?.contextHealth?.latestFunctionalTurn || null;
  const functionalToolFakeExecution =
    feedback.checks?.latestFunctionalTurnFakeExecution === true ||
    latestFunctionalTurn?.fakeExecution === true ||
    feedback.failureMatrix?.toolTurns?.reason === "assistant_text_without_expected_functional_tool";
  addCheck(checks, "no_functional_tool_fake_execution", !functionalToolFakeExecution, {
    latestFunctionalTurn,
    latestFunctionalTurnFakeExecution: feedback.checks?.latestFunctionalTurnFakeExecution,
    toolTurnsReason: feedback.failureMatrix?.toolTurns?.reason || "",
  });
  if (options.requireSilenceMs > 0) {
    const silenceMs = Number(connection.meetAudioEnergy?.silenceMs || 0);
    addCheck(checks, "required_silence_window_observed", silenceMs >= options.requireSilenceMs, {
      silenceMs,
      requiredSilenceMs: options.requireSilenceMs,
    });
  }
  const joinedInput = inputText(realtime);
  const inputMissing = options.expectedInput
    .map((regex) => ({ pattern: regex.source, matched: regex.test(joinedInput) }))
    .filter((entry) => !entry.matched);
  if (options.expectedInput.length > 0) {
    addCheck(checks, "expected_input_text_observed", inputMissing.length === 0, {
      missing: inputMissing,
      inputChars: joinedInput.length,
      latestFunctionalTurn,
    });
  }
  const expectedTools = options.expectedTools || [];
  if (expectedTools.length > 0) {
    const toolNames = toolNamesFromRealtime(realtime);
    const matched = expectedTools.some((name) => toolNames.includes(name));
    addCheck(checks, "expected_realtime_tool_called", matched, {
      expectedTools,
      toolNames,
      latestFunctionalTurn,
      inputMatched: inputMissing.length === 0,
    });
    if (
      expectedTools.some((name) =>
        ["kwwk_computer_use", "control_shared_app_window"].includes(name),
      )
    ) {
      const appControlFlow = appControlTerminalFlow(realtime);
      addCheck(
        checks,
        "expected_app_control_terminal_result",
        matched && appControlFlow.ok,
        appControlFlow,
      );
    }
  }
  const joinedOutput = outputText(realtime);
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
  const waitedDiagnosticsPath = options.waitNewerThan ? await waitForNewerDiagnostics(options) : "";
  const requestedDiagnosticsPath = waitedDiagnosticsPath
    ? options.diagnosticsPath || "latest"
    : options.diagnosticsPath;
  const diagnosticsPath =
    waitedDiagnosticsPath && requestedDiagnosticsPath === "latest"
      ? waitedDiagnosticsPath
      : await resolveDiagnosticsPath(requestedDiagnosticsPath, options.diagnosticsDir);
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
