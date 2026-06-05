(() => {
  function truncateText(text: unknown, maxChars = 3500): string {
    const raw = String(text || "");
    if (raw.length <= maxChars) return raw;
    return `${raw.slice(0, maxChars).trimEnd()}\n\n...(truncated from ${raw.length} characters)`;
  }

  function workerResultStatusLabel(job) {
    if (job.status === "failed") return "failed";
    if (job.status === "timeout") return "timed out";
    return "completed";
  }

  function buildWorkerResultChatText(job) {
    const status = workerResultStatusLabel(job);
    const result = workerResultChatBody(job);
    return truncateText(
      [`Background task ${status}: ${job.task || job.id}`, "", result].join("\n"),
    );
  }

  function shouldSendWorkerResultToMeetChat(job) {
    const result = String(workerResultChatBody(job, ""));
    return result.trim().length > 0;
  }

  function workerResultChatBody(job, fallback = "No detailed result was returned.") {
    if (isMeetingAppControlWorkerJob(job)) {
      const envelope = job?.resultEnvelope || job?.result_envelope || {};
      return envelope.summary || envelope.error || job.error || job.result || fallback;
    }
    return job.result || job.error || fallback;
  }

  function normalizedToken(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[_\s]+/g, "-");
  }

  function isMeetingAppControlWorkerJob(job) {
    const context = job && typeof job.context === "object" ? job.context : {};
    return (
      normalizedToken(context.session_kind || context.sessionKind) === "meeting-app-control" ||
      normalizedToken(context.source) === "meeting-realtime-shared-app-control" ||
      normalizedToken(job?.mode) === "app-control"
    );
  }

  function shouldVoiceAckWorkerResult(job) {
    return !isMeetingAppControlWorkerJob(job);
  }

  function buildWorkerResultVoiceText(job, chatDelivery) {
    const status = workerResultStatusLabel(job);
    if (chatDelivery?.ok) {
      return [
        `The background task ${status}.`,
        "I posted the full result to Meet chat, so I will not read the whole thing aloud.",
        "Check the chat first; tell me directly if you want me to keep going.",
      ].join("\n");
    }
    if (chatDelivery && chatDelivery.ok === false) {
      return [
        `The background task ${status}, but sending the long result to Meet chat failed.`,
        `Send failure reason: ${chatDelivery.error || "unknown"}`,
        "I will not read the whole result aloud to avoid disrupting the meeting.",
      ].join("\n");
    }
    const result = job.result || job.error || "No detailed result was returned.";
    return [
      `Background task ${status}.`,
      `Task: ${job.task || job.id}`,
      `Result: ${result}`,
      "Briefly report this to the meeting user in 1-2 English sentences.",
    ].join("\n");
  }

  function buildWorkerResultText(job) {
    const status = job.status === "failed" ? "failed" : "completed";
    const result = job.result || job.error || "No detailed result was returned.";
    return [
      `Background task ${status}.`,
      `Task: ${job.task || job.id}`,
      `Result: ${result}`,
      "Briefly report this to the meeting user in 1-2 English sentences.",
    ].join("\n");
  }

  function isNoActionWorkerJob(job) {
    if (!job || String(job.status || "").toLowerCase() !== "completed") {
      return false;
    }
    const envelope = job.resultEnvelope || job.result_envelope || {};
    const action = String(envelope.action || "")
      .trim()
      .toLowerCase();
    if (action === "none" || action === "no_action") {
      return true;
    }
    const text = [job.result, envelope.summary]
      .filter(Boolean)
      .map((value) => String(value).trim().toLowerCase())
      .join("\n");
    if (!text) {
      return true;
    }
    return [
      "no action needed",
      "no action.",
      "no action",
      "nothing to do",
      "无需",
      "不需要执行",
      "没有需要执行",
      "无需助手介入",
    ].some((phrase) => text.includes(phrase));
  }

  (window as any).__MAB_REALTIME_WORKER_RESULT_HELPERS = {
    buildWorkerResultChatText,
    shouldSendWorkerResultToMeetChat,
    shouldVoiceAckWorkerResult,
    buildWorkerResultVoiceText,
    buildWorkerResultText,
    isMeetingAppControlWorkerJob,
    isNoActionWorkerJob,
  };
})();
