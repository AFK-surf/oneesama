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

export async function localAgentDialogSmoke() {
  const config = getRuntimeConfig();
  const provider = process.env.MAB_AGENT_RUNNER || "command";
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-local-dialog-"));
  const commandScript = pathJoin(dataDir, "dialog-agent-runner.mjs");
  await writeFile(
    commandScript,
    `
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const job = JSON.parse(input);
  console.log(JSON.stringify({
    status: "completed",
    result: "本地 Agent provider 已处理：" + job.task,
  }));
});
`,
    "utf8",
  );
  const env = {
    MAB_MEETING_PORT: "18895",
    MAB_MEETING_AGENT_URL: "http://127.0.0.1:18895",
    MAB_BROWSER_HEADLESS: "true",
    MAB_DATA_DIR: dataDir,
    MAB_AGENT_RUNNER: provider,
    MAB_DRY_RUN_AGENT: config.dryRunAgent ? "1" : "",
    MAB_AGENT_COMMAND:
      provider === "command" ? `${process.execPath} ${commandScript}` : config.agentCommand,
    MAB_AGENT_HTTP_URL: config.agentHttpUrl,
    MAB_CODEX_BIN: config.codexBin,
    MAB_CODEX_MODEL: config.codexModel,
    MAB_STT_PROVIDER: "event",
    MAB_TTS_PROVIDER: "tone-wav",
  };
  const fixture = await startLocalMeetFixtureServer();
  const meeting = startService("apps/meeting-agent/src/index.js", env);
  try {
    await waitForHealth("http://127.0.0.1:18895/healthz");
    const utterance = "请用一句话说明本地 Agent provider 已接入会议。";
    const join = await postJson("http://127.0.0.1:18895/join/google-meet", {
      sessionId: "local_agent_dialog_smoke",
      meetUrl: `${fixture.url}?participantAudio=1`,
      botName: "Local Dialog Bot",
      dryRun: false,
      allowNonGoogleMeet: true,
      collectFixtureState: true,
      disableLive2D: true,
      installRealtimeBridge: false,
      installWorkerResultBridge: false,
      installLocalDialogBridge: true,
      localDialogTtsMode: "server",
      localDialogTtsUrl: "http://127.0.0.1:18895/tts/synthesize",
      localDialogSttProvider: "event",
      localDialogTtsProvider: "tone-wav",
      localDialogTtsGain: 0.42,
      localDialogAcceptanceUtterance: utterance,
    });
    assertSmoke(
      join.result?.fixtureState?.joined === true,
      "local dialog smoke did not join fixture",
      join,
    );

    const status = await waitForJoinStatus(
      "http://127.0.0.1:18895/join/status",
      (body) => {
        const dialog = body.active?.localDialog;
        const avatar = body.active?.avatarReady?.avatarState;
        const audio = body.active?.avatarAudio;
        return (
          dialog?.turns?.some((turn) => {
            const responseText = String(turn.responseText || "");
            return (
              turn.status === "completed" &&
              turn.job?.provider === provider &&
              responseText.trim().length > 0 &&
              (provider !== "command" || responseText.includes("本地 Agent provider"))
            );
          }) &&
          dialog?.tts?.routedToAvatarBus === true &&
          (audio?.injectedTones > 0 || audio?.routedBuffers > 0) &&
          avatar?.updates?.some((update) => update.kind === "action" && update.action === "speak")
        );
      },
      12_000,
    );
    const workerJobs = await (await fetch("http://127.0.0.1:18895/worker/jobs")).json();
    const turn = status.active?.localDialog?.lastTurn;
    assertSmoke(
      turn?.job?.provider === provider,
      "local dialog did not use the selected provider",
      { expected: provider, turn },
    );
    assertSmoke(
      turn?.tts?.ok === true,
      "local dialog TTS did not route into the avatar fake mic bus",
      turn,
    );
    assertSmoke(
      status.active?.avatarAudio?.routedBuffers >= 1,
      "local dialog server TTS did not route a decoded audio buffer into the avatar fake mic",
      status.active?.avatarAudio,
    );
    assertSmoke(
      workerJobs.jobs?.some((job) => job.id === turn.job.id),
      "local dialog job was not recorded for reporting",
      workerJobs,
    );
    const stop = await postJson("http://127.0.0.1:18895/join/stop", {
      reason: "local_agent_dialog_smoke_done",
    });
    assertSmoke(stop.ok === true, "local dialog stop failed", stop);
    console.log(JSON.stringify({ ok: true, join, status, workerJobs, stop }, null, 2));
  } finally {
    await postJson("http://127.0.0.1:18895/join/stop", {
      reason: "local_agent_dialog_cleanup",
    }).catch(() => {});
    meeting.child.kill("SIGTERM");
    await fixture.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

export async function captionLocalDialogSmoke() {
  const { chromium } = await import("playwright");
  const port = 18884;
  const server = createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
<html>
  <body>
    <div role="region" aria-label="Captions" id="captions" style="padding:20px;border:1px solid #ddd"></div>
  </body>
</html>`);
      return;
    }
    if (req.method === "POST" && req.url === "/dialog/turn") {
      let body = "";
      req.setEncoding("utf8");
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body || "{}");
      const utterance = String(parsed.utterance || "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          status: "completed",
          provider: "caption-smoke",
          responseText: `收到字幕:${utterance}`,
          job: {
            id: "job_caption_smoke",
            provider: "caption-smoke",
            status: "completed",
            result: `收到字幕:${utterance}`,
          },
        }),
      );
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  });
  await new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve());
  });

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript({
      content: `
window.MAB_AVATAR_AUDIO_BUS = {
  injectTone() { return { ok: true, durationMs: 800 }; },
  playAudioDataUrl() { return Promise.resolve({ ok: true, durationMs: 800 }); },
};
window.MAB_AVATAR_CONTROLLER = {
  updateState(update) { return { ok: true, update }; },
};
`,
    });
    await context.addInitScript({
      content: buildLocalDialogInitScript({
        enabled: true,
        sessionId: "caption_local_dialog_smoke",
        turnUrl: `http://127.0.0.1:${port}/dialog/turn`,
        ttsMode: "tone",
        sttProvider: "caption",
        ttsProvider: "browser-tone",
        botName: "Caption Smoke Bot",
      }),
    });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    const capture = await installMeetCaptionCapture(page, {});
    await page.evaluate(
      ({ speaker, text }) => {
        const root = document.getElementById("captions");
        const entry = document.createElement("div");
        entry.style.padding = "8px";
        const speakerNode = document.createElement("div");
        speakerNode.className = "NWpY1d";
        speakerNode.textContent = speaker;
        const textNode = document.createElement("div");
        textNode.className = "ygicle";
        textNode.textContent = text;
        entry.appendChild(speakerNode);
        entry.appendChild(textNode);
        root.appendChild(entry);
      },
      { speaker: "Peng", text: "你好，这是测试字幕" },
    );
    await page.waitForFunction(
      () => {
        const dialog = window.MAB_LOCAL_DIALOG as
          | {
              utterancesReceived?: number;
              lastTurn?: { status?: string };
            }
          | null
          | undefined;
        return dialog?.utterancesReceived === 1 && dialog?.lastTurn?.status === "completed";
      },
      null,
      { timeout: 5_000 },
    );
    interface DialogTurnSnapshot {
      utterancesReceived?: number;
      lastTurn?: {
        status?: string;
        responseText?: string;
        tts?: { ok?: boolean; [key: string]: unknown };
        [key: string]: unknown;
      };
      [key: string]: unknown;
    }
    const first = (await page.evaluate(() => window.MAB_LOCAL_DIALOG)) as DialogTurnSnapshot | null;
    assertSmoke(
      String(first?.lastTurn?.responseText || "").includes("测试字幕"),
      "caption local dialog smoke did not preserve the caption text in the agent response",
      first,
    );
    assertSmoke(
      first?.lastTurn?.tts?.ok === true,
      "caption local dialog smoke did not route TTS",
      first?.lastTurn,
    );

    await page.evaluate(
      ({ speaker, text }) => {
        const root = document.getElementById("captions");
        const entry = document.createElement("div");
        entry.style.padding = "8px";
        const speakerNode = document.createElement("div");
        speakerNode.className = "NWpY1d";
        speakerNode.textContent = speaker;
        const textNode = document.createElement("div");
        textNode.className = "ygicle";
        textNode.textContent = text;
        entry.appendChild(speakerNode);
        entry.appendChild(textNode);
        root.appendChild(entry);
      },
      { speaker: "Caption Smoke Bot", text: "这条不该自激" },
    );
    await page.waitForTimeout(1_000);
    const second = await page.evaluate(() => ({
      dialog: window.MAB_LOCAL_DIALOG,
      capture: window.MAB_CAPTION_CAPTURE,
    }));
    assertSmoke(
      second.dialog?.utterancesReceived === 1,
      "caption local dialog smoke forwarded the bot's own caption and would self-loop",
      second,
    );

    console.log(
      JSON.stringify(
        {
          ok: true,
          install: capture.install,
          firstTurn: first.lastTurn,
          finalUtterances: second.dialog?.utterancesReceived || 0,
          latestCaption: second.capture?.latest || null,
        },
        null,
        2,
      ),
    );
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

