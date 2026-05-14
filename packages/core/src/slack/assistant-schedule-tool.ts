export const SLACK_SCHEDULE_METADATA_CHANNEL_ID = "slack_channel_id";
export const SLACK_SCHEDULE_METADATA_THREAD_TS = "slack_thread_ts";

export const ASSISTANT_SCHEDULE_TOOL_NAME = "manage_schedule";
export const ASSISTANT_SCHEDULE_ACTIONS = ["list"];

/**
 * Schedule definitions accept both snake_case and PascalCase variants because
 * they're produced by both the Go server (PascalCase) and TS clients
 * (snake_case). We list every known field as optional with both casings.
 */
export interface ScheduleDefinitionInput {
  id?: string;
  ID?: string;
  name?: string;
  Name?: string;
  description?: string;
  Description?: string;
  prompt?: string;
  Prompt?: string;
  metadata?: Record<string, unknown>;
  Metadata?: Record<string, unknown>;
  cron_expr?: string;
  cronExpr?: string;
  CronExpr?: string;
  count_limit?: number;
  countLimit?: number;
  CountLimit?: number;
  date_time_limit?: string;
  dateTimeLimit?: string;
  DateTimeLimit?: string;
  timezone?: string;
  Timezone?: string;
  is_paused?: boolean;
  isPaused?: boolean;
  IsPaused?: boolean;
  deleted_at?: string;
  deletedAt?: string;
  DeletedAt?: string;
  run_history?: unknown;
  runHistory?: unknown;
  RunHistory?: unknown;
  created_at?: string;
  createdAt?: string;
  CreatedAt?: string;
  updated_at?: string;
  updatedAt?: string;
  UpdatedAt?: string;
  [key: string]: unknown;
}

export interface ScheduleContextInput {
  channelId?: string;
  channel_id?: string;
  threadTs?: string;
  thread_ts?: string;
}

export interface ScheduleManagerLike {
  list?: () => Promise<ScheduleDefinitionInput[]> | ScheduleDefinitionInput[];
  List?: () => Promise<ScheduleDefinitionInput[]> | ScheduleDefinitionInput[];
  definitions?: ScheduleDefinitionInput[] | (() => ScheduleDefinitionInput[]);
  schedules?: ScheduleDefinitionInput[];
  [key: string]: unknown;
}

export function assistantScheduleToolDescription(): string {
  return 'Inspect durable scheduled tasks created from the current Slack thread. Assistant sessions only support action="list". Creating or changing schedules is not available here.';
}

export function assistantScheduleToolParameters() {
  return {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ASSISTANT_SCHEDULE_ACTIONS,
        description:
          'The action to perform. Assistant sessions only support "list" for schedules created from the current Slack thread.',
      },
    },
    required: ["action"],
    additionalProperties: false,
  };
}

function trim(value: unknown): string {
  return String(value || "").trim();
}

function legacySlackThreadContextLine(channelId: string, threadTs: string): string {
  return `[Context] This schedule was created in channel=${channelId} thread_ts=${threadTs}.`;
}

export function scheduleMetadataMatchesSlackThread(
  definition: ScheduleDefinitionInput = {},
  channelId: string = "",
  threadTs: string = "",
): boolean {
  const channel = trim(channelId);
  const thread = trim(threadTs);
  if (!channel || !thread) return false;
  const metadata = (definition.metadata || definition.Metadata || {}) as Record<string, unknown>;
  return (
    trim(metadata[SLACK_SCHEDULE_METADATA_CHANNEL_ID]) === channel &&
    trim(metadata[SLACK_SCHEDULE_METADATA_THREAD_TS]) === thread
  );
}

export function scheduleBelongsToSlackThread(
  definition: ScheduleDefinitionInput = {},
  channelId: string = "",
  threadTs: string = "",
): boolean {
  const channel = trim(channelId);
  const thread = trim(threadTs);
  if (!channel || !thread) return false;
  if (scheduleMetadataMatchesSlackThread(definition, channel, thread)) return true;
  const prompt = String(definition.prompt || definition.Prompt || "");
  return prompt.includes(legacySlackThreadContextLine(channel, thread));
}

export function filterSchedulesForCurrentSlackThread(
  definitions: ScheduleDefinitionInput[] = [],
  context: ScheduleContextInput = {},
): ScheduleDefinitionInput[] {
  const channelId = trim(context.channelId || context.channel_id);
  const threadTs = trim(context.threadTs || context.thread_ts);
  if (!channelId || !threadTs || !Array.isArray(definitions) || definitions.length === 0) return [];
  return definitions.filter((definition) =>
    scheduleBelongsToSlackThread(definition, channelId, threadTs),
  );
}

