/* eslint-disable no-unused-vars */
import {
  existsSync,
  readFileSync,
  spawn,
  spawnSync,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  writeFile,
  createServer,
  tmpdir,
  basename,
  dirname,
  pathJoin,
  relative,
  Database,
  getRuntimeConfig,
  createInMemorySessionStore,
  createSessionStore,
  createAgentRunner,
  codexAppServerRunnerInternals,
  buildAvatarInitScript,
  buildLocalDialogInitScript,
  createGoogleMeetJoiner,
  installMeetCaptionCapture,
  createMeetingArtifactPipeline,
  computeDigestWebhookSignature,
  verifyDigestWebhookSignature,
  startLocalMeetFixtureServer,
  buildRealtimeBrowserInitScript,
  buildRealtimeInstructions,
  buildRealtimeSessionConfig,
  realtimeToolSchemas,
  createWorkerReportStore,
  parseAvatarCommand,
  slackTextResponse,
  createJsonServer,
  signSlackRequestBody,
  verifySlackRequest,
  createCanvasPublisher,
  createSlackPoster,
  createInMemoryAssistantScheduleManager,
  executeAssistantScheduleTool,
  LEGACY_SLACK_TOOL_SPECS,
  createLegacySlackToolRegistry,
  createLegacySlackDomainStore,
  htmlToMarkdown,
  markdownToBlocks,
  markdownToMrkdwn,
  markdownToSlackFallbackText,
  markdownishToMrkdwn,
  createLocalSlackMemoryProvider,
  seedLegacySlackMemory,
  buildSlackTriageActionBlocks,
  formatTriageContexts,
  loadTriageContextProjection,
  persistTriageContextProjection,
  buildDailyNoteCompactionTask,
  buildDailyNoteCompactionPrompt,
  dailyNoteCompactHash,
  shouldCompactDailyNote,
  assertNoPrivateSlackFields,
  createShadowTapPayload,
  postShadowTap,
  printHelp,
  assertSmoke,
  readStdinText,
  shouldRunOptionalSmoke,
  collectRealtimeSentEvents,
  hasCommand,
  parseEnvFile,
  envValue,
  redactSecret,
} from "./common.js";
import type {
  RealtimeBridgeWorkerToolCall,
  RealtimeBridgeSnapshot,
  AvatarStateSnapshot,
  AvatarVisualSnapshot,
  AvatarVisualDiff,
  AvatarVisualTestHarness,
  ShadowHookResponseBody,
  ShadowHookBody,
  ShadowHookResult,
  ShadowReportEvent,
  EvidenceArtifact,
  CutoverEvidenceManifest,
} from "./common.js";
import {
  shadowTransmitterHook,
  waitForRunnerJob,
  waitForWorkerReportJob,
  writeTextArtifact,
  writeJsonArtifact,
  runEvidenceCommand,
  fetchJsonArtifact,
  collectArtifacts,
  copyStateArtifacts,
  createCutoverEvidenceBundle,
  cutoverEvidenceBundle,
  cutoverEvidenceSmoke,
  summarizeParityJoin,
  summarizeParityJob,
  startOldStackFixture,
  startService,
  waitForHealth,
  waitForServiceHealth,
  waitForJoinStatus,
  postJson,
  postJsonWithStatus,
  buildSlackCommandForm,
  postSignedSlackCommand,
  buildSlackInteractionForm,
  postSignedSlackInteraction,
  postSignedSlackJson,
} from "./support.js";

