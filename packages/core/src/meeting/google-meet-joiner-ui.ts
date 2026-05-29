import { buildScreenShareInitScript } from "./screen-share-init-builder.ts";
import {
  DEFAULT_SYNTHETIC_SCREEN_SHARE_FPS,
  DEFAULT_SYNTHETIC_SCREEN_SHARE_HEIGHT,
  DEFAULT_SYNTHETIC_SCREEN_SHARE_WIDTH,
  nowIso,
  positiveInteger,
  type AccessibilityNodeLike,
  type AccessibilitySnapshotApi,
  type ButtonInventoryEntry,
  type Diagnostics,
  type MeetPageState,
  type Page,
  type PresentationState,
  type ScreenShareBridgeInput,
  type ScreenShareControllerState,
  type ShareScreenDomClickResult,
} from "./google-meet-joiner-base.ts";
export async function collectButtonInventory(
  page: Page,
  diagnostics: Diagnostics,
  label: string,
): Promise<ButtonInventoryEntry[]> {
  if (process.env.MAB_SKIP_BUTTON_INVENTORY === "1") {
    diagnostics.buttonInventories.push({ ts: nowIso(), label, buttons: [] });
    diagnostics.record("button_inventory_skipped", { label });
    return [];
  }
  const inventoryPromise = page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll<HTMLElement>("button, [role=button]"));
    return nodes
      .slice(0, 80)
      .map((node, index) => {
        const rect = node.getBoundingClientRect();
        return {
          index,
          tag: node.tagName.toLowerCase(),
          text: (node.innerText || node.textContent || "").trim().slice(0, 120),
          aria: node.getAttribute("aria-label") || "",
          role: node.getAttribute("role") || "",
          disabled: Boolean(
            ("disabled" in node && typeof node.disabled === "boolean" && node.disabled) ||
            node.getAttribute("aria-disabled") === "true",
          ),
          visible:
            rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== "hidden",
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        };
      })
      .filter((button) => button.text || button.aria || button.visible);
  });
  const buttons = (await Promise.race([
    inventoryPromise,
    new Promise((resolve) =>
      setTimeout(
        () =>
          resolve([
            {
              error: "button_inventory_timeout",
            },
          ]),
        2500,
      ),
    ),
  ]).catch((error) => [
    {
      error: String(error?.message || error),
    },
  ])) as ButtonInventoryEntry[];
  diagnostics.buttonInventories.push({ ts: nowIso(), label, buttons });
  diagnostics.record("button_inventory", { label, count: buttons.length });
  return buttons;
}

export async function clickFirstVisible(
  page: Page,
  selectors: string[],
  timeout = 1800,
  diagnostics: Diagnostics | null = null,
) {
  for (const selector of selectors) {
    try {
      await page.locator(selector).first().click({ timeout });
      diagnostics?.record("click", { selector });
      return selector;
    } catch (error) {
      diagnostics?.record("click_miss", {
        selector,
        error: String(error?.message || error).slice(0, 180),
      });
      // Keep trying the next localized / aria selector.
    }
  }
  return "";
}

export async function withTimeout<T, F>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: F,
): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<F>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function collectAccessibilitySnapshotText(node: unknown, output: string[] = []): string[] {
  if (!node || typeof node !== "object") return output;
  const accessibilityNode = node as AccessibilityNodeLike;
  for (const field of ["name", "value", "description"]) {
    const value = accessibilityNode[field as keyof AccessibilityNodeLike];
    if (typeof value === "string" && value.trim()) output.push(value.trim());
  }
  for (const child of accessibilityNode.children || [])
    collectAccessibilitySnapshotText(child, output);
  return output;
}

export function collectAccessibilityButtons(
  node: unknown,
  output: Array<{ label: string; role: string }> = [],
) {
  if (!node || typeof node !== "object") return output;
  const accessibilityNode = node as AccessibilityNodeLike;
  if (
    accessibilityNode.role === "button" &&
    typeof accessibilityNode.name === "string" &&
    accessibilityNode.name.trim()
  ) {
    output.push({
      label: accessibilityNode.name.trim().slice(0, 160),
      role: accessibilityNode.role,
    });
  }
  for (const child of accessibilityNode.children || []) collectAccessibilityButtons(child, output);
  return output;
}

