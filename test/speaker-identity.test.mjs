import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { resolveSpeakerIdentity } from "../packages/core/src/realtime/speaker-identity.ts";

test("resolveSpeakerIdentity resolves configured current-user aliases", () => {
  const identity = resolveSpeakerIdentity("Peng Xiao (speaking)", {
    name: "彭萧",
    englishName: "Peng Xiao",
    aliases: ["peng", "px"],
  });

  assert.equal(identity.resolved, true);
  assert.equal(identity.role, "current_user");
  assert.equal(identity.isCurrentUser, true);
  assert.equal(identity.canonicalName, "彭萧");
  assert.equal(identity.preferredName, "彭萧");
  assert.equal(identity.matchedAlias, "Peng Xiao");
});

test("resolveSpeakerIdentity falls back without guessing external speakers", () => {
  const identity = resolveSpeakerIdentity("Cindy is speaking", {
    name: "彭萧",
    englishName: "Peng Xiao",
  });

  assert.equal(identity.resolved, false);
  assert.equal(identity.role, "external");
  assert.equal(identity.isCurrentUser, false);
  assert.equal(identity.canonicalName, "Cindy");
  assert.deepEqual(identity.evidence, ["fallback:display_name"]);
});
