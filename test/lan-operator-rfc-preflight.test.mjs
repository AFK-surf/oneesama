import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vite-plus/test";

import { buildLanRfcPreflightReport } from "../scripts/lan-operator-rfc-preflight.mjs";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

function auditFixture() {
  return {
    ok: false,
    artifactCount: 14,
    passed: 6,
    failed: 8,
    missing: 0,
    categories: {
      local_diagnostic: { total: 6, passed: 6, failed: 0, missing: 0 },
      external_lan: { total: 2, passed: 0, failed: 2, missing: 0 },
    },
    requiredFailures: [
      {
        id: "lan_voice_loop_external",
        category: "external_lan",
        status: "failed",
        blocker: "missing_lan_operator_surface_url",
        path: "/tmp/oneesama-realtime-lan-voice-external-latest.json",
      },
    ],
    nextActionCount: 1,
  };
}

function response(body) {
  return {
    ok: true,
    status: 200,
    async json() {
      return body;
    },
  };
}

function mockFetch({ statusBody, reportBody }) {
  return async (url) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname === "/runtime/status") return response(statusBody);
    if (pathname === "/runtime/report") return response(reportBody);
    throw new Error(`unexpected url: ${url}`);
  };
}

function surfaceContext() {
  return {
    trustedLanOperatorMode: true,
    lanModeExplicitlyEnabled: true,
    lanReachability: {
      externallyReachableCandidate: true,
      advertisedUrl: "http://192.168.1.22:18913/",
      primaryLanUrl: "http://192.168.1.22:18913/",
      lanUrls: ["http://192.168.1.22:18913/"],
    },
    lanPeerEvidence: {
      operatorNonLoopbackPeerCount: 1,
      operatorPrivateLanPeerCount: 1,
      byKind: {
        events: { activeCount: 1, nonLoopbackCount: 1 },
        voice: { activeCount: 1, nonLoopbackCount: 1 },
      },
    },
  };
}

test("LAN RFC preflight reports missing external inputs without hiding current audit state", async () => {
  const report = await buildLanRfcPreflightReport({
    env: {},
    fetchImpl: null,
    now: Date.UTC(2026, 5, 6),
    auditReport: auditFixture(),
  });

  assert.equal(report.ok, false);
  assert.equal(report.preflightSatisfied, false);
  assert.equal(report.acceptanceSatisfied, false);
  assert.equal(report.surface.configured, false);
  assert.equal(report.currentEvidence.passed, 6);
  assert.equal(report.currentEvidence.missing, 0);
  assert.ok(
    report.blockers.some((blocker) => blocker.blocker === "missing_lan_operator_surface_url"),
  );
  assert.ok(
    report.blockers.some((blocker) => blocker.blocker === "openai_realtime_api_key_missing"),
  );
  assert.ok(
    report.blockers.some((blocker) => blocker.blocker === "meet_compatibility_input_missing"),
  );
  assert.ok(
    report.commands.some((entry) => /acceptance:realtime-lan-voice:external/.test(entry.command)),
  );
  assert.ok(
    report.commands.some(
      (entry) =>
        entry.command === "vp run acceptance:realtime-lan-host-visual-stream:display:manual",
    ),
  );
  assert.ok(
    report.commands.some(
      (entry) =>
        entry.command === "vp run acceptance:realtime-lan-host-visual-stream:display:native",
    ),
  );
});

test("LAN RFC preflight rejects loopback surface URLs for second-computer evidence", async () => {
  const report = await buildLanRfcPreflightReport({
    surfaceUrl: "http://127.0.0.1:18913/",
    env: {
      MAB_OPENAI_API_KEY: "sk-test",
      MAB_REAL_MEET_URL: "https://meet.google.com/abc-defg-hij",
    },
    fetchImpl: mockFetch({
      statusBody: {
        ok: true,
        debug: { surfaceContext: surfaceContext() },
      },
      reportBody: {
        report: { summaries: { surfaceContext: surfaceContext() } },
      },
    }),
    now: Date.UTC(2026, 5, 6),
    auditReport: auditFixture(),
  });

  assert.equal(report.ok, false);
  assert.equal(report.surface.runtimeStatusReachable, true);
  assert.equal(report.surface.debugReportReachable, true);
  assert.equal(report.surface.nonLoopbackHost, false);
  assert.ok(
    report.blockers.some((blocker) => blocker.blocker === "lan_operator_surface_url_loopback"),
  );
  assert.equal(report.environment.openaiRealtime.configured, true);
  assert.equal(report.environment.meetCompatibility.meetUrlConfigured, true);
});

