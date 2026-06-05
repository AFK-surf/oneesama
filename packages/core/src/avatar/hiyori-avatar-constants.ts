export const DEFAULT_HIYORI_MODEL_URL =
  "https://fastly.jsdelivr.net/gh/Live2D/CubismWebSamples@develop/Samples/Resources/Hiyori/Hiyori.model3.json";
export const DEFAULT_HIYORI_MODEL_FALLBACK_URLS = [
  "https://cdn.jsdelivr.net/gh/Live2D/CubismWebSamples@develop/Samples/Resources/Hiyori/Hiyori.model3.json",
  "https://gcore.jsdelivr.net/gh/Live2D/CubismWebSamples@develop/Samples/Resources/Hiyori/Hiyori.model3.json",
  "https://raw.githubusercontent.com/Live2D/CubismWebSamples/develop/Samples/Resources/Hiyori/Hiyori.model3.json",
];
export const DEFAULT_VRM_MODEL_URL =
  "https://raw.githubusercontent.com/trinhtanphat/AMI-Chat-AI/main/public/models/3d/Sendagaya_Shibu.vrm";
export const DEFAULT_THREE_MODULE_URL = "https://esm.sh/three@0.164.1";
export const DEFAULT_GLTF_LOADER_MODULE_URL =
  "https://esm.sh/three@0.164.1/examples/jsm/loaders/GLTFLoader.js";
export const DEFAULT_THREE_VRM_MODULE_URL =
  "https://esm.sh/@pixiv/three-vrm@2.1.3?deps=three@0.164.1";
export const ALLOWED_MOODS = ["neutral", "happy", "surprised", "thinking", "sad", "shy"];
export const ALLOWED_ACTIONS = [
  "idle",
  "nod",
  "shake",
  "wave",
  "think",
  "lean_forward",
  "emphasize",
  "shrug",
  "speak",
];
export const ALLOWED_STATUS_KINDS = [
  "idle",
  "thinking",
  "writing_code",
  "opening_preview",
  "blocked",
  "done",
];
export const STATUS_LABELS: Record<string, string> = {
  idle: "",
  thinking: "Thinking",
  writing_code: "Writing code",
  opening_preview: "Opening preview",
  blocked: "Blocked",
  done: "Done",
};
export const EXPRESSION_PRESETS = {
  neutral: {
    ParamMouthForm: 0,
    ParamMouthOpenY: 0,
    ParamEyeOpen: 1,
    ParamEyeSmile: 0,
    ParamCheek: 0,
    ParamBrowAngle: 0,
    ParamBrowY: 0,
  },
  happy: {
    ParamMouthForm: 1,
    ParamMouthOpenY: 0.16,
    ParamEyeOpen: 0.82,
    ParamEyeSmile: 1,
    ParamCheek: 1,
    ParamBrowAngle: 0.55,
    ParamBrowY: 0.28,
  },
  surprised: {
    ParamMouthForm: 0.05,
    ParamMouthOpenY: 0.42,
    ParamEyeOpen: 1.45,
    ParamEyeSmile: 0,
    ParamCheek: 0.25,
    ParamBrowAngle: 1.1,
    ParamBrowY: 0.75,
  },
  thinking: {
    ParamMouthForm: 0.12,
    ParamMouthOpenY: 0.05,
    ParamEyeOpen: 0.72,
    ParamEyeSmile: 0,
    ParamCheek: 0,
    ParamBrowAngle: -0.75,
    ParamBrowY: -0.32,
  },
  sad: {
    ParamMouthForm: -1,
    ParamMouthOpenY: 0.04,
    ParamEyeOpen: 0.58,
    ParamEyeSmile: 0,
    ParamCheek: 0,
    ParamBrowAngle: -1.05,
    ParamBrowY: -0.52,
  },
  shy: {
    ParamMouthForm: 0.45,
    ParamMouthOpenY: 0.06,
    ParamEyeOpen: 0.55,
    ParamEyeSmile: 0.62,
    ParamCheek: 1,
    ParamBrowAngle: -0.65,
    ParamBrowY: -0.22,
  },
};
export const ACTION_DURATIONS_MS: Record<string, number> = {
  idle: 200,
  nod: 1000,
  shake: 1000,
  wave: 1700,
  think: 2200,
  lean_forward: 1400,
  emphasize: 1100,
  shrug: 1200,
  speak: 1800,
};

export function clamp(value: unknown, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

export function clamp01(value: unknown): number {
  return clamp(value, 0, 1);
}

export function normalizeEnum(
  value: unknown,
  allowed: readonly string[],
  fallback: string,
): string {
  const normalized = String(value || fallback);
  return allowed.includes(normalized) ? normalized : fallback;
}
