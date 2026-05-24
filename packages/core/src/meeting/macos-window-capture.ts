import { execFile } from "node:child_process";
import { existsSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface MacOSWindowCaptureFrame {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export interface MacOSWindowCaptureTarget {
  windowId?: number | string;
  windowID?: number | string;
  processId?: number | string;
  pid?: number | string;
  bundleIdentifier?: string;
  bundleId?: string;
  applicationName?: string;
  appName?: string;
  name?: string;
  title?: string;
}

export interface MacOSWindowCaptureWindow {
  windowId: number;
  windowID: number;
  title: string;
  name: string;
  applicationName: string;
  bundleIdentifier: string;
  processId: number;
  pid: number;
  frame?: MacOSWindowCaptureFrame;
  source: "macos_screencapturekit";
}

export interface MacOSWindowCaptureListResult {
  ok: boolean;
  source: "macos_screencapturekit";
  count: number;
  windows: MacOSWindowCaptureWindow[];
  applications: MacOSWindowCaptureWindow[];
  error?: string;
  detail?: string;
}

export interface MacOSWindowCaptureFrameResult {
  ok: boolean;
  source: "macos_screencapturekit";
  output: string;
  captureBackend?: string;
  width?: number;
  height?: number;
  scaleFactor?: number;
  window?: MacOSWindowCaptureWindow;
  error?: string;
  detail?: string;
}

function readPngDimensions(path: string): { width?: number; height?: number } {
  let fd: number | null = null;
  try {
    const header = Buffer.alloc(24);
    fd = openSync(path, "r");
    const bytes = readSync(fd, header, 0, header.length, 0);
    if (bytes < 24) return {};
    const pngSignature = "89504e470d0a1a0a";
    if (header.subarray(0, 8).toString("hex") !== pngSignature) return {};
    return {
      width: header.readUInt32BE(16),
      height: header.readUInt32BE(20),
    };
  } catch {
    return {};
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function helperSourcePath() {
  return fileURLToPath(new URL("./macos-window-capture.swift", import.meta.url));
}

function helperBinaryPath() {
  return resolve(
    process.env.ONEESAMA_MACOS_WINDOW_CAPTURE_HELPER ||
      join(tmpdir(), "oneesama-macos-window-capture-helper"),
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

async function ensureHelperBinary() {
  if (process.platform !== "darwin") {
    throw new Error("macOS window capture requires darwin");
  }
  const source = helperSourcePath();
  const binary = helperBinaryPath();
  if (!helperNeedsCompile(source, binary)) return binary;
  await mkdir(dirname(binary), { recursive: true });
  await execFileAsync("/usr/bin/swiftc", ["-parse-as-library", source, "-o", binary], {
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  });
  return binary;
}

async function runHelper<T>(args: string[]): Promise<T> {
  const binary = await ensureHelperBinary();
  const { stdout, stderr } = await execFileAsync(binary, args, {
    timeout: 10000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const text = String(stdout || "").trim();
  if (!text) throw new Error(String(stderr || "macos_window_capture_empty_output").trim());
  const parsed = JSON.parse(text) as T & { ok?: boolean; error?: string };
  if (parsed && parsed.ok === false) {
    throw new Error(parsed.error || "macos_window_capture_failed");
  }
  return parsed as T;
}

function text(value: unknown) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

export function matchesMacOSWindowCaptureTarget(
  window: MacOSWindowCaptureWindow,
  target: MacOSWindowCaptureTarget = {},
) {
  const windowId = Number(target.windowId || target.windowID || 0) || 0;
  if (windowId && Number(window.windowId || window.windowID || 0) === windowId) return true;
  const processId = Number(target.processId || target.pid || 0) || 0;
  if (processId && Number(window.processId || window.pid || 0) === processId) return true;
  const bundle = text(target.bundleIdentifier || target.bundleId);
  if (bundle && text(window.bundleIdentifier) === bundle) return true;
  const name = text(target.applicationName || target.appName || target.name || target.title);
  if (!name) return false;
  return [window.applicationName, window.name, window.title]
    .map(text)
    .some((candidate) => candidate === name || candidate.includes(name));
}

export async function listMacOSWindowCaptureTargets(): Promise<MacOSWindowCaptureListResult> {
  const result = await runHelper<MacOSWindowCaptureListResult>(["list"]);
  const windows = Array.isArray(result.windows) ? result.windows : [];
  return {
    ok: true,
    source: "macos_screencapturekit",
    count: windows.length,
    windows,
    applications: windows,
  };
}

export async function captureMacOSWindowFrame(input: {
  windowId: number | string;
  outputPath: string;
  timeoutMs?: number;
}): Promise<MacOSWindowCaptureFrameResult> {
  const windowId = String(input.windowId || "").trim();
  if (!windowId) throw new Error("windowId is required");
  const outputPath = resolve(input.outputPath);
  await mkdir(dirname(outputPath), { recursive: true });
  const backend = String(process.env.ONEESAMA_MACOS_WINDOW_CAPTURE_BACKEND || "screencapture")
    .trim()
    .toLowerCase();
  if (backend !== "screencapturekit") {
    await execFileAsync("/usr/sbin/screencapture", ["-x", "-l", windowId, outputPath], {
      timeout: Math.max(1000, input.timeoutMs || 2500),
      maxBuffer: 1024 * 1024,
    });
    const dimensions = readPngDimensions(outputPath);
    return {
      ok: true,
      source: "macos_screencapturekit",
      captureBackend: "screencapture_window",
      output: outputPath,
      width: dimensions.width,
      height: dimensions.height,
    };
  }
  const result = await runHelper<MacOSWindowCaptureFrameResult>([
    "capture",
    "--window-id",
    windowId,
    "--output",
    outputPath,
    "--timeout-ms",
    String(input.timeoutMs || 2500),
  ]);
  const dimensions = readPngDimensions(outputPath);
  return {
    ...result,
    width: dimensions.width || result.width,
    height: dimensions.height || result.height,
  };
}
