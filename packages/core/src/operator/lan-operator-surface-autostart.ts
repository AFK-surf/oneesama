import { spawn, type ChildProcess } from "node:child_process";
import {
  DEFAULT_LAN_OPERATOR_AVATAR_PRESET,
  normalizeLanOperatorAvatarPreset,
  type LanOperatorAvatarPresetId,
} from "./lan-operator-avatar-presets.ts";

export interface LanOperatorSurfaceAutostartConfig {
  openBrowser: boolean;
  openOperator: boolean;
  autoAvatarPublisher: boolean;
  avatarPreset: LanOperatorAvatarPresetId;
}

export interface LanOperatorSurfaceAutostartUrl {
  kind: "operator";
  url: string;
}

export interface LanOperatorSurfaceAutostartLaunch {
  kind: LanOperatorSurfaceAutostartUrl["kind"];
  url: string;
  command: string;
  args: string[];
  launched: boolean;
  error: string | null;
}

function envFlag(value: unknown): boolean | null {
  if (value == null || value === "") return null;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off", "none"].includes(normalized)) return false;
  return null;
}

export function parseLanOperatorSurfaceAutostartConfig(
  argv: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): LanOperatorSurfaceAutostartConfig {
  const openBrowser = envFlag(env.MAB_LAN_OPERATOR_OPEN_BROWSER) ?? true;
  const openOperator = envFlag(env.MAB_LAN_OPERATOR_OPEN_OPERATOR) ?? true;
  const autoAvatarPublisher = envFlag(env.MAB_LAN_OPERATOR_AUTO_AVATAR_PUBLISHER) ?? true;
  const avatarPreset = normalizeLanOperatorAvatarPreset(
    env.MAB_LAN_OPERATOR_AVATAR_PRESET || env.MAB_LAN_OPERATOR_AVATAR_RENDERER,
  );
  const config = { openBrowser, openOperator, autoAvatarPublisher, avatarPreset };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--no-open") {
      config.openBrowser = false;
      config.openOperator = false;
      config.autoAvatarPublisher = false;
    } else if (arg === "--open") {
      config.openBrowser = true;
    } else if (arg === "--no-open-operator") {
      config.openOperator = false;
    } else if (arg === "--open-operator") {
      config.openOperator = true;
    } else if (arg === "--no-auto-avatar-publisher") {
      config.autoAvatarPublisher = false;
    } else if (arg === "--auto-avatar-publisher") {
      config.autoAvatarPublisher = true;
    } else if (arg === "--avatar-preset" || arg === "--avatar-renderer") {
      index += 1;
      config.avatarPreset = normalizeLanOperatorAvatarPreset(
        argv[index] || DEFAULT_LAN_OPERATOR_AVATAR_PRESET,
      );
    } else if (arg.startsWith("--avatar-preset=")) {
      config.avatarPreset = normalizeLanOperatorAvatarPreset(arg.slice("--avatar-preset=".length));
    } else if (arg.startsWith("--avatar-renderer=")) {
      config.avatarPreset = normalizeLanOperatorAvatarPreset(
        arg.slice("--avatar-renderer=".length),
      );
    }
  }
  if (!config.openBrowser) {
    config.openOperator = false;
    config.autoAvatarPublisher = false;
  }
  return config;
}

export function buildLanOperatorSurfaceAutostartUrls(
  baseUrl: string,
  config: LanOperatorSurfaceAutostartConfig,
): LanOperatorSurfaceAutostartUrl[] {
  if (!config.openBrowser) return [];
  const urls: LanOperatorSurfaceAutostartUrl[] = [];
  if (config.openOperator) {
    const operatorUrl = new URL("/operator", baseUrl);
    if (config.autoAvatarPublisher) {
      operatorUrl.searchParams.set("autoAvatarPublisher", "1");
      operatorUrl.searchParams.set("avatarPreset", config.avatarPreset);
    }
    urls.push({ kind: "operator", url: operatorUrl.toString() });
  }
  return urls;
}

function openCommandForPlatform(
  url: string,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", "", url] };
  return { command: "xdg-open", args: [url] };
}

export function launchLanOperatorSurfaceAutostartUrls(
  urls: LanOperatorSurfaceAutostartUrl[],
  input: {
    platform?: NodeJS.Platform;
    spawnImpl?: typeof spawn;
  } = {},
): LanOperatorSurfaceAutostartLaunch[] {
  const spawnImpl = input.spawnImpl || spawn;
  return urls.map((entry) => {
    const { command, args } = openCommandForPlatform(entry.url, input.platform);
    try {
      const child = spawnImpl(command, args, {
        detached: true,
        stdio: "ignore",
      }) as ChildProcess;
      child.unref?.();
      return { ...entry, command, args, launched: true, error: null };
    } catch (error) {
      return {
        ...entry,
        command,
        args,
        launched: false,
        error: String(error instanceof Error ? error.message : error),
      };
    }
  });
}
