import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { loadOperatorDotEnvFiles } from "./lan-operator-dotenv.ts";

const DEFAULT_LIVE_ENV_FILES = [
  "oneesama-live-env-from-proc.sh",
  "oneesama-openai-live.sh",
  "oneesama-gemini-live.sh",
  "oneesama-app-control-live.sh",
];

export interface LanOperatorBackendLiveEnvLoadResult {
  schema: "oneesama.lan_operator_backend_live_env.v1";
  loaded: boolean;
  keys: string[];
}

function defaultLiveEnvPaths(env: Record<string, string | undefined>) {
  const base =
    env.ONEESAMA_LIVE_DEFAULT_ENV_DIR ||
    join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "oneesama", "live-env");
  return DEFAULT_LIVE_ENV_FILES.map((name) => join(base, name));
}

function parseShellAssignmentLine(line: string) {
  const trimmed = String(line || "").trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u);
  if (!match) return null;
  let value = match[2].trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return [match[1], value] as const;
}

export function loadLanOperatorBackendLiveEnv(
  env: NodeJS.ProcessEnv = process.env,
): LanOperatorBackendLiveEnvLoadResult {
  const keys = new Set<string>();
  // Repo-root .env / .env.local first (the conventional local-config file);
  // ~/.config live-env files fill any gaps. No-override throughout.
  for (const key of loadOperatorDotEnvFiles(undefined, undefined, env)) keys.add(key);
  for (const filePath of defaultLiveEnvPaths(env)) {
    if (!existsSync(filePath)) continue;
    const content = readFileSync(filePath, "utf8");
    for (const line of content.split(/\r?\n/u)) {
      const assignment = parseShellAssignmentLine(line);
      if (!assignment) continue;
      const [key, value] = assignment;
      if (!env[key] && value) {
        env[key] = value;
        keys.add(key);
      }
    }
  }
  return {
    schema: "oneesama.lan_operator_backend_live_env.v1",
    loaded: keys.size > 0,
    keys: [...keys].toSorted(),
  };
}
