import { createRecappiAudioTap } from "../packages/core/src/audio/recappi-audio-tap.ts";
import { chromium } from "playwright";

function flagValue(name, fallback) {
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg === name || arg.startsWith(prefix));
  if (!match) return fallback;
  if (match === name) return true;
  return match.slice(prefix.length);
}

function numberFlag(name, fallback) {
  const value = Number(flagValue(name, fallback));
  return Number.isFinite(value) ? value : fallback;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startTapWithRetry(tap, context, deadlineMs) {
  const startedAt = Date.now();
  let attempt = 0;
  let lastError = null;
  while (Date.now() - startedAt < deadlineMs) {
    attempt += 1;
    try {
      const status = await tap.start({ context });
      return { status, attempt };
    } catch (error) {
      lastError = error;
      await wait(Math.min(1000, 150 + attempt * 100));
    }
  }
  throw new Error(
    `recappi_tap_start_timeout after ${attempt} attempts: ${String(
      lastError?.message || lastError || "unknown",
    )}`,
  );
}

const durationMs = numberFlag("--duration-ms", 3000);
const startTimeoutMs = numberFlag("--start-timeout-ms", 12000);
const minChunks = numberFlag("--min-chunks", 5);
const minSamples = numberFlag("--min-samples", 8192);
const minMaxAbs = numberFlag("--min-max-abs", 0.02);
const minRms = numberFlag("--min-rms", 0.01);
const headless = flagValue("--headless", false) === true || flagValue("--headless", "") === "true";

const samplesSeen = {
  chunks: 0,
  samples: 0,
  maxAbs: 0,
  sumSquares: 0,
};

let browser = null;
let releaseConsumer = null;
let tap = null;

try {
  browser = await chromium.launch({
    headless,
    args: [
      "--autoplay-policy=no-user-gesture-required",
      "--disable-features=AudioServiceOutOfProcess",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--enable-usermedia-screen-capturing",
    ],
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setContent(`
    <!doctype html>
    <html>
      <head><title>Recappi Chrome Audio Smoke</title></head>
      <body><h1>Recappi Chrome Audio Smoke</h1></body>
    </html>
  `);
  await page.evaluate(async () => {
    const audioContext = new AudioContext();
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.frequency.value = 880;
    gain.gain.value = 0.14;
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.start();
    await audioContext.resume();
    window.__recappiChromeAudioSmoke = {
      stop() {
        try {
          oscillator.stop();
        } catch {
          // Best effort cleanup after the node already stopped.
        }
        return audioContext.close();
      },
    };
  });
  await wait(300);

  tap = createRecappiAudioTap({ log: () => {} });
  releaseConsumer = tap.addConsumer((error, samples) => {
    if (error || !samples?.length) return;
    samplesSeen.chunks += 1;
    samplesSeen.samples += samples.length;
    for (const sample of samples) {
      const value = Number(sample) || 0;
      const abs = Math.abs(value);
      if (abs > samplesSeen.maxAbs) samplesSeen.maxAbs = abs;
      samplesSeen.sumSquares += value * value;
    }
  });

  const probe = await tap.probe({ context });
  if (!probe.ok) {
    throw new Error(`recappi_probe_failed:${probe.error || "unknown"}`);
  }
  const start = await startTapWithRetry(tap, context, startTimeoutMs);
  await wait(durationMs);

  const rms = samplesSeen.samples ? Math.sqrt(samplesSeen.sumSquares / samplesSeen.samples) : 0;
  const status = tap.status();
  const summary = {
    ok:
      samplesSeen.chunks >= minChunks &&
      samplesSeen.samples >= minSamples &&
      samplesSeen.maxAbs >= minMaxAbs &&
      rms >= minRms,
    probe,
    startAttempt: start.attempt,
    tap: {
      source: status.source,
      processId: status.processId,
      sampleRate: status.sampleRate,
      channels: status.channels,
      running: status.running,
      errors: status.errors,
    },
    observed: {
      chunks: samplesSeen.chunks,
      samples: samplesSeen.samples,
      maxAbs: samplesSeen.maxAbs,
      rms,
    },
    thresholds: { minChunks, minSamples, minMaxAbs, minRms, durationMs },
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) {
    throw new Error(
      `recappi_audio_energy_missing chunks=${samplesSeen.chunks} samples=${samplesSeen.samples} maxAbs=${samplesSeen.maxAbs} rms=${rms}`,
    );
  }
} finally {
  try {
    releaseConsumer?.();
  } catch {
    // Best effort cleanup.
  }
  try {
    tap?.stop?.();
  } catch {
    // Best effort cleanup.
  }
  try {
    if (browser) {
      const pages = browser.contexts().flatMap((context) => context.pages());
      await Promise.all(
        pages.map((page) =>
          page.evaluate(() => window.__recappiChromeAudioSmoke?.stop?.()).catch(() => {}),
        ),
      );
      await browser.close();
    }
  } catch {
    // Best effort cleanup.
  }
}
