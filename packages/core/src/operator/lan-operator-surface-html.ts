/* eslint-disable max-lines */
import type { AvatarRuntimeSessionConfig } from "../avatar-runtime/contracts.ts";
import { DEFAULT_SOURCE_RECTS } from "./lan-operator-debug-state.ts";
import { buildLanOperatorArtifactClientScript } from "./lan-operator-artifact-client.ts";
import { buildLanOperatorDebugPanelClientScript } from "./lan-operator-debug-panel-client.ts";
import { buildLanOperatorOutputClientScript } from "./lan-operator-output-client.ts";
import { buildLanOperatorTextInputClientScript } from "./lan-operator-text-input-client.ts";
import { buildLanOperatorVoiceControlsClientScript } from "./lan-operator-voice-controls-client.ts";
import { buildLanOperatorVoiceClientScript } from "./lan-operator-voice-client.ts";
import { buildLanOperatorVisualClientScript } from "./lan-operator-visual-client.ts";
import { buildLanOperatorWebSocketClientScript } from "./lan-operator-websocket-client.ts";
function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
export function buildLanOperatorSurfaceHtml(config: Readonly<AvatarRuntimeSessionConfig>) {
  const webrtcIceServers = Array.isArray(
    (config.renderer as { webrtcIceServers?: unknown } | undefined)?.webrtcIceServers,
  )
    ? (config.renderer as { webrtcIceServers: unknown[] }).webrtcIceServers
    : [];
  const boot = JSON.stringify({
    sessionId: config.sessionId,
    botName: config.botName,
    conversationTransport: config.conversationTransport,
    webrtcIceServers,
    sources: [
      { id: "host-app", label: "Host app", kind: "desktop_app", state: "synthetic" },
      { id: "avatar", label: "Avatar", kind: "avatar", state: "synthetic" },
    ],
    sourceRects: DEFAULT_SOURCE_RECTS,
  });
  const title = `${config.botName} Local Operator`;
  const voiceClientSource = buildLanOperatorVoiceClientScript();
  const voiceControlsClientSource = buildLanOperatorVoiceControlsClientScript();
  const websocketClientSource = buildLanOperatorWebSocketClientScript();
  const artifactClientSource = buildLanOperatorArtifactClientScript();
  const outputClientSource = buildLanOperatorOutputClientScript(),
    visualClientSource = buildLanOperatorVisualClientScript(),
    textInputClientSource = buildLanOperatorTextInputClientScript(),
    debugPanelClientSource = buildLanOperatorDebugPanelClientScript();
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f7f8fb; --panel: #ffffff; --panel-2: #f1f4f8; --ink: #16202f;
        --muted: #667084; --line: #d8dee8; --accent: #0f766e; --blue: #315fce;
        --warn: #b7791f; --bad: #b42318;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0; min-height: 100vh; background: var(--bg); color: var(--ink);
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      button, select, input { font: inherit; font-size: 13px; }
      .app { display: grid; grid-template-rows: auto 1fr; min-height: 100vh; }
      header {
        display: flex; align-items: center; justify-content: space-between; gap: 16px;
        min-height: 58px; padding: 0 18px; border-bottom: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.9); backdrop-filter: blur(12px);
      }
      h1 { margin: 0; font-size: 17px; line-height: 1.2; letter-spacing: 0; }
      .topline { display: flex; align-items: center; gap: 12px; color: var(--muted); font-size: 12px; }
      .status-dot { width: 9px; height: 9px; border-radius: 99px; background: var(--warn); display: inline-block; }
      .status-dot.ready { background: var(--accent); }
      .status-dot.bad { background: var(--bad); }
      main { display: grid; grid-template-columns: minmax(520px, 1fr) 390px; gap: 14px; padding: 14px; min-height: 0; }
      .stage-shell, .debug-shell { min-height: 0; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
      .stage-toolbar {
        display: flex; align-items: center; justify-content: space-between; gap: 10px;
        padding: 10px 12px; border-bottom: 1px solid var(--line);
      }
      .toolbar-group { display: flex; align-items: center; gap: 8px; min-width: 0; }
      .voice-tools { flex-wrap: wrap; justify-content: flex-end; }
      .btn {
        border: 1px solid var(--line); border-radius: 6px; background: #fff; color: var(--ink);
        min-height: 32px; padding: 6px 10px; cursor: pointer;
      }
      .btn.primary { border-color: var(--accent); background: var(--accent); color: #fff; }
      .btn:disabled { cursor: not-allowed; opacity: 0.55; }
      .voice-device {
        width: 176px; min-height: 32px; border: 1px solid var(--line); border-radius: 6px;
        background: #fff; color: var(--ink); padding: 5px 8px;
      }
      .checkbox-control {
        display: inline-flex; align-items: center; gap: 5px; min-height: 32px; color: var(--muted);
        font-size: 12px; user-select: none;
      }
      .energy-meter {
        width: 76px; height: 8px; border-radius: 99px; overflow: hidden; background: #d8dee8;
      }
      .energy-meter span { display: block; width: 0%; height: 100%; background: var(--accent); }
      .energy-label { width: 38px; color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
      .source-tabs { display: flex; gap: 6px; }
      .source-tabs button[aria-pressed="true"] { border-color: var(--blue); color: var(--blue); background: #eef3ff; }
      .stage-grid { display: grid; grid-template-columns: 190px 1fr; min-height: calc(100vh - 110px); }
      aside { border-right: 1px solid var(--line); background: var(--panel-2); padding: 10px; }
      .source-row {
        width: 100%; display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: center;
        margin-bottom: 8px; border: 1px solid var(--line); border-radius: 7px; background: #fff;
        padding: 9px; color: var(--ink); text-align: left; cursor: pointer;
      }
      .source-row strong { display: block; font-size: 13px; line-height: 1.2; }
      .source-row span { color: var(--muted); font-size: 11px; }
      .source-row[aria-pressed="true"] { border-color: var(--blue); box-shadow: inset 0 0 0 1px var(--blue); }
      .canvas-wrap { min-width: 0; display: grid; place-items: center; padding: 16px; background: #e8edf4; }
      canvas {
        width: min(100%, 1180px); aspect-ratio: 16 / 9; border-radius: 8px;
        border: 1px solid #c6cfdd; background: #111827;
        box-shadow: 0 12px 36px rgba(17, 24, 39, 0.12); touch-action: none;
      }
      .debug-shell { display: grid; grid-template-rows: auto 1fr; }
      .debug-header {
        display: flex; align-items: center; justify-content: space-between; gap: 10px;
        padding: 10px 12px; border-bottom: 1px solid var(--line);
      }
      .debug-header h2 { margin: 0; font-size: 14px; letter-spacing: 0; }
      .debug-body { overflow: auto; padding: 12px; }
      .metric-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
      .metric { min-height: 64px; border: 1px solid var(--line); border-radius: 7px; background: #fbfcfe; padding: 8px; }
      .metric b { display: block; margin-bottom: 5px; color: var(--muted); font-size: 11px; font-weight: 650; }
      .metric span { font-size: 13px; overflow-wrap: anywhere; }
      .debug-filter { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
      .debug-filter input { flex: 1; min-width: 0; min-height: 32px; border: 1px solid var(--line); border-radius: 6px; padding: 6px 9px; background: #fff; color: var(--ink); }
      .debug-filter span { min-width: 92px; color: var(--muted); font-size: 11px; text-align: right; }
      .debug-sections { display: grid; gap: 10px; margin-top: 10px; }
      .debug-section {
        border: 1px solid var(--line); border-radius: 7px; background: #fff;
        overflow: hidden;
      }
      .debug-section[data-filter-hidden="true"], .debug-table tr[data-filter-hidden="true"], pre[data-filter-hidden="true"] { display: none; }
      .debug-section-title {
        display: flex; align-items: center; justify-content: space-between; gap: 8px;
        min-height: 34px; padding: 8px 10px; border-bottom: 1px solid var(--line);
        color: var(--muted); font-size: 11px; font-weight: 700; text-transform: uppercase;
      }
      .debug-section-title span { color: var(--ink); font-weight: 600; text-transform: none; }
      .debug-table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 11px; }
      .debug-table th, .debug-table td {
        padding: 7px 8px; border-bottom: 1px solid #edf0f5; text-align: left;
        vertical-align: top; overflow-wrap: anywhere;
      }
      .debug-table th { color: var(--muted); font-weight: 650; background: #fbfcfe; }
      .debug-table tr:last-child td { border-bottom: 0; }
      .debug-ok { color: var(--accent); font-weight: 650; }
      .debug-warn { color: var(--warn); font-weight: 650; }
      .debug-bad { color: var(--bad); font-weight: 650; }
      pre {
        margin: 10px 0 0; padding: 10px; border: 1px solid var(--line); border-radius: 7px;
        background: #0f172a; color: #e2e8f0; font-size: 11px; line-height: 1.45;
        overflow: auto; max-height: 48vh;
      }
      @media (max-width: 980px) {
        main { grid-template-columns: 1fr; }
        .stage-grid { grid-template-columns: 1fr; min-height: auto; }
        aside { border-right: 0; border-bottom: 1px solid var(--line); }
      }
    </style>
  </head>
  <body>
    <div class="app">
      <header>
        <div>
          <h1>${escapeHtml(config.botName)} Local Operator Surface</h1>
          <div class="topline">
            <span id="ready-dot" class="status-dot"></span>
            <span id="session-label">${escapeHtml(config.sessionId)}</span>
          </div>
        </div>
        <div class="topline">
          <span id="voice-label">voice: connecting</span>
          <span id="visual-label">visual: composing</span>
        </div>
      </header>
      <main>
        <section class="stage-shell">
          <div class="stage-toolbar">
            <div class="toolbar-group source-tabs" id="source-tabs"></div>
            <div class="toolbar-group voice-tools">
              <select class="voice-device" id="voice-device-select" aria-label="Microphone">
                <option value="">Default mic</option>
              </select>
              <button class="btn" id="refresh-voice-devices-button" type="button">Refresh</button>
              <button class="btn" id="overlay-button" type="button">Ping Overlay</button>
              <button class="btn" id="cancel-response-button" type="button">Cancel</button>
              <button class="btn" id="cancel-tool-button" type="button">Cancel Tool</button>
              <button class="btn" id="clear-audio-button" type="button">Clear Audio</button>
              <button class="btn" id="reset-session-button" type="button">Reset</button>
              <button class="btn" id="open-debug-panel-button" type="button">Open Debug</button>
              <button class="btn primary" id="voice-button" type="button">Arm</button>
              <button class="btn" id="voice-mute-button" type="button">Mute</button>
              <button class="btn" id="voice-ptt-button" type="button" title="Diagnostic push-to-talk">PTT</button>
              <label class="checkbox-control"><input id="local-vad-toggle" type="checkbox" /> VAD</label>
              <span class="energy-meter" aria-hidden="true"><span id="voice-energy-bar"></span></span>
              <span class="energy-label" id="voice-energy-label">0.00</span>
            </div>
          </div>
          <div class="stage-grid">
            <aside id="source-list"></aside>
            <div class="canvas-wrap">
              <canvas id="composition" width="1280" height="720"></canvas>
            </div>
          </div>
        </section>
        <section class="debug-shell" id="debug-panel" tabindex="-1" data-debug-panel-opened="false">
          <div class="debug-header">
            <h2>Debug Panel</h2>
            <div class="toolbar-group">
              <button class="btn" id="copy-debug-button" type="button">Copy JSON</button>
              <button class="btn" id="download-report-button" type="button">Download</button>
              <button class="btn" id="mark-run-button" type="button">Mark</button>
              <select id="debug-view" aria-label="Debug view">
                <option value="summary">Summary</option>
                <option value="trace">Trace</option>
              </select>
            </div>
          </div>
          <div class="debug-body">
            <div class="metric-grid">
              <div class="metric"><b>Voice WS</b><span id="voice-ws">closed</span></div>
              <div class="metric"><b>Transport</b><span id="transport-state">closed</span></div>
              <div class="metric"><b>Mic</b><span id="mic-state">idle</span></div>
              <div class="metric"><b>Local VAD</b><span id="local-vad-state">off</span></div>
              <div class="metric"><b>Voice chunks</b><span id="voice-chunks">0</span></div>
              <div class="metric"><b>Visual tracks</b><span id="visual-tracks">0</span></div>
              <div class="metric"><b>Composition</b><span id="composition-state">starting</span></div>
              <div class="metric"><b>Layout revision</b><span id="layout-revision">0</span></div>
              <div class="metric"><b>KWWK overlays</b><span id="overlay-count">0</span></div>
              <div class="metric"><b>KWWK job</b><span id="kwwk-job-state">idle</span></div>
              <div class="metric"><b>Tool routing</b><span id="tool-routing-state">idle</span></div>
              <div class="metric"><b>Assistant text</b><span id="assistant-text-state">idle</span></div>
              <div class="metric"><b>Output audio</b><span id="output-audio-state">idle</span></div>
              <div class="metric"><b>Engine control</b><span id="engine-control-state">idle</span></div>
              <div class="metric"><b>Artifacts</b><span id="artifact-state">idle</span></div>
              <div class="metric"><b>Timeline</b><span id="timeline-state">idle</span></div>
            </div>
            <div class="debug-filter"><input id="debug-filter-input" type="search" placeholder="Filter debug rows" aria-label="Filter debug rows" /><button class="btn" id="debug-filter-clear-button" type="button">Clear</button><span id="debug-filter-state">filter off</span></div>
            <div class="debug-sections" data-debug-panel="dense">
              <section class="debug-section">
                <div class="debug-section-title">Transport <span id="debug-transport-summary">closed</span></div>
                <table class="debug-table">
                  <thead><tr><th>Channel</th><th>State / ID</th><th>Reconnects</th><th>Last packet / RTT / Host</th></tr></thead>
                  <tbody id="debug-transport-table"></tbody>
                </table>
              </section>
              <section class="debug-section">
                <div class="debug-section-title">Voice Input <span id="debug-voice-summary">idle</span></div>
                <table class="debug-table">
                  <tbody id="debug-voice-table"></tbody>
                </table>
              </section>
              <section class="debug-section">
                <div class="debug-section-title">Timeline <span id="debug-timeline-count">0 rows</span></div>
                <table class="debug-table">
                  <thead><tr><th>Layer</th><th>Event</th><th>Duration</th><th>Status</th></tr></thead>
                  <tbody id="debug-timeline-table"></tbody>
                </table>
              </section>
              <section class="debug-section">
                <div class="debug-section-title">Turn Correlation <span id="debug-turn-count">0 turns</span></div>
                <table class="debug-table">
                  <thead><tr><th>Turn</th><th>Milestones</th><th>Latest</th><th>Status</th></tr></thead>
                  <tbody id="debug-turn-table"></tbody>
                </table>
              </section>
              <section class="debug-section"><div class="debug-section-title">Turn Timeline <span id="debug-turn-timeline-summary">waiting</span></div><table class="debug-table"><thead><tr><th>Turn</th><th>Step</th><th>Event</th><th>Status / IDs</th></tr></thead><tbody id="debug-turn-timeline-table"></tbody></table></section>
              <section class="debug-section">
                <div class="debug-section-title">Conversation Turn <span id="debug-conversation-summary">idle</span></div>
                <table class="debug-table">
                  <tbody id="debug-conversation-table"></tbody>
                </table>
              </section>
              <section class="debug-section">
                <div class="debug-section-title">Conversation Engine Port <span id="debug-port-summary">canonical</span></div>
                <table class="debug-table">
                  <tbody id="debug-port-table"></tbody>
                </table>
              </section>
              <section class="debug-section"><div class="debug-section-title">Provider Raw Event Drilldown <span id="debug-provider-drilldown-summary">none</span></div><table class="debug-table"><thead><tr><th>Provider</th><th>Raw event</th><th>Canonical</th><th>Summary</th></tr></thead><tbody id="debug-provider-drilldown-table"></tbody></table></section>
              <section class="debug-section">
                <div class="debug-section-title">Tool Routing <span id="debug-tool-routing-summary">idle</span></div>
                <table class="debug-table">
                  <tbody id="debug-tool-routing-table"></tbody>
                </table>
              </section>
              <section class="debug-section">
                <div class="debug-section-title">KWWK Progress <span id="debug-kwwk-summary">idle</span></div>
                <table class="debug-table">
                  <tbody id="debug-kwwk-table"></tbody>
                </table>
              </section>
              <section class="debug-section">
                <div class="debug-section-title">Visual Composition <span id="debug-visual-summary">not connected</span></div>
                <table class="debug-table">
                  <tbody id="debug-composition-table"></tbody>
                </table>
                <table class="debug-table">
                  <thead><tr><th>Source</th><th>State</th><th>Track</th><th>Rect</th></tr></thead>
                  <tbody id="debug-visual-source-table"></tbody>
                </table>
              </section>
              <section class="debug-section"><div class="debug-section-title">Artifacts <span id="debug-artifact-summary">idle</span></div><table class="debug-table"><thead><tr><th>Kind</th><th>Label</th><th>Bytes</th><th>Link / policy</th></tr></thead><tbody id="debug-artifact-table"></tbody></table></section>
            </div>
            <pre id="debug-json">{}</pre>
          </div>
        </section>
      </main>
    </div>
    <script>${voiceClientSource}</script>
    <script>${voiceControlsClientSource}</script>
    <script>${websocketClientSource}</script>
    <script>${artifactClientSource}</script>
    <script>${outputClientSource}</script>
    <script>${visualClientSource}</script><script>${textInputClientSource}</script>
    <script>${debugPanelClientSource}</script>
    <script>
      (() => {
        const boot = ${boot};
        const canvas = document.getElementById("composition");
        const ctx = canvas.getContext("2d");
        const [readyDot, voiceLabel, visualLabel, voiceWsNode, transportStateNode, voiceChunksNode, visualTracksNode, compositionNode, layoutRevisionNode, overlayCountNode, kwwkJobNode, toolRoutingNode, assistantTextNode, outputAudioNode, engineControlNode, artifactNode, timelineNode, debugShell, debugJson, debugFilterInput, debugFilterClearButton, debugFilterState, debugTimelineCount, debugTransportSummary, debugTransportTable, debugVoiceSummary, debugVoiceTable, debugTimelineTable, debugTurnCount, debugTurnTable, debugTurnTimelineSummary, debugTurnTimelineTable, debugConversationSummary, debugConversationTable, debugPortSummary, debugPortTable, debugProviderDrilldownSummary, debugProviderDrilldownTable, debugToolRoutingSummary, debugToolRoutingTable, debugKwwkSummary, debugKwwkTable, debugVisualSummary, debugCompositionTable, debugVisualSourceTable, debugArtifactSummary, debugArtifactTable, sourceList, sourceTabs] = ["ready-dot", "voice-label", "visual-label", "voice-ws", "transport-state", "voice-chunks", "visual-tracks", "composition-state", "layout-revision", "overlay-count", "kwwk-job-state", "tool-routing-state", "assistant-text-state", "output-audio-state", "engine-control-state", "artifact-state", "timeline-state", "debug-panel", "debug-json", "debug-filter-input", "debug-filter-clear-button", "debug-filter-state", "debug-timeline-count", "debug-transport-summary", "debug-transport-table", "debug-voice-summary", "debug-voice-table", "debug-timeline-table", "debug-turn-count", "debug-turn-table", "debug-turn-timeline-summary", "debug-turn-timeline-table", "debug-conversation-summary", "debug-conversation-table", "debug-port-summary", "debug-port-table", "debug-provider-drilldown-summary", "debug-provider-drilldown-table", "debug-tool-routing-summary", "debug-tool-routing-table", "debug-kwwk-summary", "debug-kwwk-table", "debug-visual-summary", "debug-composition-table", "debug-visual-source-table", "debug-artifact-summary", "debug-artifact-table", "source-list", "source-tabs"].map((id) => document.getElementById(id));
        const COMPOSITION_TARGET_FPS = 30;
        const state = {
          ready: false,
          sessionId: boot.sessionId,
          eventsWsState: "closed",
          voiceWsState: "closed",
          voiceStreamId: "",
          voiceStreamGeneration: 0,
          transport: {
            events: window.MAB_LAN_OPERATOR_WEBSOCKET.defaultConnection(),
            voice: window.MAB_LAN_OPERATOR_WEBSOCKET.defaultConnection(),
            visual: window.MAB_LAN_OPERATOR_WEBSOCKET.defaultConnection(),
          },
          transportMeta: { surfaceId: boot.sessionId, hostUrl: location.origin },
          webrtcIceServers: Array.isArray(boot.webrtcIceServers) ? boot.webrtcIceServers : [],
          voiceArmed: false,
          voiceMuted: false,
          voiceDeviceId: "",
          voiceDevices: [],
          voiceChunksSent: 0,
          voiceDroppedChunks: 0,
          voice: { activeStreamId: null, activeStreamGeneration: 0, streamOpenCount: 0, staleChunksRejected: 0, lastRejectedStreamId: null, lastReceiveLagMs: null, maxReceiveLagMs: null, receiveLagClock: "client_wall_to_host_wall", ackCount: 0, lastAckSequence: null, lastAckAt: null, lastAckRttMs: null, maxAckRttMs: null, ackClock: "client_send_to_ack_wall" },
          voiceCapture: { mode: "synthetic", status: "idle", errors: [] },
          localVadEnabled: false,
          voiceLocalVad: { enabled: false, role: "disabled", active: false, threshold: 0.02, lastEnergy: null, lastUpdatedAt: null },
          voicePushToTalkActive: false,
          output: {
            assistantText: { deltaCount: 0, completedCount: 0, currentText: "", completedText: "", lastTextAt: null, lastResponseId: null },
            assistantAudio: { enabled: true, status: "idle", chunksReceived: 0, chunksPlayed: 0, bytesReceived: 0, sampleRate: null, channels: null, queuedMs: 0, rms: null, peak: null, lastChunkAt: null, lastPlaybackAt: null, lastError: null },
          },
          toolRouting: {
            expectedTool: null,
            actualTool: null,
            callId: null,
            itemId: null,
            status: "idle",
            argumentsText: "",
            parsedArguments: null,
            functionOutputDelivered: false,
            functionOutput: null,
            argumentSafety: { naturalLanguageInstruction: false, safeTargetHint: false, exposesRawOperations: false, exposesCoordinates: false, ok: false },
            cancel: { requestedCount: 0, lastRequestedAt: null, lastCallId: null, lastJobId: null, lastReason: null, lastResult: null, lastError: null },
            lastUpdatedAt: null,
            errors: [],
            calls: [],
          },
          kwwk: {
            currentJobId: null,
            status: "idle",
            target: {},
            blocker: null,
            latestActionKind: null,
            cursorEventCount: 0,
            actionCount: 0,
            timings: { observeMs: null, planMs: null, executeMs: null, verifyMs: null, totalMs: null },
            verification: { schema: null, ok: null, status: null, reason: null, blocker: null, checkCount: 0, failedCheckCount: 0, checks: [], lastUpdatedAt: null },
            phaseEvidence: {
              observe: { status: null, durationMs: null, summary: null, detail: {}, lastUpdatedAt: null },
              plan: { status: null, durationMs: null, summary: null, detail: {}, lastUpdatedAt: null },
              execute: { status: null, durationMs: null, summary: null, detail: {}, lastUpdatedAt: null },
              verify: { status: null, durationMs: null, summary: null, detail: {}, lastUpdatedAt: null },
            },
            lastUpdatedAt: null,
            actions: [],
          },
          conversation: {
            engineId: "",
            status: "not_connected",
            eventCounts: {},
            canonicalEvents: [],
            provider: { adapterKind: boot.conversationTransport, rawEventDrilldownAvailable: false, latestProviderEventType: null, providerEventCounts: {}, recentEvents: [] },
            lastEventAt: null,
            errors: [],
            control: { inFlight: 0, commandCounts: {}, lastCommand: null, lastCommandAt: null, lastDetail: null, lastResult: null, lastError: null },
          },
          artifacts: { reportCopyCount: 0, reportDownloadCount: 0, interestingMarks: [], largeArtifacts: [], lastReportAt: null, lastReportAction: null },
          timeline: { currentTurnId: null, lastEventAt: null, turns: [], rows: [] },
          sources: boot.sources,
          visual: { transport: "webrtc", connectionState: "not_connected", iceConnectionState: null, peerConnectionState: null, signalingState: null, receiverWebSocketState: "closed", hostPublisherConnections: 0, trackCount: 0 },
          sourceRects: structuredClone(boot.sourceRects),
          focusedSourceId: "host-app",
          layoutRevision: 0,
          overlays: [],
          localComposedStream: null,
          localComposedTrack: null,
          compositionFrameCount: 0,
          compositionLastFrameAt: null,
          compositionLastFrameEpochMs: 0,
          errors: [],
        };
        let eventsWs = null;
        let voiceWs = null;
        let eventsSocketClient = null;
        let voiceSocketClient = null;
        let drag = null;
        let voiceCapture = null;
        let outputClient = null;
        let visualReceiver = null, voiceControls = null, textInputClient = null, artifactClient = null, compositionHeartbeat = null;
        function clamp(value, min, max) {
          return Math.min(max, Math.max(min, value));
        }
        function sendOperatorEvent(message) {
          return Boolean(eventsSocketClient?.send(message));
        }
        function currentTrackState() {
          const stream = state.localComposedStream;
          const track = state.localComposedTrack;
          const settings = track?.getSettings?.() || {};
          const now = performance.now();
          return {
            localComposedTrack: Boolean(track), localComposedStreamId: stream?.id || null,
            trackId: track?.id || null, trackKind: track?.kind || null,
            trackReadyState: track?.readyState || null, trackMuted: Boolean(track?.muted),
            width: Number(settings.width || canvas.width), height: Number(settings.height || canvas.height),
            targetFps: COMPOSITION_TARGET_FPS, renderedFrameCount: state.compositionFrameCount,
            lastRenderedFrameAt: state.compositionLastFrameAt,
            lastRenderedFrameAgeMs: state.compositionLastFrameEpochMs ? Math.max(0, Math.round(now - state.compositionLastFrameEpochMs)) : null,
          };
        }
        function currentComposition() {
          return {
            mode: "operator_side",
            ...currentTrackState(),
            layoutRevision: state.layoutRevision,
            sourceRects: state.sourceRects,
            focusedSourceId: state.focusedSourceId,
            overlayCount: state.overlays.length,
          };
        }
        function emitCompositionState() {
          return sendOperatorEvent({ type: "composition_state", composition: currentComposition() });
        }

        function compactDebugValue(value) {
          if (value == null || value === "") return "-";
          if (typeof value === "number") return Number.isFinite(value) ? String(Math.round(value * 100) / 100) : "-";
          if (typeof value === "boolean") return value ? "yes" : "no";
          if (typeof value === "string") return value;
          try {
            return JSON.stringify(value);
          } catch {
            return String(value);
          }
        }

        function durationLabel(value) {
          return value == null ? "-" : String(Math.round(Number(value))) + "ms";
        }

        function rectLabel(rect) {
          if (!rect) return "-";
          return [
            "x " + Math.round(rect.x * 100) + "%",
            "y " + Math.round(rect.y * 100) + "%",
            "w " + Math.round(rect.width * 100) + "%",
            "h " + Math.round(rect.height * 100) + "%",
          ].join(" / ");
        }

        function replaceTableRows(tbody, rows) {
          tbody.replaceChildren();
          for (const row of rows) {
            const tr = document.createElement("tr");
            for (const cell of row) {
              const td = document.createElement("td");
              if (cell && typeof cell === "object" && "text" in cell) {
                td.textContent = compactDebugValue(cell.text);
                if (cell.className) td.className = cell.className;
              } else {
                td.textContent = compactDebugValue(cell);
              }
              tr.appendChild(td);
            }
            tbody.appendChild(tr);
          }
        }

        function applyDebugFilter() { return window.MAB_LAN_OPERATOR_DEBUG_PANEL.applyFilter({ input: debugFilterInput, status: debugFilterState, json: debugJson }); }

        function renderDebugSections(composition) {
          const transportChannelRows = Object.entries(state.transport || {}).map(([label, connection]) => [
            label,
            connection.state,
            String(connection.reconnectCount || 0) + " / " + String(connection.connectCount || 0),
            (connection.lastPacketAt || "-") + " / " + durationLabel(connection.rttMs),
          ]);
          const transportRows = [
            ["surface", state.transportMeta.surfaceId, "-", state.transportMeta.hostUrl],
            ...transportChannelRows,
          ];
          const reconnects = transportChannelRows.reduce(
            (total, row) => total + Number(String(row[2]).split(" / ")[0] || 0),
            0,
          );
          debugTransportSummary.textContent = "reconnects " + String(reconnects);
          replaceTableRows(debugTransportTable, transportRows.length ? transportRows : [["-", "closed", "0 / 0", "-"]]);

          const capture = state.voiceCapture || {};
          const localVad = state.voiceLocalVad || {};
          debugVoiceSummary.textContent = [
            state.voiceArmed ? "armed" : "idle",
            state.voiceMuted ? "muted" : "open",
            capture.status || "idle",
          ].join(" / ");
          replaceTableRows(debugVoiceTable, [
            ["WebSocket", state.voiceWsState],
            ["Voice reconnects", String(state.transport.voice?.reconnectCount || 0) + " / " + String(state.transport.voice?.connectCount || 0)],
            ["Mic", state.voiceArmed ? "armed" : "idle"],
            ["Mute", state.voiceMuted ? "muted" : "open"],
            ["Capture mode", capture.mode || "unknown"],
            ["Permission", capture.permissionState],
            ["Device", capture.deviceLabel || capture.deviceId || "default"],
            ["Devices", state.voiceDevices.length || capture.availableDeviceCount || 0],
            ["Energy", capture.lastEnergy],
            ["Local VAD", localVad.enabled ? (localVad.active ? "active" : "quiet") : "disabled"],
            ["Chunks/drops", String(state.voiceChunksSent) + " / " + String(state.voiceDroppedChunks)],
            ["Host chunks/gaps", String(state.voice.chunksReceived || 0) + " / " + String(state.voice.dropsDetected || 0)],
            ["Voice stream", String(state.voice.activeStreamGeneration || state.voiceStreamGeneration) + " / stale " + String(state.voice.staleChunksRejected || 0)],
            ["Host receive lag", durationLabel(state.voice.lastReceiveLagMs)],
            ["Voice ACK RTT", durationLabel(state.voice.lastAckRttMs)],
          ]);

          const timelineRows = state.timeline.rows.slice(-16).reverse().map((row) => [
            row.layer,
            row.event,
            durationLabel(row.durationMs),
            {
              text: row.ok ? (row.blocker || "ok") : (row.blocker || "blocked"),
              className: row.ok ? "debug-ok" : "debug-bad",
            },
          ]);
          debugTimelineCount.textContent = String(state.timeline.rows.length) + " rows";
          replaceTableRows(debugTimelineTable, timelineRows.length ? timelineRows : [["-", "waiting", "-", "idle"]]);

          window.MAB_LAN_OPERATOR_DEBUG_PANEL.renderTurnsAndConversation({
            state,
            boot,
            debugTurnCount,
            debugTurnTable,
            debugTurnTimelineSummary,
            debugTurnTimelineTable,
            debugConversationSummary,
            debugConversationTable,
            debugPortSummary,
            debugPortTable,
            debugProviderDrilldownSummary,
            debugProviderDrilldownTable,
            durationLabel,
            replaceTableRows,
          });

          window.MAB_LAN_OPERATOR_DEBUG_PANEL.renderToolAndKwwk({ state, debugToolRoutingSummary, debugToolRoutingTable, debugKwwkSummary, debugKwwkTable, replaceTableRows });

          debugVisualSummary.textContent = state.visual.connectionState + " / " + String(state.visual.trackCount || 0) + " tracks";
          replaceTableRows(debugCompositionTable, [
            ["Mode", composition.mode],
            ["Track", composition.localComposedTrack ? String(composition.trackReadyState || "track") : "missing"],
            ["Track id", composition.trackId],
            ["Canvas", String(composition.width) + "x" + String(composition.height) + " @" + String(composition.targetFps) + "fps"],
            ["Frame age", durationLabel(composition.lastRenderedFrameAgeMs)],
            ["Focused source", composition.focusedSourceId],
          ]);
          replaceTableRows(debugVisualSourceTable, state.sources.map((source) => [
            source.label + " / " + source.id,
            source.state + " / " + String(source.sourceMode || "-") +
              " / " + String(source.captureStatus || "-"),
            source.trackId || source.trackReadyState || "synthetic",
            source.captureError || rectLabel(state.sourceRects[source.id]),
          ]));
          artifactClient?.render({ summary: debugArtifactSummary, table: debugArtifactTable, replaceTableRows });
        }

        function syncDebug() {
          readyDot.className = "status-dot " + (state.ready ? "ready" : "");
          voiceLabel.textContent = "voice: " + state.voiceWsState;
          visualLabel.textContent = "visual: " + state.visual.connectionState;
          voiceWsNode.textContent = state.voiceWsState;
          transportStateNode.textContent =
            "events " + String(state.transport.events?.state || "-") +
            " / voice " + String(state.transport.voice?.state || "-") +
            " / visual " + String(state.transport.visual?.state || "-");
          voiceChunksNode.textContent = String(state.voiceChunksSent);
          visualTracksNode.textContent = String(state.visual.trackCount || 0);
          const composition = currentComposition();
          compositionNode.textContent = composition.localComposedTrack
            ? String(composition.trackReadyState || "track") + " " +
              String(composition.width) + "x" + String(composition.height) +
              " @" + String(composition.targetFps) + "fps"
            : "no track";
          layoutRevisionNode.textContent = String(state.layoutRevision);
          overlayCountNode.textContent = String(state.overlays.length);
          kwwkJobNode.textContent = state.kwwk.blocker
            ? state.kwwk.status + " " + state.kwwk.blocker
            : state.kwwk.status + " actions:" + String(state.kwwk.actionCount);
          toolRoutingNode.textContent = state.toolRouting.actualTool
            ? String(state.toolRouting.expectedTool || "?") + " -> " +
              String(state.toolRouting.actualTool) + " " +
              String(state.toolRouting.argumentSafety.ok ? "safe" : "check")
            : "idle";
          assistantTextNode.textContent = state.output.assistantText.completedText || state.output.assistantText.currentText || "idle";
          outputAudioNode.textContent = state.output.assistantAudio.status + " " + String(state.output.assistantAudio.chunksPlayed) + "/" + String(state.output.assistantAudio.chunksReceived);
          engineControlNode.textContent = state.conversation.control.lastCommand
            ? state.conversation.control.lastCommand + " " + String(state.conversation.control.lastResult || "sent")
            : "idle";
          artifactNode.textContent = state.artifacts.lastReportAction
            ? state.artifacts.lastReportAction + " marks:" + String(state.artifacts.interestingMarks.length) +
              " copy:" + String(state.artifacts.reportCopyCount) +
              " dl:" + String(state.artifacts.reportDownloadCount) +
              " links:" + String((state.artifacts.largeArtifacts || []).length) +
              " bundles:" + String((state.artifacts.bundles || []).length)
            : "idle";
          const latestTimeline = state.timeline.rows.at(-1);
          timelineNode.textContent = latestTimeline
            ? latestTimeline.layer + " " + latestTimeline.event +
              (latestTimeline.durationMs == null ? "" : " +" + String(latestTimeline.durationMs) + "ms")
            : "idle";
          voiceControls?.update();
          renderDebugSections(composition);
          debugJson.textContent = JSON.stringify({
            sessionId: boot.sessionId,
            conversationTransport: boot.conversationTransport,
            voice: {
              websocketState: state.voiceWsState,
              armed: state.voiceArmed,
              muted: state.voiceMuted,
              chunksSent: state.voiceChunksSent,
              droppedChunks: state.voiceDroppedChunks,
              devices: state.voiceDevices.map((device) => ({
                deviceId: device.deviceId,
                label: device.label,
                groupId: device.groupId,
              })),
              selectedDeviceId: state.voiceDeviceId,
              localVad: state.voiceLocalVad,
              hostReceiveLagMs: state.voice.lastReceiveLagMs,
              maxHostReceiveLagMs: state.voice.maxReceiveLagMs,
              hostReceiveLagClock: state.voice.receiveLagClock,
              voiceAckRttMs: state.voice.lastAckRttMs,
              maxVoiceAckRttMs: state.voice.maxAckRttMs,
              voiceAckClock: state.voice.ackClock,
              capture: state.voiceCapture,
            },
            transport: state.transport,
            transportMeta: state.transportMeta,
            canonicalEvents: state.canonicalEvents || [],
            conversation: state.conversation,
            toolRouting: state.toolRouting,
            kwwk: state.kwwk,
            output: state.output,
            artifacts: state.artifacts,
            timeline: state.timeline,
            visual: {
              transport: "webrtc", connectionState: state.visual.connectionState,
              iceConnectionState: state.visual.iceConnectionState, peerConnectionState: state.visual.peerConnectionState,
              signalingState: state.visual.signalingState, receiverWebSocketState: state.visual.receiverWebSocketState,
              hostPublisherConnections: state.visual.hostPublisherConnections, trackCount: state.visual.trackCount,
              sources: state.sources, composition, overlays: state.overlays.slice(-8),
            },
            errors: state.errors,
          }, null, 2);
          applyDebugFilter();
        }

        function renderSourceControls() {
          sourceList.innerHTML = "";
          sourceTabs.innerHTML = "";
          for (const source of state.sources) {
            const row = document.createElement("button");
            row.type = "button";
            row.className = "source-row";
            row.setAttribute("aria-pressed", source.id === state.focusedSourceId ? "true" : "false");
            row.innerHTML = "<div><strong></strong><span></span></div><span></span>";
            row.querySelector("strong").textContent = source.label;
            row.querySelector("div span").textContent = source.kind;
            row.querySelector(":scope > span").textContent = source.id === state.focusedSourceId ? "focus" : "";
            row.addEventListener("click", () => setFocusedSource(source.id));
            sourceList.appendChild(row);

            const tab = document.createElement("button");
            tab.type = "button";
            tab.className = "btn";
            tab.setAttribute("aria-pressed", source.id === state.focusedSourceId ? "true" : "false");
            tab.textContent = source.label;
            tab.addEventListener("click", () => setFocusedSource(source.id));
            sourceTabs.appendChild(tab);
          }
        }

        function setFocusedSource(sourceId) {
          state.focusedSourceId = sourceId;
          state.layoutRevision += 1;
          renderSourceControls();
          emitCompositionState();
          syncDebug();
        }

        function moveSource(sourceId, rect) {
          const next = {
            x: clamp(Number(rect.x), 0, 0.95),
            y: clamp(Number(rect.y), 0, 0.95),
            width: clamp(Number(rect.width), 0.08, 1),
            height: clamp(Number(rect.height), 0.08, 1),
          };
          next.width = Math.min(next.width, 1 - next.x);
          next.height = Math.min(next.height, 1 - next.y);
          state.sourceRects[sourceId] = next;
          state.focusedSourceId = sourceId;
          state.layoutRevision += 1;
          renderSourceControls();
          emitCompositionState();
          syncDebug();
          return currentComposition();
        }

        function pointToCanvas(event) {
          const rect = canvas.getBoundingClientRect();
          return {
            x: (event.clientX - rect.left) / rect.width,
            y: (event.clientY - rect.top) / rect.height,
          };
        }

        function sourceAt(point) {
          return [...state.sources].reverse().find((source) => {
            const rect = state.sourceRects[source.id];
            return point.x >= rect.x && point.x <= rect.x + rect.width &&
              point.y >= rect.y && point.y <= rect.y + rect.height;
          });
        }

        function emitKwwkOverlay(input = {}) {
          const sourceId = input.sourceId || state.focusedSourceId || "host-app";
          const overlay = {
            id: "overlay_" + Date.now().toString(36),
            sourceId,
            kind: input.kind || "cursor",
            x: clamp(Number(input.x ?? 0.5), 0, 1),
            y: clamp(Number(input.y ?? 0.5), 0, 1),
            label: String(input.label || "KWWK"),
            ts: Date.now(),
          };
          state.overlays.push(overlay);
          state.overlays = state.overlays.slice(-40);
          sendOperatorEvent({ type: "visual_overlay_event", overlay });
          syncDebug();
          return overlay;
        }

        function emitKwwkJobState(input = {}) {
          state.kwwk = {
            ...state.kwwk,
            currentJobId: input.jobId || input.job_id || state.kwwk.currentJobId,
            status: input.status || state.kwwk.status,
            target: { ...state.kwwk.target, ...(input.target || {}) },
            blocker: input.blocker || null,
            latestActionKind: input.latestActionKind || input.action?.kind || state.kwwk.latestActionKind,
            cursorEventCount: state.kwwk.cursorEventCount + Number(input.cursorEventCountDelta || 0),
            actionCount: input.action ? state.kwwk.actionCount + 1 : Number(input.actionCount || state.kwwk.actionCount),
            timings: { ...state.kwwk.timings, ...(input.timings || {}) },
            verification: input.verification ? { ...state.kwwk.verification, ...input.verification, lastUpdatedAt: new Date().toISOString() } : state.kwwk.verification,
            phaseEvidence: input.phaseEvidence ? Object.fromEntries(Object.entries(state.kwwk.phaseEvidence).map(([phase, current]) => [phase, { ...current, ...(input.phaseEvidence[phase] || {}), lastUpdatedAt: input.phaseEvidence[phase] ? new Date().toISOString() : current.lastUpdatedAt }])) : state.kwwk.phaseEvidence,
            lastUpdatedAt: new Date().toISOString(),
            actions: input.action
              ? [
                  ...state.kwwk.actions,
                  {
                    ts: new Date().toISOString(),
                    kind: String(input.action.kind || "action"),
                    label: String(input.action.label || ""),
                    status: String(input.action.status || input.status || "running"),
                    durationMs: input.action.durationMs == null ? null : Number(input.action.durationMs),
                  },
                ].slice(-80)
              : state.kwwk.actions,
          };
          sendOperatorEvent({ type: "kwwk_job_state", kwwk: input });
          syncDebug();
          return state.kwwk;
        }

        function submitToolResult(input = {}) { return sendOperatorEvent({ type: "conversation_tool_result", callId: state.toolRouting.callId, itemId: state.toolRouting.itemId, toolName: state.toolRouting.actualTool, turnId: state.timeline.currentTurnId, responseId: state.output.assistantText.lastResponseId, ...input }); }

        function cancelTool(input = {}) {
          const reason = String(input.reason || "operator_cancelled");
          const callId = String(input.callId || state.toolRouting.callId || "");
          if (!callId) { Object.assign(state.toolRouting.cancel, { lastResult: "failed", lastError: "missing_call_id", lastReason: reason }); syncDebug(); return false; }
          return sendOperatorEvent({ type: "tool_cancel", callId, itemId: input.itemId || state.toolRouting.itemId || "", toolName: input.toolName || state.toolRouting.actualTool || "kwwk_computer_use", jobId: input.jobId || state.kwwk.currentJobId || "", turnId: input.turnId || state.timeline.currentTurnId || "", responseId: input.responseId || state.output.assistantText.lastResponseId || "", reason });
        }

        function openDebugPanel() {
          debugShell.dataset.debugPanelOpened = "true";
          debugShell.scrollIntoView?.({ block: "nearest", inline: "nearest" });
          debugShell.focus?.({ preventScroll: true });
          return true;
        }

        function sendSyntheticVoiceChunk(input = {}) {
          const sequence = Number(input.sequence ?? state.voiceChunksSent + 1);
          const sentAt = new Date().toISOString();
          const payload = {
            type: "voice_chunk",
            sessionId: boot.sessionId,
            sequence,
            voiceStreamId: input.voiceStreamId || input.streamId || state.voiceStreamId || "",
            voiceStreamGeneration: Number(input.voiceStreamGeneration || state.voiceStreamGeneration || 0),
            monotonicMs: performance.now(),
            sentAt,
            sampleRate: Number(input.sampleRate || 24000),
            channels: Number(input.channels || 1),
            durationMs: Number(input.durationMs || 20),
            energy: Number(input.energy ?? 0.16),
            source: String(input.source || "synthetic_pcm16"),
            dataBase64: input.dataBase64 || "AAAAAA==",
          };
          if (!voiceSocketClient?.send(payload)) return false;
          state.voiceChunksSent = Math.max(state.voiceChunksSent, sequence);
          syncDebug();
          return true;
        }

        function recordVoiceChunkAck(payload = {}) {
          const ackAt = new Date().toISOString(), sentAtMs = Date.parse(String(payload.sentAt || ""));
          const ackRttMs = Number.isFinite(sentAtMs) ? Math.max(0, Date.now() - sentAtMs) : null;
          state.voice = { ...state.voice, ackCount: Number(state.voice.ackCount || 0) + 1, lastAckSequence: Number(payload.sequence) || state.voice.lastAckSequence, lastAckAt: ackAt, lastAckRttMs: ackRttMs, maxAckRttMs: ackRttMs == null ? state.voice.maxAckRttMs : Math.max(Number(state.voice.maxAckRttMs || 0), ackRttMs), ackClock: "client_send_to_ack_wall" };
          sendOperatorEvent({ type: "operator_voice_chunk_ack_observed", ack: { ...payload, ackAt, ackRttMs, ackClock: state.voice.ackClock } }); syncDebug();
        }

        function sendEngineControl(type, input = {}) {
          if (type === "cancel_response" || type === "clear_audio_buffer" || type === "reset_session" || type === "disconnect") {
            outputClient?.stopAudio(type);
          }
          Object.assign(state.conversation.control, { lastCommand: type, lastCommandAt: new Date().toISOString(), lastDetail: input.detail || null, lastResult: "sent", lastError: null });
          syncDebug();
          return sendOperatorEvent({
            type: "engine_control",
            control: {
              type,
              reason: input.reason || "operator_debug_panel",
              responseId: input.responseId || state.output.assistantText.lastResponseId || "",
              detail: input.detail || {},
            },
          });
        }

        async function fetchDebugReport() {
          const response = await fetch("/runtime/report", { cache: "no-store" });
          if (!response.ok) throw new Error("debug_report_fetch_failed:" + String(response.status));
          return await response.json();
        }

        async function copyDiagnostics() {
          const body = await fetchDebugReport();
          const report = body.report || body;
          const text = JSON.stringify(report, null, 2);
          try {
            await navigator.clipboard?.writeText?.(text);
          } catch {
            // Headless smoke tests and non-secure LAN origins may not expose clipboard.
          }
          window.__MAB_LAST_COPIED_DIAGNOSTICS = text;
          artifactClient?.record("copy");
          return { ok: true, bytes: text.length, report };
        }

        async function downloadReport() {
          const body = await fetchDebugReport();
          const report = body.report || body;
          const text = JSON.stringify(report, null, 2);
          const filename = "oneesama-local-operator-" + boot.sessionId + "-" + String(Date.now()) + ".json";
          const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
          const link = document.createElement("a");
          link.href = url;
          link.download = filename;
          document.body.appendChild(link);
          link.click();
          link.remove();
          window.setTimeout(() => URL.revokeObjectURL(url), 1000);
          artifactClient?.record("download");
          return { ok: true, filename, bytes: text.length, report };
        }

        async function createDebugBundle(input = {}) {
          const body = await fetchDebugReport();
          const report = body.report || body;
          const text = JSON.stringify(report, null, 2);
          const bundle = artifactClient?.createBundle({
            label: input.label || "Local Operator Debug Bundle",
            href: input.href || null,
            report,
            reportBytes: text.length,
            failureMatrix: input.failureMatrix || report.failureMatrix || null,
            slo: input.slo || report.slo || null,
            sessionId: boot.sessionId,
          });
          return { ok: Boolean(bundle), bundle, report };
        }

        function markInterestingRun(input = {}) {
          artifactClient?.record("mark", {
            label: String(input.label || "interesting"),
            note: String(input.note || ""),
          });
          return state.artifacts;
        }

        function registerArtifactLink(input = {}) {
          return artifactClient?.registerLink(input) || null;
        }

        async function startMicrophone() {
          voiceCapture = voiceCapture || window.MAB_LAN_OPERATOR_AUDIO_CAPTURE.create({
            state,
            getVoiceSocket: () => voiceSocketClient?.socket() || voiceWs,
            sendOperatorEvent,
            syncDebug,
          });
          const result = await voiceCapture.startMicrophone({ deviceId: state.voiceDeviceId });
          sendEngineControl("set_voice_armed", { reason: "operator_armed", detail: { armed: true, muted: state.voiceMuted, captureStatus: state.voiceCapture?.status || "" } });
          void voiceControls?.refreshDevices?.().catch(() => undefined);
          syncDebug();
          return {
            ok: result?.ok === true,
            alreadyStarted: result?.alreadyStarted === true,
            capture: state.voiceCapture,
          };
        }

        async function stopMicrophone(reason = "operator_disarmed") {
          if (!voiceCapture) return { ok: true, skipped: true };
          const result = await voiceCapture.stopMicrophone(reason);
          sendEngineControl("set_voice_armed", { reason, detail: { armed: false, muted: state.voiceMuted, captureStatus: state.voiceCapture?.status || "" } });
          syncDebug();
          return result;
        }

        function setVoiceMuted(muted) {
          voiceCapture = voiceCapture || window.MAB_LAN_OPERATOR_AUDIO_CAPTURE.create({
            state,
            getVoiceSocket: () => voiceSocketClient?.socket() || voiceWs,
            sendOperatorEvent,
            syncDebug,
          });
          const result = voiceCapture.setMuted(muted);
          sendEngineControl("set_voice_muted", { reason: state.voiceMuted ? "operator_muted" : "operator_unmuted", detail: { armed: state.voiceArmed, muted: state.voiceMuted } });
          syncDebug();
          return result;
        }

        function drawSource(source, index) {
          const rect = state.sourceRects[source.id];
          const x = rect.x * canvas.width;
          const y = rect.y * canvas.height;
          const width = rect.width * canvas.width;
          const height = rect.height * canvas.height;
          const focused = source.id === state.focusedSourceId;
          const video = visualReceiver?.sourceVideo(source.id);
          if (video && video.readyState >= 2) {
            ctx.drawImage(video, x, y, width, height);
            visualReceiver?.noteSourceRendered(source.id, video);
          } else {
          const gradient = ctx.createLinearGradient(x, y, x + width, y + height);
          if (source.id === "avatar") {
            gradient.addColorStop(0, "#0f766e");
            gradient.addColorStop(1, "#1d4ed8");
          } else {
            gradient.addColorStop(0, "#111827");
            gradient.addColorStop(1, "#334155");
          }
          ctx.fillStyle = gradient;
          ctx.fillRect(x, y, width, height);
          }
          ctx.strokeStyle = focused ? "#93c5fd" : "#64748b";
          ctx.lineWidth = focused ? 4 : 2;
          ctx.strokeRect(x, y, width, height);
          ctx.fillStyle = "rgba(255,255,255,0.92)";
          ctx.font = "600 24px system-ui, sans-serif";
          ctx.fillText(source.label, x + 24, y + 42);
          ctx.fillStyle = "rgba(255,255,255,0.68)";
          ctx.font = "15px system-ui, sans-serif";
          ctx.fillText(source.kind + " source " + String(index + 1), x + 24, y + 70);
        }

        function drawOverlays() {
          const now = Date.now();
          for (const overlay of state.overlays) {
            const rect = state.sourceRects[overlay.sourceId];
            if (!rect) continue;
            const age = now - overlay.ts;
            const alpha = clamp(1 - age / 3000, 0.18, 1);
            const x = (rect.x + overlay.x * rect.width) * canvas.width;
            const y = (rect.y + overlay.y * rect.height) * canvas.height;
            ctx.save();
            ctx.globalAlpha = alpha;
            ctx.strokeStyle = "#facc15";
            ctx.fillStyle = "#facc15";
            ctx.lineWidth = 4;
            ctx.beginPath();
            ctx.arc(x, y, 18, 0, Math.PI * 2);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(x - 28, y);
            ctx.lineTo(x + 28, y);
            ctx.moveTo(x, y - 28);
            ctx.lineTo(x, y + 28);
            ctx.stroke();
            ctx.font = "700 14px system-ui, sans-serif";
            ctx.fillText(overlay.label, x + 24, y - 18);
            ctx.restore();
          }
        }

        function render() {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.fillStyle = "#0f172a";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          state.sources.forEach(drawSource);
          drawOverlays();
          state.compositionFrameCount += 1;
          state.compositionLastFrameAt = new Date().toISOString();
          state.compositionLastFrameEpochMs = performance.now();
          requestAnimationFrame(render);
        }

        function mergeTransportSnapshot(serverTransport) {
          state.transport = state.transport || {};
          for (const [label, remoteConnection] of Object.entries(serverTransport || {})) {
            if (!state.transport[label]) {
              state.transport[label] = window.MAB_LAN_OPERATOR_WEBSOCKET.defaultConnection();
            }
            const localConnection = state.transport[label];
            const localState = String(localConnection.state || "closed");
            const remoteState = String(remoteConnection.state || "closed");
            Object.assign(localConnection, {
              ...remoteConnection,
              connectCount: Math.max(Number(localConnection.connectCount) || 0, Number(remoteConnection.connectCount) || 0),
              reconnectCount: Math.max(Number(localConnection.reconnectCount) || 0, Number(remoteConnection.reconnectCount) || 0),
              rttMs: localConnection.rttMs ?? remoteConnection.rttMs ?? null,
              nextReconnectAt: localConnection.nextReconnectAt || remoteConnection.nextReconnectAt || null,
              state:
                (localState === "reconnecting" || localState === "connecting") && remoteState === "closed"
                  ? localState
                  : remoteState,
            });
          }
        }

        function handleEventsMessage(payload) {
          if (payload.type === "canonical_conversation_event" && payload.event) {
            state.canonicalEvents = [...(state.canonicalEvents || []), payload.event].slice(-60);
            outputClient?.handleCanonicalEvent(payload.event);
          }
          if (payload.debug?.transport) mergeTransportSnapshot(payload.debug.transport);
          if (payload.debug?.voice) state.voice = { ...state.voice, ...payload.debug.voice };
          const conversation = payload.debug?.conversation;
          if (conversation) state.conversation = { ...state.conversation, ...conversation, control: { ...state.conversation.control, ...(conversation.control || {}) } };
          if (payload.debug?.artifacts) state.artifacts = payload.debug.artifacts;
          if (payload.debug?.timeline) state.timeline = payload.debug.timeline;
          if (payload.debug?.kwwk) state.kwwk = payload.debug.kwwk;
          if (payload.debug?.toolRouting) state.toolRouting = payload.debug.toolRouting;
          syncDebug();
        }

        function waitForOpen(client, timeoutMs = 1600) {
          return new Promise((resolve) => {
            const startedAt = performance.now();
            const timer = window.setInterval(() => {
              if (client.state().state === "open" || performance.now() - startedAt > timeoutMs) {
                window.clearInterval(timer);
                resolve(client);
              }
            }, 25);
          });
        }

        canvas.addEventListener("pointerdown", (event) => {
          const point = pointToCanvas(event);
          const source = sourceAt(point);
          if (!source) return;
          const rect = state.sourceRects[source.id];
          state.focusedSourceId = source.id;
          const resize = point.x > rect.x + rect.width - 0.04 && point.y > rect.y + rect.height - 0.04;
          drag = { sourceId: source.id, origin: point, start: { ...rect }, resize };
          canvas.setPointerCapture(event.pointerId);
          renderSourceControls();
        });

        canvas.addEventListener("pointermove", (event) => {
          if (!drag) return;
          const point = pointToCanvas(event);
          const dx = point.x - drag.origin.x;
          const dy = point.y - drag.origin.y;
          const next = drag.resize
            ? {
                ...drag.start,
                width: drag.start.width + dx,
                height: drag.start.height + dy,
              }
            : {
                ...drag.start,
                x: drag.start.x + dx,
                y: drag.start.y + dy,
              };
          moveSource(drag.sourceId, next);
        });

        canvas.addEventListener("pointerup", () => {
          drag = null;
        });

        document.getElementById("overlay-button").addEventListener("click", () => {
          emitKwwkOverlay({ kind: "click", label: "KWWK", x: 0.5, y: 0.5 });
        });
        document.getElementById("cancel-response-button").addEventListener("click", () => {
          sendEngineControl("cancel_response");
        });
        document.getElementById("cancel-tool-button").addEventListener("click", () => {
          cancelTool();
        });
        document.getElementById("clear-audio-button").addEventListener("click", () => {
          sendEngineControl("clear_audio_buffer");
        });
        document.getElementById("reset-session-button").addEventListener("click", () => {
          sendEngineControl("reset_session");
        });
        document.getElementById("open-debug-panel-button").addEventListener("click", openDebugPanel);
        document.getElementById("copy-debug-button").addEventListener("click", () => {
          void copyDiagnostics().catch((error) => {
            state.errors.push(String(error?.message || error));
            syncDebug();
          });
        });
        document.getElementById("download-report-button").addEventListener("click", () => {
          void downloadReport().catch((error) => {
            state.errors.push(String(error?.message || error));
            syncDebug();
          });
        });
        document.getElementById("mark-run-button").addEventListener("click", () => {
          markInterestingRun({ label: "operator_mark" });
        });
        debugFilterInput.addEventListener("input", () => applyDebugFilter());
        debugFilterClearButton.addEventListener("click", () => { debugFilterInput.value = ""; applyDebugFilter(); });
        voiceControls = window.MAB_LAN_OPERATOR_VOICE_CONTROLS.create({ state, sendOperatorEvent, syncDebug, startMicrophone, stopMicrophone, setVoiceMuted });
        voiceControls.bind();
        textInputClient = window.MAB_LAN_OPERATOR_TEXT_INPUT.create({ state, boot, sendOperatorEvent, syncDebug });
        artifactClient = window.MAB_LAN_OPERATOR_ARTIFACTS.create({ state, sendOperatorEvent, syncDebug });

        (async () => {
          try {
            renderSourceControls();
            voiceControls.renderDeviceOptions();
            render();
            const stream = canvas.captureStream ? canvas.captureStream(COMPOSITION_TARGET_FPS) : null;
            state.localComposedStream = stream;
            state.localComposedTrack = stream?.getVideoTracks?.()[0] || null;
            const emitTrackState = () => { emitCompositionState(); syncDebug(); };
            state.localComposedTrack?.addEventListener?.("ended", emitTrackState);
            state.localComposedTrack?.addEventListener?.("mute", emitTrackState); state.localComposedTrack?.addEventListener?.("unmute", emitTrackState);
            outputClient = window.MAB_LAN_OPERATOR_OUTPUT.create({ state, sendOperatorEvent, syncDebug });
            eventsSocketClient = window.MAB_LAN_OPERATOR_WEBSOCKET.create({
              state,
              label: "events",
              path: "/operator/events/ws",
              onState: (connection) => { state.eventsWsState = connection.state; },
              onOpen: (client) => {
                eventsWs = client.socket();
                client.send({ type: "operator_surface_connected" });
              },
              onMessage: handleEventsMessage,
              onError: () => state.errors.push("events_websocket_error"),
              syncDebug,
            });
            eventsSocketClient.connect();
            await waitForOpen(eventsSocketClient);
            visualReceiver = window.MAB_LAN_OPERATOR_VISUAL_RECEIVER.create({ state, sendOperatorEvent, syncDebug, renderSourceControls });
            visualReceiver.connect();
            voiceSocketClient = window.MAB_LAN_OPERATOR_WEBSOCKET.create({
              state,
              label: "voice",
              path: "/operator/voice/ws",
              onState: (connection) => { state.voiceWsState = connection.state; },
              onOpen: (client) => {
                voiceWs = client.socket();
                state.voiceStreamGeneration += 1;
                state.voiceStreamId = "voice_stream_" + Date.now().toString(36) + "_" + String(state.voiceStreamGeneration);
                client.send({ type: "operator_voice_stream_opened", voiceStreamId: state.voiceStreamId, voiceStreamGeneration: state.voiceStreamGeneration, openedAt: new Date().toISOString() });
              },
              onMessage: (payload) => {
                if (payload.type === "operator_voice_chunk_ack") recordVoiceChunkAck(payload);
              },
              onError: () => state.errors.push("voice_websocket_error"),
              syncDebug,
            });
            voiceSocketClient.connect();
            await waitForOpen(voiceSocketClient);
            void voiceControls.refreshDevices().catch(() => undefined);
            compositionHeartbeat = window.setInterval(() => {
              emitCompositionState();
              syncDebug();
            }, 1000);
            emitCompositionState();
            state.ready = true;
            syncDebug();
          } catch (error) {
            state.errors.push(String(error?.message || error));
            readyDot.className = "status-dot bad";
            syncDebug();
          }
        })();

        window.MAB_LAN_OPERATOR_SURFACE = {
          state, moveSource, setFocusedSource, emitKwwkOverlay, sendSyntheticVoiceChunk,
          emitKwwkJobState, submitToolResult, cancelTool, sendEngineControl, fetchDebugReport, copyDiagnostics, downloadReport,
          createDebugBundle, markInterestingRun, registerArtifactLink, openDebugPanel, currentComposition, startMicrophone, stopMicrophone, setVoiceMuted,
          setDebugFilter: (query) => { debugFilterInput.value = String(query || ""); return applyDebugFilter(); },
          getDebugFilter: () => applyDebugFilter(),
          refreshVoiceDevices: () => voiceControls?.refreshDevices(),
          configureLocalVad: (enabled) => voiceControls?.configureLocalVad(enabled), sendTextInput: (text) => textInputClient?.sendText(text),
          setAudioEnabled: (enabled) => outputClient?.setAudioEnabled(enabled),
          getComposedVideoTrack: () => state.localComposedTrack, outputClient: () => outputClient,
          forceCloseTransport: (label) => {
            if (label === "events") return eventsSocketClient?.socket()?.close();
            if (label === "voice") return voiceSocketClient?.socket()?.close();
            return false;
          },
          visualReceiver: () => visualReceiver,
        };
      })();
    </script>
  </body>
</html>`;
}
