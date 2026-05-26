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

function shouldInjectRealtimeAgentsSDK(config: Record<string, unknown>): boolean {
  const runtime = normalizeAgentRuntime(config.agentRuntime);
  return ["agents-sdk", "openai-agents", "openai-agents-sdk"].includes(runtime);
}

export function readRealtimeAgentsSDKBundle() {
  const entryPath = require.resolve("@openai/agents-realtime");
  const bundlePath = resolve(dirname(entryPath), "bundle/openai-realtime-agents.umd.js");
  const packagePath = resolve(dirname(entryPath), "../package.json");
  const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: string };
  return {
    source: readFileSync(bundlePath, "utf8"),
    version: pkg.version || "",
    bundlePath,
  };
}

export function buildRealtimeBrowserInitScript(config = {}) {
  const normalizedConfig = config as Record<string, unknown>;
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
      "./realtime-browser-local-tool-helpers.js",
      "./realtime-browser-local-tool-helpers.ts",
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
      "./realtime-browser-context-helpers.js",
      "./realtime-browser-context-helpers.ts",
    ),
  ];
  const source = readBrowserInitSource(
    import.meta.url,
    "./realtime-browser-bridge.js",
    "./realtime-browser-bridge.ts",
  );
  if (!shouldInjectRealtimeAgentsSDK(normalizedConfig)) {
    return [
      `window.MAB_REALTIME_BRIDGE_CONFIG = ${JSON.stringify(config)};`,
      ...helperSources,
      source,
    ].join("\n");
  }
  const bundle = readRealtimeAgentsSDKBundle();
  return [
    `window.MAB_REALTIME_BRIDGE_CONFIG = ${JSON.stringify({
      ...normalizedConfig,
      agentSDKVersion: normalizedConfig.agentSDKVersion || bundle.version,
    })};`,
    bundle.source,
    ...helperSources,
    source,
  ].join("\n");
}
