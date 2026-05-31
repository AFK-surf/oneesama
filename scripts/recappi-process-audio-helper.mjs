import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function flagValue(name, fallback = "") {
  const prefix = `${name}=`;
  const arg = process.argv.find((entry) => entry === name || entry.startsWith(prefix));
  if (!arg) return fallback;
  if (arg === name) return "true";
  return arg.slice(prefix.length);
}

function writeJson(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

const processId = Number(flagValue("--pid", "0"));
if (!Number.isFinite(processId) || processId <= 0) {
  writeJson({ type: "error", error: "missing_pid" });
  process.exit(2);
}

let audioSession = null;
let stopping = false;

function stop() {
  if (stopping) return;
  stopping = true;
  try {
    audioSession?.stop?.();
  } catch {
    // Best effort shutdown.
  }
  audioSession = null;
}

process.once("SIGTERM", () => {
  stop();
  process.exit(0);
});
process.once("SIGINT", () => {
  stop();
  process.exit(0);
});
process.once("disconnect", () => {
  stop();
  process.exit(0);
});

try {
  const { ShareableContent } = require("@recappi/sdk");
  audioSession = ShareableContent.tapAudio(processId, (error, samples) => {
    if (error) {
      writeJson({ type: "callback_error", error: String(error?.message || error) });
      return;
    }
    if (!samples?.length) return;
    const floats = Float32Array.from(samples, (sample) => Number(sample) || 0);
    writeJson({
      type: "audio",
      samples: Buffer.from(floats.buffer).toString("base64"),
      sampleCount: floats.length,
    });
  });
  writeJson({
    type: "started",
    processId,
    sampleRate: audioSession?.sampleRate || 48000,
    channels: audioSession?.channels || 2,
  });
} catch (error) {
  writeJson({ type: "error", error: String(error?.message || error) });
  process.exit(1);
}
