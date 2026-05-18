# Triage backfill replay (task #185, slice 1)

`oneesama-triage-replay` is the dry-run companion to the live triage
path. It scans a batch of recent Slack messages, classifies which ones
oneesama probably should have caught, and emits a Markdown report with
draft replies for a human to review. **Nothing is posted.** That's the
whole point of slice 1 — the operator is the safety toggle.

This is the response to Peng's 5/18 ask:
> 我觉得你们可以扫一下过去的所有消息，然后想一想哪些其实是值得回的，
> 尤其是那种长时间没有人回的消息。

## Slice 1 input shape

NDJSON on stdin. One [`SlackInboundMessage`][SlackInboundMessage] JSON
object per line. Both `channelId` and `channel_id` field names are
accepted; same for `thread_ts` / `threadTs`. At minimum each record
needs `channelId`, `ts`, `user_id`, and `text`.

A trivial example file `recent.ndjson`:

```
{"channelId":"C0123","user_id":"U_PENG","ts":"1779000000.000","text":"CI 在 main 整体卡住了，没有任何 build 反应"}
{"channelId":"C0123","user_id":"U_PENG","ts":"1779000100.000","text":"我们要不要回滚 canvas writes?"}
{"channelId":"C0123","user_id":"U_DRIVER","ts":"1779000101.000","thread_ts":"1779000100.000","text":"Looking at it now."}
```

Run the CLI:

```
oneesama-triage-replay --bot-user-ids U_BOT < recent.ndjson > replay-report.md
```

You get a Markdown file grouped by classification. In the example
above:

- The first message (`卡住了`) classifies as `stuck_or_handoff` and
  produces a candidate.
- The second message has a human reply (`Looking at it now`), so it is
  intentionally skipped — humans don't need oneesama talking over them.

## Classification taxonomy

Reused from driver's #186 (`service_triage_delayed_followup.go`) so
the live triage path and the backfill scan classify the same way:

- `stale_wait_for_human` — earlier triage explicitly said "wait for
  human" and that wait now looks indefinite.
- `unanswered_question` — open question (`?`/`？`/`要不要`/`should we`)
  with no reply.
- `stuck_or_handoff` — explicit blocked / failed / broken / 卡住 / 报错.
- `link_followup_candidate` — high-information article/PDF link share
  with no reply (matches #184's heuristic).
- `synthesis_eligible_thread` — discussion thread that's worth a brief
  synthesis even though no specific question was asked.

## What's NOT in slice 1

- **`--post`**. Driver owns the live `--post` toggle path. The dry-run
  CLI cannot send Slack messages.
- **Live `conversations.history` fetch**. The CLI does not call Slack.
  Slice 2 will add `--live --channel C123 --since 24h` so the operator
  doesn't need to materialise NDJSON manually.
- **Persistence**. Candidates are not stored anywhere — re-running the
  CLI on the same input produces the same report (the algorithm is
  pure). Driver's #186 already persists "wait-for-human" decisions in
  live triage state; future slices can read that state to enrich
  candidates.

## Why dry-run first

Two reasons:

1. **The algorithm should be reviewable before it's loud.** A
   classifier that misjudges noisy channels would create more chat
   noise than the silence it's trying to fix. The Markdown report
   lets us check classification quality on real messages before any
   reply ships.
2. **It composes with existing exports.** Any source of messages
   (Slack export tool, a fixture, a stub) can feed the CLI without
   coupling it to oneesama's runtime auth. The same code path the
   operator runs locally is what slice 2 will eventually wire to a
   live fetch.

[SlackInboundMessage]: ../internal/slackagent/inbound_types.go
