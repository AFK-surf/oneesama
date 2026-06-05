import { spawnSync } from "node:child_process";
import type { Locator, Page } from "playwright";
import type { Diagnostics } from "./google-meet-joiner-base.ts";

export type UIInteractionMode = "synthetic" | "humanized";
export type UIInteractionRequest = "auto" | UIInteractionMode | "xdotool" | "xtest";
export type UIInteractionBackend = "playwright" | "cliclick" | "xdotool" | "xtest";

export type CommandResult = {
  status: number | null;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  error?: Error;
};

export type CommandRunner = (command: string, args: string[]) => CommandResult;

export type Point = {
  x: number;
  y: number;
};

export type TimedPoint = Point & {
  t: number;
};

export type HumanizedClickPlan = {
  seed: number;
  profile: string;
  endpoint: Point;
  points: TimedPoint[];
  preClickDelayMs: number;
  holdMs: number;
};

export type ElementBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type ClickTarget = {
  screen: Point;
  viewport: Point;
};

export type PageWindowMetrics = {
  screenX: number;
  screenY: number;
  outerWidth: number;
  outerHeight: number;
  innerWidth: number;
  innerHeight: number;
  devicePixelRatio: number;
};

export type ScreenGeometry = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type UIInteractionDetails = {
  mode: UIInteractionMode;
  requested: UIInteractionRequest;
  backend: UIInteractionBackend;
  lane: string;
  reason: string;
};

export interface UIInteraction {
  readonly details: UIInteractionDetails;
  click(locator: Locator): Promise<void>;
  fill(locator: Locator, text: string): Promise<void>;
  pressKey(page: Page, key: string): Promise<void>;
}

const defaultStepMs = 16;

