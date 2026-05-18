(() => {
  if (window.__meetingAvatarWorkerResultBridge) return;
  if (window.top !== window) return;
  window.__meetingAvatarWorkerResultBridge = true;

  const config = {
    workerPollUrl: "",
    pollIntervalMs: 4000,
    enabled: true,
    minCreatedAt: "",
    ...(window.MAB_WORKER_RESULT_CONFIG || {}),
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

  function injectIntoRealtime(job) {
    if (typeof window.MAB_REALTIME_CLIENT?.injectWorkerResult === "function") {
      window.MAB_REALTIME_CLIENT.injectWorkerResult(job);
      return "MAB_REALTIME_CLIENT.injectWorkerResult";
    }

    if (typeof window.MAB_REALTIME_CLIENT?.sendWorkerResult === "function") {
      window.MAB_REALTIME_CLIENT.sendWorkerResult(job);
      return "MAB_REALTIME_CLIENT.sendWorkerResult";
    }

    window.dispatchEvent(new CustomEvent("meeting-avatar-worker-result", { detail: job }));
    return "custom-event";
  }

  async function pollOnce() {
    if (!state.enabled) return [];
    state.lastPollAt = new Date().toISOString();
    const response = await fetch(config.workerPollUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ limit: 5, markDelivered: true, minCreatedAt: config.minCreatedAt }),
    });
    const body = await response.json();
    if (!response.ok || body.ok === false) {
      throw new Error(body.error || `worker poll failed: ${response.status}`);
    }
    const jobs = body.jobs || [];
    for (const job of jobs) {
      const delivery = {
        ts: new Date().toISOString(),
        jobId: job.id,
        status: job.status,
        task: job.task,
        channel: injectIntoRealtime(job),
      };
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

  if (state.enabled) {
    window.setTimeout(loop, 250);
  }
})();