export async function slackInstallSmoke() {
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-slack-install-"));
  const slackPort = "18950";
  const meetingPort = "18951";
  const slackUrl = `http://127.0.0.1:${slackPort}`;
  const meetingUrl = `http://127.0.0.1:${meetingPort}`;
  const manifestPath = pathJoin(dataDir, "slack-manifest-bad.json");
  const pastedManifest = {
    display_information: {
      name: "Onee-sama",
      background_color: "#302f2f",
    },
    features: {
      app_home: {
        home_tab_enabled: true,
        messages_tab_enabled: false,
        messages_tab_read_only_enabled: false,
      },
      bot_user: {
        display_name: "Onee-sama",
        always_online: true,
      },
      assistant_view: {
        assistant_description: "Onee-sama is an AI assistant.",
        suggested_prompts: [],
      },
    },
    oauth_config: {
      redirect_urls: ["https://localhost:8080/slack/oauth"],
      scopes: {
        user: ["channels:history", "channels:read", "groups:history", "im:history"],
        bot: [
          "im:read",
          "app_mentions:read",
          "assistant:write",
          "channels:history",
          "channels:join",
          "channels:read",
          "chat:write",
          "chat:write.public",
          "commands",
          "files:read",
          "files:write",
          "groups:history",
          "groups:read",
          "im:history",
          "im:write",
          "pins:read",
          "pins:write",
          "reactions:read",
          "reactions:write",
          "users:read",
        ],
      },
    },
    settings: {
      event_subscriptions: {
        bot_events: [
          "app_mention",
          "assistant_thread_context_changed",
          "assistant_thread_started",
          "message.channels",
          "message.im",
        ],
      },
      interactivity: { is_enabled: true },
      socket_mode_enabled: true,
    },
  };
  await writeFile(manifestPath, `${JSON.stringify(pastedManifest, null, 2)}\n`);

  const meeting = startService("apps/meeting-agent/src/index.js", {
    MAB_MEETING_PORT: meetingPort,
    MAB_MEETING_AGENT_URL: meetingUrl,
    MAB_DATA_DIR: pathJoin(dataDir, "meeting-data"),
    MAB_DRY_RUN_AGENT: "1",
  });
  const slack = startService("apps/slack-agent/src/index.js", {
    MAB_SLACK_PORT: slackPort,
    MAB_MEETING_AGENT_URL: meetingUrl,
    MAB_PUBLIC_BASE_URL: "https://localhost:8080",
    MAB_DATA_DIR: pathJoin(dataDir, "slack-data"),
    MAB_SLACK_WORKSPACE_DIR: pathJoin(dataDir, "workspace"),
    MAB_SLACK_APP_MANIFEST_PATH: manifestPath,
    SLACK_CLIENT_ID: "123.456",
    SLACK_CLIENT_SECRET: "fixture-secret",
    MAB_STATE_PROVIDER: "json-file",
    MAB_SLACK_SOCKET_MODE: "0",
    MAB_SLACK_API_MOCK: "1",
    MAB_SLACK_POSTER_MOCK: "1",
    MAB_DRY_RUN_AGENT: "1",
  });

  try {
    await waitForServiceHealth(meeting, `${meetingUrl}/health`);
    const health = await waitForServiceHealth(slack, `${slackUrl}/healthz`);
    assertSmoke(
      health.ok === true && health.service === "slack-agent",
      "Slack Agent service did not boot",
      health,
    );

    const install = await (await fetch(`${slackUrl}/slack/install`)).json();
    assertSmoke(install.ok === true, "Slack install model failed", install);
    assertSmoke(
      install.manifest?.features?.app_home?.messages_tab_enabled === true,
      "generated manifest does not enable App Home messages tab",
      install,
    );
    assertSmoke(
      install.manifest?.features?.slash_commands?.some((entry) => entry.command === "/avatar"),
      "generated manifest did not include /avatar slash command",
      install,
    );
    assertSmoke(
      install.oauth?.installUrl?.includes("https://slack.com/oauth/v2/authorize"),
      "install URL was not generated",
      install,
    );

    const badValidation = await postJsonWithStatus(`${slackUrl}/slack/app/manifest/validate`, {
      manifest: pastedManifest,
    });
    assertSmoke(
      badValidation.httpStatus === 400 && badValidation.ok === false,
      "bad manifest should fail validation",
      badValidation,
    );
    const badBlocking = badValidation.validation?.blocking || [];
    assertSmoke(
      badBlocking.includes("app_home_messages_tab"),
      "bad manifest did not flag disabled messages tab",
      badValidation,
    );
    assertSmoke(
      badBlocking.includes("bot_events"),
      "bad manifest did not flag missing message.groups event",
      badValidation,
    );
    assertSmoke(
      badBlocking.includes("slash_command"),
      "bad manifest did not flag missing /avatar command definition",
      badValidation,
    );

    const goodValidation = await postJsonWithStatus(`${slackUrl}/slack/app/manifest/validate`, {
      manifest: install.manifest,
    });
    assertSmoke(
      goodValidation.httpStatus === 200 && goodValidation.ok === true,
      "generated manifest should pass validation",
      goodValidation,
    );

    const routeValidation = await postJsonWithStatus(`${slackUrl}/slack/validate`, {
      require_slack_tokens: false,
      manifest: install.manifest,
    });
    assertSmoke(
      routeValidation.httpStatus === 200 && routeValidation.manifestValidation?.ok === true,
      "slack validate route did not include manifest validation",
      routeValidation,
    );

    const validateOnly = spawnSync(process.execPath, ["apps/slack-agent/src/index.js"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MAB_SLACK_VALIDATE_ONLY: "1",
        MAB_SLACK_APP_MANIFEST_PATH: manifestPath,
        MAB_DATA_DIR: pathJoin(dataDir, "validate-only-data"),
        MAB_SLACK_WORKSPACE_DIR: pathJoin(dataDir, "validate-workspace"),
        MAB_STATE_PROVIDER: "json-file",
        MAB_SLACK_SOCKET_MODE: "0",
        MAB_SLACK_API_MOCK: "1",
        MAB_SLACK_POSTER_MOCK: "1",
        MAB_DRY_RUN_AGENT: "1",
      },
      encoding: "utf8",
      timeout: 15_000,
    });
    assertSmoke(
      validateOnly.status === 1,
      "validate-only should fail the pasted incomplete manifest",
      {
        status: validateOnly.status,
        stdout: validateOnly.stdout,
        stderr: validateOnly.stderr,
      },
    );
    const validateOnlyResult = JSON.parse(validateOnly.stdout);
    assertSmoke(
      validateOnlyResult.manifestValidation?.blocking?.includes("app_home_messages_tab"),
      "validate-only did not surface manifest gaps",
      validateOnlyResult,
    );

    console.log(
      JSON.stringify(
        {
          ok: true,
          install: {
            manifestMessagesTab: install.manifest.features.app_home.messages_tab_enabled,
            slashCommands: install.manifest.features.slash_commands.map((entry) => entry.command),
            installUrl: install.oauth.installUrl,
          },
          badValidation: {
            httpStatus: badValidation.httpStatus,
            blocking: badValidation.validation.blocking,
          },
          goodValidation: {
            httpStatus: goodValidation.httpStatus,
            blocking: goodValidation.validation.blocking,
          },
          routeValidation: {
            httpStatus: routeValidation.httpStatus,
            manifestOk: routeValidation.manifestValidation.ok,
          },
          validateOnly: {
            status: validateOnly.status,
            blocking: validateOnlyResult.manifestValidation.blocking,
          },
        },
        null,
        2,
      ),
    );
  } finally {
    slack.child.kill("SIGTERM");
    meeting.child.kill("SIGTERM");
    await rm(dataDir, { recursive: true, force: true });
  }
}