test("LAN RFC preflight passes when URL, runtime report, and external env are ready", async () => {
  const context = surfaceContext();
  const report = await buildLanRfcPreflightReport({
    surfaceUrl: "http://192.168.1.22:18913/",
    env: {
      OPENAI_API_KEY: "sk-test",
      https_proxy: "http://127.0.0.1:6152",
      MAB_REAL_MEET_URL: "https://meet.google.com/abc-defg-hij",
    },
    fetchImpl: mockFetch({
      statusBody: {
        ok: true,
        debug: { surfaceContext: context },
      },
      reportBody: {
        report: { summaries: { surfaceContext: context } },
      },
    }),
    now: Date.UTC(2026, 5, 6),
    auditReport: auditFixture(),
  });

  assert.equal(report.ok, true);
  assert.equal(report.preflightSatisfied, true);
  assert.equal(report.acceptanceSatisfied, false);
  assert.equal(report.surface.nonLoopbackHost, true);
  assert.equal(report.surface.runtimeStatusOk, true);
  assert.equal(report.surface.lanPeerEvidence.operatorNonLoopbackPeerCount, 1);
  assert.equal(report.environment.openaiRealtime.keySource, "OPENAI_API_KEY");
  assert.equal(report.environment.openaiRealtime.websocketProxy.configured, true);
  assert.equal(report.environment.openaiRealtime.websocketProxy.source, "https_proxy");
  assert.equal(report.environment.openaiRealtime.websocketProxy.protocol, "http:");
  assert.equal(report.environment.openaiRealtime.websocketProxy.supportedByRealtimeTransport, true);
  assert.equal(report.environment.openaiRealtime.websocketProxy.loopbackProxy, true);
  assert.equal(report.currentEvidence.nextActionCount, 1);
});

test("LAN RFC preflight reports unsupported OpenAI Realtime proxy schemes", async () => {
  const report = await buildLanRfcPreflightReport({
    surfaceUrl: "http://192.168.1.22:18913/",
    env: {
      OPENAI_API_KEY: "sk-test",
      all_proxy: "socks5://127.0.0.1:6153",
      MAB_REAL_MEET_URL: "https://meet.google.com/abc-defg-hij",
    },
    fetchImpl: mockFetch({
      statusBody: {
        ok: true,
        debug: { surfaceContext: surfaceContext() },
      },
      reportBody: {
        report: { summaries: { surfaceContext: surfaceContext() } },
      },
    }),
    now: Date.UTC(2026, 5, 6),
    auditReport: auditFixture(),
  });

  assert.equal(report.environment.openaiRealtime.websocketProxy.configured, true);
  assert.equal(report.environment.openaiRealtime.websocketProxy.source, "all_proxy");
  assert.equal(report.environment.openaiRealtime.websocketProxy.protocol, "socks5:");
  assert.equal(
    report.environment.openaiRealtime.websocketProxy.supportedByRealtimeTransport,
    false,
  );
});

test("LAN RFC package scripts expose the manual display-capture gate", () => {
  const script = packageJson.scripts["acceptance:realtime-lan-host-visual-stream:display:manual"];
  const nativeScript =
    packageJson.scripts["acceptance:realtime-lan-host-visual-stream:display:native"];

  assert.match(script, /MAB_LAN_OPERATOR_BROWSER_CHANNEL=chrome/);
  assert.match(script, /MAB_LAN_OPERATOR_MANUAL_DISPLAY_CAPTURE_PICKER=1/);
  assert.match(script, /--require-display-capture/);
  assert.match(script, /--timeout-ms 120000/);
  assert.match(
    script,
    /--json-out \/tmp\/oneesama-realtime-lan-host-visual-stream-display-latest\.json/,
  );
  assert.match(nativeScript, /MAB_LAN_OPERATOR_BROWSER_CHANNEL=chrome/);
  assert.match(nativeScript, /MAB_LAN_OPERATOR_NATIVE_SCREENCAPTURE_FALLBACK=1/);
  assert.match(nativeScript, /--require-display-capture/);
  assert.match(
    nativeScript,
    /--json-out \/tmp\/oneesama-realtime-lan-host-visual-stream-display-latest\.json/,
  );
});
