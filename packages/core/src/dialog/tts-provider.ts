import { spawn } from "node:child_process";
import { getRuntimeConfig } from "../env.js";

interface TtsSynthesisInput {
  text?: string;
  voice?: string;
  format?: string;
  durationMs?: number;
  frequency?: number;
  gain?: number;
  context?: Record<string, unknown>;
}

interface TtsProviderFactoryOptions {
  env?: NodeJS.ProcessEnv;
  provider?: string;
}

interface TtsProviderResponse {
  ok: boolean;
  provider?: string;
  error?: string;
  [key: string]: unknown;
}

function clamp(value: unknown, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function normalizeProvider(provider: unknown): string {
  return String(provider || "tone-wav")
    .trim()
    .toLowerCase()
    .replaceAll("_", "-");
}

function encodePcm16Wav({
  samples,
  sampleRate,
}: {
  samples: Float32Array;
  sampleRate: number;
}): Buffer {
  const bytesPerSample = 2;
  const blockAlign = bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < samples.length; index += 1) {
    buffer.writeInt16LE(clamp(samples[index], -1, 1) * 32767, 44 + index * bytesPerSample);
  }
  return buffer;
}

function synthesizeToneWav({
  text = "",
  durationMs,
  frequency,
  gain,
}: TtsSynthesisInput): TtsProviderResponse {
  const safeText = String(text || "");
  const sampleRate = 24_000;
  const resolvedDurationMs = clamp(durationMs || 650 + safeText.length * 28, 450, 3600);
  const resolvedFrequency = clamp(frequency || 420 + (safeText.length % 11) * 24, 180, 1200);
  const resolvedGain = clamp(gain ?? 0.16, 0.001, 0.8);
  const sampleCount = Math.ceil((sampleRate * resolvedDurationMs) / 1000);
  const fadeSamples = Math.min(Math.floor(sampleRate * 0.04), Math.floor(sampleCount / 2));
  const samples = new Float32Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) {
    const t = index / sampleRate;
    const fadeIn = fadeSamples ? Math.min(1, index / fadeSamples) : 1;
    const fadeOut = fadeSamples ? Math.min(1, (sampleCount - index) / fadeSamples) : 1;
    const envelope = Math.min(fadeIn, fadeOut);
    const vibrato = Math.sin(2 * Math.PI * 4.2 * t) * 5;
    samples[index] =
      Math.sin(2 * Math.PI * (resolvedFrequency + vibrato) * t) * resolvedGain * envelope;
  }
  const wav = encodePcm16Wav({ samples, sampleRate });
  return {
    ok: true,
    provider: "tone-wav",
    mimeType: "audio/wav",
    audioDataUrl: `data:audio/wav;base64,${wav.toString("base64")}`,
    durationMs: resolvedDurationMs,
    sampleRate,
    textLength: safeText.length,
  };
}

function parseProviderResponse(
  text: string,
  fallback: Record<string, unknown> = {},
): TtsProviderResponse {
  const trimmed = String(text || "").trim();
  if (!trimmed) return { ok: false, error: "empty_tts_provider_response", ...fallback };
  try {
    return { ...fallback, ...JSON.parse(trimmed) };
  } catch {
    return {
      ok: false,
      error: "tts_provider_returned_non_json",
      raw: trimmed.slice(0, 400),
      ...fallback,
    };
  }
}

function runCommandProvider({
  command,
  payload,
  env,
}: {
  command: string;
  payload: TtsSynthesisInput;
  env: NodeJS.ProcessEnv;
}): Promise<TtsProviderResponse> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [], {
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const parsed = parseProviderResponse(stdout, { provider: "command", debug: stderr.trim() });
      resolve({
        ...parsed,
        ok: code === 0 && parsed.ok !== false,
        error:
          code === 0 ? parsed.error : parsed.error || stderr.trim() || `tts command exited ${code}`,
      });
    });
    child.stdin.end(JSON.stringify(payload, null, 2));
  });
}

async function runHttpProvider({
  url,
  payload,
}: {
  url: string;
  payload: TtsSynthesisInput;
}): Promise<TtsProviderResponse> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  const parsed = parseProviderResponse(text, { provider: "http" });
  return {
    ...parsed,
    ok: response.ok && parsed.ok !== false,
    error: response.ok
      ? parsed.error
      : parsed.error || `tts HTTP provider returned ${response.status}`,
  };
}

export function createTtsProvider(options: TtsProviderFactoryOptions = {}) {
  const config = getRuntimeConfig(options.env);
  const provider = normalizeProvider(options.provider || config.ttsProvider);
  const env = options.env || process.env;

  async function synthesize(input: TtsSynthesisInput = {}): Promise<TtsProviderResponse> {
    const payload = {
      text: String(input.text || ""),
      voice: input.voice || config.ttsVoice,
      format: input.format || "wav",
      durationMs: input.durationMs,
      frequency: input.frequency,
      gain: input.gain,
      context: input.context || {},
    };
    if (!payload.text.trim()) return { ok: false, provider, error: "text_required" };
    if (provider === "tone" || provider === "tone-wav") {
      return synthesizeToneWav(payload);
    }
    if (provider === "command") {
      if (!config.ttsCommand)
        return {
          ok: false,
          provider,
          error: "MAB_TTS_COMMAND is required when MAB_TTS_PROVIDER=command",
        };
      return await runCommandProvider({ command: config.ttsCommand, payload, env });
    }
    if (provider === "http" || provider === "http-json") {
      if (!config.ttsHttpUrl)
        return {
          ok: false,
          provider,
          error: "MAB_TTS_HTTP_URL is required when MAB_TTS_PROVIDER=http",
        };
      return await runHttpProvider({ url: config.ttsHttpUrl, payload });
    }
    return { ok: false, provider, error: `Unsupported MAB_TTS_PROVIDER provider: ${provider}` };
  }

  return { provider, synthesize };
}
