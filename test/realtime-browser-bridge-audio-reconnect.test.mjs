import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";

import { buildRealtimeBrowserInitScript } from "../packages/core/src/realtime/realtime-browser-init-builder.ts";

test("Realtime bridge keeps Meet audio routed after startup reconnect", async () => {
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
            send(payload) {
              this.sent.push(payload);
            },
            close() {
              this.readyState = "closed";
              this.onclose?.({});
            },
            onclose: null,
            onmessage: null,
            onopen: null,
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
          for (const channel of this.dataChannels) channel.close();
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
      const audioContext = new AudioContext();
      const oscillator = audioContext.createOscillator();
      const destination = audioContext.createMediaStreamDestination();
      oscillator.connect(destination);
      oscillator.start();

      window.MAB_REALTIME_CLIENT.registerParticipantAudioStream(destination.stream, {
        label: "test-participant-audio",
      });
      await window.MAB_REALTIME_CLIENT.connect();
      window.MAB_REALTIME_CLIENT.sendRealtimeEvent({
        type: "conversation.item.create",
        item: { type: "message", role: "system", content: [] },
      });
      await new Promise((resolve) => setTimeout(resolve, 50));

      return {
        peerCount: window.__MAB_FAKE_PEERS.length,
        senderTrackStates: window.__MAB_FAKE_PEERS.map((peer) =>
          peer.senders.map((sender) => sender.track?.readyState || "missing"),
        ),
        replaceReasons: window.MAB_REALTIME_BRIDGE.timeline
          .filter((entry) => entry.type === "realtime_input_replace_track")
          .map((entry) => entry.detail.reason),
      };
    });

    assert.ok(result.peerCount >= 2, `expected reconnect, got ${result.peerCount} peer(s)`);
    assert.deepEqual(result.senderTrackStates.at(-1), ["live"]);
    assert.ok(result.replaceReasons.includes("pending-meet-audio-flush"));
    assert.ok(result.replaceReasons.includes("reconnect-meet-audio-mix"));
  } finally {
    await browser.close();
  }
});

test("Realtime bridge routes participant audio through a single mixer sender", async () => {
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
            send(payload) {
              this.sent.push(payload);
            },
            close() {
              this.readyState = "closed";
              this.onclose?.({});
            },
            onclose: null,
            onmessage: null,
            onopen: null,
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
          for (const channel of this.dataChannels) channel.close();
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
        sendSessionUpdateOnConnect: false,
      }),
    });

    const result = await page.evaluate(async () => {
      const audioContext = new AudioContext();
      const oscillator = audioContext.createOscillator();
      const quietGain = audioContext.createGain();
      quietGain.gain.value = 0.00025;
      const destination = audioContext.createMediaStreamDestination();
      oscillator.connect(quietGain);
      quietGain.connect(destination);
      oscillator.start();
      const secondOscillator = audioContext.createOscillator();
      const secondGain = audioContext.createGain();
      secondGain.gain.value = 0.00025;
      const secondDestination = audioContext.createMediaStreamDestination();
      secondOscillator.connect(secondGain);
      secondGain.connect(secondDestination);
      secondOscillator.start();
      const [participantTrack] = destination.stream.getAudioTracks();
      const [secondParticipantTrack] = secondDestination.stream.getAudioTracks();

      window.MAB_REALTIME_CLIENT.registerParticipantAudioStream(destination.stream, {
        label: "quiet-test-participant-audio",
      });
      window.MAB_REALTIME_CLIENT.registerParticipantAudioStream(secondDestination.stream, {
        label: "quiet-test-participant-audio-2",
      });
      await window.MAB_REALTIME_CLIENT.connect();
      await new Promise((resolve) => setTimeout(resolve, 350));

      const peer = window.__MAB_FAKE_PEERS.at(-1);
      return {
        participantTrackIds: [participantTrack.id, secondParticipantTrack.id],
        senderTrackIds: peer.senders.map((sender) => sender.track?.id || ""),
        placeholderEvents: window.MAB_REALTIME_BRIDGE.timeline.filter(
          (entry) => entry.type === "realtime_input_placeholder_added",
        ).length,
        directEvents: window.MAB_REALTIME_BRIDGE.timeline.filter(
          (entry) => entry.type === "realtime_input_direct_participant_audio",
        ).length,
        replaceReasons: window.MAB_REALTIME_BRIDGE.timeline
          .filter((entry) => entry.type === "realtime_input_replace_track")
          .map((entry) => entry.detail.reason),
        connection: window.MAB_REALTIME_BRIDGE.connection,
      };
    });

    assert.equal(result.senderTrackIds.length, 1);
    assert.ok(!result.participantTrackIds.includes(result.senderTrackIds[0]));
    assert.equal(result.placeholderEvents, 1);
    assert.equal(result.directEvents, 0);
    assert.ok(result.replaceReasons.includes("pending-meet-audio-flush"));
    assert.equal(result.connection.pendingMeetAudioTrackCount, 0);
    assert.equal(result.connection.participantAudioTracksAdded, 0);
    assert.equal(result.connection.meetAudioTracksForwarded, 2);
    assert.equal(result.connection.currentRealtimeInputSource, "meet_audio_mix");
    assert.equal(result.connection.currentRealtimeInputIsRoutingMix, true);
    assert.equal(result.connection.meetAudioInputGain, 48);
    assert.equal(result.connection.meetAudioEnergy.observed, true);
    assert.ok(result.connection.meetAudioEnergy.rms > 0.003);
    assert.ok(result.connection.meetAudioEnergy.peak > 0.01);
    assert.ok(result.connection.meetAudioEnergy.lastEnergyAt);
  } finally {
    await browser.close();
  }
});

