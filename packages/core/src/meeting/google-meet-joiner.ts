import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join as pathJoin, resolve as pathResolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getRuntimeConfig } from "../env.ts";
import type { ScreenShareState, VideoStageState } from "../browser-runtime-types.ts";
import { buildAvatarInitScript } from "../avatar/init-script-builder.ts";
import { buildLocalDialogInitScript } from "../dialog/local-dialog-init-builder.ts";
import { enableMeetCaptions, installMeetCaptionCapture } from "./caption-capture.ts";
import { waitForMeetAdmission } from "./meet-admission.ts";
import { installMeetLocalPlaybackMute } from "./meet-local-playback-mute.ts";
import { createMeetingRecorder } from "./meeting-recorder.ts";
import { dismissMeetPrompts, installMeetPromptAutoDismisser } from "./meet-prompts.ts";
import { buildScreenShareInitScript } from "./screen-share-init-builder.ts";
import { buildRealtimeBrowserInitScript } from "../realtime/realtime-browser-init-builder.ts";
import { buildWorkerResultInitScript } from "../realtime/worker-result-init-builder.ts";
import {
  buildRealtimeInstructions,
  buildRealtimeSessionConfig,
  realtimeToolSchemas,
} from "../realtime/realtime-contract.ts";

const require = createRequire(import.meta.url);

type Page = import("playwright").Page;
type BrowserContext = import("playwright").BrowserContext;

interface MeetUrlOptions {
  allowNonGoogleMeet?: boolean;
}

interface VideoStageInput {
  stageTitle?: string;
  title?: string;
  subtitle?: string;
  videoUrl?: string;
  url?: string;
  path?: string;
  muted?: boolean;
  width?: number | string;
  height?: number | string;
}

interface ScreenShareBridgeInput extends VideoStageInput {
  mode?: string;
  screenShareMode?: string;
  fps?: number | string;
  preview?: boolean;
  allowCoordinateFallback?: boolean;
  waitMs?: number;
}

interface MeetChatInput {
  text?: string;
  message?: string;
  limit?: number;
  count?: number;
  onlyLinks?: boolean;
  only_links?: boolean;
}

interface ButtonInventoryEntry {
  index?: number;
  tag?: string;
  text?: string;
  aria?: string;
  role?: string;
  disabled?: boolean;
  visible?: boolean;
  rect?: { x: number; y: number; width: number; height: number };
  label?: string;
  error?: string;
}

interface Diagnostics {
  sessionId: string;
  startedAt: string;
  events: Array<{ ts: string; type: string; detail: unknown }>;
  console: Array<{ ts: string; type: string; text: string }>;
  pageErrors: Array<{ ts: string; message: string }>;
  requestFailures: Array<{ ts: string; url: string; method: string; failure: string }>;
  screenshots: Array<{ ts: string; name: string; path: string }>;
  buttonInventories: Array<{ ts: string; label: string; buttons: ButtonInventoryEntry[] }>;
  jsonPath: string;
  saving?: boolean;
  record(type: string, detail?: unknown): void;
}

interface AccessibilityNodeLike {
  name?: unknown;
  value?: unknown;
  description?: unknown;
  role?: unknown;
  children?: AccessibilityNodeLike[];
}

interface AccessibilitySnapshotApi {
  snapshot(options: { interestingOnly: boolean }): Promise<unknown>;
}

interface PresentationButton {
  index: number;
  label: string;
  disabled: boolean;
  visible: boolean;
  rect: { x: number; y: number; width: number; height: number };
}

interface PresentationState {
  ok: boolean;
  presenting?: boolean;
  starting?: boolean;
  failed?: boolean;
  textHead?: string;
  shareButtons?: PresentationButton[];
  buttons?: PresentationButton[];
  error?: string;
}

interface ShareScreenButtonInfo {
  index: number;
  label: string;
  rect: { x: number; y: number; width: number; height: number };
}

type ShareScreenDomClickResult =
  | {
      ok: true;
      selector: string;
      button: ShareScreenButtonInfo;
    }
  | {
      ok: false;
      reason: string;
      candidates?: PresentationButton[];
      error?: string;
    };

type ScreenShareControllerState = ScreenShareState | { ok: boolean; error?: string; mode?: string };

interface GuestNameEvalResult {
  ok: boolean;
  reason?: string;
  textHead?: string;
  tag?: string;
  aria?: string;
  placeholder?: string;
  valueLength?: number;
  error?: string;
}

type MeetJoinButtonEvalResult =
  | {
      ok: true;
      selector: string;
      button: PresentationButton;
      candidates: PresentationButton[];
    }
  | {
      ok: false;
      error?: string;
      candidates: PresentationButton[];
    };

interface MeetPageState {
  ok: boolean;
  url?: string;
  title?: string;
  source?: string;
  inMeeting?: boolean;
  participantCount?: number | null;
  waitingForAdmit?: boolean;
  preJoin?: boolean;
  signIn?: boolean;
  cannotJoin?: boolean;
  textHead?: string;
  buttons?: Array<PresentationButton | { label: string; role: string }>;
  error?: string;
  jsProbe?: { ok: boolean; error?: string };
  accessibilityProbe?: { ok: boolean; error?: string };
}

interface GoogleMeetJoinerOptions {
  allowNonGoogleMeet?: boolean;
  playwrightModulePath?: string;
  chromiumExecutablePath?: string;
}

interface GoogleMeetJoinInput extends ScreenShareBridgeInput {
  meetUrl?: string;
  sessionId?: string;
  botName?: string;
  dryRun?: boolean;
  installAvatar?: boolean;
  installRealtimeBridge?: boolean;
  installLocalDialogBridge?: boolean;
  installWorkerResultBridge?: boolean;
  installScreenShareBridge?: boolean;
  autoStartScreenShare?: boolean;
  workerPollUrl?: string;
  recordMeeting?: boolean;
  captureCaptions?: boolean;
  captionLanguage?: string;
  artifactsDir?: string;
  meetAudioBackend?: string;
  browserUserDataDir?: string;
  meetProfileMode?: string;
  browserViewportWidth?: number | string;
  browserViewportHeight?: number | string;
  allowNonGoogleMeet?: boolean;
  realtimeInstructions?: string;
  avatarModelUrl?: string;
  avatarDepsDir?: string;
  avatarLayout?: string;
  disableLive2D?: boolean;
  deferAvatarRendererUntilJoined?: boolean;
  avatarCanvasWidth?: number | string;
  avatarCanvasHeight?: number | string;
  avatarCaptureFps?: number | string;
  realtimeBridgeMode?: string;
  realtimeAgentRuntime?: string;
  realtimeToolCallbackToken?: string;
  autoRespondToWorkerResults?: boolean;
  realtimeTools?: unknown[];
  realtimeSession?: Record<string, unknown>;
  sendRealtimeSessionUpdate?: boolean;
  includeParticipantAudio?: boolean;
  forwardMeetAudioToRealtime?: boolean;
  realtimeFallbackToLocalMic?: boolean;
  workerDelegateUrl?: string;
  workerStatusUrl?: string;
  autoConnectRealtime?: boolean;
  realtimeTokenUrl?: string;
  realtimeSdpUrl?: string;
  localDialogTurnUrl?: string;
  localDialogTtsMode?: string;
  localDialogTtsUrl?: string;
  localDialogSttProvider?: string;
  localDialogTtsProvider?: string;
  localDialogTtsGain?: number | string;
  screenShareTitle?: string;
  screenShareSubtitle?: string;
  screenShareWidth?: number | string;
  screenShareHeight?: number | string;
  screenShareFps?: number | string;
  workerResultMinCreatedAt?: string;
  localDialogAcceptanceUtterance?: string;
  collectFixtureState?: boolean;
  browserExtraArgs?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function assertMeetUrl(meetUrl: string, options: MeetUrlOptions = {}) {
  if (options.allowNonGoogleMeet) return;
  if (!/^https:\/\/meet\.google\.com\/[a-z-]+/i.test(meetUrl || "")) {
    throw new Error("meetUrl must be a Google Meet URL");
  }
}

function normalizeMeetProfileMode(mode: unknown, hasUserDataDir: boolean): "guest" | "persistent" {
  const normalized = String(mode || "")
    .trim()
    .toLowerCase();
  if (!normalized) return hasUserDataDir ? "persistent" : "guest";
  if (normalized === "guest" || normalized === "persistent") return normalized;
  throw new Error("MAB_MEET_PROFILE_MODE must be guest or persistent");
}

function escapeHtml(value: unknown): string {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function normalizeStageVideoUrl(value = ""): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw) || /^file:\/\//i.test(raw) || /^data:/i.test(raw)) return raw;
  return pathToFileURL(pathResolve(raw)).toString();
}

