/* eslint-disable no-unused-vars */
const {
  rememberAvatarToolCall,
  rememberAvatarToolError,
  rememberWorkerToolCall,
  rememberWorkerToolError,
  rememberMeetToolCall,
  rememberMeetToolError,
  rememberWorkspaceToolCall,
  rememberWorkspaceToolError,
} = (window as any).__MAB_REALTIME_LOCAL_TOOL_ROUTER_HELPERS.createToolState(state);
function realtimeItemMetadata(event) {
  const item = event?.item || event?.message || {};
  return {
    ...(typeof event?.metadata === "object" && event.metadata ? event.metadata : {}),
    ...(typeof item?.metadata === "object" && item.metadata ? item.metadata : {}),
  };
}

function realtimeEventSource(event) {
  const metadata = realtimeItemMetadata(event);
  return String(metadata.source || event?.__mabSource || event?.source || "").trim();
}

function isUserInputTextItem(event) {
  if (event?.type !== "conversation.item.create") return false;
  const item = event.item || event.message || {};
  if (item.role !== "user") return false;
  return (item.content || []).some((part) => part?.type === "input_text" && part?.text);
}

function shouldAllowUserInputTextEvent(event) {
  if (!isUserInputTextItem(event)) return { ok: true, source: "" };
  const source = realtimeEventSource(event);
  // Captions are intentionally absent here: ASR/Realtime speech turns must come
  // from Meet audio, not from a caption fallback that can drift or echo.
  const allowed = new Set(["manual_text_turn", "meet_chat_observer"]);
  return { ok: allowed.has(source), source };
}

function sanitizeRealtimeEventForWire(event) {
  const cloned = JSON.parse(JSON.stringify(event || {}));
  delete cloned.metadata;
  delete cloned.__mabSource;
  for (const key of ["item", "message", "image"]) {
    if (cloned[key] && typeof cloned[key] === "object") {
      delete cloned[key].metadata;
      delete cloned[key].__mabSource;
    }
  }
  return cloned;
}

function isRealtimeAgentSDKTransportDisconnectedError(error) {
  const message = String((error && error.message) || error || "");
  return /data channel.*not connected|not connected.*data channel|call `?connect\(\)`?/i.test(
    message,
  );
}

function handleRealtimeAgentSDKSendError(error, eventType = "") {
  const message = String((error && error.message) || error || "").slice(0, 600);
  if (!isRealtimeAgentSDKTransportDisconnectedError(error)) {
    rememberError(error);
    throw error;
  }
  Object.assign(state.connection as Record<string, unknown>, {
    lastRealtimeAgentSDKSendErrorAt: new Date().toISOString(),
    lastRealtimeAgentSDKSendError: message,
  });
  markRealtimeAgentSDKTransportDisconnected("agents_sdk_send_not_connected", {
    eventType,
    error: message,
    peerConnectionState: state.connection.peerConnectionState || "agents-sdk-send-failed",
  });
  return "agents-sdk-transport-not-connected";
}

