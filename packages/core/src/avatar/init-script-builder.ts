import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
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

let cachedInlineVRMDeps = "";

function shouldInlineVRMDeps(config: AvatarInitScriptConfig) {
  const renderer = String(config.avatarRenderer || "vrm").toLowerCase();
  return renderer === "vrm" || renderer === "3d";
}

function buildInlineVRMDeps() {
  if (cachedInlineVRMDeps) return cachedInlineVRMDeps;

  const result = buildSync({
    stdin: {
      contents: [
        "import * as THREE from 'three';",
        "import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';",
        "import { VRMLoaderPlugin, VRMUtils, VRMExpressionPresetName, VRMHumanBoneName } from '@pixiv/three-vrm';",
        "window.MAB_AVATAR_THREE_VRM_DEPS = { THREE, GLTFLoader, VRMLoaderPlugin, VRMUtils, VRMExpressionPresetName, VRMHumanBoneName };",
      ].join("\n"),
      resolveDir: resolve(fileURLToPath(new URL("../../../..", import.meta.url))),
      sourcefile: "mab-avatar-vrm-deps.js",
      loader: "js",
    },
    bundle: true,
    format: "iife",
    globalName: "MABAvatarVRMDepsBundle",
    logLevel: "silent",
    minify: true,
    platform: "browser",
    target: "es2020",
    write: false,
  });

  const bundle = result.outputFiles?.[0]?.text || "";
  if (!bundle) throw new Error("build VRM dependency bundle produced no output");
  cachedInlineVRMDeps = [
    "window.MAB_AVATAR_INLINE_VRM_DEPS = true;",
    bundle,
  ].join("\n");
  return cachedInlineVRMDeps;
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
    shouldInlineVRMDeps(runtimeConfig) ? buildInlineVRMDeps() : "",
    `window.MAB_AVATAR_CONFIG = ${JSON.stringify(runtimeConfig)};`,
    source,
  ]
    .filter(Boolean)
    .join("\n");
}
