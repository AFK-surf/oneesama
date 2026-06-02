(() => {
  if (window.__meetingAvatarWorkerResultBridge) return;
  if (window.top !== window) return;
  window.__meetingAvatarWorkerResultBridge = true;

  const config = {
    workerPollUrl: "",
    workerMarkRealtimeDeliveredUrl: "",
    pollIntervalMs: 4000,
    enabled: true,
    autoStart: true,
    minCreatedAt: "",
    sessionId: "",
    toolCallbackToken: "",
    allowCustomWorkerResultEvents: false,
    ...window.MAB_WORKER_RESULT_CONFIG,
  };

  const state = {
    ok: true,
    enabled: Boolean(config.enabled && config.workerPollUrl),
    delivered: [],
    errors: [],
    lastPollAt: "",
    lastDeliveryAt: "",
  };
  window.MAB_WORKER_RESULT_BRIDGE = state;

  const log = (...args) => console.error("[meeting-avatar-worker-result]", ...args);

  function rememberError(error) {
    state.errors.push({
      ts: new Date().toISOString(),
      message: String((error && error.message) || error).slice(0, 500),
    });
    state.errors = state.errors.slice(-20);
  }

  function recordValue(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  function injectionWasSuppressed(delivery) {
    const record = recordValue(delivery);
    return record.suppressed === true || record.ok === false;
  }

  async function injectIntoRealtime(job) {
    if (typeof window.MAB_REALTIME_CLIENT?.injectWorkerResult === "function") {
      const delivery = await window.MAB_REALTIME_CLIENT.injectWorkerResult(job);
      return { channel: "MAB_REALTIME_CLIENT.injectWorkerResult", delivery };
    }

    if (config.allowCustomWorkerResultEvents === true) {
      window.dispatchEvent(new CustomEvent("meeting-avatar-worker-result", { detail: job }));
      return {
        channel: "custom-event-diagnostic",
        delivery: {
          ok: false,
          suppressed: true,
          reason: "custom_worker_result_event_diagnostic_only",
        },
      };
    }

    return { channel: "realtime-client-missing", delivery: null };
  }

  function deliveryReachedRealtime(injection) {
    const channel = injection?.channel || "";
    if (injectionWasSuppressed(injection?.delivery)) return false;
    return channel === "MAB_REALTIME_CLIENT.injectWorkerResult";
  }

  function markRealtimeDeliveredUrl() {
    if (config.workerMarkRealtimeDeliveredUrl) return config.workerMarkRealtimeDeliveredUrl;
    if (!config.workerPollUrl) return "";
    return String(config.workerPollUrl).replace(
      /\/poll-realtime(?:\?.*)?$/,
      "/mark-realtime-delivered",
    );
  }

  function internalHeaders() {
    const headers = { "content-type": "application/json" };
    if (config.toolCallbackToken) {
      headers["X-Oneesama-Internal-Key"] = String(config.toolCallbackToken);
    }
    return headers;
  }

  async function markRealtimeDelivered(job, channel) {
    const url = markRealtimeDeliveredUrl();
    const jobId = job?.id || job?.jobId || job?.job_id || "";
    const deliveryToken =
      job?.realtimeDeliveryAttempt?.token ||
      job?.realtime_delivery_attempt?.token ||
      job?.deliveryToken ||
      job?.delivery_token ||
      "";
    if (!url || !jobId || !channel) {
      return { ok: false, skipped: true, reason: "realtime_delivery_not_confirmed" };
    }
    const response = await fetch(url, {
      method: "POST",
      headers: internalHeaders(),
      body: JSON.stringify({
        id: jobId,
        jobId,
        channel,
        deliveryToken,
        token: deliveryToken,
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok === false) {
      throw new Error(body.error || `worker realtime delivery marker failed: ${response.status}`);
    }
    return body;
  }

  async function pollOnce() {
    if (!state.enabled) return [];
    state.lastPollAt = new Date().toISOString();
    const response = await fetch(config.workerPollUrl, {
      method: "POST",
      headers: internalHeaders(),
      body: JSON.stringify({
        limit: 5,
        markDelivered: false,
        minCreatedAt: config.minCreatedAt,
        sessionId: config.sessionId,
      }),
    });
    const body = await response.json();
    if (!response.ok || body.ok === false) {
      throw new Error(body.error || `worker poll failed: ${response.status}`);
    }
    const jobs = body.jobs || [];
    for (const job of jobs) {
      const injection = await injectIntoRealtime(job);
      const delivery = {
        ts: new Date().toISOString(),
        jobId: job.id,
        status: job.status,
        task: job.task,
        channel: injection.channel,
        injection: injection.delivery || null,
        suppressed: injectionWasSuppressed(injection.delivery),
        reason: recordValue(injection.delivery).reason || "",
        ack: null,
      };
      if (deliveryReachedRealtime(injection)) {
        delivery.ack = await markRealtimeDelivered(job, injection.channel);
      }
      state.delivered.push(delivery);
      state.delivered = state.delivered.slice(-50);
      state.lastDeliveryAt = delivery.ts;
      log("delivered worker result", delivery);
    }
    return jobs;
  }

  async function loop() {
    try {
      await pollOnce();
    } catch (error) {
      rememberError(error);
    } finally {
      if (state.enabled) window.setTimeout(loop, config.pollIntervalMs);
    }
  }

  window.MAB_WORKER_RESULT_BRIDGE_API = {
    pollOnce,
    stop() {
      state.enabled = false;
    },
    start() {
      if (state.enabled) return;
      state.enabled = Boolean(config.workerPollUrl);
      if (state.enabled) loop();
    },
  };

  if (state.enabled && config.autoStart !== false) {
    window.setTimeout(loop, 250);
  }
})();