function sendRealtimeEvent(event) {
  const textGuard = shouldAllowUserInputTextEvent(event);
  if (!textGuard.ok) {
    state.connection.blockedUserTextEvents = (state.connection.blockedUserTextEvents || 0) + 1;
    recordTimeline("realtime_user_text_blocked", {
      source: textGuard.source || "missing",
      type: event?.type || "",
    });
    updateFeedback();
    return "blocked-untrusted-user-text";
  }
  const stamped = {
    ...event,
    event_id: event.event_id || `evt_${randomEventId()}`,
  };
  state.outbound.push({ ts: new Date().toISOString(), event: stamped });
  state.outbound = state.outbound.slice(-100);
  state.connection.lastOutboundEventAt = new Date().toISOString();
  state.connection.lastOutboundEventType = stamped.type || "";
  recordTimeline("realtime_outbound", summarizeRealtimeEvent(stamped));
  updateFeedback();
  const wireEvent = sanitizeRealtimeEventForWire(stamped);

  if (state.agentRuntime.active === "agents-sdk" && activeRealtimeAgentTransport?.sendEvent) {
    try {
      if (stamped.type === "response.cancel" && activeRealtimeAgentSession?.interrupt) {
        activeRealtimeAgentSession.interrupt();
      } else {
        activeRealtimeAgentTransport.sendEvent(wireEvent);
      }
    } catch (error) {
      return handleRealtimeAgentSDKSendError(error, stamped.type || "");
    }
    state.connection.sentDataChannelMessages.push({
      ts: new Date().toISOString(),
      payload: JSON.stringify(wireEvent),
      runtime: "agents-sdk",
    });
    state.connection.sentDataChannelMessages = state.connection.sentDataChannelMessages.slice(-100);
    return "agents-sdk-transport";
  }

  const dataChannel = window.MAB_REALTIME_DATA_CHANNEL || window.MAB_REALTIME_DC;
  if (dataChannel?.readyState === "open" && typeof dataChannel.send === "function") {
    if (
      state.connection.peerConnectionState === "failed" ||
      state.connection.peerConnectionState === "closed"
    ) {
      scheduleRealtimeReconnect(`send_${state.connection.peerConnectionState}`, 0);
    }
    dataChannel.send(JSON.stringify(wireEvent));
    return "data-channel";
  }

  if (state.connection.mode !== "mock" && state.connection.mode !== "webrtc-mock") {
    scheduleRealtimeReconnect("send_without_open_data_channel", 0);
  }
  if (
    shouldUseRealtimeAgentSDK() &&
    state.connection.mode !== "mock" &&
    state.connection.mode !== "webrtc-mock"
  ) {
    markRealtimeAgentSDKTransportDisconnected("agents_sdk_send_not_connected", {
      eventType: stamped.type || "",
      peerConnectionState: state.connection.peerConnectionState || "agents-sdk-not-connected",
    });
    return "agents-sdk-transport-not-connected";
  }
  window.dispatchEvent(new CustomEvent("meeting-avatar-realtime-event", { detail: wireEvent }));
  return "custom-event";
}

function requestRealtimeTextTurn(payload = {}) {
  const request = payload as Record<string, any>;
  const text = String(request.text || "").trim();
  if (!text) return { ok: false, error: "text_required" };
  const instructions = String(request.instructions || "").trim();
  const toolChoice = preferredToolChoiceForTextTurn(text);
  const forcedInstructions = forcedToolInstructionsForTextTurn(text, toolChoice);
  const directToolRouting = Boolean(
    config.directTextTurnToolRouting &&
    toolChoice?.name &&
    shouldDirectRouteTextTurnTool(toolChoice.name),
  );
  const itemEvent = {
    type: "conversation.item.create",
    event_id: `evt_${randomEventId()}`,
    item: {
      type: "message",
      role: "user",
      metadata: { source: "manual_text_turn" },
      content: [{ type: "input_text", text }],
    },
  };
  const itemChannel = sendRealtimeEvent(itemEvent);
  const responseInstructions = [forcedInstructions, instructions].filter(Boolean).join("\n\n");
  const response = responseInstructions ? { instructions: responseInstructions } : {};
  if (toolChoice) {
    (response as Record<string, any>).tool_choice = toolChoice;
  }
  let responseChannel = directToolRouting ? "direct-tool-routing" : "";
  if (!directToolRouting) {
    const responseEvent = {
      type: "response.create",
      event_id: `evt_${randomEventId()}`,
      response,
    };
    responseChannel = sendRealtimeEvent(responseEvent);
  }
  const manualFunctionalTurn = recordManualFunctionalTextTurn(text, {
    eventId: itemEvent.event_id,
    channel: responseChannel,
    hasInstructions: Boolean(instructions),
  });
  if (directToolRouting && toolChoice?.name) {
    queueDirectTextTurnTool(toolChoice.name, text);
  }
  recordTimeline("realtime_text_turn_requested", {
    channel: responseChannel,
    itemChannel,
    chars: text.length,
    hasInstructions: Boolean(instructions),
    directToolRouting,
    toolChoice: toolChoice?.name || "",
  });
  return {
    ok:
      itemChannel !== "blocked-untrusted-user-text" &&
      responseChannel !== "blocked-untrusted-user-text" &&
      itemChannel !== "agents-sdk-transport-not-connected" &&
      responseChannel !== "agents-sdk-transport-not-connected",
    error:
      itemChannel === "agents-sdk-transport-not-connected" ||
      responseChannel === "agents-sdk-transport-not-connected"
        ? "realtime_transport_not_connected"
        : undefined,
    channel: responseChannel,
    item: { ok: itemChannel !== "blocked-untrusted-user-text", channel: itemChannel },
    response: { ok: responseChannel !== "blocked-untrusted-user-text", channel: responseChannel },
    directToolRouting,
    toolChoice: toolChoice?.name || "",
    manualFunctionalTurn,
    feedback: state.feedback || null,
    realtimeBridge: state,
  };
}

