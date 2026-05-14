import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { getRuntimeConfig } from "../env.js";
import { createStateCollection, type StateCollection } from "../persistence/state-provider.js";

const TERMINAL_STATUSES = new Set(["completed", "failed", "timeout"]);
const CODEX_TOOL_STATUS_LABELS = new Map([
  ["exec_command", "Running command..."],
  ["write_stdin", "Interacting with command..."],
  ["apply_patch", "Editing files..."],
  ["view_image", "Inspecting image..."],
  ["read_mcp_resource", "Reading resource..."],
  ["list_mcp_resources", "Listing resources..."],
  ["list_mcp_resource_templates", "Listing resources..."],
  ["spawn_agent", "Delegating to worker..."],
  ["wait_agent", "Waiting for worker..."],
  ["close_agent", "Closing worker..."],
  ["send_input", "Messaging worker..."],
  ["web.run", "Using web tool..."],
]);

function safeName(value, fallback = "session") {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return normalized || fallback;
}

function hashText(value) {
  return crypto
    .createHash("sha256")
    .update(String(value || ""))
    .digest("hex")
    .slice(0, 16);
}

function text(value: unknown, fallback: string = ""): string {
  const normalized = String(value || "").trim();
  return normalized || fallback;
}

function normalizeThreadTs(value: unknown): string {
  const normalized = text(value);
  return normalized === "channel-root" ? "" : normalized;
}

interface SlackContext {
  workspaceId?: string;
  teamId?: string;
  team_id?: string;
  channelId?: string;
  channel_id?: string;
  threadTs?: string;
  thread_ts?: string;
  userId?: string;
  user_id?: string;
  requestedBy?: string;
}

export interface CodexAppServerContext {
  codexAppServerSessionKey?: string;
  agentSessionKey?: string;
  codexAppServer?: { requestedSessionKey?: string };
  slack?: SlackContext;
  workspaceId?: string;
  teamId?: string;
  team_id?: string;
  channelId?: string;
  channel_id?: string;
  threadTs?: string;
  thread_ts?: string;
  userId?: string;
  user_id?: string;
  requestedBy?: string;
  sessionId?: string;
  meeting?: { sessionId?: string };
  [key: string]: unknown;
}

function explicitSessionKey(context: CodexAppServerContext = {}): string {
  return text(
    context.codexAppServerSessionKey ||
      context.agentSessionKey ||
      context.codexAppServer?.requestedSessionKey,
  );
}

interface SlackIdentity {
  workspaceId: string;
  channelId: string;
  threadTs: string;
  userId: string;
}

function slackIdentity(context: CodexAppServerContext = {}): SlackIdentity | null {
  const slack: SlackContext = context.slack || {};
  const workspaceId = text(
    slack.workspaceId ||
      slack.teamId ||
      slack.team_id ||
      context.workspaceId ||
      context.teamId ||
      context.team_id,
  );
  const channelId = text(
    slack.channelId || slack.channel_id || context.channelId || context.channel_id,
  );
  if (!workspaceId || !channelId) return null;
  return {
    workspaceId,
    channelId,
    threadTs: normalizeThreadTs(
      slack.threadTs || slack.thread_ts || context.threadTs || context.thread_ts,
    ),
    userId: text(
      slack.userId || slack.user_id || context.userId || context.user_id || context.requestedBy,
    ),
  };
}

function buildSlackSessionKey({
  context = {},
  task = "",
}: { context?: CodexAppServerContext; task?: string } = {}) {
  const identity = (slackIdentity(context) || {}) as Partial<SlackIdentity>;
  const workspaceId = text(identity.workspaceId, "workspace");
  const channelId = text(identity.channelId, "channel");
  const threadTs = normalizeThreadTs(identity.threadTs);
  if (threadTs) return ["slack", workspaceId, channelId, threadTs].join(":");

  const sessionId = text(context.sessionId);
  if (sessionId) return ["slack", workspaceId, channelId, "session", sessionId].join(":");

  const userId = text(identity.userId, "unknown-user");
  if (userId !== "unknown-user")
    return ["slack", workspaceId, channelId, "channel-root", userId].join(":");

  return ["slack", workspaceId, channelId, "channel-root", hashText(task)].join(":");
}

