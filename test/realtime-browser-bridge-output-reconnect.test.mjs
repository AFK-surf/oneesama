import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";

import { buildRealtimeBrowserInitScript } from "../packages/core/src/realtime/realtime-browser-init-builder.ts";

test("Realtime reconnect keeps avatar bus attached to Meet sender and clears stale output", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.evaluate(() => {
      window.__MAB_FAKE_PEERS = [];
      window.__MAB_AVATAR_AUDIO_CONTEXT = new AudioContext();
      window.__MAB_AVATAR_AUDIO_DESTINATION =
        window.__MAB_AVATAR_AUDIO_CONTEXT.createMediaStreamDestination();
      window.__MAB_AVATAR_AUDIO_TRACK =
        window.__MAB_AVATAR_AUDIO_DESTINATION.stream.getAudioTracks()[0];
      window.__MAB_AVATAR_BUS_STREAMS = [];
      window.MAB_AVATAR_AUDIO_BUS = {
        track: window.__MAB_AVATAR_AUDIO_TRACK,
        syntheticSpeechActive: false,
        addStream(stream, options = {}) {
          window.__MAB_AVATAR_BUS_STREAMS.push({
            label: options.label || "",
            trackIds: stream?.getAudioTracks?.().map((track) => track.id) || [],
          });
          return { ok: true };
        },
        setSyntheticSpeech(active) {
          this.syntheticSpeechActive = Boolean(active);
          return { ok: true };
        },
      };

      class FakeRTCPeerConnection {
        constructor() {
          this.connectionState = "new";
          this.signalingState = "stable";
          this.senders = [];
          this.dataChannels = [];
          this.listeners = {};
          window.__MAB_FAKE_PEERS.push(this);
        }

        addTrack(track) {
          const sender = {
            track,
            bytesSent: 0,
            packetsSent: 0,
            async replaceTrack(nextTrack) {
              sender.track = nextTrack || null;
            },
            async getStats() {
              if (sender.track?.readyState === "live") {
                sender.bytesSent += 2048;
                sender.packetsSent += 8;
              }
              return new Map([
                [
                  "outbound-audio",
                  {
                    type: "outbound-rtp",
                    kind: "audio",
                    bytesSent: sender.bytesSent,
                    packetsSent: sender.packetsSent,
                  },
                ],
              ]);
            },
          };
          this.senders.push(sender);
          return sender;
        }

        getSenders() {
          return this.senders;
        }

        addTransceiver(trackOrKind) {
          const track = typeof trackOrKind === "object" ? trackOrKind : null;
          const sender = track ? this.addTrack(track) : { track: null };
          return { sender };
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
        includeParticipantAudio: false,
        captureMeetAudioForTranscript: false,
        sendSessionUpdateOnConnect: false,
      }),
    });

    const result = await page.evaluate(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

      const meetContext = new AudioContext();
      await meetContext.resume();
      const meetDestination = meetContext.createMediaStreamDestination();
      const meetPeer = new RTCPeerConnection();
      const meetSender = meetPeer.addTrack(
        meetDestination.stream.getAudioTracks()[0],
        meetDestination.stream,
      );
      await wait(250);

      await window.MAB_REALTIME_CLIENT.connect();
      const firstRealtimePeer = window.__MAB_FAKE_PEERS.at(-1);
      firstRealtimePeer.dataChannels[0].readyState = "open";
      firstRealtimePeer.dataChannels[0].dispatchFakeEvent("open", {});
      firstRealtimePeer.dataChannels[0].dispatchFakeEvent("message", {
        data: JSON.stringify({ type: "response.output_audio.delta" }),
      });
      const staleOutputWasActive = window.MAB_REALTIME_BRIDGE.protection.outputAudioActive === true;
      firstRealtimePeer.dataChannels[0].close();

      await wait(850);
      const reconnectedPeer = window.__MAB_FAKE_PEERS.at(-1);
      reconnectedPeer.dataChannels[0].readyState = "open";
      reconnectedPeer.dataChannels[0].dispatchFakeEvent("open", {});
      await wait(150);

      const clearedAfterReconnect = {
        outputAudioActive: window.MAB_REALTIME_BRIDGE.protection.outputAudioActive,
        syntheticSpeechActive: window.MAB_AVATAR_AUDIO_BUS.syntheticSpeechActive,
      };
      const rawStatsBeforeOutput =
        window.MAB_REALTIME_BRIDGE.connection.primaryMeetAudioSenderStats;
      const statsBeforeOutput = rawStatsBeforeOutput ? { ...rawStatsBeforeOutput } : {};

      const remoteContext = new AudioContext();
      await remoteContext.resume();
      const oscillator = remoteContext.createOscillator();
      const gain = remoteContext.createGain();
      gain.gain.value = 0.02;
      const remoteDestination = remoteContext.createMediaStreamDestination();
      oscillator.connect(gain);
      gain.connect(remoteDestination);
      oscillator.start();
      reconnectedPeer.ontrack?.({ streams: [remoteDestination.stream] });
      await wait(1200);
      oscillator.stop();
      await remoteContext.close();
      await meetContext.close();

      return {
        peerCount: window.__MAB_FAKE_PEERS.length,
        staleOutputWasActive,
        clearedAfterReconnect,
        avatarAudioTrackId: window.__MAB_AVATAR_AUDIO_TRACK.id,
        meetSenderTrackId: meetSender.track?.id || "",
        avatarBusStreams: window.__MAB_AVATAR_BUS_STREAMS,
        connection: window.MAB_REALTIME_BRIDGE.connection,
        statsBeforeOutput,
        statsAfterOutput: window.MAB_REALTIME_BRIDGE.connection.primaryMeetAudioSenderStats,
        timelineTypes: window.MAB_REALTIME_BRIDGE.timeline.map((entry) => entry.type),
      };
    });

    assert.ok(result.peerCount >= 3, `expected Meet + two Realtime peers, got ${result.peerCount}`);
    assert.equal(result.staleOutputWasActive, true);
    assert.equal(result.clearedAfterReconnect.outputAudioActive, false);
    assert.equal(result.clearedAfterReconnect.syntheticSpeechActive, false);
    assert.equal(result.meetSenderTrackId, result.avatarAudioTrackId);
    assert.equal(result.connection.primaryMeetAudioSenderUsingAvatarBus, true);
    assert.equal(result.connection.remoteAudioRoutedToAvatarBus, true);
    assert.equal(result.avatarBusStreams.length, 1);
    assert.ok(result.timelineTypes.includes("realtime_connection_cleanup"));
    assert.ok(result.timelineTypes.includes("remote_audio_route"));
    assert.ok(
      result.statsAfterOutput.bytesSent > result.statsBeforeOutput.bytesSent,
      `expected Meet outbound bytes to grow after reconnect; before=${result.statsBeforeOutput.bytesSent} after=${result.statsAfterOutput.bytesSent}`,
    );
  } finally {
    await browser.close();
  }
});