export async function realLocalDialogSmoke() {
  const config = getRuntimeConfig();
  const meetUrl = process.env.MAB_REAL_MEET_URL || "";
  if (!meetUrl) {
    const skipped = {
      ok: true,
      skipped: true,
      reason: "MAB_REAL_MEET_URL missing",
      note: "Set MAB_REAL_MEET_URL and MAB_REQUIRE_REAL_LOCAL_DIALOG=1 to make this optional smoke mandatory.",
    };
    if (process.env.MAB_REQUIRE_REAL_LOCAL_DIALOG === "1") {
      assertSmoke(
        false,
        "MAB_REAL_MEET_URL is required when MAB_REQUIRE_REAL_LOCAL_DIALOG=1",
        skipped,
      );
    }
    console.log(JSON.stringify(skipped, null, 2));
    return;
  }
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-real-local-dialog-"));
  const env = {
    MAB_MEETING_PORT: "18896",
    MAB_MEETING_AGENT_URL: "http://127.0.0.1:18896",
    MAB_BROWSER_HEADLESS: "true",
    MAB_DATA_DIR: dataDir,
    MAB_AGENT_RUNNER: config.agentRunner,
    MAB_DRY_RUN_AGENT: config.dryRunAgent ? "1" : "",
    MAB_AGENT_COMMAND: config.agentCommand,
    MAB_AGENT_HTTP_URL: config.agentHttpUrl,
    MAB_CODEX_BIN: config.codexBin,
    MAB_CODEX_MODEL: config.codexModel,
    MAB_STT_PROVIDER: config.sttProvider,
    MAB_TTS_PROVIDER: config.ttsProvider,
    MAB_TTS_COMMAND: config.ttsCommand,
    MAB_TTS_HTTP_URL: config.ttsHttpUrl,
  };
  const meeting = startService("apps/meeting-agent/src/index.js", env);
  try {
    await waitForHealth("http://127.0.0.1:18896/healthz");
    const join = await postJson("http://127.0.0.1:18896/join/google-meet", {
      sessionId: "real_local_dialog_smoke",
      meetUrl,
      botName: "Local Dialog Bot",
      dryRun: false,
      collectFixtureState: false,
      disableLive2D: true,
      installRealtimeBridge: false,
      installWorkerResultBridge: false,
      installLocalDialogBridge: true,
      localDialogTtsMode: "server",
      localDialogTtsUrl: "http://127.0.0.1:18896/tts/synthesize",
      localDialogSttProvider: config.sttProvider,
      localDialogTtsProvider: config.ttsProvider,
      localDialogTtsGain: 0.35,
      localDialogAcceptanceUtterance: "请用一句话说明你已经通过本地 Agent provider 接入会议。",
    });
    assertSmoke(
      join.result?.clickedJoinSelector,
      "real local dialog smoke did not click a Meet join button",
      join,
    );
    const status = await waitForJoinStatus(
      "http://127.0.0.1:18896/join/status",
      (body) => {
        const dialog = body.active?.localDialog;
        const audio = body.active?.avatarAudio;
        return (
          dialog?.turns?.some((turn) => ["completed", "failed"].includes(turn.status)) &&
          audio?.injectedTones > 0
        );
      },
      40_000,
    );
    const turn = status.active?.localDialog?.lastTurn;
    const latestInventory = (join.result?.buttonInventories || []).at(-1) || {};
    const visibleButtonLabels = (latestInventory.buttons || [])
      .filter((button) => button.visible)
      .map((button) => button.aria || button.text || "")
      .filter(Boolean);
    const inCallControlsVisible = visibleButtonLabels.some(
      (label) =>
        /leave call|turn off microphone|turn off camera|microphone|camera/i.test(label) ||
        /退出|离开|離れる|マイク|カメラ|通話/.test(label),
    );
    assertSmoke(
      inCallControlsVisible,
      "real local dialog smoke did not observe in-call Meet controls; the room may be expired, blocked, or waiting for admit",
      { visibleButtonLabels, join, status },
    );
    assertSmoke(turn?.status === "completed", "real local dialog provider turn did not complete", {
      turn,
      status,
    });
    assertSmoke(
      turn?.tts?.ok === true,
      "real local dialog TTS did not route to avatar fake mic",
      turn,
    );
    const stop = await postJson("http://127.0.0.1:18896/join/stop", {
      reason: "real_local_dialog_smoke_done",
    });
    assertSmoke(stop.ok === true, "real local dialog stop failed", stop);
    console.log(
      JSON.stringify(
        { ok: true, join, status, visibleButtonLabels, inCallControlsVisible, stop },
        null,
        2,
      ),
    );
  } finally {
    await postJson("http://127.0.0.1:18896/join/stop", {
      reason: "real_local_dialog_cleanup",
    }).catch(() => {});
    meeting.child.kill("SIGTERM");
    await rm(dataDir, { recursive: true, force: true });
  }
}

