type AvatarHudConfig = {
  canvasWidth: number;
  canvasHeight: number;
};

type AvatarStatus = {
  kind: string;
  text: string;
};

type AvatarController = {
  visibleStatus: () => AvatarStatus | null;
};

type HudRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type HudSignal = {
  key: string;
  label: string;
  value: string;
  level: "ok" | "active" | "warn" | "blocked" | "idle";
};

const STATUS_LABELS: Record<string, string> = {
  idle: "",
  thinking: "Thinking",
  writing_code: "Writing code",
  opening_preview: "App control",
  blocked: "Blocked",
  done: "Done",
};

const STATUS_COLORS: Record<string, { accent: string; bg: string }> = {
  idle: { accent: "#64748b", bg: "rgba(15, 23, 42, 0.78)" },
  thinking: { accent: "#38bdf8", bg: "rgba(15, 23, 42, 0.78)" },
  writing_code: { accent: "#a78bfa", bg: "rgba(24, 24, 27, 0.82)" },
  opening_preview: { accent: "#34d399", bg: "rgba(6, 78, 59, 0.82)" },
  blocked: { accent: "#fb7185", bg: "rgba(127, 29, 29, 0.84)" },
  done: { accent: "#4ade80", bg: "rgba(20, 83, 45, 0.82)" },
};

const SIGNAL_COLORS: Record<HudSignal["level"], { dot: string; bg: string; text: string }> = {
  ok: { dot: "#4ade80", bg: "rgba(20, 83, 45, 0.64)", text: "#dcfce7" },
  active: { dot: "#38bdf8", bg: "rgba(14, 116, 144, 0.58)", text: "#e0f2fe" },
  warn: { dot: "#fbbf24", bg: "rgba(120, 53, 15, 0.58)", text: "#fef3c7" },
  blocked: { dot: "#fb7185", bg: "rgba(127, 29, 29, 0.62)", text: "#ffe4e6" },
  idle: { dot: "#94a3b8", bg: "rgba(51, 65, 85, 0.58)", text: "#e2e8f0" },
};

function drawRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function bridgeState() {
  return (window as any).MAB_REALTIME_BRIDGE || {};
}

function bridgeFailureMatrix(bridge: any) {
  return bridge?.feedback?.failureMatrix || bridge?.failureMatrix || {};
}

function failureLevel(entry: any): HudSignal["level"] {
  if (!entry?.status) return "idle";
  if (entry.status === "blocked") return "blocked";
  if (entry.status === "waiting" || entry.status === "degraded") return "warn";
  if (entry.status === "healthy") return "ok";
  return "idle";
}

function latestErrorSummary(bridge: any) {
  const errors = Array.isArray(bridge?.errors) ? bridge.errors : [];
  const last = errors.at(-1);
  return String(last?.message || last?.reason || last?.type || "").trim();
}

function countAppControlJobs(bridge: any) {
  const jobs = Object.values(bridge?.turnPolicy?.appControlJobs || {}) as any[];
  return jobs.reduce(
    (acc, job) => {
      const status = String(job?.status || "").toLowerCase();
      if (status === "failed" || status === "timeout" || status === "blocked") acc.blocked += 1;
      else if (status === "accepted" || status === "running" || status === "queued")
        acc.active += 1;
      else if (status === "completed") acc.completed += 1;
      return acc;
    },
    { active: 0, blocked: 0, completed: 0 },
  );
}

function realtimeSignal(bridge: any, failures: any): HudSignal {
  const level = failureLevel(failures.realtimeConnection || failures.transport);
  if (level === "blocked" || level === "warn") {
    return { key: "rt", label: "RT", value: "block", level };
  }
  const connected =
    bridge?.connected === true ||
    bridge?.connection?.peerConnectionState === "connected" ||
    bridge?.connection?.dataChannelReadyState === "open";
  return connected
    ? { key: "rt", label: "RT", value: "on", level: "ok" }
    : { key: "rt", label: "RT", value: "wait", level: "warn" };
}

function audioSignal(bridge: any, failures: any): HudSignal {
  const level = failureLevel(failures.audioInput);
  if (level === "blocked" || level === "warn")
    return { key: "audio", label: "Audio", value: "check", level };
  const source = String(bridge?.connection?.currentRealtimeInputSource || "").trim();
  if (source.includes("recappi"))
    return { key: "audio", label: "Audio", value: "tap", level: "ok" };
  if (source.includes("meet_audio_mix"))
    return { key: "audio", label: "Audio", value: "meet", level: "ok" };
  return {
    key: "audio",
    label: "Audio",
    value: source ? "on" : "wait",
    level: source ? "ok" : "warn",
  };
}

function voiceSignal(bridge: any, failures: any): HudSignal {
  const level = failureLevel(failures.audioOutput || failures.modelTurn);
  if (level === "blocked" || level === "warn")
    return { key: "voice", label: "Voice", value: "check", level };
  if (bridge?.protection?.outputAudioActive === true) {
    return { key: "voice", label: "Voice", value: "talk", level: "active" };
  }
  const events = Number(bridge?.connection?.responseEvents || bridge?.responseEvents || 0);
  return events > 0
    ? { key: "voice", label: "Voice", value: "ready", level: "ok" }
    : { key: "voice", label: "Voice", value: "idle", level: "idle" };
}