function normalizeScheduleDefinition(definition: ScheduleDefinitionInput = {}) {
  return {
    id: trim(definition.id || definition.ID),
    name: definition.name || definition.Name || "",
    description: definition.description || definition.Description || "",
    prompt: definition.prompt || definition.Prompt || "",
    metadata: definition.metadata || definition.Metadata || undefined,
    cron_expr: definition.cron_expr || definition.cronExpr || definition.CronExpr || "",
    count_limit:
      definition.count_limit ?? definition.countLimit ?? definition.CountLimit ?? undefined,
    date_time_limit:
      definition.date_time_limit ||
      definition.dateTimeLimit ||
      definition.DateTimeLimit ||
      undefined,
    timezone: definition.timezone || definition.Timezone || "",
    is_paused: Boolean(definition.is_paused ?? definition.isPaused ?? definition.IsPaused ?? false),
    deleted_at: definition.deleted_at || definition.deletedAt || definition.DeletedAt || undefined,
    run_history:
      definition.run_history || definition.runHistory || definition.RunHistory || undefined,
    created_at: definition.created_at || definition.createdAt || definition.CreatedAt || undefined,
    updated_at: definition.updated_at || definition.updatedAt || definition.UpdatedAt || undefined,
  };
}

function stripUndefinedFields<T extends Record<string, unknown>>(object: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

function mutationBlockedResult(action: unknown) {
  return {
    ok: false,
    success: false,
    tool: ASSISTANT_SCHEDULE_TOOL_NAME,
    error: "assistant_mutation_blocked",
    action: trim(action),
    allowed_actions: ASSISTANT_SCHEDULE_ACTIONS,
    text: `Action ${JSON.stringify(trim(action))} is not available in assistant sessions. Allowed actions: ${ASSISTANT_SCHEDULE_ACTIONS.map((item) => JSON.stringify(item)).join(", ")}.`,
    metadata: {
      allowed_actions: ASSISTANT_SCHEDULE_ACTIONS,
    },
  };
}

async function listScheduleDefinitions(
  scheduleManager: ScheduleManagerLike | null | undefined,
): Promise<ScheduleDefinitionInput[]> {
  if (!scheduleManager) return [];
  if (typeof scheduleManager.list === "function") return await scheduleManager.list();
  if (typeof scheduleManager.List === "function") return await scheduleManager.List();
  if (typeof scheduleManager.definitions === "function") return scheduleManager.definitions();
  if (Array.isArray(scheduleManager.definitions)) return scheduleManager.definitions;
  if (Array.isArray(scheduleManager.schedules)) return scheduleManager.schedules;
  return [];
}

export interface ExecuteAssistantScheduleToolArgs {
  action?: string;
  channel_id?: string;
  channelId?: string;
  thread_ts?: string;
  threadTs?: string;
  [key: string]: unknown;
}

export interface ExecuteAssistantScheduleToolOptions {
  channelId?: string;
  channel_id?: string;
  threadTs?: string;
  thread_ts?: string;
  scheduleManager?: ScheduleManagerLike | null;
  scheduleStore?: ScheduleManagerLike | null;
  sessionMetadata?: {
    channel_id?: string;
    channelId?: string;
    thread_ts?: string;
    threadTs?: string;
    [key: string]: unknown;
  };
  slackContext?: {
    channel_id?: string;
    channelId?: string;
    thread_ts?: string;
    threadTs?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export async function executeAssistantScheduleTool(
  args: ExecuteAssistantScheduleToolArgs = {},
  options: ExecuteAssistantScheduleToolOptions = {},
) {
  const action = trim(args.action || "list");
  if (action !== "list") return mutationBlockedResult(action);

  const channelId = trim(
    args.channel_id ||
      args.channelId ||
      options.channelId ||
      options.channel_id ||
      options.sessionMetadata?.channel_id ||
      options.sessionMetadata?.channelId ||
      options.slackContext?.channel_id ||
      options.slackContext?.channelId,
  );
  const threadTs = trim(
    args.thread_ts ||
      args.threadTs ||
      options.threadTs ||
      options.thread_ts ||
      options.sessionMetadata?.thread_ts ||
      options.sessionMetadata?.threadTs ||
      options.slackContext?.thread_ts ||
      options.slackContext?.threadTs,
  );
  if (!channelId || !threadTs) {
    return {
      ok: false,
      success: false,
      tool: ASSISTANT_SCHEDULE_TOOL_NAME,
      error: "slack_thread_context_required",
      text: "Slack channel_id and thread_ts are required to list assistant schedules for the current thread.",
      metadata: { schedule_ids: [] },
    };
  }

  const definitions = await listScheduleDefinitions(
    options.scheduleManager || options.scheduleStore,
  );
  const schedules = filterSchedulesForCurrentSlackThread(definitions, { channelId, threadTs }).map(
    (definition) => stripUndefinedFields(normalizeScheduleDefinition(definition)),
  );
  const scheduleIds = schedules.map((definition) => definition.id).filter(Boolean);
  const text = JSON.stringify(schedules, null, 2);
  return {
    ok: true,
    success: true,
    tool: ASSISTANT_SCHEDULE_TOOL_NAME,
    schedules,
    text,
    metadata: {
      schedule_ids: scheduleIds,
    },
  };
}

export function createInMemoryAssistantScheduleManager(
  definitions: ScheduleDefinitionInput[] = [],
): ScheduleManagerLike {
  const schedules = [...definitions];
  return {
    async list() {
      return schedules.map((definition) => ({
        ...definition,
        metadata: definition.metadata ? { ...definition.metadata } : definition.metadata,
      }));
    },
  };
}
