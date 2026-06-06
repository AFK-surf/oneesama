import { createLanOperatorSurfaceServer } from "./lan-operator-surface.ts";
import { resolveLanOperatorConversationTransport } from "./lan-operator-conversation-transport.ts";
import { parseLanOperatorWebrtcIceServers } from "./lan-operator-runtime-config.ts";
import { decideTrustedLanOperatorMode } from "./lan-operator-trusted-lan.ts";

const host =
  process.env.MAB_LOCAL_OPERATOR_HOST || process.env.MAB_LAN_OPERATOR_HOST || "127.0.0.1";
const trustedLanMode = decideTrustedLanOperatorMode({ host });
if (!trustedLanMode.allowed) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: trustedLanMode.blocker,
        hint: trustedLanMode.hint,
        bindHost: trustedLanMode.bindHost,
        localOnlyMode: trustedLanMode.localOnlyMode,
        trustedLanOperatorMode: trustedLanMode.trustedLanOperatorMode,
        lanModeExplicitlyEnabled: trustedLanMode.lanModeExplicitlyEnabled,
      },
      null,
      2,
    ),
  );
  process.exit(1);
}

const conversationTransportSelection = resolveLanOperatorConversationTransport();
const webrtcIceServers = parseLanOperatorWebrtcIceServers(
  process.env.MAB_LAN_OPERATOR_WEBRTC_ICE_SERVERS,
);
const surface = createLanOperatorSurfaceServer({
  host,
  port: Number(process.env.MAB_LOCAL_OPERATOR_PORT || process.env.MAB_LAN_OPERATOR_PORT || 18913),
  sessionId: process.env.MAB_LOCAL_OPERATOR_SESSION_ID || process.env.MAB_LAN_OPERATOR_SESSION_ID,
  botName:
    process.env.MAB_LOCAL_OPERATOR_BOT_NAME || process.env.MAB_LAN_OPERATOR_BOT_NAME || "Oneesama",
  conversationTransport: conversationTransportSelection.transport,
  conversationTransportSelection,
  webrtcIceServers,
  trustedLanOperatorMode: trustedLanMode.trustedLanOperatorMode,
  lanModeExplicitlyEnabled: trustedLanMode.lanModeExplicitlyEnabled,
});

const started = await surface.listen();
const status = surface.status();
const debug = status.debug as { surfaceContext?: { lanReachability?: unknown } } | undefined;
console.log(
  JSON.stringify(
    {
      ok: true,
      url: started.url,
      lanReachability: debug?.surfaceContext?.lanReachability || null,
      bindHost: started.bindHost,
      sessionId: surface.config.sessionId,
      surfaceKind: surface.config.surfaceKind,
      conversationTransport: surface.config.conversationTransport,
      conversationTransportSelection,
      localOnlyMode: trustedLanMode.localOnlyMode,
      trustedLanOperatorMode: trustedLanMode.trustedLanOperatorMode,
      lanModeExplicitlyEnabled: trustedLanMode.lanModeExplicitlyEnabled,
      inputPolicy: surface.config.inputPolicy,
      outputPolicy: surface.config.outputPolicy,
      webrtcIceServers,
    },
    null,
    2,
  ),
);

async function shutdown(signal: string) {
  await surface.close();
  console.log(JSON.stringify({ ok: true, stopped: true, signal }, null, 2));
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
