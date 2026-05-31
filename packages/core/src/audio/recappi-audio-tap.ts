import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

type BrowserContext = import("playwright").BrowserContext;

export interface ShareableApplication {
  bundleIdentifier?: string;
  bundleId?: string;
  processId?: number;
  pid?: number;
  applicationName?: string;
  localizedName?: string;
  name?: string;
  title?: string;
}

interface ShareableAudioSession {
  sampleRate?: number;
  channels?: number;
  stop?: () => void;
}

export type RecappiAudioCallback = (error: unknown, samples: number[]) => void;

interface ShareableContentApi {
  applications(): ShareableApplication[];
  applicationWithProcessId?: (processId: number) => ShareableApplication | null;
  tapAudio(processId: number, callback: RecappiAudioCallback): ShareableAudioSession;
}

interface RecappiSdkModule {
  ShareableContent: ShareableContentApi;
}

export interface RecappiAudioTapOptions {
  recappiSdkPath?: string;
  log?: (message: string) => void;
  shareableContent?: ShareableContentApi;
  useHelperProcess?: boolean;
}

export interface RecappiAudioTapStartOptions {
  context?: BrowserContext | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function defaultLog(message: string): void {
  console.error(`[recappi-audio-tap] ${message}`);
}

async function loadRecappiSdk(options: RecappiAudioTapOptions = {}): Promise<RecappiSdkModule> {
  if (options.shareableContent) {
    return { ShareableContent: options.shareableContent };
  }
  try {
    return require("@recappi/sdk") as RecappiSdkModule;
  } catch {
    // Continue into the local fallback below. Production installs should get
    // Recappi from package.json; the path override is only for local SDK work.
  }

  const sdkPath = options.recappiSdkPath || process.env.MAB_RECAPPI_SDK_PATH || "";
  if (!sdkPath || !existsSync(sdkPath)) {
    throw new Error("Recappi SDK not found. Install @recappi/sdk or set MAB_RECAPPI_SDK_PATH.");
  }
  return require(sdkPath);
}

function chromiumAppText(app: ShareableApplication): { bundle: string; name: string } {
  const bundle = String(app.bundleIdentifier || app.bundleId || "").toLowerCase();
  const name = String(
    app.applicationName || app.localizedName || app.name || app.title || "",
  ).toLowerCase();
  return { bundle, name };
}

function isChromiumApp(app: ShareableApplication): boolean {
  const { bundle, name } = chromiumAppText(app);
  return bundle.includes("chromium") || bundle.includes("chrome") || name.includes("chrom");
}

function isHelperApp(app: ShareableApplication): boolean {
  const { bundle, name } = chromiumAppText(app);
  return bundle.includes(".helper") || name.includes("helper");
}

async function findChromiumAudioPid(
  context: BrowserContext | null | undefined,
  shareableContent: ShareableContentApi,
  log: (message: string) => void,
): Promise<number | null> {
  let apps: ShareableApplication[] = [];
  try {
    apps = shareableContent?.applications?.() || [];
  } catch (error) {
    log(`Recappi app scan failed: ${String((error as Error)?.message || error)}`);
  }

  const chromiumApps = apps.filter(isChromiumApp);

  let checkedCdpBrowser = false;
  try {
    const browser = context?.browser?.();
    if (browser?.newBrowserCDPSession) {
      checkedCdpBrowser = true;
      const session = await browser.newBrowserCDPSession();
      const { processInfo } = await session.send("SystemInfo.getProcessInfo");
      const cdpPids = new Set((processInfo || []).map((p) => Number(p.id || 0)).filter(Boolean));
      const matchedApps = chromiumApps.filter((app) =>
        cdpPids.has(Number(app.processId || app.pid)),
      );
      const matchedHelperApp = matchedApps.find(isHelperApp);
      const matchedApp = matchedApps.find((app) => !isHelperApp(app));
      if (matchedApp?.processId || matchedApp?.pid) {
        return Number(matchedApp.processId || matchedApp.pid);
      }
      if (matchedHelperApp?.processId || matchedHelperApp?.pid) {
        log(
          `Ignoring Recappi Chromium helper pid ${matchedHelperApp.processId || matchedHelperApp.pid}; process audio tap remains unavailable`,
        );
      }

      const browserProc = (processInfo || []).find((p) => p.type === "browser");
      const browserPid = Number(browserProc?.id || 0);
      if (browserPid && shareableContent.applicationWithProcessId) {
        const app = shareableContent.applicationWithProcessId(browserPid);
        if ((app?.processId || app?.pid) && !isHelperApp(app)) {
          return Number(app.processId || app.pid);
        }
        if (app?.processId || app?.pid) {
          log(
            `Ignoring Recappi browser process lookup because it resolved to helper pid ${app.processId || app.pid}; process audio tap remains unavailable`,
          );
        }
      }

      const audio = (processInfo || []).find((p) => p.type === "audio.mojom.AudioService");
      if (audio?.id) {
        log(
          `CDP audio service pid ${audio.id} is not a Recappi shareable application; process audio tap remains unavailable`,
        );
      }
    }
  } catch (error) {
    log(`CDP process lookup failed: ${String((error as Error)?.message || error)}`);
  }

  if (checkedCdpBrowser) return null;

  const nonHelperChromium = chromiumApps.find((app) => {
    return !isHelperApp(app);
  });
  if (nonHelperChromium?.processId || nonHelperChromium?.pid) {
    return Number(nonHelperChromium.processId || nonHelperChromium.pid);
  }
  if (chromiumApps.length === 1 && (chromiumApps[0].processId || chromiumApps[0].pid)) {
    return Number(chromiumApps[0].processId || chromiumApps[0].pid);
  }
  return null;
}

function normalizeShareableApplication(app: ShareableApplication, index: number) {
  const processId = Number(app.processId || app.pid || 0) || 0;
  const bundleIdentifier = String(app.bundleIdentifier || app.bundleId || "").trim();
  const applicationName = String(
    app.applicationName ||
      app.localizedName ||
      app.name ||
      app.title ||
      bundleIdentifier ||
      processId ||
      `app-${index + 1}`,
  ).trim();
  return {
    processId,
    bundleIdentifier,
    applicationName,
    name: applicationName,
    title: applicationName,
    source: "recappi_shareable_content",
  };
}

export async function listRecappiShareableApplications(options: RecappiAudioTapOptions = {}) {
  const { ShareableContent } = await loadRecappiSdk(options);
  const apps = ShareableContent.applications?.() || [];
  return apps
    .map(normalizeShareableApplication)
    .filter((app) => app.processId || app.bundleIdentifier || app.applicationName)
    .toSorted((a, b) => a.applicationName.localeCompare(b.applicationName));
}

export function createRecappiAudioTap(options: RecappiAudioTapOptions = {}) {
  const consumers = new Set<RecappiAudioCallback>();
  const log = options.log || defaultLog;
  const state = {
    ok: true,
    startedAt: "",
    stoppedAt: "",
    source: "",
    processId: 0,
    sampleRate: 0,
    channels: 0,
    sampleCount: 0,
    chunks: 0,
    consumerCount: 0,
    errors: [] as Array<{ ts: string; stage: string; error: string }>,
  };
  let audioSession: ShareableAudioSession | null = null;
  let helperProcess: ChildProcessWithoutNullStreams | null = null;
  let startPromise: Promise<ReturnType<typeof status>> | null = null;

  async function probe(startOptions: RecappiAudioTapStartOptions = {}) {
    const { ShareableContent } = await loadRecappiSdk(options);
    const processId = await findChromiumAudioPid(startOptions.context, ShareableContent, log);
    if (processId) {
      return {
        ok: true,
        source: "recappi_process_audio",
        processId,
      };
    }
    return {
      ok: false,
      source: "",
      processId: 0,
      error: "chromium_audio_process_not_found",
    };
  }

  function rememberError(stage: string, error: unknown) {
    state.ok = false;
    const entry = {
      ts: nowIso(),
      stage,
      error: String((error as Error)?.message || error),
    };
    state.errors.push(entry);
    state.errors = state.errors.slice(-20);
    log(`${stage}: ${entry.error}`);
  }

  const onAudio: RecappiAudioCallback = (error, samples) => {
    if (error) {
      rememberError("recappi_callback", error);
      for (const consumer of consumers) consumer(error, []);
      return;
    }
    state.chunks += 1;
    state.sampleCount += samples.length;
    for (const consumer of consumers) consumer(null, samples);
  };

  function helperScriptPath() {
    return resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../../scripts/recappi-process-audio-helper.mjs",
    );
  }