export async function slackToolRegistrySmoke() {
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-slack-tool-registry-"));
  try {
    const memoryRoot = pathJoin(dataDir, "slack-memory");
    const sourceRoot = pathJoin(dataDir, "legacy-source");
    await mkdir(pathJoin(memoryRoot, "workspace"), { recursive: true });
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(
      pathJoin(memoryRoot, "workspace", "MEMORY.md"),
      "Operator uses Linear, Slack Canvas, and legacy workspace memory.\n",
    );
    for (const spec of LEGACY_SLACK_TOOL_SPECS) {
      await writeFile(
        pathJoin(sourceRoot, spec.source),
        `package slack\n\nfunc Name() string { return "${spec.name}" }\n`,
      );
    }
    const localMemory = createLocalSlackMemoryProvider({
      enabled: true,
      rootDir: memoryRoot,
    });
    const calls = [];
    const registry = createLegacySlackToolRegistry({
      botToken: "slack-test-token",
      localMemory,
      sourceRoot,
      workspaceDir: process.cwd(),
      runtimeStatus: () => ({ socketMode: { connected: true }, service: "smoke" }),
      fetchImpl: (async (url: string | URL, options: RequestInit = {}) => {
        calls.push({
          url: String(url),
          payload: JSON.parse(String(options.body || "{}")),
        });
        return {
          ok: true,
          status: 200,
          async json() {
            return { ok: true, method: String(url).split("/").pop(), ts: "1710000000.000000" };
          },
        } as unknown as Response;
      }) as typeof fetch,
    });
    const report = registry.report();
    const expected = [
      "audio_generation",
      "figma_api",
      "followup_memory",
      "google_calendar_api",
      "heartbeat_log",
      "image_generation",
      "linear_api",
      "notion_api",
      "person_memory",
      "read_doc",
      "runtime_status",
      "slack_api",
      "suggest_action",
      "usage_api",
      "manage_schedule",
    ];
    const names = report.tools.map((tool) => tool.name).toSorted();
    for (const name of expected) {
      assertSmoke(names.includes(name), `Legacy tool registry missing ${name}`, names);
      assertSmoke(
        report.sourceEvidence[name]?.exists === true,
        `Legacy source evidence missing for ${name}`,
        report.sourceEvidence[name],
      );
    }
    type ExecuteResult = {
      ok: boolean;
      status?: string;
      error?: string;
      results?: unknown[];
      schedules?: unknown[];
      [key: string]: unknown;
    };
    const executeRegistry = registry.execute as (
      name: string,
      args?: Record<string, unknown>,
    ) => Promise<unknown>;
    const slackApi = (await executeRegistry("slack_api", {
      method: "auth.test",
      payload: {},
    })) as ExecuteResult;
    const slackSurfaceMethods = [
      { method: "conversations.history", payload: { channel: "C_SMOKE", limit: 1 } },
      {
        method: "conversations.replies",
        payload: { channel: "C_SMOKE", ts: "1710000000.000000", limit: 5 },
      },
      { method: "files.info", payload: { file: "F_SMOKE" } },
      {
        method: "reactions.add",
        payload: { channel: "C_SMOKE", timestamp: "1710000000.000000", name: "eyes" },
      },
      { method: "pins.add", payload: { channel: "C_SMOKE", timestamp: "1710000000.000000" } },
      {
        method: "chat.update",
        payload: { channel: "C_SMOKE", ts: "1710000000.000000", text: "updated smoke" },
      },
      { method: "chat.delete", payload: { channel: "C_SMOKE", ts: "1710000000.000000" } },
    ];
    const slackSurfaceCalls: ExecuteResult[] = [];
    for (const call of slackSurfaceMethods) {
      slackSurfaceCalls.push((await executeRegistry("slack_api", call)) as ExecuteResult);
    }
    const memory = (await executeRegistry("person_memory", {
      query: "Linear Canvas",
      limit: 3,
    })) as ExecuteResult;
    const runtime = (await executeRegistry("runtime_status", {})) as ExecuteResult & {
      status?: { service?: string };
    };
    const suggest = (await executeRegistry("suggest_action", {
      action: { type: "confirm", text: "Ship it" },
    })) as ExecuteResult;
    const scheduleList = (await executeRegistry("manage_schedule", {
      action: "list",
      channel_id: "C_SMOKE",
      thread_ts: "1710000000.000000",
    })) as ExecuteResult;
    const scheduleBlocked = (await executeRegistry("manage_schedule", {
      action: "create",
    })) as ExecuteResult;
    const runCommand = (await executeRegistry("run_command", {
      command: "git status --short",
    })) as ExecuteResult;
    const linear = (await executeRegistry("linear_api", { action: "list" })) as ExecuteResult;
    assertSmoke(
      slackApi.ok === true && calls.length >= 1,
      "slack_api adapter did not call Slack API mock",
      slackApi,
    );
    assertSmoke(
      slackSurfaceCalls.every((call) => call.ok === true),
      "Slack surface API smoke failed",
      slackSurfaceCalls,
    );
    const calledMethods = calls.map((call) => call.url.split("/").pop());
    for (const { method } of slackSurfaceMethods) {
      assertSmoke(
        calledMethods.includes(method),
        `Slack surface method ${method} was not forwarded`,
        calledMethods,
      );
    }
    assertSmoke(
      memory.ok === true && (memory.results?.length || 0) >= 1,
      "person_memory adapter did not search local memory",
      memory,
    );
    assertSmoke(
      runtime.ok === true && runtime.status?.service === "smoke",
      "runtime_status adapter failed",
      runtime,
    );
    assertSmoke(
      suggest.ok === true && suggest.status === "pending_user_confirmation",
      "suggest_action adapter failed",
      suggest,
    );
    assertSmoke(
      scheduleList.ok === true && Array.isArray(scheduleList.schedules),
      "manage_schedule list adapter failed",
      scheduleList,
    );
    assertSmoke(
      scheduleBlocked.ok === false && scheduleBlocked.error === "assistant_mutation_blocked",
      "manage_schedule should gate mutations",
      scheduleBlocked,
    );
    assertSmoke(
      runCommand.ok === false && runCommand.error === "run_command_disabled",
      "run_command should fail closed by default",
      runCommand,
    );
    assertSmoke(
      linear.ok === false && linear.error === "external_provider_required",
      "credentialed external tool should fail closed",
      linear,
    );
    console.log(
      JSON.stringify(
        {
          ok: true,
          totalTools: report.totalTools,
          activeTools: report.activeTools,
          pendingTools: report.pendingTools,
          smoke: {
            slackApi,
            slackSurfaceCalls,
            memory,
            runtime,
            suggest,
            scheduleList,
            scheduleBlocked,
            runCommand,
            linear,
          },
        },
        null,
        2,
      ),
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}
