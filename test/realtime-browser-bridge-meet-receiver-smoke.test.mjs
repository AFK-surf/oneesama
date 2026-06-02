import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { chromium } from "playwright";

import { installMeetLocalPlaybackMute } from "../packages/core/src/meeting/meet-local-playback-mute.ts";
import { buildRealtimeBrowserInitScript } from "../packages/core/src/realtime/realtime-browser-init-builder.ts";

async function installRealtimeHarness(page, harnessOptions = {}) {
  if (harnessOptions.url) {
    await page.route(`${harnessOptions.url}**`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><html><body></body></html>",
      });
    });
    await page.goto(harnessOptions.url);
  } else {
    await page.setContent("<!doctype html><html><body></body></html>");
  }
  await page.evaluate(() => {
    window.__MAB_FAKE_PEERS = [];
    window.MAB_AVATAR_AUDIO = { outputEnergy: {} };
    window.__MAB_FAKE_AVATAR_BUS = {
      streams: [],
      tones: [],
      addStream(stream, streamOptions = {}) {
        this.streams.push({
          label: streamOptions.label || "",
          trackIds: stream?.getAudioTracks?.().map((track) => track.id) || [],
        });
        window.MAB_AVATAR_AUDIO.outputEnergy = {
          observed: true,
          rms: 0.05,
          peak: 0.12,
          maxRms: 0.05,
          lastEnergyAt: new Date().toISOString(),
        };
        return { ok: true };
      },
      injectTone(toneOptions = {}) {
        this.tones.push(toneOptions);
        window.MAB_AVATAR_AUDIO.outputEnergy = {
          observed: true,
          rms: 0.05,
          peak: 0.12,
          maxRms: 0.05,
          lastEnergyAt: new Date().toISOString(),
        };
        return { ok: true };
      },
      setSyntheticSpeech(active) {
        this.syntheticSpeechActive = Boolean(active);
        return { ok: true };
      },
    };
    window.MAB_AVATAR_AUDIO_BUS = window.__MAB_FAKE_AVATAR_BUS;
    window.MAB_AVATAR_CONTROLLER = {
      updateState(input = {}) {
        this.lastUpdate = input;
        return { ok: true, mood: input.mood || "neutral", action: input.action || "idle" };
      },
      setExpression(mood = "neutral") {
        this.lastExpression = mood;
        return { ok: true, mood };
      },
      setAction(action = "idle") {
        this.lastAction = action;
        return { ok: true, action };
      },
    };

    class FakeRTCPeerConnection {
      constructor() {
        this.connectionState = "new";
        this.signalingState = "stable";
        this.senders = [];
        this.receivers = [];
        this.dataChannels = [];
        this.listeners = {};
        window.__MAB_FAKE_PEERS.push(this);
      }

      addTrack(track) {
        const sender = {
          track,
          async replaceTrack(nextTrack) {
            sender.track = nextTrack || null;
          },
          async getStats() {
            return new Map([
              [
                "outbound-audio",
                {
                  type: "outbound-rtp",
                  kind: "audio",
                  bytesSent: sender.track?.readyState === "live" ? 4096 : 0,
                  packetsSent: sender.track?.readyState === "live" ? 16 : 0,
                },
              ],
            ]);
          },
        };
        this.senders.push(sender);
        return sender;
      }

      addTransceiver(trackOrKind) {
        const track = typeof trackOrKind === "object" ? trackOrKind : null;
        const sender = track ? this.addTrack(track) : { track: null };
        return { sender };
      }

      getSenders() {
        return this.senders;
      }

      getReceivers() {
        return this.receivers;
      }

      addEventListener(type, listener) {
        (this.listeners[type] ||= []).push(listener);
      }

      removeEventListener(type, listener) {
        this.listeners[type] = (this.listeners[type] || []).filter((entry) => entry !== listener);
      }

      dispatchFakeEvent(type, event = {}) {
        for (const listener of this.listeners[type] || []) listener.call(this, event);
      }

      createDataChannel(label) {
        const channel = {
          label,
          readyState: "connecting",
          sent: [],
          listeners: {},
          send(payload) {
            this.sent.push(payload);
          },
          close() {
            this.readyState = "closed";
            this.dispatchFakeEvent("close", {});
          },
          addEventListener(type, listener) {
            (this.listeners[type] ||= []).push(listener);
          },
          dispatchFakeEvent(type, event = {}) {
            for (const listener of this.listeners[type] || []) listener.call(this, event);
          },
        };
        this.dataChannels.push(channel);
        return channel;
      }

      async createOffer() {
        return { type: "offer", sdp: "offer" };
      }

      async setLocalDescription(description) {
        this.localDescription = description;
      }

      async setRemoteDescription(description) {
        this.remoteDescription = description;
        this.connectionState = "connected";
        this.onconnectionstatechange?.({});
        this.dispatchFakeEvent("connectionstatechange", {});
      }

      close() {
        this.connectionState = "closed";
        this.signalingState = "closed";
        for (const channel of this.dataChannels) channel.close();
        this.dispatchFakeEvent("connectionstatechange", {});
      }
    }

    window.RTCPeerConnection = FakeRTCPeerConnection;
    window.fetch = async (url) => {
      const value = String(url);
      if (value.includes("/token")) {
        return new Response(JSON.stringify({ value: "ek_test" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("answer", {
        status: 200,
        headers: { "content-type": "application/sdp" },
      });
    };
  });

  await page.addScriptTag({
    content: buildRealtimeBrowserInitScript({
      mode: "webrtc-mock",
      autoConnect: false,
      tokenUrl: "https://example.test/token",
      forwardMeetAudioToRealtime: true,
      includeParticipantAudio: true,
      meetAudioInputSource: harnessOptions.meetAudioInputSource || "webrtc",
      allowRecappiReceiverFallback: harnessOptions.allowRecappiReceiverFallback === true,
      autoRespondToAvatarToolCalls: harnessOptions.autoRespondToAvatarToolCalls,
      captureMeetAudioForTranscript: false,
      meetAudioEnergyStaleMs: 1000,
      tools: harnessOptions.tools || [
        {
          type: "function",
          name: "update_avatar_state",
          description: "Update avatar state for the fixture.",
          parameters: { type: "object", properties: {}, required: [] },
        },
      ],
      ...(harnessOptions.meetAudioInputGain !== undefined
        ? { meetAudioInputGain: harnessOptions.meetAudioInputGain }
        : {}),
      ...(harnessOptions.allowGenericMediaElementAudioDiscovery !== undefined
        ? {
            allowGenericMediaElementAudioDiscovery:
              harnessOptions.allowGenericMediaElementAudioDiscovery,
          }
        : {}),
    }),
  });
}

async function runMockReceiverScenario(page, options = {}) {
  return page.evaluate(async (scenario) => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const meetContext = new AudioContext();
    await meetContext.resume();
    const oscillator = meetContext.createOscillator();
    oscillator.frequency.value = 880;
    const sourceGain = meetContext.createGain();
    sourceGain.gain.value = scenario.sourceGain;
    const meetDestination = meetContext.createMediaStreamDestination();
    oscillator.connect(sourceGain);
    sourceGain.connect(meetDestination);
    oscillator.start();

    const element = document.createElement("audio");
    element.autoplay = true;
    document.body.appendChild(element);
    await wait(80);
    const localPlaybackMuted = element.muted === true;
    if (scenario.mutedElementSilencesCapture && localPlaybackMuted) {
      sourceGain.gain.value = 0;
    }

    const [meetTrack] = meetDestination.stream.getAudioTracks();
    const meetPeer = new RTCPeerConnection();
    meetPeer.dispatchFakeEvent("track", {
      track: meetTrack,
      streams: [meetDestination.stream],
    });
    await wait(80);

    await window.MAB_REALTIME_CLIENT.connect();
    const dispatchRealtimeServerEvent = (detail) =>
      window.dispatchEvent(
        new CustomEvent("meeting-avatar-realtime-server-event", {
          detail,
        }),
      );

    dispatchRealtimeServerEvent({
      type: "session.created",
      session: { id: "sess_mock_receiver" },
    });

    if (scenario.emitSpeechAndResponse) {
      dispatchRealtimeServerEvent({ type: "input_audio_buffer.speech_started" });
      dispatchRealtimeServerEvent({ type: "response.created", response: { id: "resp_mock" } });
      dispatchRealtimeServerEvent({
        type: "response.output_audio.delta",
        response_id: "resp_mock",
      });
    } else {
      window.MAB_REALTIME_CLIENT.observeCaptionSpeakerSignal({
        speaker: "Peng Xiao",
        text: "你好你好你好",
        streamId: "mock-caption-stream",
      });
    }

    await wait(450);
    const forwarded = window.MAB_REALTIME_BRIDGE.timeline.filter(
      (entry) => entry.type === "meet_audio_track_forwarded",
    );
    const result = {
      localPlaybackMuted,
      sourceGainValue: sourceGain.gain.value,
      forwardedSources: forwarded.map((entry) => entry.detail.source || ""),
      connection: window.MAB_REALTIME_BRIDGE.connection,
      feedback: window.MAB_REALTIME_BRIDGE.feedback,
      protection: window.MAB_REALTIME_BRIDGE.protection,
      avatarBus: {
        streams: window.__MAB_FAKE_AVATAR_BUS.streams,
        tones: window.__MAB_FAKE_AVATAR_BUS.tones,
        syntheticSpeechActive: window.__MAB_FAKE_AVATAR_BUS.syntheticSpeechActive === true,
      },
      sentMessages: window.MAB_REALTIME_BRIDGE.connection.sentDataChannelMessages,
    };
    oscillator.stop();
    await meetContext.close();
    return result;
  }, options);
}

test("mock Meet receiver track drives the production Realtime input/output routes", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await installRealtimeHarness(page);
    const result = await runMockReceiverScenario(page, {
      sourceGain: 0.03,
      mutedElementSilencesCapture: false,
      emitSpeechAndResponse: true,
    });

    assert.equal(result.localPlaybackMuted, false);
    assert.deepEqual(result.forwardedSources, ["pc.track"]);
    assert.equal(result.connection.participantAudioTracksDiscovered, 0);
    assert.equal(result.connection.meetAudioTracksForwarded, 1);
    assert.equal(result.connection.pendingMeetAudioTrackCount, 0);
    assert.equal(result.connection.currentRealtimeInputSource, "meet_audio_mix");
    assert.equal(result.connection.openaiSessionId, "sess_mock_receiver");
    assert.equal(result.connection.currentRealtimeInputIsRoutingMix, true);
    assert.equal(result.connection.meetAudioEnergy.observed, true);
    assert.ok(result.connection.meetAudioEnergy.rms > 0.003);
    assert.ok(result.connection.meetAudioEnergy.peak > 0.01);
    assert.ok(result.protection.lastInputSpeechStartedAt);
    assert.ok(result.feedback.checks.responseEvents >= 1);
    assert.equal(result.connection.remoteAudioRoutedToAvatarBus, true);
    assert.equal(result.avatarBus.tones.length, 1);
    assert.equal(result.feedback.failureMatrix.audioInput.status, "ok");
    assert.equal(result.feedback.failureMatrix.modelTurn.status, "ok");
    assert.equal(result.feedback.failureMatrix.audioOutput.status, "ok");
  } finally {
    await browser.close();
  }
});

