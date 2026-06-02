export function drawVideoHoldFrame(ctx: CanvasRenderingContext2D, config: Record<string, any>) {
  ctx.fillStyle = String(config.background || "#0b1018");
  ctx.fillRect(0, 0, Number(config.canvasWidth), Number(config.canvasHeight));
}

export function drawVideoBootFrame(
  ctx: CanvasRenderingContext2D,
  config: Record<string, any>,
  drawFallback: (ctx: CanvasRenderingContext2D, t?: number) => void,
  t = 0,
) {
  if (String(config.avatarRenderer || "live2d").toLowerCase() === "video") {
    drawVideoHoldFrame(ctx, config);
    return;
  }
  drawFallback(ctx, t);
}

export function startVideoHoldLoop(
  ctx: CanvasRenderingContext2D | null,
  config: Record<string, any>,
  rendererState: Record<string, any>,
) {
  const drawHold = () => {
    if (ctx) drawVideoHoldFrame(ctx, config);
    rendererState.videoHoldFrames += 1;
    requestAnimationFrame(drawHold);
  };
  requestAnimationFrame(drawHold);
}

export function startSuppressedVideoHoldRenderer(
  ctx: CanvasRenderingContext2D | null,
  config: Record<string, any>,
  rendererState: Record<string, any>,
  patch: Record<string, any> = {},
) {
  Object.assign(
    rendererState,
    {
      renderer: "video",
      live2dLoaded: false,
      vrmLoaded: false,
      videoLoaded: false,
      fallbackReason: "",
      videoFallbackFrames: 0,
      videoFallbackSuppressed: true,
      videoHoldFrames: 0,
    },
    patch,
  );
  startVideoHoldLoop(ctx, config, rendererState);
}
