import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";

import { readBrowserInitSource } from "../packages/core/src/browser-init-source.ts";

const meetChatHelperSource = readBrowserInitSource(
  new URL("../packages/core/src/realtime/realtime-browser-init-builder.ts", import.meta.url).href,
  "./realtime-browser-meet-chat-helpers.js",
  "./realtime-browser-meet-chat-helpers.ts",
);

async function runMeetChatScan(html) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(html);
    await page.addScriptTag({ content: meetChatHelperSource });
    return await page.evaluate(() => {
      const timeline = [];
      const outbound = [];
      const state = {
        meetChat: {
          messages: [],
          links: [],
          errors: [],
          injected: 0,
        },
      };
      const helper = window.__MAB_REALTIME_MEET_CHAT_HELPERS.create({
        config: { botName: "Onee Sama" },
        state,
        observedMeetChatKeys: new Set(),
        postJson: async () => ({ ok: true }),
        localServiceUrl: (path) => path,
        recordTimeline: (type, detail = {}) => timeline.push({ type, detail }),
        sendRealtimeEvent: (event) => {
          outbound.push(event);
          return "custom-event";
        },
        updateFeedback: () => {},
      });
      return {
        scanned: helper.scanMeetChatMessages("mutation"),
        timeline,
        outbound,
        state,
      };
    });
  } finally {
    await browser.close();
  }
}

test("Meet chat observer ignores support links outside the chat surface", async () => {
  const result = await runMeetChatScan(`
    <!doctype html>
    <html>
      <body>
        <main>
          <a
            href="https://support.google.com/meet/answer/9852160?hl=en_US"
            style="display:block;width:480px;height:24px"
          >
            Learn more about removal from this video call
          </a>
        </main>
      </body>
    </html>
  `);

  assert.equal(result.scanned.length, 0);
  assert.equal(result.timeline.length, 0);
  assert.equal(result.outbound.length, 0);
  assert.equal(result.state.meetChat.injected, 0);
});

test("Meet chat observer still accepts links inside the chat surface", async () => {
  const result = await runMeetChatScan(`
    <!doctype html>
    <html>
      <body>
        <section aria-label="Chat with everyone" style="display:block;width:520px;height:120px">
          <div data-message-id="msg-1" style="display:block;width:500px;height:48px">
            Peng Xiao: please open
            <a href="https://meet.google.com/abc-defg-hij">https://meet.google.com/abc-defg-hij</a>
          </div>
        </section>
      </body>
    </html>
  `);

  assert.equal(result.scanned.length, 1);
  assert.equal(result.timeline.length, 1);
  assert.equal(result.timeline[0].type, "meet_chat_observed");
  assert.equal(result.outbound.length, 1);
  assert.equal(result.outbound[0].item.metadata.source, "meet_chat_observer");
  assert.deepEqual(result.state.meetChat.links, ["https://meet.google.com/abc-defg-hij"]);
});
