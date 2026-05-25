import { execFile, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function helperSourcePath() {
  return fileURLToPath(new URL("./app-control-helper.swift", import.meta.url));
}

export function appControlHelperBinaryPath() {
  return resolve(
    process.env.ONEESAMA_APP_CONTROL_HELPER ||
      join(tmpdir(), "oneesama-app-control-helper"),
  );
}

function helperNeedsCompile(source: string, binary: string) {
  if (!existsSync(binary)) return true;
  try {
    return statSync(binary).mtimeMs < statSync(source).mtimeMs;
  } catch {
    return true;
  }
}

export async function ensureAppControlHelperBinary() {
  if (process.platform !== "darwin") {
    throw new Error("app-control helper requires darwin");
  }
  const source = helperSourcePath();
  const binary = appControlHelperBinaryPath();
  if (!helperNeedsCompile(source, binary)) return binary;
  await mkdir(dirname(binary), { recursive: true });
  await execFileAsync("/usr/bin/swiftc", [source, "-o", binary], {
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  });
  return binary;
}

async function main() {
  if (process.argv.includes("--help")) {
    process.stdout.write("usage: tsx packages/core/src/meeting/app-control-helper.ts [--stdio]\n");
    return;
  }
  const binary = await ensureAppControlHelperBinary();
  const child = spawn(binary, ["--stdio"], {
    stdio: "inherit",
  });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`app-control helper exited: ${code ?? signal ?? "unknown"}`));
      }
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
