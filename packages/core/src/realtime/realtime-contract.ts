export const realtimeToolSchemas = [
  {
    type: "function",
    name: "delegate_to_worker",
    description:
      "Start a background workspace job for complex work that should not be improvised in the realtime voice conversation.",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description:
            "Clear task, including URLs, file paths, expected output, and any user wording that matters.",
        },
        context: {
          type: "string",
          description:
            "Useful meeting/workspace context. Include Meet chat links or prior results when relevant.",
        },
        mode: {
          type: "string",
          enum: ["analysis", "code", "research", "debug", "plan"],
          default: "analysis",
        },
        allowCodeChanges: { type: "boolean", default: false },
      },
      required: ["task"],
    },
  },
  {
    type: "function",
    name: "worker_status",
    description: "Check status/result of a background workspace job.",
    parameters: {
      type: "object",
      properties: {
        jobId: { type: "string" },
      },
      required: [],
    },
  },
  {
    type: "function",
    name: "delegate_to_codex",
    description:
      "Compatibility alias for starting a background workspace job for links, files, code, debugging, planning, or multi-step research.",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "Clear task. Include exact URLs/file paths/commands and what to report back.",
        },
        context: {
          type: "string",
          description:
            "Useful meeting/workspace context. Include Meet chat links or prior results when relevant.",
        },
        mode: {
          type: "string",
          enum: ["analysis", "code", "research", "debug", "plan"],
          default: "analysis",
        },
        allow_code_changes: { type: "boolean", default: false },
        wait_for_result: { type: "boolean", default: false },
      },
      required: ["task"],
    },
  },
  {
    type: "function",
    name: "delegate_status",
    description: "Compatibility alias for checking status/result of a background workspace job.",
    parameters: {
      type: "object",
      properties: {
        job_id: { type: "string" },
      },
      required: [],
    },
  },
  {
    type: "function",
    name: "send_meet_chat",
    description: "Send a short visible message into the current Google Meet chat.",
    parameters: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "The exact chat message to send to the current Meet.",
        },
      },
      required: ["text"],
    },
  },
  {
    type: "function",
    name: "present_video_stage",
    description:
      "Open a controlled video/stage tab and make Google Meet share that stage. Use immediately when the user says 放视频 / 分享视频 / 播放视频 / share screen with a video / open video stage / present video. For non-direct video links, first resolve a playable file or URL in the background, then present the resulting video file or URL.",
    parameters: {
      type: "object",
      properties: {
        videoUrl: {
          type: "string",
          description:
            "Direct video URL, data URL, file URL, or local file path. Optional: without it, a placeholder stage is shared.",
        },
        title: { type: "string", description: "Visible title on the shared stage." },
        subtitle: { type: "string", description: "Visible subtitle on the shared stage." },
        muted: { type: "boolean", default: true },
      },
      required: [],
    },
  },
  {
    type: "function",
    name: "stop_video_stage",
    description:
      "Stop the current Google Meet video-stage/screen-share presentation. Use immediately when the user says 停止分享 / stop sharing / 关掉分享 / stop video stage.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    type: "function",
    name: "list_shareable_apps",
    description:
      "List local applications that can be selected for an application/window share in the current meeting.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    type: "function",
    name: "present_app_share",
    description:
      "Request sharing a specific local application/window into the current meeting. The browser or meeting client may still ask the user to confirm the exact window.",
    parameters: {
      type: "object",
      properties: {
        processId: { type: "integer", description: "Process id from list_shareable_apps." },
        bundleIdentifier: {
          type: "string",
          description: "Bundle identifier from list_shareable_apps.",
        },
        applicationName: {
          type: "string",
          description: "Application name from list_shareable_apps.",
        },
        mode: {
          type: "string",
          enum: ["native", "synthetic"],
          default: "native",
        },
      },
      required: [],
    },
  },
  {
    type: "function",
    name: "read_meet_chat",
    description:
      "Read recent visible Google Meet chat messages and links from the current meeting.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "integer", default: 10 },
        onlyLinks: { type: "boolean", default: false },
      },
      required: [],
    },
  },
  {
    type: "function",
    name: "meet_participants",
    description:
      "Return the current Google Meet participant list and best-effort active/recent speaker state from live Meet DOM/captions.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    type: "function",
    name: "active_speaker",
    description:
      "Return the current or most recent Google Meet speaker, with source/confidence metadata. This is best-effort and may come from captions or Meet DOM speaker indicators.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    type: "function",
    name: "fetch_url",
    description:
      "Read a public URL and return extracted text/markdown. Uses a reader service by default, which is useful for X/Twitter links and pages that are hard to read directly. If this fails or the request needs deeper browsing, continue in the background.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The exact http(s) URL to read." },
        useJina: {
          type: "boolean",
          default: true,
          description: "Use the Jina reader service instead of direct fetch.",
        },
        maxChars: {
          type: "integer",
          default: 8000,
          description: "Maximum returned text characters.",
        },
      },
      required: ["url"],
    },
  },
  {
    type: "function",
    name: "current_user_identity",
    description:
      "Return the current meeting speaker/user identity. Use whenever the user asks who they are, says 'my/me/I', or asks for their own workspace data.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    type: "function",
    name: "resolve_speaker_identity",
    description:
      "Resolve a live meeting speaker display name to the current workspace identity profile when possible. Falls back to the display name with low confidence instead of guessing.",
    parameters: {
      type: "object",
      properties: {
        display_name: {
          type: "string",
          description: "Raw speaker or participant display name from Meet, captions, Slack, or another surface.",
        },
        source: {
          type: "string",
          enum: ["meet_dom", "caption", "slack_event", "manual", "unknown"],
          default: "unknown",
        },
        channel: { type: "string" },
        workspace: { type: "string" },
        meeting_url: {
          type: "string",
          description: "Current Google Meet URL when available, used to reconcile calendar attendees.",
        },
        calendar_attendees: {
          type: "array",
          description: "Optional attendee hints from a matched calendar event.",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              display_name: { type: "string" },
              email: { type: "string" },
              aliases: { type: "array", items: { type: "string" } },
              role: { type: "string" },
            },
          },
        },
        learn: {
          type: "object",
          description:
            "Optional user-corrected identity memory to persist for future speaker resolution.",
          properties: {
            canonical_name: { type: "string" },
            preferred_name: { type: "string" },
            honorific_preference: { type: "string" },
            role: { type: "string" },
            aliases: { type: "array", items: { type: "string" } },
            meet_display_names: { type: "array", items: { type: "string" } },
            slack_user_id: { type: "string" },
            slack_team_id: { type: "string" },
            email: { type: "string" },
            calendar_emails: { type: "array", items: { type: "string" } },
            linear: { type: "string" },
            github: { type: "string" },
          },
        },
      },
      required: ["display_name"],
    },
  },
  {
    type: "function",
    name: "search_team_members",
    description:
      "Search Linear users/team members and return fuzzy candidates. Use before assignee-specific Linear lookups if the spoken name is ambiguous.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Name, nickname, email, or spoken partial name." },
      },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "linear_query",
    description:
      "Search Linear issues by free text in title/description. Use for issue keyword lookups.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer", default: 5 },
      },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "linear_user_issues",
    description:
      "List incomplete Linear issues assigned to a user. Use for 'my tasks', 'tasks on someone's plate', or assignee questions.",
    parameters: {
      type: "object",
      properties: {
        user: {
          type: "string",
          description:
            "Email, display name, handle, or username. Prefer the current workspace user's email when available, for example user@example.com.",
        },
      },
      required: ["user"],
    },
  },
  {
    type: "function",
    name: "google_calendar",
    description: "Search Google Calendar events.",
    parameters: {
      type: "object",
      properties: {
        time_min: { type: "string" },
        time_max: { type: "string" },
        max_results: { type: "integer", default: 10 },
      },
      required: [],
    },
  },
  {
    type: "function",
    name: "calendar_attendees",
    description: "Look up the calendar event matching the current Meet URL and return attendees.",
    parameters: {
      type: "object",
      properties: {
        meet_url: {
          type: "string",
          description: "Google Meet URL. Defaults to the current meeting when omitted.",
        },
      },
      required: [],
    },
  },
  {
    type: "function",
    name: "slack_search",
    description: "Search Cue Slack messages.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        count: { type: "integer", default: 5 },
      },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "notion_search",
    description: "Search Cue Notion documents.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "github_search",
    description: "Search GitHub issues, repos, or code.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        kind: { type: "string", enum: ["issues", "repos", "code"], default: "issues" },
      },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "memory_write",
    description: "Write session memory for this meeting avatar.",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string" },
        value: {},
      },
      required: ["key"],
    },
  },
  {
    type: "function",
    name: "memory_read",
    description: "Read session memory. Omit key to return all memory.",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string" },
      },
      required: [],
    },
  },
  {
    type: "function",
    name: "now",
    description: "Return the current date/time in Asia/Shanghai.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    type: "function",
    name: "set_avatar_expression",
    description: "Set the Live2D avatar's visible mood before or during an answer.",
    parameters: {
      type: "object",
      properties: {
        mood: { type: "string", enum: ["neutral", "happy", "surprised", "thinking", "sad", "shy"] },
      },
      required: ["mood"],
    },
  },
  {
    type: "function",
    name: "set_avatar_action",
    description:
      "Trigger a visible Live2D head/body action. Use nod for agreement, shake for disagreement, wave for greetings, think for reasoning, speak while talking, and emphasize for conclusions.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "idle",
            "nod",
            "shake",
            "wave",
            "think",
            "lean_forward",
            "emphasize",
            "shrug",
            "speak",
          ],
        },
        intensity: { type: "number", description: "0.2 to 1.2 is the normal visible range." },
      },
      required: ["action"],
    },
  },
  {
    type: "function",
    name: "update_avatar_state",
    description: "Set the avatar mood and action together for the current response.",
    parameters: {
      type: "object",
      properties: {
        mood: { type: "string", enum: ["neutral", "happy", "surprised", "thinking", "sad", "shy"] },
        action: {
          type: "string",
          enum: [
            "idle",
            "nod",
            "shake",
            "wave",
            "think",
            "lean_forward",
            "emphasize",
            "shrug",
            "speak",
          ],
        },
        intensity: { type: "number", description: "0.2 to 1.2 is the normal visible range." },
      },
      required: [],
    },
  },
];

