export function realMeetAudioInputGainFields() {
  const raw = process.env.MAB_REAL_MEET_AUDIO_INPUT_GAIN;
  if (!raw) return {};
  const gain = Number(raw);
  if (!Number.isFinite(gain) || gain <= 0) {
    throw new Error(`Invalid MAB_REAL_MEET_AUDIO_INPUT_GAIN: ${raw}`);
  }
  return {
    meetAudioInputGain: gain,
    meet_audio_input_gain: gain,
  };
}

export function jsonLine(prefix, payload) {
  console.log(`${prefix} ${JSON.stringify(payload)}`);
}

export function compactJsonForDiagnostics(value, depth = 0) {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (/^data:image\//i.test(value)) return `data:image/*;base64,<${value.length} chars>`;
    if (value.length > 700) return `${value.slice(0, 700)}...<${value.length} chars>`;
    return value;
  }
  if (depth >= 5) return "[truncated]";
  if (Array.isArray(value))
    return value.slice(0, 24).map((item) => compactJsonForDiagnostics(item, depth + 1));
  if (typeof value !== "object") return String(value);
  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = compactJsonForDiagnostics(entry, depth + 1);
  }
  return output;
}

export function applyLocalFixtureToolShareSmokeDefaults() {
  process.env.MAB_SYNTHETIC_SPEAKER_TEXT =
    process.env.MAB_SYNTHETIC_SPEAKER_TEXT ||
    "请分享 Chrome 浏览器窗口到会议里。请开始屏幕共享。请分享窗口。";
  process.env.MAB_REALTIME_SYNTHETIC_EXPECTED_TOOLS =
    process.env.MAB_REALTIME_SYNTHETIC_EXPECTED_TOOLS ||
    "list_shareable_windows,share_existing_app_window";
  process.env.MAB_REALTIME_SYNTHETIC_REQUIRE_TOOL =
    process.env.MAB_REALTIME_SYNTHETIC_REQUIRE_TOOL || "1";
  process.env.MAB_REALTIME_SYNTHETIC_SPEECH_START_DELAY_MS =
    process.env.MAB_REALTIME_SYNTHETIC_SPEECH_START_DELAY_MS || "30000";
}

export function localFixtureToolShareTextTurnInstructions(expectedToolNames) {
  return [
    "The local fixture audio path already produced a model response.",
    "Now call the matching screen-share tool for this request. Do not answer verbally before the tool call.",
    expectedToolNames.length > 0 ? `Expected tool names: ${expectedToolNames.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function compactSyntheticResult(result, { syntheticSpeakerText, expectedToolNames }) {
  const compact = result?.final?.compact || result?.last?.compact || {};
  const gates = result?.final?.gates || result?.last?.gates || {};
  const textTurnFallback =
    result?.textTurnFallback ||
    result?.final?.textTurnFallback ||
    result?.last?.textTurnFallback ||
    null;
  return {
    ok: result?.ok === true,
    acceptanceSatisfied:
      result?.acceptanceSatisfied === true &&
      !textTurnFallback &&
      (!result?.childExit || result.childExit.code === 0),
    sessionId: result?.sessionId || "",
    syntheticSpeakerText: result?.syntheticSpeakerText || syntheticSpeakerText,
    expectedToolNames: result?.expectedToolNames || expectedToolNames,
    gates,
    toolCalls: compact.toolCalls || null,
    checks: compact.feedback?.checks
      ? {
          modelTurnEvents: compact.feedback.checks.modelTurnEvents,
          meetToolCalls: compact.feedback.checks.meetToolCalls,
          workspaceToolCalls: compact.feedback.checks.workspaceToolCalls,
          workerToolCalls: compact.feedback.checks.workerToolCalls,
          appControlJobTotal: compact.feedback.checks.appControlJobTotal,
        }
      : null,
    textTurnFallback,
    error: result?.error || "",
  };
}
