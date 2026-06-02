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
import type { ShadowTapInput } from "./common.js";
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

export async function copyAgentRealTaskReports({ rootDir }) {
  const reportDir =
    process.env.MAB_AGENT_REAL_TASK_REPORT_DIR || pathJoin(process.cwd(), "reports");
  if (!existsSync(reportDir)) return [];
  const copied = [];
  for (const name of await readdir(reportDir)) {
    if (!/^agent-real-task-.+\.json$/.test(name)) continue;
    const sourcePath = pathJoin(reportDir, name);
    const targetPath = pathJoin(rootDir, "reports", name);
    await mkdir(dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
    copied.push(relative(rootDir, targetPath));
  }
  return copied.toSorted();
}

export async function waitForRunnerJob(runner, jobId, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = runner.getJob(jobId);
    if (last && ["completed", "failed", "timeout"].includes(last.status)) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for runner job ${jobId}: ${JSON.stringify(last)}`);
}

export async function waitForWorkerReportJob({ url, jobId, timeoutMs = 120_000 }) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const body = await (await fetch(url)).json();
    last = body.jobs?.find((job) => job.id === jobId) || null;
    if (last && ["completed", "failed", "timeout"].includes(last.status)) return last;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for worker job ${jobId}: ${JSON.stringify(last)}`);
}

export async function shadowTransmitterHook() {
  let input: ShadowTapInput = {};
  try {
    const raw = await readStdinText();
    input = raw.trim() ? (JSON.parse(raw) as ShadowTapInput) : {};
  } catch (error) {
    process.exitCode = 1;
    console.log(
      JSON.stringify(
        {
          ok: false,
          error: "invalid_shadow_transmitter_input",
          detail: String(error?.message || error),
        },
        null,
        2,
      ),
    );
    return;
  }

  if (process.env.MAB_SHADOW_TAP_ENABLED !== "1") {
    console.log(
      JSON.stringify(
        {
          ok: true,
          disabled: true,
          reason: "MAB_SHADOW_TAP_ENABLED is not 1",
        },
        null,
        2,
      ),
    );
    return;
  }

  const endpoint = process.env.MAB_SHADOW_TAP_URL || process.env.MAB_SHADOW_TAP_ENDPOINT || "";
  const secret = process.env.MAB_SHADOW_TAP_SECRET || "";
  if (!endpoint || !secret) {
    process.exitCode = 1;
    console.log(
      JSON.stringify(
        {
          ok: false,
          disabled: false,
          error: "shadow_tap_not_configured",
          detail:
            "MAB_SHADOW_TAP_URL and MAB_SHADOW_TAP_SECRET are required when MAB_SHADOW_TAP_ENABLED=1",
        },
        null,
        2,
      ),
    );
    return;
  }

  const payload = createShadowTapPayload({
    ...input,
    source: process.env.MAB_SHADOW_TAP_SOURCE || input.source || "legacy-slack-agentd",
  });
  assertNoPrivateSlackFields(payload);

  const timeoutMs = Number.parseInt(process.env.MAB_SHADOW_TAP_TIMEOUT_MS || "1500", 10);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 1500,
  );
  const result = await postShadowTap({
    endpoint,
    secret,
    payload,
    fetchImpl: (url, options) => fetch(url, { ...options, signal: controller.signal }),
  });
  clearTimeout(timer);

  const output = {
    ok: result.ok,
    disabled: false,
    status: result.status,
    payload,
    response: result.body,
  };
  if (!result.ok) process.exitCode = 1;
  console.log(JSON.stringify(output, null, 2));
}

export async function writeTextArtifact(filePath, content) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

