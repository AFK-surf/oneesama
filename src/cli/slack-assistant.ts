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
  redactSecret
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
  CutoverEvidenceManifest
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
  postSignedSlackJson
} from "./support.js";

export async function canvasPublisherSmoke() {
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-canvas-publisher-"));
  try {
    const pipeline = createMeetingArtifactPipeline({
      rootDir: pathJoin(dataDir, "artifacts"),
      asrProvider: "none",
    });
    const processed = await pipeline.postProcessMeeting({
      sessionId: "meet_canvas_smoke",
      meetUrl: "https://meet.google.com/abc-defg-hij",
      title: "Canvas publisher smoke",
      captions: [
        {
          speaker: "Operator",
          text: "Decision: keep legacy project read-only.",
          timestamp: "2026-05-08T05:01:00.000Z",
        },
        {
          speaker: "Bot",
          text: "Action item: send the post-meeting report to Slack Canvas.",
          timestamp: "2026-05-08T05:01:10.000Z",
        },
      ],
    });
    const publisher = createCanvasPublisher({
      provider: "file",
      outDir: pathJoin(dataDir, "canvas"),
      env: { ...process.env, MAB_SLACK_POSTER_MOCK: "1" },
    });
    const published = await publisher.publish({
      artifact: processed.artifact,
      channel: "C_SMOKE",
      threadTs: "1710000000.000000",
    });
    assertSmoke(published.ok === true, "canvas publisher smoke failed", published);
    assertSmoke(
      existsSync(published.markdownPath),
      "canvas publisher did not write markdown payload",
      published,
    );
    assertSmoke(
      existsSync(published.manifestPath),
      "canvas publisher did not write manifest",
      published,
    );
    assertSmoke(
      (published.slack as { mock?: boolean } | null)?.mock === true,
      "canvas publisher did not use Slack-thread fallback in mock mode",
      published,
    );
    assertSmoke(
      publisher.listPublished().length === 1,
      "canvas publisher did not list published manifest",
      publisher.listPublished(),
    );

    const slackPort = 18946;
    const slackUrl = `http://127.0.0.1:${slackPort}`;
    const serviceCanvasDir = pathJoin(dataDir, "service-canvas");
    const slack = startService("apps/slack-agent/src/index.js", {
      MAB_SLACK_PORT: String(slackPort),
      MAB_DATA_DIR: pathJoin(dataDir, "service-data"),
      MAB_CANVAS_DIR: serviceCanvasDir,
      MAB_CANVAS_PUBLISHER: "file",
      MAB_SLACK_POSTER_MOCK: "1",
      MAB_DRY_RUN_AGENT: "1",
      SLACK_SIGNING_SECRET: "canvas-publisher-smoke-signing-secret",
    });
    let servicePublished = null;
    let serviceCanvas = null;
    try {
      await waitForServiceHealth(slack, `${slackUrl}/healthz`);
      servicePublished = await postJsonWithStatus(`${slackUrl}/post-meeting/publish`, {
        artifact: processed.artifact,
        channel: "C_SMOKE",
        threadTs: "1710000000.000000",
        destination: "post-meeting",
        dedupKey: `post-meeting:${processed.artifact.id}:smoke`,
      });
      assertSmoke(
        servicePublished.httpStatus === 200 && servicePublished.ok === true,
        "Slack Agent post-meeting publish route failed",
        servicePublished,
      );
      assertSmoke(
        servicePublished.published?.slack?.mock === true,
        "Slack Agent post-meeting route did not use mock Slack delivery",
        servicePublished,
      );
      assertSmoke(
        existsSync(servicePublished.published.markdownPath),
        "Slack Agent post-meeting route did not write markdown",
        servicePublished,
      );

      serviceCanvas = await postJsonWithStatus(`${slackUrl}/canvas/publish`, {
        artifact: processed.artifact,
        destination: "canvas",
      });
      assertSmoke(
        serviceCanvas.httpStatus === 200 && serviceCanvas.ok === true,
        "Slack Agent canvas publish route failed",
        serviceCanvas,
      );
      assertSmoke(
        serviceCanvas.published?.surface === "file",
        "Slack Agent canvas route did not use file Canvas publisher",
        serviceCanvas,
      );
      assertSmoke(
        existsSync(serviceCanvas.published.markdownPath),
        "Slack Agent canvas route did not write markdown",
        serviceCanvas,
      );

      const listed = await (await fetch(`${slackUrl}/canvas/published`)).json();
      assertSmoke(
        listed.published.length === 2,
        "Slack Agent did not list both published summary deliveries",
        listed,
      );
    } finally {
      slack.child.kill("SIGTERM");
    }

    console.log(
      JSON.stringify(
        { ok: true, artifact: processed.artifact, published, servicePublished, serviceCanvas },
        null,
        2,
      ),
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

export async function slackMrkdwnRendererSmoke() {
  const table = "| Name | Status |\n| --- | --- |\n| Alice | Done |\n| Bob | Pending |";
  const tableWant = "• *Name*: Alice  ·  *Status*: Done\n• *Name*: Bob  ·  *Status*: Pending";
  assertSmoke(
    markdownToMrkdwn("this is **bold** and *italic*") === "this is *bold* and _italic_",
    "Markdown emphasis did not convert to Slack mrkdwn",
  );
  assertSmoke(
    markdownToMrkdwn("check [Spec](https://example.com)") === "check <https://example.com|Spec>",
    "Markdown link did not convert to Slack link",
  );
  assertSmoke(
    markdownToMrkdwn("## Summary\n- **Action**") === "*Summary*\n• *Action*",
    "Headers/lists did not convert to Slack mrkdwn",
  );
  assertSmoke(
    markdownToMrkdwn(table) === tableWant,
    "Markdown table did not collapse to Slack bullets",
    { got: markdownToMrkdwn(table) },
  );
  assertSmoke(
    markdownToMrkdwn("use `**literal**` and **real**") === "use `**literal**` and *real*",
    "Inline code was not preserved during mrkdwn conversion",
  );
  assertSmoke(
    markdownishToMrkdwn(":calendar: *Already Slack bold*\n[Open](https://example.com)") ===
      ":calendar: *Already Slack bold*\n<https://example.com|Open>",
    "Markdownish conversion did not preserve existing Slack mrkdwn",
  );
  assertSmoke(
    markdownToSlackFallbackText("See **status** in [Linear](https://linear.app).") ===
      "See *status* in <https://linear.app|Linear>.",
    "Slack fallback text did not convert markdown",
  );
  const blocks = markdownToBlocks(
    "# Project Status\n\nCore features are done.\n\n---\n\n## Next\n- **Fix** auth",
  ) as Array<{ type?: string; text?: { text?: string } }>;
  assertSmoke(blocks[0]?.type === "header", "Markdown heading did not become header block", blocks);
  assertSmoke(
    blocks.some((block) => block.type === "divider"),
    "Markdown horizontal rule did not become divider block",
    blocks,
  );
  assertSmoke(
    blocks.some((block) => block.type === "section" && block.text?.text?.includes("• *Fix* auth")),
    "Markdown body did not become mrkdwn section",
    blocks,
  );
  const chunks = markdownToBlocks(`## Long\n${"a".repeat(3100)}`) as Array<{
    type?: string;
    text?: { text?: string };
  }>;
  assertSmoke(
    chunks.filter((block) => block.type === "section").length >= 2,
    "Long mrkdwn body was not chunked",
    chunks,
  );
  assertSmoke(
    htmlToMarkdown(`<p>Hello <a href="https://example.com">world</a></p>`) ===
      "Hello [world](https://example.com)",
    "HTML link did not convert to Markdown",
  );

  const poster = createSlackPoster({ mock: true });
  const post = await poster.postMessage({
    channel: "C_SMOKE",
    text: "# Worker Result\n\n- **Status**: Done\n- [Open](https://example.com)",
    dedupKey: "mrkdwn-renderer-smoke",
  });
  assertSmoke(post.ok === true && post.mock === true, "Mock Slack poster failed", post);
  assertSmoke(
    post.message?.text?.includes("*Status*"),
    "Poster fallback text did not render mrkdwn",
    post,
  );
  assertSmoke(
    (post.message?.blocks?.[0] as { type?: string } | undefined)?.type === "header",
    "Poster did not auto-build blocks from markdown",
    post,
  );

  console.log(JSON.stringify({ ok: true, table: tableWant, blocks, chunks, post }, null, 2));
}

export async function slackAssistantScheduleSmoke() {
  const definitions = [
    {
      id: "keep-metadata",
      name: "Current thread via metadata",
      prompt: "Summarize this thread.",
      metadata: {
        slack_channel_id: "C123",
        slack_thread_ts: "1700000000.123456",
      },
      cron_expr: "0 9 * * 1",
      timezone: "Asia/Shanghai",
      is_paused: false,
      created_at: "2026-05-12T00:00:00.000Z",
      updated_at: "2026-05-12T00:00:00.000Z",
    },
    {
      id: "keep-legacy",
      name: "Current thread via legacy prompt",
      prompt:
        "Summarize this thread.\n\n[Context] This schedule was created in channel=C123 thread_ts=1700000000.123456. When posting results, use slack_api to deliver to the appropriate channel/thread. Your text output alone is NOT delivered to Slack.",
      cron_expr: "0 10 * * *",
      timezone: "Asia/Shanghai",
      is_paused: false,
    },
    {
      id: "drop-other-thread",
      name: "Other thread",
      prompt: "Summarize another thread.",
      metadata: {
        slack_channel_id: "C123",
        slack_thread_ts: "1700000001.123456",
      },
      cron_expr: "0 11 * * *",
      timezone: "Asia/Shanghai",
      is_paused: false,
    },
    {
      id: "drop-no-context",
      name: "No Slack context",
      prompt: "Summarize something else.",
      cron_expr: "0 12 * * *",
      timezone: "Asia/Shanghai",
      is_paused: false,
    },
  ];
  const scheduleManager = createInMemoryAssistantScheduleManager(definitions);
  const args = { action: "list", channel_id: "C123", thread_ts: "1700000000.123456" };
  type ScheduleListResult = {
    ok: boolean;
    success?: boolean;
    error?: string;
    text?: string;
    metadata?: { schedule_ids?: string[]; [key: string]: unknown };
    schedules?: unknown[];
    [key: string]: unknown;
  };
  const direct = (await executeAssistantScheduleTool(args, {
    scheduleManager,
  })) as ScheduleListResult;
  assertSmoke(
    direct.ok === true && direct.success === true,
    "Assistant schedule list failed",
    direct,
  );
  assertSmoke(
    JSON.stringify(direct.metadata?.schedule_ids) ===
      JSON.stringify(["keep-metadata", "keep-legacy"]),
    "Assistant schedule list was not scoped to the current Slack thread",
    direct,
  );
  assertSmoke(
    (direct.schedules?.length || 0) === 2 && !direct.text?.includes("drop-other-thread"),
    "Assistant schedule output included other threads",
    direct,
  );

  for (const action of ["create", "get", "update", "pause", "resume", "delete"]) {
    const blocked = (await executeAssistantScheduleTool(
      { action },
      { scheduleManager },
    )) as ScheduleListResult;
    assertSmoke(
      blocked.ok === false && blocked.error === "assistant_mutation_blocked",
      `Assistant schedule ${action} should be blocked`,
      blocked,
    );
    assertSmoke(
      Boolean(
        blocked.text?.includes("not available in assistant sessions") &&
        blocked.text?.includes('"list"'),
      ),
      `Assistant schedule ${action} gate text missing allowed action`,
      blocked,
    );
  }

  const registry = createLegacySlackToolRegistry({
    scheduleManager,
    sessionMetadata: {
      channel_id: "C123",
      thread_ts: "1700000000.123456",
    },
  });
  const executeRegistry = registry.execute as (
    name: string,
    args?: Record<string, unknown>,
  ) => Promise<unknown>;
  const registryList = (await executeRegistry("manage_schedule", {
    action: "list",
  })) as ScheduleListResult;
  assertSmoke(
    registryList.ok === true && (registryList.metadata?.schedule_ids?.length || 0) === 2,
    "Legacy tool registry did not execute manage_schedule",
    registryList,
  );
  const registryBlocked = (await executeRegistry("manage_schedule", {
    action: "delete",
  })) as ScheduleListResult;
  assertSmoke(
    registryBlocked.ok === false && registryBlocked.error === "assistant_mutation_blocked",
    "Legacy tool registry did not block manage_schedule mutation",
    registryBlocked,
  );
  const report = registry.report() as {
    activeTools: string[];
    sourceEvidence: Record<string, { exists?: boolean; [key: string]: unknown }>;
  };
  assertSmoke(
    report.activeTools.includes("manage_schedule"),
    "Legacy registry did not mark manage_schedule active",
    report,
  );
  assertSmoke(
    report.sourceEvidence.manage_schedule?.exists === true,
    "Legacy source evidence missing for manage_schedule",
    report.sourceEvidence.manage_schedule,
  );

  console.log(
    JSON.stringify(
      { ok: true, direct, registryList, registryBlocked, activeTools: report.activeTools },
      null,
      2,
    ),
  );
}

export async function slackAssistantScheduleServiceSmoke() {
  const dataDir = await mkdtemp(
    pathJoin(tmpdir(), "meeting-avatar-bot-assistant-schedule-service-"),
  );
  const port = "18946";
  const baseUrl = `http://127.0.0.1:${port}`;
  const definitionsPath = pathJoin(dataDir, "assistant-schedules.json");
  await writeFile(
    definitionsPath,
    JSON.stringify(
      {
        definitions: [
          {
            id: "service-keep-metadata",
            name: "Service current thread via metadata",
            metadata: { slack_channel_id: "C_SERVICE", slack_thread_ts: "1710000000.000000" },
            prompt: "Summarize service thread.",
            cron_expr: "0 9 * * 1",
            timezone: "Asia/Shanghai",
          },
          {
            id: "service-keep-legacy",
            name: "Service current thread via prompt",
            prompt:
              "Summarize service thread.\n\n[Context] This schedule was created in channel=C_SERVICE thread_ts=1710000000.000000. When posting results, use slack_api to deliver to the appropriate channel/thread. Your text output alone is NOT delivered to Slack.",
            cron_expr: "0 10 * * 1",
            timezone: "Asia/Shanghai",
          },
          {
            id: "service-drop-other-thread",
            name: "Service other thread",
            metadata: { slack_channel_id: "C_SERVICE", slack_thread_ts: "1710000001.000000" },
            prompt: "Summarize another thread.",
            cron_expr: "0 11 * * 1",
            timezone: "Asia/Shanghai",
          },
        ],
      },
      null,
      2,
    ),
  );

  const service = startService("apps/slack-agent/src/index.js", {
    MAB_SLACK_PORT: port,
    MAB_DATA_DIR: dataDir,
    MAB_STATE_PROVIDER: "json-file",
    MAB_SLACK_SOCKET_MODE: "0",
    MAB_SLACK_API_MOCK: "1",
    MAB_SLACK_POSTER_MOCK: "1",
    MAB_DRY_RUN_AGENT: "1",
    MAB_ASSISTANT_SCHEDULE_DEFINITIONS_PATH: definitionsPath,
  });

  try {
    const health = await waitForServiceHealth(service, `${baseUrl}/healthz`, 10_000);
    assertSmoke(
      health.ok === true && health.service === "slack-agent",
      "Slack Agent service did not boot",
      health,
    );
    const parity = await (await fetch(`${baseUrl}/slack/tools/parity`)).json();
    assertSmoke(
      parity.activeTools?.includes("manage_schedule"),
      "Slack Agent service did not expose manage_schedule as active",
      parity,
    );

    const list = await postJsonWithStatus(`${baseUrl}/slack/tools/call`, {
      tool: "manage_schedule",
      args: { action: "list", channel_id: "C_SERVICE", thread_ts: "1710000000.000000" },
    });
    assertSmoke(
      list.httpStatus === 200 && list.ok === true,
      "Slack Agent service manage_schedule list failed",
      list,
    );
    assertSmoke(
      JSON.stringify(list.metadata?.schedule_ids) ===
        JSON.stringify(["service-keep-metadata", "service-keep-legacy"]),
      "Slack Agent service manage_schedule list was not scoped to the current thread",
      list,
    );

    const blocked = await postJsonWithStatus(`${baseUrl}/slack/tools/call`, {
      tool: "manage_schedule",
      args: { action: "delete", channel_id: "C_SERVICE", thread_ts: "1710000000.000000" },
    });
    assertSmoke(
      blocked.httpStatus === 400 &&
        blocked.ok === false &&
        blocked.error === "assistant_mutation_blocked",
      "Slack Agent service manage_schedule did not block mutation",
      blocked,
    );

    console.log(JSON.stringify({ ok: true, service: { health, parity }, list, blocked }, null, 2));
  } finally {
    service.child.kill("SIGTERM");
    await rm(dataDir, { recursive: true, force: true });
  }
}

export async function slackWorkspaceBootstrapSmoke() {
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-workspace-bootstrap-"));
  const meetingPort = "18948";
  const slackPort = "18949";
  const meetingUrl = `http://127.0.0.1:${meetingPort}`;
  const slackUrl = `http://127.0.0.1:${slackPort}`;
  const workspaceDir = pathJoin(dataDir, "workspace");
  const validateOnlyWorkspaceDir = pathJoin(dataDir, "validate-only-workspace");
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(pathJoin(workspaceDir, "SOUL.md"), "custom soul stays\n");

  const meeting = startService("apps/meeting-agent/src/index.js", {
    MAB_MEETING_PORT: meetingPort,
    MAB_MEETING_AGENT_URL: meetingUrl,
    MAB_DATA_DIR: pathJoin(dataDir, "meeting-data"),
    MAB_DRY_RUN_AGENT: "1",
  });
  const slack = startService("apps/slack-agent/src/index.js", {
    MAB_SLACK_PORT: slackPort,
    MAB_MEETING_AGENT_URL: meetingUrl,
    MAB_DATA_DIR: pathJoin(dataDir, "slack-data"),
    MAB_SLACK_WORKSPACE_DIR: workspaceDir,
    MAB_STATE_PROVIDER: "json-file",
    MAB_SLACK_SOCKET_MODE: "0",
    MAB_SLACK_API_MOCK: "1",
    MAB_SLACK_POSTER_MOCK: "1",
    MAB_DRY_RUN_AGENT: "1",
  });

  try {
    await waitForServiceHealth(meeting, `${meetingUrl}/health`);
    const validateOnly = spawnSync(process.execPath, ["apps/slack-agent/src/index.js"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MAB_SLACK_VALIDATE_ONLY: "1",
        MAB_VALIDATE_MEETING_AGENT_URL: meetingUrl,
        MAB_MEET_WEBHOOK_LISTEN: "127.0.0.1:0",
        MAB_SLACK_WORKSPACE_DIR: validateOnlyWorkspaceDir,
        MAB_DATA_DIR: pathJoin(dataDir, "validate-only-data"),
        MAB_STATE_PROVIDER: "json-file",
        MAB_SLACK_SOCKET_MODE: "0",
        MAB_SLACK_API_MOCK: "1",
        MAB_SLACK_POSTER_MOCK: "1",
        MAB_DRY_RUN_AGENT: "1",
      },
      encoding: "utf8",
      timeout: 15_000,
    });
    assertSmoke(validateOnly.status === 0, "Slack validate-only process failed", {
      status: validateOnly.status,
      stdout: validateOnly.stdout,
      stderr: validateOnly.stderr,
    });
    const validateOnlyResult = JSON.parse(validateOnly.stdout);
    assertSmoke(
      validateOnlyResult.ok === true,
      "Slack validate-only process returned not ok",
      validateOnlyResult,
    );
    assertSmoke(
      validateOnlyResult.workspace?.created?.includes("AGENTS.md"),
      "Slack validate-only did not bootstrap workspace",
      validateOnlyResult,
    );
    assertSmoke(
      validateOnlyResult.validation?.checks?.some(
        (check) => check.name === "meetd_health" && check.ok === true,
      ),
      "Slack validate-only did not check Meeting Agent health",
      validateOnlyResult,
    );

    const health = await waitForServiceHealth(slack, `${slackUrl}/healthz`);
    assertSmoke(
      health.state?.slackWorkspaceDir === workspaceDir,
      "Slack Agent did not expose workspace dir",
      health,
    );
    assertSmoke(
      health.state?.slackWorkspaceBootstrap?.ok === true,
      "Slack Agent startup workspace bootstrap failed",
      health,
    );
    assertSmoke(
      health.state?.slackWorkspaceBootstrap?.created?.includes("AGENTS.md"),
      "Slack Agent startup did not create AGENTS.md",
      health,
    );
    assertSmoke(
      health.state?.slackWorkspaceBootstrap?.existing?.includes("SOUL.md"),
      "Slack Agent startup overwrote or missed existing SOUL.md",
      health,
    );
    assertSmoke(
      readFileSync(pathJoin(workspaceDir, "SOUL.md"), "utf8") === "custom soul stays\n",
      "workspace bootstrap overwrote existing SOUL.md",
    );

    const firstBootstrap = await postJsonWithStatus(`${slackUrl}/slack/workspace/bootstrap`, {});
    assertSmoke(
      firstBootstrap.httpStatus === 200 && firstBootstrap.ok === true,
      "workspace bootstrap route failed",
      firstBootstrap,
    );
    assertSmoke(
      firstBootstrap.created.length === 0,
      "workspace bootstrap route was not idempotent after startup bootstrap",
      firstBootstrap,
    );
    assertSmoke(
      firstBootstrap.existing.includes("AGENTS.md"),
      "workspace bootstrap route did not report existing AGENTS.md",
      firstBootstrap,
    );
    assertSmoke(
      firstBootstrap.existing.includes("CODEX_GUIDANCE.md"),
      "workspace bootstrap route did not report existing CODEX_GUIDANCE.md",
      firstBootstrap,
    );
    assertSmoke(
      firstBootstrap.existing.includes("docs/slack-patterns.md"),
      "workspace bootstrap route did not report existing Slack pattern docs",
      firstBootstrap,
    );
    assertSmoke(
      firstBootstrap.existing.includes("SOUL.md"),
      "workspace bootstrap overwrote or missed existing SOUL.md",
      firstBootstrap,
    );

    const secondBootstrap = await postJsonWithStatus(`${slackUrl}/slack/workspace/bootstrap`, {});
    assertSmoke(
      secondBootstrap.httpStatus === 200 && secondBootstrap.created.length === 0,
      "workspace bootstrap was not idempotent",
      secondBootstrap,
    );

    const valid = await postJsonWithStatus(`${slackUrl}/slack/validate`, {
      meeting_agent_url: meetingUrl,
      webhook_listen: "127.0.0.1:0",
      require_slack_tokens: false,
    });
    assertSmoke(
      valid.httpStatus === 200 && valid.ok === true,
      "Slack validate-only route failed valid local preflight",
      valid,
    );
    assertSmoke(
      valid.checks.some((check) => check.name === "meetd_health" && check.ok === true),
      "Slack validate-only did not check Meeting Agent health",
      valid,
    );
    assertSmoke(
      valid.checks.some((check) => check.name === "webhook_listen" && check.ok === true),
      "Slack validate-only did not check webhook listen",
      valid,
    );

    const bad = await postJsonWithStatus(`${slackUrl}/slack/validate`, {
      meeting_agent_url: "http://127.0.0.1:9",
      webhook_listen: "127.0.0.1:0",
      require_slack_tokens: false,
    });
    assertSmoke(
      bad.httpStatus === 400 && bad.ok === false,
      "Slack validate-only should fail bad Meeting Agent health",
      bad,
    );

    console.log(
      JSON.stringify(
        {
          ok: true,
          health: health.state,
          validateOnly: validateOnlyResult,
          firstBootstrap,
          secondBootstrap,
          valid,
          bad: {
            httpStatus: bad.httpStatus,
            checks: bad.checks?.map((check) => ({
              name: check.name,
              ok: check.ok,
              status: check.status || 0,
            })),
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

