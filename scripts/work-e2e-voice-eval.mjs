// End-to-end voice work loop (voice -> work wiring gate).
//   spoken command (synthetic PCM via macOS `say`) -> OpenAI realtime input
//   transcription -> intent compiler -> typed job -> live stepwise planner on
//   a deterministic in-memory fake work surface -> verified done -> extracted
//   passage injected back into the realtime session -> spoken summary.
//   (The real executor backend is kwwk-cu AX; the fake surface keeps this
//   voice-wiring gate automated and browser-free.)
//
//   vp run eval:work-e2e-voice            # 10 runs, gate: >=8 successes
//   vp exec tsx scripts/work-e2e-voice-eval.mjs --runs 3
//
// Requires a real OpenAI key (loaded from the oneesama live-env files) and
// macOS `say`/`afconvert` for the synthetic utterances.
import { execFile, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { loadLanOperatorBackendLiveEnv } from "../packages/core/src/operator/lan-operator-backend-live-env.ts";
import { createWorkExecutor } from "../packages/core/src/work/work-executor.ts";
import { createWorkFakeSurface } from "../packages/core/src/work/work-fake-surface.ts";
import { compileWorkIntent } from "../packages/core/src/work/work-intent-compiler.ts";
import { createOpenAIWorkPlanner } from "../packages/core/src/work/work-openai-planner.ts";

// The work half runs on a deterministic in-memory fake surface (the CDP work
// browser was dropped); the voice -> transcribe -> intent -> planner ->
// execute -> verify -> spoken-summary loop is what this gate exercises. One
// rich page covers all three utterances.
function fakeWorkPages() {
  return {
    pages: {
      "work://release-notes": {
        url: "work://release-notes",
        title: "Fixture Product Release Notes",
        text: "What changed in version 2.0: Fixture Product 2.0 adds offline replay, a stepwise planner, and verified post-conditions. The Team plan costs forty-nine dollars per month. Known issues: the 2.0 importer skips archives larger than two gigabytes.",
        refs: [
          { ref: "1", role: "heading", name: "What changed in version 2.0" },
          {
            ref: "2",
            role: "text",
            name: "Fixture Product 2.0 adds offline replay and a stepwise planner",
          },
          { ref: "3", role: "text", name: "The Team plan costs forty-nine dollars per month" },
          {
            ref: "4",
            role: "text",
            name: "Known issues: importer skips archives larger than two gigabytes",
          },
        ],
        extracts: {
          1: "Fixture Product 2.0 adds offline replay, a stepwise planner, and verified post-conditions.",
          2: "Fixture Product 2.0 adds offline replay, a stepwise planner, and verified post-conditions.",
          3: "The Team plan costs forty-nine dollars per month.",
          4: "The 2.0 importer skips archives larger than two gigabytes.",
        },
      },
    },
    startUrl: "work://release-notes",
    allowedHosts: ["work"],
  };
}

const execFileAsync = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const args = { runs: 10, port: 18975, jsonOut: "/tmp/oneesama-work-e2e-voice-latest.json" };
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === "--runs") args.runs = Math.max(1, Number(process.argv[++i] || 10));
  else if (process.argv[i] === "--port") args.port = Number(process.argv[++i] || 18975);
  else if (process.argv[i] === "--json-out")
    args.jsonOut = String(process.argv[++i] || args.jsonOut);
}

const UTTERANCES = [
  "find out what changed in version 2.0",
  "look up the team plan pricing",
  "check the known issues",
];

loadLanOperatorBackendLiveEnv();
if (
  !process.env.ONEESAMA_OPENAI_API_KEY &&
  !process.env.MAB_OPENAI_API_KEY &&
  !process.env.OPENAI_API_KEY
) {
  console.error("work-e2e-voice-eval: no OpenAI key available");
  process.exit(2);
}

function parseWav(buffer) {
  let offset = 12;
  let format = null;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = buffer.subarray(offset + 8, offset + 8 + size);
    if (id === "fmt ") format = { sampleRate: body.readUInt32LE(4) };
    else if (id === "data") data = body;
    offset += 8 + size + (size % 2);
  }
  return { sampleRate: format?.sampleRate || 24000, data: data || Buffer.alloc(0) };
}

