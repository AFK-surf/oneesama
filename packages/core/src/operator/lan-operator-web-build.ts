import { fileURLToPath } from "node:url";

import { build as viteBuild } from "vite-plus";
import type { InlineConfig } from "vite-plus";

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
export const OPERATOR_WEB_BUNDLER = "vite-plus";

let cachedBundle: Promise<string> | null = null;

interface OperatorWebBuildResult {
  output?: unknown[];
}

interface OperatorWebOutputChunk {
  code: string;
  isEntry?: boolean;
  type: "chunk";
}

/**
 * Bundle the React operator app (web/main.tsx) to a single IIFE via Vite+,
 * in-memory and cached. No dist files, no separate build step - the operator
 * server serves the result at `/operator` (bundle at `/operator/app.js`); the
 * legacy string surface stays at the root `/`.
 */
export function buildOperatorWebBundle(): Promise<string> {
  if (!cachedBundle) {
    cachedBundle = viteBuild(buildOperatorWebBundleConfig())
      .then((result) => extractOperatorWebEntryChunk(result).code)
      .catch((error) => {
        cachedBundle = null; // allow retry after a fix
        throw error;
      });
  }
  return cachedBundle;
}

function buildOperatorWebBundleConfig(): InlineConfig {
  return {
    configFile: false,
    mode: "production",
    logLevel: "silent",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: {
      cssCodeSplit: false,
      emptyOutDir: false,
      lib: {
        entry: ENTRY,
        fileName: () => "operator-app.js",
        formats: ["iife"],
        name: "OneesamaOperatorWeb",
      },
      minify: true,
      sourcemap: false,
      target: "es2022",
      write: false,
    },
  };
}

function extractOperatorWebEntryChunk(result: unknown): OperatorWebOutputChunk {
  const results = Array.isArray(result) ? result : [result];
  const output = results
    .flatMap((item) => (isOperatorWebBuildResult(item) ? item.output || [] : []))
    .filter(isOperatorWebOutputChunk);
  const entryChunk = output.find((item) => item.isEntry);
  if (!entryChunk) {
    throw new Error("operator_web_bundle_entry_chunk_missing");
  }
  return entryChunk;
}

function isOperatorWebBuildResult(value: unknown): value is OperatorWebBuildResult {
  return Boolean(value && typeof value === "object" && "output" in value);
}

function isOperatorWebOutputChunk(value: unknown): value is OperatorWebOutputChunk {
  return Boolean(
    value &&
    typeof value === "object" &&
    "type" in value &&
    value.type === "chunk" &&
    "code" in value &&
    typeof value.code === "string",
  );
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
