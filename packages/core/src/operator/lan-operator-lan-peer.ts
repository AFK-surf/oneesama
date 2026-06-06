export type LanPeerKind = "events" | "voice" | "visual_operator" | "visual_host";

export type LanPeerConnectionEvidence = {
  id: string;
  kind: LanPeerKind;
  remoteAddress: string;
  normalizedAddress: string;
  remotePort: number | null;
  remoteFamily: string | null;
  loopback: boolean;
  privateLan: boolean;
  connectedAt: string;
  lastPacketAt: string | null;
  disconnectedAt: string | null;
  state: "open" | "closed";
};

function ipv4Parts(address: string) {
  const parts = address.split(".").map((part) => Number(part));
  return parts.length === 4 &&
    parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? parts
    : null;
}

export function normalizeLanPeerAddress(address: unknown) {
  const raw = String(address || "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (raw.startsWith("::ffff:")) return raw.slice("::ffff:".length);
  if (raw === "0:0:0:0:0:0:0:1") return "::1";
  return raw;
}

export function isLoopbackLanPeerAddress(address: unknown) {
  const normalized = normalizeLanPeerAddress(address);
  const parts = ipv4Parts(normalized);
  if (parts) return parts[0] === 127;
  return normalized === "localhost" || normalized === "::1";
}

export function isPrivateLanPeerAddress(address: unknown) {
  const normalized = normalizeLanPeerAddress(address);
  const parts = ipv4Parts(normalized);
  if (parts) {
    const [first, second] = parts;
    return (
      first === 10 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 169 && second === 254)
    );
  }
  return (
    normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:")
  );
}

function summarizeKind(peers: LanPeerConnectionEvidence[], kind: LanPeerKind) {
  const active = peers.filter((peer) => peer.kind === kind && peer.state === "open");
  return {
    activeCount: active.length,
    nonLoopbackCount: active.filter((peer) => !peer.loopback).length,
    privateLanCount: active.filter((peer) => peer.privateLan).length,
  };
}

function publicPeer(peer: LanPeerConnectionEvidence) {
  return {
    id: peer.id,
    kind: peer.kind,
    remoteAddress: peer.normalizedAddress,
    remotePort: peer.remotePort,
    remoteFamily: peer.remoteFamily,
    loopback: peer.loopback,
    privateLan: peer.privateLan,
    connectedAt: peer.connectedAt,
    lastPacketAt: peer.lastPacketAt,
    disconnectedAt: peer.disconnectedAt,
    state: peer.state,
  };
}

export function buildLanPeerEvidenceSummary(
  peers: LanPeerConnectionEvidence[],
  now = new Date().toISOString(),
) {
  const recentPeers = peers.slice(-80);
  const activePeers = recentPeers.filter((peer) => peer.state === "open");
  const operatorPeers = activePeers.filter((peer) =>
    ["events", "voice", "visual_operator"].includes(peer.kind),
  );
  return {
    schema: "oneesama.lan_peer_evidence.v1",
    updatedAt: now,
    totalConnectionCount: recentPeers.length,
    activeConnectionCount: activePeers.length,
    nonLoopbackPeerCount: activePeers.filter((peer) => !peer.loopback).length,
    privateLanPeerCount: activePeers.filter((peer) => peer.privateLan).length,
    operatorNonLoopbackPeerCount: operatorPeers.filter((peer) => !peer.loopback).length,
    operatorPrivateLanPeerCount: operatorPeers.filter((peer) => peer.privateLan).length,
    byKind: {
      events: summarizeKind(recentPeers, "events"),
      voice: summarizeKind(recentPeers, "voice"),
      visual_operator: summarizeKind(recentPeers, "visual_operator"),
      visual_host: summarizeKind(recentPeers, "visual_host"),
    },
    activePeers: activePeers.map(publicPeer),
    recentPeers: recentPeers.map(publicPeer),
  };
}

export function createLanPeerEvidenceTracker() {
  const peers: LanPeerConnectionEvidence[] = [];

  function summary() {
    return buildLanPeerEvidenceSummary(peers);
  }

  return {
    connected(input: {
      id: string;
      kind: LanPeerKind;
      remoteAddress?: string | null;
      remotePort?: number | null;
      remoteFamily?: string | null;
    }) {
      const remoteAddress = String(input.remoteAddress || "");
      const peer: LanPeerConnectionEvidence = {
        id: input.id,
        kind: input.kind,
        remoteAddress,
        normalizedAddress: normalizeLanPeerAddress(remoteAddress),
        remotePort: Number.isFinite(Number(input.remotePort)) ? Number(input.remotePort) : null,
        remoteFamily: input.remoteFamily || null,
        loopback: isLoopbackLanPeerAddress(remoteAddress),
        privateLan: isPrivateLanPeerAddress(remoteAddress),
        connectedAt: new Date().toISOString(),
        lastPacketAt: null,
        disconnectedAt: null,
        state: "open",
      };
      peers.push(peer);
      if (peers.length > 120) peers.splice(0, peers.length - 120);
      return summary();
    },
    packet(id: string) {
      const peer = peers.findLast((entry) => entry.id === id);
      if (peer) peer.lastPacketAt = new Date().toISOString();
      return summary();
    },
    closed(id: string) {
      const peer = peers.findLast((entry) => entry.id === id);
      if (peer) {
        peer.state = "closed";
        peer.disconnectedAt = new Date().toISOString();
      }
      return summary();
    },
    summary,
  };
}
