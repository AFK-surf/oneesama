import { readBrowserInitSource } from "../browser-init-source.ts";

export function buildRealtimeBrowserInitScript(config = {}) {
  const source = readBrowserInitSource(
    import.meta.url,
    "./realtime-browser-bridge.js",
    "./realtime-browser-bridge.ts",
  );
  return [`window.MAB_REALTIME_BRIDGE_CONFIG = ${JSON.stringify(config)};`, source].join("\n");
}