async function synthesizeUtterances() {
  const wavs = [];
  for (const [index, utterance] of UTTERANCES.entries()) {
    const aiff = `/tmp/oneesama-e2e-${index}.aiff`;
    const wav = `/tmp/oneesama-e2e-${index}.wav`;
    await execFileAsync("say", [utterance, "-o", aiff]);
    await execFileAsync("afconvert", ["-f", "WAVE", "-d", "LEI16@24000", "-c", "1", aiff, wav]);
    wavs.push(parseWav(readFileSync(wav)));
  }
  return wavs;
}

function wsConnect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => resolve(ws), { once: true });
    ws.addEventListener(
      "error",
      (event) => reject(new Error(String(event?.message || "ws_error"))),
      {
        once: true,
      },
    );
  });
}

async function startOperatorServer(port) {
  const child = spawn("vp", ["run", "dev:local-operator", "--", "--no-open"], {
    env: {
      ...process.env,
      MAB_LAN_OPERATOR_OPEN_BROWSER: "0",
      MAB_LAN_OPERATOR_AUTO_AVATAR_PUBLISHER: "0",
      MAB_LAN_OPERATOR_PORT: String(port),
      // Direct OpenAI works on this network; the adapter proxy tunnel is
      // unnecessary here and Playwright/fixture traffic is localhost.
      https_proxy: "",
      HTTPS_PROXY: "",
      http_proxy: "",
      HTTP_PROXY: "",
      all_proxy: "",
      ALL_PROXY: "",
    },
    stdio: "ignore",
    detached: false,
  });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/runtime/status`);
      if (response.ok) {
        const body = await response.json();
        const transport = body?.snapshot?.conversationTransport;
        if (transport !== "openai_realtime") {
          child.kill();
          throw new Error(`unexpected transport: ${transport}`);
        }
        return child;
      }
    } catch {
      // retry until deadline
    }
    await sleep(500);
  }
  child.kill();
  throw new Error("operator_server_start_timeout");
}

const report = {
  schema: "oneesama.work_e2e_voice_eval.v1",
  generatedAt: new Date().toISOString(),
  runs: 0,
  successes: 0,
  details: [],
  gate: { required: Math.ceil(args.runs * 0.8), ok: false },
};

const wavs = await synthesizeUtterances();
const operator = await startOperatorServer(args.port);

const statusBody = await (await fetch(`http://127.0.0.1:${args.port}/runtime/status`)).json();
const sessionId = statusBody?.debug?.surfaceContext?.sessionId;
if (!sessionId) throw new Error("session_id_missing");

const eventsWs = await wsConnect(`ws://127.0.0.1:${args.port}/operator/events/ws`);
const voiceWs = await wsConnect(`ws://127.0.0.1:${args.port}/operator/voice/ws`);

const canonical = [];
eventsWs.addEventListener("message", (message) => {
  try {
    const payload = JSON.parse(String(message.data));
    if (payload.type === "canonical_conversation_event" && payload.event) {
      canonical.push(payload.event);
    }
  } catch {
    // ignore unparseable frames
  }
});

async function waitForEvent(predicate, timeoutMs, fromIndex) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = canonical.slice(fromIndex).find(predicate);
    if (found) return found;
    await sleep(200);
  }
  return null;
}

// Connect the realtime session once up front.
eventsWs.send(
  JSON.stringify({
    type: "engine_control",
    sessionId,
    control: { type: "connect", reason: "work_e2e_voice_eval", detail: {} },
  }),
);
{
  const deadline = Date.now() + 20000;
  let connected = false;
  while (Date.now() < deadline && !connected) {
    const body = await (await fetch(`http://127.0.0.1:${args.port}/runtime/status`)).json();
    connected = body?.debug?.conversation?.status === "connected";
    if (!connected) await sleep(500);
  }
  if (!connected) throw new Error("realtime_connect_timeout");
}

