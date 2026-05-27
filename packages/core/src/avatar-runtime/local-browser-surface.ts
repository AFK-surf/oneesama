import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { HiyoriAvatarConfig, LocalDialogConfig } from "../browser-runtime-types.ts";
import {
  buildRuntimeStatusSnapshot,
  createRuntimeEvent,
  defaultRuntimeDiagnosticsConfig,
  validateRuntimeSessionConfig,
  type AvatarRuntimeSessionConfig,
  type ConversationTransport,
  type RuntimeEvent,
  type RuntimeHealth,
  type RuntimeInitScript,
} from "./contracts.ts";
import {
  buildAvatarRuntimeInitScripts,
  summarizeRuntimeInitScripts,
} from "./runtime-init-builder.ts";

export interface LocalBrowserTurnRequest {
  sessionId?: string;
  utterance?: string;
  context?: Record<string, unknown>;
  mode?: string;
  timeoutMs?: number;
}

export interface LocalBrowserTurnResponse {
  ok?: boolean;
  status?: string;
  provider?: string;
  responseText?: string;
  job?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface LocalBrowserSurfaceOptions {
  host?: string;
  port?: number;
  sessionId?: string;
  botName?: string;
  conversationTransport?: ConversationTransport;
  avatar?: Partial<HiyoriAvatarConfig>;
  localDialog?: Partial<LocalDialogConfig>;
  handleTurn?: (request: LocalBrowserTurnRequest) => Promise<LocalBrowserTurnResponse | string>;
}

export interface LocalBrowserSurfaceListenResult {
  host: string;
  port: number;
  url: string;
}

export interface LocalBrowserSurfaceServer {
  config: Readonly<AvatarRuntimeSessionConfig>;
  events: RuntimeEvent[];
  scripts: RuntimeInitScript[];
  server: Server;
  listen(): Promise<LocalBrowserSurfaceListenResult>;
  close(): Promise<void>;
  status(health?: RuntimeHealth): Record<string, unknown>;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 18911;

function normalizedSessionId(value: string | undefined) {
  const trimmed = String(value || "").trim();
  return trimmed || `local_browser_${randomUUID()}`;
}

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

async function readJsonBody(req: IncomingMessage) {
  let body = "";
  req.setEncoding("utf8");
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error("request_body_too_large");
  }
  return body ? JSON.parse(body) : {};
}

function defaultTurnResponse(request: LocalBrowserTurnRequest): LocalBrowserTurnResponse {
  const utterance = String(request.utterance || "").trim();
  const responseText = utterance ? `本地 Oneesama 已收到：${utterance}` : "本地 Oneesama 已启动。";
  return {
    ok: true,
    status: "completed",
    provider: "local-browser-mock",
    responseText,
    job: {
      id: `job_${Date.now().toString(36)}`,
      provider: "local-browser-mock",
      status: "completed",
      task: utterance,
      result: responseText,
    },
  };
}

export function buildLocalBrowserRuntimeSessionConfig(
  options: LocalBrowserSurfaceOptions = {},
): AvatarRuntimeSessionConfig {
  const sessionId = normalizedSessionId(options.sessionId);
  const botName = String(options.botName || "Oneesama").trim() || "Oneesama";
  return {
    sessionId,
    botName,
    surfaceKind: "local_browser",
    conversationTransport: options.conversationTransport || "mock",
    renderer: {
      surface: "local_browser",
      avatarRenderer: options.avatar?.avatarRenderer || "live2d",
    },
    conversation: {
      mode: "local_text_dialog",
      transport: options.conversationTransport || "mock",
    },
    inputPolicy: {
      audioInputs: ["synthetic"],
      textInputs: ["local_text"],
      continuousMic: false,
    },
    outputPolicy: {
      audioOutputs: ["avatar_bus_only"],
      videoOutputs: ["dom_canvas"],
      allowLocalSpeaker: false,
    },
    capabilities: [
      {
        name: "local_text_dialog",
        toolName: "local_text_dialog",
        description: "Local browser text input routed through the avatar dialog bridge",
        surfaceOnly: true,
        enabled: true,
      },
      {
        name: "avatar_preview",
        toolName: "avatar_preview",
        description: "Local browser preview of the avatar media track",
        surfaceOnly: true,
        enabled: true,
      },
    ],
    diagnostics: defaultRuntimeDiagnosticsConfig({
      defaultStatusView: "diagnostic",
      redactByDefault: true,
    }),
  };
}

function buildLocalBrowserInitScripts(
  config: Readonly<AvatarRuntimeSessionConfig>,
  options: LocalBrowserSurfaceOptions,
) {
  return buildAvatarRuntimeInitScripts({
    sessionId: config.sessionId,
    botName: config.botName,
    surfaceKind: config.surfaceKind,
    conversationTransport: config.conversationTransport,
    installAvatar: true,
    installRealtimeBridge: false,
    installLocalDialogBridge: true,
    installScreenShareBridge: false,
    installWorkerResultBridge: false,
    avatar: {
      avatarRenderer: "live2d",
      layout: "center",
      botName: config.botName,
      disableLive2D: false,
      canvasWidth: 1280,
      canvasHeight: 720,
      captureFps: 24,
      ...options.avatar,
    },
    localDialog: {
      enabled: true,
      botName: config.botName,
      sessionId: config.sessionId,
      turnUrl: "/dialog/turn",
      ttsMode: "tone",
      sttProvider: "local_text",
      ttsProvider: "browser-tone",
      ttsGain: 0.025,
      ...options.localDialog,
    },
  });
}

function buildRuntimeInitSource(scripts: RuntimeInitScript[]) {
  return [
    `(() => {
  if (typeof globalThis.__name !== "function") {
    Object.defineProperty(globalThis, "__name", {
      value: (fn) => fn,
      configurable: true,
    });
  }
})();`,
    ...scripts.map((script) => script.content),
  ].join("\n\n");
}

export function buildLocalBrowserSurfaceHtml(config: Readonly<AvatarRuntimeSessionConfig>) {
  const title = `${config.botName} Local Avatar`;
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <script src="/runtime/init.js"></script>
    <style>
      :root {
        color-scheme: light;
        --bg: #f5f7fb;
        --panel: #ffffff;
        --ink: #1d2433;
        --muted: #687083;
        --line: #d8dee9;
        --blue: #2f6df6;
        --green: #178f5f;
        --red: #b73535;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        background: var(--bg);
        color: var(--ink);
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      main {
        display: grid;
        grid-template-columns: minmax(320px, 1.15fr) minmax(320px, 0.85fr);
        gap: 20px;
        width: min(1180px, calc(100vw - 32px));
        margin: 0 auto;
        padding: 24px 0;
      }
      header {
        grid-column: 1 / -1;
        display: flex;
        align-items: flex-end;
        justify-content: space-between;
        gap: 16px;
      }
      h1 {
        margin: 0;
        font-size: 24px;
        line-height: 1.2;
        letter-spacing: 0;
      }
      .subtle { color: var(--muted); font-size: 13px; }
      .panel {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 16px;
      }
      .stage {
        display: grid;
        gap: 12px;
      }
      video {
        display: block;
        width: 100%;
        aspect-ratio: 16 / 9;
        border-radius: 8px;
        background: #e6ebf4;
        border: 1px solid var(--line);
        object-fit: contain;
      }
      .status-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 8px;
      }
      .pill {
        border: 1px solid var(--line);
        border-radius: 6px;
        padding: 8px 10px;
        background: #fbfcff;
        min-height: 54px;
      }
      .pill strong {
        display: block;
        margin-bottom: 4px;
        font-size: 12px;
        color: var(--muted);
        font-weight: 600;
      }
      .pill span { font-size: 13px; }
      form {
        display: grid;
        gap: 10px;
      }
      textarea {
        width: 100%;
        min-height: 110px;
        resize: vertical;
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 12px;
        font: inherit;
        line-height: 1.45;
      }
      button {
        width: fit-content;
        border: 0;
        border-radius: 6px;
        background: var(--blue);
        color: white;
        padding: 9px 14px;
        font: inherit;
        font-weight: 650;
        cursor: pointer;
      }
      button:disabled { opacity: 0.55; cursor: not-allowed; }
      .transcript {
        display: grid;
        gap: 10px;
        margin-top: 14px;
        max-height: 360px;
        overflow: auto;
      }
      .turn {
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 10px;
        background: #fbfcff;
      }
      .turn b {
        display: block;
        margin-bottom: 4px;
        font-size: 12px;
        color: var(--muted);
      }
      .ok { color: var(--green); }
      .bad { color: var(--red); }
      @media (max-width: 860px) {
        main { grid-template-columns: 1fr; }
        header { align-items: flex-start; flex-direction: column; }
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <div>
          <h1>${escapeHtml(config.botName)} Local Avatar Surface</h1>
          <div class="subtle">surface=local_browser · transport=${escapeHtml(config.conversationTransport)} · no Meet required</div>
        </div>
        <div class="subtle" id="boot-status">starting</div>
      </header>
      <section class="panel stage">
        <video id="avatar-preview" autoplay muted playsinline></video>
        <div class="status-grid">
          <div class="pill"><strong>Runtime</strong><span id="runtime-status">starting</span></div>
          <div class="pill"><strong>Input</strong><span>local text</span></div>
          <div class="pill"><strong>Output</strong><span>avatar bus only</span></div>
        </div>
      </section>
      <section class="panel">
        <form id="dialog-form">
          <label class="subtle" for="utterance">Text turn</label>
          <textarea id="utterance" placeholder="跟 Oneesama 说一句话"></textarea>
          <button id="send" type="submit" disabled>Send</button>
        </form>
        <div class="transcript" id="transcript" aria-live="polite"></div>
      </section>
    </main>
    <script>
      (() => {
        const state = {
          ready: false,
          turns: [],
          lastResult: null,
          errors: [],
        };
        const bootStatus = document.getElementById("boot-status");
        const runtimeStatus = document.getElementById("runtime-status");
        const sendButton = document.getElementById("send");
        const utteranceInput = document.getElementById("utterance");
        const transcript = document.getElementById("transcript");
        const preview = document.getElementById("avatar-preview");

        function setStatus(text, ok = true) {
          bootStatus.textContent = text;
          bootStatus.className = ok ? "subtle ok" : "subtle bad";
          runtimeStatus.textContent = text;
          runtimeStatus.className = ok ? "ok" : "bad";
        }

        function appendTurn(role, text) {
          const node = document.createElement("div");
          node.className = "turn";
          node.innerHTML = "<b></b><span></span>";
          node.querySelector("b").textContent = role;
          node.querySelector("span").textContent = text || "";
          transcript.prepend(node);
        }

        async function waitForReady() {
          const started = Date.now();
          while (Date.now() - started < 10000) {
            if (window.MAB_AVATAR_READY?.ok && window.MAB_LOCAL_DIALOG_CONTROLLER?.sendUtterance) {
              return window.MAB_AVATAR_READY;
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          throw new Error("local_avatar_runtime_not_ready");
        }

        async function attachPreview() {
          const stream = await navigator.mediaDevices.getUserMedia({ video: true });
          preview.srcObject = stream;
          await preview.play().catch(() => {});
          return stream;
        }

        async function sendText(text) {
          const utterance = String(text || "").trim();
          if (!utterance) return { ok: false, error: "empty_utterance" };
          sendButton.disabled = true;
          appendTurn("You", utterance);
          const result = await window.MAB_LOCAL_DIALOG_CONTROLLER.sendUtterance({
            text: utterance,
            source: "local_browser_text",
            context: { surfaceKind: "local_browser" },
          });
          state.lastResult = result;
          state.turns.push(result);
          const turn = result?.turn || {};
          appendTurn("${escapeHtml(config.botName)}", turn.responseText || result?.response?.responseText || "");
          sendButton.disabled = false;
          return result;
        }

        window.MAB_LOCAL_BROWSER_SURFACE = {
          state,
          sendText,
          attachPreview,
        };

        document.getElementById("dialog-form").addEventListener("submit", async (event) => {
          event.preventDefault();
          try {
            const value = utteranceInput.value;
            utteranceInput.value = "";
            await sendText(value);
          } catch (error) {
            state.errors.push(String(error?.message || error));
            setStatus(String(error?.message || error), false);
          }
        });

        (async () => {
          try {
            await waitForReady();
            await window.MAB_AVATAR_START_RENDERER?.();
            await attachPreview();
            state.ready = true;
            sendButton.disabled = false;
            setStatus("ready");
          } catch (error) {
            state.errors.push(String(error?.message || error));
            setStatus(String(error?.message || error), false);
          }
        })();
      })();
    </script>
  </body>
</html>`;
}

function runtimeStatusBody(
  config: Readonly<AvatarRuntimeSessionConfig>,
  scripts: RuntimeInitScript[],
  events: RuntimeEvent[],
  health: RuntimeHealth,
) {
  return {
    ok: health !== "failed",
    snapshot: buildRuntimeStatusSnapshot({
      config,
      health,
      events,
      warnings: [],
      errors: [],
    }),
    inputPolicy: config.inputPolicy,
    outputPolicy: config.outputPolicy,
    initScripts: summarizeRuntimeInitScripts(scripts),
  };
}

export function createLocalBrowserSurfaceServer(
  options: LocalBrowserSurfaceOptions = {},
): LocalBrowserSurfaceServer {
  const rawConfig = buildLocalBrowserRuntimeSessionConfig(options);
  const validation = validateRuntimeSessionConfig(rawConfig);
  if (!validation.ok || !validation.config) {
    throw new Error(`local_browser runtime config invalid: ${validation.errors.join("; ")}`);
  }
  const config = validation.config;
  const scripts = buildLocalBrowserInitScripts(config, options);
  const events = [...validation.events, ...scripts.map((script) => script.event)];
  const initSource = buildRuntimeInitSource(scripts);
  const html = buildLocalBrowserSurfaceHtml(config);
  let health: RuntimeHealth = "ready";

  async function handleTurn(req: IncomingMessage, res: ServerResponse) {
    const request = (await readJsonBody(req)) as LocalBrowserTurnRequest;
    const response = options.handleTurn
      ? await options.handleTurn(request)
      : defaultTurnResponse(request);
    const body =
      typeof response === "string"
        ? {
            ...defaultTurnResponse(request),
            responseText: response,
          }
        : {
            ...defaultTurnResponse(request),
            ...response,
          };
    events.push(
      createRuntimeEvent(config, {
        phase: "tool",
        event: "local_browser_dialog_turn_completed",
        severity: "info",
        summary: "Local browser dialog turn completed",
        detail: {
          provider: body.provider,
          status: body.status,
          utteranceLength: String(request.utterance || "").length,
          responseLength: String(body.responseText || "").length,
        },
        redaction: "summarized",
      }),
    );
    jsonResponse(res, body.ok === false ? 500 : 200, body);
  }

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
      if (req.method === "GET" && url.pathname === "/") return htmlResponse(res, html);
      if (req.method === "GET" && url.pathname === "/runtime/init.js") {
        return jsResponse(res, initSource);
      }
      if (req.method === "GET" && url.pathname === "/runtime/status") {
        return jsonResponse(res, 200, runtimeStatusBody(config, scripts, events, health));
      }
      if (req.method === "POST" && url.pathname === "/dialog/turn") {
        return await handleTurn(req, res);
      }
      jsonResponse(res, 404, { ok: false, error: "not_found" });
    })().catch((error) => {
      health = "failed";
      events.push(
        createRuntimeEvent(config, {
          phase: "init",
          event: "local_browser_surface_request_failed",
          severity: "error",
          summary: "Local browser surface request failed",
          detail: { error: String(error?.message || error) },
          redaction: "summarized",
        }),
      );
      jsonResponse(res, 500, { ok: false, error: String(error?.message || error) });
    });
  });

  return {
    config,
    events,
    scripts,
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
      const displayHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
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
    status(nextHealth: RuntimeHealth = health) {
      return runtimeStatusBody(config, scripts, events, nextHealth);
    },
  };
}