export function defaultCommandRunner(command: string, args: string[]): CommandResult {
  return spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function envValue(env: NodeJS.ProcessEnv, name: string): string {
  return (env[name] || "").trim();
}

function parseInteractionRequest(rawValue: string): UIInteractionRequest {
  const raw = rawValue.trim().toLowerCase();
  switch (raw) {
    case "":
    case "auto":
      return "auto";
    case "humanized":
    case "os":
      return "humanized";
    case "x11":
    case "xdotool":
      return "xdotool";
    case "xtest":
      return "xtest";
    case "synthetic":
    case "playwright":
    case "cdp":
    case "robotic":
      return "synthetic";
    default:
      throw new Error(`Unsupported MEET_UI_INTERACTION_MODE=${rawValue}`);
  }
}

export function canUseX11Input(
  env: NodeJS.ProcessEnv = process.env,
  runner: CommandRunner = defaultCommandRunner,
): { ok: true } | { ok: false; reason: string } {
  if (!envValue(env, "DISPLAY")) {
    return { ok: false, reason: "DISPLAY is not set" };
  }

  const result = runner("xdotool", ["getmouselocation", "--shell"]);
  if (result.error) {
    return { ok: false, reason: `xdotool unavailable: ${result.error.message}` };
  }
  if (result.status !== 0) {
    const stderr = String(result.stderr || "").trim();
    return { ok: false, reason: `xdotool probe failed: ${stderr || `exit ${result.status}`}` };
  }
  return { ok: true };
}

export function xtestCommand(env: NodeJS.ProcessEnv = process.env): string {
  return envValue(env, "MEET_XTEST_INPUT_COMMAND") || "cueboard-xtest-input";
}

export function canUseXTestInput(
  env: NodeJS.ProcessEnv = process.env,
  runner: CommandRunner = defaultCommandRunner,
): { ok: true } | { ok: false; reason: string } {
  if (!envValue(env, "DISPLAY")) {
    return { ok: false, reason: "DISPLAY is not set" };
  }

  const command = xtestCommand(env);
  const result = runner(command, ["probe", "--json"]);
  if (result.error) {
    return { ok: false, reason: `${command} unavailable: ${result.error.message}` };
  }
  if (result.status !== 0) {
    const stderr = String(result.stderr || "").trim();
    return { ok: false, reason: `${command} probe failed: ${stderr || `exit ${result.status}`}` };
  }
  return { ok: true };
}

export function canUseMacInput(
  runner: CommandRunner = defaultCommandRunner,
): { ok: true } | { ok: false; reason: string } {
  const result = runner("cliclick", ["p:."]);
  if (result.error) {
    return { ok: false, reason: `cliclick unavailable: ${result.error.message}` };
  }
  if (result.status !== 0) {
    const stderr = String(result.stderr || "").trim();
    return { ok: false, reason: `cliclick probe failed: ${stderr || `exit ${result.status}`}` };
  }
  return { ok: true };
}

function inputProbeReason(result: { ok: true } | { ok: false; reason: string }): string {
  return "reason" in result ? result.reason : "";
}

export function resolveUIInteractionDetails(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  runner: CommandRunner = defaultCommandRunner,
): UIInteractionDetails {
  const requested = parseInteractionRequest(envValue(env, "MEET_UI_INTERACTION_MODE"));
  if (requested === "synthetic") {
    return {
      mode: "synthetic",
      requested,
      backend: "playwright",
      lane: envValue(env, "MEET_JOIN_LANE") || "docker_synthetic",
      reason: "requested synthetic input",
    };
  }

  if (platform === "darwin") {
    const mac = canUseMacInput(runner);
    if (requested === "humanized" || requested === "xtest" || requested === "xdotool") {
      if (!mac.ok) {
        throw new Error(
          `MEET_UI_INTERACTION_MODE=humanized requires macOS input: ${inputProbeReason(mac)}`,
        );
      }
      return {
        mode: "humanized",
        requested,
        backend: "cliclick",
        lane: envValue(env, "MEET_JOIN_LANE") || "macos_host_humanized_control",
        reason: "requested humanized macOS input",
      };
    }
    if (!mac.ok) {
      return {
        mode: "synthetic",
        requested,
        backend: "playwright",
        lane: envValue(env, "MEET_JOIN_LANE") || "macos_synthetic",
        reason: `auto fallback: ${inputProbeReason(mac)}`,
      };
    }
    return {
      mode: "humanized",
      requested,
      backend: "cliclick",
      lane: envValue(env, "MEET_JOIN_LANE") || "macos_host_humanized_control",
      reason: "auto selected humanized macOS input",
    };
  }

  if (requested === "auto" && platform !== "linux") {
    return {
      mode: "synthetic",
      requested,
      backend: "playwright",
      lane: envValue(env, "MEET_JOIN_LANE") || `${platform}_synthetic`,
      reason: `auto fallback on ${platform}`,
    };
  }

  const xtest = canUseXTestInput(env, runner);
  if (requested === "xtest") {
    if (!xtest.ok) {
      throw new Error(
        `MEET_UI_INTERACTION_MODE=xtest requires XTEST input: ${inputProbeReason(xtest)}`,
      );
    }
    return {
      mode: "humanized",
      requested,
      backend: "xtest",
      lane: envValue(env, "MEET_JOIN_LANE") || "docker_xtest_humanized",
      reason: "requested clean-room XTEST humanized input",
    };
  }

  const x11 = canUseX11Input(env, runner);
  if (requested === "xdotool") {
    if (!x11.ok) {
      throw new Error(
        `MEET_UI_INTERACTION_MODE=humanized requires X11 input: ${inputProbeReason(x11)}`,
      );
    }
    return {
      mode: "humanized",
      requested,
      backend: "xdotool",
      lane: envValue(env, "MEET_JOIN_LANE") || "docker_xdotool_humanized",
      reason: "requested xdotool humanized X11 input",
    };
  }

  if (requested === "humanized") {
    if (xtest.ok) {
      return {
        mode: "humanized",
        requested,
        backend: "xtest",
        lane: envValue(env, "MEET_JOIN_LANE") || "docker_xtest_humanized",
        reason: "requested humanized input; selected clean-room XTEST backend",
      };
    }
    if (!x11.ok) {
      throw new Error(
        `MEET_UI_INTERACTION_MODE=humanized requires XTEST or X11 input: ${inputProbeReason(xtest)}; ${inputProbeReason(x11)}`,
      );
    }
    return {
      mode: "humanized",
      requested,
      backend: "xdotool",
      lane: envValue(env, "MEET_JOIN_LANE") || "docker_xdotool_humanized",
      reason: `requested humanized input; XTEST unavailable (${inputProbeReason(xtest)}); selected xdotool fallback`,
    };
  }

  if (xtest.ok) {
    return {
      mode: "humanized",
      requested,
      backend: "xtest",
      lane: envValue(env, "MEET_JOIN_LANE") || "docker_xtest_humanized",
      reason: "auto selected clean-room XTEST humanized input",
    };
  }
  if (x11.ok) {
    return {
      mode: "humanized",
      requested,
      backend: "xdotool",
      lane: envValue(env, "MEET_JOIN_LANE") || "docker_xdotool_humanized",
      reason: `auto selected xdotool fallback because XTEST is unavailable: ${inputProbeReason(xtest)}`,
    };
  }
  return {
    mode: "synthetic",
    requested,
    backend: "playwright",
    lane: envValue(env, "MEET_JOIN_LANE") || "docker_synthetic",
    reason: `auto fallback: ${inputProbeReason(xtest)}; ${inputProbeReason(x11)}`,
  };
}

export function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function minimumJerk(t: number): number {
  return 10 * t ** 3 - 15 * t ** 4 + 6 * t ** 5;
}

export function generateHumanizedTrajectory(
  start: Point,
  end: Point,
  seed = Date.now(),
): TimedPoint[] {
  const random = createSeededRandom(seed);
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const distance = Math.hypot(dx, dy);
  const durationMs = clamp(360 + distance * 0.55 + random() * 220, 430, 1600);
  const steps = Math.round(clamp(durationMs / defaultStepMs, 24, 90));
  const normalLength = Math.max(1, distance);
  const normalX = -dy / normalLength;
  const normalY = dx / normalLength;
  const bend = (random() - 0.5) * clamp(distance * 0.16, 12, 90);
  const wave = (random() - 0.5) * clamp(distance * 0.05, 3, 24);
  const jitter = clamp(distance * 0.006, 0.25, 2.4);
  const points: TimedPoint[] = [];

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const eased = minimumJerk(t);
    const envelope = Math.sin(Math.PI * t);
    const sideOffset = envelope * bend + Math.sin(Math.PI * 2 * t) * wave;
    const jitterEnvelope = Math.sin(Math.PI * t) ** 1.5;
    const jitterX = (random() - 0.5) * jitter * jitterEnvelope;
    const jitterY = (random() - 0.5) * jitter * jitterEnvelope;

    points.push({
      x: start.x + dx * eased + normalX * sideOffset + jitterX,
      y: start.y + dy * eased + normalY * sideOffset + jitterY,
      t: Math.round(durationMs * t),
    });
  }

  points[0] = { ...start, t: 0 };
  points[points.length - 1] = { ...end, t: Math.round(durationMs) };
  return points;
}