test("Meet receiver routing excludes muted and ended stale tracks from the input mix", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await installRealtimeHarness(page);
    const result = await page.evaluate(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const createToneTrack = async (gainValue) => {
        const context = new AudioContext();
        await context.resume();
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        gain.gain.value = gainValue;
        const destination = context.createMediaStreamDestination();
        oscillator.connect(gain);
        gain.connect(destination);
        oscillator.start();
        return { context, oscillator, track: destination.stream.getAudioTracks()[0] };
      };

      const staleTone = await createToneTrack(0.03);
      let staleMuted = true;
      Object.defineProperty(staleTone.track, "muted", {
        configurable: true,
        get: () => staleMuted,
      });

      const endedTone = await createToneTrack(0.03);
      endedTone.track.stop();

      const liveTone = await createToneTrack(0.03);
      const meetPeer = new RTCPeerConnection();
      meetPeer.dispatchFakeEvent("track", {
        track: staleTone.track,
        streams: [new MediaStream([staleTone.track])],
      });
      meetPeer.dispatchFakeEvent("track", {
        track: endedTone.track,
        streams: [new MediaStream([endedTone.track])],
      });
      meetPeer.dispatchFakeEvent("track", {
        track: liveTone.track,
        streams: [new MediaStream([liveTone.track])],
      });

      await window.MAB_REALTIME_CLIENT.connect();
      await wait(450);

      const forwarded = window.MAB_REALTIME_BRIDGE.timeline.filter(
        (entry) => entry.type === "meet_audio_track_forwarded",
      );
      const skipped = window.MAB_REALTIME_BRIDGE.timeline.filter(
        (entry) =>
          entry.type === "meet_audio_track_skipped" && entry.detail.reason === "track_ended",
      );
      const connected = window.MAB_REALTIME_BRIDGE.timeline.filter(
        (entry) => entry.type === "meet_audio_source_connected",
      );
      const scenarioResult = {
        staleTrackId: staleTone.track.id,
        endedTrackId: endedTone.track.id,
        liveTrackId: liveTone.track.id,
        forwardedSources: forwarded.map((entry) => ({
          source: entry.detail.source || "",
          trackId: entry.detail.trackId || "",
        })),
        skippedEndedTrackIds: skipped.map((entry) => entry.detail.trackId || ""),
        connectedTrackIds: connected.map((entry) => entry.detail.trackId || ""),
        connection: window.MAB_REALTIME_BRIDGE.connection,
      };

      staleMuted = false;
      staleTone.oscillator.stop();
      liveTone.oscillator.stop();
      await staleTone.context.close();
      await endedTone.context.close();
      await liveTone.context.close();
      return scenarioResult;
    });

    assert.deepEqual(result.forwardedSources, [
      { source: "pc.track", trackId: result.staleTrackId },
      { source: "pc.track", trackId: result.liveTrackId },
    ]);
    assert.deepEqual(result.skippedEndedTrackIds, [result.endedTrackId]);
    assert.deepEqual(result.connectedTrackIds, [result.liveTrackId]);
    assert.equal(result.connection.meetAudioTracksForwarded, 2);
    assert.equal(result.connection.meetAudioSourcesActive, 1);
    assert.equal(result.connection.meetAudioSourcesUnmuted, 1);
    const staleState = result.connection.meetAudioTrackStates.find(
      (entry) => entry.trackId === result.staleTrackId,
    );
    const liveState = result.connection.meetAudioTrackStates.find(
      (entry) => entry.trackId === result.liveTrackId,
    );
    assert.equal(staleState?.muted, true);
    assert.equal(staleState?.connected, false);
    assert.equal(liveState?.connected, true);
    assert.equal(result.connection.meetAudioEnergy.observed, true);
  } finally {
    await browser.close();
  }
});

