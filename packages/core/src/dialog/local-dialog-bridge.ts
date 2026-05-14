import type {
  AudioPlaybackResult,
  LocalDialogConfig,
  LocalDialogInput,
  LocalDialogSpeakOptions,
} from "../browser-runtime-types.js";

interface LocalDialogTurn {
  id: string;
  ts: string;
  updatedAt?: string;
  status: string;
  utterance?: string;
  source?: string;
  context?: Record<string, unknown>;
  responseText?: string;
  job?: unknown;
  provider?: string;
  tts?: SpeakResult;
  error?: string;
}

interface LocalDialogState {
  ok: boolean;
  enabled: boolean;
  provider: string;
  turns: LocalDialogTurn[];
  utterancesReceived: number;
  responsesSpoken: number;
  lastTurn: LocalDialogTurn | null;
  errors: Array<Record<string, unknown>>;
  tts: {
    mode?: string;
    provider?: string;
    routedToAvatarBus: boolean;
    lastRoute: Record<string, unknown> | null;
  };
  stt: {
    provider?: string;
    utterancesReceived: number;
    lastUtterance: Record<string, unknown> | null;
  };
}

interface SpeakResult extends AudioPlaybackResult {
  avatar?: unknown;
  provider?: string;
  played?: AudioPlaybackResult;
  tone?: AudioPlaybackResult;
  error?: string;
}

