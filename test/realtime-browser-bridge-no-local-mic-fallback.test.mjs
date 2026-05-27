import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";

import { buildRealtimeBrowserInitScript } from "../packages/core/src/realtime/realtime-browser-init-builder.ts";

test("Realtime bridge does not route browser local mic into the Meet audio mix", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.evaluate(() => {
      window.__MAB_FAKE_PEERS = [];
      window.__MAB_GET_USER_MEDIA_CALLS = 0;
      window.__MAB_AVATAR_BUS_STREAMS = [];
      window.__MAB_AVATAR_AUDIO_CONTEXT = new AudioContext();
      window.__MAB_AVATAR_AUDIO_DESTINATION =
        window.__MAB_AVATAR_AUDIO_CONTEXT.createMediaStreamDestination();
      window.__MAB_AVATAR_AUDIO_TRACK =
        window.__MAB_AVATAR_AUDIO_DESTINATION.stream.getAudioTracks()[0];
      window.MAB_AVATAR_AUDIO_BUS = {
        track: window.__MAB_AVATAR_AUDIO_TRACK,
        addStream(stream, options = {}) {
          window.__MAB_AVATAR_BUS_STREAMS.push({
            streamId: stream?.id || "",
            trackIds: stream?.getAudioTracks?.().map((track) => track.id) || [],
            label: options.label || "",
          });
          return { ok: true };
        },
      };
      class FakeRTCPeerConnection {
        constructor() {
          this.connectionState = "new";
          this.senders = [];
          this.listeners = {};
          window.__MAB_FAKE_PEERS.push(this);
        }

        addTrack(track) {
          const sender = {
            track,
            replaceTrack(nextTrack) {
              sender.track = nextTrack;
              return Promise.resolve();
            },
          };
          this.senders.push(sender);
          return sender;
        }

        getSenders() {
          return this.senders;
        }

        addEventListener(type, listener) {
          (this.listeners[type] ||= []).push(listener);
        }

        dispatchFakeEvent(type, event = {}) {
          for (const listener of this.listeners[type] || []) listener.call(this, event);
        }

        createDataChannel(label) {
          return {
            label,
            readyState: "connecting",
            sent: [],
            listeners: {},
            send(payload) {
              this.sent.push(payload);
            },
            addEventListener(type, listener) {
              (this.listeners[type] ||= []).push(listener);
            },
          };
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
          this.dispatchFakeEvent("connectionstatechange", {});
        }
      }
      window.RTCPeerConnection = FakeRTCPeerConnection;
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          getUserMedia: async () => {
            window.__MAB_GET_USER_MEDIA_CALLS += 1;
            throw new Error("local mic fallback must not be used");
          },
        },
      });
      window.fetch = async (url) =>
        String(url).includes("/token")
          ? new Response(JSON.stringify({ value: "ek_test" }), {
              status: 200,
              headers: { "content-type": "application/json" },
            })
          : new Response("answer", {
              status: 200,
              headers: { "content-type": "application/sdp" },
            });
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
        sendSessionUpdateOnConnect: false,
      }),
    });

    const result = await page.evaluate(async () => {
      await window.MAB_REALTIME_CLIENT.connect();
      const realtimePeer = window.__MAB_FAKE_PEERS[0];
      const meetAudioContext = new AudioContext();
      const meetDestination = meetAudioContext.createMediaStreamDestination();
      const meetPeer = new RTCPeerConnection();
      const meetSender = meetPeer.addTrack(
        meetDestination.stream.getAudioTracks()[0],
        meetDestination.stream,
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      const mediaElementContext = new AudioContext();
      const mediaElementDestination = mediaElementContext.createMediaStreamDestination();
      const audioElement = document.createElement("audio");
      audioElement.captureStream = () => mediaElementDestination.stream;
      document.body.append(audioElement);
      await new Promise((resolve) => setTimeout(resolve, 1100));
      const audioContext = new AudioContext();
      const oscillator = audioContext.createOscillator();
      const destination = audioContext.createMediaStreamDestination();
      oscillator.connect(destination);
      oscillator.start();
      realtimePeer.ontrack?.({ streams: [destination.stream] });
      await new Promise((resolve) => setTimeout(resolve, 100));
      oscillator.stop();
      await audioContext.close();
      await meetAudioContext.close();
      await mediaElementContext.close();

      return {
        getUserMediaCalls: window.__MAB_GET_USER_MEDIA_CALLS,
        localRealtimeAudioElements: document.querySelectorAll(
          "audio[data-meeting-avatar-realtime-audio]",
        ).length,
        avatarBusStreams: window.__MAB_AVATAR_BUS_STREAMS,
        avatarAudioTrackId: window.__MAB_AVATAR_AUDIO_TRACK.id,
        meetSenderTrackId: meetSender.track?.id || "",
        connection: window.MAB_REALTIME_BRIDGE.connection,
        primarySenderAttachEvents: window.MAB_REALTIME_BRIDGE.timeline.filter(
          (entry) => entry.type === "primary_meet_audio_sender_attached",
        ),
        localMicEvents: window.MAB_REALTIME_BRIDGE.timeline.filter((entry) =>
          String(entry.type).startsWith("local_audio"),
        ),
      };
    });

    assert.equal(result.getUserMediaCalls, 0);
    assert.equal(result.localRealtimeAudioElements, 0);
    assert.equal(result.avatarBusStreams.length, 1);
    assert.equal(result.meetSenderTrackId, result.avatarAudioTrackId);
    assert.equal(result.connection.primaryMeetAudioSenderUsingAvatarBus, true);
    assert.equal(result.primarySenderAttachEvents.length, 1);
    assert.equal(result.connection.meetMediaElementsScanned, 1);
    assert.equal(result.connection.meetMediaElementAudioTracksAdded, 1);
    assert.equal(result.connection.localAudioFallbackEnabled, false);
    assert.equal(result.connection.localAudioTrackAdded, false);
    assert.equal(result.connection.localAudioFallbackTrackAdded, false);
    assert.equal(result.connection.localAudioRoutedToRealtimeMix, false);
    assert.equal(result.connection.localAudioMixEnabled, false);
    assert.equal(result.connection.currentRealtimeInputSource, "meet_audio_mix");
    assert.equal(result.connection.currentRealtimeInputIsRoutingMix, true);
    assert.deepEqual(result.localMicEvents, []);
  } finally {
    await browser.close();
  }
});
