import type { LanOperatorVoiceChunk, LanOperatorVoiceForwardResult } from "./lan-operator-voice.ts";

export type CanonicalConversationEventType =
  | "engine_connected"
  | "engine_disconnected"
  | "speech_started"
  | "speech_stopped"
  | "transcript_delta"
  | "transcript_completed"
  | "assistant_text_delta"
  | "assistant_text_completed"
  | "assistant_audio_started"
  | "assistant_audio_chunk"
  | "assistant_audio_stopped"
  | "tool_call_started"
  | "tool_call_delta"
  | "tool_call_completed"
  | "tool_result_accepted"
  | "interrupted"
  | "engine_error";

export interface CanonicalConversationEvent {
  id: string;
  ts: string;
  sessionId: string;
  type: CanonicalConversationEventType;
  engineId: string;
  turnId?: string;
  responseId?: string;
  itemId?: string;
  text?: string;
  audioBase64?: string;
  error?: string;
  detail?: Record<string, unknown>;
}

export interface ConversationEnginePort {
  id: string;
  connect?(sessionId: string): Promise<CanonicalConversationEvent[]> | CanonicalConversationEvent[];
  control?(
    command: ConversationEngineControlCommand,
  ): Promise<ConversationEngineControlOutput> | ConversationEngineControlOutput;
  receiveVoiceChunk(chunk: LanOperatorVoiceChunk):
    | Promise<{
        result?: LanOperatorVoiceForwardResult;
        events?: CanonicalConversationEvent[];
      }>
    | {
        result?: LanOperatorVoiceForwardResult;
        events?: CanonicalConversationEvent[];
      };
  receiveTextInput?(input: LanOperatorTextInput):
    | Promise<{
        result?: LanOperatorVoiceForwardResult;
        events?: CanonicalConversationEvent[];
      }>
    | {
        result?: LanOperatorVoiceForwardResult;
        events?: CanonicalConversationEvent[];
      };
  receiveToolResult?(input: LanOperatorToolResultInput):
    | Promise<{
        result?: LanOperatorVoiceForwardResult;
        events?: CanonicalConversationEvent[];
      }>
    | {
        result?: LanOperatorVoiceForwardResult;
        events?: CanonicalConversationEvent[];
      };
  disconnect?(
    reason?: string,
  ): Promise<CanonicalConversationEvent[]> | CanonicalConversationEvent[];
}

export interface LanOperatorTextInput {
  id: string;
  ts: string;
  sessionId: string;
  text: string;
  source: "operator_text_input" | "diagnostic_text_input" | string;
  monotonicMs: number | null;
  surfaceContext?: Record<string, unknown>;
}

export interface LanOperatorToolResultInput {
  id: string;
  ts: string;
  sessionId: string;
  callId: string;
  itemId?: string;
  turnId?: string;
  responseId?: string;
  toolName?: string;
  jobId?: string;
  status: "completed" | "blocked" | "failed" | string;
  output: Record<string, unknown> | string | null;
  source: "kwwk" | "operator_debug_panel" | string;
  surfaceContext?: Record<string, unknown>;
}

export type ConversationEngineControlType =
  | "connect"
  | "disconnect"
  | "cancel_response"
  | "clear_audio_buffer"
  | "drain_events"
  | "set_voice_armed"
  | "set_voice_muted"
  | "reset_session"
  | "reconnect";

export interface ConversationEngineControlCommand {
  id: string;
  ts: string;
  sessionId: string;
  type: ConversationEngineControlType;
  reason?: string;
  responseId?: string;
  detail?: Record<string, unknown>;
}

export interface ConversationEngineControlOutput {
  result?: LanOperatorVoiceForwardResult;
  events?: CanonicalConversationEvent[];
}

export interface DiagnosticConversationEngineOptions {
  engineId?: string;
  speechEnergyThreshold?: number;
  assistantEveryChunks?: number;
}

function canonicalId(type: CanonicalConversationEventType, sequence = 0) {
  return `${type}_${Date.now().toString(36)}_${Math.max(0, sequence).toString(36)}`;
}

function canonicalEvent(
  engineId: string,
  sessionId: string,
  type: CanonicalConversationEventType,
  input: Partial<CanonicalConversationEvent> = {},
): CanonicalConversationEvent {
  const sequence = Number(input.detail?.sequence || 0);
  return {
    id: input.id || canonicalId(type, sequence),
    ts: input.ts || new Date().toISOString(),
    sessionId,
    type,
    engineId,
    turnId: input.turnId,
    responseId: input.responseId,
    itemId: input.itemId,
    text: input.text,
    audioBase64: input.audioBase64,
    error: input.error,
    detail: input.detail,
  };
}

