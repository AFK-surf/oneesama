const BOLD_ITALIC_RE = /\*\*\*(.+?)\*\*\*/gs;
const BOLD_RE = /\*\*(.+?)\*\*/gs;
const ITALIC_RE = /\*([^*\n]+?)\*/g;
const LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g;
const HEADER_RE = /^#{1,6}\s+(.+)$/gm;
const STRIKE_RE = /~~(.+?)~~/gs;
const UNORDERED_LIST_RE = /^(\s*)[-*]\s+/gm;
const ORDERED_LIST_RE = /^(\s*)\d+\.\s+/gm;
const TABLE_ROW_RE = /^\|(.+)\|$/;
const TABLE_SEPARATOR_RE = /^\|[\s:]*-{2,}[\s:]*(\|[\s:]*-{2,}[\s:]*)*\|$/;
const INLINE_CODE_ISSUE_RE = /`([A-Z]{2,10}-\d+)`/g;
const LINEAR_ISSUE_RE = /\b([A-Z]{2,10}-\d+)\b/g;

const TAG_OPEN_PATTERNS = new Map([
  ["h1", /<h1[^>]*>/gi],
  ["h2", /<h2[^>]*>/gi],
  ["h3", /<h3[^>]*>/gi],
  ["h4", /<h4[^>]*>/gi],
  ["li", /<li[^>]*>/gi],
  ["p", /<p[^>]*>/gi],
  ["b", /<b[^>]*>/gi],
  ["strong", /<strong[^>]*>/gi],
  ["i", /<i[^>]*>/gi],
  ["em", /<em[^>]*>/gi],
  ["code", /<code[^>]*>/gi],
]);

const PH_BI_OPEN = "\u0000BI\u0001";
const PH_BI_CLOSE = "\u0000BI\u0002";
const PH_B_OPEN = "\u0000B\u0001";
const PH_B_CLOSE = "\u0000B\u0002";

export interface MarkdownRendererOptions {
  linearWorkspaceSlug?: string;
  maxBlocks?: number | string;
  [key: string]: unknown;
}

function splitCodeSegments(input: unknown) {
  const text = String(input || "");
  const segments = [];
  let i = 0;
  while (i < text.length) {
    if (text.slice(i, i + 3) === "```") {
      const end = text.indexOf("```", i + 3);
      if (end >= 0) {
        segments.push({ text: text.slice(i, end + 3), isCode: true });
        i = end + 3;
        continue;
      }
      segments.push({ text: text.slice(i), isCode: true });
      break;
    }
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end >= 0) {
        segments.push({ text: text.slice(i, end + 1), isCode: true });
        i = end + 1;
        continue;
      }
    }
    let next = text.indexOf("`", i + 1);
    if (next < 0) next = text.length;
    segments.push({ text: text.slice(i, next), isCode: false });
    i = next;
  }
  return segments;
}

function convertEmphasis(text) {
  return text
    .replace(BOLD_ITALIC_RE, `${PH_BI_OPEN}$1${PH_BI_CLOSE}`)
    .replace(BOLD_RE, `${PH_B_OPEN}$1${PH_B_CLOSE}`)
    .replace(ITALIC_RE, "_$1_")
    .replaceAll(PH_BI_OPEN, "*_")
    .replaceAll(PH_BI_CLOSE, "_*")
    .replaceAll(PH_B_OPEN, "*")
    .replaceAll(PH_B_CLOSE, "*");
}

function convertStrongEmphasis(text) {
  return text.replace(BOLD_ITALIC_RE, "*_$1_*").replace(BOLD_RE, "*$1*");
}

function parseTableRow(line) {
  return String(line || "")
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((part) => part.trim());
}

function convertMarkdownTable(text) {
  const lines = String(text || "").split("\n");
  const result = [];
  for (let i = 0; i < lines.length; ) {
    if (
      i + 1 < lines.length &&
      TABLE_ROW_RE.test(lines[i]) &&
      TABLE_SEPARATOR_RE.test(lines[i + 1].trim())
    ) {
      const headers = parseTableRow(lines[i]);
      i += 2;
      while (i < lines.length && TABLE_ROW_RE.test(lines[i])) {
        const cols = parseTableRow(lines[i]);
        const parts = [];
        for (let j = 0; j < cols.length; j += 1) {
          const col = cols[j].trim();
          if (!col) continue;
          const header = headers[j]?.trim() || "";
          parts.push(header ? `*${header}*: ${col}` : col);
        }
        if (parts.length) result.push(`• ${parts.join("  ·  ")}`);
        i += 1;
      }
      continue;
    }
    result.push(lines[i]);
    i += 1;
  }
  return result.join("\n");
}