function preferredToolChoiceForTextTurn(text: string) {
  const value = String(text || "");
  const statusIntent =
    /(进度|状态|做完|完成|结果|到哪|怎么样|status|progress|done|result)/i.test(value) &&
    /(codex|后台|任务|那个活|活儿|job|worker)/i.test(value);
  if (statusIntent && hasConfiguredRealtimeTool("worker_status")) {
    return { type: "function", name: "worker_status" };
  }

  const externalLookupIntent =
    /(github|gh|repo|仓库|issue|pr)/i.test(value) &&
    /(搜|搜索|查|找|lookup|search|find)/i.test(value);
  if (externalLookupIntent && hasConfiguredRealtimeTool("delegate_to_worker")) {
    return { type: "function", name: "delegate_to_worker" };
  }

  const backgroundJobIntent =
    (/(后台|codex|写脚本|脚本|调研|报告|处理.*文件|跑.*测试|查代码|改.*repo|研究|research|script|debug|investigate)/i.test(
      value,
    ) ||
      (/(实现|开发|做一个|做个|搭建|写一个|写个|build|implement|create|make)/i.test(value) &&
        /(web|网页|网站|应用|app|游戏|game|五子棋|gomoku|同步|sync|多人|multi)/i.test(value)) ||
      /(五子棋|gomoku)/i.test(value)) &&
    !statusIntent;
  if (backgroundJobIntent && hasConfiguredRealtimeTool("delegate_to_worker")) {
    return { type: "function", name: "delegate_to_worker" };
  }

  if (config.directTextTurnToolRouting) {
    const stopShareIntent =
      /(停止|停掉|结束|取消|stop|end|cancel)/i.test(value) &&
      /(共享|分享|屏幕|窗口|share|present|screen|stage)/i.test(value);
    if (stopShareIntent && hasConfiguredRealtimeTool("stop_video_stage")) {
      return { type: "function", name: "stop_video_stage" };
    }

    const complexAppControlIntent =
      /(共享|shared|窗口|window|app|应用|浏览器|browser|chrome|safari|pencil|文档|document|roadmap|页面|page|界面|ui)/i.test(
        value,
      ) &&
      /(重新设计|重做|改版|重构|重写|整理|优化|规划|多步|复杂|设计.*方案|redesign|rework|refactor|rewrite|organize|polish|multi[- ]?step|complex)/i.test(
        value,
      );
    if (complexAppControlIntent && hasConfiguredRealtimeTool("delegate_to_worker")) {
      return { type: "function", name: "delegate_to_worker" };
    }

    const appControlIntent =
      (/(控制|操作|处理|卡住|点击|点一下|点开|点选|输入|回车|切到|切换|画|draw|click|type|enter|switch|control|operate|stuck)/i.test(
        value,
      ) ||
        (/(tab|标签页|页签)/i.test(value) &&
          /(next|previous|prev|下一个|上一个|前一个|左边|右边|第)/i.test(value))) &&
      !stopShareIntent;
    if (appControlIntent && hasConfiguredRealtimeTool("kwwk_computer_use")) {
      return { type: "function", name: "kwwk_computer_use" };
    }

    const shareIntent =
      /(共享|分享|演示|投屏|share|present|show)/i.test(value) &&
      /(窗口|浏览器|chrome|safari|pencil|app|应用|屏幕|会议|browser|window|screen)/i.test(value) &&
      !stopShareIntent;
    if (shareIntent && hasConfiguredRealtimeTool("share_existing_app_window")) {
      return { type: "function", name: "share_existing_app_window" };
    }
    if (shareIntent && hasConfiguredRealtimeTool("list_shareable_windows")) {
      return { type: "function", name: "list_shareable_windows" };
    }

    const meetChatIntent =
      /(会议|meet|聊天|chat)/i.test(value) &&
      /(说了啥|说什么|刚说|聊天|消息|内容|read|what)/i.test(value);
    if (meetChatIntent && hasConfiguredRealtimeTool("read_meet_chat")) {
      return { type: "function", name: "read_meet_chat" };
    }

    const linearSelfIssueIntent =
      /(linear)/i.test(value) &&
      /(我|我的|me|my)/i.test(value) &&
      /(issue|任务|没做完|待办|assigned|open)/i.test(value);
    if (linearSelfIssueIntent && hasConfiguredRealtimeTool("current_user_identity")) {
      return { type: "function", name: "current_user_identity" };
    }
  }

  return null;
}