function diagnosticPcm16Base64() {
  const sampleRate = 24000;
  const frames = Math.round(sampleRate * 0.08);
  const bytes = new Uint8Array(frames * 2);
  for (let index = 0; index < frames; index += 1) {
    const envelope = Math.sin((Math.PI * index) / Math.max(1, frames - 1));
    const sample = Math.round(
      Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 0.16 * envelope * 32767,
    );
    bytes[index * 2] = sample & 0xff;
    bytes[index * 2 + 1] = (sample >> 8) & 0xff;
  }
  return Buffer.from(bytes).toString("base64");
}

function diagnosticAssistantAudioEvents(
  engineId: string,
  sessionId: string,
  turnId: string,
  responseId: string,
  sequence: number,
) {
  const detail = { sequence, diagnostic: true, sampleRate: 24000, channels: 1, encoding: "pcm16" };
  return [
    canonicalEvent(engineId, sessionId, "assistant_audio_started", { turnId, responseId, detail }),
    canonicalEvent(engineId, sessionId, "assistant_audio_chunk", {
      turnId,
      responseId,
      audioBase64: diagnosticPcm16Base64(),
      detail,
    }),
    canonicalEvent(engineId, sessionId, "assistant_audio_stopped", { turnId, responseId, detail }),
  ];
}