function buildVideoStageHtml(input: VideoStageInput = {}): string {
  const title = escapeHtml(input.stageTitle || input.title || "Meeting Avatar Bot");
  const heading = escapeHtml(input.title || "Onee Sama video stage");
  const subtitle = escapeHtml(input.subtitle || "Screen share video stage");
  const videoUrl = normalizeStageVideoUrl(input.videoUrl || input.url || input.path || "");
  const videoTag = videoUrl
    ? `<video id="stage-video" src="${escapeHtml(videoUrl)}" controls autoplay loop playsinline ${input.muted === false ? "" : "muted"}></video>`
    : `<canvas id="stage-canvas" width="1280" height="720"></canvas>`;
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <style>
    html, body { margin: 0; height: 100%; background: #05070a; color: white; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, sans-serif; overflow: hidden; }
    .stage { width: 100vw; height: 100vh; display: grid; place-items: center; background: radial-gradient(circle at 25% 15%, #253a5d 0, transparent 32%), linear-gradient(135deg, #071018, #111827 52%, #05070a); }
    video, canvas { width: 100vw; height: 100vh; object-fit: contain; background: #05070a; }
    .overlay { position: fixed; left: 32px; bottom: 28px; padding: 14px 18px; border-radius: 10px; background: rgba(5, 7, 10, .72); border: 1px solid rgba(255,255,255,.16); backdrop-filter: blur(10px); }
    .overlay h1 { margin: 0 0 5px; font-size: 28px; line-height: 1.1; }
    .overlay p { margin: 0; font-size: 16px; color: rgba(255,255,255,.76); }
  </style>
</head>
<body>
  <main class="stage">${videoTag}</main>
  <section class="overlay"><h1>${heading}</h1><p>${subtitle}</p></section>
  <script>
    const state = { ok: true, title: document.title, videoUrl: ${JSON.stringify(videoUrl)}, frames: 0, playing: false, errors: [] };
    window.MAB_VIDEO_STAGE = state;
    const video = document.getElementById("stage-video");
    const canvas = document.getElementById("stage-canvas");
    if (video) {
      const mark = () => { state.playing = !video.paused; state.currentTime = video.currentTime; state.duration = video.duration || 0; };
      video.addEventListener("play", mark);
      video.addEventListener("pause", mark);
      video.addEventListener("timeupdate", mark);
      video.addEventListener("error", () => state.errors.push("video_error"));
      video.play().then(mark).catch((error) => {
        state.errors.push(String(error && error.message || error));
        mark();
      });
    }
    if (canvas) {
      const ctx = canvas.getContext("2d");
      function draw() {
        state.frames += 1;
        const t = state.frames / 60;
        const w = canvas.width;
        const h = canvas.height;
        const g = ctx.createLinearGradient(0, 0, w, h);
        g.addColorStop(0, "hsl(" + ((t * 32) % 360) + " 78% 22%)");
        g.addColorStop(.55, "#111827");
        g.addColorStop(1, "hsl(" + (((t * 32) + 110) % 360) + " 72% 20%)");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = "rgba(255,255,255,.12)";
        for (let i = 0; i < 9; i += 1) {
          ctx.fillRect(((i * 151 + state.frames * 9) % (w + 240)) - 120, 110 + i * 58, 280, 3);
        }
        ctx.fillStyle = "#fff";
        ctx.font = "700 72px system-ui, sans-serif";
        ctx.fillText(${JSON.stringify(input.title || "Video stage ready")}, 80, 180);
        ctx.font = "400 34px system-ui, sans-serif";
        ctx.fillStyle = "rgba(255,255,255,.78)";
        ctx.fillText(${JSON.stringify(input.subtitle || "Drop a video URL or local file path to play it here.")}, 84, 240);
        requestAnimationFrame(draw);
      }
      draw();
    }
  </script>
</body>
</html>`;
}

async function loadPlaywright(modulePath?: string) {
  if (modulePath) return require(modulePath);
  return await import("playwright");
}

function createDiagnostics(sessionId: string, screenshotDir: string): Diagnostics {
  const diagnostics: Diagnostics = {
    sessionId,
    startedAt: nowIso(),
    events: [],
    console: [],
    pageErrors: [],
    requestFailures: [],
    screenshots: [],
    buttonInventories: [],
    jsonPath: `${screenshotDir}/${sessionId}-diagnostics.json`,
    record: () => {},
  };

  diagnostics.record = (type, detail = {}) => {
    diagnostics.events.push({ ts: nowIso(), type, detail });
  };

  return diagnostics;
}

async function saveDiagnostics(diagnostics: Diagnostics) {
  if (diagnostics.saving) return;
  diagnostics.saving = true;
  const serializable = { ...diagnostics };
  delete serializable.record;
  delete serializable.saving;
  try {
    await writeFile(diagnostics.jsonPath, `${JSON.stringify(serializable, null, 2)}\n`);
  } finally {
    diagnostics.saving = false;
  }
}

function installPageDiagnostics(page: Page, diagnostics: Diagnostics) {
  page.on("console", (message) => {
    diagnostics.console.push({
      ts: nowIso(),
      type: message.type(),
      text: message.text().slice(0, 1000),
    });
  });
  page.on("pageerror", (error) => {
    diagnostics.pageErrors.push({
      ts: nowIso(),
      message: String(error?.message || error).slice(0, 1000),
    });
  });
  page.on("requestfailed", (request) => {
    diagnostics.requestFailures.push({
      ts: nowIso(),
      url: request.url(),
      method: request.method(),
      failure: request.failure()?.errorText || "request_failed",
    });
  });
}

async function takeScreenshot(page: Page, diagnostics: Diagnostics, name: string): Promise<string> {
  if (process.env.MAB_SKIP_SCREENSHOTS === "1") {
    diagnostics.record("screenshot_skipped", { name });
    return "";
  }
  const path = diagnostics.jsonPath.replace("-diagnostics.json", `-${name}.png`);
  try {
    const result = await withTimeout(
      page.screenshot({
        path,
        fullPage: false,
        animations: "disabled",
        timeout: 8000,
      }),
      9000,
      { timedOut: true },
    );
    if (
      typeof result === "object" &&
      result !== null &&
      "timedOut" in result &&
      result.timedOut
    ) {
      throw new Error("screenshot_timeout");
    }
    diagnostics.screenshots.push({ ts: nowIso(), name, path });
    diagnostics.record("screenshot", { name, path });
    return path;
  } catch (error) {
    diagnostics.record("screenshot_failed", {
      name,
      path,
      error: String(error?.message || error).slice(0, 300),
    });
    return "";
  }
}

async function collectButtonInventory(
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

async function clickFirstVisible(
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

async function withTimeout<T, F>(promise: Promise<T>, timeoutMs: number, fallback: F): Promise<T | F> {
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

function collectAccessibilitySnapshotText(node: unknown, output: string[] = []): string[] {
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

function collectAccessibilityButtons(
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
  for (const child of accessibilityNode.children || [])
    collectAccessibilityButtons(child, output);
  return output;
}

async function evaluateMeetAccessibilityState(page: Page): Promise<MeetPageState> {
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
    /Leave call|Leave meeting/i.test(text),
    /Present now|Share screen/i.test(text),
    buttons.some((button) =>
      /Leave call|Leave meeting|Turn off microphone|Turn on microphone|Turn off camera|Turn on camera|Raise hand|More options|Share screen|Present now/i.test(
        button.label,
      ),
    ),
  ];
  return {
    ok: true,
    source: "accessibility",
    url: page.url(),
    title: "",
    inMeeting: !waitingForAdmit && inMeetingSignals.some(Boolean),
    waitingForAdmit,
    preJoin: /Join now|Ask to join|Getting ready/i.test(text),
    signIn: /Forgot email|Create account|Use your Google Account/i.test(text),
    cannotJoin:
      /You can't join this video call|No one can join a meeting unless invited or admitted by the host/i.test(
        text,
      ),
    textHead: text.slice(0, 1000),
    buttons,
  };
}

async function revealMeetToolbar(page: Page, diagnostics: Diagnostics | null = null) {
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

async function getMeetPresentationState(page: Page): Promise<PresentationState> {
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

function getNativeScreenShareFailureHint(
  presentation: PresentationState | null | undefined,
) {
  const text = presentation?.textHead || "";
  if (
    process.platform === "darwin" &&
    /Can't share your screen|Something went wrong when screen sharing/i.test(text)
  ) {
    return {
      reason: "macos_screen_recording_permission_required",
      permission: "System Settings > Privacy & Security > Screen & System Audio Recording",
      action:
        "Grant the browser used by MAB_CHROMIUM_EXECUTABLE permission, then restart that browser session.",
    };
  }
  return null;
}

async function clickMeetShareScreenControl(
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
  ).catch((error): ShareScreenDomClickResult => ({
    ok: false,
    reason: "share_screen_dom_click_error",
    error: String(error?.message || error).slice(0, 240),
  }));
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

async function readScreenShareControllerState(page: Page): Promise<ScreenShareControllerState | null> {
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

async function ensureScreenShareController(page: Page, input: ScreenShareBridgeInput = {}) {
  const current = await readScreenShareControllerState(page);
  if (current?.ok || current?.mode)
    return { ok: true, installed: false, state: current };
  await page.evaluate(
    (runtimeConfig) => {
      if (window.MAB_SCREEN_SHARE_CONTROLLER) return;
      const config = {
        enabled: true,
        width: Number.parseInt(String(runtimeConfig.width ?? 1280), 10),
        height: Number.parseInt(String(runtimeConfig.height ?? 720), 10),
        fps: Number.parseInt(String(runtimeConfig.fps ?? 30), 10),
        mode: runtimeConfig.mode || "synthetic",
        title: runtimeConfig.title || "Meeting Avatar Bot",
        subtitle: runtimeConfig.subtitle || "Agent screen share",
        videoUrl: runtimeConfig.videoUrl || "",
        muted: runtimeConfig.muted !== false,
      };
      const state = {
        ok: true,
        enabled: true,
        active: false,
        startedAt: "",
        stoppedAt: "",
        streamId: "",
        trackIds: [],
        frames: 0,
        displayMediaCalls: 0,
        mode: config.mode,
        title: config.title,
        subtitle: config.subtitle,
        videoUrl: config.videoUrl,
        videoReady: false,
        videoError: "",
        errors: [],
      };
      window.MAB_SCREEN_SHARE = state;
      let canvas = null;
      let ctx = null;
      let stream = null;
      let timer = null;
      let video = null;

      function ensureCanvas() {
        if (canvas) return canvas;
        canvas = document.createElement("canvas");
        canvas.width = config.width;
        canvas.height = config.height;
        canvas.style.cssText =
          "position:fixed;right:12px;bottom:12px;width:256px;height:144px;z-index:2147483647;border:1px solid rgba(0,0,0,.25);background:#101418;display:none";
        canvas.dataset.meetingAvatarScreenShare = "1";
        document.documentElement.appendChild(canvas);
        ctx = canvas.getContext("2d");
        return canvas;
      }

      function ensureVideo() {
        if (!state.videoUrl) return null;
        if (video) return video;
        video = document.createElement("video");
        video.src = state.videoUrl;
        video.crossOrigin = "anonymous";
        video.muted = config.muted;
        video.loop = true;
        video.playsInline = true;
        video.autoplay = true;
        video.style.cssText =
          "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none";
        video.addEventListener("loadeddata", () => {
          state.videoReady = true;
        });
        video.addEventListener("canplay", () => {
          state.videoReady = true;
        });
        video.addEventListener("error", () => {
          state.videoError = "video_error";
          state.errors.push("video_error");
        });
        document.documentElement.appendChild(video);
        video.play().catch((error) => {
          state.videoError = String((error && error.message) || error);
          state.errors.push("video_play_failed: " + state.videoError);
        });
        return video;
      }

      function drawFrame() {
        ensureCanvas();
        state.frames += 1;
        const w = canvas.width;
        const h = canvas.height;
        const t = state.frames / Math.max(1, config.fps);
        const videoEl = ensureVideo();
        if (videoEl && videoEl.readyState >= 2 && videoEl.videoWidth && videoEl.videoHeight) {
          const scale = Math.min(w / videoEl.videoWidth, h / videoEl.videoHeight);
          const dw = Math.round(videoEl.videoWidth * scale);
          const dh = Math.round(videoEl.videoHeight * scale);
          ctx.fillStyle = "#05070a";
          ctx.fillRect(0, 0, w, h);
          try {
            ctx.drawImage(videoEl, Math.round((w - dw) / 2), Math.round((h - dh) / 2), dw, dh);
          } catch (error) {
            state.videoError = String((error && error.message) || error);
          }
        } else {
          const hue = Math.round((t * 24) % 360);
          const gradient = ctx.createLinearGradient(0, 0, w, h);
          gradient.addColorStop(0, "hsl(" + hue + " 72% 18%)");
          gradient.addColorStop(0.55, "#182332");
          gradient.addColorStop(1, "hsl(" + ((hue + 80) % 360) + " 70% 24%)");
          ctx.fillStyle = gradient;
          ctx.fillRect(0, 0, w, h);
          ctx.fillStyle = "rgba(255,255,255,.10)";
          for (let i = 0; i < 10; i += 1) {
            const x = ((i * 173 + state.frames * 8) % (w + 180)) - 90;
            ctx.fillRect(x, 110 + i * 52, 240, 3);
          }
        }
        ctx.fillStyle = "rgba(5,7,10,.68)";
        ctx.fillRect(48, h - 138, Math.min(w - 96, 760), 92);
        ctx.fillStyle = "#fff";
        ctx.font = "700 32px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
        ctx.fillText(state.title || config.title, 72, h - 86);
        ctx.font = "400 20px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
        ctx.fillStyle = "rgba(255,255,255,.78)";
        ctx.fillText(state.subtitle || config.subtitle, 74, h - 56);
      }

      function createStream() {
        ensureCanvas();
        drawFrame();
        stream = canvas.captureStream(config.fps);
        state.streamId = stream.id;
        state.trackIds = stream.getVideoTracks().map((track) => track.id);
        return stream;
      }

      function decorateDisplayTrack(track, _constraints = {}) {
        try {
          track.contentHint = "detail";
        } catch {
          // Ignore browsers that expose a read-only contentHint.
        }
        const originalGetSettings = track.getSettings?.bind(track);
        track.getSettings = () => ({
          ...(originalGetSettings ? originalGetSettings() : {}),
          width: config.width,
          height: config.height,
          frameRate: config.fps,
          aspectRatio: config.width / config.height,
          displaySurface: "browser",
          logicalSurface: true,
          cursor: "always",
        });
        return track;
      }

      async function start(options: ScreenShareBridgeInput = {}) {
        state.title = options.title || state.title || config.title;
        state.subtitle = options.subtitle || state.subtitle || config.subtitle;
        state.videoUrl =
          options.videoUrl || options.url || options.path || state.videoUrl || config.videoUrl;
        if (state.videoUrl && (!video || video.src !== state.videoUrl)) {
          if (video) video.remove();
          video = null;
          ensureVideo();
        }
        if (!stream) createStream();
        if (!timer)
          timer = window.setInterval(drawFrame, Math.max(16, Math.round(1000 / config.fps)));
        state.active = true;
        state.startedAt = new Date().toISOString();
        state.stoppedAt = "";
        canvas.style.display = options.preview === true ? "block" : "none";
        window.dispatchEvent(
          new CustomEvent("meeting-avatar-screen-share-stream", {
            detail: { label: "meeting-avatar-screen-share", stream, state: { ...state } },
          }),
        );
        return { ok: true, state: { ...state } };
      }

      async function stop() {
        if (timer) window.clearInterval(timer);
        timer = null;
        if (stream) for (const track of stream.getTracks()) track.stop();
        stream = null;
        state.active = false;
        state.stoppedAt = new Date().toISOString();
        state.streamId = "";
        state.trackIds = [];
        return { ok: true, state: { ...state } };
      }

      const mediaDevices =
        navigator.mediaDevices || ({} as MediaDevices & { getDisplayMedia?: typeof navigator.mediaDevices.getDisplayMedia });
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: mediaDevices,
      });
      const fakeGetDisplayMedia = async (constraints: { video?: boolean } = {}) => {
        state.displayMediaCalls += 1;
        const result = await start({ preview: false });
        if (!result.ok) throw new Error("screen share failed");
        const tracks = [];
        if (constraints.video !== false) {
          tracks.push(
            ...stream
              .getVideoTracks()
              .map((track) => decorateDisplayTrack(track.clone(), constraints)),
          );
        }
        return new MediaStream(tracks);
      };
      if (config.mode !== "native") {
        try {
          mediaDevices.getDisplayMedia = fakeGetDisplayMedia;
        } catch (error) {
          state.errors.push(
            "install instance getDisplayMedia failed: " + String((error && error.message) || error),
          );
        }
        try {
          Object.defineProperty(Object.getPrototypeOf(mediaDevices), "getDisplayMedia", {
            configurable: true,
            writable: true,
            value: fakeGetDisplayMedia,
          });
        } catch (error) {
          state.errors.push(
            "install prototype getDisplayMedia failed: " +
              String((error && error.message) || error),
          );
        }
      }
      window.MAB_SCREEN_SHARE_CONTROLLER = {
        start,
        stop,
        state: () => ({ ...state }),
        mode: config.mode,
      };
    },
    {
      mode: input.mode || "synthetic",
      title: input.title || "Meeting Avatar Bot",
      subtitle: input.subtitle || "Agent screen share",
      videoUrl: input.videoUrl || input.url || input.path || "",
      width: input.width || 1280,
      height: input.height || 720,
      fps: input.fps || 30,
      muted: input.muted !== false,
    },
  );
  const installed = await readScreenShareControllerState(page);
  return {
    ok: Boolean(installed?.ok || installed?.mode),
    installed: true,
    state: installed,
  };
}

async function fillGuestName(
  page: Page,
  botName: string,
  diagnostics: Diagnostics | null = null,
  timeoutMs = 35_000,
) {
  const deadline = Date.now() + timeoutMs;
  let lastResult: GuestNameEvalResult | null = null;
  while (Date.now() < deadline) {
    await dismissMeetPrompts(page, diagnostics);
    const result = await withTimeout<GuestNameEvalResult, GuestNameEvalResult>(
      page.evaluate((name) => {
        const text = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
        if (
          /You can't join this video call|No one can join a meeting unless invited or admitted by the host/i.test(
            text,
          )
        ) {
          return {
            ok: false,
            reason: "cannot_join_meeting",
            textHead: text.slice(0, 500),
          };
        }
        const hasGuestJoinForm = /What'?s your name\?|Ask to join|Join now/i.test(text);
        const hasAntiBotInterlock =
          /Getting ready\.\.\./i.test(text) ||
          (/confirm you'?re not a bot/i.test(text) && !hasGuestJoinForm);
        if (hasAntiBotInterlock) {
          return {
            ok: false,
            reason: "meet_anti_bot_prejoin",
            textHead: text.slice(0, 500),
          };
        }
        if (
          /Forgot email|Create account|Use your Google Account/i.test(text) &&
          /accounts\.google\.com/i.test(location.href)
        ) {
          return {
            ok: false,
            reason: "google_sign_in_required",
            textHead: text.slice(0, 500),
          };
        }
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
        const getValueLength = (node: HTMLElement) =>
          "value" in node && typeof node.value === "string"
            ? node.value.length
            : (node.textContent || "").length;
        const fields = Array.from(
          document.querySelectorAll<HTMLElement>(
            [
              'input[aria-label*="name" i]',
              'input[placeholder*="name" i]',
              'input[type="text"]',
              "textarea",
              '[contenteditable="true"]',
            ].join(","),
          ),
        );
        const visibleFields = fields.filter(isVisible);
        const field =
          visibleFields.find((node) => {
            const label =
              `${node.getAttribute("aria-label") || ""} ${node.getAttribute("placeholder") || ""}`.toLowerCase();
            return label.includes("name") || label.includes("your name") || fields.length === 1;
          }) || visibleFields[0];
        if (!field) {
          return {
            ok: false,
            reason: "guest_name_field_absent",
            textHead: (document.body?.innerText || "").slice(0, 500),
          };
        }
        field.focus();
        if ("value" in field) {
          field.value = "";
          field.dispatchEvent(
            new InputEvent("input", {
              bubbles: true,
              inputType: "deleteContentBackward",
              data: null,
            }),
          );
          field.value = name;
          field.dispatchEvent(
            new InputEvent("input", { bubbles: true, inputType: "insertText", data: name }),
          );
          field.dispatchEvent(new Event("change", { bubbles: true }));
        } else {
          field.textContent = "";
          field.dispatchEvent(
            new InputEvent("input", {
              bubbles: true,
              inputType: "deleteContentBackward",
              data: null,
            }),
          );
          field.textContent = name;
          field.dispatchEvent(
            new InputEvent("input", { bubbles: true, inputType: "insertText", data: name }),
          );
        }
        field.blur();
        return {
          ok: true,
          tag: field.tagName.toLowerCase(),
          aria: field.getAttribute("aria-label") || "",
          placeholder: field.getAttribute("placeholder") || "",
          valueLength: getValueLength(field),
        };
      }, botName),
      2500,
      {
        ok: false,
        reason: "guest_name_eval_timeout",
      },
    ).catch((error): GuestNameEvalResult => ({
      ok: false,
      reason: "guest_name_eval_error",
      error: String(error?.message || error).slice(0, 300),
    }));
    lastResult = result;
    if (["cannot_join_meeting", "google_sign_in_required"].includes(result.reason)) {
      diagnostics?.record("guest_name_terminal_state", result);
      return result;
    }
    if (result.ok) {
      diagnostics?.record("guest_name_filled", { botName, ...result });
      return result;
    }
    diagnostics?.record("guest_name_wait", result);
    await page.waitForTimeout(1000);
  }
  diagnostics?.record("guest_name_absent", lastResult || { reason: "timeout" });
  return { ok: false, ...(lastResult || { reason: "timeout" }) };
}

async function clickMeetJoinButton(
  page: Page,
  diagnostics: Diagnostics | null = null,
  timeoutMs = 45_000,
) {
  const deadline = Date.now() + timeoutMs;
  let lastCandidates: PresentationButton[] = [];
  let clickedSelector = "";
  while (Date.now() < deadline) {
    await dismissMeetPrompts(page, diagnostics);
    const result = await withTimeout<MeetJoinButtonEvalResult, MeetJoinButtonEvalResult>(
      page.evaluate(() => {
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
        const buttons = Array.from(document.querySelectorAll<HTMLElement>("button, [role=button]"));
        const candidates = buttons
          .map((node, index) => {
            const label =
              `${node.innerText || node.textContent || ""} ${node.getAttribute("aria-label") || ""}`
                .replace(/\s+/g, " ")
                .trim();
            const rect = node.getBoundingClientRect();
            return {
              index,
              label: label.slice(0, 160),
              disabled: Boolean(
                ("disabled" in node && typeof node.disabled === "boolean" && node.disabled) ||
                  node.getAttribute("aria-disabled") === "true",
              ),
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
            (button) =>
              button.visible &&
              /\b(ask to join|join now|join)\b|申请加入|立即加入|加入/i.test(button.label),
          );
        const enabled = candidates.find((button) => !button.disabled);
        if (!enabled) return { ok: false, candidates };
        buttons[enabled.index].click();
        return { ok: true, selector: "dom:meet-join-button", button: enabled, candidates };
      }),
      2500,
      {
        ok: false,
        error: "join_button_eval_timeout",
        candidates: [],
      },
    ).catch((error): MeetJoinButtonEvalResult => ({
      ok: false,
      error: String(error?.message || error).slice(0, 300),
      candidates: [],
    }));
    lastCandidates = result.candidates || [];
    if (result.ok) {
      clickedSelector = result.selector;
      diagnostics?.record("click", {
        selector: result.selector,
        button: result.button,
      });
      if (result.button?.rect) {
        await page.mouse
          .click(
            result.button.rect.x + Math.round(result.button.rect.width / 2),
            result.button.rect.y + Math.round(result.button.rect.height / 2),
            { delay: 30 },
          )
          .catch((error) => {
            diagnostics?.record("click_miss", {
              selector: "mouse:meet-join-button",
              error: String(error?.message || error).slice(0, 180),
            });
          });
      }
      await page.waitForTimeout(3000);
      const pageState = await evaluateMeetPageState(page);
      diagnostics?.record("join_after_click_state", { pageState });
      if (pageState.waitingForAdmit) return result.selector;
      if (pageState.inMeeting) return result.selector;
      if (pageState.error === "meet_page_state_timeout") {
        diagnostics?.record("join_state_probe_timeout_assume_clicked", {
          selector: result.selector,
          reason: "meet_spa_blocks_runtime_evaluation_after_join_click",
        });
        return result.selector;
      }
      if (pageState.signIn) {
        diagnostics?.record("join_terminal_state", {
          reason: "google_sign_in_required",
          pageState,
        });
        return "";
      }
      await page.waitForTimeout(1000);
      continue;
    }
    if (clickedSelector) {
      const pageState = await evaluateMeetPageState(page);
      if (pageState.waitingForAdmit) return clickedSelector;
      if (pageState.inMeeting) return clickedSelector;
      if (pageState.signIn) {
        diagnostics?.record("join_terminal_state", {
          reason: "google_sign_in_required",
          pageState,
        });
        return "";
      }
    }
    diagnostics?.record("join_wait", {
      error: "error" in result ? result.error || "" : "",
      candidates: lastCandidates.slice(0, 8),
    });
    const pageState = await evaluateMeetPageState(page);
    diagnostics?.record("join_wait_state", {
      inMeeting: pageState?.inMeeting === true,
      waitingForAdmit: pageState?.waitingForAdmit === true,
      preJoin: pageState?.preJoin === true,
      signIn: pageState?.signIn === true,
      cannotJoin: pageState?.cannotJoin === true,
      textHead: String(pageState?.textHead || "").slice(0, 240),
    });
    await page.waitForTimeout(1000);
  }
  diagnostics?.record("join_wait_timeout", { candidates: lastCandidates.slice(0, 8) });
  return "";
}

async function evaluateAvatarReady(page) {
  return await withTimeout(
    page.evaluate(() => window.MAB_AVATAR_READY || null),
    2500,
    null,
  ).catch(() => null);
}

async function startAvatarRenderer(page, diagnostics: Diagnostics | null = null) {
  const result = await withTimeout(
    page.evaluate(async () => {
      if (!window.MAB_AVATAR_START_RENDERER) {
        return { ok: false, error: "avatar_renderer_start_missing" };
      }
      const ready = await window.MAB_AVATAR_START_RENDERER();
      return { ok: true, ready: ready || window.MAB_AVATAR_READY || null };
    }),
    25_000,
    { ok: false, error: "avatar_renderer_start_timeout" },
  ).catch((error) => ({
    ok: false,
    error: String(error?.message || error).slice(0, 300),
  }));
  diagnostics?.record("avatar_renderer_start", result);
  return result;
}

async function evaluateAvatarAudio(page) {
  return await withTimeout(
    page.evaluate(() => window.MAB_AVATAR_AUDIO || null),
    2500,
    null,
  ).catch(() => null);
}

async function evaluateFixtureState(page) {
  return await withTimeout(
    page.evaluate(() => window.__MAB_MEET_FIXTURE || null),
    2500,
    null,
  ).catch(() => null);
}

async function evaluateRealtimeBridgeState(page) {
  return await withTimeout(
    page.evaluate(() => window.MAB_REALTIME_BRIDGE || null),
    2500,
    null,
  ).catch(() => null);
}

async function evaluateWorkerResultBridgeState(page) {
  return await withTimeout(
    page.evaluate(() => window.MAB_WORKER_RESULT_BRIDGE || null),
    2500,
    null,
  ).catch(() => null);
}

async function evaluateLocalDialogState(page) {
  return await withTimeout(
    page.evaluate(() => {
      if (window.MAB_LOCAL_DIALOG) return window.MAB_LOCAL_DIALOG;
      const config = window.MAB_LOCAL_DIALOG_CONFIG || null;
      const controller = window.MAB_LOCAL_DIALOG_CONTROLLER || null;
      if (!config && !controller) return null;
      return {
        ok: false,
        bootstrapOnly: true,
        enabled: Boolean(config?.enabled),
        provider: "",
        utterancesReceived: 0,
        responsesSpoken: 0,
        controllerReady: typeof controller?.sendUtterance === "function",
        config,
        errors: [{ message: "local_dialog_state_missing" }],
      };
    }),
    2500,
    null,
  ).catch(() => null);
}

async function evaluateScreenShareState(page) {
  return await withTimeout(
    page.evaluate(() => window.MAB_SCREEN_SHARE || null),
    2500,
    null,
  ).catch(() => null);
}

function compactCaptionState(captions) {
  if (!captions) return null;
  return {
    ok: captions.ok,
    count: captions.count,
    latest: captions.latest || null,
    paths: captions.paths || null,
    containerFound: Boolean(captions.browser?.containerFound),
    errors: captions.browser?.errors || [],
  };
}

function compactRuntimeState({
  avatarReady,
  avatarAudio,
  realtimeBridge,
  workerResultBridge,
  localDialog,
  captions,
  screenShare,
}) {
  return {
    avatarState: avatarReady?.avatarState || null,
    avatarRenderer: avatarReady?.renderer || null,
    avatarAudio: avatarAudio
      ? {
          ok: avatarAudio.ok,
          routedStreams: avatarAudio.routedStreams,
          routedElements: avatarAudio.routedElements,
          routedBuffers: avatarAudio.routedBuffers,
          injectedTones: avatarAudio.injectedTones,
          lastRoute: avatarAudio.lastRoute || null,
          errors: avatarAudio.errors || [],
        }
      : null,
    realtime: realtimeBridge
      ? {
          mode: realtimeBridge.mode,
          connected: realtimeBridge.connected,
          connecting: realtimeBridge.connecting,
          feedback: realtimeBridge.feedback || null,
          session: realtimeBridge.session || null,
          connection: realtimeBridge.connection || null,
          inboundTail: (realtimeBridge.inbound || []).slice(-12),
          transcripts: realtimeBridge.transcripts || null,
          outboundTail: (realtimeBridge.outbound || []).slice(-12).map((entry) => ({
            ts: entry.ts,
            type: entry.event?.type || "",
            itemType: entry.event?.item?.type || "",
          })),
          timelineTail: (realtimeBridge.timeline || []).slice(-20),
          errors: realtimeBridge.errors || [],
          avatarTools: realtimeBridge.avatarTools || null,
          workerTools: realtimeBridge.workerTools || null,
          meetTools: realtimeBridge.meetTools || null,
        }
      : null,
    workerResultBridge: workerResultBridge
      ? {
          ok: workerResultBridge.ok,
          enabled: workerResultBridge.enabled,
          deliveredTail: (workerResultBridge.delivered || []).slice(-10),
          errors: workerResultBridge.errors || [],
          lastPollAt: workerResultBridge.lastPollAt || "",
          lastDeliveryAt: workerResultBridge.lastDeliveryAt || "",
        }
      : null,
    localDialog: localDialog
      ? {
          ok: localDialog.ok,
          enabled: localDialog.enabled,
          provider: localDialog.provider,
          utterancesReceived: localDialog.utterancesReceived,
          responsesSpoken: localDialog.responsesSpoken,
          errors: localDialog.errors || [],
        }
      : null,
    captions: compactCaptionState(captions),
    screenShare: screenShare
      ? {
          ok: screenShare.ok,
          enabled: screenShare.enabled,
          active: screenShare.active,
          streamId: screenShare.streamId || "",
          trackIds: screenShare.trackIds || [],
          frames: screenShare.frames || 0,
          displayMediaCalls: screenShare.displayMediaCalls || 0,
          errors: screenShare.errors || [],
        }
      : null,
  };
}

async function evaluateMeetPageState(page: Page): Promise<MeetPageState> {
  const jsState = await withTimeout<MeetPageState, MeetPageState>(
    page.evaluate(() => {
      const text = (document.body?.innerText || "").slice(0, 5000);
      const url = location.href;
      const title = document.title || "";
      const buttons = Array.from(document.querySelectorAll<HTMLElement>("button, [role=button]"))
        .map((node, index) => {
          const rect = node.getBoundingClientRect();
          const label =
            `${node.innerText || node.textContent || ""} ${node.getAttribute("aria-label") || ""}`
              .replace(/\s+/g, " ")
              .trim();
          return {
            index,
            label: label.slice(0, 160),
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
        .filter((button) => button.visible && button.label);
      function participantCount(): number | null {
        const peopleBtn = document.querySelector<HTMLElement>(
          'button[aria-label*="people" i], button[aria-label*="参与者"], button[aria-label*="用户"]',
        );
        if (peopleBtn) {
          const badge = peopleBtn.querySelector(".gv5Jzc, .uGOf1d, .wnPUne");
          if (badge?.textContent) {
            const parsed = Number.parseInt(badge.textContent.trim(), 10);
            if (Number.isFinite(parsed)) return parsed;
          }
          const label = peopleBtn.getAttribute("aria-label") || "";
          const match = label.match(/\((\d+)\)/);
          if (match) return Number.parseInt(match[1], 10);
        }

        const tiles = document.querySelectorAll("[data-participant-id], [data-requested-participant-id]");
        if (tiles.length > 0) return tiles.length;
        return null;
      }
      const waitingForAdmit =
        /Please wait until a meeting host brings you into the call|Someone will let you in soon|waiting for.*host/i.test(
          text,
        );
      const inMeetingSignals = [
        /You have joined the call/i.test(text),
        /Leave call/i.test(text),
        /Leave meeting/i.test(text),
        /Present now/i.test(text),
        /Share screen/i.test(text),
        /People/i.test(text) && /Chat/i.test(text),
        buttons.some((button) =>
          /Leave call|Leave meeting|Turn off microphone|Turn on microphone|Turn off camera|Turn on camera|Raise hand|More options|Share screen|Present now/i.test(
            button.label,
          ),
        ),
      ];
      const preJoinSignals = [
        /Join now/i.test(text),
        /Ask to join/i.test(text),
        /Getting ready/i.test(text),
      ];
      const signInSignals = [
        /Forgot email/i.test(text),
        /Create account/i.test(text),
        /Sign in/i.test(text) && /Next/i.test(text),
        /accounts\.google\.com/i.test(url),
      ];
      return {
        ok: true,
        url,
        title,
        inMeeting: !waitingForAdmit && inMeetingSignals.some(Boolean),
        participantCount: participantCount(),
        waitingForAdmit,
        preJoin: preJoinSignals.some(Boolean),
        signIn: signInSignals.some(Boolean),
        cannotJoin:
          /You can't join this video call|No one can join a meeting unless invited or admitted by the host/i.test(
            text,
          ),
        textHead: text.slice(0, 1000),
        buttons: buttons.slice(0, 30),
      };
    }),
    2500,
      {
        ok: false,
        error: "meet_page_state_timeout",
      },
  ).catch((error): MeetPageState => ({
    ok: false,
    error: String(error?.message || error),
  }));
  if (jsState.ok || jsState.error !== "meet_page_state_timeout") return jsState;
  const accessibilityState = await evaluateMeetAccessibilityState(page);
  if (accessibilityState.ok) {
    return {
      ...accessibilityState,
      jsProbe: jsState,
    };
  }
  return {
    ...jsState,
    accessibilityProbe: accessibilityState,
  };
}

export function createGoogleMeetJoiner(options: GoogleMeetJoinerOptions = {}) {
  const config = getRuntimeConfig();
  let active = null;
  const activeBrowserPath = pathJoin(config.dataDir, "active-meet-browser.json");

  async function clearActiveBrowserRecord() {
    await unlink(activeBrowserPath).catch(() => {});
  }

  async function rememberActiveBrowser(browser, sessionId, meetUrl) {
    const pid = typeof browser?.process === "function" ? browser.process()?.pid : 0;
    if (!pid) return { ok: false, reason: "browser_pid_unavailable" };
    await mkdir(config.dataDir, { recursive: true });
    await writeFile(
      activeBrowserPath,
      `${JSON.stringify(
        {
          pid,
          sessionId,
          meetUrl,
          createdAt: nowIso(),
        },
        null,
        2,
      )}\n`,
    );
    return { ok: true, pid, path: activeBrowserPath };
  }

  async function stopRecordedBrowser(reason = "replace_existing_bot") {
    let record;
    try {
      record = JSON.parse(await readFile(activeBrowserPath, "utf8"));
    } catch {
      return { ok: true, stopped: false, reason, source: "record_absent" };
    }
    const pid = Number(record.pid || 0);
    if (!pid || pid === process.pid) {
      await clearActiveBrowserRecord();
      return { ok: true, stopped: false, reason, source: "record_invalid" };
    }
    try {
      process.kill(pid, 0);
    } catch {
      await clearActiveBrowserRecord();
      return {
        ok: true,
        stopped: false,
        reason,
        source: "process_absent",
        pid,
        sessionId: record.sessionId || "",
      };
    }
    try {
      process.kill(pid, "SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 800));
      try {
        process.kill(pid, 0);
        process.kill(pid, "SIGKILL");
      } catch {
        // Process exited after SIGTERM.
      }
      await clearActiveBrowserRecord();
      return {
        ok: true,
        stopped: true,
        reason,
        source: "recorded_browser",
        pid,
        sessionId: record.sessionId || "",
      };
    } catch (error) {
      return {
        ok: false,
        stopped: false,
        reason,
        source: "recorded_browser",
        pid,
        sessionId: record.sessionId || "",
        error: String(error?.message || error),
      };
    }
  }

  async function stop(reason = "manual_stop") {
    if (!active) return { ok: true, stopped: false, reason };
    const previous = active;
    active = null;
    previous.diagnostics?.record("stop", { reason });
    try {
      await previous.recorder?.stop();
    } catch (error) {
      previous.diagnostics?.record("recorder_stop_error", {
        error: String(error?.message || error),
      });
    }
    try {
      await previous.captionCapture?.flush();
    } catch (error) {
      previous.diagnostics?.record("caption_flush_error", {
        error: String(error?.message || error),
      });
    }
    try {
      if (previous.persistentBrowserContext) {
        await previous.context?.close();
      } else {
        await previous.browser?.close();
      }
    } catch (error) {
      previous.diagnostics?.record("stop_close_error", { error: String(error?.message || error) });
      // Browser may already be gone.
    }
    await clearActiveBrowserRecord();
    if (previous.diagnostics) await saveDiagnostics(previous.diagnostics).catch(() => {});
    return {
      ok: true,
      stopped: true,
      sessionId: previous.sessionId,
      reason,
      diagnosticsPath: previous.diagnostics?.jsonPath || "",
    };
  }

  async function join(input: GoogleMeetJoinInput) {
    const meetUrl = input.meetUrl || "";
    const allowNonGoogleMeet = Boolean(input.allowNonGoogleMeet || options.allowNonGoogleMeet);
    assertMeetUrl(meetUrl, { allowNonGoogleMeet });
    const sessionId = input.sessionId || `manual_${Date.now()}`;
    const botName = input.botName || config.botName;
    const dryRun = Boolean(input.dryRun);
    const installAvatar = input.installAvatar !== false;
    const installRealtimeBridge = input.installRealtimeBridge !== false;
    const installLocalDialogBridge = Boolean(input.installLocalDialogBridge);
    const installWorkerResultBridge = input.installWorkerResultBridge !== false;
    const installScreenShareBridge = Boolean(input.installScreenShareBridge);
    const autoStartScreenShare = Boolean(input.autoStartScreenShare);
    const workerPollUrl = input.workerPollUrl || `${config.meetingAgentUrl}/worker/poll-realtime`;
    const recordMeeting = Boolean(input.recordMeeting ?? config.recordMeeting);
    const captureCaptions = Boolean(input.captureCaptions ?? config.captureCaptions);
    const captionLanguage = input.captionLanguage || config.captionLanguage || "";
    const artifactsDir = input.artifactsDir || pathJoin(config.meetingArtifactsDir, sessionId);
    const recorder = createMeetingRecorder({
      backend: input.meetAudioBackend || config.meetAudioBackend,
    });
    const browserUserDataDirInput = input.browserUserDataDir || config.browserUserDataDir || "";
    const meetProfileMode = normalizeMeetProfileMode(
      input.meetProfileMode || config.meetProfileMode,
      Boolean(browserUserDataDirInput),
    );
    if (meetProfileMode === "persistent" && !browserUserDataDirInput) {
      throw new Error(
        "MAB_BROWSER_USER_DATA_DIR is required when MAB_MEET_PROFILE_MODE=persistent",
      );
    }
    const browserUserDataDir = meetProfileMode === "persistent" ? browserUserDataDirInput : "";

    const replacementStop = await stop("replace_existing_bot");
    const recordedBrowserStop = replacementStop.stopped
      ? { ok: true, stopped: false, reason: "active_stop_closed_browser", source: "record_skipped" }
      : await stopRecordedBrowser("replace_existing_bot");

    const plan = {
      provider: "google-meet",
      sessionId,
      meetUrl,
      botName,
      headless: config.browserHeadless,
      installAvatar,
      installRealtimeBridge,
      installLocalDialogBridge,
      installWorkerResultBridge,
      installScreenShareBridge,
      autoStartScreenShare,
      workerPollUrl,
      recordMeeting,
      captureCaptions,
      captionLanguage,
      artifactsDir,
      meetAudioBackend: recorder.backend,
      allowNonGoogleMeet,
      screenshotDir: config.screenshotDir,
      meetProfileMode,
      browserUserDataDir,
      replacementStop,
      recordedBrowserStop,
      steps: [
        "launch chromium",
        "install init scripts from avatar/realtime layers",
        "install optional synthetic screen-share provider",
        "open meet URL",
        "dismiss popups",
        "fill guest display name",
        "click Join now / Ask to join",
        "keep browser session alive until stopped",
      ],
    };

    if (dryRun) return { ok: true, dryRun: true, plan };

    await mkdir(config.screenshotDir, { recursive: true });
    const diagnostics = createDiagnostics(sessionId, config.screenshotDir);
    diagnostics.record("join_start", {
      meetUrl,
      botName,
      installAvatar,
      allowNonGoogleMeet,
      meetProfileMode,
    });
    const playwright = await loadPlaywright(
      options.playwrightModulePath || config.playwrightModulePath,
    );
    const recorderLaunchEnv = recordMeeting ? await recorder.prepareLaunchEnv() : undefined;
    const browserLaunchOptions = {
      executablePath: options.chromiumExecutablePath || config.chromiumExecutablePath || undefined,
      headless: config.browserHeadless,
      env: recorderLaunchEnv,
      args: [
        "--use-fake-ui-for-media-stream",
        "--enable-usermedia-screen-capturing",
        "--auto-select-desktop-capture-source=Entire screen",
        "--auto-select-tab-capture-source-by-title=Meeting Avatar Bot",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        ...(config.avatarUseSwiftShader
          ? ["--use-angle=swiftshader", "--use-gl=angle", "--enable-unsafe-swiftshader"]
          : ["--use-angle=default", "--enable-gpu-rasterization"]),
        "--ignore-gpu-blocklist",
        "--enable-webgl",
        "--disable-blink-features=AutomationControlled",
        "--autoplay-policy=no-user-gesture-required",
        "--no-first-run",
        "--no-default-browser-check",
        ...String(input.browserExtraArgs || "")
          .split(/\s+/)
          .map((arg) => arg.trim())
          .filter(Boolean),
        ...String(config.chromiumExtraArgs || "")
          .split(/\s+/)
          .map((arg) => arg.trim())
          .filter(Boolean),
      ],
    };
    const contextOptions = {
      permissions: ["microphone", "camera"],
      viewport: {
        width: Number(input.browserViewportWidth || config.browserViewportWidth || 1440),
        height: Number(input.browserViewportHeight || config.browserViewportHeight || 900),
      },
    };
    let browser;
    let context;
    if (browserUserDataDir) {
      await mkdir(browserUserDataDir, { recursive: true });
      diagnostics.record("browser_launch", {
        persistentUserDataDir: browserUserDataDir,
        executablePath: browserLaunchOptions.executablePath || "",
        headless: browserLaunchOptions.headless,
      });
      context = await playwright.chromium.launchPersistentContext(browserUserDataDir, {
        ...browserLaunchOptions,
        ...contextOptions,
      });
      browser = typeof context.browser === "function" ? context.browser() : null;
    } else {
      diagnostics.record("browser_launch", {
        persistentUserDataDir: "",
        executablePath: browserLaunchOptions.executablePath || "",
        headless: browserLaunchOptions.headless,
      });
      browser = await playwright.chromium.launch(browserLaunchOptions);
      context = await browser.newContext(contextOptions);
    }
    active = {
      sessionId,
      browser,
      context,
      persistentBrowserContext: Boolean(browserUserDataDir),
      browserUserDataDir,
      meetProfileMode,
      startedAt: nowIso(),
      meetUrl,
      diagnostics,
      artifactsDir,
      recorder: recordMeeting ? recorder : null,
      captionCapture: null,
    };
    const browserRecord = await rememberActiveBrowser(browser, sessionId, meetUrl);
    // tsx/esbuild can serialize page.evaluate callbacks through __name; expose a no-op
    // helper so browser-side diagnostics keep working when smokes run TypeScript directly.
    await context.addInitScript({
      content: `
        (() => {
          if (typeof globalThis.__name !== "function") {
            Object.defineProperty(globalThis, "__name", {
              value: (fn) => fn,
              configurable: true,
            });
          }
        })();
      `,
    });
    if (installAvatar) {
      await context.addInitScript({
        content: buildAvatarInitScript({
          modelUrl: input.avatarModelUrl || config.avatarModelUrl,
          modelFallbackUrls: config.avatarModelFallbackUrls,
          live2dDepsDir: input.avatarDepsDir || config.avatarDepsDir,
          layout: input.avatarLayout || config.avatarLayout,
          botName,
          disableLive2D: Boolean(input.disableLive2D),
          deferRendererUntilExplicitStart:
            input.deferAvatarRendererUntilJoined !== false && installAvatar,
          canvasWidth: Number(input.avatarCanvasWidth || config.avatarCanvasWidth || 1920),
          canvasHeight: Number(input.avatarCanvasHeight || config.avatarCanvasHeight || 1080),
          captureFps: Number(input.avatarCaptureFps || config.avatarCaptureFps || 30),
        }),
      });
    }
    if (installRealtimeBridge) {
      const realtimeCurrentUser = {
        name: config.currentUserName,
        englishName: config.currentUserEnglishName,
        email: config.currentUserEmail,
        linear: config.currentUserLinear,
        github: config.currentUserGithub,
        role: config.currentUserRole,
      };
      const realtimeTools = input.realtimeTools || realtimeToolSchemas;
      const realtimeInstructions =
        input.realtimeInstructions ||
        buildRealtimeInstructions({
          botName,
          personalityContext: config.realtimePersonalityContext,
          currentUser: realtimeCurrentUser,
        });
      const realtimeSession =
        input.realtimeSession ||
        buildRealtimeSessionConfig(
          {
            botName,
            currentUser: realtimeCurrentUser,
            instructions: realtimeInstructions,
            tools: realtimeTools,
          },
          config,
        );
      await context.addInitScript({
        content: buildRealtimeBrowserInitScript({
          mode: input.realtimeBridgeMode || "mock",
          agentRuntime: input.realtimeAgentRuntime || config.openaiRealtimeAgentRuntime,
          sessionId,
          botName,
          toolCallbackToken: input.realtimeToolCallbackToken || config.internalAuthKey || "",
          autoRespondToWorkerResults: input.autoRespondToWorkerResults !== false,
          instructions: realtimeInstructions,
          tools: realtimeTools,
          session: realtimeSession,
          sendSessionUpdateOnConnect: input.sendRealtimeSessionUpdate !== false,
          includeParticipantAudio: Boolean(input.includeParticipantAudio),
          forwardMeetAudioToRealtime: input.forwardMeetAudioToRealtime !== false,
          fallbackToLocalMic: Boolean(input.realtimeFallbackToLocalMic),
          workerDelegateUrl: input.workerDelegateUrl || `${config.meetingAgentUrl}/worker/delegate`,
          workerStatusUrl: input.workerStatusUrl || `${config.meetingAgentUrl}/worker/status`,
          autoConnect: Boolean(input.autoConnectRealtime),
          tokenUrl: input.realtimeTokenUrl || `${config.meetingAgentUrl}/realtime/client-secret`,
          sdpUrl: input.realtimeSdpUrl || config.openaiRealtimeSdpUrl,
        }),
      });
    }
    if (installLocalDialogBridge) {
      await context.addInitScript({
        content: buildLocalDialogInitScript({
          enabled: true,
          botName,
          sessionId,
          turnUrl: input.localDialogTurnUrl || `${config.meetingAgentUrl}/dialog/turn`,
          ttsMode: input.localDialogTtsMode || "tone",
          ttsUrl: input.localDialogTtsUrl || `${config.meetingAgentUrl}/tts/synthesize`,
          sttProvider: input.localDialogSttProvider || config.sttProvider,
          ttsProvider: input.localDialogTtsProvider || config.ttsProvider,
          ttsGain: Number(input.localDialogTtsGain ?? 0.025),
        }),
      });
    }
    if (installScreenShareBridge) {
      await context.addInitScript({
        content: buildScreenShareInitScript({
          enabled: true,
          autoStart: autoStartScreenShare,
          mode: input.screenShareMode || "synthetic",
          title: input.screenShareTitle || "Meeting Avatar Bot",
          subtitle: input.screenShareSubtitle || "Agent screen share",
          width: input.screenShareWidth || 1280,
          height: input.screenShareHeight || 720,
          fps: input.screenShareFps || 15,
        }),
      });
    }
    if (installWorkerResultBridge) {
      await context.addInitScript({
        content: buildWorkerResultInitScript({
          workerPollUrl,
          enabled: Boolean(workerPollUrl),
          minCreatedAt: input.workerResultMinCreatedAt || new Date().toISOString(),
        }),
      });
    }
    const page = await context.newPage();
    active = {
      ...active,
      context,
      page,
    };
    installPageDiagnostics(page, diagnostics);
    diagnostics.record("goto_start", { meetUrl });
    await saveDiagnostics(diagnostics);
    await page.goto(meetUrl, { waitUntil: "commit", timeout: 25_000 });
    diagnostics.record("goto_complete", { url: page.url() });
    await saveDiagnostics(diagnostics);
    await installMeetPromptAutoDismisser(page, diagnostics);
    await installMeetLocalPlaybackMute(page, diagnostics);
    await page.waitForTimeout(2500);
    await takeScreenshot(page, diagnostics, "01-after-nav");
    await collectButtonInventory(page, diagnostics, "after-nav");

    await dismissMeetPrompts(page, diagnostics);

    const guestNameResult = await fillGuestName(page, botName, diagnostics);
    if (
      !guestNameResult.ok &&
      ["cannot_join_meeting", "google_sign_in_required", "meet_anti_bot_prejoin"].includes(
        guestNameResult.reason,
      )
    ) {
      const meetPage = await evaluateMeetPageState(page);
      diagnostics.record("join_failed_terminal_state", { guestNameResult, meetPage });
      await saveDiagnostics(diagnostics);
      return {
        ok: false,
        error: guestNameResult.reason,
        sessionId,
        screenshotDir: config.screenshotDir,
        diagnosticsPath: diagnostics.jsonPath,
        meetPage,
        guestName: guestNameResult,
      };
    }

    await collectButtonInventory(page, diagnostics, "pre-join-click");

    let clicked = await clickMeetJoinButton(page, diagnostics, 45_000);
    if (!clicked)
      clicked = await clickFirstVisible(
        page,
        [
          'button:has-text("Ask to join")',
          'button:has-text("Join now")',
          'button:has-text("加入")',
          'button:has-text("申请加入")',
          'button:has-text("立即加入")',
          'button:has-text("Join")',
          '[aria-label*="Ask to join" i]',
          '[aria-label*="Join now" i]',
          '[aria-label*="加入" i]',
          "button[jsname]",
        ],
        2500,
        diagnostics,
      );
    if (!clicked) {
      const enterFallback = await page.keyboard
        .press("Enter")
        .then(() => true)
        .catch(() => false);
      diagnostics.record("join_enter_fallback", { ok: enterFallback });
      if (enterFallback) {
        await page.waitForTimeout(1500);
        const pageState = await evaluateMeetPageState(page);
        if (pageState?.waitingForAdmit || pageState?.inMeeting) clicked = "keyboard:enter";
      }
    }
    if (!clicked) {
      const meetPage = await evaluateMeetPageState(page);
      diagnostics.record("join_failed_no_button", { meetPage });
      await saveDiagnostics(diagnostics);
      await stop("join_button_not_found").catch(() => {});
      return {
        ok: false,
        error: "join_button_not_found",
        sessionId,
        screenshotDir: config.screenshotDir,
        diagnosticsPath: diagnostics.jsonPath,
        meetPage,
      };
    }

    await page.waitForTimeout(2500);
    await takeScreenshot(page, diagnostics, "02-after-join-click");
    await collectButtonInventory(page, diagnostics, "after-join-click");
    let admission = null;
    if (clicked) {
      const joinedFixture = allowNonGoogleMeet ? await evaluateFixtureState(page) : null;
      if (joinedFixture?.joined === true) {
        admission = { state: "admitted", signal: "fixture_joined", fixtureState: joinedFixture };
        diagnostics.record("admission_state", admission);
      } else {
        admission = await waitForMeetAdmission(page, {
          diagnostics,
          dismissMeetPrompts,
          evaluateMeetPageState,
          timeoutMs: 120_000,
        });
      }
      if (admission.state === "denied") {
        await saveDiagnostics(diagnostics);
        return {
          ok: false,
          error: "admission_denied",
          sessionId,
          screenshotDir: config.screenshotDir,
          diagnosticsPath: diagnostics.jsonPath,
          admission,
        };
      }
      if (admission.state === "sign_in_required") {
        await saveDiagnostics(diagnostics);
        return {
          ok: false,
          error: "google_sign_in_required",
          sessionId,
          screenshotDir: config.screenshotDir,
          diagnosticsPath: diagnostics.jsonPath,
          admission,
        };
      }
    }
    const avatarRendererStart =
      installAvatar && clicked
        ? await startAvatarRenderer(page, diagnostics)
        : { ok: false, skipped: true, reason: "avatar_not_installed_or_not_joined" };
    let captionCapture = null;
    let captionEnable = null;
    if (captureCaptions && clicked) {
      captionCapture = await installMeetCaptionCapture(page, { artifactsDir, diagnostics });
      captionEnable = await enableMeetCaptions(page, { captionLanguage, diagnostics });
      await page.waitForTimeout(1200);
      const captionStatus = await captionCapture.status();
      diagnostics.record("caption_capture_ready", {
        captionEnable,
        captions: compactCaptionState(captionStatus),
      });
    } else if (captureCaptions) {
      diagnostics.record("caption_capture_skipped", { reason: "join_not_confirmed" });
    }
    if (recordMeeting) {
      const recorderStart = await recorder.start({ context, artifactsDir });
      diagnostics.record("recorder_start", recorderStart);
    }
    if (input.localDialogAcceptanceUtterance) {
      const localDialogDispatch = await page
        .evaluate(
          async ({ text, sessionId: localSessionId }) => {
            if (!window.MAB_LOCAL_DIALOG_CONTROLLER?.sendUtterance) {
              return { ok: false, error: "local_dialog_controller_missing" };
            }
            return await window.MAB_LOCAL_DIALOG_CONTROLLER.sendUtterance({
              source: "joiner-acceptance",
              text,
              sessionId: localSessionId,
              context: { acceptance: "joiner-local-dialog" },
            });
          },
          { text: input.localDialogAcceptanceUtterance, sessionId },
        )
        .catch((error) => ({
          ok: false,
          error: String(error?.message || error),
        }));
      diagnostics.record("local_dialog_acceptance_dispatched", localDialogDispatch);
    }
    let screenShareStart = null;
    if (installScreenShareBridge && autoStartScreenShare) {
      screenShareStart = await page
        .evaluate(
          async ({ title, subtitle }) => {
            if (!window.MAB_SCREEN_SHARE_CONTROLLER?.start) {
              return { ok: false, error: "screen_share_controller_missing" };
            }
            return await window.MAB_SCREEN_SHARE_CONTROLLER.start({ title, subtitle });
          },
          {
            title: input.screenShareTitle || "Meeting Avatar Bot",
            subtitle: input.screenShareSubtitle || "Agent screen share",
          },
        )
        .catch((error) => ({
          ok: false,
          error: String(error?.message || error),
        }));
      diagnostics.record("screen_share_auto_start", screenShareStart);
    }
    const avatarReady = await evaluateAvatarReady(page);
    const avatarAudio = await evaluateAvatarAudio(page);
    const fixtureState = input.collectFixtureState ? await evaluateFixtureState(page) : null;
    const localDialog = await evaluateLocalDialogState(page);
    const screenShare = await evaluateScreenShareState(page);
    const meetPage = await evaluateMeetPageState(page);
    const captions = captionCapture ? await captionCapture.status() : null;
    diagnostics.record("join_complete", {
      clickedJoinSelector: clicked,
      admission,
      meetPage,
      avatarReady,
      avatarAudio,
      fixtureState,
      localDialog,
      screenShare,
      screenShareStart,
      avatarRendererStart,
      captions: compactCaptionState(captions),
    });
    await saveDiagnostics(diagnostics);
    active = {
      ...active,
      context,
      page,
      captionCapture,
      captionEnable,
      clickedJoinSelector: clicked,
      admission,
      avatarReady,
      avatarAudio,
      fixtureState,
      localDialog,
      screenShare,
      meetPage,
      captions,
    };

    return {
      ok: true,
      dryRun: false,
      sessionId,
      replacementStop,
      recordedBrowserStop,
      browserRecord,
      clickedJoinSelector: clicked,
      admission,
      screenshotDir: config.screenshotDir,
      diagnosticsPath: diagnostics.jsonPath,
      artifactsDir,
      recorder: recordMeeting ? recorder.status() : null,
      captions: compactCaptionState(captions),
      screenshots: diagnostics.screenshots,
      buttonInventories: diagnostics.buttonInventories,
      avatarReady,
      avatarAudio,
      fixtureState,
      localDialog,
      screenShare,
      meetPage,
      screenShareStart,
    };
  }

  async function refreshActiveRuntimeState() {
    if (!active?.page) return;
    const [
      avatarReady,
      avatarAudio,
      fixtureState,
      realtimeBridge,
      workerResultBridge,
      localDialog,
      screenShare,
      captions,
      meetPage,
    ] = await Promise.all([
      evaluateAvatarReady(active.page),
      evaluateAvatarAudio(active.page),
      evaluateFixtureState(active.page),
      evaluateRealtimeBridgeState(active.page),
      evaluateWorkerResultBridgeState(active.page),
      evaluateLocalDialogState(active.page),
      evaluateScreenShareState(active.page),
      active.captionCapture?.status() || Promise.resolve(null),
      evaluateMeetPageState(active.page),
    ]);
    active.avatarReady = avatarReady;
    active.avatarAudio = avatarAudio;
    active.fixtureState = fixtureState;
    active.realtimeBridge = realtimeBridge;
    active.workerResultBridge = workerResultBridge;
    active.localDialog = localDialog;
    active.screenShare = screenShare;
    active.captions = captions;
    active.meetPage = meetPage;
    if (active.diagnostics) {
      active.diagnostics.record("runtime_state_refresh", {
        meetPage,
        ...compactRuntimeState({
          avatarReady,
          avatarAudio,
          realtimeBridge,
          workerResultBridge,
          localDialog,
          screenShare,
          captions,
        }),
      });
      await saveDiagnostics(active.diagnostics).catch(() => {});
      await active.captionCapture?.flush().catch(() => {});
    }
  }

  async function injectWorkerResult(job) {
    if (!active?.page) return { ok: false, error: "no_active_join" };
    const result = await active.page
      .evaluate((payload) => {
        if (typeof window.MAB_REALTIME_CLIENT?.injectWorkerResult === "function") {
          return {
            ok: true,
            channel: "MAB_REALTIME_CLIENT.injectWorkerResult",
            delivery: window.MAB_REALTIME_CLIENT.injectWorkerResult(payload),
          };
        }
        if (typeof window.MAB_REALTIME_CLIENT?.sendWorkerResult === "function") {
          return {
            ok: true,
            channel: "MAB_REALTIME_CLIENT.sendWorkerResult",
            delivery: window.MAB_REALTIME_CLIENT.sendWorkerResult(payload),
          };
        }
        window.dispatchEvent(new CustomEvent("meeting-avatar-worker-result", { detail: payload }));
        return { ok: true, channel: "meeting-avatar-worker-result" };
      }, job)
      .catch((error) => ({ ok: false, error: String(error?.message || error) }));
    await refreshActiveRuntimeState();
    return {
      ...result,
      realtimeBridge: active.realtimeBridge || null,
      workerResultBridge: active.workerResultBridge || null,
    };
  }

  async function sendRealtimeEvent(event) {
    if (!active?.page) return { ok: false, error: "no_active_join" };
    const result = await active.page
      .evaluate((payload) => {
        if (!window.MAB_REALTIME_CLIENT?.sendRealtimeEvent) {
          return { ok: false, error: "realtime_client_missing" };
        }
        const channel = window.MAB_REALTIME_CLIENT.sendRealtimeEvent(payload);
        return { ok: true, channel };
      }, event)
      .catch((error) => ({ ok: false, error: String(error?.message || error) }));
    await refreshActiveRuntimeState();
    return {
      ...result,
      feedback: active.realtimeBridge?.feedback || null,
      realtimeBridge: active.realtimeBridge || null,
    };
  }

  async function requestRealtimeTextTurn({ text, instructions }) {
    const userText = String(text || "").trim();
    if (!userText) return { ok: false, error: "text_required" };
    const item = await sendRealtimeEvent({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: userText,
          },
        ],
      },
    });
    if (!item.ok) return item;
    const response = await sendRealtimeEvent({
      type: "response.create",
      response: {
        instructions:
          instructions || "Answer the user's text turn in concise Chinese with real audio.",
      },
    });
    return {
      ok: response.ok,
      item,
      response,
      feedback: response.feedback,
      realtimeBridge: response.realtimeBridge,
    };
  }

  async function sendMeetChat(input: MeetChatInput = {}) {
    const text = String(input.text || input.message || "").trim();
    if (!text) return { ok: false, error: "text_required" };
    if (!active?.page) return { ok: false, error: "no_active_join" };
    const result = await active.page
      .evaluate(
        async (payload) => {
          const client = window.MAB_REALTIME_CLIENT;
          if (typeof client?.runLocalMeetTool !== "function") {
            return { ok: false, error: "meet_chat_bridge_missing" };
          }
          return await client.runLocalMeetTool("send_meet_chat", payload);
        },
        { text },
      )
      .catch((error) => ({ ok: false, error: String(error?.message || error) }));
    await refreshActiveRuntimeState();
    return {
      ...result,
      realtimeBridge: active.realtimeBridge || null,
      fixtureState: active.fixtureState || null,
    };
  }

  async function readMeetChat(input: MeetChatInput = {}) {
    if (!active?.page) return { ok: false, error: "no_active_join" };
    const result = await active.page
      .evaluate(
        async (payload) => {
          const client = window.MAB_REALTIME_CLIENT;
          if (typeof client?.runLocalMeetTool !== "function") {
            return { ok: false, error: "meet_chat_bridge_missing" };
          }
          return await client.runLocalMeetTool("read_meet_chat", payload);
        },
        {
          limit: input.limit || input.count || 10,
          onlyLinks: Boolean(input.onlyLinks || input.only_links),
        },
      )
      .catch((error) => ({ ok: false, error: String(error?.message || error) }));
    await refreshActiveRuntimeState();
    return {
      ...result,
      realtimeBridge: active.realtimeBridge || null,
      fixtureState: active.fixtureState || null,
    };
  }

  async function startScreenShare(input: ScreenShareBridgeInput = {}) {
    if (!active?.page) return { ok: false, error: "no_active_join" };
    const result = await active.page
      .evaluate(
        async (payload) => {
          if (!window.MAB_SCREEN_SHARE_CONTROLLER?.start) {
            return { ok: false, error: "screen_share_controller_missing" };
          }
          return await window.MAB_SCREEN_SHARE_CONTROLLER.start(payload);
        },
        {
          title: input.title || "Meeting Avatar Bot",
          subtitle: input.subtitle || "Agent screen share",
          preview: Boolean(input.preview),
        },
      )
      .catch((error) => ({ ok: false, error: String(error?.message || error) }));
    active.diagnostics?.record("screen_share_start_requested", result);
    await refreshActiveRuntimeState();
    return {
      ...result,
      screenShare: active.screenShare || null,
      fixtureState: active.fixtureState || null,
    };
  }

  async function presentScreenShare(input: ScreenShareBridgeInput = {}) {
    if (!active?.page) return { ok: false, error: "no_active_join" };
    const meetPage = await evaluateMeetPageState(active.page);
    const beforePresentation = await getMeetPresentationState(active.page);
    const beforeButtons = await collectButtonInventory(
      active.page,
      active.diagnostics,
      "before-native-present",
    );
    active.diagnostics?.record("screen_share_present_start", {
      inputMode: input.mode || "",
      waitMs: input.waitMs || 0,
      meetPage,
      beforePresentation,
      beforeButtons: beforeButtons.slice(0, 30),
    });
    await saveDiagnostics(active.diagnostics).catch(() => {});
    if (!meetPage.inMeeting) {
      active.diagnostics?.record("screen_share_present_blocked", {
        reason: meetPage.signIn ? "google_sign_in_required" : "not_in_meeting",
        meetPage,
        beforePresentation,
      });
      await saveDiagnostics(active.diagnostics).catch(() => {});
      return {
        ok: false,
        error: meetPage.signIn ? "google_sign_in_required" : "not_in_meeting",
        mode: input.mode || "",
        meetPage,
        presentation: beforePresentation,
        buttons: beforeButtons.slice(0, 30),
      };
    }
    const controllerBefore = await readScreenShareControllerState(active.page);
    const nativeMode = controllerBefore?.mode === "native" || input.mode === "native";
    const start = nativeMode
      ? {
          ok: true,
          mode: "native",
          skipped: true,
          reason: "meet_native_present_uses_meet_getDisplayMedia",
          controllerBefore,
        }
      : await startScreenShare(input);
    const clickedSelector = await clickMeetShareScreenControl(active.page, active.diagnostics, {
      allowCoordinateFallback: Boolean(input.allowCoordinateFallback),
    });
    if (!clickedSelector) {
      const afterMissPresentation = await getMeetPresentationState(active.page);
      active.diagnostics?.record("screen_share_present_blocked", {
        reason: "share_screen_button_not_found",
        start,
        afterMissPresentation,
      });
      await saveDiagnostics(active.diagnostics).catch(() => {});
      return {
        ok: false,
        error: "share_screen_button_not_found",
        mode: nativeMode ? "native" : "synthetic",
        start,
        presentation: afterMissPresentation,
        screenShare: active.screenShare || null,
        fixtureState: active.fixtureState || null,
      };
    }
    const afterClickPresentation = await getMeetPresentationState(active.page);
    active.diagnostics?.record("screen_share_present_clicked", {
      nativeMode,
      clickedSelector,
      start,
      afterClickPresentation,
    });
    await saveDiagnostics(active.diagnostics).catch(() => {});
    if (nativeMode) {
      await withTimeout(
        active.page.waitForTimeout(Math.min(Number(input.waitMs || 1500), 2000)),
        2500,
        null,
      );
      const afterWaitPresentation = await getMeetPresentationState(active.page);
      const permissionHint = getNativeScreenShareFailureHint(afterWaitPresentation);
      const ok = Boolean(start.ok && clickedSelector && !afterWaitPresentation.failed);
      active.diagnostics?.record("screen_share_present_native_result", {
        ok,
        afterWaitPresentation,
        permissionHint,
      });
      await saveDiagnostics(active.diagnostics).catch(() => {});
      return {
        ok,
        mode: "native",
        start,
        clickedSelector,
        presentation: afterWaitPresentation,
        permissionHint,
        note: "native_present_handoff_clicked; Meet/Chrome owns desktop picker and stream state",
        screenShare: active.screenShare || null,
        fixtureState: active.fixtureState || null,
      };
    }
    await clickFirstVisible(
      active.page,
      [
        "text=/Your entire screen/i",
        "text=/Entire screen/i",
        "text=/A window/i",
        "text=/A tab/i",
        'button:has-text("Share")',
      ],
      700,
      active.diagnostics,
    );
    await active.page.waitForTimeout(Number(input.waitMs || 3000));
    let screenshot = "";
    try {
      screenshot = await takeScreenshot(
        active.page,
        active.diagnostics,
        "screen-share-present-click",
      );
    } catch (error) {
      active.diagnostics?.record("screen_share_present_screenshot_error", {
        error: String(error?.message || error),
      });
    }
    const buttons = await collectButtonInventory(
      active.page,
      active.diagnostics,
      "after-screen-share-present-click",
    );
    await refreshActiveRuntimeState();
    active.diagnostics?.record("screen_share_present_requested", {
      start,
      clickedSelector,
      screenshot,
    });
    await saveDiagnostics(active.diagnostics).catch(() => {});
    return {
      ok: Boolean(start.ok && clickedSelector),
      start,
      clickedSelector,
      screenshot,
      visibleButtonLabels: buttons
        .filter((button) => button.visible)
        .map((button) => button.aria || button.text || "")
        .filter(Boolean),
      screenShare: active.screenShare || null,
      fixtureState: active.fixtureState || null,
    };
  }

  async function openVideoStage(input: VideoStageInput = {}) {
    if (!active?.context) return { ok: false, error: "no_active_join" };
    if (active.stagePage && !active.stagePage.isClosed()) {
      await active.stagePage.close().catch(() => {});
    }
    const stagePage = await active.context.newPage();
    active.stagePage = stagePage;
    installPageDiagnostics(stagePage, active.diagnostics);
    const html = buildVideoStageHtml(input);
    await stagePage.setContent(html, { waitUntil: "domcontentloaded" });
    await stagePage
      .setViewportSize({
        width: Number(input.width || 1280),
        height: Number(input.height || 720),
      })
      .catch(() => {});
    await stagePage.waitForTimeout(500);
    const stage = await withTimeout(
      stagePage.evaluate(() => window.MAB_VIDEO_STAGE || null),
      2500,
      null,
    ).catch((error) => ({ ok: false, error: String(error?.message || error) }));
    active.diagnostics?.record("video_stage_opened", {
      title: input.stageTitle || input.title || "Meeting Avatar Bot",
      videoUrl: input.videoUrl || input.url || input.path || "",
      stage,
    });
    await saveDiagnostics(active.diagnostics).catch(() => {});
    return {
      ok: true,
      title: await stagePage.title().catch(() => ""),
      url: stagePage.url(),
      stage,
    };
  }

  async function presentVideoStage(input: ScreenShareBridgeInput = {}) {
    if (!active?.page) return { ok: false, error: "no_active_join" };
    const stage = await openVideoStage({
      ...input,
      stageTitle: input.stageTitle || "Meeting Avatar Bot",
    });
    if (!stage.ok) return stage;
    const presentationMode = input.mode || input.screenShareMode || "synthetic";
    const syntheticController =
      presentationMode === "synthetic"
        ? await ensureScreenShareController(active.page, {
            ...input,
            mode: "synthetic",
            title: input.title || "Onee Sama video stage",
            subtitle: input.subtitle || "Shared by Onee Sama",
            fps: input.fps || 30,
          })
        : null;
    await active.page.bringToFront().catch(() => {});
    const present = await presentScreenShare({
      ...input,
      mode: presentationMode,
      waitMs: input.waitMs || 2500,
    });
    return {
      ok: Boolean(stage.ok && present.ok),
      stage,
      syntheticController,
      present,
      note:
        presentationMode === "synthetic"
          ? "video_stage_tab_opened; synthetic Meet screen-share stream was requested"
          : "video_stage_tab_opened; Meet native tab share was requested",
    };
  }

  async function stopScreenShare() {
    if (!active?.page) return { ok: false, error: "no_active_join" };
    const result = await active.page
      .evaluate(async () => {
        if (!window.MAB_SCREEN_SHARE_CONTROLLER?.stop) {
          return { ok: false, error: "screen_share_controller_missing" };
        }
        return await window.MAB_SCREEN_SHARE_CONTROLLER.stop();
      })
      .catch((error) => ({ ok: false, error: String(error?.message || error) }));
    active.diagnostics?.record("screen_share_stop_requested", result);
    await refreshActiveRuntimeState();
    return {
      ...result,
      screenShare: active.screenShare || null,
      fixtureState: active.fixtureState || null,
    };
  }

  async function status() {
    await refreshActiveRuntimeState();
    return {
      ok: true,
      active: active
        ? {
            sessionId: active.sessionId,
            meetUrl: active.meetUrl,
            startedAt: active.startedAt,
            meetProfileMode: active.meetProfileMode || "",
            browserUserDataDir: active.browserUserDataDir || "",
            clickedJoinSelector: active.clickedJoinSelector || "",
            diagnosticsPath: active.diagnostics?.jsonPath || "",
            artifactsDir: active.artifactsDir || "",
            screenshots: active.diagnostics?.screenshots || [],
            avatarReady: active.avatarReady || null,
            avatarAudio: active.avatarAudio || null,
            recorder: active.recorder?.status() || null,
            captions: compactCaptionState(active.captions) || null,
            fixtureState: active.fixtureState || null,
            realtimeBridge: active.realtimeBridge || null,
            workerResultBridge: active.workerResultBridge || null,
            localDialog: active.localDialog || null,
            screenShare: active.screenShare || null,
            meetPage: active.meetPage || null,
          }
        : null,
    };
  }

  return {
    join,
    stop,
    status,
    injectWorkerResult,
    sendRealtimeEvent,
    requestRealtimeTextTurn,
    sendMeetChat,
    readMeetChat,
    startScreenShare,
    presentScreenShare,
    openVideoStage,
    presentVideoStage,
    stopScreenShare,
  };
}
