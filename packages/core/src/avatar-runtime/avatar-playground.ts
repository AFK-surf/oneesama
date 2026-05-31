import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, relative, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import type { HiyoriAvatarConfig } from "../browser-runtime-types.ts";
import { buildAvatarInitScript } from "../avatar/init-script-builder.ts";

export interface AvatarPlaygroundOptions {
  host?: string;
  port?: number;
  botName?: string;
  avatar?: Partial<HiyoriAvatarConfig>;
}

export interface AvatarPlaygroundListenResult {
  host: string;
  port: number;
  url: string;
}

export interface AvatarPlaygroundServer {
  server: Server;
  listen(): Promise<AvatarPlaygroundListenResult>;
  close(): Promise<void>;
}

type AvatarPreset = {
  id: string;
  name: string;
  shortName: string;
  icon: string;
  note: string;
  avatar: Partial<HiyoriAvatarConfig>;
};

type StatePreset = {
  id: string;
  name: string;
  icon: string;
  description: string;
  mood: string;
  action: string;
  intensity: number;
  statusKind: string;
  statusText: string;
  audioSource: string;
  audioStatus: "healthy" | "waiting" | "blocked";
  voice: "idle" | "talk" | "ready" | "blocked";
  tool: "idle" | "running" | "done" | "blocked";
  error?: string;
};

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 18912;
const DEFAULT_AVATAR_ASSET_ROOT = fileURLToPath(new URL("../../assets/avatar/", import.meta.url));
const VIDEO_IDLE_URL = "/assets/avatar/v1-green/oneesama-video-idle-loop-subtle.mp4";
const VIDEO_SPEAKING_URL = "/assets/avatar/v1-green/oneesama-video-speaking-loop-slit.mp4";

const AVATAR_PRESETS: AvatarPreset[] = [
  {
    id: "hiyori-live2d",
    name: "Hiyori Live2D",
    shortName: "Hiyori",
    icon: "H",
    note: "Default Live2D renderer with network/CDN fallback.",
    avatar: { avatarRenderer: "live2d", disableLive2D: false, background: "#12161d" },
  },
  {
    id: "fallback-canvas",
    name: "Fallback Canvas",
    shortName: "Fallback",
    icon: "F",
    note: "Deterministic canvas avatar for fast local iteration.",
    avatar: { avatarRenderer: "live2d", disableLive2D: true, background: "#e9edf2" },
  },
  {
    id: "vrm-preview",
    name: "VRM Preview",
    shortName: "VRM",
    icon: "3D",
    note: "Experimental 3D/VRM renderer; falls back if WebGL/deps are unavailable.",
    avatar: { avatarRenderer: "vrm", disableLive2D: true, background: "#11161f" },
  },
  {
    id: "oneesama-video",
    name: "Oneesama Video",
    shortName: "Video",
    icon: "V",
    note: "Two-state muted video avatar: idle loop plus coarse speaking loop.",
    avatar: {
      avatarRenderer: "video",
      background: "#0b1018",
      videoObjectFit: "cover",
      videoMuted: true,
      videoCrossfadeMs: 220,
      videoSpeakingDebounceMs: 220,
      videoChromaKey: {
        enabled: true,
        keyColor: "#00ff00",
        similarity: 0.22,
        smoothness: 0.06,
        minGreen: 45,
        minDominance: 18,
        spill: 0.82,
        spillSoftness: 10,
        matteErodePx: 1,
        matteFeatherPx: 1,
      },
      videoSources: [
        {
          id: "idle",
          label: "Idle loop",
          state: "idle",
          url: VIDEO_IDLE_URL,
          objectFit: "cover",
          background: "#0b1018",
          default: true,
        },
        {
          id: "speaking",
          label: "Speaking loop",
          state: "speaking",
          url: VIDEO_SPEAKING_URL,
          objectFit: "cover",
          background: "#0b1018",
        },
      ],
    },
  },
];

