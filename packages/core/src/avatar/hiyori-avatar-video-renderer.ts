type VideoAvatarSource = {
  id: string;
  label: string;
  url: string;
  state: "idle" | "speaking";
  objectFit: "cover" | "contain";
  background: string;
  default: boolean;
};

type VideoRendererOptions = {
  config: Record<string, any>;
  avatarController: Record<string, any>;
  rendererState: Record<string, any>;
  drawFallback(ctx: CanvasRenderingContext2D, t?: number): void;
};

type RGB = { r: number; g: number; b: number };
type PixelData = Uint8ClampedArray<ArrayBufferLike>;

type VideoChromaKeyConfig = {
  enabled: boolean;
  keyColor: RGB;
  similarity: number;
  smoothness: number;
  minGreen: number;
  minDominance: number;
  spill: number;
  spillSoftness: number;
  matteErodePx: number;
  matteFeatherPx: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function parseColor(value: unknown, fallback: RGB): RGB {
  const text = String(value || "").trim();
  const hex = text.startsWith("#") ? text.slice(1) : text;
  if (/^[0-9a-f]{6}$/iu.test(hex)) {
    return {
      r: Number.parseInt(hex.slice(0, 2), 16),
      g: Number.parseInt(hex.slice(2, 4), 16),
      b: Number.parseInt(hex.slice(4, 6), 16),
    };
  }
  return fallback;
}

function smoothstep(edge0: number, edge1: number, value: number) {
  const t = clamp((value - edge0) / Math.max(0.0001, edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function normalizeObjectFit(value: unknown): "cover" | "contain" {
  return String(value || "cover").toLowerCase() === "contain" ? "contain" : "cover";
}

function createBlobUrlFromBase64(value: unknown, mimeType: unknown): string {
  const base64 = String(value || "").trim();
  if (!base64) return "";
  try {
    const binary = atob(base64);
    const chunks: BlobPart[] = [];
    const chunkSize = 32_768;
    for (let offset = 0; offset < binary.length; offset += chunkSize) {
      const slice = binary.slice(offset, offset + chunkSize);
      const bytes = new Uint8Array(slice.length);
      for (let index = 0; index < slice.length; index += 1) bytes[index] = slice.charCodeAt(index);
      chunks.push((bytes.buffer as ArrayBuffer).slice(0));
    }
    return URL.createObjectURL(
      new Blob(chunks, { type: String(mimeType || "video/mp4") || "video/mp4" }),
    );
  } catch (error) {
    console.warn("[meeting-avatar-video] failed to create inline video blob", error);
    return "";
  }
}

function normalizeChromaKeyConfig(config: Record<string, any>): VideoChromaKeyConfig {
  const raw = config.videoChromaKey || {};
  return {
    enabled: Boolean(raw.enabled),
    keyColor: parseColor(raw.keyColor || raw.color || "#00ff00", { r: 0, g: 255, b: 0 }),
    similarity: clamp(raw.similarity ?? 0.22, 0.01, 0.8),
    smoothness: clamp(raw.smoothness ?? 0.06, 0.001, 0.4),
    minGreen: clamp(raw.minGreen ?? 45, 0, 255),
    minDominance: clamp(raw.minDominance ?? 18, 0, 255),
    spill: clamp(raw.spill ?? 0.78, 0, 1),
    spillSoftness: clamp(raw.spillSoftness ?? 10, 0, 80),
    matteErodePx: Math.round(clamp(raw.matteErodePx ?? 1, 0, 3)),
    matteFeatherPx: Math.round(clamp(raw.matteFeatherPx ?? 1, 0, 3)),
  };
}

function normalizeVideoSources(config: Record<string, any>): VideoAvatarSource[] {
  const sources: VideoAvatarSource[] = [];
  const seen = new Set<string>();
  const addSource = (source: Record<string, any> | undefined, fallbackState?: string) => {
    const url =
      String(source?.url || "").trim() ||
      createBlobUrlFromBase64(source?.inlineBase64, source?.mimeType);
    if (!url || seen.has(url)) return;
    const state = String(source?.state || fallbackState || source?.action || "idle")
      .toLowerCase()
      .includes("speak")
      ? "speaking"
      : "idle";
    seen.add(url);
    sources.push({
      id: String(source?.id || state),
      label: String(source?.label || state),
      url,
      state,
      objectFit: normalizeObjectFit(source?.objectFit || config.videoObjectFit),
      background: String(source?.background || config.background),
      default: Boolean(source?.default),
    });
  };
  for (const source of Array.isArray(config.videoSources) ? config.videoSources : []) {
    addSource(source, undefined);
  }
  addSource({ id: "idle", label: "Idle", url: config.videoIdleUrl }, "idle");
  addSource({ id: "speaking", label: "Speaking", url: config.videoSpeakingUrl }, "speaking");
  return sources;
}

function erodeAlpha(source: PixelData, width: number, height: number, radius: number) {
  if (radius <= 0) return source;
  const next = new Uint8ClampedArray(source);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let min = 255;
      for (let yy = Math.max(0, y - radius); yy <= Math.min(height - 1, y + radius); yy += 1) {
        const row = yy * width;
        for (let xx = Math.max(0, x - radius); xx <= Math.min(width - 1, x + radius); xx += 1) {
          const value = source[(row + xx) * 4 + 3] || 0;
          if (value < min) min = value;
        }
      }
      next[(y * width + x) * 4 + 3] = min;
    }
  }
  return next;
}

function featherAlpha(source: PixelData, width: number, height: number, radius: number) {
  if (radius <= 0) return source;
  const next = new Uint8ClampedArray(source);
  const diameter = radius * 2 + 1;
  const maxSamples = diameter * diameter;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      let count = 0;
      for (let yy = Math.max(0, y - radius); yy <= Math.min(height - 1, y + radius); yy += 1) {
        const row = yy * width;
        for (let xx = Math.max(0, x - radius); xx <= Math.min(width - 1, x + radius); xx += 1) {
          sum += source[(row + xx) * 4 + 3] || 0;
          count += 1;
        }
      }
      next[(y * width + x) * 4 + 3] = Math.round(sum / Math.max(1, Math.min(maxSamples, count)));
    }
  }
  return next;
}

