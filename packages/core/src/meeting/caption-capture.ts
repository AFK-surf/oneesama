import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join as pathJoin } from "node:path";
import type { CaptionCaptureState, CaptionEvent, LocalDialogInput } from "../browser-runtime-types.ts";

const CAPTION_CONTAINERS = [
  'div[role="region"][aria-label="Captions"]',
  'div[role="region"][aria-label*="字幕"]',
  ".a4cQT",
];

const SPEAKER_BADGE = ".NWpY1d, .xoMHSc, .zs7s8d";
const INLINE_CAPTION_SETTINGS_SELECTOR = [
  'button[aria-label*="Open caption settings" i]',
  '[role="button"][aria-label*="Open caption settings" i]',
  'button[aria-label*="caption settings" i]',
  '[role="button"][aria-label*="caption settings" i]',
  'button[aria-label*="字幕设置" i]',
  '[role="button"][aria-label*="字幕设置" i]',
  'button[aria-label*="字幕設定" i]',
  '[role="button"][aria-label*="字幕設定" i]',
].join(", ");
const CAPTION_LANGUAGE_LABEL = /Language of the meeting|meeting language|会议语言|會議語言/i;
const CAPTION_LANGUAGE_COMBOBOX_XPATH = [
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
type Diagnostics = { record?: (type: string, detail?: Record<string, unknown>) => void } | null;
type CaptionToggleProbe = {
  ok: boolean;
  alreadyOn?: boolean;
  candidateIndex?: number;
  candidates: Array<{ index: number; aria: string; text: string; visible: boolean }>;
  error?: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeCaptionText(text: unknown): string {
  return String(text || "")
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" ")
    .trim();
}

function isLocalMeetCaptionSpeaker(speaker: unknown): boolean {
  const normalized = normalizeCaptionText(speaker)
    .toLowerCase()
    .replace(/[：:]\s*$/, "");
  if (!normalized) return false;
  if (["you", "me", "myself", "我", "你", "您", "自己", "本人"].includes(normalized)) {
    return true;
  }
  return /^you\s*\(.+\)$/.test(normalized);
}

function isCaptionSettingsUiText(text: unknown): boolean {
  const normalized = normalizeCaptionText(text);
  if (!normalized) return true;
  return /^(English|Chinese, Mandarin \(Simplified\)|Chinese \(Simplified\)|Chinese \(Traditional\)|Japanese|Korean|French|German|Spanish|Portuguese|Italian|Dutch|Russian)$/i.test(normalized);
}

function compactCaptionEvent(event: CaptionEvent): CaptionEvent {
  return {
    ts: event.ts,
    speaker: event.speaker,
    text: event.text,
    streamId: event.streamId,
    source: event.source || "google-meet-caption-dom",
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function enableMeetCaptions(
  page: import("playwright").Page,
  {
    captionLanguage = "",
    diagnostics = null,
  }: { captionLanguage?: string; diagnostics?: Diagnostics } = {},
) {
  const wantsLanguage = Boolean(captionLanguage.trim());
  const direct: CaptionToggleProbe = await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll<HTMLElement>("button, [role=button]"));
    const candidates = nodes
      .map((node, index) => {
        const rect = node.getBoundingClientRect();
        const aria = node.getAttribute("aria-label") || "";
        const text = (node.innerText || node.textContent || "").trim();
        const visible = rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== "hidden";
        return { index, aria, text, visible };
      })
      .filter((button) => button.visible && /caption|captions|字幕/i.test(`${button.aria} ${button.text}`));
    const alreadyOn = candidates.find((button) => /turn off|hide captions|关闭字幕|停用字幕/i.test(`${button.aria} ${button.text}`));
    const turnOn = candidates.find((button) => /turn on|show captions|开启字幕|显示字幕/i.test(`${button.aria} ${button.text}`)) || candidates[0];
    return {
      ok: true,
      alreadyOn: Boolean(alreadyOn),
      candidateIndex: turnOn?.index ?? -1,
      candidates: candidates.slice(0, 8),
    };
  }).catch((error: unknown) => ({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    candidates: [],
  }));

  diagnostics?.record("caption_toggle_candidates", direct);
  if (direct.ok && direct.alreadyOn) {
    if (!wantsLanguage) return { ok: true, method: "direct", alreadyOn: true, candidates: direct.candidates };
    const settings = await enableCaptionsViaSettings(page, captionLanguage, diagnostics, { enableLiveCaptions: false });
    return settings.ok
      ? { ...settings, alreadyOn: true, direct }
      : {
          ok: false,
          method: "direct+settings-language",
          alreadyOn: true,
          candidates: direct.candidates,
          direct,
          language: settings,
        };
  }

  if (direct.ok && direct.candidateIndex >= 0) {
    const clicked = await page.evaluate((index) => {
      const node = Array.from(document.querySelectorAll<HTMLElement>("button, [role=button]"))[index];
      if (!node) return false;
      node.click();
      return true;
    }, direct.candidateIndex).catch(() => false);
    if (clicked) {
      await page.waitForTimeout(1000);
      if (wantsLanguage) {
        const settings = await enableCaptionsViaSettings(page, captionLanguage, diagnostics, { enableLiveCaptions: false });
        if (settings.ok)
          return { ...settings, method: "direct+settings-language", clicked: true, direct };
        return { ok: false, method: "direct+settings-language", clicked: true, direct, language: settings };
      }
      return { ok: true, method: "direct", clicked: true, candidates: direct.candidates };
    }
  }

  const settings = await enableCaptionsViaSettings(page, captionLanguage, diagnostics, { enableLiveCaptions: true });
  return settings.ok ? settings : { ok: false, method: "settings", direct, settings };
}