function shouldDirectRouteTextTurnTool(name: string) {
  return new Set([
    "stop_video_stage",
    "kwwk_computer_use",
    "share_existing_app_window",
    "list_shareable_windows",
    "read_meet_chat",
    "current_user_identity",
    "worker_status",
    "delegate_to_worker",
  ]).has(name);
}

function inferTextTurnApplicationName(text: string) {
  const value = String(text || "");
  if (/pencil/i.test(value)) return "Pencil";
  if (/safari/i.test(value)) return "Safari";
  if (/(chrome|浏览器|browser)/i.test(value)) return "Chrome";
  return "";
}

function textLooksLikeCodeBuildRequest(text: string) {
  const value = String(text || "");
  return (
    (/(实现|开发|做一个|做个|搭建|写一个|写个|build|implement|create|make)/i.test(value) &&
      /(web|网页|网站|应用|app|游戏|game|五子棋|gomoku|同步|sync|多人|multi)/i.test(value)) ||
    /(五子棋|gomoku)/i.test(value)
  );
}

function gomokuAcceptanceContextForText(text: string) {
  if (!/(五子棋|gomoku)/i.test(String(text || ""))) return {};
  return {
    acceptanceScenario: "gomoku_sync_build_and_play",
    artifactContract:
      'Build a runnable synced web Gomoku app where a human user and the bot can play together. Prefer a static app that can sync two tabs via BroadcastChannel/localStorage or a tiny local server. Return one line starting with ONEESAMA_GOMOKU_ARTIFACT followed by JSON: {"appDir":"absolute path to app directory","entry":"index.html","notes":"short"}. The app must expose window.__GOMOKU_TEST_API__ with getState(), playMove(row,col,actor), requestBotMove(), and reset(). The harness will use playMove(row,col,"user") for the user move, then requestBotMove() so the app/bot logic chooses and records the bot move; do not require the harness to fake a bot move by directly calling playMove(...,"bot").',
  };
}

function directTextTurnToolArgs(name: string, text: string) {
  const applicationName = inferTextTurnApplicationName(text);
  if (name === "share_existing_app_window") {
    return applicationName ? { applicationName } : {};
  }
  if (name === "kwwk_computer_use") {
    return {
      instruction: text,
      ...(applicationName ? { applicationName } : {}),
    };
  }
  if (name === "delegate_to_worker") {
    const wantsCode = textLooksLikeCodeBuildRequest(text);
    const context = gomokuAcceptanceContextForText(text);
    return {
      task: text,
      ...(wantsCode ? { mode: "code", allowCodeChanges: true } : {}),
      ...(Object.keys(context).length > 0 ? { context } : {}),
    };
  }
  return {};
}

