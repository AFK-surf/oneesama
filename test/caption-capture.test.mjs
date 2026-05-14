import assert from "node:assert/strict";
import test from "node:test";

import { enableMeetCaptions } from "../packages/core/src/meeting/caption-capture.ts";

function fakeCaptionSettingsPage(directProbe, { domMeetingLanguageClick = true, failSelectors = [], visibleSelectors = [] } = {}) {
  const clicks = [];
  const filters = [];
  const page = {
    clicks,
    filters,
    keyboard: { async press(key) { clicks.push({ selector: "keyboard", key }); } },
    async evaluate(fn, arg) {
      if (typeof arg === "number") return true;
      const source = String(fn);
      if (source.includes("language of the meeting|meeting language")) {
        if (domMeetingLanguageClick) clicks.push({ selector: "dom-meeting-language-combobox" });
        return domMeetingLanguageClick;
      }
      if (source.includes("translated captions|translate captions")) return undefined;
      return directProbe;
    },
    locator(selector) {
      const chain = {
        filter(options) {
          filters.push({ selector, hasText: String(options?.hasText || "") });
          return chain;
        },
        first() {
          return chain;
        },
        async waitFor() {},
        async isVisible() {
          return visibleSelectors.includes(selector);
        },
        async click() {
          if (failSelectors.includes(selector)) throw new Error(`forced failure for ${selector}`);
          clicks.push({ selector, filter: filters.at(-1)?.hasText || "" });
        },
        async scrollIntoViewIfNeeded() {
          clicks.push({ selector, action: "scroll" });
        },
        async evaluate() {
          clicks.push({ selector, action: "evaluate" });
          return true;
        },
      };
      return chain;
    },
    async waitForTimeout() {},
  };
  return page;
}

test("enableMeetCaptions still configures the selected language when captions are already on", async () => {
  const page = fakeCaptionSettingsPage({
    ok: true,
    alreadyOn: true,
    candidateIndex: 0,
    candidates: [{ index: 0, aria: "Turn off captions", text: "", visible: true }],
  });

  const result = await enableMeetCaptions(page, { captionLanguage: "Chinese (Simplified)" });

  assert.equal(result.ok, true);
  assert.equal(result.alreadyOn, true);
  assert.equal(result.path, "inline");
  assert.ok(page.clicks.some((click) => click.selector === '[role="option"]' && String(click.filter).includes("Chinese")));
  assert.ok(page.clicks.some((click) => String(click.selector).includes("caption settings")));
  assert.ok(page.clicks.some((click) => click.selector === "dom-meeting-language-combobox"));
  assert.ok(!page.clicks.some((click) => click.selector === 'button[aria-label="More options"], button[aria-label="更多选项"]'));
  assert.ok(!page.clicks.some((click) => click.selector === "text=/Live captions|实时字幕/i"), "already-on path must not toggle captions off");
});

test("enableMeetCaptions falls back to the legacy settings menu when the inline caption button is unavailable", async () => {
  const page = fakeCaptionSettingsPage({
    ok: true,
    alreadyOn: true,
    candidateIndex: 0,
    candidates: [{ index: 0, aria: "Turn off captions", text: "", visible: true }],
  }, {
    failSelectors: [
      [
        'button[aria-label*="Open caption settings" i]',
        '[role="button"][aria-label*="Open caption settings" i]',
        'button[aria-label*="caption settings" i]',
        '[role="button"][aria-label*="caption settings" i]',
        'button[aria-label*="字幕设置" i]',
        '[role="button"][aria-label*="字幕设置" i]',
        'button[aria-label*="字幕設定" i]',
        '[role="button"][aria-label*="字幕設定" i]',
      ].join(", "),
    ],
  });

  const result = await enableMeetCaptions(page, { captionLanguage: "Chinese (Simplified)" });

  assert.equal(result.ok, true);
  assert.equal(result.path, "legacy");
  assert.ok(page.clicks.some((click) => click.selector === 'button[aria-label="More options"], button[aria-label="更多选项"]'));
});

test("enableMeetCaptions falls back to DOM click when the language combobox refuses a normal click", async () => {
  const page = fakeCaptionSettingsPage({
    ok: true,
    alreadyOn: true,
    candidateIndex: 0,
    candidates: [{ index: 0, aria: "Turn off captions", text: "", visible: true }],
  }, {
    domMeetingLanguageClick: false,
    failSelectors: [
      "xpath=(//*[self::div or self::span or self::label][contains(translate(normalize-space(.), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'language of the meeting') or contains(translate(normalize-space(.), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'meeting language') or contains(normalize-space(.), '会议语言') or contains(normalize-space(.), '會議語言')]/following::*[@role='combobox'][1])[1]",
    ],
  });

  const result = await enableMeetCaptions(page, { captionLanguage: "Chinese (Simplified)" });

  assert.equal(result.ok, true);
  assert.ok(page.clicks.some((click) => click.selector.includes("following::*[@role='combobox'][1]") && click.action === "evaluate"));
});

test("enableMeetCaptions refuses translated captions mode when a meeting language was requested", async () => {
  const page = fakeCaptionSettingsPage({
    ok: true,
    alreadyOn: true,
    candidateIndex: 0,
    candidates: [{ index: 0, aria: "Turn off captions", text: "", visible: true }],
  }, {
    visibleSelectors: ['text=/Translated captions|翻译字幕|翻譯字幕/i'],
  });

  const result = await enableMeetCaptions(page, { captionLanguage: "Chinese (Simplified)" });

  assert.equal(result.ok, false);
  assert.equal(result.method, "direct+settings-language");
  assert.deepEqual(result.language, { ok: false, method: "settings" });
});
