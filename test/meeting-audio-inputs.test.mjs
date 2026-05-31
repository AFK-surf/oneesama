import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { isRecappiAudioTapAvailable } from "../packages/core/src/audio/recappi-audio-tap.ts";
import {
  createMeetingAudioInputs,
  isGoogleMeetUrlForRealtimeAudio,
  shouldUseRecappiRealtimeAudioInput,
} from "../packages/core/src/meeting/meeting-audio-inputs.ts";

test("Recappi realtime input is allowed for a real Google Meet URL", () => {
  assert.equal(isGoogleMeetUrlForRealtimeAudio("https://meet.google.com/oyw-ixnm-nog"), true);
  assert.equal(
    shouldUseRecappiRealtimeAudioInput({
      platform: "darwin",
      meetUrl: "https://meet.google.com/oyw-ixnm-nog",
      realtimeWantsMeetAudio: true,
      recorderBackend: "recappi",
      recappiTapAvailable: true,
    }),
    true,
  );
});

test("Recappi realtime input stays off for non-Google fixtures", () => {
  assert.equal(isGoogleMeetUrlForRealtimeAudio("http://127.0.0.1:4173/fixture"), false);
  assert.equal(
    shouldUseRecappiRealtimeAudioInput({
      platform: "darwin",
      meetUrl: "http://127.0.0.1:4173/fixture",
      realtimeWantsMeetAudio: true,
      recorderBackend: "recappi",
      recappiTapAvailable: true,
    }),
    false,
  );
});

test("Recappi tap availability requires an installed package or explicit SDK path", async () => {
  const root = await mkdtemp(join(tmpdir(), "oneesama-recappi-sdk-"));
  const sdkPath = join(root, "fake-recappi-sdk.cjs");
  try {
    assert.equal(isRecappiAudioTapAvailable({ recappiSdkPath: join(root, "missing.cjs") }), false);
    await writeFile(sdkPath, "module.exports = { ShareableContent: {} };\n");
    assert.equal(isRecappiAudioTapAvailable({ recappiSdkPath: sdkPath }), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("permissive runner mode still uses Recappi realtime input for real Meet URLs", () => {
  const result = createMeetingAudioInputs({
    input: {
      allowNonGoogleMeet: true,
      includeParticipantAudio: true,
      forwardMeetAudioToRealtime: true,
      meetAudioBackend: "recappi",
    },
    config: { meetAudioBackend: "recappi" },
    sessionId: "session_test",
    artifactsDir: "/tmp/session_test",
    meetUrl: "https://meet.google.com/oyw-ixnm-nog",
    installRealtimeBridge: true,
    recordMeeting: true,
  });

  if (process.platform === "darwin" && isRecappiAudioTapAvailable()) {
    assert.ok(result.realtimeRecappiAudioInput, "real Google Meet joins should get Recappi input");
    assert.equal(result.realtimeAudioCapture, null);
  } else {
    assert.equal(result.realtimeRecappiAudioInput, null);
    assert.ok(result.realtimeAudioCapture, "missing Recappi SDK should fall back to WebRTC capture");
  }
});

test("permissive fixture mode keeps Recappi realtime input disabled off Google Meet", () => {
  const result = createMeetingAudioInputs({
    input: {
      allowNonGoogleMeet: true,
      includeParticipantAudio: true,
      forwardMeetAudioToRealtime: true,
      meetAudioBackend: "recappi",
    },
    config: { meetAudioBackend: "recappi" },
    sessionId: "session_fixture",
    artifactsDir: "/tmp/session_fixture",
    meetUrl: "http://127.0.0.1:4173/fixture",
    installRealtimeBridge: true,
    recordMeeting: true,
  });

  assert.equal(result.realtimeRecappiAudioInput, null);
  assert.ok(result.realtimeAudioCapture, "fixtures should keep the browser WebRTC capture path");
});