function applyChromaKey(
  image: ImageData,
  chroma: VideoChromaKeyConfig,
  rendererState: Record<string, any>,
) {
  const { data, width, height } = image;
  const { keyColor } = chroma;
  const maxDistance = Math.sqrt(255 * 255 * 3);
  let transparentPixels = 0;
  let edgePixels = 0;

  for (let index = 0; index < data.length; index += 4) {
    const r = data[index] || 0;
    const g = data[index + 1] || 0;
    const b = data[index + 2] || 0;
    const distance =
      Math.sqrt((r - keyColor.r) ** 2 + (g - keyColor.g) ** 2 + (b - keyColor.b) ** 2) /
      maxDistance;
    const dominance = g - Math.max(r, b);
    const isGreenish = g >= chroma.minGreen && dominance >= chroma.minDominance;
    const distanceAlpha = smoothstep(
      chroma.similarity,
      chroma.similarity + chroma.smoothness,
      distance,
    );
    const dominanceAlpha = isGreenish
      ? smoothstep(chroma.minDominance, chroma.minDominance + chroma.spillSoftness, dominance)
      : 0;
    const alpha = isGreenish ? Math.min(distanceAlpha, 1 - dominanceAlpha) : 1;
    const nextAlpha = Math.round(255 * clamp(alpha, 0, 1));
    data[index + 3] = nextAlpha;
    if (nextAlpha < 12) transparentPixels += 1;
    else if (nextAlpha < 245) edgePixels += 1;

    if (isGreenish) {
      const neutralGreen = Math.max(r, b) + 4;
      const despillAmount = chroma.spill * clamp((dominance - chroma.minDominance) / 80, 0, 1);
      data[index + 1] = Math.round(g + (Math.min(g, neutralGreen) - g) * despillAmount);
    }
  }

  if (chroma.matteErodePx > 0 || chroma.matteFeatherPx > 0) {
    let alphaData: PixelData = new Uint8ClampedArray(data);
    alphaData = erodeAlpha(alphaData, width, height, chroma.matteErodePx);
    alphaData = featherAlpha(alphaData, width, height, chroma.matteFeatherPx);
    for (let index = 3; index < data.length; index += 4) {
      data[index] = alphaData[index] || 0;
    }
  }

  transparentPixels = 0;
  edgePixels = 0;
  for (let index = 3; index < data.length; index += 4) {
    const alpha = data[index] || 0;
    if (alpha < 12) transparentPixels += 1;
    else if (alpha < 245) edgePixels += 1;
  }

  const pixels = Math.max(1, width * height);
  rendererState.videoChromaTransparentRatio = Number((transparentPixels / pixels).toFixed(4));
  rendererState.videoChromaEdgeRatio = Number((edgePixels / pixels).toFixed(4));
  return image;
}

