import { buildAvatarInitScript } from "../avatar/init-script-builder.ts";
import { buildLocalDialogInitScript } from "../dialog/local-dialog-init-builder.ts";
import { buildScreenShareInitScript } from "../meeting/screen-share-init-builder.ts";
import { buildRealtimeBrowserInitScript } from "../realtime/realtime-browser-init-builder.ts";
import { buildWorkerResultInitScript } from "../realtime/worker-result-init-builder.ts";
import {
  createRuntimeEvent,
  defaultRuntimeDiagnosticsConfig,
  normalizeConversationTransport,
  type AvatarRuntimeSessionConfig,
  type ConversationTransport,
  type RuntimeInitScript,
} from "./contracts.ts";

export interface AvatarRuntimeInitBuilderConfig extends Pick<
  AvatarRuntimeSessionConfig,
  "sessionId" | "botName" | "surfaceKind" | "conversationTransport"
> {
  diagnostics?: AvatarRuntimeSessionConfig["diagnostics"];
  installAvatar?: boolean;
  installRealtimeBridge?: boolean;
  installLocalDialogBridge?: boolean;
  installScreenShareBridge?: boolean;
  installWorkerResultBridge?: boolean;
  avatar?: Record<string, unknown>;
  realtime?: Record<string, unknown>;
  localDialog?: Record<string, unknown>;
  screenShare?: Record<string, unknown>;
  workerResult?: Record<string, unknown>;
}

type InitScriptCategory = RuntimeInitScript["category"];

const CATEGORY_SUMMARIES: Record<InitScriptCategory, string> = {
  avatar: "Avatar renderer init script installed",
  realtime: "Realtime browser bridge init script installed",
  local_dialog: "Local dialog bridge init script installed",
  screen_share: "Screen-share bridge init script installed",
  worker_result: "Worker-result bridge init script installed",
};

const REALTIME_MODE_TRANSPORTS: Record<string, ConversationTransport> = {
  mock: "mock",
  "webrtc-mock": "webrtc_mock",
  webrtc: "raw_webrtc",
  "raw-webrtc": "raw_webrtc",
  "agents-sdk": "agents_sdk",
  "agents-sdk-mock": "agents_sdk",
};

const MOCK_REALTIME_MODES = new Set(["mock", "webrtc-mock", "agents-sdk-mock"]);

function installEnabled(value: boolean | undefined): boolean {
  return value !== false;
}

function runtimeEventConfig(config: AvatarRuntimeInitBuilderConfig) {
  return {
    sessionId: config.sessionId,
    surfaceKind: config.surfaceKind,
    conversationTransport: config.conversationTransport,
  };
}

export function inferConversationTransportFromRealtimeMode(mode: unknown): ConversationTransport {
  const key = String(mode || "mock")
    .trim()
    .toLowerCase();
  const mapped = REALTIME_MODE_TRANSPORTS[key];
  if (mapped) return mapped;
  return normalizeConversationTransport(key);
}

function createInitScript(
  config: AvatarRuntimeInitBuilderConfig,
  category: InitScriptCategory,
  content: string,
  detail: Record<string, unknown> = {},
): RuntimeInitScript {
  return {
    category,
    content,
    event: createRuntimeEvent(runtimeEventConfig(config), {
      phase: "init",
      event: "runtime_init_script_built",
      severity: "info",
      summary: CATEGORY_SUMMARIES[category],
      detail: {
        category,
        contentLength: content.length,
        ...detail,
      },
      redaction: "summarized",
    }),
  };
}

function realtimeEventDetail(realtime: Record<string, unknown> | undefined) {
  const realtimeBridgeMode = String(realtime?.mode || "").trim();
  if (!realtimeBridgeMode) return {};
  return {
    realtimeBridgeMode,
    mockTransport: MOCK_REALTIME_MODES.has(realtimeBridgeMode.toLowerCase()),
  };
}

export function buildAvatarRuntimeInitScripts(
  config: AvatarRuntimeInitBuilderConfig,
): RuntimeInitScript[] {
  const normalizedConfig = {
    ...config,
    diagnostics: defaultRuntimeDiagnosticsConfig(config.diagnostics),
  };
  const scripts: RuntimeInitScript[] = [];

  if (installEnabled(normalizedConfig.installAvatar)) {
    scripts.push(
      createInitScript(
        normalizedConfig,
        "avatar",
        buildAvatarInitScript(normalizedConfig.avatar || {}),
      ),
    );
  }

  if (installEnabled(normalizedConfig.installRealtimeBridge)) {
    scripts.push(
      createInitScript(
        normalizedConfig,
        "realtime",
        buildRealtimeBrowserInitScript(normalizedConfig.realtime || {}),
        realtimeEventDetail(normalizedConfig.realtime),
      ),
    );
  }

  if (installEnabled(normalizedConfig.installLocalDialogBridge)) {
    scripts.push(
      createInitScript(
        normalizedConfig,
        "local_dialog",
        buildLocalDialogInitScript(normalizedConfig.localDialog || {}),
      ),
    );
  }

  if (installEnabled(normalizedConfig.installScreenShareBridge)) {
    scripts.push(
      createInitScript(
        normalizedConfig,
        "screen_share",
        buildScreenShareInitScript(normalizedConfig.screenShare || {}),
      ),
    );
  }

  if (installEnabled(normalizedConfig.installWorkerResultBridge)) {
    scripts.push(
      createInitScript(
        normalizedConfig,
        "worker_result",
        buildWorkerResultInitScript(normalizedConfig.workerResult || {}),
        {
          enabled: Boolean(normalizedConfig.workerResult?.enabled),
        },
      ),
    );
  }

  return scripts;
}

export function summarizeRuntimeInitScripts(scripts: RuntimeInitScript[]) {
  return {
    categories: scripts.map((script) => script.category),
    events: scripts.map((script) => script.event),
    totalContentLength: scripts.reduce((sum, script) => sum + script.content.length, 0),
  };
}