function linkifyLinearIssues(text, workspaceSlug) {
  if (!workspaceSlug) return text;
  let result = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === "<") {
      const end = text.indexOf(">", i);
      if (end >= 0) {
        result += text.slice(i, end + 1);
        i = end + 1;
        continue;
      }
    }
    const next = text.indexOf("<", i + 1);
    const segment = next >= 0 ? text.slice(i, next) : text.slice(i);
    result += segment.replace(
      LINEAR_ISSUE_RE,
      (match) => `<https://linear.app/${workspaceSlug}/issue/${match}|${match}>`,
    );
    if (next < 0) break;
    i = next;
  }
  return result;
}

function convertCommonMarkdown(text: unknown, options: MarkdownRendererOptions = {}) {
  let output = convertMarkdownTable(text);
  output = output
    .replace(LINK_RE, "<$2|$1>")
    .replace(HEADER_RE, "*$1*")
    .replace(STRIKE_RE, "~$1~")
    .replace(UNORDERED_LIST_RE, "$1• ")
    .replace(ORDERED_LIST_RE, "$1• ")
    .replaceAll("\n---\n", "\n———\n")
    .replaceAll("\n***\n", "\n———\n")
    .replaceAll("\n___\n", "\n———\n");
  return linkifyLinearIssues(output, options.linearWorkspaceSlug || "");
}

function transformText(text: unknown, options: MarkdownRendererOptions = {}) {
  return convertCommonMarkdown(convertEmphasis(text), options);
}

function transformTextPreservingMrkdwn(text: unknown, options: MarkdownRendererOptions = {}) {
  return convertCommonMarkdown(convertStrongEmphasis(text), options);
}

export function markdownToMrkdwn(text: unknown, options: MarkdownRendererOptions = {}): string {
  let input = String(text || "");
  if (options.linearWorkspaceSlug) input = input.replace(INLINE_CODE_ISSUE_RE, "$1");
  return splitCodeSegments(input)
    .map((segment) => (segment.isCode ? segment.text : transformText(segment.text, options)))
    .join("");
}

export function markdownishToMrkdwn(text: unknown, options: MarkdownRendererOptions = {}): string {
  let input = String(text || "");
  if (options.linearWorkspaceSlug) input = input.replace(INLINE_CODE_ISSUE_RE, "$1");
  return splitCodeSegments(input)
    .map((segment) =>
      segment.isCode ? segment.text : transformTextPreservingMrkdwn(segment.text, options),
    )
    .join("");
}

export function markdownToSlackFallbackText(
  text: unknown,
  options: MarkdownRendererOptions = {},
): string {
  const fallback = markdownToMrkdwn(text, options).trim();
  return fallback || String(text || "");
}

function allSameChar(text, ch) {
  for (const char of text) {
    if (char !== ch && char !== " ") return false;
  }
  return true;
}

function leadingHeaderHashes(text) {
  let count = 0;
  while (count < text.length && text[count] === "#") count += 1;
  return count;
}

function splitMarkdownSections(markdown) {
  const sections = [];
  let bodyLines = [];
  const flushBody = () => {
    const body = bodyLines.join("\n").trim();
    if (body) sections.push({ kind: "body", text: body });
    bodyLines = [];
  };
  for (const line of String(markdown || "").split("\n")) {
    const trimmed = line.trim();
    if (
      trimmed.length >= 3 &&
      (allSameChar(trimmed, "-") || allSameChar(trimmed, "*") || allSameChar(trimmed, "_"))
    ) {
      flushBody();
      sections.push({ kind: "divider" });
      continue;
    }
    const hashCount = leadingHeaderHashes(trimmed);
    if (
      hashCount > 0 &&
      hashCount <= 3 &&
      hashCount < trimmed.length &&
      trimmed[hashCount] === " "
    ) {
      flushBody();
      sections.push({ kind: "header", text: trimmed.slice(hashCount + 1).trim() });
      continue;
    }
    bodyLines.push(line);
  }
  flushBody();
  return sections;
}

