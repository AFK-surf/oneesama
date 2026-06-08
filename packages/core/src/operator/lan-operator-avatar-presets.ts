import type { HiyoriAvatarConfig } from "../browser-runtime-types.ts";

export const LAN_OPERATOR_AVATAR_PRESET_IDS = [
  "fallback-canvas",
  "hiyori-live2d",
  "oneesama-video",
] as const;

export type LanOperatorAvatarPresetId = (typeof LAN_OPERATOR_AVATAR_PRESET_IDS)[number];

export const DEFAULT_LAN_OPERATOR_AVATAR_PRESET: LanOperatorAvatarPresetId = "fallback-canvas";

const VIDEO_IDLE_URL = "/assets/avatar/v1-green/oneesama-video-idle-loop-subtle.mp4";
const VIDEO_SPEAKING_URL = "/assets/avatar/v1-green/oneesama-video-speaking-loop-slit.mp4";

export interface LanOperatorAvatarPreset {
  id: LanOperatorAvatarPresetId;
  name: string;
  shortName: string;
  renderer: string;
  config: HiyoriAvatarConfig;
}

export const LAN_OPERATOR_AVATAR_PRESETS: LanOperatorAvatarPreset[] = [
  {
    id: "fallback-canvas",
    name: "Fallback Canvas",
    shortName: "Fallback",
    renderer: "fallback",
    config: {
      avatarRenderer: "live2d",
      disableLive2D: true,
      background: "#e9edf2",
    },
  },
  {
    id: "hiyori-live2d",
    name: "Hiyori Live2D",
    shortName: "Hiyori",
    renderer: "live2d",
    config: {
      avatarRenderer: "live2d",
      disableLive2D: false,
      background: "#12161d",
    },
  },
  {
    id: "oneesama-video",
    name: "Oneesama Video",
    shortName: "Video",
    renderer: "video",
    config: {
      avatarRenderer: "video",
      background: "#0b1018",
      videoObjectFit: "cover",
      videoMuted: true,
      videoCrossfadeMs: 220,
      videoSpeakingDebounceMs: 220,
      videoChromaKey: {
        enabled: true,
        keyColor: "#00ff00",
        similarity: 0.22,
        smoothness: 0.06,
        minGreen: 45,
        minDominance: 18,
        spill: 0.82,
        spillSoftness: 10,
        matteErodePx: 1,
        matteFeatherPx: 1,
      },
      videoSources: [
        {
          id: "idle",
          label: "Idle loop",
          state: "idle",
          url: VIDEO_IDLE_URL,
          objectFit: "cover",
          background: "#0b1018",
          default: true,
        },
        {
          id: "speaking",
          label: "Speaking loop",
          state: "speaking",
          url: VIDEO_SPEAKING_URL,
          objectFit: "cover",
          background: "#0b1018",
        },
      ],
    },
  },
];

const PRESET_BY_ID = new Map(LAN_OPERATOR_AVATAR_PRESETS.map((preset) => [preset.id, preset]));

export function normalizeLanOperatorAvatarPreset(value: unknown): LanOperatorAvatarPresetId {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "fallback" || normalized === "canvas") return "fallback-canvas";
  if (normalized === "live2d" || normalized === "hiyori") return "hiyori-live2d";
  if (normalized === "video") return "oneesama-video";
  if (LAN_OPERATOR_AVATAR_PRESET_IDS.includes(normalized as LanOperatorAvatarPresetId)) {
    return normalized as LanOperatorAvatarPresetId;
  }
  return DEFAULT_LAN_OPERATOR_AVATAR_PRESET;
}

export function lanOperatorAvatarPreset(value: unknown): LanOperatorAvatarPreset {
  return (
    PRESET_BY_ID.get(normalizeLanOperatorAvatarPreset(value)) || LAN_OPERATOR_AVATAR_PRESETS[0]
  );
}

export function lanOperatorAvatarPresetConfig(value: unknown): HiyoriAvatarConfig {
  return { ...lanOperatorAvatarPreset(value).config };
}
