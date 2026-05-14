/// <reference lib="dom" />
// @ts-check

/**
 * @typedef {{ record?: (type: string, detail?: any) => void } | null} Diagnostics
 * @typedef {import('playwright').Page} Page
 */

/**
 * @param {Page} page
 */
export async function detectAdmissionDeniedMessage(page) {
  return await page
    .evaluate(() => {
      const raw = document.body?.innerText || "";
      const patterns = [
        /you can't join this video call/i,
        /no one can join a meeting unless invited or admitted by the host/i,
        /returning to home screen/i,
        /无法加入此视频通话/i,
        /无法加入这场视频通话/i,
        /无法加入此通话/i,
      ];
      if (!patterns.some((pattern) => pattern.test(raw))) return null;
      return raw
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 4)
        .join(" / ");
    })
    .catch(() => null);
}

/**
 * @param {Page} page
 * @param {{
 *   diagnostics?: Diagnostics,
 *   dismissMeetPrompts?: (page: Page, diagnostics?: Diagnostics) => Promise<unknown>,
 *   evaluateMeetPageState: (page: Page) => Promise<any>,
 *   timeoutMs?: number,
 * }} options
 */
export async function waitForMeetAdmission(page, options) {
  const {
    diagnostics = null,
    dismissMeetPrompts = async () => {},
    evaluateMeetPageState,
    timeoutMs = 120_000,
  } = options;
  const ccSelector = [
    'button[aria-label*="captions" i]',
    'button[aria-label*="caption" i]',
    'button[aria-label*="字幕"]',
  ].join(", ");
  const leaveSelector = [
    'button[aria-label*="Leave call" i]',
    'button[aria-label*="Leave meeting" i]',
    'button[aria-label*="离开通话"]',
  ].join(", ");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await dismissMeetPrompts(page, diagnostics);
    const [captionVisible, leaveVisible] = await Promise.all([
      page
        .locator(ccSelector)
        .first()
        .isVisible({ timeout: 1000 })
        .catch(() => false),
      page
        .locator(leaveSelector)
        .first()
        .isVisible({ timeout: 1000 })
        .catch(() => false),
    ]);
    if (captionVisible) {
      const result = { state: "admitted", signal: "captions" };
      diagnostics?.record?.("admission_state", result);
      return result;
    }
    const denialMessage = await detectAdmissionDeniedMessage(page);
    if (denialMessage) {
      const result = { state: "denied", message: denialMessage };
      diagnostics?.record?.("admission_state", result);
      return result;
    }
    const pageState = await evaluateMeetPageState(page);
    // The old Cueboard joiner waited for the CC button before declaring
    // admission. A waiting-room page can still expose Leave/More controls, so
    // never treat those controls alone as admission. Keep pageState as a
    // fallback only when it explicitly says we are no longer waiting.
    if (pageState?.inMeeting && !pageState?.waitingForAdmit) {
      const result = { state: "admitted", signal: "page_state", pageState };
      diagnostics?.record?.("admission_state", result);
      return result;
    }
    if (pageState?.signIn) {
      const result = { state: "sign_in_required", pageState };
      diagnostics?.record?.("admission_state", result);
      return result;
    }
    diagnostics?.record?.("admission_wait", {
      inMeeting: pageState?.inMeeting === true,
      leaveVisible,
      waitingForAdmit: pageState?.waitingForAdmit === true,
      preJoin: pageState?.preJoin === true,
      textHead: String(pageState?.textHead || "").slice(0, 240),
    });
    await page.waitForTimeout(1000);
  }
  const result = { state: "timeout" };
  diagnostics?.record?.("admission_state", result);
  return result;
}
