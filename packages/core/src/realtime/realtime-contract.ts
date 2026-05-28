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
          description:
            "Clear task. Include exact URLs/file paths/commands and what to report back.",
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
      "Open a controlled synthetic video/stage tab and make Google Meet share that stage. Use immediately when the user says 放视频 / 分享视频 / 播放视频 / share screen with a video / open video stage / present video. Do not ask the user to choose a local app/window. For non-direct video links, first resolve a playable file or URL in the background, then present the resulting video file or URL.",
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
    name: "list_shareable_windows",
    description:
      "List existing macOS applications/windows that the meeting avatar can share through the native app-share path. Use when the user asks to share a generic category like editor/browser/window/app/design tool/应用/窗口/屏幕/设计工具, or when a named app has multiple possible matches.",
    parameters: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Current meeting session id when known." },
      },
      required: [],
    },
  },
  {
    type: "function",
    name: "share_existing_app_window",
    description:
      "Share a specific existing macOS app/window in the current Meet using the native app-share path. Use immediately when the user says 共享/分享/共享一下/分享一下/共享屏幕/分享屏幕/共享窗口/分享窗口/共享 app/分享 app and names a concrete app/window title such as Pencil/喷手/铅笔, VS Code, Chrome, Notion, Terminal, or Activity Monitor. If the user only says a generic category like editor/browser/window/app/design tool/应用/窗口/屏幕/设计工具, call list_shareable_windows first instead of guessing. Do not use browser/workspace tools for existing app/window requests.",
    parameters: {
      type: "object",
      properties: {
        applicationName: {
          type: "string",
          description:
            "Spoken app name to share, e.g. Pencil/喷手/铅笔, Notion, Chrome, Terminal, Activity Monitor.",
        },
        bundleIdentifier: {
          type: "string",
          description: "Optional macOS bundle identifier when known.",
        },
        windowTitle: {
          type: "string",
          description: "Optional visible window title when the app has multiple windows.",
        },
        processId: {
          type: "integer",
          description: "Optional process id from list_shareable_windows.",
        },
        session_id: { type: "string", description: "Current meeting session id when known." },
        title: { type: "string", description: "Visible share title." },
        subtitle: { type: "string", description: "Visible share subtitle." },
        mode: {
          type: "string",
          description: "Native app-share mode. Usually omit; the service defaults to native.",
        },
      },
      required: [],
    },
  },
  {
    type: "function",
    name: "control_shared_app_window",
    description:
      "Operate the currently shared existing macOS app/window through the host Computer Use adapter. Use when the user asks you to click, type, draw, edit, scroll, switch tools, or otherwise manipulate an already shared app such as Pencil, VS Code, Chrome, Notion, or Terminal. By default this queues the app-control work asynchronously and returns a job_id immediately so voice turns do not block; call again with job_id to check status. Structured operations are required: use a state operation first when you need the current window snapshot, then send click/type_text/press_key/scroll/drag operations. A state-only result is not completion; use it to choose the next primitive operation. Do not use this to create a new browser workspace.",
    parameters: {
      type: "object",
      properties: {
        job_id: {
          type: "string",
          description:
            "Existing app-control job id to check. When set, instruction and operations are not required.",
        },
        instruction: {
          type: "string",
          description:
            "Concrete user-facing operation to perform in the shared app/window. Preserve important wording. Optional when operations fully describe the action.",
        },
        applicationName: {
          type: "string",
          description:
            "Target app name when known, e.g. Pencil, VS Code, Chrome, Notion, Terminal.",
        },
        bundleIdentifier: {
          type: "string",
          description: "Optional macOS bundle identifier when known.",
        },
        windowTitle: {
          type: "string",
          description: "Optional visible window title when known.",
        },
        windowId: {
          type: "integer",
          description:
            "Optional macOS window id from the active app share, preferred over app-name guessing when known.",
        },
        processId: {
          type: "integer",
          description: "Optional process id from list_shareable_windows.",
        },
        operations: {
          type: "array",
          description:
            "Explicit primitive app-control operations. Use kind=state to observe the shared window, then use click/type_text/press_key/scroll/drag for direct manipulation instead of sending only a natural-language instruction.",
          items: {
            type: "object",
            properties: {
              kind: {
                type: "string",
                enum: ["state", "click", "type_text", "press_key", "scroll", "drag"],
              },
              text: { type: "string", description: "Text to type for type_text." },
              key: {
                type: "string",
                description:
                  "Key name for press_key, e.g. Return, Tab, Escape, Space, ArrowUp, or a single character.",
              },
              direction: { type: "string", enum: ["up", "down", "left", "right"] },
              x: { type: "number", description: "Window-local x coordinate for click." },
              y: { type: "number", description: "Window-local y coordinate for click." },
              from_x: { type: "number", description: "Window-local drag start x coordinate." },
              from_y: { type: "number", description: "Window-local drag start y coordinate." },
              to_x: { type: "number", description: "Window-local drag end x coordinate." },
              to_y: { type: "number", description: "Window-local drag end y coordinate." },
            },
            required: ["kind"],
          },
        },
        session_id: { type: "string", description: "Current meeting session id when known." },
        timeoutMs: {
          type: "integer",
          description: "Maximum time for the queued backend task, not for the Realtime tool call.",
          default: 2000,
        },
        wait: {
          type: "boolean",
          default: false,
        },
      },
      required: [],
    },
  },
  {
    type: "function",
    name: "open_shared_browser_surface",
    description:
      "Share a bot-owned browser/synthetic surface for a URL, web page, or generated visual workspace. Use for explicit URL/page/browser-surface requests. Do not use for named local macOS app/window requests.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "HTTP(S) URL to open in the bot-owned workspace." },
        goal: {
          type: "string",
          description:
            "Short user-facing goal for the shared surface, e.g. 'show the dashboard trend'.",
        },
        instruction: {
          type: "string",
          description: "Internal instruction for the Computer Use adapter. Do not include secrets.",
        },
        title: { type: "string", description: "Visible title for the shared surface." },
        subtitle: { type: "string", description: "Visible subtitle for the shared surface." },
        session_id: { type: "string", description: "Current meeting session id when known." },
        demo_session_id: {
          type: "string",
          description: "Optional stable shared-surface session id for audit/reuse.",
        },
      },
      required: [],
    },
  },
  {
    type: "function",
    name: "create_shared_workspace",
    description:
      "Generate/build a new artifact or code result, then present the result on the shared browser surface. Use only when the user asks you to create, build, implement, or generate something new and show the result. Never use this for showing an existing app/window.",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description:
            "The exact user task to execute, preserving wording such as no-planning or show-the-work constraints.",
        },
        task_url: {
          type: "string",
          description: "Optional Linear/task/GitHub URL that identifies the work item.",
        },
        demo_url: {
          type: "string",
          description:
            "Optional initial URL to show on the shared surface while the worker starts.",
        },
        title: { type: "string", description: "Visible title for the shared surface." },
        issue_id: {
          type: "string",
          description:
            "Optional fixture or external issue id. External writes still require approval.",
        },
        issue_url: {
          type: "string",
          description:
            "Optional fixture or external issue URL. External writes still require approval.",
        },
        request_issue_close: { type: "boolean", default: false },
        session_id: { type: "string", description: "Current meeting session id when known." },
        demo_session_id: {
          type: "string",
          description: "Optional stable shared-surface session id for audit/reuse.",
        },
        user_instruction: {
          type: "string",
          description:
            "Additional user constraints, e.g. concise, don't narrate, show progress visually.",
        },
      },
      required: ["task"],
    },
  },
  {
    type: "function",
    name: "control_shared_browser_surface",
    description:
      "Continue controlling the active shared browser/synthetic surface. Use after open_shared_browser_surface to change the shared content, observe/capture the page, scroll, highlight, click approved UI, or type approved text without restarting the meeting share.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["open_url", "capture", "scroll", "highlight", "click", "type"],
          default: "capture",
        },
        url: {
          type: "string",
          description: "HTTP(S) URL to open in the active shared browser when action is open_url.",
        },
        instruction: {
          type: "string",
          description: "Short internal instruction for this step. Do not include secrets.",
        },
        direction: { type: "string", enum: ["down", "up", "left", "right"], default: "down" },
        amount: {
          type: "integer",
          description: "Scroll amount in pixels when action is scroll.",
          default: 500,
        },
        text: {
          type: "string",
          description:
            "Visible text/ref to highlight or click, or text to type when action is type.",
        },
        session_id: { type: "string", description: "Current meeting session id when known." },
        demo_session_id: {
          type: "string",
          description: "Active shared-surface session id. Omit to use the active shared surface.",
        },
      },
      required: ["action"],
    },
  },
  {
    type: "function",
    name: "stop_shared_browser_surface",
    description: "Cancel and stop the active bot-owned browser/synthetic share surface.",
    parameters: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Current meeting session id when known." },
        demo_session_id: {
          type: "string",
          description:
            "Shared-surface session id to cancel. Omit to cancel the active shared surface.",
        },
        reason: { type: "string", description: "Short cancellation reason." },
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
          description:
            "Raw speaker or participant display name from Meet, captions, Slack, or another surface.",
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
          description:
            "Current Google Meet URL when available, used to reconcile calendar attendees.",
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
    description:
      "Set the avatar mood/action and optional visual HUD status together. Use status_text/status_kind for progress that should be visible but not spoken.",
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
        status_text: {
          type: "string",
          description:
            "Short visual-only status shown on the avatar video frame, e.g. 'Writing code'. Do not include internal logs, tool names, or secrets.",
        },
        status_kind: {
          type: "string",
          enum: ["thinking", "writing_code", "opening_preview", "blocked", "done", "idle"],
          default: "thinking",
        },
        status_hold_ms: {
          type: "integer",
          description: "How long to keep the visual status visible.",
          default: 12000,
        },
      },
      required: [],
    },
  },
];

