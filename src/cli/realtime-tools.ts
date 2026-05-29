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

export async function realtimeSessionUpdateSmoke() {
  const { chromium } = await import("playwright");
  const config = getRuntimeConfig();
  const executablePath =
    config.chromiumExecutablePath && existsSync(config.chromiumExecutablePath)
      ? config.chromiumExecutablePath
      : undefined;
  const browser = await chromium.launch({
    headless: true,
    executablePath,
  });
  try {
    const instructions = buildRealtimeInstructions({ botName: "Session Update Smoke Bot" });
    const context = await browser.newContext({ permissions: ["microphone", "camera"] });
    await context.addInitScript({
      content: buildRealtimeBrowserInitScript({
        mode: "webrtc-mock",
        autoConnect: true,
        instructions,
        tools: realtimeToolSchemas,
      }),
    });
    const page = await context.newPage();
    await page.goto("data:text/html,<html><body>realtime session update smoke</body></html>");
    await page.waitForFunction(
      () => {
        const bridge = window.MAB_REALTIME_BRIDGE as
          | { connection?: { dataChannelOpen?: boolean } }
          | null
          | undefined;
        return bridge?.connection?.dataChannelOpen === true;
      },
      null,
      { timeout: 10_000 },
    );

    type SessionUpdateSession = {
      model?: string;
      output_modalities?: string[];
      audio?: { input?: { turn_detection?: { type?: string } } };
      reasoning?: { effort?: string };
      instructions?: string;
      tools?: Array<{ name?: string }>;
      [key: string]: unknown;
    };
    type SessionUpdateBridge = RealtimeBridgeSnapshot & {
      session?: { configured?: boolean; toolNames?: string[] };
      timeline?: Array<{ type?: string; detail?: { type?: string } }>;
      outbound?: Array<{
        event?: SessionUpdateSession & { type?: string; session?: SessionUpdateSession };
      }>;
      connection?: { sentDataChannelMessages?: Array<{ payload?: string }> };
    };
    const result = (await page.evaluate(() => ({
      bridge: window.MAB_REALTIME_BRIDGE,
      clientTools: Object.keys(window.MAB_REALTIME_CLIENT || {}),
    }))) as { bridge?: SessionUpdateBridge; clientTools?: string[] };
    const sentEvents = collectRealtimeSentEvents(result.bridge || {}) as Array<
      Record<string, unknown> & { type?: string; session?: SessionUpdateSession }
    >;
    const sessionUpdate = sentEvents.find((event) => event.type === "session.update");
    const toolNames = (sessionUpdate?.session?.tools || [])
      .map((tool) => tool.name)
      .filter(Boolean);
    assertSmoke(
      result.bridge?.session?.configured === true,
      "Realtime session was not marked configured",
      result.bridge?.session,
    );
    assertSmoke(
      Boolean(sessionUpdate),
      "Realtime bridge did not send session.update over the data channel",
      sentEvents,
    );
    assertSmoke(
      sessionUpdate?.session?.model === "gpt-realtime-2",
      "session.update did not default to gpt-realtime-2",
      sessionUpdate,
    );
    assertSmoke(
      Boolean(sessionUpdate?.session?.output_modalities?.includes("audio")),
      "session.update did not use Realtime 2 output_modalities",
      sessionUpdate,
    );
    assertSmoke(
      sessionUpdate?.session?.audio?.input?.turn_detection?.type === "semantic_vad",
      "session.update did not use Realtime 2 semantic_vad",
      sessionUpdate,
    );
    assertSmoke(
      sessionUpdate?.session?.reasoning?.effort === "high",
      "session.update did not set high Realtime 2 reasoning effort",
      sessionUpdate,
    );
    assertSmoke(
      !("modalities" in (sessionUpdate?.session || {})),
      "session.update used legacy modalities",
      sessionUpdate,
    );
    assertSmoke(
      Boolean(sessionUpdate?.session?.instructions?.includes("Session Update Smoke Bot")),
      "session.update did not include runtime instructions",
      sessionUpdate,
    );
    assertSmoke(
      toolNames.includes("delegate_to_worker"),
      "session.update did not include delegate_to_worker",
      toolNames,
    );
    assertSmoke(
      toolNames.includes("update_avatar_state"),
      "session.update did not include update_avatar_state",
      toolNames,
    );
    assertSmoke(
      Boolean(result.bridge?.session?.toolNames?.includes("update_avatar_state")),
      "Realtime bridge did not record configured avatar tool names",
      result.bridge?.session,
    );
    assertSmoke(
      Boolean(
        result.bridge?.timeline?.some(
          (entry) => entry.type === "realtime_outbound" && entry.detail?.type === "session.update",
        ),
      ),
      "Realtime bridge did not record session.update in the timeline",
      result.bridge?.timeline,
    );

    console.log(JSON.stringify({ ok: true, ...result, sessionUpdate }, null, 2));
  } finally {
    await browser.close();
  }
}

