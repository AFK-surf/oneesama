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
        color-scheme: dark;
        /* shadcn-style zinc dark tokens */
        --background: #09090b;
        --surface: #0c0c0f;
        --panel: #141417;
        --panel-2: #1a1a1e;
        --elevated: #212127;
        --ink: #fafafa;
        --muted: #a1a1aa;
        --faint: #71717a;
        --line: #26262b;
        --line-2: #323239;
        --accent: #34d399;
        --accent-ink: #052e1f;
        --blue: #60a5fa;
        --ok: #34d399;
        --warn: #fbbf24;
        --bad: #f87171;
        --ring: color-mix(in srgb, var(--accent) 55%, transparent);
        --radius: 9px;
        --mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
        --sans: "Inter", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      * { box-sizing: border-box; }
      ::selection { background: color-mix(in srgb, var(--accent) 35%, transparent); }
      html, body { height: 100%; }
      body {
        margin: 0; color: var(--ink); font-family: var(--sans);
        font-size: 13px; -webkit-font-smoothing: antialiased; letter-spacing: 0.1px;
        background:
          radial-gradient(1100px 560px at 80% -12%, color-mix(in srgb, var(--accent) 7%, transparent), transparent 60%),
          var(--background);
      }
      button, select, input { font: inherit; font-size: 12px; color: var(--ink); }
      ::-webkit-scrollbar { width: 10px; height: 10px; }
      ::-webkit-scrollbar-thumb { background: var(--line-2); border-radius: 99px; border: 2px solid transparent; background-clip: padding-box; }
      ::-webkit-scrollbar-thumb:hover { background: #45454d; background-clip: padding-box; }

      /* ----- app shell: fixed viewport height, panels scroll internally ----- */
      .app { display: grid; grid-template-rows: auto minmax(0, 1fr); height: 100vh; }
      header {
        display: flex; align-items: center; justify-content: space-between; gap: 16px;
        min-height: 52px; padding: 0 18px;
        border-bottom: 1px solid var(--line);
        background: color-mix(in srgb, var(--panel) 82%, transparent);
        backdrop-filter: blur(14px) saturate(140%);
      }
      .brand { display: flex; align-items: baseline; gap: 12px; min-width: 0; }
      h1 { margin: 0; font-size: 14px; font-weight: 650; line-height: 1.2; letter-spacing: 0.2px; white-space: nowrap; }
      .topline { display: flex; align-items: center; gap: 10px; color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
      .topline span[id$="-label"] { display: inline-flex; align-items: center; gap: 6px; padding: 2px 9px; border: 1px solid var(--line); border-radius: 99px; background: var(--panel-2); white-space: nowrap; }
      #session-label { font-family: var(--mono); font-size: 10.5px; color: var(--muted); }
      .status-dot { width: 8px; height: 8px; border-radius: 99px; display: inline-block; background: var(--warn); box-shadow: 0 0 0 3px color-mix(in srgb, var(--warn) 18%, transparent); }
      .status-dot.ready { background: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent); }
      .status-dot.bad { background: var(--bad); box-shadow: 0 0 0 3px color-mix(in srgb, var(--bad) 22%, transparent); }

      main { display: grid; gap: 0; padding: 10px; min-height: 0; overflow: hidden; }
      main[data-dock="right"] { grid-template-columns: minmax(0, 1fr) 14px var(--dock-w, clamp(520px, 44vw, 800px)); grid-template-rows: minmax(0, 1fr); }
      main[data-dock="bottom"] { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) 14px var(--dock-h, 40vh); }
      main[data-dock="hidden"] { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); }
      main[data-dock="hidden"] .dock-splitter, main[data-dock="hidden"] .debug-shell { display: none; }
      .dock-splitter { position: relative; align-self: stretch; justify-self: stretch; background: transparent; }
      main[data-dock="right"] .dock-splitter { cursor: col-resize; }
      main[data-dock="bottom"] .dock-splitter { cursor: row-resize; }
      .dock-splitter::before { content: ""; position: absolute; inset: 0; margin: auto; background: var(--line-2); border-radius: 99px; }
      main[data-dock="right"] .dock-splitter::before { width: 2px; height: 44px; }
      main[data-dock="bottom"] .dock-splitter::before { height: 2px; width: 44px; }
      .dock-splitter:hover::before, .dock-splitter:focus-visible::before { background: var(--accent); }
      .dock-controls { display: inline-flex; align-items: center; gap: 3px; margin-left: auto; }
      .dock-btn { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border: 1px solid var(--line-2); border-radius: 6px; background: var(--elevated); color: var(--muted); cursor: pointer; font-size: 11px; line-height: 1; }
      .dock-btn:hover { background: #2a2a30; color: var(--ink); }
      .dock-btn[aria-pressed="true"] { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 55%, transparent); }
      .dock-summon { position: fixed; right: 14px; bottom: 14px; z-index: 20; display: inline-flex; align-items: center; gap: 8px; padding: 8px 12px; border: 1px solid var(--line-2); border-radius: 99px; background: color-mix(in srgb, var(--panel) 92%, transparent); backdrop-filter: blur(10px); color: var(--muted); font-family: var(--mono); font-size: 11px; cursor: pointer; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4); }
      .dock-summon[hidden] { display: none; }
      .dock-summon:hover { border-color: #3a3a42; color: var(--ink); }
      .dock-summon-dot { width: 8px; height: 8px; border-radius: 99px; background: var(--accent); flex: 0 0 auto; }
      .dock-summon-dot.warn { background: var(--warn); }
      .dock-summon-dot.bad { background: var(--bad); }
      .dock-summon-cue { color: var(--faint); font-size: 9.5px; }
      .stage-shell, .debug-shell {
        min-height: 0; background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius);
        overflow: hidden; box-shadow: inset 0 1px 0 rgba(255,255,255,0.02), 0 8px 30px rgba(0,0,0,0.35);
      }
      .stage-shell { display: flex; flex-direction: column; }

      /* ----- stage toolbar (primary controls only) ----- */
      .stage-toolbar {
        flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 10px;
        padding: 8px 10px; border-bottom: 1px solid var(--line);
        background: linear-gradient(180deg, var(--panel-2), var(--panel));
      }
      .toolbar-group { display: flex; align-items: center; gap: 6px; min-width: 0; }
      .voice-tools { gap: 6px; }
      .toolbar-divider { width: 1px; align-self: stretch; margin: 2px 2px; background: var(--line); }

      /* ----- buttons / inputs ----- */
      .btn {
        display: inline-flex; align-items: center; gap: 6px; white-space: nowrap;
        border: 1px solid var(--line-2); border-radius: 7px; background: var(--elevated); color: var(--ink);
        height: 28px; padding: 0 10px; cursor: pointer; font-weight: 550;
        transition: background .12s ease, border-color .12s ease, transform .04s ease;
      }
      .btn:hover { background: #2a2a30; border-color: #3a3a42; }
      .btn:active { transform: translateY(1px); }
      .btn.primary {
        border-color: color-mix(in srgb, var(--accent) 60%, transparent); background: var(--accent); color: var(--accent-ink); font-weight: 650;
        box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 30%, transparent), 0 6px 18px color-mix(in srgb, var(--accent) 22%, transparent);
      }
      .btn.primary:hover { background: color-mix(in srgb, var(--accent) 88%, white); }
      .btn:disabled { cursor: not-allowed; opacity: 0.45; }
      :is(button, input, select):focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
      .voice-device { height: 28px; max-width: 178px; border: 1px solid var(--line-2); border-radius: 7px; background: var(--elevated); color: var(--ink); padding: 0 8px; }
      .checkbox-control { display: inline-flex; align-items: center; gap: 5px; height: 28px; padding: 0 8px; border: 1px solid var(--line-2); border-radius: 7px; background: var(--elevated); color: var(--muted); font-size: 11px; user-select: none; }
      .checkbox-control input { accent-color: var(--accent); }
      .energy-wrap { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 9px; border: 1px solid var(--line-2); border-radius: 7px; background: var(--elevated); }
      .energy-meter { width: 64px; height: 6px; border-radius: 99px; overflow: hidden; background: var(--line-2); }
      .energy-meter span { display: block; width: 0%; height: 100%; background: linear-gradient(90deg, var(--accent), #6ee7b7); transition: width .1s linear; }
      .energy-label { min-width: 30px; color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; font-family: var(--mono); text-align: right; }

      /* ----- source tabs ----- */
      .source-tabs { display: flex; gap: 6px; flex-wrap: wrap; }
      .source-tabs button[aria-pressed="true"] { border-color: color-mix(in srgb, var(--blue) 65%, transparent); color: #bfdbfe; background: color-mix(in srgb, var(--blue) 16%, transparent); }

      /* ----- stage grid: source list + canvas ----- */
      .stage-grid { flex: 1 1 auto; min-height: 0; display: grid; grid-template-columns: 150px 1fr; }
      aside { border-right: 1px solid var(--line); background: var(--surface); padding: 10px; overflow: auto; min-height: 0; }
      .source-row {
        width: 100%; display: grid; grid-template-columns: 1fr auto; gap: 6px; align-items: center;
        margin-bottom: 5px; border: 1px solid var(--line); border-radius: 7px; background: var(--panel-2);
        padding: 6px 8px; color: var(--ink); text-align: left; cursor: pointer; transition: border-color .12s, background .12s;
      }
      .source-row:hover { border-color: var(--line-2); background: var(--elevated); }
      .source-row strong { display: block; font-size: 11.5px; line-height: 1.2; font-weight: 600; }
      .source-row span { color: var(--faint); font-size: 9px; font-family: var(--mono); font-variant-numeric: tabular-nums; }
      .source-row[aria-pressed="true"] { border-color: color-mix(in srgb, var(--blue) 70%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--blue) 55%, transparent); background: color-mix(in srgb, var(--blue) 12%, transparent); }
      .canvas-wrap { position: relative; min-width: 0; min-height: 0; display: grid; place-items: center; padding: 10px; overflow: hidden; background: radial-gradient(120% 120% at 50% 0%, #121216, #08080a); }
      .stage-hud { position: absolute; left: 12px; right: 12px; bottom: 12px; display: flex; flex-wrap: wrap; align-items: center; gap: 5px 12px; padding: 6px 11px; border-radius: 9px; border: 1px solid color-mix(in srgb, var(--line-2) 70%, transparent); background: color-mix(in srgb, #000 52%, transparent); backdrop-filter: blur(8px) saturate(130%); font-family: var(--mono); font-size: 10px; color: var(--muted); }
      .hud-chip { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; font-variant-numeric: tabular-nums; }
      .hud-chip b { color: var(--ink); font-weight: 600; }
      .hud-dot { width: 6px; height: 6px; border-radius: 99px; background: var(--faint); flex: 0 0 auto; }
      .hud-chip.ok .hud-dot { background: var(--ok); }
      .hud-chip.warn .hud-dot { background: var(--warn); }
      .hud-chip.bad .hud-dot { background: var(--bad); }
      canvas { aspect-ratio: 16 / 9; max-width: 100%; max-height: 100%; width: auto; height: auto; border-radius: 10px; border: 1px solid var(--line-2); background: #050507; box-shadow: 0 18px 50px rgba(0,0,0,0.55); touch-action: none; }

      /* ----- control dock (secondary / diagnostic controls, below stage) ----- */
      .control-dock {
        flex: 0 0 auto; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 8px;
        padding: 7px 12px; border-top: 1px solid var(--line);
        background: linear-gradient(180deg, var(--panel), var(--surface));
      }
      .dock-group { display: flex; align-items: center; gap: 6px; }
      .dock-group + .dock-group { padding-left: 8px; border-left: 1px solid var(--line); }
      .dock-label { font-size: 9px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--faint); margin-right: 2px; white-space: nowrap; }
      .dock-grow { flex: 1 1 240px; min-width: 200px; }
      .dock-grow form, .dock-grow [data-operator-text-input] { display: flex; flex: 1; gap: 6px; }
      .dock-grow #operator-text-input { flex: 1; min-width: 0; max-width: none; }

      /* ----- debug panel ----- */
      .debug-shell { display: flex; flex-direction: column; }
      .debug-header {
        display: flex; align-items: center; justify-content: space-between; gap: 10px;
        padding: 8px 10px 8px 12px; border-bottom: 1px solid var(--line);
        background: linear-gradient(180deg, var(--panel-2), var(--panel));
      }
      .debug-header h2 { margin: 0; font-size: 11px; letter-spacing: 0.07em; text-transform: uppercase; color: var(--muted); font-weight: 700; }
      .debug-body { flex: 1; overflow: hidden; min-height: 0; padding: 10px; display: flex; flex-direction: column; gap: 10px; }
      /* ----- realtime conversation cockpit (primary) ----- */
      .conversation-panel { flex: 1 1 60%; min-height: 220px; display: flex; flex-direction: column; border: 1px solid var(--line); border-radius: 9px; background: var(--surface); overflow: hidden; }
      .conversation-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 7px 11px; border-bottom: 1px solid var(--line); background: linear-gradient(180deg, var(--panel-2), var(--panel)); }
      .conversation-title { font-size: 10px; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase; color: var(--muted); }
      .conversation-meta { font-size: 10px; color: var(--faint); font-family: var(--mono); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .cockpit-strip { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; padding: 7px 11px; border-bottom: 1px solid var(--line); background: var(--panel); }
      .cockpit-chip { display: inline-flex; align-items: center; gap: 6px; font-family: var(--mono); font-variant-numeric: tabular-nums; font-size: 10.5px; color: var(--muted); white-space: nowrap; }
      .cockpit-dot { width: 7px; height: 7px; border-radius: 99px; background: var(--faint); flex: 0 0 auto; }
      .cockpit-chip.ok .cockpit-dot { background: var(--ok); }
      .cockpit-chip.running .cockpit-dot { background: var(--blue); }
      .cockpit-chip.error { color: var(--bad); }
      .cockpit-chip.error .cockpit-dot { background: var(--bad); }
      .verdict-strip { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 10px; padding: 7px 11px; border-bottom: 1px solid var(--line); background: linear-gradient(180deg, var(--panel-2), var(--panel)); }
      .verdict-badge { font-family: var(--mono); font-size: 10.5px; font-weight: 700; letter-spacing: 0.02em; padding: 2px 9px; border-radius: 6px; white-space: nowrap; color: var(--muted); background: var(--elevated); }
      .verdict-badge.ok { color: #8be8a4; background: #14261a; }
      .verdict-badge.warn { color: #fbbf24; background: #2a2310; }
      .verdict-badge.bad { color: #ff8b8b; background: #3a171d; }
      .verdict-pipeline { display: flex; align-items: center; gap: 3px; flex-wrap: wrap; }
      .stage { display: inline-flex; align-items: center; gap: 5px; font-family: var(--mono); font-size: 9.5px; color: var(--faint); padding: 1px 6px; border-radius: 99px; }
      .stage::before { content: ""; width: 6px; height: 6px; border-radius: 99px; background: var(--faint); flex: 0 0 auto; }
      .stage.ok { color: #cfe9d6; } .stage.ok::before { background: var(--ok); }
      .stage.warn { color: #e9d9b0; } .stage.warn::before { background: var(--warn); }
      .stage.bad { color: #e9b8bc; background: color-mix(in srgb, var(--bad) 14%, transparent); } .stage.bad::before { background: var(--bad); }
      .stage-arrow { color: var(--line-2); font-size: 10px; }
      .verdict-next { font-size: 10px; color: var(--muted); font-family: var(--mono); }
      .verdict-next b { color: var(--ink); font-weight: 600; }
      .conversation-stream { flex: 1; min-height: 0; overflow: auto; }
      .conversation-empty { color: var(--faint); font-size: 12px; text-align: center; padding: 28px 12px; line-height: 1.5; }
      .tl-row { display: flex; flex-direction: column; gap: 3px; width: 100%; text-align: left; background: transparent; border: 0; border-bottom: 1px solid var(--line); border-left: 2px solid transparent; padding: 7px 11px 7px 9px; color: var(--ink); cursor: pointer; }
      .tl-row:hover, .tl-row.open { background: var(--panel-2); }
      .tl-main { display: flex; align-items: center; gap: 9px; }
      .tl-chip { flex: 0 0 auto; min-width: 64px; font-family: var(--mono); font-size: 8.5px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; padding: 2px 7px; border-radius: 5px; background: var(--elevated); color: var(--muted); text-align: center; }
      .tl-summary { flex: 1; min-width: 0; color: var(--ink); font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .tl-status { flex: 0 0 auto; font-family: var(--mono); font-size: 8.5px; font-weight: 650; padding: 1px 7px; border-radius: 99px; white-space: nowrap; color: var(--muted); background: var(--elevated); }
      .tl-dur { flex: 0 0 auto; min-width: 34px; color: var(--faint); font-family: var(--mono); font-size: 9.5px; text-align: right; }
      .tl-meta { display: flex; flex-wrap: wrap; gap: 4px 9px; color: var(--faint); font-size: 9px; font-family: var(--mono); font-variant-numeric: tabular-nums; padding-left: 1px; }
      .tl-user { border-left-color: #5da7ff; }
      .tl-assistant { border-left-color: var(--accent); }
      .tl-tool { border-left-color: #61d8c6; }
      .tl-connection { border-left-color: #747782; }
      .tl-error { border-left-color: #ff5f6d; }
      .tl-user .tl-chip { color: #5da7ff; }
      .tl-assistant .tl-chip { color: var(--accent); }
      .tl-tool .tl-chip { color: #61d8c6; }
      .tl-connection .tl-chip { color: #9aa0aa; }
      .tl-error .tl-chip { color: #ff8b8b; }
      .tl-status.ok { color: #8be8a4; background: #14261a; }
      .tl-status.running { color: #90c8ff; background: #15233a; }
      .tl-status.error { color: #ff8b8b; background: #3a171d; }
      .tl-raw { margin-top: 6px; padding: 8px 9px; border-radius: 6px; background: #0a0a0c; border: 1px solid var(--line); color: #c9c9cf; font-family: var(--mono); font-size: 10px; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 220px; overflow: auto; }
      /* ----- telemetry (secondary) ----- */
      .debug-panel-bar { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      .debug-tablist { display: inline-flex; gap: 3px; }
      .debug-tab { border: 1px solid var(--line); border-radius: 7px; background: var(--panel-2); color: var(--muted); height: 26px; padding: 0 11px; cursor: pointer; font-size: 11px; font-weight: 600; }
      .debug-tab:hover { background: var(--elevated); color: var(--ink); }
      .debug-tab[aria-selected="true"] { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 55%, transparent); background: color-mix(in srgb, var(--accent) 12%, var(--panel-2)); }
      .tabpanel[hidden] { display: none; }
      .telemetry-wrap { display: flex; flex: 1 1 auto; min-height: 0; overflow: auto; flex-direction: column; gap: 10px; border: 1px solid var(--line); border-radius: 9px; background: var(--surface); padding: 10px; }
      .telemetry-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 10px; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase; color: var(--faint); }
      .telemetry-head .toolbar-group { gap: 6px; }
      .metric-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: 6px; }
      .metric { min-height: 0; border: 1px solid var(--line); border-radius: 8px; background: linear-gradient(180deg, var(--panel-2), var(--panel)); padding: 7px 8px; display: flex; flex-direction: column; gap: 3px; }
      .metric b { color: var(--faint); font-size: 9.5px; font-weight: 650; letter-spacing: 0.06em; text-transform: uppercase; }
      .metric span { font-size: 12.5px; font-family: var(--mono); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; line-height: 1.25; }
      .debug-filter { display: flex; align-items: center; gap: 8px; }
      .debug-filter input { flex: 1; min-width: 0; height: 30px; border: 1px solid var(--line-2); border-radius: 7px; padding: 0 10px; background: var(--surface); color: var(--ink); }
      .debug-filter input::placeholder { color: var(--faint); }
      .debug-filter span { min-width: 84px; color: var(--faint); font-size: 10.5px; text-align: right; font-family: var(--mono); }
      .debug-sections { display: grid; gap: 8px; }
      .debug-section { border: 1px solid var(--line); border-radius: 8px; background: var(--panel); overflow: hidden; }
      .debug-section[data-filter-hidden="true"], .debug-table tr[data-filter-hidden="true"], pre[data-filter-hidden="true"] { display: none; }
      .debug-section-title {
        display: flex; align-items: center; justify-content: space-between; gap: 8px;
        min-height: 30px; padding: 6px 10px; border-bottom: 1px solid var(--line);
        color: var(--faint); font-size: 10px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
        background: var(--panel-2);
      }
      .debug-section-title span { color: var(--ink); font-weight: 600; letter-spacing: 0; text-transform: none; font-family: var(--mono); font-size: 10.5px; }
      .debug-table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 10.5px; font-family: var(--mono); font-variant-numeric: tabular-nums; }
      .debug-table th, .debug-table td { padding: 4px 8px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; overflow-wrap: anywhere; }
      .debug-table th { color: var(--faint); font-weight: 600; background: var(--surface); text-transform: uppercase; font-size: 9.5px; letter-spacing: 0.04em; }
      .debug-table tbody tr:nth-child(even) { background: color-mix(in srgb, var(--elevated) 32%, transparent); }
      .debug-table tr:last-child td { border-bottom: 0; }
      .debug-ok { color: var(--ok); font-weight: 650; }
      .debug-warn { color: var(--warn); font-weight: 650; }
      .debug-bad { color: var(--bad); font-weight: 650; }
      td.debug-ok { box-shadow: inset 2px 0 0 var(--ok); }
      td.debug-warn { box-shadow: inset 2px 0 0 var(--warn); }
      td.debug-bad { box-shadow: inset 2px 0 0 var(--bad); }
      pre { margin: 0; padding: 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); color: #d4d4d8; font-size: 10.5px; line-height: 1.5; font-family: var(--mono); overflow: auto; max-height: 48vh; }

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
          <div class="stage-toolbar">
            <div class="toolbar-group source-tabs" id="source-tabs"></div>
            <div class="toolbar-group voice-tools">
              <select class="voice-device" id="voice-device-select" aria-label="Microphone">
                <option value="">Default mic</option>
              </select>
              <button class="btn primary" id="voice-button" type="button">Arm</button>
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
          <div class="stage-grid">
            <aside id="source-list"></aside>
            <div class="canvas-wrap">
              <canvas id="composition" width="1280" height="720"></canvas>
              <div class="stage-hud" id="stage-hud"></div>
            </div>
          </div>
          <div class="control-dock">
            <div class="dock-group">
              <span class="dock-label">Devices</span>
              <button class="btn" id="refresh-voice-devices-button" type="button">Refresh</button>
            </div>
            <div class="dock-group">
              <span class="dock-label">Session</span>
              <button class="btn" id="overlay-button" type="button">Ping Overlay</button>
              <button class="btn" id="cancel-response-button" type="button">Cancel</button>
              <button class="btn" id="cancel-tool-button" type="button">Cancel Tool</button>
              <button class="btn" id="clear-audio-button" type="button">Clear Audio</button>
              <button class="btn" id="reset-session-button" type="button">Reset</button>
            </div>
            <div class="dock-group">
              <span class="dock-label">Debug</span>
              <button class="btn" id="open-debug-panel-button" type="button">Telemetry</button>
            </div>
            <div class="dock-group dock-grow" id="operator-input-dock">
              <span class="dock-label">Input</span>
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
                <button class="dock-btn" id="dock-hide-button" type="button" title="Hide debug (\`)">✕</button>
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
                <div class="conversation-empty">No messages yet. Arm the mic and speak, or type below and hit Send Text.</div>
              </div>
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
        <span id="dock-summon-text">debug hidden</span>
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
            const hud = (tone, label, value) => {
              const c = document.createElement("span");
              c.className = "hud-chip" + (tone ? " " + tone : "");
              const d = document.createElement("span"); d.className = "hud-dot"; c.appendChild(d);
              if (label) c.appendChild(document.createTextNode(label + " "));
              const b = document.createElement("b"); b.textContent = value; c.appendChild(b);
              return c;
            };
            stageHud.innerHTML = "";
            stageHud.appendChild(hud(vTone, "webrtc", String(vConn)));
            stageHud.appendChild(hud("", "", String(composition.mode || "live") + " " + String(composition.width) + "x" + String(composition.height) + " @" + String(composition.targetFps) + "fps"));
            stageHud.appendChild(hud("", "tracks", String(state.visual.trackCount || 0)));
            stageHud.appendChild(hud("", "sources", String((state.sources || []).length)));
            if (focusName) stageHud.appendChild(hud("", "focus", focusName));
            stageHud.appendChild(hud("", "frame", durationLabel(composition.lastRenderedFrameAgeMs)));
          }
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
          text.textContent = "debug hidden · " + label;
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
        for (const [tabId, , tabName] of DEBUG_TABS) {
          document.getElementById(tabId)?.addEventListener("click", () => setDebugTab(tabName));
        }
        setDebugTab("ledger");
        document.getElementById("dock-right-button")?.addEventListener("click", () => setDock("right"));
        document.getElementById("dock-bottom-button")?.addEventListener("click", () => setDock("bottom"));
        document.getElementById("dock-hide-button")?.addEventListener("click", () => setDock("hidden"));
        document.getElementById("dock-summon")?.addEventListener("click", () => setDock(dockLastOpen));
        document.getElementById("dock-splitter")?.addEventListener("pointerdown", startDockResize);
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
