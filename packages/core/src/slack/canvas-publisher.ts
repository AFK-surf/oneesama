import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getRuntimeConfig } from "../env.js";
import { createSlackPoster } from "./slack-poster.js";

export interface CanvasArtifact {
  id?: string;
  title?: string;
  meetUrl?: string;
  files?: { transcript?: string; audio?: string; [key: string]: unknown };
  summary?: {
    highlights?: unknown[];
    decisions?: unknown[];
    actionItems?: unknown[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

type FetchLike = typeof fetch;

function normalizeProvider(provider: unknown): string {
  return String(provider || "file")
    .trim()
    .toLowerCase()
    .replaceAll("_", "-");
}

function safeJsonParse<T = unknown>(raw: string, fallback: T | null = null): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function sanitizeId(value: unknown, fallback: string = "canvas"): string {
  const safe = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);
  return safe || fallback;
}

function readTextIfExists(path: string): string {
  if (!path || !existsSync(path)) return "";
  return readFileSync(path, "utf8");
}

export interface CallSlackApiArgs {
  botToken?: string;
  method: string;
  payload: Record<string, unknown>;
  fetchImpl?: FetchLike;
}

export interface CallSlackApiResult {
  ok: boolean;
  status?: number;
  method: string;
  body?: { ok?: boolean; error?: string; canvas_id?: string; canvas?: { id?: string }; [key: string]: unknown };
  error?: string;
  detail?: string;
}

export async function callSlackApi({
  botToken,
  method,
  payload,
  fetchImpl = fetch,
}: CallSlackApiArgs): Promise<CallSlackApiResult> {
  if (!botToken) return { ok: false, error: "missing_slack_bot_token", method };
  try {
    const response = await fetchImpl(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${botToken}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(payload),
    });
    const body = (await response.json().catch(() => ({}))) as CallSlackApiResult["body"];
    return {
      ok: response.ok && body?.ok === true,
      status: response.status,
      method,
      body,
      error: body?.ok === true ? "" : body?.error || `http_${response.status}`,
    };
  } catch (error) {
    const err = error as { message?: string };
    return {
      ok: false,
      status: 0,
      method,
      error: "request_failed",
      detail: String(err?.message || error),
    };
  }
}

async function createSlackCanvas({
  botToken,
  title,
  markdown,
  channel,
  fetchImpl,
}: {
  botToken?: string;
  title?: string;
  markdown: string;
  channel?: string;
  fetchImpl?: FetchLike;
}) {
  const payload: Record<string, unknown> = {
    title: title || "Meeting summary",
    document_content: {
      type: "markdown",
      markdown,
    },
  };
  if (channel) payload.channel_id = channel;
  const result = await callSlackApi({
    botToken,
    method: "canvases.create",
    payload,
    fetchImpl,
  });
  return {
    ...result,
    canvasId: result.body?.canvas_id || result.body?.canvas?.id || "",
    channel,
  };
}

async function editSlackCanvas({
  botToken,
  canvasId,
  markdown,
  operation = "insert_at_end",
  sectionId = "",
  fetchImpl,
}: {
  botToken?: string;
  canvasId?: string;
  markdown: string;
  operation?: string;
  sectionId?: string;
  fetchImpl?: FetchLike;
}) {
  if (!canvasId) return { ok: false, error: "missing_canvas_id", method: "canvases.edit" };
  const change: Record<string, unknown> = {
    operation,
    document_content: {
      type: "markdown",
      markdown,
    },
  };
  if (sectionId) change.section_id = sectionId;
  return await callSlackApi({
    botToken,
    method: "canvases.edit",
    payload: {
      canvas_id: canvasId,
      changes: [change],
    },
    fetchImpl,
  });
}

function renderPublishMarkdown({
  artifact = {},
  summaryMarkdown = "",
  title = "",
}: {
  artifact?: CanvasArtifact;
  summaryMarkdown?: string;
  title?: string;
}): string {
  if (summaryMarkdown.trim()) return summaryMarkdown;
  const lines = [
    `# ${title || artifact.title || "Meeting summary"}`,
    "",
    `- Meeting: ${artifact.meetUrl || "unknown"}`,
    `- Artifact: ${artifact.id || "unknown"}`,
  ];
  if (artifact.files?.transcript) lines.push(`- Transcript: ${artifact.files.transcript}`);
  if (artifact.files?.audio) lines.push(`- Audio: ${artifact.files.audio}`);
  lines.push("", "## Highlights", "");
  for (const item of artifact.summary?.highlights || []) lines.push(`- ${item}`);
  if (!(artifact.summary?.highlights || []).length) lines.push("- No highlights captured yet.");
  lines.push("", "## Decisions", "");
  for (const item of artifact.summary?.decisions || []) lines.push(`- ${item}`);
  if (!(artifact.summary?.decisions || []).length) lines.push("- No explicit decisions captured.");
  lines.push("", "## Action Items", "");
  for (const item of artifact.summary?.actionItems || []) lines.push(`- ${item}`);
  if (!(artifact.summary?.actionItems || []).length)
    lines.push("- No explicit action items captured.");
  return `${lines.join("\n")}\n`;
}

export interface CreateCanvasPublisherOptions {
  env?: NodeJS.ProcessEnv;
  provider?: string;
  outDir?: string;
  botToken?: string;
  fetchImpl?: FetchLike;
  poster?: ReturnType<typeof createSlackPoster>;
}

export interface CanvasPublishInput {
  artifact?: CanvasArtifact & { files?: { summary?: string } };
  artifactId?: string;
  id?: string;
  title?: string;
  summaryMarkdown?: string;
  summaryPath?: string;
  destination?: string;
  channel?: string;
  threadTs?: string;
  thread_ts?: string;
  canvasId?: string;
  operation?: string;
  sectionId?: string;
  section_id?: string;
  dedupKey?: string;
  [key: string]: unknown;
}

interface PublishedCanvasManifest {
  id: string;
  provider: string;
  surface: string;
  artifactId: string;
  markdownPath: string;
  manifestPath: string;
  createdAt: string;
  ok: boolean;
  destination: string;
  slack: unknown;
  canvas: unknown;
  [key: string]: unknown;
}

export function createCanvasPublisher(options: CreateCanvasPublisherOptions = {}) {
  const config = getRuntimeConfig(options.env);
  const provider = normalizeProvider(options.provider || config.canvasPublisher);
  const outDir = resolve(options.outDir || config.canvasDir);
  const botToken = options.botToken || config.slackBotToken;
  const fetchImpl = options.fetchImpl || fetch;
  const poster =
    options.poster ||
    createSlackPoster({
      botToken,
      mock: config.slackPosterMock || !botToken,
      fetchImpl,
    });
  mkdirSync(outDir, { recursive: true });

  function listPublished(): PublishedCanvasManifest[] {
    if (!existsSync(outDir)) return [];
    return readdirSync(outDir)
      .filter((name) => name.endsWith(".json"))
      .map(
        (name) =>
          safeJsonParse<PublishedCanvasManifest>(readFileSync(join(outDir, name), "utf8")) as
            | PublishedCanvasManifest
            | null,
      )
      .filter((entry): entry is PublishedCanvasManifest => Boolean(entry))
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }

  async function publish(input: CanvasPublishInput = {}): Promise<PublishedCanvasManifest> {
    const artifact = input.artifact || {};
    const artifactId =
      input.artifactId || artifact.id || `meeting-${crypto.randomUUID().slice(0, 8)}`;
    const id = input.id || `canvas-${sanitizeId(artifactId)}-${crypto.randomUUID().slice(0, 8)}`;
    const createdAt = new Date().toISOString();
    const summaryMarkdown =
      input.summaryMarkdown ||
      readTextIfExists(input.summaryPath || artifact.files?.summary || "");
    const markdown = renderPublishMarkdown({
      artifact,
      summaryMarkdown,
      title: input.title,
    });
    const markdownPath = join(outDir, `${id}.md`);
    const manifestPath = join(outDir, `${id}.json`);
    writeFileSync(markdownPath, markdown);

    const result: PublishedCanvasManifest = {
      ok: true,
      id,
      provider,
      surface: provider,
      artifactId,
      markdownPath,
      manifestPath,
      createdAt,
      destination: input.destination || "",
      slack: null,
      canvas: null,
    };

    if (provider === "slack-canvas") {
      const canvas = input.canvasId
        ? await editSlackCanvas({
            botToken,
            canvasId: input.canvasId,
            markdown,
            operation: input.operation,
            sectionId: input.sectionId || input.section_id || "",
            fetchImpl,
          })
        : await createSlackCanvas({
            botToken,
            title: input.title || artifact.title || "Meeting summary",
            markdown,
            channel: input.channel || config.canvasSlackChannel,
            fetchImpl,
          });
      result.ok = canvas.ok;
      result.canvas = canvas;
      result.surface = "slack-canvas";
    } else if (provider === "slack-thread" || provider === "slack" || input.channel) {
      const post = await poster.postMessage({
        channel: input.channel || config.canvasSlackChannel,
        threadTs: input.threadTs || input.thread_ts || config.canvasSlackThreadTs,
        text: markdown.slice(0, 3500),
        dedupKey:
          input.dedupKey ||
          `post-meeting:${artifactId}:${input.channel || config.canvasSlackChannel}:${input.threadTs || input.thread_ts || config.canvasSlackThreadTs}`,
      });
      result.ok = post.ok;
      result.slack = post;
      result.surface = post.mock ? "mock-slack-thread" : "slack-thread";
    }

    writeFileSync(manifestPath, `${JSON.stringify(result, null, 2)}\n`);
    return result;
  }

  return {
    provider,
    outDir,
    publish,
    listPublished,
  };
}
