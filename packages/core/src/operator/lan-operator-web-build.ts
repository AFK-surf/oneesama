import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

export interface OperatorWebBoot {
  sessionId: string;
  token?: string;
  conversationTransport?: string;
  botName?: string;
  webrtcIceServers?: Array<Record<string, unknown>>;
}

const ENTRY = fileURLToPath(new URL("./web/main.tsx", import.meta.url));

let cachedBundle: Promise<string> | null = null;

/**
 * Bundle the React operator app (web/main.tsx) to a single IIFE via esbuild,
 * in-memory and cached. No dist files, no separate build step — the operator
 * server serves the result. This is the new React surface (`/operator2`); the
 * legacy string surface stays at `/operator` until parity.
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
      :root { --bg:#eef0f4; --surface:#fff; --panel:#f7f8fa; --ink:#1b1d22; --muted:#5b616e; --faint:#8b909c; --line:#e4e6ea; --accent:#0f9d6e; --blue:#2563c9; color-scheme:light; }
      * { box-sizing: border-box; }
      body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif; }
      .op { display:flex; flex-direction:column; height:100vh; }
      .op-header { display:flex; align-items:center; justify-content:space-between; padding:14px 20px; border-bottom:1px solid var(--line); background:var(--surface); }
      .op-title { font-weight:680; font-size:15px; }
      .op-status { font-family:ui-monospace,Menlo,monospace; font-size:11.5px; color:var(--muted); display:flex; align-items:center; gap:6px; }
      .op-status .dot { width:8px; height:8px; border-radius:50%; display:inline-block; }
      .op-body { flex:1; min-height:0; display:grid; grid-template-columns:minmax(0,1fr) 380px; gap:14px; padding:14px; }
      @media (max-width:880px) { .op-body { grid-template-columns:1fr; grid-template-rows:minmax(220px,1fr) minmax(220px,1fr); } }
      .op-left { display:flex; flex-direction:column; gap:10px; min-width:0; }
      .op-stage { flex:1; min-height:0; display:flex; flex-direction:column; border:1px solid var(--line); border-radius:12px; overflow:hidden; background:var(--surface); }
      .op-stage-tabs { display:flex; gap:3px; padding:6px; border-bottom:1px solid var(--line); }
      .op-stage-tabs button { height:28px; padding:0 14px; border:0; border-radius:7px; background:transparent; color:var(--muted); font:inherit; font-weight:560; cursor:pointer; }
      .op-stage-tabs button.active { color:#1a44b8; background:color-mix(in srgb,var(--blue) 14%,transparent); }
      .op-stage-frame { flex:1; min-height:0; position:relative; background:#0f172a; }
      .op-stage-frame iframe { position:absolute; inset:0; width:100%; height:100%; border:0; }
      .op-mic { display:flex; align-items:center; gap:8px; flex:0 0 auto; }
      .op-mic-hint { font-size:11px; color:var(--faint); }
      .op-energy { width:80px; height:6px; border-radius:3px; background:var(--line); overflow:hidden; }
      .op-energy-bar { display:block; height:100%; background:var(--accent); transition:width .08s linear; }
      .op-conv { display:flex; flex-direction:column; min-height:0; border:1px solid var(--line); border-radius:12px; overflow:hidden; background:var(--surface); }
      .op-conv-tabs { display:flex; gap:3px; padding:6px; border-bottom:1px solid var(--line); flex:0 0 auto; }
      .op-conv-tabs button { height:28px; padding:0 14px; border:0; border-radius:7px; background:transparent; color:var(--muted); font:inherit; font-weight:560; cursor:pointer; }
      .op-conv-tabs button.active { color:#1a44b8; background:color-mix(in srgb,var(--blue) 14%,transparent); }
      .op-stream { flex:1; min-height:0; overflow:auto; padding:16px 18px; display:flex; flex-direction:column; gap:10px; }
      .op-work { display:flex; flex-direction:column; min-height:0; flex:1; }
      .op-work .op-input { padding:12px 14px; border-bottom:1px solid var(--line); }
      .op-work-body { flex:1; min-height:0; overflow:auto; padding:14px; display:flex; flex-direction:column; gap:10px; }
      .op-work-head { display:flex; align-items:center; gap:8px; }
      .op-work-phase { font-family:ui-monospace,Menlo,monospace; font-size:11.5px; padding:2px 8px; border-radius:6px; background:var(--panel); color:var(--muted); }
      .op-work-phase.phase-done { color:#0a7a52; background:color-mix(in srgb,var(--accent) 14%,white); }
      .op-work-phase.phase-error, .op-work-phase.phase-not_a_command { color:#b5322b; background:color-mix(in srgb,#b5322b 12%,white); }
      .op-work-phase.phase-running { color:#9a6310; background:color-mix(in srgb,#9a6310 14%,white); }
      .op-work-tag { font-family:ui-monospace,Menlo,monospace; font-size:11px; color:var(--faint); }
      .op-work-intent { font-weight:560; }
      .op-work-steps { margin:0; padding-left:18px; display:flex; flex-direction:column; gap:6px; font-size:13px; }
      .op-work-steps li.failed { color:#b5322b; }
      .op-work-step-op { font-family:ui-monospace,Menlo,monospace; font-size:12px; }
      .op-work-step-why { display:block; color:var(--muted); font-size:12px; }
      .op-work-step-err { display:block; color:#b5322b; font-size:12px; }
      .op-work-result { display:flex; flex-direction:column; gap:6px; border-top:1px solid var(--line); padding-top:10px; }
      .op-work-check { font-family:ui-monospace,Menlo,monospace; font-size:12px; }
      .op-work-extract { background:var(--panel); border-radius:8px; padding:10px; font-size:13px; white-space:pre-wrap; }
      .op-empty { color:var(--faint); text-align:center; margin:auto; font-size:13px; }
      .op-turn { display:flex; flex-direction:column; gap:3px; max-width:78%; padding:9px 12px; border-radius:12px; }
      .op-turn-you { align-self:flex-end; background:color-mix(in srgb,var(--blue) 12%,white); }
      .op-turn-bot { align-self:flex-start; background:var(--surface); border:1px solid var(--line); }
      .op-turn-role { font-size:10px; color:var(--faint); text-transform:uppercase; letter-spacing:0.04em; }
      .op-turn-text { white-space:pre-wrap; }
      .op-turn-status { font-size:10px; color:var(--faint); }
      .op-error { color:#b5322b; font-size:12px; }
      .op-composer { border-top:1px solid var(--line); background:var(--surface); padding:12px 18px; display:flex; flex-direction:column; gap:8px; }
      .op-conn { display:flex; align-items:center; justify-content:space-between; }
      .op-conn-label { font-family:ui-monospace,Menlo,monospace; font-size:11.5px; }
      .op-conn-label.ok { color:#0a7a52; } .op-conn-label.off { color:var(--muted); }
      .op-input { display:flex; gap:8px; }
      .op-input input { flex:1; height:38px; padding:0 12px; border:1px solid var(--line); border-radius:9px; font:inherit; }
      .btn { height:38px; padding:0 16px; border:1px solid var(--line); border-radius:9px; background:var(--surface); color:var(--ink); font:inherit; font-weight:560; cursor:pointer; }
      .btn:disabled { opacity:0.5; cursor:not-allowed; }
      .btn.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
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