export function generateHumanizedClickPlan(
  start: Point,
  endpoints: Point[],
  seed = Date.now(),
): HumanizedClickPlan {
  if (endpoints.length === 0) {
    throw new Error("generateHumanizedClickPlan requires at least one endpoint");
  }

  const random = createSeededRandom(seed);
  const endpoint = endpoints[Math.floor(random() * endpoints.length)] || endpoints[0];
  const points = generateHumanizedTrajectory(start, endpoint, seed ^ 0xa11ce);
  const distance = Math.hypot(endpoint.x - start.x, endpoint.y - start.y);
  const profile =
    distance > 180 && random() > 0.35 ? "transformed_settle_overshoot" : "transformed_settle";
  const settled = addSettleMotion(
    points,
    endpoint,
    random,
    profile === "transformed_settle_overshoot",
  );
  return {
    seed,
    profile,
    endpoint,
    points: settled,
    preClickDelayMs: Math.round(70 + random() * 180),
    holdMs: Math.round(55 + random() * 135),
  };
}

function addSettleMotion(
  points: TimedPoint[],
  endpoint: Point,
  random: () => number,
  allowOvershoot: boolean,
): TimedPoint[] {
  if (points.length < 2) {
    return points;
  }
  const result = points.slice(0, -1);
  const previous = result[result.length - 1];
  const finalT = points[points.length - 1].t;
  const angle = random() * Math.PI * 2;
  const radius = allowOvershoot ? 4 + random() * 14 : 1 + random() * 5;
  const settleCount = allowOvershoot ? 4 : 2 + Math.floor(random() * 3);
  const settleWindowMs = Math.min(260, Math.max(90, finalT - previous.t + 110));

  for (let i = 0; i < settleCount; i++) {
    const progress = (i + 1) / (settleCount + 1);
    const decay = (1 - progress) ** 1.4;
    const wobble = angle + i * (Math.PI * 0.72 + random() * 0.4);
    result.push({
      x: endpoint.x + Math.cos(wobble) * radius * decay,
      y: endpoint.y + Math.sin(wobble) * radius * decay,
      t: Math.round(finalT - settleWindowMs + settleWindowMs * progress),
    });
  }

  result.push({ ...endpoint, t: finalT + Math.round(25 + random() * 95) });
  for (let i = 1; i < result.length; i++) {
    if (result[i].t <= result[i - 1].t) {
      result[i] = { ...result[i], t: result[i - 1].t + defaultStepMs };
    }
  }
  return result;
}

