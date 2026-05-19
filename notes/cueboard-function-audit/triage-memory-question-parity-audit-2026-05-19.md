# Triage Memory Question Parity Audit — 2026-05-19

## Production Case

- New message: `C09KVPBMLJ3:1779179299.144449`
- User text: `没付费的用户 reset quota 了吗`
- Old Bridge reply: answered from team/meeting Memory:
  `付费用户的配额已经全部重置拉满，但免费送的用户也需要重置`
- New Oneesama behavior before fix: recorded a successful triage run
  but produced no action. The AgentRunner summary and Pi foreground
  reason both classified the question as a product/technical question
  outside the office-helper lane.

## Root Cause

This was not an entrypoint miss. The scanner saw the Slack message and
created triage run `1779179367129001`.

Two Memory-path regressions hid the answer:

1. The triage related-memory query used the entire rendered digest.
   The digest included stale low-context channel expansion about
   `bridge / apple watch`, so Memory providers could rank unrelated
   context ahead of the fresh question.
2. The failed no-action triage run itself became a
   `triage_projection` Memory record. On rerun, that projection had
   exact lexical overlap with the question and could crowd out the
   true team fact, creating a self-reinforcing "we skipped this"
   loop.

The actual answer was already present in imported old Slack Agent D
workspace Memory:

- `memory/legacy/slack-agent-d/workspace/memory/team/facts/meeting-84.md`
- `memory/legacy/slack-agent-d/workspace/memory/team/meetings/meeting-84.md`

## Fix

- Triage now derives `localSlackMemory` and `relatedMemory` queries
  from the fresh Slack message text and file metadata, falling back to
  the full digest only when there is no usable message text.
- No-action / skip / stay-silent triage projections are no longer
  indexed as related-memory evidence.
- Team facts and meeting memories receive a narrow family boost for
  quota/reset/user terms so source-cited meeting facts can beat
  generic projections or entity noise.

## Fixture

`TestSlackTriageRelatedMemoryUsesFreshQuestionOverDigestContext`
reproduces the production shape:

- fresh question: `没付费的用户 reset quota 了吗`
- stale digest context: `bridge 能接 apple watch 吗`
- imported meeting facts: meeting 84 quota reset notes
- bad no-action projection: the previous Oneesama skip result

The test asserts:

- the Memory query is the fresh question only;
- the top related-memory record is `team_fact` or `team_meeting`;
- no no-action `triage_projection` enters related memory;
- stale digest entity-graph context does not pollute the evidence set.

## Decision

Keep automatic scanner triage within the old Cueboard contract:
when a user asks a direct workspace question and source-cited team
Memory can answer it, Oneesama should provide one short verified fact
instead of treating "not @mentioned" as a reason to stay silent.
