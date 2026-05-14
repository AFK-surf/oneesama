(() => {
  if (window.__meetingAvatarBotInjected) return;
  if (window.top !== window) return;
  window.__meetingAvatarBotInjected = true;

  const config = {
    modelUrl:
      "https://cdn.jsdelivr.net/gh/Live2D/CubismWebSamples@master/Samples/Resources/Hiyori/Hiyori.model3.json",
    canvasWidth: 1920,
    canvasHeight: 1080,
    captureFps: 30,
    botName: "Meeting Avatar Bot",
    background: "#f7f8fb",
    layout: "face",
    disableLive2D: false,
    enableVisualTestHooks: false,
    ...(window.MAB_AVATAR_CONFIG || {}),
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

    function updateState(input: UpdateStateInput = {}) {
      const mood = input.mood || state.mood;
      const action = input.action || state.action;
      const intensity = input.intensity ?? state.intensity;
      const expression = setExpression(mood, { holdMs: input.expressionHoldMs ?? 11000 });
      const actionResult = setAction(action, intensity, { holdMs: input.actionHoldMs ?? 6500 });
      return {
        ok: true,
        mood: state.mood,
        action: state.action,
        intensity: state.intensity,
        expression,
        actionResult,
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
    fallbackReason: "",
    modelUrl: config.modelUrl,
    live2dParameterFrames: 0,
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
      script.onload = resolve;
      script.onerror = () => reject(new Error(`failed to load ${src}`));
      document.head.appendChild(script);
    });
  }

  async function loadLive2DDeps() {
    if (window.PIXI && window.PIXI!.live2d && window.Live2DCubismCore)
      return;
    await loadScript("https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js");
    await loadScript("https://cdn.jsdelivr.net/npm/pixi.js@6.5.10/dist/browser/pixi.min.js");
    await loadScript("https://cdn.jsdelivr.net/npm/pixi-live2d-display@0.4.0/dist/cubism4.min.js");
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
        drawFallback(testCtx, Number(input.timeMs ?? 1200));
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
        const compact = sampleCtx.getImageData(0, 0, sampleCanvas.width, sampleCanvas.height);
        return {
          label: input.label || `${avatarController.state.mood}-${avatarController.state.action}`,
          mood: avatarController.state.mood,
          action: avatarController.state.action,
          intensity: avatarController.state.intensity,
          hash: hashBytes(compact.data),
          face,
          mouth,
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
    let live2dLoaded = false;
    let fallbackReason = config.disableLive2D ? "disabled_by_config" : "";

    if (!config.disableLive2D) {
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
        const model = await window.PIXI!.live2d.Live2DModel.from(config.modelUrl, { autoInteract: false });
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
          modelWidth: model.width,
          modelHeight: model.height,
          layout: config.layout,
        });
        log("Live2D avatar loaded", config.modelUrl);
      } catch (error) {
        fallbackReason = String(error?.message || error);
        log("Live2D load failed; using fallback canvas", error?.message);
      }
    }

    if (!live2dLoaded) {
      Object.assign(rendererState, {
        renderer: "fallback",
        live2dLoaded: false,
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
    const mediaDevicesAny = (navigator.mediaDevices ||
      ({} as MediaDevices)) as MediaDevices & {
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
      mode: "hiyori-live2d-or-fallback",
      videoTrackId: videoTrack.id,
      audioTrackId: audioTrack.id,
      audioRoute: window.MAB_AVATAR_AUDIO,
      avatarState: window.MAB_AVATAR_STATE,
      renderer: window.MAB_AVATAR_RENDERER,
      rendererMode: window.MAB_AVATAR_RENDERER.renderer,
      live2dLoaded: window.MAB_AVATAR_RENDERER.live2dLoaded,
      fallbackReason: window.MAB_AVATAR_RENDERER.fallbackReason,
      modelUrl: config.modelUrl,
    };
    log("avatar fake media ready", window.MAB_AVATAR_READY);
    const renderCanvas = await createAvatarCanvas();
    const mirrorRenderCanvas = () => {
      try {
        bootCtx.clearRect(0, 0, canvas.width, canvas.height);
        bootCtx.drawImage(renderCanvas, 0, 0, canvas.width, canvas.height);
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
      fallbackReason: window.MAB_AVATAR_RENDERER.fallbackReason,
      modelUrl: config.modelUrl,
    });
    if (config.enableVisualTestHooks) {
      window.MAB_AVATAR_VISUAL_TEST = createAvatarVisualTestHooks(canvas);
    }
    log("avatar renderer ready", window.MAB_AVATAR_READY);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
