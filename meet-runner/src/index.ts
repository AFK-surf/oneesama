import readline from "node:readline";

import { createGoogleMeetJoiner } from "../../packages/core/src/meeting/google-meet-joiner.ts";
import {
  deriveStartedStatus,
  hasJoinAcceptedEvidence,
  joinFailureMessage,
  recoverAcceptedJoinAfterError,
} from "./join-result.ts";
import {
  assertRealtimeRuntimePlacementForMeetJoin,
  buildPlan,
  normalizeBrowserIslandOptions,
} from "./join-plan.ts";
import { failure, parseRequestLine, success, writeResponse } from "./protocol.ts";
import { statusSession } from "./session-status.ts";
import type { JsonRpcRequest } from "./types.ts";
import type {
  RealtimeEventParams,
  PrepareJoinParams,
  RealtimeTextTurnParams,
  StatusSessionParams,
  StopSessionParams,
} from "./types.ts";

const bridgeMode = "persistent-session";
const meetUrlPattern = /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}(?:[/?#].*)?$/i;

type RunnerSessionState = {
  id: string;
  meeting_url: string;
  status: string;
  title: string;
  updated_at: string;
  started: boolean;
};

const sessions = new Map<string, RunnerSessionState>();
const joiner = createGoogleMeetJoiner({ allowNonGoogleMeet: true });

function now(): string {
  return new Date().toISOString();
}

function realtimeEventPayload(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function validateHostRealtimeEvent(event: Record<string, unknown>): {
  ok: boolean;
  error?: string;
} {
  const type = String(event.type || "").trim();
  if (!type) return { ok: false, error: "realtime_event_type_required" };
  if (type === "response.cancel" || type === "input_audio_buffer.clear") return { ok: true };
  return { ok: false, error: "realtime_event_type_not_allowed" };
}

function firstNonEmpty(...values: Array<unknown>): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  return "";
}

function setSession(state: RunnerSessionState) {
  sessions.set(state.id, state);
  return {
    id: state.id,
    meeting_url: state.meeting_url,
    status: state.status,
    title: state.title,
    updated_at: state.updated_at,
  };
}

function handleDryRunJoin(params: PrepareJoinParams) {
  const meetingUrl = firstNonEmpty(params.meeting_url);
  const allowNonGoogleMeet = Boolean(params.allow_non_google_meet);
  if (!meetingUrl) {
    throw new Error("meeting_url is required");
  }
  if (!allowNonGoogleMeet && !meetUrlPattern.test(meetingUrl)) {
    throw new Error("meeting_url must be a Google Meet URL");
  }

  const sessionId = firstNonEmpty(params.session_id, `session_${Date.now().toString(36)}`);
  const title = firstNonEmpty(params.title, "Google Meet join plan");
  const dryRun = Boolean(params.dry_run);
  const plan = buildPlan(params, meetingUrl);
  const session = setSession({
    id: sessionId,
    meeting_url: meetingUrl,
    status: dryRun ? "prepared" : "join_requested",
    title,
    updated_at: now(),
    started: false,
  });
  return {
    ok: true,
    accepted: true,
    started: false,
    bridge_mode: bridgeMode,
    note: "TS meet-runner bridge keeps a persistent session worker and prepares the Playwright join plan without launching the browser. Browser-island install flags are preserved in the plan for later execution.",
    session,
    plan,
  };
}

async function handleJoinRequest(params: PrepareJoinParams) {
  if (params.dry_run) {
    return handleDryRunJoin(params);
  }

  const meetingUrl = firstNonEmpty(params.meeting_url);
  const options = normalizeBrowserIslandOptions(params);
  if (!meetingUrl) {
    throw new Error("meeting_url is required");
  }
  if (!options.allowNonGoogleMeet && !meetUrlPattern.test(meetingUrl)) {
    throw new Error("meeting_url must be a Google Meet URL");
  }
  assertRealtimeRuntimePlacementForMeetJoin(options, meetingUrl);

  const sessionId = firstNonEmpty(params.session_id, `session_${Date.now().toString(36)}`);
  const title = firstNonEmpty(params.title, "Google Meet join plan");
  const displayName = firstNonEmpty(params.display_name);
  let joinResult: any;
  let recoveredAfterError = "";
  const joinInput = {
    sessionId,
    meetUrl: meetingUrl,
    botName: displayName,
    dryRun: false,
    allowNonGoogleMeet: options.allowNonGoogleMeet,
    captureCaptions: options.captureCaptions,
    captionLanguage: options.captionLanguage,
    recordMeeting: options.recordMeeting,
    artifactsDir: options.artifactsDir,
    meetAudioBackend: options.meetAudioBackend,
    installAvatar: options.installAvatar,
    installRealtimeBridge: options.installRealtimeBridge,
    realtimeBridgeMode: options.realtimeBridgeMode,
    realtimeAgentRuntime: options.realtimeAgentRuntime,
    realtimeRuntimePlacement: options.realtimeRuntimePlacement,
    realtimeToolCallbackToken: params.realtime_tool_callback_token,
    realtimeInstructions: params.realtime_instructions,
    realtimeTools: Array.isArray(params.realtime_tools) ? params.realtime_tools : undefined,
    realtimeSession:
      params.realtime_session && typeof params.realtime_session === "object"
        ? params.realtime_session
        : undefined,
    autoConnectRealtime: options.autoConnectRealtime,
    sendRealtimeSessionUpdate: options.sendRealtimeSessionUpdate,
    includeParticipantAudio: options.includeParticipantAudio,
    forwardMeetAudioToRealtime: options.forwardMeetAudioToRealtime,
    meetAudioInputGain: options.meetAudioInputGain,
    installLocalDialogBridge: options.installLocalDialogBridge,
    installWorkerResultBridge: options.installWorkerResultBridge,
    installScreenShareBridge: options.installScreenShareBridge,
    autoStartScreenShare: options.autoStartScreenShare,
    disableLive2D: options.disableLive2D,
    collectFixtureState: options.collectFixtureState,
    workerPollUrl: params.worker_poll_url,
    workerResultMinCreatedAt: params.worker_result_min_created_at,
    workerDelegateUrl: params.worker_delegate_url,
    workerStatusUrl: params.worker_status_url,
    localDialogTurnUrl: params.local_dialog_turn_url,
    localDialogTtsUrl: params.local_dialog_tts_url,
    localDialogTtsMode: params.local_dialog_tts_mode,
    localDialogTtsProvider: params.local_dialog_tts_provider,
    localDialogTtsGain: Number(params.local_dialog_tts_gain || 0) || undefined,
    browserExtraArgs: params.browser_extra_args,
    screenShareMode: params.screen_share_mode,
    screenShareTitle: params.screen_share_title,
    screenShareSubtitle: params.screen_share_subtitle,
    screenShareWidth: params.screen_share_width,
    screenShareHeight: params.screen_share_height,
    screenShareFps: params.screen_share_fps,
  };
  try {
    joinResult = await joiner.join(joinInput);
  } catch (error) {
    joinResult = await recoverAcceptedJoinAfterError(error, joiner);
    recoveredAfterError = String(joinResult.recovered_after_error || "");
  }
  if (!joinResult?.ok && !hasJoinAcceptedEvidence(joinResult)) {
    throw new Error(joinFailureMessage(joinResult));
  }
  if (!joinResult?.ok) {
    recoveredAfterError = joinFailureMessage(joinResult);
    joinResult = { ...joinResult, ok: true };
  }

  const session = setSession({
    id: sessionId,
    meeting_url: meetingUrl,
    status: deriveStartedStatus(joinResult),
    title,
    updated_at: now(),
    started: true,
  });
  return {
    ok: true,
    accepted: true,
    started: true,
    bridge_mode: bridgeMode,
    note: firstNonEmpty(
      recoveredAfterError
        ? `TS meet-runner bridge recovered an accepted Google Meet join after a post-join error: ${recoveredAfterError}`
        : "",
      "TS meet-runner bridge launched the Playwright joiner and kept the browser session attached to this worker. Browser-island install flags and fixture-state collection now follow the explicit Go join request through this worker.",
    ),
    session,
    plan: buildPlan(params, meetingUrl),
  };
}

async function handleStopSession(params: StopSessionParams) {
  const sessionId = firstNonEmpty(params.session_id);
  if (!sessionId) {
    throw new Error("session_id is required");
  }
  const existing = sessions.get(sessionId) ?? {
    id: sessionId,
    meeting_url: "",
    status: "prepared",
    title: "Google Meet join plan",
    updated_at: now(),
    started: false,
  };
  let stoppedAt = now();
  let reason = firstNonEmpty(params.reason);
  let stopResult = null;
  const beforeStop = existing.started ? await joiner.status() : null;
  if (existing.started) {
    stopResult = await joiner.stop(reason || "manual_stop");
    if (!stopResult?.ok) {
      throw new Error(firstNonEmpty(stopResult?.error, "google meet stop failed"));
    }
    stoppedAt = firstNonEmpty(stopResult?.stoppedAt, stopResult?.stopped_at, stoppedAt);
    reason = firstNonEmpty(reason, stopResult?.reason);
  }
  const session = setSession({
    id: sessionId,
    meeting_url: existing.meeting_url,
    status: "stopped",
    title: existing.title,
    updated_at: stoppedAt,
    started: false,
  });
  return {
    ok: true,
    stopped_at: stoppedAt,
    reason,
    session,
    runtime: { beforeStop, stopResult },
  };
}

async function handleRequest(request: JsonRpcRequest): Promise<void> {
  try {
    switch (request.method) {
      case "runner.ping":
        writeResponse(
          success(request.id, {
            ok: true,
            name: "meet-runner",
            entry: "src/index.ts",
            bridge_mode: bridgeMode,
            capabilities: [
              "runner.ping",
              "join.google_meet.prepare",
              "join.session.status",
              "join.session.stop",
              "worker.result.inject",
              "meet.chat.send",
              "screen_share.start",
              "screen_share.present",
              "screen_share.video",
              "screen_share.apps",
              "screen_share.app",
              "screen_share.stop",
              "realtime.event",
              "realtime.text_turn",
            ],
          }),
        );
        return;
      case "join.google_meet.prepare":
        writeResponse(
          success(request.id, await handleJoinRequest((request.params ?? {}) as PrepareJoinParams)),
        );
        return;
      case "join.session.status":
        writeResponse(
          success(
            request.id,
            await statusSession((request.params ?? {}) as StatusSessionParams, sessions, joiner),
          ),
        );
        return;
      case "join.session.stop":
        writeResponse(
          success(request.id, await handleStopSession((request.params ?? {}) as StopSessionParams)),
        );
        return;
      case "worker.result.inject":
        writeResponse(
          success(request.id, await joiner.injectWorkerResult((request.params as any)?.job)),
        );
        return;
      case "meet.chat.send":
        writeResponse(success(request.id, await joiner.sendMeetChat(request.params ?? {})));
        return;
      case "screen_share.start":
        writeResponse(success(request.id, await joiner.startScreenShare(request.params ?? {})));
        return;
      case "screen_share.present":
        writeResponse(success(request.id, await joiner.presentScreenShare(request.params ?? {})));
        return;
      case "screen_share.video":
        writeResponse(success(request.id, await joiner.presentVideoStage(request.params ?? {})));
        return;
      case "screen_share.apps":
        writeResponse(success(request.id, await joiner.listShareableApps()));
        return;
      case "screen_share.app":
        writeResponse(success(request.id, await joiner.presentAppShare(request.params ?? {})));
        return;
      case "screen_share.stop":
        writeResponse(success(request.id, await joiner.stopScreenShare()));
        return;
      case "realtime.text_turn":
        writeResponse(
          success(
            request.id,
            await joiner.requestRealtimeTextTurn(
              (request.params ?? {}) as RealtimeTextTurnParams as any,
            ),
          ),
        );
        return;
      case "realtime.event": {
        const params = (request.params ?? {}) as RealtimeEventParams;
        const event = realtimeEventPayload(params.event || params);
        const validation = validateHostRealtimeEvent(event);
        if (!validation.ok) {
          writeResponse(failure(request.id, validation.error || "realtime_event_not_allowed"));
          return;
        }
        writeResponse(success(request.id, await joiner.sendRealtimeEvent(event)));
        return;
      }
      default:
        writeResponse(failure(request.id, `unsupported method: ${request.method}`));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeResponse(failure(request.id, message));
  }
}

async function main(): Promise<void> {
  const lineReader = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
    terminal: false,
  });
  for await (const line of lineReader) {
    if (line.trim() === "") {
      continue;
    }
    try {
      await handleRequest(parseRequestLine(line));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeResponse(failure(null, message));
    }
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  writeResponse(failure(null, message));
  process.exitCode = 1;
});