export async function writeJsonArtifact(filePath, value) {
  await writeTextArtifact(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function runEvidenceCommand({ name, args, rootDir, required = false }) {
  const safeName = name.replace(/[^a-z0-9_.-]+/gi, "-").toLowerCase();
  const startedAt = new Date().toISOString();
  const result = spawnSync(args[0], args.slice(1), {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  const evidenceCommand = {
    name,
    args,
    startedAt,
    finishedAt: new Date().toISOString(),
    status: result.status,
    signal: result.signal,
    ok: result.status === 0,
    stdoutPath: `commands/${safeName}.stdout.txt`,
    stderrPath: `commands/${safeName}.stderr.txt`,
  };
  await writeTextArtifact(pathJoin(rootDir, evidenceCommand.stdoutPath), result.stdout || "");
  await writeTextArtifact(pathJoin(rootDir, evidenceCommand.stderrPath), result.stderr || "");
  if (required)
    assertSmoke(evidenceCommand.ok, `evidence command failed: ${name}`, evidenceCommand);
  return evidenceCommand;
}

export async function fetchJsonArtifact(url, filePath) {
  const response = await fetch(url);
  const body = await response.json();
  await writeJsonArtifact(filePath, { httpStatus: response.status, body });
  return { httpStatus: response.status, body };
}

export async function collectArtifacts(rootDir) {
  const artifacts = [];
  async function walk(currentDir) {
    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = pathJoin(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const fileStat = await stat(fullPath);
        artifacts.push({
          path: relative(rootDir, fullPath),
          bytes: fileStat.size,
        });
      }
    }
  }
  await walk(rootDir);
  return artifacts.toSorted((a, b) => a.path.localeCompare(b.path));
}

export async function copyStateArtifacts({ statePath, rootDir }) {
  const copied = [];
  for (const sourcePath of [statePath, `${statePath}-wal`, `${statePath}-shm`]) {
    if (!existsSync(sourcePath)) continue;
    const targetPath = pathJoin(rootDir, "state", basename(sourcePath));
    await mkdir(dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
    copied.push(relative(rootDir, targetPath));
  }
  return copied;
}

export async function createCutoverEvidenceBundle({ smokeMode = false } = {}) {
  const evidenceDir = process.env.MAB_CUTOVER_EVIDENCE_DIR
    ? pathJoin(process.env.MAB_CUTOVER_EVIDENCE_DIR)
    : await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-cutover-evidence-"));
  await mkdir(evidenceDir, { recursive: true });

  const bundlePath = process.env.MAB_CUTOVER_EVIDENCE_BUNDLE || `${evidenceDir}.tar.gz`;
  const runtimeDir = pathJoin(evidenceDir, "runtime");
  const statePath = pathJoin(runtimeDir, "state.sqlite3");
  const cutoverReportPath = pathJoin(evidenceDir, "reports", "cutover-report.jsonl");
  const shadowReportPath = pathJoin(evidenceDir, "reports", "shadow-tap-report.jsonl");
  const slackPort = Number(process.env.MAB_CUTOVER_EVIDENCE_SLACK_PORT || 18930);
  const meetingPort = Number(process.env.MAB_CUTOVER_EVIDENCE_MEETING_PORT || 18931);
  const signingSecret = "cutover-evidence-signing-secret";
  const shadowSecret = "cutover-evidence-shadow-secret";
  const commands = [];
  const checks = [];
  let slack = null;
  let meeting = null;

  const env = {
    MAB_SLACK_PORT: String(slackPort),
    MAB_MEETING_PORT: String(meetingPort),
    MAB_MEETING_AGENT_URL: `http://127.0.0.1:${meetingPort}`,
    MAB_DRY_RUN_AGENT: "1",
    MAB_BROWSER_HEADLESS: "true",
    MAB_DATA_DIR: runtimeDir,
    MAB_STATE_PROVIDER: "sqlite",
    MAB_STATE_SQLITE_PATH: statePath,
    MAB_CUTOVER_MODE: "shadow",
    MAB_CUTOVER_REPORT_PATH: cutoverReportPath,
    MAB_SHADOW_TAP_SECRET: shadowSecret,
    MAB_SHADOW_TAP_REPORT_PATH: shadowReportPath,
    SLACK_SIGNING_SECRET: signingSecret,
  };

  async function recordCheck(name, pass, details = {}) {
    const check = { name, pass: Boolean(pass), details };
    checks.push(check);
    await writeJsonArtifact(pathJoin(evidenceDir, "checks", `${name}.json`), check);
    assertSmoke(check.pass, `cutover evidence check failed: ${name}`, check);
    return check;
  }

  try {
    await mkdir(pathJoin(evidenceDir, "reports"), { recursive: true });
    await mkdir(pathJoin(evidenceDir, "health"), { recursive: true });

    commands.push(
      await runEvidenceCommand({
        name: "git-status",
        args: ["git", "status", "--short", "--branch"],
        rootDir: evidenceDir,
      }),
    );
    commands.push(
      await runEvidenceCommand({
        name: "git-log",
        args: ["git", "log", "--oneline", "--decorate", "-n", "30"],
        rootDir: evidenceDir,
      }),
    );
    commands.push(
      await runEvidenceCommand({
        name: "git-remote",
        args: ["git", "remote", "-v"],
        rootDir: evidenceDir,
      }),
    );
    commands.push(
      await runEvidenceCommand({
        name: "github-recent-prs",
        args: [
          "gh",
          "pr",
          "list",
          "--state",
          "merged",
          "--limit",
          "25",
          "--json",
          "number,title,url,mergedAt,mergeCommit",
        ],
        rootDir: evidenceDir,
      }),
    );

    meeting = startService("apps/meeting-agent/src/index.js", env);
    slack = startService("apps/slack-agent/src/index.js", env);

    const meetingHealth = await waitForServiceHealth(
      meeting,
      `http://127.0.0.1:${meetingPort}/healthz`,
    );
    const slackHealth = await waitForServiceHealth(slack, `http://127.0.0.1:${slackPort}/healthz`);
    await writeJsonArtifact(pathJoin(evidenceDir, "health", "meeting-health.json"), meetingHealth);
    await writeJsonArtifact(pathJoin(evidenceDir, "health", "slack-health.json"), slackHealth);

    const join = await postSignedSlackCommand(
      `http://127.0.0.1:${slackPort}/slack/commands/avatar`,
      "join https://meet.google.com/abc-defg-hij --avatar hiyori --bot-name EvidenceBot",
      { signingSecret, userId: "U_EVIDENCE" },
    );
    await writeJsonArtifact(pathJoin(evidenceDir, "reports", "shadow-join-response.json"), join);
    await recordCheck(
      "shadow-join-old-primary",
      join.ok === true && join.session?.status === "shadow_old_stack_primary",
      {
        status: join.session?.status,
        cutoverDecision: join.cutoverDecision,
      },
    );

    const meetingSessionsAfterJoin = await fetchJsonArtifact(
      `http://127.0.0.1:${meetingPort}/sessions`,
      pathJoin(evidenceDir, "reports", "meeting-sessions-after-shadow-join.json"),
    );
    await recordCheck(
      "shadow-join-no-meeting-side-effect",
      meetingSessionsAfterJoin.body?.sessions?.length === 0,
      meetingSessionsAfterJoin.body,
    );

    const mirroredCommands = [
      {
        name: "join",
        text: "join https://meet.google.com/abc-defg-hij --avatar hiyori --bot-name EvidenceBot",
        oldStack: {
          source: "legacy-slack-agentd",
          sessionId: "meet_old_evidence_0001",
          status: "meeting_agent_started",
        },
      },
      {
        name: "delegate",
        text: "delegate --session meet_old_evidence_0001 Summarize the cutover evidence bundle.",
        oldStack: {
          source: "legacy-slack-agentd",
          sessionId: "meet_old_evidence_0001",
          jobId: "job_old_evidence_0001",
          status: "completed",
        },
      },
      {
        name: "jobs",
        text: "jobs --session meet_old_evidence_0001",
        oldStack: { source: "legacy-slack-agentd", sessionId: "meet_old_evidence_0001", jobs: 1 },
      },
      {
        name: "stop",
        text: "stop meet_old_evidence_0001 --reason evidence_done",
        oldStack: {
          source: "legacy-slack-agentd",
          sessionId: "meet_old_evidence_0001",
          status: "stopped",
        },
      },
    ];

    const shadowPosts = [];
    for (const commandBody of mirroredCommands) {
      const response = await fetch(`http://127.0.0.1:${slackPort}/shadow/slack-command`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-mab-shadow-tap-secret": shadowSecret,
        },
        body: JSON.stringify({
          source: "legacy-slack-agentd",
          eventId: `evt_evidence_${commandBody.name}`,
          team_id: "T_EVIDENCE",
          channel_id: "C_EVIDENCE",
          user_id: "U_EVIDENCE",
          text: commandBody.text,
          oldStack: commandBody.oldStack,
        }),
      });
      const body = await response.json();
      const result = { name: commandBody.name, httpStatus: response.status, body };
      shadowPosts.push(result);
      await writeJsonArtifact(
        pathJoin(evidenceDir, "reports", `shadow-tap-${commandBody.name}.json`),
        result,
      );
      await recordCheck(
        `shadow-tap-${commandBody.name}-suppressed`,
        response.status === 200 && body?.sideEffects === "suppressed",
        result,
      );
    }

    const slackSessions = await fetchJsonArtifact(
      `http://127.0.0.1:${slackPort}/sessions`,
      pathJoin(evidenceDir, "reports", "slack-sessions.json"),
    );
    const cutoverReport = await fetchJsonArtifact(
      `http://127.0.0.1:${slackPort}/cutover/report`,
      pathJoin(evidenceDir, "reports", "cutover-report.snapshot.json"),
    );
    const shadowReport = await fetchJsonArtifact(
      `http://127.0.0.1:${slackPort}/shadow/report`,
      pathJoin(evidenceDir, "reports", "shadow-report.snapshot.json"),
    );

    await recordCheck(
      "cutover-report-recorded",
      cutoverReport.body?.events?.length >= 1,
      cutoverReport.body,
    );
    await recordCheck(
      "shadow-report-recorded",
      shadowReport.body?.events?.length === mirroredCommands.length,
      shadowReport.body,
    );
    await recordCheck(
      "state-provider-sqlite",
      slackHealth.state?.provider === "sqlite" && meetingHealth.state?.provider === "sqlite",
      {
        slackState: slackHealth.state,
        meetingState: meetingHealth.state,
      },
    );

    for (const service of [slack, meeting]) {
      if (service) service.child.kill("SIGTERM");
    }
    slack = null;
    meeting = null;
    await new Promise((resolve) => setTimeout(resolve, 250));

    const stateArtifacts = await copyStateArtifacts({ statePath, rootDir: evidenceDir });
    const agentRealTaskReports = await copyAgentRealTaskReports({ rootDir: evidenceDir });
    await writeJsonArtifact(pathJoin(evidenceDir, "reports", "shadow-posts.json"), shadowPosts);

    const manifest: CutoverEvidenceManifest = {
      ok: true,
      kind: "meeting-avatar-bot.cutover-evidence.v1",
      generatedAt: new Date().toISOString(),
      smokeMode,
      repo: {
        head: spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim(),
        branch: spawnSync("git", ["branch", "--show-current"], { encoding: "utf8" }).stdout.trim(),
        origin: spawnSync("git", ["config", "--get", "remote.origin.url"], {
          encoding: "utf8",
        }).stdout.trim(),
      },
      env: {
        cutoverMode: env.MAB_CUTOVER_MODE,
        stateProvider: env.MAB_STATE_PROVIDER,
        stateSqlitePath: "runtime/state.sqlite3",
        cutoverReportPath: "reports/cutover-report.jsonl",
        shadowTapReportPath: "reports/shadow-tap-report.jsonl",
      },
      checks,
      commands,
      stateArtifacts,
      agentRealTaskReports,
      reportSummary: {
        slackSessions: slackSessions.body?.sessions?.length || 0,
        cutoverEvents: cutoverReport.body?.events?.length || 0,
        shadowEvents: shadowReport.body?.events?.length || 0,
        agentRealTaskReports: agentRealTaskReports.length,
      },
      artifacts: [],
    };
    await writeJsonArtifact(pathJoin(evidenceDir, "manifest.json"), manifest);

    const artifacts = await collectArtifacts(evidenceDir);
    manifest.artifacts = artifacts;
    await writeJsonArtifact(pathJoin(evidenceDir, "manifest.json"), manifest);

    await mkdir(dirname(bundlePath), { recursive: true });
    const tar = spawnSync(
      "tar",
      ["-czf", bundlePath, "-C", dirname(evidenceDir), basename(evidenceDir)],
      {
        encoding: "utf8",
      },
    );
    assertSmoke(tar.status === 0, "failed to create cutover evidence tarball", {
      status: tar.status,
      stderr: tar.stderr,
    });

    const bundle = {
      ok: true,
      evidenceDir,
      bundlePath,
      manifestPath: pathJoin(evidenceDir, "manifest.json"),
      manifest,
    };
    console.log(JSON.stringify(bundle, null, 2));
    return bundle;
  } finally {
    for (const service of [slack, meeting]) {
      if (service) service.child.kill("SIGTERM");
    }
  }
}

export async function cutoverEvidenceBundle() {
  await createCutoverEvidenceBundle();
}

export async function cutoverEvidenceSmoke() {
  const bundle = await createCutoverEvidenceBundle({ smokeMode: true });
  assertSmoke(existsSync(bundle.bundlePath), "cutover evidence tarball was not created", bundle);
  assertSmoke(existsSync(bundle.manifestPath), "cutover evidence manifest was not created", bundle);
  assertSmoke(
    bundle.manifest?.checks?.every((check) => check.pass),
    "cutover evidence manifest includes failed checks",
    bundle.manifest,
  );
  assertSmoke(
    bundle.manifest?.artifacts?.some((artifact) => artifact.path === "manifest.json"),
    "cutover evidence manifest is not listed as an artifact",
    bundle.manifest,
  );
}

export function summarizeParityJoin(result) {
  return {
    ok: result?.ok,
    status: result?.session?.status,
    meetUrl: result?.session?.meetUrl,
    avatar: result?.session?.avatar,
    text: result?.text,
  };
}

export function summarizeParityJob(job) {
  return {
    idPrefix: job?.id?.split("_").slice(0, 2).join("_") || "",
    status: job?.status,
    task: job?.task,
    result: job?.result,
  };
}

export async function startOldStackFixture({ port }) {
  const sessions = [];
  const jobs = [];

  function latestSession() {
    return sessions.at(-1) || null;
  }

  function getSession(parsed) {
    if (!parsed.sessionId) return latestSession();
    return sessions.find((session) => session.id === parsed.sessionId) || null;
  }

  async function handleAvatarCommand({ body }) {
    const parsed = parseAvatarCommand(body.text || body.raw || "");
    if (parsed.action === "join") {
      if (!parsed.validMeetUrl) {
        return {
          status: 400,
          body: slackTextResponse("Old stack fixture expected a Google Meet URL.", { ok: false }),
        };
      }
      const session = {
        id: `meet_old_${String(sessions.length + 1).padStart(4, "0")}`,
        status: "meeting_agent_started",
        source: "old-stack-fixture",
        meetUrl: parsed.meetUrl,
        avatar: parsed.avatar,
        requestedBy: body.user_id || body.user || "unknown",
      };
      sessions.push(session);
      return slackTextResponse(
        `Old stack fixture session ${session.id} created for ${session.meetUrl}.`,
        { extra: { session, oldStack: { fixture: true } } },
      );
    }

    if (parsed.action === "status") {
      const session = getSession(parsed);
      return slackTextResponse(
        `Status: ${session ? `${session.id} ${session.status} ${session.meetUrl}` : "no active session"}`,
        { extra: { session, sessions, oldStack: { fixture: true } } },
      );
    }

    if (parsed.action === "delegate") {
      const session = getSession(parsed);
      const job = {
        id: `job_old_${String(jobs.length + 1).padStart(4, "0")}`,
        provider: "fixture-agent",
        status: "completed",
        mode: parsed.requestedMode,
        task: parsed.task,
        result: "Dry-run agent runner accepted the task.",
      };
      jobs.push(job);
      if (session) session.status = "worker_delegated";
      return slackTextResponse(`Delegated to ${job.provider}: ${job.id} (${job.status}).`, {
        extra: { session, job, oldStack: { fixture: true } },
      });
    }

    if (parsed.action === "jobs") {
      const messages = jobs.map(
        (job) => `Worker ${job.id} ${job.status}: ${job.task}\n${job.result}`,
      );
      return slackTextResponse(
        [`Worker jobs: local=${jobs.length}, meeting=${jobs.length}`, messages.join("\n\n")]
          .filter(Boolean)
          .join("\n\n"),
        { extra: { jobs, messages, oldStack: { fixture: true } } },
      );
    }

    if (parsed.action === "stop") {
      const session = getSession(parsed);
      if (session) session.status = "stopped";
      return slackTextResponse(`Stop requested for ${session?.id || "current meeting joiner"}.`, {
        extra: { session, oldStack: { fixture: true } },
      });
    }

    return {
      status: 400,
      body: slackTextResponse(`Unknown old-stack fixture command: ${parsed.action}`, { ok: false }),
    };
  }

  const service = createJsonServer({
    name: "old-stack-fixture",
    port,
    routes: {
      "GET /healthz": () => ({ ok: true, service: "old-stack-fixture" }),
      "GET /sessions": () => ({ ok: true, sessions }),
      "GET /jobs": () => ({ ok: true, jobs }),
      "POST /slack/commands/avatar": handleAvatarCommand,
    },
  });

  await service.listen();
  return {
    close: () => new Promise((resolve) => service.server.close(resolve)),
  };
}

export function startService(script, env) {
  let entry = script;
  if (!existsSync(entry) && entry.endsWith(".js") && existsSync(entry.replace(/\.js$/, ".ts"))) {
    entry = entry.replace(/\.js$/, ".ts");
  }
  const args = entry.endsWith(".ts") ? ["--import", "tsx", entry] : [entry];
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  return { child, logs: () => ({ stdout, stderr }) };
}

export async function waitForHealth(url, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch {
      // Service is still booting.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

export async function waitForServiceHealth(service, url, timeoutMs = 8_000) {
  try {
    return await waitForHealth(url, timeoutMs);
  } catch (error) {
    const logs = service?.logs?.() || {};
    error.message = `${error.message}\nstdout:\n${logs.stdout || ""}\nstderr:\n${logs.stderr || ""}`;
    throw error;
  }
}

export async function waitForJoinStatus(url, predicate, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await (await fetch(url)).json();
      if (predicate(last)) return last;
    } catch {
      // Status route may not be ready for the first poll.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for join status: ${JSON.stringify(last)}`);
}

export async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return response.json();
}

export async function postJsonWithStatus(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { httpStatus: response.status, ...(await response.json()) };
}

interface SlackCommandFormOptions {
  userId?: string;
  userName?: string;
  formOverrides?: Record<string, string>;
}

interface SignedSlackRequestOptions extends SlackCommandFormOptions {
  timestamp?: string | number;
  rawBody?: string;
  signature?: string;
  signingSecret?: string;
  omitTimestamp?: boolean;
  omitSignature?: boolean;
}

export function buildSlackCommandForm(commandText: string, options: SlackCommandFormOptions = {}) {
  const form = new URLSearchParams({
    token: "deprecated-verification-token",
    team_id: "T_SMOKE",
    team_domain: "smoke",
    channel_id: "C_SMOKE",
    channel_name: "meeting-avatar-smoke",
    user_id: options.userId || "U_SMOKE",
    user_name: options.userName || "smoke-user",
    command: "/avatar",
    text: commandText,
    response_url: "https://hooks.slack.com/commands/smoke",
    trigger_id: "smoke-trigger",
    ...options.formOverrides,
  });
  return form.toString();
}

export async function postSignedSlackCommand(
  url: string,
  commandText: string,
  options: SignedSlackRequestOptions = {},
) {
  const timestamp = String(options.timestamp || Math.floor(Date.now() / 1000));
  const rawBody = options.rawBody || buildSlackCommandForm(commandText, options);
  const signature =
    options.signature ??
    signSlackRequestBody({
      signingSecret: options.signingSecret || "",
      timestamp,
      rawBody,
    });
  const headers = {
    "content-type": "application/x-www-form-urlencoded",
  };
  if (!options.omitTimestamp) headers["x-slack-request-timestamp"] = timestamp;
  if (!options.omitSignature) headers["x-slack-signature"] = signature;
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: rawBody,
  });
  const body = await response.json();
  return { ...body, httpStatus: response.status, rawBody, timestamp, signature };
}

export function buildSlackInteractionForm(payload: Record<string, unknown>) {
  return new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
}

export async function postSignedSlackInteraction(
  url: string,
  payload: Record<string, unknown>,
  options: SignedSlackRequestOptions = {},
) {
  return postSignedSlackCommand(url, "", {
    ...options,
    rawBody: buildSlackInteractionForm(payload),
  });
}

export async function postSignedSlackJson(
  url: string,
  body: Record<string, unknown>,
  options: SignedSlackRequestOptions = {},
) {
  const timestamp = String(options.timestamp || Math.floor(Date.now() / 1000));
  const rawBody = JSON.stringify(body);
  const signature =
    options.signature ??
    signSlackRequestBody({
      signingSecret: options.signingSecret || "",
      timestamp,
      rawBody,
    });
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
    body: rawBody,
  });
  return { ...(await response.json()), httpStatus: response.status, rawBody, timestamp, signature };
}
