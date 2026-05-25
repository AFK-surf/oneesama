export function getRuntimeConfig(env = process.env) {
  const splitList = (value = "") =>
    String(value || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  const openaiBaseUrl = (
    env.MAB_OPENAI_BASE_URL ||
    env.OPENAI_BASE_URL ||
    "https://api.openai.com/v1"
  ).replace(/\/+$/, "");
  return {
    openaiApiKey: env.MAB_OPENAI_API_KEY || env.OPENAI_API_KEY || "",
    openaiBaseUrl,
    openaiRealtimeClientSecretsUrl:
      env.MAB_OPENAI_REALTIME_CLIENT_SECRETS_URL || `${openaiBaseUrl}/realtime/client_secrets`,
    openaiRealtimeSdpUrl: env.MAB_OPENAI_REALTIME_SDP_URL || `${openaiBaseUrl}/realtime/calls`,
    openaiRealtimeModel:
      env.MAB_OPENAI_REALTIME_MODEL || env.OPENAI_REALTIME_MODEL || "gpt-realtime-2",
    openaiRealtimeReasoningEffort: env.MAB_OPENAI_REALTIME_REASONING_EFFORT || "high",
    openaiRealtimeVoice: env.MAB_OPENAI_REALTIME_VOICE || "marin",
    openaiRealtimeTurnDetection: env.MAB_OPENAI_REALTIME_TURN_DETECTION || "semantic_vad",
    openaiRealtimeSessionSchema: env.MAB_OPENAI_REALTIME_SESSION_SCHEMA || "realtime-2",
    openaiRealtimeAgentRuntime: env.MAB_OPENAI_REALTIME_AGENT_RUNTIME || "agents-sdk",
    realtimePersonalityContext: env.MAB_REALTIME_PERSONALITY_CONTEXT || "",
    internalAuthKey: env.MAB_INTERNAL_AUTH_KEY || env.ONEESAMA_INTERNAL_AUTH_KEY || "",
    slackBotToken: env.SLACK_BOT_TOKEN || "",
    slackAppToken: env.SLACK_APP_TOKEN || "",
    slackSigningSecret: env.SLACK_SIGNING_SECRET || "",
    slackClientId: env.SLACK_CLIENT_ID || "",
    slackClientSecret: env.SLACK_CLIENT_SECRET || "",
    slackRedirectUri: env.SLACK_REDIRECT_URI || "",
    slackAppManifestPath: env.MAB_SLACK_APP_MANIFEST_PATH || "",
    slackSocketMode: (env.MAB_SLACK_SOCKET_MODE || "") === "1",
    slackEventBuffer: (env.MAB_SLACK_EVENT_BUFFER || "1") !== "0",
    slackEventDebounceMs: Number.parseInt(env.MAB_SLACK_EVENT_DEBOUNCE_MS || "300000", 10),
    slackEventMaxBatch: Number.parseInt(env.MAB_SLACK_EVENT_MAX_BATCH || "20", 10),
    slackEventAllowBotMessages: (env.MAB_SLACK_EVENT_ALLOW_BOT_MESSAGES || "") === "1",
    slackEventTriage: (env.MAB_SLACK_EVENT_TRIAGE || "") === "1",
    slackTriagePostActions: (env.MAB_SLACK_TRIAGE_POST_ACTIONS || "1") !== "0",
    slackTriageHeuristicFallback: (env.MAB_SLACK_TRIAGE_HEURISTIC_FALLBACK || "1") !== "0",
    slackApiMock: (env.MAB_SLACK_API_MOCK || "") === "1",
    slackPosterMock: (env.MAB_SLACK_POSTER_MOCK || "") === "1",
    slackMemoryEnabled: (env.MAB_SLACK_MEMORY_ENABLED || "") === "1",
    slackMemoryDir:
      env.MAB_SLACK_MEMORY_DIR ||
      `${env.MAB_DATA_DIR || "/tmp/meeting-avatar-bot-data"}/slack-memory`,
    assistantScheduleDefinitionsPath: env.MAB_ASSISTANT_SCHEDULE_DEFINITIONS_PATH || "",
    slackDomainStoreEnabled: (env.MAB_SLACK_DOMAIN_STORE || "1") !== "0",
    slackDomainDbPath:
      env.MAB_SLACK_DOMAIN_DB_PATH ||
      `${env.MAB_DATA_DIR || "/tmp/meeting-avatar-bot-data"}/slack-agent-domain.sqlite3`,
    legacySlackWorkspaceDir: env.MAB_LEGACY_SLACK_WORKSPACE_DIR || "",
    legacySlackAgentDb: env.MAB_LEGACY_SLACK_AGENT_DB || "",
    cutoverMode: env.MAB_CUTOVER_MODE || "new",
    cutoverCanaryPercent: Number.parseFloat(env.MAB_CUTOVER_CANARY_PERCENT || "0"),
    cutoverAutoRollbackOnFailure: (env.MAB_CUTOVER_AUTO_ROLLBACK_ON_FAILURE || "") === "1",
    cutoverReportPath: env.MAB_CUTOVER_REPORT_PATH || "",
    shadowTapSecret: env.MAB_SHADOW_TAP_SECRET || "",
    shadowTapReportPath: env.MAB_SHADOW_TAP_REPORT_PATH || "",
    stateProvider: env.MAB_STATE_PROVIDER || "json-file",
    stateSqlitePath: env.MAB_STATE_SQLITE_PATH || "",
    slackPort: Number.parseInt(env.MAB_SLACK_PORT || "8780", 10),
    meetingPort: Number.parseInt(env.MAB_MEETING_PORT || "8781", 10),
    publicBaseUrl: env.MAB_PUBLIC_BASE_URL || "http://127.0.0.1:8780",
    meetingAgentUrl:
      env.MAB_MEETING_AGENT_URL || `http://127.0.0.1:${env.MAB_MEETING_PORT || "8781"}`,
    dataDir: env.MAB_DATA_DIR || "/tmp/meeting-avatar-bot-data",
    agentRunner: env.MAB_AGENT_RUNNER || "dry-run",
    dryRunAgent: (env.MAB_DRY_RUN_AGENT || "") === "1",
    dryRunCodex: (env.MAB_DRY_RUN_CODEX || "") === "1",
    agentCommand: env.MAB_AGENT_COMMAND || "",
    agentHttpUrl: env.MAB_AGENT_HTTP_URL || "",
    agentRunnerTimeoutMs: Number.parseInt(env.MAB_AGENT_RUNNER_TIMEOUT_MS || "120000", 10),
    agentRunnerOutputMaxBytes: Number.parseInt(
      env.MAB_AGENT_RUNNER_OUTPUT_MAX_BYTES || "262144",
      10,
    ),
    codexBin: env.MAB_CODEX_BIN || "codex",
    codexModel: env.MAB_CODEX_MODEL || "gpt-5.5",
    codexModelProvider: env.MAB_CODEX_MODEL_PROVIDER || "",
    codexBaseUrl: (env.MAB_CODEX_BASE_URL || "").replace(/\/+$/, ""),
    codexEnvKey: env.MAB_CODEX_ENV_KEY || "",
    codexWireApi: env.MAB_CODEX_WIRE_API || "",
    codexSandbox: env.MAB_CODEX_SANDBOX || "",
    codexRunnerMode: env.MAB_CODEX_RUNNER_MODE || "exec",
    codexAppServerUrl: env.MAB_CODEX_APP_SERVER_URL || "",
    codexAppServerPort: Number.parseInt(env.MAB_CODEX_APP_SERVER_PORT || "18765", 10),
    codexAppServerSessionsPath:
      env.MAB_CODEX_APP_SERVER_SESSIONS_PATH ||
      `${env.MAB_DATA_DIR || "/tmp/meeting-avatar-bot-data"}/codex-app-server-sessions.json`,
    codexAppServerWorkspaceRoot:
      env.MAB_CODEX_APP_SERVER_WORKSPACE_ROOT ||
      `${env.MAB_DATA_DIR || "/tmp/meeting-avatar-bot-data"}/codex-app-server-workspaces`,
    codexHome: env.MAB_CODEX_HOME || env.CODEX_HOME || "",
    claudeBin: env.MAB_CLAUDE_BIN || "claude",
    claudeModel: env.MAB_CLAUDE_MODEL || "sonnet",
    claudeReadPermissionMode: env.MAB_CLAUDE_READ_PERMISSION_MODE || "dontAsk",
    claudeWritePermissionMode: env.MAB_CLAUDE_WRITE_PERMISSION_MODE || "acceptEdits",
    claudeMaxBudgetUsd: env.MAB_CLAUDE_MAX_BUDGET_USD || "",
    ollamaBaseUrl: (env.MAB_OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/+$/, ""),
    ollamaModel: env.MAB_OLLAMA_MODEL || "llama3.2",
    slackAgentDUrl: env.MAB_SLACK_AGENT_D_URL || "",
    slackAgentDToken: env.MAB_SLACK_AGENT_D_TOKEN || "",
    slackAgentDTimeoutMs: Number.parseInt(env.MAB_SLACK_AGENT_D_TIMEOUT_MS || "120000", 10),
    slackAgentDPollIntervalMs: Number.parseInt(
      env.MAB_SLACK_AGENT_D_POLL_INTERVAL_MS || "1000",
      10,
    ),
    sttProvider: env.MAB_STT_PROVIDER || "event",
    ttsProvider: env.MAB_TTS_PROVIDER || "tone-wav",
    ttsVoice: env.MAB_TTS_VOICE || "default",
    ttsCommand: env.MAB_TTS_COMMAND || "",
    ttsHttpUrl: env.MAB_TTS_HTTP_URL || "",
    meetingArtifactsDir:
      env.MAB_MEETING_ARTIFACTS_DIR ||
      `${env.MAB_DATA_DIR || "/tmp/meeting-avatar-bot-data"}/meeting-artifacts`,
    digestWebhookUrl: env.MAB_DIGEST_WEBHOOK_URL || "",
    digestWebhookSecret: env.MAB_DIGEST_WEBHOOK_SECRET || "",
    digestWebhookMaxAttempts: Number.parseInt(env.MAB_DIGEST_WEBHOOK_MAX_ATTEMPTS || "5", 10),
    digestWebhookRetryDelayMs: Number.parseInt(env.MAB_DIGEST_WEBHOOK_RETRY_DELAY_MS || "1000", 10),
    meetAudioBackend: env.MAB_MEET_AUDIO_BACKEND || env.MEET_AUDIO_BACKEND || "auto",
    recordMeeting: (env.MAB_RECORD_MEETING || "") === "1",
    captureCaptions: (env.MAB_CAPTURE_CAPTIONS || env.MAB_ENABLE_CAPTIONS || "") === "1",
    captionLanguage: env.MAB_CAPTION_LANGUAGE || "",
    asrProvider: env.MAB_ASR_PROVIDER || "caption",
    asrCommand: env.MAB_ASR_COMMAND || "",
    asrHttpUrl: env.MAB_ASR_HTTP_URL || "",
    asrModel: env.MAB_ASR_MODEL || "gpt-4o-mini-transcribe",
    openaiAudioTranscriptionsUrl:
      env.MAB_OPENAI_AUDIO_TRANSCRIPTIONS_URL || `${openaiBaseUrl}/audio/transcriptions`,
    asrLanguage: env.MAB_ASR_LANGUAGE || "auto",
    canvasPublisher: env.MAB_CANVAS_PUBLISHER || "file",
    canvasDir: env.MAB_CANVAS_DIR || `${env.MAB_DATA_DIR || "/tmp/meeting-avatar-bot-data"}/canvas`,
    canvasSlackChannel: env.MAB_CANVAS_SLACK_CHANNEL || "",
    canvasSlackThreadTs: env.MAB_CANVAS_SLACK_THREAD_TS || "",
    botName: env.MAB_BOT_NAME || "Meeting Avatar Bot",
    currentUserName: env.MAB_CURRENT_USER_NAME || env.KNOWN_USER || "",
    currentUserEnglishName: env.MAB_CURRENT_USER_ENGLISH_NAME || "",
    currentUserEmail: env.MAB_CURRENT_USER_EMAIL || "",
    workspaceEmailDomain: env.MAB_WORKSPACE_EMAIL_DOMAIN || "",
    currentUserLinear: env.MAB_CURRENT_USER_LINEAR || "",
    currentUserGithub: env.MAB_CURRENT_USER_GITHUB || "",
    currentUserRole: env.MAB_CURRENT_USER_ROLE || "",
    currentUserAliases: splitList(
      env.MAB_CURRENT_USER_ALIASES || env.ONEESAMA_CURRENT_USER_ALIASES,
    ),
    browserHeadless: (env.MAB_BROWSER_HEADLESS || "false") === "true",
    screenshotDir: env.MAB_SCREENSHOT_DIR || "/tmp/meeting-avatar-bot",
    playwrightModulePath: env.MAB_PLAYWRIGHT_MODULE || "",
    chromiumExecutablePath: env.MAB_CHROMIUM_EXECUTABLE || "",
    chromiumExtraArgs: env.MAB_CHROMIUM_EXTRA_ARGS || "",
    browserUserDataDir: env.MAB_BROWSER_USER_DATA_DIR || "",
    browserViewportWidth: Number(env.MAB_BROWSER_VIEWPORT_WIDTH || 1440),
    browserViewportHeight: Number(env.MAB_BROWSER_VIEWPORT_HEIGHT || 900),
    meetProfileMode: env.MAB_MEET_PROFILE_MODE || "",
    avatarModelUrl:
      env.MAB_AVATAR_MODEL_URL ||
      "https://fastly.jsdelivr.net/gh/Live2D/CubismWebSamples@develop/Samples/Resources/Hiyori/Hiyori.model3.json",
    avatarModelFallbackUrls: (
      env.MAB_AVATAR_MODEL_FALLBACK_URLS ||
      [
        "https://cdn.jsdelivr.net/gh/Live2D/CubismWebSamples@develop/Samples/Resources/Hiyori/Hiyori.model3.json",
        "https://gcore.jsdelivr.net/gh/Live2D/CubismWebSamples@develop/Samples/Resources/Hiyori/Hiyori.model3.json",
        "https://raw.githubusercontent.com/Live2D/CubismWebSamples/develop/Samples/Resources/Hiyori/Hiyori.model3.json",
      ].join(",")
    )
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    avatarRenderer: env.MAB_AVATAR_RENDERER || "vrm",
    avatarVRMModelUrl:
      env.MAB_AVATAR_VRM_MODEL_URL ||
      "https://raw.githubusercontent.com/trinhtanphat/AMI-Chat-AI/main/public/models/3d/Sendagaya_Shibu.vrm",
    avatarVRMModelFallbackUrls: splitList(env.MAB_AVATAR_VRM_MODEL_FALLBACK_URLS || ""),
    avatarDepsDir: env.MAB_AVATAR_DEPS_DIR || "",
    avatarAssetRoot: env.MAB_AVATAR_ASSET_ROOT || "",
    avatarLayout: env.MAB_AVATAR_LAYOUT || "face",
    avatarCanvasWidth: Number(env.MAB_AVATAR_CANVAS_WIDTH || 1920),
    avatarCanvasHeight: Number(env.MAB_AVATAR_CANVAS_HEIGHT || 1080),
    avatarCaptureFps: Number(env.MAB_AVATAR_CAPTURE_FPS || 30),
    avatarUseSwiftShader: ["1", "true", "yes"].includes(
      String(env.MAB_AVATAR_USE_SWIFTSHADER || "").toLowerCase(),
    ),
  };
}
