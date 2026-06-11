import type { AvatarRuntimeSessionConfig } from "../avatar-runtime/contracts.ts";
import { buildAvatarInitScript } from "../avatar/init-script-builder.ts";
import {
  lanOperatorAvatarPreset,
  lanOperatorAvatarPresetConfig,
  normalizeLanOperatorAvatarPreset,
} from "./lan-operator-avatar-presets.ts";
import { buildLanOperatorWebSocketClientScript } from "./lan-operator-websocket-client.ts";

export interface HostVisualPublisherPageOptions {
  sourceId?: string;
  label?: string;
  kind?: string;
  diagnostic?: boolean;
  avatar?: boolean;
  avatarPreset?: string;
  avatarRenderer?: string;
  /** Chrome-less render for embedding in another surface (hides header/controls/status). */
  embed?: boolean;
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildLanOperatorHostVisualPublisherHtml(
  config: Readonly<AvatarRuntimeSessionConfig>,
  options: HostVisualPublisherPageOptions = {},
) {
  const renderer = (config.renderer || {}) as { webrtcIceServers?: unknown };
  const webrtcIceServers = Array.isArray(renderer.webrtcIceServers)
    ? renderer.webrtcIceServers
    : [];
  const avatarPresetId = normalizeLanOperatorAvatarPreset(
    options.avatarPreset || options.avatarRenderer,
  );
  const avatarPreset = lanOperatorAvatarPreset(avatarPresetId);
  const boot = JSON.stringify({
    sessionId: config.sessionId,
    webrtcIceServers,
    source: {
      id: String(options.sourceId || "host-app"),
      label: String(options.label || "App view"),
      kind: String(options.kind || "desktop_app"),
    },
    diagnostic: Boolean(options.diagnostic),
    avatar: Boolean(options.avatar),
    avatarPreset: avatarPreset.id,
    avatarPresetName: avatarPreset.name,
    avatarRenderer: avatarPreset.renderer,
  });
  const avatarInitScript = options.avatar
    ? buildAvatarInitScript({
        layout: "center",
        canvasWidth: 1280,
        canvasHeight: 720,
        captureFps: 30,
        enableVisualTestHooks: true,
        allowIframe: true,
        ...lanOperatorAvatarPresetConfig(avatarPreset.id),
      })
    : "";
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(config.botName)} Host Visual Publisher</title>
    <style>
      * { box-sizing: border-box; }
      body {
        margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f7f8fb;
        color: #172033; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      main { width: min(720px, calc(100vw - 32px)); border: 1px solid #d8dee8; border-radius: 8px; background: #fff; overflow: hidden; }
      header { padding: 14px 16px; border-bottom: 1px solid #d8dee8; }
      h1 { margin: 0; font-size: 18px; letter-spacing: 0; }
      .body { display: grid; gap: 12px; padding: 16px; }
      .actions { display: flex; gap: 8px; flex-wrap: wrap; }
      button { min-height: 34px; border: 1px solid #d8dee8; border-radius: 6px; background: #fff; padding: 6px 10px; font: inherit; cursor: pointer; }
      button.primary { border-color: #0f766e; background: #0f766e; color: #fff; }
      video, canvas { width: 100%; aspect-ratio: 16 / 9; border: 1px solid #c6cfdd; border-radius: 8px; background: #0f172a; }
      pre { margin: 0; padding: 10px; border-radius: 7px; background: #0f172a; color: #e2e8f0; overflow: auto; font-size: 12px; }
      /* Chrome-less embed: just the live render, filling the frame. */
      body[data-embed] { display: block; background: #0f172a; }
      body[data-embed] main { width: 100%; min-height: 100vh; border: 0; border-radius: 0; }
      body[data-embed] header, body[data-embed] .actions, body[data-embed] #status { display: none; }
      body[data-embed] .body { padding: 0; gap: 0; height: 100vh; }
      body[data-embed] video, body[data-embed] canvas { height: 100vh; aspect-ratio: auto; border: 0; border-radius: 0; object-fit: contain; }
    </style>
  </head>
  <body${options.embed ? " data-embed" : ""}>
    <main>
      <header>
        <h1>${escapeHtml(config.botName)} Host Visual Publisher</h1>
      </header>
      <div class="body">
        <div class="actions">
          <button class="primary" id="share-display" type="button">Share Display</button>
          <button id="diagnostic-canvas" type="button">Diagnostic Canvas</button>
          <button id="avatar-renderer" type="button">Avatar Renderer</button>
        </div>
        <video id="preview" autoplay muted playsinline></video>
        <canvas id="diagnostic" width="1280" height="720" hidden></canvas>
        <pre id="status">{}</pre>
      </div>
    </main>
    <script>${buildLanOperatorWebSocketClientScript()}</script>
    ${options.avatar ? `<script>${avatarInitScript}</script>` : ""}
    <script>
      (() => {
        const boot = ${boot};
        const statusNode = document.getElementById("status");
        const preview = document.getElementById("preview");
        const diagnosticCanvas = document.getElementById("diagnostic");
        const diagnosticCtx = diagnosticCanvas.getContext("2d");
        const state = {
          sessionId: boot.sessionId,
          source: boot.source,
          webrtcIceServers: Array.isArray(boot.webrtcIceServers) ? boot.webrtcIceServers : [],
          websocketState: "closed",
          peerConnectionState: "new",
          iceConnectionState: "new",
          signalingState: "stable",
          streamId: null,
          trackId: null,
          trackReadyState: null,
          errors: [],
          sourceMode: boot.avatar ? "avatar_renderer" : boot.diagnostic ? "diagnostic_canvas" : "display_capture",
          requestedAvatarRenderer: boot.avatarRenderer,
          captureStatus: "idle",
          captureError: null,
          captureAttemptCount: 0,
          captureLastAttemptAt: null,
          captureLastSuccessAt: null,
          captureLastErrorAt: null,
          requestedAvatarPreset: boot.avatarPreset,
          displaySurface: null,
          trackLabel: null,
          avatarRenderer: null,
          avatarPreset: boot.avatarPreset,
          avatarFallbackReason: null,
          avatarReady: false,
        };
        let hostVisualSocketClient = null;
        let pc = null;
        let currentStream = null;
        let republishPromise = null;
        let diagnosticAnimation = null;

        function syncStatus() {
          statusNode.textContent = JSON.stringify(state, null, 2);
        }

        function send(message) {
          return hostVisualSocketClient?.send(message) || false;
        }

        function sourceMetadata() {
          return {
            ...boot.source,
            sourceMode: state.sourceMode,
            captureStatus: state.captureStatus,
            captureError: state.captureError,
            captureAttemptCount: state.captureAttemptCount,
            captureLastAttemptAt: state.captureLastAttemptAt,
            captureLastSuccessAt: state.captureLastSuccessAt,
            captureLastErrorAt: state.captureLastErrorAt,
            displaySurface: state.displaySurface,
            trackLabel: state.trackLabel,
            avatarRenderer: state.avatarRenderer,
            avatarPreset: state.avatarPreset,
            requestedAvatarPreset: state.requestedAvatarPreset,
            requestedAvatarRenderer: state.requestedAvatarRenderer,
            avatarFallbackReason: state.avatarFallbackReason,
            avatarReady: state.avatarReady,
          };
        }

        function connectWebSocket() {
          if (hostVisualSocketClient?.socket()?.readyState === WebSocket.OPEN) {
            return hostVisualSocketClient.socket();
          }
          if (!hostVisualSocketClient) {
            hostVisualSocketClient = window.MAB_LAN_OPERATOR_WEBSOCKET.create({
              state,
              label: "hostVisual",
              path: "/host/visual/ws",
              onState: (connection) => { state.websocketState = connection.state; },
              onOpen: () => {
                send({ type: "host_visual_publisher_ready", source: sourceMetadata() });
                if (currentStream) {
                  void publishCurrentStream("websocket_reconnected").catch((error) => {
                    state.errors.push(String(error?.message || error));
                    syncStatus();
                  });
                }
              },
              onError: () => {
                state.errors.push("host_visual_websocket_error");
                syncStatus();
              },
              onMessage: (payload) => {
                void handleMessage(payload).catch((error) => {
                  state.errors.push(String(error?.message || error));
                  syncStatus();
                });
              },
              syncDebug: syncStatus,
            });
          }
          hostVisualSocketClient.connect();
          syncStatus();
          return hostVisualSocketClient.socket();
        }

        async function handleMessage(payload) {
          const sourceId = String(payload.sourceId || payload.source?.id || boot.source.id || "");
          if (sourceId && sourceId !== boot.source.id) return;
          if (payload.type === "operator_visual_receiver_ready" && currentStream) {
            await publishCurrentStream("operator_receiver_ready");
            return;
          }
          if (payload.type === "operator_visual_answer" && pc) {
            await pc.setRemoteDescription(payload.description);
          }
          if (payload.type === "operator_visual_ice_candidate" && pc && payload.candidate) {
            await pc.addIceCandidate(payload.candidate);
          }
          syncStatus();
        }

        function waitForWebSocketOpen() {
          connectWebSocket();
          if (hostVisualSocketClient.state().state === "open") return Promise.resolve();
          return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
              clearInterval(timer);
              reject(new Error("host_visual_websocket_timeout"));
            }, 3000);
            const timer = setInterval(() => {
              const connection = hostVisualSocketClient.state();
              if (connection.state === "open") {
                clearInterval(timer);
                clearTimeout(timeout);
                resolve();
              }
              if (connection.state === "failed") {
                clearInterval(timer);
                clearTimeout(timeout);
                reject(new Error(connection.lastError || "host_visual_websocket_error"));
              }
            }, 25);
          });
        }

        function updatePeerState() {
          if (!pc) return;
          state.peerConnectionState = pc.connectionState;
          state.iceConnectionState = pc.iceConnectionState;
          state.signalingState = pc.signalingState;
          syncStatus();
        }

        async function publishCurrentStream(reason) {
          if (!currentStream) throw new Error("host_visual_stream_missing");
          if (republishPromise) return await republishPromise;
          republishPromise = (async () => {
            connectWebSocket();
            await waitForWebSocketOpen();
            preview.srcObject = currentStream;
            await preview.play().catch(() => {});
            const [track] = currentStream.getVideoTracks();
            const settings = track?.getSettings?.() || {};
            state.streamId = currentStream.id;
            state.trackId = track?.id || null;
            state.trackReadyState = track?.readyState || null;
            state.trackLabel = track?.label || null;
            state.displaySurface = settings.displaySurface || null;
            state.captureStatus = "live";
            state.captureError = null;
            state.captureLastSuccessAt = new Date().toISOString();
            track?.addEventListener?.("ended", () => {
              state.trackReadyState = track.readyState;
              state.captureStatus = "stopped";
              send({ type: "host_visual_publisher_ready", source: sourceMetadata(), reason: "track_ended" });
              syncStatus();
            });
            pc?.close?.();
            pc = new RTCPeerConnection({ iceServers: Array.isArray(boot.webrtcIceServers) ? boot.webrtcIceServers : [] });
            pc.addEventListener("icecandidate", (event) => {
              if (event.candidate) {
                send({
                  type: "host_visual_ice_candidate",
                  sourceId: boot.source.id,
                  candidate: event.candidate,
                });
              }
            });
            pc.addEventListener("connectionstatechange", updatePeerState);
            pc.addEventListener("iceconnectionstatechange", updatePeerState);
            pc.addEventListener("signalingstatechange", updatePeerState);
            for (const videoTrack of currentStream.getVideoTracks()) pc.addTrack(videoTrack, currentStream);
            send({ type: "host_visual_publisher_ready", source: sourceMetadata(), reason });
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            send({
              type: "host_visual_offer",
              sourceId: boot.source.id,
              source: sourceMetadata(),
              description: pc.localDescription,
              reason,
            });
            updatePeerState();
            return { ok: true, streamId: currentStream.id, trackId: state.trackId, reason };
          })();
          try {
            return await republishPromise;
          } finally {
            republishPromise = null;
          }
        }

        async function publishStream(stream) {
          currentStream = stream;
          return await publishCurrentStream("operator_requested");
        }

        async function startDisplayCapture() {
          state.sourceMode = "display_capture";
          state.captureStatus = "requesting";
          state.captureError = null;
          state.captureAttemptCount += 1;
          state.captureLastAttemptAt = new Date().toISOString();
          send({ type: "host_visual_publisher_ready", source: sourceMetadata(), reason: "display_capture_requesting" });
          syncStatus();
          try {
            const stream = await navigator.mediaDevices.getDisplayMedia({
              video: true,
              audio: false,
            });
            return await publishStream(stream);
          } catch (error) {
            state.captureStatus = "failed";
            state.captureError = String(error?.name ? error.name + ": " + (error?.message || error.name) : error?.message || error);
            state.captureLastErrorAt = new Date().toISOString();
            send({ type: "host_visual_publisher_ready", source: sourceMetadata(), reason: "display_capture_failed" });
            syncStatus();
            throw error;
          }
        }

        function drawDiagnosticFrame() {
          const now = Date.now();
          const x = (now / 20) % diagnosticCanvas.width;
          diagnosticCtx.fillStyle = "#0f172a";
          diagnosticCtx.fillRect(0, 0, diagnosticCanvas.width, diagnosticCanvas.height);
          diagnosticCtx.fillStyle = boot.source.id === "avatar" ? "#7c3aed" : "#0f766e";
          diagnosticCtx.fillRect(0, 0, x, diagnosticCanvas.height);
          diagnosticCtx.fillStyle = "#e2e8f0";
          diagnosticCtx.font = "700 42px system-ui, sans-serif";
          diagnosticCtx.fillText(String(boot.source.label || "Host Visual Stream"), 56, 86);
          diagnosticCtx.font = "24px system-ui, sans-serif";
          diagnosticCtx.fillText(String(boot.source.kind || "desktop_app") + " / " + new Date(now).toISOString(), 56, 132);
          diagnosticAnimation = requestAnimationFrame(drawDiagnosticFrame);
        }

        async function startDiagnosticCanvas() {
          diagnosticCanvas.hidden = false;
          if (!diagnosticAnimation) drawDiagnosticFrame();
          const stream = diagnosticCanvas.captureStream(30);
          state.sourceMode = "diagnostic_canvas";
          state.displaySurface = null;
          state.captureError = null;
          return await publishStream(stream);
        }

        async function waitForAvatarReady() {
          const started = Date.now();
          while (Date.now() - started < 10000) {
            if (window.MAB_AVATAR_READY?.ok && window.MAB_AVATAR_MEDIA) return window.MAB_AVATAR_READY;
            if (window.MAB_AVATAR_READY?.ok === false) throw new Error(window.MAB_AVATAR_READY.error || "avatar_renderer_failed");
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          throw new Error("avatar_renderer_timeout");
        }

        async function startAvatarRenderer() {
          if (!boot.avatar) throw new Error("avatar_renderer_not_enabled");
          const ready = await waitForAvatarReady();
          await window.MAB_AVATAR_START_RENDERER?.();
          const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
          state.avatarRenderer = window.MAB_AVATAR_RENDERER?.renderer || ready.rendererMode || "avatar";
          state.avatarPreset = boot.avatarPreset;
          state.avatarFallbackReason = window.MAB_AVATAR_RENDERER?.fallbackReason || ready.fallbackReason || null;
          state.avatarReady = true;
          state.sourceMode = "avatar_renderer";
          state.displaySurface = null;
          state.captureError = null;
          return await publishStream(stream);
        }

        document.getElementById("share-display").addEventListener("click", () => {
          void startDisplayCapture().catch((error) => {
            state.errors.push(String(error?.message || error));
            syncStatus();
          });
        });
        document.getElementById("diagnostic-canvas").addEventListener("click", () => {
          void startDiagnosticCanvas().catch((error) => {
            state.errors.push(String(error?.message || error));
            syncStatus();
          });
        });
        document.getElementById("avatar-renderer").addEventListener("click", () => {
          void startAvatarRenderer().catch((error) => {
            state.errors.push(String(error?.message || error));
            syncStatus();
          });
        });

        connectWebSocket();
        syncStatus();
        window.MAB_LAN_HOST_VISUAL_PUBLISHER = {
          state,
          publishStream,
          startDisplayCapture,
          startDiagnosticCanvas,
          startAvatarRenderer,
          forceCloseTransport: () => hostVisualSocketClient?.socket()?.close(),
        };
        if (boot.avatar) {
          void startAvatarRenderer().catch((error) => {
            state.errors.push(String(error?.message || error));
            syncStatus();
          });
        } else if (boot.diagnostic) {
          void startDiagnosticCanvas().catch((error) => {
            state.errors.push(String(error?.message || error));
            syncStatus();
          });
        }
      })();
    </script>
  </body>
</html>`;
}
