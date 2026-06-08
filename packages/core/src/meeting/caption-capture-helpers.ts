import type { CaptionEvent } from "../browser-runtime-types.ts";

export const CAPTION_CONTAINERS = [
  'div[role="region"][aria-label="Captions"]',
  'div[role="region"][aria-label*="字幕"]',
  ".a4cQT",
];
export const SPEAKER_BADGE = ".NWpY1d, .xoMHSc, .zs7s8d";
export const INLINE_CAPTION_SETTINGS_SELECTOR = [
  'button[aria-label*="Open caption settings" i]',
  '[role="button"][aria-label*="Open caption settings" i]',
  'button[aria-label*="caption settings" i]',
  '[role="button"][aria-label*="caption settings" i]',
  'button[aria-label*="字幕设置" i]',
  '[role="button"][aria-label*="字幕设置" i]',
  'button[aria-label*="字幕設定" i]',
  '[role="button"][aria-label*="字幕設定" i]',
].join(", ");
export const CAPTION_LANGUAGE_LABEL = /Language of the meeting|meeting language|会议语言|會議語言/i;
export const CAPTION_LANGUAGE_COMBOBOX_XPATH = [
  "xpath=(",
  "//*[self::div or self::span or self::label]",
  "[contains(translate(normalize-space(.), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'language of the meeting')",
  " or contains(translate(normalize-space(.), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'meeting language')",
  " or contains(normalize-space(.), '会议语言')",
  " or contains(normalize-space(.), '會議語言')",
  "]",
  "/following::*[@role='combobox'][1]",
  ")[1]",
].join("");

export function nowIso(): string {
  return new Date().toISOString();
}

export function normalizeCaptionText(text: unknown): string {
  return String(text || "")
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" ")
    .trim();
}

export function isLocalMeetCaptionSpeaker(speaker: unknown): boolean {
  const normalized = normalizeCaptionText(speaker)
    .toLowerCase()
    .replace(/[：:]\s*$/, "");
  if (!normalized) return false;
  if (["you", "me", "myself", "我", "你", "您", "自己", "本人"].includes(normalized)) {
    return true;
  }
  return /^you\s*\(.+\)$/.test(normalized);
}

export function isCaptionSettingsUiText(text: unknown): boolean {
  const normalized = normalizeCaptionText(text);
  if (!normalized) return true;
  return /^(English|Chinese, Mandarin \(Simplified\)|Chinese \(Simplified\)|Chinese \(Traditional\)|Japanese|Korean|French|German|Spanish|Portuguese|Italian|Dutch|Russian)$/i.test(
    normalized,
  );
}

export function compactCaptionEvent(event: CaptionEvent): CaptionEvent {
  return {
    ts: event.ts,
    speaker: event.speaker,
    text: event.text,
    streamId: event.streamId,
    source: event.source || "google-meet-caption-dom",
  };
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
