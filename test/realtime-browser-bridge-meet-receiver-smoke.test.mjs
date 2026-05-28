import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";

import { installMeetLocalPlaybackMute } from "../packages/core/src/meeting/meet-local-playback-mute.ts";
import { buildRealtimeBrowserInitScript } from "../packages/core/src/realtime/realtime-browser-init-builder.ts";

async function installRealtimeHarness(page) {
  await page.setContent("<!doctype html><html><body></body></html>");
  await page.evaluate(() => {
    window.__MAB_FAKE_PEERS = [];
    window.__MAB_FAKE_AVATAR_BUS = {
      streams: [],
      tones: [],
      addStream(stream, options = {}) {
        this.streams.push({
          label: options.label || "",
          trackIds: stream?.getAudioTracks?.().map((track) => track.id) || [],
        });
        return { ok: true };
      },
      injectTone(options = {}) {
        this.tones.push(options);
        return { ok: true };
      },
      setSyntheticSpeech(active) {
        this.syntheticSpeechActive = Boolean(active);
        return { ok: true };
      },
    };
    window.MAB_AVATAR_AUDIO_BUS = window.__MAB_FAKE_AVATAR_BUS;

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
      mode: "webrtc",
      agentRuntime: "raw",
      autoConnect: false,
      tokenUrl: "https://example.test/token",
      sdpUrl: "https://example.test/sdp",
      forwardMeetAudioToRealtime: true,
      includeParticipantAudio: true,
      captureMeetAudioForTranscript: false,
      meetAudioEnergyStaleMs: 1000,
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
    const realtimePeer = window.__MAB_FAKE_PEERS.at(-1);
    const channel = realtimePeer.dataChannels.at(-1);
    channel.readyState = "open";
    channel.dispatchFakeEvent("open", {});
    channel.dispatchFakeEvent("message", {
      data: JSON.stringify({ type: "session.created" }),
    });

    if (scenario.emitSpeechAndResponse) {
      channel.dispatchFakeEvent("message", {
        data: JSON.stringify({ type: "input_audio_buffer.speech_started" }),
      });
      channel.dispatchFakeEvent("message", {
        data: JSON.stringify({ type: "response.created", response: { id: "resp_mock" } }),
      });
      channel.dispatchFakeEvent("message", {
        data: JSON.stringify({ type: "response.output_audio.delta", response_id: "resp_mock" }),
      });
      const remoteContext = new AudioContext();
      await remoteContext.resume();
      const remoteOscillator = remoteContext.createOscillator();
      const remoteDestination = remoteContext.createMediaStreamDestination();
      remoteOscillator.connect(remoteDestination);
      remoteOscillator.start();
      realtimePeer.ontrack?.({
        streams: [remoteDestination.stream],
        track: remoteDestination.stream.getAudioTracks()[0],
      });
      await wait(80);
      remoteOscillator.stop();
      await remoteContext.close();
    } else {
      window.MAB_REALTIME_CLIENT.injectCaptionTurn({
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
        syntheticSpeechActive: window.__MAB_FAKE_AVATAR_BUS.syntheticSpeechActive === true,
      },
      sentMessages: channel.sent,
    };
    oscillator.stop();
    await meetContext.close();
    return result;
  }, options);
}

test("mock Meet receiver track drives the production Realtime input/output gates", async () => {
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
    assert.equal(result.connection.currentRealtimeInputIsRoutingMix, true);
    assert.equal(result.connection.meetAudioEnergy.observed, true);
    assert.ok(result.connection.meetAudioEnergy.rms > 0.003);
    assert.ok(result.connection.meetAudioEnergy.peak > 0.01);
    assert.ok(result.protection.lastInputSpeechStartedAt);
    assert.ok(result.feedback.checks.responseEvents >= 1);
    assert.equal(result.connection.remoteAudioRoutedToAvatarBus, true);
    assert.equal(result.avatarBus.streams.length, 1);
    assert.equal(result.feedback.failureMatrix.audioInput.status, "ok");
    assert.equal(result.feedback.failureMatrix.modelTurn.status, "ok");
    assert.equal(result.feedback.failureMatrix.audioOutput.status, "ok");
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
    assert.equal(result.feedback.failureMatrix.audioInput.status, "ok");
    assert.equal(result.feedback.failureMatrix.modelTurn.status, "waiting");
    assert.equal(result.feedback.failureMatrix.modelTurn.reason, "meet_audio_no_energy_observed");
    assert.equal(result.feedback.failureMatrix.audioOutput.reason, "waiting_for_model_response");
  } finally {
    await browser.close();
  }
});