  function decodeHelperSamples(payload: string): number[] {
    const buffer = Buffer.from(payload, "base64");
    const floats = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
    return Array.from(floats);
  }

  function startAudioHelper(processId: number): Promise<ShareableAudioSession> {
    return new Promise((resolveStart, rejectStart) => {
      const child = spawn(process.execPath, [helperScriptPath(), `--pid=${processId}`], {
        cwd: resolve(dirname(fileURLToPath(import.meta.url)), "../../../.."),
        stdio: ["ignore", "pipe", "pipe"],
      });
      helperProcess = child;
      let stdoutBuffer = "";
      let settled = false;

      const rejectOnce = (error: unknown) => {
        if (settled) return;
        settled = true;
        helperProcess = null;
        rejectStart(error instanceof Error ? error : new Error(String(error)));
      };

      const handleMessage = (message: any) => {
        if (message?.type === "started") {
          state.source = "recappi_process_audio";
          state.processId = Number(message.processId || processId);
          state.startedAt = state.startedAt || nowIso();
          state.stoppedAt = "";
          state.sampleRate = Number(message.sampleRate || 48000);
          state.channels = Number(message.channels || 2);
          if (!settled) {
            settled = true;
            const stopHelper = () => {
              if (helperProcess === child && !child.killed) {
                child.kill("SIGTERM");
              }
            };
            resolveStart({
              sampleRate: state.sampleRate,
              channels: state.channels,
              stop: stopHelper,
            });
          }
          return;
        }
        if (message?.type === "audio") {
          onAudio(null, decodeHelperSamples(String(message.samples || "")));
          return;
        }
        if (message?.type === "callback_error") {
          onAudio(new Error(String(message.error || "recappi_callback_error")), []);
          return;
        }
        if (message?.type === "error") {
          rejectOnce(new Error(String(message.error || "recappi_helper_failed")));
        }
      };

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdoutBuffer += chunk;
        while (stdoutBuffer.includes("\n")) {
          const index = stdoutBuffer.indexOf("\n");
          const line = stdoutBuffer.slice(0, index).trim();
          stdoutBuffer = stdoutBuffer.slice(index + 1);
          if (!line) continue;
          try {
            handleMessage(JSON.parse(line));
          } catch (error) {
            rememberError("recappi_helper_parse", error);
          }
        }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        const message = chunk.trim();
        if (message) log(`recappi_helper_stderr: ${message}`);
      });
      child.once("error", rejectOnce);
      child.once("exit", (code, signal) => {
        if (helperProcess === child) helperProcess = null;
        audioSession = null;
        if (!settled && !state.stoppedAt) {
          rejectOnce(new Error(`recappi_helper_exit:${code ?? signal ?? "unknown"}`));
          return;
        }
        if (!state.stoppedAt) {
          rememberError("recappi_helper_exit", `code=${code ?? ""} signal=${signal ?? ""}`);
        }
      });
    });
  }

  async function start(startOptions: RecappiAudioTapStartOptions = {}) {
    if (audioSession) return status();
    if (startPromise) return startPromise;
    startPromise = (async () => {
      const { ShareableContent } = await loadRecappiSdk(options);
      const processId = await findChromiumAudioPid(startOptions.context, ShareableContent, log);
      if (!processId) {
        throw new Error("chromium_audio_process_not_found");
      }
      if (options.shareableContent || options.useHelperProcess === false) {
        audioSession = ShareableContent.tapAudio(processId, onAudio);
        state.source = "recappi_process_audio";
        state.processId = processId;
        state.startedAt = state.startedAt || nowIso();
        state.stoppedAt = "";
        state.sampleRate = audioSession?.sampleRate || 48000;
        state.channels = audioSession?.channels || 2;
      } else {
        audioSession = await startAudioHelper(processId);
      }
      return status();
    })();
    try {
      return await startPromise;
    } finally {
      startPromise = null;
    }
  }

  function addConsumer(consumer: RecappiAudioCallback) {
    consumers.add(consumer);
    state.consumerCount = consumers.size;
    return () => {
      consumers.delete(consumer);
      state.consumerCount = consumers.size;
    };
  }

  function stop() {
    state.stoppedAt = nowIso();
    if (audioSession?.stop) audioSession.stop();
    if (helperProcess && !helperProcess.killed) helperProcess.kill("SIGTERM");
    helperProcess = null;
    audioSession = null;
    return status();
  }

  function status() {
    return {
      ...state,
      running: Boolean(audioSession),
      consumerCount: consumers.size,
    };
  }

  return {
    addConsumer,
    probe,
    start,
    stop,
    status,
  };
}