(() => {
  if (window.__meetingAvatarLocalDialogInjected) return;
  if (window.top !== window) return;
  window.__meetingAvatarLocalDialogInjected = true;

  /** @type {LocalDialogConfig} */
  const config: LocalDialogConfig = {
    enabled: true,
    turnUrl: "/dialog/turn",
    sessionId: "",
    ttsMode: "tone",
    ttsUrl: "/tts/synthesize",
    ttsGain: 0.025,
    ttsMinDurationMs: 650,
    ttsMaxDurationMs: 2600,
    sttProvider: "event",
    ttsProvider: "browser-tone",
    avatarMood: "happy",
    avatarAction: "speak",
    ...(window.MAB_LOCAL_DIALOG_CONFIG || {}),
  };

  const TERMINAL_STATUSES = new Set(["completed", "failed", "timeout"]);
  const state = {
    ok: true,
    enabled: Boolean(config.enabled),
    provider: "",
    turns: [],
    utterancesReceived: 0,
    responsesSpoken: 0,
    lastTurn: null,
    errors: [],
    tts: {
      mode: config.ttsMode,
      provider: config.ttsProvider,
      routedToAvatarBus: false,
      lastRoute: null,
    },
    stt: {
      provider: config.sttProvider,
      utterancesReceived: 0,
      lastUtterance: null,
    },
  };

  function rememberError(error: unknown, detail: Record<string, unknown> = {}) {
    const message = error instanceof Error ? error.message : String(error);
    const entry = {
      ts: new Date().toISOString(),
      message: message.slice(0, 400),
      ...detail,
    };
    state.errors.push(entry);
    state.errors = state.errors.slice(-20);
    return entry;
  }

  function rememberTurn(patch: Partial<LocalDialogTurn>): LocalDialogTurn {
    const turn: LocalDialogTurn = {
      id: patch.id || `turn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      ts: new Date().toISOString(),
      status: "running",
      ...patch,
    };
    state.turns.push(turn);
    state.turns = state.turns.slice(-20);
    state.lastTurn = turn;
    return turn;
  }

  function updateTurn(turn: LocalDialogTurn, patch: Partial<LocalDialogTurn>): LocalDialogTurn {
    Object.assign(turn, patch, { updatedAt: new Date().toISOString() });
    state.lastTurn = turn;
    return turn;
  }

  function setAvatarSpeaking(text: string): unknown {
    const controller = window.MAB_AVATAR_CONTROLLER;
    if (!controller?.updateState) return null;
    return controller.updateState({
      mood: config.avatarMood || "happy",
      action: config.avatarAction || "speak",
      intensity: Math.min(1.35, Math.max(0.55, 0.75 + String(text || "").length / 160)),
      expressionHoldMs: 7000,
      actionHoldMs: 4200,
    });
  }

  async function speakText(text: string, options: LocalDialogSpeakOptions = {}): Promise<SpeakResult> {
    const safeText = String(text || "").trim();
    const avatar = setAvatarSpeaking(safeText);
    const bus = window.MAB_AVATAR_AUDIO_BUS;
    if (!bus) {
      const error = rememberError(new Error("avatar_audio_bus_missing"), { phase: "tts" });
      return { ok: false, error: error.message, avatar };
    }
    const durationMs = Math.max(
      Number(config.ttsMinDurationMs || 650),
      Math.min(Number(config.ttsMaxDurationMs || 2600), 650 + safeText.length * 22),
    );
    if ((config.ttsMode === "server" || config.ttsMode === "provider") && config.ttsUrl) {
      try {
        const response = await fetch(config.ttsUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            text: safeText,
            durationMs,
            gain: Number(config.ttsGain ?? 0.025),
            context: options.context || {},
          }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok || !body.ok) throw new Error(body.error || `tts_provider_failed_${response.status}`);
        if (!body.audioDataUrl) throw new Error("tts_provider_missing_audio_data_url");
        const played = await bus.playAudioDataUrl(body.audioDataUrl, {
          label: options.label || "local-dialog-tts",
          gain: Number(config.ttsGain ?? 0.025),
        });
        state.responsesSpoken += played.ok ? 1 : 0;
        state.tts.routedToAvatarBus = played.ok;
        state.tts.provider = body.provider || config.ttsProvider || "server";
        state.tts.lastRoute = {
          ts: new Date().toISOString(),
          mode: config.ttsMode,
          provider: body.provider || "",
          textLength: safeText.length,
          durationMs: body.durationMs || played.durationMs || durationMs,
          played,
        };
        return { ok: played.ok, provider: body.provider || "", played, avatar, durationMs: body.durationMs || played.durationMs || durationMs };
      } catch (error) {
        const entry = rememberError(error, { phase: "tts_provider" });
        return { ok: false, error: entry.message, avatar };
      }
    }
    if (!bus.injectTone) {
      const error = rememberError(new Error("avatar_audio_bus_missing_inject_tone"), { phase: "tts" });
      return { ok: false, error: error.message, avatar };
    }
    const tone = bus.injectTone({
      label: options.label || "local-dialog-tts",
      frequency: Number(options.frequency || 420 + (safeText.length % 9) * 28),
      durationMs,
      gain: Number(config.ttsGain ?? 0.025),
    });
    state.responsesSpoken += tone.ok ? 1 : 0;
    state.tts.routedToAvatarBus = tone.ok;
    state.tts.lastRoute = {
      ts: new Date().toISOString(),
      mode: config.ttsMode,
      provider: "browser-tone",
      textLength: safeText.length,
      durationMs,
      tone,
    };
    return { ok: tone.ok, tone, avatar, durationMs };
  }

  async function sendUtterance(input: LocalDialogInput = {}): Promise<Record<string, unknown>> {
    if (!state.enabled) return { ok: false, error: "local_dialog_disabled" };
    const utterance = String(input.text || input.utterance || "").trim();
    if (!utterance) return { ok: false, error: "empty_utterance" };
    state.utterancesReceived += 1;
    state.stt.utterancesReceived += 1;
    state.stt.lastUtterance = {
      ts: new Date().toISOString(),
      source: input.source || config.sttProvider || "event",
      text: utterance,
    };
    window.dispatchEvent(new CustomEvent("meeting-avatar-user-speech-started", {
      detail: { source: "local-dialog", utterance },
    }));
    const turn = rememberTurn({
      utterance,
      source: input.source || "local-stt",
      context: input.context || {},
    });
    try {
      const response = await fetch(config.turnUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: input.sessionId || config.sessionId || "",
          utterance,
          context: input.context || {},
          mode: input.mode || "dialog",
          allowCodeChanges: Boolean(input.allowCodeChanges),
          timeoutMs: Number(input.timeoutMs || 30_000),
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.ok) {
        throw new Error(body.error || `dialog_turn_failed_${response.status}`);
      }
      state.provider = body.provider || body.job?.provider || state.provider;
      const responseText = body.responseText || body.job?.result || "";
      const tts = await speakText(responseText, {
        label: "local-dialog-response",
        context: { turnId: turn.id, utterance },
      });
      updateTurn(turn, {
        status: body.status || body.job?.status || "completed",
        responseText,
        job: body.job || null,
        provider: body.provider || body.job?.provider || "",
        tts,
      });
      window.dispatchEvent(new CustomEvent("meeting-avatar-local-dialog-response", {
        detail: { turn, response: body, tts },
      }));
      return { ok: true, turn, response: body, tts };
    } catch (error) {
      rememberError(error, { phase: "dialog_turn", utterance });
      updateTurn(turn, { status: "failed", error: String(error?.message || error) });
      return { ok: false, turn, error: String(error?.message || error) };
    }
  }

  window.MAB_LOCAL_DIALOG = state;
  window.MAB_LOCAL_DIALOG_CONTROLLER = {
    state,
    sendUtterance,
    injectTranscript: sendUtterance,
    speakText,
    terminalStatuses: [...TERMINAL_STATUSES],
  };

  window.addEventListener("meeting-avatar-local-utterance", (event) => {
    const customEvent = event as CustomEvent<LocalDialogInput>;
    sendUtterance(customEvent.detail || {}).catch((error) =>
      rememberError(error, { phase: "event_listener" }),
    );
  });
})();
