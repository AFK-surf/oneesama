function normalizeRealtimeAgentRuntime(value: unknown) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function isRealtimeSidecarUrl(value: unknown) {
  try {
    return new URL(String(value || "")).pathname.startsWith("/realtime-sidecar/");
  } catch {
    return false;
  }
}

export async function collectRealtimeSidecarPageStatus(activeSession: any) {
  const managedPage = activeSession?.realtimeSidecarPage || null;
  const managedPageActive = managedPage ? !managedPage.isClosed?.() : false;
  const managedPageUrl = managedPage?.url?.() || "";
  const serverUrl = activeSession?.realtimeSidecarServer?.url || "";
  const pages =
    typeof activeSession?.context?.pages === "function" ? activeSession.context.pages() : [];
  let scannedPageCount = 0;
  let sidecarPageCount = 0;
  let sdkOwnerPageCount = 0;
  const seenUrls = new Set<string>();

  for (const page of pages) {
    if (!page || page.isClosed?.()) continue;
    scannedPageCount += 1;
    const pageUrl = page.url?.() || "";
    const probe = await page
      .evaluate(() => {
        const realtimeBridge = (window as any).MAB_REALTIME_BRIDGE || {};
        const realtimeClient = (window as any).MAB_REALTIME_CLIENT || {};
        return {
          hasSidecarMarker: Boolean((window as any).MAB_REALTIME_SIDECAR_PAGE),
          pageRole: String(
            realtimeBridge.realtimePageRole ||
              realtimeBridge.pageRole ||
              realtimeClient.realtimePageRole ||
              realtimeClient.pageRole ||
              "",
          ),
          sdkOwner: String(realtimeBridge.sdkOwner || realtimeClient.sdkOwner || ""),
        };
      })
      .catch(() => null);
    const pageIsSidecar =
      probe?.hasSidecarMarker === true ||
      probe?.pageRole === "sidecar" ||
      isRealtimeSidecarUrl(pageUrl) ||
      Boolean(serverUrl && pageUrl === serverUrl);
    if (!pageIsSidecar) continue;
    seenUrls.add(pageUrl);
    sidecarPageCount += 1;
    if (probe?.sdkOwner === "sidecar") {
      sdkOwnerPageCount += 1;
    }
  }

  if (managedPageActive && sidecarPageCount === 0) {
    sidecarPageCount = 1;
    if (managedPageUrl) seenUrls.add(managedPageUrl);
    if (activeSession?.realtimeSdkOwner === "sidecar") {
      sdkOwnerPageCount = 1;
    }
  }

  return {
    active: managedPageActive,
    url: managedPageUrl,
    serverUrl,
    sdkOwner: "sidecar",
    pageCount: sidecarPageCount,
    sdkOwnerPageCount,
    scannedPageCount,
    urls: Array.from(seenUrls).slice(0, 5),
  };
}

export function mergeMeetSurfaceAudioOutputState(realtimeBridge: any, meetSurfaceBridge: any) {
  if (!realtimeBridge || !meetSurfaceBridge || realtimeBridge === meetSurfaceBridge) {
    return realtimeBridge;
  }
  const surfaceConnection = meetSurfaceBridge.connection || {};
  if (surfaceConnection.meetSurfaceAudioOutputHookInstalled !== true) return realtimeBridge;
  const connection = {
    ...realtimeBridge.connection,
  };
  for (const key of [
    "meetSurfaceAudioOutputHookInstalled",
    "meetSurfaceAudioOutputHookStatus",
    "meetSurfaceAudioOutputLastScanAt",
    "meetSurfaceAudioOutputLastCandidateAt",
    "meetOutboundAudioSenderCandidates",
    "primaryMeetAudioSenderTrackId",
    "primaryMeetAudioSenderUsingAvatarBus",
    "primaryMeetAudioSenderStats",
    "primaryMeetAudioSenderAttachAttempts",
    "lastPrimaryMeetAudioAttachAt",
    "lastPrimaryMeetAudioAttachError",
  ]) {
    if (surfaceConnection[key] !== undefined) connection[key] = surfaceConnection[key];
  }
  const sidecarTimeline = Array.isArray(realtimeBridge.timeline) ? realtimeBridge.timeline : [];
  const surfaceTimeline = Array.isArray(meetSurfaceBridge.timeline)
    ? meetSurfaceBridge.timeline
    : [];
  return {
    ...realtimeBridge,
    connection,
    meetSurfaceBridge: {
      ok: meetSurfaceBridge.ok,
      runtimePlacement: meetSurfaceBridge.runtimePlacement || "",
      pageRole: meetSurfaceBridge.pageRole || "",
      sdkOwner: meetSurfaceBridge.sdkOwner || "",
      connection: surfaceConnection,
      timelineTail: surfaceTimeline.slice(-20),
    },
    timeline: [...sidecarTimeline, ...surfaceTimeline].slice(-80),
  };
}

export function defaultRealtimeBridgeModeForRuntime(runtime: unknown) {
  const normalized = normalizeRealtimeAgentRuntime(runtime);
  if (["agents-sdk", "openai-agents", "openai-agents-sdk"].includes(normalized)) {
    return "agents-sdk";
  }
  return "mock";
}

function isGoogleMeetPageUrl(value: string) {
  return /^https:\/\/meet\.google\.com\//i.test(String(value || "").trim());
}

export function assertRealtimeRuntimePlacementForMeetJoin({
  installRealtimeBridge,
  realtimeRuntimePlacement,
  meetUrl,
}: {
  installRealtimeBridge: boolean;
  realtimeRuntimePlacement: string;
  meetUrl: string;
}) {
  if (
    installRealtimeBridge &&
    realtimeRuntimePlacement === "inline" &&
    isGoogleMeetPageUrl(meetUrl)
  ) {
    throw new Error(
      "inline Realtime SDK on Meet has been removed; use realtimeRuntimePlacement=sidecar",
    );
  }
}
