import assert from "node:assert/strict";
import http from "node:http";
import { test } from "vite-plus/test";

import { chromium } from "playwright";

import { buildRealtimeBrowserInitScript } from "../packages/core/src/realtime/realtime-browser-init-builder.ts";

test("Realtime sidecar output PCM reaches Meet avatar bus without a local speaker sink", async () => {
  await withRealtimeTokenServer(async ({ baseUrl }) => {
    const browser = await chromium.launch({
      headless: true,
      args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream"],
    });
    const context = await browser.newContext();
    const meetPage = await context.newPage();
    const sidecarPage = await context.newPage();
    try {
      await installMeetAvatarAudioBusFixture(meetPage);
      await sidecarPage.exposeFunction("MAB_HOST_ENQUEUE_REALTIME_PCM", async (payload) => {
        return await meetPage.evaluate((chunk) => {
          return window.MAB_AVATAR_AUDIO_BUS.enqueuePcmFrames(chunk);
        }, payload);
      });
      await sidecarPage.addInitScript({ content: buildFakeRealtimeWebRTCNamespace() });
      await sidecarPage.addInitScript({
        content: buildRealtimeBrowserInitScript({
          mode: "agents-sdk",
          agentRuntime: "test-sdk",
          realtimeRuntimePlacement: "sidecar",
          realtimePageRole: "sidecar",
          sessionId: "sidecar-output-audio-session",
          botName: "Onee-sama",
          autoConnect: true,
          tokenUrl: `${baseUrl}/realtime/client-secret`,
          openaiRealtimeBaseUrl: "https://api.openai.com/v1",
        }),
      });
      await sidecarPage.goto(`${baseUrl}/sidecar`);
      await sidecarPage.waitForFunction(() => window.__MAB_FAKE_WEBRTC_PC);

      const outputPcm = await sidecarPage.evaluate(async () => {
        const samples = Array.from(
          { length: 2400 },
          (_, index) => Math.sin((index / 48000) * 2 * Math.PI * 660) * 0.2,
        );
        return await window.MAB_REALTIME_CLIENT.pushRealtimeOutputPcmFrames({
          label: "model-speech-fixture",
          format: "float32",
          sampleRate: 48000,
          channels: 1,
          samples,
          endOfUtterance: true,
        });
      });

      await meetPage.waitForFunction(
        () => window.MAB_AVATAR_AUDIO?.outputEnergy?.observed === true,
        undefined,
        {
          timeout: 3000,
        },
      );
      const sidecarState = await sidecarPage.evaluate(() => ({
        connection: window.MAB_REALTIME_BRIDGE.connection,
        timelineTypes: window.MAB_REALTIME_BRIDGE.timeline.map((entry) => entry.type),
      }));
      const meetAudio = await meetPage.evaluate(() => window.MAB_AVATAR_AUDIO);

      assert.equal(outputPcm.ok, true);
      assert.equal(sidecarState.connection.remoteAudioRoutedToAvatarBus, true);
      assert.equal(sidecarState.connection.realtimeOutputAudioPort.mode, "sidecar-pcm");
      assert.equal(sidecarState.connection.realtimeOutputAudioPort.localSpeakerSink, false);
      assert.ok(
        ["MediaStreamDestination", "host-pcm-port"].includes(
          sidecarState.connection.realtimeOutputAudioPort.sinkNode,
        ),
      );
      assert.ok(sidecarState.connection.sidecarOutputPcmChunks > 0);
      assert.ok(
        sidecarState.timelineTypes.includes("remote_audio_sidecar_pcm_chunk"),
        `timeline=${JSON.stringify(sidecarState.timelineTypes)}`,
      );
      assert.ok(meetAudio.routedPcmChunks > 0);
      assert.ok(meetAudio.routedPcmSamples > 0);
      assert.equal(meetAudio.outputEnergy.observed, true);
      assert.ok(meetAudio.outputEnergy.maxRms > 0.01);
      assert.equal(meetAudio.outputTrackReadyState, "live");
      assert.equal(meetAudio.outputTrackMuted, false);
    } finally {
      await browser.close();
    }
  });
});

test("Realtime sidecar output PCM does not use tone fallback for real PCM", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.addInitScript({
      content: `
        window.__MAB_SIDE_CAR_TONES = [];
        window.MAB_AVATAR_AUDIO_BUS = {
          injectTone(options = {}) {
            window.__MAB_SIDE_CAR_TONES.push(options);
            return { ok: true, durationMs: options.durationMs || 120 };
          },
        };
      `,
    });
    await page.addInitScript({
      content: buildRealtimeBrowserInitScript({
        mode: "webrtc-mock",
        realtimeRuntimePlacement: "sidecar",
        realtimePageRole: "sidecar",
        sessionId: "sidecar-output-audio-no-fallback-session",
        autoConnect: false,
        simulateRemoteAudio: false,
      }),
    });
    await page.goto("data:text/html,<html><body>sidecar</body></html>");

    const result = await page.evaluate(() =>
      window.MAB_REALTIME_CLIENT.pushRealtimeOutputPcmFrames({
        label: "real-pcm-without-port",
        format: "float32",
        sampleRate: 48000,
        channels: 1,
        samples: [0.2, -0.2, 0.1, -0.1],
      }),
    );
    const bridge = await page.evaluate(() => ({
      connection: window.MAB_REALTIME_BRIDGE.connection,
      tones: window.__MAB_SIDE_CAR_TONES,
    }));

    assert.equal(result.ok, false);
    assert.equal(result.error, "realtime_output_audio_port_missing");
    assert.deepEqual(bridge.tones, []);
    assert.equal(bridge.connection.remoteAudioRoutedToAvatarBus, false);
    assert.equal(
      bridge.connection.realtimeOutputAudioPort.lastError,
      "realtime_output_audio_port_missing",
    );
  } finally {
    await browser.close();
  }
});