function drawVideoFrame(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  source: VideoAvatarSource,
  alpha: number,
  config: Record<string, any>,
  chroma: VideoChromaKeyConfig,
  scratch: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D },
  rendererState: Record<string, any>,
) {
  if (!video || video.readyState < 2) return false;
  const canvasW = Number(config.canvasWidth);
  const canvasH = Number(config.canvasHeight);
  const videoW = video.videoWidth || canvasW;
  const videoH = video.videoHeight || canvasH;
  const scale =
    source.objectFit === "contain"
      ? Math.min(canvasW / videoW, canvasH / videoH)
      : Math.max(canvasW / videoW, canvasH / videoH);
  const drawW = videoW * scale;
  const drawH = videoH * scale;
  const dx = (canvasW - drawW) / 2;
  const dy = (canvasH - drawH) / 2;
  ctx.save();
  ctx.globalAlpha = clamp(alpha, 0, 1);
  if (chroma.enabled) {
    if (scratch.canvas.width !== canvasW) scratch.canvas.width = canvasW;
    if (scratch.canvas.height !== canvasH) scratch.canvas.height = canvasH;
    scratch.ctx.clearRect(0, 0, canvasW, canvasH);
    scratch.ctx.drawImage(video, dx, dy, drawW, drawH);
    const image = scratch.ctx.getImageData(0, 0, canvasW, canvasH);
    scratch.ctx.putImageData(applyChromaKey(image, chroma, rendererState), 0, 0);
    ctx.drawImage(scratch.canvas, 0, 0);
  } else {
    ctx.drawImage(video, dx, dy, drawW, drawH);
  }
  ctx.restore();
  return true;
}

function createVideoElement(source: VideoAvatarSource, config: Record<string, any>) {
  const video = document.createElement("video");
  video.src = source.url;
  video.muted = config.videoMuted !== false;
  video.loop = true;
  video.autoplay = true;
  video.playsInline = true;
  video.preload = "auto";
  video.crossOrigin = "anonymous";
  video.style.cssText =
    "position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;opacity:0;pointer-events:none;";
  document.documentElement.appendChild(video);
  return video;
}

async function loadVideoElement(video: HTMLVideoElement, source: VideoAvatarSource) {
  await new Promise((resolve, reject) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(true);
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`video avatar source failed: ${source.label || source.url}`));
    };
    const cleanup = () => {
      video.removeEventListener("canplay", done);
      video.removeEventListener("loadeddata", done);
      video.removeEventListener("error", fail);
    };
    video.addEventListener("canplay", done, { once: true });
    video.addEventListener("loadeddata", done, { once: true });
    video.addEventListener("error", fail, { once: true });
    video.load();
    if (video.readyState >= 2) done();
  });
  await video.play().catch(() => undefined);
  return video;
}