export function parseXdotoolShellGeometry(output: string): ScreenGeometry | null {
  const values = new Map<string, number>();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^([A-Z]+)=(-?\d+)$/);
    if (!match) {
      continue;
    }
    values.set(match[1], Number(match[2]));
  }

  const x = values.get("X");
  const y = values.get("Y");
  const width = values.get("WIDTH");
  const height = values.get("HEIGHT");
  if ([x, y, width, height].some((value) => value === undefined || !Number.isFinite(value))) {
    return null;
  }
  return { x: x!, y: y!, width: width!, height: height! };
}

export function computeScreenPoint(
  box: ElementBox,
  metrics: PageWindowMetrics,
  geometry?: ScreenGeometry | null,
): Point {
  return computeScreenPointForViewport(
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    metrics,
    geometry,
  );
}

export function computeScreenPointForViewport(
  viewportPoint: Point,
  metrics: PageWindowMetrics,
  geometry?: ScreenGeometry | null,
): Point {
  const scale =
    Number.isFinite(metrics.devicePixelRatio) && metrics.devicePixelRatio > 0
      ? metrics.devicePixelRatio
      : 1;
  const viewportX = viewportPoint.x * scale;
  const viewportY = viewportPoint.y * scale;
  const innerWidth = Math.max(1, metrics.innerWidth * scale);
  const innerHeight = Math.max(1, metrics.innerHeight * scale);

  if (geometry) {
    const horizontalChrome = Math.max(0, geometry.width - innerWidth);
    const leftChrome = horizontalChrome / 2;
    const topChrome = Math.max(0, geometry.height - innerHeight - leftChrome);
    return {
      x: Math.round(geometry.x + leftChrome + viewportX),
      y: Math.round(geometry.y + topChrome + viewportY),
    };
  }

  const horizontalChrome = Math.max(0, metrics.outerWidth - metrics.innerWidth);
  const leftChrome = horizontalChrome / 2;
  const topChrome = Math.max(0, metrics.outerHeight - metrics.innerHeight - leftChrome);
  return {
    x: Math.round((metrics.screenX + leftChrome) * scale + viewportX),
    y: Math.round((metrics.screenY + topChrome) * scale + viewportY),
  };
}

function candidateViewportPoints(box: ElementBox): Point[] {
  const insetX = Math.min(Math.max(box.width * 0.18, 4), Math.max(4, box.width / 2 - 2));
  const insetY = Math.min(Math.max(box.height * 0.18, 4), Math.max(4, box.height / 2 - 2));
  const left = box.x + insetX;
  const right = box.x + box.width - insetX;
  const top = box.y + insetY;
  const bottom = box.y + box.height - insetY;
  const midX = box.x + box.width / 2;
  const midY = box.y + box.height / 2;

  return [
    { x: midX, y: midY },
    { x: left, y: midY },
    { x: right, y: midY },
    { x: midX, y: top },
    { x: midX, y: bottom },
    { x: left, y: top },
    { x: right, y: bottom },
  ];
}

async function isLocatorHitAtViewportPoint(locator: Locator, point: Point): Promise<boolean> {
  return locator
    .evaluate(
      (el, { x, y }) => {
        const hit = document.elementFromPoint(x, y);
        if (!hit) {
          return false;
        }
        if (el === hit || el.contains(hit)) {
          return true;
        }
        const interactive = hit.closest(
          "button, [role='button'], input, textarea, [contenteditable='true']",
        );
        return interactive === el || Boolean(interactive && el.contains(interactive));
      },
      { x: point.x, y: point.y },
    )
    .catch(() => false);
}

