import assert from "node:assert/strict";
import test from "node:test";

import { __captionCaptureTestInternals, enableMeetCaptions } from "../packages/core/src/meeting/caption-capture.ts";

function fakeCaptionSettingsPage(
  directProbe,
  {
    domMeetingLanguageClick = true,
    domMeetingLanguageOptionClick = true,
    failSelectors = [],
    translatedSelected = false,
    liveSelected = true,
  } = {},
) {
  const clicks = [];
  const filters = [];
  let dialogOpen = false;
  const page = {
    clicks,
    filters,
    keyboard: { async press(key) { clicks.push({ selector: "keyboard", key }); } },
    async evaluate(fn, arg) {
      if (typeof arg === "number") return true;
      const source = String(fn);
      if (source.includes('querySelectorAll("button, [role=button]")') || source.includes('querySelectorAll<HTMLElement>("button, [role=button]")')) {
        return directProbe;
      }
      if (source.includes("targetPattern=/^(Live captions|") && source.includes("triggerClick")) {
        clicks.push({ selector: "dom-live-captions-mode" });
        return true;
      }
      if (source.includes("targetPattern=/^(Live captions|")) {
        return Boolean(liveSelected && dialogOpen);
      }
      if (source.includes("targetPattern=/^(Translated captions|")) {
        return Boolean(translatedSelected && dialogOpen);
      }
      if (source.includes('[role="combobox"][aria-expanded="true"]')) {
        clicks.push({ selector: "dom-meeting-language-option", pattern: String(arg || "") });
        return domMeetingLanguageOptionClick;
      }
      if (source.includes("textHead: textOf(document.body)")) {
        return {};
      }
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
          if (String(selector).includes("caption settings") || String(selector).includes("More options") || String(selector).includes('[role="tab"]')) {
            dialogOpen = true;
          }
          if (String(selector).includes("Close")) dialogOpen = false;
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

  const records = [];
  const result = await enableMeetCaptions(page, {
    captionLanguage: "Chinese (Simplified)",
    diagnostics: { record: (type, detail) => records.push({ type, detail }) },
  });

  assert.equal(result.ok, true);
  assert.equal(result.alreadyOn, true);
  assert.equal(result.path, "inline");
  assert.ok(page.clicks.some((click) => click.selector === "dom-meeting-language-option" && String(click.pattern).includes("Chinese, Mandarin")));
  assert.deepEqual(records.find((record) => record.type === "caption_settings_live_radio_selected")?.detail, { attempt: 1, selected: true });
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
    translatedSelected: true,
  });

  const result = await enableMeetCaptions(page, { captionLanguage: "Chinese (Simplified)" });

  assert.equal(result.ok, false);
  assert.equal(result.method, "direct+settings-language");
  assert.deepEqual(result.language, { ok: false, method: "settings" });
});

