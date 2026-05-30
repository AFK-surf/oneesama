#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";

const DEFAULT_BASE_URL = "https://ark.ap-southeast.bytepluses.com/api/v3";
const DEFAULT_MODEL = "dreamina-seedance-2-0-fast-260128";
const DEFAULT_ASSET_ROOT = path.resolve("tmp/avatar-video");
const DEFAULT_KEYFRAME_DIR = path.join(DEFAULT_ASSET_ROOT, "keyframes");
const DEFAULT_DURATION_SECONDS = 5;
const DEFAULT_RESOLUTION = "720p";
const DEFAULT_RATIO = "16:9";
const POLL_INTERVAL_MS = 10_000;
const POLL_TIMEOUT_MS = 10 * 60_000;
const KEYFRAME_FILES = {
  idleFirst: "oneesama-video-idle-first.png",
  idleLast: "oneesama-video-idle-last.png",
  speakingFirst: "oneesama-video-speaking-first.png",
  speakingLast: "oneesama-video-speaking-last.png",
};

const IDLE_PROMPT = [
  "Animate the provided idle keyframe while preserving the exact same identity, crop, outfit, lighting, and background.",
  "Calm attentive idle loop: gentle breathing, natural blinking, tiny head and shoulder movement, occasional very soft smile.",
  "Not talking; mouth stays naturally closed.",
  "Return to the supplied last frame if present; otherwise return to the first keyframe.",
  "Seamless loop, first and last frames nearly identical, stable framing, no subtitles, no text, no logos.",
].join(" ");

const SPEAKING_PROMPT = [
  "Animate the provided speaking keyframe while preserving the exact same identity, crop, outfit, lighting, and background.",
  "Natural generic speaking loop: restrained low-amplitude mouth opening and closing, not aligned to any specific words.",
  "Subtle head motion, calm focused expression, occasional blink.",
  "Return to the supplied last frame if present; otherwise return to the first keyframe.",
  "Seamless loop, first and last frames nearly identical, stable framing, no subtitles, no text, no logos.",
].join(" ");