async function enableCaptionsViaSettings(
  page: import("playwright").Page,
  captionLanguage: string,
  diagnostics: Diagnostics,
  { enableLiveCaptions = true }: { enableLiveCaptions?: boolean } = {},
) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const settingsPath = await openCaptionSettingsPanel(page, { preferInline: attempt === 0 });

      if (captionLanguage) {
        await selectLiveCaptionsMode(page);
        diagnostics?.record("caption_settings_inventory_before_language", await inspectCaptionSettingsPanel(page).catch((error) => ({ error: String(error?.message || error) })));
        await clickCaptionLanguageCombobox(page);
        await clickCaptionLanguageOption(page, captionLanguage);
        await selectLiveCaptionsMode(page);
        await disableTranslatedCaptions(page);
        diagnostics?.record("caption_settings_inventory_after_language", await inspectCaptionSettingsPanel(page).catch((error) => ({ error: String(error?.message || error) })));
        if (await translatedCaptionsEnabled(page)) {
          throw new Error("translated captions enabled instead of meeting language");
        }
        diagnostics?.record("caption_settings_live_radio_selected", { attempt: attempt + 1, selected: await liveCaptionsRadioSelected(page) });
      }

      if (enableLiveCaptions) {
        await page.locator('text=/Live captions|实时字幕/i').first().click({ timeout: 2500 }).catch(() => {});
      }
      await page.locator('[aria-label="Close" i], [aria-label="Close dialog" i], [aria-label="关闭"]').first().click({ timeout: 1500 }).catch(async () => {
        await page.keyboard.press("Escape").catch(() => {});
      });
      await page.waitForTimeout(1000);
      return { ok: true, method: "settings", attempt: attempt + 1, path: settingsPath };
    } catch (error) {
      diagnostics?.record("caption_settings_attempt_failed", { attempt: attempt + 1, error: String(error?.message || error).slice(0, 220) });
      await page.keyboard.press("Escape").catch(() => {});
    }
  }
  return { ok: false, method: "settings" };
}

async function openCaptionSettingsPanel(
  page: import("playwright").Page,
  { preferInline = true }: { preferInline?: boolean } = {},
): Promise<"inline" | "legacy"> {
  const openers = preferInline
    ? [openInlineCaptionSettings, openLegacyCaptionSettings]
    : [openLegacyCaptionSettings, openInlineCaptionSettings];
  let lastError: unknown = null;
  for (const open of openers) {
    try {
      return await open(page);
    } catch (error) {
      lastError = error;
      await page.keyboard.press("Escape").catch(() => {});
    }
  }
  throw lastError || new Error("unable to open caption settings");
}

async function openInlineCaptionSettings(page: import("playwright").Page): Promise<"inline"> {
  await page.locator(INLINE_CAPTION_SETTINGS_SELECTOR).first().click({ timeout: 1500 });
  await page.waitForTimeout(500);
  return "inline";
}

async function openLegacyCaptionSettings(page: import("playwright").Page): Promise<"legacy"> {
  await page.locator('button[aria-label="More options"], button[aria-label="更多选项"]').first().click({ timeout: 3500 });
  await page.locator('[role="menuitem"]').filter({ hasText: /settings|设置/i }).first().click({ timeout: 3500 });
  await page.locator('[role="tab"]').filter({ hasText: /caption|字幕/i }).first().click({ timeout: 3500 });
  return "legacy";
}

