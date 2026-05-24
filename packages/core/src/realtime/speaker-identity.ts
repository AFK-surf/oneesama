import type { RealtimeCurrentUser } from "./realtime-contract.ts";

export interface SpeakerIdentityResolution {
  resolved: boolean;
  role: "current_user" | "external" | "unknown";
  isCurrentUser: boolean;
  canonicalName: string;
  preferredName: string;
  confidence: "low" | "medium" | "high";
  resolver: "workspace_current_user" | "unresolved";
  matchedAlias?: string;
  displayName: string;
  evidence: string[];
}

export function normalizeSpeakerDisplayName(value: unknown): string {
  let text = String(value || "")
    .replace(/\s+/g, " ")
    .replace(/^You$/i, "You")
    .trim();
  if (!text) return "";
  text = text
    .replace(
      /\s*\((?:you|me|host|presenting|speaking|muted|muted microphone|microphone off)\)\s*$/i,
      "",
    )
    .replace(/\s+(?:is )?(?:speaking|talking|presenting)$/i, "")
    .replace(/\s+(?:muted|microphone off|camera off)$/i, "")
    .replace(/'s (?:video|screen|presentation)$/i, "")
    .replace(/(?:的视频|正在发言|正在讲话|正在演示|已静音|麦克风已关闭)$/g, "")
    .trim();
  const blacklist = [
    "leave call",
    "leave meeting",
    "turn off microphone",
    "turn on microphone",
    "turn off camera",
    "turn on camera",
    "raise hand",
    "more options",
    "present now",
    "share screen",
    "people",
    "chat",
    "activities",
    "host controls",
    "settings",
    "unknown",
  ];
  const lowered = text.toLowerCase();
  if (blacklist.includes(lowered)) return "";
  if (/^(press down arrow|external participants joined|your audio is merged)/i.test(text)) {
    return "";
  }
  if (text.length > 80 || text.split(" ").length > 8) return "";
  return text;
}

function normalizeIdentityAlias(value: unknown): string {
  return normalizeSpeakerDisplayName(value)
    .toLowerCase()
    .replace(/[·・]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitIdentityAliases(value: unknown): string[] {
  const parts = Array.isArray(value) ? value : String(value || "").split(",");
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    const text = normalizeSpeakerDisplayName(part);
    if (!text) continue;
    const key = normalizeIdentityAlias(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function currentUserAliasList(currentUser?: RealtimeCurrentUser | null): string[] {
  if (!currentUser) return [];
  return splitIdentityAliases([
    currentUser.name,
    currentUser.englishName || currentUser.english,
    ...(Array.isArray(currentUser.aliases)
      ? currentUser.aliases
      : splitIdentityAliases(currentUser.aliases)),
  ]);
}

function preferredCurrentUserAddress(aliases: string[], fallback: string): string {
  return aliases.find((alias) => /[\u4e00-\u9fff]/.test(alias)) || fallback;
}

export function resolveSpeakerIdentity(
  displayName: unknown,
  currentUser?: RealtimeCurrentUser | null,
): SpeakerIdentityResolution | null {
  const rawDisplayName = normalizeSpeakerDisplayName(displayName);
  const normalizedName = normalizeIdentityAlias(displayName);
  if (!normalizedName) return null;
  const aliases = currentUserAliasList(currentUser);
  for (const alias of aliases) {
    if (normalizeIdentityAlias(alias) === normalizedName) {
      const canonicalName =
        currentUser?.name || currentUser?.englishName || currentUser?.english || alias;
      return {
        resolved: true,
        role: "current_user",
        isCurrentUser: true,
        canonicalName,
        preferredName: preferredCurrentUserAddress(aliases, canonicalName),
        confidence: "high",
        resolver: "workspace_current_user",
        matchedAlias: alias,
        displayName: rawDisplayName,
        evidence: [`exact_alias:${alias}`],
      };
    }
  }
  return {
    resolved: false,
    role: "external",
    isCurrentUser: false,
    canonicalName: rawDisplayName,
    preferredName: rawDisplayName,
    confidence: "low",
    resolver: "unresolved",
    displayName: rawDisplayName,
    evidence: ["fallback:display_name"],
  };
}
