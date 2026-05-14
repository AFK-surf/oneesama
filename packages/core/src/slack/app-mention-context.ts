export const MAX_APP_MENTION_THREAD_MESSAGES = 50;

const MEET_URL_RE =
  /https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}(?:[/?#][^\s<>\])}]*)?/i;

export interface SlackTextObject {
  type?: string;
  text?: string;
  plain_text?: string;
  [key: string]: unknown;
}

export interface SlackFileLike {
  id?: string;
  ID?: string;
  name?: string;
  Name?: string;
  title?: string;
  Title?: string;
  filetype?: string;
  Filetype?: string;
  file_type?: string;
  type?: string;
  mimetype?: string;
  Mimetype?: string;
  mime_type?: string;
  size?: number;
  Size?: number;
  permalink?: string;
  Permalink?: string;
  url?: string;
  url_private?: string;
  url_private_download?: string;
  URLPrivate?: string;
  image_url?: string;
  imageUrl?: string;
  data_url?: string;
  dataUrl?: string;
  [key: string]: unknown;
}

export interface SlackBlockShape {
  type?: string;
  block_id?: string;
  text?: SlackTextObject | string;
  fields?: SlackTextObject[];
  elements?: Array<SlackTextObject & { type?: string; url?: string }>;
  [key: string]: unknown;
}

export interface SlackAttachmentShape {
  files?: SlackFileLike[];
  Files?: SlackFileLike[];
  attachments?: SlackAttachmentShape[];
  Attachments?: SlackAttachmentShape[];
  [key: string]: unknown;
}

export interface SlackMessageShape {
  ts?: string;
  type?: string;
  user?: string;
  user_id?: string;
  userId?: string;
  username?: string;
  user_name?: string;
  name?: string;
  bot_id?: string;
  bot_profile?: { name?: string; [key: string]: unknown };
  botProfile?: { name?: string; [key: string]: unknown };
  user_profile?: { display_name?: string; real_name?: string; [key: string]: unknown };
  profile?: { display_name?: string; real_name?: string; [key: string]: unknown };
  text?: string;
  blocks?: SlackBlockShape[];
  files?: SlackFileLike[];
  Files?: SlackFileLike[];
  attachments?: SlackAttachmentShape[];
  Attachments?: SlackAttachmentShape[];
  thread_ts?: string;
  event_ts?: string;
  permalink?: string;
  subtype?: string;
  [key: string]: unknown;
}

function text(value: unknown): string {
  return String(value || "").trim();
}

function truncate(value: unknown, maxLength: number): string {
  const normalized = String(value || "");
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}...`;
}

function normalizeComparableText(value: unknown): string {
  return String(value || "")
    .replaceAll("*", "")
    .replaceAll("_", "")
    .replaceAll("`", "")
    .replaceAll("~", "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function valueFromPath(object: unknown, paths: string[][] = []): unknown {
  for (const path of paths) {
    let current: unknown = object;
    for (const segment of path) {
      if (current && typeof current === "object") {
        current = (current as Record<string, unknown>)[segment];
      } else {
        current = undefined;
      }
      if (current === undefined || current === null) break;
    }
    if (current !== undefined && current !== null && String(current).trim() !== "") return current;
  }
  return "";
}

type ResolveName = ((userId: string) => string | undefined | null) | null;

function userLabel(
  message: SlackMessageShape = {},
  botUserId: string = "",
  resolveName: ResolveName = null,
): string {
  const userId = text(message.user || message.user_id || message.userId);
  const isBotSelf = botUserId && userId === botUserId;
  let name = "";
  if (resolveName && userId) name = text(resolveName(userId));
  name ||= text(
    valueFromPath(message, [
      ["user_profile", "display_name"],
      ["user_profile", "real_name"],
      ["profile", "display_name"],
      ["profile", "real_name"],
    ]),
  );
  name ||= text(message.username || message.user_name || message.name);
  name ||= userId || "bot";

  const botName = text(
    valueFromPath(message, [
      ["bot_profile", "name"],
      ["botProfile", "name"],
    ]),
  );
  if (!isBotSelf && message.bot_id && botName) name = botName;
  if (isBotSelf) return `${name} [assistant]`;
  if (message.bot_id) return `${name} [app]`;
  return name;
}

function resolveTextMentions(value: unknown = "", resolveName: ResolveName = null): string {
  if (!resolveName) return String(value || "");
  return String(value || "").replace(/<@([A-Z0-9]+)>/g, (_match, userId) => {
    const name = text(resolveName(userId));
    return name ? `@${name}` : `<@${userId}>`;
  });
}

function slackTextObjectText(value: SlackTextObject | string | undefined = ""): string {
  if (typeof value === "string") return value;
  return value?.text || value?.plain_text || "";
}

function blockTextLines(blocks: SlackBlockShape[] = [], resolveName: ResolveName = null): string[] {
  const lines: string[] = [];
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (!block || block.block_id === "reply_feedback" || block.block_id === "reply_feedback_saved")
      continue;
    if (block.type === "section") {
      const sectionText = slackTextObjectText(block.text);
      if (sectionText) lines.push(resolveTextMentions(sectionText, resolveName));
      for (const field of block.fields || []) {
        const fieldText = slackTextObjectText(field);
        if (fieldText) lines.push(resolveTextMentions(fieldText, resolveName));
      }
      continue;
    }
    if (block.type === "header") {
      const header = slackTextObjectText(block.text);
      if (header) lines.push(`[header: ${header}]`);
      continue;
    }
    if (block.type === "context") {
      for (const element of block.elements || []) {
        const contextText = slackTextObjectText(element);
        if (contextText)
          lines.push(`[context: ${truncate(resolveTextMentions(contextText, resolveName), 200)}]`);
      }
      continue;
    }
    if (block.type === "actions") {
      for (const element of block.elements || []) {
        if (element.type !== "button" || !element.url) continue;
        const label = slackTextObjectText(element.text);
        lines.push(`[button: ${label} <${element.url}>]`);
      }
    }
  }
  return lines;
}

function messageFiles(message: SlackMessageShape = {}): SlackFileLike[] {
  return Array.isArray(message.files)
    ? message.files
    : Array.isArray(message.Files)
      ? message.Files
      : [];
}

function messageAttachments(message: SlackMessageShape = {}): SlackAttachmentShape[] {
  return Array.isArray(message.attachments)
    ? message.attachments
    : Array.isArray(message.Attachments)
      ? message.Attachments
      : [];
}

interface NormalizedSlackFile {
  id: string;
  name: string;
  title: string;
  filetype: string;
  mimetype: string;
  size: number;
  permalink: string;
  urlPrivate: string;
  imageUrl: string;
}

function normalizeFile(file: SlackFileLike = {}): NormalizedSlackFile {
  return {
    id: text(file.id || file.ID),
    name: text(file.name || file.Name || file.title || file.Title || file.id || file.ID || "file"),
    title: text(file.title || file.Title || file.name || file.Name),
    filetype: text(file.filetype || file.Filetype || file.file_type || file.type),
    mimetype: text(file.mimetype || file.Mimetype || file.mime_type),
    size: Number(file.size || file.Size || 0),
    permalink: text(
      file.permalink || file.Permalink || file.url || file.url_private || file.url_private_download,
    ),
    urlPrivate: text(file.url_private || file.url_private_download || file.URLPrivate),
    imageUrl: text(file.image_url || file.imageUrl || file.data_url || file.dataUrl || file.url),
  };
}

function attachmentFiles(attachment: SlackAttachmentShape = {}): SlackFileLike[] {
  return Array.isArray(attachment.files)
    ? attachment.files
    : Array.isArray(attachment.Files)
      ? attachment.Files
      : [];
}

export function extractCanvasFilesFromAttachments(
  messages: SlackMessageShape[] = [],
): NormalizedSlackFile[] {
  const files: NormalizedSlackFile[] = [];
  for (const message of messages) {
    for (const attachment of messageAttachments(message)) {
      for (const file of attachmentFiles(attachment)) {
        const normalized = normalizeFile(file);
        if (normalized.filetype === "quip" || normalized.mimetype.includes("slack-docs"))
          files.push(normalized);
      }
    }
  }
  return files;
}

function mergeAttachmentCanvasFiles(messages: SlackMessageShape[] = []) {
  const cloned: SlackMessageShape[] = messages.map((message) => ({ ...message }));
  const canvasFiles = extractCanvasFilesFromAttachments(cloned);
  if (canvasFiles.length && cloned[0]) {
    cloned[0].files = [
      ...messageFiles(cloned[0]),
      ...(canvasFiles as unknown as SlackFileLike[]),
    ];
  }
  return { messages: cloned, canvasFiles };
}

export function stripSlackBotMention(value: unknown = "", botUserId: string = ""): string {
  const source = String(value || "");
  if (botUserId) return source.replaceAll(`<@${botUserId}>`, "").trim();
  return source.replace(/<@[^>]+>\s*/g, "").trim();
}

export function findGoogleMeetUrl(value: unknown = ""): string {
  const match = String(value || "").match(MEET_URL_RE)?.[0] || "";
  return match.replace(/[.,;:!?\]\)}>]+$/g, "");
}