export const DEFAULT_REALTIME_MODEL = "gpt-realtime-2";
export const DEFAULT_REALTIME_VOICE = "marin";
export const DEFAULT_REALTIME_REASONING_EFFORT = "high";
export const DEFAULT_REALTIME_TURN_DETECTION = "semantic_vad";

function normalizeModalities(value) {
  if (Array.isArray(value) && value.length) return value;
  if (typeof value === "string" && value.trim()) {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return ["audio"];
}

function shouldUseLegacySessionSchema(value) {
  return ["legacy", "v1", "1", "1.5", "realtime-1.5"].includes(String(value || "").toLowerCase());
}

export function usesRealtime2Model(model: string = "") {
  return String(model || "").includes("gpt-realtime-2");
}

export interface RealtimeSessionOptions {
  model?: string;
  instructions?: string;
  tools?: unknown[];
  toolChoice?: string;
  tool_choice?: string;
  voice?: string;
  outputModalities?: string[] | string;
  output_modalities?: string[] | string;
  inputAudioFormat?: string;
  input_audio_format?: string;
  outputAudioFormat?: string;
  output_audio_format?: string;
  inputAudioFormatType?: string;
  outputAudioFormatType?: string;
  inputAudioRate?: number | string;
  outputAudioRate?: number | string;
  reasoningEffort?: string;
  reasoning_effort?: string;
  reasoning?: Record<string, unknown>;
  turnDetection?: unknown;
  turn_detection?: unknown;
  audio?: {
    input?: {
      format?: {
        type?: string;
        rate?: number;
      };
      turn_detection?: Record<string, unknown> | null;
      [key: string]: unknown;
    };
    output?: {
      format?: {
        type?: string;
        rate?: number;
      };
      voice?: string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  truncation?: unknown;
  sessionSchema?: string;
  session_schema?: string;
  botName?: string;
  personalityContext?: string;
  currentUser?: RealtimeCurrentUser;
  [key: string]: unknown;
}

export interface RealtimeSessionConfig {
  openaiRealtimeModel?: string;
  openaiRealtimeVoice?: string;
  openaiRealtimeReasoningEffort?: string;
  openaiRealtimeTurnDetection?: unknown;
  openaiRealtimeSessionSchema?: string;
  botName?: string;
  realtimePersonalityContext?: string;
  currentUserName?: string;
  currentUserEnglishName?: string;
  currentUserEmail?: string;
  currentUserLinear?: string;
  currentUserGithub?: string;
  currentUserRole?: string;
  currentUserAliases?: string[] | string;
  [key: string]: unknown;
}

interface LegacyRealtimeSession {
  type: "realtime";
  model: string;
  instructions: string;
  tools: unknown[];
  modalities: string[];
  voice: string;
  input_audio_format: string;
  output_audio_format: string;
  turn_detection: Record<string, unknown> | null;
  tool_choice?: string;
}

interface Realtime2AudioConfig {
  input: {
    format: {
      type: string;
      rate: number;
    };
    turn_detection: Record<string, unknown> | null;
    [key: string]: unknown;
  };
  output: {
    format: {
      type: string;
      rate: number;
    };
    voice: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface Realtime2Session {
  type: "realtime";
  model: string;
  output_modalities: string[];
  instructions: string;
  tools: unknown[];
  audio: Realtime2AudioConfig;
  tool_choice?: string;
  reasoning?: Record<string, unknown>;
  truncation?: unknown;
}

export interface RealtimeCurrentUser {
  name?: string;
  englishName?: string;
  english?: string;
  email?: string;
  linear?: string;
  github?: string;
  role?: string;
  aliases?: string[] | string;
}

export interface RealtimeInstructionOptions {
  botName?: string;
  personalityContext?: string;
  currentUser?: RealtimeCurrentUser;
}

function currentUserFromConfig(config: RealtimeSessionConfig = {}): RealtimeCurrentUser {
  return {
    name: config.currentUserName || "",
    englishName: config.currentUserEnglishName || "",
    email: config.currentUserEmail || "",
    linear: config.currentUserLinear || "",
    github: config.currentUserGithub || "",
    role: config.currentUserRole || "",
    aliases: config.currentUserAliases || [],
  };
}

function normalizeTurnDetectionConfig(value: unknown) {
  if (value === null) return null;
  if (typeof value === "object" && value !== undefined) {
    return { ...(value as Record<string, unknown>) };
  }
  const normalized = String(value || "").trim();
  if (!normalized || normalized === "none") return null;
  if (normalized.startsWith("{")) {
    try {
      const parsed = JSON.parse(normalized);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { ...parsed };
      }
    } catch {
      // Fall through to treating the value as a literal turn_detection type.
    }
  }
  switch (normalized.toLowerCase()) {
    case "steady":
      return { type: "semantic_vad", eagerness: "low" };
    case "balanced":
      return { type: "semantic_vad", eagerness: "auto" };
    case "fast":
      return { type: "semantic_vad", eagerness: "high" };
  }
  return { type: normalized };
}

function normalizeRealtimeTruncation(value: unknown) {
  if (value !== undefined && value !== null && value !== "") {
    if (typeof value === "string") {
      if (value.trim().toLowerCase() === "disabled") return "disabled";
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }
    return value;
  }
  return {
    type: "retention_ratio",
    retention_ratio: 0.8,
    token_limits: {
      post_instructions: 8000,
    },
  };
}

export function buildRealtimeSessionConfig(
  options: RealtimeSessionOptions = {},
  config: RealtimeSessionConfig = {},
) {
  const model = options.model || config.openaiRealtimeModel || DEFAULT_REALTIME_MODEL;
  const currentUser = options.currentUser || currentUserFromConfig(config);
  const personalityContext = options.personalityContext || config.realtimePersonalityContext || "";
  const botName = options.botName || config.botName || "Meeting Avatar Bot";
  const instructions =
    options.instructions || buildRealtimeInstructions({ botName, personalityContext, currentUser });
  const tools = options.tools || realtimeToolSchemas;
  const toolChoice =
    options.toolChoice || options.tool_choice || (tools?.length ? "auto" : undefined);
  const voice = options.voice || config.openaiRealtimeVoice || DEFAULT_REALTIME_VOICE;
  const reasoningEffort =
    options.reasoningEffort ||
    options.reasoning_effort ||
    config.openaiRealtimeReasoningEffort ||
    DEFAULT_REALTIME_REASONING_EFFORT;
  const turnDetection =
    options.turnDetection ||
    options.turn_detection ||
    config.openaiRealtimeTurnDetection ||
    DEFAULT_REALTIME_TURN_DETECTION;
  const sessionSchema =
    options.sessionSchema ||
    options.session_schema ||
    config.openaiRealtimeSessionSchema ||
    "realtime-2";

  if (shouldUseLegacySessionSchema(sessionSchema)) {
    const legacyTurnDetection = options.turnDetection || options.turn_detection || "server_vad";
    const legacySession: LegacyRealtimeSession = {
      type: "realtime",
      model,
      instructions,
      tools,
      modalities: normalizeModalities(options.outputModalities || options.output_modalities),
      voice,
      input_audio_format: options.inputAudioFormat || options.input_audio_format || "pcm16",
      output_audio_format: options.outputAudioFormat || options.output_audio_format || "pcm16",
      turn_detection: normalizeTurnDetectionConfig(legacyTurnDetection),
    };
    if (toolChoice) legacySession.tool_choice = toolChoice;
    return legacySession;
  }

  const session: Realtime2Session = {
    type: "realtime",
    model,
    output_modalities: normalizeModalities(options.outputModalities || options.output_modalities),
    instructions,
    tools,
    truncation: normalizeRealtimeTruncation(options.truncation),
    audio: {
      input: {
        format: {
          type: options.inputAudioFormatType || "audio/pcm",
          rate: Number(options.inputAudioRate || 24000),
        },
        turn_detection: normalizeTurnDetectionConfig(turnDetection),
      },
      output: {
        format: {
          type: options.outputAudioFormatType || "audio/pcm",
          rate: Number(options.outputAudioRate || 24000),
        },
        voice,
      },
    },
  };
  if (options.audio) {
    session.audio = {
      ...session.audio,
      ...options.audio,
      input: {
        ...session.audio.input,
        ...(options.audio.input || {}),
      } as Realtime2AudioConfig["input"],
      output: {
        ...session.audio.output,
        ...(options.audio.output || {}),
      } as Realtime2AudioConfig["output"],
    };
  }
  if (toolChoice) session.tool_choice = toolChoice;
  if (options.reasoning) {
    session.reasoning = options.reasoning;
  } else if (
    reasoningEffort &&
    reasoningEffort !== "off" &&
    reasoningEffort !== "none" &&
    usesRealtime2Model(model)
  ) {
    session.reasoning = { effort: reasoningEffort };
  }
  return session;
}

export function buildRealtimeInstructions({
  botName = "Meeting Avatar Bot",
  personalityContext = "",
  currentUser = {},
}: RealtimeInstructionOptions = {}) {
  const lines = [
    `You are ${botName}, a low-latency AI meeting avatar.`,
    "Speak concise Chinese by default.",
    "Persona: lively, concise, reliable meeting copilot with a bright on-camera presence. Be warm and playful, but keep answers short and useful.",
    "Product behavior: keep implementation details invisible. Do not mention internal function names, model/runtime names, background job names, or service routing unless the user explicitly asks for debugging.",
    "When asked what you can do, describe capabilities in user-facing terms: listen and respond in the meeting, understand who is speaking, read meeting chat or shared links, help with workspace lookup, summarize, plan, research, and follow up.",
    "When the user asks you to do complex work, say briefly that you will handle it or check it, then use the appropriate internal action. Do not narrate the internal mechanism.",
    "Identity contract: live speaker identity is provided by runtime context or identity lookup. If active speaker context marks someone as current_user, treat first-person wording like “我/我的/我是谁” as that identity. If identity is uncertain, ask a short clarification instead of guessing.",
    "Project context: AFK AI, Inc. builds oneesama as a meeting avatar and workspace automation framework.",
    "Collaboration habits inherited from workspace memory: low-friction actions, concise replies, no vague development time estimates, report concrete state/actions/blockers/evidence.",
    "Use real meeting/workspace data when available. Never invent names, tasks, calendar facts, documents, links, or code state.",
    "For identity questions, resolve the current speaker identity first. Do not answer from stale defaults.",
    "For personal task questions, resolve the current user profile first and use its workspace identifiers.",
    "For screen share, video playback, links, meeting chat, calendar, tasks, documents, code, research, or long-running work, use the available internal actions silently and summarize the result in concise Chinese.",
    "If a long-running result is not ready, say you are handling it and will report back automatically. Never pretend it is complete before the result arrives.",
    "When live meeting participants or speaker context is injected, use it as conversation context. Do not recite detection sources, confidence values, or raw context fields unless the user asks for debugging.",
    "For non-trivial spoken answers, adjust the avatar mood/action before or during the answer so the visible avatar matches the conversation.",
  ];
  if (personalityContext) {
    lines.push(`Extra local workspace context:\n${String(personalityContext).slice(0, 4000)}`);
  }
  return lines.join("\n");
}