async function installMeetAvatarAudioBusFixture(page) {
  await page.setContent("<!doctype html><html><body>Meet avatar audio bus fixture</body></html>");
  await page.evaluate(() => {
    const audioContext = new AudioContext({ sampleRate: 48000 });
    const destination = audioContext.createMediaStreamDestination();
    const track = destination.stream.getAudioTracks()[0];
    const state = {
      ok: true,
      sampleRate: audioContext.sampleRate,
      outputTrackId: track?.id || "",
      outputTrackReadyState: track?.readyState || "",
      outputTrackMuted: track?.muted === true,
      routedPcmChunks: 0,
      routedPcmSamples: 0,
      lastPcmRoute: null,
      outputEnergy: {
        observed: false,
        rms: 0,
        peak: 0,
        maxRms: 0,
        lastEnergyAt: "",
      },
    };
    window.MAB_AVATAR_AUDIO_BUS = {
      audioContext,
      stream: destination.stream,
      track,
      enqueuePcmFrames(payload = {}) {
        const samples = Array.isArray(payload.samples) ? payload.samples : [];
        let sumSquares = 0;
        let peak = 0;
        for (const sample of samples) {
          const value = Math.max(-1, Math.min(1, Number(sample || 0)));
          const abs = Math.abs(value);
          peak = Math.max(peak, abs);
          sumSquares += value * value;
        }
        const rms = samples.length ? Math.sqrt(sumSquares / samples.length) : 0;
        state.routedPcmChunks += 1;
        state.routedPcmSamples += samples.length;
        state.outputTrackReadyState = track?.readyState || "";
        state.outputTrackMuted = track?.muted === true;
        state.outputEnergy = {
          observed: state.outputEnergy.observed || rms > 0.01 || peak > 0.03,
          rms: Number(rms.toFixed(5)),
          peak: Number(peak.toFixed(5)),
          maxRms: Number(Math.max(state.outputEnergy.maxRms || 0, rms).toFixed(5)),
          lastEnergyAt:
            rms > 0.01 || peak > 0.03 ? new Date().toISOString() : state.outputEnergy.lastEnergyAt,
        };
        state.lastPcmRoute = {
          ts: new Date().toISOString(),
          label: payload.label || "",
          sampleRate: payload.sampleRate || 0,
          channels: payload.channels || 0,
          frames: samples.length / Math.max(1, Number(payload.channels || 1)),
        };
        return { ok: true, ...state.lastPcmRoute };
      },
    };
    window.MAB_AVATAR_AUDIO = state;
  });
}

function buildFakeRealtimeWebRTCNamespace() {
  return `
    window.__MAB_FAKE_ORIGINAL_ONTRACK_CALLS = 0;
    window.OpenAIAgentsRealtime = {
      tool(config) { return config; },
      RealtimeAgent: function RealtimeAgent(config) { this.config = config; },
      OpenAIRealtimeWebRTC: class OpenAIRealtimeWebRTC {
        constructor(options) {
          const receiver = {
            track: { id: 'remote_audio_track', kind: 'audio', readyState: 'live', muted: false },
            getStats: async () => new Map([
              ['inbound_audio', {
                type: 'inbound-rtp',
                kind: 'audio',
                bytesReceived: 4096,
                packetsReceived: 24,
                totalAudioEnergy: 0.42,
                audioLevel: 0.12,
              }],
            ]),
          };
          const pc = {
            connectionState: 'connected',
            ontrack() { window.__MAB_FAKE_ORIGINAL_ONTRACK_CALLS += 1; },
            getReceivers: () => [receiver],
            getSenders: () => [],
            addEventListener() {},
            close() {},
          };
          window.__MAB_FAKE_WEBRTC_PC = pc;
          options.changePeerConnection(pc);
        }
        on() { return this; }
        close() {}
      },
      RealtimeSession: class RealtimeSession {
        constructor() { this.listeners = new Map(); }
        on(type, callback) {
          const callbacks = this.listeners.get(type) || [];
          callbacks.push(callback);
          this.listeners.set(type, callbacks);
          return this;
        }
        async connect() {}
        close() {}
      },
    };
  `;
}

async function withRealtimeTokenServer(callback) {
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/realtime/client-secret") {
      response.end(JSON.stringify({ ok: true, client_secret: { value: "ek_mock_sdk" } }));
      return;
    }
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    await callback({ baseUrl: `http://127.0.0.1:${address.port}` });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
