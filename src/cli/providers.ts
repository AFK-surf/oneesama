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

export async function doctor() {
  const config = getRuntimeConfig();
  const checks = [
    ["node >= 22", Number(process.versions.node.split(".")[0]) >= 22, process.version],
    [
      "OpenAI-compatible realtime key",
      Boolean(config.openaiApiKey),
      config.openaiApiKey ? "set" : "missing",
    ],
    ["OpenAI base URL", Boolean(config.openaiBaseUrl), config.openaiBaseUrl],
    ["SLACK_BOT_TOKEN", Boolean(config.slackBotToken), config.slackBotToken ? "set" : "missing"],
    ["SLACK_APP_TOKEN", Boolean(config.slackAppToken), config.slackAppToken ? "set" : "missing"],
    ["agent runner", Boolean(config.agentRunner), config.agentRunner],
    [
      "codex binary",
      config.agentRunner !== "codex" || Boolean(hasCommand(config.codexBin)),
      hasCommand(config.codexBin) || "not required unless MAB_AGENT_RUNNER=codex",
    ],
    [
      "Ollama endpoint",
      config.agentRunner !== "ollama" || Boolean(config.ollamaBaseUrl),
      config.ollamaBaseUrl || "not required unless MAB_AGENT_RUNNER=ollama",
    ],
    [
      "Slack Agent D bridge",
      config.agentRunner !== "slack-agent-d" || Boolean(config.slackAgentDUrl),
      config.slackAgentDUrl || "not required unless MAB_AGENT_RUNNER=slack-agent-d",
    ],
    ["Avatar renderer", Boolean(config.avatarRenderer), config.avatarRenderer || "missing"],
    ["Hiyori/model URL", Boolean(config.avatarModelUrl), config.avatarModelUrl || "missing"],
    ["VRM/model URL", Boolean(config.avatarVRMModelUrl), config.avatarVRMModelUrl || "missing"],
    [
      "Playwright chromium cache",
      existsSync(`${process.env.HOME}/Library/Caches/ms-playwright`),
      "optional for local Meet joiner",
    ],
  ];

  for (const [name, ok, detail] of checks) {
    console.log(`${ok ? "ok " : "warn"} ${name}: ${detail}`);
  }
  console.log(
    "\nDoctor is warning-only for the scaffold. Missing tokens are expected in open-source local smoke.",
  );
}

export async function smoke() {
  const sessions = createInMemorySessionStore();
  const runner = createAgentRunner({ provider: "dry-run" });
  const session = sessions.create({
    source: "smoke",
    meetUrl: "https://meet.google.com/example-demo",
    avatar: "hiyori",
    requestedBy: "local-dev",
  });
  const job = await runner.startTask({
    task: "Summarize the open-source Meeting Avatar Bot MVP.",
    mode: "plan",
    context: { sessionId: session.id },
  });
  sessions.update(session.id, { lastWorkerJobId: job.id, status: "ready_for_meeting_agent" });
  console.log(JSON.stringify({ ok: true, session: sessions.get(session.id), job }, null, 2));
}

