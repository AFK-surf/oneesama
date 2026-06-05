/* eslint-disable no-unused-vars */
interface BuildSessionUpdateOptions {
  session?: RealtimeSessionShape & { schema?: string; session_schema?: string };
  instructions?: string;
  tools?: any[];
  toolChoice?: string;
  sessionSchema?: string;
}

function sendSessionUpdate(options: BuildSessionUpdateOptions = {}) {
  const event = buildSessionUpdateEvent({
    session: config.session,
    instructions: config.instructions,
    tools: config.tools,
    toolChoice: config.toolChoice,
    ...options,
  });
  if (!Object.keys(event.session || {}).length)
    return { ok: true, skipped: true, reason: "empty_session_update" };
  const channel = sendRealtimeEvent(event);
  state.session.configured = true;
  state.session.updateEventsSent += 1;
  state.session.lastUpdateChannel = channel;
  state.session.lastUpdateAt = new Date().toISOString();
  state.session.instructionsLength = String(event.session?.instructions || "").length;
  state.session.toolNames = normalizeToolNames((event.session?.tools as any[] | undefined) || []);
  updateFeedback();
  return { ok: true, channel, event };
}

function injectCurrentUserContext() {
  const currentUser = (config.currentUser || {}) as Record<string, unknown>;
  const configuredName = String(currentUser.name || "").trim();
  const spokenName = String(
    currentUser.englishName || currentUser.english || currentUser.name || "",
  ).trim();
  const name = spokenName || configuredName;
  if (!name) return { ok: true, skipped: true, reason: "no_current_user_context" };
  const identity = {
    resolved: true,
    role: "current_user",
    isCurrentUser: true,
    canonicalName: name,
    preferredName: spokenName || name,
    confidence: "high",
    evidence:
      configuredName && configuredName !== spokenName
        ? ["runtime_current_user_config", "runtime_alias_not_spoken_name"]
        : ["runtime_current_user_config"],
  };
  return pushSessionContext({
    reason: "current_user_bootstrap",
    kind: "identity",
    value: identity,
    force: true,
  });
}

function configureRealtimeSession() {
  if (config.sendSessionUpdateOnConnect === false) return { ok: true, skipped: true };
  const sessionUpdate = sendSessionUpdate();
  const identityContext = injectCurrentUserContext();
  return { ok: true, sessionUpdate, identityContext };
}

function shouldUseRealtimeAgentSDK(runtime = config.agentRuntime) {
  return ["agents-sdk", "openai-agents", "openai-agents-sdk"].includes(
    String(runtime || "").toLowerCase(),
  );
}

function getRealtimeAgentsSDKNamespace() {
  const namespace = (window as any).OpenAIAgentsRealtime || (window as any).openaiAgentsRealtime;
  if (namespace?.RealtimeAgent && namespace?.RealtimeSession && namespace?.tool) {
    state.agentRuntime.bundleGlobal = "OpenAIAgentsRealtime";
    return namespace;
  }
  return null;
}

async function mintRealtimeClientSecretForSDK(connectionConfig) {
  let response;
  try {
    response = await fetch(connectionConfig.tokenUrl || config.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...connectionConfig.session,
        instructions: connectionConfig.instructions,
        tools: connectionConfig.tools,
        toolChoice: connectionConfig.toolChoice,
      }),
    });
  } catch (tokenFetchError) {
    const detail = {
      status: 0,
      ok: false,
      retryable: true,
      retryAfter: "",
      retryAfterMs: 0,
      requestId: "",
      error: String((tokenFetchError && tokenFetchError.message) || tokenFetchError).slice(0, 500),
      reason: "realtime_token_fetch_failed",
    };
    state.connection.lastTokenError = {
      ts: new Date().toISOString(),
      ...detail,
    };
    recordTimeline("realtime_token_error", state.connection.lastTokenError);
    const error = new Error(`Realtime client secret fetch failed: ${detail.error}`);
    const typedError = error as Error & { realtimeTokenError?: Record<string, unknown> };
    typedError.realtimeTokenError = detail;
    throw typedError;
  }
  const text = await readResponseText(response);
  const body = parseJsonObject(text);
  const value = body.value || body.client_secret?.value || body.secret?.value;
  if (!response.ok || !value) {
    const retry = retryAfterDetail(response);
    const failure = classifyRealtimeConnectFailure(response.status, text, "realtime_token");
    const requestId = responseRequestId(response);
    state.connection.lastTokenError = {
      ts: new Date().toISOString(),
      status: response.status,
      ok: response.ok,
      retryable: failure.retryable,
      terminal: failure.terminal,
      ...retry,
      requestId,
      error: body.error || "",
      detail: body.detail || null,
      body: text.slice(0, 1000),
      reason: failure.reason,
    };
    recordTimeline("realtime_token_error", state.connection.lastTokenError);
    if (failure.terminal) {
      updateAvatarHudStatus("blocked", "Realtime blocked", { mood: "sad", action: "shrug" });
    }
    const error = new Error(
      [
        response.ok
          ? "Realtime client secret response did not include a value"
          : "Realtime client secret request failed:",
        formatRealtimeErrorValue(body.error) || (!response.ok ? "" : "missing value"),
        `status=${response.status}`,
        retry.retryAfter ? `retry_after=${retry.retryAfter}` : "",
        requestId ? `request_id=${requestId}` : "",
        body.detail ? `detail=${JSON.stringify(body.detail)}` : "",
        text && !body.error ? `body=${text.slice(0, 240)}` : "",
      ]
        .filter(Boolean)
        .join(" "),
    );
    const typedError = error as Error & { realtimeTokenError?: Record<string, unknown> };
    typedError.realtimeTokenError = state.connection.lastTokenError;
    throw error;
  }
  return value;
}

function buildRealtimeAgentSDKTools(namespace, tools = []) {
  const sdkTools = [];
  for (const toolConfig of tools) {
    const name = toolConfig?.name || "";
    if (!name || !isLocalToolName(name)) continue;
    sdkTools.push(
      namespace.tool({
        name,
        description: toolConfig.description || `Local ${name} tool`,
        parameters: toolConfig.parameters || { type: "object", properties: {}, required: [] },
        strict: toolConfig.strict === true,
        execute: async (input, _context, details) => {
          const callId =
            details?.toolCall?.callId ||
            details?.toolCall?.call_id ||
            details?.callId ||
            details?.call_id ||
            "";
          const execution = await runLocalToolForSDK(name, input || {}, callId);
          const output = JSON.stringify(realtimeAgentSDKToolModelOutput(execution));
          return execution.delivery?.policy?.autoRespond === false && namespace.backgroundResult
            ? namespace.backgroundResult(output)
            : output;
        },
      }),
    );
  }
  state.agentRuntime.sdkToolNames = sdkTools.map((entry) => entry.name || "");
  return sdkTools;
}

function realtimeAgentSDKToolModelOutput(execution) {
  return (
    execution?.delivery?.modelResult?.result ||
    execution?.delivery?.compactResult ||
    execution?.result ||
    execution
  );
}
