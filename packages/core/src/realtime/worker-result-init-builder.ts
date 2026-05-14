import { readBrowserInitSource } from "../browser-init-source.ts";

export function buildWorkerResultInitScript(config = {}) {
  const source = readBrowserInitSource(
    import.meta.url,
    "./worker-result-bridge.js",
    "./worker-result-bridge.ts",
  );
  return [`window.MAB_WORKER_RESULT_CONFIG = ${JSON.stringify(config)};`, source].join("\n");
}
