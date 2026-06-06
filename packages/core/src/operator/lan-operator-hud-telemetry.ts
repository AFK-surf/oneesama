import type { DebugState } from "./lan-operator-debug-state.ts";

type HudLevel = "ok" | "active" | "warn" | "blocked" | "idle";

type HudSignal = {
  key: string;
  label: string;
  value: string;
  level: HudLevel;
  visibleWhenOk?: boolean;
};

function latestBlocker(debug: DebugState) {
  return debug.timeline.rows.findLast((row) => row.blocker) || null;
}

function connectionLevel(debug: DebugState): HudLevel {
  if (debug.conversation.status === "failed") return "blocked";
  if (debug.transport.events.state === "open" || debug.conversation.status === "connected") {
    return "ok";
  }
  if (debug.transport.events.state === "connecting") return "warn";
  return "idle";
}

function audioSignal(debug: DebugState): HudSignal {
  if (debug.voice.forwardFailures > 0) {
    return { key: "audio", label: "音频", value: "卡住", level: "blocked" };
  }
  if (debug.voice.chunksReceived > 0) {
    return { key: "audio", label: "音频", value: "有输入", level: "ok" };
  }
  if (debug.voice.armed) return { key: "audio", label: "音频", value: "待输入", level: "active" };
  return { key: "audio", label: "音频", value: "", level: "idle" };
}

function turnSignal(debug: DebugState): HudSignal {
  const latestTurn = debug.timeline.turns.at(-1);
  if (!latestTurn) return { key: "think", label: "回合", value: "空闲", level: "idle" };
  if (latestTurn.status === "blocked" || latestTurn.status === "failed") {
    return { key: "think", label: "回合", value: "卡住", level: "blocked" };
  }
  if (latestTurn.status === "active")
    return { key: "think", label: "回合", value: "进行中", level: "active" };
  return { key: "think", label: "回合", value: "已回应", level: "ok" };
}

function toolSignal(debug: DebugState): HudSignal {
  if (debug.kwwk.blocker || debug.kwwk.status === "blocked" || debug.kwwk.status === "failed") {
    return {
      key: "tool",
      label: "工具",
      value: debug.kwwk.blocker || "卡住",
      level: "blocked",
      visibleWhenOk: true,
    };
  }
  if (["queued", "observing", "planning", "executing", "verifying"].includes(debug.kwwk.status)) {
    return {
      key: "tool",
      label: "工具",
      value: debug.kwwk.status,
      level: "active",
      visibleWhenOk: true,
    };
  }
  if (debug.kwwk.status === "completed") {
    return { key: "tool", label: "工具", value: "完成", level: "ok", visibleWhenOk: true };
  }
  return { key: "tool", label: "工具", value: "空闲", level: "idle" };
}

function outputSignal(debug: DebugState): HudSignal {
  const audio = debug.output.assistantAudio;
  if (audio.status === "failed" || audio.status === "blocked") {
    return { key: "speak", label: "说", value: "卡住", level: "blocked" };
  }
  if (audio.status === "playing" || audio.chunksPlayed > 0) {
    return { key: "speak", label: "说", value: "播放", level: "active" };
  }
  return { key: "speak", label: "说", value: "", level: "idle" };
}

export function buildLanOperatorMeetHudTelemetry(debug: DebugState) {
  const blocker = latestBlocker(debug);
  const connection = connectionLevel(debug);
  return {
    schema: "oneesama.lan_operator_hud_telemetry.v1",
    source: "lan_operator_debug_state",
    primaryBlocker: blocker
      ? {
          layer: blocker.layer,
          event: blocker.event,
          blocker: blocker.blocker,
          turnId: blocker.turnId,
          responseId: blocker.responseId,
        }
      : null,
    signals: [
      {
        key: "rt",
        label: "连接",
        value: connection === "ok" ? "在线" : connection === "blocked" ? "卡住" : "",
        level: connection,
      },
      audioSignal(debug),
      turnSignal(debug),
      outputSignal(debug),
      toolSignal(debug),
      {
        key: "err",
        label: "错误",
        value: blocker ? "1" : "正常",
        level: blocker ? "blocked" : "ok",
      },
    ] satisfies HudSignal[],
  };
}