test("Realtime bridge keeps late participant tracks in the mixer when the peer connection is closed", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.evaluate(() => {
      window.__MAB_FAKE_PEERS = [];
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
          if (this.signalingState === "closed" || this.connectionState === "closed") {
            throw new Error(
              "Failed to execute 'addTrack' on 'RTCPeerConnection': The RTCPeerConnection's signalingState is 'closed'.",
            );
          }
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
        autoReconnect: false,
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
      const peer = window.__MAB_FAKE_PEERS.at(-1);
      peer.close();
      const audioContext = new AudioContext();
      const oscillator = audioContext.createOscillator();
      const destination = audioContext.createMediaStreamDestination();
      oscillator.connect(destination);
      oscillator.start();
      window.MAB_REALTIME_CLIENT.registerParticipantAudioStream(destination.stream, {
        label: "late-participant-audio",
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      oscillator.stop();
      await audioContext.close();
      return {
        errors: window.MAB_REALTIME_BRIDGE.errors,
        skipped: window.MAB_REALTIME_BRIDGE.timeline.filter(
          (entry) => entry.type === "participant_audio_add_track_skipped",
        ),
        forwarded: window.MAB_REALTIME_BRIDGE.timeline.filter(
          (entry) => entry.type === "meet_audio_track_forwarded",
        ),
        connection: window.MAB_REALTIME_BRIDGE.connection,
      };
    });

    assert.equal(result.errors.length, 0);
    assert.equal(result.skipped.length, 0);
    assert.equal(result.forwarded.length, 1);
    assert.equal(result.connection.participantAudioTracksAdded, 0);
    assert.equal(result.connection.meetAudioTracksForwarded, 1);
  } finally {
    await browser.close();
  }
});

test("Realtime bridge scans Meet inbound receiver audio when track event was missed", async () => {
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
          this.receivers = [];
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

        getReceivers() {
          return this.receivers;
        }

        addEventListener(type, listener) {
          (this.listeners[type] ||= []).push(listener);
        }

        createDataChannel(label) {
          const channel = {
            label,
            readyState: "connecting",
            sent: [],
            send(payload) {
              this.sent.push(payload);
            },
            close() {
              this.readyState = "closed";
              this.onclose?.({});
            },
            onclose: null,
            onmessage: null,
            onopen: null,
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
        }

        close() {
          this.connectionState = "closed";
          for (const channel of this.dataChannels) channel.close();
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
        sendSessionUpdateOnConnect: false,
      }),
    });

    const result = await page.evaluate(async () => {
      const audioContext = new AudioContext();
      const oscillator = audioContext.createOscillator();
      const destination = audioContext.createMediaStreamDestination();
      oscillator.connect(destination);
      oscillator.start();
      const [participantTrack] = destination.stream.getAudioTracks();

      const meetPeer = new RTCPeerConnection();
      meetPeer.receivers = [{ track: participantTrack }];
      await new Promise((resolve) => setTimeout(resolve, 1100));
      await window.MAB_REALTIME_CLIENT.connect();
      await new Promise((resolve) => setTimeout(resolve, 120));

      const realtimePeer = window.__MAB_FAKE_PEERS.at(-1);
      const forwarded = window.MAB_REALTIME_BRIDGE.timeline.filter(
        (entry) => entry.type === "meet_audio_track_forwarded",
      );
      const replaceReasons = window.MAB_REALTIME_BRIDGE.timeline
        .filter((entry) => entry.type === "realtime_input_replace_track")
        .map((entry) => entry.detail.reason);
      oscillator.stop();
      await audioContext.close();
      return {
        participantTrackId: participantTrack.id,
        senderTrackCount: realtimePeer.senders.length,
        forwardedSources: forwarded.map((entry) => entry.detail.source),
        replaceReasons,
      };
    });

    assert.equal(result.senderTrackCount, 1);
    assert.ok(result.forwardedSources.includes("scanReceiver[0]"));
    assert.ok(
      result.replaceReasons.includes("pending-meet-audio-flush") ||
        result.replaceReasons.includes("meet-audio-forwarded"),
      `expected receiver audio to become realtime input, got ${result.replaceReasons.join(",")}`,
    );
  } finally {
    await browser.close();
  }
});

