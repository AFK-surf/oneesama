import { existsSync } from "node:fs";
import { createRequire } from "node:module";

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
  tapAudio(processId: number, callback: RecappiAudioCallback): ShareableAudioSession;
  tapGlobalAudio(filters: unknown[], callback: RecappiAudioCallback): ShareableAudioSession;
}

interface RecappiSdkModule {
  ShareableContent: ShareableContentApi;
}

export interface RecappiAudioTapOptions {
  recappiSdkPath?: string;
  log?: (message: string) => void;
}

export interface RecappiAudioTapStartOptions {
  context?: BrowserContext | null;
  allowGlobalFallback?: boolean;
}

function nowIso(): string {
  return new Date().toISOString();
}

function defaultLog(message: string): void {
  console.error(`[recappi-audio-tap] ${message}`);
}

async function loadRecappiSdk(options: RecappiAudioTapOptions = {}): Promise<RecappiSdkModule> {
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

async function findChromiumAudioPid(
  context: BrowserContext | null | undefined,
  shareableContent: ShareableContentApi,
  log: (message: string) => void,
): Promise<number | null> {
  try {
    const browser = context?.browser?.();
    if (browser?.newBrowserCDPSession) {
      const session = await browser.newBrowserCDPSession();
      const { processInfo } = await session.send("SystemInfo.getProcessInfo");
      const audio = (processInfo || []).find((p) => p.type === "audio.mojom.AudioService");
      if (audio?.id) return audio.id;
      const browserProc = (processInfo || []).find((p) => p.type === "browser");
      if (browserProc?.id) return browserProc.id;
    }
  } catch (error) {
    log(`CDP process lookup failed: ${String((error as Error)?.message || error)}`);
  }

  try {
    const apps = shareableContent?.applications?.() || [];
    const chromium = apps.find((app) => {
      const bundle = String(app.bundleIdentifier || "").toLowerCase();
      return bundle.includes("chromium") || bundle.includes("chrome");
    });
    return chromium?.processId || null;
  } catch (error) {
    log(`Recappi app scan failed: ${String((error as Error)?.message || error)}`);
    return null;
  }
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
  let startPromise: Promise<ReturnType<typeof status>> | null = null;

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

  async function start(startOptions: RecappiAudioTapStartOptions = {}) {
    if (audioSession) return status();
    if (startPromise) return startPromise;
    startPromise = (async () => {
      const { ShareableContent } = await loadRecappiSdk(options);
      const processId = await findChromiumAudioPid(startOptions.context, ShareableContent, log);
      if (!processId && !startOptions.allowGlobalFallback) {
        throw new Error("chromium_audio_process_not_found");
      }
      try {
        if (processId) {
          audioSession = ShareableContent.tapAudio(processId, onAudio);
          state.source = "recappi_process_audio";
          state.processId = processId;
        } else {
          audioSession = ShareableContent.tapGlobalAudio([], onAudio);
          state.source = "recappi_global_audio";
          state.processId = 0;
        }
      } catch (error) {
        if (!startOptions.allowGlobalFallback || !processId) throw error;
        rememberError("recappi_tap_audio", error);
        audioSession = ShareableContent.tapGlobalAudio([], onAudio);
        state.source = "recappi_global_audio";
        state.processId = 0;
      }
      state.startedAt = state.startedAt || nowIso();
      state.stoppedAt = "";
      state.sampleRate = audioSession?.sampleRate || 48000;
      state.channels = audioSession?.channels || 2;
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
    if (audioSession?.stop) audioSession.stop();
    audioSession = null;
    state.stoppedAt = nowIso();
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
    start,
    stop,
    status,
  };
}
