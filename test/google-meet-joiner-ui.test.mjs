import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { chromium } from "playwright";

import { clickMeetShareScreenControlResult } from "../packages/core/src/meeting/google-meet-joiner-ui.ts";

function diagnostics() {
  return {
    sessionId: "ui_test",
    startedAt: new Date(0).toISOString(),
    events: [],
    console: [],
    pageErrors: [],
    requestFailures: [],
    screenshots: [],
    buttonInventories: [],
    jsonPath: "",
    record(type, detail = {}) {
      this.events.push({ ts: new Date(0).toISOString(), type, detail });
    },
  };
}

async function loadHtml(page, html) {
  await page.addInitScript(() => {
    window.__name = (fn) => fn;
  });
  await page.goto(`data:text/html,${encodeURIComponent(html)}`);
}

test("Meet share-screen click reports disabled present controls explicitly", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await loadHtml(
      page,
      `
      <!doctype html>
      <button aria-label="Share screen" disabled style="width: 120px; height: 48px">
        computer_arrow_up Share screen
      </button>
    `,
    );
    const diag = diagnostics();

    const result = await clickMeetShareScreenControlResult(page, diag);

    assert.equal(result.ok, false);
    assert.equal(result.reason, "share_screen_button_disabled");
    assert.equal(result.candidates?.[0]?.disabled, true);
    assert.match(result.candidates?.[0]?.label || "", /Share screen/);
    assert.ok(
      diag.events.some(
        (event) =>
          event.type === "click_miss" && event.detail?.reason === "share_screen_button_disabled",
      ),
    );
  } finally {
    await browser.close();
  }
});

test("Meet share-screen click still clicks enabled present controls", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await loadHtml(
      page,
      `
      <!doctype html>
      <button aria-label="Share screen" style="width: 120px; height: 48px" onclick="window.clicked = true">
        computer_arrow_up Share screen
      </button>
    `,
    );

    const result = await clickMeetShareScreenControlResult(page, diagnostics());
    const clicked = await page.evaluate(() => window.clicked === true);

    assert.equal(result.ok, true);
    assert.ok(result.selector);
    assert.equal(clicked, true);
  } finally {
    await browser.close();
  }
});