class MockElement {
  constructor(tagName, attrs = {}, text = "", children = [], rect = {}) {
    this.tagName = tagName.toUpperCase();
    this.attrs = { ...attrs };
    this.innerText = text;
    this.textContent = text;
    this.children = children;
    this.parentElement = null;
    this.clicked = false;
    this.checked = Boolean(attrs.checked);
    this.rect = { top: 0, left: 0, width: 120, height: 20, ...rect };
    for (const child of children) child.parentElement = this;
  }
  getAttribute(name) {
    if (name === "id") return this.attrs.id || "";
    if (name === "type") return this.attrs.type || "";
    if (name === "for") return this.attrs.for || "";
    return this.attrs[name] || "";
  }
  getBoundingClientRect() {
    return {
      top: this.rect.top,
      left: this.rect.left,
      x: this.rect.left,
      y: this.rect.top,
      width: this.rect.width,
      height: this.rect.height,
      bottom: this.rect.top + this.rect.height,
      right: this.rect.left + this.rect.width,
    };
  }
  click() {
    this.clicked = true;
  }
  dispatchEvent() {
    this.clicked = true;
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
  querySelectorAll(selector) {
    return queryAll(this.children, selector, true);
  }
}

function queryAll(nodes, selector, includeSelf = true) {
  const selectors = selector.split(",").map((part) => part.trim()).filter(Boolean);
  const out = [];
  const visit = (node) => {
    if (includeSelf && selectors.some((part) => matchesSelector(node, part))) out.push(node);
    for (const child of node.children || []) visit(child);
  };
  for (const node of nodes) visit(node);
  return out;
}

function matchesSelector(node, selector) {
  if (selector === "*") return true;
  const role = node.getAttribute("role");
  if (selector === '[role="combobox"][aria-expanded="true"]') {
    return role === "combobox" && node.getAttribute("aria-expanded") === "true";
  }
  if (selector === '[role="option"]') return role === "option";
  if (selector === "label") return node.tagName.toLowerCase() === "label";
  if (selector === "[role='radio']" || selector === '[role="radio"]') return role === "radio";
  if (selector === 'input[type="radio"]') return node.tagName.toLowerCase() === "input" && node.getAttribute("type") === "radio";
  return false;
}

async function withMockDom(root, fn) {
  const previous = {
    document: globalThis.document,
    getComputedStyle: globalThis.getComputedStyle,
    HTMLElement: globalThis.HTMLElement,
    MouseEvent: globalThis.MouseEvent,
  };
  const all = queryAll([root], "*", true);
  globalThis.HTMLElement = MockElement;
  globalThis.MouseEvent = class MouseEvent {};
  globalThis.getComputedStyle = () => ({ visibility: "visible", display: "block" });
  globalThis.document = {
    body: root,
    querySelectorAll: (selector) => queryAll([root], selector, true),
    getElementById: (id) => all.find((node) => node.getAttribute("id") === id) || null,
  };
  try {
    return await fn();
  } finally {
    globalThis.document = previous.document;
    globalThis.getComputedStyle = previous.getComputedStyle;
    globalThis.HTMLElement = previous.HTMLElement;
    globalThis.MouseEvent = previous.MouseEvent;
  }
}

function mockDomPage(root) {
  return {
    async evaluate(fn, arg) {
      return withMockDom(root, () => fn(arg));
    },
    locator(selector) {
      return {
        filter() { return this; },
        first() { return this; },
        async waitFor() {},
        async scrollIntoViewIfNeeded() {},
        async click() {
          throw new Error(`unexpected locator fallback: ${selector}`);
        },
        async evaluate() {
          throw new Error(`unexpected locator fallback evaluate: ${selector}`);
        },
      };
    },
  };
}

test("clickCaptionLanguageOption scopes Chinese to the expanded meeting-language listbox", async () => {
  const sourceChinese = new MockElement("div", { role: "option" }, "Chinese, Mandarin (Simplified)", [], { top: 300 });
  const translationChinese = new MockElement("div", { role: "option" }, "Chinese (Simplified)", [], { top: 520 });
  const root = new MockElement("div", {}, "", [
    new MockElement("div", { role: "combobox", "aria-expanded": "true", "aria-controls": "meeting-list" }, "Language of the meeting language English", [], { top: 193 }),
    new MockElement("div", { id: "meeting-list", role: "listbox" }, "", [sourceChinese, new MockElement("div", { role: "option" }, "English", [], { top: 540 })]),
    new MockElement("div", { role: "combobox", "aria-expanded": "true", "aria-controls": "translation-list" }, "Your preferred language Afrikaans", [], { top: 513 }),
    new MockElement("div", { id: "translation-list", role: "listbox" }, "", [translationChinese]),
  ]);

  await __captionCaptureTestInternals.clickCaptionLanguageOption(mockDomPage(root), "Chinese (Simplified)");

  assert.equal(sourceChinese.clicked, true);
  assert.equal(translationChinese.clicked, false);
});

test("translatedCaptionsEnabled uses checked state instead of visible label text", async () => {
  const radio = new MockElement("input", { id: "translated-radio", type: "radio" }, "");
  const root = new MockElement("div", {}, "", [
    new MockElement("div", { role: "dialog" }, "", [
      new MockElement("label", { for: "translated-radio" }, "Translated captions"),
      radio,
    ]),
  ]);
  const page = mockDomPage(root);

  assert.equal(await __captionCaptureTestInternals.translatedCaptionsEnabled(page), false);
  radio.checked = true;
  assert.equal(await __captionCaptureTestInternals.translatedCaptionsEnabled(page), true);
});

test("liveCaptionsRadioSelected ignores inline label text and reads the dialog radio", async () => {
  const liveRadio = new MockElement("input", { id: "live-radio", type: "radio", checked: true }, "");
  const root = new MockElement("div", {}, "", [
    new MockElement("span", {}, "Live captions"),
    new MockElement("div", { role: "dialog" }, "", [
      new MockElement("label", { for: "live-radio" }, "Live captions"),
      liveRadio,
    ]),
  ]);

  assert.equal(await __captionCaptureTestInternals.liveCaptionsRadioSelected(mockDomPage(root)), true);
});
