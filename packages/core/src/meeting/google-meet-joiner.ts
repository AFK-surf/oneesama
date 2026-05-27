import { createServer, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join as pathJoin, resolve as pathResolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getRuntimeConfig } from "../env.ts";
import type { ScreenShareState } from "../browser-runtime-types.ts";
import { buildAvatarRuntimeInitScripts } from "../avatar-runtime/runtime-init-builder.ts";
import { validateGoogleMeetRuntimeSessionConfig } from "../avatar-runtime/google-meet-surface.ts";
import { enableMeetCaptions, installMeetCaptionCapture } from "./caption-capture.ts";
import { buildGoogleMeetChromiumArgs } from "./google-meet-launch-args.ts";
import { waitForMeetAdmission } from "./meet-admission.ts";
import { installMeetLocalPlaybackMute } from "./meet-local-playback-mute.ts";
import { createMeetingRecorder, listShareableApplications } from "./meeting-recorder.ts";
import { createWebRTCAudioCaptureSink } from "./webrtc-audio-capture.ts";
import { dismissMeetPrompts, installMeetPromptAutoDismisser } from "./meet-prompts.ts";
import { buildScreenShareInitScript } from "./screen-share-init-builder.ts";
import {
  captureMacOSWindowFrame,
  listMacOSWindowCaptureTargets,
  matchesMacOSWindowCaptureTarget,
  readImageDimensions,
  startMacOSWindowCaptureStream,
} from "./macos-window-capture.ts";
import {
  buildRealtimeInstructions,
  buildRealtimeSessionConfig,
  type RealtimeCurrentUser,
  realtimeToolSchemas,
} from "../realtime/realtime-contract.ts";
import {
  normalizeSpeakerDisplayName,
  resolveSpeakerIdentity,
  type SpeakerIdentityResolution,
} from "../realtime/speaker-identity.ts";

const require = createRequire(import.meta.url);

type Page = import("playwright").Page;
const DEFAULT_SYNTHETIC_SCREEN_SHARE_WIDTH = 2560;
const DEFAULT_SYNTHETIC_SCREEN_SHARE_HEIGHT = 1440;
const DEFAULT_SYNTHETIC_SCREEN_SHARE_FPS = 25;
const MAX_SYNTHETIC_SCREEN_SHARE_WIDTH = 3840;
const MAX_SYNTHETIC_SCREEN_SHARE_HEIGHT = 2160;

interface MeetUrlOptions {
  allowNonGoogleMeet?: boolean;
}

interface VideoStageInput {
  stageTitle?: string;
  title?: string;
  subtitle?: string;
  videoUrl?: string;
  url?: string;
  path?: string;
  muted?: boolean;
  width?: number | string;
  screenShareWidth?: number | string;
  height?: number | string;
  screenShareHeight?: number | string;
  screenShareFps?: number | string;
}

interface ScreenShareBridgeInput extends VideoStageInput {
  mode?: string;
  screenShareMode?: string;
  fps?: number | string;
  preview?: boolean;
  allowCoordinateFallback?: boolean;
  waitMs?: number;
  imageUrl?: string;
  imagePath?: string;
  framePath?: string;
}

interface AppShareInput extends ScreenShareBridgeInput {
  windowId?: number | string;
  windowID?: number | string;
  windowTitle?: string;
  processId?: number | string;
  pid?: number | string;
  bundleIdentifier?: string;
  bundleId?: string;
  applicationName?: string;
  appName?: string;
  name?: string;
}

interface MeetChatInput {
  text?: string;
  message?: string;
  limit?: number;
  count?: number;
  onlyLinks?: boolean;
  only_links?: boolean;
}

interface ButtonInventoryEntry {
  index?: number;
  tag?: string;
  text?: string;
  aria?: string;
  role?: string;
  disabled?: boolean;
  visible?: boolean;
  rect?: { x: number; y: number; width: number; height: number };
  label?: string;
  error?: string;
}

interface Diagnostics {
  sessionId: string;
  startedAt: string;
  events: Array<{ ts: string; type: string; detail: unknown }>;
  console: Array<{ ts: string; type: string; text: string }>;
  pageErrors: Array<{ ts: string; message: string }>;
  requestFailures: Array<{ ts: string; url: string; method: string; failure: string }>;
  screenshots: Array<{ ts: string; name: string; path: string }>;
  buttonInventories: Array<{ ts: string; label: string; buttons: ButtonInventoryEntry[] }>;
  jsonPath: string;
  saving?: boolean;
  record(type: string, detail?: unknown): void;
}

interface AccessibilityNodeLike {
  name?: unknown;
  value?: unknown;
  description?: unknown;
  role?: unknown;
  children?: AccessibilityNodeLike[];
}

interface AccessibilitySnapshotApi {
  snapshot(options: { interestingOnly: boolean }): Promise<unknown>;
}

interface PresentationButton {
  index: number;
  label: string;
  disabled: boolean;
  visible: boolean;
  rect: { x: number; y: number; width: number; height: number };
}

interface PresentationState {
  ok: boolean;
  presenting?: boolean;
  starting?: boolean;
  failed?: boolean;
  textHead?: string;
  shareButtons?: PresentationButton[];
  buttons?: PresentationButton[];
  error?: string;
}

interface ShareScreenButtonInfo {
  index: number;
  label: string;
  rect: { x: number; y: number; width: number; height: number };
}

type ShareScreenDomClickResult =
  | {
      ok: true;
      selector: string;
      button: ShareScreenButtonInfo;
    }
  | {
      ok: false;
      reason: string;
      candidates?: PresentationButton[];
      error?: string;
    };

type ScreenShareControllerState = ScreenShareState | { ok: boolean; error?: string; mode?: string };

interface GuestNameEvalResult {
  ok: boolean;
  reason?: string;
  textHead?: string;
  tag?: string;
  aria?: string;
  placeholder?: string;
  valueLength?: number;
  error?: string;
}

type MeetJoinButtonEvalResult =
  | {
      ok: true;
      selector: string;
      button: PresentationButton;
      candidates: PresentationButton[];
    }
  | {
      ok: false;
      error?: string;
      candidates: PresentationButton[];
    };

interface MeetPageState {
  ok: boolean;
  url?: string;
  title?: string;
  source?: string;
  inMeeting?: boolean;
  participantCount?: number | null;
  participants?: MeetParticipantSignal[];
  activeSpeaker?: MeetSpeakerSignal | null;
  waitingForAdmit?: boolean;
  preJoin?: boolean;
  signIn?: boolean;
  cannotJoin?: boolean;
  textHead?: string;
  buttons?: Array<PresentationButton | { label: string; role: string }>;
  error?: string;
  jsProbe?: { ok: boolean; error?: string };
  accessibilityProbe?: { ok: boolean; error?: string };
}

interface MeetParticipantSignal {
  name: string;
  source: string;
  confidence: "low" | "medium" | "high";
  participantId?: string;
  rawLabel?: string;
  lastSeenAt?: string;
  identity?: SpeakerIdentityResolution | null;
}

interface MeetSpeakerSignal {
  name: string;
  source: string;
  confidence: "low" | "medium" | "high";
  observedAt: string;
  rawLabel?: string;
  text?: string;
  identity?: SpeakerIdentityResolution | null;
}

interface MeetingAwarenessState {
  ok: boolean;
  observedAt: string;
  source: string;
  participants: MeetParticipantSignal[];
  participantCount: number | null;
  activeSpeaker: MeetSpeakerSignal | null;
  recentSpeakers: MeetSpeakerSignal[];
  caveat: string;
}

interface GoogleMeetJoinerOptions {
  allowNonGoogleMeet?: boolean;
  playwrightModulePath?: string;
  chromiumExecutablePath?: string;
}

interface GoogleMeetJoinInput extends ScreenShareBridgeInput {
  meetUrl?: string;
  sessionId?: string;
  botName?: string;
  dryRun?: boolean;
  installAvatar?: boolean;
  installRealtimeBridge?: boolean;
  installLocalDialogBridge?: boolean;
  installWorkerResultBridge?: boolean;
  installScreenShareBridge?: boolean;
  autoStartScreenShare?: boolean;
  workerPollUrl?: string;
  recordMeeting?: boolean;
  captureCaptions?: boolean;
  captionLanguage?: string;
  artifactsDir?: string;
  meetAudioBackend?: string;
  browserUserDataDir?: string;
  meetProfileMode?: string;
  browserViewportWidth?: number | string;
  browserViewportHeight?: number | string;
  muteLocalPlayback?: boolean;
  allowNonGoogleMeet?: boolean;
  realtimeInstructions?: string;
  avatarModelUrl?: string;
  avatarRenderer?: string;
  avatarVRMModelUrl?: string;
  avatarDepsDir?: string;
  avatarLayout?: string;
  disableLive2D?: boolean;
  deferAvatarRendererUntilJoined?: boolean;
  avatarCanvasWidth?: number | string;
  avatarCanvasHeight?: number | string;
  avatarCaptureFps?: number | string;
  realtimeBridgeMode?: string;
  realtimeAgentRuntime?: string;
  realtimeToolCallbackToken?: string;
  autoRespondToWorkerResults?: boolean;
  realtimeTools?: unknown[];
  realtimeSession?: Record<string, unknown>;
  sendRealtimeSessionUpdate?: boolean;
  includeParticipantAudio?: boolean;
  forwardMeetAudioToRealtime?: boolean;
  workerDelegateUrl?: string;
  workerStatusUrl?: string;
  autoConnectRealtime?: boolean;
  realtimeTokenUrl?: string;
  realtimeSdpUrl?: string;
  localDialogTurnUrl?: string;
  localDialogTtsMode?: string;
  localDialogTtsUrl?: string;
  localDialogSttProvider?: string;
  localDialogTtsProvider?: string;
  localDialogTtsGain?: number | string;
  screenShareTitle?: string;
  screenShareSubtitle?: string;
  screenShareWidth?: number | string;
  screenShareHeight?: number | string;
  screenShareFps?: number | string;
  workerResultMinCreatedAt?: string;
  localDialogAcceptanceUtterance?: string;
  collectFixtureState?: boolean;
  browserExtraArgs?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function safeFilePart(value: unknown, fallback = "item"): string {
  return (
    String(value || fallback)
      .replace(/[^a-zA-Z0-9_.-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 96) || fallback
  );
}

function positiveInteger(value: unknown): number | null {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function fitDimensionsWithin(width: number, height: number, maxWidth: number, maxHeight: number) {
  if (!width || !height) return { width: maxWidth, height: maxHeight };
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return {
    width: Math.max(320, Math.round(width * scale)),
    height: Math.max(180, Math.round(height * scale)),
  };
}

function syntheticShareDimensionsFromSource(
  input: ScreenShareBridgeInput = {},
  source: { width?: number; height?: number; frame?: { width?: number; height?: number } } = {},
) {
  const requestedWidth = positiveInteger(input.width ?? input.screenShareWidth);
  const requestedHeight = positiveInteger(input.height ?? input.screenShareHeight);
  const sourceWidth =
    positiveInteger(source.width) ??
    (positiveInteger(source.frame?.width) ? positiveInteger(source.frame?.width)! * 2 : null) ??
    DEFAULT_SYNTHETIC_SCREEN_SHARE_WIDTH;
  const sourceHeight =
    positiveInteger(source.height) ??
    (positiveInteger(source.frame?.height) ? positiveInteger(source.frame?.height)! * 2 : null) ??
    DEFAULT_SYNTHETIC_SCREEN_SHARE_HEIGHT;
  const aspect = sourceWidth / Math.max(1, sourceHeight);
  const width =
    requestedWidth ?? (requestedHeight ? Math.round(requestedHeight * aspect) : sourceWidth);
  const height =
    requestedHeight ?? (requestedWidth ? Math.round(requestedWidth / aspect) : sourceHeight);
  return fitDimensionsWithin(
    width,
    height,
    MAX_SYNTHETIC_SCREEN_SHARE_WIDTH,
    MAX_SYNTHETIC_SCREEN_SHARE_HEIGHT,
  );
}

function assertMeetUrl(meetUrl: string, options: MeetUrlOptions = {}) {
  if (options.allowNonGoogleMeet) return;
  if (!/^https:\/\/meet\.google\.com\/[a-z-]+/i.test(meetUrl || "")) {
    throw new Error("meetUrl must be a Google Meet URL");
  }
}

function normalizeMeetProfileMode(mode: unknown, hasUserDataDir: boolean): "guest" | "persistent" {
  const normalized = String(mode || "")
    .trim()
    .toLowerCase();
  if (!normalized) return hasUserDataDir ? "persistent" : "guest";
  if (normalized === "guest" || normalized === "persistent") return normalized;
  throw new Error("MAB_MEET_PROFILE_MODE must be guest or persistent");
}

function escapeHtml(value: unknown): string {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function normalizeStageVideoUrl(value = ""): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw) || /^file:\/\//i.test(raw) || /^data:/i.test(raw)) return raw;
  return pathToFileURL(pathResolve(raw)).toString();
}

async function normalizeScreenShareImageUrl(value = ""): Promise<string> {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^data:/i.test(raw) || /^https?:\/\//i.test(raw)) return raw;
  const filePath = /^file:\/\//i.test(raw) ? fileURLToPath(raw) : pathResolve(raw);
  const bytes = await readFile(filePath);
  const lower = filePath.toLowerCase();
  const mime =
    lower.endsWith(".jpg") || lower.endsWith(".jpeg")
      ? "image/jpeg"
      : lower.endsWith(".webp")
        ? "image/webp"
        : "image/png";
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
}

interface LocalMultipartFrameServer {
  url: string;
  port: number;
  token: string;
  framePath: string;
  stop: () => void;
  clientCount: () => number;
}

async function startLocalMultipartFrameServer(input: {
  framePath: string;
  fps: number;
}): Promise<LocalMultipartFrameServer> {
  const framePath = pathResolve(input.framePath);
  const fps = Math.max(1, Math.min(30, Number.parseInt(String(input.fps || 25), 10) || 25));
  const token = randomUUID();
  const boundary = `oneesama-${token.replace(/-/g, "")}`;
  const clients = new Set<ServerResponse>();
  let latestFrame: Buffer | null = null;
  let latestSignature = "";
  let busy = false;
  let stopped = false;

  const writeFrame = (res: ServerResponse, frame: Buffer) => {
    if (res.destroyed || res.writableEnded) return;
    try {
      res.write(`--${boundary}\r\n`);
      res.write("Content-Type: image/jpeg\r\n");
      res.write(`Content-Length: ${frame.length}\r\n`);
      res.write("Cache-Control: no-store\r\n\r\n");
      res.write(frame);
      res.write("\r\n");
    } catch {
      clients.delete(res);
      res.destroy();
    }
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname !== `/screen-share/${token}.mjpg`) {
      res.writeHead(404, {
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      });
      res.end("not found");
      return;
    }
    req.socket.setNoDelay(true);
    res.writeHead(200, {
      "Content-Type": `multipart/x-mixed-replace; boundary=${boundary}`,
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      Pragma: "no-cache",
      Expires: "0",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "X-Content-Type-Options": "nosniff",
    });
    clients.add(res);
    if (latestFrame) writeFrame(res, latestFrame);
    req.on("close", () => {
      clients.delete(res);
    });
  });