export async function evaluateMeetAccessibilityState(page: Page): Promise<MeetPageState> {
  const accessibility = (page as Page & { accessibility?: AccessibilitySnapshotApi }).accessibility;
  if (!accessibility?.snapshot) {
    return { ok: false, error: "meet_accessibility_unavailable" };
  }
  const snapshot = await withTimeout(
    accessibility.snapshot({ interestingOnly: false }),
    2500,
    null,
  ).catch(() => null);
  if (!snapshot) return { ok: false, error: "meet_accessibility_state_timeout" };
  const text = collectAccessibilitySnapshotText(snapshot).join("\n").replace(/\s+/g, " ").trim();
  const buttons = collectAccessibilityButtons(snapshot).slice(0, 30);
  const waitingForAdmit =
    /Please wait until a meeting host brings you into the call|Someone will let you in soon|waiting for.*host/i.test(
      text,
    );
  const inMeetingSignals = [
    /You have joined the call/i.test(text),
    /Your camera is on/i.test(text),
    /Your microphone is on/i.test(text),
    /Call controls/i.test(text),
    /Leave call|Leave meeting|退出通话|离开通话|退出会议|离开会议/i.test(text),
    /Present now|Share screen|共享屏幕|展示/i.test(text),
    buttons.some((button) =>
      /Leave call|Leave meeting|退出通话|离开通话|退出会议|离开会议|Turn off microphone|Turn on microphone|Turn off camera|Turn on camera|Raise hand|举手|More options|Share screen|Present now|共享屏幕|与所有人聊天|会议工具|发送回应/i.test(
        button.label,
      ),
    ),
  ];
  const inMeeting = !waitingForAdmit && inMeetingSignals.some(Boolean);
  const cannotJoin =
    !inMeeting &&
    !waitingForAdmit &&
    /You can't join this video call|No one can join a meeting unless invited or admitted by the host/i.test(
      text,
    );
  return {
    ok: true,
    source: "accessibility",
    url: page.url(),
    title: "",
    inMeeting,
    waitingForAdmit,
    preJoin: /Join now|Ask to join|Getting ready|立即加入|申请加入|你的姓名/i.test(text),
    signIn: /Forgot email|Create account|Use your Google Account/i.test(text),
    cannotJoin,
    textHead: text.slice(0, 1000),
    buttons,
  };
}

export async function revealMeetToolbar(page: Page, diagnostics: Diagnostics | null = null) {
  try {
    const viewport = page.viewportSize() || { width: 1920, height: 1080 };
    await page.mouse.move(Math.round(viewport.width / 2), Math.max(1, viewport.height - 48));
    await page.waitForTimeout(250);
    diagnostics?.record("meet_toolbar_revealed", {
      width: viewport.width,
      height: viewport.height,
    });
  } catch (error) {
    diagnostics?.record("meet_toolbar_reveal_failed", {
      error: String(error?.message || error).slice(0, 180),
    });
  }
}

