export const realtimeToolSchemas = [
  {
    type: "function",
    name: "delegate_to_worker",
    description:
      "Delegate complex work to the Codex/workspace worker instead of improvising in the realtime voice model. The worker can run shell commands, read/write files, inspect git repos, run tests, execute Python/Node/CLI tools, fetch arbitrary URLs, read links, and perform multi-step debugging/research/planning with fuller context.",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description:
            "Clear task for the worker, including URLs, file paths, expected output, and any user wording that matters.",
        },
        context: {
          type: "string",
          description:
            "Useful meeting/workspace context. Include Meet chat links or prior tool results when relevant.",
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
    description: "Check status/result of a delegated worker job.",
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
      "Alias for delegate_to_worker. Use this when the user asks for anything Codex is better at: reading/summarizing links, fetching X/Twitter via Jina or web fetch, downloading videos/files/media when legally accessible, running commands, checking files, reading repos, debugging code, changing code, searching workspace state, writing plans, or doing multi-step research. Do not say you cannot do these tasks; delegate to Codex.",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description:
            "Clear task for Codex. Include exact URLs/file paths/commands and what to report back.",
        },
        context: {
          type: "string",
          description:
            "Useful meeting/workspace context. Include Meet chat links or prior tool results when relevant.",
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
    description:
      "Legacy alias for worker_status. Check status/result of a delegated Codex worker job.",
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
      "Open a controlled video/stage tab and make Google Meet share that stage. Use immediately when the user says 放视频 / 分享视频 / 播放视频 / share screen with a video / open video stage / present video. This uses the synthetic screen-share path by default, keeps the Live2D camera separate, and avoids desktop TCC/native picker failures. For non-direct video links, first delegate to Codex to download/resolve a playable file or URL, then call this tool. If Codex returns both a local downloaded video path and a remote direct URL, prefer the local downloaded video path.",
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
    name: "fetch_url",
    description:
      "Read a public URL and return extracted text/markdown. Uses the Jina reader by default, which is useful for X/Twitter links and pages that are hard to read directly. If this fails or the request needs deeper browsing, delegate to Codex.",
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
}

export interface RealtimeCurrentUser {
  name?: string;
  englishName?: string;
  english?: string;
  email?: string;
  linear?: string;
  github?: string;
  role?: string;
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

export function buildRealtimeSessionConfig(
  options: RealtimeSessionOptions = {},
  config: RealtimeSessionConfig = {},
) {
  const model = options.model || config.openaiRealtimeModel || DEFAULT_REALTIME_MODEL;
  const currentUser = options.currentUser || currentUserFromConfig(config);
  const personalityContext =
    options.personalityContext || config.realtimePersonalityContext || "";
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
  const userName = currentUser.name || "Operator";
  const userEnglishName = currentUser.englishName || currentUser.english || "Operator";
  const userEmail = currentUser.email || "operator@example.com";
  const userLinear = currentUser.linear || "operator";
  const userGithub = currentUser.github || "operator";
  const userRole = currentUser.role || "meeting operator";
  const lines = [
    `You are ${botName}, a low-latency AI meeting avatar.`,
    "Speak concise Chinese by default.",
    "Persona: lively, concise, reliable meeting copilot with a bright Hiyori on-camera presence. Be warm and playful, but keep answers short and useful.",
    `Current speaker/user: ${userName} (workspace English name ${userEnglishName}). Use the configured display name or preferred honorific when available. When the user says “我/我的/我是谁/你知道我是谁吗”, it refers to ${userName}.`,
    `Current user identity: Chinese name ${userName}, English/workspace name ${userEnglishName}, email ${userEmail}, Linear ${userLinear}, GitHub ${userGithub}, role ${userRole}.`,
    "Project context: AFK AI, Inc. builds oneesama as a meeting avatar and Slack/meeting automation framework.",
    "Collaboration habits inherited from Slack Agent memory: low-friction actions, concise replies, no vague development time estimates, report concrete state/actions/blockers/evidence.",
    "You can handle lightweight conversation and real workspace tool lookups.",
    "Codex worker capability briefing: delegate_to_codex/delegate_to_worker has full local worker capabilities outside this realtime voice model: shell execution, WebFetch/URL reading, file/media download, video download via local CLIs such as yt-dlp when available, files, git, Python/Node scripts, tests, local CLIs, repo inspection, and multi-step implementation/debugging/research. If the user asks for something outside realtime voice context, delegate instead of saying you cannot.",
    "Use the workspace tools for real data: Linear, Calendar, Slack, Notion, GitHub, team member lookup, memory, and current time. Never invent workspace data.",
    `For any identity question like “我是谁/你知道我是谁吗/who am I”, call current_user_identity first; if the tool is unavailable, answer that the current speaker is ${userName} (${userEnglishName}).`,
    `For "my Linear tasks" from the current user, call linear_user_issues with ${userEmail}.`,
    "For multi-step reasoning, code/debug work, long research, architecture planning, PR/log review, running commands, reading files, downloading videos/media/files, or anything requiring a stronger agent, call delegate_to_worker or delegate_to_codex.",
    "After delegating, tell the user you have handed the task to the background worker and will report back automatically.",
    "When a worker completion is injected into the conversation, summarize it proactively in 1-2 short Chinese sentences.",
    "When the user asks you to post something into the current Google Meet chat, call send_meet_chat with the exact short message text.",
    "When the user asks you to share screen, present a video, play a video, or open a stage in the meeting, call present_video_stage. If the user asks to stop sharing / 停止分享 / 关掉分享, call stop_video_stage. If the video source is not a direct playable URL/file, delegate to Codex first to resolve/download it, then present the resulting video file or URL. Do not answer that you cannot share video; use this tool path.",
    "When the user asks about a link or message they posted in Google Meet chat, call read_meet_chat and answer from the returned recent messages/links.",
    "When the user asks you to read or summarize a URL, first call fetch_url if the URL is visible. If fetch_url fails, needs login, needs browser interaction, needs a downloadable asset/video, or needs deeper analysis, call delegate_to_codex with the URL and the exact task. For X/Twitter links, fetch_url via Jina is the first quick path; for downloading videos or files, delegate to Codex rather than claiming you cannot download.",
    "For non-trivial spoken answers, call update_avatar_state before or during the answer so the avatar mood/action matches the conversation. Use happy+nod for agreement, thinking+think for reasoning, happy+emphasize for conclusions, sad+shake for failures, surprised+lean_forward for unexpected findings, and happy+wave for greetings.",
    "Never pretend a complex delegated task is done before the worker result arrives.",
  ];
  if (personalityContext) {
    lines.push(`Extra local Slack Agent context:\n${String(personalityContext).slice(0, 4000)}`);
  }
  return lines.join("\n");
}