  const tick = async () => {
    if (busy || stopped || clients.size === 0) return;
    busy = true;
    try {
      const info = await stat(framePath);
      if (!info.size) return;
      const signature = `${info.mtimeMs}:${info.size}`;
      if (signature === latestSignature && latestFrame) return;
      const frame = await readFile(framePath);
      latestFrame = frame;
      latestSignature = signature;
      for (const client of clients) writeFrame(client, frame);
    } catch {
      // The capture helper may be in the middle of its atomic move; retry next tick.
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(tick, Math.max(16, Math.round(1000 / fps)));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  await tick();
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/screen-share/${token}.mjpg`,
    port,
    token,
    framePath,
    stop: () => {
      stopped = true;
      clearInterval(timer);
      for (const client of clients) {
        try {
          client.end();
        } catch {
          client.destroy();
        }
      }
      clients.clear();
      server.close();
    },
    clientCount: () => clients.size,
  };
}

function buildVideoStageHtml(input: VideoStageInput = {}): string {
  const title = escapeHtml(input.stageTitle || input.title || "Meeting Avatar Bot");
  const heading = escapeHtml(input.title || "Onee Sama video stage");
  const subtitle = escapeHtml(input.subtitle || "Screen share video stage");
  const videoUrl = normalizeStageVideoUrl(input.videoUrl || input.url || input.path || "");
  const videoTag = videoUrl
    ? `<video id="stage-video" src="${escapeHtml(videoUrl)}" controls autoplay loop playsinline ${input.muted === false ? "" : "muted"}></video>`
    : `<canvas id="stage-canvas" width="1280" height="720"></canvas>`;
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <style>
    html, body { margin: 0; height: 100%; background: #05070a; color: white; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, sans-serif; overflow: hidden; }
    .stage { width: 100vw; height: 100vh; display: grid; place-items: center; background: radial-gradient(circle at 25% 15%, #253a5d 0, transparent 32%), linear-gradient(135deg, #071018, #111827 52%, #05070a); }
    video, canvas { width: 100vw; height: 100vh; object-fit: contain; background: #05070a; }
    .overlay { position: fixed; left: 32px; bottom: 28px; padding: 14px 18px; border-radius: 10px; background: rgba(5, 7, 10, .72); border: 1px solid rgba(255,255,255,.16); backdrop-filter: blur(10px); }
    .overlay h1 { margin: 0 0 5px; font-size: 28px; line-height: 1.1; }
    .overlay p { margin: 0; font-size: 16px; color: rgba(255,255,255,.76); }
  </style>
</head>
<body>
  <main class="stage">${videoTag}</main>
  <section class="overlay"><h1>${heading}</h1><p>${subtitle}</p></section>
  <script>
    const state = { ok: true, title: document.title, videoUrl: ${JSON.stringify(videoUrl)}, frames: 0, playing: false, errors: [] };
    window.MAB_VIDEO_STAGE = state;
    const video = document.getElementById("stage-video");
    const canvas = document.getElementById("stage-canvas");
    if (video) {
      const mark = () => { state.playing = !video.paused; state.currentTime = video.currentTime; state.duration = video.duration || 0; };
      video.addEventListener("play", mark);
      video.addEventListener("pause", mark);
      video.addEventListener("timeupdate", mark);
      video.addEventListener("error", () => state.errors.push("video_error"));
      video.play().then(mark).catch((error) => {
        state.errors.push(String(error && error.message || error));
        mark();
      });
    }
    if (canvas) {
      const ctx = canvas.getContext("2d");
      function draw() {
        state.frames += 1;
        const t = state.frames / 60;
        const w = canvas.width;
        const h = canvas.height;
        const g = ctx.createLinearGradient(0, 0, w, h);
        g.addColorStop(0, "hsl(" + ((t * 32) % 360) + " 78% 22%)");
        g.addColorStop(.55, "#111827");
        g.addColorStop(1, "hsl(" + (((t * 32) + 110) % 360) + " 72% 20%)");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = "rgba(255,255,255,.12)";
        for (let i = 0; i < 9; i += 1) {
          ctx.fillRect(((i * 151 + state.frames * 9) % (w + 240)) - 120, 110 + i * 58, 280, 3);
        }
        ctx.fillStyle = "#fff";
        ctx.font = "700 72px system-ui, sans-serif";
        ctx.fillText(${JSON.stringify(input.title || "Video stage ready")}, 80, 180);
        ctx.font = "400 34px system-ui, sans-serif";
        ctx.fillStyle = "rgba(255,255,255,.78)";
        ctx.fillText(${JSON.stringify(input.subtitle || "Drop a video URL or local file path to play it here.")}, 84, 240);
        requestAnimationFrame(draw);
      }
      draw();
    }
  </script>
</body>
</html>`;
}

async function loadPlaywright(modulePath?: string) {
  if (modulePath) return require(modulePath);
  return await import("playwright");
}

function createDiagnostics(sessionId: string, screenshotDir: string): Diagnostics {
  const diagnostics: Diagnostics = {
    sessionId,
    startedAt: nowIso(),
    events: [],
    console: [],
    pageErrors: [],
    requestFailures: [],
    screenshots: [],
    buttonInventories: [],
    jsonPath: `${screenshotDir}/${sessionId}-diagnostics.json`,
    record: () => {},
  };

  diagnostics.record = (type, detail = {}) => {
    diagnostics.events.push({ ts: nowIso(), type, detail });
  };

  return diagnostics;
}

async function saveDiagnostics(diagnostics: Diagnostics) {
  if (diagnostics.saving) return;
  diagnostics.saving = true;
  const serializable = { ...diagnostics };
  delete serializable.record;
  delete serializable.saving;
  try {
    await writeFile(diagnostics.jsonPath, `${JSON.stringify(serializable, null, 2)}\n`);
  } finally {
    diagnostics.saving = false;
  }
}

function installPageDiagnostics(page: Page, diagnostics: Diagnostics) {
  page.on("console", (message) => {
    diagnostics.console.push({
      ts: nowIso(),
      type: message.type(),
      text: message.text().slice(0, 1000),
    });
  });
  page.on("pageerror", (error) => {
    diagnostics.pageErrors.push({
      ts: nowIso(),
      message: String(error?.message || error).slice(0, 1000),
    });
  });
  page.on("requestfailed", (request) => {
    diagnostics.requestFailures.push({
      ts: nowIso(),
      url: request.url(),
      method: request.method(),
      failure: request.failure()?.errorText || "request_failed",
    });
  });
}

function isRetryableMeetGotoError(error: unknown): boolean {
  const message = String((error as Error)?.message || error);
  return ["net::ERR_CONNECTION_CLOSED", "net::ERR_ABORTED", "Execution context was destroyed"].some(
    (fragment) => message.includes(fragment),
  );
}

async function gotoMeetWithRetry(page: Page, meetUrl: string, diagnostics: Diagnostics) {
  const maxAttempts = 2;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    diagnostics.record("goto_attempt", { meetUrl, attempt, maxAttempts });
    await saveDiagnostics(diagnostics);
    try {
      return await page.goto(meetUrl, { waitUntil: "commit", timeout: 25_000 });
    } catch (error) {
      lastError = error;
      diagnostics.record("goto_attempt_failed", {
        meetUrl,
        attempt,
        maxAttempts,
        retryable: isRetryableMeetGotoError(error),
        error: String((error as Error)?.message || error).slice(0, 1000),
      });
      await saveDiagnostics(diagnostics);
      if (attempt >= maxAttempts || !isRetryableMeetGotoError(error)) break;
      await page.waitForTimeout(750).catch(() => {});
    }
  }
  throw lastError;
}

async function takeScreenshot(page: Page, diagnostics: Diagnostics, name: string): Promise<string> {
  if (process.env.MAB_SKIP_SCREENSHOTS === "1") {
    diagnostics.record("screenshot_skipped", { name });
    return "";
  }
  const path = diagnostics.jsonPath.replace("-diagnostics.json", `-${name}.png`);
  try {
    const result = await withTimeout(
      page.screenshot({
        path,
        fullPage: false,
        animations: "disabled",
        timeout: 8000,
      }),
      9000,
      { timedOut: true },
    );
    if (typeof result === "object" && result !== null && "timedOut" in result && result.timedOut) {
      throw new Error("screenshot_timeout");
    }
    diagnostics.screenshots.push({ ts: nowIso(), name, path });
    diagnostics.record("screenshot", { name, path });
    return path;
  } catch (error) {
    diagnostics.record("screenshot_failed", {
      name,
      path,
      error: String(error?.message || error).slice(0, 300),
    });
    return "";
  }
}

async function collectButtonInventory(
  page: Page,
  diagnostics: Diagnostics,
  label: string,
): Promise<ButtonInventoryEntry[]> {
  if (process.env.MAB_SKIP_BUTTON_INVENTORY === "1") {
    diagnostics.buttonInventories.push({ ts: nowIso(), label, buttons: [] });
    diagnostics.record("button_inventory_skipped", { label });
    return [];
  }
  const inventoryPromise = page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll<HTMLElement>("button, [role=button]"));
    return nodes
      .slice(0, 80)
      .map((node, index) => {
        const rect = node.getBoundingClientRect();
        return {
          index,
          tag: node.tagName.toLowerCase(),
          text: (node.innerText || node.textContent || "").trim().slice(0, 120),
          aria: node.getAttribute("aria-label") || "",
          role: node.getAttribute("role") || "",
          disabled: Boolean(
            ("disabled" in node && typeof node.disabled === "boolean" && node.disabled) ||
            node.getAttribute("aria-disabled") === "true",
          ),
          visible:
            rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== "hidden",
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        };
      })
      .filter((button) => button.text || button.aria || button.visible);
  });
  const buttons = (await Promise.race([
    inventoryPromise,
    new Promise((resolve) =>
      setTimeout(
        () =>
          resolve([
            {
              error: "button_inventory_timeout",
            },
          ]),
        2500,
      ),
    ),
  ]).catch((error) => [
    {
      error: String(error?.message || error),
    },
  ])) as ButtonInventoryEntry[];
  diagnostics.buttonInventories.push({ ts: nowIso(), label, buttons });
  diagnostics.record("button_inventory", { label, count: buttons.length });
  return buttons;
}

async function clickFirstVisible(
  page: Page,
  selectors: string[],
  timeout = 1800,
  diagnostics: Diagnostics | null = null,
) {
  for (const selector of selectors) {
    try {
      await page.locator(selector).first().click({ timeout });
      diagnostics?.record("click", { selector });
      return selector;
    } catch (error) {
      diagnostics?.record("click_miss", {
        selector,
        error: String(error?.message || error).slice(0, 180),
      });
      // Keep trying the next localized / aria selector.
    }
  }
  return "";
}

async function withTimeout<T, F>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: F,
): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<F>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function collectAccessibilitySnapshotText(node: unknown, output: string[] = []): string[] {
  if (!node || typeof node !== "object") return output;
  const accessibilityNode = node as AccessibilityNodeLike;
  for (const field of ["name", "value", "description"]) {
    const value = accessibilityNode[field as keyof AccessibilityNodeLike];
    if (typeof value === "string" && value.trim()) output.push(value.trim());
  }
  for (const child of accessibilityNode.children || [])
    collectAccessibilitySnapshotText(child, output);
  return output;
}

function collectAccessibilityButtons(
  node: unknown,
  output: Array<{ label: string; role: string }> = [],
) {
  if (!node || typeof node !== "object") return output;
  const accessibilityNode = node as AccessibilityNodeLike;
  if (
    accessibilityNode.role === "button" &&
    typeof accessibilityNode.name === "string" &&
    accessibilityNode.name.trim()
  ) {
    output.push({
      label: accessibilityNode.name.trim().slice(0, 160),
      role: accessibilityNode.role,
    });
  }
  for (const child of accessibilityNode.children || []) collectAccessibilityButtons(child, output);
  return output;
}

async function evaluateMeetAccessibilityState(page: Page): Promise<MeetPageState> {
  const accessibility = (page as Page & { accessibility?: AccessibilitySnapshotApi }).accessibility;
  if (!accessibility?.snapshot) {
    return { ok: false, error: "meet_accessibility_unavailable" };
  }
  const snapshot = await withTimeout(
    accessibility.snapshot({ interestingOnly: false }),
    2500,
    null,
  ).catch(() => null);
  if (!snapshot) return { ok: false, error: "meet_accessibility_state_timeout" };
  const text = collectAccessibilitySnapshotText(snapshot).join("\n").replace(/\s+/g, " ").trim();
  const buttons = collectAccessibilityButtons(snapshot).slice(0, 30);
  const waitingForAdmit =
    /Please wait until a meeting host brings you into the call|Someone will let you in soon|waiting for.*host/i.test(
      text,
    );
  const inMeetingSignals = [
    /You have joined the call/i.test(text),
    /Your camera is on/i.test(text),
    /Your microphone is on/i.test(text),
    /Call controls/i.test(text),
    /Leave call|Leave meeting/i.test(text),
    /Present now|Share screen/i.test(text),
    buttons.some((button) =>
      /Leave call|Leave meeting|Turn off microphone|Turn on microphone|Turn off camera|Turn on camera|Raise hand|More options|Share screen|Present now/i.test(
        button.label,
      ),
    ),
  ];
  const inMeeting = !waitingForAdmit && inMeetingSignals.some(Boolean);
  const cannotJoin =
    !inMeeting &&
    !waitingForAdmit &&
    /You can't join this video call|No one can join a meeting unless invited or admitted by the host/i.test(
      text,
    );
  return {
    ok: true,
    source: "accessibility",
    url: page.url(),
    title: "",
    inMeeting,
    waitingForAdmit,
    preJoin: /Join now|Ask to join|Getting ready/i.test(text),
    signIn: /Forgot email|Create account|Use your Google Account/i.test(text),
    cannotJoin,
    textHead: text.slice(0, 1000),
    buttons,
  };
}

async function revealMeetToolbar(page: Page, diagnostics: Diagnostics | null = null) {
  try {
    const viewport = page.viewportSize() || { width: 1920, height: 1080 };
    await page.mouse.move(Math.round(viewport.width / 2), Math.max(1, viewport.height - 48));
    await page.waitForTimeout(250);
    diagnostics?.record("meet_toolbar_revealed", {
      width: viewport.width,
      height: viewport.height,
    });
  } catch (error) {
    diagnostics?.record("meet_toolbar_reveal_failed", {
      error: String(error?.message || error).slice(0, 180),
    });
  }
}

