type SlackJobLike = Record<string, any>;
type SlackWorkerResponseBody = Record<string, any>;

export function createSlackWorkerResultHandlers(ctx: any) {
  const {
    config,
    finalizedWorkerJobReports,
    poster,
    postJson,
    finalizeSlackTriageJob,
    postSlackMessage,
    scheduleSlackAssistantThreadStatus,
    assistantStatusTextForJob,
  } = ctx;

  async function reportFinishedWorkerJob(job: SlackJobLike) {
    if ((job?.context as { source?: string } | undefined)?.source === "slack-triage") {
      await finalizeSlackTriageJob(job);
      return null;
    }
    if (!["completed", "failed"].includes(String(job.status))) return null;
    if (finalizedWorkerJobReports.has(String(job.id)))
      return finalizedWorkerJobReports.get(String(job.id));
    const meetingReport = await postJson(`${config.meetingAgentUrl}/worker/report`, {
      id: job.id,
      status: job.status,
      task: job.task,
      result: job.result,
      error: job.error,
    });
    const slackPost = await postSlackWorkerResult(job);
    const assistantStatusClear = await clearSlackAssistantStatusForWorkerJob(job);
    const report = {
      ok:
        meetingReport.ok &&
        (!slackPost || slackPost.ok !== false) &&
        assistantStatusClear.ok !== false,
      status: meetingReport.status,
      body: meetingReport.body,
      meetingReport,
      slackPost,
      assistantStatusClear,
    };
    finalizedWorkerJobReports.set(job.id, report);
    return report;
  }

  function slackRefForWorkerJob(job: SlackJobLike = {}) {
    const slack = (job.context?.slack || {}) as {
      channelId?: string;
      channel?: string;
      threadTs?: string;
      thread_ts?: string;
      [key: string]: unknown;
    };
    const slackAppMention = job.context?.slackAppMention as { threadTs?: string } | undefined;
    const channel = slack.channelId || slack.channel || "";
    const threadTs = slack.threadTs || slack.thread_ts || slackAppMention?.threadTs || "";
    if (!channel) return null;
    return { channel, threadTs };
  }

  function slackWorkerResultText(job: SlackJobLike = {}) {
    if (job.status !== "completed") {
      return "";
    }
    return String(job.result || "").trim();
  }

  async function postSlackWorkerResult(job: SlackJobLike = {}) {
    const ref = slackRefForWorkerJob(job);
    const text = slackWorkerResultText(job);
    if (!ref || !text) return null;
    if (!config.slackApiMock) {
      return poster.postMessage({
        channel: ref.channel,
        threadTs: ref.threadTs,
        text,
        dedupKey: `slack-worker-result:${job.id}:${ref.channel}:${ref.threadTs || "root"}`,
      });
    }
    return postSlackMessage({
      channel: ref.channel,
      text,
      thread_ts: ref.threadTs,
    });
  }

  async function clearSlackAssistantStatusForWorkerJob(job: SlackJobLike = {}) {
    const ref = slackRefForWorkerJob(job);
    if (!ref?.channel || !ref?.threadTs)
      return { ok: true, skipped: true, reason: "missing_slack_ref" };
    return scheduleSlackAssistantThreadStatus({
      channelId: ref.channel,
      threadTs: ref.threadTs,
      status: "",
      immediate: true,
    });
  }

  async function updateSlackAssistantStatusForWorkerJob(job: SlackJobLike = {}) {
    const ref = slackRefForWorkerJob(job);
    if (!ref?.channel || !ref?.threadTs || job.status !== "running") {
      return { ok: true, skipped: true, reason: "missing_or_terminal_slack_ref" };
    }
    const status = job.latestProgressStatus || assistantStatusTextForJob(job) || "Working on it...";
    return scheduleSlackAssistantThreadStatus({
      channelId: ref.channel,
      threadTs: ref.threadTs,
      status,
      immediate: false,
    });
  }

  function slackImmediateWorkerAckText(responseBody: SlackWorkerResponseBody = {}) {
    if (responseBody?.job) {
      if (responseBody.job.status === "failed")
        return "我接到了，但后台处理失败了，正在把错误收口。";
      return "";
    }
    return responseBody?.text || "";
  }

  function shouldKeepAssistantStatusUntilWorkerDone(responseBody: SlackWorkerResponseBody = {}) {
    return Boolean(responseBody?.job && responseBody.job.status === "running");
  }

  function formatWorkerJobForSlack(job) {
    const statusLabel = job.status === "completed" ? "completed" : job.status;
    const detail =
      job.status === "completed"
        ? job.result || "(no result)"
        : job.error || job.result || "(no detail)";
    return `Worker ${job.id} ${statusLabel}: ${job.task || "(untitled task)"}\n${detail}`;
  }

  async function pollMeetingWorkerResults({ limit = 10, markDelivered = true } = {}) {
    const response = await postJson(`${config.meetingAgentUrl}/worker/poll-slack`, {
      limit,
      markDelivered,
    });
    const jobs = response.body?.jobs || [];
    const messages = jobs.map(formatWorkerJobForSlack);
    return {
      ok: response.ok,
      status: response.status,
      jobs,
      messages,
      text: messages.length
        ? messages.join("\n\n")
        : "No completed meeting worker jobs ready for Slack.",
      meetingAgent: response.body,
    };
  }

  async function postMeetingWorkerResultsToSlack({
    limit = 10,
    channel = "",
    threadTs = "",
    markDelivered = true,
  } = {}) {
    const response = await postJson(`${config.meetingAgentUrl}/worker/poll-slack`, {
      limit,
      markDelivered: false,
    });
    const jobs = response.body?.jobs || [];
    const posts = [];
    for (const job of jobs) {
      const text = formatWorkerJobForSlack(job);
      const dedupKey = `worker-result:${job.id}:slack:${channel}:${threadTs}`;
      const post = await poster.postMessage({ channel, threadTs, text, dedupKey });
      posts.push({ jobId: job.id, text, post });
      if (post.ok && markDelivered) {
        await postJson(`${config.meetingAgentUrl}/worker/mark-slack-delivered`, {
          jobId: job.id,
          channel,
          threadTs,
          ts: post.ts,
          dedupKey,
          mock: Boolean(post.mock),
        });
      }
    }

    return {
      ok: response.ok && posts.every((entry) => entry.post.ok),
      status: response.status,
      jobs,
      posts,
      text: posts.length
        ? posts.map((entry) => entry.text).join("\n\n")
        : "No completed meeting worker jobs ready for Slack.",
      meetingAgent: response.body,
      poster: { mock: poster.mock },
    };
  }

  return {
    clearSlackAssistantStatusForWorkerJob,
    formatWorkerJobForSlack,
    pollMeetingWorkerResults,
    postMeetingWorkerResultsToSlack,
    postSlackWorkerResult,
    reportFinishedWorkerJob,
    shouldKeepAssistantStatusUntilWorkerDone,
    slackImmediateWorkerAckText,
    updateSlackAssistantStatusForWorkerJob,
  };
}
