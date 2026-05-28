import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { getRuntimeConfig } from "../env.js";

interface TranscriptSegmentInput {
  speaker?: string;
  user?: string;
  name?: string;
  text?: string;
  startMs?: number | string | null;
  endMs?: number | string | null;
  timestamp?: string;
  ts?: string;
  source?: string;
  chunkIndex?: number | string;
  chunkPath?: string;
}

interface TranscriptLike {
  text?: string;
  segments?: TranscriptSegmentInput[];
}

interface ChatMessageInput {
  direction?: string;
  type?: string;
  source?: string;
  text?: string;
  message?: string;
  body?: string;
  links?: string[];
  timestamp?: string;
  ts?: string;
  createdAt?: string;
  sentAt?: string;
  messageId?: string;
  id?: string;
  eventId?: string;
  sender?: string;
  user?: string;
  name?: string;
  author?: string;
  deliveryState?: string;
  status?: string;
  error?: string;
}

interface AudioChunkInput {
  path?: string;
  audioPath?: string;
  filePath?: string;
}

interface MeetingArtifactInput {
  id?: string;
  artifactId?: string;
  meetingId?: string;
  sessionId?: string;
  title?: string;
  meetUrl?: string;
  transcriptText?: string;
  text?: string;
  transcript?: TranscriptLike;
  segments?: TranscriptSegmentInput[];
  captions?: TranscriptSegmentInput[];
  chatMessages?: ChatMessageInput[];
  meetChatMessages?: ChatMessageInput[];
  meetChat?: { messages?: ChatMessageInput[] };
  realtimeBridge?: { meetChat?: { messages?: ChatMessageInput[] } };
  audioChunks?: Array<string | AudioChunkInput>;
  audioChunkPaths?: Array<string | AudioChunkInput>;
  artifactDir?: string;
  audioPath?: string;
  sourceAudioPath?: string;
  audioMimeType?: string;
  audioBase64?: string;
  env?: NodeJS.ProcessEnv;
  rootDir?: string;
  asrProvider?: string;
  asrModel?: string;
  language?: string;
  context?: Record<string, unknown>;
  useAudioChunks?: boolean;
  participants?: string[];
  summary?: ReturnType<typeof buildFallbackSummary>;
  source?: string;
}

interface NormalizedSegment {
  speaker: string;
  text: string;
  startMs: number | null;
  endMs: number | null;
  timestamp: string;
  source: string;
  chunkIndex?: number;
  chunkPath?: string;
}

interface NormalizedChatMessage {
  direction: string;
  sender: string;
  text: string;
  timestamp: string;
  messageId: string;
  links: string[];
  source: string;
  deliveryState?: string;
  error?: string;
}

interface AsrPayload {
  audioPath: string;
  audioMimeType: string;
  captions: NormalizedSegment[];
  language: string;
  context: Record<string, unknown>;
  meeting: {
    id: string;
    title: string;
    meetUrl: string;
  };
}

interface AsrChunkResult {
  index: number;
  audioPath: string;
  provider: string;
  ok: boolean;
  text: string;
  textLength: number;
  segmentCount: number;
  error: string;
}

interface AsrProviderResult {
  ok: boolean;
  provider: string;
  language?: string;
  text?: string;
  transcriptText?: string;
  transcript?: TranscriptLike;
  segments?: TranscriptSegmentInput[];
  captions?: TranscriptSegmentInput[];
  chunks?: AsrChunkResult[];
  audioChunks?: string[];
  chunked?: boolean;
  model?: string;
  raw?: unknown;
  error?: string;
  detail?: string;
  debug?: string;
  skipped?: boolean;
}

interface AsrProviderResponse extends Partial<Omit<AsrProviderResult, "error">> {
  error?: string | { message?: string };
}

