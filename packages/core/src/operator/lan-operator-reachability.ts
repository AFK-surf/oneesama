import { networkInterfaces } from "node:os";

import { isPrivateLanPeerAddress, normalizeLanPeerAddress } from "./lan-operator-lan-peer.ts";
import { isLoopbackLanOperatorHost } from "./lan-operator-trusted-lan.ts";

type InterfaceAddress = {
  address?: string;
  family?: string | number;
  internal?: boolean;
};

type InterfaceMap = Record<string, InterfaceAddress[] | undefined>;

export type LanOperatorReachabilityInput = {
  bindHost: string;
  port: number;
  trustedLanOperatorMode: boolean;
  lanModeExplicitlyEnabled: boolean;
  interfaces?: InterfaceMap;
};

function isIpv4Address(entry: InterfaceAddress) {
  return entry.family === "IPv4" || entry.family === 4;
}

function hostForUrl(address: string) {
  return address.includes(":") ? `[${address}]` : address;
}

function bindMode(bindHost: string, localOnlyMode: boolean) {
  const normalized = normalizeLanPeerAddress(bindHost);
  if (localOnlyMode) return "loopback";
  if (normalized === "0.0.0.0" || normalized === "::") return "wildcard";
  return isPrivateLanPeerAddress(normalized) ? "explicit_lan" : "explicit_non_lan";
}

function discoveredLanAddresses(interfaces: InterfaceMap) {
  const addresses = Object.values(interfaces)
    .flatMap((entries) => entries || [])
    .filter((entry) => !entry.internal && isIpv4Address(entry))
    .map((entry) => normalizeLanPeerAddress(entry.address))
    .filter(
      (address) =>
        address && !isLoopbackLanOperatorHost(address) && isPrivateLanPeerAddress(address),
    );
  return [...new Set(addresses)];
}

export function buildLanOperatorReachability(input: LanOperatorReachabilityInput) {
  const bindHost = String(input.bindHost || "0.0.0.0").trim() || "0.0.0.0";
  const port = Number(input.port || 0);
  const localOnlyMode = isLoopbackLanOperatorHost(bindHost);
  const mode = bindMode(bindHost, localOnlyMode);
  const interfaces = input.interfaces || (networkInterfaces() as InterfaceMap);
  const explicitAddress =
    !localOnlyMode && mode !== "wildcard" ? [normalizeLanPeerAddress(bindHost)] : [];
  const lanAddresses = mode === "wildcard" ? discoveredLanAddresses(interfaces) : explicitAddress;
  const lanUrls = lanAddresses.map((address) => `http://${hostForUrl(address)}:${port}/`);
  const loopbackUrl = `http://127.0.0.1:${port}/`;
  const blockers = [];
  if (!localOnlyMode && !input.trustedLanOperatorMode)
    blockers.push("trusted_lan_operator_mode_not_enabled");
  if (!localOnlyMode && lanUrls.length === 0) blockers.push("no_private_lan_address_detected");
  return {
    schema: "oneesama.lan_operator_reachability.v1",
    bindHost,
    bindMode: mode,
    port,
    localOnlyMode,
    trustedLanOperatorMode: input.trustedLanOperatorMode,
    lanModeExplicitlyEnabled: input.lanModeExplicitlyEnabled,
    loopbackUrl,
    lanUrls,
    primaryLanUrl: lanUrls[0] || null,
    advertisedUrl: lanUrls[0] || loopbackUrl,
    lanAddressCount: lanUrls.length,
    externallyReachableCandidate:
      !localOnlyMode && input.trustedLanOperatorMode && lanUrls.length > 0,
    blockers,
  };
}
