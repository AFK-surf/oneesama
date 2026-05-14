import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readBrowserInitSource } from "../browser-init-source.ts";
import type { HiyoriAvatarConfig } from "../browser-runtime-types.ts";

interface AvatarInitScriptConfig extends HiyoriAvatarConfig {
  live2dDepsDir?: string;
  depsDir?: string;
}

function patchCubismCore(source) {
  return source
    .replace(/^\s*var Live2DCubismCore;/m, "")
    .replace(
      /Live2DCubismCore=Live2DCubismCore\|\|\{\}/g,
      "window.Live2DCubismCore=window.Live2DCubismCore||{}",
    );
}

function patchPixi(source) {
  return source.replace(/^(\s*\/\*[\s\S]*?\*\/)?\s*var PIXI=/m, (match) =>
    match.replace("var PIXI=", "window.PIXI="),
  );
}

function readRequiredFile(path) {
  if (!existsSync(path)) {
    throw new Error(`Avatar Live2D dependency not found: ${path}`);
  }
  return readFileSync(path, "utf8");
}

function buildInlineLive2DDeps(depsDir) {
  if (!depsDir) return "";

  const root = resolve(depsDir);
  const cubism = patchCubismCore(readRequiredFile(join(root, "live2dcubismcore.min.js")));
  const pixi = patchPixi(readRequiredFile(join(root, "pixi.min.js")));
  const pixiUnsafeEval = readRequiredFile(join(root, "pixi-unsafe-eval.min.js"));
  const pixiLive2D = readRequiredFile(join(root, "pixi-live2d-display-cubism4.min.js"));
  const pixiShim = [
    "(function(){",
    "  window.process = window.process || { env: { NODE_ENV: 'production' }, version: '', browser: true };",
    "  window.global = window.global || window;",
    "  const P = window.PIXI; if (!P) return;",
    "  if (P.utils && P.utils.EventEmitter && !P.EventEmitter) P.EventEmitter = P.utils.EventEmitter;",
    "})();",
  ].join("\n");

  return [
    "window.MAB_AVATAR_INLINE_LIVE2D_DEPS = true;",
    "window.process = window.process || { env: { NODE_ENV: 'production' }, version: '', browser: true };",
    "window.global = window.global || window;",
    cubism,
    pixi,
    pixiUnsafeEval,
    pixiShim,
    pixiLive2D,
  ].join("\n");
}

export function buildAvatarInitScript(config: AvatarInitScriptConfig = {}) {
  const runtimeConfig = { ...config };
  const depsDir =
    runtimeConfig.live2dDepsDir || runtimeConfig.depsDir || process.env.MAB_AVATAR_DEPS_DIR || "";
  delete runtimeConfig.live2dDepsDir;
  delete runtimeConfig.depsDir;

  const source = readBrowserInitSource(
    import.meta.url,
    "./hiyori-avatar-inject.js",
    "./hiyori-avatar-inject.ts",
  );
  return [
    buildInlineLive2DDeps(depsDir),
    `window.MAB_AVATAR_CONFIG = ${JSON.stringify(runtimeConfig)};`,
    source,
  ]
    .filter(Boolean)
    .join("\n");
}
