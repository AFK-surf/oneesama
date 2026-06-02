import assert from "node:assert/strict";
import http from "node:http";
import { test } from "vite-plus/test";
import { chromium } from "playwright";

import { startRealtimeSidecarPage } from "../packages/core/src/meeting/google-meet-joiner-realtime-sidecar.ts";
import { buildRealtimeBrowserInitScript } from "../packages/core/src/realtime/realtime-browser-init-builder.ts";

test("Realtime sidecar accepts host-forwarded Meet surface PCM for non-Google fixtures", async () => {
  await withSurfaceAudioServer(async ({ baseUrl }) => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    try {
      const sidecarPage = await context.newPage();
      await sidecarPage.addInitScript({
        content: buildRealtimeBrowserInitScript({
          mode: "webrtc-mock",
          agentRuntime: "mock",
          realtimeRuntimePlacement: "sidecar",
          realtimePageRole: "sidecar",
          sessionId: "sidecar-surface-audio-session",
          tokenUrl: `${baseUrl}/realtime/client-secret`,
          autoConnect: true,
          includeParticipantAudio: true,
          forwardMeetAudioToRealtime: true,
          meetAudioInputSource: "webrtc",
          allowHostMeetAudioPcmInput: true,
          meetAudioInputGain: 1,
          tools: [],
          session: {},
        }),
      });
      await sidecarPage.goto(`${baseUrl}/sidecar`);
      await sidecarPage.waitForFunction(
        () => typeof window.MAB_REALTIME_CLIENT?.pushHostMeetAudioSamples === "function",
      );

      await context.exposeBinding("MAB_HOST_FORWARD_MEET_AUDIO_PCM", async (_source, payload) => {
        return await sidecarPage.evaluate(
          (chunk) => window.MAB_REALTIME_CLIENT.pushHostMeetAudioSamples(chunk),
          payload,
        );
      });

      const meetPage = await context.newPage();
      await meetPage.addInitScript({
        content: buildRealtimeBrowserInitScript({
          mode: "agents-sdk",
          agentRuntime: "agents-sdk",
          realtimeRuntimePlacement: "sidecar",
          realtimePageRole: "meet-surface",
          sessionId: "sidecar-surface-audio-session",
          tokenUrl: `${baseUrl}/realtime/client-secret`,
          includeParticipantAudio: true,
          forwardMeetAudioToRealtime: true,
          allowHostMeetAudioPcmInput: true,
          allowParticipantAudioStreamEvents: true,
        }),
      });
      await meetPage.goto(`${baseUrl}/meet`);
      await meetPage.mouse.click(20, 20);
      await meetPage.evaluate(async () => {
        const AudioContextImpl = window.AudioContext || window.webkitAudioContext;
        const audioContext = new AudioContextImpl({ sampleRate: 48000 });
        await audioContext.resume();
        const oscillator = audioContext.createOscillator();
        const gain = audioContext.createGain();
        const destination = audioContext.createMediaStreamDestination();
        oscillator.frequency.value = 440;
        gain.gain.value = 0.08;
        oscillator.connect(gain);
        gain.connect(destination);
        oscillator.start();
        window.__MAB_TEST_SURFACE_AUDIO_STOP = async () => {
          try {
            oscillator.stop();
          } catch {}
          try {
            await audioContext.close();
          } catch {}
        };
        window.dispatchEvent(
          new CustomEvent("meeting-avatar-participant-audio-stream", {
            detail: { label: "fixture-surface-pcm", stream: destination.stream },
          }),
        );
      });

      await sidecarPage.waitForFunction(
        () => window.MAB_REALTIME_BRIDGE?.connection?.hostMeetAudioInput?.chunks > 0,
      );
      await sidecarPage.waitForFunction(
        () => window.MAB_REALTIME_BRIDGE?.connection?.meetAudioEnergy?.observed === true,
      );

      const [sidecarState, meetState] = await Promise.all([
        sidecarPage.evaluate(() => ({
          connection: window.MAB_REALTIME_BRIDGE.connection,
          timelineTypes: window.MAB_REALTIME_BRIDGE.timeline.map((entry) => entry.type),
        })),
        meetPage.evaluate(() => ({
          sdkGlobal: Boolean(window.OpenAIAgentsRealtime),
          surfaceAudioInput: window.MAB_MEET_SURFACE_AUDIO_INPUT?.state || null,
        })),
      ]);
      await meetPage.evaluate(() => window.__MAB_TEST_SURFACE_AUDIO_STOP?.());

      assert.equal(meetState.sdkGlobal, false);
      assert.ok(meetState.surfaceAudioInput?.chunks > 0);
      assert.equal(sidecarState.connection.hostMeetAudioInput.connected, true);
      assert.ok(sidecarState.connection.hostMeetAudioInput.samplesReceived > 0);
      assert.equal(sidecarState.connection.currentRealtimeInputSource, "host_meet_audio_pcm");
      assert.deepEqual(sidecarState.connection.meetAudioTrackStates.at(-1), {
        trackId: "host-meet-audio-pcm",
        readyState: "live",
        enabled: true,
        muted: false,
        connected: true,
        disconnectReason: "",
        source: "host_meet_audio_pcm",
        label: "Host-forwarded Meet surface PCM",
      });
      assert.equal(sidecarState.connection.meetAudioTracksForwarded, 1);
      assert.equal(sidecarState.connection.meetAudioEnergy.observed, true);
      assert.ok(sidecarState.timelineTypes.includes("host_meet_audio_input_connected"));
    } finally {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  });
});