test("Recappi process audio input feeds the routing mix without RTC tracks", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await installRealtimeHarness(page, { meetAudioInputSource: "recappi_process_audio" });
    const result = await page.evaluate(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      await window.MAB_REALTIME_CLIENT.connect();
      const sampleRate = 48000;
      const channels = 2;
      for (let chunk = 0; chunk < 8; chunk += 1) {
        const frames = 4096;
        const samples = [];
        for (let frame = 0; frame < frames; frame += 1) {
          const value =
            Math.sin(((chunk * frames + frame) / sampleRate) * Math.PI * 2 * 660) * 0.03;
          samples.push(value, value);
        }
        window.MAB_REALTIME_CLIENT.pushRecappiAudioSamples({
          source: "recappi_process_audio",
          sampleRate,
          channels,
          samples,
        });
      }
      await wait(750);
      const forwarded = window.MAB_REALTIME_BRIDGE.timeline.filter(
        (entry) => entry.type === "meet_audio_track_forwarded",
      );
      return {
        forwardedSources: forwarded.map((entry) => entry.detail.source || ""),
        connection: window.MAB_REALTIME_BRIDGE.connection,
        feedback: window.MAB_REALTIME_BRIDGE.feedback,
      };
    });

    assert.deepEqual(result.forwardedSources, []);
    assert.equal(result.connection.recappiAudioInput.connected, true);
    assert.equal(result.connection.recappiAudioInput.source, "recappi_process_audio");
    assert.equal(result.connection.currentRealtimeInputSource, "recappi_process_audio_tap");
    assert.equal(result.connection.currentRealtimeInputIsRoutingMix, true);
    assert.equal(result.connection.meetAudioTracksForwarded, 1);
    assert.equal(result.connection.meetAudioSourcesActive, 1);
    assert.equal(result.connection.meetAudioSourcesUnmuted, 1);
    assert.equal(result.connection.meetAudioEnergy.observed, true);
    assert.equal(result.feedback.failureMatrix.audioInput.status, "ok");
    assert.equal(result.connection.meetAudioInputGain, 1);
    assert.equal(result.connection.recappiAudioInput.adaptiveGain, 1);
    assert.ok(result.connection.recappiAudioInput.lastRawRms > 0);
  } finally {
    await browser.close();
  }
});

