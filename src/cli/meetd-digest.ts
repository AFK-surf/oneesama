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

export async function meetdApiCompatSmoke() {
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-meetd-api-"));
  const port = "18924";
  const baseUrl = `http://127.0.0.1:${port}`;
  const service = startService("apps/meeting-agent/src/index.js", {
    MAB_MEETING_PORT: port,
    MAB_MEETING_AGENT_URL: baseUrl,
    MAB_DATA_DIR: dataDir,
    MAB_DRY_RUN_AGENT: "1",
  });

  try {
    const health = await waitForServiceHealth(service, `${baseUrl}/health`);
    assertSmoke(health.status === "ok", "MeetD compat /health did not match old API", health);

    const create = await postJson(`${baseUrl}/meetings`, {
      event_id: "meetd-compat-event",
      meet_url: "https://meet.google.com/abc-defg-hij",
      title: "MeetD Compat Fixture",
      start_at: "2026-05-12T01:00:00.000Z",
      end_at: "2026-05-12T02:00:00.000Z",
      transcript_text: "Operator: 请验证 MeetD 兼容 API。\nOnee-sama: 收到。",
      captions: [
        {
          speaker: "Operator",
          text: "请验证 MeetD 兼容 API。",
          timestamp: "2026-05-12T01:00:10.000Z",
          source: "live_caption",
        },
        {
          speaker: "Onee-sama",
          text: "收到。",
          timestamp: "2026-05-12T01:00:20.000Z",
          source: "asr",
        },
      ],
    });
    assertSmoke(
      Number(create.meeting_id) > 0,
      "MeetD compat create did not return numeric meeting_id",
      create,
    );

    const duplicate = await postJson(`${baseUrl}/meetings`, {
      event_id: "meetd-compat-event",
      meet_url: "https://meet.google.com/abc-defg-hij",
      title: "MeetD Compat Fixture",
      start_at: "2026-05-12T01:00:00.000Z",
      end_at: "2026-05-12T02:00:00.000Z",
    });
    assertSmoke(
      duplicate.meeting_id === create.meeting_id,
      "MeetD compat create was not idempotent by event_id",
      { create, duplicate },
    );

    const detail = await (await fetch(`${baseUrl}/meetings/${create.meeting_id}`)).json();
    assertSmoke(
      detail.title === "MeetD Compat Fixture",
      "MeetD compat get meeting lost title",
      detail,
    );
    assertSmoke(detail.status === "pending", "MeetD compat new meeting was not pending", detail);

    const list = await (await fetch(`${baseUrl}/meetings?status=pending`)).json();
    assertSmoke(
      list.meetings?.some((meeting) => meeting.id === create.meeting_id),
      "MeetD compat list did not include pending meeting",
      list,
    );

    const liveCaptions = await (
      await fetch(`${baseUrl}/meetings/${create.meeting_id}/captions?limit=1`)
    ).json();
    assertSmoke(
      liveCaptions.source === "live_caption",
      "MeetD compat captions default source changed",
      liveCaptions,
    );
    assertSmoke(
      liveCaptions.returned_captions === 1,
      "MeetD compat captions limit was not honored",
      liveCaptions,
    );
    assertSmoke(
      liveCaptions.speakers.includes("Operator"),
      "MeetD compat captions did not preserve speakers",
      liveCaptions,
    );

    const allCaptions = await (
      await fetch(`${baseUrl}/meetings/${create.meeting_id}/captions?source=all`)
    ).json();
    assertSmoke(
      allCaptions.total_captions === 2,
      "MeetD compat all captions did not include live + asr",
      allCaptions,
    );

    const transcriptResponse = await fetch(
      `${baseUrl}/meetings/${create.meeting_id}/artifacts/transcript`,
    );
    const transcript = await transcriptResponse.text();
    assertSmoke(
      transcriptResponse.status === 200,
      "MeetD compat transcript artifact route failed",
      { status: transcriptResponse.status, transcript },
    );
    assertSmoke(transcript.includes("Onee-sama"), "MeetD compat transcript artifact lost content", {
      transcript,
    });

    const chat = await postJsonWithStatus(`${baseUrl}/meetings/${create.meeting_id}/chat`, {
      text: "fixture chat",
    });
    assertSmoke(
      chat.httpStatus === 404 && chat.error === "no active joiner for this meeting",
      "MeetD compat chat should fail closed without active joiner",
      chat,
    );

    const cancel = await postJson(`${baseUrl}/meetings/${create.meeting_id}/cancel`, {});
    assertSmoke(cancel.status === "cancelled", "MeetD compat cancel failed", cancel);
    const cancelled = await (await fetch(`${baseUrl}/meetings/${create.meeting_id}`)).json();
    assertSmoke(
      cancelled.status === "cancelled",
      "MeetD compat cancel did not persist status",
      cancelled,
    );

    const done = await postJson(`${baseUrl}/meetings`, {
      event_id: "meetd-compat-done-event",
      meet_url: "https://meet.google.com/red-eliv-erx",
      title: "MeetD Done Fixture",
      start_at: "2026-05-12T03:00:00.000Z",
      end_at: "2026-05-12T04:00:00.000Z",
      status: "done",
      result: { summary: { highlights: ["done"] } },
    });
    const redeliver = await postJson(`${baseUrl}/meetings/${done.meeting_id}/redeliver`, {});
    assertSmoke(redeliver.status === "redelivered", "MeetD compat redeliver failed", redeliver);
    const resummarize = await postJson(`${baseUrl}/meetings/${done.meeting_id}/resummarize`, {});
    assertSmoke(
      resummarize.status === "resummarizing",
      "MeetD compat resummarize failed",
      resummarize,
    );

    console.log(
      JSON.stringify(
        {
          ok: true,
          health,
          meetingId: create.meeting_id,
          duplicate,
          detail,
          listCount: list.meetings?.length || 0,
          liveCaptions,
          allCaptions,
          chat,
          cancel,
          redeliver,
          resummarize,
        },
        null,
        2,
      ),
    );
  } finally {
    service.child.kill("SIGTERM");
    await rm(dataDir, { recursive: true, force: true });
  }
}

