import { buildRealtimeBrowserInitScript } from "../realtime/realtime-browser-init-builder.ts";
import { buildWorkerResultInitScript } from "../realtime/worker-result-init-builder.ts";
import {
  installPageDiagnostics,
  startLocalRealtimeSidecarServer,
} from "./google-meet-joiner-base.ts";

export async function startRealtimeSidecarPage({
  context,
  diagnostics,
  getMeetPage,
  realtimeBridgeConfig,
  sessionId,
  workerResultConfig = null,
}) {
  const server = await startLocalRealtimeSidecarServer({ sessionId });
  let page;
  try {
    page = await context.newPage();
    installPageDiagnostics(page, diagnostics);

    await page.exposeFunction("MAB_HOST_ENQUEUE_REALTIME_PCM", async (payload) => {
      const targetPage = getMeetPage();
      if (!targetPage || targetPage.isClosed?.()) {
        return { ok: false, error: "meet_page_missing_for_realtime_output_audio" };
      }
      const result = await targetPage
        .evaluate((chunk) => {
          const bus = window.MAB_AVATAR_AUDIO_BUS;
          if (typeof bus?.enqueuePcmFrames !== "function") {
            return { ok: false, error: "avatar_audio_bus_pcm_enqueue_missing" };
          }
          return bus.enqueuePcmFrames(chunk);
        }, payload)
        .catch((error) => ({ ok: false, error: String(error?.message || error) }));
      diagnostics.record("realtime_sidecar_output_pcm_enqueue", {
        ok: result?.ok === true,
        samples: Array.isArray(payload?.samples) ? payload.samples.length : 0,
        sampleRate: payload?.sampleRate || 0,
        channels: payload?.channels || 0,
        error: result?.ok === false ? result?.error || result?.reason || "" : "",
      });
      return result;
    });

    await page.exposeFunction("MAB_HOST_RUN_SURFACE_TOOL", async (payload) => {
      const payloadSessionId = String(payload?.sessionId || "");
      if (payloadSessionId !== String(sessionId || "")) {
        diagnostics.record("realtime_sidecar_surface_tool", {
          ok: false,
          name: payload?.name || "",
          callId: payload?.callId || "",
          responseId: payload?.responseId || "",
          sessionId: payloadSessionId,
          expectedSessionId: String(sessionId || ""),
          error: "realtime_sidecar_session_mismatch",
        });
        return { ok: false, error: "realtime_sidecar_session_mismatch" };
      }
      const targetPage = getMeetPage();
      if (!targetPage || targetPage.isClosed?.()) {
        return { ok: false, error: "meet_page_missing_for_surface_tool" };
      }
      const result = await targetPage
        .evaluate(async (request) => {
          const tools = window.MAB_MEET_SURFACE_TOOLS;
          if (typeof tools?.run !== "function") {
            return { ok: false, error: "meet_surface_tool_port_missing" };
          }
          return await tools.run(request?.name || "", request?.args || {});
        }, payload)
        .catch((error) => ({ ok: false, error: String(error?.message || error) }));
      diagnostics.record("realtime_sidecar_surface_tool", {
        ok: result?.ok === true,
        name: payload?.name || "",
        callId: payload?.callId || "",
        responseId: payload?.responseId || "",
        error: result?.ok === false ? result?.error || result?.reason || "" : "",
      });
      return result;
    });

    await page.exposeFunction("MAB_HOST_UPDATE_AVATAR_HUD", async (payload) => {
      const targetPage = getMeetPage();
      if (!targetPage || targetPage.isClosed?.()) {
        return { ok: false, error: "meet_page_missing_for_avatar_hud" };
      }
      const update = {
        mood: payload?.mood,
        action: payload?.action,
        status_kind: payload?.statusKind || payload?.status_kind || payload?.kind || "thinking",
        status_text: payload?.statusText || payload?.status_text || payload?.text || "",
        status_hold_ms:
          payload?.holdMs || payload?.statusHoldMs || payload?.status_hold_ms || undefined,
      };
      const result = await targetPage
        .evaluate((hudUpdate) => {
          const controller = window.MAB_AVATAR_CONTROLLER;
          if (typeof controller?.updateState !== "function") {
            return { ok: false, error: "avatar_controller_missing" };
          }
          return controller.updateState(hudUpdate);
        }, update)
        .catch((error) => ({ ok: false, error: String(error?.message || error) }));
      diagnostics.record("realtime_sidecar_avatar_hud", {
        ok: result?.ok === true,
        statusKind: update.status_kind,
        statusText: String(update.status_text || "").slice(0, 80),
        error: result?.ok === false ? result?.error || result?.reason || "" : "",
      });
      return result;
    });

    await page.exposeFunction("MAB_HOST_UPDATE_KWWK_CURSOR_FEEDBACK", async (payload) => {
      const targetPage = getMeetPage();
      if (!targetPage || targetPage.isClosed?.()) {
        return { ok: false, error: "meet_page_missing_for_kwwk_cursor_feedback" };
      }
      const update = {
        kind: payload?.kind || "move",
        label: payload?.label || "",
        x: Number(payload?.x || 0.5),
        y: Number(payload?.y || 0.52),
        holdMs: payload?.holdMs || payload?.hold_ms || undefined,
      };
      const result = await targetPage
        .evaluate((cursorUpdate) => {
          const updateCursor = (window as any).MAB_KWWK_CURSOR_FEEDBACK;
          if (typeof updateCursor !== "function") {
            return { ok: false, error: "kwwk_cursor_feedback_missing" };
          }
          return updateCursor(cursorUpdate);
        }, update)
        .catch((error) => ({ ok: false, error: String(error?.message || error) }));
      diagnostics.record("realtime_sidecar_kwwk_cursor_feedback", {
        ok: result?.visible === true || result?.ok === true,
        kind: update.kind,
        label: String(update.label || "").slice(0, 80),
        x: update.x,
        y: update.y,
        error: result?.ok === false ? result?.error || result?.reason || "" : "",
      });
      return result?.visible === true ? { ok: true, snapshot: result } : result;
    });

    let inputPcmChunksForwarded = 0;
    await context.exposeBinding("MAB_HOST_FORWARD_MEET_AUDIO_PCM", async (_source, payload) => {
      const payloadSessionId = String(payload?.sessionId || "");
      if (payloadSessionId !== String(sessionId || "")) {
        diagnostics.record("realtime_sidecar_input_pcm_forward", {
          ok: false,
          chunk: inputPcmChunksForwarded,
          source: payload?.source || "",
          label: payload?.label || "",
          sessionId: payloadSessionId,
          expectedSessionId: String(sessionId || ""),
          error: "realtime_sidecar_session_mismatch",
        });
        return { ok: false, error: "realtime_sidecar_session_mismatch" };
      }
      const samples = Array.isArray(payload?.samples) ? payload.samples.length : 0;
      const result = await page
        .evaluate((chunk) => {
          const client = window.MAB_REALTIME_CLIENT;
          if (typeof client?.pushHostMeetAudioSamples !== "function") {
            return { ok: false, error: "sidecar_host_meet_audio_input_missing" };
          }
          return client.pushHostMeetAudioSamples(chunk);
        }, payload)
        .catch((error) => ({ ok: false, error: String(error?.message || error) }));
      inputPcmChunksForwarded += 1;
      const shouldRecord =
        result?.ok !== true || inputPcmChunksForwarded <= 5 || inputPcmChunksForwarded % 50 === 0;
      if (shouldRecord) {
        diagnostics.record("realtime_sidecar_input_pcm_forward", {
          ok: result?.ok === true,
          chunk: inputPcmChunksForwarded,
          source: payload?.source || "",
          label: payload?.label || "",
          samples,
          sampleRate: payload?.sampleRate || 0,
          channels: payload?.channels || 0,
          error: result?.ok === false ? result?.error || result?.reason || "" : "",
        });
      }
      return result;
    });

    await page.addInitScript({
      content: buildRealtimeBrowserInitScript({
        ...realtimeBridgeConfig,
        realtimeRuntimePlacement: "sidecar",
        realtimePageRole: "sidecar",
      }),
    });
    if (workerResultConfig?.enabled !== false && workerResultConfig?.workerPollUrl) {
      await page.addInitScript({
        content: buildWorkerResultInitScript(workerResultConfig),
      });
    }
    diagnostics.record("realtime_sidecar_page_start", {
      url: server.url,
      port: server.port,
      sdkOwner: "sidecar",
      workerResultBridge: Boolean(
        workerResultConfig?.enabled !== false && workerResultConfig?.workerPollUrl,
      ),
    });
    await page.goto(server.url, {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    });
    return { page, server };
  } catch (error) {
    await page?.close?.().catch(() => {});
    server.stop();
    throw error;
  }
}
