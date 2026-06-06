import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "vite-plus/test";

import { createLanOperatorSurfaceServer } from "../packages/core/src/operator/lan-operator-surface.ts";
import {
  decideTrustedLanOperatorMode,
  isLoopbackLanOperatorHost,
} from "../packages/core/src/operator/lan-operator-trusted-lan.ts";
import {
  buildLanPeerEvidenceSummary,
  isLoopbackLanPeerAddress,
  isPrivateLanPeerAddress,
  normalizeLanPeerAddress,
} from "../packages/core/src/operator/lan-operator-lan-peer.ts";
import { buildLanOperatorReachability } from "../packages/core/src/operator/lan-operator-reachability.ts";

const execFileAsync = promisify(execFile);

test("LAN operator trusted mode allows loopback without LAN opt-in", () => {
  const decision = decideTrustedLanOperatorMode({
    host: "127.0.0.1",
    env: {},
  });

  assert.equal(isLoopbackLanOperatorHost("localhost"), true);
  assert.equal(decision.allowed, true);
  assert.equal(decision.localOnlyMode, true);
  assert.equal(decision.trustedLanOperatorMode, false);
  assert.equal(decision.lanModeExplicitlyEnabled, false);
  assert.equal(decision.blocker, null);
});

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
        connectedAt: "2026-06-05T00:00:00.000Z",
        lastPacketAt: null,
        disconnectedAt: null,
        state: "open",
      },
    ],
    "2026-06-05T00:00:01.000Z",
  );

  assert.equal(summary.operatorNonLoopbackPeerCount, 1);
  assert.equal(summary.operatorPrivateLanPeerCount, 1);
  assert.equal(summary.byKind.events.privateLanCount, 1);
});

test("LAN operator trusted mode rejects non-loopback bind without explicit opt-in", () => {
  const decision = decideTrustedLanOperatorMode({
    host: "0.0.0.0",
    env: {},
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.localOnlyMode, false);
  assert.equal(decision.trustedLanOperatorMode, false);
  assert.equal(decision.lanModeExplicitlyEnabled, false);
  assert.equal(decision.blocker, "trusted_lan_operator_mode_not_enabled");
});

test("LAN operator trusted mode allows non-loopback bind with explicit opt-in", () => {
  const decision = decideTrustedLanOperatorMode({
    host: "0.0.0.0",
    env: { MAB_LAN_OPERATOR_ENABLE_TRUSTED_LAN: "1" },
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.localOnlyMode, false);
  assert.equal(decision.trustedLanOperatorMode, true);
  assert.equal(decision.lanModeExplicitlyEnabled, true);
});

test("LAN operator reachability advertises private LAN URLs for wildcard bind", () => {
  const reachability = buildLanOperatorReachability({
    bindHost: "0.0.0.0",
    port: 18913,
    trustedLanOperatorMode: true,
    lanModeExplicitlyEnabled: true,
    interfaces: {
      lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
      en0: [{ address: "192.168.50.22", family: "IPv4", internal: false }],
    },
  });

  assert.equal(reachability.schema, "oneesama.lan_operator_reachability.v1");
  assert.equal(reachability.bindMode, "wildcard");
  assert.equal(reachability.externallyReachableCandidate, true);
  assert.deepEqual(reachability.lanUrls, ["http://192.168.50.22:18913/"]);
  assert.equal(reachability.advertisedUrl, "http://192.168.50.22:18913/");
});

test("LAN operator surface context records trusted LAN opt-in evidence", () => {
  const surface = createLanOperatorSurfaceServer({
    host: "127.0.0.1",
    port: 0,
    sessionId: "lan-operator-trusted-lan-policy",
    trustedLanOperatorMode: false,
    lanModeExplicitlyEnabled: false,
  });
  const status = surface.status();

  assert.equal(status.debug.surfaceContext.trustedLanOperatorMode, false);
  assert.equal(status.debug.surfaceContext.lanModeExplicitlyEnabled, false);
  assert.equal(status.debug.surfaceContext.schema, "oneesama.lan_operator_surface_context.v1");
  assert.equal(status.debug.surfaceContext.lanReachability.localOnlyMode, true);
  assert.equal(status.debug.surfaceContext.lanReachability.loopbackUrl.includes("127.0.0.1"), true);
});

test("LAN operator runtime report exposes reachability evidence after listen", async () => {
  const surface = createLanOperatorSurfaceServer({
    host: "127.0.0.1",
    port: 0,
    sessionId: "lan-operator-reachability-report",
    trustedLanOperatorMode: false,
    lanModeExplicitlyEnabled: false,
  });
  const { url } = await surface.listen();
  try {
    const reportBody = await (await fetch(new URL("/runtime/report", url))).json();
    const reachability = reportBody.report.summaries.surfaceContext.lanReachability;
    assert.equal(reachability.schema, "oneesama.lan_operator_reachability.v1");
    assert.equal(reachability.bindHost, "127.0.0.1");
    assert.equal(reachability.localOnlyMode, true);
    assert.equal(reachability.externallyReachableCandidate, false);
  } finally {
    await surface.close();
  }
});

test("LAN operator CLI refuses LAN exposure without trusted LAN opt-in", async () => {
  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["--import", "tsx", "packages/core/src/operator/lan-operator-surface-cli.ts"],
      {
        cwd: new URL("..", import.meta.url),
        env: {
          ...process.env,
          MAB_LAN_OPERATOR_HOST: "0.0.0.0",
          MAB_LAN_OPERATOR_PORT: "0",
          MAB_LAN_OPERATOR_ENABLE_TRUSTED_LAN: "",
          MAB_LAN_OPERATOR_TRUSTED_LAN: "",
        },
      },
    ),
    (error) => {
      const stderr = String(error.stderr || "");
      assert.match(stderr, /trusted_lan_operator_mode_not_enabled/);
      assert.match(stderr, /MAB_LAN_OPERATOR_ENABLE_TRUSTED_LAN=1/);
      return true;
    },
  );
});
