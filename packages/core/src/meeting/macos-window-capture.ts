import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
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

export interface MacOSWindowCaptureHelperProcess {
  pid: number;
  command: string;
}

function jpegSofMarker(marker: number) {
  return (
    (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
  );
}

function uint24LE(buffer: Buffer, offset: number) {
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
}

function readWebPDimensions(header: Buffer, bytes: number): { width?: number; height?: number } {
  if (
    bytes < 30 ||
    header.subarray(0, 4).toString("ascii") !== "RIFF" ||
    header.subarray(8, 12).toString("ascii") !== "WEBP"
  ) {
    return {};
  }
  const chunk = header.subarray(12, 16).toString("ascii");
  if (chunk === "VP8X") {
    return {
      width: uint24LE(header, 24) + 1,
      height: uint24LE(header, 27) + 1,
    };
  }
  if (chunk === "VP8 " && header[23] === 0x9d && header[24] === 0x01 && header[25] === 0x2a) {
    return {
      width: header.readUInt16LE(26) & 0x3fff,
      height: header.readUInt16LE(28) & 0x3fff,
    };
  }
  if (chunk === "VP8L" && header[20] === 0x2f) {
    const b1 = header[21];
    const b2 = header[22];
    const b3 = header[23];
    const b4 = header[24];
    return {
      width: 1 + b1 + ((b2 & 0x3f) << 8),
      height: 1 + ((b2 & 0xc0) >> 6) + (b3 << 2) + ((b4 & 0x0f) << 10),
    };
  }
  return {};
}

export function readImageDimensions(path: string): { width?: number; height?: number } {
  let fd: number | null = null;
  try {
    const header = Buffer.alloc(64 * 1024);
    fd = openSync(path, "r");
    const bytes = readSync(fd, header, 0, header.length, 0);
    if (bytes < 24) return {};
    const pngSignature = "89504e470d0a1a0a";
    if (header.subarray(0, 8).toString("hex") === pngSignature) {
      return {
        width: header.readUInt32BE(16),
        height: header.readUInt32BE(20),
      };
    }

    const webPDimensions = readWebPDimensions(header, bytes);
    if (webPDimensions.width && webPDimensions.height) return webPDimensions;

    if (header[0] !== 0xff || header[1] !== 0xd8) return {};
    let offset = 2;
    while (offset + 4 < bytes) {
      if (header[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      while (offset < bytes && header[offset] === 0xff) offset += 1;
      if (offset >= bytes) return {};
      const marker = header[offset];
      offset += 1;
      if (marker === 0xd8 || marker === 0x01) continue;
      if (marker === 0xd9 || marker === 0xda) return {};
      if (offset + 2 > bytes) return {};
      const length = header.readUInt16BE(offset);
      offset += 2;
      if (length < 2) return {};
      const payloadLength = length - 2;
      if (offset + payloadLength > bytes) return {};
      if (jpegSofMarker(marker) && payloadLength >= 6) {
        return {
          height: header.readUInt16BE(offset + 1),
          width: header.readUInt16BE(offset + 3),
        };
      }
      offset += payloadLength;
    }
    return {};
  } catch {
    return {};
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export const readPngDimensions = readImageDimensions;

async function waitForImage(path: string, timeoutMs: number, child?: ChildProcess) {
  const started = Date.now();
  let lastExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  child?.once("exit", (code, signal) => {
    lastExit = { code, signal };
  });
  while (Date.now() - started < timeoutMs) {
    if (existsSync(path)) {
      const dimensions = readImageDimensions(path);
      if (dimensions.width && dimensions.height) return dimensions;
    }
    if (lastExit) {
      throw new Error(`macos_window_capture_stream_exited:${lastExit.code ?? lastExit.signal ?? "unknown"}`);
    }
    await new Promise((settle) => setTimeout(settle, 40));
  }
  throw new Error("macos_window_capture_stream_timeout");
}

function helperSourcePath() {
  return fileURLToPath(new URL("./macos-window-capture.swift", import.meta.url));
}

function helperWebPSourcePath() {
  return fileURLToPath(new URL("./macos-window-webp.c", import.meta.url));
}

function helperWebPHeaderPath() {
  return fileURLToPath(new URL("./macos-window-webp.h", import.meta.url));
}

function helperBinaryPath() {
  return resolve(
    process.env.ONEESAMA_MACOS_WINDOW_CAPTURE_HELPER ||
      join(tmpdir(), "oneesama-macos-window-capture-helper"),
  );
}

export function macOSWindowCaptureHelperProcessFromPSLine(
  line: string,
  helperPath = helperBinaryPath(),
): MacOSWindowCaptureHelperProcess | null {
  const match = String(line || "").match(/^\s*(\d+)\s+(.+?)\s*$/);
  if (!match) return null;
  const pid = Number(match[1]);
  const command = String(match[2] || "").trim();
  if (!pid || !command) return null;
  const helperName = basename(helperPath);
  const isHelper =
    command.startsWith(`${helperPath} `) ||
    command === helperPath ||
    command.includes(`/${helperName} `) ||
    command === helperName;
  if (!isHelper || !/\sstream(\s|$)/.test(command)) return null;
  return { pid, command };
}

async function killOrphanedHelperStreams(options: {
  keepProcessIds?: Array<number | null | undefined>;
  settleMs?: number;
} = {}) {
  if (process.platform !== "darwin") return 0;
  const keep = new Set(
    (options.keepProcessIds || [])
      .map((value) => Number(value || 0) || 0)
      .filter(Boolean),
  );
  const { stdout } = await execFileAsync("/bin/ps", ["-axo", "pid=,command="], {
    timeout: 3000,
    maxBuffer: 2 * 1024 * 1024,
  });
  const helperPath = helperBinaryPath();
  const matches = String(stdout || "")
    .split(/\r?\n/)
    .map((line) => macOSWindowCaptureHelperProcessFromPSLine(line, helperPath))
    .filter((entry): entry is MacOSWindowCaptureHelperProcess => Boolean(entry));
  let killed = 0;
  for (const entry of matches) {
    if (keep.has(entry.pid) || entry.pid === process.pid) continue;
    try {
      process.kill(entry.pid, "SIGTERM");
      killed += 1;
    } catch {
      // The process may already be gone; the next helper list is the source of truth.
    }
  }
  if (killed > 0) {
    await new Promise((settle) => setTimeout(settle, Math.max(0, options.settleMs ?? 150)));
  }
  return killed;
}

function helperWebPPrefix() {
  const override = String(process.env.ONEESAMA_WEBP_PREFIX || "").trim();
  if (override) return override;
  if (existsSync("/opt/homebrew/include/webp/encode.h")) return "/opt/homebrew";
  if (existsSync("/usr/local/include/webp/encode.h")) return "/usr/local";
  return "/opt/homebrew";
}

function helperNeedsCompile(sources: string[], binary: string) {
  if (!existsSync(binary)) return true;
  try {
    const binaryMtime = statSync(binary).mtimeMs;
    return sources.some((source) => binaryMtime < statSync(source).mtimeMs);
  } catch {
    return true;
  }
}

async function ensureHelperBinary() {
  if (process.platform !== "darwin") {
    throw new Error("macOS window capture requires darwin");
  }
  const source = helperSourcePath();
  const webPSource = helperWebPSourcePath();
  const webPHeader = helperWebPHeaderPath();
  const binary = helperBinaryPath();
  if (!helperNeedsCompile([source, webPSource, webPHeader], binary)) return binary;
  await mkdir(dirname(binary), { recursive: true });
  const webPPrefix = helperWebPPrefix();
  const object = join(tmpdir(), "oneesama-macos-window-webp.o");
  await execFileAsync("/usr/bin/clang", ["-c", webPSource, "-I", `${webPPrefix}/include`, "-o", object], {
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  });
  await execFileAsync("/usr/bin/swiftc", [
    "-parse-as-library",
    source,
    object,
    "-import-objc-header",
    webPHeader,
    "-L",
    `${webPPrefix}/lib`,
    "-lwebp",
    "-o",
    binary,
  ], {
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
  const outputText = String(stdout || "").trim();
  if (!outputText) throw new Error(String(stderr || "macos_window_capture_empty_output").trim());
  const parsed = JSON.parse(outputText) as T & { ok?: boolean; error?: string };
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

export async function listMacOSWindowCaptureTargets(options: {
  keepProcessIds?: Array<number | null | undefined>;
  cleanupOrphanedStreams?: boolean;
} = {}): Promise<MacOSWindowCaptureListResult> {
  if (options.cleanupOrphanedStreams !== false) {
    await killOrphanedHelperStreams({ keepProcessIds: options.keepProcessIds });
  }
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
  const backend = String(process.env.ONEESAMA_MACOS_WINDOW_CAPTURE_BACKEND || "screencapturekit")
    .trim()
    .toLowerCase();
  if (backend !== "screencapturekit") {
    await execFileAsync("/usr/sbin/screencapture", ["-x", "-l", windowId, outputPath], {
      timeout: Math.max(1000, input.timeoutMs || 2500),
      maxBuffer: 1024 * 1024,
    });
    const dimensions = readImageDimensions(outputPath);
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
  const dimensions = readImageDimensions(outputPath);
  return {
    ...result,
    width: dimensions.width || result.width,
    height: dimensions.height || result.height,
  };
}

export async function startMacOSWindowCaptureStream(input: {
  windowId: number | string;
  outputPath: string;
  fps?: number | string;
  timeoutMs?: number;
}): Promise<MacOSWindowCaptureFrameResult & { stop: () => void; processId?: number }> {
  const windowId = String(input.windowId || "").trim();
  if (!windowId) throw new Error("windowId is required");
  const outputPath = resolve(input.outputPath);
  await mkdir(dirname(outputPath), { recursive: true });
  const backend = String(process.env.ONEESAMA_MACOS_WINDOW_CAPTURE_BACKEND || "screencapturekit")
    .trim()
    .toLowerCase();
  if (backend !== "screencapturekit") {
    throw new Error("macos_window_capture_stream_requires_screencapturekit");
  }
  const binary = await ensureHelperBinary();
  const fps = Math.max(1, Math.min(30, Number.parseInt(String(input.fps ?? 25), 10) || 25));
  const child = spawn(
    binary,
    [
      "stream",
      "--window-id",
      windowId,
      "--output",
      outputPath,
      "--fps",
      String(fps),
      "--timeout-ms",
      String(input.timeoutMs || 2500),
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk || "");
    if (stderr.length > 4096) stderr = stderr.slice(-4096);
  });
  const dimensions = await waitForImage(outputPath, Math.max(1000, input.timeoutMs || 2500), child)
    .catch((error) => {
      child.kill("SIGTERM");
      const detail = stderr.trim();
      throw new Error(detail ? `${error.message}: ${detail}` : error.message);
    });
  return {
    ok: true,
    source: "macos_screencapturekit",
    captureBackend: "screencapturekit_stream",
    output: outputPath,
    width: dimensions.width,
    height: dimensions.height,
    processId: child.pid,
    stop: () => {
      if (!child.killed) child.kill("SIGTERM");
    },
  };
}
