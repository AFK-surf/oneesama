import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMeetingAwarenessState,
  meetingAwarenessContextText,
} from "../packages/core/src/meeting/google-meet-joiner.ts";

test("meeting awareness prefers fresh caption speaker and merges participant sources", () => {
  const nowMs = Date.parse("2026-05-16T15:25:30Z");
  const awareness = buildMeetingAwarenessState({
    nowMs,
    meetPage: {
      ok: true,
      inMeeting: true,
      participantCount: 3,
      participants: [
        { name: "Peng Xiao", source: "meet_participant_tile", confidence: "medium" },
        { name: "Miao", source: "meet_participant_tile", confidence: "medium" },
      ],
      activeSpeaker: {
        name: "Miao",
        source: "meet_speaker_tile_indicator",
        confidence: "medium",
        observedAt: "2026-05-16T15:25:28Z",
      },
    },
    captions: {
      ok: true,
      latest: {
        ts: "2026-05-16T15:25:29Z",
        speaker: "Peng Xiao",
        text: "我们继续看参会者信息。",
        source: "google-meet-caption-dom",
      },
      tail: [
        {
          ts: "2026-05-16T15:25:10Z",
          speaker: "Cindy",
          text: "我也在。",
          source: "google-meet-caption-dom",
        },
      ],
    },
  });

  assert.equal(awareness.ok, true);
  assert.equal(awareness.participantCount, 3);
  assert.deepEqual(awareness.participants.map((participant) => participant.name).sort(), [
    "Cindy",
    "Miao",
    "Peng Xiao",
  ]);
  assert.equal(awareness.activeSpeaker?.name, "Peng Xiao");
  assert.equal(awareness.activeSpeaker?.source, "google-meet-caption-dom");
  assert.equal(awareness.activeSpeaker?.confidence, "high");
  assert.match(meetingAwarenessContextText(awareness), /Current\/recent speaker: Peng Xiao/);
});

test("meeting awareness links active speaker aliases to current user", () => {
  const awareness = buildMeetingAwarenessState({
    nowMs: Date.parse("2026-05-16T15:25:30Z"),
    currentUser: {
      name: "Peng Xiao",
      englishName: "Peng Xiao",
      aliases: ["彭潇", "肖鹏", "Operator"],
    },
    meetPage: {
      ok: true,
      inMeeting: true,
      activeSpeaker: {
        name: "彭潇",
        source: "meet_speaker_tile_indicator",
        confidence: "medium",
        observedAt: "2026-05-16T15:25:28Z",
      },
    },
  });

  assert.equal(awareness.activeSpeaker?.identity?.canonicalName, "Peng Xiao");
  assert.equal(awareness.activeSpeaker?.identity?.isCurrentUser, true);
  assert.match(meetingAwarenessContextText(awareness), /canonical_name=Peng Xiao/);
  assert.match(meetingAwarenessContextText(awareness), /is_current_user=true/);
});

test("meeting awareness resolves another workspace owner without Peng-specific prompt data", () => {
  const awareness = buildMeetingAwarenessState({
    nowMs: Date.parse("2026-05-16T15:25:30Z"),
    currentUser: {
      name: "张三",
      englishName: "Zhang San",
      aliases: ["张三", "Zhang San", "Operator"],
    },
    meetPage: {
      ok: true,
      inMeeting: true,
      participants: [{ name: "李四", source: "meet_participant_tile", confidence: "medium" }],
      activeSpeaker: {
        name: "Zhang San",
        source: "meet_speaker_tile_indicator",
        confidence: "medium",
        observedAt: "2026-05-16T15:25:28Z",
      },
    },
  });

  assert.equal(awareness.activeSpeaker?.identity?.canonicalName, "张三");
  assert.equal(awareness.activeSpeaker?.identity?.preferredName, "张三");
  assert.equal(awareness.activeSpeaker?.identity?.isCurrentUser, true);
  const external = awareness.participants.find((participant) => participant.name === "李四");
  assert.equal(external?.identity?.role, "external");
  assert.equal(external?.identity?.isCurrentUser, false);
});

test("meeting awareness falls back to DOM speaker when caption speaker is stale", () => {
  const awareness = buildMeetingAwarenessState({
    nowMs: Date.parse("2026-05-16T15:26:30Z"),
    meetPage: {
      ok: true,
      activeSpeaker: {
        name: "Miao",
        source: "meet_speaker_tile_indicator",
        confidence: "medium",
        observedAt: "2026-05-16T15:26:29Z",
      },
    },
    captions: {
      ok: true,
      latest: {
        ts: "2026-05-16T15:25:00Z",
        speaker: "Peng Xiao",
        text: "旧字幕。",
        source: "google-meet-caption-dom",
      },
    },
  });

  assert.equal(awareness.activeSpeaker?.name, "Miao");
  assert.equal(awareness.activeSpeaker?.source, "meet_speaker_tile_indicator");
});
