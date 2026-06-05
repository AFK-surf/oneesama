import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { readBrowserInitSource } from "../browser-init-source.ts";

const require = createRequire(import.meta.url);

function normalizeAgentRuntime(value: unknown): string {
  return String(value || "")
    .trim()
    .toLowerCase();
}

export type RealtimeRuntimePlacement = "inline" | "sidecar";
export type RealtimePageRole = "generic" | "meet-surface" | "sidecar";

const INLINE_MEET_SDK_DEPRECATED_REASON =
  "inline_agents_sdk_on_google_meet_has_been_removed_use_realtime_sdk_sidecar";

export function normalizeRealtimeRuntimePlacement(value: unknown): RealtimeRuntimePlacement {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
  if (!normalized) return "sidecar";
  if (normalized === "inline") return "inline";
  if (normalized === "sidecar") return "sidecar";
  throw new Error(
    `realtimeRuntimePlacement must be inline or sidecar; got ${JSON.stringify(value)}`,
  );
}

function normalizeRealtimePageRole(value: unknown): RealtimePageRole {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
  if (!normalized || normalized === "generic") return "generic";
  if (normalized === "meet" || normalized === "meet-surface" || normalized === "google-meet") {
    return "meet-surface";
  }
  if (normalized === "sidecar") return "sidecar";
  throw new Error(
    `realtimePageRole must be generic, meet-surface, or sidecar; got ${JSON.stringify(value)}`,
  );
}

function realtimeRuntimePlacementFromConfig(
  config: Record<string, unknown>,
): RealtimeRuntimePlacement {
  return normalizeRealtimeRuntimePlacement(
    config.realtimeRuntimePlacement ?? config.runtimePlacement,
  );
}

function realtimePageRoleFromConfig(config: Record<string, unknown>): RealtimePageRole {
  return normalizeRealtimePageRole(config.realtimePageRole ?? config.pageRole);
}

function allowInlineAgentsSDKDiagnostic(config: Record<string, unknown>): boolean {
  return config.allowInlineAgentsSDKDiagnostic === true;
}

function configWithRuntimePlacement(config: Record<string, unknown>): Record<string, unknown> {
  const hasPageRole = config.realtimePageRole !== undefined || config.pageRole !== undefined;
  return {
    ...config,
    realtimeRuntimePlacement: realtimeRuntimePlacementFromConfig(config),
    ...(hasPageRole ? { realtimePageRole: realtimePageRoleFromConfig(config) } : {}),
  };
}

function shouldInjectRealtimeAgentsSDK(config: Record<string, unknown>): boolean {
  const runtime = normalizeAgentRuntime(config.agentRuntime);
  if (!["agents-sdk", "openai-agents", "openai-agents-sdk"].includes(runtime)) return false;
  const placement = realtimeRuntimePlacementFromConfig(config);
  if (placement === "inline") {
    return (
      allowInlineAgentsSDKDiagnostic(config) &&
      realtimePageRoleFromConfig(config) !== "meet-surface"
    );
  }
  return realtimePageRoleFromConfig(config) === "sidecar";
}

function shouldBuildMeetSurfacePlaceholder(config: Record<string, unknown>): boolean {
  return (
    realtimeRuntimePlacementFromConfig(config) === "sidecar" &&
    realtimePageRoleFromConfig(config) === "meet-surface"
  );
}

function shouldBuildRemovedInlineMeetSurfacePlaceholder(config: Record<string, unknown>): boolean {
  return (
    realtimeRuntimePlacementFromConfig(config) === "inline" &&
    realtimePageRoleFromConfig(config) === "meet-surface"
  );
}