function queueDirectFunctionalTool(
  name: string,
  text: string,
  { source = "manual_text_turn" }: { source?: string } = {},
) {
  const callId = `${source}_${randomEventId()}`;
  recordTimeline("realtime_direct_functional_tool_route", {
    name,
    callId,
    source,
  });
  Promise.resolve()
    .then(() => runLocalToolForSDK(name, directTextTurnToolArgs(name, text), callId))
    .then((result) => {
      recordTimeline("realtime_direct_functional_tool_done", {
        name,
        callId,
        source,
        ok: (result as { ok?: boolean })?.ok !== false,
      });
      updateFeedback();
      return result;
    })
    .catch((error) => {
      recordTimeline("realtime_direct_functional_tool_error", {
        name,
        callId,
        source,
        error: String(error?.message || error).slice(0, 300),
      });
      updateFeedback();
      return undefined;
    });
}

function queueDirectTextTurnTool(name: string, text: string) {
  queueDirectFunctionalTool(name, text, { source: "manual_text_turn" });
}

function hasConfiguredRealtimeTool(name: string) {
  const desired = String(name || "");
  if (!desired) return false;
  if ((state.session.toolNames || []).includes(desired)) return true;
  if ((state.agentRuntime.sdkToolNames || []).includes(desired)) return true;
  return (config.tools || []).some((tool) => String(tool?.name || "") === desired);
}

(window as any).__MAB_REALTIME_DIRECT_TOOL_ROUTING = {
  preferredToolChoice: preferredToolChoiceForTextTurn,
  shouldDirectRouteTool: shouldDirectRouteTextTurnTool,
  queue: queueDirectFunctionalTool,
};

function forcedToolInstructionsForTextTurn(
  text: string,
  toolChoice: { type: string; name: string } | null,
) {
  const name = toolChoice?.name || "";
  if (!name) return "";
  const userText = String(text || "").slice(0, 500);
  if (name === "worker_status") {
    return [
      "For this turn, call worker_status now before any assistant text.",
      "Do not say progress text or promise to check status before the tool call.",
      "Omit jobId when the user refers to the latest or previous background job.",
      `Latest user request: ${userText}`,
    ].join("\n");
  }
  if (name === "delegate_to_worker") {
    return [
      "For this turn, call delegate_to_worker now before any assistant text.",
      "Put the user's full background task in the task argument and preserve app/window, repo, issue, URL, and keyword wording.",
      "If the user asks to build, implement, create, or run a web app/game such as Gomoku/五子棋, set mode to code and allowCodeChanges to true.",
      "Do not say progress text or promise to work before the tool call.",
      `Latest user request: ${userText}`,
    ].join("\n");
  }
  if (name === "stop_video_stage") {
    return [
      "For this turn, call stop_video_stage now before any assistant text.",
      "Use this for requests to stop or cancel the current shared screen/window.",
      "Do not call share_existing_app_window, list_shareable_windows, or kwwk_computer_use for a stop-share request.",
      `Latest user request: ${userText}`,
    ].join("\n");
  }
  if (name === "kwwk_computer_use") {
    return [
      "For this turn, call kwwk_computer_use now before any assistant text.",
      "Put the user's requested app/window action in the instruction argument as natural language.",
      "Do not include low-level operations or coordinate primitives.",
      "Do not use browser/demo workspace tools for an already shared app/window.",
      `Latest user request: ${userText}`,
    ].join("\n");
  }
  if (name === "share_existing_app_window") {
    return [
      "For this turn, call share_existing_app_window now before any assistant text.",
      "If the user names an app or browser, preserve that app/window name in the tool arguments.",
      "Do not use browser/demo workspace tools for sharing an existing local app/window.",
      `Latest user request: ${userText}`,
    ].join("\n");
  }
  if (name === "list_shareable_windows") {
    return [
      "For this turn, call list_shareable_windows now before any assistant text.",
      "Use this when the user asks to share a window but the target app/window is ambiguous.",
      `Latest user request: ${userText}`,
    ].join("\n");
  }
  if (name === "read_meet_chat") {
    return [
      "For this turn, call read_meet_chat now before any assistant text.",
      "Use this for requests asking what people said in the meeting chat.",
      `Latest user request: ${userText}`,
    ].join("\n");
  }
  if (name === "current_user_identity") {
    return [
      "For this turn, call current_user_identity now before any assistant text.",
      "Use this as the first step for personal Linear issue/task requests before querying Linear.",
      `Latest user request: ${userText}`,
    ].join("\n");
  }
  return "";
}
