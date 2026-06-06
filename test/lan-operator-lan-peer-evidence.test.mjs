import assert from "node:assert/strict";
import { chromium } from "playwright";
import { test } from "vite-plus/test";

import {
  buildLanPeerEvidenceSummary,
  isLoopbackLanPeerAddress,
  isPrivateLanPeerAddress,
  normalizeLanPeerAddress,
} from "../packages/core/src/operator/lan-operator-lan-peer.ts";
import { createLanOperatorSurfaceServer } from "../packages/core/src/operator/lan-operator-surface.ts";
import { attachLanAcceptanceSlo } from "../scripts/lan-operator-acceptance-slo.mjs";

const baseTime = Date.parse("2026-06-05T00:00:00.000Z");

function at(ms) {
  return new Date(baseTime + ms).toISOString();
}

async function waitForRuntimeStatus(url, predicate, timeoutMs = 5_000) {
  const statusUrl = new URL("/runtime/status", url);
  const started = Date.now();
  let lastBody = null;
  while (Date.now() - started < timeoutMs) {
    const body = await (await fetch(statusUrl)).json();
    lastBody = body;
    if (predicate(body)) return body;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`runtime_status_timeout: ${JSON.stringify(lastBody)}`);
}

function baseVoiceExternalReport(lanEvidence = {}) {
  return {
    schema: "oneesama.lan_voice_acceptance.v1",
    gate: "lan_voice_loop",
    ok: true,
    conversationEngine: {
      speechStartMs: 120,
      canonicalEventCounts: { speech_started: 1, assistant_text_completed: 1 },
    },
    audio: {
      transport: "websocket_pcm",
      turnDetectionOwner: "conversation_engine",
      localVadEnabled: false,
      localVadRole: "disabled",
      forwardedChunksDelta: 6,
      hostReceiveLagMs: 12,
      voiceAckRttMs: 18,
      voiceStreamId: "voice_stream_external_no_peer",
      voiceStreamGeneration: 1,
      voiceStreamOpenCount: 1,
      staleChunksRejected: 0,
    },
    lanEvidence: {
      externalSurfaceMode: true,
      nonLoopbackSurfaceHost: true,
      voicePublisherMode: "preexisting_lan_operator_surface",
      ...lanEvidence,
    },
    timeline: [
      {
        at: at(0),
        event: "operator_voice_chunk_received",
        turnId: "turn_external_no_peer",
        durationMs: null,
        ok: true,
      },
      {
        at: at(120),
        event: "speech_started",
        turnId: "turn_external_no_peer",
        durationMs: 120,
        ok: true,
      },
      {
        at: at(310),
        event: "assistant_text_delta",
        turnId: "turn_external_no_peer",
        durationMs: 310,
        ok: true,
      },
    ],
    turns: [
      {
        turnId: "turn_external_no_peer",
        milestones: { heard: true, speechStarted: true, transcript: true, output: true },
      },
    ],
  };
}

function baseVisualExternalReport(lanEvidence = {}) {
  return {
    schema: "oneesama.lan_voice_acceptance.v1",
    gate: "lan_host_visual_stream",
    ok: true,
    timings: { connectedMs: 700 },
    visual: {
      frameAgeMs: 12,
      frameRate: 30,
      hostSourceMode: "diagnostic_canvas",
      avatarSourceMode: "avatar_renderer",
      avatarRenderer: "fallback",
      operatorScreenBackflow: false,
      sources: [
        {
          id: "host-app",
          state: "live",
          trackReadyState: "live",
          width: 1280,
          height: 720,
          frameRate: 30,
          frameAgeMs: 12,
        },
        {
          id: "avatar",
          state: "live",
          trackReadyState: "live",
          width: 640,
          height: 360,
          frameRate: 30,
          frameAgeMs: 12,
        },
      ],
      composition: {
        mode: "operator_side",
        localComposedTrack: true,
        trackKind: "video",
        trackReadyState: "live",
        width: 1280,
        height: 720,
        targetFps: 30,
        lastRenderedFrameAgeMs: 9,
        layoutRevision: 1,
        focusedSourceId: "avatar",
        overlayCount: 1,
        sourceRects: {
          "host-app": { x: 0.04, y: 0.08, width: 0.64, height: 0.78 },
          avatar: { x: 0.58, y: 0.42, width: 0.28, height: 0.38 },
        },
      },
    },
    lanEvidence: {
      externalSurfaceMode: true,
      nonLoopbackSurfaceHost: true,
      publisherMode: "preexisting_host_publishers",
      ...lanEvidence,
    },
  };
}

