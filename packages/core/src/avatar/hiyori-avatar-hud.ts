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

type HudCell = {
  key: string;
  label: string;
  value: string;
  level: HudSignal["level"];
  color: string;
  pulse: boolean;
};

const CELL_COLORS: Record<string, string> = {
  rt: "#5ed99d",
  audio: "#6fbef0",
  voice: "#c39fff",
  tool: "#f4c45a",
  err: "#ff8a8a",
  done: "#5ed99d",
  status: "#d7ddff",
};

const SIGNAL_LABELS: Record<string, string> = {
  rt: "RT",
  audio: "Audio",
  voice: "Voice",
  tool: "Tool",
  err: "Err",
};

const CELL_PRIORITY: Record<string, number> = {
  err: 0,
  tool: 1,
  voice: 2,
  audio: 3,
  rt: 4,
  done: 5,
  status: 6,
};

function drawSegmentRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  first: boolean,
  last: boolean,
) {
  const radius = 4;
  const tl = first ? radius : 0;
  const tr = last ? radius : 0;
  const br = last ? radius : 0;
  const bl = first ? radius : 0;
  ctx.beginPath();
  ctx.moveTo(x + tl, y);
  ctx.lineTo(x + width - tr, y);
  if (tr > 0) ctx.quadraticCurveTo(x + width, y, x + width, y + tr);
  else ctx.lineTo(x + width, y);
  ctx.lineTo(x + width, y + height - br);
  if (br > 0) ctx.quadraticCurveTo(x + width, y + height, x + width - br, y + height);
  else ctx.lineTo(x + width, y + height);
  ctx.lineTo(x + bl, y + height);
  if (bl > 0) ctx.quadraticCurveTo(x, y + height, x, y + height - bl);
  else ctx.lineTo(x, y + height);
  ctx.lineTo(x, y + tl);
  if (tl > 0) ctx.quadraticCurveTo(x, y, x + tl, y);
  else ctx.lineTo(x, y);
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
  return visibleCells(status, signals).length > 0;
}