export async function realtimeWorkerToolSmoke() {
  const { chromium } = await import("playwright");
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-realtime-worker-tool-"));
  const env = {
    MAB_MEETING_PORT: "18892",
    MAB_MEETING_AGENT_URL: "http://127.0.0.1:18892",
    MAB_BROWSER_HEADLESS: "true",
    MAB_DRY_RUN_AGENT: "1",
    MAB_DATA_DIR: dataDir,
  };
  const meeting = startService("apps/meeting-agent/src/index.js", env);
  const config = getRuntimeConfig();
  const executablePath =
    config.chromiumExecutablePath && existsSync(config.chromiumExecutablePath)
      ? config.chromiumExecutablePath
      : undefined;
  const browser = await chromium.launch({
    headless: true,
    executablePath,
  });
  try {
    await waitForHealth("http://127.0.0.1:18892/healthz");
    const context = await browser.newContext({ permissions: ["microphone", "camera"] });
    await context.addInitScript({
      content: buildRealtimeBrowserInitScript({
        mode: "webrtc-mock",
        autoConnect: true,
        simulateRemoteAudio: false,
        workerDelegateUrl: "http://127.0.0.1:18892/worker/delegate",
        workerStatusUrl: "http://127.0.0.1:18892/worker/status",
      }),
    });
    const page = await context.newPage();
    await page.goto("http://127.0.0.1:18892/healthz");
    await page.waitForFunction(
      () =>
        (
          window.MAB_REALTIME_BRIDGE as
            | { connection?: { dataChannelOpen?: boolean } }
            | null
            | undefined
        )?.connection?.dataChannelOpen === true,
      null,
      { timeout: 10_000 },
    );

    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent("meeting-avatar-realtime-server-event", {
          detail: {
            type: "response.function_call_arguments.done",
            name: "delegate_to_worker",
            call_id: "call_delegate_worker_smoke",
            arguments: JSON.stringify({
              task: "Summarize the Realtime worker tool bridge.",
              context: "Local smoke test from Realtime function call.",
              mode: "analysis",
              allowCodeChanges: false,
            }),
          },
        }),
      );
    });
    await page.waitForFunction(
      () => {
        const tools = (
          window.MAB_REALTIME_BRIDGE as
            | {
                workerTools?: {
                  calls?: Array<{ name?: string; result?: { job?: { id?: string } } }>;
                  errors?: unknown[];
                };
              }
            | null
            | undefined
        )?.workerTools;
        return (
          tools?.calls?.some((call) => call.name === "delegate_to_worker") ||
          tools?.errors?.length > 0
        );
      },
      null,
      { timeout: 10_000 },
    );

    const delegateState = (await page.evaluate(() => {
      const bridge = window.MAB_REALTIME_BRIDGE as {
        workerTools?: {
          calls?: Array<{ name?: string; result?: { job?: { id?: string } } }>;
          errors?: unknown[];
        };
      } | null;
      const call = bridge?.workerTools?.calls?.find((entry) => entry.name === "delegate_to_worker");
      return {
        call,
        bridge: window.MAB_REALTIME_BRIDGE,
      };
    })) as {
      call?: RealtimeBridgeWorkerToolCall;
      bridge?: RealtimeBridgeSnapshot;
    };
    assertSmoke(
      !delegateState.bridge?.workerTools?.errors?.length,
      "delegate_to_worker recorded worker tool errors",
      delegateState.bridge?.workerTools,
    );
    const jobId = delegateState.call?.result?.job?.id;
    assertSmoke(Boolean(jobId), "delegate_to_worker did not return a worker job id", delegateState);

    await page.evaluate((id) => {
      window.dispatchEvent(
        new CustomEvent("meeting-avatar-realtime-server-event", {
          detail: {
            type: "response.function_call_arguments.done",
            name: "worker_status",
            call_id: "call_worker_status_smoke",
            arguments: JSON.stringify({ jobId: id }),
          },
        }),
      );
    }, jobId);
    await page.waitForFunction(
      () =>
        (
          window.MAB_REALTIME_BRIDGE as
            | {
                workerTools?: {
                  calls?: Array<{ name?: string; result?: { job?: { id?: string } } }>;
                  errors?: unknown[];
                };
              }
            | null
            | undefined
        )?.workerTools?.calls?.some((call) => call.name === "worker_status"),
      null,
      { timeout: 10_000 },
    );

    const result = (await page.evaluate(() => ({
      bridge: window.MAB_REALTIME_BRIDGE,
      clientTools: Object.keys(window.MAB_REALTIME_CLIENT || {}),
    }))) as { bridge?: RealtimeBridgeSnapshot; clientTools?: string[] };
    const sentEvents = collectRealtimeSentEvents(result.bridge || {}) as Array<
      Record<string, unknown> & {
        type?: string;
        item?: { type?: string; call_id?: string };
      }
    >;
    const functionOutputs = sentEvents.filter(
      (event) => event.item?.type === "function_call_output",
    );
    const outputCallIds = new Set(functionOutputs.map((event) => event.item?.call_id));
    const workerJobs = (await (await fetch("http://127.0.0.1:18892/worker/jobs")).json()) as {
      jobs?: Array<{ id?: string; status?: string }>;
    };
    const reportedJob = workerJobs.jobs?.find((job) => job.id === jobId);

    assertSmoke(
      outputCallIds.has("call_delegate_worker_smoke"),
      "delegate_to_worker did not emit a function_call_output",
      sentEvents,
    );
    assertSmoke(
      outputCallIds.has("call_worker_status_smoke"),
      "worker_status did not emit a function_call_output",
      sentEvents,
    );
    assertSmoke(
      Boolean(
        result.bridge?.inbound?.some(
          (entry) =>
            entry.event?.type === "response.function_call_arguments.done" &&
            entry.event?.name === "delegate_to_worker",
        ),
      ),
      "Realtime bridge did not record inbound delegate_to_worker event",
      result.bridge?.inbound,
    );
    assertSmoke(
      Boolean(
        result.bridge?.timeline?.some(
          (entry) => entry.type === "realtime_inbound" && entry.detail?.name === "worker_status",
        ),
      ),
      "Realtime bridge did not record inbound worker_status event in timeline",
      result.bridge?.timeline,
    );
    assertSmoke(
      Boolean(
        result.bridge?.workerTools?.calls?.some(
          (call) => call.name === "worker_status" && call.result?.job?.id === jobId,
        ),
      ),
      "worker_status did not return the delegated job",
      result.bridge?.workerTools,
    );
    assertSmoke(
      reportedJob?.status === "completed",
      "delegated worker job was not reported to Meeting Agent",
      workerJobs,
    );
    assertSmoke(
      sentEvents.some((event) => event.type === "response.create"),
      "worker tool call did not request a follow-up response",
      sentEvents,
    );

    console.log(JSON.stringify({ ok: true, jobId, ...result, workerJobs }, null, 2));
  } finally {
    await browser.close();
    meeting.child.kill("SIGTERM");
    await rm(dataDir, { recursive: true, force: true });
  }
}