function buildSessionKey({
  context = {},
  task = "",
}: { context?: CodexAppServerContext; task?: string } = {}) {
  const explicit = explicitSessionKey(context);
  if (explicit) return explicit;

  if (slackIdentity(context)) {
    return buildSlackSessionKey({ context, task });
  }
  if (context.sessionId) return `meeting:${context.sessionId}`;
  if (context.meetUrl) return `meeting-url:${hashText(context.meetUrl)}`;
  return `adhoc:${hashText(task)}`;
}

function buildBaseInstructions({
  sessionKey,
  context = {},
}: { sessionKey?: string; context?: CodexAppServerContext } = {}) {
  return [
    "You are a Codex App Server worker for meeting-avatar-bot.",
    "Answer in concise Chinese unless the user explicitly asks otherwise.",
    "Use tools and local files when needed. If blocked, report the concrete blocker.",
    "",
    `Business session key: ${sessionKey}`,
    `Context: ${JSON.stringify(context)}`,
  ].join("\n");
}

function inputItem(textValue: unknown) {
  return {
    type: "text",
    text: String(textValue || ""),
    text_elements: [],
  };
}

function compactOneLine(value: unknown, maxLength = 80): string {
  const oneLine = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!oneLine) return "";
  return oneLine.length > maxLength ? `${oneLine.slice(0, maxLength - 1)}…` : oneLine;
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const textValue = compactOneLine(value);
    if (textValue) return textValue;
  }
  return "";
}

interface CodexEventItem {
  type?: string;
  kind?: string;
  turnId?: string;
  turn_id?: string;
  toolName?: string;
  tool_name?: string;
  name?: string;
  tool?: { name?: string };
  call?: { name?: string };
  command?: string;
  cmd?: string;
  input?: { cmd?: string; command?: string };
  message?: string;
  title?: string;
  summary?: string;
  text?: string;
  [key: string]: unknown;
}

interface CodexEventParams {
  turnId?: string;
  turn_id?: string;
  turn?: { id?: string };
  item?: CodexEventItem;
  msg?: { turn_id?: string; item?: CodexEventItem; [key: string]: unknown };
  event?: { item?: CodexEventItem; [key: string]: unknown };
  toolName?: string;
  tool_name?: string;
  name?: string;
  tool?: { name?: string };
  command?: string;
  cmd?: string;
  input?: { cmd?: string; command?: string };
  message?: string;
  progress?: string;
  delta?: string;
  text?: string;
  output?: string;
  itemType?: string;
  item_type?: string;
  [key: string]: unknown;
}

interface CodexAppServerMessage {
  method?: string;
  id?: string | number;
  params?: CodexEventParams;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
  [key: string]: unknown;
}

function eventTurnId(message: CodexAppServerMessage = {}): string {
  const params = message.params || {};
  return text(
    params.turnId ||
      params.turn_id ||
      params.turn?.id ||
      params.item?.turnId ||
      params.item?.turn_id ||
      params.msg?.turn_id,
  );
}

function eventItem(message: CodexAppServerMessage = {}): CodexEventItem {
  const params = message.params || {};
  return params.item || params.msg?.item || params.event?.item || {};
}

function labelForToolName(toolName: string = "") {
  const normalized = String(toolName || "").trim();
  if (!normalized) return "";
  return (
    CODEX_TOOL_STATUS_LABELS.get(normalized) ||
    CODEX_TOOL_STATUS_LABELS.get(normalized.replace(/^functions\\./, "")) ||
    `Using ${normalized}...`
  );
}

function toolNameFromEvent(message: CodexAppServerMessage = {}) {
  const params = message.params || {};
  const item = eventItem(message);
  return text(
    params.toolName ||
      params.tool_name ||
      params.name ||
      params.tool?.name ||
      item.toolName ||
      item.tool_name ||
      item.name ||
      item.tool?.name ||
      item.call?.name,
  );
}

