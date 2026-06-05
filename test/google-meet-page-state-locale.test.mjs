import assert from "node:assert/strict";
import { afterAll as after, beforeAll as before, test } from "vite-plus/test";
import { chromium } from "playwright";

import { evaluateMeetPageState } from "../packages/core/src/meeting/google-meet-joiner-runtime-state.ts";

let browser;

before(async () => {
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
});

test("detects an in-call Google Meet page in Chinese locale", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <main>
        <div>wbn-gvks-nfs</div>
        <div>通话期间的消息</div>
        <button aria-label="call_end 退出通话">call_end 退出通话</button>
        <button aria-label="computer_arrow_up 共享屏幕">computer_arrow_up 共享屏幕</button>
        <button aria-label="chat_bubble 与所有人聊天">chat_bubble 与所有人聊天</button>
      </main>
    `);
    await page.evaluate(() => {
      globalThis.__name = (fn) => fn;
    });

    const state = await evaluateMeetPageState(page);

    assert.equal(state.ok, true);
    assert.equal(state.inMeeting, true);
    assert.equal(state.waitingForAdmit, false);
    assert.equal(state.cannotJoin, false);
  } finally {
    await page.close();
  }
});

test("keeps Chinese pre-join device controls out of the in-call state", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <main>
        <label>你的姓名 <input value="Onee Sama"></label>
        <button aria-label="关闭麦克风"></button>
        <button aria-label="关闭摄像头"></button>
        <button>立即加入</button>
      </main>
    `);
    await page.evaluate(() => {
      globalThis.__name = (fn) => fn;
    });

    const state = await evaluateMeetPageState(page);

    assert.equal(state.ok, true);
    assert.equal(state.inMeeting, false);
    assert.equal(state.preJoin, true);
  } finally {
    await page.close();
  }
});

test("keeps English pre-join Join now page out of the in-call state", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <main>
        <button aria-label="more_vert More options">more_vert</button>
        <button aria-label="Turn off microphone">mic</button>
        <button aria-label="Turn off camera">camera</button>
        <label>What's your name? <input value="Onee Sama"></label>
        <button>Join now</button>
      </main>
    `);
    await page.evaluate(() => {
      globalThis.__name = (fn) => fn;
    });

    const state = await evaluateMeetPageState(page);

    assert.equal(state.ok, true);
    assert.equal(state.inMeeting, false);
    assert.equal(state.preJoin, true);
  } finally {
    await page.close();
  }
});