test("Realtime feedback waits on silent placeholder when Meet audio is expected", async () => {
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

        close() {
          this.connectionState = "closed";
          for (const channel of this.dataChannels) channel.close();
        }
      }
      window.RTCPeerConnection = FakeRTCPeerConnection;
      window.__MAB_GET_USER_MEDIA_CALLS = 0;
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          getUserMedia: async () => {
            window.__MAB_GET_USER_MEDIA_CALLS += 1;
            throw new Error("local mic fallback removed");
          },
        },
      });
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
      }),
    });

    const result = await page.evaluate(async () => {
      await window.MAB_REALTIME_CLIENT.connect();
      const peer = window.__MAB_FAKE_PEERS.at(-1);
      const channel = peer.dataChannels.at(-1);
      channel.readyState = "open";
      channel.dispatchFakeEvent("open", {});
      channel.dispatchFakeEvent("message", {
        data: JSON.stringify({ type: "session.created" }),
      });
      await new Promise((resolve) => setTimeout(resolve, 50));

      return {
        feedback: window.MAB_REALTIME_BRIDGE.feedback,
        connection: window.MAB_REALTIME_BRIDGE.connection,
        getUserMediaCalls: window.__MAB_GET_USER_MEDIA_CALLS,
      };
    });

    assert.equal(result.getUserMediaCalls, 0);
    assert.equal(result.connection.realtimeInputPlaceholderAdded, true);
    assert.equal(result.connection.meetAudioTracksForwarded, 0);
    assert.equal(result.connection.participantAudioTracksAdded, 0);
    assert.equal(result.feedback.status, "waiting_for_turn");
    assert.equal(result.feedback.checks.meetParticipantAudioReady, false);
    assert.equal(result.feedback.audioInputPolicy.source, "silent_placeholder");
    assert.equal(result.feedback.audioInputPolicy.ready, false);
    assert.equal(result.feedback.failureMatrix.audioInput.reason, "silent_input_placeholder_only");
    assert.equal(result.feedback.runtimeState.phase, "audioInput:silent_input_placeholder_only");
    assert.ok(result.feedback.blockers.includes("waiting_for_meet_audio"));
    assert.ok(result.feedback.blockers.includes("silent_input_placeholder_only"));
    assert.ok(!result.feedback.blockers.includes("no_response_events"));
  } finally {
    await browser.close();
  }
});