async function getMeetPresentationState(page: Page): Promise<PresentationState> {
  return await withTimeout(
    page.evaluate(() => {
      const text = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
      const has = (pattern) => pattern.test(text);
      const isDisabled = (node: HTMLElement) =>
        Boolean(
          ("disabled" in node && typeof node.disabled === "boolean" && node.disabled) ||
          node.getAttribute("aria-disabled") === "true",
        );
      const buttons = Array.from(document.querySelectorAll<HTMLElement>("button, [role=button]"))
        .map((node, index) => {
          const rect = node.getBoundingClientRect();
          const label =
            `${node.innerText || node.textContent || ""} ${node.getAttribute("aria-label") || ""}`
              .replace(/\s+/g, " ")
              .trim();
          return {
            index,
            label: label.slice(0, 120),
            disabled: isDisabled(node),
            visible:
              rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== "hidden",
            rect: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
          };
        })
        .filter((button) => button.visible && button.label);
      return {
        ok: true,
        presenting: has(/\b(You'?re presenting|You are presenting|Stop presenting)\b/i),
        starting: has(/Presentation is starting/i),
        failed: has(/Can't share your screen|Something went wrong when screen sharing/i),
        textHead: text.slice(0, 800),
        shareButtons: buttons
          .filter((button) =>
            /share screen|present|presentation|stop presenting/i.test(button.label),
          )
          .slice(0, 12),
        buttons: buttons.slice(0, 30),
      };
    }),
    2500,
    { ok: false, error: "presentation_state_timeout" },
  ).catch((error) => ({ ok: false, error: String(error?.message || error) }));
}

async function clickMeetShareScreenControl(
  page: Page,
  diagnostics: Diagnostics | null = null,
  options: { allowCoordinateFallback?: boolean } = {},
) {
  await revealMeetToolbar(page, diagnostics);
  const domClick = await withTimeout<ShareScreenDomClickResult, ShareScreenDomClickResult>(
    page.evaluate(() => {
      const isDisabled = (node: HTMLElement) =>
        Boolean(
          ("disabled" in node && typeof node.disabled === "boolean" && node.disabled) ||
          node.getAttribute("aria-disabled") === "true",
        );
      const isVisible = (node) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== "hidden" &&
          style.display !== "none"
        );
      };
      const nodes = Array.from(document.querySelectorAll<HTMLElement>("button, [role=button]"));
      const candidates = nodes
        .map((node, index) => {
          const label =
            `${node.innerText || node.textContent || ""} ${node.getAttribute("aria-label") || ""}`
              .replace(/\s+/g, " ")
              .trim();
          const rect = node.getBoundingClientRect();
          return {
            node,
            index,
            label,
            disabled: isDisabled(node),
            visible: isVisible(node),
            rect: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
          };
        })
        .filter(
          (candidate) =>
            candidate.visible &&
            !candidate.disabled &&
            /\b(share screen|present now|present)\b|computer_arrow_up|present_to_all/i.test(
              candidate.label,
            ),
        );
      const candidate = candidates[0];
      if (!candidate) {
        return {
          ok: false,
          reason: "share_screen_button_not_found",
          candidates: candidates.slice(0, 8).map(({ index, label, disabled, visible, rect }) => ({
            index,
            label,
            disabled,
            visible,
            rect,
          })),
        };
      }
      candidate.node.click();
      return {
        ok: true,
        selector: "dom:meet-share-screen-button",
        button: {
          index: candidate.index,
          label: candidate.label,
          rect: candidate.rect,
        },
      };
    }),
    2500,
    { ok: false, reason: "share_screen_dom_click_timeout" },
  ).catch(
    (error): ShareScreenDomClickResult => ({
      ok: false,
      reason: "share_screen_dom_click_error",
      error: String(error?.message || error).slice(0, 240),
    }),
  );
  if (domClick.ok) {
    diagnostics?.record("click", { selector: domClick.selector, button: domClick.button });
    return domClick.selector;
  }
  diagnostics?.record("click_miss", domClick);

  const locatorCandidates = [
    {
      selector: "role:button[name=/share screen|present now|present/i]",
      locator: () =>
        page.getByRole("button", { name: /share screen|present now|present/i }).first(),
    },
    {
      selector: "[aria-label*=present/share-screen]",
      locator: () =>
        page
          .locator(
            '[aria-label*="Present" i], [aria-label*="Share screen" i], [data-tooltip*="Present" i], [data-tooltip*="Share screen" i]',
          )
          .first(),
    },
  ];
  for (const candidate of locatorCandidates) {
    try {
      await candidate.locator().click({ timeout: 2500 });
      diagnostics?.record("click", { selector: candidate.selector });
      return candidate.selector;
    } catch (error) {
      diagnostics?.record("click_miss", {
        selector: candidate.selector,
        error: String(error?.message || error).slice(0, 180),
      });
    }
  }

  if (options.allowCoordinateFallback) {
    try {
      const viewport = page.viewportSize() || { width: 1920, height: 1080 };
      const x = Math.round(viewport.width * 0.47);
      const y = Math.max(1, viewport.height - 40);
      await page.mouse.click(x, y, { delay: 20 });
      diagnostics?.record("click", { selector: "coordinate:bottom-toolbar-share-screen", x, y });
      return "coordinate:bottom-toolbar-share-screen";
    } catch (error) {
      diagnostics?.record("click_miss", {
        selector: "coordinate:bottom-toolbar-share-screen",
        error: String(error?.message || error).slice(0, 180),
      });
    }
  }

  return "";
}

async function readScreenShareControllerState(
  page: Page,
): Promise<ScreenShareControllerState | null> {
  return await withTimeout(
    page.evaluate(() => {
      if (window.MAB_SCREEN_SHARE_CONTROLLER?.status)
        return window.MAB_SCREEN_SHARE_CONTROLLER.status();
      if (window.MAB_SCREEN_SHARE_CONTROLLER?.state)
        return window.MAB_SCREEN_SHARE_CONTROLLER.state();
      if (window.MAB_SCREEN_SHARE_CONTROLLER?.mode)
        return { ok: true, mode: window.MAB_SCREEN_SHARE_CONTROLLER.mode };
      return null;
    }),
    2500,
    { ok: false, error: "screen_share_controller_state_timeout" },
  ).catch((error) => ({ ok: false, error: String(error?.message || error) }));
}

async function waitForScreenShareImageSource(page: Page, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  let state: ScreenShareControllerState | null = null;
  while (Date.now() < deadline) {
    state = await readScreenShareControllerState(page);
    const screenShare = state as any;
    if (screenShare?.imageUrl && screenShare?.imageReady) {
      return { ok: true, state };
    }
    const errors = Array.isArray(screenShare?.errors) ? screenShare.errors : [];
    if (screenShare?.imageError || errors.some((entry) => /image/i.test(String(entry)))) {
      return {
        ok: false,
        error: String(
          screenShare.imageError || errors.find((entry) => /image/i.test(String(entry))),
        ),
        state,
      };
    }
    await page.waitForTimeout(100);
  }
  return {
    ok: false,
    error: "screen_share_image_source_not_attached",
    state,
  };
}

async function ensureScreenShareController(page: Page, input: ScreenShareBridgeInput = {}) {
  const current = await readScreenShareControllerState(page);
  if (current?.ok || current?.mode) return { ok: true, installed: false, state: current };
  const installScript = buildScreenShareInitScript({
    enabled: true,
    mode: input.mode || "synthetic",
    title: input.title || "Meeting Avatar Bot",
    subtitle: input.subtitle || "Agent screen share",
    width:
      positiveInteger(input.width ?? input.screenShareWidth) ||
      DEFAULT_SYNTHETIC_SCREEN_SHARE_WIDTH,
    height:
      positiveInteger(input.height ?? input.screenShareHeight) ||
      DEFAULT_SYNTHETIC_SCREEN_SHARE_HEIGHT,
    fps: positiveInteger(input.fps ?? input.screenShareFps) || DEFAULT_SYNTHETIC_SCREEN_SHARE_FPS,
    videoUrl: input.videoUrl || input.url || input.path || "",
    muted: input.muted !== false,
  });
  const install: { ok: boolean; error?: string } = await page
    .evaluate(installScript)
    .then(() => ({ ok: true }))
    .catch((error) => ({ ok: false, error: String(error?.message || error) }));
  if (!install.ok) {
    return { ok: false, installed: false, error: install.error, state: current };
  }
  const installed = await readScreenShareControllerState(page);
  return {
    ok: Boolean(installed?.ok || installed?.mode),
    installed: true,
    state: installed,
  };
}

async function fillGuestName(
  page: Page,
  botName: string,
  diagnostics: Diagnostics | null = null,
  timeoutMs = 35_000,
) {
  const deadline = Date.now() + timeoutMs;
  let lastResult: GuestNameEvalResult | null = null;
  while (Date.now() < deadline) {
    await dismissMeetPrompts(page, diagnostics);
    const result = await withTimeout<GuestNameEvalResult, GuestNameEvalResult>(
      page.evaluate((name) => {
        const text = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
        if (
          /You can't join this video call|No one can join a meeting unless invited or admitted by the host/i.test(
            text,
          )
        ) {
          return {
            ok: false,
            reason: "cannot_join_meeting",
            textHead: text.slice(0, 500),
          };
        }
        const hasGuestJoinForm = /What'?s your name\?|Ask to join|Join now/i.test(text);
        const hasAntiBotInterlock =
          /Getting ready\.\.\./i.test(text) ||
          (/confirm you'?re not a bot/i.test(text) && !hasGuestJoinForm);
        if (hasAntiBotInterlock) {
          return {
            ok: false,
            reason: "meet_anti_bot_prejoin",
            textHead: text.slice(0, 500),
          };
        }
        if (
          /Forgot email|Create account|Use your Google Account/i.test(text) &&
          /accounts\.google\.com/i.test(location.href)
        ) {
          return {
            ok: false,
            reason: "google_sign_in_required",
            textHead: text.slice(0, 500),
          };
        }
        const isVisible = (node) => {
          const rect = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.visibility !== "hidden" &&
            style.display !== "none"
          );
        };
        const getValueLength = (node: HTMLElement) =>
          "value" in node && typeof node.value === "string"
            ? node.value.length
            : (node.textContent || "").length;
        const fields = Array.from(
          document.querySelectorAll<HTMLElement>(
            [
              'input[aria-label*="name" i]',
              'input[placeholder*="name" i]',
              'input[type="text"]',
              "textarea",
              '[contenteditable="true"]',
            ].join(","),
          ),
        );
        const visibleFields = fields.filter(isVisible);
        const field =
          visibleFields.find((node) => {
            const label =
              `${node.getAttribute("aria-label") || ""} ${node.getAttribute("placeholder") || ""}`.toLowerCase();
            return label.includes("name") || label.includes("your name") || fields.length === 1;
          }) || visibleFields[0];
        if (!field) {
          return {
            ok: false,
            reason: "guest_name_field_absent",
            textHead: (document.body?.innerText || "").slice(0, 500),
          };
        }
        field.focus();
        if ("value" in field) {
          field.value = "";
          field.dispatchEvent(
            new InputEvent("input", {
              bubbles: true,
              inputType: "deleteContentBackward",
              data: null,
            }),
          );
          field.value = name;
          field.dispatchEvent(
            new InputEvent("input", { bubbles: true, inputType: "insertText", data: name }),
          );
          field.dispatchEvent(new Event("change", { bubbles: true }));
        } else {
          field.textContent = "";
          field.dispatchEvent(
            new InputEvent("input", {
              bubbles: true,
              inputType: "deleteContentBackward",
              data: null,
            }),
          );
          field.textContent = name;
          field.dispatchEvent(
            new InputEvent("input", { bubbles: true, inputType: "insertText", data: name }),
          );
        }
        field.blur();
        return {
          ok: true,
          tag: field.tagName.toLowerCase(),
          aria: field.getAttribute("aria-label") || "",
          placeholder: field.getAttribute("placeholder") || "",
          valueLength: getValueLength(field),
        };
      }, botName),
      2500,
      {
        ok: false,
        reason: "guest_name_eval_timeout",
      },
    ).catch(
      (error): GuestNameEvalResult => ({
        ok: false,
        reason: "guest_name_eval_error",
        error: String(error?.message || error).slice(0, 300),
      }),
    );
    lastResult = result;
    if (["cannot_join_meeting", "google_sign_in_required"].includes(result.reason)) {
      diagnostics?.record("guest_name_terminal_state", result);
      return result;
    }
    if (result.ok) {
      diagnostics?.record("guest_name_filled", { botName, ...result });
      return result;
    }
    diagnostics?.record("guest_name_wait", result);
    await page.waitForTimeout(1000);
  }
  diagnostics?.record("guest_name_absent", lastResult || { reason: "timeout" });
  return { ok: false, ...(lastResult || { reason: "timeout" }) };
}

async function clickMeetJoinButton(
  page: Page,
  diagnostics: Diagnostics | null = null,
  timeoutMs = 45_000,
) {
  const deadline = Date.now() + timeoutMs;
  let lastCandidates: PresentationButton[] = [];
  let clickedSelector = "";
  while (Date.now() < deadline) {
    await dismissMeetPrompts(page, diagnostics);
    const result = await withTimeout<MeetJoinButtonEvalResult, MeetJoinButtonEvalResult>(
      page.evaluate(() => {
        const isVisible = (node) => {
          const rect = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.visibility !== "hidden" &&
            style.display !== "none"
          );
        };
        const buttons = Array.from(document.querySelectorAll<HTMLElement>("button, [role=button]"));
        const candidates = buttons
          .map((node, index) => {
            const label =
              `${node.innerText || node.textContent || ""} ${node.getAttribute("aria-label") || ""}`
                .replace(/\s+/g, " ")
                .trim();
            const rect = node.getBoundingClientRect();
            return {
              index,
              label: label.slice(0, 160),
              disabled: Boolean(
                ("disabled" in node && typeof node.disabled === "boolean" && node.disabled) ||
                node.getAttribute("aria-disabled") === "true",
              ),
              visible: isVisible(node),
              rect: {
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
              },
            };
          })
          .filter(
            (button) =>
              button.visible &&
              /\b(ask to join|join now|join)\b|申请加入|立即加入|加入/i.test(button.label),
          );
        const enabled = candidates.find((button) => !button.disabled);
        if (!enabled) return { ok: false, candidates };
        buttons[enabled.index].click();
        return { ok: true, selector: "dom:meet-join-button", button: enabled, candidates };
      }),
      2500,
      {
        ok: false,
        error: "join_button_eval_timeout",
        candidates: [],
      },
    ).catch(
      (error): MeetJoinButtonEvalResult => ({
        ok: false,
        error: String(error?.message || error).slice(0, 300),
        candidates: [],
      }),
    );
    lastCandidates = result.candidates || [];
    if (result.ok) {
      clickedSelector = result.selector;
      diagnostics?.record("click", {
        selector: result.selector,
        button: result.button,
      });
      if (result.button?.rect) {
        await page.mouse
          .click(
            result.button.rect.x + Math.round(result.button.rect.width / 2),
            result.button.rect.y + Math.round(result.button.rect.height / 2),
            { delay: 30 },
          )
          .catch((error) => {
            diagnostics?.record("click_miss", {
              selector: "mouse:meet-join-button",
              error: String(error?.message || error).slice(0, 180),
            });
          });
      }
      await page.waitForTimeout(3000);
      const pageState = await evaluateMeetPageState(page);
      diagnostics?.record("join_after_click_state", { pageState });
      if (pageState.waitingForAdmit) return result.selector;
      if (pageState.inMeeting) return result.selector;
      if (pageState.error === "meet_page_state_timeout") {
        diagnostics?.record("join_state_probe_timeout_assume_clicked", {
          selector: result.selector,
          reason: "meet_spa_blocks_runtime_evaluation_after_join_click",
        });
        return result.selector;
      }
      if (pageState.signIn) {
        diagnostics?.record("join_terminal_state", {
          reason: "google_sign_in_required",
          pageState,
        });
        return "";
      }
      await page.waitForTimeout(1000);
      continue;
    }
    if (clickedSelector) {
      const pageState = await evaluateMeetPageState(page);
      if (pageState.waitingForAdmit) return clickedSelector;
      if (pageState.inMeeting) return clickedSelector;
      if (pageState.signIn) {
        diagnostics?.record("join_terminal_state", {
          reason: "google_sign_in_required",
          pageState,
        });
        return "";
      }
    }
    diagnostics?.record("join_wait", {
      error: "error" in result ? result.error || "" : "",
      candidates: lastCandidates.slice(0, 8),
    });
    const pageState = await evaluateMeetPageState(page);
    diagnostics?.record("join_wait_state", {
      inMeeting: pageState?.inMeeting === true,
      waitingForAdmit: pageState?.waitingForAdmit === true,
      preJoin: pageState?.preJoin === true,
      signIn: pageState?.signIn === true,
      cannotJoin: pageState?.cannotJoin === true,
      textHead: String(pageState?.textHead || "").slice(0, 240),
    });
    await page.waitForTimeout(1000);
  }
  diagnostics?.record("join_wait_timeout", { candidates: lastCandidates.slice(0, 8) });
  return "";
}

async function evaluateAvatarReady(page) {
  return await evaluateWindowState(page, "MAB_AVATAR_READY");
}

async function startAvatarRenderer(page, diagnostics: Diagnostics | null = null) {
  const result = await withTimeout(
    page.evaluate(async () => {
      if (!window.MAB_AVATAR_START_RENDERER) {
        return { ok: false, error: "avatar_renderer_start_missing" };
      }
      const ready = await window.MAB_AVATAR_START_RENDERER();
      return { ok: true, ready: ready || window.MAB_AVATAR_READY || null };
    }),
    25_000,
    { ok: false, error: "avatar_renderer_start_timeout" },
  ).catch((error) => ({
    ok: false,
    error: String(error?.message || error).slice(0, 300),
  }));
  diagnostics?.record("avatar_renderer_start", result);
  return result;
}

async function evaluateAvatarAudio(page) {
  return await evaluateWindowState(page, "MAB_AVATAR_AUDIO");
}

async function evaluateFixtureState(page) {
  return await evaluateWindowState(page, "__MAB_MEET_FIXTURE");
}

async function evaluateRealtimeBridgeState(page) {
  return await evaluateWindowState(page, "MAB_REALTIME_BRIDGE");
}

async function evaluateWorkerResultBridgeState(page) {
  return await evaluateWindowState(page, "MAB_WORKER_RESULT_BRIDGE");
}

async function evaluateWindowState(page, key: string) {
  return await withTimeout(
    page.evaluate((name) => window[name] || null, key),
    2500,
    null,
  ).catch(() => null);
}

async function evaluateLocalDialogState(page) {
  return await withTimeout(
    page.evaluate(() => {
      if (window.MAB_LOCAL_DIALOG) return window.MAB_LOCAL_DIALOG;
      const config = window.MAB_LOCAL_DIALOG_CONFIG || null;
      const controller = window.MAB_LOCAL_DIALOG_CONTROLLER || null;
      if (!config && !controller) return null;
      return {
        ok: false,
        bootstrapOnly: true,
        enabled: Boolean(config?.enabled),
        provider: "",
        utterancesReceived: 0,
        responsesSpoken: 0,
        controllerReady: typeof controller?.sendUtterance === "function",
        config,
        errors: [{ message: "local_dialog_state_missing" }],
      };
    }),
    2500,
    null,
  ).catch(() => null);
}

async function evaluateScreenShareState(page) {
  return await evaluateWindowState(page, "MAB_SCREEN_SHARE");
}

function compactCaptionState(captions) {
  if (!captions) return null;
  return {
    ok: captions.ok,
    count: captions.count,
    latest: captions.latest || null,
    paths: captions.paths || null,
    containerFound: Boolean(captions.browser?.containerFound),
    errors: captions.browser?.errors || [],
  };
}