export async function dialogProviderSmoke() {
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-dialog-provider-"));
  const env: Record<string, string> = {
    MAB_MEETING_PORT: "18897",
    MAB_MEETING_AGENT_URL: "http://127.0.0.1:18897",
    MAB_BROWSER_HEADLESS: "true",
    MAB_DATA_DIR: dataDir,
    MAB_AGENT_RUNNER: "command",
    MAB_TTS_PROVIDER: "tone-wav",
  };
  const commandScript = pathJoin(dataDir, "dialog-provider-agent.mjs");
  await writeFile(
    commandScript,
    `
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const job = JSON.parse(input);
  console.log(JSON.stringify({
    status: "completed",
    result: "Dialog provider seam handled: " + job.task,
  }));
});
`,
    "utf8",
  );
  env.MAB_AGENT_COMMAND = `${process.execPath} ${commandScript}`;
  const meeting = startService("apps/meeting-agent/src/index.js", env);
  try {
    await waitForHealth("http://127.0.0.1:18897/healthz");
    const providers = await (await fetch("http://127.0.0.1:18897/dialog/providers")).json();
    assertSmoke(
      providers.tts?.provider === "tone-wav",
      "dialog provider route did not report the configured TTS provider",
      providers,
    );
    const tts = await postJson("http://127.0.0.1:18897/tts/synthesize", {
      text: "本地 TTS provider seam 已经准备好。",
      durationMs: 700,
    });
    assertSmoke(
      tts.ok === true && tts.audioDataUrl?.startsWith("data:audio/wav;base64,"),
      "TTS provider did not return a WAV data URL",
      tts,
    );
    const turn = await postJson("http://127.0.0.1:18897/dialog/turn", {
      sessionId: "dialog_provider_smoke",
      utterance: "请确认本地 dialog provider seam 工作正常。",
      timeoutMs: 8_000,
    });
    assertSmoke(turn.ok === true, "dialog turn route did not complete", turn);
    assertSmoke(
      turn.provider === "command",
      "dialog turn route did not use the configured AgentRunner",
      turn,
    );
    assertSmoke(
      turn.responseText.includes("Dialog provider seam handled"),
      "dialog turn did not return provider text",
      turn,
    );
    console.log(
      JSON.stringify(
        {
          ok: true,
          providers,
          tts: { ...tts, audioDataUrl: `${tts.audioDataUrl.slice(0, 64)}...` },
          turn,
        },
        null,
        2,
      ),
    );
  } finally {
    meeting.child.kill("SIGTERM");
    await rm(dataDir, { recursive: true, force: true });
  }
}

