(() => {
  if (window.__meetingAvatarBotInjected) return;
  if (window.top !== window) return;
  window.__meetingAvatarBotInjected = true;

  const DEFAULT_HIYORI_MODEL_URL =
    "https://fastly.jsdelivr.net/gh/Live2D/CubismWebSamples@develop/Samples/Resources/Hiyori/Hiyori.model3.json";
  const DEFAULT_HIYORI_MODEL_FALLBACK_URLS = [
    "https://cdn.jsdelivr.net/gh/Live2D/CubismWebSamples@develop/Samples/Resources/Hiyori/Hiyori.model3.json",
    "https://gcore.jsdelivr.net/gh/Live2D/CubismWebSamples@develop/Samples/Resources/Hiyori/Hiyori.model3.json",
    "https://raw.githubusercontent.com/Live2D/CubismWebSamples/develop/Samples/Resources/Hiyori/Hiyori.model3.json",
  ];
  const DEFAULT_VRM_MODEL_URL =
    "https://raw.githubusercontent.com/trinhtanphat/AMI-Chat-AI/main/public/models/3d/Sendagaya_Shibu.vrm";
  const DEFAULT_THREE_MODULE_URL = "https://esm.sh/three@0.164.1";
  const DEFAULT_GLTF_LOADER_MODULE_URL =
    "https://esm.sh/three@0.164.1/examples/jsm/loaders/GLTFLoader.js";
  const DEFAULT_THREE_VRM_MODULE_URL = "https://esm.sh/@pixiv/three-vrm@2.1.3?deps=three@0.164.1";
  const config = {
    modelUrl: DEFAULT_HIYORI_MODEL_URL,
    modelFallbackUrls: DEFAULT_HIYORI_MODEL_FALLBACK_URLS,
    vrmModelUrl: DEFAULT_VRM_MODEL_URL,
    vrmModelFallbackUrls: [],
    threeModuleUrl: DEFAULT_THREE_MODULE_URL,
    gltfLoaderModuleUrl: DEFAULT_GLTF_LOADER_MODULE_URL,
    threeVrmModuleUrl: DEFAULT_THREE_VRM_MODULE_URL,
    canvasWidth: 1920,
    canvasHeight: 1080,
    captureFps: 30,
    botName: "Meeting Avatar Bot",
    background: "#f7f8fb",
    layout: "face",
    avatarRenderer: "live2d",
    disableLive2D: false,
    deferRendererUntilExplicitStart: false,
    enableVisualTestHooks: false,
    ...window.MAB_AVATAR_CONFIG,
  };

  const log = (...args) => console.log("[meeting-avatar]", ...args);
  const ALLOWED_MOODS = ["neutral", "happy", "surprised", "thinking", "sad", "shy"];
  const ALLOWED_ACTIONS = [
    "idle",
    "nod",
    "shake",
    "wave",
    "think",
    "lean_forward",
    "emphasize",
    "shrug",
    "speak",
  ];
  const ALLOWED_STATUS_KINDS = [
    "idle",
    "thinking",
    "writing_code",
    "opening_preview",
    "blocked",
    "done",
  ];
  const STATUS_LABELS: Record<string, string> = {
    idle: "",
    thinking: "Thinking",
    writing_code: "Writing code",
    opening_preview: "Opening preview",
    blocked: "Blocked",
    done: "Done",
  };
  const STATUS_COLORS: Record<string, { accent: string; bg: string }> = {
    idle: { accent: "#64748b", bg: "rgba(15, 23, 42, 0.78)" },
    thinking: { accent: "#38bdf8", bg: "rgba(15, 23, 42, 0.78)" },
    writing_code: { accent: "#a78bfa", bg: "rgba(24, 24, 27, 0.82)" },
    opening_preview: { accent: "#34d399", bg: "rgba(6, 78, 59, 0.82)" },
    blocked: { accent: "#fb7185", bg: "rgba(127, 29, 29, 0.84)" },
    done: { accent: "#4ade80", bg: "rgba(20, 83, 45, 0.82)" },
  };
  const EXPRESSION_PRESETS = {
    neutral: {
      ParamMouthForm: 0,
      ParamMouthOpenY: 0,
      ParamEyeOpen: 1,
      ParamEyeSmile: 0,
      ParamCheek: 0,
      ParamBrowAngle: 0,
      ParamBrowY: 0,
    },
    happy: {
      ParamMouthForm: 1,
      ParamMouthOpenY: 0.16,
      ParamEyeOpen: 0.82,
      ParamEyeSmile: 1,
      ParamCheek: 1,
      ParamBrowAngle: 0.55,
      ParamBrowY: 0.28,
    },
    surprised: {
      ParamMouthForm: 0.05,
      ParamMouthOpenY: 0.42,
      ParamEyeOpen: 1.45,
      ParamEyeSmile: 0,
      ParamCheek: 0.25,
      ParamBrowAngle: 1.1,
      ParamBrowY: 0.75,
    },
    thinking: {
      ParamMouthForm: 0.12,
      ParamMouthOpenY: 0.05,
      ParamEyeOpen: 0.72,
      ParamEyeSmile: 0,
      ParamCheek: 0,
      ParamBrowAngle: -0.75,
      ParamBrowY: -0.32,
    },
    sad: {
      ParamMouthForm: -1,
      ParamMouthOpenY: 0.04,
      ParamEyeOpen: 0.58,
      ParamEyeSmile: 0,
      ParamCheek: 0,
      ParamBrowAngle: -1.05,
      ParamBrowY: -0.52,
    },
    shy: {
      ParamMouthForm: 0.45,
      ParamMouthOpenY: 0.06,
      ParamEyeOpen: 0.55,
      ParamEyeSmile: 0.62,
      ParamCheek: 1,
      ParamBrowAngle: -0.65,
      ParamBrowY: -0.22,
    },
  };
  const ACTION_DURATIONS_MS = {
    idle: 200,
    nod: 1000,
    shake: 1000,
    wave: 1700,
    think: 2200,
    lean_forward: 1400,
    emphasize: 1100,
    shrug: 1200,
    speak: 1800,
  };

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, Number(value) || 0));
  }

  function clamp01(value) {
    return clamp(value, 0, 1);
  }

  function normalizeEnum(value, allowed, fallback) {
    const normalized = String(value || fallback);
    return allowed.includes(normalized) ? normalized : fallback;
  }

  function setLive2DParam(core, id, value) {
    try {
      core.setParameterValueById(id, value);
    } catch {
      // Hiyori variants may not expose every parameter; missing ids are fine.
    }
  }

  function createAvatarStateController() {
    const state = {
      ok: true,
      mood: "neutral",
      action: "idle",
      intensity: 0.8,
      expressionHoldUntil: 0,
      actionStartedAt: 0,
      actionEndsAt: 0,
      actionHoldUntil: 0,
      statusText: "",
      statusKind: "idle",
      statusVisibleUntil: 0,
      statusUpdatedAt: "",
      updates: [],
      live2dParameterFrames: 0,
      lastUpdateAt: "",
    };

    function remember(kind, detail = {}) {
      const update = { ts: new Date().toISOString(), kind, ...detail };
      state.updates.push(update);
      state.updates = state.updates.slice(-40);
      state.lastUpdateAt = update.ts;
      return update;
    }

    function expressionHoldActive() {
      return performance.now() < state.expressionHoldUntil && state.mood !== "neutral";
    }

    function actionHoldActive() {
      return performance.now() < state.actionHoldUntil && state.action !== "idle";
    }

    interface SetExpressionOptions {
      forceNeutral?: boolean;
      holdMs?: number;
    }

    interface SetActionOptions {
      auto?: boolean;
      force?: boolean;
      holdMs?: number;
      durationMs?: number;
    }

    interface UpdateStateInput {
      mood?: string;
      action?: string;
      intensity?: number;
      expressionHoldMs?: number;
      actionHoldMs?: number;
      statusText?: string;
      statusKind?: string;
      statusHoldMs?: number;
      status_text?: string;
      status_kind?: string;
      status_hold_ms?: number;
    }

    function setExpression(mood: string = "neutral", options: SetExpressionOptions = {}) {
      const safeMood = normalizeEnum(mood, ALLOWED_MOODS, "neutral");
      if (safeMood === "neutral" && expressionHoldActive() && !options.forceNeutral) {
        return { ok: true, skipped: true, reason: "expression_hold_active", mood: state.mood };
      }
      state.mood = safeMood;
      state.expressionHoldUntil =
        safeMood === "neutral" ? 0 : performance.now() + Number(options.holdMs ?? 9000);
      remember("expression", { mood: safeMood });
      return { ok: true, mood: state.mood };
    }

    function setAction(
      action: string = "idle",
      intensity: number = 0.8,
      options: SetActionOptions = {},
    ) {
      const safeAction = normalizeEnum(action, ALLOWED_ACTIONS, "idle");
      if ((safeAction === "idle" || options.auto) && actionHoldActive() && !options.force) {
        return {
          ok: true,
          skipped: true,
          reason: "action_hold_active",
          action: state.action,
          intensity: state.intensity,
        };
      }
      const durationMs = Number(options.durationMs ?? ACTION_DURATIONS_MS[safeAction] ?? 1000);
      state.action = safeAction;
      state.intensity = clamp(intensity, 0.2, 1.8);
      state.actionStartedAt = performance.now();
      state.actionEndsAt = state.actionStartedAt + durationMs;
      state.actionHoldUntil =
        safeAction === "idle"
          ? 0
          : performance.now() + Number(options.holdMs ?? Math.max(1800, durationMs + 650));
      remember("action", { action: safeAction, intensity: state.intensity });
      return { ok: true, action: state.action, intensity: state.intensity };
    }

    function defaultStatusText(kind: string) {
      return STATUS_LABELS[kind] || "";
    }

    function normalizeStatusText(value: unknown) {
      return String(value ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 96);
    }

    function setStatus(kind = "idle", text = "", holdMs = 12000) {
      const safeKind = normalizeEnum(kind, ALLOWED_STATUS_KINDS, "idle");
      const safeText = normalizeStatusText(text || defaultStatusText(safeKind));
      if (safeKind === "idle" || !safeText) {
        state.statusKind = "idle";
        state.statusText = "";
        state.statusVisibleUntil = 0;
        state.statusUpdatedAt = new Date().toISOString();
        remember("status", { statusKind: "idle", statusText: "" });
        return { ok: true, statusKind: state.statusKind, statusText: state.statusText };
      }
      state.statusKind = safeKind;
      state.statusText = safeText;
      state.statusVisibleUntil = performance.now() + Number(holdMs ?? 12000);
      state.statusUpdatedAt = new Date().toISOString();
      remember("status", { statusKind: safeKind, statusText: safeText });
      return { ok: true, statusKind: state.statusKind, statusText: state.statusText };
    }

    function statusActive() {
      return (
        state.statusKind !== "idle" &&
        Boolean(state.statusText) &&
        performance.now() < Number(state.statusVisibleUntil || 0)
      );
    }

    function visibleStatus() {
      if (!statusActive()) {
        if (state.statusKind !== "idle" || state.statusText) {
          state.statusKind = "idle";
          state.statusText = "";
          state.statusVisibleUntil = 0;
        }
        return null;
      }
      return { kind: state.statusKind, text: state.statusText };
    }

    function updateState(input: UpdateStateInput = {}) {
      const mood = input.mood || state.mood;
      const action = input.action || state.action;
      const intensity = input.intensity ?? state.intensity;
      const expression = setExpression(mood, { holdMs: input.expressionHoldMs ?? 11000 });
      const actionResult = setAction(action, intensity, { holdMs: input.actionHoldMs ?? 6500 });
      const statusKind = input.statusKind ?? input.status_kind;
      const statusText = input.statusText ?? input.status_text;
      const statusHoldMs = input.statusHoldMs ?? input.status_hold_ms;
      const statusResult =
        statusKind !== undefined || statusText !== undefined || statusHoldMs !== undefined
          ? setStatus(
              String(statusKind ?? (statusText !== undefined ? "thinking" : state.statusKind)),
              String(statusText ?? ""),
              Number(statusHoldMs ?? 12000),
            )
          : { ok: true, skipped: true, statusKind: state.statusKind, statusText: state.statusText };
      return {
        ok: true,
        mood: state.mood,
        action: state.action,
        intensity: state.intensity,
        statusKind: state.statusKind,
        statusText: state.statusText,
        expression,
        actionResult,
        statusResult,
      };
    }

    function getActionEnvelope() {
      if (performance.now() > state.actionEndsAt) state.action = "idle";
      const local = clamp01(
        (performance.now() - state.actionStartedAt) /
          Math.max(1, state.actionEndsAt - state.actionStartedAt),
      );
      return state.action === "idle" ? 0 : Math.sin(Math.PI * local) * state.intensity;
    }

    const controller = {
      state,
      allowedMoods: ALLOWED_MOODS,
      allowedActions: ALLOWED_ACTIONS,
      currentPreset: () => EXPRESSION_PRESETS[state.mood] || EXPRESSION_PRESETS.neutral,
      getActionEnvelope,
      visibleStatus,
      setStatus,
      setExpression,
      setAction,
      updateState,
    };
    window.MAB_AVATAR_STATE = state;
    window.MAB_AVATAR_CONTROLLER = controller;
    return controller;
  }

  const avatarController = createAvatarStateController();
  const rendererState = {
    ok: true,
    renderer: "initializing",
    live2dLoaded: false,
    vrmLoaded: false,
    fallbackReason: "",
    modelUrl: config.modelUrl,
    vrmModelUrl: config.vrmModelUrl,
    modelAttempts: [],
    vrmModelAttempts: [],
    vrmDependencySource: "",
    vrmDependencyAttempts: [],
    live2dParameterFrames: 0,
    vrmFrames: 0,
    vrmSpeechFrames: 0,
    vrmMouthLevel: 0,
    vrmViseme: "closed",
  };
  window.MAB_AVATAR_RENDERER = rendererState;

  let trustedScriptPolicy;
  function getTrustedScriptPolicy() {
    if (trustedScriptPolicy !== undefined) return trustedScriptPolicy;
    try {
      trustedScriptPolicy =
        window.trustedTypes?.createPolicy?.("meeting-avatar-live2d", {
          createScriptURL: (value) => value,
        }) || null;
    } catch {
      trustedScriptPolicy = null;
    }
    return trustedScriptPolicy;
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      const policy = getTrustedScriptPolicy();
      script.src = policy ? policy.createScriptURL(src) : src;
      script.async = true;
      script.addEventListener("load", resolve, { once: true });
      script.addEventListener("error", () => reject(new Error(`failed to load ${src}`)), { once: true });
      document.head.appendChild(script);
    });
  }

  async function loadLive2DDeps() {
    if (window.PIXI && window.PIXI!.live2d && window.Live2DCubismCore) return;
    await loadScript("https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js");
    await loadScript("https://cdn.jsdelivr.net/npm/pixi.js@6.5.10/dist/browser/pixi.min.js");
    await loadScript("https://cdn.jsdelivr.net/npm/pixi-live2d-display@0.4.0/dist/cubism4.min.js");
  }

  function normalizeModelUrls(...values) {
    const urls = [];
    const seen = new Set();
    for (const value of values.flat()) {
      const url = String(value || "").trim();
      if (!url || seen.has(url)) continue;
      seen.add(url);
      urls.push(url);
    }
    return urls;
  }

  async function loadLive2DModelWithFallback() {
    const urls = normalizeModelUrls(config.modelUrl, config.modelFallbackUrls);
    let lastError = null;
    for (const modelUrl of urls) {
      try {
        rendererState.modelAttempts.push({ url: modelUrl, ok: false });
        const model = await window.PIXI!.live2d.Live2DModel.from(modelUrl, { autoInteract: false });
        const attempt = rendererState.modelAttempts[rendererState.modelAttempts.length - 1];
        if (attempt) attempt.ok = true;
        rendererState.modelUrl = modelUrl;
        return { model, modelUrl };
      } catch (error) {
        lastError = error;
        const attempt = rendererState.modelAttempts[rendererState.modelAttempts.length - 1];
        if (attempt) attempt.error = String(error?.message || error);
        log("Live2D model load failed; trying fallback", modelUrl, error?.message);
      }
    }
    throw lastError || new Error("no Live2D model URLs configured");
  }

  function drawRoundRect(ctx, x, y, w, h, r) {
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, r);
      return;
    }
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
  }

  function drawFallback(ctx, t = 0) {
    const { canvasWidth: w, canvasHeight: h } = config;
    const state = avatarController.state;
    const mood = state.mood;
    const action = state.action;
    const actionPulse = avatarController.getActionEnvelope();
    const happy = mood === "happy" || mood === "shy";
    const surprised = mood === "surprised";
    const thinking = mood === "thinking";
    const sad = mood === "sad";
    const speaking = action === "speak";
    const shake = action === "shake" ? Math.sin(t / 70) * 18 * actionPulse : 0;
    const nod =
      action === "nod" || action === "emphasize" ? Math.sin(t / 90) * 14 * actionPulse : 0;
    ctx.fillStyle = config.background;
    ctx.fillRect(0, 0, w, h);
    ctx.save();
    ctx.translate(w / 2 + shake, h * 0.53 + Math.sin(t / 900) * 8 + nod);

    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "#ccd3df";
    ctx.lineWidth = 8;
    drawRoundRect(ctx, -260, -360, 520, 640, 120);
    ctx.fill();
    ctx.stroke();

    ctx.strokeStyle = "#2d3442";
    ctx.fillStyle = "#2d3442";
    ctx.lineWidth = 12;
    if (happy) {
      ctx.beginPath();
      ctx.arc(-95, -110, 44, 0.08 * Math.PI, 0.92 * Math.PI);
      ctx.arc(95, -110, 44, 0.08 * Math.PI, 0.92 * Math.PI);
      ctx.stroke();
    } else {
      const eyeScale = surprised ? 1.35 : thinking || sad ? 0.78 : 1;
      ctx.beginPath();
      ctx.arc(-95, -120, 34 * eyeScale, 0, Math.PI * 2);
      ctx.arc(95, -120, 34 * eyeScale, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.strokeStyle = "#e15c8f";
    ctx.lineWidth = 12;
    ctx.beginPath();
    if (sad) {
      ctx.arc(0, 65, 72, Math.PI + 0.2, Math.PI * 2 - 0.2);
    } else if (surprised || speaking) {
      ctx.ellipse(0, -12, 38, 54, 0, 0, Math.PI * 2);
    } else {
      ctx.arc(0, -20, happy ? 92 : 80, 0.15, Math.PI - 0.15);
    }
    ctx.stroke();

    ctx.fillStyle = "#232833";
    ctx.font = "700 54px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(config.botName, 0, 210);
    ctx.font = "34px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.fillStyle = "#657083";
    ctx.fillText(`fallback camera · ${mood} / ${action}`, 0, 265);
    ctx.restore();
  }

  function drawAvatarHud(ctx) {
    const status = avatarController.visibleStatus();
    if (!status) return;
    const { canvasWidth: w, canvasHeight: h } = config;
    const colors = STATUS_COLORS[status.kind] || STATUS_COLORS.thinking;
    const margin = 56;
    const maxWidth = Math.min(760, w - margin * 2);
    const x = margin;
    const y = h - 174;
    const height = 118;
    const radius = 28;
    const label = STATUS_LABELS[status.kind] || "Working";
    const text = status.text;

    ctx.save();
    ctx.shadowColor = "rgba(15, 23, 42, 0.28)";
    ctx.shadowBlur = 24;
    ctx.shadowOffsetY = 8;
    ctx.fillStyle = colors.bg;
    drawRoundRect(ctx, x, y, maxWidth, height, radius);
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.fillStyle = colors.accent;
    drawRoundRect(ctx, x + 22, y + 28, 16, height - 56, 8);
    ctx.fill();
    ctx.fillStyle = "rgba(255, 255, 255, 0.78)";
    ctx.font = "700 22px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(label, x + 56, y + 40);
    ctx.fillStyle = "#ffffff";
    ctx.font = "800 36px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.fillText(text, x + 56, y + 86, maxWidth - 86);
    ctx.restore();
  }

  function createAvatarVisualTestHooks(sourceCanvas) {
    const testCanvas = document.createElement("canvas");
    testCanvas.width = config.canvasWidth;
    testCanvas.height = config.canvasHeight;
    const testCtx = testCanvas.getContext("2d", { willReadFrequently: true });
    const sampleCanvas = document.createElement("canvas");
    sampleCanvas.width = 96;
    sampleCanvas.height = 54;
    const sampleCtx = sampleCanvas.getContext("2d", { willReadFrequently: true });

    function hashBytes(bytes) {
      let hash = 2166136261;
      for (let i = 0; i < bytes.length; i += 1) {
        hash ^= bytes[i];
        hash = Math.imul(hash, 16777619);
      }
      return (hash >>> 0).toString(16).padStart(8, "0");
    }

    function metricsFromContext(ctx, rect) {
      const image = ctx.getImageData(rect.x, rect.y, rect.width, rect.height);
      let nonBackground = 0;
      let ink = 0;
      let minX = rect.width;
      let minY = rect.height;
      let maxX = 0;
      let maxY = 0;
      for (let i = 0; i < image.data.length; i += 4) {
        const r = image.data[i];
        const g = image.data[i + 1];
        const b = image.data[i + 2];
        const alpha = image.data[i + 3];
        const delta = Math.abs(r - 247) + Math.abs(g - 248) + Math.abs(b - 251);
        if (alpha > 10 && delta > 36) {
          const pixel = i / 4;
          const x = pixel % rect.width;
          const y = Math.floor(pixel / rect.width);
          nonBackground += 1;
          ink += delta;
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
      const total = rect.width * rect.height;
      return {
        hash: hashBytes(image.data),
        nonBackgroundRatio: nonBackground / total,
        meanInk: ink / total,
        bounds: nonBackground ? { minX, minY, maxX, maxY } : null,
      };
    }

    function pixelDifference(left, right, rect) {
      const a = left.getImageData(rect.x, rect.y, rect.width, rect.height).data;
      const b = right.getImageData(rect.x, rect.y, rect.width, rect.height).data;
      let changed = 0;
      let totalDelta = 0;
      for (let i = 0; i < a.length; i += 4) {
        const delta =
          Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
        totalDelta += delta;
        if (delta > 30) changed += 1;
      }
      const pixels = rect.width * rect.height;
      return {
        changedRatio: changed / pixels,
        meanDelta: totalDelta / pixels,
      };
    }

    interface RenderSnapshotInput {
      mood?: string;
      action?: string;
      intensity?: number;
      actionElapsedMs?: number;
      actionRemainingMs?: number;
      statusKind?: string;
      statusText?: string;
      statusHoldMs?: number;
      timeMs?: number;
      label?: string;
      includeDataUrl?: boolean;
    }

    function renderSnapshot(input: RenderSnapshotInput = {}) {
      const saved = {
        mood: avatarController.state.mood,
        action: avatarController.state.action,
        intensity: avatarController.state.intensity,
        actionStartedAt: avatarController.state.actionStartedAt,
        actionEndsAt: avatarController.state.actionEndsAt,
        actionHoldUntil: avatarController.state.actionHoldUntil,
        expressionHoldUntil: avatarController.state.expressionHoldUntil,
        statusKind: avatarController.state.statusKind,
        statusText: avatarController.state.statusText,
        statusVisibleUntil: avatarController.state.statusVisibleUntil,
        statusUpdatedAt: avatarController.state.statusUpdatedAt,
      };
      try {
        const now = performance.now();
        avatarController.state.mood = normalizeEnum(input.mood, ALLOWED_MOODS, "neutral");
        avatarController.state.action = normalizeEnum(input.action, ALLOWED_ACTIONS, "idle");
        avatarController.state.intensity = clamp(input.intensity ?? 0.9, 0.2, 1.8);
        avatarController.state.actionStartedAt = now - Number(input.actionElapsedMs ?? 500);
        avatarController.state.actionEndsAt = now + Number(input.actionRemainingMs ?? 500);
        avatarController.state.actionHoldUntil = now + 1000;
        avatarController.state.expressionHoldUntil = now + 1000;
        if (input.statusKind || input.statusText) {
          avatarController.setStatus(
            String(input.statusKind || "thinking"),
            String(input.statusText || ""),
            Number(input.statusHoldMs || 12000),
          );
        }
        drawFallback(testCtx, Number(input.timeMs ?? 1200));
        drawAvatarHud(testCtx);
        sampleCtx.clearRect(0, 0, sampleCanvas.width, sampleCanvas.height);
        sampleCtx.drawImage(
          testCanvas,
          600,
          130,
          720,
          680,
          0,
          0,
          sampleCanvas.width,
          sampleCanvas.height,
        );
        const face = metricsFromContext(testCtx, { x: 600, y: 130, width: 720, height: 680 });
        const mouth = metricsFromContext(testCtx, { x: 760, y: 430, width: 400, height: 250 });
        const status = metricsFromContext(testCtx, { x: 40, y: 860, width: 820, height: 170 });
        const compact = sampleCtx.getImageData(0, 0, sampleCanvas.width, sampleCanvas.height);
        return {
          label: input.label || `${avatarController.state.mood}-${avatarController.state.action}`,
          mood: avatarController.state.mood,
          action: avatarController.state.action,
          intensity: avatarController.state.intensity,
          statusKind: avatarController.state.statusKind,
          statusText: avatarController.state.statusText,
          hash: hashBytes(compact.data),
          face,
          mouth,
          status,
          dataUrl: input.includeDataUrl ? testCanvas.toDataURL("image/png") : undefined,
        };
      } finally {
        Object.assign(avatarController.state, saved);
      }
    }

    function compareSnapshots(
      leftInput: RenderSnapshotInput,
      rightInput: RenderSnapshotInput,
      rect = { x: 760, y: 430, width: 400, height: 250 },
    ) {
      renderSnapshot(leftInput);
      const left = testCtx.getImageData(0, 0, testCanvas.width, testCanvas.height);
      const leftCanvas = document.createElement("canvas");
      leftCanvas.width = testCanvas.width;
      leftCanvas.height = testCanvas.height;
      const leftCtx = leftCanvas.getContext("2d", { willReadFrequently: true });
      leftCtx.putImageData(left, 0, 0);
      renderSnapshot(rightInput);
      return pixelDifference(leftCtx, testCtx, rect);
    }

    return {
      sourceCanvas,
      renderSnapshot,
      compareSnapshots,
      captureSourceSnapshot(input: { label?: string; includeDataUrl?: boolean } = {}) {
        try {
          testCtx.clearRect(0, 0, testCanvas.width, testCanvas.height);
          testCtx.drawImage(sourceCanvas, 0, 0, testCanvas.width, testCanvas.height);
          sampleCtx.clearRect(0, 0, sampleCanvas.width, sampleCanvas.height);
          sampleCtx.drawImage(
            testCanvas,
            600,
            130,
            720,
            680,
            0,
            0,
            sampleCanvas.width,
            sampleCanvas.height,
          );
          const compact = sampleCtx.getImageData(0, 0, sampleCanvas.width, sampleCanvas.height);
          return {
            ok: true,
            label: input.label || "source",
            renderer: rendererState.renderer,
            live2dLoaded: rendererState.live2dLoaded,
            live2dParameterFrames: avatarController.state.live2dParameterFrames,
            hash: hashBytes(compact.data),
            face: metricsFromContext(testCtx, { x: 600, y: 130, width: 720, height: 680 }),
            mouth: metricsFromContext(testCtx, { x: 760, y: 430, width: 400, height: 250 }),
            status: metricsFromContext(testCtx, { x: 40, y: 860, width: 820, height: 170 }),
            dataUrl: input.includeDataUrl ? testCanvas.toDataURL("image/png") : undefined,
          };
        } catch (error) {
          return {
            ok: false,
            label: input.label || "source",
            renderer: rendererState.renderer,
            live2dLoaded: rendererState.live2dLoaded,
            live2dParameterFrames: avatarController.state.live2dParameterFrames,
            error: String(error?.message || error),
          };
        }
      },
      getLiveHash() {
        sampleCtx.clearRect(0, 0, sampleCanvas.width, sampleCanvas.height);
        sampleCtx.drawImage(
          sourceCanvas,
          600,
          130,
          720,
          680,
          0,
          0,
          sampleCanvas.width,
          sampleCanvas.height,
        );
        return hashBytes(
          sampleCtx.getImageData(0, 0, sampleCanvas.width, sampleCanvas.height).data,
        );
      },
    };
  }

  function applyAvatarStateToLive2D(model, frameCount) {
    const core = model?.internalModel?.coreModel;
    if (!core) return;
    const t = frameCount / 60;
    const preset = avatarController.currentPreset();
    for (const [id, value] of Object.entries(preset)) setLive2DParam(core, id, value);

    const action = avatarController.state.action;
    const actionP = avatarController.getActionEnvelope();
    const mouthLevel = window.MAB_AVATAR_AUDIO_BUS?.getMouthLevel?.() || 0;
    const wave = action === "wave" ? Math.sin(t * 18) * actionP : 0;
    const shake = action === "shake" ? Math.sin(t * 16) * actionP : 0;
    const nod = action === "nod" || action === "emphasize" ? actionP : 0;
    const think = action === "think" ? actionP : 0;
    const lean = action === "lean_forward" || action === "emphasize" ? actionP : 0;
    const shrug = action === "shrug" ? actionP : 0;
    const speak = action === "speak" ? actionP : 0;
    const audioMouth = mouthLevel > 0.01 ? 0.06 + mouthLevel * 0.86 : 0;
    if (speak > 0 || audioMouth > 0) {
      setLive2DParam(
        core,
        "ParamMouthOpenY",
        Math.max(preset.ParamMouthOpenY || 0, audioMouth, 0.18 + speak * 0.62),
      );
      setLive2DParam(core, "ParamMouthForm", Math.max(preset.ParamMouthForm || 0, 0.35));
    }

    setLive2DParam(core, "ParamAngleX", Math.sin(t * 0.42) * 2 + shake * 7);
    setLive2DParam(
      core,
      "ParamAngleY",
      Math.sin(t * 0.57 + 1.1) * 1.2 - nod * 7 - lean * 3.5 + think * 1.4,
    );
    setLive2DParam(core, "ParamAngleZ", Math.sin(t * 0.33 + 0.6) * 1.0 - think * 4 + shrug * 2);
    setLive2DParam(core, "ParamBodyAngleX", Math.sin(t * 0.31 + 0.4) * 0.9 + shake * 1.8);
    setLive2DParam(core, "ParamBodyAngleY", Math.sin(t * 0.27 + 2.1) * 0.7 + lean * 3);
    setLive2DParam(core, "ParamBodyAngleZ", Math.sin(t * 0.24 + 0.7) * 0.5 + shrug * 1.5);
    setLive2DParam(core, "ParamBreath", 0.55 + Math.sin(t * 1.1) * 0.22);
    setLive2DParam(core, "ParamShoulder", shrug * 0.45 + lean * 0.18);
    setLive2DParam(core, "ParamEyeBallX", Math.sin(t * 0.21) * 0.1 - think * 0.28);
    setLive2DParam(core, "ParamEyeBallY", Math.sin(t * 0.17 + 1.8) * 0.06 + think * 0.1);
    setLive2DParam(core, "ParamArmLA", Math.sin(t * 0.62) * 0.06 + think * 0.35 + shrug * 0.25);
    setLive2DParam(
      core,
      "ParamArmRA",
      Math.sin(t * 0.58 + 1.4) * 0.06 + wave * 0.45 + lean * 0.18 + shrug * 0.25 + nod * 0.1,
    );
    setLive2DParam(core, "ParamHandL", think * 0.25);
    setLive2DParam(core, "ParamHandR", wave * 0.4);
    avatarController.state.live2dParameterFrames += 1;
  }

  function normalizeRenderer(value) {
    const renderer = String(value || "live2d").toLowerCase();
    if (renderer === "3d") return "vrm";
    return ["live2d", "vrm", "fallback"].includes(renderer) ? renderer : "live2d";
  }

  async function loadThreeVRMDeps() {
    const inline = window.MAB_AVATAR_THREE_VRM_DEPS;
    if (
      inline?.THREE &&
      inline?.GLTFLoader &&
      inline?.VRMLoaderPlugin
    ) {
      rendererState.vrmDependencySource = "inline_bundle";
      return {
        THREE: inline.THREE,
        GLTFLoader: inline.GLTFLoader,
        VRMLoaderPlugin: inline.VRMLoaderPlugin,
        VRMUtils: inline.VRMUtils,
        VRMExpressionPresetName: inline.VRMExpressionPresetName || {},
        VRMHumanBoneName: inline.VRMHumanBoneName || {},
      };
    }

    const urls = {
      three: config.threeModuleUrl,
      gltfLoader: config.gltfLoaderModuleUrl,
      threeVrm: config.threeVrmModuleUrl,
    };
    rendererState.vrmDependencyAttempts.push({ source: "dynamic_import", urls, ok: false });
    const attempt =
      rendererState.vrmDependencyAttempts[rendererState.vrmDependencyAttempts.length - 1];
    let three;
    let gltfLoader;
    let threeVrm;
    try {
      [three, gltfLoader, threeVrm] = await Promise.all([
        import(urls.three),
        import(urls.gltfLoader),
        import(urls.threeVrm),
      ]);
    } catch (error) {
      if (attempt) attempt.error = String(error?.message || error);
      throw error;
    }
    if (attempt) attempt.ok = true;
    rendererState.vrmDependencySource = "dynamic_import";
    return {
      THREE: three,
      GLTFLoader: gltfLoader.GLTFLoader,
      VRMLoaderPlugin: threeVrm.VRMLoaderPlugin,
      VRMUtils: threeVrm.VRMUtils,
      VRMExpressionPresetName: threeVrm.VRMExpressionPresetName || {},
      VRMHumanBoneName: threeVrm.VRMHumanBoneName || {},
    };
  }

  async function loadVRMModelWithFallback(loader) {
    const urls = normalizeModelUrls(config.vrmModelUrl, config.vrmModelFallbackUrls);
    let lastError = null;
    for (const modelUrl of urls) {
      try {
        rendererState.vrmModelAttempts.push({ url: modelUrl, ok: false });
        const gltf = await loader.loadAsync(modelUrl);
        const vrm = gltf?.userData?.vrm;
        if (!vrm) throw new Error("loaded GLTF did not contain VRM metadata");
        const attempt = rendererState.vrmModelAttempts[rendererState.vrmModelAttempts.length - 1];
        if (attempt) attempt.ok = true;
        rendererState.vrmModelUrl = modelUrl;
        return { vrm, modelUrl };
      } catch (error) {
        lastError = error;
        const attempt = rendererState.vrmModelAttempts[rendererState.vrmModelAttempts.length - 1];
        if (attempt) attempt.error = String(error?.message || error);
        log("VRM model load failed; trying fallback", modelUrl, error?.message);
      }
    }
    throw lastError || new Error("no VRM model URLs configured");
  }

  function setVRMExpression(vrm, names, value) {
    const expressionManager = vrm?.expressionManager;
    if (!expressionManager?.setValue) return;
    for (const name of names.filter(Boolean)) {
      try {
        expressionManager.setValue(name, value);
      } catch {
        // VRM models vary in their expression presets; absent names are expected.
      }
    }
  }

  function vrmExpressionNames(presets, aliases) {
    return [...presets, ...aliases].filter(Boolean);
  }

  function mouthExpressionGroups(VRMExpressionPresetName) {
    return {
      aa: vrmExpressionNames(
        [VRMExpressionPresetName.Aa, VRMExpressionPresetName.aa],
        ["aa", "A", "Mouth_A"],
      ),
      ih: vrmExpressionNames(
        [VRMExpressionPresetName.Ih, VRMExpressionPresetName.ih],
        ["ih", "I", "Mouth_I"],
      ),
      ou: vrmExpressionNames(
        [VRMExpressionPresetName.Ou, VRMExpressionPresetName.ou],
        ["ou", "U", "Mouth_U"],
      ),
      ee: vrmExpressionNames(
        [VRMExpressionPresetName.Ee, VRMExpressionPresetName.ee],
        ["ee", "E", "Mouth_E"],
      ),
      oh: vrmExpressionNames(
        [VRMExpressionPresetName.Oh, VRMExpressionPresetName.oh],
        ["oh", "O", "Mouth_O"],
      ),
    };
  }

  function applyVRMMouth(vrm, VRMExpressionPresetName, mouthLevel, elapsedSeconds) {
    const groups = mouthExpressionGroups(VRMExpressionPresetName);
    for (const names of Object.values(groups)) setVRMExpression(vrm, names, 0);
    const mouth = clamp01(mouthLevel);
    if (mouth <= 0.01) return { viseme: "closed", mouth };

    const cycle = Math.floor(elapsedSeconds * 9.5) % 5;
    const selected = ["aa", "ih", "ou", "ee", "oh"][cycle] || "aa";
    const flutter = 0.78 + 0.22 * (0.5 + 0.5 * Math.sin(elapsedSeconds * 24));
    const open = clamp01(mouth * flutter);
    const weights = {
      aa: selected === "aa" ? open : open * 0.3,
      ih: selected === "ih" ? open * 0.72 : 0,
      ou: selected === "ou" ? open * 0.68 : 0,
      ee: selected === "ee" ? open * 0.62 : 0,
      oh: selected === "oh" ? open * 0.74 : 0,
    };
    for (const [viseme, value] of Object.entries(weights)) {
      setVRMExpression(vrm, groups[viseme], value);
    }
    return { viseme: selected, mouth: open };
  }

  function rotateBone(vrm, boneName, rotation) {
    const node = vrm?.humanoid?.getNormalizedBoneNode?.(boneName);
    if (!node) return;
    node.rotation.x = rotation.x ?? node.rotation.x;
    node.rotation.y = rotation.y ?? node.rotation.y;
    node.rotation.z = rotation.z ?? node.rotation.z;
  }

  function applyAvatarStateToVRM(vrm, deps, delta, elapsedSeconds) {
    vrm?.update?.(delta);
    const { VRMExpressionPresetName, VRMHumanBoneName } = deps;
    const state = avatarController.state;
    const mood = state.mood;
    const action = state.action;
    const actionP = avatarController.getActionEnvelope();
    const mouthLevel = window.MAB_AVATAR_AUDIO_BUS?.getMouthLevel?.() || 0;
    const speak = action === "speak" ? actionP : 0;
    const mouth = clamp01(Math.max(mouthLevel, speak * 0.9, mood === "surprised" ? 0.35 : 0));
    const speech = applyVRMMouth(vrm, VRMExpressionPresetName, mouth, elapsedSeconds);
    setVRMExpression(
      vrm,
      [VRMExpressionPresetName.Happy, VRMExpressionPresetName.happy, "happy"],
      mood === "happy" || mood === "shy" ? 0.85 : 0,
    );
    setVRMExpression(
      vrm,
      [VRMExpressionPresetName.Surprised, VRMExpressionPresetName.surprised, "surprised"],
      mood === "surprised" ? 0.75 : 0,
    );
    setVRMExpression(
      vrm,
      [VRMExpressionPresetName.Sad, VRMExpressionPresetName.sad, "sad"],
      mood === "sad" ? 0.8 : 0,
    );
    setVRMExpression(
      vrm,
      [VRMExpressionPresetName.Relaxed, VRMExpressionPresetName.relaxed, "relaxed"],
      mood === "thinking" ? 0.35 : 0,
    );
    vrm?.expressionManager?.update?.();

    const wave = action === "wave" ? Math.sin(elapsedSeconds * 18) * actionP : 0;
    const shake = action === "shake" ? Math.sin(elapsedSeconds * 16) * actionP : 0;
    const nod = action === "nod" || action === "emphasize" ? actionP : 0;
    const think = action === "think" ? actionP : 0;
    const lean = action === "lean_forward" || action === "emphasize" ? actionP : 0;
    const shrug = action === "shrug" ? actionP : 0;
    const speechMotion = speech.mouth * (0.55 + 0.45 * Math.sin(elapsedSeconds * 18));
    rotateBone(vrm, VRMHumanBoneName.Head || "head", {
      x:
        Math.sin(elapsedSeconds * 0.57 + 1.1) * 0.025 -
        nod * 0.22 -
        lean * 0.08 +
        speechMotion * 0.035,
      y: Math.sin(elapsedSeconds * 0.42) * 0.04 + shake * 0.2,
      z: Math.sin(elapsedSeconds * 0.33 + 0.6) * 0.02 - think * 0.12,
    });
    rotateBone(vrm, VRMHumanBoneName.Spine || "spine", {
      x: lean * 0.08 + speechMotion * 0.012,
      y: shake * 0.04,
      z: shrug * 0.04,
    });
    rotateBone(vrm, VRMHumanBoneName.Chest || "chest", {
      x: lean * 0.16 + speechMotion * 0.025,
      y: shake * 0.08,
      z: shrug * 0.08,
    });
    rotateBone(vrm, VRMHumanBoneName.RightUpperArm || "rightUpperArm", {
      x: -0.08 - wave * 0.55 - shrug * 0.18,
      y: 0.05 + wave * 0.3,
      z: -1.18 - wave * 0.25,
    });
    rotateBone(vrm, VRMHumanBoneName.LeftUpperArm || "leftUpperArm", {
      x: -0.08 - think * 0.28 - shrug * 0.18,
      y: -0.05,
      z: 1.18,
    });
    rotateBone(vrm, VRMHumanBoneName.RightLowerArm || "rightLowerArm", {
      x: -0.08,
      y: 0,
      z: -0.28 - wave * 0.2,
    });
    rotateBone(vrm, VRMHumanBoneName.LeftLowerArm || "leftLowerArm", {
      x: -0.08,
      y: 0,
      z: 0.28 + think * 0.12,
    });
    rendererState.vrmMouthLevel = Number(speech.mouth.toFixed(4));
    rendererState.vrmViseme = speech.viseme;
    if (speech.mouth > 0.01)
      rendererState.vrmSpeechFrames = (rendererState.vrmSpeechFrames || 0) + 1;
    rendererState.vrmFrames += 1;
  }

  async function createVRMAvatarRenderer(canvas) {
    const deps = await loadThreeVRMDeps();
    const { THREE, GLTFLoader, VRMLoaderPlugin, VRMUtils } = deps;
    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: true,
    });
    renderer.setSize(config.canvasWidth, config.canvasHeight, false);
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(config.background);
    const camera = new THREE.PerspectiveCamera(
      config.layout === "presenter" ? 24 : 18,
      config.canvasWidth / config.canvasHeight,
      0.1,
      100,
    );
    camera.position.set(0, config.layout === "presenter" ? 1.25 : 1.42, 3.1);
    camera.lookAt(0, 1.25, 0);

    const keyLight = new THREE.DirectionalLight(0xffffff, 2.4);
    keyLight.position.set(1.5, 2.4, 2.8);
    scene.add(keyLight);
    scene.add(new THREE.AmbientLight(0xffffff, 1.25));

    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const { vrm, modelUrl } = await loadVRMModelWithFallback(loader);
    VRMUtils?.removeUnnecessaryVertices?.(vrm.scene);
    VRMUtils?.removeUnnecessaryJoints?.(vrm.scene);
    VRMUtils?.rotateVRM0?.(vrm);
    scene.add(vrm.scene);

    const box = new THREE.Box3().setFromObject(vrm.scene);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    const height = Math.max(0.1, size.y);
    const targetHeight = config.layout === "presenter" ? 2.2 : 2.4;
    const scale = targetHeight / height;
    vrm.scene.scale.setScalar(scale);
    const targetCenterX = config.layout === "presenter" ? 0.7 : 0;
    const targetCenterY = config.layout === "presenter" ? 0 : 0.55;
    vrm.scene.position.set(
      targetCenterX - center.x * scale,
      targetCenterY - center.y * scale,
      -center.z * scale,
    );

    Object.assign(rendererState, {
      renderer: "vrm",
      vrmLoaded: true,
      live2dLoaded: false,
      fallbackReason: "",
      vrmModelUrl: modelUrl,
      layout: config.layout,
    });
    log("VRM avatar loaded", modelUrl);

    const clock = new THREE.Clock();
    const startedAt = performance.now();
    function tick() {
      const delta = clock.getDelta();
      const elapsedSeconds = (performance.now() - startedAt) / 1000;
      applyAvatarStateToVRM(vrm, deps, delta, elapsedSeconds);
      renderer.render(scene, camera);
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  function createHiddenAvatarCanvas() {
    const canvas = document.createElement("canvas");
    canvas.width = config.canvasWidth;
    canvas.height = config.canvasHeight;
    canvas.style.cssText =
      "position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;pointer-events:none;";
    document.documentElement.appendChild(canvas);
    return canvas;
  }

  async function createAvatarCanvas(existingCanvas = null) {
    const canvas = existingCanvas || createHiddenAvatarCanvas();
    const requestedRenderer = normalizeRenderer(config.avatarRenderer);
    let live2dLoaded = false;
    let vrmLoaded = false;
    let fallbackReason =
      requestedRenderer === "fallback"
        ? "fallback_requested"
        : config.disableLive2D && requestedRenderer === "live2d"
          ? "disabled_by_config"
          : "";

    if (requestedRenderer === "vrm") {
      try {
        await createVRMAvatarRenderer(canvas);
        vrmLoaded = true;
      } catch (error) {
        fallbackReason = String(error?.message || error);
        log("VRM load failed; using fallback canvas", error?.message);
      }
    }

    if (!vrmLoaded && requestedRenderer === "live2d" && !config.disableLive2D) {
      try {
        await loadLive2DDeps();
        const app = new window.PIXI!.Application({
          view: canvas,
          width: config.canvasWidth,
          height: config.canvasHeight,
          backgroundAlpha: 1,
          backgroundColor: Number.parseInt(config.background.replace("#", ""), 16) || 0xf7f8fb,
          antialias: true,
          resolution: 2,
          autoDensity: true,
          powerPreference: "high-performance",
          autoStart: true,
        });
        const { model, modelUrl } = await loadLive2DModelWithFallback();
        app.stage.addChild(model);
        const fitScale = config.canvasHeight / model.height;
        const scale = config.layout === "presenter" ? fitScale * 0.82 : fitScale * 2.35;
        model.scale.set(scale);
        if (config.layout === "presenter") {
          const presenterMargin = Math.round(config.canvasWidth * 0.025);
          model.anchor.set(0.5, 1);
          model.x = config.canvasWidth - model.width / 2 - presenterMargin;
          model.y = config.canvasHeight + Math.round(model.height * 0.2);
        } else {
          model.anchor.set(0.5, 0);
          model.x = config.canvasWidth / 2;
          model.y = -model.height * 0.02;
        }
        if (model.motion) {
          const forcePriority = 3;
          await model.motion("Idle", 0, forcePriority);
        }
        const motionManager = model.internalModel?.motionManager;
        if (motionManager?.startRandomMotion) {
          motionManager.startRandomMotion = () => Promise.resolve(false);
        }
        let frameCount = 0;
        app.ticker.add(
          () => {
            frameCount += 1;
            applyAvatarStateToLive2D(model, frameCount);
            rendererState.live2dParameterFrames = avatarController.state.live2dParameterFrames;
          },
          null,
          window.PIXI!.UPDATE_PRIORITY.LOW,
        );
        live2dLoaded = true;
        Object.assign(rendererState, {
          renderer: "live2d",
          live2dLoaded: true,
          fallbackReason: "",
          modelUrl,
          modelWidth: model.width,
          modelHeight: model.height,
          layout: config.layout,
        });
        log("Live2D avatar loaded", modelUrl);
      } catch (error) {
        fallbackReason = String(error?.message || error);
        log("Live2D load failed; using fallback canvas", error?.message);
      }
    }

    if (!live2dLoaded && !vrmLoaded) {
      Object.assign(rendererState, {
        renderer: "fallback",
        live2dLoaded: false,
        vrmLoaded: false,
        fallbackReason: fallbackReason || "live2d_not_loaded",
      });
      const ctx = canvas.getContext("2d");
      const tick = (t) => {
        drawFallback(ctx, t);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }

    return canvas;
  }

  function createAvatarAudioBus() {
    const AudioContextImpl = window.AudioContext || window.webkitAudioContext;
    const audioContext = new AudioContextImpl({ sampleRate: 48000 });
    const destination = audioContext.createMediaStreamDestination();
    const masterGain = audioContext.createGain();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.18;
    const waveform = new Uint8Array(analyser.fftSize);
    let smoothedMouthLevel = 0;
    let syntheticSpeechActive = false;
    let syntheticSpeechUntil = 0;
    masterGain.gain.value = Number((config as Record<string, unknown>).fakeMicGain ?? 1);
    masterGain.connect(destination);
    masterGain.connect(analyser);

    const state = {
      ok: true,
      sampleRate: audioContext.sampleRate,
      outputTrackId: destination.stream.getAudioTracks()[0]?.id || "",
      lipSyncEnabled: true,
      mouthLevel: 0,
      mouthRms: 0,
      syntheticSpeechActive: false,
      routedStreams: 0,
      routedElements: 0,
      routedBuffers: 0,
      injectedTones: 0,
      lastRoute: null,
      errors: [],
    };

    function rememberError(error: unknown): void {
      const err = error as { message?: string };
      state.errors.push({
        ts: new Date().toISOString(),
        message: String((err && err.message) || error).slice(0, 300),
      });
      state.errors = state.errors.slice(-20);
    }

    function touch(kind: string, detail: Record<string, unknown> = {}): void {
      state.lastRoute = { ts: new Date().toISOString(), kind, ...detail };
      audioContext.resume?.().catch(() => {});
    }

    interface StreamOptions {
      label?: string;
      gain?: number;
    }

    function addStream(stream: MediaStream | null | undefined, options: StreamOptions = {}) {
      try {
        if (!stream || !stream.getAudioTracks || stream.getAudioTracks().length === 0) {
          throw new Error("stream has no audio tracks");
        }
        const source = audioContext.createMediaStreamSource(stream);
        const gain = audioContext.createGain();
        gain.gain.value = Number(options.gain ?? 1);
        source.connect(gain);
        gain.connect(masterGain);
        state.routedStreams += 1;
        touch("stream", {
          label: options.label || "",
          trackIds: stream.getAudioTracks().map((track) => track.id),
        });
        return { ok: true };
      } catch (error) {
        rememberError(error);
        return { ok: false, error: String((error && error.message) || error) };
      }
    }

    function getMouthLevel() {
      try {
        analyser.getByteTimeDomainData(waveform);
        let sumSquares = 0;
        for (const sample of waveform) {
          const centered = (sample - 128) / 128;
          sumSquares += centered * centered;
        }
        const rms = Math.sqrt(sumSquares / waveform.length);
        const gated = Math.max(0, rms - 0.012);
        const syntheticActive = syntheticSpeechActive || performance.now() < syntheticSpeechUntil;
        const t = performance.now() / 1000;
        const synthetic = syntheticActive
          ? 0.2 +
            0.24 * (0.5 + 0.5 * Math.sin(t * 18)) +
            0.16 * (0.5 + 0.5 * Math.sin(t * 31 + 0.8))
          : 0;
        const target = clamp01(Math.max(gated * 5.8, synthetic));
        const coefficient = target > smoothedMouthLevel ? 0.52 : 0.22;
        smoothedMouthLevel += (target - smoothedMouthLevel) * coefficient;
        state.mouthRms = Number(rms.toFixed(4));
        state.mouthLevel = Number(smoothedMouthLevel.toFixed(4));
        state.syntheticSpeechActive = syntheticActive;
        return smoothedMouthLevel;
      } catch (error) {
        rememberError(error);
        return 0;
      }
    }

    function setSyntheticSpeech(active: boolean, options: { holdMs?: number } = {}) {
      syntheticSpeechActive = Boolean(active);
      syntheticSpeechUntil = syntheticSpeechActive
        ? performance.now() + Number(options.holdMs ?? 1600)
        : 0;
      state.syntheticSpeechActive = syntheticSpeechActive;
      return { ok: true, active: syntheticSpeechActive };
    }

    function addElement(audioElement: HTMLMediaElement, options: StreamOptions = {}) {
      try {
        const source = audioContext.createMediaElementSource(audioElement);
        const gain = audioContext.createGain();
        gain.gain.value = Number(options.gain ?? 1);
        source.connect(gain);
        gain.connect(masterGain);
        state.routedElements += 1;
        touch("element", { label: options.label || "" });
        return { ok: true };
      } catch (error) {
        rememberError(error);
        const err = error as { message?: string };
        return { ok: false, error: String((err && err.message) || error) };
      }
    }

    interface InjectToneOptions {
      label?: string;
      frequency?: number;
      gain?: number;
      durationMs?: number;
    }

    function injectTone(options: InjectToneOptions = {}) {
      try {
        const oscillator = audioContext.createOscillator();
        const gain = audioContext.createGain();
        oscillator.frequency.value = Number(options.frequency ?? 440);
        gain.gain.value = Number(options.gain ?? 0.0001);
        oscillator.connect(gain);
        gain.connect(masterGain);
        oscillator.start();
        oscillator.stop(audioContext.currentTime + Number(options.durationMs ?? 120) / 1000);
        state.injectedTones += 1;
        touch("tone", { label: options.label || "mock-remote-audio" });
        return { ok: true };
      } catch (error) {
        rememberError(error);
        const err = error as { message?: string };
        return { ok: false, error: String((err && err.message) || error) };
      }
    }

    async function playAudioDataUrl(audioDataUrl: string, options: StreamOptions = {}) {
      try {
        const response = await fetch(audioDataUrl);
        const arrayBuffer = await response.arrayBuffer();
        const decoded = await audioContext.decodeAudioData(arrayBuffer.slice(0));
        const source = audioContext.createBufferSource();
        const gain = audioContext.createGain();
        source.buffer = decoded;
        gain.gain.value = Number(options.gain ?? 1);
        source.connect(gain);
        gain.connect(masterGain);
        source.start();
        state.routedBuffers += 1;
        touch("buffer", {
          label: options.label || "",
          durationMs: Math.round(decoded.duration * 1000),
        });
        return { ok: true, durationMs: Math.round(decoded.duration * 1000) };
      } catch (error) {
        rememberError(error);
        const err = error as { message?: string };
        return { ok: false, error: String((err && err.message) || error) };
      }
    }

    const keeper = audioContext.createConstantSource();
    const keeperGain = audioContext.createGain();
    keeper.offset.value = 0;
    keeperGain.gain.value = 0;
    keeper.connect(keeperGain);
    keeperGain.connect(masterGain);
    keeper.start();

    const bus = {
      state,
      audioContext,
      stream: destination.stream,
      track: destination.stream.getAudioTracks()[0],
      addStream,
      addElement,
      playAudioDataUrl,
      injectTone,
      getMouthLevel,
      setSyntheticSpeech,
    };
    window.MAB_AVATAR_AUDIO_BUS = bus;
    window.MAB_AVATAR_AUDIO = state;

    window.addEventListener("meeting-avatar-audio-stream", (event: Event) => {
      const detail = (event as CustomEvent).detail as
        | { stream?: MediaStream; label?: string; gain?: number }
        | undefined;
      addStream(detail?.stream, {
        label: detail?.label || "meeting-avatar-audio-stream",
        gain: detail?.gain,
      });
    });

    return bus;
  }

  function installMediaDeviceOverride(videoTrack: MediaStreamTrack, audioTrack: MediaStreamTrack) {
    const mediaDevicesAny = (navigator.mediaDevices || ({} as MediaDevices)) as MediaDevices & {
      getUserMedia?: (constraints?: MediaStreamConstraints) => Promise<MediaStream>;
      enumerateDevices?: () => Promise<MediaDeviceInfo[]>;
    };
    const originalGetUserMedia = mediaDevicesAny.getUserMedia?.bind(mediaDevicesAny);
    const originalEnumerateDevices = mediaDevicesAny.enumerateDevices?.bind(mediaDevicesAny);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      get: () => mediaDevicesAny,
    });

    mediaDevicesAny.getUserMedia = async (constraints: MediaStreamConstraints = {}) => {
      const tracks: MediaStreamTrack[] = [];
      if (constraints.video) tracks.push(videoTrack.clone());
      if (constraints.audio) tracks.push(audioTrack.clone());
      if (tracks.length) return new MediaStream(tracks);
      if (originalGetUserMedia) return originalGetUserMedia(constraints);
      return new MediaStream();
    };

    mediaDevicesAny.enumerateDevices = async () => {
      const realDevices = originalEnumerateDevices
        ? await originalEnumerateDevices().catch(() => [] as MediaDeviceInfo[])
        : [];
      return [
        {
          deviceId: "meeting-avatar-mic",
          kind: "audioinput",
          label: `${config.botName} Mic`,
          groupId: "meeting-avatar",
        } as MediaDeviceInfo,
        {
          deviceId: "meeting-avatar-camera",
          kind: "videoinput",
          label: `${config.botName} Camera`,
          groupId: "meeting-avatar",
        } as MediaDeviceInfo,
        ...realDevices,
      ];
    };
  }

  async function start() {
    const canvas = createHiddenAvatarCanvas();
    const bootCtx = canvas.getContext("2d")!;
    drawFallback(bootCtx, performance.now());
    const bootFallbackTick = (t: number) => {
      if (rendererState.renderer !== "initializing") return;
      drawFallback(bootCtx, t);
      requestAnimationFrame(bootFallbackTick);
    };
    requestAnimationFrame(bootFallbackTick);
    const videoTrack = canvas
      .captureStream(Math.max(1, Number(config.captureFps || 30)))
      .getVideoTracks()[0];
    const audioBus = createAvatarAudioBus();
    const audioTrack = audioBus.track;
    installMediaDeviceOverride(videoTrack, audioTrack);
    window.MAB_AVATAR_READY = {
      ok: true,
      mode: "avatar-renderer",
      videoTrackId: videoTrack.id,
      audioTrackId: audioTrack.id,
      audioRoute: window.MAB_AVATAR_AUDIO,
      avatarState: window.MAB_AVATAR_STATE,
      renderer: window.MAB_AVATAR_RENDERER,
      rendererMode: window.MAB_AVATAR_RENDERER.renderer,
      live2dLoaded: window.MAB_AVATAR_RENDERER.live2dLoaded,
      vrmLoaded: window.MAB_AVATAR_RENDERER.vrmLoaded,
      fallbackReason: window.MAB_AVATAR_RENDERER.fallbackReason,
      modelUrl: config.modelUrl,
      vrmModelUrl: config.vrmModelUrl,
      rendererDeferred: Boolean(config.deferRendererUntilExplicitStart),
    };
    log("avatar fake media ready", window.MAB_AVATAR_READY);
    let rendererStartPromise: Promise<typeof window.MAB_AVATAR_READY> | null = null;
    const startRenderer = async () => {
      if (rendererStartPromise) return rendererStartPromise;
      rendererStartPromise = (async () => {
        const renderCanvas = await createAvatarCanvas();
        const mirrorRenderCanvas = () => {
          try {
            bootCtx.clearRect(0, 0, canvas.width, canvas.height);
            bootCtx.drawImage(renderCanvas, 0, 0, canvas.width, canvas.height);
            drawAvatarHud(bootCtx);
          } catch (error) {
            rendererState.fallbackReason =
              rendererState.fallbackReason || String(error?.message || error);
          }
          requestAnimationFrame(mirrorRenderCanvas);
        };
        requestAnimationFrame(mirrorRenderCanvas);
        Object.assign(window.MAB_AVATAR_READY, {
          avatarState: window.MAB_AVATAR_STATE,
          renderer: window.MAB_AVATAR_RENDERER,
          rendererMode: window.MAB_AVATAR_RENDERER.renderer,
          live2dLoaded: window.MAB_AVATAR_RENDERER.live2dLoaded,
          vrmLoaded: window.MAB_AVATAR_RENDERER.vrmLoaded,
          fallbackReason: window.MAB_AVATAR_RENDERER.fallbackReason,
          modelUrl: config.modelUrl,
          vrmModelUrl: config.vrmModelUrl,
          rendererDeferred: false,
          rendererStartedAt: new Date().toISOString(),
        });
        if (config.enableVisualTestHooks) {
          window.MAB_AVATAR_VISUAL_TEST = createAvatarVisualTestHooks(canvas);
        }
        log("avatar renderer ready", window.MAB_AVATAR_READY);
        return window.MAB_AVATAR_READY;
      })().catch((error) => {
        rendererStartPromise = null;
        rendererState.fallbackReason =
          rendererState.fallbackReason || String(error?.message || error);
        Object.assign(window.MAB_AVATAR_READY, {
          ok: false,
          rendererDeferred: false,
          rendererError: String(error?.message || error),
        });
        throw error;
      });
      return rendererStartPromise;
    };
    window.MAB_AVATAR_START_RENDERER = startRenderer;
    if (config.deferRendererUntilExplicitStart) {
      log("avatar renderer deferred until explicit start", window.MAB_AVATAR_READY);
    } else {
      await startRenderer();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