async function locatorClickTargets(
  locator: Locator,
  geometry?: ScreenGeometry | null,
  devicePixelRatioOverride?: number,
): Promise<ClickTarget[]> {
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error("Cannot interact with an element that has no bounding box");
  }

  const page = locator.page();
  const metrics = await page.evaluate<PageWindowMetrics>(() => ({
    screenX: window.screenX,
    screenY: window.screenY,
    outerWidth: window.outerWidth,
    outerHeight: window.outerHeight,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio || 1,
  }));
  if (
    devicePixelRatioOverride &&
    Number.isFinite(devicePixelRatioOverride) &&
    devicePixelRatioOverride > 0
  ) {
    metrics.devicePixelRatio = devicePixelRatioOverride;
  }

  const targets: ClickTarget[] = [];
  for (const viewport of candidateViewportPoints(box)) {
    if (!(await isLocatorHitAtViewportPoint(locator, viewport))) {
      continue;
    }
    targets.push({
      viewport,
      screen: computeScreenPointForViewport(viewport, metrics, geometry),
    });
  }

  if (targets.length > 0) {
    return targets;
  }

  const viewport = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  return [
    {
      viewport,
      screen: computeScreenPointForViewport(viewport, metrics, geometry),
    },
  ];
}

function ensureCommand(result: CommandResult, command: string, args: string[]): string {
  if (result.error) {
    throw new Error(`${command} ${args.join(" ")} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = String(result.stderr || "").trim();
    throw new Error(`${command} ${args.join(" ")} failed: ${stderr || `exit ${result.status}`}`);
  }
  return String(result.stdout || "").trim();
}

function parseMouseLocation(output: string): Point | null {
  const x = output.match(/\bX=(-?\d+)\b/);
  const y = output.match(/\bY=(-?\d+)\b/);
  if (!x || !y) {
    return null;
  }
  return { x: Number(x[1]), y: Number(y[1]) };
}

function parseCliclickLocation(output: string): Point | null {
  const match = output.trim().match(/^(-?\d+),(-?\d+)$/);
  if (!match) {
    return null;
  }
  return { x: Number(match[1]), y: Number(match[2]) };
}

function keyForCliclick(key: string): string {
  switch (key.toLowerCase()) {
    case "escape":
    case "esc":
      return "esc";
    case "enter":
    case "return":
      return "return";
    case "tab":
      return "tab";
    case " ":
    case "space":
      return "space";
    default:
      return key.toLowerCase();
  }
}

class SyntheticInteraction implements UIInteraction {
  readonly details: UIInteractionDetails;

  constructor(details: UIInteractionDetails) {
    this.details = details;
  }

  async click(locator: Locator): Promise<void> {
    await locator.click();
  }

  async fill(locator: Locator, text: string): Promise<void> {
    await locator.fill(text);
  }

  async pressKey(page: Page, key: string): Promise<void> {
    await page.keyboard.press(key);
  }
}

class MacHumanizedInteraction implements UIInteraction {
  readonly details: UIInteractionDetails;
  private readonly runner: CommandRunner;

  constructor(details: UIInteractionDetails, runner: CommandRunner) {
    this.details = details;
    this.runner = runner;
  }

  async click(locator: Locator): Promise<void> {
    await locator.scrollIntoViewIfNeeded().catch(() => {});
    const page = locator.page();
    await page.bringToFront();
    this.activateChromeForInput("click");
    await page.waitForTimeout(120);
    const targets = await locatorClickTargets(locator, null, 1);
    let lastError: unknown = null;
    for (const target of targets) {
      try {
        this.moveToAndClick(target.screen);
        return;
      } catch (err) {
        lastError = err;
        await page.waitForTimeout(120);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(String(lastError || "macOS click failed"));
  }

  async fill(locator: Locator, text: string): Promise<void> {
    await this.click(locator);
    await locator.focus().catch(() => {});
    await locator.page().waitForTimeout(90);
    this.activateChromeForInput("paste");
    this.withClipboard(text, () => {
      this.runCliclick(["kd:cmd", "t:a", "ku:cmd", "kd:cmd", "t:v", "ku:cmd"]);
    });
  }

  async pressKey(page: Page, key: string): Promise<void> {
    await page.bringToFront();
    this.activateChromeForInput(`key:${key}`);
    await page.waitForTimeout(80);
    this.runCliclick([`kp:${keyForCliclick(key)}`]);
  }

  private currentMouseLocation(): Point | null {
    const result = this.runner("cliclick", ["p:."]);
    if (result.status !== 0 || result.error) {
      return null;
    }
    return parseCliclickLocation(String(result.stdout || ""));
  }

  private moveToAndClick(target: Point): void {
    const start = this.currentMouseLocation() || { x: target.x - 140, y: target.y + 80 };
    const points = generateHumanizedTrajectory(start, target);
    const args: string[] = [];

    for (let i = 1; i < points.length; i++) {
      const previous = points[i - 1];
      const point = points[i];
      const waitMs = Math.max(4, point.t - previous.t);
      args.push(`m:${Math.round(point.x)},${Math.round(point.y)}`, `w:${waitMs}`);
    }
    args.push(`c:${target.x},${target.y}`);
    this.runCliclick(args);

    const location = this.currentMouseLocation();
    if (location && Math.hypot(location.x - target.x, location.y - target.y) > 12) {
      throw new Error(
        `macOS pointer endpoint mismatch: got ${location.x},${location.y}; wanted ${target.x},${target.y}`,
      );
    }
  }

  private runCliclick(args: string[]): string {
    return ensureCommand(this.runner("cliclick", args), "cliclick", args);
  }

  private activateChromeForInput(stage: string): void {
    const activate = spawnSync(
      "osascript",
      ["-e", 'tell application "Google Chrome" to activate'],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    if (activate.error || activate.status !== 0) {
      throw new Error(
        `osascript activate Google Chrome failed during ${stage}: ${
          activate.error?.message ||
          String(activate.stderr || "").trim() ||
          `exit ${activate.status}`
        }`,
      );
    }
  }

  private withClipboard(text: string, action: () => void): void {
    const previous = spawnSync("pbpaste", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const hadPrevious = !previous.error && previous.status === 0;
    const previousText = hadPrevious ? String(previous.stdout || "") : "";

    const copy = spawnSync("pbcopy", {
      input: text,
      encoding: "utf8",
      stdio: ["pipe", "ignore", "pipe"],
    });
    ensureCommand(copy, "pbcopy", []);

    try {
      action();
    } finally {
      if (hadPrevious) {
        spawnSync("pbcopy", {
          input: previousText,
          encoding: "utf8",
          stdio: ["pipe", "ignore", "ignore"],
        });
      }
    }
  }
}

class X11HumanizedInteraction implements UIInteraction {
  readonly details: UIInteractionDetails;
  private readonly runner: CommandRunner;

  constructor(details: UIInteractionDetails, runner: CommandRunner) {
    this.details = details;
    this.runner = runner;
  }

  async click(locator: Locator): Promise<void> {
    await locator.scrollIntoViewIfNeeded().catch(() => {});
    const page = locator.page();
    await page.bringToFront();
    await page.waitForTimeout(120);
    const targets = await locatorClickTargets(locator, this.activeWindowGeometry());
    let lastError: unknown = null;
    for (const target of targets) {
      try {
        this.moveToAndClick(target.screen);
        return;
      } catch (err) {
        lastError = err;
        await page.waitForTimeout(120);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(String(lastError || "X11 click failed"));
  }

  async fill(locator: Locator, text: string): Promise<void> {
    await this.click(locator);
    this.runXdotool(["key", "--clearmodifiers", "ctrl+a"]);
    this.runXdotool(["type", "--clearmodifiers", "--delay", "35", text]);
  }

  async pressKey(page: Page, key: string): Promise<void> {
    await page.bringToFront();
    await page.waitForTimeout(80);
    this.runXdotool(["key", "--clearmodifiers", key]);
  }

  private activeWindowGeometry(): ScreenGeometry | null {
    try {
      const output = ensureCommand(
        this.runner("xdotool", ["getactivewindow", "getwindowgeometry", "--shell"]),
        "xdotool",
        ["getactivewindow", "getwindowgeometry", "--shell"],
      );
      return parseXdotoolShellGeometry(output);
    } catch (err) {
      const searched = this.searchVisibleBrowserWindowGeometry();
      if (searched) {
        console.error(
          `[meeting-joiner] Active X11 window geometry unavailable, using visible browser window geometry: ${String(err)}`,
        );
        return searched;
      }
      console.error(
        `[meeting-joiner] X11 window geometry unavailable, using browser window metrics: ${String(err)}`,
      );
      return null;
    }
  }

  private searchVisibleBrowserWindowGeometry(): ScreenGeometry | null {
    for (const className of ["chromium", "chrome", "google-chrome"]) {
      const search = this.runner("xdotool", ["search", "--onlyvisible", "--class", className]);
      if (search.error || search.status !== 0) {
        continue;
      }

      const windowIDs = String(search.stdout || "")
        .split(/\s+/)
        .map((value) => value.trim())
        .filter(Boolean)
        .reverse();
      for (const windowID of windowIDs) {
        const geometry = this.runner("xdotool", ["getwindowgeometry", "--shell", windowID]);
        if (geometry.error || geometry.status !== 0) {
          continue;
        }
        const parsed = parseXdotoolShellGeometry(String(geometry.stdout || ""));
        if (parsed && parsed.width > 100 && parsed.height > 100) {
          return parsed;
        }
      }
    }
    return null;
  }

  private currentMouseLocation(): Point | null {
    const result = this.runner("xdotool", ["getmouselocation", "--shell"]);
    if (result.status !== 0 || result.error) {
      return null;
    }
    return parseMouseLocation(String(result.stdout || ""));
  }

  private moveToAndClick(target: Point): void {
    const start = this.currentMouseLocation() || { x: target.x - 140, y: target.y + 80 };
    const points = generateHumanizedTrajectory(start, target);
    const args: string[] = [];
    let previousRounded = { x: Math.round(start.x), y: Math.round(start.y) };

    for (let i = 1; i < points.length; i++) {
      const previous = points[i - 1];
      const point = points[i];
      const waitSeconds = Math.max(0.004, (point.t - previous.t) / 1000);
      const rounded = { x: Math.round(point.x), y: Math.round(point.y) };
      if (rounded.x === previousRounded.x && rounded.y === previousRounded.y) {
        continue;
      }
      args.push("mousemove", String(rounded.x), String(rounded.y), "sleep", waitSeconds.toFixed(3));
      previousRounded = rounded;
    }
    args.push("click", "1");
    this.runXdotool(args);

    const location = this.currentMouseLocation();
    if (location && Math.hypot(location.x - target.x, location.y - target.y) > 12) {
      throw new Error(
        `X11 pointer endpoint mismatch: got ${location.x},${location.y}; wanted ${target.x},${target.y}`,
      );
    }
  }

  private runXdotool(args: string[]): string {
    return ensureCommand(this.runner("xdotool", args), "xdotool", args);
  }
}

class XTestHumanizedInteraction implements UIInteraction {
  readonly details: UIInteractionDetails;
  private readonly runner: CommandRunner;

  constructor(details: UIInteractionDetails, runner: CommandRunner) {
    this.details = details;
    this.runner = runner;
  }

  async click(locator: Locator): Promise<void> {
    await locator.scrollIntoViewIfNeeded().catch(() => {});
    const page = locator.page();
    await page.bringToFront();
    await page.waitForTimeout(120);
    const targets = await locatorClickTargets(locator, this.activeWindowGeometry());
    let lastError: unknown = null;
    for (const target of targets) {
      try {
        this.moveToAndClick(target.screen);
        return;
      } catch (err) {
        lastError = err;
        await page.waitForTimeout(120);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(String(lastError || "XTEST click failed"));
  }

  async fill(locator: Locator, text: string): Promise<void> {
    await this.click(locator);
    this.runXTest(["key", "ctrl+a"]);
    this.runXTest(["type", "--delay-ms", "35", text]);
  }

  async pressKey(page: Page, key: string): Promise<void> {
    await page.bringToFront();
    await page.waitForTimeout(80);
    this.runXTest(["key", key]);
  }

  private activeWindowGeometry(): ScreenGeometry | null {
    try {
      const output = ensureCommand(
        this.runner("xdotool", ["getactivewindow", "getwindowgeometry", "--shell"]),
        "xdotool",
        ["getactivewindow", "getwindowgeometry", "--shell"],
      );
      return parseXdotoolShellGeometry(output);
    } catch (err) {
      const searched = this.searchVisibleBrowserWindowGeometry();
      if (searched) {
        console.error(
          `[meeting-joiner] Active X11 window geometry unavailable, using visible browser window geometry: ${String(err)}`,
        );
        return searched;
      }
      console.error(
        `[meeting-joiner] X11 window geometry unavailable, using browser window metrics: ${String(err)}`,
      );
      return null;
    }
  }

  private searchVisibleBrowserWindowGeometry(): ScreenGeometry | null {
    for (const className of ["chromium", "chrome", "google-chrome"]) {
      const search = this.runner("xdotool", ["search", "--onlyvisible", "--class", className]);
      if (search.error || search.status !== 0) {
        continue;
      }

      const windowIDs = String(search.stdout || "")
        .split(/\s+/)
        .map((value) => value.trim())
        .filter(Boolean)
        .reverse();
      for (const windowID of windowIDs) {
        const geometry = this.runner("xdotool", ["getwindowgeometry", "--shell", windowID]);
        if (geometry.error || geometry.status !== 0) {
          continue;
        }
        const parsed = parseXdotoolShellGeometry(String(geometry.stdout || ""));
        if (parsed && parsed.width > 100 && parsed.height > 100) {
          return parsed;
        }
      }
    }
    return null;
  }

  private currentMouseLocation(): Point | null {
    const result = this.runner(xtestCommand(), ["position"]);
    if (result.status !== 0 || result.error) {
      return null;
    }
    return parseMouseLocation(String(result.stdout || ""));
  }

  private moveToAndClick(target: Point): void {
    const start = this.currentMouseLocation() || { x: target.x - 140, y: target.y + 80 };
    const points = generateHumanizedTrajectory(start, target);
    const args = ["move-click-rel", "--button", "1"];
    let previousRounded = { x: Math.round(start.x), y: Math.round(start.y) };

    for (let i = 1; i < points.length; i++) {
      const previous = points[i - 1];
      const point = points[i];
      const waitMs = Math.max(4, point.t - previous.t);
      const rounded = { x: Math.round(point.x), y: Math.round(point.y) };
      const dx = rounded.x - previousRounded.x;
      const dy = rounded.y - previousRounded.y;
      if (dx === 0 && dy === 0) {
        continue;
      }
      args.push("--delta", `${dx},${dy},${waitMs}`);
      previousRounded = rounded;
    }
    this.runXTest(args);

    const location = this.currentMouseLocation();
    if (location && Math.hypot(location.x - target.x, location.y - target.y) > 12) {
      throw new Error(
        `XTEST pointer endpoint mismatch: got ${location.x},${location.y}; wanted ${target.x},${target.y}`,
      );
    }
  }

  private runXTest(args: string[]): string {
    const command = xtestCommand();
    return ensureCommand(this.runner(command, args), command, args);
  }
}

export function createUIInteraction(
  details = resolveUIInteractionDetails(),
  runner: CommandRunner = defaultCommandRunner,
): UIInteraction {
  if (details.mode === "humanized") {
    if (process.platform === "darwin") {
      return new MacHumanizedInteraction(details, runner);
    }
    if (details.backend === "xtest") {
      return new XTestHumanizedInteraction(details, runner);
    }
    return new X11HumanizedInteraction(details, runner);
  }
  return new SyntheticInteraction(details);
}

export type MeetUIInteractionMode = UIInteractionMode;
export type MeetUIInteractionRequest = UIInteractionRequest;
export type MeetUIInteractionBackend = UIInteractionBackend;
export type MeetUIInteractionDetails = UIInteractionDetails;
export type MeetUIInteraction = UIInteraction;

function mapOneesamaMeetInputEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    MEET_UI_INTERACTION_MODE:
      env.MAB_MEET_UI_INTERACTION_MODE || env.MEET_UI_INTERACTION_MODE || "",
    MEET_JOIN_LANE: env.MAB_MEET_JOIN_LANE || env.MEET_JOIN_LANE || "",
    MEET_XTEST_INPUT_COMMAND:
      env.MAB_MEET_XTEST_INPUT_COMMAND || env.MEET_XTEST_INPUT_COMMAND || "",
  };
}

export function resolveMeetUIInteractionDetails(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  runner: CommandRunner = defaultCommandRunner,
): MeetUIInteractionDetails {
  return resolveUIInteractionDetails(mapOneesamaMeetInputEnv(env), platform, runner);
}

export function createMeetUIInteraction(
  diagnostics: Diagnostics | null = null,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  runner: CommandRunner = defaultCommandRunner,
): MeetUIInteraction {
  const details = resolveMeetUIInteractionDetails(env, platform, runner);
  diagnostics?.record("meet_ui_interaction_selected", details);
  return createUIInteraction(details, runner);
}