export async function meetdRuntimeStoreSmoke() {
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-meetd-runtime-"));
  const port = "18947";
  const baseUrl = `http://127.0.0.1:${port}`;
  const service = startService("apps/meeting-agent/src/index.js", {
    MAB_MEETING_PORT: port,
    MAB_MEETING_AGENT_URL: baseUrl,
    MAB_DATA_DIR: dataDir,
    MAB_STATE_PROVIDER: "json-file",
    MAB_DRY_RUN_AGENT: "1",
  });

  const now = new Date("2026-05-12T10:00:00.000Z");
  const iso = (offsetMs) => new Date(now.getTime() + offsetMs).toISOString();

  try {
    const health = await waitForServiceHealth(service, `${baseUrl}/healthz`);
    assertSmoke(
      health.state?.meetdRuntime?.pending === 0,
      "MeetD runtime health did not expose empty pending count",
      health,
    );

    const ready = await postJson(`${baseUrl}/meetings`, {
      event_id: "runtime-ready-event",
      meet_url: "https://meet.google.com/runtime-ready",
      title: "Runtime Ready",
      start_at: iso(5_000),
      end_at: iso(60 * 60 * 1000),
      slack_channel_id: "C_RUNTIME",
      slack_thread_ts: "1770000000.000001",
    });
    assertSmoke(
      Number(ready.meeting_id) > 0 && ready.created === true,
      "MeetD runtime ready meeting was not created",
      ready,
    );

    const duplicateEvent = await postJson(`${baseUrl}/meetings`, {
      event_id: "runtime-ready-event",
      meet_url: "https://meet.google.com/runtime-ready",
      title: "Runtime Ready Duplicate",
      start_at: iso(5_000),
      end_at: iso(60 * 60 * 1000),
    });
    assertSmoke(
      duplicateEvent.meeting_id === ready.meeting_id && duplicateEvent.idempotent === "event_id",
      "MeetD runtime store did not de-dupe by event_id",
      { ready, duplicateEvent },
    );

    const duplicateUrl = await postJson(`${baseUrl}/meetings`, {
      event_id: "runtime-ready-other-event",
      meet_url: "https://meet.google.com/runtime-ready",
      title: "Runtime Ready URL Duplicate",
      start_at: iso(2 * 60 * 1000),
      end_at: iso(62 * 60 * 1000),
    });
    assertSmoke(
      duplicateUrl.meeting_id === ready.meeting_id &&
        duplicateUrl.idempotent === "meet_url_start_window",
      "MeetD runtime store did not de-dupe active URL/start window",
      { ready, duplicateUrl },
    );

    const future = await postJson(`${baseUrl}/meetings`, {
      event_id: "runtime-future-event",
      meet_url: "https://meet.google.com/runtime-future",
      title: "Runtime Future",
      start_at: iso(10 * 60 * 1000),
      end_at: iso(70 * 60 * 1000),
    });
    const missed = await postJson(`${baseUrl}/meetings`, {
      event_id: "runtime-missed-event",
      meet_url: "https://meet.google.com/runtime-missed",
      title: "Runtime Missed",
      start_at: iso(-10 * 60 * 1000),
      end_at: iso(50 * 60 * 1000),
    });
    const active = await postJson(`${baseUrl}/meetings`, {
      event_id: "runtime-active-event",
      meet_url: "https://meet.google.com/runtime-active",
      title: "Runtime Active",
      start_at: iso(-30_000),
      end_at: iso(50 * 60 * 1000),
      status: "active",
    });
    const processing = await postJson(`${baseUrl}/meetings`, {
      event_id: "runtime-processing-event",
      meet_url: "https://meet.google.com/runtime-processing",
      title: "Runtime Processing",
      start_at: iso(-30_000),
      end_at: iso(50 * 60 * 1000),
      status: "processing",
    });

    const statusBefore = await (await fetch(`${baseUrl}/meetings/runtime/status`)).json();
    assertSmoke(
      statusBefore.counts.pending === 3,
      "MeetD runtime status should see ready/future/missed pending",
      statusBefore,
    );
    assertSmoke(
      statusBefore.counts.active === 1,
      "MeetD runtime status should see one active meeting",
      statusBefore,
    );
    assertSmoke(
      statusBefore.counts.processing === 1,
      "MeetD runtime status should see one processing meeting",
      statusBefore,
    );

    const tick = await postJson(`${baseUrl}/meetings/runtime/tick`, {
      now: now.toISOString(),
      stale_ms: -1,
      dry_run_joiner: true,
    });
    assertSmoke(tick.ok === true, "MeetD runtime tick failed", tick);
    assertSmoke(
      tick.ready.some(
        (item) =>
          item.meeting_id === ready.meeting_id &&
          item.action === "join_planned" &&
          item.status === "joining",
      ),
      "MeetD runtime did not claim ready meeting for join",
      tick.ready,
    );
    assertSmoke(
      tick.ready.some(
        (item) =>
          item.meeting_id === future.meeting_id &&
          item.action === "not_ready" &&
          item.status === "pending",
      ),
      "MeetD runtime did not leave future meeting pending",
      tick.ready,
    );
    assertSmoke(
      tick.ready.some(
        (item) =>
          item.meeting_id === missed.meeting_id &&
          item.action === "cancelled" &&
          item.status === "cancelled",
      ),
      "MeetD runtime did not cancel missed start-window meeting",
      tick.ready,
    );
    assertSmoke(
      tick.cleaned.some(
        (meeting) =>
          meeting.id === active.meeting_id &&
          meeting.status === "failed" &&
          meeting.error === "daemon restart",
      ),
      "MeetD runtime stale cleanup did not fail old active meeting",
      tick.cleaned,
    );
    assertSmoke(
      tick.recovered.some(
        (meeting) =>
          meeting.id === processing.meeting_id &&
          meeting.status === "processing" &&
          meeting.recovery_requested === true,
      ),
      "MeetD runtime did not mark processing meeting for recovery",
      tick.recovered,
    );

    const readyDetail = await (await fetch(`${baseUrl}/meetings/${ready.meeting_id}`)).json();
    const futureDetail = await (await fetch(`${baseUrl}/meetings/${future.meeting_id}`)).json();
    const missedDetail = await (await fetch(`${baseUrl}/meetings/${missed.meeting_id}`)).json();
    const activeDetail = await (await fetch(`${baseUrl}/meetings/${active.meeting_id}`)).json();
    const processingDetail = await (
      await fetch(`${baseUrl}/meetings/${processing.meeting_id}`)
    ).json();
    assertSmoke(
      readyDetail.status === "joining",
      "MeetD runtime ready detail did not persist joining",
      readyDetail,
    );
    assertSmoke(
      futureDetail.status === "pending",
      "MeetD runtime future detail did not persist pending",
      futureDetail,
    );
    assertSmoke(
      missedDetail.status === "cancelled",
      "MeetD runtime missed detail did not persist cancelled",
      missedDetail,
    );
    assertSmoke(
      activeDetail.status === "failed" && activeDetail.error === "daemon restart",
      "MeetD runtime stale detail did not persist failed",
      activeDetail,
    );
    assertSmoke(
      processingDetail.recovery_requested === true,
      "MeetD runtime processing recovery flag did not persist",
      processingDetail,
    );

    const statusAfter = await (await fetch(`${baseUrl}/meetings/runtime/status`)).json();
    assertSmoke(
      statusAfter.counts.joining === 1,
      "MeetD runtime status after tick should count joining",
      statusAfter,
    );
    assertSmoke(
      statusAfter.counts.pending === 1,
      "MeetD runtime status after tick should keep one future pending",
      statusAfter,
    );
    assertSmoke(
      statusAfter.counts.cancelled === 1,
      "MeetD runtime status after tick should count cancelled",
      statusAfter,
    );
    assertSmoke(
      statusAfter.counts.failed === 1,
      "MeetD runtime status after tick should count failed",
      statusAfter,
    );

    console.log(
      JSON.stringify(
        {
          ok: true,
          health: health.state.meetdRuntime,
          ready,
          duplicateEvent,
          duplicateUrl,
          tick,
          statusAfter: statusAfter.counts,
        },
        null,
        2,
      ),
    );
  } finally {
    service.child.kill("SIGTERM");
    await rm(dataDir, { recursive: true, force: true });
  }
}

