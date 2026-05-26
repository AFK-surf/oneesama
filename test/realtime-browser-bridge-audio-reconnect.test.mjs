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

test("Realtime bridge prefers direct participant audio over a silent mix placeholder", async () => {
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
      const destination = audioContext.createMediaStreamDestination();
      oscillator.connect(destination);
      oscillator.start();
      const [participantTrack] = destination.stream.getAudioTracks();

      window.MAB_REALTIME_CLIENT.registerParticipantAudioStream(destination.stream, {
        label: "test-participant-audio",
      });
      await window.MAB_REALTIME_CLIENT.connect();
      await new Promise((resolve) => setTimeout(resolve, 50));

      const peer = window.__MAB_FAKE_PEERS.at(-1);
      return {
        participantTrackId: participantTrack.id,
        senderTrackIds: peer.senders.map((sender) => sender.track?.id || ""),
        placeholderEvents: window.MAB_REALTIME_BRIDGE.timeline.filter(
          (entry) => entry.type === "realtime_input_placeholder_added",
        ).length,
        directEvents: window.MAB_REALTIME_BRIDGE.timeline.filter(
          (entry) => entry.type === "realtime_input_direct_participant_audio",
        ).length,
      };
    });

    assert.deepEqual(result.senderTrackIds, [result.participantTrackId]);
    assert.equal(result.placeholderEvents, 0);
    assert.equal(result.directEvents, 1);
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
        fallbackToLocalMic: false,
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

test("Realtime feedback blocks only-local-mic input when Meet audio is expected", async () => {
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
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          getUserMedia: async () => window.__MAB_LOCAL_MIC_STREAM,
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
        fallbackToLocalMic: true,
        captureMeetAudioForTranscript: false,
      }),
    });

    const result = await page.evaluate(async () => {
      const localContext = new AudioContext();
      await localContext.resume();
      const oscillator = localContext.createOscillator();
      const localDestination = localContext.createMediaStreamDestination();
      oscillator.connect(localDestination);
      oscillator.start();
      window.__MAB_LOCAL_MIC_STREAM = localDestination.stream;

      await window.MAB_REALTIME_CLIENT.connect();
      const peer = window.__MAB_FAKE_PEERS.at(-1);
      const channel = peer.dataChannels.at(-1);
      channel.readyState = "open";
      channel.dispatchFakeEvent("open", {});
      channel.dispatchFakeEvent("message", {
        data: JSON.stringify({ type: "session.created" }),
      });
      await new Promise((resolve) => setTimeout(resolve, 50));

      oscillator.stop();
      await localContext.close();
      return {
        feedback: window.MAB_REALTIME_BRIDGE.feedback,
        connection: window.MAB_REALTIME_BRIDGE.connection,
      };
    });

    assert.equal(result.connection.localAudioTrackAdded, true);
    assert.equal(result.connection.meetAudioTracksForwarded, 0);
    assert.equal(result.connection.participantAudioTracksAdded, 0);
    assert.equal(result.feedback.status, "waiting_for_turn");
    assert.equal(result.feedback.checks.onlyLocalMicFallbackInput, true);
    assert.equal(result.feedback.checks.meetParticipantAudioReady, false);
    assert.ok(result.feedback.blockers.includes("waiting_for_meet_audio"));
    assert.ok(result.feedback.blockers.includes("only_local_mic_fallback_input"));
    assert.ok(!result.feedback.blockers.includes("no_response_events"));
  } finally {
    await browser.close();
  }
});

test("Realtime bridge keeps local mic fallback audible after late Meet audio replaces input", async () => {
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
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          getUserMedia: async () => window.__MAB_LOCAL_MIC_STREAM,
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
        fallbackToLocalMic: true,
        captureMeetAudioForTranscript: false,
        sendSessionUpdateOnConnect: false,
      }),
    });

    const result = await page.evaluate(async () => {
      const localContext = new AudioContext();
      await localContext.resume();
      const oscillator = localContext.createOscillator();
      const localGain = localContext.createGain();
      const localDestination = localContext.createMediaStreamDestination();
      localGain.gain.value = 0.75;
      oscillator.frequency.value = 440;
      oscillator.connect(localGain).connect(localDestination);
      oscillator.start();
      window.__MAB_LOCAL_MIC_STREAM = localDestination.stream;
      const [localMicTrack] = localDestination.stream.getAudioTracks();

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
      oscillator.stop();
      await localContext.close();

      return {
        localMicTrackId: localMicTrack.id,
        senderTrackIds: peer.senders.map((sender) => sender.track?.id || ""),
        replacedTrackId: realtimeInputTrack?.id || "",
        rms,
        localMicMixEvents: window.MAB_REALTIME_BRIDGE.timeline.filter(
          (entry) => entry.type === "local_audio_routed_to_realtime_mix",
        ).length,
        replaceReasons: window.MAB_REALTIME_BRIDGE.timeline
          .filter((entry) => entry.type === "realtime_input_replace_track")
          .map((entry) => entry.detail.reason),
      };
    });

    assert.notEqual(result.replacedTrackId, result.localMicTrackId);
    assert.ok(result.replaceReasons.includes("meet-audio-forwarded"));
    assert.equal(result.localMicMixEvents, 1);
    assert.ok(result.rms > 0.05, `expected local mic fallback in mix, got rms=${result.rms}`);
  } finally {
    await browser.close();
  }
});