export function splitMrkdwnChunks(text, maxLen = 3000) {
  const input = String(text || "");
  if (input.length <= maxLen) return input ? [input] : [];
  const chunks = [];
  let rest = input;
  while (rest.length > 0) {
    if (rest.length <= maxLen) {
      chunks.push(rest);
      break;
    }
    let cut = rest.lastIndexOf("\n", maxLen);
    if (cut <= 0) cut = maxLen;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
    if (rest.startsWith("\n")) rest = rest.slice(1);
  }
  return chunks;
}

function truncateSlackHeader(text) {
  const value = String(text || "").trim();
  return value.length > 150 ? `${value.slice(0, 149)}…` : value;
}

export function markdownToBlocks(
  markdown: unknown,
  options: MarkdownRendererOptions = {},
): Array<Record<string, unknown>> {
  const input = String(markdown || "").trim();
  if (!input) return [];
  const blocks = [];
  for (const section of splitMarkdownSections(input)) {
    if (section.kind === "header") {
      blocks.push({
        type: "header",
        text: { type: "plain_text", text: truncateSlackHeader(section.text), emoji: true },
      });
      continue;
    }
    if (section.kind === "divider") {
      blocks.push({ type: "divider" });
      continue;
    }
    const mrkdwn = markdownToMrkdwn(section.text, options).trim();
    for (const chunk of splitMrkdwnChunks(mrkdwn, 3000)) {
      if (chunk.trim()) {
        blocks.push({ type: "section", text: { type: "mrkdwn", text: chunk } });
      }
    }
  }
  if (!blocks.length) {
    for (const chunk of splitMrkdwnChunks(markdownToMrkdwn(input, options), 3000)) {
      blocks.push({ type: "section", text: { type: "mrkdwn", text: chunk } });
    }
  }
  return blocks.slice(0, Math.max(1, Number.parseInt(String(options.maxBlocks ?? "50"), 10)));
}

function replaceTag(html, tag, prefix, suffix) {
  const openRe = TAG_OPEN_PATTERNS.get(tag);
  if (!openRe) return html;
  return html
    .replace(openRe, prefix)
    .replaceAll(`</${tag}>`, suffix)
    .replaceAll(`</${tag.toUpperCase()}>`, suffix);
}

function extractAnchorHref(openTag) {
  const match = String(openTag || "").match(/\shref=["']([^"']+)["']/i);
  return match?.[1] || "";
}

function convertLinks(html) {
  let rest = String(html || "");
  let output = "";
  for (;;) {
    const start = rest.toLowerCase().indexOf("<a");
    if (start < 0) return output + rest;
    output += rest.slice(0, start);
    rest = rest.slice(start);
    const tagEnd = rest.indexOf(">");
    if (tagEnd < 0) return output + rest;
    const openTag = rest.slice(0, tagEnd + 1);
    const href = extractAnchorHref(openTag);
    if (!href) {
      output += openTag;
      rest = rest.slice(tagEnd + 1);
      continue;
    }
    const closeIdx = rest
      .slice(tagEnd + 1)
      .toLowerCase()
      .indexOf("</a>");
    if (closeIdx < 0) return output + rest;
    const linkText = rest.slice(tagEnd + 1, tagEnd + 1 + closeIdx);
    output += `[${linkText}](${href})`;
    rest = rest.slice(tagEnd + 1 + closeIdx + "</a>".length);
  }
}

function stripAllTags(html) {
  let output = "";
  let inTag = false;
  for (const char of String(html || "")) {
    if (char === "<") {
      inTag = true;
      continue;
    }
    if (char === ">") {
      inTag = false;
      continue;
    }
    if (!inTag) output += char;
  }
  return output;
}

export function htmlToMarkdown(html) {
  let output = String(html || "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n");
  output = replaceTag(output, "h1", "# ", "\n\n");
  output = replaceTag(output, "h2", "## ", "\n\n");
  output = replaceTag(output, "h3", "### ", "\n\n");
  output = replaceTag(output, "h4", "#### ", "\n\n");
  output = output.replace(/<br\s*\/?>/gi, "\n");
  output = replaceTag(output, "li", "- ", "\n");
  output = replaceTag(output, "p", "", "\n\n");
  output = replaceTag(output, "b", "**", "**");
  output = replaceTag(output, "strong", "**", "**");
  output = replaceTag(output, "i", "_", "_");
  output = replaceTag(output, "em", "_", "_");
  output = replaceTag(output, "code", "`", "`");
  output = convertLinks(output);
  output = stripAllTags(output)
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&nbsp;", " ");
  while (output.includes("\n\n\n")) output = output.replaceAll("\n\n\n", "\n\n");
  return output.trim();
}