test("Recappi process audio skips Meet receiver tracks by default", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await installRealtimeHarness(page, { meetAudioInputSource: "recappi_process_audio" });
    const result = await runMockReceiverScenario(page, {
      sourceGain: 0.03,
      mutedElementSilencesCapture: false,
      emitSpeechAndResponse: false,
    });

    assert.deepEqual(result.forwardedSources, []);
    assert.equal(result.connection.recappiAudioInput.connected, false);
    assert.equal("recappiReceiverFallbackActive" in result.connection, false);
    assert.equal(result.connection.currentRealtimeInputSource, "silent_placeholder");
    assert.equal(result.connection.meetAudioTracksForwarded, 0);
    assert.equal(result.feedback.failureMatrix.audioInput.status, "waiting");
  } finally {
    await browser.close();
  }
});

test("Recappi process audio ignores legacy Meet receiver fallback flag", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await installRealtimeHarness(page, {
      meetAudioInputSource: "recappi_process_audio",
      allowRecappiReceiverFallback: true,
    });
    const result = await runMockReceiverScenario(page, {
      sourceGain: 0.03,
      mutedElementSilencesCapture: false,
      emitSpeechAndResponse: false,
    });

    assert.deepEqual(result.forwardedSources, []);
    assert.equal(result.connection.recappiAudioInput.connected, false);
    assert.equal("recappiReceiverFallbackActive" in result.connection, false);
    assert.equal(result.connection.currentRealtimeInputSource, "silent_placeholder");
    assert.equal(result.connection.meetAudioTracksForwarded, 0);
    assert.equal(result.feedback.failureMatrix.audioInput.status, "waiting");
  } finally {
    await browser.close();
  }
});

test("Realtime marks missing expected audio input as blocked after startup grace", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await installRealtimeHarness(page, { meetAudioInputSource: "recappi_process_audio" });
    const result = await page.evaluate(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      await window.MAB_REALTIME_CLIENT.connect();
      window.MAB_REALTIME_BRIDGE.connection.lastRealtimeInputReplaceAt = new Date(
        Date.now() - 20_000,
      ).toISOString();
      window.MAB_REALTIME_BRIDGE.connection.currentRealtimeInputSource = "meet_audio_mix";
      window.MAB_REALTIME_BRIDGE.connection.currentRealtimeInputIsRoutingMix = true;
      window.MAB_REALTIME_CLIENT.observeCaptionSpeakerSignal({
        speaker: "Peng Xiao",
        text: "你好你好",
        streamId: "missing-audio-caption",
      });
      await wait(50);
      const feedback = window.MAB_REALTIME_BRIDGE.feedback;
      return { feedback };
    });

    assert.equal(result.feedback.status, "blocked");
    assert.equal(result.feedback.failureMatrix.audioInput.status, "blocked");
    assert.equal(result.feedback.failureMatrix.audioInput.reason, "silent_input_placeholder_only");
    assert.equal(
      result.feedback.failureMatrix.audioInput.signals.inputAudioMissingMs >= 15_000,
      true,
    );
  } finally {
    await browser.close();
  }
});