function commandFromEvent(message: CodexAppServerMessage = {}) {
  const params = message.params || {};
  const item = eventItem(message);
  return firstText(
    params.command,
    params.cmd,
    params.input?.cmd,
    params.input?.command,
    item.command,
    item.cmd,
    item.input?.cmd,
    item.input?.command,
  );
}

function progressTextFromEvent(message: CodexAppServerMessage = {}) {
  const params = message.params || {};
  const item = eventItem(message);
  return firstText(
    params.message,
    params.progress,
    params.delta,
    params.text,
    params.output,
    item.message,
    item.title,
    item.summary,
  );
}

function itemTypeFromEvent(message: CodexAppServerMessage = {}) {
  const params = message.params || {};
  const item = eventItem(message);
  return text(params.itemType || params.item_type || item.type || item.kind);
}

function codexProgressFromEvent(message: CodexAppServerMessage = {}) {
  const method = String(message.method || "");
  const itemType = itemTypeFromEvent(message);
  const toolName = toolNameFromEvent(message);
  const command = commandFromEvent(message);
  const progressText = progressTextFromEvent(message);

  if (method === "item/agentMessage/delta") {
    return { status: "Composing reply...", toolName: "agent_message", method };
  }
  if (method === "item/plan/delta") {
    return { status: "Planning...", toolName: "plan", method };
  }
  if (method.startsWith("item/reasoning/")) {
    return { status: "Thinking...", toolName: "reasoning", method };
  }
  if (method.startsWith("item/autoApprovalReview/")) {
    return { status: "Checking action safety...", toolName: "approval", method };
  }
  if (method.startsWith("item/commandExecution/")) {
    return {
      status: command ? `Running command: ${command}` : "Running command...",
      toolName: "exec_command",
      method,
    };
  }
  if (method.startsWith("item/fileChange/")) {
    return { status: "Editing files...", toolName: "apply_patch", method };
  }
  if (method === "item/mcpToolCall/progress") {
    return {
      status: progressText || labelForToolName(toolName) || "Using tool...",
      toolName,
      method,
    };
  }
  if (method === "item/started") {
    if (itemType === "commandExecution") {
      return {
        status: command ? `Running command: ${command}` : "Running command...",
        toolName: "exec_command",
        method,
      };
    }
    if (itemType === "fileChange")
      return { status: "Editing files...", toolName: "apply_patch", method };
    if (itemType === "mcpToolCall" || itemType === "toolCall") {
      return { status: labelForToolName(toolName) || "Using tool...", toolName, method };
    }
    if (itemType === "reasoning") return { status: "Thinking...", toolName: "reasoning", method };
    if (itemType === "plan") return { status: "Planning...", toolName: "plan", method };
    if (itemType === "agentMessage")
      return { status: "Composing reply...", toolName: "agent_message", method };
    return { status: progressText || "Thinking...", toolName, method };
  }
  if (method === "item/completed") {
    if (itemType === "agentMessage")
      return { status: "Composing reply...", toolName: "agent_message", method };
    if (
      itemType === "commandExecution" ||
      itemType === "fileChange" ||
      itemType === "mcpToolCall" ||
      itemType === "toolCall"
    ) {
      return null;
    }
    return { status: "Thinking...", toolName: toolName || itemType, method };
  }
  if (method.startsWith("codex/event/")) {
    return {
      status: progressText || labelForToolName(toolName) || "Working on it...",
      toolName,
      method,
    };
  }
  return null;
}

function normalizeTurnStatus(status: unknown): string {
  if (
    typeof status === "string" &&
    ["completed", "failed", "interrupted", "inProgress"].includes(status)
  )
    return status;
  return "unknown";
}

interface CodexProcessConfig {
  codexAppServerUrl?: string;
  codexAppServerPort?: number | string;
  codexHome?: string;
  codexBin?: string;
  [key: string]: unknown;
}

