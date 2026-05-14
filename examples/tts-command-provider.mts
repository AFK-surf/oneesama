#!/usr/bin/env node

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});

process.stdin.on("end", () => {
  const payload = JSON.parse(input || "{}");
  const text = payload.text || "";
  const sampleRate = 24_000;
  const durationMs = Math.min(1400, Math.max(500, 450 + text.length * 24));
  const sampleCount = Math.ceil((sampleRate * durationMs) / 1000);
  const wav = Buffer.alloc(44 + sampleCount * 2);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + sampleCount * 2, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(sampleCount * 2, 40);
  for (let index = 0; index < sampleCount; index += 1) {
    const t = index / sampleRate;
    const envelope = Math.min(1, index / 800, (sampleCount - index) / 800);
    const sample = Math.sin(2 * Math.PI * 480 * t) * 0.12 * envelope;
    wav.writeInt16LE(Math.max(-1, Math.min(1, sample)) * 32767, 44 + index * 2);
  }
  process.stdout.write(
    JSON.stringify({
      ok: true,
      provider: "command",
      mimeType: "audio/wav",
      audioDataUrl: `data:audio/wav;base64,${wav.toString("base64")}`,
      durationMs,
      sampleRate,
      text,
    }),
  );
});
