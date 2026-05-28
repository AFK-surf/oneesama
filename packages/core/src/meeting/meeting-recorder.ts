import {
  spawn,
  spawnSync,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRecappiAudioTap,
  listRecappiShareableApplications,
  type RecappiAudioCallback,
} from "../audio/recappi-audio-tap.ts";

type MeetingAudioBackend = "none" | "pulse" | "recappi";

interface MeetingRecorderOptions {
  backend?: MeetingAudioBackend | string;
  recappiSdkPath?: string;
  recappiTap?: ReturnType<typeof createRecappiAudioTap>;
  runtimeDir?: string;
  sinkName?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function log(message: string): void {
  console.error(`[meeting-recorder] ${message}`);
}

function sanitizeName(value: unknown, fallback: string): string {
  return (
    String(value || fallback)
      .replace(/[^a-zA-Z0-9_.-]+/g, "_")
      .replace(/^_+|_+$/g, "") || fallback
  );
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv): string {
  const result = spawnSync(command, args, {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw new Error(`${command} failed to start: ${result.error.message}`);
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(" ")} failed: ${(result.stderr || "").trim() || result.status}`,
    );
  return (result.stdout || "").trim();
}

function commandExists(command: string): boolean {
  const result = spawnSync("bash", ["-lc", `command -v ${command}`], { stdio: "ignore" });
  return result.status === 0;
}

async function waitForChildProcessExit(
  proc: ChildProcess | ChildProcessWithoutNullStreams | null | undefined,
  timeoutMs: number,
): Promise<boolean> {
  if (!proc || proc.exitCode !== null || proc.killed) return true;
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.off("close", onClose);
      proc.off("exit", onExit);
      proc.off("error", onError);
      resolve(ok);
    };
    const onClose = () => finish(true);
    const onExit = () => finish(true);
    const onError = () => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);
    proc.once("close", onClose);
    proc.once("exit", onExit);
    proc.once("error", onError);
  });
}

export function resolveMeetingAudioBackend(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): MeetingAudioBackend {
  const raw = String(env.MAB_MEET_AUDIO_BACKEND || env.MEET_AUDIO_BACKEND || "auto")
    .trim()
    .toLowerCase();
  if (!raw || raw === "auto") {
    if (platform === "darwin") return "recappi";
    if (platform === "linux") return "pulse";
    return "none";
  }
  if (["none", "off", "disabled"].includes(raw)) return "none";
  if (["pulse", "pulseaudio"].includes(raw)) return "pulse";
  if (raw === "recappi") return "recappi";
  throw new Error(`Unsupported MAB_MEET_AUDIO_BACKEND=${raw}`);
}

export async function listShareableApplications(options: MeetingRecorderOptions = {}) {
  return await listRecappiShareableApplications(options);
}

class PulseAudioRecorder {
  runtimeDir: string;
  sinkName: string;
  monitorSource: string;
  env: NodeJS.ProcessEnv;
  startedPulse: boolean;
  moduleId: string;
  ffmpegProc: ChildProcessWithoutNullStreams | null;
  outputPath: string;

  constructor(options: MeetingRecorderOptions = {}) {
    this.runtimeDir =
      options.runtimeDir ||
      process.env.MAB_MEET_PULSE_RUNTIME_DIR ||
      process.env.MEET_PULSE_RUNTIME_DIR ||
      join(tmpdir(), `meeting-avatar-pulse-${process.pid}`);
    this.sinkName = sanitizeName(
      options.sinkName || process.env.MAB_MEET_PULSE_SINK_NAME || process.env.MEET_PULSE_SINK_NAME,
      `meeting_avatar_${process.pid}`,
    );
    this.monitorSource = `${this.sinkName}.monitor`;
    this.env = {
      ...process.env,
      HOME: process.env.HOME || join(tmpdir(), `meeting-avatar-home-${process.pid}`),
      XDG_RUNTIME_DIR: this.runtimeDir,
      PULSE_SINK: this.sinkName,
    };
    this.startedPulse = false;
    this.moduleId = "";
    this.ffmpegProc = null;
    this.outputPath = "";
  }

  canConnect(): boolean {
    return spawnSync("pactl", ["info"], { env: this.env, stdio: "ignore" }).status === 0;
  }

  async prepareLaunchEnv(): Promise<NodeJS.ProcessEnv> {
    await mkdir(this.runtimeDir, { recursive: true, mode: 0o700 });
    if (!this.canConnect()) {
      run(
        "pulseaudio",
        ["--daemonize=yes", "--exit-idle-time=-1", "--log-target=stderr"],
        this.env,
      );
      this.startedPulse = true;
    }
    if (!this.canConnect()) throw new Error("PulseAudio server is unavailable");
    this.moduleId = run(
      "pactl",
      ["load-module", "module-null-sink", `sink_name=${this.sinkName}`],
      this.env,
    );
    return this.env;
  }

  async start(
    artifactsDir: string,
  ): Promise<{ ok: true; backend: "pulse"; audioPath: string; chunkPattern: string }> {
    await mkdir(artifactsDir, { recursive: true });
    this.outputPath = join(artifactsDir, "audio.wav");
    const chunkPattern = join(artifactsDir, "audio_chunk_%03d.mp3");
    this.ffmpegProc = spawn(
      "ffmpeg",
      [
        "-y",
        "-f",
        "pulse",
        "-i",
        this.monitorSource,
        "-c:a",
        "pcm_s16le",
        this.outputPath,
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "libmp3lame",
        "-b:a",
        "64k",
        "-f",
        "segment",
        "-segment_time",
        "300",
        chunkPattern,
      ],
      { env: this.env, stdio: ["ignore", "ignore", "pipe"] },
    );
    this.ffmpegProc.stderr?.on("data", (chunk) => {
      const text = String(chunk || "").trim();
      if (text) log(`ffmpeg: ${text}`);
    });
    return { ok: true, backend: "pulse", audioPath: this.outputPath, chunkPattern };
  }

  async stop(): Promise<void> {
    if (this.ffmpegProc) {
      this.ffmpegProc.kill("SIGINT");
      if (!(await waitForChildProcessExit(this.ffmpegProc, 10_000)))
        this.ffmpegProc.kill("SIGKILL");
      this.ffmpegProc = null;
    }
    if (this.moduleId) {
      try {
        run("pactl", ["unload-module", this.moduleId], this.env);
      } catch (error) {
        log(`failed to unload pulse module ${this.moduleId}: ${String(error?.message || error)}`);
      }
      this.moduleId = "";
    }
    if (this.startedPulse) {
      spawnSync("pulseaudio", ["--kill"], { env: this.env, stdio: "ignore" });
      this.startedPulse = false;
    }
  }
}

export function createMeetingRecorder(options: MeetingRecorderOptions = {}) {
  const backend = options.backend
    ? resolveMeetingAudioBackend({ MAB_MEET_AUDIO_BACKEND: options.backend }, process.platform)
    : resolveMeetingAudioBackend();
  const state = {
    ok: true,
    enabled: backend !== "none",
    backend,
    startedAt: "",
    stoppedAt: "",
    artifactsDir: "",
    audioPath: "",
    chunkPattern: "",
    sampleRate: 0,
    channels: 0,
    sampleCount: 0,
    errors: [],
  };
  let pulse = null;
  const recappiTap =
    backend === "recappi"
      ? options.recappiTap || createRecappiAudioTap({ recappiSdkPath: options.recappiSdkPath, log })
      : null;
  const ownsRecappiTap = Boolean(recappiTap && !options.recappiTap);
  let releaseRecappiConsumer: (() => void) | null = null;
  let ffmpegProc = null;

  async function prepareLaunchEnv() {
    if (backend !== "pulse") return undefined;
    pulse = new PulseAudioRecorder(options);
    try {
      return await pulse.prepareLaunchEnv();
    } catch (error) {
      state.errors.push({
        ts: nowIso(),
        stage: "pulse_prepare",
        error: String(error?.message || error),
      });
      log(
        `PulseAudio prepare failed; continuing without app-audio capture: ${String(error?.message || error)}`,
      );
      return undefined;
    }
  }

  async function start({ context, artifactsDir }) {
    if (backend === "none") {
      state.enabled = false;
      return { ok: true, skipped: true, backend };
    }
    if (!commandExists("ffmpeg")) {
      state.errors.push({ ts: nowIso(), stage: "ffmpeg", error: "ffmpeg_not_found" });
      return { ok: false, error: "ffmpeg_not_found", backend };
    }
    await mkdir(artifactsDir, { recursive: true });
    state.startedAt = nowIso();
    state.artifactsDir = artifactsDir;

    if (backend === "pulse") {
      if (!pulse) {
        state.errors.push({ ts: nowIso(), stage: "pulse_start", error: "pulse_not_prepared" });
        return { ok: false, error: "pulse_not_prepared", backend };
      }
      const result = await pulse.start(artifactsDir);
      Object.assign(state, { audioPath: result.audioPath, chunkPattern: result.chunkPattern });
      return { ...result, state: status() };
    }

    if (backend === "recappi") {
      try {
        if (!recappiTap) throw new Error("recappi_tap_unavailable");
        const tapState = await recappiTap.start({ context, allowGlobalFallback: true });
        const onAudio: RecappiAudioCallback = (error, samples) => {
          if (error) {
            state.errors.push({
              ts: nowIso(),
              stage: "recappi_callback",
              error: String((error as Error)?.message || error),
            });
            return;
          }
          state.sampleCount += samples.length;
          if (!ffmpegProc?.stdin?.writable) return;
          const buffer = Buffer.alloc(samples.length * 2);
          for (let i = 0; i < samples.length; i += 1) {
            const sample = Math.max(-1, Math.min(1, samples[i]));
            buffer.writeInt16LE(sample < 0 ? sample * 0x8000 : sample * 0x7fff, i * 2);
          }
          ffmpegProc.stdin.write(buffer);
        };
        releaseRecappiConsumer = recappiTap.addConsumer(onAudio);
        state.sampleRate = tapState.sampleRate || 48000;
        state.channels = tapState.channels || 2;
        state.audioPath = join(artifactsDir, "audio.wav");
        state.chunkPattern = join(artifactsDir, "audio_chunk_%03d.mp3");
        ffmpegProc = spawn(
          "ffmpeg",
          [
            "-f",
            "s16le",
            "-ar",
            String(state.sampleRate),
            "-ac",
            String(state.channels),
            "-i",
            "pipe:0",
            "-c:a",
            "pcm_s16le",
            "-y",
            state.audioPath,
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "libmp3lame",
            "-b:a",
            "64k",
            "-f",
            "segment",
            "-segment_time",
            "300",
            state.chunkPattern,
          ],
          { stdio: ["pipe", "ignore", "pipe"] },
        );
        ffmpegProc.stderr?.on("data", (chunk) => {
          const text = String(chunk || "").trim();
          if (text) log(`ffmpeg: ${text}`);
        });
        return {
          ok: true,
          backend,
          audioPath: state.audioPath,
          chunkPattern: state.chunkPattern,
          state: status(),
        };
      } catch (error) {
        state.errors.push({
          ts: nowIso(),
          stage: "recappi_start",
          error: String((error as Error)?.message || error),
        });
        return {
          ok: false,
          error: String((error as Error)?.message || error),
          backend,
          state: status(),
        };
      }
    }

    return { ok: false, error: `unsupported_backend:${backend}` };
  }

  async function stop() {
    state.stoppedAt = nowIso();
    try {
      if (backend === "pulse" && pulse) {
        await pulse.stop();
      }
      if (backend === "recappi") {
        releaseRecappiConsumer?.();
        releaseRecappiConsumer = null;
        if (ownsRecappiTap) recappiTap?.stop();
        if (ffmpegProc?.stdin) ffmpegProc.stdin.end();
        if (ffmpegProc && !(await waitForChildProcessExit(ffmpegProc, 10_000)))
          ffmpegProc.kill("SIGKILL");
      }
      return { ok: true, state: status() };
    } catch (error) {
      state.errors.push({ ts: nowIso(), stage: "stop", error: String(error?.message || error) });
      return { ok: false, error: String(error?.message || error), state: status() };
    } finally {
      ffmpegProc = null;
      pulse = null;
    }
  }

  function status() {
    return {
      ...state,
      recording: Boolean(ffmpegProc || pulse?.ffmpegProc),
      recappiTap: recappiTap?.status?.() || null,
    };
  }

  return { backend, state, prepareLaunchEnv, start, stop, status };
}