let sequence = 0;
// Paced ~4x realtime: the server forwards at most 32 chunks concurrently,
// so an unpaced blast drops most of the utterance before the provider
// hears it.
async function sendPcm(samples, sampleRate, streamId) {
  const frame = Math.round(sampleRate * 0.02) * 2;
  for (let offset = 0; offset + frame <= samples.length; offset += frame) {
    const bytes = samples.subarray(offset, offset + frame);
    let sum = 0;
    for (let i = 0; i < bytes.length; i += 2) sum += Math.abs(bytes.readInt16LE(i));
    voiceWs.send(
      JSON.stringify({
        type: "voice_chunk",
        sessionId,
        sequence: sequence++,
        voiceStreamId: streamId,
        voiceStreamGeneration: 1,
        monotonicMs: performance.now(),
        sentAt: new Date().toISOString(),
        sampleRate,
        channels: 1,
        durationMs: 20,
        energy: sum / (bytes.length / 2) / 32768,
        dataBase64: bytes.toString("base64"),
        source: "work_e2e_voice_pcm16",
      }),
    );
    await sleep(5);
  }
}

for (let run = 0; run < args.runs; run++) {
  const wav = wavs[run % wavs.length];
  const utterance = UTTERANCES[run % UTTERANCES.length];
  const detail = { run, utterance, transcript: "", status: "", summaryAudio: false, ms: 0 };
  const startedAt = Date.now();
  const markBefore = canonical.length;
  try {
    const streamId = `e2e_${run}_${sequence}`;
    await sendPcm(wav.data, wav.sampleRate, streamId);
    const silence = Buffer.alloc(Math.round(wav.sampleRate * 0.02) * 2 * 80);
    await sendPcm(silence, wav.sampleRate, streamId);

    const transcriptEvent = await waitForEvent(
      (event) => event.type === "transcript_completed" && String(event.text || "").length > 0,
      30000,
      markBefore,
    );
    if (!transcriptEvent) throw new Error("transcript_timeout");
    detail.transcript = String(transcriptEvent.text || "");

    const compilation = await compileWorkIntent(detail.transcript);
    if (compilation.decision !== "job" || !compilation.job) {
      throw new Error(`intent_not_a_command:${detail.transcript}`);
    }

    const surface = createWorkFakeSurface({
      ...fakeWorkPages(),
      surfaceId: compilation.job.surfaceId,
    });
    let result;
    try {
      const executor = createWorkExecutor({
        surface,
        planner: createOpenAIWorkPlanner({ baseUrlHint: "work://release-notes" }),
        maxSteps: 10,
      });
      result = await executor.run(compilation.job);
    } finally {
      await surface.close().catch(() => {});
    }
    detail.status = result.status;
    if (result.status !== "done") throw new Error(`job_${result.status}:${result.blocker}`);

    const markBeforeSummary = canonical.length;
    eventsWs.send(
      JSON.stringify({
        type: "operator_text_input",
        sessionId,
        inputId: `e2e_summary_${run}`,
        text: `Summarize this finding for the meeting in two short spoken sentences: ${result.extracted.slice(0, 600)}`,
        source: "work_e2e_voice_eval",
      }),
    );
    const audioEvent = await waitForEvent(
      (event) => event.type === "assistant_audio_chunk",
      30000,
      markBeforeSummary,
    );
    detail.summaryAudio = Boolean(audioEvent);
    if (!audioEvent) throw new Error("summary_audio_timeout");

    report.successes += 1;
  } catch (error) {
    detail.error = String(error instanceof Error ? error.message : error).slice(0, 200);
  } finally {
    detail.ms = Date.now() - startedAt;
    report.runs += 1;
    report.details.push(detail);
    console.log(
      `run ${run}: ${detail.error ? `FAIL ${detail.error}` : "ok"} transcript=${JSON.stringify(
        detail.transcript,
      )} job=${detail.status} audio=${detail.summaryAudio} ${detail.ms}ms`,
    );
  }
}

report.gate.ok = report.successes >= report.gate.required;
writeFileSync(args.jsonOut, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  `work-e2e-voice-eval ${report.successes}/${report.runs} (gate >=${report.gate.required}: ${
    report.gate.ok ? "PASS" : "FAIL"
  })`,
);
console.log(`artifact: ${args.jsonOut}`);

eventsWs.close();
voiceWs.close();
operator.kill();
process.exit(report.gate.ok ? 0 : 1);
