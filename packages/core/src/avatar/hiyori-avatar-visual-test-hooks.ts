interface VisualHooksInput {
  config: { canvasWidth: number; canvasHeight: number };
  avatarController: any;
  rendererState: any;
  normalizeEnum: (value: unknown, allowed: string[], fallback: string) => string;
  allowedMoods: string[];
  allowedActions: string[];
  clamp: (value: unknown, min: number, max: number) => number;
  drawFallback: (ctx: CanvasRenderingContext2D, t?: number) => void;
  drawAvatarHud: (ctx: CanvasRenderingContext2D) => void;
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

export function createAvatarVisualTestHooks(sourceCanvas: HTMLCanvasElement, input: VisualHooksInput) {
  const {
    config,
    avatarController,
    rendererState,
    normalizeEnum,
    allowedMoods,
    allowedActions,
    clamp,
    drawFallback,
    drawAvatarHud,
  } = input;
  const testCanvas = document.createElement("canvas");
  testCanvas.width = config.canvasWidth;
  testCanvas.height = config.canvasHeight;
  const testCtx = testCanvas.getContext("2d", { willReadFrequently: true })!;
  const sampleCanvas = document.createElement("canvas");
  sampleCanvas.width = 96;
  sampleCanvas.height = 54;
  const sampleCtx = sampleCanvas.getContext("2d", { willReadFrequently: true })!;

  function hashBytes(bytes: Uint8ClampedArray) {
    let hash = 2166136261;
    for (let i = 0; i < bytes.length; i += 1) {
      hash ^= bytes[i];
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function metricsFromContext(ctx: CanvasRenderingContext2D, rect: DOMRectInit) {
    const image = ctx.getImageData(rect.x!, rect.y!, rect.width!, rect.height!);
    let nonBackground = 0;
    let ink = 0;
    let minX = rect.width!;
    let minY = rect.height!;
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
        const x = pixel % rect.width!;
        const y = Math.floor(pixel / rect.width!);
        nonBackground += 1;
        ink += delta;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
    const total = rect.width! * rect.height!;
    return {
      hash: hashBytes(image.data),
      nonBackgroundRatio: nonBackground / total,
      meanInk: ink / total,
      bounds: nonBackground ? { minX, minY, maxX, maxY } : null,
    };
  }

  function pixelDifference(
    left: CanvasRenderingContext2D,
    right: CanvasRenderingContext2D,
    rect: DOMRectInit,
  ) {
    const a = left.getImageData(rect.x!, rect.y!, rect.width!, rect.height!).data;
    const b = right.getImageData(rect.x!, rect.y!, rect.width!, rect.height!).data;
    let changed = 0;
    let totalDelta = 0;
    for (let i = 0; i < a.length; i += 4) {
      const delta =
        Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      totalDelta += delta;
      if (delta > 30) changed += 1;
    }
    const pixels = rect.width! * rect.height!;
    return { changedRatio: changed / pixels, meanDelta: totalDelta / pixels };
  }

  function renderSnapshot(snapshotInput: RenderSnapshotInput = {}) {
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
      avatarController.state.mood = normalizeEnum(snapshotInput.mood, allowedMoods, "neutral");
      avatarController.state.action = normalizeEnum(snapshotInput.action, allowedActions, "idle");
      avatarController.state.intensity = clamp(snapshotInput.intensity ?? 0.9, 0.2, 1.8);
      avatarController.state.actionStartedAt = now - Number(snapshotInput.actionElapsedMs ?? 500);
      avatarController.state.actionEndsAt = now + Number(snapshotInput.actionRemainingMs ?? 500);
      avatarController.state.actionHoldUntil = now + 1000;
      avatarController.state.expressionHoldUntil = now + 1000;
      if (snapshotInput.statusKind || snapshotInput.statusText) {
        avatarController.setStatus(
          String(snapshotInput.statusKind || "thinking"),
          String(snapshotInput.statusText || ""),
          Number(snapshotInput.statusHoldMs || 12000),
        );
      }
      drawFallback(testCtx, Number(snapshotInput.timeMs ?? 1200));
      drawAvatarHud(testCtx);
      sampleCtx.clearRect(0, 0, sampleCanvas.width, sampleCanvas.height);
      sampleCtx.drawImage(testCanvas, 600, 130, 720, 680, 0, 0, sampleCanvas.width, sampleCanvas.height);
      const compact = sampleCtx.getImageData(0, 0, sampleCanvas.width, sampleCanvas.height);
      return {
        label: snapshotInput.label || `${avatarController.state.mood}-${avatarController.state.action}`,
        mood: avatarController.state.mood,
        action: avatarController.state.action,
        intensity: avatarController.state.intensity,
        statusKind: avatarController.state.statusKind,
        statusText: avatarController.state.statusText,
        hash: hashBytes(compact.data),
        face: metricsFromContext(testCtx, { x: 600, y: 130, width: 720, height: 680 }),
        mouth: metricsFromContext(testCtx, { x: 760, y: 430, width: 400, height: 250 }),
        status: metricsFromContext(testCtx, { x: 40, y: 860, width: 820, height: 170 }),
        dataUrl: snapshotInput.includeDataUrl ? testCanvas.toDataURL("image/png") : undefined,
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
    const leftCtx = leftCanvas.getContext("2d", { willReadFrequently: true })!;
    leftCtx.putImageData(left, 0, 0);
    renderSnapshot(rightInput);
    return pixelDifference(leftCtx, testCtx, rect);
  }

  return {
    sourceCanvas,
    renderSnapshot,
    compareSnapshots,
    captureSourceSnapshot(captureInput: { label?: string; includeDataUrl?: boolean } = {}) {
      try {
        testCtx.clearRect(0, 0, testCanvas.width, testCanvas.height);
        testCtx.drawImage(sourceCanvas, 0, 0, testCanvas.width, testCanvas.height);
        sampleCtx.clearRect(0, 0, sampleCanvas.width, sampleCanvas.height);
        sampleCtx.drawImage(sourceCanvas, 600, 130, 720, 680, 0, 0, sampleCanvas.width, sampleCanvas.height);
        const compact = sampleCtx.getImageData(0, 0, sampleCanvas.width, sampleCanvas.height);
        return {
          ok: true,
          label: captureInput.label || "source",
          renderer: rendererState.renderer,
          live2dLoaded: rendererState.live2dLoaded,
          live2dParameterFrames: avatarController.state.live2dParameterFrames,
          hash: hashBytes(compact.data),
          face: metricsFromContext(testCtx, { x: 600, y: 130, width: 720, height: 680 }),
          mouth: metricsFromContext(testCtx, { x: 760, y: 430, width: 400, height: 250 }),
          status: metricsFromContext(testCtx, { x: 40, y: 860, width: 820, height: 170 }),
          dataUrl: captureInput.includeDataUrl ? testCanvas.toDataURL("image/png") : undefined,
        };
      } catch (error) {
        return {
          ok: false,
          label: captureInput.label || "source",
          renderer: rendererState.renderer,
          live2dLoaded: rendererState.live2dLoaded,
          live2dParameterFrames: avatarController.state.live2dParameterFrames,
          error: String((error as { message?: string })?.message || error),
        };
      }
    },
    getLiveHash() {
      sampleCtx.clearRect(0, 0, sampleCanvas.width, sampleCanvas.height);
      sampleCtx.drawImage(sourceCanvas, 600, 130, 720, 680, 0, 0, sampleCanvas.width, sampleCanvas.height);
      return hashBytes(sampleCtx.getImageData(0, 0, sampleCanvas.width, sampleCanvas.height).data);
    },
  };
}