test("Recappi process audio keeps Meet receiver diagnostic-only before tap connects", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await installRealtimeHarness(page, {
      meetAudioInputSource: "recappi_process_audio",
      allowRecappiReceiverFallback: true,
    });
    const result = await page.evaluate(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const meetContext = new AudioContext();
      await meetContext.resume();
      const oscillator = meetContext.createOscillator();
      oscillator.frequency.value = 660;
      const sourceGain = meetContext.createGain();
      sourceGain.gain.value = 0.03;
      const meetDestination = meetContext.createMediaStreamDestination();
      oscillator.connect(sourceGain);
      sourceGain.connect(meetDestination);
      oscillator.start();

      const [meetTrack] = meetDestination.stream.getAudioTracks();
      const meetPeer = new RTCPeerConnection();
      meetPeer.dispatchFakeEvent("track", {
        track: meetTrack,
        streams: [meetDestination.stream],
      });
      await window.MAB_REALTIME_CLIENT.connect();
      await wait(250);
      const fallback = {
        statePresent: "recappiReceiverFallbackActive" in window.MAB_REALTIME_BRIDGE.connection,
        gain: window.MAB_REALTIME_BRIDGE.connection.meetAudioInputGain,
        trackStates: window.MAB_REALTIME_BRIDGE.connection.meetAudioTrackStates,
      };

      const samples = [];
      for (let frame = 0; frame < 4096; frame += 1) {
        const value = Math.sin((frame / 48000) * Math.PI * 2 * 440) * 0.05;
        samples.push(value, value);
      }
      const accepted = window.MAB_REALTIME_CLIENT.pushRecappiAudioSamples({
        source: "recappi_process_audio",
        sampleRate: 48000,
        channels: 2,
        samples,
      });
      await wait(300);
      const disconnectEvents = window.MAB_REALTIME_BRIDGE.timeline.filter(
        (entry) => entry.type === "meet_audio_receiver_diagnostic_disconnected",
      );
      oscillator.stop();
      meetTrack.stop();
      await meetContext.close();
      return {
        accepted,
        fallback,
        connection: window.MAB_REALTIME_BRIDGE.connection,
        disconnectEvents,
      };
    });

    assert.equal(result.fallback.statePresent, false);
    assert.equal(result.fallback.gain, 1);
    assert.equal(result.accepted.ok, true);
    assert.equal(result.connection.recappiAudioInput.connected, true);
    assert.equal("recappiReceiverFallbackActive" in result.connection, false);
    assert.equal(result.connection.currentRealtimeInputSource, "recappi_process_audio_tap");
    assert.equal(result.connection.meetAudioInputGain, 1);
    assert.equal(result.disconnectEvents.length, 0);
    const fallbackTrack = result.connection.meetAudioTrackStates.find(
      (entry) => entry.source === "pc.track",
    );
    assert.equal(fallbackTrack, undefined);
  } finally {
    await browser.close();
  }
});

test("Recappi global audio fallback is rejected for Realtime input", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await installRealtimeHarness(page, { meetAudioInputSource: "recappi_process_audio" });
    const result = await page.evaluate(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      await window.MAB_REALTIME_CLIENT.connect();
      const accepted = window.MAB_REALTIME_CLIENT.pushRecappiAudioSamples({
        source: "recappi_global_audio",
        sampleRate: 48000,
        channels: 2,
        samples: [0.02, 0.02, -0.02, -0.02],
      });
      await wait(100);
      return {
        accepted,
        recappi: { ...window.MAB_REALTIME_BRIDGE.connection.recappiAudioInput },
        trackStates: window.MAB_REALTIME_BRIDGE.connection.meetAudioTrackStates,
      };
    });

    assert.equal(result.accepted.ok, false);
    assert.equal(result.accepted.error, "recappi_global_audio_rejected");
    assert.equal(result.recappi.connected, false);
    assert.equal(result.recappi.source, "");
    const recappiTrackStates = result.trackStates.filter((entry) =>
      ["recappi_process_audio", "recappi_global_audio"].includes(entry.source),
    );
    assert.equal(recappiTrackStates.length, 0);
  } finally {
    await browser.close();
  }
});

test("avatar visual tool output requests a follow-up response by default", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await installRealtimeHarness(page);
    const result = await page.evaluate(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      await window.MAB_REALTIME_CLIENT.connect();
      window.dispatchEvent(
        new CustomEvent("meeting-avatar-realtime-server-event", {
          detail: {
            type: "response.output_item.done",
            item: {
              type: "function_call",
              name: "update_avatar_state",
              call_id: "call_avatar_visual",
              arguments: JSON.stringify({ mood: "happy", action: "wave" }),
            },
          },
        }),
      );
      await wait(100);
      return {
        sent: window.MAB_REALTIME_BRIDGE.connection.sentDataChannelMessages.map((entry) =>
          typeof entry.payload === "string" ? JSON.parse(entry.payload) : entry.payload,
        ),
        decisions: window.MAB_REALTIME_BRIDGE.turnPolicy.decisions,
      };
    });

    assert.equal(
      result.sent.some((event) => event.type === "conversation.item.create"),
      true,
    );
    assert.equal(
      result.sent.some((event) => event.type === "response.create"),
      true,
    );
    assert.equal(result.decisions.at(-1).scope, "function_tool");
    assert.equal(result.decisions.at(-1).name, "update_avatar_state");
    assert.equal(result.decisions.at(-1).autoRespond, true);
  } finally {
    await browser.close();
  }
});