function captionEventTimeMs(event: any): number {
  const parsed = Date.parse(String(event?.ts || event?.timestamp || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function captionSpeakerSignal(event: any): MeetSpeakerSignal | null {
  const name = normalizeSpeakerDisplayName(event?.speaker);
  if (!name) return null;
  return {
    name,
    source: event?.source || "google-meet-caption-dom",
    confidence: "high",
    observedAt: String(event?.ts || event?.timestamp || nowIso()),
    text: String(event?.text || "").slice(0, 240),
  };
}

export function buildMeetingAwarenessState({
  meetPage,
  captions,
  currentUser,
  nowMs = Date.now(),
  recentWindowMs = 30_000,
}: {
  meetPage?: MeetPageState | null;
  captions?: any;
  currentUser?: RealtimeCurrentUser | null;
  nowMs?: number;
  recentWindowMs?: number;
} = {}): MeetingAwarenessState {
  const participantMap = new Map<string, MeetParticipantSignal>();
  const addParticipant = (candidate: Partial<MeetParticipantSignal> | null | undefined) => {
    const name = normalizeSpeakerDisplayName(candidate?.name);
    if (!name) return;
    const key = name.toLowerCase();
    const existing = participantMap.get(key);
    const next: MeetParticipantSignal = {
      name,
      source: candidate?.source || "unknown",
      confidence: candidate?.confidence || "low",
      participantId: candidate?.participantId || existing?.participantId || "",
      rawLabel: candidate?.rawLabel || existing?.rawLabel || "",
      lastSeenAt: candidate?.lastSeenAt || existing?.lastSeenAt || nowIso(),
      identity: resolveSpeakerIdentity(name, currentUser) || existing?.identity || null,
    };
    const rank = { low: 1, medium: 2, high: 3 };
    if (!existing || rank[next.confidence] >= rank[existing.confidence]) {
      participantMap.set(key, next);
    }
  };

  for (const participant of meetPage?.participants || []) addParticipant(participant);

  const captionEvents = [
    ...(Array.isArray(captions?.tail) ? captions.tail : []),
    ...(Array.isArray(captions?.captions) ? captions.captions.slice(-12) : []),
    captions?.latest,
  ].filter(Boolean);
  const recentSpeakers: MeetSpeakerSignal[] = [];
  const seenRecent = new Set<string>();
  for (const event of captionEvents) {
    const signal = captionSpeakerSignal(event);
    if (!signal) continue;
    addParticipant({
      name: signal.name,
      source: "caption_speaker",
      confidence: "medium",
      lastSeenAt: signal.observedAt,
    });
    const key = signal.name.toLowerCase();
    if (!seenRecent.has(key)) {
      seenRecent.add(key);
      recentSpeakers.push(signal);
    }
  }

  const latestCaption = captionSpeakerSignal(captions?.latest);
  const latestCaptionAge = latestCaption
    ? nowMs - captionEventTimeMs(captions?.latest)
    : Number.POSITIVE_INFINITY;
  const captionIsFresh =
    latestCaption && (!Number.isFinite(latestCaptionAge) || latestCaptionAge <= recentWindowMs);
  const domSpeaker = meetPage?.activeSpeaker || null;
  const activeSpeaker = captionIsFresh ? latestCaption : domSpeaker || latestCaption || null;
  if (activeSpeaker?.name) {
    activeSpeaker.identity = resolveSpeakerIdentity(activeSpeaker.name, currentUser);
  }
  if (activeSpeaker?.name) {
    addParticipant({
      name: activeSpeaker.name,
      source: activeSpeaker.source,
      confidence: activeSpeaker.confidence,
      lastSeenAt: activeSpeaker.observedAt,
      rawLabel: activeSpeaker.rawLabel,
    });
  }

  const participants = Array.from(participantMap.values()).toSorted((a, b) =>
    a.name.localeCompare(b.name),
  );
  const participantCount =
    typeof meetPage?.participantCount === "number" && Number.isFinite(meetPage.participantCount)
      ? meetPage.participantCount
      : participants.length || null;
  return {
    ok: Boolean(meetPage?.ok || captions?.ok),
    observedAt: nowIso(),
    source: "meet_dom_and_caption_tail",
    participants,
    participantCount,
    activeSpeaker,
    recentSpeakers: recentSpeakers.slice(-8),
    caveat:
      "Best-effort Google Meet DOM/caption heuristic; active speaker is not an official Google API signal.",
  };
}

export function meetingAwarenessContextText(awareness: MeetingAwarenessState | null): string {
  if (!awareness?.ok) return "";
  const displayName = (entry?: { name?: string; identity?: SpeakerIdentityResolution | null }) =>
    entry?.identity?.preferredName || entry?.identity?.canonicalName || entry?.name || "";
  const names = awareness.participants
    .map((participant) => displayName(participant))
    .filter(Boolean);
  const speaker = displayName(awareness.activeSpeaker || undefined) || "暂时不确定";
  const lines = [
    "会议实时状态更新：",
    `- 当前可见参会者：${names.length ? names.join("、") : "暂时不确定"}。`,
    `- 当前或最近说话的人：${speaker}。`,
  ];
  const identity = awareness.activeSpeaker?.identity;
  if (identity?.resolved) {
    lines.splice(
      3,
      0,
      identity.isCurrentUser
        ? "- 这位说话者就是当前用户；第一人称表达按当前用户理解。"
        : `- 这位说话者可以按 ${identity.preferredName || identity.canonicalName} 理解。`,
    );
  }
  return lines.join("\n");
}

function meetingAwarenessSignature(awareness: MeetingAwarenessState | null): string {
  if (!awareness?.ok) return "";
  const participants = awareness.participants
    .map((participant) => participant.name.toLowerCase())
    .toSorted()
    .join("|");
  const speakerIdentity = awareness.activeSpeaker?.identity;
  const speaker = [
    awareness.activeSpeaker?.name?.toLowerCase() || "",
    speakerIdentity?.canonicalName?.toLowerCase() || "",
    speakerIdentity?.preferredName?.toLowerCase() || "",
    speakerIdentity?.isCurrentUser ? "current_user" : "",
  ].join("|");
  if (!participants && !speaker) return "";
  return `${speaker}::${participants}`;
}

async function publishMeetingAwarenessToPage(
  page: Page,
  awareness: MeetingAwarenessState | null,
  pushContext = true,
) {
  if (!awareness?.ok) return { ok: false, skipped: true, reason: "awareness_empty" };
  const contextText = meetingAwarenessContextText(awareness);
  return await withTimeout(
    page.evaluate(
      ({ state, text, push, signature }) => {
        window.MAB_MEETING_AWARENESS = state;
        if (!push) return { ok: true, stored: true, pushed: false, reason: "unchanged" };
        if (!text) return { ok: true, stored: true, pushed: false, reason: "empty_context" };
        const client = window.MAB_REALTIME_CLIENT;
        if (typeof client?.pushSessionContext === "function") {
          const result = client.pushSessionContext({
            text,
            signature,
            reason: "meeting_awareness",
            kind: "meetingAwareness",
            value: state,
          });
          return {
            ok: true,
            stored: true,
            pushed: result?.ok === true,
            channel: result?.channel || "",
            result,
          };
        }
        if (typeof client?.sendRealtimeEvent !== "function") {
          return { ok: true, stored: true, pushed: false, reason: "realtime_client_missing" };
        }
        const channel = client.sendRealtimeEvent({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "system",
            metadata: { source: "meeting_awareness" },
            content: [{ type: "input_text", text }],
          },
        });
        return { ok: true, stored: true, pushed: true, channel };
      },
      {
        state: awareness,
        text: contextText,
        push: pushContext,
        signature: meetingAwarenessSignature(awareness),
      },
    ),
    2500,
    { ok: false, error: "meeting_awareness_publish_timeout" },
  ).catch((error) => ({ ok: false, error: String(error?.message || error) }));
}

function logMeetingAwarenessDebug(
  label: string,
  awareness: MeetingAwarenessState | null,
  pushResult?: unknown,
) {
  if (!awareness?.ok) return;
  const activeSpeaker = awareness.activeSpeaker || null;
  const detail = {
    label,
    observedAt: awareness.observedAt,
    participantCount: awareness.participantCount,
    participants: awareness.participants.map((participant) => ({
      name: participant.name,
      source: participant.source,
      confidence: participant.confidence,
      identity: participant.identity || null,
    })),
    activeSpeaker: activeSpeaker
      ? {
          name: activeSpeaker.name,
          source: activeSpeaker.source,
          confidence: activeSpeaker.confidence,
          identity: activeSpeaker.identity || null,
          text: activeSpeaker.text || "",
        }
      : null,
    pushResult: pushResult || null,
  };
  console.error(`[meeting-awareness] ${JSON.stringify(detail)}`);
  if (activeSpeaker?.name && !activeSpeaker.identity?.resolved) {
    console.warn(
      `[meeting-awareness-identity-unresolved] ${JSON.stringify({
        activeSpeaker: activeSpeaker.name,
        source: activeSpeaker.source,
        confidence: activeSpeaker.confidence,
        identity: activeSpeaker.identity || null,
      })}`,
    );
  }
}

function compactRuntimeState({
  avatarReady,
  avatarAudio,
  realtimeBridge,
  workerResultBridge,
  localDialog,
  captions,
  screenShare,
}) {
  return {
    avatarState: avatarReady?.avatarState || null,
    avatarRenderer: avatarReady?.renderer || null,
    avatarAudio: avatarAudio
      ? {
          ok: avatarAudio.ok,
          routedStreams: avatarAudio.routedStreams,
          routedElements: avatarAudio.routedElements,
          routedBuffers: avatarAudio.routedBuffers,
          injectedTones: avatarAudio.injectedTones,
          lastRoute: avatarAudio.lastRoute || null,
          errors: avatarAudio.errors || [],
        }
      : null,
    realtime: realtimeBridge
      ? {
          mode: realtimeBridge.mode,
          connected: realtimeBridge.connected,
          connecting: realtimeBridge.connecting,
          feedback: realtimeBridge.feedback || null,
          session: realtimeBridge.session || null,
          connection: realtimeBridge.connection || null,
          protection: realtimeBridge.protection || null,
          inboundTail: (realtimeBridge.inbound || []).slice(-12),
          transcripts: realtimeBridge.transcripts || null,
          workerResults: realtimeBridge.workerResults || [],
          outboundTail: (realtimeBridge.outbound || []).slice(-12).map((entry) => ({
            ts: entry.ts,
            type: entry.event?.type || "",
            itemType: entry.event?.item?.type || "",
          })),
          timelineTail: (realtimeBridge.timeline || []).slice(-20),
          errors: realtimeBridge.errors || [],
          avatarTools: realtimeBridge.avatarTools || null,
          workerTools: realtimeBridge.workerTools || null,
          meetTools: realtimeBridge.meetTools || null,
          workspaceTools: realtimeBridge.workspaceTools || null,
        }
      : null,
    workerResultBridge: workerResultBridge
      ? {
          ok: workerResultBridge.ok,
          enabled: workerResultBridge.enabled,
          deliveredTail: (workerResultBridge.delivered || []).slice(-10),
          errors: workerResultBridge.errors || [],
          lastPollAt: workerResultBridge.lastPollAt || "",
          lastDeliveryAt: workerResultBridge.lastDeliveryAt || "",
        }
      : null,
    localDialog: localDialog
      ? {
          ok: localDialog.ok,
          enabled: localDialog.enabled,
          provider: localDialog.provider,
          utterancesReceived: localDialog.utterancesReceived,
          responsesSpoken: localDialog.responsesSpoken,
          errors: localDialog.errors || [],
        }
      : null,
    captions: compactCaptionState(captions),
    screenShare: screenShare
      ? {
          ok: screenShare.ok,
          enabled: screenShare.enabled,
          active: screenShare.active,
          streamId: screenShare.streamId || "",
          trackIds: screenShare.trackIds || [],
          frames: screenShare.frames || 0,
          displayMediaCalls: screenShare.displayMediaCalls || 0,
          mode: screenShare.mode || "",
          title: screenShare.title || "",
          subtitle: screenShare.subtitle || "",
          videoUrl: screenShare.videoUrl || "",
          videoReady: Boolean(screenShare.videoReady),
          videoError: screenShare.videoError || "",
          imageUrl: screenShare.imageUrl || "",
          imageReady: Boolean(screenShare.imageReady),
          imageError: screenShare.imageError || "",
          errors: screenShare.errors || [],
        }
      : null,
  };
}

async function evaluateMeetPageState(page: Page): Promise<MeetPageState> {
  const jsState = await withTimeout<MeetPageState, MeetPageState>(
    page.evaluate(() => {
      const text = (document.body?.innerText || "").slice(0, 5000);
      const url = location.href;
      const title = document.title || "";
      const buttons = Array.from(document.querySelectorAll<HTMLElement>("button, [role=button]"))
        .map((node, index) => {
          const rect = node.getBoundingClientRect();
          const label =
            `${node.innerText || node.textContent || ""} ${node.getAttribute("aria-label") || ""}`
              .replace(/\s+/g, " ")
              .trim();
          return {
            index,
            label: label.slice(0, 160),
            disabled: Boolean(
              ("disabled" in node && typeof node.disabled === "boolean" && node.disabled) ||
              node.getAttribute("aria-disabled") === "true",
            ),
            visible:
              rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== "hidden",
            rect: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
          };
        })
        .filter((button) => button.visible && button.label);
      function cleanPersonName(raw: unknown): string {
        let value = String(raw || "")
          .replace(/\s+/g, " ")
          .trim();
        if (!value) return "";
        value = value
          .replace(
            /\s*\((?:you|me|host|presenting|speaking|muted|muted microphone|microphone off)\)\s*$/i,
            "",
          )
          .replace(/\s+(?:is )?(?:speaking|talking|presenting)$/i, "")
          .replace(/\s+(?:muted|microphone off|camera off)$/i, "")
          .replace(/'s (?:video|screen|presentation)$/i, "")
          .replace(/(?:的视频|正在发言|正在讲话|正在演示|已静音|麦克风已关闭)$/g, "")
          .trim();
        if (!value || value.length > 80 || value.split(" ").length > 8) return "";
        const lowered = value.toLowerCase();
        const blacklist = new Set([
          "leave call",
          "leave meeting",
          "turn off microphone",
          "turn on microphone",
          "turn off camera",
          "turn on camera",
          "raise hand",
          "more options",
          "present now",
          "share screen",
          "people",
          "chat",
          "activities",
          "host controls",
          "settings",
          "unknown",
        ]);
        if (blacklist.has(lowered)) return "";
        if (/^(press down arrow|external participants joined|your audio is merged)/i.test(value)) {
          return "";
        }
        return value;
      }
      function firstNameFromNode(node: HTMLElement | null): string {
        if (!node) return "";
        const direct = [
          node.getAttribute("data-self-name"),
          node.getAttribute("data-participant-name"),
          node.getAttribute("aria-label"),
          node.getAttribute("title"),
        ];
        for (const candidate of direct) {
          const name = cleanPersonName(candidate);
          if (name) return name;
        }
        const line = (node.innerText || node.textContent || "")
          .split("\n")
          .map((candidateLine) => cleanPersonName(candidateLine))
          .find(Boolean);
        return line || "";
      }
      function addParticipant(
        map: Map<string, MeetParticipantSignal>,
        input: Partial<MeetParticipantSignal>,
      ) {
        const name = cleanPersonName(input.name);
        if (!name) return;
        const key = name.toLowerCase();
        if (map.has(key)) return;
        map.set(key, {
          name,
          source: input.source || "meet_dom",
          confidence: input.confidence || "low",
          participantId: input.participantId || "",
          rawLabel: input.rawLabel || "",
          lastSeenAt: new Date().toISOString(),
        });
      }
      function parseSpeakerFromLabel(label: string): string {
        const normalized = String(label || "")
          .replace(/\s+/g, " ")
          .trim();
        if (!normalized) return "";
        const patterns = [
          /^(.+?)\s+(?:is\s+)?(?:speaking|talking)$/i,
          /^(.+?)\s+(?:is\s+)?presenting$/i,
          /^(.+?)'s (?:video|screen|presentation)$/i,
          /^正在(?:发言|讲话)[:：]?\s*(.+)$/i,
          /^(.+?)\s*正在(?:发言|讲话)$/i,
        ];
        for (const pattern of patterns) {
          const match = normalized.match(pattern);
          if (match) {
            const name = cleanPersonName(match[1]);
            if (name) return name;
          }
        }
        return "";
      }
      function collectParticipants(): MeetParticipantSignal[] {
        const map = new Map<string, MeetParticipantSignal>();
        const nodes = Array.from(
          document.querySelectorAll<HTMLElement>(
            "[data-participant-id], [data-requested-participant-id], [data-self-name], [data-participant-name]",
          ),
        ).slice(0, 80);
        for (const node of nodes) {
          addParticipant(map, {
            name: firstNameFromNode(node),
            source: "meet_participant_tile",
            confidence: "medium",
            participantId:
              node.getAttribute("data-participant-id") ||
              node.getAttribute("data-requested-participant-id") ||
              "",
            rawLabel:
              node.getAttribute("aria-label") ||
              node.getAttribute("title") ||
              (node.innerText || "").split("\n").slice(0, 3).join(" / "),
          });
        }
        return Array.from(map.values());
      }
      function detectActiveSpeaker(): MeetSpeakerSignal | null {
        const nodes = Array.from(
          document.querySelectorAll<HTMLElement>(
            '[aria-label], [data-tooltip], [title], [role="button"], [role="listitem"], [data-participant-id], [data-requested-participant-id]',
          ),
        ).slice(0, 400);
        for (const node of nodes) {
          const rawLabel = [
            node.getAttribute("aria-label"),
            node.getAttribute("data-tooltip"),
            node.getAttribute("title"),
            (node.innerText || "").split("\n").slice(0, 3).join(" "),
          ]
            .filter(Boolean)
            .join(" ");
          if (!/(speaking|talking|正在发言|正在讲话)/i.test(rawLabel)) continue;
          const tile = node.closest<HTMLElement>(
            "[data-participant-id], [data-requested-participant-id], [data-self-name], [data-participant-name]",
          );
          const name = parseSpeakerFromLabel(rawLabel) || firstNameFromNode(tile);
          if (!name) continue;
          return {
            name,
            source: "meet_speaker_tile_indicator",
            confidence: "medium",
            observedAt: new Date().toISOString(),
            rawLabel: rawLabel.slice(0, 240),
          };
        }
        return null;
      }
      function participantCount(): number | null {
        const peopleBtn = document.querySelector<HTMLElement>(
          'button[aria-label*="people" i], button[aria-label*="参与者"], button[aria-label*="用户"]',
        );
        if (peopleBtn) {
          const badge = peopleBtn.querySelector(".gv5Jzc, .uGOf1d, .wnPUne");
          if (badge?.textContent) {
            const parsed = Number.parseInt(badge.textContent.trim(), 10);
            if (Number.isFinite(parsed)) return parsed;
          }
          const label = peopleBtn.getAttribute("aria-label") || "";
          const match = label.match(/\((\d+)\)/);
          if (match) return Number.parseInt(match[1], 10);
        }

        const tiles = document.querySelectorAll(
          "[data-participant-id], [data-requested-participant-id]",
        );
        if (tiles.length > 0) return tiles.length;
        return null;
      }
      const participants = collectParticipants();
      const activeSpeaker = detectActiveSpeaker();
      const waitingForAdmit =
        /Please wait until a meeting host brings you into the call|Someone will let you in soon|waiting for.*host/i.test(
          text,
        );
      const inMeetingSignals = [
        /You have joined the call/i.test(text),
        /Leave call/i.test(text),
        /Leave meeting/i.test(text),
        /Present now/i.test(text),
        /Share screen/i.test(text),
        /People/i.test(text) && /Chat/i.test(text),
        buttons.some((button) =>
          /Leave call|Leave meeting|Turn off microphone|Turn on microphone|Turn off camera|Turn on camera|Raise hand|More options|Share screen|Present now/i.test(
            button.label,
          ),
        ),
      ];
      const preJoinSignals = [
        /Join now/i.test(text),
        /Ask to join/i.test(text),
        /Getting ready/i.test(text),
      ];
      const signInSignals = [
        /Forgot email/i.test(text),
        /Create account/i.test(text),
        /Sign in/i.test(text) && /Next/i.test(text),
        /accounts\.google\.com/i.test(url),
      ];
      const inMeeting = !waitingForAdmit && inMeetingSignals.some(Boolean);
      const cannotJoin =
        !inMeeting &&
        !waitingForAdmit &&
        /You can't join this video call|No one can join a meeting unless invited or admitted by the host/i.test(
          text,
        );
      return {
        ok: true,
        url,
        title,
        inMeeting,
        participantCount: participantCount(),
        participants,
        activeSpeaker,
        waitingForAdmit,
        preJoin: preJoinSignals.some(Boolean),
        signIn: signInSignals.some(Boolean),
        cannotJoin,
        textHead: text.slice(0, 1000),
        buttons: buttons.slice(0, 30),
      };
    }),
    2500,
    {
      ok: false,
      error: "meet_page_state_timeout",
    },
  ).catch(
    (error): MeetPageState => ({
      ok: false,
      error: String(error?.message || error),
    }),
  );
  if (jsState.ok || jsState.error !== "meet_page_state_timeout") return jsState;
  const accessibilityState = await evaluateMeetAccessibilityState(page);
  if (accessibilityState.ok) {
    return {
      ...accessibilityState,
      jsProbe: jsState,
    };
  }
  return {
    ...jsState,
    accessibilityProbe: accessibilityState,
  };
}

async function openMeetPeoplePanelForAwareness(page: Page, diagnostics?: Diagnostics) {
  const result = await withTimeout(
    page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll<HTMLElement>("button, [role=button]"));
      const peopleButton = buttons.find((node) => {
        const label =
          `${node.innerText || node.textContent || ""} ${node.getAttribute("aria-label") || ""} ${node.getAttribute("data-tooltip") || ""}`
            .replace(/\s+/g, " ")
            .trim();
        return /people|participants|show everyone|参与者|用户|成员/i.test(label);
      });
      if (!peopleButton) return { ok: false, reason: "people_button_not_found" };
      const expanded =
        peopleButton.getAttribute("aria-expanded") === "true" ||
        peopleButton.getAttribute("aria-pressed") === "true";
      if (expanded) {
        return {
          ok: true,
          alreadyOpen: true,
          label: (peopleButton.getAttribute("aria-label") || peopleButton.innerText || "").slice(
            0,
            120,
          ),
        };
      }
      peopleButton.click();
      return {
        ok: true,
        clicked: true,
        label: (peopleButton.getAttribute("aria-label") || peopleButton.innerText || "").slice(
          0,
          120,
        ),
      };
    }),
    2500,
    { ok: false, reason: "people_panel_open_timeout" },
  ).catch((error) => ({
    ok: false,
    reason: "people_panel_open_error",
    error: String(error?.message || error),
  }));
  diagnostics?.record("meeting_awareness_people_panel", result);
  if ((result as any)?.clicked) await page.waitForTimeout(700).catch(() => {});
  return result;
}

