import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

import type { LanOperatorLiveProviderConfig } from "./lan-operator-live-provider-config.ts";

export interface OperatorWebBoot {
  sessionId: string;
  token?: string;
  conversationTransport?: string;
  botName?: string;
  webrtcIceServers?: Array<Record<string, unknown>>;
  liveProviderConfig?: LanOperatorLiveProviderConfig | null;
}

const ENTRY = fileURLToPath(new URL("./web/main.tsx", import.meta.url));

let cachedBundle: Promise<string> | null = null;

/**
 * Bundle the React operator app (web/main.tsx) to a single IIFE via esbuild,
 * in-memory and cached. No dist files, no separate build step — the operator
 * server serves the result at `/operator` (bundle at `/operator/app.js`); the
 * legacy string surface stays at the root `/`.
 */
export function buildOperatorWebBundle(): Promise<string> {
  if (!cachedBundle) {
    cachedBundle = esbuild
      .build({
        entryPoints: [ENTRY],
        bundle: true,
        format: "iife",
        platform: "browser",
        target: ["es2022"],
        jsx: "automatic",
        write: false,
        minify: true,
        sourcemap: false,
        define: { "process.env.NODE_ENV": '"production"' },
        logLevel: "silent",
      })
      .then((result) => result.outputFiles[0]?.text ?? "")
      .catch((error) => {
        cachedBundle = null; // allow retry after a fix
        throw error;
      });
  }
  return cachedBundle;
}

function escapeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</gu, "\\u003c");
}

