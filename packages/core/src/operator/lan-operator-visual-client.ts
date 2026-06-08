export function buildLanOperatorVisualClientScript() {
  return `
(() => {
  function ensureSource(state, source) {
    const sourceId = String(source?.id || "host-app");
    let entry = state.sources.find((item) => item.id === sourceId);
    if (!entry) {
      entry = {
        id: sourceId,
        label: String(source?.label || sourceId),
        kind: String(source?.kind || "desktop_app"),
        state: "connecting",
      };
      state.sources.push(entry);
    }
    entry.label = String(source?.label || entry.label || sourceId);
    entry.kind = String(source?.kind || entry.kind || "desktop_app");
    entry.state = String(source?.state || entry.state || "connecting");
    if (source && Object.prototype.hasOwnProperty.call(source, "sourceMode")) {
      entry.sourceMode = source.sourceMode ? String(source.sourceMode) : null;
    }
    if (source && Object.prototype.hasOwnProperty.call(source, "captureStatus")) {
      entry.captureStatus = source.captureStatus ? String(source.captureStatus) : null;
    }
    if (source && Object.prototype.hasOwnProperty.call(source, "captureError")) {
      entry.captureError = source.captureError ? String(source.captureError) : null;
    }
    if (source && Object.prototype.hasOwnProperty.call(source, "captureAttemptCount")) {
      entry.captureAttemptCount = Number(source.captureAttemptCount || 0) || 0;
    }
    if (source && Object.prototype.hasOwnProperty.call(source, "captureLastAttemptAt")) {
      entry.captureLastAttemptAt = source.captureLastAttemptAt ? String(source.captureLastAttemptAt) : null;
    }
    if (source && Object.prototype.hasOwnProperty.call(source, "captureLastSuccessAt")) {
      entry.captureLastSuccessAt = source.captureLastSuccessAt ? String(source.captureLastSuccessAt) : null;
    }
    if (source && Object.prototype.hasOwnProperty.call(source, "captureLastErrorAt")) {
      entry.captureLastErrorAt = source.captureLastErrorAt ? String(source.captureLastErrorAt) : null;
    }
    if (source && Object.prototype.hasOwnProperty.call(source, "displaySurface")) {
      entry.displaySurface = source.displaySurface ? String(source.displaySurface) : null;
    }
    if (source && Object.prototype.hasOwnProperty.call(source, "trackLabel")) {
      entry.trackLabel = source.trackLabel ? String(source.trackLabel) : null;
    }
    if (source && Object.prototype.hasOwnProperty.call(source, "avatarRenderer")) {
      entry.avatarRenderer = source.avatarRenderer ? String(source.avatarRenderer) : null;
    }
    if (source && Object.prototype.hasOwnProperty.call(source, "avatarPreset")) {
      entry.avatarPreset = source.avatarPreset ? String(source.avatarPreset) : null;
    }
    if (source && Object.prototype.hasOwnProperty.call(source, "requestedAvatarPreset")) {
      entry.requestedAvatarPreset = source.requestedAvatarPreset
        ? String(source.requestedAvatarPreset)
        : null;
    }
    if (source && Object.prototype.hasOwnProperty.call(source, "requestedAvatarRenderer")) {
      entry.requestedAvatarRenderer = source.requestedAvatarRenderer
        ? String(source.requestedAvatarRenderer)
        : null;
    }
    if (source && Object.prototype.hasOwnProperty.call(source, "avatarFallbackReason")) {
      entry.avatarFallbackReason = source.avatarFallbackReason
        ? String(source.avatarFallbackReason)
        : null;
    }
    if (source && Object.prototype.hasOwnProperty.call(source, "avatarReady")) {
      entry.avatarReady = source.avatarReady == null ? null : Boolean(source.avatarReady);
    }
    return entry;
  }

  function createMetrics() {
    return {
      renderedFrameCount: 0,
      frameSampleCount: 0,
      frameSampleStartedAt: 0,
      frameRate: 0,
      lastFrameAt: null,
      lastFrameEpochMs: 0,
      width: null,
      height: null,
      streamId: null,
      trackId: null,
      trackReadyState: null,
    };
  }

  window.MAB_LAN_OPERATOR_VISUAL_RECEIVER = {
    create(input) {
      const state = input.state;
      const peers = new Map();
      const videos = new Map();
      const metrics = new Map();
      let ws = null;
      let reconnectTimer = null;

      state.visual = state.visual || {};
      state.transport = state.transport || {};
      state.transport.visual = {
        ...window.MAB_LAN_OPERATOR_WEBSOCKET.defaultConnection(),
        ...(state.transport.visual || {}),
      };
      state.visual.receiverWebSocketState = "closed";
      state.visual.hostPublisherConnections = 0;
      state.visual.connectionState = "not_connected";
      state.visual.iceConnectionState = null;
      state.visual.peerConnectionState = null;
      state.visual.signalingState = null;
      state.visual.trackCount = 0;

      function send(message) {
        if (!ws || ws.readyState !== WebSocket.OPEN) return false;
        ws.send(JSON.stringify({ sessionId: state.sessionId, ...message }));
        return true;
      }

      function patchTransport(patch = {}) {
        Object.assign(state.transport.visual, patch);
        input.sendOperatorEvent?.({
          type: "operator_connection_state",
          label: "visual",
          connection: state.transport.visual,
        });
        input.syncDebug?.();
      }

      function metricFor(sourceId) {
        if (!metrics.has(sourceId)) metrics.set(sourceId, createMetrics());
        return metrics.get(sourceId);
      }

      function receiverVideoHost() {
        let host = document.getElementById("lan-operator-receiver-videos");
        if (!host) {
          host = document.createElement("div");
          host.id = "lan-operator-receiver-videos";
          host.setAttribute("aria-hidden", "true");
          Object.assign(host.style, {
            position: "fixed",
            left: "-9999px",
            top: "0",
            width: "1px",
            height: "1px",
            overflow: "hidden",
            pointerEvents: "none",
            opacity: "0",
          });
          document.body.appendChild(host);
        }
        return host;
      }

      function disposeSourceVideo(sourceId) {
        const existing = videos.get(sourceId);
        if (!existing) return;
        existing.srcObject = null;
        existing.remove();
        videos.delete(sourceId);
      }

      function updateSource(sourceId, update = {}) {
        const entry = ensureSource(state, { id: sourceId, ...update });
        const metric = metricFor(sourceId);
        entry.streamId = metric.streamId;
        entry.trackId = metric.trackId;
        entry.trackReadyState = metric.trackReadyState;
        entry.width = metric.width;
        entry.height = metric.height;
        entry.frameRate = metric.frameRate ? Math.round(metric.frameRate * 10) / 10 : null;
        entry.frameAgeMs = metric.lastFrameEpochMs
          ? Math.max(0, Math.round(performance.now() - metric.lastFrameEpochMs))
          : null;
        entry.lastFrameAt = metric.lastFrameAt;
        input.renderSourceControls?.();
        input.syncDebug?.();
        return entry;
      }

      function currentVisualState() {
        const now = performance.now();
        for (const source of state.sources) {
          const metric = metricFor(source.id);
          source.frameAgeMs = metric.lastFrameEpochMs
            ? Math.max(0, Math.round(now - metric.lastFrameEpochMs))
            : source.frameAgeMs || null;
        }
        const liveSourceCount = state.sources.filter((source) => source.streamId || source.state === "live").length;
        const hostPublisherConnections = Math.max(state.visual.hostPublisherConnections, liveSourceCount);
        const trackCount = videos.size;
        state.visual.hostPublisherConnections = hostPublisherConnections;
        state.visual.trackCount = trackCount;
        return {
          transport: "webrtc",
          connectionState: state.visual.connectionState,
          iceConnectionState: state.visual.iceConnectionState,
          peerConnectionState: state.visual.peerConnectionState,
          signalingState: state.visual.signalingState,
          receiverWebSocketState: state.visual.receiverWebSocketState,
          hostPublisherConnections,
          trackCount,
          reconnectCount: state.transport.visual.reconnectCount,
          lastPacketAt: state.transport.visual.lastPacketAt,
          sources: state.sources,
        };
      }

      function emitVisualState() {
        input.sendOperatorEvent?.({ type: "host_visual_stream_state", visual: currentVisualState() });
      }

      function setPeerState(pc) {
        state.visual.iceConnectionState = pc.iceConnectionState;
        state.visual.peerConnectionState = pc.connectionState;
        state.visual.signalingState = pc.signalingState;
        state.visual.connectionState =
          videos.size > 0
            ? "connected"
            : ws?.readyState === WebSocket.OPEN
              ? "connecting"
              : "not_connected";
        emitVisualState();
        input.syncDebug?.();
      }

      function sourceVideo(sourceId) {
        return videos.get(sourceId) || null;
      }

      function noteSourceRendered(sourceId, video, frameMetadata = null) {
        const metric = metricFor(sourceId);
        const now = performance.now();
        if (!metric.frameSampleStartedAt || now - metric.frameSampleStartedAt > 1000) {
          if (metric.frameSampleStartedAt) {
            metric.frameRate = (metric.frameSampleCount * 1000) / (now - metric.frameSampleStartedAt);
          }
          metric.frameSampleStartedAt = now;
          metric.frameSampleCount = 0;
        }
        metric.renderedFrameCount += 1;
        metric.frameSampleCount += 1;
        if (metric.frameSampleStartedAt && now > metric.frameSampleStartedAt) {
          metric.frameRate = (metric.frameSampleCount * 1000) / (now - metric.frameSampleStartedAt);
        }
        metric.lastFrameAt = new Date().toISOString();
        metric.lastFrameEpochMs = now;
        metric.width = Number(video.videoWidth || frameMetadata?.width || frameMetadata?.displayWidth || metric.width || 0) || null;
        metric.height = Number(video.videoHeight || frameMetadata?.height || frameMetadata?.displayHeight || metric.height || 0) || null;
        updateSource(sourceId, { state: "live" });
      }

      function observeVideoFrames(sourceId, video, track) {
        const metric = metricFor(sourceId);
        const settings = track?.getSettings?.() || {};
        metric.width = Number(settings.width || metric.width || 0) || null;
        metric.height = Number(settings.height || metric.height || 0) || null;
        metric.trackReadyState = track?.readyState || metric.trackReadyState;
        const noteIfReady = (frameMetadata = null) => {
          metric.trackReadyState = track?.readyState || metric.trackReadyState;
          const metadataWidth = Number(frameMetadata?.width || frameMetadata?.displayWidth || 0) || null;
          const metadataHeight = Number(frameMetadata?.height || frameMetadata?.displayHeight || 0) || null;
          const width = Number(video.videoWidth || metadataWidth || metric.width || 0) || null;
          const height = Number(video.videoHeight || metadataHeight || metric.height || 0) || null;
          if (width) metric.width = width;
          if (height) metric.height = height;
          if (video.readyState >= 2 || frameMetadata || (metric.width && metric.height)) {
            noteSourceRendered(sourceId, video, frameMetadata);
          } else {
            updateSource(sourceId, { state: "live" });
          }
        };
        const addProbe = (eventName) => video.addEventListener(eventName, () => noteIfReady(), { passive: true });
        addProbe("loadedmetadata");
        addProbe("loadeddata");
        addProbe("canplay");
        addProbe("playing");
        addProbe("resize");
        let stopped = false;
        const stop = () => { stopped = true; };
        track?.addEventListener?.("ended", stop, { once: true });
        if (typeof video.requestVideoFrameCallback === "function") {
          const loop = (_now, metadata) => {
            if (stopped || videos.get(sourceId) !== video) return;
            noteIfReady(metadata);
            video.requestVideoFrameCallback(loop);
          };
          video.requestVideoFrameCallback(loop);
        } else {
          const timer = window.setInterval(() => {
            if (stopped || videos.get(sourceId) !== video) {
              window.clearInterval(timer);
              return;
            }
            noteIfReady();
          }, 100);
        }
        noteIfReady();
      }

      async function createPeer(source) {
        const sourceId = String(source.id || "host-app");
        peers.get(sourceId)?.close?.();
        disposeSourceVideo(sourceId);
        const pc = new RTCPeerConnection({
          iceServers: Array.isArray(state.webrtcIceServers) ? state.webrtcIceServers : [],
        });
        peers.set(sourceId, pc);
        pc.addEventListener("icecandidate", (event) => {
          if (event.candidate) {
            send({ type: "operator_visual_ice_candidate", sourceId, candidate: event.candidate });
          }
        });
        pc.addEventListener("connectionstatechange", () => setPeerState(pc));
        pc.addEventListener("iceconnectionstatechange", () => setPeerState(pc));
        pc.addEventListener("signalingstatechange", () => setPeerState(pc));
        pc.addEventListener("track", (event) => {
          const stream = event.streams?.[0] || new MediaStream([event.track]);
          const video = document.createElement("video");
          video.autoplay = true;
          video.muted = true;
          video.playsInline = true;
          video.dataset.lanVisualSourceId = sourceId;
          video.srcObject = stream;
          receiverVideoHost().appendChild(video);
          videos.set(sourceId, video);
          const metric = metricFor(sourceId);
          metric.streamId = stream.id;
          metric.trackId = event.track.id;
          metric.trackReadyState = event.track.readyState;
          event.track.addEventListener("ended", () => {
            metric.trackReadyState = event.track.readyState;
            updateSource(sourceId, { state: "ended" });
            emitVisualState();
          });
          void video.play().catch((error) => {
            state.errors.push("host_visual_video_play_failed:" + String(error?.message || error));
          });
          observeVideoFrames(sourceId, video, event.track);
          updateSource(sourceId, { ...source, state: "live" });
          setPeerState(pc);
        });
        return pc;
      }

      async function handleOffer(payload) {
        const source = payload.source || { id: payload.sourceId || "host-app" };
        const sourceId = String(source.id || payload.sourceId || "host-app");
        updateSource(sourceId, { ...source, state: "connecting" });
        const pc = await createPeer({ ...source, id: sourceId });
        await pc.setRemoteDescription(payload.description);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        send({ type: "operator_visual_answer", sourceId, description: pc.localDescription });
        setPeerState(pc);
      }

      async function handleCandidate(payload) {
        const sourceId = String(payload.sourceId || "host-app");
        const pc = peers.get(sourceId);
        if (pc && payload.candidate) await pc.addIceCandidate(payload.candidate);
      }

      function connect() {
        if (ws && ws.readyState === WebSocket.OPEN) return ws;
        state.visual.receiverWebSocketState = "connecting";
        patchTransport({
          state: state.transport.visual.connectCount > 0 ? "reconnecting" : "connecting",
          nextReconnectAt: null,
        });
        const protocol = location.protocol === "https:" ? "wss:" : "ws:";
        ws = new WebSocket(protocol + "//" + location.host + "/operator/visual/ws");
        ws.addEventListener("open", () => {
          state.visual.receiverWebSocketState = "open";
          state.visual.connectionState = "connecting";
          patchTransport({
            state: "open",
            connectCount: state.transport.visual.connectCount + 1,
            lastConnectedAt: new Date().toISOString(),
            lastPacketAt: new Date().toISOString(),
            lastError: null,
            nextReconnectAt: null,
          });
          send({ type: "operator_visual_receiver_ready" });
          emitVisualState();
          input.syncDebug?.();
        });
        ws.addEventListener("close", () => {
          state.visual.receiverWebSocketState = "closed";
          state.visual.connectionState = videos.size > 0 ? "degraded" : "not_connected";
          const delay = Math.min(3000, 650 * Math.max(1, state.transport.visual.reconnectCount + 1));
          const nextReconnectAt = new Date(Date.now() + delay).toISOString();
          patchTransport({
            state: "reconnecting",
            reconnectCount: state.transport.visual.reconnectCount + 1,
            lastDisconnectedAt: new Date().toISOString(),
            lastError: "websocket_closed",
            nextReconnectAt,
          });
          if (!reconnectTimer) {
            reconnectTimer = window.setTimeout(() => {
              reconnectTimer = null;
              connect();
            }, delay);
          }
          emitVisualState();
          input.syncDebug?.();
        });
        ws.addEventListener("error", () => {
          state.errors.push("operator_visual_websocket_error");
          patchTransport({ state: "failed", lastError: "operator_visual_websocket_error" });
          input.syncDebug?.();
        });
        ws.addEventListener("message", (event) => {
          void (async () => {
            patchTransport({ lastPacketAt: new Date().toISOString() });
            const payload = JSON.parse(String(event.data || "{}"));
            if (payload.type === "host_visual_publisher_ready") {
              state.visual.hostPublisherConnections = Number(payload.hostPublisherConnections || 1);
              updateSource(String(payload.source?.id || payload.sourceId || "host-app"), {
                ...(payload.source || {}),
                state: "connecting",
              });
              emitVisualState();
            }
            if (payload.type === "host_visual_offer") await handleOffer(payload);
            if (payload.type === "host_visual_ice_candidate") await handleCandidate(payload);
          })().catch((error) => {
            state.errors.push("operator_visual_message_failed:" + String(error?.message || error));
            input.syncDebug?.();
          });
        });
        return ws;
      }

      window.setInterval(() => {
        emitVisualState();
        input.syncDebug?.();
      }, 1000);

      return {
        connect,
        currentVisualState,
        sourceVideo,
        noteSourceRendered,
      };
    },
  };
})();
`;
}
