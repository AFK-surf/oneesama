/* eslint-disable no-unused-vars */
const {
  extractLocalToolCall,
  runLocalAvatarTool,
  updateAvatarHudStatus,
  updateKWWKCursorFeedback,
  latestKWWKCursorFeedbackPoint,
  rememberKWWKActionTelemetry,
  postJson,
  localServiceUrl,
  runLocalWorkerTool,
  runLocalWorkspaceTool,
} = (window as any).__MAB_REALTIME_LOCAL_TOOL_HELPERS.create({
  config,
  state,
  localWorkspaceTools,
  isLocalToolName,
  recordTimeline,
  rememberAvatarToolError,
});
const {
  sendMeetChat,
  readMeetChat: _readMeetChat,
  installMeetChatObserver,
  runLocalMeetTool,
} = (window as any).__MAB_REALTIME_MEET_CHAT_HELPERS.create({
  config,
  state,
  observedMeetChatKeys,
  postJson,
  localServiceUrl,
  recordTimeline,
  sendRealtimeEvent,
  updateFeedback,
});

const meetingEventHelpers = (window as any).__MAB_REALTIME_MEETING_EVENT_HELPERS.create({
  config,
  state,
  recordTimeline,
});

const {
  deliverFunctionToolResult,
  deliverFunctionToolError,
  prepareFunctionToolResult,
  prepareFunctionToolError,
  deliverWorkerResult,
  rememberSuppressedWorkerResult,
  shouldDeliverWorkerResult,
} = (window as any).__MAB_REALTIME_TURN_POLICY_HELPERS.create({
  config,
  state,
  sendRealtimeEvent,
  sendMeetChat,
  recordTimeline,
  buildWorkerResultChatText,
  shouldSendWorkerResultToMeetChat,
  shouldVoiceAckWorkerResult,
  buildWorkerResultVoiceText,
  buildWorkerResultText,
  meetingEvents: meetingEventHelpers,
});

function currentRealtimeToolNames(): string[] {
  const activeSessionNames = Array.isArray(state.session?.toolNames)
    ? state.session.toolNames.map((name) => String(name || "")).filter(Boolean)
    : [];
  if (state.session?.configured === true) return activeSessionNames;
  if (activeSessionNames.length > 0) return activeSessionNames;
  return normalizeToolNames(Array.isArray(config.tools) ? config.tools : []);
}

function isLocalToolExposed(name: string): boolean {
  return currentRealtimeToolNames().includes(name);
}

const { runLocalToolForSDK, handleLocalToolCallEvent } = (
  window as any
).__MAB_REALTIME_LOCAL_TOOL_ROUTER_HELPERS.create({
  state,
  handledLocalToolCallIds,
  extractLocalToolCall,
  runLocalAvatarTool,
  runLocalWorkerTool,
  runLocalMeetTool,
  runLocalWorkspaceTool,
  isLocalToolExposed,
  deliverFunctionToolResult,
  deliverFunctionToolError,
  prepareFunctionToolResult,
  prepareFunctionToolError,
  rememberAvatarToolCall,
  rememberAvatarToolError,
  rememberWorkerToolCall,
  rememberWorkerToolError,
  rememberMeetToolCall,
  rememberMeetToolError,
  rememberWorkspaceToolCall,
  rememberWorkspaceToolError,
  recordTimeline,
  updateFeedback,
});

const {
  createMockDataChannel,
  routeRemoteAudioStream,
  routeSidecarPcmFrames,
  injectMockRemoteAudio,
} = (window as any).__MAB_REALTIME_AUDIO_OUTPUT_HELPERS.create({
  state,
  rememberError,
  recordTimeline,
  updateFeedback,
});