/** Minimal HTML shell that boots the React bundle. */
export function buildOperatorWebShellHtml(boot: OperatorWebBoot, bundleUrl: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtmlText(boot.botName || "Oneesama")} Operator</title>
    <style>
      :root {
        --bg:#e8ebef;
        --surface:#ffffff;
        --panel:#f5f7f9;
        --ink:#20242b;
        --muted:#5d6673;
        --faint:#87909e;
        --line:#dce1e7;
        --line-strong:#c6ced8;
        --green:#15845f;
        --blue:#2458c7;
        --amber:#9a6415;
        --red:#b43a32;
        --stage:#111827;
        color-scheme:light;
      }
      * { box-sizing:border-box; }
      body {
        margin:0;
        background:var(--bg);
        color:var(--ink);
        font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;
      }
      button, input, select { font:inherit; letter-spacing:0; }
      .op { display:flex; flex-direction:column; height:100vh; min-width:0; }
      .op-command {
        flex:0 0 auto;
        display:grid;
        grid-template-columns:210px minmax(320px,1fr) auto;
        gap:14px;
        align-items:center;
        padding:10px 12px;
        border-bottom:1px solid var(--line);
        background:var(--surface);
      }
      .op-brand-name { font-size:16px; font-weight:720; }
      .op-brand-sub { color:var(--muted); font-size:12px; }
      .op-command-center { min-width:0; display:flex; align-items:center; gap:10px; }
      .op-provider { display:grid; grid-template-columns:auto 210px; gap:8px; align-items:center; }
      .op-provider > span { color:var(--muted); font-size:12px; }
      .op-provider-detail {
        min-width:0;
        display:flex;
        gap:6px;
        flex-wrap:wrap;
        color:var(--muted);
        font:12px ui-monospace,Menlo,monospace;
      }
      .op-provider-detail span {
        padding:3px 7px;
        border:1px solid var(--line);
        border-radius:6px;
        background:var(--panel);
      }
      .op-command-actions { display:flex; align-items:center; justify-content:flex-end; gap:7px; flex-wrap:wrap; }
      .op-main {
        flex:1;
        min-height:0;
        display:grid;
        grid-template-columns:minmax(420px,1.15fr) minmax(360px,0.9fr) minmax(310px,0.75fr);
        gap:10px;
        padding:10px;
      }
      .op-left-rail, .op-center-rail {
        min-width:0;
        min-height:0;
        display:flex;
        flex-direction:column;
        gap:10px;
      }
      .op-stage, .op-voice, .op-conversation, .op-work, .op-diagnostics {
        min-width:0;
        min-height:0;
        border:1px solid var(--line);
        border-radius:8px;
        background:var(--surface);
        overflow:hidden;
      }
      .op-stage { flex:1 1 58%; display:flex; flex-direction:column; }
      .op-voice { flex:0 0 auto; }
      .op-conversation { flex:1 1 54%; display:flex; flex-direction:column; }
      .op-work { flex:1 1 46%; display:flex; flex-direction:column; }
      .op-diagnostics { display:flex; flex-direction:column; }
      .op-diagnostics.closed { flex:0 0 auto; min-height:auto; }
      .op-panel-head {
        flex:0 0 auto;
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:10px;
        padding:10px 12px;
        border-bottom:1px solid var(--line);
        background:linear-gradient(180deg,#fff,#fafbfc);
      }
      .op-panel-head.compact { border-bottom:0; padding-bottom:8px; }
      .op-panel-head h2 { margin:0; font-size:13px; font-weight:720; }
      .op-panel-head p { margin:2px 0 0; color:var(--muted); font-size:12px; }
      .op-stage-actions { display:flex; gap:6px; }
      .op-stage-tabs {
        flex:0 0 auto;
        display:flex;
        gap:6px;
        padding:8px;
        border-bottom:1px solid var(--line);
        overflow:auto;
      }
      .op-stage-tabs button {
        display:flex;
        align-items:center;
        gap:6px;
        height:30px;
        padding:0 10px;
        border:1px solid transparent;
        border-radius:7px;
        background:transparent;
        color:var(--muted);
        cursor:pointer;
        white-space:nowrap;
      }
      .op-stage-tabs button.active {
        color:var(--blue);
        border-color:color-mix(in srgb,var(--blue) 24%,white);
        background:color-mix(in srgb,var(--blue) 10%,white);
      }
      .op-stage-tabs em { color:var(--faint); font-style:normal; font-size:11px; }
      .op-stage-frame { flex:1; min-height:220px; position:relative; background:var(--stage); }
      .op-stage-frame iframe { position:absolute; inset:0; width:100%; height:100%; border:0; }
      .op-stage-telemetry {
        flex:0 0 auto;
        display:grid;
        grid-template-columns:repeat(3,minmax(0,1fr));
        border-top:1px solid var(--line);
      }
      .op-metric, .op-mini-metric {
        min-width:0;
        display:flex;
        flex-direction:column;
        gap:1px;
        padding:7px 9px;
        border-right:1px solid var(--line);
      }
      .op-metric:nth-child(3n), .op-mini-metric:last-child { border-right:0; }
      .op-metric span, .op-mini-metric span { color:var(--faint); font-size:11px; }
      .op-metric strong, .op-mini-metric strong {
        overflow:hidden;
        text-overflow:ellipsis;
        color:var(--ink);
        font:12px ui-monospace,Menlo,monospace;
        white-space:nowrap;
      }
      .op-voice-controls {
        display:grid;
        grid-template-columns:minmax(170px,1fr) repeat(4,auto) auto auto;
        gap:7px;
        align-items:center;
        padding:0 12px 12px;
      }
      .op-voice-meter {
        width:120px;
        height:8px;
        border-radius:4px;
        background:var(--line);
        overflow:hidden;
      }
      .op-voice-meter-fill {
        display:block;
        height:100%;
        background:linear-gradient(90deg,var(--green),#4aa66f);
        transition:width .08s linear;
      }
      .op-check { display:flex; align-items:center; gap:6px; color:var(--muted); white-space:nowrap; }
      .op-inline-state { color:var(--faint); font:12px ui-monospace,Menlo,monospace; white-space:nowrap; }
      .op-mini-metrics { display:grid; grid-template-columns:repeat(3,82px); border:1px solid var(--line); border-radius:7px; overflow:hidden; }
      .op-milestones {
        flex:0 0 auto;
        display:flex;
        gap:5px;
        flex-wrap:wrap;
        padding:8px 12px;
        border-bottom:1px solid var(--line);
        background:var(--panel);
      }
      .op-milestones span {
        padding:2px 7px;
        border-radius:6px;
        color:var(--faint);
        background:#fff;
        border:1px solid var(--line);
        font-size:11px;
      }
      .op-milestones span.done { color:var(--green); border-color:color-mix(in srgb,var(--green) 32%,white); }
      .op-stream {
        flex:1;
        min-height:0;
        overflow:auto;
        padding:12px;
        display:flex;
        flex-direction:column;
        gap:9px;
        background:#fbfcfd;
      }
      .op-turn {
        display:flex;
        flex-direction:column;
        gap:3px;
        max-width:84%;
        padding:8px 10px;
        border-radius:8px;
        border:1px solid var(--line);
        background:#fff;
      }
      .op-turn-you {
        align-self:flex-end;
        border-color:color-mix(in srgb,var(--blue) 20%,white);
        background:color-mix(in srgb,var(--blue) 8%,white);
      }
      .op-turn-bot { align-self:flex-start; }
      .op-turn.live { border-color:color-mix(in srgb,var(--green) 24%,white); }
      .op-turn-role { color:var(--faint); font-size:10px; text-transform:uppercase; letter-spacing:0; }
      .op-turn-text { white-space:pre-wrap; overflow-wrap:anywhere; }
      .op-turn-status { color:var(--faint); font-size:10px; }
      .op-composer {
        flex:0 0 auto;
        display:grid;
        grid-template-columns:minmax(0,1fr) auto;
        gap:8px;
        padding:10px 12px;
        border-top:1px solid var(--line);
        background:var(--surface);
      }
      .op-composer input, .op-input input, .op-filter {
        min-width:0;
        width:100%;
        height:36px;
        padding:0 10px;
        border:1px solid var(--line-strong);
        border-radius:7px;
        background:#fff;
        color:var(--ink);
      }
      .op-input { flex:0 0 auto; display:grid; grid-template-columns:minmax(0,1fr) auto; gap:8px; padding:10px 12px; border-bottom:1px solid var(--line); }
      .op-work-body { flex:1; min-height:0; overflow:auto; padding:10px 12px; display:flex; flex-direction:column; gap:10px; }
      .op-work-kwwk, .op-work-head {
        display:flex;
        flex-wrap:wrap;
        gap:7px;
        align-items:center;
        color:var(--muted);
        font:12px ui-monospace,Menlo,monospace;
      }
      .op-work-kwwk span:not(.op-work-phase) {
        padding:3px 7px;
        border:1px solid var(--line);
        border-radius:6px;
        background:var(--panel);
      }
      .op-work-phase {
        font:12px ui-monospace,Menlo,monospace;
        padding:3px 8px;
        border-radius:6px;
        background:var(--panel);
        color:var(--muted);
      }
      .op-work-phase.phase-done,
      .op-work-phase.phase-completed { color:var(--green); background:color-mix(in srgb,var(--green) 12%,white); }
      .op-work-phase.phase-error,
      .op-work-phase.phase-failed,
      .op-work-phase.phase-blocked,
      .op-work-phase.phase-not_a_command { color:var(--red); background:color-mix(in srgb,var(--red) 10%,white); }
      .op-work-phase.phase-running,
      .op-work-phase.phase-queued,
      .op-work-phase.phase-observing,
      .op-work-phase.phase-planning,
      .op-work-phase.phase-executing,
      .op-work-phase.phase-verifying { color:var(--amber); background:color-mix(in srgb,var(--amber) 12%,white); }
      .op-work-actions { display:flex; flex-direction:column; gap:5px; }
      .op-work-actions div {
        display:grid;
        grid-template-columns:90px minmax(0,1fr) 72px;
        gap:8px;
        align-items:center;
        padding:6px 8px;
        border:1px solid var(--line);
        border-radius:7px;
        background:var(--panel);
        font-size:12px;
      }
      .op-work-actions span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .op-work-actions em { color:var(--muted); font-style:normal; text-align:right; }
      .op-work-tag, .op-work-check { color:var(--faint); font:12px ui-monospace,Menlo,monospace; }
      .op-work-intent { font-weight:650; }
      .op-work-steps { margin:0; padding-left:18px; display:flex; flex-direction:column; gap:6px; font-size:13px; }
      .op-work-steps li.failed, .op-work-step-err, .op-error { color:var(--red); }
      .op-work-step-op { font:12px ui-monospace,Menlo,monospace; }
      .op-work-step-why { display:block; color:var(--muted); font-size:12px; }
      .op-work-result { display:flex; flex-direction:column; gap:6px; border-top:1px solid var(--line); padding-top:10px; }
      .op-work-extract, .op-raw {
        margin:0;
        padding:10px;
        border:1px solid var(--line);
        border-radius:7px;
        background:var(--panel);
        overflow:auto;
        white-space:pre-wrap;
        font:12px ui-monospace,Menlo,monospace;
      }
      .op-diagnostic-tabs { display:grid; grid-template-columns:repeat(4,1fr); gap:5px; padding:8px; border-bottom:1px solid var(--line); }
      .op-diagnostic-tabs button {
        height:30px;
        border:1px solid transparent;
        border-radius:7px;
        background:transparent;
        color:var(--muted);
        cursor:pointer;
      }
      .op-diagnostic-tabs button.active {
        color:var(--blue);
        border-color:color-mix(in srgb,var(--blue) 22%,white);
        background:color-mix(in srgb,var(--blue) 9%,white);
      }
      .op-diagnostic-body { flex:1; min-height:0; overflow:auto; padding:10px; display:flex; flex-direction:column; gap:10px; }
      .op-metric-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:7px; }
      .op-metric-grid div, .op-source-row {
        min-width:0;
        padding:8px;
        border:1px solid var(--line);
        border-radius:7px;
        background:var(--panel);
      }
      .op-metric-grid span, .op-source-row span { display:block; color:var(--faint); font-size:11px; }
      .op-metric-grid strong, .op-source-row strong {
        display:block;
        overflow:hidden;
        text-overflow:ellipsis;
        white-space:nowrap;
        font:12px ui-monospace,Menlo,monospace;
      }
      .op-source-row { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:8px; align-items:center; }
      .op-source-row div:last-child { display:flex; gap:8px; color:var(--muted); font:12px ui-monospace,Menlo,monospace; }
      .op-timeline-list { display:flex; flex-direction:column; gap:5px; }
      .op-timeline-list div {
        display:grid;
        grid-template-columns:92px minmax(0,1fr) 58px;
        gap:7px;
        padding:6px 8px;
        border:1px solid var(--line);
        border-radius:7px;
        background:#fff;
        font-size:12px;
      }
      .op-timeline-list div.bad { border-color:color-mix(in srgb,var(--red) 35%,white); color:var(--red); }
      .op-timeline-list span, .op-timeline-list em { color:var(--faint); font-style:normal; }
      .op-timeline-list strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .op-raw-actions { display:flex; gap:7px; flex-wrap:wrap; }
      .op-raw { min-height:360px; }
      .op-alert-list { display:flex; flex-direction:column; gap:6px; }
      .op-alert { padding:8px; border:1px solid color-mix(in srgb,var(--red) 35%,white); border-radius:7px; color:var(--red); background:color-mix(in srgb,var(--red) 7%,white); font-size:12px; }
      .op-empty { color:var(--faint); text-align:center; margin:auto; font-size:13px; }
      .op-empty.small { margin:0; padding:12px; }
      .op-error { font-size:12px; }
      .op-select {
        min-width:0;
        height:34px;
        padding:0 9px;
        border:1px solid var(--line-strong);
        border-radius:7px;
        background:#fff;
        color:var(--ink);
      }
      .btn {
        height:34px;
        padding:0 11px;
        border:1px solid var(--line-strong);
        border-radius:7px;
        background:#fff;
        color:var(--ink);
        font-weight:610;
        cursor:pointer;
        white-space:nowrap;
      }
      .btn:hover:not(:disabled) { border-color:#aeb8c4; background:#f8fafc; }
      .btn:disabled { opacity:.48; cursor:not-allowed; }
      .btn.primary { background:var(--green); border-color:var(--green); color:#fff; }
      .btn.primary:hover:not(:disabled) { background:#126f52; }
      .btn.danger { color:var(--red); border-color:color-mix(in srgb,var(--red) 30%,white); }
      .op-status-pill {
        display:flex;
        flex-direction:column;
        justify-content:center;
        min-width:74px;
        height:34px;
        padding:3px 8px;
        border:1px solid var(--line);
        border-radius:7px;
        background:var(--panel);
      }
      .op-status-pill span { color:var(--faint); font-size:10px; }
      .op-status-pill strong {
        overflow:hidden;
        text-overflow:ellipsis;
        white-space:nowrap;
        font:12px ui-monospace,Menlo,monospace;
      }
      .op-status-pill.tone-ok strong { color:var(--green); }
      .op-status-pill.tone-warn strong { color:var(--amber); }
      .op-status-pill.tone-bad strong { color:var(--red); }
      .op-status-pill.tone-idle strong { color:var(--muted); }
      @media (max-width:1180px) {
        .op-command { grid-template-columns:1fr; }
        .op-command-actions { justify-content:flex-start; }
        .op-main { grid-template-columns:1fr; overflow:auto; }
        .op-left-rail, .op-center-rail, .op-diagnostics { min-height:520px; }
      }
      @media (max-width:720px) {
        .op-main { padding:7px; gap:7px; }
        .op-provider { grid-template-columns:1fr; }
        .op-command-center, .op-command-actions, .op-voice-controls { align-items:stretch; flex-direction:column; display:flex; }
        .op-stage-telemetry, .op-metric-grid { grid-template-columns:1fr; }
        .op-mini-metrics { grid-template-columns:1fr; width:100%; }
        .op-turn { max-width:100%; }
      }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script>window.__OPERATOR_BOOT__ = ${escapeJson(boot)};</script>
    <script src="${bundleUrl}"></script>
  </body>
</html>`;
}

function escapeHtmlText(value: string): string {
  return value.replace(
    /[&<>"]/gu,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] || c,
  );
}