test("LAN peer evidence classifies loopback, IPv4-mapped, and private LAN addresses", () => {
  assert.equal(normalizeLanPeerAddress("::ffff:192.168.1.42"), "192.168.1.42");
  assert.equal(isLoopbackLanPeerAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackLanPeerAddress("192.168.1.42"), false);
  assert.equal(isPrivateLanPeerAddress("192.168.1.42"), true);
  assert.equal(isPrivateLanPeerAddress("172.20.10.5"), true);
  assert.equal(isPrivateLanPeerAddress("8.8.8.8"), false);

  const summary = buildLanPeerEvidenceSummary(
    [
      {
        id: "peer_events",
        kind: "events",
        remoteAddress: "::ffff:192.168.1.42",
        normalizedAddress: "192.168.1.42",
        remotePort: 50000,
        remoteFamily: "IPv6",
        loopback: false,
        privateLan: true,
        connectedAt: at(0),
        lastPacketAt: null,
        disconnectedAt: null,
        state: "open",
      },
    ],
    at(1),
  );

  assert.equal(summary.operatorNonLoopbackPeerCount, 1);
  assert.equal(summary.operatorPrivateLanPeerCount, 1);
  assert.equal(summary.byKind.events.privateLanCount, 1);
});

test("LAN operator surface records websocket LAN peer evidence", async () => {
  const surface = createLanOperatorSurfaceServer({
    host: "127.0.0.1",
    port: 0,
    sessionId: "lan-operator-peer-evidence",
    botName: "LAN Oneesama",
  });
  const { url } = await surface.listen();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 860 } });
    await page.goto(url);
    await page.waitForFunction(() => window.MAB_LAN_OPERATOR_SURFACE?.state?.ready === true, null, {
      timeout: 10_000,
    });
    const body = await waitForRuntimeStatus(
      url,
      (nextBody) =>
        Number(nextBody.debug.surfaceContext.lanPeerEvidence?.activeConnectionCount || 0) >= 2 &&
        Number(nextBody.debug.surfaceContext.lanPeerEvidence?.byKind?.events?.activeCount || 0) >=
          1 &&
        Number(nextBody.debug.surfaceContext.lanPeerEvidence?.byKind?.voice?.activeCount || 0) >= 1,
    );
    const evidence = body.debug.surfaceContext.lanPeerEvidence;

    assert.equal(evidence.schema, "oneesama.lan_peer_evidence.v1");
    assert.equal(evidence.operatorNonLoopbackPeerCount, 0);
    assert.ok(
      evidence.activePeers.every((peer) => peer.loopback === true),
      JSON.stringify(evidence),
    );
  } finally {
    await browser.close();
    await surface.close();
  }
});

test("LAN voice external SLO fails without host-observed operator peer evidence", () => {
  const report = attachLanAcceptanceSlo(
    baseVoiceExternalReport({
      peerEvidence: { operatorNonLoopbackPeerCount: 0, operatorPrivateLanPeerCount: 0 },
    }),
  );

  assert.equal(report.ok, false);
  assert.ok(
    report.slo.failures.some(
      (failure) => failure.id === "lan_voice_external_operator_peer_observed",
    ),
    JSON.stringify(report.slo),
  );
});

test("LAN host visual external SLO fails without host-observed operator peer evidence", () => {
  const report = attachLanAcceptanceSlo(
    baseVisualExternalReport({
      peerEvidence: { operatorNonLoopbackPeerCount: 0, operatorPrivateLanPeerCount: 0 },
    }),
  );

  assert.equal(report.ok, false);
  assert.ok(
    report.slo.failures.some(
      (failure) => failure.id === "host_visual_external_operator_peer_observed",
    ),
    JSON.stringify(report.slo),
  );
});