export function containsGoogleMeetUrl(value: unknown = ""): boolean {
  return Boolean(findGoogleMeetUrl(value));
}

export interface FormatSlackThreadOptions {
  botUserId?: string;
  resolveName?: ResolveName;
  limit?: number;
  [key: string]: unknown;
}

export function formatSlackThreadTranscript(
  messages: SlackMessageShape[] = [],
  options: FormatSlackThreadOptions = {},
) {
  const botUserId = text(options.botUserId);
  const resolveName = options.resolveName || null;
  const lines = [];
  const limited = messages.slice(0, options.limit || MAX_APP_MENTION_THREAD_MESSAGES);
  for (const message of limited) {
    const userId = text(message.user || message.user_id || message.userId);
    const isBotSelf = botUserId && userId === botUserId;
    const subtype = text(message.subtype || message.subType);
    if (!isBotSelf && subtype && subtype !== "bot_message") continue;

    const attachments = messageAttachments(message);
    const files = messageFiles(message).map(normalizeFile);
    const blocks = Array.isArray(message.blocks) ? message.blocks : [];
    const rawText = text(resolveTextMentions(message.text || "", resolveName));
    const blockLines = blockTextLines(blocks, resolveName);
    if (isBotSelf && !rawText && !blockLines.length && !attachments.length && !files.length)
      continue;
    if (!isBotSelf && !rawText && !blockLines.length && !attachments.length && !files.length)
      continue;

    const messageLines = [];
    const seen = new Set();
    const addLine = (line) => {
      const trimmed = text(line);
      const key = normalizeComparableText(trimmed);
      if (!trimmed || !key || seen.has(key)) return;
      seen.add(key);
      messageLines.push(trimmed);
    };
    if (rawText && !(isBotSelf && blockLines.length)) addLine(rawText);
    for (const line of blockLines) addLine(line);
    if (rawText && !messageLines.length) addLine(rawText);

    const ts = text(message.ts || message.timestamp || message.event_ts);
    const prefix = `[ts:${ts}] ${userLabel(message, botUserId, resolveName)}`;
    const rendered = messageLines.length ? `${prefix}: ${messageLines[0]}` : `${prefix}:`;
    lines.push(rendered);
    for (const line of messageLines.slice(1)) lines.push(`  ${line}`);

    for (const attachment of attachments) {
      const title = text(attachment.title || attachment.Title);
      const titleLink = text(attachment.title_link || attachment.titleLink || attachment.TitleLink);
      const attText = text(attachment.text || attachment.Text);
      if (title || titleLink) {
        lines.push(
          `  [attachment${title ? `: ${title}` : ""}${titleLink ? ` <${titleLink}>` : ""}]`,
        );
      }
      if (attText) lines.push(`  ${truncate(attText, 300)}`);
    }

    for (const file of files) {
      if (file.filetype === "quip" || file.mimetype.includes("slack-docs")) {
        lines.push(`  [canvas: "${file.title || file.name}" canvas_id=${file.id}]`);
      } else {
        const fileLine = [
          `  [file: ${file.name}`,
          `type=${file.filetype || file.mimetype || "unknown"}`,
          `size=${file.size || 0}`,
          file.permalink ? `<${file.permalink}>` : "",
        ]
          .filter(Boolean)
          .join(" ");
        lines.push(`${fileLine}]`);
      }
    }

    if (Array.isArray(message.reactions) && message.reactions.length) {
      const reactions = message.reactions
        .map(
          (reaction) =>
            `:${reaction.name || reaction.emoji || "reaction"}: x${reaction.count || 1}`,
        )
        .join(", ");
      lines.push(`  [reactions: ${reactions}]`);
    }
  }
  return lines.join("\n").trim();
}