export async function createVideoAvatarRenderer(
  canvas: HTMLCanvasElement,
  { config, avatarController, rendererState, drawFallback }: VideoRendererOptions,
) {
  const sources = normalizeVideoSources(config);
  const idleSource = sources.find((source) => source.state === "idle") || sources[0];
  const speakingSource =
    sources.find((source) => source.state === "speaking") ||
    sources.find((source) => source.default) ||
    idleSource;
  if (!idleSource?.url) throw new Error("video avatar has no idle source");

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("video avatar canvas context unavailable");
  const scratchCanvas = document.createElement("canvas");
  const scratchCtx = scratchCanvas.getContext("2d", { willReadFrequently: true });
  if (!scratchCtx) throw new Error("video avatar chroma-key canvas context unavailable");
  const scratch = { canvas: scratchCanvas, ctx: scratchCtx };
  const chroma = normalizeChromaKeyConfig(config);
  const idleVideo = createVideoElement(idleSource, config);
  const speakingVideo =
    speakingSource.url === idleSource.url ? idleVideo : createVideoElement(speakingSource, config);
  await Promise.all([
    loadVideoElement(idleVideo, idleSource),
    speakingVideo === idleVideo
      ? Promise.resolve(idleVideo)
      : loadVideoElement(speakingVideo, speakingSource),
  ]);

  const videoByState = {
    idle: idleVideo,
    speaking: speakingVideo,
  };
  const sourceByState = { idle: idleSource, speaking: speakingSource };
  const crossfadeMs = Math.max(0, Number(config.videoCrossfadeMs ?? 220));
  const debounceMs = Math.max(0, Number(config.videoSpeakingDebounceMs ?? 180));
  let currentState: "idle" | "speaking" = "idle";
  let previousState: "idle" | "speaking" = "idle";
  let transitionStartedAt = performance.now();
  let lastSpeakingAt = -Infinity;
  let lastRenderedAt = -Infinity;

  Object.assign(rendererState, {
    renderer: "video",
    live2dLoaded: false,
    vrmLoaded: false,
    videoLoaded: true,
    videoSources: sources.map(({ id, label, url, state }) => ({ id, label, url, state })),
    videoState: currentState,
    fallbackReason: "",
    layout: config.layout,
    videoChromaKeyed: chroma.enabled,
  });

  function updateTargetState(now: number) {
    const mouthLevel = window.MAB_AVATAR_AUDIO_BUS?.getMouthLevel?.() || 0;
    const explicitSpeak = avatarController.state.action === "speak";
    if (explicitSpeak || mouthLevel > 0.015) lastSpeakingAt = now;
    const nextState = now - lastSpeakingAt <= debounceMs ? "speaking" : "idle";
    rendererState.videoMouthLevel = Number(mouthLevel.toFixed(4));
    if (nextState !== currentState) {
      previousState = currentState;
      currentState = nextState;
      transitionStartedAt = now;
    }
    rendererState.videoState = currentState;
  }

  function tick(now: number) {
    const targetFps = Math.max(1, Number(config.captureFps || 24));
    const minFrameMs = 1000 / targetFps;
    if (now - lastRenderedAt < minFrameMs * 0.9) {
      requestAnimationFrame(tick);
      return;
    }
    lastRenderedAt = now;
    updateTargetState(now);
    const background = sourceByState[currentState]?.background || sourceByState.idle.background;
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, Number(config.canvasWidth), Number(config.canvasHeight));
    const fade = crossfadeMs <= 0 ? 1 : clamp((now - transitionStartedAt) / crossfadeMs, 0, 1);
    if (fade < 1 && previousState !== currentState) {
      drawVideoFrame(
        ctx,
        videoByState[previousState],
        sourceByState[previousState],
        1 - fade,
        config,
        chroma,
        scratch,
        rendererState,
      );
    }
    const drew = drawVideoFrame(
      ctx,
      videoByState[currentState],
      sourceByState[currentState],
      fade,
      config,
      chroma,
      scratch,
      rendererState,
    );
    if (!drew) drawFallback(ctx, now);
    rendererState.videoFrames += 1;
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}