function buildMeetSurfaceRealtimePlaceholder(config: Record<string, unknown>) {
  const normalizedConfig = configWithRuntimePlacement(config);
  const surfaceConfig: Record<string, unknown> = {
    ...normalizedConfig,
    sdkOwner: "sidecar",
  };
  delete surfaceConfig.toolCallbackToken;
  delete surfaceConfig.tools;
  delete surfaceConfig.session;
  delete surfaceConfig.instructions;
  delete surfaceConfig.openaiRealtimeBaseUrl;
  delete surfaceConfig.sdpUrl;
  delete surfaceConfig.workerDelegateUrl;
  delete surfaceConfig.workerStatusUrl;
  delete surfaceConfig.currentUser;
  const meetChatHelper = readBrowserInitSource(
    import.meta.url,
    "./realtime-browser-meet-chat-helpers.js",
    "./realtime-browser-meet-chat-helpers.ts",
  );
  const meetSurfaceAudioOutputHook = readBrowserInitSource(
    import.meta.url,
    "./realtime-meet-surface-audio-output-hook.js",
    "./realtime-meet-surface-audio-output-hook.ts",
  );
  return [
    `window.MAB_REALTIME_BRIDGE_CONFIG = ${JSON.stringify(surfaceConfig)};`,
    meetChatHelper,
    "window.MAB_REALTIME_BRIDGE = window.MAB_REALTIME_BRIDGE || {",
    "  ok: true,",
    '  runtimePlacement: "sidecar",',
    '  pageRole: "meet-surface",',
    '  sdkOwner: "sidecar",',
    '  agentRuntime: { active: "", sdkConnected: false, sdkOwner: "sidecar", sdkSuppressedOnMeetSurface: true },',
    "};",
    "window.MAB_REALTIME_CLIENT = window.MAB_REALTIME_CLIENT || {",
    '  runtimePlacement: "sidecar",',
    '  pageRole: "meet-surface",',
    '  sdkOwner: "sidecar",',
    "};",
    meetSurfaceAudioOutputHook,
    "(() => {",
    "  const config = window.MAB_REALTIME_BRIDGE_CONFIG || {};",
    "  const state = { meetChat: { observerInstalled: false, messages: [], links: [], errors: [], lastObservedAt: '', injected: 0 }, timeline: [] };",
    "  const recordTimeline = (type, detail = {}) => { state.timeline.push({ ts: new Date().toISOString(), type, detail }); state.timeline = state.timeline.slice(-80); };",
    "  const updateFeedback = () => {};",
    "  const postJson = async (url, body) => {",
    "    const headers = { 'content-type': 'application/json' };",
    "    if (config.toolCallbackToken) headers['X-Oneesama-Internal-Key'] = String(config.toolCallbackToken);",
    "    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });",
    "    const payload = await response.json().catch(() => ({ ok: false, error: 'invalid_json_response' }));",
    "    return response.ok ? payload : { ok: false, status: response.status, body: payload };",
    "  };",
    "  const localServiceUrl = (path) => { try { return new URL(path, new URL(config.tokenUrl || location.href, location.href).origin).toString(); } catch { return path; } };",
    "  const helpers = window.__MAB_REALTIME_MEET_CHAT_HELPERS.create({ config, state, recordTimeline, updateFeedback, postJson, localServiceUrl });",
    "  window.MAB_MEET_SURFACE_TOOLS = { state, run: (name, args = {}) => helpers.runLocalMeetTool(name, args), sendMeetChat: helpers.sendMeetChat, readMeetChat: helpers.readMeetChat };",
    "  (() => {",
    "    if (config.allowHostMeetAudioPcmInput !== true) return;",
    "    if (typeof window.MAB_HOST_FORWARD_MEET_AUDIO_PCM !== 'function') return;",
    "    const routedStreams = new WeakSet();",
    "    let audioContext = null;",
    "    let processorCount = 0;",
    "    const surfaceAudioInput = { enabled: true, streams: 0, metadataRegistrations: 0, chunks: 0, samples: 0, droppedChunks: 0, droppedSamples: 0, inFlight: 0, lastChunkAt: '', lastMetadataAt: '', errors: [] };",
    "    const rememberError = (stage, error) => { surfaceAudioInput.errors.push({ ts: new Date().toISOString(), stage, error: String(error && error.message || error).slice(0, 240) }); surfaceAudioInput.errors = surfaceAudioInput.errors.slice(-20); recordTimeline('surface_audio_input_error', { stage, error: String(error && error.message || error).slice(0, 240) }); };",
    "    const ensureAudioContext = () => {",
    "      if (audioContext) return audioContext;",
    "      const AudioContextImpl = window.AudioContext || window.webkitAudioContext;",
    "      if (!AudioContextImpl) throw new Error('audio_context_unavailable');",
    "      audioContext = new AudioContextImpl({ sampleRate: 48000 });",
    "      const resume = () => audioContext && audioContext.state === 'suspended' && audioContext.resume().catch((error) => rememberError('audio_context_resume', error));",
    "      window.addEventListener('click', resume, { capture: true, passive: true });",
    "      window.addEventListener('pointerdown', resume, { capture: true, passive: true });",
    "      window.addEventListener('keydown', resume, { capture: true });",
    "      resume();",
    "      return audioContext;",
    "    };",
    "    const forwardSamples = (samples, label, streamId = '', trackIds = []) => {",
    "      if (!samples || !samples.length) return;",
    "      if (surfaceAudioInput.inFlight >= 4) {",
    "        surfaceAudioInput.droppedChunks += 1;",
    "        surfaceAudioInput.droppedSamples += samples.length;",
    "        return;",
    "      }",
    "      const payload = { sessionId: String(config.sessionId || ''), source: 'host_meet_audio_pcm', label, streamId, trackIds, sampleRate: audioContext ? audioContext.sampleRate : 48000, channels: 1, samples: Array.from(samples, (sample) => Number(sample || 0)) };",
    "      surfaceAudioInput.chunks += 1;",
    "      surfaceAudioInput.samples += payload.samples.length;",
    "      surfaceAudioInput.inFlight += 1;",
    "      surfaceAudioInput.lastChunkAt = new Date().toISOString();",
    "      window.MAB_HOST_FORWARD_MEET_AUDIO_PCM(payload).catch((error) => rememberError('host_forward', error)).finally(() => { surfaceAudioInput.inFlight = Math.max(0, surfaceAudioInput.inFlight - 1); });",
    "    };",
    "    const forwardStreamMetadata = (label, stream, tracks) => {",
    "      const payload = { sessionId: String(config.sessionId || ''), source: 'host_meet_audio_pcm', label, streamId: stream && stream.id || '', trackIds: tracks.map((track) => track.id), sampleRate: audioContext ? audioContext.sampleRate : 48000, channels: 0, samples: [], metadataOnly: true };",
    "      surfaceAudioInput.metadataRegistrations += 1;",
    "      surfaceAudioInput.lastMetadataAt = new Date().toISOString();",
    "      recordTimeline('surface_audio_input_source_metadata_registered', { label, streamId: payload.streamId, trackIds: payload.trackIds });",
    "      window.MAB_HOST_FORWARD_MEET_AUDIO_PCM(payload).then((result) => {",
    "        if (!result || result.ok !== true) rememberError('host_metadata_forward', result && (result.error || result.reason) || 'metadata_forward_failed');",
    "      }).catch((error) => rememberError('host_metadata_forward', error));",
    "    };",
    "    const registerStream = (stream, label = 'meet-surface-audio') => {",
    "      try {",
    "        if (!stream || routedStreams.has(stream)) return { ok: true, skipped: true, reason: 'duplicate_stream' };",
    "        const tracks = stream.getAudioTracks ? stream.getAudioTracks().filter((track) => track.readyState !== 'ended') : [];",
    "        if (!tracks.length) return { ok: false, error: 'stream_has_no_audio_tracks' };",
    "        routedStreams.add(stream);",
    "        forwardStreamMetadata(label, stream, tracks);",
    "        const ctx = ensureAudioContext();",
    "        const source = ctx.createMediaStreamSource(stream);",
    "        const processor = ctx.createScriptProcessor(4096, Math.min(2, Math.max(1, tracks.length)), 1);",
    "        const sink = ctx.createGain();",
    "        sink.gain.value = 0;",
    "        processor.onaudioprocess = (event) => {",
    "          try {",
    "            const input = event.inputBuffer;",
    "            const channels = Math.max(1, input.numberOfChannels || 1);",
    "            const first = input.getChannelData(0);",
    "            let mono = first;",
    "            if (channels > 1) {",
    "              mono = new Float32Array(first.length);",
    "              for (let channel = 0; channel < channels; channel += 1) {",
    "                const data = input.getChannelData(channel);",
    "                for (let index = 0; index < data.length; index += 1) mono[index] += data[index] / channels;",
    "              }",
    "            }",
    "            forwardSamples(mono, label, stream.id || '', tracks.map((track) => track.id));",
    "          } catch (error) {",
    "            rememberError('audio_process', error);",
    "          }",
    "        };",
    "        source.connect(processor);",
    "        processor.connect(sink);",
    "        sink.connect(ctx.destination);",
    "        processorCount += 1;",
    "        surfaceAudioInput.streams += 1;",
    "        recordTimeline('surface_audio_input_stream_registered', { label, trackIds: tracks.map((track) => track.id), processorCount });",
    "        return { ok: true, trackIds: tracks.map((track) => track.id), processorCount };",
    "      } catch (error) {",
    "        rememberError('register_stream', error);",
    "        return { ok: false, error: String(error && error.message || error) };",
    "      }",
    "    };",
    "    const allowParticipantAudioStreamEvent = () => config.allowParticipantAudioStreamEvents === true || ['mock', 'webrtc-mock', 'agents-sdk-mock'].includes(String(config.mode || ''));",
    "    const captureElementStream = (element) => {",
    "      const stream = element.srcObject instanceof MediaStream ? element.srcObject : null;",
    "      if (stream) return stream;",
    "      const capture = element.captureStream || element.mozCaptureStream;",
    "      if (typeof capture !== 'function') return null;",
    "      try { return capture.call(element); } catch (error) { rememberError('element_capture_stream', error); return null; }",
    "    };",
    "    const scan = () => {",
    "      for (const element of Array.from(document.querySelectorAll('audio,video'))) {",
    "        const stream = captureElementStream(element);",
    "        if (stream) registerStream(stream, element.dataset && element.dataset.meetingAvatarParticipant || element.id || element.tagName.toLowerCase());",
    "      }",
    "      return surfaceAudioInput;",
    "    };",
    "    window.addEventListener('meeting-avatar-participant-audio-stream', (event) => {",
    "      const detail = event.detail || {};",
    "      if (!allowParticipantAudioStreamEvent()) { recordTimeline('surface_audio_input_stream_event_rejected', { label: detail.label || '', mode: config.mode || '', reason: 'participant_audio_stream_event_disabled' }); return; }",
    "      registerStream(detail.stream, detail.label || 'participant-audio-event');",
    "    });",
    "    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scan, { once: true }); else scan();",
    "    window.setInterval(scan, 1500);",
    "    window.MAB_MEET_SURFACE_AUDIO_INPUT = { state: surfaceAudioInput, registerStream, scan };",
    "  })();",
    "})();",
  ].join("\n");
}