test("Realtime sidecar rejects host-forwarded Meet surface PCM from stale sessions", async () => {
  await withSurfaceAudioServer(async ({ baseUrl }) => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const meetPage = await context.newPage();
    const events = [];
    const diagnostics = {
      sessionId: "sidecar-current-audio-session",
      console: [],
      pageErrors: [],
      requestFailures: [],
      events,
      record: (type, detail = {}) => events.push({ type, detail }),
    };
    let sidecar;
    try {
      await meetPage.goto(`${baseUrl}/meet`);
      sidecar = await startRealtimeSidecarPage({
        context,
        diagnostics,
        getMeetPage: () => meetPage,
        realtimeBridgeConfig: {
          mode: "webrtc-mock",
          agentRuntime: "mock",
          realtimeRuntimePlacement: "sidecar",
          realtimePageRole: "sidecar",
          sessionId: "sidecar-current-audio-session",
          tokenUrl: `${baseUrl}/realtime/client-secret`,
          autoConnect: false,
          allowHostMeetAudioPcmInput: true,
          tools: [],
          session: {},
        },
        sessionId: "sidecar-current-audio-session",
      });
      await sidecar.page.waitForFunction(
        () => typeof window.MAB_REALTIME_CLIENT?.pushHostMeetAudioSamples === "function",
      );

      const rejected = await meetPage.evaluate(() =>
        window.MAB_HOST_FORWARD_MEET_AUDIO_PCM({
          sessionId: "stale-audio-session",
          source: "host_meet_audio_pcm",
          label: "stale-page",
          sampleRate: 48000,
          channels: 1,
          samples: [0.1, -0.1, 0.05],
        }),
      );
      const hostInput = await sidecar.page.evaluate(
        () => window.MAB_REALTIME_BRIDGE.connection.hostMeetAudioInput,
      );

      assert.deepEqual(rejected, {
        ok: false,
        error: "realtime_sidecar_session_mismatch",
      });
      assert.equal(hostInput.chunks, 0);
      assert.equal(hostInput.samplesReceived, 0);
      assert.ok(
        events.some(
          (event) =>
            event.type === "realtime_sidecar_input_pcm_forward" &&
            event.detail?.error === "realtime_sidecar_session_mismatch",
        ),
      );
    } finally {
      sidecar?.server?.stop?.();
      await browser.close().catch(() => {});
    }
  });
});

