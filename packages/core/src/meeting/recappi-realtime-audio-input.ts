import { type Page } from "playwright";
import { createRecappiAudioTap, type RecappiAudioCallback } from "../audio/recappi-audio-tap.ts";

type BrowserContext = import("playwright").BrowserContext;

interface DiagnosticsLike {
  record?: (type: string, detail?: Record<string, unknown>) => void;
}

interface RecappiRealtimeAudioInputOptions {
  sessionId: string;
  recappiTap: ReturnType<typeof createRecappiAudioTap>;
  maxPendingPushes?: number;
}

interface RecappiAudioPayload {
  sessionId: string;
  source: string;
  sampleRate: number;
  channels: number;
  samples: number[];
}

function nowIso(): string {
  return new Date().toISOString();
}

export function createRecappiRealtimeAudioInput(options: RecappiRealtimeAudioInputOptions) {
  const state = {
    ok: true,
    enabled: true,
    source: "recappi_process_audio",
    sessionId: options.sessionId,
    startedAt: "",
    stoppedAt: "",
    sampleRate: 0,
    channels: 0,
    processId: 0,
    chunks: 0,
    samples: 0,
    pushedChunks: 0,
    droppedChunks: 0,
    pendingPushes: 0,
    lastChunkAt: "",
    lastPushAt: "",
    lastError: "",
    errors: [] as Array<{ ts: string; stage: string; error: string }>,
  };
  let page: Page | null = null;
  let releaseConsumer: (() => void) | null = null;
  let pushLoop: Promise<void> | null = null;
  let pushActive = false;
  let pushFlushScheduled = false;
  const pendingPayloads: RecappiAudioPayload[] = [];
  const maxPendingPushes = Math.max(1, options.maxPendingPushes || 64);

  function rememberError(stage: string, error: unknown) {
    state.ok = false;
    const entry = {
      ts: nowIso(),
      stage,
      error: String((error as Error)?.message || error),
    };
    state.lastError = entry.error;
    state.errors.push(entry);
    state.errors = state.errors.slice(-20);
  }

  function refreshPendingPushes() {
    state.pendingPushes = pendingPayloads.length + (pushActive ? 1 : 0);
  }

  function coalescePayloads(payloads: RecappiAudioPayload[]): RecappiAudioPayload | null {
    if (!payloads.length) return null;
    if (payloads.length === 1) return payloads[0];
    const first = payloads[0];
    const sampleCount = payloads.reduce((total, payload) => total + payload.samples.length, 0);
    const samples = Array.from<number>({ length: sampleCount });
    let offset = 0;
    for (const payload of payloads) {
      for (let index = 0; index < payload.samples.length; index += 1) {
        samples[offset + index] = payload.samples[index] || 0;
      }
      offset += payload.samples.length;
    }
    return {
      ...first,
      samples,
    };
  }

  async function flushPushQueue() {
    if (pushLoop) return pushLoop;
    pushLoop = (async () => {
      while (pendingPayloads.length > 0) {
        const batch = pendingPayloads.splice(0, pendingPayloads.length);
        const payload = coalescePayloads(batch);
        if (!payload) continue;
        pushActive = true;
        refreshPendingPushes();
        try {
          const target = page;
          if (!target || target.isClosed()) continue;
          const result = await target.evaluate((chunk) => {
            return (
              (window as any).MAB_REALTIME_CLIENT?.pushRecappiAudioSamples?.(chunk) || {
                ok: false,
                error: "push_recappi_audio_missing",
              }
            );
          }, payload);
          if (!result?.ok) throw new Error(result?.error || result?.reason || "push_failed");
          state.pushedChunks += batch.length;
          state.lastPushAt = nowIso();
        } catch (pushError) {
          rememberError("browser_push", pushError);
        } finally {
          pushActive = false;
          refreshPendingPushes();
        }
      }
    })();
    try {
      await pushLoop;
    } finally {
      pushLoop = null;
      refreshPendingPushes();
    }
  }

  function schedulePushFlush() {
    if (pushFlushScheduled) return;
    pushFlushScheduled = true;
    setTimeout(() => {
      pushFlushScheduled = false;
      void flushPushQueue();
    }, 0);
  }

  const onAudio: RecappiAudioCallback = (error, samples) => {
    if (error) {
      rememberError("recappi_callback", error);
      return;
    }
    state.chunks += 1;
    state.samples += samples.length;
    state.lastChunkAt = nowIso();
    const target = page;
    if (!target || target.isClosed()) return;
    refreshPendingPushes();
    if (state.pendingPushes >= maxPendingPushes) {
      state.droppedChunks += 1;
      return;
    }
    const payload: RecappiAudioPayload = {
      sessionId: options.sessionId,
      source: state.source,
      sampleRate: state.sampleRate || 48000,
      channels: state.channels || 2,
      samples: Array.from(samples, (sample) => Number(sample || 0)),
    };
    pendingPayloads.push(payload);
    refreshPendingPushes();
    schedulePushFlush();
  };

  async function start({
    context,
    page: targetPage,
    diagnostics,
  }: {
    context: BrowserContext;
    page: Page;
    diagnostics?: DiagnosticsLike | null;
  }) {
    page = targetPage;
    const tapState = await options.recappiTap.start({ context, allowGlobalFallback: true });
    if (!["recappi_process_audio", "recappi_global_audio"].includes(tapState.source || "")) {
      throw new Error(`unexpected_recappi_tap_source:${tapState.source || "unknown"}`);
    }
    state.startedAt = state.startedAt || nowIso();
    state.stoppedAt = "";
    state.source = tapState.source || "recappi_process_audio";
    state.sampleRate = tapState.sampleRate || 48000;
    state.channels = tapState.channels || 2;
    state.processId = tapState.processId || 0;
    releaseConsumer = options.recappiTap.addConsumer(onAudio);
    diagnostics?.record?.("recappi_realtime_audio_start", status());
    return { ok: true, state: status() };
  }

  async function stop() {
    releaseConsumer?.();
    releaseConsumer = null;
    state.stoppedAt = nowIso();
    await flushPushQueue();
    return { ok: true, state: status() };
  }

  function status() {
    return {
      ...state,
      recording: Boolean(releaseConsumer),
      tap: options.recappiTap.status(),
    };
  }

  return {
    start,
    stop,
    status,
  };
}