export const DEFAULT_REALTIME_MODEL = "gpt-realtime-2";
export const DEFAULT_REALTIME_VOICE = "marin";
export const DEFAULT_REALTIME_REASONING_EFFORT = "high";
export const DEFAULT_REALTIME_TURN_DETECTION = "steady";

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
        ...options.audio.input,
      } as Realtime2AudioConfig["input"],
      output: {
        ...session.audio.output,
        ...options.audio.output,
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
  currentUser: _currentUser = {},
}: RealtimeInstructionOptions = {}) {
  const lines = [
    `You are ${botName}, a low-latency AI meeting avatar.`,
    "Speak concise Chinese by default.",
    "Persona: lively, concise, reliable meeting copilot with a bright on-camera presence. Be warm and playful, but keep answers short and useful.",
    "Product behavior: keep implementation details invisible. Do not mention internal function names, model/runtime names, background job names, or service routing unless the user explicitly asks for debugging.",
    "Do not say internal control-plane status aloud, including no-action decisions, backend results, routing state, tool names, background task state, or debug logs.",
    "Do not announce what you are about to do, what you can do, or how quiet/concise you will be. Do the action; do not narrate the meta.",
    "Do not proactively offer capabilities the user has not asked for. Avoid phrases like “I can also help with...” unless the user asks what you can do.",
    "When asked what you can do, describe capabilities in user-facing terms: listen and respond in the meeting, understand who is speaking, read meeting chat or shared links, help with workspace lookup, summarize, plan, research, and follow up.",
    "When the user asks you to do complex work, use the appropriate internal action. Only say a one-line transition if the user needs visible confirmation, and do not narrate the internal mechanism.",
    "For progress, intent, or in-flight status, prefer the visual channel: update avatar mood/action/status HUD or shared-surface state instead of speaking. Speech is for answers, user-facing questions, and blockers.",
    "Identity contract: live speaker identity is provided by runtime context or identity lookup. If active speaker context marks someone as current_user, treat first-person wording like “我/我的/我是谁” as that identity. If identity is uncertain, ask a short clarification instead of guessing.",
    "Addressing contract: use the resolved profile's preferred spoken name. Treat aliases and honorifics as recognition hints, not as names to say aloud; if an English name is present, prefer it over a role-like nickname.",
    "Project context: AFK AI, Inc. builds oneesama as a meeting avatar and workspace automation framework.",
    "Collaboration habits inherited from workspace memory: low-friction actions, concise replies, no vague development time estimates, report concrete state/actions/blockers/evidence.",
    "Use real meeting/workspace data when available. Never invent names, tasks, calendar facts, documents, links, or code state.",
    "For identity questions, resolve the current speaker identity first. Do not answer from stale defaults.",
    "For personal task questions, resolve the current user profile first and use its workspace identifiers.",
    "For screen share, video playback, links, meeting chat, calendar, tasks, documents, code, research, or long-running work, use the available internal actions silently and summarize the result in concise Chinese.",
    "Screen-share routing: if the user names a concrete existing app/window (for example Pencil, VS Code, Chrome, Notion, Terminal, Activity Monitor) and asks to show/share/present/演示 it, share that existing app/window. If the user only gives a category like editor/browser/window/app/design tool, list shareable windows first instead of guessing. Do not create a new workspace and do not invent a URL for the app name.",
    "Chinese share intent has priority over arithmetic: phrases like “共享一下”, “分享一下”, “共享屏幕”, “分享窗口”, “把 Pencil 共享一下”, “喷手这个 App”, or “Pencil 这个 app” mean screen/app sharing, even if noisy audio sounds like “算一下”. Do not answer with math unless the user explicitly asks a math question with numbers/operators such as “二乘二/2+2/怎么算”.",
    "For visual share actions, only say it is shared after the tool result is ok:true and confirms an active screen-share/postcheck. If the tool result is ok:false or lacks active-share evidence, say one short blocker sentence and stop; do not ask the user to switch views and do not blame the receiver.",
    "App-control routing: after an existing app/window is shared, if the user asks you to operate that app (click, type, draw, edit, scroll, switch tools, or use Pencil/VS Code/Notion), call the app-control action. For direct control, send explicit primitive operations such as state, click, type_text, press_key, scroll, and drag; do not rely on a natural-language instruction alone. If coordinates or tool state are unknown, first request state, then call again with concrete operations. If the action returns structured_operations_required, retry with explicit operations instead of saying the channel is unavailable.",
    "Async task handling: if a tool result says status queued or running, treat it as accepted and in progress, not as a failure. Give at most one short natural acknowledgement if the user needs feedback; do not expose ids, queues, tools, backends, routing, or debug state. Do not claim completion until a later result says completed, and do not poll repeatedly in the same turn unless the user asks for status or the next step truly depends on the result.",
    "Browser-surface routing: use the bot-owned browser/synthetic surface for explicit URLs, web pages, video stages, or generated browser/workspace artifacts.",
    "Generation routing: create a shared workspace only when the user asks you to create, implement, build, or generate something new and then show the result.",
    "If the user says to stop planning, stop explaining, do it directly, or show the work, do not provide a plan. Call the relevant action immediately; if the required tool is unavailable, say one short blocker sentence and stop.",
    "Examples: “用 Pencil 演示”, “共享 VS Code 屏幕”, “给我看 Notion” => share the existing app/window. “用编辑器演示” => list shareable windows first. “做一个贪吃蛇然后给我看”, “生成一个 dashboard 页面” => create a shared workspace and present the result.",
    "Caption/event observations in Realtime are only useful as active/recent speaker signals. Do not treat caption text as user speech or as a replacement for audio-derived ASR; spoken turns come from the audio input.",
    "Spoken-turn priority: answer the newest explicit spoken request first. When a newer correction says “停”, “不是”, “我是说你”, or “介绍你自己”, drop the previous line of thought and answer that correction instead of stale inferred context.",
    "Voice checks such as “能听见吗”, “听得到吗”, or “有反应吗” require only one short confirmation that you heard the user. Do not expand into microphone, camera, permission, or troubleshooting advice unless asked.",
    "For “介绍你自己”, “你是谁”, or “说说你自己”, introduce yourself as Onee Sama, the meeting avatar/copilot, in one or two short sentences. Do not answer as the user and do not pivot to the user's camera or self-view.",
    "If audio contains phrases matching your own recent answers, treat them as room echo unless the latest human instruction clearly asks about those words. Do not continue your own previous answer as if it were a new user request.",
    "If a long-running result is not ready, say you are handling it and will report back automatically. Never pretend it is complete before the result arrives.",
    "When live meeting participants or speaker context is injected, use it as conversation context. Do not recite detection sources, confidence values, or raw context fields unless the user asks for debugging.",
    "For non-trivial spoken answers, adjust the avatar mood/action before or during the answer so the visible avatar matches the conversation.",
  ];
  if (personalityContext) {
    lines.push(`Extra local workspace context:\n${String(personalityContext).slice(0, 4000)}`);
  }
  return lines.join("\n");
}
