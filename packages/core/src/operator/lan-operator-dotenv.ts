import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Minimal dotenv loader for the operator CLI. `vp exec tsx` does not load
// `.env`, so the CLI imports this first to pick up machine-local config
// (e.g. MAB_LAN_OPERATOR_AUTO_AVATAR_PUBLISHER, an OpenAI key) without the
// user having to prefix inline env vars on every run. No-override semantics:
// a value already in process.env (shell-inline) always wins, matching the
// dotenv convention and the backend live-env loader.
function parseAssignment(line: string): [string, string] | null {
  const trimmed = line.trim();
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
  return [match[1], value];
}

export function loadOperatorDotEnvFiles(
  files: string[] = [".env.local", ".env"],
  cwd: string = process.cwd(),
): string[] {
  const loaded: string[] = [];
  for (const file of files) {
    const path = resolve(cwd, file);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split(/\r?\n/u)) {
      const assignment = parseAssignment(line);
      if (!assignment) continue;
      const [key, value] = assignment;
      if (value !== "" && process.env[key] === undefined) {
        process.env[key] = value;
        loaded.push(key);
      }
    }
  }
  return loaded;
}
