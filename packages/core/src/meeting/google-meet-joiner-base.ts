import { createServer, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { extname, isAbsolute, relative, resolve as pathResolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ScreenShareState } from "../browser-runtime-types.ts";
import type { SpeakerIdentityResolution } from "../realtime/speaker-identity.ts";
export const require = createRequire(import.meta.url);
export type Page = import("playwright").Page;
export const DEFAULT_SYNTHETIC_SCREEN_SHARE_WIDTH = 2560;
export const DEFAULT_SYNTHETIC_SCREEN_SHARE_HEIGHT = 1440;
export const DEFAULT_SYNTHETIC_SCREEN_SHARE_FPS = 25;
export const MAX_SYNTHETIC_SCREEN_SHARE_WIDTH = 3840;
export const MAX_SYNTHETIC_SCREEN_SHARE_HEIGHT = 2160;
export interface MeetUrlOptions {
  allowNonGoogleMeet?: boolean;
}
export interface VideoStageInput {
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
export interface ScreenShareBridgeInput extends VideoStageInput {
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
export interface AppShareInput extends ScreenShareBridgeInput {
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
export interface MeetChatInput {
  text?: string;
  message?: string;
  limit?: number;
  count?: number;
  onlyLinks?: boolean;
  only_links?: boolean;
}

export interface ButtonInventoryEntry {
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

export interface Diagnostics {
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

export interface AccessibilityNodeLike {
  name?: unknown;
  value?: unknown;
  description?: unknown;
  role?: unknown;
  children?: AccessibilityNodeLike[];
}

export interface AccessibilitySnapshotApi {
  snapshot(options: { interestingOnly: boolean }): Promise<unknown>;
}

export interface PresentationButton {
  index: number;
  label: string;
  disabled: boolean;
  visible: boolean;
  rect: { x: number; y: number; width: number; height: number };
}

export interface PresentationState {
  ok: boolean;
  presenting?: boolean;
  starting?: boolean;
  failed?: boolean;
  textHead?: string;
  shareButtons?: PresentationButton[];
  buttons?: PresentationButton[];
  error?: string;
}

export interface ShareScreenButtonInfo {
  index: number;
  label: string;
  rect: { x: number; y: number; width: number; height: number };
}

export type ShareScreenDomClickResult =
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

export type ScreenShareControllerState = ScreenShareState | { ok: boolean; error?: string; mode?: string };

export interface GuestNameEvalResult {
  ok: boolean;
  reason?: string;
  textHead?: string;
  tag?: string;
  aria?: string;
  placeholder?: string;
  valueLength?: number;
  error?: string;
}

export type MeetJoinButtonEvalResult =
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

export interface MeetPageState {
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

export interface MeetParticipantSignal {
  name: string;
  source: string;
  confidence: "low" | "medium" | "high";
  participantId?: string;
  rawLabel?: string;
  lastSeenAt?: string;
  identity?: SpeakerIdentityResolution | null;
}

export interface MeetSpeakerSignal {
  name: string;
  source: string;
  confidence: "low" | "medium" | "high";
  observedAt: string;
  rawLabel?: string;
  identity?: SpeakerIdentityResolution | null;
}

export interface MeetingAwarenessState {
  ok: boolean;
  observedAt: string;
  source: string;
  participants: MeetParticipantSignal[];
  participantCount: number | null;
  activeSpeaker: MeetSpeakerSignal | null;
  recentSpeakers: MeetSpeakerSignal[];
  caveat: string;
}

export interface GoogleMeetJoinerOptions {
  allowNonGoogleMeet?: boolean;
  playwrightModulePath?: string;
  chromiumExecutablePath?: string;
}

export interface GoogleMeetJoinInput extends ScreenShareBridgeInput {
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
  autoRespondToAvatarToolCalls?: boolean;
  realtimeTools?: unknown[];
  realtimeSession?: Record<string, unknown>;
  sendRealtimeSessionUpdate?: boolean;
  includeParticipantAudio?: boolean;
  forwardMeetAudioToRealtime?: boolean;
  meetAudioInputGain?: number | string;
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

export function shouldMuteMeetLocalPlayback(input: GoogleMeetJoinInput): boolean {
  if (typeof input.muteLocalPlayback === "boolean") return input.muteLocalPlayback;
  const realtimeNeedsMeetAudio =
    input.installRealtimeBridge !== false &&
    input.autoConnectRealtime === true &&
    input.includeParticipantAudio === true &&
    input.forwardMeetAudioToRealtime !== false;
  return !realtimeNeedsMeetAudio;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function safeFilePart(value: unknown, fallback = "item"): string {
  return (
    String(value || fallback)
      .replace(/[^a-zA-Z0-9_.-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 96) || fallback
  );
}

export function positiveInteger(value: unknown): number | null {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function fitDimensionsWithin(width: number, height: number, maxWidth: number, maxHeight: number) {
  if (!width || !height) return { width: maxWidth, height: maxHeight };
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return {
    width: Math.max(320, Math.round(width * scale)),
    height: Math.max(180, Math.round(height * scale)),
  };
}

export function syntheticShareDimensionsFromSource(
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

export function assertMeetUrl(meetUrl: string, options: MeetUrlOptions = {}) {
  if (options.allowNonGoogleMeet) return;
  if (!/^https:\/\/meet\.google\.com\/[a-z-]+/i.test(meetUrl || "")) {
    throw new Error("meetUrl must be a Google Meet URL");
  }
}

export function normalizeMeetProfileMode(mode: unknown, hasUserDataDir: boolean): "guest" | "persistent" {
  const normalized = String(mode || "")
    .trim()
    .toLowerCase();
  if (!normalized) return hasUserDataDir ? "persistent" : "guest";
  if (normalized === "guest" || normalized === "persistent") return normalized;
  throw new Error("MAB_MEET_PROFILE_MODE must be guest or persistent");
}

export function escapeHtml(value: unknown): string {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function normalizeStageVideoUrl(value = ""): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw) || /^file:\/\//i.test(raw) || /^data:/i.test(raw)) return raw;
  return pathToFileURL(pathResolve(raw)).toString();
}

export async function normalizeScreenShareImageUrl(value = ""): Promise<string> {
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

export interface LocalMultipartFrameServer {
  url: string;
  port: number;
  token: string;
  framePath: string;
  stop: () => void;
  clientCount: () => number;
}

export interface LocalStaticAssetServer {
  baseUrl: string;
  port: number;
  token: string;
  root: string;
  urlFor: (relativePath: string) => string;
  stop: () => void;
}

function mediaTypeForPath(pathname: string) {
  switch (extname(pathname).toLowerCase()) {
    case ".mp4":
      return "video/mp4";
    case ".webm":
      return "video/webm";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    default:
      return "application/octet-stream";
  }
}

function safeStaticAssetPath(root: string, relativePath: string) {
  const clean = decodeURIComponent(relativePath).replace(/^\/+/, "");
  const absolute = pathResolve(root, clean);
  const fromRoot = relative(root, absolute);
  if (!fromRoot || fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
    throw new Error("asset_path_outside_root");
  }
  return { absolute, relative: fromRoot.split(sep).join("/") };
}

function parseRangeHeader(header: string | undefined, size: number) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const startRaw = match[1] || "";
  const endRaw = match[2] || "";
  let start = startRaw ? Number.parseInt(startRaw, 10) : 0;
  let end = endRaw ? Number.parseInt(endRaw, 10) : size - 1;
  if (!startRaw && endRaw) {
    const suffixLength = Math.max(0, Number.parseInt(endRaw, 10) || 0);
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
    return null;
  }
  return {
    start: Math.min(start, size - 1),
    end: Math.min(end, size - 1),
  };
}

export async function startLocalStaticAssetServer(input: {
  root: string;
  pathPrefix?: string;
}): Promise<LocalStaticAssetServer> {
  const root = pathResolve(input.root);
  const rootInfo = await stat(root);
  if (!rootInfo.isDirectory()) {
    throw new Error(`Avatar asset root is not a directory: ${root}`);
  }
  const token = randomUUID();
  const prefix = `${input.pathPrefix || "/avatar-assets"}/${token}`;
  let stopped = false;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "Range",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    };
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }
    if ((req.method !== "GET" && req.method !== "HEAD") || !url.pathname.startsWith(prefix)) {
      res.writeHead(404, corsHeaders);
      res.end("not found");
      return;
    }
    try {
      const { absolute, relative: relativePath } = safeStaticAssetPath(
        root,
        url.pathname.slice(prefix.length),
      );
      const info = await stat(absolute);
      if (!info.isFile()) {
        res.writeHead(404, corsHeaders);
        res.end("not found");
        return;
      }
      const range = parseRangeHeader(req.headers.range, info.size);
      const contentType = mediaTypeForPath(relativePath);
      if (range) {
        const length = range.end - range.start + 1;
        res.writeHead(206, {
          ...corsHeaders,
          "Accept-Ranges": "bytes",
          "Content-Type": contentType,
          "Content-Length": length,
          "Content-Range": `bytes ${range.start}-${range.end}/${info.size}`,
        });
        if (req.method === "HEAD") {
          res.end();
          return;
        }
        createReadStream(absolute, { start: range.start, end: range.end }).pipe(res);
        return;
      }
      res.writeHead(200, {
        ...corsHeaders,
        "Accept-Ranges": "bytes",
        "Content-Type": contentType,
        "Content-Length": info.size,
      });
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      createReadStream(absolute).pipe(res);
    } catch {
      res.writeHead(404, corsHeaders);
      res.end("not found");
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const baseUrl = `http://localhost:${port}${prefix}`;
  return {
    baseUrl,
    port,
    token,
    root,
    urlFor: (relativePath: string) => {
      const safe = safeStaticAssetPath(root, relativePath).relative;
      return `${baseUrl}/${safe
        .split("/")
        .map((part) => encodeURIComponent(part))
        .join("/")}`;
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      server.close();
    },
  };
}

export async function startLocalMultipartFrameServer(input: {
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

export function buildVideoStageHtml(input: VideoStageInput = {}): string {
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

export async function loadPlaywright(modulePath?: string) {
  if (modulePath) return require(modulePath);
  return await import("playwright");
}

export function createDiagnostics(sessionId: string, screenshotDir: string): Diagnostics {
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

export async function saveDiagnostics(diagnostics: Diagnostics) {
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

export function installPageDiagnostics(page: Page, diagnostics: Diagnostics) {
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

export function isRetryableMeetGotoError(error: unknown): boolean {
  const message = String((error as Error)?.message || error);
  return ["net::ERR_CONNECTION_CLOSED", "net::ERR_ABORTED", "Execution context was destroyed"].some(
    (fragment) => message.includes(fragment),
  );
}

export async function withTimeout<T, F>(
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

export async function gotoMeetWithRetry(page: Page, meetUrl: string, diagnostics: Diagnostics) {
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

export async function takeScreenshot(page: Page, diagnostics: Diagnostics, name: string): Promise<string> {
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
