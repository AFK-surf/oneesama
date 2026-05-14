const MEET_URL_RE = /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}(?:[/?#].*)?$/i;

export interface ParsedFlags {
  reason?: string;
  [key: string]: string | boolean | undefined;
}

export interface AvatarCommandResult {
  action: string;
  flags: ParsedFlags;
  positionals: string[];
  meetUrl: string;
  validMeetUrl: boolean;
  sessionId: string;
  avatar: string;
  botName: string;
  dryRunJoiner: boolean;
  startJoiner: boolean;
  requestedMode: string;
  allowCodeChanges: boolean;
  task: string;
}

interface SlackTextResponseOptions {
  ok?: boolean;
  responseType?: string;
  extra?: Record<string, unknown>;
}

function tokenize(input = ""): string[] {
  const tokens = [];
  let current = "";
  let quote = "";
  let escaped = false;

  for (const char of String(input)) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = "";
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (current) tokens.push(current);
  return tokens;
}

function camelFlag(flag: string): string {
  return flag.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function parseBoolean(value: unknown, defaultValue = false): boolean {
  if (value === undefined) return defaultValue;
  if (typeof value === "boolean") return value;
  return !["0", "false", "no", "off"].includes(String(value).toLowerCase());
}

function parseFlags(tokens: string[]): { flags: ParsedFlags; positionals: string[] } {
  const flags: ParsedFlags = {};
  const positionals: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const raw = token.slice(2);
    const [key, inlineValue] = raw.split(/=(.*)/s).filter((part) => part !== undefined);
    const normalized = camelFlag(key);
    if (inlineValue !== undefined) {
      flags[normalized] = inlineValue;
      continue;
    }

    const next = tokens[index + 1];
    if (next && !next.startsWith("--")) {
      flags[normalized] = next;
      index += 1;
    } else {
      flags[normalized] = true;
    }
  }

  return { flags, positionals };
}

export function parseAvatarCommand(text = ""): AvatarCommandResult {
  const tokens = tokenize(text);
  const action = (tokens[0] || "help").toLowerCase();
  const { flags, positionals } = parseFlags(tokens.slice(1));
  const meetUrl = String(
    flags.meetUrl || positionals.find((part) => part.startsWith("http")) || "",
  );
  const sessionId = String(
    flags.session || flags.sessionId || positionals.find((part) => part.startsWith("meet_")) || "",
  );
  const dryRunJoiner = flags.real ? false : parseBoolean(flags.dryRun, true);
  const avatar = String(flags.avatar || "hiyori");
  const botName = String(flags.botName || flags.name || "");
  const requestedMode = String(flags.mode || "analysis");

  return {
    action,
    flags,
    positionals,
    meetUrl,
    validMeetUrl: meetUrl ? MEET_URL_RE.test(meetUrl) : false,
    sessionId,
    avatar,
    botName,
    dryRunJoiner,
    startJoiner: parseBoolean(flags.startJoiner, true),
    requestedMode,
    allowCodeChanges: parseBoolean(flags.allowCodeChanges ?? flags.write, false),
    task:
      action === "delegate"
        ? positionals
            .filter((part) => part !== sessionId)
            .join(" ")
            .trim()
        : "",
  };
}

export function avatarCommandUsage() {
  return [
    "Meeting Avatar Bot commands:",
    "/avatar join <meet-url> [--avatar hiyori] [--bot-name name] [--dry-run false]",
    "/avatar status [session-id]",
    "/avatar stop [session-id] [--reason text]",
    "/avatar delegate <task> [--session meet_xxx] [--mode analysis] [--write false]",
    "/avatar jobs",
  ].join("\n");
}

export function slackTextResponse(text: string, options: SlackTextResponseOptions = {}) {
  return {
    ok: options.ok !== false,
    response_type: options.responseType || "ephemeral",
    text,
    ...options.extra,
  };
}