const STATE_PRESETS: StatePreset[] = [
  {
    id: "idle",
    name: "Idle",
    icon: "I",
    description: "Renderer is calm, connected, and waiting.",
    mood: "neutral",
    action: "idle",
    intensity: 0.65,
    statusKind: "idle",
    statusText: "",
    audioSource: "recappi_process_audio_tap",
    audioStatus: "healthy",
    voice: "idle",
    tool: "idle",
  },
  {
    id: "listening",
    name: "Listening",
    icon: "L",
    description: "Connected and waiting for the human voice turn.",
    mood: "thinking",
    action: "idle",
    intensity: 0.7,
    statusKind: "thinking",
    statusText: "等待输入",
    audioSource: "recappi_process_audio_tap",
    audioStatus: "healthy",
    voice: "idle",
    tool: "idle",
  },
  {
    id: "thinking",
    name: "Thinking",
    icon: "T",
    description: "Realtime has heard the user and is preparing a response.",
    mood: "thinking",
    action: "think",
    intensity: 1,
    statusKind: "thinking",
    statusText: "思考中",
    audioSource: "recappi_process_audio_tap",
    audioStatus: "healthy",
    voice: "ready",
    tool: "idle",
  },
  {
    id: "speaking",
    name: "Speaking",
    icon: "S",
    description: "Realtime output audio is active.",
    mood: "happy",
    action: "speak",
    intensity: 1.15,
    statusKind: "done",
    statusText: "正在说话",
    audioSource: "recappi_process_audio_tap",
    audioStatus: "healthy",
    voice: "talk",
    tool: "idle",
  },
  {
    id: "tool",
    name: "Using Tool",
    icon: "CU",
    description: "App-control/CU is operating a shared window.",
    mood: "thinking",
    action: "lean_forward",
    intensity: 1.1,
    statusKind: "opening_preview",
    statusText: "正在操作 Pencil",
    audioSource: "recappi_process_audio_tap",
    audioStatus: "healthy",
    voice: "ready",
    tool: "running",
  },
  {
    id: "blocked",
    name: "Blocked",
    icon: "!",
    description: "A tool or runtime blocker needs operator attention.",
    mood: "sad",
    action: "shrug",
    intensity: 1,
    statusKind: "blocked",
    statusText: "操作受阻",
    audioSource: "recappi_process_audio_tap",
    audioStatus: "healthy",
    voice: "ready",
    tool: "blocked",
    error: "app_control_job_blocked",
  },
  {
    id: "done",
    name: "Done",
    icon: "✓",
    description: "Tool completed and user-facing confirmation should stay visual.",
    mood: "happy",
    action: "emphasize",
    intensity: 1.05,
    statusKind: "done",
    statusText: "操作完成",
    audioSource: "recappi_process_audio_tap",
    audioStatus: "healthy",
    voice: "ready",
    tool: "done",
  },
  {
    id: "snapshot",
    name: "Snapshot",
    icon: "◎",
    description: "Presentation-ready pose for inspecting composition.",
    mood: "happy",
    action: "wave",
    intensity: 1,
    statusKind: "done",
    statusText: "预设快照",
    audioSource: "recappi_process_audio_tap",
    audioStatus: "healthy",
    voice: "ready",
    tool: "idle",
  },
];

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function jsonResponse(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body, null, 2));
}

function htmlResponse(res: ServerResponse, html: string) {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(html);
}