test("avatar visual tool follow-up can be explicitly disabled", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await installRealtimeHarness(page, { autoRespondToAvatarToolCalls: false });
    const result = await page.evaluate(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      await window.MAB_REALTIME_CLIENT.connect();
      window.dispatchEvent(
        new CustomEvent("meeting-avatar-realtime-server-event", {
          detail: {
            type: "response.output_item.done",
            item: {
              type: "function_call",
              name: "update_avatar_state",
              call_id: "call_avatar_visual_disabled",
              arguments: JSON.stringify({ mood: "happy", action: "wave" }),
            },
          },
        }),
      );
      await wait(100);
      return {
        sent: window.MAB_REALTIME_BRIDGE.connection.sentDataChannelMessages.map((entry) =>
          typeof entry.payload === "string" ? JSON.parse(entry.payload) : entry.payload,
        ),
        decisions: window.MAB_REALTIME_BRIDGE.turnPolicy.decisions,
      };
    });

    assert.equal(
      result.sent.some((event) => event.type === "conversation.item.create"),
      true,
    );
    assert.equal(
      result.sent.some((event) => event.type === "response.create"),
      false,
    );
    assert.equal(result.decisions.at(-1).autoRespond, false);
  } finally {
    await browser.close();
  }
});

test("Recappi process audio uses source-specific gain instead of Meet receiver amplification", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await installRealtimeHarness(page, { meetAudioInputSource: "recappi_process_audio" });
    const result = await page.evaluate(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      await window.MAB_REALTIME_CLIENT.connect();
      window.MAB_REALTIME_CLIENT.pushRecappiAudioSamples({
        source: "recappi_process_audio",
        sampleRate: 48000,
        channels: 2,
        samples: [0.02, 0.02, -0.02, -0.02],
      });
      await wait(80);
      return {
        currentSource: window.MAB_REALTIME_BRIDGE.connection.currentRealtimeInputSource,
        meetAudioInputGain: window.MAB_REALTIME_BRIDGE.connection.meetAudioInputGain,
      };
    });

    assert.equal(result.currentSource, "recappi_process_audio_tap");
    assert.equal(result.meetAudioInputGain, 1);
    assert.notEqual(result.meetAudioInputGain, 48);
  } finally {
    await browser.close();
  }
});

test("Recappi process audio adaptively boosts low true-room input levels", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await installRealtimeHarness(page, { meetAudioInputSource: "recappi_process_audio" });
    const result = await page.evaluate(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      await window.MAB_REALTIME_CLIENT.connect();
      const samples = [];
      for (let frame = 0; frame < 4096; frame += 1) {
        const value = Math.sin((frame / 48000) * Math.PI * 2 * 440) * 0.001;
        samples.push(value, value);
      }
      const accepted = window.MAB_REALTIME_CLIENT.pushRecappiAudioSamples({
        source: "recappi_process_audio",
        sampleRate: 48000,
        channels: 2,
        samples,
      });
      await wait(300);
      const gainEvents = window.MAB_REALTIME_BRIDGE.timeline.filter(
        (entry) =>
          entry.type === "meet_audio_input_gain_updated" &&
          entry.detail.reason === "recappi-process-audio-adaptive-gain",
      );
      return {
        accepted,
        gainEvents,
        connection: window.MAB_REALTIME_BRIDGE.connection,
      };
    });

    assert.equal(result.accepted.ok, true);
    assert.equal(result.connection.currentRealtimeInputSource, "recappi_process_audio_tap");
    assert.equal(result.connection.recappiAudioInput.connected, true);
    assert.equal(result.connection.recappiAudioInput.lastRawRms < 0.01, true);
    assert.equal(result.connection.recappiAudioInput.lastRawPeak < 0.01, true);
    assert.equal(result.connection.recappiAudioInput.adaptiveGain > 1, true);
    assert.equal(
      result.connection.meetAudioInputGain,
      result.connection.recappiAudioInput.adaptiveGain,
    );
    assert.equal(result.gainEvents.length >= 1, true);
  } finally {
    await browser.close();
  }
});

test("Recappi process audio respects explicit input gain overrides", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await installRealtimeHarness(page, {
      meetAudioInputSource: "recappi_process_audio",
      meetAudioInputGain: 3,
    });
    const result = await page.evaluate(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      await window.MAB_REALTIME_CLIENT.connect();
      const samples = [];
      for (let frame = 0; frame < 4096; frame += 1) {
        const value = Math.sin((frame / 48000) * Math.PI * 2 * 440) * 0.001;
        samples.push(value, value);
      }
      window.MAB_REALTIME_CLIENT.pushRecappiAudioSamples({
        source: "recappi_process_audio",
        sampleRate: 48000,
        channels: 2,
        samples,
      });
      await wait(150);
      return {
        connection: window.MAB_REALTIME_BRIDGE.connection,
      };
    });

    assert.equal(result.connection.recappiAudioInput.connected, true);
    assert.equal(result.connection.meetAudioInputGain, 3);
    assert.equal(result.connection.recappiAudioInput.adaptiveGain, 3);
  } finally {
    await browser.close();
  }
});

