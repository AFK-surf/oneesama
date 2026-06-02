export type KWWKCursorFeedbackKind =
  | "move"
  | "click"
  | "press"
  | "drag"
  | "target"
  | "blocked"
  | "done";

export type KWWKCursorFeedback = {
  x?: number;
  y?: number;
  kind?: KWWKCursorFeedbackKind;
  label?: string;
  holdMs?: number;
  at?: number;
};

export type KWWKCursorSnapshot = {
  visible: boolean;
  x: number;
  y: number;
  kind: KWWKCursorFeedbackKind;
  label: string;
  ageMs: number;
  holdMs: number;
};

type KWWKCursorEvent = {
  kind: string;
  x: number;
  y: number;
  label: string;
  at: number;
  coordinateSpaceId: string;
};

const DEFAULT_CURSOR_HOLD_MS = 1800;
const DEFAULT_CLICK_HOLD_MS = 2600;
const DEFAULT_DRAG_HOLD_MS = 3200;
const TRAIL_HOLD_MS = 2200;
const COORDINATE_SPACE_ID = "avatar_shared_surface_normalized";

let latestFeedback: Required<KWWKCursorFeedback> | null = null;
let cursorEvents: KWWKCursorEvent[] = [];

function boundedNumber(value: unknown, fallback: number, min: number, max: number) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.max(min, Math.min(max, numberValue));
}

function normalizeKind(value: unknown): KWWKCursorFeedbackKind {
  const text = String(value || "").trim();
  if (
    text === "click" ||
    text === "press" ||
    text === "drag" ||
    text === "target" ||
    text === "blocked" ||
    text === "done"
  ) {
    return text;
  }
  return "move";
}

function cursorEventKind(kind: KWWKCursorFeedbackKind) {
  if (kind === "click" || kind === "press") return "cursor.click";
  if (kind === "drag") return "cursor.drag";
  if (kind === "target") return "cursor.highlight";
  return "cursor.move";
}

export function updateKWWKCursorFeedback(input: KWWKCursorFeedback = {}) {
  const kind = normalizeKind(input.kind);
  const at = Number.isFinite(Number(input.at)) ? Number(input.at) : performance.now();
  latestFeedback = {
    x: boundedNumber(input.x, 0.5, 0, 1),
    y: boundedNumber(input.y, 0.52, 0, 1),
    kind,
    label: String(input.label || "")
      .trim()
      .slice(0, 48),
    holdMs: boundedNumber(
      input.holdMs,
      kind === "click" || kind === "press"
        ? DEFAULT_CLICK_HOLD_MS
        : kind === "drag"
          ? DEFAULT_DRAG_HOLD_MS
          : DEFAULT_CURSOR_HOLD_MS,
      250,
      8000,
    ),
    at,
  };
  cursorEvents.push({
    kind: cursorEventKind(kind),
    x: latestFeedback.x,
    y: latestFeedback.y,
    label: latestFeedback.label,
    at,
    coordinateSpaceId: COORDINATE_SPACE_ID,
  });
  cursorEvents = cursorEvents.slice(-40);
  return getKWWKCursorSnapshot();
}

export function getKWWKCursorSnapshot(): KWWKCursorSnapshot {
  const feedback = latestFeedback;
  if (!feedback) {
    return {
      visible: false,
      x: 0,
      y: 0,
      kind: "move",
      label: "",
      ageMs: Number.POSITIVE_INFINITY,
      holdMs: 0,
    };
  }
  const ageMs = Math.max(0, performance.now() - feedback.at);
  return {
    visible: ageMs <= feedback.holdMs,
    x: feedback.x,
    y: feedback.y,
    kind: feedback.kind,
    label: feedback.label,
    ageMs,
    holdMs: feedback.holdMs,
  };
}

function cursorColor(kind: KWWKCursorFeedbackKind) {
  if (kind === "blocked") return "#ff8a8a";
  if (kind === "done") return "#5ed99d";
  if (kind === "drag") return "#b8f26f";
  if (kind === "target") return "#c7b8ff";
  if (kind === "click" || kind === "press") return "#f4c45a";
  return "#9fe8ff";
}

