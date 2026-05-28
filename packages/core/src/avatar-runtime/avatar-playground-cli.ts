import { createAvatarPlaygroundServer } from "./avatar-playground.ts";

function envFlag(name: string, defaultValue = false) {
  const value = process.env[name];
  if (value == null || value === "") return defaultValue;
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

const playground = createAvatarPlaygroundServer({
  host: process.env.MAB_AVATAR_PLAYGROUND_HOST || "127.0.0.1",
  port: Number(process.env.MAB_AVATAR_PLAYGROUND_PORT || 18912),
  botName: process.env.MAB_AVATAR_PLAYGROUND_BOT_NAME || "Oneesama",
  avatar: {
    modelUrl: process.env.MAB_AVATAR_PLAYGROUND_MODEL_URL,
    vrmModelUrl: process.env.MAB_AVATAR_PLAYGROUND_VRM_MODEL_URL,
    live2dDepsDir: process.env.MAB_AVATAR_DEPS_DIR,
    disableLive2D: envFlag("MAB_AVATAR_PLAYGROUND_DISABLE_LIVE2D", false),
  },
});

const started = await playground.listen();
console.log(JSON.stringify({ ok: true, url: started.url }, null, 2));

async function shutdown(signal: string) {
  await playground.close();
  console.log(JSON.stringify({ ok: true, stopped: true, signal }, null, 2));
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