class CodexAppServerProcess {
  config: CodexProcessConfig;
  child: import("node:child_process").ChildProcess | null;
  stdout: string;
  stderr: string;

  constructor({ config }: { config: CodexProcessConfig }) {
    this.config = config;
    this.child = null;
    this.stdout = "";
    this.stderr = "";
  }

  get url(): string {
    return this.config.codexAppServerUrl || `ws://127.0.0.1:${this.config.codexAppServerPort}`;
  }

  async start(): Promise<void> {
    if (this.config.codexAppServerUrl || this.child) return;
    const env = { ...process.env };
    if (this.config.codexHome) env.CODEX_HOME = this.config.codexHome;
    this.child = spawn(String(this.config.codexBin || ""), ["app-server", "--listen", this.url], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child.stdout?.on("data", (chunk: Buffer) => {
      this.stdout = `${this.stdout}${chunk.toString()}`.slice(-12000);
    });
    this.child.stderr?.on("data", (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString()}`.slice(-12000);
    });
    this.child.once("exit", () => {
      this.child = null;
    });
    await this.waitUntilConnectable();
  }

  async waitUntilConnectable(): Promise<void> {
    const deadline = Date.now() + 10000;
    let lastError: unknown = null;
    while (Date.now() < deadline) {
      const socket = new WebSocket(this.url);
      try {
        await new Promise<void>((resolve, reject) => {
          socket.addEventListener("open", () => resolve(), { once: true });
          socket.addEventListener("error", (event) => reject(event), { once: true });
        });
        socket.close();
        return;
      } catch (error) {
        lastError = error;
        try {
          socket.close();
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
    const err = lastError as { message?: string } | null;
    throw new Error(
      `codex app-server did not become ready: ${String(err?.message || lastError || "timeout")}`,
    );
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = null;
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 2500).unref();
    });
  }
}

interface CodexPendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
}

class CodexAppServerClient {
  url: string;
  serviceName: string;
  openaiApiKey: string;
  socket: WebSocket | null;
  requestCounter: number;
  pending: Map<string | number, CodexPendingRequest>;
  activeTurns: Map<string, unknown>;

  constructor({
    url,
    serviceName,
    openaiApiKey = "",
  }: {
    url: string;
    serviceName: string;
    openaiApiKey?: string;
  }) {
    this.url = url;
    this.serviceName = serviceName;
    this.openaiApiKey = openaiApiKey;
    this.socket = null;
    this.requestCounter = 0;
    this.pending = new Map();
    this.activeTurns = new Map();
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => this.handleMessage(String(event.data)));
    this.socket.addEventListener("close", () =>
      this.failAll(new Error("Codex app-server websocket closed")),
    );
    await this.request("initialize", {
      clientInfo: { name: this.serviceName, version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    await this.ensureAuthenticated();
  }

  async ensureAuthenticated() {
    const response = (await this.request("account/read", { refreshToken: false }).catch(
      () => null,
    )) as { account?: unknown } | null;
    if (response?.account) return;
    if (!this.openaiApiKey) return;
    await this.request("account/login/start", { type: "apiKey", apiKey: this.openaiApiKey });
  }

  async close() {
    if (!this.socket) return;
    const socket = this.socket;
    this.socket = null;
    socket.close();
  }

  async request(method, params = undefined) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Codex app-server websocket is not connected");
    }
    const id = String(++this.requestCounter);
    const payload = params === undefined ? { id, method } : { id, method, params };
    return await new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify(payload));
    });
  }

  async ensureThread(session) {
    if (session.codexThreadId) {
      const resumed = (await this.request("thread/resume", {
        threadId: session.codexThreadId,
        cwd: session.workspacePath,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        model: null,
        modelProvider: null,
        config: null,
        baseInstructions: null,
        developerInstructions: null,
        personality: null,
        persistExtendedHistory: true,
      })) as { thread?: { id?: string } };
      return resumed.thread?.id || "";
    }

    const started = (await this.request("thread/start", {
      cwd: session.workspacePath,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      model: null,
      modelProvider: null,
      config: null,
      serviceName: this.serviceName,
      baseInstructions: session.baseInstructions,
      developerInstructions: null,
      personality: null,
      ephemeral: false,
      experimentalRawEvents: true,
      persistExtendedHistory: true,
    })) as { thread?: { id?: string } };
    return started.thread?.id || "";
  }

  async startTurn({
    threadId,
    cwd,
    input,
    onEvent = null,
  }: {
    threadId: string;
    cwd: string;
    input: unknown;
    onEvent?: ((message: CodexAppServerMessage) => unknown) | null;
  }): Promise<{ threadId: string; turnId: string; finalMessage: string; aborted: boolean }> {
    const result = (await this.request("turn/start", {
      threadId,
      input,
      cwd,
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
      collaborationMode: null,
      outputSchema: null,
      model: null,
      effort: null,
      summary: "auto",
      personality: null,
    })) as { turn?: { id?: string } };
    const turnId = result.turn?.id || "";
    return await new Promise((resolve, reject) => {
      this.activeTurns.set(turnId, {
        threadId,
        turnId,
        text: "",
        onEvent: typeof onEvent === "function" ? onEvent : null,
        resolve,
        reject,
      });
    });
  }

  async readTurn({ threadId, turnId }: { threadId: string; turnId: string }) {
    const result = (await this.request("thread/read", {
      threadId,
      includeTurns: true,
    })) as {
      thread?: {
        turns?: Array<{
          id: string;
          status?: string;
          items?: Array<{ type?: string; text?: string }>;
          error?: { additionalDetails?: string; message?: string };
        }>;
      };
    };
    const turn = result.thread?.turns?.find((entry) => entry.id === turnId);
    if (!turn) return null;
    const lastAgentMessage = (turn.items || [])
      .filter((item) => item.type === "agentMessage")
      .at(-1);
    return {
      status: normalizeTurnStatus(turn.status),
      finalMessage: String(lastAgentMessage?.text || "").trim(),
      errorMessage: turn.error?.additionalDetails || turn.error?.message || "",
    };
  }

  handleMessage(raw: string): void {
    const message = JSON.parse(raw) as CodexAppServerMessage;
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result ?? null);
      return;
    }
    const turnId = eventTurnId(message);
    const turn = (turnId ? this.activeTurns.get(turnId) : null) as
      | {
          threadId: string;
          turnId: string;
          text: string;
          onEvent: ((message: CodexAppServerMessage) => unknown) | null;
          resolve: (value: unknown) => void;
          reject: (reason?: unknown) => void;
        }
      | null
      | undefined;
    if (turn?.onEvent) {
      try {
        turn.onEvent(message);
      } catch {}
    }
    if (message.method === "item/agentMessage/delta") {
      if (turn) turn.text += String(message.params?.delta || "");
      return;
    }
    if (message.method === "turn/completed") {
      const completedTurnId = String(message.params?.turn?.id || "");
      const completedTurn = this.activeTurns.get(completedTurnId) as typeof turn;
      if (!completedTurn) return;
      this.activeTurns.delete(completedTurnId);
      completedTurn.resolve({
        threadId: completedTurn.threadId,
        turnId: completedTurnId,
        finalMessage: completedTurn.text.trim(),
        aborted: false,
      });
      return;
    }
    if (message.method === "codex/event/turn_aborted") {
      const abortedTurnId = String(
        (message.params?.msg as { turn_id?: string } | undefined)?.turn_id || "",
      );
      const abortedTurn = this.activeTurns.get(abortedTurnId) as typeof turn;
      if (!abortedTurn) return;
      this.activeTurns.delete(abortedTurnId);
      abortedTurn.resolve({
        threadId: abortedTurn.threadId,
        turnId: abortedTurnId,
        finalMessage: abortedTurn.text.trim(),
        aborted: true,
      });
    }
  }

  failAll(error: unknown): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.reject(error);
    }
    for (const [id, turn] of this.activeTurns) {
      this.activeTurns.delete(id);
      (turn as CodexPendingRequest).reject(error);
    }
  }
}

export interface CreateCodexAppServerRunnerOptions {
  env?: NodeJS.ProcessEnv;
  dryRun?: boolean;
  onJobUpdate?: (job: unknown) => unknown;
  onJobProgress?: (job: unknown) => unknown;
  [key: string]: unknown;
}

interface CodexSessionRecord {
  id: string;
  sessionKey: string;
  codexThreadId: string;
  workspacePath: string;
  baseInstructions: string;
  createdAt: string;
  updatedAt: string;
}

export function createCodexAppServerRunner(options: CreateCodexAppServerRunnerOptions = {}) {
  const config = getRuntimeConfig(options.env);
  const dryRun = Boolean(options.dryRun);
  const notify = typeof options.onJobUpdate === "function" ? options.onJobUpdate : null;
  const notifyProgress = typeof options.onJobProgress === "function" ? options.onJobProgress : null;
  const jobs = new Map<string, Record<string, unknown>>();
  const sessions = createStateCollection({
    provider: config.stateProvider,
    filePath: config.codexAppServerSessionsPath,
    sqlitePath: config.stateSqlitePath,
    collection: "codex_app_server_sessions",
  }) as StateCollection<CodexSessionRecord>;
  const processHandle = new CodexAppServerProcess({ config });
  let client = null;

  interface CodexJobShape {
    id: string;
    provider: string;
    status: string;
    mode: string;
    task: string;
    context: Record<string, unknown>;
    createdAt: string;
    updatedAt?: string;
    progressEvents?: Array<Record<string, unknown>>;
    latestProgressStatus?: string;
    latestToolName?: string;
    latestProgressMethod?: string;
    sessionKey?: string;
    sessionId?: string;
    workspacePath?: string;
    finalMessage?: string;
    error?: unknown;
    result?: unknown;
    aborted?: boolean;
    [key: string]: unknown;
  }

  function updateJob(id: string, patch: Partial<CodexJobShape>): CodexJobShape | null {
    const current = jobs.get(id) as CodexJobShape | undefined;
    if (!current) return null;
    const next: CodexJobShape = { ...current, ...patch, updatedAt: new Date().toISOString() };
    jobs.set(id, next);
    if (notify && TERMINAL_STATUSES.has(next.status)) Promise.resolve(notify(next)).catch(() => {});
    return next;
  }

  function getJob(id: string): CodexJobShape | null {
    return (jobs.get(id) as CodexJobShape | undefined) || null;
  }

  function listJobs(): CodexJobShape[] {
    return [...(jobs.values() as Iterable<CodexJobShape>)].sort((a, b) =>
      String(a.createdAt).localeCompare(String(b.createdAt)),
    );
  }

  function ensureSession({
    task,
    context,
  }: {
    task: string;
    context: CodexAppServerContext;
  }): CodexSessionRecord {
    const sessionKey = buildSessionKey({ context, task });
    const id = hashText(sessionKey);
    const current = sessions.get(id);
    if (current) return current;
    const workspacePath = join(config.codexAppServerWorkspaceRoot, safeName(sessionKey, id));
    mkdirSync(workspacePath, { recursive: true });
    const created = {
      id,
      sessionKey,
      codexThreadId: "",
      workspacePath,
      baseInstructions: buildBaseInstructions({ sessionKey, context }),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    sessions.set(id, created);
    return created;
  }

  function updateSession(session: CodexSessionRecord): CodexSessionRecord {
    const next: CodexSessionRecord = { ...session, updatedAt: new Date().toISOString() };
    sessions.set(next.id, next);
    return next;
  }

  async function ensureClient() {
    if (client) return client;
    await processHandle.start();
    client = new CodexAppServerClient({
      url: processHandle.url,
      serviceName: "meeting-avatar-bot",
      openaiApiKey: config.openaiApiKey,
    });
    await client.connect();
    return client;
  }

  async function startTask({ task, context = {}, mode = "analysis", allowCodeChanges = false }) {
    let session = ensureSession({ task, context });
    const job = {
      id: `job_${crypto.randomUUID().slice(0, 8)}`,
      provider: "codex-app-server",
      status: dryRun ? "completed" : "running",
      mode,
      task,
      context: {
        ...context,
        codexAppServer: {
          sessionKey: session.sessionKey,
          sessionId: session.id,
          codexThreadId: session.codexThreadId,
          workspacePath: session.workspacePath,
        },
      },
      allowCodeChanges,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      result: dryRun ? "Dry-run Codex App Server runner accepted the task." : "",
      progressEvents: [],
    };
    jobs.set(job.id, job);

    if (dryRun) {
      if (!session.codexThreadId) {
        session = updateSession({
          ...session,
          codexThreadId: `dry_thread_${crypto.randomUUID().slice(0, 8)}`,
        });
      }
      updateJob(job.id, {
        context: {
          ...job.context,
          codexAppServer: {
            ...job.context.codexAppServer,
            codexThreadId: session.codexThreadId,
          },
        },
      });
      return getJob(job.id);
    }

    runAppServerTurn(job, session).catch((error) => {
      updateJob(job.id, { status: "failed", error: String(error?.message || error) });
    });
    return job;
  }

  async function runAppServerTurn(job, initialSession) {
    const appServer = await ensureClient();
    let session = initialSession;
    updateProgress(job.id, { status: "Starting Codex...", toolName: "codex" });
    const codexThreadId = await appServer.ensureThread(session);
    if (codexThreadId !== session.codexThreadId) {
      session = updateSession({ ...session, codexThreadId });
    }
    updateJob(job.id, {
      context: {
        ...job.context,
        codexAppServer: {
          ...job.context.codexAppServer,
          codexThreadId,
        },
      },
    });
    const turn = await appServer.startTurn({
      threadId: codexThreadId,
      cwd: session.workspacePath,
      input: [
        inputItem(
          [
            `Mode: ${job.mode}`,
            `Allow code changes: ${job.allowCodeChanges ? "yes" : "no"}`,
            `Task: ${job.task}`,
            "",
            `Context: ${JSON.stringify(job.context)}`,
          ].join("\n"),
        ),
      ],
      onEvent: (message) => {
        const progress = codexProgressFromEvent(message);
        if (progress?.status) updateProgress(job.id, progress);
      },
    });
    const status = turn.aborted ? "failed" : "completed";
    updateJob(job.id, {
      status,
      result: turn.finalMessage,
      debug: JSON.stringify({
        threadId: turn.threadId,
        turnId: turn.turnId,
        aborted: turn.aborted,
      }),
    });
  }

  interface CodexProgressInput {
    status?: string;
    toolName?: string;
    method?: string;
    [key: string]: unknown;
  }

  function updateProgress(jobId: string, progress: CodexProgressInput = {}) {
    const current = jobs.get(jobId) as CodexJobShape | undefined;
    if (!current || TERMINAL_STATUSES.has(current.status)) return current || null;
    const event = {
      at: new Date().toISOString(),
      status: compactOneLine(progress.status, 120),
      toolName: compactOneLine(progress.toolName, 80),
      method: compactOneLine(progress.method, 80),
    };
    const nextEvents = [...(current.progressEvents || []), event].slice(-30);
    const next = updateJob(jobId, {
      latestProgressStatus: event.status,
      latestToolName: event.toolName,
      latestProgressMethod: event.method,
      progressEvents: nextEvents,
    });
    if (notifyProgress && next) Promise.resolve(notifyProgress(next)).catch(() => {});
    return next;
  }

  return {
    startTask,
    getJob,
    listJobs,
    close: async () => {
      await client?.close();
      await processHandle.stop();
    },
  };
}

export const codexAppServerRunnerInternals = {
  buildSessionKey,
  codexProgressFromEvent,
};
