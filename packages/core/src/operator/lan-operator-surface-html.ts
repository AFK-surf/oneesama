/* eslint-disable max-lines */
import type { AvatarRuntimeSessionConfig } from "../avatar-runtime/contracts.ts";
import { DEFAULT_SOURCE_RECTS } from "./lan-operator-debug-state.ts";
import { buildLanOperatorArtifactClientScript } from "./lan-operator-artifact-client.ts";
import { buildLanOperatorDebugPanelClientScript } from "./lan-operator-debug-panel-client.ts";
import { buildLanOperatorKwwkCursorClientScript } from "./lan-operator-kwwk-cursor-client.ts";
import { buildLanOperatorOutputClientScript } from "./lan-operator-output-client.ts";
import { buildLanOperatorTextInputClientScript } from "./lan-operator-text-input-client.ts";
import { buildLanOperatorVoiceControlsClientScript } from "./lan-operator-voice-controls-client.ts";
import { buildLanOperatorVoiceClientScript } from "./lan-operator-voice-client.ts";
import { buildLanOperatorVisualClientScript } from "./lan-operator-visual-client.ts";
import { buildLanOperatorWebSocketClientScript } from "./lan-operator-websocket-client.ts";
import type { LanOperatorLiveProviderConfig } from "./lan-operator-live-provider-config.ts";
function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
export function buildLanOperatorSurfaceHtml(
  config: Readonly<AvatarRuntimeSessionConfig>,
  options: { liveProviderConfig?: LanOperatorLiveProviderConfig } = {},
) {
  const webrtcIceServers = Array.isArray(
    (config.renderer as { webrtcIceServers?: unknown } | undefined)?.webrtcIceServers,
  )
    ? (config.renderer as { webrtcIceServers: unknown[] }).webrtcIceServers
    : [];
  const boot = JSON.stringify({
    sessionId: config.sessionId,
    botName: config.botName,
    conversationTransport: config.conversationTransport,
    liveProviderConfig: options.liveProviderConfig || null,
    webrtcIceServers,
    sources: [
      { id: "host-app", label: "App view", kind: "desktop_app", state: "synthetic" },
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
    debugPanelClientSource = buildLanOperatorDebugPanelClientScript(),
    kwwkCursorClientSource = buildLanOperatorKwwkCursorClientScript();
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root {
        color-scheme: light;
        /* calm light tokens */
        --background: #eef0f4;
        --surface: #ffffff;
        --panel: #ffffff;
        --panel-2: #f5f6f8;
        --elevated: #ffffff;
        --elevated-2: #f1f2f5;
        --ink: #1b1d22;
        --muted: #5b606b;
        --faint: #969ba6;
        --line: #e4e6ea;
        --line-2: #d4d7dd;
        --accent: #0f9d6e;
        --accent-ink: #ffffff;
        --blue: #2f6df0;
        --ok: #0f9d6e;
        --warn: #c47d12;
        --bad: #d6453d;
        --ring: color-mix(in srgb, var(--accent) 45%, transparent);
        --radius: 12px;
        --radius-sm: 8px;
        --shadow-sm: 0 1px 2px rgba(24,28,40,0.06), 0 1px 1px rgba(24,28,40,0.04);
        --shadow-md: 0 8px 24px rgba(24,28,40,0.10), 0 2px 6px rgba(24,28,40,0.06);
        --stage-bg: #f1f3f6;
        --glass: rgba(255,255,255,0.82);
        --mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
        --sans: "Inter", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      * { box-sizing: border-box; }
      /* The hidden attribute must always win, even over class display rules
         (e.g. .btn sets display:inline-flex, which would otherwise show a
         hidden Connect/Disconnect button). */
      [hidden] { display: none !important; }
      ::selection { background: color-mix(in srgb, var(--accent) 24%, transparent); }
      html, body { height: 100%; }
      body {
        margin: 0; color: var(--ink); font-family: var(--sans);
        font-size: 13px; -webkit-font-smoothing: antialiased; letter-spacing: 0.1px;
        background:
          radial-gradient(1200px 620px at 84% -16%, color-mix(in srgb, var(--accent) 7%, transparent), transparent 60%),
          radial-gradient(900px 520px at 6% 112%, color-mix(in srgb, var(--blue) 6%, transparent), transparent 58%),
          var(--background);
      }
      button, select, input { font: inherit; font-size: 12px; color: var(--ink); }
      ::-webkit-scrollbar { width: 11px; height: 11px; }
      ::-webkit-scrollbar-thumb { background: var(--line-2); border-radius: 99px; border: 3px solid transparent; background-clip: padding-box; }
      ::-webkit-scrollbar-thumb:hover { background: #b9bdc6; background-clip: padding-box; }

      /* ----- app shell: fixed viewport height, panels scroll internally ----- */
      .app { display: grid; grid-template-rows: auto minmax(0, 1fr); height: 100vh; }
      header {
        display: flex; align-items: center; justify-content: space-between; gap: 16px;
        height: 48px; padding: 0 16px;
        border-bottom: 1px solid var(--line);
        background: color-mix(in srgb, var(--surface) 88%, transparent);
        backdrop-filter: blur(16px) saturate(120%);
      }
      header > div { display: flex; align-items: center; gap: 12px; min-width: 0; }
      h1 { margin: 0; font-size: 13.5px; font-weight: 660; line-height: 1.2; letter-spacing: 0.2px; white-space: nowrap; color: var(--ink); }
      .topline { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
      .topline span[id$="-label"] { display: inline-flex; align-items: center; gap: 6px; padding: 3px 9px; border: 1px solid var(--line); border-radius: 99px; background: var(--panel-2); white-space: nowrap; }
      #session-label { font-family: var(--mono); font-size: 10.5px; color: var(--faint); border: 0; background: none; padding: 0; }
      .status-dot { width: 7px; height: 7px; border-radius: 99px; display: inline-block; background: var(--warn); box-shadow: 0 0 0 3px color-mix(in srgb, var(--warn) 16%, transparent); }
      .status-dot.ready { background: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent); }
      .status-dot.bad { background: var(--bad); box-shadow: 0 0 0 3px color-mix(in srgb, var(--bad) 18%, transparent); }

      main { display: grid; gap: 12px; padding: 12px; min-height: 0; overflow: hidden; }
      main[data-dock="right"] { grid-template-columns: minmax(0, 1fr) 12px var(--dock-w, clamp(340px, 27vw, 440px)); grid-template-rows: minmax(0, 1fr); }
      main[data-dock="bottom"] { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) 12px var(--dock-h, 38vh); }
      main[data-dock="hidden"] { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); }
      main[data-dock="hidden"] .dock-splitter, main[data-dock="hidden"] .debug-shell { display: none; }
      /* Clean mode (debug hidden): drop the secondary control strip; header bar,
         stage, and the mic bar stay — still grounded, no floating overlays. */
      main[data-dock="hidden"] .control-dock { display: none; }
      .dock-splitter { position: relative; align-self: stretch; justify-self: stretch; background: transparent; }
      main[data-dock="right"] .dock-splitter { cursor: col-resize; }
      main[data-dock="bottom"] .dock-splitter { cursor: row-resize; }
      .dock-splitter::before { content: ""; position: absolute; inset: 0; margin: auto; background: var(--line-2); border-radius: 99px; transition: background .12s ease; }
      main[data-dock="right"] .dock-splitter::before { width: 3px; height: 40px; }
      main[data-dock="bottom"] .dock-splitter::before { height: 3px; width: 40px; }
      .dock-splitter:hover::before, .dock-splitter:focus-visible::before { background: var(--accent); }
      .dock-controls { display: inline-flex; align-items: center; gap: 3px; margin-left: auto; }
      .dock-btn { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border: 1px solid var(--line-2); border-radius: 7px; background: var(--surface); color: var(--muted); cursor: pointer; font-size: 11px; line-height: 1; }
      .dock-btn:hover { background: var(--elevated-2); color: var(--ink); }
      .dock-btn[aria-pressed="true"] { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 50%, transparent); background: color-mix(in srgb, var(--accent) 10%, var(--surface)); }
      .dock-summon { position: fixed; right: 16px; bottom: 16px; z-index: 20; display: inline-flex; align-items: center; gap: 8px; padding: 9px 13px; border: 1px solid var(--line-2); border-radius: 99px; background: var(--glass); backdrop-filter: blur(12px); color: var(--muted); font-family: var(--mono); font-size: 11px; cursor: pointer; box-shadow: var(--shadow-md); }
      .dock-summon[hidden] { display: none; }
      .dock-summon:hover { border-color: #c2c6cd; color: var(--ink); }
      .dock-summon-dot { width: 8px; height: 8px; border-radius: 99px; background: var(--accent); flex: 0 0 auto; }
      .dock-summon-dot.warn { background: var(--warn); }
      .dock-summon-dot.bad { background: var(--bad); }
      .dock-summon-cue { color: var(--faint); font-size: 9.5px; }

      .stage-shell, .debug-shell {
        min-height: 0; background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius);
        overflow: hidden; box-shadow: var(--shadow-md);
      }
      .stage-shell { display: flex; flex-direction: column; }

      /* ----- buttons / inputs ----- */
      .btn {
        display: inline-flex; align-items: center; justify-content: center; gap: 6px; white-space: nowrap;
        border: 1px solid var(--line-2); border-radius: var(--radius-sm); background: var(--surface); color: var(--ink);
        height: 30px; padding: 0 12px; cursor: pointer; font-weight: 540; box-shadow: var(--shadow-sm);
        transition: background .12s ease, border-color .12s ease, transform .04s ease, color .12s ease;
      }
      .btn:hover { background: var(--elevated-2); border-color: #c2c6cd; }
      .btn:active { transform: translateY(1px); }
      .btn.primary {
        border-color: transparent; background: var(--accent); color: var(--accent-ink); font-weight: 640;
        box-shadow: 0 1px 2px color-mix(in srgb, var(--accent) 30%, transparent), 0 6px 16px color-mix(in srgb, var(--accent) 24%, transparent);
      }
      .btn.primary:hover { background: color-mix(in srgb, var(--accent) 90%, black); border-color: transparent; }
      .btn.danger { border-color: color-mix(in srgb, var(--bad) 45%, transparent); color: var(--bad); background: color-mix(in srgb, var(--bad) 6%, var(--surface)); }
      .btn.danger:hover { background: color-mix(in srgb, var(--bad) 12%, var(--surface)); border-color: var(--bad); }
      .btn:disabled { cursor: not-allowed; opacity: 0.45; box-shadow: none; }
      .btn[aria-pressed="true"] { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 50%, transparent); background: color-mix(in srgb, var(--accent) 10%, var(--surface)); }
      :is(button, input, select):focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
      select, .voice-device { height: 30px; max-width: 168px; border: 1px solid var(--line-2); border-radius: var(--radius-sm); background: var(--surface); color: var(--ink); padding: 0 9px; box-shadow: var(--shadow-sm); }
      .checkbox-control { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 10px; border: 1px solid var(--line-2); border-radius: var(--radius-sm); background: var(--surface); color: var(--muted); font-size: 11px; user-select: none; cursor: pointer; box-shadow: var(--shadow-sm); }
      .checkbox-control input { accent-color: var(--accent); }
      .energy-wrap { display: inline-flex; align-items: center; gap: 7px; height: 30px; padding: 0 10px; border: 1px solid var(--line-2); border-radius: var(--radius-sm); background: var(--surface); box-shadow: var(--shadow-sm); }
      .energy-meter { width: 56px; height: 6px; border-radius: 99px; overflow: hidden; background: var(--line-2); }
      .energy-meter span { display: block; width: 0%; height: 100%; background: linear-gradient(90deg, var(--accent), #34d399); transition: width .1s linear; }
      .energy-label { min-width: 30px; color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; font-family: var(--mono); text-align: right; }
      .toolbar-group { display: flex; align-items: center; gap: 7px; min-width: 0; }
      .toolbar-divider { width: 1px; align-self: stretch; margin: 4px 1px; background: var(--line-2); }
      .dock-label { font-size: 9px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: var(--faint); white-space: nowrap; }

      /* ----- stage: attached header bar + canvas + attached mic bar (all grounded) ----- */
      .stage-topbar {
        flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 12px;
        padding: 9px 12px; border-bottom: 1px solid var(--line);
        background: var(--panel-2);
      }
      .source-tabs { display: flex; gap: 3px; padding: 3px; border-radius: 10px; border: 1px solid var(--line); background: var(--surface); box-shadow: var(--shadow-sm); }
      .source-tabs button { height: 26px; padding: 0 12px; border: 0; border-radius: 7px; background: transparent; color: var(--muted); font-weight: 560; cursor: pointer; transition: background .12s ease, color .12s ease; }
      .source-tabs button:hover { color: var(--ink); background: var(--elevated-2); }
      .source-tabs button[aria-pressed="true"] { color: #1a44b8; background: color-mix(in srgb, var(--blue) 14%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--blue) 30%, transparent); }
      .stage-hud { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 5px 12px; font-family: var(--mono); font-size: 10px; color: var(--muted); }
      .hud-chip { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; font-variant-numeric: tabular-nums; }
      .hud-chip b { color: var(--ink); font-weight: 600; }
      .hud-dot { width: 6px; height: 6px; border-radius: 99px; background: var(--faint); flex: 0 0 auto; }
      .hud-chip.ok .hud-dot { background: var(--ok); }
      .hud-chip.warn .hud-dot { background: var(--warn); }
      .hud-chip.bad .hud-dot { background: var(--bad); }

      .stage-grid { flex: 1 1 auto; min-height: 0; display: grid; grid-template-columns: 1fr; }
      .canvas-wrap { position: relative; min-width: 0; min-height: 0; display: grid; place-items: center; padding: 14px; overflow: hidden; background: var(--stage-bg); }
      canvas { aspect-ratio: 16 / 9; max-width: 100%; max-height: 100%; width: auto; height: auto; border-radius: 12px; border: 1px solid var(--line-2); background: #0c0e12; box-shadow: var(--shadow-md); touch-action: none; }

      /* attached mic bar (grounded footer of the stage) */
      .stage-controls {
        flex: 0 0 auto; display: flex; align-items: center; flex-wrap: wrap; justify-content: center; gap: 7px;
        padding: 9px 12px; border-top: 1px solid var(--line);
        background: var(--panel-2);
      }
      .voice-tools { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; justify-content: center; }
      .voice-tools .dock-label { margin-right: 1px; }

      /* ----- secondary control strip (below stage, hidden in clean mode) ----- */
      .control-dock {
        flex: 0 0 auto; display: flex; flex-wrap: wrap; align-items: center; gap: 7px 10px;
        padding: 8px 14px; border-top: 1px solid var(--line);
        background: var(--surface);
      }
      .dock-group { display: flex; align-items: center; gap: 7px; }
      .dock-group + .dock-group { padding-left: 10px; border-left: 1px solid var(--line); }
      .dock-grow { flex: 1 1 0; min-width: 0; }
      .dock-status { min-width: 0; max-width: 220px; font-size: 10.5px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      /* darker than the token colors so small status text stays readable (AA) on the light panels */
      .dock-status.ok { color: #0a7a52; }
      .dock-status.warn { color: #9a6310; }
      .dock-status.bad { color: #b5322b; }
      .control-dock .btn { height: 28px; padding: 0 10px; }
      .diagnostic-menu { display: flex; align-items: center; gap: 7px; }
      .diagnostic-menu[open] { flex: 1 1 100%; flex-wrap: wrap; padding-top: 4px; }
      .diagnostic-menu > summary { list-style: none; }
      .diagnostic-menu > summary::-webkit-details-marker { display: none; }
      .diagnostic-popover { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; min-width: 0; }

      /* ----- debug dock ----- */
      .debug-shell { display: flex; flex-direction: column; }
      .debug-body { flex: 1; overflow: hidden; min-height: 0; padding: 12px; display: flex; flex-direction: column; gap: 12px; }
      .debug-panel-bar { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      .debug-tablist { display: inline-flex; gap: 3px; padding: 3px; border-radius: 10px; background: var(--panel-2); border: 1px solid var(--line); }
      .debug-tab { border: 0; border-radius: 7px; background: transparent; color: var(--muted); height: 28px; padding: 0 13px; cursor: pointer; font-size: 11.5px; font-weight: 580; }
      .debug-tab:hover { background: var(--elevated-2); color: var(--ink); }
      .debug-tab[aria-selected="true"] { color: var(--ink); background: var(--surface); box-shadow: var(--shadow-sm); }
      .tabpanel[hidden] { display: none; }

      /* ----- realtime conversation (primary ledger view) ----- */
      .conversation-panel { flex: 1 1 60%; min-height: 220px; display: flex; flex-direction: column; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); overflow: hidden; }
      .conversation-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 11px 14px; border-bottom: 1px solid var(--line); }
      .conversation-title { font-size: 12.5px; font-weight: 660; letter-spacing: 0.1px; color: var(--ink); }
      .conversation-meta { font-size: 10px; color: var(--faint); font-family: var(--mono); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .verdict-strip { display: flex; align-items: center; flex-wrap: wrap; gap: 7px 10px; padding: 8px 14px; border-bottom: 1px solid var(--line); }
      .verdict-strip:empty { display: none; }
      .verdict-badge { font-family: var(--mono); font-size: 10px; font-weight: 700; letter-spacing: 0.02em; padding: 2px 9px; border-radius: 6px; white-space: nowrap; color: var(--muted); background: var(--panel-2); }
      .verdict-badge.ok { color: #0a7a52; background: #e4f6ee; }
      .verdict-badge.warn { color: #9a6310; background: #fcf1dc; }
      .verdict-badge.bad { color: #b5322b; background: #fbe6e4; }
      .verdict-pipeline { display: flex; align-items: center; gap: 3px; flex-wrap: wrap; }
      .stage { display: inline-flex; align-items: center; gap: 5px; font-family: var(--mono); font-size: 9.5px; color: var(--faint); padding: 1px 6px; border-radius: 99px; }
      .stage::before { content: ""; width: 6px; height: 6px; border-radius: 99px; background: var(--faint); flex: 0 0 auto; }
      .stage.ok { color: #0a7a52; } .stage.ok::before { background: var(--ok); }
      .stage.warn { color: #9a6310; } .stage.warn::before { background: var(--warn); }
      .stage.bad { color: #b5322b; background: color-mix(in srgb, var(--bad) 10%, transparent); } .stage.bad::before { background: var(--bad); }
      .stage-arrow { color: var(--line-2); font-size: 10px; }
      .verdict-next { font-size: 10px; color: var(--muted); font-family: var(--mono); }
      .verdict-next b { color: var(--ink); font-weight: 600; }
      .verdict-pipeline .stage { cursor: pointer; }
      .verdict-pipeline .stage:hover { background: var(--elevated-2); color: var(--ink); }
      .cockpit-strip { display: flex; flex-wrap: wrap; align-items: center; gap: 5px 14px; padding: 7px 14px; border-bottom: 1px solid var(--line); color: var(--faint); }
      .cockpit-strip:empty { display: none; }
      .cockpit-chip { display: inline-flex; align-items: center; gap: 6px; font-family: var(--mono); font-variant-numeric: tabular-nums; font-size: 10px; color: var(--muted); white-space: nowrap; }
      .cockpit-dot { width: 6px; height: 6px; border-radius: 99px; background: var(--faint); flex: 0 0 auto; }
      .cockpit-chip.ok .cockpit-dot { background: var(--ok); }
      .cockpit-chip.running .cockpit-dot { background: var(--blue); }
      .cockpit-chip.error { color: var(--bad); }
      .cockpit-chip.error .cockpit-dot { background: var(--bad); }
      .conversation-stream { flex: 1; min-height: 0; overflow: auto; padding: 6px 0; }
      .conversation-empty { color: var(--faint); font-size: 12.5px; text-align: center; padding: 40px 22px; line-height: 1.6; }

      /* conversation rows as a clean chat/log */
      .tl-row { display: flex; flex-direction: column; gap: 4px; width: 100%; text-align: left; background: transparent; border: 0; border-left: 2px solid transparent; padding: 9px 14px 9px 12px; color: var(--ink); cursor: pointer; transition: background .1s ease; }
      .tl-row:hover, .tl-row.open { background: var(--panel-2); }
      .tl-main { display: flex; align-items: center; gap: 9px; }
      .tl-chip { flex: 0 0 auto; min-width: 58px; font-family: var(--mono); font-size: 8.5px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; padding: 2px 8px; border-radius: 99px; background: var(--panel-2); color: var(--muted); text-align: center; }
      .tl-summary { flex: 1; min-width: 0; color: var(--ink); font-size: 12.5px; line-height: 1.4; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .tl-status { flex: 0 0 auto; font-family: var(--mono); font-size: 8.5px; font-weight: 650; padding: 1px 8px; border-radius: 99px; white-space: nowrap; color: var(--muted); background: var(--panel-2); }
      .tl-dur { flex: 0 0 auto; min-width: 34px; color: var(--faint); font-family: var(--mono); font-size: 9.5px; text-align: right; }
      .tl-meta { display: flex; flex-wrap: wrap; gap: 4px 9px; color: var(--faint); font-size: 9px; font-family: var(--mono); font-variant-numeric: tabular-nums; padding-left: 1px; }
      .tl-user { border-left-color: var(--blue); }
      .tl-assistant { border-left-color: var(--accent); }
      .tl-tool { border-left-color: #14a8c0; }
      .tl-connection { border-left-color: #b3b8c0; }
      .tl-error { border-left-color: var(--bad); }
      .tl-user .tl-chip { color: #1a44b8; background: color-mix(in srgb, var(--blue) 12%, var(--panel-2)); }
      .tl-assistant .tl-chip { color: #0a7a52; background: color-mix(in srgb, var(--accent) 14%, var(--panel-2)); }
      .tl-tool .tl-chip { color: #0a7c90; }
      .tl-connection .tl-chip { color: #6b7280; }
      .tl-error .tl-chip { color: #b5322b; }
      .tl-status.ok { color: #0a7a52; background: #e4f6ee; }
      .tl-status.running { color: #1a44b8; background: #e6edfd; }
      .tl-status.error { color: #b5322b; background: #fbe6e4; }
      .tl-raw { margin-top: 6px; padding: 9px 10px; border-radius: var(--radius-sm); background: var(--panel-2); border: 1px solid var(--line); color: #3f4450; font-family: var(--mono); font-size: 10px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 220px; overflow: auto; }
      .tl-row.selected { background: color-mix(in srgb, var(--accent) 9%, transparent); border-left-color: var(--accent); }
      .tl-row.selected .tl-summary { color: var(--ink); }

      /* ----- selected-event inspector ----- */
      .event-inspector { flex: 0 0 auto; max-height: 46%; display: flex; flex-direction: column; gap: 8px; border-top: 1px solid var(--line-2); background: var(--panel-2); padding: 11px 14px; overflow: auto; }
      .event-inspector[hidden] { display: none; }
      .inspector-head { display: flex; align-items: center; gap: 8px; }
      .inspector-head .tl-chip { color: var(--muted); background: var(--surface); }
      .inspector-owner { font-family: var(--mono); font-size: 11px; color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 200px; }
      .inspector-spacer { flex: 1; }
      .inspector-head .btn { height: 24px; padding: 0 9px; }
      #inspector-close { min-width: 26px; padding: 0; font-size: 15px; line-height: 1; }
      .inspector-evidence { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 6px 12px; }
      .insp-kv { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
      .insp-kv b { color: var(--faint); font-size: 8.5px; font-weight: 650; letter-spacing: 0.06em; text-transform: uppercase; }
      .insp-kv span { font-family: var(--mono); font-variant-numeric: tabular-nums; font-size: 11px; color: var(--ink); overflow-wrap: anywhere; }
      .inspector-next { font-family: var(--mono); font-size: 10.5px; color: #9a6310; background: #fcf1dc; border: 1px solid color-mix(in srgb, var(--warn) 32%, transparent); border-radius: var(--radius-sm); padding: 6px 9px; }
      .inspector-next.bad { color: #b5322b; background: #fbe6e4; border-color: color-mix(in srgb, var(--bad) 32%, transparent); }
      .inspector-next b { color: var(--ink); font-weight: 600; }
      .inspector-raw { margin: 0; padding: 9px 10px; border-radius: var(--radius-sm); background: var(--surface); border: 1px solid var(--line); color: #3f4450; font-family: var(--mono); font-size: 10px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 200px; overflow: auto; }

      /* ----- composer (lives in the ledger) ----- */
      .ledger-composer { flex: 0 0 auto; border-top: 1px solid var(--line); background: var(--panel-2); padding: 11px 14px; }
      .ledger-composer form { display: flex; flex-direction: column; gap: 8px; width: 100%; }
      .ledger-composer .composer-row { display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0; }
      .ledger-composer .composer-row-status { justify-content: space-between; gap: 10px; }
      .ledger-composer .composer-actions { display: inline-flex; align-items: center; gap: 6px; flex: 0 0 auto; }
      .ledger-composer #operator-realtime-mode-status { flex: 1 1 auto; min-width: 0; max-width: none; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ledger-composer #operator-text-input { flex: 1 1 auto; min-width: 0; width: 100%; max-width: none; height: 36px; }
      .ledger-composer #operator-text-send-button { flex: 0 0 auto; height: 36px; }

      /* ----- telemetry / sources ----- */
      .telemetry-wrap { display: flex; flex: 1 1 auto; min-height: 0; overflow: auto; flex-direction: column; gap: 12px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); padding: 12px; }
      .telemetry-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 11px; font-weight: 660; letter-spacing: 0.06em; text-transform: uppercase; color: var(--faint); }
      .telemetry-head .toolbar-group { gap: 6px; }
      .telemetry-head .btn { height: 28px; padding: 0 10px; }
      .metric-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(108px, 1fr)); gap: 7px; }
      .metric { min-height: 0; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--panel-2); padding: 8px 9px; display: flex; flex-direction: column; gap: 4px; }
      .metric b { color: var(--faint); font-size: 9.5px; font-weight: 650; letter-spacing: 0.06em; text-transform: uppercase; }
      .metric span { font-size: 12.5px; font-family: var(--mono); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; line-height: 1.25; color: var(--ink); }
      .debug-filter { display: flex; align-items: center; gap: 8px; }
      .debug-filter input { flex: 1; min-width: 0; height: 32px; border: 1px solid var(--line-2); border-radius: var(--radius-sm); padding: 0 11px; background: var(--surface); color: var(--ink); }
      .debug-filter input::placeholder { color: var(--faint); }
      .debug-filter span { min-width: 80px; color: var(--faint); font-size: 10.5px; text-align: right; font-family: var(--mono); }
      .debug-sections { display: grid; gap: 9px; }
      .debug-section { border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--surface); overflow: hidden; }
      .debug-section[data-filter-hidden="true"], .debug-table tr[data-filter-hidden="true"], pre[data-filter-hidden="true"] { display: none; }
      .debug-section-title {
        display: flex; align-items: center; justify-content: space-between; gap: 8px;
        min-height: 32px; padding: 7px 11px; border-bottom: 1px solid var(--line);
        color: var(--faint); font-size: 10px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
        background: var(--panel-2);
      }
      .debug-section-title span { color: var(--ink); font-weight: 600; letter-spacing: 0; text-transform: none; font-family: var(--mono); font-size: 10.5px; }
      .debug-table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 10.5px; font-family: var(--mono); font-variant-numeric: tabular-nums; }
      .debug-table th, .debug-table td { padding: 5px 9px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; overflow-wrap: anywhere; color: var(--ink); }
      .debug-table th { color: var(--faint); font-weight: 600; background: var(--panel-2); text-transform: uppercase; font-size: 9.5px; letter-spacing: 0.04em; }
      .debug-table tbody tr:nth-child(even) { background: color-mix(in srgb, var(--panel-2) 60%, transparent); }
      .debug-table tr:last-child td { border-bottom: 0; }
      .debug-ok { color: var(--ok); font-weight: 650; }
      .debug-warn { color: var(--warn); font-weight: 650; }
      .debug-bad { color: var(--bad); font-weight: 650; }
      td.debug-ok { box-shadow: inset 2px 0 0 var(--ok); }
      td.debug-warn { box-shadow: inset 2px 0 0 var(--warn); }
      td.debug-bad { box-shadow: inset 2px 0 0 var(--bad); }
      pre { margin: 0; padding: 11px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--panel-2); color: #3f4450; font-size: 10.5px; line-height: 1.5; font-family: var(--mono); overflow: auto; max-height: 48vh; }

      @media (max-width: 1040px) {
        main { grid-template-columns: 1fr; overflow: auto; }
        .stage-grid { grid-template-columns: 1fr; }
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
      <main data-dock="right">
        <section class="stage-shell">
          <div class="stage-topbar">
            <div class="source-tabs" id="source-tabs"></div>
            <div class="stage-hud" id="stage-hud"></div>
          </div>
          <div class="stage-grid">
            <div class="canvas-wrap">
              <canvas id="composition" width="1280" height="720"></canvas>
            </div>
          </div>
          <div class="stage-controls">
            <div class="toolbar-group voice-tools">
              <span class="dock-label">Mic</span>
              <select class="voice-device" id="voice-device-select" aria-label="Microphone">
                <option value="">Default mic</option>
              </select>
              <button class="btn" id="refresh-voice-devices-button" type="button" title="Refresh microphone list">Refresh</button>
              <button class="btn primary" id="voice-button" type="button">Start mic</button>
              <button class="btn" id="voice-mute-button" type="button">Mute</button>
              <button class="btn" id="voice-ptt-button" type="button" title="Diagnostic push-to-talk">PTT</button>
              <span class="toolbar-divider" aria-hidden="true"></span>
              <label class="checkbox-control"><input id="local-vad-toggle" type="checkbox" /> VAD</label>
              <span class="energy-wrap" title="Mic input energy">
                <span class="energy-meter" aria-hidden="true"><span id="voice-energy-bar"></span></span>
                <span class="energy-label" id="voice-energy-label">0.00</span>
              </span>
            </div>
          </div>
          <div class="control-dock">
            <div class="dock-group">
              <span class="dock-label">Provider</span>
              <select class="voice-device" id="conversation-provider-select" aria-label="Realtime provider"></select>
              <button class="btn" id="copy-provider-run-button" type="button" title="Copy the selected provider launch command">Copy Env</button>
              <span class="dock-status" id="conversation-provider-status">loading</span>
            </div>
            <div class="dock-group">
              <span class="dock-label">Avatar</span>
              <select class="voice-device" id="avatar-publisher-renderer-select" aria-label="Avatar publisher type">
                <option value="fallback-canvas">Fallback</option>
                <option value="oneesama-video">Video</option>
                <option value="hiyori-live2d">Hiyori</option>
              </select>
              <span class="dock-status" id="avatar-publisher-status">not open</span>
            </div>
            <div class="dock-group">
              <span class="dock-label">Debug</span>
              <button class="btn" id="open-debug-panel-button" type="button" title="Open the Realtime telemetry tab in the debug panel">Debug panel</button>
            </div>
            <div class="dock-group">
              <details class="diagnostic-menu" id="diagnostic-controls">
                <summary class="btn" title="Show advanced diagnostic and reset controls">Diagnostics</summary>
                <div class="diagnostic-popover" role="group" aria-label="Diagnostic controls">
                  <button class="btn" id="overlay-button" type="button" title="Send a visual overlay ping to the app view">Ping Overlay</button>
                  <button class="btn" id="cu-cursor-button" type="button" title="Run the cursor-rendering diagnostic fixture">CU Cursor</button>
                  <button class="btn" id="cancel-response-button" type="button" title="Stop the assistant's current reply (only while it is replying)" disabled>Stop reply</button>
                  <button class="btn" id="cancel-tool-button" type="button" title="Stop the active tool / KWWK action (only while one is running)" disabled>Stop action</button>
                  <button class="btn" id="clear-audio-button" type="button" title="Clear the pending Realtime input-audio buffer (rarely needed)">Clear audio</button>
                  <button class="btn danger" id="reset-session-button" type="button" title="Reset the Realtime session — clears the current conversation and reconnects">Reset session…</button>
                </div>
              </details>
            </div>
          </div>
        </section>
        <div class="dock-splitter" id="dock-splitter" role="separator" aria-orientation="vertical" aria-label="Resize debug dock" tabindex="0"></div>
        <section class="debug-shell" id="debug-panel" tabindex="-1" data-debug-panel-opened="false">
          <div class="debug-body">
            <div class="debug-panel-bar">
              <div class="debug-tablist" role="tablist" aria-label="Debug views">
                <button class="debug-tab" id="debug-tab-ledger" role="tab" aria-selected="true" aria-controls="tabpanel-ledger" type="button">Ledger</button>
                <button class="debug-tab" id="debug-tab-telemetry" role="tab" aria-selected="false" aria-controls="tabpanel-telemetry" type="button">Telemetry</button>
                <button class="debug-tab" id="debug-tab-sources" role="tab" aria-selected="false" aria-controls="tabpanel-sources" type="button">Sources</button>
              </div>
              <span class="dock-controls" role="group" aria-label="Debug dock layout">
                <button class="dock-btn" id="dock-right-button" type="button" title="Dock right" aria-pressed="true">⇥</button>
                <button class="dock-btn" id="dock-bottom-button" type="button" title="Dock bottom" aria-pressed="false">⤓</button>
                <button class="dock-btn" id="dock-hide-button" type="button" title="Clean mode — hide debug (\`)">✕</button>
              </span>
            </div>
            <section class="conversation-panel tabpanel active" id="tabpanel-ledger" role="tabpanel" aria-labelledby="debug-tab-ledger" data-tab="ledger">
              <div class="conversation-head">
                <span class="conversation-title">Realtime Conversation</span>
                <span class="conversation-meta" id="conversation-meta">—</span>
              </div>
              <div class="verdict-strip" id="operator-verdict"></div>
              <div class="cockpit-strip" id="operator-cockpit"></div>
              <div class="conversation-stream" id="operator-conversation-stream">
                <div class="conversation-empty">No messages yet. Start mic and speak, or type below and hit Send Text.</div>
              </div>
              <aside class="event-inspector" id="operator-event-inspector" data-inspector-open="false" aria-live="polite" hidden>
                <div class="inspector-head" id="inspector-head">
                  <span class="tl-chip" id="inspector-chip">event</span>
                  <span class="inspector-owner" id="inspector-owner"></span>
                  <span class="tl-status" id="inspector-status">info</span>
                  <span class="inspector-spacer"></span>
                  <button class="btn" id="inspector-copy" type="button">Copy</button>
                  <button class="btn" id="inspector-close" type="button" aria-label="Close inspector">×</button>
                </div>
                <div class="inspector-evidence" id="inspector-evidence"></div>
                <div class="inspector-next" id="inspector-next" hidden></div>
                <pre class="inspector-raw" id="inspector-raw"></pre>
              </aside>
              <div class="ledger-composer" id="operator-composer-dock" role="group" aria-label="Realtime message composer"></div>
            </section>
            <section class="telemetry-wrap tabpanel" id="tabpanel-telemetry" role="tabpanel" aria-labelledby="debug-tab-telemetry" data-tab="telemetry" hidden>
              <div class="telemetry-head">
                <span>Telemetry</span>
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
              <section class="debug-section">
                <div class="debug-section-title">Provider Config <span id="debug-provider-config-summary">loading</span></div>
                <table class="debug-table">
                  <thead><tr><th>Provider</th><th>Key</th><th>Model / Config</th><th>Launch</th></tr></thead>
                  <tbody id="debug-provider-config-table"></tbody>
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
              <section class="debug-section"><div class="debug-section-title">Artifacts <span id="debug-artifact-summary">idle</span></div><table class="debug-table"><thead><tr><th>Kind</th><th>Label</th><th>Bytes</th><th>Link / policy</th></tr></thead><tbody id="debug-artifact-table"></tbody></table></section>
            </div>
            <pre id="debug-json">{}</pre>
            </section>
            <section class="telemetry-wrap tabpanel" id="tabpanel-sources" role="tabpanel" aria-labelledby="debug-tab-sources" data-tab="sources" hidden>
              <div class="telemetry-head"><span>Sources</span></div>
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
            </section>
          </div>
        </section>
      </main>
      <button class="dock-summon" id="dock-summon" type="button" hidden title="Show debug (\`)">
        <span class="dock-summon-dot" id="dock-summon-dot"></span>
        <span id="dock-summon-text">clean mode</span>
        <span class="dock-summon-cue">show \`</span>
      </button>
    </div>
    <script>${voiceClientSource}</script>
    <script>${voiceControlsClientSource}</script>
    <script>${websocketClientSource}</script>
    <script>${artifactClientSource}</script>
    <script>${outputClientSource}</script>
    <script>${visualClientSource}</script><script>${textInputClientSource}</script>
    <script>${debugPanelClientSource}</script>
    <script>${kwwkCursorClientSource}</script>
    <script>
      (() => {
        const boot = ${boot};
        const bootParams = new URLSearchParams(location.search);
        const canvas = document.getElementById("composition");
        const ctx = canvas.getContext("2d");
        const [readyDot, voiceLabel, visualLabel, voiceWsNode, transportStateNode, voiceChunksNode, visualTracksNode, compositionNode, layoutRevisionNode, overlayCountNode, kwwkJobNode, toolRoutingNode, assistantTextNode, outputAudioNode, engineControlNode, artifactNode, timelineNode, debugShell, debugJson, debugFilterInput, debugFilterClearButton, debugFilterState, debugTimelineCount, debugTransportSummary, debugTransportTable, debugVoiceSummary, debugVoiceTable, debugTimelineTable, debugTurnCount, debugTurnTable, debugTurnTimelineSummary, debugTurnTimelineTable, debugConversationSummary, debugConversationTable, debugPortSummary, debugPortTable, debugProviderConfigSummary, debugProviderConfigTable, debugProviderDrilldownSummary, debugProviderDrilldownTable, debugToolRoutingSummary, debugToolRoutingTable, debugKwwkSummary, debugKwwkTable, debugVisualSummary, debugCompositionTable, debugVisualSourceTable, debugArtifactSummary, debugArtifactTable, sourceTabs] = ["ready-dot", "voice-label", "visual-label", "voice-ws", "transport-state", "voice-chunks", "visual-tracks", "composition-state", "layout-revision", "overlay-count", "kwwk-job-state", "tool-routing-state", "assistant-text-state", "output-audio-state", "engine-control-state", "artifact-state", "timeline-state", "debug-panel", "debug-json", "debug-filter-input", "debug-filter-clear-button", "debug-filter-state", "debug-timeline-count", "debug-transport-summary", "debug-transport-table", "debug-voice-summary", "debug-voice-table", "debug-timeline-table", "debug-turn-count", "debug-turn-table", "debug-turn-timeline-summary", "debug-turn-timeline-table", "debug-conversation-summary", "debug-conversation-table", "debug-port-summary", "debug-port-table", "debug-provider-config-summary", "debug-provider-config-table", "debug-provider-drilldown-summary", "debug-provider-drilldown-table", "debug-tool-routing-summary", "debug-tool-routing-table", "debug-kwwk-summary", "debug-kwwk-table", "debug-visual-summary", "debug-composition-table", "debug-visual-source-table", "debug-artifact-summary", "debug-artifact-table", "source-tabs"].map((id) => document.getElementById(id));
        const conversationProviderSelect = document.getElementById("conversation-provider-select");
        const copyProviderRunButton = document.getElementById("copy-provider-run-button");
        const conversationProviderStatus = document.getElementById("conversation-provider-status");
        const avatarPublisherRendererSelect = document.getElementById("avatar-publisher-renderer-select");
        const avatarPublisherStatus = document.getElementById("avatar-publisher-status");
        const COMPOSITION_TARGET_FPS = 30;
        const LEGACY_DEFAULT_SOURCE_RECTS = {
          "host-app": { x: 0.04, y: 0.08, width: 0.7, height: 0.7 },
          avatar: { x: 0.72, y: 0.56, width: 0.24, height: 0.24 },
        };
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
          liveProviderConfig: boot.liveProviderConfig || null,
          providerConfigSelection: boot.conversationTransport,
          providerSwitch: { status: "idle", targetTransport: null, lastError: null, lastResult: null },
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
          publishers: {
            autoAvatarPublisher: true,
            avatarPreset: bootParams.get("avatarPreset") || "fallback-canvas",
            avatarWindowOpen: false,
            lastAvatarPublisherUrl: null,
            status: "not_open",
            statusText: "not open",
          },
          sourceRects: structuredClone(boot.sourceRects),
          sourceMediaDrawRects: {},
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
        let visualReceiver = null, voiceControls = null, textInputClient = null, artifactClient = null, compositionHeartbeat = null, avatarPublisherFrame = null;
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
            sourceMediaDrawRects: state.sourceMediaDrawRects,
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

        function liveProviderConfig() {
          return state.liveProviderConfig || boot.liveProviderConfig || { providers: [] };
        }

        function liveProviderEntries() {
          const config = liveProviderConfig();
          return Array.isArray(config.providers) ? config.providers : [];
        }

        function providerEntry(transport) {
          return liveProviderEntries().find((provider) => provider.transport === transport) || null;
        }

        function activeConversationTransport() {
          const config = liveProviderConfig();
          return String(
            config.selectedTransport ||
            state.conversation?.provider?.adapterKind ||
            boot.conversationTransport ||
            "mock"
          );
        }

        function providerConfigLabel(provider) {
          if (!provider) return "unknown";
          return provider.label || provider.transport || "provider";
        }

        function providerConfigStatus(provider, targetTransport) {
          if (!provider) return "unknown";
          const activeTransport = activeConversationTransport();
          const switching =
            state.providerSwitch.status === "switching" &&
            state.providerSwitch.targetTransport === targetTransport;
          const failed =
            state.providerSwitch.status === "failed" &&
            state.providerSwitch.targetTransport === targetTransport;
          const keyState = provider.keyConfigured
            ? "key:" + String(provider.keySource || "configured")
            : "key missing";
          if (switching) return "switching / " + keyState;
          if (failed) return "failed / " + keyState;
          return (targetTransport === activeTransport ? "selected" : "available") + " / " + keyState;
        }

        function providerConfigModel(provider) {
          if (!provider) return "-";
          const parts = [
            provider.model || "-",
            provider.modelSource ? "model:" + provider.modelSource : "",
            provider.config?.thinkingLevel ? "thinking:" + provider.config.thinkingLevel : "",
          ];
          return parts.filter(Boolean).join(" / ");
        }

        function populateProviderSelect() {
          if (!conversationProviderSelect || conversationProviderSelect.options.length > 0) return;
          for (const provider of liveProviderEntries()) {
            const option = document.createElement("option");
            option.value = provider.transport;
            option.textContent = providerConfigLabel(provider);
            conversationProviderSelect.appendChild(option);
          }
          if (!conversationProviderSelect.options.length) {
            const option = document.createElement("option");
            option.value = boot.conversationTransport;
            option.textContent = boot.conversationTransport;
            conversationProviderSelect.appendChild(option);
          }
          conversationProviderSelect.value = activeConversationTransport();
          state.providerConfigSelection = conversationProviderSelect.value;
        }

        function renderProviderConfigDock() {
          populateProviderSelect();
          const activeTransport = activeConversationTransport();
          const targetTransport = String(state.providerConfigSelection || activeTransport);
          const provider = providerEntry(targetTransport);
          if (conversationProviderSelect) {
            conversationProviderSelect.disabled = state.providerSwitch.status === "switching";
            if (conversationProviderSelect.value !== targetTransport) {
              conversationProviderSelect.value = targetTransport;
            }
          }
          if (conversationProviderStatus) {
            const switching =
              state.providerSwitch.status === "switching" &&
              state.providerSwitch.targetTransport === targetTransport;
            const failed =
              state.providerSwitch.status === "failed" &&
              state.providerSwitch.targetTransport === targetTransport;
            conversationProviderStatus.textContent = providerConfigStatus(provider, targetTransport);
            conversationProviderStatus.className = "dock-status " +
              (failed
                ? "bad"
                : switching
                  ? "warn"
                  : targetTransport === activeTransport
                ? (provider?.keyConfigured ? "ok" : "bad")
                : (provider?.keyConfigured ? "warn" : "bad"));
          }
          if (copyProviderRunButton) {
            copyProviderRunButton.disabled = !provider?.runCommand;
            copyProviderRunButton.title = provider?.runCommand || "No provider launch command";
          }
        }

        async function copySelectedProviderRunCommand() {
          const targetTransport = String(state.providerConfigSelection || activeConversationTransport());
          const provider = providerEntry(targetTransport);
          const command = String(provider?.runCommand || "");
          if (!command) return { ok: false, error: "provider_run_command_missing" };
          try {
            await navigator.clipboard?.writeText(command);
            if (copyProviderRunButton) {
              copyProviderRunButton.textContent = "Copied";
              setTimeout(() => { copyProviderRunButton.textContent = "Copy Env"; }, 1200);
            }
            return { ok: true, command };
          } catch (error) {
            return { ok: false, error: String(error?.message || error), command };
          }
        }

        function mergeRuntimeDebugSnapshot(debug, options = {}) {
          if (!debug || typeof debug !== "object") return;
          if (debug.surfaceContext?.liveProviderConfig) {
            state.liveProviderConfig = debug.surfaceContext.liveProviderConfig;
            const selected = String(state.liveProviderConfig?.selectedTransport || "");
            if (selected) boot.conversationTransport = selected;
          }
          const selectedTransport = String(debug.surfaceContext?.operatorMode?.conversationTransport || "");
          if (selectedTransport) boot.conversationTransport = selectedTransport;
          if (debug.transport) mergeTransportSnapshot(debug.transport);
          if (debug.voice) state.voice = { ...state.voice, ...debug.voice };
          if (debug.output && options.replaceOutput) state.output = debug.output;
          if (debug.artifacts) state.artifacts = debug.artifacts;
          if (debug.timeline) state.timeline = debug.timeline;
          if (debug.kwwk) state.kwwk = debug.kwwk;
          if (debug.toolRouting) state.toolRouting = debug.toolRouting;
          const conversation = debug.conversation;
          if (conversation) {
            state.conversation = {
              ...state.conversation,
              ...conversation,
              control: { ...state.conversation.control, ...(conversation.control || {}) },
            };
          }
        }

        async function switchConversationProvider(transport) {
          const targetTransport = String(transport || "").trim();
          if (!targetTransport) return { ok: false, error: "provider_transport_missing" };
          state.providerConfigSelection = targetTransport;
          state.providerSwitch = {
            status: "switching",
            targetTransport,
            lastError: null,
            lastResult: null,
          };
          renderProviderConfigDock();
          syncDebug();
          try {
            const response = await fetch("/runtime/provider", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ transport: targetTransport, connect: true }),
            });
            const body = await response.json();
            if (!response.ok || !body.ok) {
              throw new Error(body.error || "provider_switch_failed");
            }
            if (body.liveProviderConfig) state.liveProviderConfig = body.liveProviderConfig;
            if (body.conversationTransport) {
              boot.conversationTransport = body.conversationTransport;
              state.providerConfigSelection = body.conversationTransport;
            }
            mergeRuntimeDebugSnapshot(body.debug, { replaceOutput: true });
            state.providerSwitch = {
              status: "active",
              targetTransport: String(body.conversationTransport || targetTransport),
              lastError: null,
              lastResult: body,
            };
            textInputClient?.renderStatus?.();
            renderProviderConfigDock();
            syncDebug();
            return body;
          } catch (error) {
            const message = String(error?.message || error);
            state.providerSwitch = {
              status: "failed",
              targetTransport,
              lastError: message,
              lastResult: null,
            };
            state.errors.push("provider_switch_failed:" + message);
            renderProviderConfigDock();
            syncDebug();
            return { ok: false, error: message, transport: targetTransport };
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
            debugProviderConfigSummary,
            debugProviderConfigTable,
            debugProviderDrilldownSummary,
            debugProviderDrilldownTable,
            durationLabel,
            replaceTableRows,
          });

          window.MAB_LAN_OPERATOR_DEBUG_PANEL.renderToolAndKwwk({ state, debugToolRoutingSummary, debugToolRoutingTable, debugKwwkSummary, debugKwwkTable, replaceTableRows });

          window.MAB_LAN_OPERATOR_DEBUG_PANEL.renderConversationStream({ stream: document.getElementById("operator-conversation-stream"), state, boot });
          updateDockSummonStatus();

          debugVisualSummary.textContent = state.visual.connectionState + " / " + String(state.visual.trackCount || 0) + " tracks";
          replaceTableRows(debugCompositionTable, [
            ["Mode", composition.mode],
            ["Track", composition.localComposedTrack ? String(composition.trackReadyState || "track") : "missing"],
            ["Track id", composition.trackId],
            ["Canvas", String(composition.width) + "x" + String(composition.height) + " @" + String(composition.targetFps) + "fps"],
            ["Frame age", durationLabel(composition.lastRenderedFrameAgeMs)],
            ["Focused source", composition.focusedSourceId],
          ]);
          const stageHud = document.getElementById("stage-hud");
          if (stageHud) {
            const vConn = state.visual.connectionState || "idle";
            const vTone = /connected|live|open/i.test(vConn) ? "ok" : (/fail|error|closed/i.test(vConn) ? "bad" : "warn");
            let focusName = "";
            for (const src of state.sources || []) { if (src.id === composition.focusedSourceId) { focusName = src.label; break; } }
            // Only stable status chips here. The per-frame "frame age" value is
            // intentionally NOT shown — it changes every heartbeat and made the
            // HUD flicker/reflow. It still lives in the Telemetry tab (Frame age).
            const chips = [
              [vTone, "webrtc", String(vConn)],
              ["", "", String(composition.mode || "live") + " " + String(composition.width) + "x" + String(composition.height) + " @" + String(composition.targetFps) + "fps"],
              ["", "tracks", String(state.visual.trackCount || 0)],
              ["", "sources", String((state.sources || []).length)],
            ];
            if (focusName) chips.push(["", "focus", focusName]);
            // Rebuild the DOM only when the chip content actually changed, so an
            // idle HUD never repaints (no flicker).
            const hudSig = JSON.stringify(chips);
            if (stageHud.dataset.hudSig !== hudSig) {
              stageHud.dataset.hudSig = hudSig;
              const hud = (tone, label, value) => {
                const c = document.createElement("span");
                c.className = "hud-chip" + (tone ? " " + tone : "");
                const d = document.createElement("span"); d.className = "hud-dot"; c.appendChild(d);
                if (label) c.appendChild(document.createTextNode(label + " "));
                const b = document.createElement("b"); b.textContent = value; c.appendChild(b);
                return c;
              };
              stageHud.innerHTML = "";
              for (const [tone, label, value] of chips) stageHud.appendChild(hud(tone, label, value));
            }
          }
          textInputClient?.renderStatus?.();
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
          updateContextualControls();
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
          renderProviderConfigDock();
          syncAvatarPublisherStatusFromSource();
          renderDebugSections(composition);
          debugJson.textContent = JSON.stringify({
            sessionId: boot.sessionId,
            conversationTransport: activeConversationTransport(),
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
            liveProviderConfig: state.liveProviderConfig,
            providerConfigSelection: state.providerConfigSelection,
            providerSwitch: state.providerSwitch,
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
          // Source switching lives only in the toolbar tabs now; the redundant
          // left source rail was removed (no judgment value, ate stage width).
          sourceTabs.innerHTML = "";
          for (const source of state.sources) {
            const tab = document.createElement("button");
            tab.type = "button";
            tab.className = "btn";
            tab.setAttribute("aria-pressed", source.id === state.focusedSourceId ? "true" : "false");
            tab.title = source.label + " · " + source.kind;
            tab.textContent = source.label;
            tab.addEventListener("click", () => setFocusedSource(source.id));
            sourceTabs.appendChild(tab);
          }
        }

        function setFocusedSource(sourceId) {
          state.focusedSourceId = sourceId;
          state.layoutRevision += 1;
          markCompositionDirty();
          renderSourceControls();
          persistUserState();
          emitCompositionState();
          syncDebug();
        }

        function isFixedSource(sourceId) {
          return sourceId === "host-app";
        }

        function fixedSourceRect(sourceId) {
          return structuredClone(boot.sourceRects?.[sourceId] || { x: 0, y: 0, width: 1, height: 1 });
        }

        function moveSource(sourceId, rect) {
          markCompositionDirty();
          if (isFixedSource(sourceId)) {
            state.sourceRects[sourceId] = fixedSourceRect(sourceId);
            state.focusedSourceId = sourceId;
            renderSourceControls();
            persistUserState();
            emitCompositionState();
            syncDebug();
            return currentComposition();
          }
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
          persistUserState();
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
          // Feed the Cueboard-standard cursor renderer with canvas-normalized
          // coords (map source-relative overlay → full-canvas normalized).
          const rect = state.sourceRects[sourceId];
          const cursorApi = window.MAB_LAN_OPERATOR_KWWK_CURSOR;
          if (cursorApi) {
            cursorApi.update({
              x: rect ? rect.x + overlay.x * rect.width : overlay.x,
              y: rect ? rect.y + overlay.y * rect.height : overlay.y,
              kind: overlay.kind === "cursor" ? "move" : overlay.kind,
              label: overlay.label,
              holdMs: input.holdMs,
            });
          }
          sendOperatorEvent({ type: "visual_overlay_event", overlay });
          syncDebug();
          return overlay;
        }
        // Render a REAL cursor event pushed from the server (upstream KWWK action
        // → server → here), NOT the demo fixture. No echo back to the server.
        function renderRemoteKwwkCursor(cursor) {
          cursor = cursor || {};
          const sourceId = cursor.sourceId || state.focusedSourceId || "host-app";
          const kind = cursor.kind === "cursor" ? "move" : cursor.kind || "move";
          const overlay = {
            id: "overlay_remote_" + Date.now().toString(36),
            sourceId,
            kind,
            x: clamp(Number(cursor.x ?? 0.5), 0, 1),
            y: clamp(Number(cursor.y ?? 0.5), 0, 1),
            label: String(cursor.label || "KWWK"),
            ts: Date.now(),
            remote: true,
          };
          state.overlays.push(overlay);
          state.overlays = state.overlays.slice(-40);
          const rect = state.sourceRects[sourceId];
          const cursorApi = window.MAB_LAN_OPERATOR_KWWK_CURSOR;
          if (cursorApi) {
            cursorApi.update({
              x: rect ? rect.x + overlay.x * rect.width : overlay.x,
              y: rect ? rect.y + overlay.y * rect.height : overlay.y,
              kind,
              label: overlay.label,
              holdMs: cursor.holdMs,
            });
          }
          syncDebug();
          return overlay;
        }
        // Pointer (click/drag) demo fixture — drives a realistic KWWK cursor
        // sequence (approach → click pulse → drag with trail → done) so the
        // Cueboard cursor can be seen/benchmarked on the operator stage.
        function runKwwkCursorFixture(opts = {}) {
          const sourceId = opts.sourceId || state.focusedSourceId || "host-app";
          const steps = [
            { x: 0.3, y: 0.3, kind: "move", label: "approach" },
            { x: 0.38, y: 0.36, kind: "move", label: "approach" },
            { x: 0.42, y: 0.4, kind: "click", label: "click save" },
            { x: 0.48, y: 0.45, kind: "drag", label: "drag" },
            { x: 0.56, y: 0.52, kind: "drag", label: "drag" },
            { x: 0.62, y: 0.58, kind: "drag", label: "drag selection" },
            { x: 0.62, y: 0.58, kind: "done", label: "done" },
          ];
          if (opts.animated === false) {
            for (const step of steps) emitKwwkOverlay({ sourceId, ...step });
            return steps.length;
          }
          let i = 0;
          const stepMs = Number(opts.stepMs) || 150;
          const tick = () => {
            if (i >= steps.length) return;
            emitKwwkOverlay({ sourceId, ...steps[i] });
            i += 1;
            window.setTimeout(tick, stepMs);
          };
          tick();
          return steps.length;
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

        const AVATAR_PRESETS = ["fallback-canvas", "oneesama-video", "hiyori-live2d"];
        function normalizeAvatarPreset(value) {
          const normalized = String(value || "").trim().toLowerCase();
          if (normalized === "fallback" || normalized === "canvas") return "fallback-canvas";
          if (normalized === "video") return "oneesama-video";
          if (normalized === "live2d" || normalized === "hiyori") return "hiyori-live2d";
          return AVATAR_PRESETS.includes(normalized) ? normalized : "fallback-canvas";
        }
        function avatarPresetLabel(value) {
          const preset = normalizeAvatarPreset(value);
          if (preset === "oneesama-video") return "video";
          if (preset === "hiyori-live2d") return "hiyori";
          return "fallback";
        }
        function avatarPublisherUrl(value = state.publishers.avatarPreset) {
          const preset = normalizeAvatarPreset(value);
          const url = new URL("/host-visual", location.origin);
          url.searchParams.set("avatar", "1");
          url.searchParams.set("sourceId", "avatar");
          url.searchParams.set("label", "Avatar");
          url.searchParams.set("kind", "avatar");
          url.searchParams.set("avatarPreset", preset);
          return url.toString();
        }
        function ensureAvatarPublisherFrame() {
          if (avatarPublisherFrame && avatarPublisherFrame.isConnected) return avatarPublisherFrame;
          avatarPublisherFrame = document.createElement("iframe");
          avatarPublisherFrame.id = "avatar-publisher-frame";
          avatarPublisherFrame.title = "Embedded avatar publisher";
          avatarPublisherFrame.setAttribute("aria-hidden", "true");
          avatarPublisherFrame.allow = "autoplay; camera; microphone; display-capture";
          Object.assign(avatarPublisherFrame.style, {
            position: "fixed",
            width: "1px",
            height: "1px",
            left: "-10px",
            bottom: "-10px",
            opacity: "0",
            pointerEvents: "none",
            border: "0",
          });
          document.body.appendChild(avatarPublisherFrame);
          return avatarPublisherFrame;
        }
        function setAvatarPublisherStatus(status, text = "") {
          state.publishers.status = String(status || "idle");
          state.publishers.statusText = text || status || "idle";
          if (avatarPublisherStatus) {
            avatarPublisherStatus.textContent = state.publishers.statusText;
            avatarPublisherStatus.className = "dock-status " + (
              status === "open" || status === "live"
                ? "ok"
                : status === "error"
                  ? "bad"
                  : status === "closed" || status === "not_open"
                    ? ""
                    : "warn"
            );
            avatarPublisherStatus.title = state.publishers.lastAvatarPublisherUrl || "";
          }
        }
        function setAvatarPublisherPreset(value, input = {}) {
          const preset = normalizeAvatarPreset(value);
          state.publishers.avatarPreset = preset;
          if (avatarPublisherRendererSelect) avatarPublisherRendererSelect.value = preset;
          if (input.persist === false) return { preset, url: avatarPublisherUrl(preset) };
          return openAvatarPublisher({ preset });
        }
        function openAvatarPublisher(input = {}) {
          const preset = normalizeAvatarPreset(input.preset || avatarPublisherRendererSelect?.value || state.publishers.avatarPreset);
          state.publishers.avatarPreset = preset;
          if (avatarPublisherRendererSelect) avatarPublisherRendererSelect.value = preset;
          const url = avatarPublisherUrl(preset);
          state.publishers.lastAvatarPublisherUrl = url;
          try {
            const frame = ensureAvatarPublisherFrame();
            if (frame.getAttribute("src") !== url) frame.setAttribute("src", url);
            state.publishers.avatarWindowOpen = true;
            setAvatarPublisherStatus(
              "open",
              "embedded · " + avatarPresetLabel(preset),
            );
          } catch (error) {
            state.publishers.avatarWindowOpen = false;
            setAvatarPublisherStatus("blocked", "open failed");
            state.errors.push(String(error?.message || error));
          }
          syncDebug();
          persistUserState();
          return { preset, url, opened: state.publishers.avatarWindowOpen };
        }
        function currentAvatarPublisherPreset() {
          return normalizeAvatarPreset(state.publishers.avatarPreset);
        }
        function syncAvatarPublisherStatusFromSource() {
          const avatar = (state.sources || []).find((source) => source.id === "avatar");
          if (!avatar) return;
          if (!state.publishers.avatarWindowOpen) return;
          const sourcePreset = normalizeAvatarPreset(
            avatar.avatarPreset || avatar.requestedAvatarPreset || state.publishers.avatarPreset,
          );
          const requestedPreset = currentAvatarPublisherPreset();
          if (state.publishers.avatarWindowOpen && sourcePreset !== requestedPreset) {
            state.publishers.avatarPreset = requestedPreset;
            if (avatarPublisherRendererSelect) avatarPublisherRendererSelect.value = requestedPreset;
            return;
          }
          const preset = sourcePreset;
          state.publishers.avatarPreset = preset;
          if (avatarPublisherRendererSelect) avatarPublisherRendererSelect.value = preset;
          if (avatar.state === "live" || avatar.captureStatus === "live") {
            const renderer = avatar.avatarRenderer ? String(avatar.avatarRenderer) : avatarPresetLabel(preset);
            const fallback = avatar.avatarFallbackReason ? " fallback:" + String(avatar.avatarFallbackReason) : "";
            setAvatarPublisherStatus("live", "live · " + avatarPresetLabel(preset) + " / " + renderer + fallback);
          } else if (avatar.captureError) {
            setAvatarPublisherStatus("error", "error · " + avatarPresetLabel(preset));
          }
        }

        const DEBUG_TABS = [
          ["debug-tab-ledger", "tabpanel-ledger", "ledger"],
          ["debug-tab-telemetry", "tabpanel-telemetry", "telemetry"],
          ["debug-tab-sources", "tabpanel-sources", "sources"],
        ];
        function setDebugTab(name) {
          for (const [tabId, panelId, tabName] of DEBUG_TABS) {
            const active = tabName === name;
            const tab = document.getElementById(tabId);
            const panel = document.getElementById(panelId);
            if (tab) tab.setAttribute("aria-selected", String(active));
            if (panel) {
              panel.hidden = !active;
              panel.classList.toggle("active", active);
            }
          }
          // The benchmark gate clicks #open-debug-panel-button and expects this flag
          // to be true with the dense telemetry sections rendered.
          if (debugShell) debugShell.dataset.debugPanelOpened = String(name === "telemetry");
          persistLayout();
        }
        function openDebugPanel() {
          setDebugTab("telemetry");
          debugShell?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
          debugShell?.focus?.({ preventScroll: true });
          return true;
        }

        const dockMain = document.querySelector("main");
        let dockLastOpen = "right";
        function setDock(stateName) {
          if (!dockMain) return;
          if (stateName !== "hidden") dockLastOpen = stateName;
          dockMain.dataset.dock = stateName;
          const summon = document.getElementById("dock-summon");
          if (summon) summon.hidden = stateName !== "hidden";
          const rb = document.getElementById("dock-right-button");
          const bb = document.getElementById("dock-bottom-button");
          if (rb) rb.setAttribute("aria-pressed", String(stateName === "right"));
          if (bb) bb.setAttribute("aria-pressed", String(stateName === "bottom"));
          const splitter = document.getElementById("dock-splitter");
          if (splitter) {
            splitter.setAttribute("aria-orientation", stateName === "bottom" ? "horizontal" : "vertical");
          }
          updateDockSummonStatus();
          persistLayout();
        }
        function toggleDockHidden() {
          setDock(dockMain && dockMain.dataset.dock === "hidden" ? dockLastOpen : "hidden");
        }
        function updateDockSummonStatus() {
          const text = document.getElementById("dock-summon-text");
          const dot = document.getElementById("dock-summon-dot");
          if (!text || !dot) return;
          const conv = state.conversation || {};
          const err =
            (conv.control && conv.control.lastError) ||
            (state.output && state.output.assistantText && state.output.assistantText.lastError) ||
            "";
          let tone = "";
          let label = "";
          if (err) {
            tone = "bad";
            label = "error";
          } else {
            label = conv.status === "connected" ? "live" : conv.status || "idle";
          }
          dot.className = "dock-summon-dot" + (tone ? " " + tone : "");
          text.textContent = "clean mode · " + label;
        }
        const LAYOUT_KEY = "mab.operator.layout.v1";
        function currentLayout() {
          const cs = dockMain ? getComputedStyle(dockMain) : null;
          let tab = "ledger";
          for (const [, , tabName] of DEBUG_TABS) {
            if (document.getElementById("debug-tab-" + tabName)?.getAttribute("aria-selected") === "true") {
              tab = tabName;
              break;
            }
          }
          return {
            dock: (dockMain && dockMain.dataset.dock) || "right",
            tab,
            w: cs ? cs.getPropertyValue("--dock-w").trim() : "",
            h: cs ? cs.getPropertyValue("--dock-h").trim() : "",
          };
        }
        let restoringLayout = false;
        function persistLayout() {
          if (restoringLayout) return;
          const layout = currentLayout();
          try {
            localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
          } catch (err) {}
          const parts = ["dock=" + layout.dock, "tab=" + layout.tab];
          if (layout.w) parts.push("w=" + parseInt(layout.w, 10));
          if (layout.h) parts.push("h=" + parseInt(layout.h, 10));
          try {
            history.replaceState(null, "", "#" + parts.join("&"));
          } catch (err) {}
        }
        function readLayout() {
          const hash = (location.hash || "").replace(/^#/, "");
          if (hash) {
            const params = {};
            for (const kv of hash.split("&")) {
              const [k, v] = kv.split("=");
              if (k) params[k] = v;
            }
            if (params.dock || params.tab) return params;
          }
          try {
            const raw = localStorage.getItem(LAYOUT_KEY);
            if (raw) return JSON.parse(raw);
          } catch (err) {}
          return null;
        }
        function restoreLayout() {
          const layout = readLayout();
          restoringLayout = true;
          const tab = ["ledger", "telemetry", "sources"].includes(layout?.tab) ? layout.tab : "ledger";
          const dock = ["right", "bottom", "hidden"].includes(layout?.dock) ? layout.dock : "right";
          if (layout?.w && dockMain) {
            dockMain.style.setProperty("--dock-w", /px$/.test(String(layout.w)) ? layout.w : layout.w + "px");
          }
          if (layout?.h && dockMain) {
            dockMain.style.setProperty("--dock-h", /px$/.test(String(layout.h)) ? layout.h : layout.h + "px");
          }
          setDebugTab(tab);
          setDock(dock);
          restoringLayout = false;
          persistLayout();
        }
        const USER_STATE_KEY = "mab.operator.user-state.v1";
        let restoringUserState = false;
        function validSourceId(sourceId) {
          return (state.sources || []).some((source) => source.id === sourceId);
        }
        function sanitizeSourceRect(rect) {
          if (!rect || typeof rect !== "object") return null;
          const next = {
            x: clamp(Number(rect.x), 0, 0.95),
            y: clamp(Number(rect.y), 0, 0.95),
            width: clamp(Number(rect.width), 0.08, 1),
            height: clamp(Number(rect.height), 0.08, 1),
          };
          next.width = Math.min(next.width, 1 - next.x);
          next.height = Math.min(next.height, 1 - next.y);
          return next;
        }
        function rectApproximatelyEqual(left, right) {
          if (!left || !right) return false;
          return Math.abs(Number(left.x) - Number(right.x)) < 0.001 &&
            Math.abs(Number(left.y) - Number(right.y)) < 0.001 &&
            Math.abs(Number(left.width) - Number(right.width)) < 0.001 &&
            Math.abs(Number(left.height) - Number(right.height)) < 0.001;
        }
        function migrateStoredSourceRect(sourceId, rect) {
          if (isFixedSource(sourceId)) return null;
          const legacyDefault = LEGACY_DEFAULT_SOURCE_RECTS[sourceId];
          if (legacyDefault && rectApproximatelyEqual(rect, legacyDefault)) return null;
          return rect;
        }
        function currentUserState() {
          const sourceRects = {};
          for (const source of state.sources || []) {
            if (isFixedSource(source.id)) continue;
            const rect = sanitizeSourceRect(state.sourceRects?.[source.id]);
            if (rect) sourceRects[source.id] = rect;
          }
          return {
            focusedSourceId: validSourceId(state.focusedSourceId) ? state.focusedSourceId : "host-app",
            sourceRects,
            publishers: {
              avatarPreset: normalizeAvatarPreset(state.publishers.avatarPreset),
              avatarPublisherOpen: true,
            },
            voice: {
              deviceId: String(state.voiceDeviceId || ""),
              localVadEnabled: Boolean(state.localVadEnabled),
            },
          };
        }
        function persistAvatarQuery(userState) {
          try {
            const url = new URL(location.href);
            url.searchParams.set("avatarPreset", userState.publishers.avatarPreset);
            url.searchParams.delete("autoAvatarPublisher");
            history.replaceState(null, "", url.pathname + url.search + location.hash);
          } catch (err) {}
        }
        function persistUserState() {
          if (restoringUserState) return;
          const userState = currentUserState();
          try {
            localStorage.setItem(USER_STATE_KEY, JSON.stringify(userState));
          } catch (err) {}
          persistAvatarQuery(userState);
        }
        function readUserState() {
          try {
            const raw = localStorage.getItem(USER_STATE_KEY);
            if (raw) return JSON.parse(raw);
          } catch (err) {}
          return null;
        }
        function restoreUserState() {
          const userState = readUserState();
          if (!userState || typeof userState !== "object") return;
          restoringUserState = true;
          try {
            if (validSourceId(userState.focusedSourceId)) {
              state.focusedSourceId = userState.focusedSourceId;
            }
            if (userState.sourceRects && typeof userState.sourceRects === "object") {
              for (const source of state.sources || []) {
                const rect = sanitizeSourceRect(userState.sourceRects[source.id]);
                const migratedRect = migrateStoredSourceRect(source.id, rect);
                if (migratedRect) state.sourceRects[source.id] = migratedRect;
              }
            }
            const publisherState = userState.publishers || {};
            if (!bootParams.has("avatarPreset") && publisherState.avatarPreset) {
              state.publishers.avatarPreset = normalizeAvatarPreset(publisherState.avatarPreset);
            }
            state.publishers.autoAvatarPublisher = true;
            const voiceState = userState.voice || {};
            if (typeof voiceState.deviceId === "string") {
              state.voiceDeviceId = voiceState.deviceId;
            }
            if (typeof voiceState.localVadEnabled === "boolean") {
              state.localVadEnabled = voiceState.localVadEnabled;
              state.voiceLocalVad = {
                ...(state.voiceLocalVad || {}),
                enabled: state.localVadEnabled,
                role: state.localVadEnabled ? "telemetry" : "disabled",
                active: state.localVadEnabled ? Boolean(state.voiceLocalVad?.active) : false,
                lastUpdatedAt: new Date().toISOString(),
              };
            }
          } finally {
            restoringUserState = false;
          }
        }
        function startDockResize(event) {
          if (!dockMain) return;
          const stateName = dockMain.dataset.dock;
          if (stateName !== "right" && stateName !== "bottom") return;
          event.preventDefault();
          const rect = dockMain.getBoundingClientRect();
          const pad = 10;
          function onMove(ev) {
            if (stateName === "right") {
              const w = Math.max(360, Math.min(rect.right - pad - ev.clientX, rect.width - 420));
              dockMain.style.setProperty("--dock-w", w + "px");
            } else {
              const h = Math.max(160, Math.min(rect.bottom - pad - ev.clientY, rect.height - 220));
              dockMain.style.setProperty("--dock-h", h + "px");
            }
          }
          function onUp() {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            document.body.style.userSelect = "";
            persistLayout();
          }
          document.body.style.userSelect = "none";
          window.addEventListener("pointermove", onMove);
          window.addEventListener("pointerup", onUp);
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

        function avatarPublisherPreviewVideo() {
          if (!avatarPublisherFrame || !avatarPublisherFrame.isConnected) return null;
          try {
            const preview = avatarPublisherFrame.contentDocument?.getElementById("preview");
            if (preview && preview.readyState >= 2 && preview.videoWidth > 0 && preview.videoHeight > 0) {
              return preview;
            }
          } catch (err) {}
          return null;
        }

        function drawableSourceVideo(source) {
          const receiverVideo = visualReceiver?.sourceVideo(source.id);
          if (receiverVideo && receiverVideo.readyState >= 2) {
            return { video: receiverVideo, mode: "webrtc_receiver" };
          }
          if (source.id === "avatar") {
            const preview = avatarPublisherPreviewVideo();
            if (preview) return { video: preview, mode: "embedded_avatar_preview" };
          }
          return { video: receiverVideo || null, mode: "placeholder" };
        }

        function drawPlaceholderSource(source, index, x, y, width, height) {
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
          state.sourceMediaDrawRects[source.id] = {
            box: { x, y, width, height },
            draw: null,
            media: { width: null, height: null },
            fit: "placeholder",
          };
          ctx.fillStyle = "rgba(255,255,255,0.92)";
          ctx.font = "600 24px system-ui, sans-serif";
          ctx.fillText(source.label, x + 24, y + 42);
          ctx.fillStyle = "rgba(255,255,255,0.68)";
          ctx.font = "15px system-ui, sans-serif";
          ctx.fillText(source.kind + " source " + String(index + 1), x + 24, y + 70);
        }

        function drawSource(source, index) {
          const rect = state.sourceRects[source.id];
          const x = rect.x * canvas.width;
          const y = rect.y * canvas.height;
          const width = rect.width * canvas.width;
          const height = rect.height * canvas.height;
          const focused = source.id === state.focusedSourceId;
          const { video, mode } = drawableSourceVideo(source);
          if (video && mode !== "placeholder") {
            drawContainedVideo(source, video, x, y, width, height, mode);
            visualReceiver?.noteSourceRendered(source.id, video);
          } else {
            drawPlaceholderSource(source, index, x, y, width, height);
          }
          ctx.strokeStyle = focused ? "#93c5fd" : "#64748b";
          ctx.lineWidth = focused ? 4 : 2;
          ctx.strokeRect(x, y, width, height);
        }

        function containedMediaRect(mediaWidth, mediaHeight, x, y, width, height) {
          const sourceWidth = Number(mediaWidth || 0);
          const sourceHeight = Number(mediaHeight || 0);
          if (!(sourceWidth > 0) || !(sourceHeight > 0) || !(width > 0) || !(height > 0)) {
            return { x, y, width, height, fit: "stretch_fallback" };
          }
          const mediaAspect = sourceWidth / sourceHeight;
          const boxAspect = width / height;
          if (mediaAspect > boxAspect) {
            const drawWidth = width;
            const drawHeight = width / mediaAspect;
            return {
              x,
              y: y + (height - drawHeight) / 2,
              width: drawWidth,
              height: drawHeight,
              fit: "contain",
            };
          }
          const drawHeight = height;
          const drawWidth = height * mediaAspect;
          return {
            x: x + (width - drawWidth) / 2,
            y,
            width: drawWidth,
            height: drawHeight,
            fit: "contain",
          };
        }

        function drawContainedVideo(source, video, x, y, width, height, mode = "webrtc_receiver") {
          const mediaWidth = Number(video.videoWidth || 0);
          const mediaHeight = Number(video.videoHeight || 0);
          const draw = containedMediaRect(mediaWidth, mediaHeight, x, y, width, height);
          ctx.fillStyle = source.id === "avatar" ? "#e9edf2" : "#0b1220";
          ctx.fillRect(x, y, width, height);
          ctx.drawImage(video, draw.x, draw.y, draw.width, draw.height);
          state.sourceMediaDrawRects[source.id] = {
            box: { x, y, width, height },
            draw: { x: draw.x, y: draw.y, width: draw.width, height: draw.height },
            media: { width: mediaWidth || null, height: mediaHeight || null },
            fit: draw.fit,
            source: mode,
          };
        }

        function drawOverlays() {
          // Cueboard-standard cursor: persistent foreground arrow + colored ring
          // + click pulse + target ring + drag trail + label box. Replaces the
          // old flat yellow crosshair. Fed via emitKwwkOverlay (canvas-normalized).
          const cursorApi = window.MAB_LAN_OPERATOR_KWWK_CURSOR;
          if (cursorApi) cursorApi.draw(ctx, canvas.width, canvas.height);
        }

        const COMPOSITION_FRAME_MS = 1000 / COMPOSITION_TARGET_FPS;
        // When nothing is moving we still repaint a couple of times a second as a
        // cheap safety net (covers any state change we didn't explicitly flag).
        const COMPOSITION_IDLE_REDRAW_MS = 500;
        let compositionDirty = true;
        let compositionLastTickMs = -1;
        let compositionLastDrawMs = -1;
        function markCompositionDirty() {
          compositionDirty = true;
        }
        function compositionHasLiveMedia() {
          for (const source of state.sources || []) {
            const drawable = drawableSourceVideo(source);
            if (drawable.video && drawable.mode !== "placeholder") return true;
          }
          return false;
        }
        function compositionCursorActive() {
          const cursor = window.MAB_LAN_OPERATOR_KWWK_CURSOR;
          return Boolean(cursor && cursor.snapshot && cursor.snapshot().visible);
        }
        function drawComposition() {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.fillStyle = "#0f172a";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          state.sources.forEach(drawSource);
          drawOverlays();
          state.compositionFrameCount += 1;
          state.compositionLastFrameAt = new Date().toISOString();
          state.compositionLastFrameEpochMs = performance.now();
          compositionDirty = false;
          compositionLastDrawMs = state.compositionLastFrameEpochMs;
        }
        function render() {
          requestAnimationFrame(render);
          const now = performance.now();
          // Cap the draw rate to the composition target fps. requestAnimationFrame
          // fires at the display refresh (often 60–120Hz), but canvas.captureStream
          // only samples at COMPOSITION_TARGET_FPS, so any faster draw is wasted CPU.
          if (compositionLastTickMs >= 0 && now - compositionLastTickMs < COMPOSITION_FRAME_MS - 1) return;
          compositionLastTickMs = now;
          // Live video / an animating cursor / an explicit change need a real draw.
          // Otherwise the canvas is static — fall back to the slow idle redraw so an
          // idle operator surface costs ~2fps instead of pegging a core at 60–120fps.
          const active = compositionDirty || compositionHasLiveMedia() || compositionCursorActive();
          if (!active && compositionLastDrawMs >= 0 && now - compositionLastDrawMs < COMPOSITION_IDLE_REDRAW_MS) return;
          drawComposition();
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
          if (payload.type === "kwwk_cursor" && payload.cursor) {
            renderRemoteKwwkCursor(payload.cursor);
            return;
          }
          if (payload.debug) mergeRuntimeDebugSnapshot(payload.debug);
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
          markCompositionDirty();
          if (isFixedSource(source.id)) {
            drag = null;
            renderSourceControls();
            persistUserState();
            emitCompositionState();
            syncDebug();
            return;
          }
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
          markCompositionDirty();
          moveSource(drag.sourceId, next);
        });

        canvas.addEventListener("pointerup", () => {
          drag = null;
        });

        document.getElementById("overlay-button").addEventListener("click", () => {
          emitKwwkOverlay({ kind: "click", label: "KWWK", x: 0.5, y: 0.5 });
        });
        document.getElementById("cu-cursor-button")?.addEventListener("click", () => {
          runKwwkCursorFixture();
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
          // Destructive: drops the live conversation/session — confirm first.
          if (!window.confirm("Reset the Realtime session? This clears the current conversation and reconnects.")) return;
          sendEngineControl("reset_session");
        });
        // Contextual controls (Stop reply / Stop action) are only meaningful while
        // the assistant is replying or a tool/KWWK job is running — gate them so the
        // disabled state communicates "nothing to stop right now".
        function updateContextualControls() {
          const replyBtn = document.getElementById("cancel-response-button");
          const toolBtn = document.getElementById("cancel-tool-button");
          const replying = Boolean(state.output && state.output.assistantText && state.output.assistantText.currentText);
          const kwwkStatus = String((state.kwwk && state.kwwk.status) || "");
          const toolActive =
            /run|exec|progress|observ|plan|verif|active/i.test(kwwkStatus) ||
            Boolean(state.conversation && state.conversation.control && state.conversation.control.inFlight > 0);
          if (replyBtn) replyBtn.disabled = !replying;
          if (toolBtn) toolBtn.disabled = !toolActive;
        }
        avatarPublisherRendererSelect?.addEventListener("change", () => {
          setAvatarPublisherPreset(avatarPublisherRendererSelect.value);
        });
        conversationProviderSelect?.addEventListener("change", () => {
          void switchConversationProvider(conversationProviderSelect.value);
        });
        copyProviderRunButton?.addEventListener("click", () => {
          void copySelectedProviderRunCommand().then((result) => {
            if (!result.ok && result.command) {
              state.errors.push("provider_run_command_copy_failed");
              syncDebug();
            }
          });
        });
        restoreUserState();
        if (avatarPublisherRendererSelect) {
          avatarPublisherRendererSelect.value = normalizeAvatarPreset(state.publishers.avatarPreset);
        }
        openAvatarPublisher({ preset: state.publishers.avatarPreset });
        document.getElementById("open-debug-panel-button").addEventListener("click", openDebugPanel);
        for (const [tabId, , tabName] of DEBUG_TABS) {
          document.getElementById(tabId)?.addEventListener("click", () => setDebugTab(tabName));
        }
        document.getElementById("dock-right-button")?.addEventListener("click", () => setDock("right"));
        document.getElementById("dock-bottom-button")?.addEventListener("click", () => setDock("bottom"));
        document.getElementById("dock-hide-button")?.addEventListener("click", () => setDock("hidden"));
        document.getElementById("dock-summon")?.addEventListener("click", () => setDock(dockLastOpen));
        document.getElementById("dock-splitter")?.addEventListener("pointerdown", startDockResize);
        restoreLayout();
        window.addEventListener("hashchange", restoreLayout);
        window.addEventListener("keydown", (event) => {
          if (event.key === "\`" && !event.metaKey && !event.ctrlKey && !event.altKey) {
            const tag = (event.target && event.target.tagName) || "";
            if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
            event.preventDefault();
            toggleDockHidden();
          }
        });
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
        voiceControls = window.MAB_LAN_OPERATOR_VOICE_CONTROLS.create({ state, sendOperatorEvent, syncDebug, startMicrophone, stopMicrophone, setVoiceMuted, persistUserState });
        voiceControls.bind();
        textInputClient = window.MAB_LAN_OPERATOR_TEXT_INPUT.create({ state, boot, sendOperatorEvent, sendEngineControl, syncDebug });
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
          state, moveSource, setFocusedSource, emitKwwkOverlay, runKwwkCursorFixture, sendSyntheticVoiceChunk,
          emitKwwkJobState, submitToolResult, cancelTool, sendEngineControl, fetchDebugReport, copyDiagnostics, downloadReport,
          createDebugBundle, markInterestingRun, registerArtifactLink, openDebugPanel, currentComposition, startMicrophone, stopMicrophone, setVoiceMuted,
          avatarPublisherUrl, openAvatarPublisher, setAvatarPublisherPreset,
          setDebugFilter: (query) => { debugFilterInput.value = String(query || ""); return applyDebugFilter(); },
          getDebugFilter: () => applyDebugFilter(),
          refreshVoiceDevices: () => voiceControls?.refreshDevices(),
          configureLocalVad: (enabled) => voiceControls?.configureLocalVad(enabled), sendTextInput: (text) => textInputClient?.sendText(text),
          setAudioEnabled: (enabled) => outputClient?.setAudioEnabled(enabled),
          liveProviderConfig: () => structuredClone(state.liveProviderConfig || {}),
          switchConversationProvider,
          copySelectedProviderRunCommand,
          getComposedVideoTrack: () => state.localComposedTrack, outputClient: () => outputClient,
          sourceMediaDrawRects: () => structuredClone(state.sourceMediaDrawRects || {}),
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