function slugify(value: unknown, fallback = "meeting"): string {
  const slug = String(value || "")
    .toLowerCase()
    .replace(/https?:\/\//g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || fallback;
}

function normalizeProvider(provider: unknown): string {
  return String(provider || "none")
    .trim()
    .toLowerCase()
    .replaceAll("_", "-");
}

function isAsrDisabledProvider(candidate: string): boolean {
  return ["none", "off", "disabled"].includes(candidate);
}

function isCaptionAsrProvider(candidate: string): boolean {
  return ["caption", "captions", "event"].includes(candidate);
}

function asrTranscriptHasContent(result: AsrProviderResult): boolean {
  return Boolean(
    String(result.text || result.transcriptText || result.transcript?.text || "").trim() ||
    (result.segments && result.segments.length > 0) ||
    (result.captions && result.captions.length > 0) ||
    (result.transcript?.segments && result.transcript.segments.length > 0),
  );
}

function audioAsrTranscriptProvider(result: AsrProviderResult, configuredProvider: string): string {
  const provider = normalizeProvider(result.provider || configuredProvider || "asr");
  return provider.startsWith("asr:") ? provider : `asr:${provider}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function normalizeAsrError(error: unknown): string {
  if (!error) return "";
  if (typeof error === "string") return error;
  if (typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return String(error);
}

function normalizeSegments(input: MeetingArtifactInput = {}): NormalizedSegment[] {
  const segments: NormalizedSegment[] = [];
  const sourceSegments = input.segments || input.captions || input.transcript?.segments || [];
  for (const segment of sourceSegments) {
    const text = String(segment?.text || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    const normalized: NormalizedSegment = {
      speaker: String(segment.speaker || segment.user || segment.name || "unknown"),
      text,
      startMs: Number.isFinite(Number(segment.startMs)) ? Number(segment.startMs) : null,
      endMs: Number.isFinite(Number(segment.endMs)) ? Number(segment.endMs) : null,
      timestamp: segment.timestamp || segment.ts || "",
      source: segment.source || "caption",
    };
    if (Number.isFinite(Number(segment.chunkIndex)))
      normalized.chunkIndex = Number(segment.chunkIndex);
    if (segment.chunkPath) normalized.chunkPath = String(segment.chunkPath);
    segments.push(normalized);
  }

  const transcriptText = String(
    input.transcriptText || input.transcript?.text || input.text || "",
  ).trim();
  if (!segments.length && transcriptText) {
    for (const [index, line] of transcriptText.split(/\n+/).entries()) {
      const text = line.replace(/\s+/g, " ").trim();
      if (!text) continue;
      segments.push({
        speaker: "unknown",
        text,
        startMs: null,
        endMs: null,
        timestamp: "",
        source: index === 0 ? "transcript_text" : "transcript_text_line",
      });
    }
  }

  return segments;
}

function extractUrls(text = ""): string[] {
  const matches = String(text || "").match(/https?:\/\/[^\s<>"')\]}]+/gi) || [];
  return matches.map((url) => url.replace(/[.,!?;:，。！？；：]+$/u, ""));
}

function normalizeChatDirection(entry: ChatMessageInput = {}): "incoming" | "outgoing" {
  const value = String(entry.direction || entry.type || "")
    .trim()
    .toLowerCase();
  if (value === "outgoing" || value === "sent" || value === "bot" || value === "assistant")
    return "outgoing";
  if (value === "incoming" || value === "received" || value === "user" || value === "participant")
    return "incoming";
  const source = String(entry.source || "")
    .trim()
    .toLowerCase();
  if (source.includes("send") || source.includes("outgoing") || source.includes("bot"))
    return "outgoing";
  return "incoming";
}

function normalizeChatMessages(input: MeetingArtifactInput = {}): NormalizedChatMessage[] {
  const sources = [
    ...(Array.isArray(input.chatMessages) ? input.chatMessages : []),
    ...(Array.isArray(input.meetChatMessages) ? input.meetChatMessages : []),
    ...(Array.isArray(input.meetChat?.messages) ? input.meetChat.messages : []),
    ...(Array.isArray(input.realtimeBridge?.meetChat?.messages)
      ? input.realtimeBridge.meetChat.messages
      : []),
  ];
  const seen = new Set();
  const messages: NormalizedChatMessage[] = [];
  for (const [index, entry] of sources.entries()) {
    const text = String(entry?.text || entry?.message || entry?.body || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    const links = Array.from(
      new Set(
        [...(Array.isArray(entry.links) ? entry.links.map(String) : []), ...extractUrls(text)]
          .map((url) => url.trim())
          .filter(Boolean),
      ),
    );
    const direction = normalizeChatDirection(entry);
    const timestamp = String(
      entry.timestamp || entry.ts || entry.createdAt || entry.sentAt || nowIso(),
    );
    const messageId = String(
      entry.messageId || entry.id || entry.eventId || `${direction}:${timestamp}:${index}:${text}`,
    ).slice(0, 180);
    const dedupeKey = `${direction}|${messageId}|${text}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const normalized: NormalizedChatMessage = {
      direction,
      sender: String(
        entry.sender ||
          entry.user ||
          entry.name ||
          entry.author ||
          (direction === "outgoing" ? "bot" : "participant"),
      ),
      text,
      timestamp,
      messageId,
      links,
      source: String(entry.source || "meet-chat"),
    };
    if (entry.deliveryState || entry.status)
      normalized.deliveryState = String(entry.deliveryState || entry.status);
    if (entry.error) normalized.error = String(entry.error);
    messages.push(normalized);
  }
  return messages;
}