export interface ExtractSlackThreadMediaOptions {
  botUserId?: string;
}

export function extractSlackThreadMedia(
  messages: SlackMessageShape[] = [],
  options: ExtractSlackThreadMediaOptions = {},
) {
  const botUserId = text(options.botUserId);
  const images = [];
  const files = [];
  const canvasFiles = [];
  for (const message of messages) {
    const userId = text(message.user || message.user_id || message.userId);
    const subtype = text(message.subtype || message.subType);
    if (botUserId && userId === botUserId) continue;
    if (subtype && subtype !== "bot_message") continue;
    for (const rawFile of messageFiles(message)) {
      const file = normalizeFile(rawFile);
      const isCanvas = file.filetype === "quip" || file.mimetype.includes("slack-docs");
      const isImage =
        file.mimetype.startsWith("image/") ||
        ["jpg", "jpeg", "png", "gif", "webp"].includes(file.filetype);
      if (isCanvas) canvasFiles.push(file);
      files.push(file);
      if (isImage) {
        images.push({
          id: file.id,
          name: file.name,
          mimetype: file.mimetype,
          size: file.size,
          permalink: file.permalink,
          imageUrl: file.imageUrl && !file.urlPrivate ? file.imageUrl : "",
          source: file.imageUrl && !file.urlPrivate ? "inline" : "metadata_only",
        });
      }
    }
  }
  return { files, images, canvasFiles };
}

