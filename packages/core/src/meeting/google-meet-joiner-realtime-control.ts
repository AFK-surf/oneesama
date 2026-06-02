export function getRealtimeControlPageForActive(active) {
  if (active?.realtimeSidecarPage && !active.realtimeSidecarPage.isClosed?.()) {
    return active.realtimeSidecarPage;
  }
  return null;
}

function deliveryRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeWorkerResultInjectionResult(result) {
  const record = deliveryRecord(result);
  const delivery = deliveryRecord(record.delivery);
  if (delivery.suppressed === true) {
    return {
      ...record,
      ok: false,
      suppressed: true,
      reason: delivery.reason || "worker_result_suppressed",
    };
  }
  return result;
}

function missingRealtimeSidecarPage() {
  return { ok: false, error: "realtime_sidecar_page_missing" };
}

export async function injectWorkerResultIntoActive(active, job, refreshActiveRuntimeState) {
  const realtimeControlPage = getRealtimeControlPageForActive(active);
  if (!realtimeControlPage) return missingRealtimeSidecarPage();
  const result = await realtimeControlPage
    .evaluate(async (payload) => {
      if (typeof window.MAB_REALTIME_CLIENT?.injectWorkerResult === "function") {
        return {
          ok: true,
          channel: "MAB_REALTIME_CLIENT.injectWorkerResult",
          delivery: await window.MAB_REALTIME_CLIENT.injectWorkerResult(payload),
        };
      }
      return { ok: false, error: "realtime_worker_result_client_missing" };
    }, job)
    .catch((error) => ({ ok: false, error: String(error?.message || error) }));
  await refreshActiveRuntimeState();
  return {
    ...normalizeWorkerResultInjectionResult(result),
    realtimeBridge: active?.realtimeBridge || null,
    workerResultBridge: active?.workerResultBridge || null,
  };
}

export async function sendRealtimeEventToActive(active, event, refreshActiveRuntimeState) {
  const realtimeControlPage = getRealtimeControlPageForActive(active);
  if (!realtimeControlPage) return missingRealtimeSidecarPage();
  const result = await realtimeControlPage
    .evaluate((payload) => {
      if (!window.MAB_REALTIME_CLIENT?.sendRealtimeControlEvent) {
        return { ok: false, error: "realtime_control_event_api_missing" };
      }
      const channel = window.MAB_REALTIME_CLIENT.sendRealtimeControlEvent(payload);
      if (channel === "realtime-control-event-not-allowed") {
        return { ok: false, error: "realtime_event_type_not_allowed", channel };
      }
      return { ok: true, channel };
    }, event)
    .catch((error) => ({ ok: false, error: String(error?.message || error) }));
  await refreshActiveRuntimeState();
  return {
    ...result,
    feedback: active?.realtimeBridge?.feedback || null,
    realtimeBridge: active?.realtimeBridge || null,
  };
}

export async function requestRealtimeTextTurnFromActive(
  active,
  { text, instructions },
  refreshActiveRuntimeState,
) {
  const realtimeControlPage = getRealtimeControlPageForActive(active);
  if (!realtimeControlPage) return missingRealtimeSidecarPage();
  const userText = String(text || "").trim();
  if (!userText) return { ok: false, error: "text_required" };
  const result = await realtimeControlPage
    .evaluate(
      (payload) => {
        const client = window.MAB_REALTIME_CLIENT;
        if (typeof client?.requestRealtimeTextTurn !== "function") {
          return { ok: false, error: "realtime_text_turn_api_missing" };
        }
        return client.requestRealtimeTextTurn(payload);
      },
      { text: userText, instructions },
    )
    .catch((error) => ({ ok: false, error: String(error?.message || error) }));
  await refreshActiveRuntimeState();
  return {
    ...result,
    feedback: active?.realtimeBridge?.feedback || result.feedback,
    realtimeBridge: active?.realtimeBridge || result.realtimeBridge,
  };
}

export async function sendMeetChatFromActive(active, input, refreshActiveRuntimeState) {
  const text = String(input.text || input.message || "").trim();
  if (!text) return { ok: false, error: "text_required" };
  if (!active?.page) return { ok: false, error: "no_active_join" };
  const result = await active.page
    .evaluate(
      async (payload) => {
        const surfaceTools = window.MAB_MEET_SURFACE_TOOLS;
        if (typeof surfaceTools?.run === "function") {
          return await surfaceTools.run("send_meet_chat", payload);
        }
        return { ok: false, error: "meet_chat_bridge_missing" };
      },
      { text },
    )
    .catch((error) => ({ ok: false, error: String(error?.message || error) }));
  await refreshActiveRuntimeState();
  return {
    ...result,
    realtimeBridge: active?.realtimeBridge || null,
    fixtureState: active?.fixtureState || null,
  };
}

export async function readMeetChatFromActive(active, input, refreshActiveRuntimeState) {
  if (!active?.page) return { ok: false, error: "no_active_join" };
  const payload = {
    limit: input.limit || input.count || 10,
    onlyLinks: Boolean(input.onlyLinks || input.only_links),
  };
  const result = await active.page
    .evaluate(async (request) => {
      const surfaceTools = window.MAB_MEET_SURFACE_TOOLS;
      if (typeof surfaceTools?.run === "function") {
        return await surfaceTools.run("read_meet_chat", request);
      }
      return { ok: false, error: "meet_chat_bridge_missing" };
    }, payload)
    .catch((error) => ({ ok: false, error: String(error?.message || error) }));
  await refreshActiveRuntimeState();
  return {
    ...result,
    realtimeBridge: active?.realtimeBridge || null,
    fixtureState: active?.fixtureState || null,
  };
}
