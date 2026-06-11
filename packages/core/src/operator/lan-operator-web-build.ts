import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

import type { LanOperatorLiveProviderConfig } from "./lan-operator-live-provider-config.ts";
import { OPERATOR_WEB_STYLES } from "./operator-web-styles.ts";

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
    <style>${OPERATOR_WEB_STYLES}</style>
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
