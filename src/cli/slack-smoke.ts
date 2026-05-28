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

export async function slackSmoke() {
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-slack-"));
  const env = {
    MAB_SLACK_PORT: "18882",
    MAB_MEETING_PORT: "18883",
    MAB_MEETING_AGENT_URL: "http://127.0.0.1:18883",
    MAB_DRY_RUN_AGENT: "1",
    MAB_BROWSER_HEADLESS: "true",
    MAB_DATA_DIR: dataDir,
    SLACK_SIGNING_SECRET: "smoke-signing-secret",
  };
  const meeting = startService("apps/meeting-agent/src/index.js", env);
  const slack = startService("apps/slack-agent/src/index.js", env);

  try {
    await waitForHealth("http://127.0.0.1:18883/healthz");
    await waitForHealth("http://127.0.0.1:18882/healthz");
    const badSignature = await postSignedSlackCommand(
      "http://127.0.0.1:18882/slack/commands/avatar",
      "status",
      { signingSecret: "wrong-secret" },
    );
    assertSmoke(
      badSignature.httpStatus === 401 && badSignature.ok === false,
      "Slack signature verifier accepted a bad signature",
      badSignature,
    );
    const join = await postSignedSlackCommand(
      "http://127.0.0.1:18882/slack/commands/avatar",
      "join https://meet.google.com/abc-defg-hij --avatar hiyori --bot-name SmokeBot",
      { signingSecret: env.SLACK_SIGNING_SECRET },
    );
    const sessionId = join.session?.id;
    const status = await postSignedSlackCommand(
      "http://127.0.0.1:18882/slack/commands/avatar",
      `status ${sessionId}`,
      { signingSecret: env.SLACK_SIGNING_SECRET },
    );
    const delegate = await postSignedSlackCommand(
      "http://127.0.0.1:18882/slack/commands/avatar",
      `delegate --session ${sessionId} Summarize the meeting avatar bot control plane.`,
      { signingSecret: env.SLACK_SIGNING_SECRET },
    );
    const jobs = await postSignedSlackCommand(
      "http://127.0.0.1:18882/slack/commands/avatar",
      "jobs",
      { signingSecret: env.SLACK_SIGNING_SECRET },
    );
    const stop = await postSignedSlackCommand(
      "http://127.0.0.1:18882/slack/commands/avatar",
      `stop ${sessionId} --reason smoke_done`,
      { signingSecret: env.SLACK_SIGNING_SECRET },
    );
    console.log(
      JSON.stringify({ ok: true, badSignature, join, status, delegate, jobs, stop }, null, 2),
    );
  } finally {
    for (const service of [slack, meeting]) service.child.kill("SIGTERM");
    await rm(dataDir, { recursive: true, force: true });
  }
}