test("Recappi process audio forwards low-level audio to Realtime input", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await installRealtimeHarness(page, { meetAudioInputSource: "recappi_process_audio" });
    const result = await page.evaluate(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      await window.MAB_REALTIME_CLIENT.connect();
      const sampleRate = 48000;
      const channels = 2;
      const quiet = [];
      const speech = [];
      for (let frame = 0; frame < 4096; frame += 1) {
        const phase = (frame / sampleRate) * Math.PI * 2 * 440;
        const quietValue = Math.sin(phase) * 0.00001;
        const speechValue = Math.sin(phase) * 0.05;
        quiet.push(quietValue, quietValue);
        speech.push(speechValue, speechValue);
      }

      let quietAccepted = null;
      for (let index = 0; index < 8; index += 1) {
        quietAccepted = window.MAB_REALTIME_CLIENT.pushRecappiAudioSamples({
          source: "recappi_process_audio",
          sampleRate,
          channels,
          samples: quiet,
        });
      }
      await wait(250);
      const afterNoise = {
        recappi: { ...window.MAB_REALTIME_BRIDGE.connection.recappiAudioInput },
        energy: { ...window.MAB_REALTIME_BRIDGE.connection.meetAudioEnergy },
      };

      let accepted = null;
      for (let index = 0; index < 8; index += 1) {
        accepted = window.MAB_REALTIME_CLIENT.pushRecappiAudioSamples({
          source: "recappi_process_audio",
          sampleRate,
          channels,
          samples: speech,
        });
      }
      await wait(750);
      return {
        quietAccepted,
        accepted,
        afterNoise,
        connection: window.MAB_REALTIME_BRIDGE.connection,
      };
    });

    assert.equal(result.quietAccepted.ok, true);
    assert.equal(result.quietAccepted.suppressed, undefined);
    assert.ok(result.afterNoise.recappi.samplesQueued > 0);
    assert.equal(result.accepted.ok, true);
    assert.equal(result.accepted.suppressed, undefined);
    assert.equal(result.connection.recappiAudioInput.noiseSuppressedChunks, 0);
    assert.equal(result.connection.currentRealtimeInputSource, "recappi_process_audio_tap");
    assert.equal(result.connection.meetAudioInputGain, 1);
    assert.equal(result.connection.meetAudioEnergy.observed, true);
  } finally {
    await browser.close();
  }
});

test("Recappi process audio forwards overlapping output without local input suppression", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await installRealtimeHarness(page, { meetAudioInputSource: "recappi_process_audio" });
    const result = await page.evaluate(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      await window.MAB_REALTIME_CLIENT.connect();
      const sampleRate = 48000;
      const channels = 2;
      const samples = [];
      for (let frame = 0; frame < 4096; frame += 1) {
        const value = Math.sin((frame / sampleRate) * Math.PI * 2 * 660) * 0.05;
        samples.push(value, value);
      }
      const firstPush = window.MAB_REALTIME_CLIENT.pushRecappiAudioSamples({
        source: "recappi_process_audio",
        sampleRate,
        channels,
        samples,
      });
      await wait(150);
      const duringOutput = {
        inputIsRoutingMix: window.MAB_REALTIME_BRIDGE.connection.currentRealtimeInputIsRoutingMix,
        recappi: { ...window.MAB_REALTIME_BRIDGE.connection.recappiAudioInput },
        energy: { ...window.MAB_REALTIME_BRIDGE.connection.meetAudioEnergy },
      };
      let accepted = null;
      for (let chunk = 0; chunk < 8; chunk += 1) {
        accepted = window.MAB_REALTIME_CLIENT.pushRecappiAudioSamples({
          source: "recappi_process_audio",
          sampleRate,
          channels,
          samples,
        });
      }
      await wait(750);
      return {
        firstPush,
        accepted,
        duringOutput,
        connection: window.MAB_REALTIME_BRIDGE.connection,
      };
    });

    assert.equal(result.firstPush.ok, true);
    assert.equal(result.firstPush.suppressed, undefined);
    assert.equal(result.duringOutput.inputIsRoutingMix, true);
    assert.ok(result.duringOutput.recappi.samplesQueued > 0);
    assert.equal(result.accepted.ok, true);
    assert.equal(result.accepted.suppressed, undefined);
    assert.equal(result.connection.currentRealtimeInputSource, "recappi_process_audio_tap");
    assert.equal(result.connection.meetAudioEnergy.observed, true);
  } finally {
    await browser.close();
  }
});

test("mock Meet receiver smoke fails loudly when playback mute silences capture", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await installRealtimeHarness(page);
    await installMeetLocalPlaybackMute(page, null, true);
    const result = await runMockReceiverScenario(page, {
      sourceGain: 0.03,
      mutedElementSilencesCapture: true,
      emitSpeechAndResponse: false,
    });

    assert.equal(result.localPlaybackMuted, true);
    assert.equal(result.sourceGainValue, 0);
    assert.deepEqual(result.forwardedSources, ["pc.track"]);
    assert.equal(result.connection.meetAudioTracksForwarded, 1);
    assert.equal(result.connection.currentRealtimeInputSource, "meet_audio_mix");
    assert.equal(result.connection.meetAudioEnergy.observed, false);
    assert.equal(result.connection.captionTurnsObserved, 1);
    assert.equal(result.feedback.checks.responseEvents, 0);
    assert.equal(result.feedback.status, "waiting_for_turn");
    assert.equal(result.feedback.audioInputPolicy.ready, false);
    assert.equal(result.feedback.runtimeState.audioInputReady, false);
    assert.equal(result.feedback.failureMatrix.audioInput.status, "waiting");
    assert.equal(result.feedback.failureMatrix.audioInput.reason, "meet_audio_no_energy_observed");
    assert.equal(result.feedback.failureMatrix.modelTurn.status, "waiting");
    assert.equal(result.feedback.failureMatrix.modelTurn.reason, "meet_audio_no_energy_observed");
    assert.equal(result.feedback.failureMatrix.audioOutput.status, "ok");
  } finally {
    await browser.close();
  }
});