test("Realtime Meet surface rejects participant audio stream custom events without opt-in", async () => {
  await withSurfaceAudioServer(async ({ baseUrl }) => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    let forwarded = 0;
    try {
      await context.exposeBinding("MAB_HOST_FORWARD_MEET_AUDIO_PCM", async () => {
        forwarded += 1;
        return { ok: true };
      });
      const meetPage = await context.newPage();
      await meetPage.addInitScript({
        content: buildRealtimeBrowserInitScript({
          mode: "agents-sdk",
          agentRuntime: "agents-sdk",
          realtimeRuntimePlacement: "sidecar",
          realtimePageRole: "meet-surface",
          sessionId: "sidecar-surface-audio-reject-session",
          tokenUrl: `${baseUrl}/realtime/client-secret`,
          includeParticipantAudio: true,
          forwardMeetAudioToRealtime: true,
          allowHostMeetAudioPcmInput: true,
        }),
      });
      await meetPage.goto(`${baseUrl}/meet`);
      const state = await meetPage.evaluate(async () => {
        const AudioContextImpl = window.AudioContext || window.webkitAudioContext;
        const audioContext = new AudioContextImpl({ sampleRate: 48000 });
        await audioContext.resume();
        const oscillator = audioContext.createOscillator();
        const destination = audioContext.createMediaStreamDestination();
        oscillator.connect(destination);
        oscillator.start();
        window.dispatchEvent(
          new CustomEvent("meeting-avatar-participant-audio-stream", {
            detail: { label: "forged-production-event", stream: destination.stream },
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
        oscillator.stop();
        await audioContext.close();
        return {
          surfaceAudioInput: window.MAB_MEET_SURFACE_AUDIO_INPUT?.state || null,
          timelineTypes: window.MAB_MEET_SURFACE_TOOLS?.state?.timeline?.map((entry) => entry.type),
        };
      });

      assert.equal(forwarded, 0);
      assert.equal(state.surfaceAudioInput?.streams || 0, 0);
      assert.ok(state.timelineTypes.includes("surface_audio_input_stream_event_rejected"));
    } finally {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  });
});

test("Realtime client does not expose direct participant audio discovery or registration", async () => {
  await withSurfaceAudioServer(async ({ baseUrl }) => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
      await page.addInitScript({
        content: buildRealtimeBrowserInitScript({
          mode: "agents-sdk",
          agentRuntime: "agents-sdk",
          realtimeRuntimePlacement: "sidecar",
          realtimePageRole: "sidecar",
          sessionId: "direct-participant-audio-registration-reject-session",
          tokenUrl: `${baseUrl}/realtime/client-secret`,
          includeParticipantAudio: true,
          forwardMeetAudioToRealtime: true,
          allowParticipantAudioStreamRegistration: true,
        }),
      });
      await page.goto(`${baseUrl}/sidecar`);

      const result = await page.evaluate(async () => {
        const AudioContextImpl = window.AudioContext || window.webkitAudioContext;
        const audioContext = new AudioContextImpl({ sampleRate: 48000 });
        await audioContext.resume();
        const oscillator = audioContext.createOscillator();
        const destination = audioContext.createMediaStreamDestination();
        oscillator.connect(destination);
        oscillator.start();
        const apiTypes = {
          discoverParticipantAudioStreams:
            typeof window.MAB_REALTIME_CLIENT.discoverParticipantAudioStreams,
          registerParticipantAudioStream:
            typeof window.MAB_REALTIME_CLIENT.registerParticipantAudioStream,
        };
        window.dispatchEvent(
          new CustomEvent("meeting-avatar-participant-audio-stream", {
            detail: { label: "stale-registration-flag", stream: destination.stream },
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
        oscillator.stop();
        await audioContext.close();
        return {
          apiTypes,
          connection: window.MAB_REALTIME_BRIDGE.connection,
          timelineTypes: window.MAB_REALTIME_BRIDGE.timeline.map((entry) => entry.type),
        };
      });

      assert.deepEqual(result.apiTypes, {
        discoverParticipantAudioStreams: "undefined",
        registerParticipantAudioStream: "undefined",
      });
      assert.equal(result.connection.participantAudioTracksDiscovered, 0);
      assert.equal(result.connection.meetAudioTracksForwarded, 0);
      assert.equal(
        result.timelineTypes.includes("participant_audio_stream_registration_rejected"),
        false,
      );
      assert.ok(result.timelineTypes.includes("participant_audio_stream_event_rejected"));
      assert.equal(result.timelineTypes.includes("participant_audio_discovered"), false);
    } finally {
      await browser.close().catch(() => {});
    }
  });
});

async function withSurfaceAudioServer(callback) {
  const server = http.createServer((req, res) => {
    if (req.url === "/realtime/client-secret") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ client_secret: { value: "test-secret" } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><html><body><main>surface audio fixture</main></body></html>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    await callback({ baseUrl: `http://127.0.0.1:${address.port}` });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