function parseArgs(argv) {
  const args = {
    ref: "",
    keyframeDir: "",
    idleFrame: "",
    idleLastFrame: "",
    speakingFrame: "",
    speakingLastFrame: "",
    outDir: process.env.ONEESAMA_AVATAR_ASSET_ROOT || DEFAULT_ASSET_ROOT,
    allowRefDirect: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--ref") args.ref = argv[++i] || "";
    else if (arg === "--keyframe-dir") args.keyframeDir = argv[++i] || "";
    else if (arg === "--idle-frame") args.idleFrame = argv[++i] || "";
    else if (arg === "--idle-last-frame") args.idleLastFrame = argv[++i] || "";
    else if (arg === "--speaking-frame") args.speakingFrame = argv[++i] || "";
    else if (arg === "--speaking-last-frame") args.speakingLastFrame = argv[++i] || "";
    else if (arg === "--out-dir") args.outDir = argv[++i] || "";
    else if (arg === "--allow-ref-direct") args.allowRefDirect = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/avatar-video-seedance-generate.mjs --keyframe-dir <dir> [--out-dir tmp/avatar-video] [--dry-run]

Alternative:
  --idle-frame <image> [--idle-last-frame <image>] --speaking-frame <image> [--speaking-last-frame <image>]

Prototype-only fallback:
  --allow-ref-direct --ref <image>

Env:
  SEEDANCE_API_KEY or ARK_API_KEY
  SEEDANCE_BASE_URL      default ${DEFAULT_BASE_URL}
  SEEDANCE_MODEL         default ${DEFAULT_MODEL}
  SEEDANCE_DURATION_SECONDS default ${DEFAULT_DURATION_SECONDS}
  SEEDANCE_RESOLUTION    default ${DEFAULT_RESOLUTION}
  SEEDANCE_RATIO         default ${DEFAULT_RATIO}

Output:
  oneesama-video-idle-loop.mp4
  oneesama-video-speaking-loop.mp4`);
}

function requireConfig(args) {
  const keyframes = resolveKeyframes(args);
  const apiKey = process.env.SEEDANCE_API_KEY || process.env.ARK_API_KEY || "";
  const config = {
    apiKey,
    baseUrl: trimTrailingSlash(process.env.SEEDANCE_BASE_URL || DEFAULT_BASE_URL),
    model: process.env.SEEDANCE_MODEL || DEFAULT_MODEL,
    duration: clampInt(process.env.SEEDANCE_DURATION_SECONDS, DEFAULT_DURATION_SECONDS, 2, 12),
    resolution: process.env.SEEDANCE_RESOLUTION || DEFAULT_RESOLUTION,
    ratio: process.env.SEEDANCE_RATIO || DEFAULT_RATIO,
    generateAudio: envBool(process.env.SEEDANCE_GENERATE_AUDIO, false),
    watermark: envBool(process.env.SEEDANCE_WATERMARK, false),
    keyframes,
    outDir: path.resolve(args.outDir || DEFAULT_ASSET_ROOT),
  };
  return config;
}

function resolveKeyframes(args) {
  const keyframeDir = path.resolve(args.keyframeDir || DEFAULT_KEYFRAME_DIR);
  const idleFirst =
    args.idleFrame || (args.keyframeDir ? path.join(keyframeDir, KEYFRAME_FILES.idleFirst) : "");
  const idleLast =
    args.idleLastFrame || (args.keyframeDir ? path.join(keyframeDir, KEYFRAME_FILES.idleLast) : "");
  const speakingFirst =
    args.speakingFrame ||
    (args.keyframeDir ? path.join(keyframeDir, KEYFRAME_FILES.speakingFirst) : "");
  const speakingLast =
    args.speakingLastFrame ||
    (args.keyframeDir ? path.join(keyframeDir, KEYFRAME_FILES.speakingLast) : "");
  if (idleFirst && speakingFirst) {
    return {
      mode: "image2_keyframes",
      idle: {
        firstFrame: requireImage(idleFirst, "--idle-frame"),
        lastFrame: optionalImage(idleLast, "--idle-last-frame"),
      },
      speaking: {
        firstFrame: requireImage(speakingFirst, "--speaking-frame"),
        lastFrame: optionalImage(speakingLast, "--speaking-last-frame"),
      },
    };
  }
  if (args.allowRefDirect) {
    const refPath = requireImage(args.ref, "--ref");
    return {
      mode: "prototype_ref_direct",
      idle: { firstFrame: refPath },
      speaking: { firstFrame: refPath },
    };
  }
  throw new Error(
    "Seedance video generation now requires Image2 keyframes. Run `npm run avatar:video:keyframes -- --ref <image>` first, save approved frames, then pass --keyframe-dir. For prototype-only direct ref animation, pass --allow-ref-direct --ref <image>.",
  );
}

function requireImage(filePath, label) {
  const resolved = path.resolve(filePath || "");
  if (!filePath || !fs.existsSync(resolved)) {
    throw new Error(`${label} must point to an existing Image2 keyframe`);
  }
  return resolved;
}

function optionalImage(filePath) {
  if (!filePath) return undefined;
  const resolved = path.resolve(filePath);
  return fs.existsSync(resolved) ? resolved : undefined;
}

function envBool(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

function clampInt(value, fallback, min, max) {
  const number = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/u, "");
}

function dataUrlForFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mime =
    ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
  return `data:${mime};base64,${fs.readFileSync(filePath).toString("base64")}`;
}

async function submitTask(config, state, prompt, frames) {
  const content = [
    { type: "text", text: prompt },
    {
      type: "image_url",
      image_url: { url: dataUrlForFile(frames.firstFrame) },
      role: "first_frame",
    },
  ];
  if (frames.lastFrame) {
    content.push({
      type: "image_url",
      image_url: { url: dataUrlForFile(frames.lastFrame) },
      role: "last_frame",
    });
  }
  const body = {
    model: config.model,
    content,
    ratio: config.ratio,
    duration: config.duration,
    resolution: config.resolution,
    generate_audio: config.generateAudio,
    watermark: config.watermark,
  };
  const response = await fetch(`${config.baseUrl}/contents/generations/tasks`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `${state} submit failed: ${response.status} ${response.statusText} ${text.slice(0, 240)}`,
    );
  }
  const json = await response.json();
  const taskId = json.id ?? json.task_id ?? json.data?.id ?? json.data?.task_id;
  if (!taskId) throw new Error(`${state} submit returned no task id`);
  return String(taskId);
}

async function pollTask(config, taskId, state) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  const url = `${config.baseUrl}/contents/generations/tasks/${encodeURIComponent(taskId)}`;
  while (Date.now() < deadline) {
    await wait(POLL_INTERVAL_MS);
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `${state} poll failed: ${response.status} ${response.statusText} ${text.slice(0, 240)}`,
      );
    }
    const json = await response.json();
    const status = String(json.status || "").toLowerCase();
    console.log(`${state}: status=${status || "unknown"}`);
    if (["succeeded", "done", "success"].includes(status)) {
      const videoUrl = extractVideoUrl(json);
      if (!videoUrl) throw new Error(`${state} completed without a video URL`);
      return videoUrl;
    }
    if (["failed", "expired", "cancelled", "canceled"].includes(status)) {
      throw new Error(`${state} ended with status=${status}`);
    }
  }
  throw new Error(`${state} timed out after ${Math.round(POLL_TIMEOUT_MS / 1000)}s`);
}

function extractVideoUrl(json) {
  const candidates = [];
  const push = (item) => {
    if (!item || typeof item !== "object") return;
    candidates.push(item.video_url, item.url);
  };
  push(json);
  if (Array.isArray(json.content)) json.content.forEach(push);
  else push(json.content);
  if (Array.isArray(json.output)) json.output.forEach(push);
  else push(json.output);
  return candidates.find((value) => typeof value === "string" && /^https?:\/\//u.test(value));
}

async function downloadVideo(url, outPath) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`download failed: ${response.status} ${response.statusText}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const partPath = `${outPath}.${process.pid}.${Date.now()}.part`;
  fs.writeFileSync(partPath, bytes);
  fs.renameSync(partPath, outPath);
  return bytes.length;
}

async function generateOne(config, state, prompt, fileName, frames) {
  console.log(
    `${state}: submit model=${config.model} duration=${config.duration}s resolution=${config.resolution} ratio=${config.ratio} first_frame=${path.basename(frames.firstFrame)} last_frame=${frames.lastFrame ? path.basename(frames.lastFrame) : "none"}`,
  );
  const taskId = await submitTask(config, state, prompt, frames);
  console.log(`${state}: task_id=${taskId}`);
  const videoUrl = await pollTask(config, taskId, state);
  const outPath = path.join(config.outDir, fileName);
  const bytes = await downloadVideo(videoUrl, outPath);
  console.log(`${state}: wrote ${outPath} bytes=${bytes}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = requireConfig(args);
  console.log(
    `Seedance config: key_present=${Boolean(config.apiKey)} mode=${config.keyframes.mode} base=${config.baseUrl} model=${config.model} out=${config.outDir}`,
  );
  if (args.dryRun) return;
  if (!config.apiKey) {
    console.error("Seedance key missing: set SEEDANCE_API_KEY or ARK_API_KEY.");
    process.exit(2);
  }
  await generateOne(
    config,
    "idle",
    IDLE_PROMPT,
    "oneesama-video-idle-loop.mp4",
    config.keyframes.idle,
  );
  await generateOne(
    config,
    "speaking",
    SPEAKING_PROMPT,
    "oneesama-video-speaking-loop.mp4",
    config.keyframes.speaking,
  );
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
