export const LOCAL_OPERATOR_GATES = Object.freeze({
  voice: "local_voice",
  hostVisual: "local_host_visual",
  toolRouting: "local_tool_routing",
  kwwkAction: "local_kwwk_action",
  debugPanel: "local_debug_panel",
  sloSuite: "local_slo_suite",
  openaiLive: "local_openai_realtime_live",
  openaiVoiceLive: "local_openai_realtime_voice_live",
  openaiToolLive: "local_openai_realtime_tool_live",
});

export const LEGACY_LOCAL_OPERATOR_GATE_ALIASES = Object.freeze({
  lan_voice_loop: LOCAL_OPERATOR_GATES.voice,
  lan_host_visual_stream: LOCAL_OPERATOR_GATES.hostVisual,
  lan_tool_routing: LOCAL_OPERATOR_GATES.toolRouting,
  lan_kwwk_action: LOCAL_OPERATOR_GATES.kwwkAction,
  lan_debug_panel: LOCAL_OPERATOR_GATES.debugPanel,
  lan_openai_realtime_live: LOCAL_OPERATOR_GATES.openaiLive,
  lan_openai_realtime_voice_live: LOCAL_OPERATOR_GATES.openaiVoiceLive,
  lan_openai_realtime_tool_live: LOCAL_OPERATOR_GATES.openaiToolLive,
});

export function normalizeLocalOperatorGate(gate) {
  const value = String(gate || "");
  return LEGACY_LOCAL_OPERATOR_GATE_ALIASES[value] || value;
}
