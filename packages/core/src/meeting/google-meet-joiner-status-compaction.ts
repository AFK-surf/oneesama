const JOIN_STATUS_TAIL_LIMIT = 20;
const JOIN_STATUS_STRING_LIMIT = 800;
const JOIN_STATUS_OBJECT_KEY_LIMIT = 60;
const JOIN_STATUS_DEPTH_LIMIT = 4;
const JOIN_STATUS_CRITICAL_KEYS = [
  "id",
  "jobId",
  "job_id",
  "callId",
  "call_id",
  "type",
  "name",
  "ok",
  "status",
  "blocker",
  "error",
  "reason",
  "summary",
  "provider",
  "mode",
  "source",
  "createdAt",
  "created_at",
  "startedAt",
  "started_at",
  "updatedAt",
  "updated_at",
  "finishedAt",
  "finished_at",
];

export function compactJoinStatusRealtimeBridge(realtimeBridge) {
  const compact = shallowObjectCopy(realtimeBridge);
  if (!compact) return realtimeBridge || null;
  tailArrayProperty(compact, "inbound");
  tailArrayProperty(compact, "outbound");
  tailArrayProperty(compact, "timeline");
  tailArrayProperty(compact, "workerResults");
  tailArrayProperty(compact, "meetingEvents");
  tailArrayProperty(compact, "errors");
  compact.connection = compactJoinStatusConnection(compact.connection);
  compact.contextHealth = compactJoinStatusContextHealth(compact.contextHealth);
  compact.turnPolicy = compactJoinStatusTurnPolicy(compact.turnPolicy);
  compact.avatarTools = compactJoinStatusToolBucket(compact.avatarTools);
  compact.workerTools = compactJoinStatusToolBucket(compact.workerTools);
  compact.meetTools = compactJoinStatusToolBucket(compact.meetTools);
  compact.workspaceTools = compactJoinStatusToolBucket(compact.workspaceTools);
  return compact;
}

export function compactJoinStatusWorkerResultBridge(workerResultBridge) {
  const compact = shallowObjectCopy(workerResultBridge);
  if (!compact) return workerResultBridge || null;
  tailArrayProperty(compact, "delivered");
  tailArrayProperty(compact, "errors");
  return compact;
}

export function compactJoinStatusActive(active, realtimeSidecarStatus = null) {
  if (!active) return null;
  return {
    sessionId: active.sessionId,
    meetUrl: active.meetUrl,
    startedAt: active.startedAt,
    meetProfileMode: active.meetProfileMode || "",
    browserUserDataDir: active.browserUserDataDir || "",
    realtimeRuntimePlacement: active.realtimeRuntimePlacement || "sidecar",
    realtimeSdkOwner: active.realtimeSdkOwner || "sidecar",
    realtimeSidecar: active.realtimeSidecarPage ? realtimeSidecarStatus : null,
    clickedJoinSelector: active.clickedJoinSelector || "",
    diagnosticsPath: active.diagnostics?.jsonPath || "",
    artifactsDir: active.artifactsDir || "",
    screenshots: active.diagnostics?.screenshots || [],
    avatarReady: active.avatarReady || null,
    avatarAudio: active.avatarAudio || null,
    recorder: active.recorder?.status() || null,
    realtimeAudioCapture: active.realtimeAudioCapture?.status() || null,
    realtimeRecappiAudioInput: active.realtimeRecappiAudioInput?.status() || null,
    captions: compactCaptionState(active.captions) || null,
    fixtureState: active.fixtureState || null,
    realtimeBridge: compactJoinStatusRealtimeBridge(active.realtimeBridge),
    workerResultBridge: compactJoinStatusWorkerResultBridge(active.workerResultBridge),
    localDialog: active.localDialog || null,
    screenShare: active.screenShare || null,
    meetPage: active.meetPage || null,
    meetingAwareness: active.meetingAwareness || null,
    meetingAwarenessPush: active.meetingAwarenessPush || null,
  };
}

export function compactCaptionState(captions) {
  if (!captions) return null;
  return {
    ok: captions.ok,
    count: captions.count,
    latest: captions.latest || null,
    paths: captions.paths || null,
    containerFound: Boolean(captions.browser?.containerFound),
    errors: captions.browser?.errors || [],
  };
}

function compactJoinStatusConnection(connection) {
  const compact = shallowObjectCopy(connection);
  if (!compact) return connection || null;
  tailArrayProperty(compact, "sentDataChannelMessages");
  return compact;
}

function compactJoinStatusContextHealth(contextHealth) {
  const compact = shallowObjectCopy(contextHealth);
  if (!compact) return contextHealth || null;
  tailArrayProperty(compact, "lastHistoryTail");
  return compact;
}