function toolSignal(bridge: any, failures: any): HudSignal {
  const jobs = countAppControlJobs(bridge);
  const level = failureLevel(failures.toolTurns);
  if (jobs.blocked > 0 || level === "blocked") {
    return { key: "tool", label: "Tool", value: "block", level: "blocked" };
  }
  if (jobs.active > 0)
    return { key: "tool", label: "Tool", value: `${jobs.active} run`, level: "active" };
  if (jobs.completed > 0) return { key: "tool", label: "Tool", value: "done", level: "ok" };
  return { key: "tool", label: "Tool", value: "idle", level: "idle" };
}

function errorSignal(bridge: any, failures: any): HudSignal {
  const blockers = Object.values(failures).filter(
    (entry: any) => entry?.status === "blocked",
  ).length;
  if (blockers > 0) return { key: "err", label: "Err", value: `${blockers}`, level: "blocked" };
  const errors = Array.isArray(bridge?.errors) ? bridge.errors.length : 0;
  if (errors > 0) return { key: "err", label: "Err", value: "seen", level: "warn" };
  return { key: "err", label: "Err", value: "ok", level: "ok" };
}

function collectSignals(): HudSignal[] {
  const bridge = bridgeState();
  const failures = bridgeFailureMatrix(bridge);
  return [
    realtimeSignal(bridge, failures),
    audioSignal(bridge, failures),
    voiceSignal(bridge, failures),
    toolSignal(bridge, failures),
    errorSignal(bridge, failures),
  ];
}

function shouldDrawHud(status: AvatarStatus | null, signals: HudSignal[]) {
  return Boolean(
    status ||
    (window as any).MAB_REALTIME_BRIDGE ||
    signals.some(
      (signal) =>
        signal.level === "blocked" || signal.level === "warn" || signal.level === "active",
    ),
  );
}

function trimHudText(value: string, max = 72) {
  const normalized = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

function drawChip(
  ctx: CanvasRenderingContext2D,
  signal: HudSignal,
  x: number,
  y: number,
  width: number,
) {
  const colors = SIGNAL_COLORS[signal.level];
  drawRoundRect(ctx, x, y, width, 34, 17);
  ctx.fillStyle = colors.bg;
  ctx.fill();
  ctx.fillStyle = colors.dot;
  ctx.beginPath();
  ctx.arc(x + 18, y + 17, 5.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = colors.text;
  ctx.font = "700 15px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(signal.label, x + 31, y + 22);
  ctx.fillStyle = "rgba(255, 255, 255, 0.72)";
  ctx.font = "700 13px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.textAlign = "right";
  ctx.fillText(signal.value, x + width - 12, y + 22);
}

export function createAvatarHud(options: {
  config: AvatarHudConfig;
  avatarController: AvatarController;
}) {
  const { config, avatarController } = options;

  function rect(): HudRect {
    const { canvasWidth: w, canvasHeight: h } = config;
    const width = Math.min(820, w * 0.64);
    const height = 142;
    return { x: (w - width) / 2, y: Math.min(h - height - 52, h * 0.66), width, height };
  }

  function draw(ctx: CanvasRenderingContext2D) {
    const status = avatarController.visibleStatus();
    const signals = collectSignals();
    if (!shouldDrawHud(status, signals)) return;

    const { x, y, width, height } = rect();
    const statusKind = status?.kind || "idle";
    const colors = STATUS_COLORS[statusKind] || STATUS_COLORS.thinking;
    const label = status ? STATUS_LABELS[statusKind] || "Working" : "Realtime";
    const errorSummary = trimHudText(latestErrorSummary(bridgeState()), 52);
    const text = trimHudText(status?.text || errorSummary || "waiting for meeting signal", 78);
    const chipWidth = (width - 84) / 5;

    ctx.save();
    ctx.shadowColor = "rgba(15, 23, 42, 0.30)";
    ctx.shadowBlur = 24;
    ctx.shadowOffsetY = 8;
    ctx.fillStyle = colors.bg;
    drawRoundRect(ctx, x, y, width, height, 28);
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.fillStyle = colors.accent;
    drawRoundRect(ctx, x + 22, y + 24, 16, 70, 8);
    ctx.fill();
    ctx.fillStyle = "rgba(255, 255, 255, 0.78)";
    ctx.font = "700 22px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(label, x + 56, y + 39);
    ctx.fillStyle = "#ffffff";
    ctx.font = "800 34px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.fillText(text, x + 56, y + 82, width - 86);
    signals.forEach((signal, index) => {
      drawChip(ctx, signal, x + 22 + index * (chipWidth + 10), y + 102, chipWidth);
    });
    ctx.restore();
  }

  (window as any).MAB_AVATAR_HUD_SIGNALS = collectSignals;

  return { rect, draw };
}
