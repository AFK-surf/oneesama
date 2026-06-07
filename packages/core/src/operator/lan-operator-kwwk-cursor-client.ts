// Cueboard-standard KWWK cursor renderer for the Local Operator stage.
//
// This is a faithful port of the shared-surface renderer in
// packages/core/src/avatar/hiyori-avatar-cursor-feedback.ts (the "Cueboard
// standard": persistent foreground arrow + colored ring + click pulse + target
// ring + drag trail + label box). The operator previously drew a flat yellow
// crosshair (drawOverlays); this replaces it with the real Cueboard renderer so
// the operator stage has cursor parity with rendered-pixel proof.
//
// Coordinates fed via update()/draw() are canvas-normalized [0,1] over the full
// composition canvas (the operator maps source-relative overlay coords into
// canvas-normalized before feeding this module).
export function buildLanOperatorKwwkCursorClientScript() {
  return `(() => {
  var DEFAULT_CURSOR_HOLD_MS = 1800;
  var DEFAULT_CLICK_HOLD_MS = 2600;
  var DEFAULT_DRAG_HOLD_MS = 3200;
  var TRAIL_HOLD_MS = 2200;
  var COORDINATE_SPACE_ID = "operator_shared_surface_normalized";

  var latestFeedback = null;
  var cursorEvents = [];

  function boundedNumber(value, fallback, min, max) {
    var n = Number(value);
    if (!isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }
  function normalizeKind(value) {
    var t = String(value || "").trim();
    if (t === "click" || t === "press" || t === "drag" || t === "target" || t === "blocked" || t === "done") return t;
    return "move";
  }
  function cursorEventKind(kind) {
    if (kind === "click" || kind === "press") return "cursor.click";
    if (kind === "drag") return "cursor.drag";
    if (kind === "target") return "cursor.highlight";
    return "cursor.move";
  }
  function update(input) {
    input = input || {};
    var kind = normalizeKind(input.kind);
    var at = isFinite(Number(input.at)) ? Number(input.at) : performance.now();
    latestFeedback = {
      x: boundedNumber(input.x, 0.5, 0, 1),
      y: boundedNumber(input.y, 0.52, 0, 1),
      kind: kind,
      label: String(input.label || "").trim().slice(0, 48),
      holdMs: boundedNumber(
        input.holdMs,
        kind === "click" || kind === "press" ? DEFAULT_CLICK_HOLD_MS : kind === "drag" ? DEFAULT_DRAG_HOLD_MS : DEFAULT_CURSOR_HOLD_MS,
        250,
        8000,
      ),
      at: at,
    };
    cursorEvents.push({
      kind: cursorEventKind(kind),
      x: latestFeedback.x,
      y: latestFeedback.y,
      label: latestFeedback.label,
      at: at,
      coordinateSpaceId: COORDINATE_SPACE_ID,
    });
    cursorEvents = cursorEvents.slice(-40);
    return snapshot();
  }
  function snapshot() {
    var f = latestFeedback;
    if (!f) return { visible: false, x: 0, y: 0, kind: "move", label: "", ageMs: Infinity, holdMs: 0 };
    var ageMs = Math.max(0, performance.now() - f.at);
    return { visible: ageMs <= f.holdMs, x: f.x, y: f.y, kind: f.kind, label: f.label, ageMs: ageMs, holdMs: f.holdMs };
  }
  function cursorColor(kind) {
    if (kind === "blocked") return "#ff8a8a";
    if (kind === "done") return "#5ed99d";
    if (kind === "drag") return "#b8f26f";
    if (kind === "target") return "#c7b8ff";
    if (kind === "click" || kind === "press") return "#f4c45a";
    return "#9fe8ff";
  }
  function recentTrailPoints(now) {
    return cursorEvents
      .filter(function (e) {
        return now - e.at <= TRAIL_HOLD_MS && (e.kind === "cursor.move" || e.kind === "cursor.drag" || e.kind === "cursor.click");
      })
      .map(function (e) { return { x: e.x, y: e.y, at: e.at, kind: e.kind }; });
  }
  function drawDragTrail(ctx, width, height, points) {
    if (points.length < 2) return;
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (var i = 1; i < points.length; i += 1) {
      var from = points[i - 1];
      var to = points[i];
      var ageWeight = i / Math.max(1, points.length - 1);
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
  function draw(ctx, width, height) {
    var snap = snapshot();
    if (!snap.visible) return false;
    var now = performance.now();
    var color = cursorColor(snap.kind);
    var x = Math.round(snap.x * width);
    var y = Math.round(snap.y * height);
    var progress = Math.max(0, Math.min(1, snap.ageMs / Math.max(1, snap.holdMs)));
    var pulse = snap.kind === "click" || snap.kind === "press";
    var target = snap.kind === "target";
    var ring = pulse ? 18 + progress * 42 : 22;
    var alpha = pulse ? Math.max(0, 1 - progress) : 0.82;

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

    if (snap.label) {
      var label = snap.label;
      var boxWidth = Math.min(260, Math.max(92, 34 + label.length * 9));
      var boxX = Math.min(width - boxWidth - 18, x + 34);
      var boxY = Math.max(18, y - 46);
      ctx.fillStyle = "rgba(13, 16, 25, 0.86)";
      ctx.strokeStyle = color + "99";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(boxX, boxY, boxWidth, 32, 6);
      else ctx.rect(boxX, boxY, boxWidth, 32);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "rgba(255, 255, 255, 0.94)";
      ctx.font = "800 14px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(label, boxX + 14, boxY + 17);
    }
    ctx.restore();
    return true;
  }
  function artifact() {
    return {
      schema: "oneesama.kwwk-cursor-artifact.v1",
      coordinateSpaces: {
        operator_shared_surface_normalized: {
          id: COORDINATE_SPACE_ID,
          kind: "shared_surface_normalized",
          width: 1,
          height: 1,
          origin: "top_left",
        },
      },
      events: cursorEvents.slice(),
      trail: recentTrailPoints(performance.now()),
      styles: { persistentCursor: true, clickPulse: true, dragTrail: true, targetRing: true, pointerAsset: "inline-cueboard-equivalent" },
      latest: snapshot(),
    };
  }
  function reset() {
    latestFeedback = null;
    cursorEvents = [];
  }

  window.MAB_LAN_OPERATOR_KWWK_CURSOR = { update: update, snapshot: snapshot, draw: draw, artifact: artifact, reset: reset };
})();`;
}