async function clickCaptionLanguageCombobox(page: import("playwright").Page): Promise<void> {
  if (await clickMeetingLanguageComboboxByLabel(page)) return;
  const candidates = [
    page.locator(CAPTION_LANGUAGE_COMBOBOX_XPATH).first(),
    page.locator('[role="combobox"]').filter({ hasText: CAPTION_LANGUAGE_LABEL }).first(),
    page.locator('[role="combobox"][aria-label*="Language of the meeting" i], [role="combobox"][aria-label*="Meeting language" i], [role="combobox"][aria-label*="会议语言" i], [role="combobox"][aria-label*="會議語言" i]').first(),
  ];
  let lastError: unknown = null;
  for (const candidate of candidates) {
    try {
      await clickLocatorRobust(candidate, { timeout: 2500 });
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("caption language combobox unavailable");
}

async function clickCaptionLanguageOption(page: import("playwright").Page, captionLanguage: string): Promise<void> {
  // Meet's MEETING LANGUAGE dropdown uses long-form labels like
  // "Chinese, Mandarin (Simplified)" while the TRANSLATION TARGET combobox
  // uses short-form "Chinese (Simplified)". If we match a short pattern, the
  // user-preferred-language option list wins via DOM order. Prefer the
  // long-form meeting-language label and verify that the chosen option lives
  // inside the just-opened source listbox (not the translation listbox).
  const trimmed = captionLanguage.trim();
  const optionPatterns: RegExp[] = [];
  if (/chinese|中文|zh/i.test(trimmed)) {
    optionPatterns.push(/Chinese, Mandarin \(Simplified\)/i);
    optionPatterns.push(/Mandarin \(Simplified\)/i);
    optionPatterns.push(/简体中文|中文（简体）/);
  }
  if (trimmed) optionPatterns.push(new RegExp(escapeRegExp(trimmed), "i"));
  if (/chinese|中文/i.test(trimmed)) {
    optionPatterns.push(/Chinese.*Simplified|Simplified.*Chinese|中文.*简体|简体.*中文/i);
    optionPatterns.push(/Chinese|中文/i);
  }
  let lastError: unknown = null;
  for (const pattern of optionPatterns) {
    try {
      const clicked = await clickMeetingLanguageOptionByPattern(page, pattern);
      if (clicked) return;
    } catch (error) {
      lastError = error;
    }
    // Fallback: legacy locator path.
    const option = page.locator('[role="option"]').filter({ hasText: pattern }).first();
    try {
      await clickLocatorRobust(option, { timeout: 1500 });
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error(`caption language option unavailable: ${captionLanguage}`);
}

async function clickMeetingLanguageOptionByPattern(
  page: import("playwright").Page,
  pattern: RegExp,
): Promise<boolean> {
  return page.evaluate((patternSource: string) => {
    const re = new RegExp(patternSource, "i");
    const translationPattern = /your preferred language|translated captions|translate captions|首选语言|偏好語言|翻译字幕|翻譯字幕/i;
    const meetingPattern = /language of the meeting|meeting language|会议语言|會議語言/i;
    const visible = (node: HTMLElement) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const textOf = (node: HTMLElement) => (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
    // Find currently-expanded listbox that is anchored to the meeting language combobox.
    const expandedCombo = Array.from(document.querySelectorAll<HTMLElement>('[role="combobox"][aria-expanded="true"]'))
      .filter(visible)
      .find((combo) => meetingPattern.test(`${textOf(combo)} ${combo.getAttribute("aria-label") || ""}`)
        && !translationPattern.test(`${textOf(combo)} ${combo.getAttribute("aria-label") || ""}`));
    const ownedListbox = expandedCombo?.getAttribute("aria-controls");
    let scopeRoot: ParentNode | null = null;
    if (ownedListbox) {
      const listbox = document.getElementById(ownedListbox);
      if (listbox) scopeRoot = listbox;
    }
    if (!scopeRoot && expandedCombo) {
      // Fallback: search globally but require option to live below the expanded combobox rect.
      scopeRoot = document;
    }
    const candidateOptions = Array.from((scopeRoot || document).querySelectorAll<HTMLElement>('[role="option"]'))
      .filter(visible)
      .filter((opt) => re.test(textOf(opt)))
      .filter((opt) => {
        if (!expandedCombo) return true;
        const optRect = opt.getBoundingClientRect();
        const comboRect = expandedCombo.getBoundingClientRect();
        // Source dropdown opens directly below or beside its combobox; reject options far above.
        return optRect.top + 4 >= comboRect.top - 4;
      });
    if (candidateOptions.length === 0) return false;
    const target = candidateOptions[0];
    try { target.click(); } catch {}
    try { target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); } catch {}
    return true;
  }, pattern.source).catch(() => false);
}

async function selectLiveCaptionsMode(page: import("playwright").Page): Promise<void> {
  // Meet renders 3 radio-like labels in the settings dialog: "No captions",
  // "Live captions", "Translated captions". Each label's actual radio control
  // may be a <label> wrapping an <input type=radio>, or a sibling element with
  // [role="radio"]. Clicking the label is the most reliable trigger, but we
  // must scope to the settings dialog so we do not accidentally hit the same
  // text in the inline caption panel.
  const clickedInDom = await page.evaluate(() => {
    const targetPattern = /^(Live captions|实时字幕|即時字幕)$/;
    const inDialog = (node: HTMLElement) => {
      let cur: HTMLElement | null = node;
      while (cur) {
        const role = cur.getAttribute("role");
        if (role === "dialog" || cur.getAttribute("aria-modal") === "true") return true;
        cur = cur.parentElement;
      }
      return false;
    };
    const visible = (node: HTMLElement) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const triggerClick = (target: HTMLElement) => {
      try { target.click(); } catch {}
      try { target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); } catch {}
    };
    const labels = Array.from(document.querySelectorAll<HTMLElement>("label, [role='radio']"))
      .filter((node) => visible(node))
      .filter((node) => targetPattern.test((node.innerText || node.textContent || "").trim()))
      .filter((node) => inDialog(node));
    for (const label of labels) {
      triggerClick(label);
      const forId = label.getAttribute("for");
      if (forId) {
        const radio = document.getElementById(forId);
        if (radio instanceof HTMLElement) triggerClick(radio);
      }
      const innerRadio = label.querySelector<HTMLElement>('input[type="radio"], [role="radio"]');
      if (innerRadio) triggerClick(innerRadio);
      let parent: HTMLElement | null = label.parentElement;
      for (let depth = 0; parent && depth < 4; depth += 1, parent = parent.parentElement) {
        const radios = parent.querySelectorAll<HTMLElement>('input[type="radio"], [role="radio"]');
        for (const radio of Array.from(radios)) {
          const rect = radio.getBoundingClientRect();
          const labelRect = label.getBoundingClientRect();
          if (Math.abs(rect.top - labelRect.top) < 32) triggerClick(radio);
        }
      }
      return true;
    }
    return false;
  }).catch(() => false);
  if (clickedInDom) return;

  // Fallback: legacy locator-based attempt (older Meet builds without dialog scoping).
  const directChoices = [
    page.locator('label').filter({ hasText: /^Live captions$/i }).first(),
    page.locator('[role="radio"]').filter({ hasText: /^Live captions$/i }).first(),
    page.locator('label').filter({ hasText: /^实时字幕$|^即時字幕$/i }).first(),
  ];
  for (const choice of directChoices) {
    try {
      await clickLocatorRobust(choice, { timeout: 800 });
      return;
    } catch {
      // Try the caption type combobox below.
    }
  }

  const captionType = page.locator('[role="combobox"][aria-label*="Caption type" i], [role="combobox"][aria-label*="字幕类型" i], [role="combobox"][aria-label*="字幕類型" i]').first();
  try {
    await clickLocatorRobust(captionType, { timeout: 800 });
    await clickLocatorRobust(page.locator('[role="option"]').filter({ hasText: /Live captions|实时字幕|即時字幕/i }).first(), { timeout: 1000 });
  } catch {
    // Some Meet builds expose the mode as radio-like text only; language selection can still proceed.
  }
}

async function liveCaptionsRadioSelected(page: import("playwright").Page): Promise<boolean> {
  return page.evaluate(() => {
    const targetPattern = /^(Live captions|实时字幕|即時字幕)$/;
    const inDialog = (node: HTMLElement) => {
      let cur: HTMLElement | null = node;
      while (cur) {
        const role = cur.getAttribute("role");
        if (role === "dialog" || cur.getAttribute("aria-modal") === "true") return true;
        cur = cur.parentElement;
      }
      return false;
    };
    const labels = Array.from(document.querySelectorAll<HTMLElement>("label, [role='radio']"))
      .filter((node) => targetPattern.test((node.innerText || node.textContent || "").trim()))
      .filter((node) => inDialog(node));
    for (const label of labels) {
      const forId = label.getAttribute("for");
      const candidates: HTMLElement[] = [];
      if (forId) {
        const direct = document.getElementById(forId);
        if (direct instanceof HTMLElement) candidates.push(direct);
      }
      const inner = label.querySelector<HTMLElement>('input[type="radio"], [role="radio"]');
      if (inner) candidates.push(inner);
      candidates.push(label);
      for (const candidate of candidates) {
        const checked = candidate.getAttribute("aria-checked") || (candidate as HTMLInputElement).checked?.toString();
        if (checked === "true") return true;
      }
    }
    return false;
  }).catch(() => false);
}

async function clickLocatorRobust(
  locator: import("playwright").Locator,
  { timeout = 1500 }: { timeout?: number } = {},
): Promise<void> {
  await locator.waitFor?.({ state: "visible", timeout }).catch(() => {});
  await locator.scrollIntoViewIfNeeded?.().catch(() => {});
  try {
    await locator.click({ timeout });
  } catch (error) {
    const clicked = await locator.evaluate((node) => {
      if (!(node instanceof HTMLElement)) return false;
      node.click();
      return true;
    }).catch(() => false);
    if (!clicked) throw error;
  }
}

async function translatedCaptionsEnabled(page: import("playwright").Page): Promise<boolean> {
  // Check whether the "Translated captions" RADIO is actually selected
  // (aria-checked=true on the radio control or its associated input). Mere
  // label visibility is not enough — the label is always rendered when the
  // captions settings dialog is open.
  return page.evaluate(() => {
    const targetPattern = /^(Translated captions|翻译字幕|翻譯字幕)$/;
    const labels = Array.from(document.querySelectorAll<HTMLElement>("label, [role='radio']"))
      .filter((node) => targetPattern.test((node.innerText || node.textContent || "").trim()));
    for (const label of labels) {
      const forId = label.getAttribute("for");
      const candidates: HTMLElement[] = [];
      if (forId) {
        const direct = document.getElementById(forId);
        if (direct instanceof HTMLElement) candidates.push(direct);
      }
      const inner = label.querySelector<HTMLElement>('input[type="radio"], [role="radio"]');
      if (inner) candidates.push(inner);
      candidates.push(label);
      for (const candidate of candidates) {
        const checked = candidate.getAttribute("aria-checked") || (candidate as HTMLInputElement).checked?.toString();
        if (checked === "true") return true;
      }
    }
    return false;
  }).catch(() => false);
}

async function inspectCaptionSettingsPanel(page: import("playwright").Page) {
  return page.evaluate(() => {
    const interesting = /caption|language|translate|字幕|语言|語言|翻译|翻譯|english|chinese|中文/i;
    const textOf = (node: HTMLElement) => (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
    const visible = (node: HTMLElement) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const compact = (node: HTMLElement) => {
      const rect = node.getBoundingClientRect();
      return {
        tag: node.tagName.toLowerCase(),
        role: node.getAttribute("role") || "",
        ariaLabel: node.getAttribute("aria-label") || "",
        ariaChecked: node.getAttribute("aria-checked") || "",
        ariaPressed: node.getAttribute("aria-pressed") || "",
        text: textOf(node).slice(0, 180),
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      };
    };
    return {
      textHead: textOf(document.body).split(" ").slice(0, 160).join(" "),
      labels: Array.from(document.querySelectorAll<HTMLElement>("div, span, label, button"))
        .filter((node) => visible(node) && interesting.test(`${textOf(node)} ${node.getAttribute("aria-label") || ""}`))
        .filter((node) => !Array.from(node.children).some((child) => interesting.test(textOf(child as HTMLElement))))
        .slice(0, 80)
        .map(compact),
      comboboxes: Array.from(document.querySelectorAll<HTMLElement>('[role="combobox"]')).filter(visible).map(compact),
      toggles: Array.from(document.querySelectorAll<HTMLElement>('[role="switch"], [role="checkbox"], button[aria-pressed], input[type="checkbox"]')).filter(visible).map(compact),
    };
  });
}

export const __captionCaptureTestInternals = {
  clickCaptionLanguageOption,
  isCaptionSettingsUiText,
  isLocalMeetCaptionSpeaker,
  liveCaptionsRadioSelected,
  translatedCaptionsEnabled,
};

async function clickMeetingLanguageComboboxByLabel(page: import("playwright").Page): Promise<boolean> {
  return page.evaluate(() => {
    const labelPattern = /language of the meeting|meeting language|会议语言|會議語言/i;
    const translationPattern = /translated captions|translate captions|translation|your preferred language|caption type|翻译字幕|翻譯字幕|首选语言|偏好語言/i;
    const textOf = (node: HTMLElement) => (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
    const visible = (node: HTMLElement) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const directCombos = Array.from(document.querySelectorAll<HTMLElement>('[role="combobox"]'))
      .filter((combo) => visible(combo))
      .map((combo) => {
        const rect = combo.getBoundingClientRect();
        const text = textOf(combo);
        const aria = combo.getAttribute("aria-label") || "";
        return {
          combo,
          text,
          aria,
          score:
            (/language of the meeting/i.test(text) ? 0 : 1000) +
            (/meeting language/i.test(aria) ? 0 : 500) +
            rect.top,
        };
      })
      .filter((entry) => labelPattern.test(`${entry.text} ${entry.aria}`))
      .filter((entry) => !translationPattern.test(`${entry.text} ${entry.aria}`))
      .toSorted((left, right) => left.score - right.score);
    if (directCombos[0]?.combo) {
      directCombos[0].combo.click();
      return true;
    }

    const labels = Array.from(document.querySelectorAll<HTMLElement>("div, span, label"))
      .filter((node) => visible(node) && labelPattern.test(textOf(node)) && !translationPattern.test(textOf(node)))
      .filter((node) => !Array.from(node.children).some((child) => labelPattern.test(textOf(child as HTMLElement))))
      .toSorted((left, right) => textOf(left).length - textOf(right).length);

    for (const label of labels) {
      const labelRect = label.getBoundingClientRect();
      const combos = Array.from(document.querySelectorAll<HTMLElement>('[role="combobox"]'))
        .filter((combo) => visible(combo))
        .filter((combo) => Boolean(label.compareDocumentPosition(combo) & Node.DOCUMENT_POSITION_FOLLOWING))
        .map((combo) => {
          const rect = combo.getBoundingClientRect();
          const text = `${textOf(combo)} ${combo.getAttribute("aria-label") || ""}`;
          return {
            combo,
            text,
            score: Math.abs(rect.top - labelRect.top) * 10 + Math.max(0, rect.left - labelRect.left),
          };
        })
        .filter((entry) => !translationPattern.test(entry.text))
        .toSorted((left, right) => left.score - right.score);
      if (combos[0]?.combo) {
        combos[0].combo.click();
        return true;
      }
    }
    return false;
  }).catch(() => false);
}

async function disableTranslatedCaptions(page: import("playwright").Page): Promise<void> {
  await page.evaluate(() => {
    const translationPattern = /translated captions|translate captions|translation|翻译字幕|翻譯字幕/i;
    const textOf = (node: HTMLElement) => (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
    const visible = (node: HTMLElement) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const labels = Array.from(document.querySelectorAll<HTMLElement>("div, span, label"))
      .filter((node) => visible(node) && translationPattern.test(textOf(node)))
      .toSorted((left, right) => textOf(left).length - textOf(right).length);
    for (const label of labels) {
      let current: HTMLElement | null = label;
      for (let depth = 0; current && depth < 6; depth += 1, current = current.parentElement) {
        const toggles = Array.from(current.querySelectorAll<HTMLElement>('[role="switch"], [role="checkbox"], button[aria-pressed], input[type="checkbox"]'));
        for (const toggle of toggles) {
          const checked = toggle.getAttribute("aria-checked") ?? toggle.getAttribute("aria-pressed") ?? ((toggle as HTMLInputElement).checked ? "true" : "");
          if (checked === "true") {
            toggle.click();
            return;
          }
        }
      }
    }
  }).catch(() => {});
}

export async function installMeetCaptionCapture(
  page: import("playwright").Page,
  {
    artifactsDir = "",
    diagnostics = null,
  }: { artifactsDir?: string; diagnostics?: Diagnostics } = {},
) {
  const captionDir = artifactsDir || "";
  if (captionDir) await mkdir(captionDir, { recursive: true });
  const ndjsonPath = captionDir ? pathJoin(captionDir, "captions.ndjson") : "";
  const jsonPath = captionDir ? pathJoin(captionDir, "captions.json") : "";
  const captions: CaptionEvent[] = [];

  await page.exposeFunction("__mabOnCaptionCapture", async (rawEvent) => {
    const event = compactCaptionEvent({
      ...rawEvent,
      ts: rawEvent?.ts || nowIso(),
      text: normalizeCaptionText(rawEvent?.text || ""),
      speaker: normalizeCaptionText(rawEvent?.speaker || "unknown") || "unknown",
    });
    if (!event.text) return;
    if (isCaptionSettingsUiText(event.text)) {
      diagnostics?.record("caption_event_dropped_ui_text", {
        speaker: event.speaker,
        text: event.text.slice(0, 240),
        streamId: event.streamId,
      });
      return;
    }
    if (isLocalMeetCaptionSpeaker(event.speaker)) {
      diagnostics?.record("caption_event_dropped_local_speaker", {
        speaker: event.speaker,
        text: event.text.slice(0, 240),
        streamId: event.streamId,
      });
      return;
    }
    captions.push(event);
    diagnostics?.record("caption_event", {
      speaker: event.speaker,
      text: event.text.slice(0, 240),
      streamId: event.streamId,
      count: captions.length,
    });
    if (ndjsonPath) await appendFile(ndjsonPath, `${JSON.stringify(event)}\n`);
  });

  const install = await page.evaluate(({ containers, speakerBadge }) => {
    function normalize(text: unknown): string {
      return String(text || "")
        .replace(/\u00a0/g, " ")
        .split("\n")
        .map((line) => line.replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .join(" ")
        .trim();
    }
    function aggregateLabel(text: string): boolean {
      const normalized = normalize(text);
      return (
        /&\s*\d+\s+others\b/i.test(normalized) ||
        /\band\s+\d+\s+others\b/i.test(normalized) ||
        /\b\d+\s+others\b/i.test(normalized) ||
        /等\s*\d+\s*人/.test(normalized) ||
        /与\s*\d+\s*位?其他/.test(normalized)
      );
    }
    function localMeetSpeaker(text: string): boolean {
      const normalized = normalize(text).toLowerCase().replace(/[：:]\s*$/, "");
      if (!normalized) return false;
      if (["you", "me", "myself", "我", "你", "您", "自己", "本人"].includes(normalized)) return true;
      return /^you\s*\(.+\)$/.test(normalized);
    }
    function visible(el: Element): boolean {
      if (!(el instanceof HTMLElement)) return false;
      if (el.getAttribute("aria-hidden") === "true") return false;
      const style = window.getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden" && el.getClientRects().length > 0;
    }
    function chooseSpeaker(texts: string[]): string {
      const unique: string[] = [];
      for (const text of texts.map(normalize).filter(Boolean)) {
        if (!unique.includes(text)) unique.push(text);
      }
      return unique.find((text) => !aggregateLabel(text)) || "";
    }
    function chooseText(speaker: string, candidates: string[]): string {
      const normalizedSpeaker = normalize(speaker);
      const unique: string[] = [];
      for (const candidate of candidates.map(normalize).filter(Boolean)) {
        if (candidate === normalizedSpeaker || aggregateLabel(candidate) || unique.includes(candidate)) continue;
        unique.push(candidate);
      }
      return unique
        .filter((candidate, index, all) => !all.some((other, otherIndex) => otherIndex !== index && other.length >= candidate.length && other.includes(candidate)))
        .join(" ")
        .trim();
    }
    function captionUiText(text: string): boolean {
      const normalized = normalize(text);
      if (!normalized) return true;
      if (normalized.length <= 2) return true;
      if (/^(English|Chinese, Mandarin \(Simplified\)|Chinese \(Simplified\)|Chinese \(Traditional\)|Japanese|Korean|French|German|Spanish|Portuguese|Italian|Dutch|Russian)$/i.test(normalized)) return true;
      if (/^(language|english|closed_caption|live captions|format_size|font size|circle|font color|settings|open caption settings|groups)$/i.test(normalized)) return true;
      if (/^(gemini|take notes with gemini|pen_spark|adaptive_audio_mic|domain_disabled)$/i.test(normalized)) return true;
      if (/^(press down arrow|external participants joined|your audio is merged with nearby devices)/i.test(normalized)) return true;
      if (/^(meeting tools|more options|leave call|turn on microphone|turn off microphone|turn on camera|turn off camera)$/i.test(normalized)) return true;
      return false;
    }
    function aggregateSpeaker(text: string): string {
      const normalized = normalize(text);
      const match = normalized.match(/^(.+?)\s*(?:&|and)\s+\d+\s+others\b/i);
      if (match) return normalize(match[1]);
      const cnMatch = normalized.match(/^(.+?)\s*(?:等|与)\s*\d+\s*(?:人|位?其他)/);
      if (cnMatch) return normalize(cnMatch[1]);
      return "";
    }
    function likelyParticipantName(text: string): boolean {
      const normalized = normalize(text);
      if (!normalized || captionUiText(normalized) || aggregateLabel(normalized)) return false;
      if (normalized.length > 64) return false;
      if (/https?:\/\//i.test(normalized)) return false;
      return /^[\p{L}\p{M}][\p{L}\p{M}\p{N} ._'-]{1,63}$/u.test(normalized);
    }
    function chooseFallbackSpeaker(lines: string[]): string {
      for (const line of lines) {
        const speaker = aggregateSpeaker(line);
        if (speaker) return speaker;
      }
      const counts = new Map<string, number>();
      for (const line of lines.map(normalize).filter(likelyParticipantName)) {
        counts.set(line, (counts.get(line) || 0) + 1);
      }
      return Array.from(counts.entries())
        .toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || "unknown";
    }
    function lineCaptionCandidate(line: string, speaker: string): boolean {
      const normalized = normalize(line);
      if (!normalized || normalized === speaker || captionUiText(normalized) || aggregateLabel(normalized)) return false;
      if (likelyParticipantName(normalized)) return false;
      if (normalized.length < 8) return false;
      if (/^[\p{L}\p{M}\p{N}_-]{1,24}$/u.test(normalized)) return false;
      return /[\p{L}\p{N}]/u.test(normalized);
    }
    function chooseFallbackCaption(lines: string[], speaker: string): string {
      const marker = lines.findIndex((line) => /^groups$/i.test(normalize(line)));
      const scoped = marker >= 0 ? lines.slice(marker + 1) : lines;
      const candidates: string[] = [];
      let seenAggregate = marker < 0;
      for (const line of scoped.map(normalize).filter(Boolean)) {
        if (!seenAggregate && aggregateLabel(line)) {
          seenAggregate = true;
          continue;
        }
        if (!seenAggregate && likelyParticipantName(line)) continue;
        if (lineCaptionCandidate(line, speaker)) candidates.push(line);
      }
      const unique: string[] = [];
      for (const candidate of candidates) {
        if (!unique.includes(candidate)) unique.push(candidate);
      }
      return unique
        .filter((candidate, index, all) => !all.some((other, otherIndex) => otherIndex !== index && other.length > candidate.length && other.includes(candidate)))
        .join(" ")
        .slice(0, 1600)
        .trim();
    }
    function fallbackCaption(container: HTMLElement): { speaker: string; text: string } | null {
      const text = container.innerText || container.textContent || "";
      const lines = String(text || "")
        .replace(/\u00a0/g, " ")
        .split("\n")
        .map((line) => line.replace(/\s+/g, " ").trim())
        .filter(Boolean);
      const speaker = chooseFallbackSpeaker(lines);
      const captionText = chooseFallbackCaption(lines, speaker);
      return captionText ? { speaker, text: captionText } : null;
    }
    function getContainers(): HTMLElement[] {
      return containers.flatMap((selector) =>
        Array.from(document.querySelectorAll<HTMLElement>(selector)),
      );
    }
    function ensureState(): CaptionCaptureState {
      window.MAB_CAPTION_CAPTURE ||= {
        ok: true,
        installedAt: new Date().toISOString(),
        containerFound: false,
        captions: [],
        latest: null,
        errors: [],
      };
      return window.MAB_CAPTION_CAPTURE;
    }

    function shouldForwardToLocalDialog(event: CaptionEvent): boolean {
      if (typeof window.MAB_LOCAL_DIALOG_CONTROLLER?.sendUtterance !== "function") return false;
      const config = window.MAB_LOCAL_DIALOG_CONFIG || {};
      const provider = normalize(config.sttProvider || "").toLowerCase();
      if (!["caption", "captions", "meet-caption", "google-meet-caption"].includes(provider)) return false;
      const speaker = normalize(event?.speaker || "");
      const botName = normalize(config.botName || "");
      if (speaker && botName && (speaker === botName || speaker.includes(botName) || botName.includes(speaker))) {
        return false;
      }
      return true;
    }

    function forwardToLocalDialog(event: CaptionEvent): void {
      if (!shouldForwardToLocalDialog(event)) return;
      const payload: LocalDialogInput = {
          source: "meet-caption",
          text: event.text,
          context: {
            speaker: event.speaker,
            captionTs: event.ts,
            captionSource: event.source || "google-meet-caption-dom",
          },
      };
      window.MAB_LOCAL_DIALOG_CONTROLLER?.sendUtterance?.(payload).catch((error: unknown) => {
        const state = ensureState();
        const message = error instanceof Error ? error.message : String(error);
        state.errors.push(message.slice(0, 300));
        if (state.errors.length > 20) state.errors.splice(0, state.errors.length - 20);
      });
    }

    function forwardToRealtime(event: CaptionEvent): void {
      const client = window.MAB_REALTIME_CLIENT;
      if (typeof client?.injectCaptionTurn !== "function") return;
      const botName = normalize(window.MAB_REALTIME_BRIDGE_CONFIG?.botName || "");
      const speaker = normalize(event?.speaker || "");
      if (speaker && botName && (speaker === botName || speaker.includes(botName) || botName.includes(speaker))) return;
      try {
        if (normalize(event?.text || "")) client.injectCaptionTurn(event);
      } catch (error) {
        const state = ensureState();
        const message = error instanceof Error ? error.message : String(error);
        state.errors.push(message.slice(0, 300));
        if (state.errors.length > 20) state.errors.splice(0, state.errors.length - 20);
      }
    }

    if (window.__MAB_CAPTION_CAPTURE_INSTALLED) {
      return { ok: true, alreadyInstalled: true };
    }
    window.__MAB_CAPTION_CAPTURE_INSTALLED = true;
    const state = ensureState();
    const lastEmitted = new WeakMap<Element, string>();
    const streamIds = new WeakMap<Element, string>();
    let nextStreamId = 1;
    let lastFallbackSignature = "";

    function scan() {
      const captionContainers = getContainers();
      state.containerFound = captionContainers.length > 0;
      for (const container of captionContainers) {
        let emittedForContainer = false;
        const children = Array.from(container.children).filter(
          (child): child is HTMLElement =>
            child instanceof HTMLElement && Boolean(child.querySelector(speakerBadge)),
        );
        for (const child of children) {
          const speaker = chooseSpeaker(
            Array.from(child.querySelectorAll<HTMLElement>(speakerBadge))
              .filter(visible)
              .map((badge) => badge.textContent || ""),
          );
          if (!speaker) continue;
          if (localMeetSpeaker(speaker)) continue;
          const candidates = Array.from(child.querySelectorAll<HTMLElement>("div, span"))
            .filter(visible)
            .filter((el) => !el.matches(speakerBadge) && !el.closest(speakerBadge) && !el.querySelector(speakerBadge))
            .filter((el) => el.children.length === 0 || el.classList.contains("ygicle") || el.classList.contains("VbkSUe"))
            .map((el) => el.textContent || "");
          const text = chooseText(speaker, candidates);
          if (!text) continue;
          const signature = `${speaker}\n${text}`;
          if (lastEmitted.get(child) === signature) continue;
          lastEmitted.set(child, signature);
          let streamId = streamIds.get(child);
          if (!streamId) {
            streamId = `caption-${nextStreamId++}`;
            streamIds.set(child, streamId);
          }
          const event = { ts: new Date().toISOString(), speaker, text, streamId, source: "google-meet-caption-dom" };
          state.latest = event;
          state.captions.push(event);
          if (state.captions.length > 100) state.captions.splice(0, state.captions.length - 100);
          window.__mabOnCaptionCapture(event);
          forwardToLocalDialog(event);
          forwardToRealtime(event);
          emittedForContainer = true;
        }
        if (!emittedForContainer) {
          const fallback = fallbackCaption(container);
          if (!fallback) continue;
          if (localMeetSpeaker(fallback.speaker)) continue;
          const signature = `${fallback.speaker}\n${fallback.text}`;
          if (signature === lastFallbackSignature) continue;
          lastFallbackSignature = signature;
          let streamId = streamIds.get(container);
          if (!streamId) {
            streamId = `caption-${nextStreamId++}`;
            streamIds.set(container, streamId);
          }
          const event = {
            ts: new Date().toISOString(),
            speaker: fallback.speaker,
            text: fallback.text,
            streamId,
            source: "google-meet-caption-dom-fallback",
          };
          state.latest = event;
          state.captions.push(event);
          if (state.captions.length > 100) state.captions.splice(0, state.captions.length - 100);
          window.__mabOnCaptionCapture(event);
          forwardToLocalDialog(event);
          forwardToRealtime(event);
        }
      }
    }

    const observer = new MutationObserver(() => {
      try {
        scan();
      } catch (error) {
        state.errors.push(String(error?.message || error).slice(0, 300));
      }
    });
    observer.observe(document.body, { childList: true, characterData: true, subtree: true });
    window.__MAB_CAPTION_CAPTURE_SCAN = scan;
    scan();
    return { ok: true, containers, speakerBadge };
  }, { containers: CAPTION_CONTAINERS, speakerBadge: SPEAKER_BADGE }).catch((error) => ({ ok: false, error: String(error?.message || error) }));

  async function browserState(): Promise<CaptionCaptureState | { ok: false; error: string }> {
    return await page.evaluate(() => window.MAB_CAPTION_CAPTURE || null).catch((error) => ({
      ok: false,
      error: String(error?.message || error),
    }));
  }

  async function status() {
    const state = await browserState();
    return {
      ok: install.ok !== false,
      install,
      count: captions.length,
      latest: captions.at(-1) || (state && "latest" in state ? state.latest : null),
      tail: captions.slice(-12),
      paths: { ndjson: ndjsonPath, json: jsonPath },
      browser: state,
    };
  }

  async function flush() {
    const state = await status();
    if (jsonPath) {
      await writeFile(jsonPath, `${JSON.stringify({
        ok: state.ok,
        generatedAt: nowIso(),
        count: captions.length,
        captions,
        browser: state.browser,
      }, null, 2)}\n`);
    }
    return state;
  }

  return { install, captions, paths: { ndjson: ndjsonPath, json: jsonPath }, status, flush };
}