function compactJoinStatusTurnPolicy(turnPolicy) {
  const compact = shallowObjectCopy(turnPolicy);
  if (!compact) return turnPolicy || null;
  tailArrayProperty(compact, "decisions");
  tailArrayProperty(compact, "events");
  tailArrayProperty(compact, "manualFunctionalTurns");
  compact.appControlJobs = tailAppControlJobs(compact.appControlJobs);
  return compact;
}

function compactJoinStatusToolBucket(bucket) {
  const compact = shallowObjectCopy(bucket);
  if (!compact) return bucket || null;
  tailArrayProperty(compact, "calls");
  tailArrayProperty(compact, "errors");
  return compact;
}

function shallowObjectCopy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return { ...value };
}

function tailArrayProperty(record, key: string, limit = JOIN_STATUS_TAIL_LIMIT) {
  if (Array.isArray(record?.[key])) {
    record[key] = record[key].slice(-limit).map((entry) => compactJoinStatusPayload(entry));
  }
}

function tailAppControlJobs(value, limit = JOIN_STATUS_TAIL_LIMIT) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value || {};
  }
  const entries = Object.entries(value);
  const selected = new Set<string>();
  const importantEntries = entries
    .map(([key, entry]) => ({
      key,
      entry,
      priority: joinStatusAppControlJobPriority(entry),
      timeMs: joinStatusAppControlJobTimeMs(entry),
    }))
    .filter((entry) => entry.priority > 0)
    .sort((left, right) => {
      if (left.priority !== right.priority) return right.priority - left.priority;
      return right.timeMs - left.timeMs;
    });
  for (const { key } of importantEntries) {
    if (selected.size >= limit) break;
    selected.add(key);
  }
  for (const [key] of entries.slice().reverse()) {
    if (selected.size >= limit) break;
    selected.add(key);
  }
  return Object.fromEntries(
    entries
      .filter(([key]) => selected.has(key))
      .map(([key, entry]) => [key, compactJoinStatusPayload(entry)]),
  );
}

function joinStatusAppControlJobPriority(value) {
  const record = shallowObjectCopy(value);
  const status = String(record?.status || "")
    .trim()
    .toLowerCase();
  if (["blocked", "failed", "error", "timeout"].includes(status)) return 3;
  if (status === "stale") return 2;
  if (["accepted", "queued", "running", "started"].includes(status)) return 1;
  return 0;
}

function joinStatusAppControlJobTimeMs(value) {
  const record = shallowObjectCopy(value);
  const parsed = Date.parse(
    String(
      record?.updatedAt || record?.updated_at || record?.finishedAt || record?.finished_at || "",
    ),
  );
  if (Number.isFinite(parsed)) return parsed;
  const started = Date.parse(String(record?.startedAt || record?.started_at || ""));
  if (Number.isFinite(started)) return started;
  const created = Date.parse(String(record?.createdAt || record?.created_at || ""));
  return Number.isFinite(created) ? created : 0;
}

function compactJoinStatusPayload(value, depth = 0) {
  if (typeof value === "string") {
    return value.length > JOIN_STATUS_STRING_LIMIT
      ? `${value.slice(0, JOIN_STATUS_STRING_LIMIT)}...`
      : value;
  }
  if (value == null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .slice(-JOIN_STATUS_TAIL_LIMIT)
      .map((entry) => compactJoinStatusPayload(entry, depth + 1));
  }
  if (depth >= JOIN_STATUS_DEPTH_LIMIT) {
    return compactJoinStatusTerminalObject(value);
  }
  return Object.fromEntries(
    prioritizedJoinStatusEntries(value)
      .slice(0, JOIN_STATUS_OBJECT_KEY_LIMIT)
      .map(([key, entry]) => [key, compactJoinStatusPayload(entry, depth + 1)]),
  );
}

function prioritizedJoinStatusEntries(value) {
  const entries = Object.entries(value);
  const critical = new Set(JOIN_STATUS_CRITICAL_KEYS);
  return [
    ...JOIN_STATUS_CRITICAL_KEYS.flatMap((key) =>
      Object.hasOwn(value, key) ? [[key, value[key]]] : [],
    ),
    ...entries.filter(([key]) => !critical.has(key)),
  ];
}

function compactJoinStatusTerminalObject(value) {
  const compact = Object.fromEntries(
    JOIN_STATUS_CRITICAL_KEYS.flatMap((key) => {
      if (!Object.hasOwn(value, key)) return [];
      const entry = value[key];
      if (entry == null || typeof entry !== "object") {
        return [[key, compactJoinStatusPayload(entry, JOIN_STATUS_DEPTH_LIMIT + 1)]];
      }
      return [[key, "[compact-object]"]];
    }),
  );
  return Object.keys(compact).length > 0 ? compact : "[compact-object]";
}
