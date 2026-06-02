import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { createWorkerReportStore } from "../packages/core/src/realtime/worker-report-store.ts";

test("worker report store suppresses meeting realtime jobs without session provenance", () => {
  const reports = createWorkerReportStore();
  const job = reports.create({
    id: "job_missing_meeting_session",
    status: "completed",
    task: "finish app control",
    result: "done",
    context: {
      session_kind: "meeting_app_control",
    },
  });

  const ready = reports.pollReadyForRealtime({
    sessionId: "current_meeting_session",
    markDelivered: false,
  });
  const stored = reports.get(job.id);

  assert.deepEqual(ready, []);
  assert.equal(stored.deliveredToRealtime, false);
  assert.equal(stored.realtimeSuppressed, true);
  assert.equal(stored.realtimeDelivery.channel, "realtime_session_missing_suppressed");
  assert.equal(stored.realtimeDelivery.reason, "worker_result_session_missing");
  assert.equal(stored.realtimeDeliveryAttempt, null);
});

test("worker report store prepares delivery attempts for matching meeting realtime jobs", () => {
  const reports = createWorkerReportStore();
  reports.create({
    id: "job_matching_meeting_session",
    status: "completed",
    task: "finish app control",
    result: "done",
    context: {
      session_kind: "meeting_app_control",
      meeting_session_id: "current_meeting_session",
    },
  });

  const ready = reports.pollReadyForRealtime({
    sessionId: "current_meeting_session",
    markDelivered: false,
  });

  assert.equal(ready.length, 1);
  assert.equal(ready[0].deliveredToRealtime, false);
  assert.equal(ready[0].realtimeSuppressed, false);
  assert.equal(typeof ready[0].realtimeDeliveryAttempt.token, "string");
  assert.ok(ready[0].realtimeDeliveryAttempt.token);
});
