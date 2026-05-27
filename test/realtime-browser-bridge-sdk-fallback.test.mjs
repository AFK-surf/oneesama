import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";

import { buildRealtimeBrowserInitScript } from "../packages/core/src/realtime/realtime-browser-init-builder.ts";

test("Realtime bridge keeps raw mixer sender live after Agents SDK fallback closes its input stream", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.evaluate(() => {
      window.__MAB_FAKE_PEERS = [];
      class FakeRTCPeerConnection {
        constructor() {
          this.connectionState = "new";
          this.senders = [];
          this.dataChannels = [];
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
          this.dispatchFakeEvent("connectionstatechange", {});
        }
      }
      window.RTCPeerConnection = FakeRTCPeerConnection;
      window.fetch = async (url) => {
        if (String(url).includes("/token")) {
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
      window.OpenAIAgentsRealtime = {
        tool(config) {
          return config;
        },
        RealtimeAgent: function RealtimeAgent(config) {
          this.config = config;
        },
        OpenAIRealtimeWebRTC: class OpenAIRealtimeWebRTC {
          constructor(options) {
            this.options = options;
          }

          on() {
            return this;
          }

          close() {
            this.options.mediaStream?.getTracks?.().forEach((track) => track.stop());
          }
        },
        RealtimeSession: class RealtimeSession {
          constructor(_agent, options) {
            this.options = options;
          }

          on() {
            return this;
          }

          async connect() {
            const stream = this.options.transport.options.mediaStream;
            window.__MAB_SDK_INPUT_TRACKS = stream.getAudioTracks().map((track) => ({
              id: track.id,
              readyState: track.readyState,
            }));
            stream.getTracks().forEach((track) => track.stop());
            throw new Error("Failed to fetch");
          }

          close() {}
        },
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
        sendSessionUpdateOnConnect: false,
      }),
    });

    const result = await page.evaluate(async () => {
      const audioContext = new AudioContext();
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      const destination = audioContext.createMediaStreamDestination();
      gain.gain.value = 0.002;
      oscillator.connect(gain);
      gain.connect(destination);
      oscillator.start();

      window.MAB_REALTIME_CLIENT.registerParticipantAudioStream(destination.stream, {
        label: "sdk-fallback-participant-audio",
      });
      await window.MAB_REALTIME_CLIENT.connect({ agentRuntime: "agents-sdk" });
      await new Promise((resolve) => setTimeout(resolve, 100));

      const peer = window.__MAB_FAKE_PEERS.at(-1);
      return {
        sdkInputTracks: window.__MAB_SDK_INPUT_TRACKS,
        senderTrackStates: peer.senders.map((sender) => sender.track?.readyState || "missing"),
        senderTrackIds: peer.senders.map((sender) => sender.track?.id || ""),
        connection: window.MAB_REALTIME_BRIDGE.connection,
        cloneEvents: window.MAB_REALTIME_BRIDGE.timeline.filter(
          (entry) => entry.type === "realtime_agent_sdk_input_stream_cloned",
        ),
      };
    });

    assert.equal(result.sdkInputTracks.length, 1);
    assert.deepEqual(result.senderTrackStates, ["live"]);
    assert.notEqual(result.senderTrackIds[0], result.sdkInputTracks[0].id);
    assert.equal(result.connection.currentRealtimeInputSource, "meet_audio_mix");
    assert.equal(result.connection.currentRealtimeInputIsRoutingMix, true);
    assert.equal(result.cloneEvents.length, 1);
  } finally {
    await browser.close();
  }
});