export function createGoogleMeetJoiner(options: GoogleMeetJoinerOptions = {}) {
  const config = getRuntimeConfig();
  let active = null;
  let activeMacWindowCapture: null | {
    timer: NodeJS.Timeout | null;
    stopped: boolean;
    window: unknown;
    stream?: { stop: () => void; processId?: number };
    mjpeg?: LocalMultipartFrameServer;
    stop: (reason?: string) => void;
  } = null;
  const activeBrowserPath = pathJoin(config.dataDir, "active-meet-browser.json");

  function buildConfiguredRealtimeCurrentUser(): RealtimeCurrentUser {
    return {
      name: config.currentUserName,
      englishName: config.currentUserEnglishName,
      email: config.currentUserEmail,
      linear: config.currentUserLinear,
      github: config.currentUserGithub,
      role: config.currentUserRole,
      aliases: config.currentUserAliases,
    };
  }

  async function clearActiveBrowserRecord() {
    await unlink(activeBrowserPath).catch(() => {});
  }

  async function rememberActiveBrowser(browser, sessionId, meetUrl) {
    const pid = typeof browser?.process === "function" ? browser.process()?.pid : 0;
    if (!pid) return { ok: false, reason: "browser_pid_unavailable" };
    await mkdir(config.dataDir, { recursive: true });
    await writeFile(
      activeBrowserPath,
      `${JSON.stringify(
        {
          pid,
          sessionId,
          meetUrl,
          createdAt: nowIso(),
        },
        null,
        2,
      )}\n`,
    );
    return { ok: true, pid, path: activeBrowserPath };
  }

  async function stopRecordedBrowser(reason = "replace_existing_bot") {
    let record;
    try {
      record = JSON.parse(await readFile(activeBrowserPath, "utf8"));
    } catch {
      return { ok: true, stopped: false, reason, source: "record_absent" };
    }
    const pid = Number(record.pid || 0);
    if (!pid || pid === process.pid) {
      await clearActiveBrowserRecord();
      return { ok: true, stopped: false, reason, source: "record_invalid" };
    }
    try {
      process.kill(pid, 0);
    } catch {
      await clearActiveBrowserRecord();
      return {
        ok: true,
        stopped: false,
        reason,
        source: "process_absent",
        pid,
        sessionId: record.sessionId || "",
      };
    }
    try {
      process.kill(pid, "SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 800));
      try {
        process.kill(pid, 0);
        process.kill(pid, "SIGKILL");
      } catch {
        // Process exited after SIGTERM.
      }
      await clearActiveBrowserRecord();
      return {
        ok: true,
        stopped: true,
        reason,
        source: "recorded_browser",
        pid,
        sessionId: record.sessionId || "",
      };
    } catch (error) {
      return {
        ok: false,
        stopped: false,
        reason,
        source: "recorded_browser",
        pid,
        sessionId: record.sessionId || "",
        error: String(error?.message || error),
      };
    }
  }

  async function stop(reason = "manual_stop") {
    if (!active) return { ok: true, stopped: false, reason };
    const previous = active;
    active = null;
    stopActiveMacWindowCapture(reason);
    previous.diagnostics?.record("stop", { reason });
    try {
      const browserStop = previous.page?.isClosed?.()
        ? { ok: true, skipped: true, reason: "page_already_closed" }
        : await previous.page
            ?.evaluate(async (stopReason) => {
              const client = window.MAB_REALTIME_CLIENT;
              if (typeof client?.stopMeetAudioCapture !== "function") {
                return { ok: true, skipped: true, reason: "realtime_audio_capture_missing" };
              }
              return await client.stopMeetAudioCapture(stopReason);
            }, reason)
            .catch((error) => ({ ok: false, error: String(error?.message || error) }));
      previous.diagnostics?.record("realtime_audio_capture_browser_stop", { browserStop });
    } catch (error) {
      previous.diagnostics?.record("realtime_audio_capture_stop_error", {
        error: String(error?.message || error),
      });
    }
    try {
      await previous.recorder?.stop();
    } catch (error) {
      previous.diagnostics?.record("recorder_stop_error", {
        error: String(error?.message || error),
      });
    }
    try {
      const finalized = previous.realtimeAudioCapture
        ? await previous.realtimeAudioCapture.finalize()
        : null;
      previous.diagnostics?.record("realtime_audio_capture_finalize", { finalized });
    } catch (error) {
      previous.diagnostics?.record("realtime_audio_capture_finalize_error", {
        error: String(error?.message || error),
      });
    }
    try {
      await previous.captionCapture?.flush();
    } catch (error) {
      previous.diagnostics?.record("caption_flush_error", {
        error: String(error?.message || error),
      });
    }
    try {
      if (previous.persistentBrowserContext) {
        await previous.context?.close();
      } else {
        await previous.browser?.close();
      }
    } catch (error) {
      previous.diagnostics?.record("stop_close_error", { error: String(error?.message || error) });
      // Browser may already be gone.
    }
    await clearActiveBrowserRecord();
    if (previous.diagnostics) await saveDiagnostics(previous.diagnostics).catch(() => {});
    return {
      ok: true,
      stopped: true,
      sessionId: previous.sessionId,
      reason,
      diagnosticsPath: previous.diagnostics?.jsonPath || "",
    };
  }

  async function join(input: GoogleMeetJoinInput) {
    const meetUrl = input.meetUrl || "";
    const allowNonGoogleMeet = Boolean(input.allowNonGoogleMeet || options.allowNonGoogleMeet);
    assertMeetUrl(meetUrl, { allowNonGoogleMeet });
    const sessionId = input.sessionId || `manual_${Date.now()}`;
    const botName = input.botName || config.botName;
    const dryRun = Boolean(input.dryRun);
    const installAvatar = input.installAvatar !== false;
    const installRealtimeBridge = input.installRealtimeBridge !== false;
    const installLocalDialogBridge = Boolean(input.installLocalDialogBridge);
    const installWorkerResultBridge = input.installWorkerResultBridge !== false;
    const installScreenShareBridge = Boolean(input.installScreenShareBridge);
    const autoStartScreenShare = Boolean(input.autoStartScreenShare);
    const workerPollUrl = input.workerPollUrl || `${config.meetingAgentUrl}/worker/poll-realtime`;
    const recordMeeting = Boolean(input.recordMeeting ?? config.recordMeeting);
    const captureCaptions = Boolean(input.captureCaptions ?? config.captureCaptions);
    const captionLanguage = input.captionLanguage || config.captionLanguage || "";
    const artifactsDir = input.artifactsDir || pathJoin(config.meetingArtifactsDir, sessionId);
    const recorder = createMeetingRecorder({
      backend: input.meetAudioBackend || config.meetAudioBackend,
    });
    const realtimeAudioCapture =
      recordMeeting && installRealtimeBridge && input.forwardMeetAudioToRealtime !== false
        ? createWebRTCAudioCaptureSink({ sessionId, artifactsDir })
        : null;
    const browserUserDataDirInput = input.browserUserDataDir || config.browserUserDataDir || "";
    const meetProfileMode = normalizeMeetProfileMode(
      input.meetProfileMode || config.meetProfileMode,
      Boolean(browserUserDataDirInput),
    );
    if (meetProfileMode === "persistent" && !browserUserDataDirInput) {
      throw new Error(
        "MAB_BROWSER_USER_DATA_DIR is required when MAB_MEET_PROFILE_MODE=persistent",
      );
    }
    const browserUserDataDir = meetProfileMode === "persistent" ? browserUserDataDirInput : "";
    const realtimeBridgeMode = input.realtimeBridgeMode || "mock";
    const runtimeSessionValidation = validateGoogleMeetRuntimeSessionConfig({
      sessionId,
      botName,
      realtimeBridgeMode,
      installAvatar,
      installRealtimeBridge,
      installLocalDialogBridge,
      installScreenShareBridge,
      installWorkerResultBridge,
    });
    if (runtimeSessionValidation.failure) throw new Error(runtimeSessionValidation.failure.error);
    const runtimeSessionConfig = runtimeSessionValidation.config!;

    const replacementStop = await stop("replace_existing_bot");
    const recordedBrowserStop = replacementStop.stopped
      ? { ok: true, stopped: false, reason: "active_stop_closed_browser", source: "record_skipped" }
      : await stopRecordedBrowser("replace_existing_bot");

    const plan = {
      provider: "google-meet",
      sessionId,
      meetUrl,
      botName,
      headless: config.browserHeadless,
      installAvatar,
      installRealtimeBridge,
      installLocalDialogBridge,
      installWorkerResultBridge,
      installScreenShareBridge,
      autoStartScreenShare,
      workerPollUrl,
      recordMeeting,
      captureCaptions,
      captionLanguage,
      artifactsDir,
      meetAudioBackend: recorder.backend,
      allowNonGoogleMeet,
      screenshotDir: config.screenshotDir,
      meetProfileMode,
      browserUserDataDir,
      replacementStop,
      recordedBrowserStop,
      runtimeSessionValidation: runtimeSessionValidation.summary,
      steps: [],
    };

    if (dryRun) return { ok: true, dryRun: true, plan };

    await mkdir(config.screenshotDir, { recursive: true });
    const diagnostics = createDiagnostics(sessionId, config.screenshotDir);
    diagnostics.record("join_start", {
      meetUrl,
      botName,
      installAvatar,
      allowNonGoogleMeet,
      meetProfileMode,
    });
    const playwright = await loadPlaywright(
      options.playwrightModulePath || config.playwrightModulePath,
    );
    const recorderLaunchEnv = recordMeeting ? await recorder.prepareLaunchEnv() : undefined;
    const browserLaunchOptions = {
      executablePath: options.chromiumExecutablePath || config.chromiumExecutablePath || undefined,
      headless: config.browserHeadless,
      env: recorderLaunchEnv,
      args: buildGoogleMeetChromiumArgs({
        avatarUseSwiftShader: config.avatarUseSwiftShader,
        browserExtraArgs: input.browserExtraArgs,
        chromiumExtraArgs: config.chromiumExtraArgs,
      }),
    };
    const contextOptions = {
      permissions: ["microphone", "camera"],
      viewport: {
        width: Number(input.browserViewportWidth || config.browserViewportWidth || 1440),
        height: Number(input.browserViewportHeight || config.browserViewportHeight || 900),
      },
    };
    let browser;
    let context;
    if (browserUserDataDir) {
      await mkdir(browserUserDataDir, { recursive: true });
      diagnostics.record("browser_launch", {
        persistentUserDataDir: browserUserDataDir,
        executablePath: browserLaunchOptions.executablePath || "",
        headless: browserLaunchOptions.headless,
        args: browserLaunchOptions.args,
      });
      context = await playwright.chromium.launchPersistentContext(browserUserDataDir, {
        ...browserLaunchOptions,
        ...contextOptions,
      });
      browser = typeof context.browser === "function" ? context.browser() : null;
    } else {
      diagnostics.record("browser_launch", {
        persistentUserDataDir: "",
        executablePath: browserLaunchOptions.executablePath || "",
        headless: browserLaunchOptions.headless,
        args: browserLaunchOptions.args,
      });
      browser = await playwright.chromium.launch(browserLaunchOptions);
      context = await browser.newContext(contextOptions);
    }
    const realtimeAudioCaptureExpose = realtimeAudioCapture
      ? await realtimeAudioCapture.exposeTo(context)
      : null;
    if (realtimeAudioCaptureExpose) {
      diagnostics.record("realtime_audio_capture_expose", realtimeAudioCaptureExpose);
    }
    active = {
      sessionId,
      browser,
      context,
      persistentBrowserContext: Boolean(browserUserDataDir),
      browserUserDataDir,
      meetProfileMode,
      startedAt: nowIso(),
      meetUrl,
      diagnostics,
      artifactsDir,
      recorder: recordMeeting ? recorder : null,
      realtimeAudioCapture,
      captionCapture: null,
    };
    const browserRecord = await rememberActiveBrowser(browser, sessionId, meetUrl);
    // tsx/esbuild can serialize page.evaluate callbacks through __name; expose a no-op
    // helper so browser-side diagnostics keep working when smokes run TypeScript directly.
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
    const realtimeCurrentUser = buildConfiguredRealtimeCurrentUser();
    const realtimeTools = input.realtimeTools || realtimeToolSchemas;
    let realtimeInstructions = "",
      realtimeSession = null;
    if (installRealtimeBridge) {
      realtimeInstructions =
        input.realtimeInstructions ||
        buildRealtimeInstructions({
          botName,
          personalityContext: config.realtimePersonalityContext,
          currentUser: realtimeCurrentUser,
        });
      realtimeSession =
        input.realtimeSession ||
        buildRealtimeSessionConfig(
          {
            botName,
            currentUser: realtimeCurrentUser,
            instructions: realtimeInstructions,
            tools: realtimeTools,
          },
          config,
        );
    }
    const runtimeInitScripts = buildAvatarRuntimeInitScripts({
      sessionId,
      botName,
      surfaceKind: runtimeSessionConfig.surfaceKind,
      conversationTransport: runtimeSessionConfig.conversationTransport,
      installAvatar,
      installRealtimeBridge,
      installLocalDialogBridge,
      installScreenShareBridge,
      installWorkerResultBridge,
      avatar: {
        modelUrl: input.avatarModelUrl || config.avatarModelUrl,
        modelFallbackUrls: config.avatarModelFallbackUrls,
        avatarRenderer: input.avatarRenderer || config.avatarRenderer,
        vrmModelUrl: input.avatarVRMModelUrl || config.avatarVRMModelUrl,
        vrmModelFallbackUrls: config.avatarVRMModelFallbackUrls,
        live2dDepsDir: input.avatarDepsDir || config.avatarDepsDir,
        layout: input.avatarLayout || config.avatarLayout,
        botName,
        disableLive2D: Boolean(input.disableLive2D),
        deferRendererUntilExplicitStart:
          input.deferAvatarRendererUntilJoined !== false && installAvatar,
        canvasWidth: Number(input.avatarCanvasWidth || config.avatarCanvasWidth || 1920),
        canvasHeight: Number(input.avatarCanvasHeight || config.avatarCanvasHeight || 1080),
        captureFps: Number(input.avatarCaptureFps || config.avatarCaptureFps || 30),
      },
      realtime: {
        mode: realtimeBridgeMode,
        agentRuntime: input.realtimeAgentRuntime || config.openaiRealtimeAgentRuntime,
        sessionId,
        botName,
        toolCallbackToken: input.realtimeToolCallbackToken || config.internalAuthKey || "",
        autoRespondToWorkerResults: input.autoRespondToWorkerResults !== false,
        instructions: realtimeInstructions,
        tools: realtimeTools,
        session: realtimeSession,
        currentUser: realtimeCurrentUser,
        sendSessionUpdateOnConnect: input.sendRealtimeSessionUpdate !== false,
        includeParticipantAudio: Boolean(input.includeParticipantAudio),
        forwardMeetAudioToRealtime: input.forwardMeetAudioToRealtime !== false,
        captureMeetAudioForTranscript: Boolean(realtimeAudioCapture),
        workerDelegateUrl: input.workerDelegateUrl || `${config.meetingAgentUrl}/worker/delegate`,
        workerStatusUrl: input.workerStatusUrl || `${config.meetingAgentUrl}/worker/status`,
        autoConnect: Boolean(input.autoConnectRealtime),
        tokenUrl: input.realtimeTokenUrl || `${config.meetingAgentUrl}/realtime/client-secret`,
        openaiRealtimeBaseUrl: config.openaiBaseUrl,
        sdpUrl: input.realtimeSdpUrl || config.openaiRealtimeSdpUrl,
      },
      localDialog: {
        enabled: true,
        botName,
        sessionId,
        turnUrl: input.localDialogTurnUrl || `${config.meetingAgentUrl}/dialog/turn`,
        ttsMode: input.localDialogTtsMode || "tone",
        ttsUrl: input.localDialogTtsUrl || `${config.meetingAgentUrl}/tts/synthesize`,
        sttProvider: input.localDialogSttProvider || config.sttProvider,
        ttsProvider: input.localDialogTtsProvider || config.ttsProvider,
        ttsGain: Number(input.localDialogTtsGain ?? 0.025),
      },
      screenShare: {
        enabled: true,
        autoStart: autoStartScreenShare,
        mode: input.screenShareMode || "synthetic",
        title: input.screenShareTitle || "Meeting Avatar Bot",
        subtitle: input.screenShareSubtitle || "Agent screen share",
        width: input.screenShareWidth || DEFAULT_SYNTHETIC_SCREEN_SHARE_WIDTH,
        height: input.screenShareHeight || DEFAULT_SYNTHETIC_SCREEN_SHARE_HEIGHT,
        fps: input.screenShareFps || DEFAULT_SYNTHETIC_SCREEN_SHARE_FPS,
      },
      workerResult: {
        workerPollUrl,
        enabled: Boolean(workerPollUrl),
        minCreatedAt: input.workerResultMinCreatedAt || new Date().toISOString(),
        sessionId,
      },
    });
    diagnostics.record("runtime_session_validation", runtimeSessionValidation.summary);
    diagnostics.record("runtime_init_scripts", {
      categories: runtimeInitScripts.map((script) => script.category),
      events: runtimeInitScripts.map((script) => script.event),
    });
    for (const script of runtimeInitScripts) {
      await context.addInitScript({ content: script.content });
    }
    const page = await context.newPage();
    active = {
      ...active,
      context,
      page,
    };
    installPageDiagnostics(page, diagnostics);
    diagnostics.record("goto_start", { meetUrl });
    await saveDiagnostics(diagnostics);
    const gotoResponse = await gotoMeetWithRetry(page, meetUrl, diagnostics);
    diagnostics.record("goto_complete", { url: page.url(), status: gotoResponse?.status?.() || 0 });
    await saveDiagnostics(diagnostics);
    await installMeetPromptAutoDismisser(page, diagnostics);
    await installMeetLocalPlaybackMute(page, diagnostics, input.muteLocalPlayback !== false);
    await page.waitForTimeout(2500);
    await takeScreenshot(page, diagnostics, "01-after-nav");
    await collectButtonInventory(page, diagnostics, "after-nav");

    await dismissMeetPrompts(page, diagnostics);

    const guestNameResult = await fillGuestName(page, botName, diagnostics);
    if (
      !guestNameResult.ok &&
      ["cannot_join_meeting", "google_sign_in_required", "meet_anti_bot_prejoin"].includes(
        guestNameResult.reason,
      )
    ) {
      const meetPage = await evaluateMeetPageState(page);
      diagnostics.record("join_failed_terminal_state", { guestNameResult, meetPage });
      await saveDiagnostics(diagnostics);
      return {
        ok: false,
        error: guestNameResult.reason,
        sessionId,
        screenshotDir: config.screenshotDir,
        diagnosticsPath: diagnostics.jsonPath,
        meetPage,
        guestName: guestNameResult,
      };
    }

    await collectButtonInventory(page, diagnostics, "pre-join-click");

    let clicked = await clickMeetJoinButton(page, diagnostics, 45_000);
    if (!clicked)
      clicked = await clickFirstVisible(
        page,
        [
          'button:has-text("Ask to join")',
          'button:has-text("Join now")',
          'button:has-text("加入")',
          'button:has-text("申请加入")',
          'button:has-text("立即加入")',
          'button:has-text("Join")',
          '[aria-label*="Ask to join" i]',
          '[aria-label*="Join now" i]',
          '[aria-label*="加入" i]',
          "button[jsname]",
        ],
        2500,
        diagnostics,
      );
    if (!clicked) {
      const enterFallback = await page.keyboard
        .press("Enter")
        .then(() => true)
        .catch(() => false);
      diagnostics.record("join_enter_fallback", { ok: enterFallback });
      if (enterFallback) {
        await page.waitForTimeout(1500);
        const pageState = await evaluateMeetPageState(page);
        if (pageState?.waitingForAdmit || pageState?.inMeeting) clicked = "keyboard:enter";
      }
    }
    if (!clicked) {
      const meetPage = await evaluateMeetPageState(page);
      diagnostics.record("join_failed_no_button", { meetPage });
      await saveDiagnostics(diagnostics);
      await stop("join_button_not_found").catch(() => {});
      return {
        ok: false,
        error: "join_button_not_found",
        sessionId,
        screenshotDir: config.screenshotDir,
        diagnosticsPath: diagnostics.jsonPath,
        meetPage,
      };
    }

    await page.waitForTimeout(2500);
    await takeScreenshot(page, diagnostics, "02-after-join-click");
    await collectButtonInventory(page, diagnostics, "after-join-click");
    let admission = null;
    if (clicked) {
      const joinedFixture = allowNonGoogleMeet ? await evaluateFixtureState(page) : null;
      if (joinedFixture?.joined === true) {
        admission = { state: "admitted", signal: "fixture_joined", fixtureState: joinedFixture };
        diagnostics.record("admission_state", admission);
      } else {
        admission = await waitForMeetAdmission(page, {
          diagnostics,
          dismissMeetPrompts,
          evaluateMeetPageState,
          timeoutMs: 120_000,
        });
      }
      if (admission.state === "denied") {
        await saveDiagnostics(diagnostics);
        return {
          ok: false,
          error: "admission_denied",
          sessionId,
          screenshotDir: config.screenshotDir,
          diagnosticsPath: diagnostics.jsonPath,
          admission,
        };
      }
      if (admission.state === "sign_in_required") {
        await saveDiagnostics(diagnostics);
        return {
          ok: false,
          error: "google_sign_in_required",
          sessionId,
          screenshotDir: config.screenshotDir,
          diagnosticsPath: diagnostics.jsonPath,
          admission,
        };
      }
    }
    const avatarRendererStart =
      installAvatar && clicked
        ? await startAvatarRenderer(page, diagnostics)
        : { ok: false, skipped: true, reason: "avatar_not_installed_or_not_joined" };
    let captionCapture = null;
    let captionEnable = null;
    if (captureCaptions && clicked) {
      captionCapture = await installMeetCaptionCapture(page, { artifactsDir, diagnostics });
      captionEnable = await enableMeetCaptions(page, { captionLanguage, diagnostics });
      await page.waitForTimeout(1200);
      const captionStatus = await captionCapture.status();
      diagnostics.record("caption_capture_ready", {
        captionEnable,
        captions: compactCaptionState(captionStatus),
      });
    } else if (captureCaptions) {
      diagnostics.record("caption_capture_skipped", { reason: "join_not_confirmed" });
    }
    if (recordMeeting) {
      const recorderStart = await recorder.start({ context, artifactsDir });
      diagnostics.record("recorder_start", recorderStart);
    }
    if (input.localDialogAcceptanceUtterance) {
      const localDialogDispatch = await page
        .evaluate(
          async ({ text, sessionId: localSessionId }) => {
            if (!window.MAB_LOCAL_DIALOG_CONTROLLER?.sendUtterance) {
              return { ok: false, error: "local_dialog_controller_missing" };
            }
            return await window.MAB_LOCAL_DIALOG_CONTROLLER.sendUtterance({
              source: "joiner-acceptance",
              text,
              sessionId: localSessionId,
              context: { acceptance: "joiner-local-dialog" },
            });
          },
          { text: input.localDialogAcceptanceUtterance, sessionId },
        )
        .catch((error) => ({
          ok: false,
          error: String(error?.message || error),
        }));
      diagnostics.record("local_dialog_acceptance_dispatched", localDialogDispatch);
    }
    let screenShareStart = null;
    if (installScreenShareBridge && autoStartScreenShare) {
      screenShareStart = await page
        .evaluate(
          async ({ title, subtitle }) => {
            if (!window.MAB_SCREEN_SHARE_CONTROLLER?.start) {
              return { ok: false, error: "screen_share_controller_missing" };
            }
            return await window.MAB_SCREEN_SHARE_CONTROLLER.start({ title, subtitle });
          },
          {
            title: input.screenShareTitle || "Meeting Avatar Bot",
            subtitle: input.screenShareSubtitle || "Agent screen share",
          },
        )
        .catch((error) => ({
          ok: false,
          error: String(error?.message || error),
        }));
      diagnostics.record("screen_share_auto_start", screenShareStart);
    }
    const avatarReady = await evaluateAvatarReady(page);
    const avatarAudio = await evaluateAvatarAudio(page);
    const fixtureState = input.collectFixtureState ? await evaluateFixtureState(page) : null;
    const localDialog = await evaluateLocalDialogState(page);
    const screenShare = await evaluateScreenShareState(page);
    let meetPage = await evaluateMeetPageState(page);
    if (meetPage.inMeeting) {
      await openMeetPeoplePanelForAwareness(page, diagnostics);
      meetPage = await evaluateMeetPageState(page);
    }
    const captions = captionCapture ? await captionCapture.status() : null;
    const meetingAwareness = buildMeetingAwarenessState({
      meetPage,
      captions,
      currentUser: realtimeCurrentUser,
    });
    diagnostics.record("join_complete", {
      clickedJoinSelector: clicked,
      admission,
      meetPage,
      meetingAwareness,
      avatarReady,
      avatarAudio,
      fixtureState,
      localDialog,
      screenShare,
      screenShareStart,
      avatarRendererStart,
      captions: compactCaptionState(captions),
    });
    await saveDiagnostics(diagnostics);
    active = {
      ...active,
      context,
      page,
      captionCapture,
      captionEnable,
      clickedJoinSelector: clicked,
      admission,
      avatarReady,
      avatarAudio,
      fixtureState,
      localDialog,
      screenShare,
      meetPage,
      captions,
      meetingAwareness,
      peoplePanelAwarenessAttempted: Boolean(meetPage.inMeeting),
    };
    active.lastMeetingAwarenessSignature = "";
    active.meetingAwarenessPush = await publishMeetingAwarenessToPage(page, meetingAwareness);
    logMeetingAwarenessDebug("join_complete", meetingAwareness, active.meetingAwarenessPush);
    if (active.meetingAwarenessPush?.pushed) {
      active.lastMeetingAwarenessSignature = meetingAwarenessSignature(meetingAwareness);
      diagnostics.record("meeting_awareness_push", active.meetingAwarenessPush);
      await saveDiagnostics(diagnostics).catch(() => {});
    }

    return {
      ok: true,
      dryRun: false,
      sessionId,
      replacementStop,
      recordedBrowserStop,
      browserRecord,
      clickedJoinSelector: clicked,
      admission,
      screenshotDir: config.screenshotDir,
      diagnosticsPath: diagnostics.jsonPath,
      artifactsDir,
      recorder: recordMeeting ? recorder.status() : null,
      realtimeAudioCapture: realtimeAudioCapture?.status() || null,
      captions: compactCaptionState(captions),
      screenshots: diagnostics.screenshots,
      buttonInventories: diagnostics.buttonInventories,
      avatarReady,
      avatarAudio,
      fixtureState,
      localDialog,
      screenShare,
      meetPage,
      meetingAwareness,
      meetingAwarenessPush: active.meetingAwarenessPush,
      screenShareStart,
    };
  }

  async function refreshActiveRuntimeState() {
    if (!active?.page) return;
    let [
      avatarReady,
      avatarAudio,
      fixtureState,
      realtimeBridge,
      workerResultBridge,
      localDialog,
      screenShare,
      captions,
      meetPage,
    ] = await Promise.all([
      evaluateAvatarReady(active.page),
      evaluateAvatarAudio(active.page),
      evaluateFixtureState(active.page),
      evaluateRealtimeBridgeState(active.page),
      evaluateWorkerResultBridgeState(active.page),
      evaluateLocalDialogState(active.page),
      evaluateScreenShareState(active.page),
      active.captionCapture?.status() || Promise.resolve(null),
      evaluateMeetPageState(active.page),
    ]);
    if (meetPage.inMeeting && !active.peoplePanelAwarenessAttempted) {
      active.peoplePanelAwarenessAttempted = true;
      await openMeetPeoplePanelForAwareness(active.page, active.diagnostics);
      meetPage = await evaluateMeetPageState(active.page);
    }
    const realtimeCurrentUser = buildConfiguredRealtimeCurrentUser();
    const meetingAwareness = buildMeetingAwarenessState({
      meetPage,
      captions,
      currentUser: realtimeCurrentUser,
    });
    active.avatarReady = avatarReady;
    active.avatarAudio = avatarAudio;
    active.fixtureState = fixtureState;
    active.realtimeBridge = realtimeBridge;
    active.workerResultBridge = workerResultBridge;
    active.localDialog = localDialog;
    active.screenShare = screenShare;
    active.captions = captions;
    active.meetPage = meetPage;
    active.meetingAwareness = meetingAwareness;
    const nextAwarenessSignature = meetingAwarenessSignature(meetingAwareness);
    if (nextAwarenessSignature && nextAwarenessSignature !== active.lastMeetingAwarenessSignature) {
      active.meetingAwarenessPush = await publishMeetingAwarenessToPage(
        active.page,
        meetingAwareness,
      );
      if (active.meetingAwarenessPush?.pushed) {
        active.lastMeetingAwarenessSignature = nextAwarenessSignature;
      }
    } else {
      await publishMeetingAwarenessToPage(active.page, meetingAwareness, false).catch(() => {});
    }
    logMeetingAwarenessDebug(
      "runtime_state_refresh",
      meetingAwareness,
      active.meetingAwarenessPush,
    );
    if (active.diagnostics) {
      active.diagnostics.record("runtime_state_refresh", {
        meetPage,
        meetingAwareness,
        meetingAwarenessPush: active.meetingAwarenessPush || null,
        ...compactRuntimeState({
          avatarReady,
          avatarAudio,
          realtimeBridge,
          workerResultBridge,
          localDialog,
          screenShare,
          captions,
        }),
      });
      await saveDiagnostics(active.diagnostics).catch(() => {});
      await active.captionCapture?.flush().catch(() => {});
    }
  }

  async function injectWorkerResult(job) {
    if (!active?.page) return { ok: false, error: "no_active_join" };
    const result = await active.page
      .evaluate(async (payload) => {
        if (typeof window.MAB_REALTIME_CLIENT?.injectWorkerResult === "function") {
          return {
            ok: true,
            channel: "MAB_REALTIME_CLIENT.injectWorkerResult",
            delivery: await window.MAB_REALTIME_CLIENT.injectWorkerResult(payload),
          };
        }
        if (typeof window.MAB_REALTIME_CLIENT?.sendWorkerResult === "function") {
          return {
            ok: true,
            channel: "MAB_REALTIME_CLIENT.sendWorkerResult",
            delivery: await window.MAB_REALTIME_CLIENT.sendWorkerResult(payload),
          };
        }
        window.dispatchEvent(new CustomEvent("meeting-avatar-worker-result", { detail: payload }));
        return { ok: true, channel: "meeting-avatar-worker-result" };
      }, job)
      .catch((error) => ({ ok: false, error: String(error?.message || error) }));
    await refreshActiveRuntimeState();
    return {
      ...result,
      realtimeBridge: active.realtimeBridge || null,
      workerResultBridge: active.workerResultBridge || null,
    };
  }

  async function sendRealtimeEvent(event) {
    if (!active?.page) return { ok: false, error: "no_active_join" };
    const result = await active.page
      .evaluate((payload) => {
        if (!window.MAB_REALTIME_CLIENT?.sendRealtimeEvent) {
          return { ok: false, error: "realtime_client_missing" };
        }
        const channel = window.MAB_REALTIME_CLIENT.sendRealtimeEvent(payload);
        return { ok: true, channel };
      }, event)
      .catch((error) => ({ ok: false, error: String(error?.message || error) }));
    await refreshActiveRuntimeState();
    return {
      ...result,
      feedback: active.realtimeBridge?.feedback || null,
      realtimeBridge: active.realtimeBridge || null,
    };
  }

  async function requestRealtimeTextTurn({ text, instructions }) {
    const userText = String(text || "").trim();
    if (!userText) return { ok: false, error: "text_required" };
    const item = await sendRealtimeEvent({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        metadata: { source: "manual_text_turn" },
        content: [
          {
            type: "input_text",
            text: userText,
          },
        ],
      },
    });
    if (!item.ok) return item;
    const response = await sendRealtimeEvent({
      type: "response.create",
      response: {
        instructions:
          instructions || "Answer the user's text turn in concise Chinese with real audio.",
      },
    });
    return {
      ok: response.ok,
      item,
      response,
      feedback: response.feedback,
      realtimeBridge: response.realtimeBridge,
    };
  }

  async function sendMeetChat(input: MeetChatInput = {}) {
    const text = String(input.text || input.message || "").trim();
    if (!text) return { ok: false, error: "text_required" };
    if (!active?.page) return { ok: false, error: "no_active_join" };
    const result = await active.page
      .evaluate(
        async (payload) => {
          const client = window.MAB_REALTIME_CLIENT;
          if (typeof client?.runLocalMeetTool !== "function") {
            return { ok: false, error: "meet_chat_bridge_missing" };
          }
          return await client.runLocalMeetTool("send_meet_chat", payload);
        },
        { text },
      )
      .catch((error) => ({ ok: false, error: String(error?.message || error) }));
    await refreshActiveRuntimeState();
    return {
      ...result,
      realtimeBridge: active.realtimeBridge || null,
      fixtureState: active.fixtureState || null,
    };
  }

  async function readMeetChat(input: MeetChatInput = {}) {
    if (!active?.page) return { ok: false, error: "no_active_join" };
    const result = await active.page
      .evaluate(
        async (payload) => {
          const client = window.MAB_REALTIME_CLIENT;
          if (typeof client?.runLocalMeetTool !== "function") {
            return { ok: false, error: "meet_chat_bridge_missing" };
          }
          return await client.runLocalMeetTool("read_meet_chat", payload);
        },
        {
          limit: input.limit || input.count || 10,
          onlyLinks: Boolean(input.onlyLinks || input.only_links),
        },
      )
      .catch((error) => ({ ok: false, error: String(error?.message || error) }));
    await refreshActiveRuntimeState();
    return {
      ...result,
      realtimeBridge: active.realtimeBridge || null,
      fixtureState: active.fixtureState || null,
    };
  }

  async function listShareableApps() {
    const errors: string[] = [];
    let recappiApplications: any[] = [];
    try {
      const applications = await listShareableApplications();
      recappiApplications = applications.map((app) =>
        Object.assign({}, app, { source: app.source || "recappi_shareable_content" }),
      );
    } catch (error) {
      const message = String(error?.message || error);
      errors.push(`recappi_shareable_content: ${message}`);
      active?.diagnostics?.record("shareable_apps_list_error", { error: message });
    }
    let macOSApplications: any[] = [];
    try {
      const macOS = await listMacOSWindowCaptureTargets({
        keepProcessIds: [activeMacWindowCapture?.stream?.processId],
      });
      macOSApplications = macOS.applications || [];
    } catch (error) {
      const message = String(error?.message || error);
      errors.push(`macos_screencapturekit: ${message}`);
      active?.diagnostics?.record("macos_window_capture_list_error", { error: message });
    }
    const seen = new Set<string>();
    const applications = [...macOSApplications, ...recappiApplications].filter((app) => {
      const key = [
        app.source || "",
        app.windowId || app.windowID || "",
        app.processId || app.pid || "",
        app.bundleIdentifier || "",
        app.applicationName || app.name || app.title || "",
      ].join(":");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    active?.diagnostics?.record("shareable_apps_listed", {
      count: applications.length,
      source: macOSApplications.length ? "macos_screencapturekit" : "recappi_shareable_content",
      errors,
    });
    await saveDiagnostics(active?.diagnostics).catch(() => {});
    if (!applications.length && errors.length) {
      await saveDiagnostics(active?.diagnostics).catch(() => {});
      return {
        ok: false,
        error: "shareable_apps_unavailable",
        detail: errors.join("; "),
        source: "macos_screencapturekit",
      };
    }
    return {
      ok: true,
      source: macOSApplications.length ? "macos_screencapturekit" : "recappi_shareable_content",
      count: applications.length,
      applications,
      errors,
    };
  }

  function stopActiveMacWindowCapture(reason = "replace_window_capture") {
    if (!activeMacWindowCapture) return { ok: true, stopped: false, reason };
    activeMacWindowCapture.stop(reason);
    const window = activeMacWindowCapture.window;
    activeMacWindowCapture = null;
    active?.diagnostics?.record("macos_window_capture_stop", { reason, window });
    return { ok: true, stopped: true, reason, window };
  }

  function macWindowFramePath(app: any, frame: number) {
    const captureDir = pathJoin(active?.artifactsDir || config.dataDir, "screen-share-capture");
    const appPart = safeFilePart(app.applicationName || app.name || app.title || "app");
    const windowPart = safeFilePart(app.windowId || app.windowID || app.processId || "window");
    return pathJoin(captureDir, `${appPart}-${windowPart}-${String(frame).padStart(4, "0")}.png`);
  }

  function macWindowLatestFramePath(app: any) {
    const captureDir = pathJoin(active?.artifactsDir || config.dataDir, "screen-share-capture");
    const appPart = safeFilePart(app.applicationName || app.name || app.title || "app");
    const windowPart = safeFilePart(app.windowId || app.windowID || app.processId || "window");
    return pathJoin(captureDir, `${appPart}-${windowPart}-latest.jpg`);
  }

  async function captureMacWindowToSynthetic(app: any, input: AppShareInput, frame: number) {
    const windowId = Number(app.windowId || app.windowID || 0) || 0;
    if (!windowId) throw new Error("macos_window_id_required");
    const framePath = macWindowFramePath(app, frame);
    const capture = await captureMacOSWindowFrame({
      windowId,
      outputPath: framePath,
      timeoutMs: 2500,
    });
    const dimensions = syntheticShareDimensionsFromSource(input, {
      width: capture.width,
      height: capture.height,
      frame: app.frame,
    });
    const update = await startScreenShare({
      ...input,
      title: input.title || `Share ${app.applicationName || app.name || "application"}`,
      subtitle:
        input.subtitle ||
        `${app.title || app.applicationName || "Mac window"} via synthetic capture`,
      imagePath: capture.output || framePath,
      framePath: capture.output || framePath,
      width: dimensions.width,
      height: dimensions.height,
      preview: input.preview,
    });
    return { capture, update, framePath, dimensions };
  }

  function startMacWindowOneShotCaptureLoop(
    app: any,
    input: AppShareInput,
    firstFrame: number,
    fallbackReason = "",
  ) {
    const fps = Math.max(
      1,
      Math.min(
        30,
        positiveInteger(input.fps ?? input.screenShareFps) || DEFAULT_SYNTHETIC_SCREEN_SHARE_FPS,
      ),
    );
    const intervalMs = Math.max(16, Math.round(1000 / fps));
    let frame = firstFrame;
    let busy = false;
    const tick = async () => {
      if (busy || !activeMacWindowCapture || activeMacWindowCapture.stopped) return;
      busy = true;
      frame += 1;
      try {
        const result = await captureMacWindowToSynthetic(app, input, frame);
        active?.diagnostics?.record("macos_window_capture_frame", {
          frame,
          window: app,
          output: result.capture.output,
          sourceWidth: result.capture.width || null,
          sourceHeight: result.capture.height || null,
          width: result.dimensions.width,
          height: result.dimensions.height,
          updateOk: result.update?.ok,
        });
      } catch (error) {
        active?.diagnostics?.record("macos_window_capture_frame_error", {
          frame,
          window: app,
          error: String(error?.message || error),
        });
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(tick, intervalMs);
    activeMacWindowCapture = {
      timer,
      stopped: false,
      window: app,
      stop: () => {
        if (timer) clearInterval(timer);
        if (activeMacWindowCapture) activeMacWindowCapture.stopped = true;
      },
    };
    active?.diagnostics?.record("macos_window_capture_loop_started", {
      window: app,
      intervalMs,
      fps,
      width: input.width || null,
      height: input.height || null,
      fallbackReason,
    });
    return {
      ok: true,
      source: "macos_screencapturekit",
      backend: "screencapturekit_oneshot",
      intervalMs,
      fps,
      fallbackReason,
      window: app,
    };
  }

  async function startMacWindowCaptureLoop(app: any, input: AppShareInput, firstFrame: number) {
    stopActiveMacWindowCapture("replace_window_capture");
    const fps = Math.max(
      1,
      Math.min(
        30,
        positiveInteger(input.fps ?? input.screenShareFps) || DEFAULT_SYNTHETIC_SCREEN_SHARE_FPS,
      ),
    );
    const intervalMs = Math.max(16, Math.round(1000 / fps));
    const windowId = Number(app.windowId || app.windowID || 0) || 0;
    const outputPath = macWindowLatestFramePath(app);
    let stream: Awaited<ReturnType<typeof startMacOSWindowCaptureStream>>;
    try {
      stream = await startMacOSWindowCaptureStream({
        windowId,
        outputPath,
        fps,
        timeoutMs: 3000,
      });
    } catch (error) {
      const fallbackReason = String(error?.message || error);
      active?.diagnostics?.record("macos_window_capture_stream_fallback", {
        window: app,
        error: fallbackReason,
      });
      return startMacWindowOneShotCaptureLoop(app, input, firstFrame, fallbackReason);
    }

    let mjpeg: LocalMultipartFrameServer;
    try {
      mjpeg = await startLocalMultipartFrameServer({ framePath: outputPath, fps });
    } catch (error) {
      stream.stop();
      const fallbackReason = String(error?.message || error);
      active?.diagnostics?.record("macos_window_capture_mjpeg_fallback", {
        window: app,
        output: outputPath,
        error: fallbackReason,
      });
      return startMacWindowOneShotCaptureLoop(app, input, firstFrame, fallbackReason);
    }
    const dimensions = syntheticShareDimensionsFromSource(input, {
      ...readImageDimensions(outputPath),
      width: stream.width,
      height: stream.height,
      frame: app.frame,
    });
    const update = await startScreenShare({
      ...input,
      title: input.title || `Share ${app.applicationName || app.name || "application"}`,
      subtitle:
        input.subtitle ||
        `${app.title || app.applicationName || "Mac window"} via synthetic capture`,
      imageUrl: mjpeg.url,
      width: dimensions.width,
      height: dimensions.height,
      preview: input.preview,
    });
    if (!update?.ok) {
      mjpeg.stop();
      stream.stop();
      return startMacWindowOneShotCaptureLoop(
        app,
        input,
        firstFrame,
        String(update?.error || "mjpeg_screen_share_start_failed"),
      );
    }
    activeMacWindowCapture = {
      timer: null,
      stopped: false,
      window: app,
      stream,
      mjpeg,
      stop: () => {
        mjpeg.stop();
        stream.stop();
        if (activeMacWindowCapture) activeMacWindowCapture.stopped = true;
      },
    };
    active?.diagnostics?.record("macos_window_capture_loop_started", {
      backend: "screencapturekit_stream_multipart",
      window: app,
      intervalMs,
      fps,
      frameTransport: "local_multipart",
      frameContentType: "image/jpeg",
      frameUrl: mjpeg.url,
      processId: stream.processId || null,
      output: outputPath,
      sourceWidth: stream.width || null,
      sourceHeight: stream.height || null,
      width: dimensions.width,
      height: dimensions.height,
      updateOk: update.ok,
    });
    return {
      ok: true,
      source: "macos_screencapturekit",
      backend: "screencapturekit_stream_multipart",
      intervalMs,
      fps,
      output: outputPath,
      frameUrl: mjpeg.url,
      processId: stream.processId || null,
      update,
      window: app,
    };
  }

  function matchesShareableApp(app, input: AppShareInput) {
    if (matchesMacOSWindowCaptureTarget(app, input)) return true;
    const windowTitle = String(input.windowTitle || "")
      .trim()
      .toLowerCase();
    if (
      windowTitle &&
      String(app.title || app.name || "")
        .trim()
        .toLowerCase()
        .includes(windowTitle)
    )
      return true;
    const processId = Number(input.processId || input.pid || 0) || 0;
    const bundle = String(input.bundleIdentifier || input.bundleId || "")
      .trim()
      .toLowerCase();
    const name = String(input.applicationName || input.appName || input.name || "")
      .trim()
      .toLowerCase();
    if (processId && Number(app.processId || 0) === processId) return true;
    if (
      bundle &&
      String(app.bundleIdentifier || "")
        .trim()
        .toLowerCase() === bundle
    )
      return true;
    if (!name) return false;
    return [app.applicationName, app.name, app.title]
      .map((value) =>
        String(value || "")
          .trim()
          .toLowerCase(),
      )
      .some((candidate) => candidate === name || candidate.includes(name));
  }

  function activeMeetPage(): { ok: true; page: Page } | { ok: false; error: string } {
    if (!active?.page) return { ok: false, error: "no_active_join" };
    if (active.page.isClosed()) return { ok: false, error: "meet_page_closed" };
    return { ok: true, page: active.page };
  }

  function meetPageUnavailable(meetPage?: MeetPageState | null) {
    if (!meetPage || meetPage.ok !== false) return false;
    return /target page, context or browser has been closed|target page has been closed|context has been closed|browser has been closed/i.test(
      String(meetPage.error || ""),
    );
  }

  function screenSharePostcheck() {
    if (meetPageUnavailable(active?.meetPage)) {
      return { ok: false, error: "meet_page_closed", meetPage: active?.meetPage || null };
    }
    if (!active?.screenShare?.active) {
      return {
        ok: false,
        error: "screen_share_not_active_after_present",
        meetPage: active?.meetPage || null,
        screenShare: active?.screenShare || null,
      };
    }
    return {
      ok: true,
      meetPage: active?.meetPage || null,
      screenShare: active?.screenShare || null,
    };
  }

  async function presentAppShare(input: AppShareInput = {}) {
    const ready = activeMeetPage();
    if ("error" in ready) return { ok: false, error: ready.error };
    await refreshActiveRuntimeState();
    if (meetPageUnavailable(active?.meetPage)) {
      return { ok: false, error: "meet_page_closed", meetPage: active?.meetPage || null };
    }
    const beforePresentation = await getMeetPresentationState(ready.page);
    const replaceExistingShare = Boolean(
      active?.screenShare?.active || beforePresentation.presenting,
    );
    const listed = await listShareableApps();
    if (!listed.ok) return listed;
    const applications = Array.isArray(listed.applications) ? listed.applications : [];
    const app = applications.find((candidate) => matchesShareableApp(candidate, input));
    if (!app) {
      return {
        ok: false,
        error: "shareable_app_not_found",
        source: listed.source,
        count: applications.length,
        candidates: applications.slice(0, 20),
      };
    }
    const previousCaptureStop = stopActiveMacWindowCapture("replace_window_capture");
    const title = input.title || `Share ${app.applicationName || app.name || "application"}`;
    const baseInput: AppShareInput = {
      ...input,
      title,
      subtitle:
        input.subtitle ||
        `${app.title || app.applicationName || "Mac window"} via synthetic capture`,
    };
    const firstFrame = await captureMacWindowToSynthetic(app, baseInput, 1);
    const shareInput: AppShareInput = {
      ...baseInput,
      width: firstFrame.dimensions.width,
      height: firstFrame.dimensions.height,
    };
    await refreshActiveRuntimeState();
    if (meetPageUnavailable(active?.meetPage)) {
      return { ok: false, error: "meet_page_closed", meetPage: active?.meetPage || null };
    }
    const present = replaceExistingShare
      ? {
          ok: true,
          replaced: true,
          reason: "synthetic_share_replaced_active",
          screenShare: active.screenShare,
        }
      : await presentScreenShare({
          ...shareInput,
          mode: "synthetic",
          title,
          imagePath: firstFrame.capture.output,
          waitMs: input.waitMs || 2500,
          fps: shareInput.fps || shareInput.screenShareFps || DEFAULT_SYNTHETIC_SCREEN_SHARE_FPS,
        });
    const loop = await startMacWindowCaptureLoop(app, shareInput, 1);
    await refreshActiveRuntimeState();
    const postcheck = screenSharePostcheck();
    const result = {
      ok: Boolean(present.ok && postcheck.ok),
      app,
      present,
      postcheck,
      beforePresentation,
      capture: {
        mode: "macos_window_to_synthetic",
        source: "macos_screencapturekit",
        backend: firstFrame.capture.captureBackend || "screencapturekit",
        appPixelsAutomaticallySelected: true,
        windowId: app.windowId || app.windowID || 0,
        firstFrame: firstFrame.capture.output,
        sourceWidth: firstFrame.capture.width || null,
        sourceHeight: firstFrame.capture.height || null,
        width: firstFrame.dimensions.width,
        height: firstFrame.dimensions.height,
        previousCaptureStop,
        loop,
      },
      note: "app_share_started_via_synthetic_capture; Meet native picker was not used.",
    };
    active.diagnostics?.record("shareable_app_present_requested", {
      app,
      mode: "macos_window_to_synthetic",
      ok: result.ok,
      present,
      postcheck,
      capture: result.capture,
    });
    await saveDiagnostics(active.diagnostics).catch(() => {});
    return result;
  }

  async function startScreenShare(input: ScreenShareBridgeInput = {}) {
    const ready = activeMeetPage();
    if ("error" in ready) {
      return {
        ok: false,
        error: ready.error,
        screenShare: active?.screenShare || null,
        fixtureState: active?.fixtureState || null,
      };
    }
    const bridgeInput: ScreenShareBridgeInput = {
      ...input,
      mode: "synthetic",
      screenShareMode: "synthetic",
    };
    const imageUrl = await normalizeScreenShareImageUrl(
      bridgeInput.imageUrl || bridgeInput.imagePath || bridgeInput.framePath || "",
    );
    const controller = await ensureScreenShareController(ready.page, bridgeInput);
    if (!controller.ok) {
      const result = {
        ok: false,
        error: "screen_share_controller_install_failed",
        controller,
      };
      active.diagnostics?.record("screen_share_start_requested", result);
      await refreshActiveRuntimeState();
      return {
        ...result,
        screenShare: active.screenShare || null,
        fixtureState: active.fixtureState || null,
      };
    }
    const result: any = await ready.page
      .evaluate(
        async (payload) => {
          if (!window.MAB_SCREEN_SHARE_CONTROLLER?.start) {
            return { ok: false, error: "screen_share_controller_missing" };
          }
          return await window.MAB_SCREEN_SHARE_CONTROLLER.start(payload);
        },
        {
          title: bridgeInput.title || "Meeting Avatar Bot",
          subtitle: bridgeInput.subtitle || "Agent screen share",
          videoUrl: bridgeInput.videoUrl || bridgeInput.url || bridgeInput.path || "",
          imageUrl,
          width:
            positiveInteger(bridgeInput.width ?? bridgeInput.screenShareWidth) ||
            DEFAULT_SYNTHETIC_SCREEN_SHARE_WIDTH,
          height:
            positiveInteger(bridgeInput.height ?? bridgeInput.screenShareHeight) ||
            DEFAULT_SYNTHETIC_SCREEN_SHARE_HEIGHT,
          fps:
            positiveInteger(bridgeInput.fps ?? bridgeInput.screenShareFps) ||
            DEFAULT_SYNTHETIC_SCREEN_SHARE_FPS,
          preview: Boolean(bridgeInput.preview),
        },
      )
      .catch((error) => ({ ok: false, error: String(error?.message || error) }));
    const imageSourcePostcheck: {
      ok: boolean;
      error?: string;
      state?: ScreenShareControllerState | null;
    } = imageUrl ? await waitForScreenShareImageSource(ready.page) : { ok: true };
    if (imageUrl && !imageSourcePostcheck.ok) {
      result.ok = false;
      result.error = imageSourcePostcheck.error || "screen_share_image_source_not_attached";
    }
    active.diagnostics?.record("screen_share_start_requested", {
      ...result,
      controllerInstalled: controller.installed,
      controllerState: controller.state || null,
      imageSourcePostcheck,
    });
    await refreshActiveRuntimeState();
    if (meetPageUnavailable(active?.meetPage)) {
      return {
        ...result,
        ok: false,
        error: "meet_page_closed",
        meetPage: active?.meetPage || null,
        screenShare: active.screenShare || null,
        fixtureState: active.fixtureState || null,
      };
    }
    return {
      ...result,
      screenShare: active.screenShare || null,
      fixtureState: active.fixtureState || null,
    };
  }

  async function presentScreenShare(input: ScreenShareBridgeInput = {}) {
    const ready = activeMeetPage();
    if ("error" in ready) return { ok: false, error: ready.error };
    const bridgeInput: ScreenShareBridgeInput = {
      ...input,
      mode: "synthetic",
      screenShareMode: "synthetic",
    };
    const meetPage = await evaluateMeetPageState(ready.page);
    if (meetPageUnavailable(meetPage)) {
      return { ok: false, error: "meet_page_closed", mode: "synthetic", meetPage };
    }
    const beforePresentation = await getMeetPresentationState(ready.page);
    const beforeButtons = await collectButtonInventory(
      ready.page,
      active.diagnostics,
      "before-synthetic-present",
    );
    active.diagnostics?.record("screen_share_present_start", {
      inputMode: "synthetic",
      requestedMode: input.mode || input.screenShareMode || "",
      waitMs: bridgeInput.waitMs || 0,
      meetPage,
      beforePresentation,
      beforeButtons: beforeButtons.slice(0, 30),
    });
    await saveDiagnostics(active.diagnostics).catch(() => {});
    if (!meetPage.inMeeting) {
      active.diagnostics?.record("screen_share_present_blocked", {
        reason: meetPage.signIn ? "google_sign_in_required" : "not_in_meeting",
        meetPage,
        beforePresentation,
      });
      await saveDiagnostics(active.diagnostics).catch(() => {});
      return {
        ok: false,
        error: meetPage.signIn ? "google_sign_in_required" : "not_in_meeting",
        mode: "synthetic",
        meetPage,
        presentation: beforePresentation,
        buttons: beforeButtons.slice(0, 30),
      };
    }
    const controllerBefore = await readScreenShareControllerState(ready.page);
    const start = await startScreenShare(bridgeInput);
    const clickedSelector = await clickMeetShareScreenControl(ready.page, active.diagnostics, {
      allowCoordinateFallback: Boolean(bridgeInput.allowCoordinateFallback),
    });
    if (!clickedSelector) {
      const afterMissPresentation = await getMeetPresentationState(ready.page);
      active.diagnostics?.record("screen_share_present_blocked", {
        reason: "share_screen_button_not_found",
        start,
        afterMissPresentation,
      });
      await saveDiagnostics(active.diagnostics).catch(() => {});
      return {
        ok: false,
        error: "share_screen_button_not_found",
        mode: "synthetic",
        start,
        presentation: afterMissPresentation,
        screenShare: active.screenShare || null,
        fixtureState: active.fixtureState || null,
      };
    }
    const afterClickPresentation = await getMeetPresentationState(ready.page);
    active.diagnostics?.record("screen_share_present_clicked", {
      nativeMode: false,
      controllerBefore,
      clickedSelector,
      start,
      afterClickPresentation,
    });
    await saveDiagnostics(active.diagnostics).catch(() => {});
    await clickFirstVisible(
      ready.page,
      [
        "text=/Your entire screen/i",
        "text=/Entire screen/i",
        "text=/A window/i",
        "text=/A tab/i",
        'button:has-text("Share")',
      ],
      700,
      active.diagnostics,
    );
    await ready.page.waitForTimeout(Number(bridgeInput.waitMs || 3000));
    let screenshot = "";
    try {
      screenshot = await takeScreenshot(
        ready.page,
        active.diagnostics,
        "screen-share-present-click",
      );
    } catch (error) {
      active.diagnostics?.record("screen_share_present_screenshot_error", {
        error: String(error?.message || error),
      });
    }
    const buttons = await collectButtonInventory(
      ready.page,
      active.diagnostics,
      "after-screen-share-present-click",
    );
    await refreshActiveRuntimeState();
    const postcheck = screenSharePostcheck();
    active.diagnostics?.record("screen_share_present_requested", {
      start,
      clickedSelector,
      screenshot,
      postcheck,
    });
    await saveDiagnostics(active.diagnostics).catch(() => {});
    return {
      ok: Boolean(start.ok && clickedSelector && postcheck.ok),
      error: postcheck.ok ? undefined : postcheck.error,
      start,
      clickedSelector,
      screenshot,
      postcheck,
      visibleButtonLabels: buttons
        .filter((button) => button.visible)
        .map((button) => button.aria || button.text || "")
        .filter(Boolean),
      screenShare: active.screenShare || null,
      fixtureState: active.fixtureState || null,
    };
  }

  async function openVideoStage(input: VideoStageInput = {}) {
    if (!active?.context) return { ok: false, error: "no_active_join" };
    if (active.stagePage && !active.stagePage.isClosed()) {
      await active.stagePage.close().catch(() => {});
    }
    const stagePage = await active.context.newPage();
    active.stagePage = stagePage;
    installPageDiagnostics(stagePage, active.diagnostics);
    const html = buildVideoStageHtml(input);
    await stagePage.setContent(html, { waitUntil: "domcontentloaded" });
    await stagePage
      .setViewportSize({
        width: Number(input.width || 1280),
        height: Number(input.height || 720),
      })
      .catch(() => {});
    await stagePage.waitForTimeout(500);
    const stage = await withTimeout(
      stagePage.evaluate(() => window.MAB_VIDEO_STAGE || null),
      2500,
      null,
    ).catch((error) => ({ ok: false, error: String(error?.message || error) }));
    active.diagnostics?.record("video_stage_opened", {
      title: input.stageTitle || input.title || "Meeting Avatar Bot",
      videoUrl: input.videoUrl || input.url || input.path || "",
      stage,
    });
    await saveDiagnostics(active.diagnostics).catch(() => {});
    return {
      ok: true,
      title: await stagePage.title().catch(() => ""),
      url: stagePage.url(),
      stage,
    };
  }

  async function presentVideoStage(input: ScreenShareBridgeInput = {}) {
    const ready = activeMeetPage();
    if ("error" in ready) return { ok: false, error: ready.error };
    const stage = await openVideoStage({
      ...input,
      stageTitle: input.stageTitle || "Meeting Avatar Bot",
    });
    if (!stage.ok) return stage;
    const presentationMode = "synthetic";
    const syntheticController = await ensureScreenShareController(ready.page, {
      ...input,
      mode: "synthetic",
      title: input.title || "Onee Sama video stage",
      subtitle: input.subtitle || "Shared by Onee Sama",
      fps: input.fps || 30,
    });
    await ready.page.bringToFront().catch(() => {});
    const present = await presentScreenShare({
      ...input,
      mode: presentationMode,
      waitMs: input.waitMs || 2500,
    });
    return {
      ok: Boolean(stage.ok && present.ok),
      stage,
      syntheticController,
      present,
      note: "video_stage_tab_opened; synthetic Meet screen-share stream was requested",
    };
  }

  async function stopScreenShare() {
    const ready = activeMeetPage();
    if ("error" in ready) {
      return {
        ok: false,
        error: ready.error,
        screenShare: active?.screenShare || null,
        fixtureState: active?.fixtureState || null,
      };
    }
    const captureStop = stopActiveMacWindowCapture("screen_share_stop");
    const result = await ready.page
      .evaluate(async () => {
        if (!window.MAB_SCREEN_SHARE_CONTROLLER?.stop) {
          return { ok: false, error: "screen_share_controller_missing" };
        }
        return await window.MAB_SCREEN_SHARE_CONTROLLER.stop();
      })
      .catch((error) => ({ ok: false, error: String(error?.message || error) }));
    active.diagnostics?.record("screen_share_stop_requested", { ...result, captureStop });
    await refreshActiveRuntimeState();
    return {
      ...result,
      screenShare: active.screenShare || null,
      fixtureState: active.fixtureState || null,
    };
  }

  async function status() {
    await refreshActiveRuntimeState();
    return {
      ok: true,
      active: active
        ? {
            sessionId: active.sessionId,
            meetUrl: active.meetUrl,
            startedAt: active.startedAt,
            meetProfileMode: active.meetProfileMode || "",
            browserUserDataDir: active.browserUserDataDir || "",
            clickedJoinSelector: active.clickedJoinSelector || "",
            diagnosticsPath: active.diagnostics?.jsonPath || "",
            artifactsDir: active.artifactsDir || "",
            screenshots: active.diagnostics?.screenshots || [],
            avatarReady: active.avatarReady || null,
            avatarAudio: active.avatarAudio || null,
            recorder: active.recorder?.status() || null,
            realtimeAudioCapture: active.realtimeAudioCapture?.status() || null,
            captions: compactCaptionState(active.captions) || null,
            fixtureState: active.fixtureState || null,
            realtimeBridge: active.realtimeBridge || null,
            workerResultBridge: active.workerResultBridge || null,
            localDialog: active.localDialog || null,
            screenShare: active.screenShare || null,
            meetPage: active.meetPage || null,
            meetingAwareness: active.meetingAwareness || null,
            meetingAwarenessPush: active.meetingAwarenessPush || null,
          }
        : null,
    };
  }

  return {
    join,
    stop,
    status,
    injectWorkerResult,
    sendRealtimeEvent,
    requestRealtimeTextTurn,
    sendMeetChat,
    readMeetChat,
    listShareableApps,
    presentAppShare,
    startScreenShare,
    presentScreenShare,
    openVideoStage,
    presentVideoStage,
    stopScreenShare,
  };
}
