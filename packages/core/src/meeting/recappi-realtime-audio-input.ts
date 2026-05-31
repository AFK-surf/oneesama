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
  startTimeoutMs?: number;
  startRetryDelayMs?: number;
  backgroundRetryTimeoutMs?: number;
  backgroundRetryDelayMs?: number;
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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const PRIME_PULSE_GAIN = 0.08;
const PRIME_PULSE_FREQUENCY_HZ = 880;
const PRIME_PULSE_MS = 450;
const PRIME_SUPPRESS_EXTRA_MS = 350;

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
    retrying: false,
    lastRetryAt: "",
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
  const startTimeoutMs = Math.max(0, options.startTimeoutMs ?? 5000);
  const startRetryDelayMs = Math.max(50, options.startRetryDelayMs ?? 250);
  const backgroundRetryTimeoutMs = Math.max(0, options.backgroundRetryTimeoutMs ?? 120_000);
  const backgroundRetryDelayMs = Math.max(100, options.backgroundRetryDelayMs ?? 1000);
  let stopped = false;
  let backgroundRetryLoop: Promise<void> | null = null;
  let activePrimeStop: (() => Promise<void>) | null = null;
  let primeSuppressUntil = 0;

  function isRetryableStartError(error: unknown): boolean {
    const message = String((error as Error)?.message || error || "");
    return (
      message.includes("Application not found or not available for audio tapping") ||
      message.includes("chromium_audio_process_not_found")
    );
  }

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
    if (Date.now() < primeSuppressUntil) {
      state.droppedChunks += 1;
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

  async function startBrowserAudioPrime(target: Page, diagnostics?: DiagnosticsLike | null) {
    const result = await target
      .evaluate(
        `(async () => {
        const globalScope = window;
        if (globalScope.__MAB_RECAPPI_AUDIO_PRIME?.active) {
          const pulse = await globalScope.__MAB_RECAPPI_AUDIO_PRIME.pulse?.();
          return { ok: true, reused: true, pulse };
        }
        const AudioContextCtor = globalScope.AudioContext || globalScope.webkitAudioContext;
        if (!AudioContextCtor) return { ok: false, error: "audio_context_unavailable" };
        const audioContext = new AudioContextCtor();
        const oscillator = audioContext.createOscillator();
        const gain = audioContext.createGain();
        gain.gain.value = 0;
        oscillator.frequency.value = ${PRIME_PULSE_FREQUENCY_HZ};
        oscillator.connect(gain).connect(audioContext.destination);
        oscillator.start();
        if (audioContext.state === "suspended") await audioContext.resume();
        const pulse = () => {
          const now = audioContext.currentTime;
          const durationSeconds = ${PRIME_PULSE_MS} / 1000;
          const primeGain = ${PRIME_PULSE_GAIN};
          try {
            gain.gain.cancelScheduledValues(now);
            gain.gain.setValueAtTime(0, now);
            gain.gain.linearRampToValueAtTime(primeGain, now + 0.02);
            gain.gain.linearRampToValueAtTime(0, now + durationSeconds);
          } catch {
            gain.gain.value = primeGain;
            setTimeout(() => {
              try { gain.gain.value = 0; } catch {}
            }, ${PRIME_PULSE_MS});
          }
          return { ok: true, gain: primeGain, frequencyHz: ${PRIME_PULSE_FREQUENCY_HZ}, durationMs: ${PRIME_PULSE_MS} };
        };
        globalScope.__MAB_RECAPPI_AUDIO_PRIME = {
          active: true,
          pulse,
          stop: async () => {
            try { oscillator.stop(); } catch {}
            try { oscillator.disconnect(); } catch {}
            try { gain.disconnect(); } catch {}
            try { await audioContext.close(); } catch {}
            globalScope.__MAB_RECAPPI_AUDIO_PRIME = null;
          },
        };
        const pulseResult = pulse();
        return { ok: true, reused: false, state: audioContext.state, pulse: pulseResult };
      })()`,
      )
      .catch((error) => ({ ok: false, error: String((error as Error)?.message || error) }));
    diagnostics?.record?.("recappi_realtime_audio_prime", result as Record<string, unknown>);
    return async () => {
      await target
        .evaluate(
          `(async () => {
          const prime = window.__MAB_RECAPPI_AUDIO_PRIME;
          if (!prime?.stop) return { ok: true, stopped: false };
          await prime.stop();
          return { ok: true, stopped: true };
        })()`,
        )
        .catch((error) => {
          diagnostics?.record?.("recappi_realtime_audio_prime_stop_error", {
            error: String((error as Error)?.message || error),
          });
        });
    };
  }

  async function pulseBrowserAudioPrime(target: Page | null, diagnostics?: DiagnosticsLike | null) {
    if (!target || target.isClosed()) return;
    const result = await target
      .evaluate(
        `(async () => {
        const prime = window.__MAB_RECAPPI_AUDIO_PRIME;
        if (!prime?.pulse) return { ok: false, reason: "prime_missing" };
        return await prime.pulse();
      })()`,
      )
      .catch((error) => ({ ok: false, error: String((error as Error)?.message || error) }));
    const durationMs = Number((result as { durationMs?: unknown })?.durationMs || 0);
    if ((result as { ok?: boolean })?.ok && durationMs > 0) {
      primeSuppressUntil = Date.now() + durationMs + PRIME_SUPPRESS_EXTRA_MS;
    }
    diagnostics?.record?.("recappi_realtime_audio_prime_pulse", result as Record<string, unknown>);
  }

  async function startTapWithRetry({
    context,
    page: targetPage,
    diagnostics,
  }: {
    context: BrowserContext;
    page: Page | null;
    diagnostics?: DiagnosticsLike | null;
  }) {
    const deadline = Date.now() + startTimeoutMs;
    let attempt = 0;
    let lastError: unknown = null;
    while (true) {
      attempt += 1;
      try {
        await pulseBrowserAudioPrime(targetPage, diagnostics);
        const tapState: any = await options.recappiTap.start({ context });
        if ((tapState.source || "") !== "recappi_process_audio") {
          throw new Error(`unexpected_recappi_tap_source:${tapState.source || "unknown"}`);
        }
        if (attempt > 1) {
          diagnostics?.record?.("recappi_realtime_audio_start_retry_succeeded", { attempt });
        }
        return tapState;
      } catch (error) {
        lastError = error;
        const message = String((error as Error)?.message || error);
        const retry =
          Date.now() < deadline && !message.startsWith("unexpected_recappi_tap_source:");
        diagnostics?.record?.("recappi_realtime_audio_start_attempt_failed", {
          attempt,
          error: message,
          retry,
        });
        if (!retry) break;
        await sleep(startRetryDelayMs);
      }
    }
    rememberError("recappi_start", lastError);
    throw lastError instanceof Error
      ? lastError
      : new Error(String(lastError || "recappi_start_failed"));
  }

  function activateTap(tapState: any, diagnostics?: DiagnosticsLike | null) {
    stopped = false;
    state.ok = true;
    state.retrying = false;
    state.lastRetryAt = "";
    state.lastError = "";
    state.startedAt = state.startedAt || nowIso();
    state.stoppedAt = "";
    state.source = tapState.source || "recappi_process_audio";
    state.sampleRate = tapState.sampleRate || 48000;
    state.channels = tapState.channels || 2;
    state.processId = tapState.processId || 0;
    releaseConsumer ??= options.recappiTap.addConsumer(onAudio);
    diagnostics?.record?.("recappi_realtime_audio_start", status());
    return { ok: true, state: status() };
  }

  function scheduleBackgroundRetry({
    context,
    page: targetPage,
    diagnostics,
  }: {
    context: BrowserContext;
    page: Page | null;
    diagnostics?: DiagnosticsLike | null;
  }) {
    if (backgroundRetryLoop) return;
    state.retrying = true;
    diagnostics?.record?.("recappi_realtime_audio_background_retry_scheduled", {
      timeoutMs: backgroundRetryTimeoutMs,
      delayMs: backgroundRetryDelayMs,
    });
    backgroundRetryLoop = (async () => {
      const deadline = Date.now() + backgroundRetryTimeoutMs;
      let attempt = 0;
      while (!stopped && Date.now() <= deadline) {
        attempt += 1;
        state.lastRetryAt = nowIso();
        try {
          const tapState = await startTapWithRetry({ context, page: targetPage, diagnostics });
          if (stopped) break;
          diagnostics?.record?.("recappi_realtime_audio_background_retry_succeeded", { attempt });
          activateTap(tapState, diagnostics);
          await activePrimeStop?.();
          activePrimeStop = null;
          return;
        } catch (error) {
          const message = String((error as Error)?.message || error);
          const retry = isRetryableStartError(error) && Date.now() < deadline && !stopped;
          diagnostics?.record?.("recappi_realtime_audio_background_retry_failed", {
            attempt,
            error: message,
            retry,
          });
          if (!retry) break;
          await sleep(backgroundRetryDelayMs);
        }
      }
      state.retrying = false;
      await activePrimeStop?.();
      activePrimeStop = null;
    })().finally(() => {
      backgroundRetryLoop = null;
      if (!releaseConsumer) state.retrying = false;
    });
  }

  async function start({
    context,
    page: targetPage,
    diagnostics,
  }: {
    context: BrowserContext;
    page: Page;
    diagnostics?: DiagnosticsLike | null;
  }) {
    stopped = false;
    page = targetPage;
    const stopPrime = await startBrowserAudioPrime(targetPage, diagnostics);
    activePrimeStop = stopPrime;
    let tapState: any;
    try {
      tapState = await startTapWithRetry({ context, page: targetPage, diagnostics });
    } catch (error) {
      if (!isRetryableStartError(error)) {
        await stopPrime();
        activePrimeStop = null;
        throw error;
      }
      scheduleBackgroundRetry({ context, page: targetPage, diagnostics });
      return { ok: false, pending: true, state: status() };
    }
    if (activePrimeStop === stopPrime) activePrimeStop = null;
    try {
      return activateTap(tapState, diagnostics);
    } finally {
      await stopPrime();
    }
  }

  async function probe({ context }: { context: BrowserContext }) {
    try {
      const tapState: any =
        typeof options.recappiTap?.probe === "function"
          ? await options.recappiTap.probe({ context })
          : await options.recappiTap.start({ context });
      if ((tapState.source || "") !== "recappi_process_audio") {
        return {
          ok: false,
          source: tapState.source || "",
          processId: tapState.processId || 0,
          error: `unexpected_recappi_tap_source:${tapState.source || "unknown"}`,
        };
      }
      return {
        ok: true,
        source: "recappi_process_audio",
        processId: tapState.processId || 0,
        sampleRate: tapState.sampleRate || 48000,
        channels: tapState.channels || 2,
      };
    } catch (error) {
      return {
        ok: false,
        source: "",
        processId: 0,
        error: String((error as Error)?.message || error),
      };
    }
  }

  async function stop() {
    stopped = true;
    releaseConsumer?.();
    releaseConsumer = null;
    state.retrying = false;
    await activePrimeStop?.();
    activePrimeStop = null;
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
    probe,
    start,
    stop,
    status,
  };
}
