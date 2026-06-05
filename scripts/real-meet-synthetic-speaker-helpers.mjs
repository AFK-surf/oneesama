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

export function realMeetUIInteractionJoinFields(defaultLane = "macos_real_meet_humanized") {
  const explicitMode = String(
    process.env.MAB_MEET_UI_INTERACTION_MODE ||
      process.env.MEET_UI_INTERACTION_MODE ||
      process.env.MAB_UI_INTERACTION_MODE ||
      "",
  ).trim();
  const mode = explicitMode || (process.platform === "darwin" ? "humanized" : "");
  if (!mode) return {};
  const lane = String(process.env.MAB_MEET_JOIN_LANE || "").trim() || defaultLane;
  return {
    meetUIInteractionMode: mode,
    meet_ui_interaction_mode: mode,
    meetJoinLane: lane,
    meet_join_lane: lane,
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
    "Share Chrome window. Share Chrome window. Share Chrome window.";
  process.env.MAB_REALTIME_SYNTHETIC_EXPECTED_TOOLS =
    process.env.MAB_REALTIME_SYNTHETIC_EXPECTED_TOOLS ||
    "list_shareable_windows,share_existing_app_window";
  process.env.MAB_REALTIME_SYNTHETIC_REQUIRE_TOOL =
    process.env.MAB_REALTIME_SYNTHETIC_REQUIRE_TOOL || "1";
  process.env.MAB_REALTIME_SYNTHETIC_SPEECH_START_DELAY_MS =
    process.env.MAB_REALTIME_SYNTHETIC_SPEECH_START_DELAY_MS || "30000";
  process.env.MAB_REALTIME_SYNTHETIC_SPEECH_LOOP =
    process.env.MAB_REALTIME_SYNTHETIC_SPEECH_LOOP || "1";
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

export function localFixtureSyntheticAudioSuiteCases() {
  return [
    {
      id: "gomoku_sync_build_and_play_en",
      category: "primary",
      description:
        "English spoken long task should delegate a real worker, build a synced Gomoku web app, and let the bot play with the user.",
      spokenText: "Synthetic audio carrier tone for Realtime input liveness.",
      carrierToneMs: 3000,
      text: "Codex build Gomoku web game with sync run locally play Gomoku with me Codex build Gomoku web game with sync",
      expectedToolNames: ["delegate_to_worker"],
      requiredToolNames: ["delegate_to_worker"],
      forbiddenToolNames: [
        "list_shareable_windows",
        "share_existing_app_window",
        "present_video_stage",
        "stop_video_stage",
        "kwwk_computer_use",
        "read_meet_chat",
        "send_meet_chat",
      ],
      requireTool: true,
      primaryAcceptance: true,
      requiresWorkerArtifact: true,
      requiresAppUrl: true,
      requiresTwoClientSync: true,
      requiresBotAndUserMoves: true,
      requiresBotMoveSource: true,
      requiresScreenshots: true,
      requiresEnglishOutput: true,
      forbiddenOutputTextPatterns: [
        "what’s on your mind",
        "what's on your mind",
        "nice to hear you",
      ],
      disableAutomaticResponse: true,
      allowToolOnlyResponse: true,
      dryRunLocalTools: false,
      speechLoop: true,
      speechStartDelayMs: 30000,
      timeoutMs: 240000,
      workerTimeoutMs: 600000,
    },
    {
      id: "gomoku_sync_build_and_play_zh_asr_probe",
      category: "asr-probe",
      description:
        "Chinese TTS/ASR probe for the same Gomoku build request; diagnostic until synthetic Chinese ASR is stable.",
      text: "帮我自动化实现一个 web 版本五子棋，要带同步。跑起来以后你和我一起下。",
      voice: "Tingting",
      expectedToolNames: ["delegate_to_worker"],
      requiredToolNames: ["delegate_to_worker"],
      forbiddenToolNames: ["share_existing_app_window", "kwwk_computer_use"],
      requireTool: true,
      primaryAcceptance: false,
      dryRunLocalTools: true,
      speechLoop: true,
      speechStartDelayMs: 30000,
    },
    {
      id: "share_chrome_window_en",
      category: "share",
      description: "English spoken request should share the Chrome app window.",
      text: "Please share the Chrome window. Please share the Chrome window now. Share Chrome window.",
      expectedToolNames: ["share_existing_app_window"],
      requiredToolNames: ["share_existing_app_window"],
      forbiddenToolNames: ["kwwk_computer_use", "delegate_to_worker"],
      speechLoop: true,
      speechStartDelayMs: 30000,
    },
    {
      id: "share_chrome_window_zh",
      category: "share",
      description: "Chinese spoken request should still route to app sharing.",
      text: "把 Chrome 浏览器窗口共享到会议里。把 Chrome 浏览器窗口共享到会议里。",
      voice: "Eddy (Chinese (China mainland))",
      expectedToolNames: ["share_existing_app_window"],
      requiredToolNames: ["share_existing_app_window"],
      forbiddenToolNames: ["kwwk_computer_use", "delegate_to_worker"],
      speechLoop: true,
      speechStartDelayMs: 30000,
    },
    {
      id: "switch_chrome_tab_en",
      category: "kwwk",
      description: "English spoken app-control request should route to KWWK CU.",
      text: "Use computer. Switch to the next Chrome tab. Use computer. Switch to the next Chrome tab.",
      expectedToolNames: ["kwwk_computer_use"],
      requiredToolNames: ["kwwk_computer_use"],
      forbiddenToolNames: ["share_existing_app_window", "delegate_to_worker"],
      speechLoop: true,
      speechStartDelayMs: 30000,
    },
    {
      id: "switch_chrome_tab_zh",
      category: "kwwk",
      description: "Chinese spoken tab-switch request should route to KWWK CU.",
      text: "操作 Chrome。切换到下一个 tab。操作 Chrome。切换到下一个 tab。",
      voice: "Eddy (Chinese (China mainland))",
      expectedToolNames: ["kwwk_computer_use"],
      requiredToolNames: ["kwwk_computer_use"],
      forbiddenToolNames: ["share_existing_app_window", "delegate_to_worker"],
      speechLoop: true,
      speechStartDelayMs: 30000,
    },
    {
      id: "read_meet_chat_en",
      category: "meet-tool",
      description: "English spoken chat-read request should use the Meet chat tool.",
      text: "Read the meeting chat. Read the meeting chat messages. What does the meeting chat say?",
      expectedToolNames: ["read_meet_chat"],
      requiredToolNames: ["read_meet_chat"],
      forbiddenToolNames: ["share_existing_app_window", "kwwk_computer_use", "delegate_to_worker"],
      speechLoop: true,
      speechStartDelayMs: 30000,
    },
    {
      id: "delegate_complex_work_en",
      category: "delegate",
      description: "Complex background work should delegate instead of using live CU.",
      text: "Use Codex for a background task. Investigate the repository and write a short report.",
      expectedToolNames: ["delegate_to_worker"],
      requiredToolNames: ["delegate_to_worker"],
      forbiddenToolNames: ["share_existing_app_window", "kwwk_computer_use"],
      dryRunLocalTools: true,
      speechLoop: true,
      speechStartDelayMs: 30000,
    },
    {
      id: "negative_status_no_cu_en",
      category: "negative",
      description:
        "Simple spoken status check should answer without app share, KWWK, or worker tools.",
      text: "Tell me if you can hear me. Tell me your current voice status.",
      expectedToolNames: [],
      requiredToolNames: [],
      forbiddenToolNames: [
        "share_existing_app_window",
        "list_shareable_windows",
        "kwwk_computer_use",
        "delegate_to_worker",
      ],
      requireTool: false,
      speechLoop: true,
      speechStartDelayMs: 30000,
    },
  ];
}

export function envForLocalFixtureSyntheticAudioSuiteCase(testCase) {
  const expectedToolNames = Array.isArray(testCase.expectedToolNames)
    ? testCase.expectedToolNames
    : [];
  const requireTool =
    testCase.requireTool !== false &&
    (expectedToolNames.length > 0 ||
      (Array.isArray(testCase.requiredToolNames) && testCase.requiredToolNames.length > 0));
  const env = {
    MAB_SYNTHETIC_SPEAKER_TEXT: testCase.spokenText || testCase.text || "",
    MAB_REALTIME_SYNTHETIC_EXPECTED_TOOLS: expectedToolNames.join(","),
    MAB_REALTIME_SYNTHETIC_REQUIRE_TOOL: requireTool ? "1" : "0",
    MAB_REALTIME_SYNTHETIC_SPEECH_START_DELAY_MS: String(testCase.speechStartDelayMs || 30000),
    MAB_REALTIME_SYNTHETIC_SPEECH_LOOP: testCase.speechLoop === false ? "" : "1",
    MAB_REALTIME_SYNTHETIC_DRY_RUN_LOCAL_TOOLS: testCase.dryRunLocalTools ? "1" : "",
    MAB_REALTIME_SYNTHETIC_TRANSCRIPT_TEXT: testCase.transcriptText || testCase.text || "",
    MAB_REALTIME_SYNTHETIC_DISABLE_AUTO_RESPONSE: testCase.disableAutomaticResponse ? "1" : "",
  };
  if (testCase.carrierToneMs) env.MAB_SYNTHETIC_SPEAKER_TONE_MS = String(testCase.carrierToneMs);
  if (testCase.voice) env.MAB_SYNTHETIC_SPEAKER_VOICE = testCase.voice;
  return env;
}

export function evaluateSyntheticAudioSuiteCase(summary, testCase) {
  const toolNames = Array.isArray(summary?.toolCalls?.all) ? summary.toolCalls.all : [];
  const requiredToolNames = Array.isArray(testCase.requiredToolNames)
    ? testCase.requiredToolNames
    : [];
  const expectedToolNames = Array.isArray(testCase.expectedToolNames)
    ? testCase.expectedToolNames
    : [];
  const forbiddenToolNames = Array.isArray(testCase.forbiddenToolNames)
    ? testCase.forbiddenToolNames
    : [];
  const forbiddenOutputTextPatterns = Array.isArray(testCase.forbiddenOutputTextPatterns)
    ? testCase.forbiddenOutputTextPatterns
    : [];
  const missingRequiredToolNames = requiredToolNames.filter((name) => !toolNames.includes(name));
  const forbiddenToolNamesCalled = forbiddenToolNames.filter((name) => toolNames.includes(name));
  const requiredToolsSatisfied =
    requiredToolNames.length === 0 || missingRequiredToolNames.length === 0;
  const expectedToolCalled =
    expectedToolNames.length === 0 || expectedToolNames.some((name) => toolNames.includes(name));
  const forbiddenToolsAbsent = forbiddenToolNamesCalled.length === 0;
  const noTextTurnFallback = !summary?.textTurnFallback;
  const gates = summary?.gates || {};
  const workerArtifact = summary?.workerArtifact || {};
  const syncProbe = summary?.syncProbe || {};
  const moveLog = Array.isArray(summary?.moveLog) ? summary.moveLog : [];
  const screenshots = Array.isArray(summary?.syncProbe?.screenshots)
    ? summary.syncProbe.screenshots
    : Array.isArray(summary?.screenshots)
      ? summary.screenshots
      : [];
  const outputTranscriptTail = Array.isArray(summary?.outputTranscriptTail)
    ? summary.outputTranscriptTail
    : [];
  const outputTexts = outputTranscriptTail.map((entry) => String(entry?.text || entry || ""));
  const appBuilt =
    testCase.requiresWorkerArtifact !== true ||
    workerArtifact.built === true ||
    (Array.isArray(workerArtifact.files) && workerArtifact.files.length > 0);
  const appUrlReachable =
    testCase.requiresAppUrl !== true ||
    (typeof workerArtifact.appUrl === "string" &&
      /^https?:\/\//i.test(workerArtifact.appUrl) &&
      workerArtifact.reachable === true);
  const twoClientSyncPass =
    testCase.requiresTwoClientSync !== true || syncProbe.twoClientSyncPass === true;
  const botMoveObserved =
    testCase.requiresBotAndUserMoves !== true ||
    moveLog.some((move) => String(move?.actor || "").toLowerCase() === "bot");
  const userMoveObserved =
    testCase.requiresBotAndUserMoves !== true ||
    moveLog.some((move) => String(move?.actor || "").toLowerCase() === "user");
  const botMoveSourceObserved =
    testCase.requiresBotMoveSource !== true ||
    syncProbe.botMoveSource === "app_bot_engine" ||
    moveLog.some(
      (move) =>
        String(move?.actor || "").toLowerCase() === "bot" &&
        /bot|engine|tool|controller/i.test(String(move?.source || "")),
    );
  const screenshotsObserved =
    testCase.requiresScreenshots !== true ||
    (screenshots.length >= 2 && screenshots.every((entry) => typeof entry === "string" && entry));
  const englishOutputOnly =
    testCase.requiresEnglishOutput !== true ||
    outputTexts.every((text) => !/[\u3400-\u9fff]/.test(text));
  const forbiddenOutputTextPatternsHit = forbiddenOutputTextPatterns.filter((pattern) =>
    outputTexts.some((text) => text.toLowerCase().includes(String(pattern || "").toLowerCase())),
  );
  const forbiddenOutputTextAbsent = forbiddenOutputTextPatternsHit.length === 0;
  const toolOnlyResponseAllowed =
    testCase.allowToolOnlyResponse === true && requiredToolsSatisfied && expectedToolCalled;
  const speechAndResponseObserved =
    gates.meetEnergyOk === true &&
    gates.speechStarted === true &&
    (gates.responseSeen === true || toolOnlyResponseAllowed);
  const outputOrToolObserved =
    requiredToolNames.length > 0 ? requiredToolsSatisfied : gates.outputRouted === true;
  const ok =
    summary?.ok === true &&
    summary?.acceptanceSatisfied === true &&
    speechAndResponseObserved &&
    outputOrToolObserved &&
    requiredToolsSatisfied &&
    expectedToolCalled &&
    forbiddenToolsAbsent &&
    noTextTurnFallback &&
    appBuilt &&
    appUrlReachable &&
    twoClientSyncPass &&
    botMoveObserved &&
    userMoveObserved &&
    botMoveSourceObserved &&
    screenshotsObserved &&
    englishOutputOnly &&
    forbiddenOutputTextAbsent;
  return {
    ok,
    speechAndResponseObserved,
    outputOrToolObserved,
    expectedToolCalled,
    requiredToolsSatisfied,
    forbiddenToolsAbsent,
    noTextTurnFallback,
    appBuilt,
    appUrlReachable,
    twoClientSyncPass,
    botMoveObserved,
    userMoveObserved,
    botMoveSourceObserved,
    screenshotsObserved,
    englishOutputOnly,
    forbiddenOutputTextAbsent,
    forbiddenOutputTextPatternsHit,
    workerArtifactRequired: testCase.requiresWorkerArtifact === true,
    appUrlRequired: testCase.requiresAppUrl === true,
    twoClientSyncRequired: testCase.requiresTwoClientSync === true,
    botAndUserMovesRequired: testCase.requiresBotAndUserMoves === true,
    botMoveSourceRequired: testCase.requiresBotMoveSource === true,
    screenshotsRequired: testCase.requiresScreenshots === true,
    englishOutputRequired: testCase.requiresEnglishOutput === true,
    missingRequiredToolNames,
    forbiddenToolNamesCalled,
    requiredToolNames,
    expectedToolNames,
    forbiddenToolNames,
    forbiddenOutputTextPatterns,
  };
}

export function compactSyntheticResult(result, { syntheticSpeakerText, expectedToolNames }) {
  const compact = result?.final?.compact || result?.last?.compact || {};
  const gates = result?.final?.gates || result?.last?.gates || {};
  const textTurnFallback =
    result?.textTurnFallback ||
    result?.final?.textTurnFallback ||
    result?.last?.textTurnFallback ||
    null;
  const syntheticTranscriptInjected =
    result?.syntheticTranscriptInjected ||
    result?.final?.syntheticTranscriptInjected ||
    result?.last?.syntheticTranscriptInjected ||
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
    workerToolCalls: compact.workerToolCalls || [],
    timelineTypes: compact.timelineTypes || [],
    directToolRoutes: compact.directToolRoutes || [],
    workerArtifact: compact.workerArtifact || result?.workerArtifact || null,
    syncProbe: compact.syncProbe || result?.syncProbe || null,
    moveLog: compact.moveLog || result?.moveLog || [],
    inputTranscriptTail: compact.inputTranscriptTail || [],
    outputTranscriptTail: compact.outputTranscriptTail || [],
    latestFunctionalTurn: compact.latestFunctionalTurn || null,
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
    syntheticTranscriptInjected,
    error: result?.error || "",
    failure: result?.failure || null,
    hostAdmission: result?.hostAdmission || null,
    mainBotProfile: result?.mainBotProfile || null,
    syntheticSpeakerProfile: result?.syntheticSpeakerProfile || null,
  };
}
