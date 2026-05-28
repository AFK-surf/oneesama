import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
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
  note: string;
  avatar: Partial<HiyoriAvatarConfig>;
};

type StatePreset = {
  id: string;
  name: string;
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

const AVATAR_PRESETS: AvatarPreset[] = [
  {
    id: "hiyori-live2d",
    name: "Hiyori Live2D",
    note: "Default Live2D renderer with network/CDN fallback.",
    avatar: { avatarRenderer: "live2d", disableLive2D: false },
  },
  {
    id: "fallback-canvas",
    name: "Fallback Canvas",
    note: "Deterministic canvas avatar for fast local iteration.",
    avatar: { avatarRenderer: "live2d", disableLive2D: true },
  },
  {
    id: "vrm-preview",
    name: "VRM Preview",
    note: "Experimental 3D/VRM renderer; falls back if WebGL/deps are unavailable.",
    avatar: { avatarRenderer: "vrm", disableLive2D: true },
  },
];

const STATE_PRESETS: StatePreset[] = [
  {
    id: "listening",
    name: "Listening",
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
        --bg: #0f1115;
        --panel: rgba(30, 34, 43, 0.82);
        --panel-strong: #191d25;
        --ink: #f3f6fb;
        --muted: #98a2b3;
        --line: rgba(255,255,255,0.12);
        --cyan: #4dd0e1;
        --green: #62d394;
        --amber: #f1c75b;
        --red: #ff6f8d;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        background:
          linear-gradient(135deg, rgba(77, 208, 225, 0.12), transparent 36%),
          repeating-linear-gradient(90deg, rgba(255,255,255,0.024) 0 1px, transparent 1px 96px),
          repeating-linear-gradient(0deg, rgba(255,255,255,0.018) 0 1px, transparent 1px 72px),
          var(--bg);
        color: var(--ink);
        font-family: "Avenir Next", "Helvetica Neue", system-ui, sans-serif;
      }
      main {
        display: grid;
        grid-template-columns: minmax(520px, 1.35fr) minmax(360px, 0.65fr);
        gap: 18px;
        width: min(1320px, calc(100vw - 32px));
        margin: 0 auto;
        padding: 18px 0;
      }
      header {
        grid-column: 1 / -1;
        display: flex;
        align-items: end;
        justify-content: space-between;
        gap: 16px;
        min-height: 64px;
      }
      h1 {
        margin: 0;
        font-size: 28px;
        letter-spacing: 0;
        line-height: 1.1;
      }
      .subtle { color: var(--muted); font-size: 13px; }
      .stage-wrap,
      .controls {
        border: 1px solid var(--line);
        background: var(--panel);
        backdrop-filter: blur(18px);
        border-radius: 8px;
      }
      .stage-wrap {
        padding: 12px;
        min-width: 0;
      }
      video {
        display: block;
        width: 100%;
        aspect-ratio: 16 / 9;
        border-radius: 6px;
        background: #f7f8fb;
        object-fit: contain;
      }
      .controls {
        display: grid;
        align-content: start;
        gap: 16px;
        padding: 16px;
      }
      .section-title {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        margin-bottom: 8px;
        gap: 12px;
      }
      .section-title h2 {
        margin: 0;
        font-size: 14px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .button-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
      }
      button,
      select {
        min-height: 38px;
        border: 1px solid var(--line);
        border-radius: 6px;
        background: var(--panel-strong);
        color: var(--ink);
        font: inherit;
      }
      button {
        cursor: pointer;
        padding: 8px 10px;
        font-weight: 700;
      }
      button.active {
        border-color: rgba(77, 208, 225, 0.72);
        box-shadow: inset 0 0 0 1px rgba(77, 208, 225, 0.34);
        color: #dffbff;
      }
      select {
        width: 100%;
        padding: 0 10px;
      }
      .signals {
        display: grid;
        grid-template-columns: repeat(5, minmax(0, 1fr));
        gap: 6px;
      }
      .signal {
        min-height: 58px;
        border: 1px solid var(--line);
        border-radius: 6px;
        padding: 8px;
        background: rgba(255,255,255,0.04);
      }
      .signal b {
        display: block;
        font-size: 11px;
        color: var(--muted);
        margin-bottom: 5px;
      }
      .signal span {
        font-size: 14px;
        font-weight: 800;
      }
      .level-ok span { color: var(--green); }
      .level-active span { color: var(--cyan); }
      .level-warn span { color: var(--amber); }
      .level-blocked span { color: var(--red); }
      .level-idle span { color: var(--muted); }
      .readout {
        min-height: 92px;
        border: 1px solid var(--line);
        border-radius: 6px;
        background: rgba(0,0,0,0.22);
        padding: 10px;
        color: #d9e2f2;
        font-size: 13px;
        line-height: 1.48;
      }
      @media (max-width: 940px) {
        main { grid-template-columns: 1fr; }
        header { align-items: start; flex-direction: column; }
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <div>
          <h1>${escapeHtml(input.botName)} Avatar Playground</h1>
          <div class="subtle">single-avatar runtime · HUD signal sandbox · no Meet required</div>
        </div>
        <div class="subtle" id="boot-status">starting</div>
      </header>
      <section class="stage-wrap">
        <video id="avatar-preview" autoplay muted playsinline></video>
      </section>
      <aside class="controls">
        <section>
          <div class="section-title">
            <h2>Avatar preset</h2>
            <span class="subtle" id="avatar-note"></span>
          </div>
          <select id="avatar-select" aria-label="Avatar preset"></select>
        </section>
        <section>
          <div class="section-title">
            <h2>State preset</h2>
            <span class="subtle">drives mood/action/HUD</span>
          </div>
          <div class="button-grid" id="state-buttons"></div>
        </section>
        <section>
          <div class="section-title">
            <h2>HUD signals</h2>
            <span class="subtle">RT / Audio / Voice / Tool / Err</span>
          </div>
          <div class="signals" id="signals"></div>
        </section>
        <section>
          <div class="section-title"><h2>Readout</h2></div>
          <div class="readout" id="readout"></div>
        </section>
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
          avatarSelect: document.getElementById("avatar-select"),
          avatarNote: document.getElementById("avatar-note"),
          stateButtons: document.getElementById("state-buttons"),
          signals: document.getElementById("signals"),
          readout: document.getElementById("readout"),
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
          return {
            connected: true,
            connection: {
              peerConnectionState: "connected",
              dataChannelReadyState: "open",
              currentRealtimeInputSource: preset.audioSource,
              responseEvents: preset.voice === "idle" ? 0 : 1,
            },
            protection: { outputAudioActive: preset.voice === "talk" },
            turnPolicy: { appControlJobs: toolJobs },
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

        function renderAvatarSelect() {
          els.avatarSelect.innerHTML = "";
          avatarPresets.forEach((preset) => {
            const option = document.createElement("option");
            option.value = preset.id;
            option.textContent = preset.name;
            option.selected = preset.id === selectedAvatarId;
            els.avatarSelect.append(option);
          });
          const selected = avatarPresets.find((preset) => preset.id === selectedAvatarId);
          els.avatarNote.textContent = selected?.note || "";
        }

        function renderStateButtons() {
          els.stateButtons.innerHTML = "";
          statePresets.forEach((preset) => {
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = preset.name;
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
            node.className = "signal level-" + signal.level;
            node.innerHTML = "<b></b><span></span>";
            node.querySelector("b").textContent = signal.label;
            node.querySelector("span").textContent = signal.value;
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

        els.avatarSelect.addEventListener("change", () => {
          const next = encodeURIComponent(els.avatarSelect.value);
          window.location.href = "/?avatar=" + next;
        });

        window.MAB_AVATAR_PLAYGROUND = {
          state,
          avatarPresets,
          statePresets,
          applyPreset,
          getSignals: () => window.MAB_AVATAR_HUD_SIGNALS?.() || [],
        };

        (async () => {
          try {
            renderAvatarSelect();
            renderStateButtons();
            await waitForReady();
            await window.MAB_AVATAR_START_RENDERER?.();
            await attachPreview();
            state.ready = true;
            els.boot.textContent = "ready";
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