export function tinyWavBase64() {
  const sampleRate = 16_000;
  const sampleCount = 1600;
  const buffer = Buffer.alloc(44 + sampleCount * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + sampleCount * 2, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(sampleCount * 2, 40);
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = Math.sin(2 * Math.PI * 440 * (index / sampleRate)) * 0.08;
    buffer.writeInt16LE(Math.round(sample * 32767), 44 + index * 2);
  }
  return buffer.toString("base64");
}
export async function postMeetingSmoke() {
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-post-meeting-"));
  try {
    const asrScript = pathJoin(dataDir, "chunk-asr-provider.mjs");
    await writeFile(
      asrScript,
      `let stdin="";process.stdin.on("data",(chunk)=>{stdin+=chunk.toString();});process.stdin.on("end",()=>{const payload=JSON.parse(stdin||"{}");const index=payload.context?.chunkIndex;if(Number.isInteger(index)){const count=payload.context?.chunkCount??0;console.log(JSON.stringify({ok:true,provider:"command",text:"chunk "+index+" of "+count+": decision ship Slack Canvas after the meeting."}));return;}console.log(JSON.stringify({ok:true,provider:"command",segments:[{speaker:"Operator",text:"We decided to use the legacy meeting recording shape.",source:"asr"},{speaker:"Bot",text:"Action item: publish transcript and summary to Slack Canvas after the meeting.",source:"asr"}]}));});`,
      "utf8",
    );
    const pipeline = createMeetingArtifactPipeline({
      rootDir: pathJoin(dataDir, "artifacts"),
      asrProvider: "command",
      env: {
        ...process.env,
        MAB_ASR_COMMAND: `${JSON.stringify(process.execPath)} ${JSON.stringify(asrScript)}`,
      },
    });
    const result = await pipeline.postProcessMeeting({
      sessionId: "meet_post_smoke",
      meetUrl: "https://meet.google.com/abc-defg-hij",
      title: "Post-meeting smoke",
      audioBase64: tinyWavBase64(),
      audioMimeType: "audio/wav",
      captions: [
        {
          speaker: "Operator",
          text: "We decided to use the legacy meeting recording shape.",
          timestamp: "2026-05-08T05:00:00.000Z",
        },
        {
          speaker: "Bot",
          text: "Action item: publish transcript and summary to Slack Canvas after the meeting.",
          timestamp: "2026-05-08T05:00:10.000Z",
        },
      ],
      chatMessages: [
        {
          direction: "incoming",
          sender: "Operator",
          text: "Please keep this Meet chat link: https://example.com/demo",
          timestamp: "2026-05-08T05:00:05.000Z",
          messageId: "chat-in-1",
          source: "observer",
        },
        {
          direction: "outgoing",
          sender: "Onee Sama",
          text: "I saw the demo link and will include it in the recap.",
          timestamp: "2026-05-08T05:00:06.000Z",
          messageId: "chat-out-1",
          deliveryState: "sent",
          source: "send_meet_chat",
        },
      ],
    });
    assertSmoke(result.ok === true, "post-meeting artifact pipeline failed", result);
    assertSmoke(
      result.artifact?.files?.audio && existsSync(result.artifact.files.audio),
      "post-meeting smoke did not write audio artifact",
      result.artifact,
    );
    assertSmoke(
      existsSync(result.artifact.files.transcript),
      "post-meeting smoke did not write transcript.json",
      result.artifact,
    );
    assertSmoke(
      existsSync(result.artifact.files.summary),
      "post-meeting smoke did not write summary.md",
      result.artifact,
    );
    assertSmoke(
      existsSync(result.artifact.files.chat),
      "post-meeting smoke did not write chat.json",
      result.artifact,
    );
    assertSmoke(
      result.transcript.segments.length === 2,
      "post-meeting smoke did not write audio ASR segments",
      result.transcript,
    );
    assertSmoke(
      result.summary.decisions.length >= 1,
      "post-meeting smoke did not extract decisions",
      result.summary,
    );
    assertSmoke(
      result.chat.messageCount === 2,
      "post-meeting smoke did not preserve Meet chat messages",
      result.chat,
    );
    assertSmoke(
      result.chat.links.includes("https://example.com/demo"),
      "post-meeting smoke did not extract Meet chat links",
      result.chat,
    );
    const replayedChat = pipeline.getArtifactChat(result.artifact.id);
    assertSmoke(
      replayedChat?.messages?.length === 2,
      "post-meeting smoke could not replay chat.json",
      replayedChat,
    );
    assertSmoke(
      replayedChat.links.includes("https://example.com/demo"),
      "post-meeting replay lost Meet chat links",
      replayedChat,
    );

    const recordingDir = pathJoin(dataDir, "recording-source");
    await mkdir(recordingDir, { recursive: true });
    const sourceAudio = pathJoin(recordingDir, "audio.wav");
    await writeFile(sourceAudio, Buffer.from(tinyWavBase64(), "base64"));
    const chunkA = pathJoin(recordingDir, "audio_chunk_000.mp3");
    const chunkB = pathJoin(recordingDir, "audio_chunk_001.mp3");
    await writeFile(chunkA, "fake mp3 chunk 0");
    await writeFile(chunkB, "fake mp3 chunk 1");
    const chunkPipeline = createMeetingArtifactPipeline({
      rootDir: pathJoin(dataDir, "chunk-artifacts"),
      asrProvider: "command",
      env: {
        ...process.env,
        MAB_ASR_COMMAND: `${JSON.stringify(process.execPath)} ${JSON.stringify(asrScript)}`,
      },
    });
    const chunked = await chunkPipeline.postProcessMeeting({
      sessionId: "meet_post_chunk_smoke",
      meetUrl: "https://meet.google.com/chunk-smoke",
      title: "Chunked ASR smoke",
      audioPath: sourceAudio,
      audioMimeType: "audio/wav",
    });
    assertSmoke(chunked.ok === true, "chunked ASR smoke failed", chunked);
    assertSmoke(
      chunked.asr.chunked === true,
      "chunked ASR smoke did not use chunked provider path",
      chunked.asr,
    );
    assertSmoke(
      chunked.asr.chunks.length === 2,
      "chunked ASR smoke did not process both chunks",
      chunked.asr,
    );
    assertSmoke(
      chunked.transcript.segments.length === 2,
      "chunked ASR smoke did not merge chunk transcript segments",
      chunked.transcript,
    );
    assertSmoke(
      chunked.transcript.text.includes("chunk 0") && chunked.transcript.text.includes("chunk 1"),
      "chunked ASR smoke lost chunk text",
      chunked.transcript,
    );
    assertSmoke(
      chunked.artifact.files.audioChunks.length === 2,
      "chunked ASR smoke did not record audio chunk files",
      chunked.artifact.files,
    );
    for (const chunkPath of chunked.artifact.files.audioChunks) {
      assertSmoke(
        existsSync(chunkPath),
        "chunked ASR smoke did not write chunk artifact",
        chunked.artifact.files,
      );
    }
    console.log(
      JSON.stringify(
        {
          ok: true,
          artifact: result.artifact,
          transcript: {
            provider: result.transcript.provider,
            segmentCount: result.transcript.segments.length,
          },
          chat: {
            messageCount: result.chat.messageCount,
            links: result.chat.links,
          },
          chunkedAsr: {
            provider: chunked.transcript.provider,
            chunkCount: chunked.asr.chunks.length,
            segmentCount: chunked.transcript.segments.length,
          },
          summary: result.summary,
        },
        null,
        2,
      ),
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