function jsResponse(res: ServerResponse, source: string) {
  res.writeHead(200, {
    "content-type": "application/javascript; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(source);
}

function avatarAssetRoots() {
  return [
    process.env.ONEESAMA_AVATAR_ASSET_ROOT,
    process.env.MAB_AVATAR_ASSET_ROOT,
    DEFAULT_AVATAR_ASSET_ROOT,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .map((value) => resolvePath(value));
}

function videoContentType(filePath: string) {
  switch (extname(filePath).toLowerCase()) {
    case ".webm":
      return "video/webm";
    case ".mov":
      return "video/quicktime";
    default:
      return "video/mp4";
  }
}

async function assetResponse(res: ServerResponse, pathname: string) {
  const relativePath = decodeURIComponent(pathname.replace(/^\/assets\/avatar\/+/, ""));
  for (const root of avatarAssetRoots()) {
    const filePath = resolvePath(root, relativePath);
    const rel = relative(root, filePath);
    if (!rel || rel.startsWith("..") || rel.includes("..")) continue;
    const info = await stat(filePath).catch(() => null);
    if (!info?.isFile()) continue;
    res.writeHead(200, {
      "content-type": videoContentType(filePath),
      "content-length": String(info.size),
      "cache-control": "public, max-age=60",
      "accept-ranges": "bytes",
    });
    createReadStream(filePath).pipe(res);
    return;
  }
  return jsonResponse(res, 404, { ok: false, error: "avatar_asset_not_found" });
}

function selectedAvatarPreset(id: string | null | undefined) {
  return AVATAR_PRESETS.find((preset) => preset.id === id) || AVATAR_PRESETS[0];
}

function buildInitSource(options: AvatarPlaygroundOptions, avatarPreset: AvatarPreset) {
  return buildAvatarInitScript({
    avatarRenderer: "live2d",
    layout: "center",
    botName: options.botName || "Oneesama",
    canvasWidth: 1280,
    canvasHeight: 720,
    captureFps: 24,
    enableVisualTestHooks: true,
    ...avatarPreset.avatar,
    ...options.avatar,
  });
}

export function buildAvatarPlaygroundHtml(input: { botName: string; selectedAvatarId: string }) {
  const selected = selectedAvatarPreset(input.selectedAvatarId);
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(input.botName)} Avatar Playground</title>
    <script src="/runtime/init.js?avatar=${encodeURIComponent(selected.id)}"></script>
    <style>
      :root {
        color-scheme: dark;
        --bg: #0a0e1a;
        --panel: rgba(10, 14, 26, 0.82);
        --panel-strong: rgba(255, 255, 255, 0.075);
        --panel-soft: rgba(255, 255, 255, 0.045);
        --line: rgba(255, 255, 255, 0.10);
        --line-strong: rgba(255, 255, 255, 0.18);
        --ink: #e9ebf3;
        --muted: rgba(233, 235, 243, 0.62);
        --faint: rgba(233, 235, 243, 0.42);
        --accent: #7c8aff;
        --cyan: #5dade2;
        --green: #58d68a;
        --amber: #f4c45a;
        --red: #ff6b6b;
        --purple: #b08cff;
      }
      * { box-sizing: border-box; -webkit-font-smoothing: antialiased; }
      html { height: 100%; }
      body {
        margin: 0;
        height: 100%;
        overflow: hidden;
        background:
          linear-gradient(150deg, rgba(124, 138, 255, 0.20), transparent 34%),
          linear-gradient(315deg, rgba(176, 140, 255, 0.12), transparent 42%),
          repeating-linear-gradient(90deg, rgba(255,255,255,0.018) 0 1px, transparent 1px 92px),
          repeating-linear-gradient(0deg, rgba(255,255,255,0.014) 0 1px, transparent 1px 72px),
          var(--bg);
        color: var(--ink);
        font-family: -apple-system, "PingFang SC", "SF Pro Display", "Helvetica Neue", sans-serif;
        letter-spacing: -0.01em;
      }
      .app {
        display: grid;
        grid-template-columns: minmax(680px, 1fr) 360px;
        height: 100vh;
        min-height: 720px;
      }
      .stage {
        position: relative;
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }
      .stage::before {
        content: "";
        position: absolute;
        inset: 0;
        pointer-events: none;
        background:
          linear-gradient(180deg, rgba(255,255,255,0.04), transparent 20%),
          linear-gradient(180deg, transparent 62%, rgba(0,0,0,0.38));
      }
      .stage-header,
      .stage-footer {
        position: relative;
        z-index: 2;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 18px;
        padding: 24px 32px;
      }
      .brand {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .brand-mark {
        display: grid;
        place-items: center;
        width: 32px;
        height: 32px;
        border-radius: 8px;
        color: white;
        font-size: 13px;
        font-weight: 900;
        background: linear-gradient(135deg, var(--accent), var(--purple));
        box-shadow: 0 8px 24px rgba(124, 138, 255, 0.24);
      }
      .brand-title {
        font-size: 15px;
        font-weight: 720;
      }
      .brand-subtitle,
      .stage-meta,
      .stage-footer {
        color: var(--muted);
        font-size: 11px;
      }
      .stage-status {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        min-height: 28px;
        padding: 0 12px;
        border: 1px solid rgba(88, 214, 138, 0.28);
        border-radius: 999px;
        background: rgba(88, 214, 138, 0.12);
        color: var(--green);
        font-size: 11px;
        font-weight: 680;
      }
      .stage-status::before {
        content: "";
        width: 6px;
        height: 6px;
        border-radius: 999px;
        background: var(--green);
        box-shadow: 0 0 12px var(--green);
      }
      .stage-canvas {
        position: relative;
        z-index: 1;
        flex: 1;
        display: grid;
        place-items: center;
        min-height: 0;
        padding: 0 32px 10px;
      }
      .avatar-frame {
        position: relative;
        width: min(680px, 72vw);
        height: min(720px, calc(100vh - 170px));
        min-height: 540px;
        border: 1px solid var(--line);
        border-radius: 24px;
        overflow: hidden;
        background:
          linear-gradient(180deg, rgba(255,255,255,0.03), transparent),
          rgba(0,0,0,0.30);
        backdrop-filter: blur(22px);
        box-shadow:
          0 30px 80px rgba(0,0,0,0.42),
          inset 0 1px 0 rgba(255,255,255,0.05);
      }
      .avatar-frame::before {
        content: "LIVE RENDER";
        position: absolute;
        left: 18px;
        top: 16px;
        z-index: 2;
        color: rgba(233,235,243,0.45);
        font-size: 10px;
        font-weight: 900;
        letter-spacing: 0.18em;
      }
      .avatar-video {
        display: block;
        width: 100%;
        height: 100%;
        background: #12161d;
        object-fit: cover;
      }
      @keyframes pulse {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.48; transform: scale(1.35); }
      }
      .stage-footer {
        padding-top: 8px;
      }
      .footer-readout {
        max-width: 70%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-family: ui-monospace, "SF Mono", Menlo, monospace;
        color: rgba(233,235,243,0.58);
      }
      .panel {
        display: flex;
        flex-direction: column;
        min-height: 0;
        overflow-y: auto;
        border-left: 1px solid var(--line);
        background: var(--panel);
        backdrop-filter: blur(22px);
      }
      .panel-header,
      .panel-section,
      .panel-footer {
        padding: 20px 24px;
        border-bottom: 1px solid var(--line);
      }
      .panel-title,
      .section-label {
        margin: 0;
        color: var(--faint);
        font-size: 10px;
        font-weight: 780;
        letter-spacing: 0.11em;
        text-transform: uppercase;
      }
      .avatar-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 8px;
        margin-top: 12px;
      }
      .avatar-card {
        aspect-ratio: 1;
        border: 1px solid var(--line);
        border-radius: 12px;
        background: var(--panel-soft);
        color: var(--muted);
        cursor: pointer;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 6px;
        transition: transform .15s ease, background .15s ease, border-color .15s ease;
      }
      .avatar-card:hover {
        transform: translateY(-1px);
        background: var(--panel-strong);
        border-color: var(--line-strong);
      }
      .avatar-card.selected {
        background: rgba(124,138,255,0.16);
        border-color: rgba(124,138,255,0.84);
        color: var(--ink);
        box-shadow: 0 10px 26px rgba(124,138,255,0.14);
      }
      .avatar-icon {
        display: grid;
        place-items: center;
        width: 34px;
        height: 34px;
        border-radius: 10px;
        background: rgba(255,255,255,0.06);
        font-size: 12px;
        font-weight: 900;
      }
      .avatar-name {
        font-size: 10px;
        font-weight: 680;
      }
      .state-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 7px;
        margin-top: 12px;
      }
      .state-btn {
        display: flex;
        align-items: center;
        gap: 8px;
        min-height: 42px;
        padding: 0 11px;
        border: 1px solid var(--line);
        border-radius: 10px;
        background: var(--panel-soft);
        color: var(--muted);
        cursor: pointer;
        font: inherit;
        font-size: 12px;
        font-weight: 680;
        text-align: left;
        transition: background .15s ease, border-color .15s ease, color .15s ease;
      }
      .state-btn:hover {
        background: var(--panel-strong);
        color: var(--ink);
      }
      .state-btn.active {
        border-color: rgba(124,138,255,0.82);
        background: rgba(124,138,255,0.16);
        color: var(--ink);
        box-shadow: 0 8px 22px rgba(124,138,255,0.12);
      }
      .state-icon {
        display: grid;
        place-items: center;
        width: 22px;
        height: 22px;
        border-radius: 7px;
        background: rgba(255,255,255,0.06);
        color: var(--ink);
        font-size: 10px;
        font-weight: 900;
      }
      .signal-list {
        display: flex;
        flex-direction: column;
        gap: 7px;
        margin-top: 12px;
      }
      .signal-row {
        min-height: 36px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 0 12px;
        border: 1px solid transparent;
        border-radius: 8px;
        background: var(--panel-soft);
      }
      .signal-row.active {
        border-color: var(--line-strong);
      }
      .signal-label {
        color: var(--muted);
        font-size: 10px;
        font-weight: 760;
        letter-spacing: 0.07em;
        text-transform: uppercase;
      }
      .signal-value,
      .footer-readout {
        font-family: ui-monospace, "SF Mono", Menlo, monospace;
      }
      .signal-value {
        font-size: 11px;
        font-weight: 760;
      }
      .level-ok .signal-value { color: var(--green); }
      .level-active .signal-value { color: var(--cyan); }
      .level-warn .signal-value { color: var(--amber); }
      .level-blocked .signal-value { color: var(--red); }
      .level-idle .signal-value { color: var(--faint); }
      .panel-footer {
        margin-top: auto;
        border-bottom: 0;
        border-top: 1px solid var(--line);
        color: var(--faint);
        font-size: 10px;
        line-height: 1.6;
      }
      .kbd {
        display: inline-flex;
        align-items: center;
        min-height: 18px;
        padding: 0 6px;
        border: 1px solid var(--line-strong);
        border-radius: 5px;
        background: var(--panel-strong);
        color: var(--muted);
        font-family: ui-monospace, "SF Mono", Menlo, monospace;
        font-size: 9px;
      }
      @media (max-width: 940px) {
        body { overflow: auto; }
        .app { grid-template-columns: 1fr; height: auto; min-height: 100vh; }
        .panel { border-left: 0; border-top: 1px solid var(--line); }
        .avatar-frame { width: min(620px, calc(100vw - 32px)); height: min(680px, 72vh); }
      }
    </style>
  </head>
  <body>
    <main class="app">
      <section class="stage">
        <header class="stage-header">
          <div class="brand">
            <div class="brand-mark">OS</div>
            <div>
              <div class="brand-title">${escapeHtml(input.botName)} Avatar Studio</div>
              <div class="brand-subtitle">runtime preview · HUD sandbox · no Meet required</div>
            </div>
          </div>
          <div class="stage-meta">
            <span class="stage-status" id="boot-status">starting</span>
          </div>
        </header>
        <div class="stage-canvas">
          <div class="avatar-frame">
            <video class="avatar-video" id="avatar-preview" autoplay muted playsinline></video>
          </div>
        </div>
        <footer class="stage-footer">
          <div class="footer-readout" id="readout">Booting avatar runtime…</div>
          <div id="renderer-readout">runtime</div>
        </footer>
      </section>
      <aside class="panel">
        <div class="panel-header">
          <h2 class="panel-title">Director</h2>
        </div>
        <section class="panel-section">
          <div class="section-label">Avatar</div>
          <div class="avatar-grid" id="avatar-cards"></div>
        </section>
        <section class="panel-section">
          <div class="section-label">State Preset</div>
          <div class="state-grid" id="state-buttons"></div>
        </section>
        <section class="panel-section">
          <div class="section-label">Signals</div>
          <div class="signal-list" id="signals"></div>
        </section>
        <footer class="panel-footer">
          <div><span class="kbd">click</span> switch presets · <span class="kbd">live</span> real runtime</div>
          <div>local 127.0.0.1:18912 · iterate without Meet</div>
        </footer>
      </aside>
    </main>
    <script>
      (() => {
        const avatarPresets = ${JSON.stringify(AVATAR_PRESETS)};
        const statePresets = ${JSON.stringify(STATE_PRESETS)};
        const selectedAvatarId = ${JSON.stringify(selected.id)};
        const els = {
          boot: document.getElementById("boot-status"),
          preview: document.getElementById("avatar-preview"),
          avatarCards: document.getElementById("avatar-cards"),
          stateButtons: document.getElementById("state-buttons"),
          signals: document.getElementById("signals"),
          readout: document.getElementById("readout"),
          rendererReadout: document.getElementById("renderer-readout"),
        };
        const state = { ready: false, activeState: "listening", errors: [] };

        function failure(status, reason) {
          return { status, reason, signals: {} };
        }

        function bridgeFromPreset(preset) {
          const toolJobs = {};
          if (preset.tool !== "idle") {
            toolJobs["playground_tool"] = {
              id: "playground_tool",
              status:
                preset.tool === "running"
                  ? "running"
                  : preset.tool === "blocked"
                    ? "blocked"
                    : "completed",
              updatedAt: new Date().toISOString(),
              visibility: "silent",
            };
          }
          const toolCallTs = new Date().toISOString();
          const toolCalls =
            preset.tool === "idle"
              ? { meet: [], workspace: [] }
              : {
                  meet: [
                    { ts: toolCallTs, name: "list_shareable_windows" },
                    { ts: toolCallTs, name: "share_existing_app_window" },
                  ],
                  workspace: [{ ts: toolCallTs, name: "control_shared_app_window" }],
                };
          return {
            connected: true,
            connection: {
              peerConnectionState: "connected",
              dataChannelReadyState: "open",
              currentRealtimeInputSource: preset.audioSource,
              responseEvents: preset.voice === "idle" ? 0 : 1,
            },
            turnPolicy: { appControlJobs: toolJobs },
            meetTools: { calls: toolCalls.meet, errors: [] },
            workspaceTools: { calls: toolCalls.workspace, errors: [] },
            workerTools: { calls: [], errors: [] },
            errors: preset.error ? [{ message: preset.error, type: "playground" }] : [],
            feedback: {
              failureMatrix: {
                transport: failure("healthy", "connected"),
                audioInput: failure(preset.audioStatus, preset.audioStatus),
                modelTurn: failure(preset.voice === "blocked" ? "blocked" : "healthy", preset.voice),
                toolTurns: failure(
                  preset.tool === "blocked" ? "blocked" : "healthy",
                  preset.tool,
                ),
                audioOutput: failure(preset.voice === "blocked" ? "blocked" : "healthy", preset.voice),
              },
            },
          };
        }

        function renderAvatarCards() {
          els.avatarCards.innerHTML = "";
          avatarPresets.forEach((preset) => {
            const card = document.createElement("button");
            card.type = "button";
            card.className = "avatar-card" + (preset.id === selectedAvatarId ? " selected" : "");
            card.innerHTML = "<span class='avatar-icon'></span><span class='avatar-name'></span>";
            card.querySelector(".avatar-icon").textContent = preset.icon;
            card.querySelector(".avatar-name").textContent = preset.shortName;
            card.title = preset.note;
            card.addEventListener("click", () => {
              window.location.href = "/?avatar=" + encodeURIComponent(preset.id);
            });
            els.avatarCards.append(card);
          });
        }

        function renderStateButtons() {
          els.stateButtons.innerHTML = "";
          statePresets.forEach((preset) => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "state-btn";
            button.innerHTML = "<span class='state-icon'></span><span></span>";
            button.querySelector(".state-icon").textContent = preset.icon;
            button.querySelector("span:last-child").textContent = preset.name;
            button.dataset.stateId = preset.id;
            button.addEventListener("click", () => applyPreset(preset.id));
            els.stateButtons.append(button);
          });
        }

        function renderSignals() {
          const signals = window.MAB_AVATAR_HUD_SIGNALS?.() || [];
          els.signals.innerHTML = "";
          signals.forEach((signal) => {
            const node = document.createElement("div");
            node.className =
              "signal-row level-" + signal.level + (signal.level === "idle" ? "" : " active");
            node.innerHTML = "<span class='signal-label'></span><span class='signal-value'></span>";
            node.querySelector(".signal-label").textContent = signal.label;
            node.querySelector(".signal-value").textContent = signal.value;
            els.signals.append(node);
          });
          return signals;
        }

        function applyPreset(id) {
          const preset = statePresets.find((candidate) => candidate.id === id) || statePresets[0];
          state.activeState = preset.id;
          window.MAB_REALTIME_BRIDGE = bridgeFromPreset(preset);
          window.MAB_AVATAR_CONTROLLER?.updateState?.({
            mood: preset.mood,
            action: preset.action,
            intensity: preset.intensity,
            status_kind: preset.statusKind,
            status_text: preset.statusText,
            status_hold_ms: 60000,
          });
          document.querySelectorAll("[data-state-id]").forEach((button) => {
            button.classList.toggle("active", button.dataset.stateId === preset.id);
          });
          const signals = renderSignals();
          els.readout.textContent =
            preset.description + "\\n" + signals.map((s) => s.label + "=" + s.value).join(" · ");
          return { preset, signals };
        }

        async function waitForReady() {
          const started = Date.now();
          while (Date.now() - started < 10000) {
            if (window.MAB_AVATAR_READY?.ok && window.MAB_AVATAR_CONTROLLER) return true;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          throw new Error("avatar_playground_runtime_not_ready");
        }

        async function attachPreview() {
          const stream = await navigator.mediaDevices.getUserMedia({ video: true });
          els.preview.srcObject = stream;
          await els.preview.play().catch(() => {});
        }

        window.MAB_AVATAR_PLAYGROUND = {
          state,
          avatarPresets,
          statePresets,
          applyPreset,
          getSignals: () => window.MAB_AVATAR_HUD_SIGNALS?.() || [],
        };

        (async () => {
          try {
            renderAvatarCards();
            renderStateButtons();
            await waitForReady();
            await window.MAB_AVATAR_START_RENDERER?.();
            await attachPreview();
            state.ready = true;
            els.boot.textContent = "ready";
            const renderer = window.MAB_AVATAR_RENDERER?.renderer || "runtime";
            els.rendererReadout.textContent = renderer;
            applyPreset("listening");
          } catch (error) {
            const message = String(error?.message || error);
            state.errors.push(message);
            els.boot.textContent = message;
            els.boot.style.color = "var(--red)";
          }
        })();
      })();
    </script>
  </body>
</html>`;
}

export function createAvatarPlaygroundServer(
  options: AvatarPlaygroundOptions = {},
): AvatarPlaygroundServer {
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url || "/", `http://${req.headers.host || DEFAULT_HOST}`);
      const avatarPreset = selectedAvatarPreset(url.searchParams.get("avatar"));
      if (req.method === "GET" && url.pathname === "/") {
        return htmlResponse(
          res,
          buildAvatarPlaygroundHtml({
            botName: options.botName || "Oneesama",
            selectedAvatarId: avatarPreset.id,
          }),
        );
      }
      if (req.method === "GET" && url.pathname === "/runtime/init.js") {
        return jsResponse(res, buildInitSource(options, avatarPreset));
      }
      if (req.method === "GET" && url.pathname.startsWith("/assets/avatar/")) {
        return assetResponse(res, url.pathname);
      }
      if (req.method === "GET" && url.pathname === "/runtime/status") {
        return jsonResponse(res, 200, {
          ok: true,
          avatars: AVATAR_PRESETS.map(({ id, name, note }) => ({ id, name, note })),
          states: STATE_PRESETS.map(({ id, name, description }) => ({ id, name, description })),
        });
      }
      return jsonResponse(res, 404, { ok: false, error: "not_found" });
    })().catch((error) => {
      jsonResponse(res, 500, { ok: false, error: String(error?.message || error) });
    });
  });

  return {
    server,
    async listen() {
      const host = options.host || DEFAULT_HOST;
      const port = Number(options.port ?? DEFAULT_PORT);
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      const address = server.address() as AddressInfo;
      const displayHost = host === "0.0.0.0" || host === "::" ? DEFAULT_HOST : host;
      return {
        host: displayHost,
        port: address.port,
        url: `http://${displayHost}:${address.port}/`,
      };
    },
    async close() {
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