export async function agentProviderSmoke() {
  const dryRunRunner = createAgentRunner({ provider: "dry-run" });
  const dryRunJob = await dryRunRunner.startTask({
    task: "Check dry-run provider.",
    mode: "smoke",
    context: { provider: "dry-run" },
  });
  assertSmoke(
    dryRunJob.provider === "dry-run",
    "dry-run provider returned the wrong provider",
    dryRunJob,
  );
  assertSmoke(
    dryRunJob.status === "completed",
    "dry-run provider did not complete synchronously",
    dryRunJob,
  );

  const tempDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-agent-provider-"));
  const commandScript = pathJoin(tempDir, "agent-command-runner.mjs");
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
    result: "command runner handled: " + job.task,
  }));
});
`,
    "utf8",
  );

  let httpServer = null;
  try {
    const commandRunner = createAgentRunner({
      provider: "command",
      env: {
        ...process.env,
        MAB_AGENT_RUNNER: "command",
        MAB_AGENT_COMMAND: `${process.execPath} ${commandScript}`,
      },
    });
    const commandJob = await commandRunner.startTask({
      task: "Check command provider.",
      mode: "smoke",
      context: { provider: "command" },
    });
    const completedCommandJob = await waitForRunnerJob(commandRunner, commandJob.id);
    assertSmoke(
      completedCommandJob.provider === "command",
      "command provider returned the wrong provider",
      completedCommandJob,
    );
    assertSmoke(
      completedCommandJob.status === "completed",
      "command provider did not complete",
      completedCommandJob,
    );
    assertSmoke(
      completedCommandJob.result.includes("Check command provider."),
      "command provider did not receive the task payload",
      completedCommandJob,
    );

    httpServer = createJsonServer({
      name: "agent-provider-smoke",
      port: 18911,
      routes: {
        "GET /healthz": () => ({ ok: true }),
        "POST /agent/run": async ({ body }) => ({
          body: {
            ok: true,
            status: "completed",
            result: `http runner handled: ${body.task}`,
          },
        }),
      },
    });
    await httpServer.listen();
    const httpRunner = createAgentRunner({
      provider: "http",
      env: {
        ...process.env,
        MAB_AGENT_RUNNER: "http",
        MAB_AGENT_HTTP_URL: "http://127.0.0.1:18911/agent/run",
      },
    });
    const httpJob = await httpRunner.startTask({
      task: "Check HTTP provider.",
      mode: "smoke",
      context: { provider: "http" },
    });
    const completedHttpJob = await waitForRunnerJob(httpRunner, httpJob.id);
    assertSmoke(
      completedHttpJob.provider === "http",
      "HTTP provider returned the wrong provider",
      completedHttpJob,
    );
    assertSmoke(
      completedHttpJob.status === "completed",
      "HTTP provider did not complete",
      completedHttpJob,
    );
    assertSmoke(
      completedHttpJob.result.includes("Check HTTP provider."),
      "HTTP provider did not receive the task payload",
      completedHttpJob,
    );

    console.log(
      JSON.stringify(
        { ok: true, dryRunJob, commandJob: completedCommandJob, httpJob: completedHttpJob },
        null,
        2,
      ),
    );
  } finally {
    if (httpServer) await new Promise((resolve) => httpServer.server.close(resolve));
    await rm(tempDir, { recursive: true, force: true });
  }
}

export function parseCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function normalizeAgentRealTaskProvider(provider) {
  const normalized = String(provider || "")
    .trim()
    .toLowerCase()
    .replaceAll("_", "-");
  if (normalized === "claude-code") return "claude";
  if (normalized === "slack-agentd" || normalized === "legacy-slack-agent-d")
    return "slack-agent-d";
  return normalized;
}

export function requiredAgentRealTaskKeywords() {
  const configured = parseCsv(process.env.MAB_AGENT_REAL_TASK_KEYWORDS || "");
  return configured.length ? configured : ["Alice", "Bob", "Slack", "Meet", "latency", "alpha42"];
}

export function agentRealTaskPrompt({ provider: _provider, keywords }) {
  return [
    "你是 meeting-avatar-bot 的可替换 AgentRunner provider。",
    "请阅读下面的短会议 transcript，输出一段中文摘要。",
    "为了让自动化验收能确认这是真 provider 输出，请在回答中逐字包含这些关键词：",
    keywords.join(", "),
    "",
    "Transcript:",
    "Alice: We need the meeting avatar bot to route complex Slack requests to a local agent provider instead of baking a model into the bot shell.",
    "Bob: Agreed. The bot should join Google Meet, keep Hiyori speaking, and report the worker result back to Slack.",
    "Alice: The cutover evidence bundle must include health checks, SQLite state snapshots, and reports.",
    "Bob: Track the latency risk as alpha42 so tomorrow's handoff can grep for it.",
    "",
    "回答要求：",
    "- 3 条 bullet 即可。",
    "- 说明 Slack 控制面、Meet/Hiyori 会议面、cutover evidence 三件事。",
    "- 不要写代码。",
  ].join("\n");
}

export function defaultAgentRealTaskProviders() {
  const configured = parseCsv(process.env.MAB_AGENT_REAL_TASK_PROVIDERS || "");
  if (configured.length) return configured;
  const selected = normalizeAgentRealTaskProvider(process.env.MAB_AGENT_RUNNER || "");
  if (selected && selected !== "dry-run") return [selected];
  return ["codex"];
}

export async function runAgentRealTaskForProvider(providerInput, { keywords, reportDir }) {
  const provider = normalizeAgentRealTaskProvider(providerInput);
  assertSmoke(
    provider && provider !== "dry-run",
    "agent real task smoke requires a live provider, not dry-run",
    { providerInput },
  );
  if (provider === "codex") {
    const codexBin = process.env.MAB_CODEX_BIN || "codex";
    assertSmoke(
      Boolean(hasCommand(codexBin)),
      "Codex real task smoke requires MAB_CODEX_BIN on PATH",
      { codexBin },
    );
  }
  if (provider === "claude") {
    const claudeBin = process.env.MAB_CLAUDE_BIN || "claude";
    assertSmoke(
      Boolean(hasCommand(claudeBin)),
      "Claude real task smoke requires MAB_CLAUDE_BIN on PATH",
      { claudeBin },
    );
  }

  const runner = createAgentRunner({
    provider,
    env: {
      ...process.env,
      MAB_AGENT_RUNNER: provider,
      MAB_DRY_RUN_AGENT: "",
      MAB_DRY_RUN_CODEX: "",
    },
  });
  const startedAt = new Date().toISOString();
  const job = await runner.startTask({
    task: agentRealTaskPrompt({ provider, keywords }),
    mode: "acceptance-smoke",
    allowCodeChanges: false,
    context: {
      fixture: "agent-real-task.v1",
      expectation: "Summarize transcript and preserve acceptance keywords.",
    },
  });
  const timeoutMs = Number.parseInt(process.env.MAB_AGENT_REAL_TASK_TIMEOUT_MS || "180000", 10);
  const completed = await waitForRunnerJob(runner, job.id, timeoutMs);
  const result = String(completed.result || "");
  const missingKeywords = keywords.filter(
    (keyword) => !result.toLowerCase().includes(keyword.toLowerCase()),
  );
  assertSmoke(
    completed.status === "completed",
    "agent real task provider did not complete",
    completed,
  );
  assertSmoke(
    missingKeywords.length === 0,
    "agent real task provider response missed expected keywords",
    {
      provider,
      missingKeywords,
      result,
    },
  );

  const report = {
    ok: true,
    kind: "meeting-avatar-bot.agent-real-task.v1",
    provider,
    startedAt,
    finishedAt: new Date().toISOString(),
    keywords,
    missingKeywords,
    job: completed,
  };
  const reportPath = pathJoin(reportDir, `agent-real-task-${provider}.json`);
  await writeJsonArtifact(reportPath, report);
  return { ...report, reportPath };
}

export async function agentRealTaskSmoke() {
  const required = process.env.MAB_REQUIRE_AGENT_REAL_TASK === "1";
  const runLive = required || process.env.MAB_RUN_AGENT_REAL_TASK_SMOKE === "1";
  const reportDir =
    process.env.MAB_AGENT_REAL_TASK_REPORT_DIR || pathJoin(process.cwd(), "reports");
  if (!runLive) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          skipped: true,
          reason:
            "set MAB_RUN_AGENT_REAL_TASK_SMOKE=1 or MAB_REQUIRE_AGENT_REAL_TASK=1 to run live AgentRunner providers",
          examples: [
            "MAB_RUN_AGENT_REAL_TASK_SMOKE=1 MAB_AGENT_RUNNER=codex npm run smoke:agent-real-task",
            "MAB_RUN_AGENT_REAL_TASK_SMOKE=1 MAB_AGENT_REAL_TASK_PROVIDERS=codex,claude npm run smoke:agent-real-task",
          ],
        },
        null,
        2,
      ),
    );
    return;
  }

  const keywords = requiredAgentRealTaskKeywords();
  const providers = defaultAgentRealTaskProviders();
  await mkdir(reportDir, { recursive: true });
  const results = [];
  for (const provider of providers) {
    results.push(await runAgentRealTaskForProvider(provider, { keywords, reportDir }));
  }
  console.log(JSON.stringify({ ok: true, reportDir, providers, results }, null, 2));
}

export async function claudeProviderSmoke() {
  const dryRunRunner = createAgentRunner({
    provider: "claude",
    dryRun: true,
    env: { ...process.env, MAB_AGENT_RUNNER: "claude", MAB_DRY_RUN_AGENT: "1" },
  });
  const dryRunJob = await dryRunRunner.startTask({
    task: "Check Claude Code provider dry-run contract.",
    mode: "smoke",
    context: { provider: "claude", runner: "claude-code" },
  });
  assertSmoke(
    dryRunJob.provider === "claude",
    "Claude provider returned the wrong provider",
    dryRunJob,
  );
  assertSmoke(
    dryRunJob.status === "completed",
    "Claude provider dry-run did not complete",
    dryRunJob,
  );

  const requireLive = (process.env.MAB_REQUIRE_CLAUDE_PROVIDER || "") === "1";
  const runLive = requireLive || (process.env.MAB_RUN_CLAUDE_PROVIDER_SMOKE || "") === "1";
  let live: { skipped: boolean; reason?: string; job?: unknown } = {
    skipped: true,
    reason:
      "set MAB_RUN_CLAUDE_PROVIDER_SMOKE=1 or MAB_REQUIRE_CLAUDE_PROVIDER=1 to run Claude Code live",
  };
  if (runLive) {
    const claudeBin = process.env.MAB_CLAUDE_BIN || "claude";
    if (!hasCommand(claudeBin)) {
      assertSmoke(!requireLive, "Claude provider live smoke requires MAB_CLAUDE_BIN on PATH", {
        claudeBin,
      });
      live = { skipped: true, reason: `Claude binary not found: ${claudeBin}` };
    } else {
      const runner = createAgentRunner({
        provider: "claude",
        env: {
          ...process.env,
          MAB_AGENT_RUNNER: "claude",
          MAB_CLAUDE_MAX_BUDGET_USD: process.env.MAB_CLAUDE_MAX_BUDGET_USD || "0.30",
        },
      });
      const job = await runner.startTask({
        task: "用一句中文说明 Claude Code provider 已接入 meeting-avatar-bot。",
        mode: "smoke",
        context: { provider: "claude", live: true },
      });
      const completed = await waitForRunnerJob(runner, job.id, 120_000);
      assertSmoke(
        completed.provider === "claude",
        "Claude provider live job returned wrong provider",
        completed,
      );
      assertSmoke(
        completed.status === "completed",
        "Claude provider live job did not complete",
        completed,
      );
      assertSmoke(
        Boolean(completed.result?.trim()),
        "Claude provider live job returned an empty result",
        completed,
      );
      live = { skipped: false, job: completed };
    }
  }

  console.log(JSON.stringify({ ok: true, dryRunJob, live }, null, 2));
}
