import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";

type BrowserContext = import("playwright").BrowserContext;

interface WebRTCAudioCaptureChunk {
  sessionId?: string;
  sequence?: number;
  mimeType?: string;
  base64?: string;
  bytes?: number;
}

interface WebRTCAudioCaptureEvent {
  sessionId?: string;
  type?: string;
  mimeType?: string;
  error?: string;
}

interface WebRTCAudioCaptureSinkOptions {
  sessionId: string;
  artifactsDir: string;
  basename?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function commandExists(command: string): boolean {
  return spawnSync("bash", ["-lc", `command -v ${command}`], { stdio: "ignore" }).status === 0;
}

async function runFfmpeg(args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr?.on("data", (chunk) => {
      stderr += String(chunk || "");
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`ffmpeg exited ${code}: ${stderr.trim()}`));
    });
  });
}

export function createWebRTCAudioCaptureSink(options: WebRTCAudioCaptureSinkOptions) {
  const base = options.basename || "webrtc-remote-audio";
  const state = {
    ok: true,
    enabled: true,
    source: "meet_webrtc_remote_audio",
    sessionId: options.sessionId,
    artifactsDir: options.artifactsDir,
    rawPath: join(options.artifactsDir, `${base}.webm`),
    audioPath: join(options.artifactsDir, "audio.wav"),
    mimeType: "",
    startedAt: "",
    stoppedAt: "",
    lastChunkAt: "",
    chunks: 0,
    bytes: 0,
    finalized: false,
    audioReady: false,
    errors: [] as Array<{ ts: string; stage: string; error: string }>,
  };

  function rememberError(stage: string, error: unknown) {
    state.ok = false;
    state.errors.push({
      ts: nowIso(),
      stage,
      error: String((error as Error)?.message || error),
    });
  }

  async function handleChunk(payload: WebRTCAudioCaptureChunk = {}) {
    if (payload.sessionId && payload.sessionId !== options.sessionId) {
      return { ok: false, ignored: true, reason: "session_id_mismatch" };
    }
    const encoded = String(payload.base64 || "");
    if (!encoded) return { ok: false, error: "empty_audio_chunk" };
    try {
      await mkdir(options.artifactsDir, { recursive: true });
      const buffer = Buffer.from(encoded, "base64");
      if (!buffer.length) return { ok: false, error: "empty_audio_buffer" };
      await appendFile(state.rawPath, buffer);
      state.mimeType = state.mimeType || String(payload.mimeType || "");
      state.startedAt = state.startedAt || nowIso();
      state.lastChunkAt = nowIso();
      state.chunks += 1;
      state.bytes += buffer.length || Number(payload.bytes || 0) || 0;
      return {
        ok: true,
        rawPath: state.rawPath,
        audioPath: state.audioPath,
        chunks: state.chunks,
        bytes: state.bytes,
      };
    } catch (error) {
      rememberError("chunk", error);
      return { ok: false, error: String((error as Error)?.message || error) };
    }
  }

  async function handleEvent(payload: WebRTCAudioCaptureEvent = {}) {
    if (payload.sessionId && payload.sessionId !== options.sessionId) {
      return { ok: false, ignored: true, reason: "session_id_mismatch" };
    }
    const type = String(payload.type || "");
    if (type === "started") {
      state.startedAt = state.startedAt || nowIso();
      state.mimeType = state.mimeType || String(payload.mimeType || "");
    } else if (type === "stopped") {
      state.stoppedAt = state.stoppedAt || nowIso();
    } else if (type === "error") {
      rememberError("browser", payload.error || "browser_audio_capture_error");
    }
    return { ok: true, state: status() };
  }

  async function exposeTo(context: BrowserContext) {
    await mkdir(options.artifactsDir, { recursive: true });
    await context.exposeBinding("__meetingAvatarMeetAudioCaptureChunk", async (_source, payload) =>
      handleChunk(payload as WebRTCAudioCaptureChunk),
    );
    await context.exposeBinding("__meetingAvatarMeetAudioCaptureEvent", async (_source, payload) =>
      handleEvent(payload as WebRTCAudioCaptureEvent),
    );
    return { ok: true, state: status() };
  }

  async function finalize() {
    state.stoppedAt = state.stoppedAt || nowIso();
    if (state.finalized) return status();
    try {
      const info = await stat(state.rawPath).catch(() => null);
      if (!info || info.isDirectory() || info.size === 0) {
        return status();
      }
      if (!commandExists("ffmpeg")) {
        rememberError("finalize", "ffmpeg_not_found");
        return status();
      }
      await runFfmpeg([
        "-y",
        "-i",
        state.rawPath,
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        state.audioPath,
      ]);
      state.finalized = true;
      state.audioReady = existsSync(state.audioPath);
    } catch (error) {
      rememberError("finalize", error);
    }
    return status();
  }

  function status() {
    return { ...state };
  }

  return {
    state,
    exposeTo,
    handleChunk,
    handleEvent,
    finalize,
    status,
  };
}