test("Google Meet pages ignore generic media element audio and keep receiver hook input", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await installRealtimeHarness(page, {
      url: "https://meet.google.com/fga-dyac-smw",
      allowGenericMediaElementAudioDiscovery: true,
    });
    const result = await page.evaluate(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const genericContext = new AudioContext();
      await genericContext.resume();
      const genericOscillator = genericContext.createOscillator();
      const genericDestination = genericContext.createMediaStreamDestination();
      genericOscillator.connect(genericDestination);
      genericOscillator.start();
      const genericElement = document.createElement("audio");
      genericElement.srcObject = genericDestination.stream;
      document.body.appendChild(genericElement);
      await wait(1200);

      const meetContext = new AudioContext();
      await meetContext.resume();
      const meetOscillator = meetContext.createOscillator();
      const meetGain = meetContext.createGain();
      meetGain.gain.value = 0.03;
      const meetDestination = meetContext.createMediaStreamDestination();
      meetOscillator.connect(meetGain);
      meetGain.connect(meetDestination);
      meetOscillator.start();
      const [meetTrack] = meetDestination.stream.getAudioTracks();
      const meetPeer = new RTCPeerConnection();
      meetPeer.dispatchFakeEvent("track", {
        track: meetTrack,
        streams: [meetDestination.stream],
      });
      await wait(80);
      await window.MAB_REALTIME_CLIENT.connect();
      await wait(450);

      const forwarded = window.MAB_REALTIME_BRIDGE.timeline.filter(
        (entry) => entry.type === "meet_audio_track_forwarded",
      );
      const skipped = window.MAB_REALTIME_BRIDGE.timeline
        .filter(
          (entry) =>
            entry.type === "participant_audio_element_discovery_skipped" ||
            entry.type === "meet_media_element_audio_discovery_skipped",
        )
        .map((entry) => entry.type);
      const scenarioResult = {
        forwardedSources: forwarded.map((entry) => entry.detail.source || ""),
        skipped,
        connection: window.MAB_REALTIME_BRIDGE.connection,
      };
      genericOscillator.stop();
      meetOscillator.stop();
      await genericContext.close();
      await meetContext.close();
      return scenarioResult;
    });

    assert.deepEqual(result.forwardedSources, ["pc.track"]);
    assert.ok(result.skipped.includes("participant_audio_element_discovery_skipped"));
    assert.ok(result.skipped.includes("meet_media_element_audio_discovery_skipped"));
    assert.equal(result.connection.participantAudioTracksDiscovered, 0);
    assert.equal(result.connection.participantAudioElementDiscoverySkipped, true);
    assert.equal(result.connection.meetMediaElementDiscoverySkipped, true);
    assert.equal(result.connection.meetMediaElementsScanned, 1);
    assert.equal(result.connection.meetMediaElementAudioTracksAdded, 0);
    assert.equal(result.connection.meetAudioTracksForwarded, 1);
    assert.equal(result.connection.currentRealtimeInputSource, "meet_audio_mix");
    assert.equal(result.connection.meetAudioEnergy.observed, true);
  } finally {
    await browser.close();
  }
});

test("Google Meet peer hook attaches avatar bus to null-track outbound audio senders discovered by stats", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await installRealtimeHarness(page, {
      url: "https://meet.google.com/fga-dyac-smw",
    });
    const result = await page.evaluate(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const audioContext = new AudioContext();
      await audioContext.resume();
      const destination = audioContext.createMediaStreamDestination();
      const [avatarTrack] = destination.stream.getAudioTracks();
      window.MAB_AVATAR_AUDIO_BUS.track = avatarTrack;

      const meetPeer = new RTCPeerConnection();
      const sender = {
        track: null,
        async replaceTrack(nextTrack) {
          this.track = nextTrack || null;
        },
        async getStats() {
          return new Map([
            [
              "outbound-audio",
              {
                type: "outbound-rtp",
                kind: "audio",
                bytesSent: this.track?.readyState === "live" ? 4096 : 0,
                packetsSent: this.track?.readyState === "live" ? 16 : 0,
              },
            ],
          ]);
        },
      };
      meetPeer.senders.push(sender);
      await wait(1800);

      const connection = window.MAB_REALTIME_BRIDGE.connection;
      const timelineTypes = window.MAB_REALTIME_BRIDGE.timeline.map((entry) => entry.type);
      const senderTrackId = sender.track?.id || "";
      await audioContext.close();
      return {
        avatarTrackId: avatarTrack.id,
        senderTrackId,
        connection,
        timelineTypes,
      };
    });

    assert.notEqual(result.senderTrackId, result.avatarTrackId);
    assert.equal(result.connection.primaryMeetAudioSenderUsingAvatarBus, true);
    assert.equal(result.connection.primaryMeetAudioSenderStats?.supported, true);
    assert.equal(result.connection.primaryMeetAudioSenderStats?.trackReadyState, "live");
    assert.ok(result.connection.primaryMeetAudioSenderStats?.bytesSent > 0);
    assert.ok(result.timelineTypes.includes("primary_meet_audio_sender_selected"));
    assert.ok(result.timelineTypes.includes("primary_meet_audio_sender_attached"));
  } finally {
    await browser.close();
  }
});