export async function realtimeLiveToolSmoke() {
  const config = getRuntimeConfig();
  const shouldRunLive = shouldRunOptionalSmoke(
    "MAB_RUN_REALTIME_LIVE_TOOL",
    "MAB_REQUIRE_REALTIME_LIVE_TOOL",
  );
  if (!config.openaiApiKey || !shouldRunLive) {
    const skipped = {
      ok: true,
      skipped: true,
      reason: config.openaiApiKey
        ? "MAB_RUN_REALTIME_LIVE_TOOL not enabled"
        : "MAB_OPENAI_API_KEY/OPENAI_API_KEY missing",
      note: "Set MAB_RUN_REALTIME_LIVE_TOOL=1 to run this optional smoke. Set MAB_REQUIRE_REALTIME_LIVE_TOOL=1 to make it mandatory.",
    };
    if (process.env.MAB_REQUIRE_REALTIME_LIVE_TOOL === "1") {
      assertSmoke(
        false,
        "MAB_OPENAI_API_KEY or OPENAI_API_KEY is required when MAB_REQUIRE_REALTIME_LIVE_TOOL=1",
        skipped,
      );
    }
    console.log(JSON.stringify(skipped, null, 2));
    return;
  }

  const { chromium } = await import("playwright");
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-realtime-live-tool-"));
  const liveToolAgentRunner =
    process.env.MAB_REALTIME_LIVE_TOOL_AGENT_RUNNER || process.env.MAB_AGENT_RUNNER || "dry-run";
  const liveToolDryRunAgent =
    process.env.MAB_REALTIME_LIVE_TOOL_DRY_RUN_AGENT ||
    (String(liveToolAgentRunner).trim().toLowerCase() === "dry-run" ? "1" : "0");
  const env = {
    MAB_MEETING_PORT: "18893",
    MAB_MEETING_AGENT_URL: "http://127.0.0.1:18893",
    MAB_BROWSER_HEADLESS: "true",
    MAB_AGENT_RUNNER: liveToolAgentRunner,
    MAB_DRY_RUN_AGENT: liveToolDryRunAgent,
    MAB_DATA_DIR: dataDir,
  };
  const meeting = startService("apps/meeting-agent/src/index.js", env);
  const executablePath =
    config.chromiumExecutablePath && existsSync(config.chromiumExecutablePath)
      ? config.chromiumExecutablePath
      : undefined;
  const browser = await chromium.launch({
    headless: true,
    executablePath,
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  const delegateTool = realtimeToolSchemas.find((tool) => tool.name === "delegate_to_worker");
  assertSmoke(delegateTool, "delegate_to_worker tool schema missing", realtimeToolSchemas);
  try {
    await waitForHealth("http://127.0.0.1:18893/healthz");
    const context = await browser.newContext({ permissions: ["microphone", "camera"] });
    // Keep page.evaluate callbacks usable when this smoke is run through tsx/esbuild.
    await context.addInitScript({
      content: `
        (() => {
          if (typeof globalThis.__name !== "function") {
            Object.defineProperty(globalThis, "__name", {
              value: (fn) => fn,
              configurable: true,
            });
          }
        })();
      `,
    });
    await context.addInitScript({
      content: buildAvatarInitScript({
        botName: "Realtime Live Tool Bot",
        disableLive2D: true,
      }),
    });
    await context.addInitScript({
      content: buildRealtimeBrowserInitScript({
        mode: "webrtc",
        autoConnect: true,
        simulateRemoteAudio: false,
        tokenUrl: "http://127.0.0.1:18893/realtime/client-secret",
        sdpUrl: config.openaiRealtimeSdpUrl,
        workerDelegateUrl: "http://127.0.0.1:18893/worker/delegate",
        workerStatusUrl: "http://127.0.0.1:18893/worker/status",
        instructions: [
          "You are a Realtime live smoke test agent.",
          "When the user asks you to delegate a task, call delegate_to_worker exactly once.",
          "Do not answer from memory for delegated tasks.",
        ].join(" "),
        tools: [delegateTool],
        session: { tool_choice: "auto" },
        sendSessionUpdateOnConnect: true,
      }),
    });
    const page = await context.newPage();
    await page.goto("http://127.0.0.1:18893/healthz");
    await page.waitForFunction(
      () =>
        window.MAB_AVATAR_READY?.ok === true &&
        (
          window.MAB_REALTIME_BRIDGE as
            | { connection?: { dataChannelOpen?: boolean } }
            | null
            | undefined
        )?.connection?.dataChannelOpen === true,
      null,
      { timeout: 35_000 },
    );

    await page.evaluate((tool) => {
      window.MAB_REALTIME_CLIENT.sendRealtimeEvent({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "请把这个测试任务委托给后台 worker：用一句话说明 Realtime live tool smoke 已经触发。",
            },
          ],
        },
      });
      window.MAB_REALTIME_CLIENT.sendRealtimeEvent({
        type: "response.create",
        response: {
          instructions:
            "You must call delegate_to_worker once with a short Chinese task. Do not produce a final answer before the function call.",
          tools: [tool],
          tool_choice: "required",
        },
      });
    }, delegateTool);

    await page.waitForFunction(
      () => {
        const bridge = window.MAB_REALTIME_BRIDGE as
          | {
              workerTools?: { calls?: Array<{ name?: string }>; errors?: unknown[] };
              errors?: unknown[];
            }
          | null
          | undefined;
        return Boolean(
          bridge?.workerTools?.calls?.some((call) => call.name === "delegate_to_worker") ||
          (bridge?.workerTools?.errors?.length || 0) > 0 ||
          (bridge?.errors?.length || 0) > 0,
        );
      },
      null,
      { timeout: 45_000 },
    );

    const result = (await page.evaluate(() => ({
      bridge: window.MAB_REALTIME_BRIDGE,
      avatar: window.MAB_AVATAR_READY,
      clientTools: Object.keys(window.MAB_REALTIME_CLIENT || {}),
    }))) as {
      bridge?: RealtimeBridgeSnapshot & { errors?: unknown[] };
      avatar?: unknown;
      clientTools?: string[];
    };
    const sentEvents = collectRealtimeSentEvents(result.bridge || {}) as Array<
      Record<string, unknown> & { item?: { type?: string; call_id?: string } }
    >;
    const delegateCall = result.bridge?.workerTools?.calls?.find(
      (call) => call.name === "delegate_to_worker",
    ) as (RealtimeBridgeWorkerToolCall & { callId?: string }) | undefined;
    const delegateCalls =
      result.bridge?.workerTools?.calls?.filter((call) => call.name === "delegate_to_worker") || [];

    assertSmoke(
      !result.bridge?.errors?.length,
      "Realtime live bridge reported errors",
      result.bridge?.errors,
    );
    assertSmoke(
      !result.bridge?.workerTools?.errors?.length,
      "Realtime live worker tool reported errors",
      result.bridge?.workerTools,
    );
    assertSmoke(
      result.bridge?.connection?.dataChannelOpen === true,
      "Realtime live data channel did not open",
      result.bridge?.connection,
    );
    assertSmoke(
      Boolean(delegateCall?.result?.job?.id),
      "Realtime live model did not trigger delegate_to_worker",
      result.bridge?.workerTools,
    );
    assertSmoke(
      delegateCalls.length === 1,
      "Realtime live delegate_to_worker call was handled more than once for the same model call",
      result.bridge?.workerTools,
    );
    assertSmoke(
      sentEvents.some(
        (event) =>
          event.item?.type === "function_call_output" &&
          event.item?.call_id === delegateCall?.callId,
      ),
      "Realtime live delegate call did not emit function_call_output",
      sentEvents,
    );
    const completedWorkerJob = await waitForWorkerReportJob({
      url: "http://127.0.0.1:18893/worker/jobs",
      jobId: delegateCall.result.job.id,
      timeoutMs: Number(process.env.MAB_REALTIME_LIVE_TOOL_WORKER_TIMEOUT_MS || 120_000),
    });
    assertSmoke(
      completedWorkerJob.status === "completed",
      "Realtime live delegated worker job did not complete successfully",
      completedWorkerJob,
    );
    assertSmoke(
      completedWorkerJob.provider === liveToolAgentRunner || liveToolAgentRunner === "dry-run",
      "Realtime live delegated worker job used the wrong AgentRunner provider",
      { expected: liveToolAgentRunner, completedWorkerJob },
    );
    const finalWorkerJobs = await (await fetch("http://127.0.0.1:18893/worker/jobs")).json();
    assertSmoke(
      finalWorkerJobs.jobs.some(
        (job) => job.id === delegateCall.result.job.id && job.status === "completed",
      ),
      "Realtime live delegated worker job was not completed in Meeting Agent",
      finalWorkerJobs,
    );

    console.log(
      JSON.stringify(
        {
          ok: true,
          agentRunner: liveToolAgentRunner,
          delegateCall,
          completedWorkerJob,
          ...result,
          workerJobs: finalWorkerJobs,
        },
        null,
        2,
      ),
    );
  } finally {
    await browser.close();
    meeting.child.kill("SIGTERM");
    await rm(dataDir, { recursive: true, force: true });
  }
}

