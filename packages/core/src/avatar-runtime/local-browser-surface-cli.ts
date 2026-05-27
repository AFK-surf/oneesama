import { createLocalBrowserSurfaceServer } from "./local-browser-surface.ts";

function envFlag(name: string, defaultValue = false) {
  const value = process.env[name];
  if (value == null || value === "") return defaultValue;
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

const surface = createLocalBrowserSurfaceServer({
  host: process.env.MAB_LOCAL_AVATAR_HOST || "127.0.0.1",
  port: Number(process.env.MAB_LOCAL_AVATAR_PORT || 18911),
  sessionId: process.env.MAB_LOCAL_AVATAR_SESSION_ID,
  botName: process.env.MAB_LOCAL_AVATAR_BOT_NAME || "Oneesama",
  avatar: {
    avatarRenderer: process.env.MAB_LOCAL_AVATAR_RENDERER || "live2d",
    modelUrl: process.env.MAB_LOCAL_AVATAR_MODEL_URL,
    vrmModelUrl: process.env.MAB_LOCAL_AVATAR_VRM_MODEL_URL,
    live2dDepsDir: process.env.MAB_AVATAR_DEPS_DIR,
    disableLive2D: envFlag("MAB_LOCAL_AVATAR_DISABLE_LIVE2D", false),
  },
});

const started = await surface.listen();
console.log(
  JSON.stringify(
    {
      ok: true,
      url: started.url,
      sessionId: surface.config.sessionId,
      surfaceKind: surface.config.surfaceKind,
      conversationTransport: surface.config.conversationTransport,
      inputPolicy: surface.config.inputPolicy,
      outputPolicy: surface.config.outputPolicy,
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
