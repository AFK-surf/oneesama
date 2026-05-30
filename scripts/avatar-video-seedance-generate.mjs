#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";

const DEFAULT_BASE_URL = "https://ark.ap-southeast.bytepluses.com/api/v3";
const DEFAULT_MODEL = "dreamina-seedance-2-0-fast-260128";
const DEFAULT_ASSET_ROOT = path.resolve("tmp/avatar-video");
const DEFAULT_DURATION_SECONDS = 5;
const DEFAULT_RESOLUTION = "720p";
const DEFAULT_RATIO = "16:9";
const POLL_INTERVAL_MS = 10_000;
const POLL_TIMEOUT_MS = 10 * 60_000;

const IDLE_PROMPT = [
  "Use the reference image as the same photorealistic on-camera woman.",
  "Black hair with bangs, black-framed glasses, navy blazer, white shirt, pearl necklace.",
  "Centered chest-up meeting avatar, clean studio lighting, simple soft background.",
  "Calm attentive idle loop: gentle breathing, natural blinking, tiny head and shoulder movement, occasional soft smile.",
  "Not talking; mouth stays naturally closed.",
  "Seamless 5 second loop, first and last frames nearly identical, stable framing, no subtitles, no text, no logos.",
].join(" ");

const SPEAKING_PROMPT = [
  "Use the reference image as the same photorealistic on-camera woman.",
  "Black hair with bangs, black-framed glasses, navy blazer, white shirt, pearl necklace.",
  "Centered chest-up meeting avatar, clean studio lighting, simple soft background.",
  "Natural generic speaking loop: restrained low-amplitude mouth opening and closing, not aligned to any specific words.",
  "Subtle head motion, calm focused expression, occasional blink.",
  "Seamless 5 second loop, first and last frames nearly identical, stable framing, no subtitles, no text, no logos.",
].join(" ");

function parseArgs(argv) {
  const args = {
    ref: "",
    outDir: process.env.ONEESAMA_AVATAR_ASSET_ROOT || DEFAULT_ASSET_ROOT,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--ref") args.ref = argv[++i] || "";
    else if (arg === "--out-dir") args.outDir = argv[++i] || "";
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
  console.log(`Usage: node scripts/avatar-video-seedance-generate.mjs --ref <image> [--out-dir tmp/avatar-video] [--dry-run]

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
  const refPath = path.resolve(args.ref || "");
  if (!args.ref || !fs.existsSync(refPath)) {
    throw new Error("--ref must point to the portrait reference image");
  }
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
    refPath,
    outDir: path.resolve(args.outDir || DEFAULT_ASSET_ROOT),
  };
  return config;
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
  const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";
  return `data:${mime};base64,${fs.readFileSync(filePath).toString("base64")}`;
}

async function submitTask(config, state, prompt) {
  const body = {
    model: config.model,
    content: [
      { type: "text", text: prompt },
      {
        type: "image_url",
        image_url: { url: dataUrlForFile(config.refPath) },
        role: "first_frame",
      },
    ],
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

async function generateOne(config, state, prompt, fileName) {
  console.log(
    `${state}: submit model=${config.model} duration=${config.duration}s resolution=${config.resolution} ratio=${config.ratio}`,
  );
  const taskId = await submitTask(config, state, prompt);
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
    `Seedance config: key_present=${Boolean(config.apiKey)} base=${config.baseUrl} model=${config.model} out=${config.outDir}`,
  );
  if (args.dryRun) return;
  if (!config.apiKey) {
    console.error("Seedance key missing: set SEEDANCE_API_KEY or ARK_API_KEY.");
    process.exit(2);
  }
  await generateOne(config, "idle", IDLE_PROMPT, "oneesama-video-idle-loop.mp4");
  await generateOne(config, "speaking", SPEAKING_PROMPT, "oneesama-video-speaking-loop.mp4");
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