function isAudioChunkName(fileName: unknown): boolean {
  return /^audio_chunk_\d+\.(?:mp3|wav|m4a|ogg)$/i.test(String(fileName || ""));
}

function inferAudioMimeType(filePath: unknown, fallback = ""): string {
  const ext = extname(String(filePath || "")).toLowerCase();
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".m4a") return "audio/mp4";
  if (ext === ".ogg") return "audio/ogg";
  if (ext === ".wav") return "audio/wav";
  return fallback || "application/octet-stream";
}

function normalizePathList(paths: Array<string | AudioChunkInput> = []): string[] {
  const seen = new Set();
  const normalized = [];
  for (const value of paths) {
    const filePath =
      typeof value === "string" ? value : value?.path || value?.audioPath || value?.filePath || "";
    if (!filePath || !existsSync(filePath)) continue;
    const resolved = resolve(filePath);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    normalized.push(resolved);
  }
  return normalized.toSorted((a, b) => basename(a).localeCompare(basename(b)));
}

function discoverAudioChunks(input: MeetingArtifactInput = {}): string[] {
  const explicit = normalizePathList([
    ...(Array.isArray(input.audioChunks) ? input.audioChunks : []),
    ...(Array.isArray(input.audioChunkPaths) ? input.audioChunkPaths : []),
  ]);
  if (explicit.length) return explicit;

  const dirs = new Set<string>();
  if (input.artifactDir) dirs.add(resolve(input.artifactDir));
  if (input.audioPath) dirs.add(resolve(dirname(input.audioPath)));
  if (input.sourceAudioPath) dirs.add(resolve(dirname(input.sourceAudioPath)));
  const paths: string[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && isAudioChunkName(entry.name)) paths.push(join(dir, entry.name));
    }
  }
  return normalizePathList(paths);
}

function materializeAudioChunks(input: MeetingArtifactInput = {}, dir: string): string[] {
  const chunks = discoverAudioChunks(input);
  const materialized: string[] = [];
  for (const chunkPath of chunks) {
    const target = join(dir, basename(chunkPath));
    if (resolve(chunkPath) !== resolve(target)) {
      writeFileSync(target, readFileSync(chunkPath));
      materialized.push(target);
    } else {
      materialized.push(chunkPath);
    }
  }
  return normalizePathList(materialized);
}

function extractLineItems(segments: NormalizedSegment[], pattern: RegExp): string[] {
  const items: string[] = [];
  for (const segment of segments) {
    const text = segment.text.trim();
    if (pattern.test(text)) items.push(text);
  }
  return items.slice(0, 8);
}