function buildRemovedInlineMeetSurfacePlaceholder(config: Record<string, unknown>) {
  const normalizedConfig = configWithRuntimePlacement(config);
  return [
    `window.MAB_REALTIME_BRIDGE_CONFIG = ${JSON.stringify(normalizedConfig)};`,
    buildInlineMeetSDKDiagnosticWarning(normalizedConfig),
    "window.MAB_REALTIME_BRIDGE = window.MAB_REALTIME_BRIDGE || {",
    "  ok: false,",
    '  runtimePlacement: "inline",',
    '  pageRole: "meet-surface",',
    '  error: "inline_realtime_sdk_on_meet_removed",',
    '  agentRuntime: { active: "", sdkConnected: false, sdkOwner: "removed", sdkSuppressedOnMeetSurface: true },',
    "};",
    "window.MAB_REALTIME_CLIENT = window.MAB_REALTIME_CLIENT || {",
    "  ok: false,",
    '  runtimePlacement: "inline",',
    '  pageRole: "meet-surface",',
    '  error: "inline_realtime_sdk_on_meet_removed",',
    "};",
  ].join("\n");
}

function buildInlineMeetSDKDiagnosticWarning(config: Record<string, unknown>) {
  if (
    realtimeRuntimePlacementFromConfig(config) !== "inline" ||
    realtimePageRoleFromConfig(config) !== "meet-surface"
  ) {
    return "";
  }
  const detail = {
    ok: false,
    severity: "warn",
    reason: INLINE_MEET_SDK_DEPRECATED_REASON,
    realtimeRuntimePlacement: "inline",
    realtimePageRole: "meet-surface",
    targetRuntimePlacement: "sidecar",
  };
  return [
    "(() => {",
    "  const detail = " + JSON.stringify(detail) + ";",
    "  const href = String(location.href || '');",
    "  if (!/^https:\\/\\/meet\\.google\\.com\\//i.test(href)) return;",
    "  window.MAB_REALTIME_INLINE_SDK_DEPRECATED = detail;",
    "  console.warn('[oneesama] Inline OpenAI Realtime Agents SDK on Google Meet has been removed; use realtimeRuntimePlacement=sidecar.', detail);",
    "  window.dispatchEvent(new CustomEvent('mab-realtime-inline-sdk-deprecated', { detail }));",
    "})();",
  ].join("\n");
}

