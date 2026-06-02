(() => {
  function truncateText(text: unknown, maxChars = 3500): string {
    const raw = String(text || "");
    if (raw.length <= maxChars) return raw;
    return `${raw.slice(0, maxChars).trimEnd()}\n\n...(已截断，原文 ${raw.length} 字符)`;
  }

  function workerResultStatusLabel(job) {
    if (job.status === "failed") return "失败";
    if (job.status === "timeout") return "超时";
    return "完成";
  }

  function buildWorkerResultChatText(job) {
    const status = workerResultStatusLabel(job);
    const result = workerResultChatBody(job);
    return truncateText([`后台任务${status}：${job.task || job.id}`, "", result].join("\n"));
  }

  function shouldSendWorkerResultToMeetChat(job) {
    const result = String(workerResultChatBody(job, ""));
    return result.trim().length > 0;
  }

  function workerResultChatBody(job, fallback = "没有返回详细结果。") {
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
        `后台任务${status}。`,
        "完整结果我已经发到 Meet chat，不在语音里整段念。",
        "你可以先看聊天里的结果，需要我继续处理再直接说。",
      ].join("\n");
    }
    if (chatDelivery && chatDelivery.ok === false) {
      return [
        `后台任务${status}，但结果太长，Meet chat 发送失败。`,
        `发送失败原因：${chatDelivery.error || "unknown"}`,
        "我先不整段朗读，避免打断会议。",
      ].join("\n");
    }
    const result = job.result || job.error || "没有返回详细结果。";
    return [
      `后台任务 ${status}。`,
      `任务：${job.task || job.id}`,
      `结果：${result}`,
      "请用 1-2 句中文主动汇报给会议里的用户。",
    ].join("\n");
  }

  function buildWorkerResultText(job) {
    const status = job.status === "failed" ? "失败" : "完成";
    const result = job.result || job.error || "没有返回详细结果。";
    return [
      `后台任务 ${status}。`,
      `任务：${job.task || job.id}`,
      `结果：${result}`,
      "请用 1-2 句中文主动汇报给会议里的用户。",
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