function trimHudText(value: string, max = 72) {
  const normalized = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

function statusCell(status: AvatarStatus | null): HudCell | null {
  if (!status || status.kind === "idle") return null;
  const text = trimHudText(status.text, 24);
  if (!text) return null;
  if (status.kind === "thinking") {
    if (text === "等待输入" || /listening/i.test(text)) {
      return {
        key: "audio",
        label: "Listening",
        value: "",
        level: "active",
        color: CELL_COLORS.audio,
        pulse: true,
      };
    }
    return {
      key: "voice",
      label: "Thinking",
      value: "",
      level: "active",
      color: CELL_COLORS.voice,
      pulse: true,
    };
  }
  if (status.kind === "opening_preview") {
    return {
      key: "tool",
      label: "Tool",
      value: "",
      level: "active",
      color: CELL_COLORS.tool,
      pulse: true,
    };
  }
  if (status.kind === "blocked") {
    return {
      key: "err",
      label: "Blocked",
      value: "",
      level: "blocked",
      color: CELL_COLORS.err,
      pulse: true,
    };
  }
  if (status.kind === "done") {
    if (/说话|speaking|talk/i.test(text)) {
      return {
        key: "voice",
        label: "Voice",
        value: "",
        level: "active",
        color: CELL_COLORS.voice,
        pulse: true,
      };
    }
    return {
      key: "done",
      label: "Done",
      value: "",
      level: "ok",
      color: CELL_COLORS.done,
      pulse: false,
    };
  }
  if (status.kind === "writing_code") {
    return {
      key: "tool",
      label: "Working",
      value: "",
      level: "active",
      color: CELL_COLORS.tool,
      pulse: true,
    };
  }
  return {
    key: "status",
    label: text,
    value: "",
    level: "active",
    color: CELL_COLORS.status,
    pulse: true,
  };
}

function signalCell(signal: HudSignal): HudCell | null {
  if (signal.level === "idle" || signal.level === "ok") return null;
  const label = SIGNAL_LABELS[signal.key] || signal.label;
  return {
    key: signal.key,
    label,
    value: signal.value,
    level: signal.level,
    color: CELL_COLORS[signal.key] || CELL_COLORS.status,
    pulse: true,
  };
}

function cellText(cell: HudCell) {
  return [cell.label, cell.value].filter(Boolean).join(" ");
}

function cellWidth(cell: HudCell) {
  return Math.max(116, Math.min(240, 46 + cellText(cell).length * 10));
}

function visibleCells(status: AvatarStatus | null, signals: HudSignal[]) {
  const cells: HudCell[] = [];
  const primary = statusCell(status);
  if (primary) cells.push(primary);
  signals
    .map((signal) => signalCell(signal))
    .filter((cell): cell is HudCell => Boolean(cell))
    .toSorted((left, right) => (CELL_PRIORITY[left.key] ?? 99) - (CELL_PRIORITY[right.key] ?? 99))
    .forEach((next) => {
      if (cells.some((cell) => cell.key === next.key)) return;
      cells.push(next);
    });
  return cells.slice(0, 3);
}

function drawCell(
  ctx: CanvasRenderingContext2D,
  cell: HudCell,
  x: number,
  y: number,
  width: number,
  first: boolean,
  last: boolean,
) {
  const height = 46;
  drawSegmentRect(ctx, x, y, width, height, first, last);
  ctx.fillStyle = "rgba(13, 16, 25, 0.82)";
  ctx.fill();
  const gradient = ctx.createLinearGradient(0, y, 0, y + height);
  gradient.addColorStop(0, `${cell.color}33`);
  gradient.addColorStop(1, `${cell.color}14`);
  ctx.fillStyle = gradient;
  ctx.fill();
  ctx.strokeStyle =
    cell.level === "blocked" || cell.level === "warn"
      ? `${cell.color}aa`
      : "rgba(255, 255, 255, 0.18)";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  const pulse = cell.pulse ? 0.58 + Math.sin(performance.now() / 260) * 0.32 : 0.96;
  ctx.globalAlpha = Math.max(0.38, pulse);
  ctx.fillStyle = cell.color;
  ctx.beginPath();
  ctx.arc(x + 21, y + 23, 5.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
  ctx.font = "800 15px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillText(cellText(cell).toUpperCase(), x + 38, y + 23);
  ctx.textBaseline = "alphabetic";
}

export function createAvatarHud(options: {
  config: AvatarHudConfig;
  avatarController: AvatarController;
}) {
  const { config, avatarController } = options;

  function rect(): HudRect {
    const status = avatarController.visibleStatus();
    const signals = collectSignals();
    const cells = visibleCells(status, signals);
    const { canvasWidth: w, canvasHeight: h } = config;
    const gap = 5;
    const width = Math.max(
      1,
      cells.reduce((sum, cell) => sum + cellWidth(cell), 0) + Math.max(0, cells.length - 1) * gap,
    );
    const height = cells.length > 0 ? 46 : 1;
    return { x: (w - width) / 2, y: Math.round(h * 0.66), width, height };
  }

  function draw(ctx: CanvasRenderingContext2D) {
    const status = avatarController.visibleStatus();
    const signals = collectSignals();
    if (!shouldDrawHud(status, signals)) return;

    const cells = visibleCells(status, signals);
    const { x, y } = rect();
    const gap = 5;

    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.34)";
    ctx.shadowBlur = 14;
    ctx.shadowOffsetY = 6;
    let cellX = x;
    cells.forEach((cell, index) => {
      const width = cellWidth(cell);
      drawCell(ctx, cell, cellX, y, width, index === 0, index === cells.length - 1);
      cellX += width + gap;
    });
    ctx.restore();
  }

  (window as any).MAB_AVATAR_HUD_SIGNALS = collectSignals;

  return { rect, draw };
}