export async function realtimeLiveRoutingSmoke() {
  const config = getRuntimeConfig();
  const shouldRunLive = shouldRunOptionalSmoke(
    "MAB_RUN_REALTIME_LIVE_ROUTING",
    "MAB_REQUIRE_REALTIME_LIVE_ROUTING",
  );
  if (!config.openaiApiKey || !shouldRunLive) {
    const skipped = {
      ok: true,
      skipped: true,
      reason: config.openaiApiKey
        ? "MAB_RUN_REALTIME_LIVE_ROUTING not enabled"
        : "MAB_OPENAI_API_KEY/OPENAI_API_KEY missing",
      note: "Set MAB_RUN_REALTIME_LIVE_ROUTING=1 to run this optional smoke. Set MAB_REQUIRE_REALTIME_LIVE_ROUTING=1 to make it mandatory.",
    };
    if (process.env.MAB_REQUIRE_REALTIME_LIVE_ROUTING === "1") {
      assertSmoke(
        false,
        "MAB_OPENAI_API_KEY or OPENAI_API_KEY is required when MAB_REQUIRE_REALTIME_LIVE_ROUTING=1",
        skipped,
      );
    }
    console.log(JSON.stringify(skipped, null, 2));
    return;
  }

  const { chromium } = await import("playwright");
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-realtime-live-routing-"));
  const env = {
    MAB_MEETING_PORT: "18894",
    MAB_MEETING_AGENT_URL: "http://127.0.0.1:18894",
    MAB_BROWSER_HEADLESS: "true",
    MAB_AGENT_RUNNER: "dry-run",
    MAB_DRY_RUN_AGENT: "1",
    MAB_DATA_DIR: dataDir,
  };
  const meeting = startService("apps/meeting-agent/src/index.js", env);
  const executablePath =
    config.chromiumExecutablePath && existsSync(config.chromiumExecutablePath)
      ? config.chromiumExecutablePath
      : undefined;
  const browser = await chromium.launch({
    headless: true,
    executablePath,
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });

  const visualToolNames = [
    "share_existing_app_window",
    "open_shared_browser_surface",
    "create_shared_workspace",
    "stop_video_stage",
    "stop_shared_browser_surface",
    "list_shareable_windows",
    "control_shared_app_window",
  ];
  const visualTools = visualToolNames.map((name) => {
    const tool = realtimeToolSchemas.find((entry) => entry.name === name);
    assertSmoke(tool, `Realtime visual routing tool schema missing: ${name}`, visualToolNames);
    return tool;
  });
  const cases = [
    {
      id: "existing_app_pencil",
      text: "用 Pencil 演示当前画面",
      expectedTools: ["share_existing_app_window"],
    },
    {
      id: "control_shared_pencil",
      text: "Pencil 已经在屏幕共享里了，请在 Pencil 里画一个贪食蛇 mockup",
      expectedTools: ["control_shared_app_window"],
      requireOperations: true,
    },
    {
      id: "ambiguous_app_editor",
      text: "用编辑器演示当前画面",
      expectedTools: ["list_shareable_windows"],
    },
    {
      id: "browser_url",
      text: "打开 https://example.com 给我看",
      expectedTools: ["open_shared_browser_surface"],
    },
    {
      id: "generate_snake",
      text: "做一个贪吃蛇，然后给我看",
      expectedTools: ["create_shared_workspace"],
    },
    {
      id: "create_dashboard",
      text: "做一个 Q3 metrics dashboard",
      expectedTools: ["create_shared_workspace"],
    },
    {
      id: "stop_share",
      text: "停止分享",
      expectedTools: ["stop_video_stage", "stop_shared_browser_surface"],
    },
    {
      id: "stop_when_idle_negative",
      text: "现在没有共享时停止分享",
      expectedTools: ["stop_video_stage", "stop_shared_browser_surface"],
      forbiddenTools: [
        "share_existing_app_window",
        "open_shared_browser_surface",
        "create_shared_workspace",
      ],
    },
  ];
  const results: unknown[] = [];

  try {
    await waitForServiceHealth(meeting, "http://127.0.0.1:18894/healthz", 20_000);
    for (const testCase of cases) {
      const context = await browser.newContext({ permissions: ["microphone", "camera"] });
      await context.addInitScript({
        content: `
          (() => {
            if (typeof globalThis.__name !== "function") {
              Object.defineProperty(globalThis, "__name", {
                value: (fn) => fn,
                configurable: true,
              });
            }
          })();
        `,
      });
      await context.addInitScript({
        content: buildAvatarInitScript({
          botName: "Realtime Visual Routing Bot",
          disableLive2D: true,
        }),
      });
      await context.addInitScript({
        content: buildRealtimeBrowserInitScript({
          mode: "webrtc",
          agentRuntime: config.openaiRealtimeAgentRuntime,
          autoConnect: true,
          simulateRemoteAudio: false,
          tokenUrl: "http://127.0.0.1:18894/realtime/client-secret",
          sdpUrl: config.openaiRealtimeSdpUrl,
          instructions: buildRealtimeInstructions({
            botName: "Realtime Visual Routing Bot",
          }),
          tools: visualTools,
          session: { tool_choice: "auto" },
          sendSessionUpdateOnConnect: true,
          dryRunLocalTools: true,
        }),
      });
      const page = await context.newPage();
      try {
        await page.goto("http://127.0.0.1:18894/healthz");
        await page.waitForFunction(
          () =>
            window.MAB_AVATAR_READY?.ok === true &&
            (
              window.MAB_REALTIME_BRIDGE as
                | { connection?: { dataChannelOpen?: boolean } }
                | null
                | undefined
            )?.connection?.dataChannelOpen === true,
          null,
          { timeout: 35_000 },
        );

        await page.evaluate(
          ({ text, tools }) => {
            window.MAB_REALTIME_CLIENT.sendRealtimeEvent({
              type: "conversation.item.create",
              metadata: { source: "manual_text_turn" },
              item: {
                type: "message",
                role: "user",
                metadata: { source: "manual_text_turn" },
                content: [{ type: "input_text", text }],
              },
            });
            window.MAB_REALTIME_CLIENT.sendRealtimeEvent({
              type: "response.create",
              response: {
                tools,
                tool_choice: "auto",
              },
            });
          },
          { text: testCase.text, tools: visualTools },
        );

        await page.waitForFunction(
          () => {
            const bridge = window.MAB_REALTIME_BRIDGE as
              | {
                  meetTools?: { calls?: unknown[]; errors?: unknown[] };
                  workspaceTools?: { calls?: unknown[]; errors?: unknown[] };
                  errors?: unknown[];
                }
              | null
              | undefined;
            return Boolean(
              (bridge?.meetTools?.calls?.length || 0) +
                (bridge?.workspaceTools?.calls?.length || 0) >
                0 ||
              (bridge?.meetTools?.errors?.length || 0) > 0 ||
              (bridge?.workspaceTools?.errors?.length || 0) > 0 ||
              (bridge?.errors?.length || 0) > 0,
            );
          },
          null,
          { timeout: 45_000 },
        );
        if ("requireOperations" in testCase && testCase.requireOperations) {
          await page.waitForFunction(
            () => {
              const calls =
                (
                  window.MAB_REALTIME_BRIDGE as
                    | {
                        workspaceTools?: {
                          calls?: Array<{ name?: string; arguments?: { operations?: unknown } }>;
                        };
                      }
                    | null
                    | undefined
                )?.workspaceTools?.calls || [];
              return calls.some((call) => {
                if (call.name !== "control_shared_app_window") return false;
                const operations = Array.isArray(call.arguments?.operations)
                  ? (call.arguments.operations as Array<{ kind?: unknown }>)
                  : [];
                return operations.some((operation) => String(operation?.kind || "") !== "state");
              });
            },
            null,
            { timeout: 45_000 },
          );
        }

        const result = (await page.evaluate(() => ({
          bridge: window.MAB_REALTIME_BRIDGE,
          avatar: window.MAB_AVATAR_READY,
        }))) as {
          bridge?: RealtimeBridgeSnapshot & {
            meetTools?: {
              calls?: Array<{ name?: string; [key: string]: unknown }>;
              errors?: unknown[];
            };
            workspaceTools?: {
              calls?: Array<{ name?: string; [key: string]: unknown }>;
              errors?: unknown[];
            };
            errors?: unknown[];
          };
          avatar?: unknown;
        };
        const calls = [
          ...(result.bridge?.meetTools?.calls || []),
          ...(result.bridge?.workspaceTools?.calls || []),
        ];
        const actualTools = calls.map((call) => call.name).filter(Boolean);
        assertSmoke(
          actualTools.length > 0,
          `Realtime routing case ${testCase.id} did not call a visual tool`,
          result.bridge,
        );
        const forbiddenTools = "forbiddenTools" in testCase ? testCase.forbiddenTools : [];
        assertSmoke(
          !actualTools.some((tool) => forbiddenTools.includes(String(tool || ""))),
          `Realtime routing case ${testCase.id} called forbidden surface creation tool`,
          { text: testCase.text, actualTools, forbiddenTools, calls, bridge: result.bridge },
        );
        assertSmoke(
          testCase.expectedTools.includes(String(actualTools[0] || "")),
          `Realtime routing case ${testCase.id} called ${actualTools[0]}, expected ${testCase.expectedTools.join(" or ")}`,
          { text: testCase.text, actualTools, calls, bridge: result.bridge },
        );
        const appControlCalls =
          "requireOperations" in testCase && testCase.requireOperations
            ? calls.filter((call) => call.name === "control_shared_app_window")
            : [];
        const directOperationCall = appControlCalls.find((call) => {
          const args = call.arguments as { operations?: unknown } | undefined;
          const operations = Array.isArray(args?.operations)
            ? (args.operations as Array<{ kind?: unknown }>)
            : [];
          return operations.some((operation) => String(operation?.kind || "") !== "state");
        });
        if ("requireOperations" in testCase && testCase.requireOperations) {
          const operations = appControlCalls.flatMap((call) => {
            const args = call.arguments as { operations?: unknown } | undefined;
            return Array.isArray(args?.operations)
              ? (args.operations as Array<{ kind?: unknown }>)
              : [];
          });
          assertSmoke(
            operations.some((operation) => String(operation?.kind || "") !== "state"),
            `Realtime routing case ${testCase.id} did not continue with direct app-control operations after state`,
            { text: testCase.text, actualTools, appControlCalls, bridge: result.bridge },
          );
        }
        results.push({
          id: testCase.id,
          text: testCase.text,
          expectedTools: testCase.expectedTools,
          actualTools,
          firstCall: calls[0],
          ...(directOperationCall ? { directOperationCall } : {}),
        });
      } catch (error) {
        const snapshot = await page
          .evaluate(() => ({
            bridge: window.MAB_REALTIME_BRIDGE,
            avatar: window.MAB_AVATAR_READY,
          }))
          .catch(() => ({}));
        assertSmoke(false, `Realtime routing case ${testCase.id} failed`, {
          error: String((error && error.message) || error),
          text: testCase.text,
          snapshot,
        });
      } finally {
        await context.close();
      }
    }

    console.log(JSON.stringify({ ok: true, cases: results }, null, 2));
  } finally {
    await browser.close();
    meeting.child.kill("SIGTERM");
    await rm(dataDir, { recursive: true, force: true });
  }
}