export async function digestWebhookSmoke() {
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-digest-webhook-"));
  const receiverPort = 18925;
  const meetingPort = 18926;
  const slackPort = 18927;
  const secret = "digest-webhook-smoke-secret";
  const received = [];
  let slack = null;
  const receiver = createJsonServer({
    name: "digest-webhook-smoke-receiver",
    port: receiverPort,
    routes: {
      "POST /digest": ({ req, rawBody, body }) => {
        const headerValue = req.headers["x-webhook-signature"];
        const signature = Array.isArray(headerValue) ? headerValue[0] || "" : headerValue || "";
        const signatureValid = verifyDigestWebhookSignature(rawBody, signature, secret);
        received.push({
          signatureValid,
          event: body.event,
          meetingId: body.meeting_id,
          title: body.title,
          transcript: body.transcript || "",
          chatTranscript: body.chat_transcript || "",
        });
        if (received.length === 1)
          return { status: 503, body: { ok: false, error: "intentional_retry_probe" } };
        return { ok: true, count: received.length };
      },
      "GET /received": () => ({ ok: true, received }),
    },
  });
  await receiver.listen();
  const meeting = startService("apps/meeting-agent/src/index.js", {
    MAB_MEETING_PORT: String(meetingPort),
    MAB_MEETING_AGENT_URL: `http://127.0.0.1:${meetingPort}`,
    MAB_DATA_DIR: dataDir,
    MAB_DIGEST_WEBHOOK_URL: `http://127.0.0.1:${receiverPort}/digest`,
    MAB_DIGEST_WEBHOOK_SECRET: secret,
    MAB_DIGEST_WEBHOOK_MAX_ATTEMPTS: "3",
    MAB_DIGEST_WEBHOOK_RETRY_DELAY_MS: "5",
    MAB_DRY_RUN_AGENT: "1",
  });

  try {
    await waitForServiceHealth(meeting, `http://127.0.0.1:${meetingPort}/healthz`);
    const done = await postJson(`http://127.0.0.1:${meetingPort}/meetings`, {
      event_id: "digest-webhook-result",
      meet_url: "https://meet.google.com/dig-esth-mac",
      title: "Digest Webhook Smoke",
      start_at: "2026-05-12T05:00:00.000Z",
      end_at: "2026-05-12T06:00:00.000Z",
      status: "done",
      result: { summary: { highlights: ["webhook redeliver"] } },
    });
    const redeliver = await postJson(
      `http://127.0.0.1:${meetingPort}/meetings/${done.meeting_id}/redeliver`,
      {},
    );
    assertSmoke(
      redeliver.status === "redelivered",
      "digest webhook redeliver did not report redelivered",
      redeliver,
    );
    assertSmoke(
      redeliver.webhook?.attempts === 2,
      "digest webhook redeliver did not retry after transient failure",
      redeliver,
    );
    assertSmoke(
      received.length === 2 && received.every((item) => item.signatureValid),
      "digest webhook receiver did not verify HMAC signatures",
      received,
    );
    assertSmoke(
      received.at(-1)?.event === "meeting.result",
      "digest webhook redeliver sent wrong event",
      received,
    );

    const digest = await postJson(
      `http://127.0.0.1:${meetingPort}/meetings/${done.meeting_id}/digest`,
      {
        transcript: "Operator: 继续迁移 MeetD digest webhook。",
        chat_transcript: "Operator: 看日志，别乱来。",
        time_from: "2026-05-12T05:10:00.000Z",
        time_to: "2026-05-12T05:15:00.000Z",
      },
    );
    assertSmoke(
      digest.status === "digest_delivered",
      "digest webhook live digest delivery failed",
      digest,
    );
    assertSmoke(
      received.at(-1)?.event === "meeting.digest",
      "digest webhook digest route sent wrong event",
      received,
    );
    assertSmoke(
      received.at(-1)?.transcript.includes("MeetD digest webhook"),
      "digest webhook payload lost transcript",
      received.at(-1),
    );

    const listed = await (await fetch(`http://127.0.0.1:${receiverPort}/received`)).json();
    assertSmoke(
      listed.received.length === 3,
      "digest webhook receiver did not record all attempts",
      listed,
    );

    slack = startService("apps/slack-agent/src/index.js", {
      MAB_SLACK_PORT: String(slackPort),
      MAB_DATA_DIR: dataDir,
      MAB_DIGEST_WEBHOOK_SECRET: secret,
      MAB_SLACK_POSTER_MOCK: "1",
      MAB_SLACK_API_MOCK: "1",
      MAB_DRY_RUN_AGENT: "1",
    });
    await waitForServiceHealth(slack, `http://127.0.0.1:${slackPort}/healthz`);
    const sendSlackWebhook = async (payload) => {
      const raw = JSON.stringify(payload);
      const response = await fetch(`http://127.0.0.1:${slackPort}/webhooks/meeting-digest`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-webhook-signature": computeDigestWebhookSignature(raw, secret),
        },
        body: raw,
      });
      return { httpStatus: response.status, ...(await response.json()) };
    };
    const slackPayload = JSON.stringify({
      event: "meeting.digest",
      meeting_id: done.meeting_id,
      title: "Digest Webhook Smoke",
      transcript: "Slack Agent receiver should verify this signature.",
    });
    const invalidSlackReceiver = await fetch(
      `http://127.0.0.1:${slackPort}/webhooks/meeting-digest`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-webhook-signature": "00" },
        body: slackPayload,
      },
    );
    assertSmoke(
      invalidSlackReceiver.status === 401,
      "Slack Agent digest receiver accepted bad HMAC",
      { status: invalidSlackReceiver.status },
    );
    const validSlackReceiver = await fetch(
      `http://127.0.0.1:${slackPort}/webhooks/meeting-digest`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-webhook-signature": computeDigestWebhookSignature(slackPayload, secret),
        },
        body: slackPayload,
      },
    );
    const validSlackBody = await validSlackReceiver.json();
    assertSmoke(
      validSlackReceiver.status === 202 &&
        validSlackBody.ok === true &&
        validSlackBody.delivery?.copilotQueued === false &&
        validSlackBody.delivery?.skippedReason === "meeting_copilot_disabled_realtime_foreground",
      "Slack Agent digest receiver rejected valid HMAC or failed to disable legacy copilot digest",
      validSlackBody,
    );

    const slackRef = { channel_id: "C_MEET_WEBHOOK", thread_ts: "1715600000.000100" };
    const joinedDelivery = await sendSlackWebhook({
      event: "meeting.joined",
      meeting_id: done.meeting_id,
      title: "Digest Webhook Smoke",
      slack_ref: slackRef,
    });
    assertSmoke(
      joinedDelivery.httpStatus === 200 && joinedDelivery.ok === true,
      "Slack Agent joined webhook failed",
      joinedDelivery,
    );
    assertSmoke(
      joinedDelivery.delivery?.post?.mock === true,
      "Slack Agent joined webhook did not post joined notice",
      joinedDelivery,
    );

    const joinedStatus = await (
      await fetch(`http://127.0.0.1:${slackPort}/slack/assistant/status`)
    ).json();
    assertSmoke(
      joinedStatus.threads.some((thread) => thread.lastStatus === "Recording meeting..."),
      "Slack Agent joined webhook did not set Recording meeting assistant status",
      joinedStatus,
    );

    const processingDelivery = await sendSlackWebhook({
      event: "meeting.processing",
      meeting_id: done.meeting_id,
      title: "Digest Webhook Smoke",
    });
    assertSmoke(
      processingDelivery.httpStatus === 200 && processingDelivery.ok === true,
      "Slack Agent processing webhook failed",
      processingDelivery,
    );
    assertSmoke(
      processingDelivery.delivery?.slackRef?.source === "meeting_thread",
      "Slack Agent processing webhook did not resolve stored meeting thread",
      processingDelivery,
    );
    const processingStatus = await (
      await fetch(`http://127.0.0.1:${slackPort}/slack/assistant/status`)
    ).json();
    assertSmoke(
      processingStatus.threads.some(
        (thread) => thread.lastStatus === "Generating meeting summary...",
      ),
      "Slack Agent processing webhook did not set Generating meeting summary assistant status",
      processingStatus,
    );

    const resultPayload = {
      event: "meeting.result",
      meeting_id: done.meeting_id,
      title: "Digest Webhook Smoke",
      status: "done",
      summary: {
        title: "Digest Webhook Smoke",
        attendees: ["Operator", "Onee-sama"],
        duration_minutes: 12,
        key_points: ["Slack-side webhook delivery works."],
        decisions: ["Keep HMAC verification before delivery."],
        action_items: [{ description: "Review task #121", owner: "Operator" }],
      },
      artifacts: {
        transcript_path: "/tmp/digest-webhook-transcript.txt",
        audio_path: "/tmp/digest-webhook-audio.wav",
      },
    };
    const resultDelivery = await sendSlackWebhook(resultPayload);
    assertSmoke(
      resultDelivery.httpStatus === 202 && resultDelivery.ok === true,
      "Slack Agent result webhook failed",
      resultDelivery,
    );
    assertSmoke(
      resultDelivery.delivery?.slackRef?.source === "meeting_thread",
      "Slack Agent result webhook did not resolve stored meeting thread",
      resultDelivery,
    );
    assertSmoke(
      resultDelivery.delivery?.published?.slack?.mock === true,
      "Slack Agent result webhook did not publish Slack summary",
      resultDelivery,
    );
    assertSmoke(
      resultDelivery.delivery?.delivery?.status === "processed",
      "Slack Agent result webhook did not confirm durable delivery",
      resultDelivery,
    );

    const duplicateDelivery = await sendSlackWebhook(resultPayload);
    assertSmoke(
      duplicateDelivery.httpStatus === 202 && duplicateDelivery.delivery?.duplicate === true,
      "Slack Agent duplicate result webhook did not dedupe",
      duplicateDelivery,
    );

    const failedDelivery = await sendSlackWebhook({
      event: "meeting.result",
      meeting_id: Number(done.meeting_id) + 1,
      title: "Failed Digest Webhook Smoke",
      status: "failed",
      error: "join failed",
      slack_ref: slackRef,
    });
    assertSmoke(
      failedDelivery.httpStatus === 202 && failedDelivery.ok === true,
      "Slack Agent failed result webhook did not accept failure payload",
      failedDelivery,
    );
    assertSmoke(
      failedDelivery.delivery?.post?.sourceText?.includes("join failed"),
      "Slack Agent failed result webhook did not post failure text",
      failedDelivery,
    );

    const slackReceived = await (
      await fetch(`http://127.0.0.1:${slackPort}/webhooks/meeting-digest`)
    ).json();
    assertSmoke(
      slackReceived.webhooks.length === 6,
      "Slack Agent digest receiver did not record verified webhook state transitions",
      slackReceived,
    );

    console.log(
      JSON.stringify(
        {
          ok: true,
          redeliver,
          digest,
          received: listed.received,
          slackReceiver: slackReceived,
          joinedDelivery,
          processingDelivery,
          resultDelivery,
          duplicateDelivery,
          failedDelivery,
        },
        null,
        2,
      ),
    );
  } finally {
    if (slack) slack.child.kill("SIGTERM");
    meeting.child.kill("SIGTERM");
    await new Promise((resolve) => receiver.server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
}

export async function meetingCopilotSmoke() {
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-meeting-copilot-"));
  const slackPort = 18928;
  const secret = "meeting-copilot-smoke-secret";
  const slack = startService("apps/slack-agent/src/index.js", {
    MAB_SLACK_PORT: String(slackPort),
    MAB_DATA_DIR: dataDir,
    MAB_DIGEST_WEBHOOK_SECRET: secret,
    MAB_SLACK_POSTER_MOCK: "1",
    MAB_SLACK_API_MOCK: "1",
    MAB_AGENT_RUNNER: "codex-app-server",
    MAB_DRY_RUN_CODEX: "1",
  });
  const sendSlackWebhook = async (payload) => {
    const raw = JSON.stringify(payload);
    const response = await fetch(`http://127.0.0.1:${slackPort}/webhooks/meeting-digest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-webhook-signature": computeDigestWebhookSignature(raw, secret),
      },
      body: raw,
    });
    return { httpStatus: response.status, ...(await response.json()) };
  };

  try {
    await waitForServiceHealth(slack, `http://127.0.0.1:${slackPort}/healthz`);
    const meetingId = 4242;
    const firstDigest = await sendSlackWebhook({
      event: "meeting.digest",
      meeting_id: meetingId,
      title: "Meeting Copilot Smoke",
      transcript: ["Operator: Onee-sama，帮我记一下这个决定。", "Onee-sama: 收到。"].join("\n"),
      chat_transcript: "Operator: 这个链接也记一下 https://example.com/demo",
      time_from: "2026-05-12T02:00:00.000Z",
      time_to: "2026-05-12T02:05:00.000Z",
      copilot_effects: [{ type: "meeting_chat", text: "收到，我会记录这个决定。" }],
    });
    assertSmoke(
      firstDigest.httpStatus === 202 &&
        firstDigest.delivery?.copilotQueued === false &&
        firstDigest.delivery?.skippedReason === "meeting_copilot_disabled_realtime_foreground",
      "meeting copilot digest was not disabled for realtime foreground ownership",
      firstDigest,
    );

    const duplicateDigest = await sendSlackWebhook({
      event: "meeting.digest",
      meeting_id: meetingId,
      title: "Meeting Copilot Smoke",
      transcript: ["Operator: Onee-sama，帮我记一下这个决定。", "Onee-sama: 收到。"].join("\n"),
      chat_transcript: "Operator: 这个链接也记一下 https://example.com/demo",
      time_from: "2026-05-12T02:00:00.000Z",
      time_to: "2026-05-12T02:05:00.000Z",
    });
    assertSmoke(
      duplicateDigest.httpStatus === 202 &&
        duplicateDigest.delivery?.copilotQueued === false &&
        duplicateDigest.delivery?.skippedReason === "meeting_copilot_disabled_realtime_foreground",
      "meeting copilot duplicate digest was not disabled",
      duplicateDigest,
    );

    const cooldownDigest = await sendSlackWebhook({
      event: "meeting.digest",
      meeting_id: meetingId,
      title: "Meeting Copilot Smoke",
      transcript: [
        "Operator: Onee-sama，帮我记一下这个决定。",
        "Onee-sama: 收到。",
        "Operator: 嗯，继续。",
      ].join("\n"),
      chat_transcript: "Operator: 这个链接也记一下 https://example.com/demo",
      time_from: "2026-05-12T02:05:00.000Z",
      time_to: "2026-05-12T02:06:00.000Z",
    });
    assertSmoke(
      cooldownDigest.delivery?.copilotQueued === false &&
        cooldownDigest.delivery?.skippedReason === "meeting_copilot_disabled_realtime_foreground",
      "meeting copilot chatter digest was not disabled",
      cooldownDigest,
    );

    const followUpDigest = await sendSlackWebhook({
      event: "meeting.digest",
      meeting_id: meetingId,
      title: "Meeting Copilot Smoke",
      transcript: [
        "Operator: Onee-sama，帮我记一下这个决定。",
        "Onee-sama: 收到。",
        "Operator: 嗯，继续。",
        "Operator: bot 能不能同步一下结论？",
      ].join("\n"),
      chat_transcript: "Operator: 这个链接也记一下 https://example.com/demo",
      time_from: "2026-05-12T02:06:00.000Z",
      time_to: "2026-05-12T02:08:00.000Z",
    });
    assertSmoke(
      followUpDigest.delivery?.copilotQueued === false &&
        followUpDigest.delivery?.skippedReason === "meeting_copilot_disabled_realtime_foreground",
      "meeting copilot explicit follow-up digest was not disabled",
      followUpDigest,
    );

    const resultDelivery = await sendSlackWebhook({
      event: "meeting.result",
      meeting_id: meetingId,
      title: "Meeting Copilot Smoke",
      status: "failed",
      error: "smoke ended",
      slack_ref: { channel_id: "C_MEET_COPILOT", thread_ts: "1715600000.000200" },
    });
    assertSmoke(
      resultDelivery.httpStatus === 202 && resultDelivery.delivery?.copilotStop?.stopped === true,
      "meeting result did not stop copilot runner",
      resultDelivery,
    );

    const status = await (
      await fetch(`http://127.0.0.1:${slackPort}/webhooks/meeting-copilot/status`)
    ).json();
    const state = status.states.find((entry) => String(entry.meetingId) === String(meetingId));
    assertSmoke(
      state?.stopped === true,
      "meeting copilot status did not retain stopped state",
      status,
    );
    assertSmoke(
      !state?.priorActions?.length,
      "disabled meeting copilot should not retain actions",
      status,
    );
    assertSmoke(
      !state?.runs?.length,
      "disabled meeting copilot should not record queued runs",
      status,
    );

    console.log(
      JSON.stringify(
        {
          ok: true,
          firstDigest,
          duplicateDigest,
          cooldownDigest,
          followUpDigest,
          resultDelivery,
          status,
        },
        null,
        2,
      ),
    );
  } finally {
    slack.child.kill("SIGTERM");
    await rm(dataDir, { recursive: true, force: true });
  }
}