function recentTrailPoints(now: number) {
  return cursorEvents
    .filter((event) => {
      return (
        now - event.at <= TRAIL_HOLD_MS &&
        (event.kind === "cursor.move" ||
          event.kind === "cursor.drag" ||
          event.kind === "cursor.click")
      );
    })
    .map((event) => ({ x: event.x, y: event.y, at: event.at, kind: event.kind }));
}

function drawDragTrail(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  points: ReturnType<typeof recentTrailPoints>,
) {
  if (points.length < 2) return;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (let i = 1; i < points.length; i += 1) {
    const from = points[i - 1];
    const to = points[i];
    const ageWeight = i / Math.max(1, points.length - 1);
    ctx.globalAlpha = 0.18 + ageWeight * 0.52;
    ctx.strokeStyle = to.kind === "cursor.drag" ? "#b8f26f" : "#9fe8ff";
    ctx.lineWidth = 5 + ageWeight * 3;
    ctx.beginPath();
    ctx.moveTo(Math.round(from.x * width), Math.round(from.y * height));
    ctx.lineTo(Math.round(to.x * width), Math.round(to.y * height));
    ctx.stroke();
  }
  ctx.restore();
}

export function drawKWWKCursorFeedback(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
) {
  const snapshot = getKWWKCursorSnapshot();
  if (!snapshot.visible) return;
  const now = performance.now();
  const color = cursorColor(snapshot.kind);
  const x = Math.round(snapshot.x * width);
  const y = Math.round(snapshot.y * height);
  const progress = Math.max(0, Math.min(1, snapshot.ageMs / Math.max(1, snapshot.holdMs)));
  const pulse = snapshot.kind === "click" || snapshot.kind === "press";
  const target = snapshot.kind === "target";
  const ring = pulse ? 18 + progress * 42 : 22;
  const alpha = pulse ? Math.max(0, 1 - progress) : 0.82;

  ctx.save();
  drawDragTrail(ctx, width, height, recentTrailPoints(now));
  ctx.shadowColor = "rgba(0, 0, 0, 0.42)";
  ctx.shadowBlur = 14;
  ctx.lineWidth = 3;
  ctx.strokeStyle = color;
  ctx.globalAlpha = alpha;
  if (target) ctx.setLineDash([10, 8]);
  ctx.beginPath();
  ctx.arc(x, y, target ? 38 + progress * 8 : ring, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;

  ctx.fillStyle = "rgba(255, 255, 255, 0.96)";
  ctx.strokeStyle = "rgba(12, 15, 24, 0.88)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + 22, y + 48);
  ctx.lineTo(x + 30, y + 28);
  ctx.lineTo(x + 51, y + 28);
  ctx.closePath();
  ctx.stroke();
  ctx.fill();

  if (snapshot.label) {
    const label = snapshot.label;
    const boxWidth = Math.min(260, Math.max(92, 34 + label.length * 9));
    const boxX = Math.min(width - boxWidth - 18, x + 34);
    const boxY = Math.max(18, y - 46);
    ctx.fillStyle = "rgba(13, 16, 25, 0.86)";
    ctx.strokeStyle = `${color}99`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(boxX, boxY, boxWidth, 32, 6);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "rgba(255, 255, 255, 0.94)";
    ctx.font = "800 14px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(label, boxX + 14, boxY + 17);
  }
  ctx.restore();
}

export function getKWWKCursorArtifact() {
  return {
    schema: "oneesama.kwwk-cursor-artifact.v1",
    coordinateSpaces: {
      [COORDINATE_SPACE_ID]: {
        id: COORDINATE_SPACE_ID,
        kind: "shared_surface_normalized",
        width: 1,
        height: 1,
        origin: "top_left",
      },
    },
    events: cursorEvents.slice(),
    trail: recentTrailPoints(performance.now()),
    styles: {
      persistentCursor: true,
      clickPulse: true,
      dragTrail: true,
      targetRing: true,
      pointerAsset: "inline-bridge-equivalent",
    },
    latest: getKWWKCursorSnapshot(),
  };
}

export function installKWWKCursorFeedbackGlobals() {
  (window as any).MAB_KWWK_CURSOR_FEEDBACK = updateKWWKCursorFeedback;
  (window as any).MAB_KWWK_CURSOR_SNAPSHOT = getKWWKCursorSnapshot;
  (window as any).MAB_KWWK_CURSOR_ARTIFACT = getKWWKCursorArtifact;
}