export async function getMeetPresentationState(page: Page): Promise<PresentationState> {
  return await withTimeout(
    page.evaluate(() => {
      const text = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
      const has = (pattern) => pattern.test(text);
      const isDisabled = (node: HTMLElement) =>
        Boolean(
          ("disabled" in node && typeof node.disabled === "boolean" && node.disabled) ||
          node.getAttribute("aria-disabled") === "true",
        );
      const buttons = Array.from(document.querySelectorAll<HTMLElement>("button, [role=button]"))
        .map((node, index) => {
          const rect = node.getBoundingClientRect();
          const label =
            `${node.innerText || node.textContent || ""} ${node.getAttribute("aria-label") || ""}`
              .replace(/\s+/g, " ")
              .trim();
          return {
            index,
            label: label.slice(0, 120),
            disabled: isDisabled(node),
            visible:
              rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== "hidden",
            rect: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
          };
        })
        .filter((button) => button.visible && button.label);
      return {
        ok: true,
        presenting: has(/\b(You'?re presenting|You are presenting|Stop presenting)\b/i),
        starting: has(/Presentation is starting/i),
        failed: has(/Can't share your screen|Something went wrong when screen sharing/i),
        textHead: text.slice(0, 800),
        shareButtons: buttons
          .filter((button) =>
            /share screen|present|presentation|stop presenting/i.test(button.label),
          )
          .slice(0, 12),
        buttons: buttons.slice(0, 30),
      };
    }),
    2500,
    { ok: false, error: "presentation_state_timeout" },
  ).catch((error) => ({ ok: false, error: String(error?.message || error) }));
}

export async function clickMeetShareScreenControl(
  page: Page,
  diagnostics: Diagnostics | null = null,
  options: { allowCoordinateFallback?: boolean } = {},
) {
  await revealMeetToolbar(page, diagnostics);
  const domClick = await withTimeout<ShareScreenDomClickResult, ShareScreenDomClickResult>(
    page.evaluate(() => {
      const isDisabled = (node: HTMLElement) =>
        Boolean(
          ("disabled" in node && typeof node.disabled === "boolean" && node.disabled) ||
          node.getAttribute("aria-disabled") === "true",
        );
      const isVisible = (node) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== "hidden" &&
          style.display !== "none"
        );
      };
      const nodes = Array.from(document.querySelectorAll<HTMLElement>("button, [role=button]"));
      const candidates = nodes
        .map((node, index) => {
          const label =
            `${node.innerText || node.textContent || ""} ${node.getAttribute("aria-label") || ""}`
              .replace(/\s+/g, " ")
              .trim();
          const rect = node.getBoundingClientRect();
          return {
            node,
            index,
            label,
            disabled: isDisabled(node),
            visible: isVisible(node),
            rect: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
          };
        })
        .filter(
          (candidate) =>
            candidate.visible &&
            !candidate.disabled &&
            /\b(share screen|present now|present)\b|computer_arrow_up|present_to_all/i.test(
              candidate.label,
            ),
        );
      const candidate = candidates[0];
      if (!candidate) {
        return {
          ok: false,
          reason: "share_screen_button_not_found",
          candidates: candidates.slice(0, 8).map(({ index, label, disabled, visible, rect }) => ({
            index,
            label,
            disabled,
            visible,
            rect,
          })),
        };
      }
      candidate.node.click();
      return {
        ok: true,
        selector: "dom:meet-share-screen-button",
        button: {
          index: candidate.index,
          label: candidate.label,
          rect: candidate.rect,
        },
      };
    }),
    2500,
    { ok: false, reason: "share_screen_dom_click_timeout" },
  ).catch(
    (error): ShareScreenDomClickResult => ({
      ok: false,
      reason: "share_screen_dom_click_error",
      error: String(error?.message || error).slice(0, 240),
    }),
  );
  if (domClick.ok) {
    diagnostics?.record("click", { selector: domClick.selector, button: domClick.button });
    return domClick.selector;
  }
  diagnostics?.record("click_miss", domClick);

  const locatorCandidates = [
    {
      selector: "role:button[name=/share screen|present now|present/i]",
      locator: () =>
        page.getByRole("button", { name: /share screen|present now|present/i }).first(),
    },
    {
      selector: "[aria-label*=present/share-screen]",
      locator: () =>
        page
          .locator(
            '[aria-label*="Present" i], [aria-label*="Share screen" i], [data-tooltip*="Present" i], [data-tooltip*="Share screen" i]',
          )
          .first(),
    },
  ];
  for (const candidate of locatorCandidates) {
    try {
      await candidate.locator().click({ timeout: 2500 });
      diagnostics?.record("click", { selector: candidate.selector });
      return candidate.selector;
    } catch (error) {
      diagnostics?.record("click_miss", {
        selector: candidate.selector,
        error: String(error?.message || error).slice(0, 180),
      });
    }
  }

  if (options.allowCoordinateFallback) {
    try {
      const viewport = page.viewportSize() || { width: 1920, height: 1080 };
      const x = Math.round(viewport.width * 0.47);
      const y = Math.max(1, viewport.height - 40);
      await page.mouse.click(x, y, { delay: 20 });
      diagnostics?.record("click", { selector: "coordinate:bottom-toolbar-share-screen", x, y });
      return "coordinate:bottom-toolbar-share-screen";
    } catch (error) {
      diagnostics?.record("click_miss", {
        selector: "coordinate:bottom-toolbar-share-screen",
        error: String(error?.message || error).slice(0, 180),
      });
    }
  }

  return "";
}

export async function readScreenShareControllerState(
  page: Page,
): Promise<ScreenShareControllerState | null> {
  return await withTimeout(
    page.evaluate(() => {
      if (window.MAB_SCREEN_SHARE_CONTROLLER?.status)
        return window.MAB_SCREEN_SHARE_CONTROLLER.status();
      if (window.MAB_SCREEN_SHARE_CONTROLLER?.state)
        return window.MAB_SCREEN_SHARE_CONTROLLER.state();
      if (window.MAB_SCREEN_SHARE_CONTROLLER?.mode)
        return { ok: true, mode: window.MAB_SCREEN_SHARE_CONTROLLER.mode };
      return null;
    }),
    2500,
    { ok: false, error: "screen_share_controller_state_timeout" },
  ).catch((error) => ({ ok: false, error: String(error?.message || error) }));
}

export async function waitForScreenShareImageSource(page: Page, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  let state: ScreenShareControllerState | null = null;
  while (Date.now() < deadline) {
    state = await readScreenShareControllerState(page);
    const screenShare = state as any;
    if (screenShare?.imageUrl && screenShare?.imageReady) {
      return { ok: true, state };
    }
    const errors = Array.isArray(screenShare?.errors) ? screenShare.errors : [];
    if (screenShare?.imageError || errors.some((entry) => /image/i.test(String(entry)))) {
      return {
        ok: false,
        error: String(
          screenShare.imageError || errors.find((entry) => /image/i.test(String(entry))),
        ),
        state,
      };
    }
    await page.waitForTimeout(100);
  }
  return {
    ok: false,
    error: "screen_share_image_source_not_attached",
    state,
  };
}

export async function ensureScreenShareController(page: Page, input: ScreenShareBridgeInput = {}) {
  const current = await readScreenShareControllerState(page);
  if (current?.ok || current?.mode) return { ok: true, installed: false, state: current };
  const installScript = buildScreenShareInitScript({
    enabled: true,
    mode: input.mode || "synthetic",
    title: input.title || "Meeting Avatar Bot",
    subtitle: input.subtitle || "Agent screen share",
    width:
      positiveInteger(input.width ?? input.screenShareWidth) ||
      DEFAULT_SYNTHETIC_SCREEN_SHARE_WIDTH,
    height:
      positiveInteger(input.height ?? input.screenShareHeight) ||
      DEFAULT_SYNTHETIC_SCREEN_SHARE_HEIGHT,
    fps: positiveInteger(input.fps ?? input.screenShareFps) || DEFAULT_SYNTHETIC_SCREEN_SHARE_FPS,
    videoUrl: input.videoUrl || input.url || input.path || "",
    muted: input.muted !== false,
  });
  const install: { ok: boolean; error?: string } = await page
    .evaluate(installScript)
    .then(() => ({ ok: true }))
    .catch((error) => ({ ok: false, error: String(error?.message || error) }));
  if (!install.ok) {
    return { ok: false, installed: false, error: install.error, state: current };
  }
  const installed = await readScreenShareControllerState(page);
  return {
    ok: Boolean(installed?.ok || installed?.mode),
    installed: true,
    state: installed,
  };
}