export function readRealtimeAgentsSDKBundle(options: { strictCSPPatch?: boolean } = {}) {
  const entryPath = require.resolve("@openai/agents-realtime");
  const bundlePath = resolve(dirname(entryPath), "bundle/openai-realtime-agents.umd.js");
  const packagePath = resolve(dirname(entryPath), "../package.json");
  const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: string };
  const source = readFileSync(bundlePath, "utf8");
  return {
    source: options.strictCSPPatch ? patchRealtimeAgentsSDKBundleForStrictCSP(source) : source,
    version: pkg.version || "",
    bundlePath,
  };
}

export function patchRealtimeAgentsSDKBundleForStrictCSP(source: string) {
  const zodGlobalConfig = "const Bc={};function qt(e){return Bc}";
  if (!source.includes(zodGlobalConfig)) {
    throw new Error("Unable to patch OpenAI Realtime Agents SDK Zod global config for strict CSP");
  }
  return source.replace(zodGlobalConfig, "const Bc={jitless:!0};function qt(e){return Bc}");
}

export function buildRealtimeBrowserInitScript(config = {}) {
  const normalizedConfig = configWithRuntimePlacement(config as Record<string, unknown>);
  if (shouldBuildMeetSurfacePlaceholder(normalizedConfig)) {
    return buildMeetSurfaceRealtimePlaceholder(normalizedConfig);
  }
  if (shouldBuildRemovedInlineMeetSurfacePlaceholder(normalizedConfig)) {
    return buildRemovedInlineMeetSurfacePlaceholder(normalizedConfig);
  }
  const helperSources = [
    readBrowserInitSource(
      import.meta.url,
      "./realtime-browser-connection-helpers.js",
      "./realtime-browser-connection-helpers.ts",
    ),
    readBrowserInitSource(
      import.meta.url,
      "./realtime-browser-session-helpers.js",
      "./realtime-browser-session-helpers.ts",
    ),
    readBrowserInitSource(
      import.meta.url,
      "./realtime-browser-audio-output-helpers.js",
      "./realtime-browser-audio-output-helpers.ts",
    ),
    readBrowserInitSource(
      import.meta.url,
      "./realtime-browser-agent-audio-helpers.js",
      "./realtime-browser-agent-audio-helpers.ts",
    ),
    readBrowserInitSource(
      import.meta.url,
      "./realtime-browser-audio-sender-stats-helpers.js",
      "./realtime-browser-audio-sender-stats-helpers.ts",
    ),
    readBrowserInitSource(
      import.meta.url,
      "./realtime-browser-agent-transport-helpers.js",
      "./realtime-browser-agent-transport-helpers.ts",
    ),
    readBrowserInitSource(
      import.meta.url,
      "./realtime-browser-local-tool-helpers.js",
      "./realtime-browser-local-tool-helpers.ts",
    ),
    readBrowserInitSource(
      import.meta.url,
      "./realtime-browser-local-tool-router-helpers.js",
      "./realtime-browser-local-tool-router-helpers.ts",
    ),
    readBrowserInitSource(
      import.meta.url,
      "./realtime-browser-meet-chat-helpers.js",
      "./realtime-browser-meet-chat-helpers.ts",
    ),
    readBrowserInitSource(
      import.meta.url,
      "./realtime-browser-worker-result-helpers.js",
      "./realtime-browser-worker-result-helpers.ts",
    ),
    readBrowserInitSource(
      import.meta.url,
      "./realtime-browser-meeting-event-helpers.js",
      "./realtime-browser-meeting-event-helpers.ts",
    ),
    readBrowserInitSource(
      import.meta.url,
      "./realtime-browser-turn-policy-helpers.js",
      "./realtime-browser-turn-policy-helpers.ts",
    ),
    readBrowserInitSource(
      import.meta.url,
      "./realtime-browser-context-helpers.js",
      "./realtime-browser-context-helpers.ts",
    ),
  ];
  const bridgeSources = [
    "./realtime-browser-bridge",
    "./realtime-browser-bridge-audio-routing-gain",
    "./realtime-browser-bridge-audio-routing",
    "./realtime-browser-bridge-recappi-audio",
    "./realtime-browser-bridge-audio-capture",
    "./realtime-browser-bridge-meet-peer-hook",
    "./realtime-browser-bridge-text-turn-routing",
    "./realtime-browser-bridge-local-tool-runtime",
    "./realtime-browser-bridge-runtime-wiring",
    "./realtime-browser-bridge-agent-transport",
    "./realtime-browser-bridge-meeting-input",
    "./realtime-browser-bridge-connect",
    "./realtime-browser-bridge-public-api",
  ].map((basePath) => readBrowserInitSource(import.meta.url, `${basePath}.js`, `${basePath}.ts`));
  const source = [
    "(() => {",
    "  if (window.__meetingAvatarRealtimeBridge) return;",
    "  if (window.top !== window) return;",
    "  window.__meetingAvatarRealtimeBridge = true;",
    ...bridgeSources,
    "})();",
  ].join("\n");
  if (!shouldInjectRealtimeAgentsSDK(normalizedConfig)) {
    return [
      `window.MAB_REALTIME_BRIDGE_CONFIG = ${JSON.stringify(normalizedConfig)};`,
      buildInlineMeetSDKDiagnosticWarning(normalizedConfig),
      ...helperSources,
      source,
    ].join("\n");
  }
  const bundle = readRealtimeAgentsSDKBundle({
    strictCSPPatch: realtimeRuntimePlacementFromConfig(normalizedConfig) === "inline",
  });
  return [
    `window.MAB_REALTIME_BRIDGE_CONFIG = ${JSON.stringify({
      ...normalizedConfig,
      agentSDKVersion: normalizedConfig.agentSDKVersion || bundle.version,
    })};`,
    buildInlineMeetSDKDiagnosticWarning(normalizedConfig),
    bundle.source,
    ...helperSources,
    source,
  ].join("\n");
}