export function createDiagnosticConversationEngine(
  options: DiagnosticConversationEngineOptions = {},
): ConversationEnginePort {
  const engineId = options.engineId || "diagnostic_conversation_engine";
  const speechEnergyThreshold = Number(options.speechEnergyThreshold ?? 0.00001);
  const assistantEveryChunks = Math.max(1, Number(options.assistantEveryChunks || 6));
  const state = {
    connected: false,
    speechActive: false,
    chunkCount: 0,
    turnId: "",
    responseId: "",
    transcriptText: "",
    assistantText: "",
  };

  function ensureConnected(sessionId: string) {
    if (state.connected) return [];
    state.connected = true;
    return [
      canonicalEvent(engineId, sessionId, "engine_connected", {
        detail: { adapter: "diagnostic", turnFormation: "energy_threshold" },
      }),
    ];
  }

  return {
    id: engineId,
    connect(sessionId) {
      return ensureConnected(sessionId);
    },
    receiveVoiceChunk(chunk) {
      const events = ensureConnected(chunk.sessionId);
      state.chunkCount += 1;
      const sequence = Number(chunk.sequence || state.chunkCount);
      const hasSpeech = chunk.energy >= speechEnergyThreshold || state.chunkCount === 1;
      if (hasSpeech && !state.speechActive) {
        state.speechActive = true;
        state.turnId = `turn_${Date.now().toString(36)}`;
        state.responseId = `response_${Date.now().toString(36)}`;
        events.push(
          canonicalEvent(engineId, chunk.sessionId, "speech_started", {
            turnId: state.turnId,
            detail: {
              sequence,
              energy: chunk.energy,
              sampleRate: chunk.sampleRate,
              source: chunk.source,
              surfaceContext: chunk.surfaceContext || {},
            },
          }),
        );
      }
      if (hasSpeech) {
        const token = state.chunkCount === 1 ? "operator audio" : ` chunk_${sequence}`;
        state.transcriptText += token;
        events.push(
          canonicalEvent(engineId, chunk.sessionId, "transcript_delta", {
            turnId: state.turnId,
            text: token,
            detail: { sequence, energy: chunk.energy },
          }),
        );
      }
      if (state.chunkCount % assistantEveryChunks === 0) {
        const text = "diagnostic response ready";
        state.assistantText += text;
        events.push(
          canonicalEvent(engineId, chunk.sessionId, "assistant_text_delta", {
            turnId: state.turnId,
            responseId: state.responseId,
            text,
            detail: { sequence, chunksSeen: state.chunkCount },
          }),
          canonicalEvent(engineId, chunk.sessionId, "assistant_text_completed", {
            turnId: state.turnId,
            responseId: state.responseId,
            text: state.assistantText,
            detail: { sequence, diagnostic: true },
          }),
          ...diagnosticAssistantAudioEvents(
            engineId,
            chunk.sessionId,
            state.turnId,
            state.responseId,
            sequence,
          ),
        );
      }
      return { result: { ok: true, engineId, accepted: true }, events };
    },
    receiveTextInput(input) {
      const text = input.text.trim();
      const events = ensureConnected(input.sessionId);
      if (!text) {
        return {
          result: { ok: false, engineId, error: "empty_operator_text_input" },
          events,
        };
      }
      state.turnId = `turn_text_${Date.now().toString(36)}`;
      state.responseId = `response_text_${Date.now().toString(36)}`;
      state.transcriptText = text;
      state.assistantText = `diagnostic text response: ${text}`;
      events.push(
        canonicalEvent(engineId, input.sessionId, "transcript_completed", {
          turnId: state.turnId,
          text,
          detail: {
            inputMode: "text",
            inputId: input.id,
            source: input.source,
            surfaceContext: input.surfaceContext || {},
          },
        }),
        canonicalEvent(engineId, input.sessionId, "assistant_text_delta", {
          turnId: state.turnId,
          responseId: state.responseId,
          text: state.assistantText,
          detail: { inputMode: "text", inputId: input.id, diagnostic: true },
        }),
        canonicalEvent(engineId, input.sessionId, "assistant_text_completed", {
          turnId: state.turnId,
          responseId: state.responseId,
          text: state.assistantText,
          detail: { inputMode: "text", inputId: input.id, diagnostic: true },
        }),
      );
      return { result: { ok: true, engineId, accepted: true, inputMode: "text" }, events };
    },
    receiveToolResult(input) {
      const events = ensureConnected(input.sessionId);
      const text =
        typeof input.output === "string" ? input.output : JSON.stringify(input.output || {});
      events.push(
        canonicalEvent(engineId, input.sessionId, "tool_result_accepted", {
          turnId: input.turnId || state.turnId,
          responseId: input.responseId || state.responseId,
          itemId: input.itemId,
          text,
          detail: {
            inputMode: "tool_result",
            inputId: input.id,
            source: input.source,
            callId: input.callId,
            name: input.toolName || "kwwk_computer_use",
            expectedTool: input.toolName || "kwwk_computer_use",
            jobId: input.jobId || "",
            status: input.status,
            surfaceContext: input.surfaceContext || {},
          },
        }),
      );
      return { result: { ok: true, engineId, accepted: true, inputMode: "tool_result" }, events };
    },
    control(command) {
      const detail = command.detail || {};
      const shouldConnectForControl =
        command.type !== "disconnect" &&
        command.type !== "drain_events" &&
        command.type !== "set_voice_muted" &&
        !(command.type === "set_voice_armed" && detail.armed === false);
      const events = shouldConnectForControl ? ensureConnected(command.sessionId) : [];
      if (command.type === "drain_events") {
        return {
          result: { ok: true, engineId, control: command.type },
          events,
        };
      }
      if (command.type === "connect") {
        return {
          result: { ok: true, engineId, control: command.type },
          events,
        };
      }
      if (command.type === "disconnect") {
        state.connected = false;
        events.push(
          canonicalEvent(engineId, command.sessionId, "engine_disconnected", {
            detail: { control: command.type, reason: command.reason || "operator_disconnect" },
          }),
        );
      }
      if (command.type === "set_voice_armed" || command.type === "set_voice_muted") {
        return {
          result: { ok: true, engineId, control: command.type, detail },
          events,
        };
      }
      if (command.type === "cancel_response") {
        events.push(
          canonicalEvent(engineId, command.sessionId, "interrupted", {
            responseId: command.responseId || state.responseId,
            detail: { control: command.type, reason: command.reason || "operator_cancelled" },
          }),
        );
      }
      if (command.type === "reset_session") {
        state.speechActive = false;
        state.chunkCount = 0;
        state.turnId = "";
        state.responseId = "";
        state.transcriptText = "";
        state.assistantText = "";
      }
      if (command.type === "reconnect" || command.type === "reset_session") {
        state.connected = false;
        events.push(
          canonicalEvent(engineId, command.sessionId, "engine_disconnected", {
            detail: { control: command.type, reason: command.reason || "operator_control" },
          }),
          ...ensureConnected(command.sessionId),
        );
      }
      return {
        result: { ok: true, engineId, control: command.type },
        events,
      };
    },
    disconnect(reason = "operator_surface_closed") {
      if (!state.connected) return [];
      state.connected = false;
      return [
        canonicalEvent(engineId, "", "engine_disconnected", {
          detail: { reason },
        }),
      ];
    },
  };
}