test("Realtime bridge flushes pending Meet audio when the silent placeholder becomes sender", async () => {
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
            send(payload) {
              this.sent.push(payload);
            },
            close() {
              this.readyState = "closed";
              this.onclose?.({});
            },
            onclose: null,
            onmessage: null,
            onopen: null,
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
          for (const channel of this.dataChannels) channel.close();
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
        sendSessionUpdateOnConnect: false,
      }),
    });

    const result = await page.evaluate(async () => {
      const meetContext = new AudioContext();
      await meetContext.resume();
      const meetOscillator = meetContext.createOscillator();
      const meetDestination = meetContext.createMediaStreamDestination();
      meetOscillator.connect(meetDestination);
      meetOscillator.start();
      const [meetTrack] = meetDestination.stream.getAudioTracks();

      const meetPeer = new RTCPeerConnection();
      meetPeer.dispatchFakeEvent("track", {
        track: meetTrack,
        streams: [meetDestination.stream],
      });
      await new Promise((resolve) => setTimeout(resolve, 50));

      await window.MAB_REALTIME_CLIENT.connect();
      await new Promise((resolve) => setTimeout(resolve, 50));

      const realtimePeer = window.__MAB_FAKE_PEERS.at(-1);
      const senderTrackId = realtimePeer.senders[0]?.track?.id || "";
      const replaceReasons = window.MAB_REALTIME_BRIDGE.timeline
        .filter((entry) => entry.type === "realtime_input_replace_track")
        .map((entry) => entry.detail.reason);
      const pendingEvents = window.MAB_REALTIME_BRIDGE.timeline.filter(
        (entry) => entry.type === "meet_audio_track_pending",
      ).length;

      meetOscillator.stop();
      await meetContext.close();

      return {
        meetTrackId: meetTrack.id,
        senderTrackId,
        pendingEvents,
        replaceReasons,
        connection: window.MAB_REALTIME_BRIDGE.connection,
      };
    });

    assert.equal(result.connection.meetAudioTracksForwarded, 1);
    assert.equal(result.connection.pendingMeetAudioTrackCount, 0);
    assert.equal(result.connection.currentRealtimeInputSource, "meet_audio_mix");
    assert.equal(result.connection.currentRealtimeInputIsRoutingMix, true);
    assert.equal(result.connection.lastRealtimeInputReplaceReason, "pending-meet-audio-flush");
    assert.equal(result.pendingEvents, 1);
    assert.notEqual(result.senderTrackId, result.meetTrackId);
    assert.ok(result.replaceReasons.includes("pending-meet-audio-flush"));
  } finally {
    await browser.close();
  }
});

test("Realtime bridge replaces the silent placeholder after late Meet audio arrives", async () => {
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
            send(payload) {
              this.sent.push(payload);
            },
            close() {
              this.readyState = "closed";
              this.onclose?.({});
            },
            onclose: null,
            onmessage: null,
            onopen: null,
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
          for (const channel of this.dataChannels) channel.close();
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
        sendSessionUpdateOnConnect: false,
      }),
    });

    const result = await page.evaluate(async () => {
      await window.MAB_REALTIME_CLIENT.connect();

      const silentContext = new AudioContext();
      await silentContext.resume();
      const silentDestination = silentContext.createMediaStreamDestination();
      window.MAB_REALTIME_CLIENT.registerParticipantAudioStream(silentDestination.stream, {
        label: "late-silent-meet-audio",
      });
      await new Promise((resolve) => setTimeout(resolve, 150));

      const peer = window.__MAB_FAKE_PEERS.at(-1);
      const realtimeInputTrack = peer.senders[0]?.track;
      const analyserContext = new AudioContext();
      await analyserContext.resume();
      const analyser = analyserContext.createAnalyser();
      analyser.fftSize = 2048;
      analyserContext
        .createMediaStreamSource(new MediaStream([realtimeInputTrack]))
        .connect(analyser);
      await new Promise((resolve) => setTimeout(resolve, 180));
      const samples = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(samples);
      const rms = Math.sqrt(
        samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length,
      );
      await analyserContext.close();
      await silentContext.close();

      return {
        senderTrackIds: peer.senders.map((sender) => sender.track?.id || ""),
        replacedTrackId: realtimeInputTrack?.id || "",
        rms,
        localMicMixEvents: window.MAB_REALTIME_BRIDGE.timeline.filter(
          (entry) => entry.type === "local_audio_routed_to_realtime_mix",
        ).length,
        replaceReasons: window.MAB_REALTIME_BRIDGE.timeline
          .filter((entry) => entry.type === "realtime_input_replace_track")
          .map((entry) => entry.detail.reason),
        connection: window.MAB_REALTIME_BRIDGE.connection,
      };
    });

    assert.equal(result.connection.currentRealtimeInputSource, "meet_audio_mix");
    assert.ok(result.replaceReasons.includes("meet-audio-forwarded"));
    assert.equal(result.localMicMixEvents, 0);
    assert.ok(
      result.rms < 0.002,
      `expected silent Meet mix without local mic, got rms=${result.rms}`,
    );
  } finally {
    await browser.close();
  }
});
