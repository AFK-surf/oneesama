import { createLanOperatorSurfaceServer } from "./lan-operator-surface.ts";
import { loadLanOperatorBackendLiveEnv } from "./lan-operator-backend-live-env.ts";
import { resolveLanOperatorConversationTransport } from "./lan-operator-conversation-transport.ts";
import { parseLanOperatorWebrtcIceServers } from "./lan-operator-runtime-config.ts";
import { decideTrustedLanOperatorMode } from "./lan-operator-trusted-lan.ts";
import {
  buildLanOperatorSurfaceAutostartUrls,
  launchLanOperatorSurfaceAutostartUrls,
  parseLanOperatorSurfaceAutostartConfig,
} from "./lan-operator-surface-autostart.ts";

function printHelp() {
  console.log(`Usage: vp run dev:local-operator -- [options]

Starts the Local Operator Surface. By default it opens the operator UI plus a
real avatar publisher so the foreground default is an actual running surface.

Options:
  --no-open                    Testing/CI: do not open browser windows
  --no-open-operator           Do not auto-open /operator
  --no-auto-avatar-publisher   Testing/CI: do not auto-open the avatar publisher
  --avatar-preset <preset>     Avatar publisher preset:
                               fallback-canvas | hiyori-live2d | oneesama-video
  --open                       Re-enable browser opening when env disabled it
  --open-operator              Re-enable operator page opening
  --auto-avatar-publisher      Re-enable avatar publisher opening

Env:
  MAB_LAN_OPERATOR_OPEN_BROWSER=0          Testing/CI: no browser windows
  MAB_LAN_OPERATOR_AUTO_AVATAR_PUBLISHER=0 Testing/CI: no avatar publisher
  MAB_LAN_OPERATOR_AVATAR_PRESET=<preset>  Default avatar publisher preset
  MAB_LAN_OPERATOR_TRANSPORT=gemini_live   Try Gemini Live / Gemini 3.1 Flash Live
  MAB_LAN_OPERATOR_TRANSPORT=openai_realtime
                                           Try OpenAI Realtime
  MAB_LAN_OPERATOR_TRANSPORT=mock          Testing/diagnostics: force local engine
  ONEESAMA_LIVE_DEFAULT_ENV_DIR=<dir>      Backend live env directory
`);
}

const cliArgs = process.argv.slice(2);
if (cliArgs.includes("--help") || cliArgs.includes("-h")) {
  printHelp();
  process.exit(0);
}

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

const backendLiveEnv = loadLanOperatorBackendLiveEnv();
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
const autostart = parseLanOperatorSurfaceAutostartConfig(cliArgs);
const autostartUrls = buildLanOperatorSurfaceAutostartUrls(started.url, autostart);
const autostartLaunches = launchLanOperatorSurfaceAutostartUrls(autostartUrls);
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
      backendLiveEnv,
      localOnlyMode: trustedLanMode.localOnlyMode,
      trustedLanOperatorMode: trustedLanMode.trustedLanOperatorMode,
      lanModeExplicitlyEnabled: trustedLanMode.lanModeExplicitlyEnabled,
      inputPolicy: surface.config.inputPolicy,
      outputPolicy: surface.config.outputPolicy,
      webrtcIceServers,
      autostart: {
        ...autostart,
        urls: autostartUrls,
        launches: autostartLaunches,
      },
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