function uniqueFiles(files: NormalizedSlackFile[] = []): NormalizedSlackFile[] {
  const seen = new Set<string>();
  const result: NormalizedSlackFile[] = [];
  for (const file of files) {
    const key = [file.id, file.name, file.filetype, file.mimetype].join(":");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(file);
  }
  return result;
}

export interface SlackAssistantThreadParentInfo {
  user?: string;
  userName?: string;
  userId?: string;
  botId?: string;
  ts?: string;
  isBotParent?: boolean;
}

export interface BuildSlackAssistantThreadMessageInput {
  channelId?: string;
  threadTs?: string;
  threadPermalink?: string;
  userId?: string;
  mentionText?: string;
  transcript?: string;
  meetingContext?: string;
  durableContext?: string;
  parentInfo?: SlackAssistantThreadParentInfo;
}

export function buildSlackAssistantThreadMessage(
  input: BuildSlackAssistantThreadMessageInput = {},
): string {
  const parentInfo: SlackAssistantThreadParentInfo = input.parentInfo || {};
  const parentAuthor =
    text(parentInfo.userName || parentInfo.user || parentInfo.userId) || "unknown";
  const lines = [
    "Thread metadata:",
    `- channel: ${text(input.channelId) || "unknown"}`,
    `- thread_ts: ${text(input.threadTs) || "unknown"}`,
  ];
  if (input.threadPermalink) lines.push(`- thread_permalink: ${input.threadPermalink}`);
  lines.push(
    `- thread started by: ${parentAuthor}${parentInfo.isBotParent ? " (assistant or app message)" : ""}`,
  );
  if (input.durableContext) lines.push("", "Durable context:", input.durableContext);
  if (input.transcript) lines.push("", "Thread context:", "", input.transcript);
  if (input.meetingContext) lines.push("", "---", "Live meeting status:", input.meetingContext);
  lines.push(
    "",
    "---",
    `User <@${text(input.userId) || "unknown"}> says:`,
    text(input.mentionText),
  );
  return lines.join("\n").trim();
}

export interface BuildSlackAppMentionContextInput {
  botUserId?: string;
  event?: SlackMessageShape;
  channelId?: string;
  threadTs?: string;
  userId?: string;
  resolveName?: ResolveName;
  messages?: SlackMessageShape[];
  text?: string;
  threadPermalink?: string;
  meetingContext?: string;
  durableContext?: string;
  source?: string;
  [key: string]: unknown;
}

export function buildSlackAppMentionContext(input: BuildSlackAppMentionContextInput = {}) {
  const botUserId = text(input.botUserId);
  const event: SlackMessageShape = input.event || {};
  const channelId = text(input.channelId || event.channel);
  const threadTs = text(input.threadTs || event.thread_ts || event.ts || event.event_ts);
  const userId = text(input.userId || event.user);
  const resolveName = input.resolveName || null;
  const { messages, canvasFiles: unfurlCanvasFiles } = mergeAttachmentCanvasFiles(
    Array.isArray(input.messages) ? input.messages : [],
  );
  const parent = messages[0] || {};
  const transcript = formatSlackThreadTranscript(messages, { botUserId, resolveName });
  const media = extractSlackThreadMedia(messages, { botUserId });
  const rawMentionText = stripSlackBotMention(event.text || input.text || "", botUserId);
  let mentionText = rawMentionText;
  let injectedJoinRequest = false;
  if (!mentionText && containsGoogleMeetUrl(transcript)) {
    mentionText = "请帮我加入这个会议";
    injectedJoinRequest = true;
  }
  const parentInfo = {
    user: text(parent.user || parent.user_id || parent.userId),
    userName: userLabel(parent, botUserId, resolveName),
    botId: text(parent.bot_id || parent.botId),
    ts: text(parent.ts || parent.timestamp),
    isBotParent: Boolean(
      parent.bot_id || (botUserId && (parent.user || parent.user_id) === botUserId),
    ),
  };
  const prompt = buildSlackAssistantThreadMessage({
    channelId,
    threadTs,
    threadPermalink: text(input.threadPermalink),
    userId,
    mentionText,
    transcript,
    meetingContext: text(input.meetingContext),
    durableContext: text(input.durableContext),
    parentInfo,
  });
  return {
    kind: "slack_app_mention_rich_context",
    source: input.source || "events_api",
    channelId,
    threadTs,
    userId,
    botUserId,
    messageCount: messages.length,
    transcript,
    prompt,
    rawMentionText,
    mentionText,
    injectedJoinRequest,
    containsMeetUrl: containsGoogleMeetUrl(transcript),
    parentInfo,
    canvasFiles: uniqueFiles([...media.canvasFiles, ...unfurlCanvasFiles]),
    files: media.files,
    imageParts: media.images,
    meetingContext: text(input.meetingContext),
    fetchedAt: new Date().toISOString(),
  };
}
