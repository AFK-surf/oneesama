import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  classifyHostAdmissionButtonLabel,
  hostAdmissionConfigFromEnv,
} from "../scripts/real-meet-host-admission-helper.mjs";

test("host admission config stays disabled unless explicitly configured", () => {
  assert.deepEqual(hostAdmissionConfigFromEnv({}), { enabled: false });
});

test("host admission config requires a separate persistent host profile", () => {
  const invalid = hostAdmissionConfigFromEnv({ MAB_REAL_MEET_HOST_ADMISSION: "1" });
  assert.equal(invalid.enabled, true);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.blocker, "host_admission_profile_required");

  const conflict = hostAdmissionConfigFromEnv({
    MAB_REAL_MEET_HOST_ADMISSION: "1",
    MAB_BROWSER_USER_DATA_DIR: "/tmp/main-profile",
    MAB_HOST_ADMISSION_BROWSER_USER_DATA_DIR: "/tmp/main-profile",
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.blocker, "host_admission_profile_conflict");
  assert.deepEqual(conflict.conflicts, ["main_bot_profile"]);

  const valid = hostAdmissionConfigFromEnv({
    MAB_REAL_MEET_HOST_ADMISSION: "1",
    MAB_BROWSER_USER_DATA_DIR: "/tmp/main-profile",
    MAB_SYNTHETIC_SPEAKER_BROWSER_USER_DATA_DIR: "/tmp/speaker-profile",
    MAB_HOST_ADMISSION_BROWSER_USER_DATA_DIR: "/tmp/host-profile",
    MAB_SYNTHETIC_SPEAKER_INVITE_EMAIL: "speaker@example.com",
  });
  assert.equal(valid.ok, true);
  assert.equal(valid.profileMode, "persistent");
  assert.equal(valid.browserUserDataDir, "/tmp/host-profile");
  assert.equal(valid.inviteEmail, "speaker@example.com");
  assert.equal(valid.inviteEmailConfigured, true);
});

test("host admission button classifier targets admit/invite controls but ignores join controls", () => {
  assert.equal(classifyHostAdmissionButtonLabel("Admit").admit, true);
  assert.equal(classifyHostAdmissionButtonLabel("Admit all").admit, true);
  assert.equal(classifyHostAdmissionButtonLabel("Let in").admit, true);
  assert.equal(classifyHostAdmissionButtonLabel("允许加入").admit, true);
  assert.equal(classifyHostAdmissionButtonLabel("Add people").invite, true);
  assert.equal(classifyHostAdmissionButtonLabel("邀请他人").invite, true);
  assert.equal(classifyHostAdmissionButtonLabel("Show everyone").people, true);

  assert.equal(classifyHostAdmissionButtonLabel("Ask to join").admit, false);
  assert.equal(classifyHostAdmissionButtonLabel("Join now").admit, false);
  assert.equal(classifyHostAdmissionButtonLabel("Deny").admit, false);
  assert.equal(classifyHostAdmissionButtonLabel("拒绝").admit, false);
});
