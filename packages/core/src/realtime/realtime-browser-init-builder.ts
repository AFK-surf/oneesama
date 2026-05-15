import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { readBrowserInitSource } from "../browser-init-source.ts";

const require = createRequire(import.meta.url);

function normalizeAgentRuntime(value: unknown): string {
  return String(value || "").trim().toLowerCase();
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
  const source = readBrowserInitSource(
    import.meta.url,
    "./realtime-browser-bridge.js",
    "./realtime-browser-bridge.ts",
  );
  if (!shouldInjectRealtimeAgentsSDK(normalizedConfig)) {
    return [`window.MAB_REALTIME_BRIDGE_CONFIG = ${JSON.stringify(config)};`, source].join("\n");
  }
  const bundle = readRealtimeAgentsSDKBundle();
  return [
    `window.MAB_REALTIME_BRIDGE_CONFIG = ${JSON.stringify({
      ...normalizedConfig,
      agentSDKVersion: normalizedConfig.agentSDKVersion || bundle.version,
    })};`,
    bundle.source,
    source,
  ].join("\n");
}