function buildFallbackSummary({
  title,
  segments,
  participants = [],
  meetUrl = "",
}: {
  title?: string;
  segments: NormalizedSegment[];
  participants?: string[];
  meetUrl?: string;
}) {
  const body = segments
    .map((segment) => segment.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const sentences = body
    .split(/(?<=[.!?。！？])\s+/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const highlights = sentences.slice(0, 5);
  if (!highlights.length && body) highlights.push(body.slice(0, 600));
  const decisions = extractLineItems(segments, /决定|决议|decision|decided|we will|我们会/i);
  const actionItems = extractLineItems(
    segments,
    /todo|action|follow up|跟进|处理|需要|要做|owner/i,
  );

  return {
    title: title || "Meeting summary",
    meetUrl,
    participants,
    highlights,
    decisions,
    actionItems,
    summaryText: highlights.join("\n"),
  };
}

function renderSummaryMarkdown(summary, artifact) {
  const lines = [
    `# ${summary.title || artifact.title || "Meeting summary"}`,
    "",
    `- Meeting: ${artifact.meetUrl || summary.meetUrl || "unknown"}`,
    `- Artifact: ${artifact.id}`,
    `- Created: ${artifact.createdAt}`,
  ];
  if (summary.participants?.length)
    lines.push(`- Participants: ${summary.participants.join(", ")}`);
  lines.push("", "## Highlights", "");
  for (const item of summary.highlights || []) lines.push(`- ${item}`);
  if (!(summary.highlights || []).length) lines.push("- No highlights captured yet.");

  lines.push("", "## Decisions", "");
  for (const item of summary.decisions || []) lines.push(`- ${item}`);
  if (!(summary.decisions || []).length) lines.push("- No explicit decisions captured.");

  lines.push("", "## Action Items", "");
  for (const item of summary.actionItems || []) lines.push(`- ${item}`);
  if (!(summary.actionItems || []).length) lines.push("- No explicit action items captured.");

  lines.push("", "## Transcript", "");
  lines.push(`- JSON: ${artifact.files.transcript}`);
  if (artifact.files.audio) lines.push(`- Audio: ${artifact.files.audio}`);
  if (artifact.files.audioChunks?.length)
    lines.push(`- Audio chunks: ${artifact.files.audioChunks.length}`);
  if (artifact.files.chat) lines.push(`- Meet chat JSON: ${artifact.files.chat}`);
  return `${lines.join("\n")}\n`;
}

function runCommandProvider({
  command,
  payload,
  env,
}: {
  command: string;
  payload: AsrPayload;
  env: NodeJS.ProcessEnv;
}): Promise<AsrProviderResult> {
  return new Promise((resolveResult) => {
    const child = spawn(command, [], {
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      resolveResult({
        ok: false,
        provider: "command",
        error: "asr_command_failed_to_start",
        detail: String(error?.message || error),
      });
    });
    child.on("close", (code) => {
      const parsed = safeJsonParse<AsrProviderResponse>(stdout, {});
      resolveResult({
        ok: code === 0 && parsed.ok !== false,
        provider: "command",
        ...parsed,
        error:
          code === 0
            ? normalizeAsrError(parsed.error)
            : normalizeAsrError(parsed.error) || stderr.trim() || `ASR command exited ${code}`,
        debug: stderr.trim(),
      });
    });
    child.stdin.end(JSON.stringify(payload, null, 2));
  });
}

async function runHttpProvider({
  url,
  payload,
}: {
  url: string;
  payload: AsrPayload;
}): Promise<AsrProviderResult> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  const parsed = safeJsonParse<AsrProviderResponse>(text, {});
  return {
    ok: response.ok && parsed.ok !== false,
    provider: "http",
    ...parsed,
    error: response.ok
      ? normalizeAsrError(parsed.error)
      : normalizeAsrError(parsed.error) || `ASR HTTP provider returned ${response.status}`,
  };
}

async function runOpenAiTranscriptionProvider({
  config,
  payload,
}: {
  config: ReturnType<typeof getRuntimeConfig>;
  payload: AsrPayload;
}): Promise<AsrProviderResult> {
  if (!config.openaiApiKey)
    return {
      ok: false,
      provider: "openai",
      error: "MAB_OPENAI_API_KEY/OPENAI_API_KEY is required",
    };
  if (!payload.audioPath || !existsSync(payload.audioPath))
    return { ok: false, provider: "openai", error: "audioPath is required for OpenAI ASR" };
  const form = new FormData();
  form.append("model", config.asrModel || "gpt-4o-mini-transcribe");
  form.append("response_format", "json");
  if (payload.language && payload.language !== "auto") form.append("language", payload.language);
  const buffer = readFileSync(payload.audioPath);
  const mimeType =
    payload.audioMimeType || (payload.audioPath.endsWith(".mp3") ? "audio/mpeg" : "audio/wav");
  form.append("file", new Blob([buffer], { type: mimeType }), basename(payload.audioPath));

  const response = await fetch(config.openaiAudioTranscriptionsUrl, {
    method: "POST",
    headers: { authorization: `Bearer ${config.openaiApiKey}` },
    body: form,
  });
  const text = await response.text();
  const parsed = safeJsonParse<AsrProviderResponse>(text, {});
  const transcriptText = typeof parsed.text === "string" ? parsed.text : text;
  return {
    ok: response.ok,
    provider: "openai",
    model: config.asrModel,
    text: response.ok ? transcriptText : "",
    raw: parsed,
    error: response.ok
      ? ""
      : normalizeAsrError(parsed.error) || text || `OpenAI ASR returned ${response.status}`,
  };
}

export function createMeetingArtifactPipeline(options: MeetingArtifactInput = {}) {
  const config = getRuntimeConfig(options.env);
  const rootDir = resolve(options.rootDir || config.meetingArtifactsDir);
  const provider = normalizeProvider(options.asrProvider || config.asrProvider);
  const env = options.env || process.env;
  mkdirSync(rootDir, { recursive: true });

  function buildAsrPayload(
    input: MeetingArtifactInput = {},
    audioPath = input.audioPath || "",
  ): AsrPayload {
    return {
      audioPath,
      audioMimeType: input.audioMimeType || inferAudioMimeType(audioPath, ""),
      captions: normalizeSegments(input),
      language: input.language || config.asrLanguage,
      context: input.context || {},
      meeting: {
        id: input.meetingId || input.sessionId || "",
        title: input.title || "",
        meetUrl: input.meetUrl || "",
      },
    };
  }

  async function runSingleAsr(payload: AsrPayload): Promise<AsrProviderResult> {
    if (isAsrDisabledProvider(provider)) {
      return {
        ok: true,
        provider,
        skipped: true,
        language: payload.language,
      };
    }
    if (isCaptionAsrProvider(provider)) {
      return {
        ok: false,
        provider,
        language: payload.language,
        error: "Captions are not a valid ASR provider; ASR must be derived from recorded audio.",
      };
    }
    if (provider === "command") {
      if (!config.asrCommand)
        return {
          ok: false,
          provider,
          error: "MAB_ASR_COMMAND is required when MAB_ASR_PROVIDER=command",
        };
      return await runCommandProvider({ command: config.asrCommand, payload, env });
    }
    if (provider === "http" || provider === "http-json") {
      if (!config.asrHttpUrl)
        return {
          ok: false,
          provider,
          error: "MAB_ASR_HTTP_URL is required when MAB_ASR_PROVIDER=http",
        };
      return await runHttpProvider({ url: config.asrHttpUrl, payload });
    }
    if (provider === "openai" || provider === "openai-transcribe" || provider === "openai-audio") {
      return await runOpenAiTranscriptionProvider({ config, payload });
    }
    return { ok: false, provider, error: `Unsupported MAB_ASR_PROVIDER provider: ${provider}` };
  }

  async function runChunkedAsr(
    basePayload: AsrPayload,
    audioChunks: string[],
  ): Promise<AsrProviderResult> {
    const chunks: AsrChunkResult[] = [];
    const segments: NormalizedSegment[] = [];
    const textParts: string[] = [];
    for (const [index, audioPath] of audioChunks.entries()) {
      const chunkPayload = {
        ...basePayload,
        audioPath,
        audioMimeType: inferAudioMimeType(audioPath, basePayload.audioMimeType),
        captions: [],
        context: {
          ...basePayload.context,
          chunkIndex: index,
          chunkCount: audioChunks.length,
          parentAudioPath: basePayload.audioPath || "",
        },
      };
      const result = await runSingleAsr(chunkPayload);
      const chunkText = String(
        result.text || result.transcriptText || result.transcript?.text || "",
      ).trim();
      const chunkSegments = normalizeSegments({
        segments: result.segments || result.captions || result.transcript?.segments || [],
        transcriptText: chunkText,
      }).map((segment) =>
        Object.assign({}, segment, {
          source: segment.source?.includes("chunk")
            ? segment.source
            : `${segment.source || result.provider || provider}_chunk`,
          chunkIndex: index,
          chunkPath: audioPath,
        }),
      );
      segments.push(...chunkSegments);
      if (chunkText) textParts.push(chunkText);
      chunks.push({
        index,
        audioPath,
        provider: result.provider || provider,
        ok: result.ok !== false,
        text: chunkText,
        textLength: chunkText.length,
        segmentCount: chunkSegments.length,
        error: result.error || "",
      });
    }

    const failed = chunks.filter((chunk) => !chunk.ok);
    return {
      ok: failed.length === 0,
      provider,
      chunked: true,
      language: basePayload.language,
      audioChunks,
      chunks,
      segments,
      text: textParts.join("\n"),
      error: failed
        .map((chunk) => chunk.error)
        .filter(Boolean)
        .join("; "),
    };
  }

  async function runAsr(input: MeetingArtifactInput = {}): Promise<AsrProviderResult> {
    const payload = buildAsrPayload(input);
    const audioChunks = discoverAudioChunks(input);
    if (isAsrDisabledProvider(provider)) return await runSingleAsr(payload);
    if (isCaptionAsrProvider(provider)) return await runSingleAsr(payload);
    if (!payload.audioPath && audioChunks.length === 0) {
      return {
        ok: false,
        provider,
        language: payload.language,
        error:
          "audioPath or audioChunks are required for ASR; captions are not allowed as ASR fallback.",
      };
    }
    if (input.useAudioChunks !== false && audioChunks.length) {
      return await runChunkedAsr(payload, audioChunks);
    }

    return await runSingleAsr(payload);
  }

  function artifactPath(id) {
    return join(rootDir, id);
  }

  async function postProcessMeeting(input: MeetingArtifactInput = {}) {
    const createdAt = nowIso();
    const id =
      input.id ||
      input.artifactId ||
      `${slugify(input.meetingId || input.sessionId || input.title || input.meetUrl)}-${crypto.randomUUID().slice(0, 8)}`;
    const dir = artifactPath(id);
    mkdirSync(dir, { recursive: true });

    const sourceAudioPath = input.audioPath || "";
    let audioPath = sourceAudioPath;
    if (input.audioBase64) {
      const ext = input.audioMimeType?.includes("mpeg") ? "mp3" : "wav";
      audioPath = join(dir, `audio.${ext}`);
      writeFileSync(audioPath, Buffer.from(input.audioBase64, "base64"));
    } else if (audioPath && existsSync(audioPath)) {
      const target = join(dir, basename(audioPath));
      if (resolve(audioPath) !== resolve(target)) {
        writeFileSync(target, readFileSync(audioPath));
        audioPath = target;
      }
    }

    const audioChunks = materializeAudioChunks(
      { ...input, audioPath, sourceAudioPath, artifactDir: dir },
      dir,
    );
    const asr = await runAsr({ ...input, audioPath, audioChunks, artifactDir: dir });
    if (asr.ok === false) {
      // ASR is strictly audio-derived. Captions can still be archived as their
      // own source, but they must not silently replace a failed audio ASR pass.
      throw new Error(
        `audio ASR failed; captions are not allowed as ASR fallback: ${
          asr.error || `provider ${provider} returned ok=false`
        }`,
      );
    }
    if (!asr.skipped && !asrTranscriptHasContent(asr)) {
      throw new Error(
        "audio ASR returned an empty transcript; captions are not allowed as ASR fallback",
      );
    }
    const captionTranscriptSource = {
      segments: input.segments || input.captions || input.transcript?.segments || [],
      transcriptText: input.transcriptText || input.transcript?.text || input.text,
    };
    const captionSegments = normalizeSegments(captionTranscriptSource);
    const audioAsrTranscriptSource = {
      segments: asr.segments || asr.captions || asr.transcript?.segments || [],
      transcriptText: asr.text || asr.transcriptText || asr.transcript?.text,
    };
    const audioAsrSegments = normalizeSegments(audioAsrTranscriptSource);
    // Captions are not ASR, but they keep the best speaker labels for the
    // transcript; audio ASR becomes the transcript only when captions are absent.
    const segments = asr.skipped
      ? captionSegments
      : captionSegments.length
        ? captionSegments
        : audioAsrSegments;
    const transcriptProvider = asr.skipped
      ? segments.some((segment) => segment.source.includes("caption"))
        ? "caption"
        : "input"
      : captionSegments.length
        ? "caption"
        : audioAsrTranscriptProvider(asr, provider);
    const transcript = {
      schema: "meeting-avatar-bot.transcript.v1",
      id,
      provider: transcriptProvider,
      ok: true,
      language: asr.language || input.language || config.asrLanguage,
      text: segments.map((segment) => segment.text).join("\n"),
      segments,
      chunks: (asr.chunks || []).map((chunk) => ({
        index: chunk.index,
        provider: chunk.provider,
        ok: chunk.ok,
        textLength: chunk.textLength,
        segmentCount: chunk.segmentCount,
        error: chunk.error || "",
      })),
      error: asr.error || "",
      createdAt,
    };

    const participants = input.participants || [
      ...new Set(
        segments
          .map((segment) => segment.speaker)
          .filter((speaker) => speaker && speaker !== "unknown"),
      ),
    ];
    const chatMessages = normalizeChatMessages(input);
    const chatLinks = Array.from(new Set(chatMessages.flatMap((message) => message.links)));
    const summary =
      input.summary ||
      buildFallbackSummary({
        title: input.title,
        segments,
        participants,
        meetUrl: input.meetUrl,
      });

    const files = {
      transcript: join(dir, "transcript.json"),
      summary: join(dir, "summary.md"),
      manifest: join(dir, "manifest.json"),
      chat: join(dir, "chat.json"),
      audio: audioPath || "",
      audioChunks,
    };
    const artifact = {
      schema: "meeting-avatar-bot.meeting-artifact.v1",
      id,
      title: input.title || summary.title || "Meeting summary",
      meetingId: input.meetingId || input.sessionId || "",
      sessionId: input.sessionId || "",
      meetUrl: input.meetUrl || "",
      dir,
      createdAt,
      updatedAt: createdAt,
      files,
      transcript: {
        provider: transcript.provider,
        segmentCount: segments.length,
        textLength: transcript.text.length,
        chunkCount: audioChunks.length,
      },
      chat: {
        messageCount: chatMessages.length,
        linkCount: chatLinks.length,
        latestAt: chatMessages.at(-1)?.timestamp || "",
      },
      summary: {
        highlights: summary.highlights || [],
        decisions: summary.decisions || [],
        actionItems: summary.actionItems || [],
      },
      source: input.source || "post-meeting",
    };
    const chat = {
      schema: "meeting-avatar-bot.meet-chat.v1",
      id,
      meetingId: artifact.meetingId,
      sessionId: artifact.sessionId,
      meetUrl: artifact.meetUrl,
      messageCount: chatMessages.length,
      linkCount: chatLinks.length,
      links: chatLinks,
      messages: chatMessages,
      createdAt,
    };

    writeFileSync(files.transcript, `${JSON.stringify(transcript, null, 2)}\n`);
    writeFileSync(files.chat, `${JSON.stringify(chat, null, 2)}\n`);
    writeFileSync(files.summary, renderSummaryMarkdown(summary, artifact));
    writeFileSync(files.manifest, `${JSON.stringify(artifact, null, 2)}\n`);
    return { ok: true, artifact, transcript, summary, chat, asr };
  }

  function getArtifact(id) {
    if (!id) return null;
    const manifestPath = join(artifactPath(id), "manifest.json");
    if (!existsSync(manifestPath)) return null;
    return safeJsonParse(readFileSync(manifestPath, "utf8"), null);
  }

  function getArtifactChat(id) {
    const artifact = getArtifact(id);
    const chatPath = artifact?.files?.chat;
    if (!chatPath || !existsSync(chatPath)) return null;
    return safeJsonParse(readFileSync(chatPath, "utf8"), null);
  }

  function listArtifacts() {
    if (!existsSync(rootDir)) return [];
    return readdirSync(rootDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => getArtifact(entry.name))
      .filter(Boolean)
      .toSorted((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }

  return {
    provider,
    rootDir,
    postProcessMeeting,
    getArtifact,
    getArtifactChat,
    listArtifacts,
  };
}
