import {
  markdownToBlocks,
  markdownToSlackFallbackText,
  markdownishToMrkdwn,
} from "./mrkdwn-renderer.js";

export interface CreateSlackPosterOptions {
  botToken?: string;
  mock?: boolean;
  fetchImpl?: typeof fetch;
  endpoint?: string;
  maxAttempts?: number | string;
  retryDelayMs?: number | string;
  renderMarkdown?: boolean;
  linearWorkspaceSlug?: string;
}

export interface SlackPostMessageInput {
  channel?: string;
  text?: string;
  threadTs?: string;
  dedupKey?: string;
  blocks?: unknown[] | null;
}

export interface SlackPostMessageResult {
  ok: boolean;
  mock?: boolean;
  channel?: string;
  ts?: string;
  message?: { text?: string; blocks?: unknown[] | null; thread_ts?: string };
  sourceText?: string;
  threadTs?: string;
  dedupKey?: string;
  attempts?: number;
  status?: number;
  body?: {
    ok?: boolean;
    error?: string;
    ts?: string;
    message?: { thread_ts?: string };
    [key: string]: unknown;
  };
  error?: string;
  detail?: string;
  deduped?: boolean;
  [key: string]: unknown;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ShouldRetryInput {
  status?: number;
  body?: { error?: string } | null;
  error?: string | null;
}

function shouldRetry({ status = 0, body = null, error = null }: ShouldRetryInput): boolean {
  if (error) return true;
  if ([429, 500, 502, 503, 504].includes(status)) return true;
  return ["ratelimited", "internal_error", "fatal_error"].includes(body?.error || "");
}

export function createSlackPoster(options: CreateSlackPosterOptions = {}) {
  const botToken = options.botToken || "";
  const mock = options.mock ?? !botToken;
  const fetchImpl = options.fetchImpl || fetch;
  const endpoint = options.endpoint || "https://slack.com/api/chat.postMessage";
  const maxAttempts = Math.max(1, Number.parseInt(String(options.maxAttempts ?? "3"), 10));
  const retryDelayMs = Math.max(0, Number.parseInt(String(options.retryDelayMs ?? "250"), 10));
  const renderMarkdown = options.renderMarkdown ?? true;
  const linearWorkspaceSlug =
    options.linearWorkspaceSlug || process.env.MAB_LINEAR_WORKSPACE_SLUG || "";
  const postedByDedupKey = new Map<string, SlackPostMessageResult>();

  function renderSlackMessage({
    text,
    blocks = null,
  }: { text?: string; blocks?: unknown[] | null } = {}) {
    const sourceText = String(text || "");
    if (Array.isArray(blocks) && blocks.length) {
      return {
        text: markdownToSlackFallbackText(sourceText, { linearWorkspaceSlug }),
        blocks,
      };
    }
    if (!renderMarkdown) {
      return {
        text: markdownishToMrkdwn(sourceText, { linearWorkspaceSlug }),
        blocks: null,
      };
    }
    return {
      text: markdownToSlackFallbackText(sourceText, { linearWorkspaceSlug }),
      blocks: markdownToBlocks(sourceText, { linearWorkspaceSlug }),
    };
  }

  async function postMessage({
    channel,
    text,
    threadTs = "",
    dedupKey = "",
    blocks = null,
  }: SlackPostMessageInput = {}): Promise<SlackPostMessageResult> {
    if (!channel) {
      return { ok: false, error: "missing_channel", channel, text, threadTs, dedupKey };
    }
    if (!text) {
      return { ok: false, error: "missing_text", channel, text, threadTs, dedupKey };
    }

    if (dedupKey && postedByDedupKey.has(dedupKey)) {
      const previous = postedByDedupKey.get(dedupKey)!;
      return { ...previous, deduped: true };
    }

    const rendered = renderSlackMessage({ text, blocks });

    if (mock) {
      const result: SlackPostMessageResult = {
        ok: true,
        mock: true,
        channel,
        ts: `mock.${Date.now()}`,
        message: { text: rendered.text, blocks: rendered.blocks },
        sourceText: text,
        threadTs,
        dedupKey,
        attempts: 1,
      };
      if (dedupKey) postedByDedupKey.set(dedupKey, result);
      return result;
    }

    const payload: Record<string, unknown> = {
      channel,
      text: rendered.text,
      unfurl_links: false,
      unfurl_media: false,
    };
    if (Array.isArray(rendered.blocks) && rendered.blocks.length) payload.blocks = rendered.blocks;
    if (threadTs) payload.thread_ts = threadTs;

    let last: SlackPostMessageResult | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${botToken}`,
            "content-type": "application/json; charset=utf-8",
          },
          body: JSON.stringify(payload),
        });
        const body = (await response.json().catch(() => ({}))) as SlackPostMessageResult["body"];
        last = {
          ok: response.ok && body?.ok === true,
          status: response.status,
          body,
          channel,
          ts: body?.ts || "",
          threadTs: body?.message?.thread_ts || threadTs,
          dedupKey,
          attempts: attempt,
        };
      } catch (error) {
        const err = error as { message?: string };
        last = {
          ok: false,
          status: 0,
          error: "request_failed",
          detail: String(err?.message || error),
          channel,
          threadTs,
          dedupKey,
          attempts: attempt,
        };
      }

      if (last.ok) {
        if (dedupKey) postedByDedupKey.set(dedupKey, last);
        return last;
      }
      if (
        attempt === maxAttempts ||
        !shouldRetry({ status: last.status, body: last.body, error: last.error })
      )
        return last;
      await delay(retryDelayMs * attempt);
    }

    return last as SlackPostMessageResult;
  }

  return { postMessage, mock, renderSlackMessage };
}
