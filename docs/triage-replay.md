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

Quality gates added after the 2026-05-18 dogfood report:

- X / Twitter status URLs are treated as low-signal by default. They
  may be interesting socially, but a raw status link without readable
  article context produced generic "I skimmed this" replies in
  dogfood, so replay skips them.
- GitHub PR / issue / commit / compare / Actions links are skipped
  when the surrounding message looks like an owner-directed work
  instruction (`review`, `approve`, `cherry-pick`, `preprod`, `看一下`,
  direct Slack mention, etc.). Those should be handled by the assigned
  human or the normal engineering workflow, not by oneesama doing a
  lightweight article synthesis.
- GitHub readable documents remain eligible when they are actually
  material to read, e.g. `/blob/.../*.pdf`, `.md`, `.txt`, or notebooks.

## Live mode (slice 2)

Slice 2 added a `--live` mode that calls Slack
`conversations.history` + `conversations.replies` directly so the
operator doesn't have to materialise NDJSON manually:

```
oneesama-triage-replay \
  --live \
  --channel C0AQ0C0KVMH,C0123ABC \
  --since 24h \
  --token "$ONEESAMA_SLACK_BOT_TOKEN" \
  --bot-user-ids U_BOT \
  --max-messages-per-channel 200 \
  > replay.md
```

If `--token` is omitted, the CLI reads `ONEESAMA_SLACK_BOT_TOKEN`
from the environment.

Live-mode guardrails applied (per driver audit of `97f01a7`):

1. **Two-stage replies fetch.** History is fetched first; only when
   `reply_count > 0` does the CLI issue a follow-up
   `conversations.replies` call. Saves quota on quiet channels.
2. **Pagination.** `response_metadata.next_cursor` is followed until
   the window is drained or the `--max-messages-per-channel` cap is
   hit.
3. **Truncation flag.** When the cap fires, the per-channel coverage
   row carries `Truncated=true` so the report never misrepresents
   coverage.
4. **429 retry hard cap.** Slack rate-limit responses honour the
   `Retry-After` header up to 3 attempts per call; afterwards the
   failure surfaces as a warning entry, not a whole-run abort.
5. **No-post.** Live mode still emits a Markdown report and nothing
   else. The driver's live triage path is the only place that
   actually posts. `--post` is intentionally absent from this CLI.

The Markdown report ends with a `## Live scan coverage` table:

| Channel | Scanned | Replies fetched | Candidates | Truncated | 429 retries | Warnings |
| ------- | ------: | --------------: | ---------: | --------- | ----------: | -------- |
| `C1`    |      47 |               3 |          4 | false     |           0 | —        |
| `C2`    |     200 |              18 |         12 | true      |           1 | —        |

## Channel auto-discovery (slice 3)

Slice 3 added `--channel auto`, which asks Slack which channels the
bot already belongs to instead of requiring the operator to hand-roll
the list:

```
oneesama-triage-replay --live --channel auto --since 24h > replay.md
```

Audit-safety rules:

1. **No joins.** Auto-discovery uses
   `users.conversations?types=public_channel,private_channel&exclude_archived=true`
   which only returns channels the bot is already a member of. The
   CLI never calls `conversations.invite` or any other join API.
2. **No DMs / group DMs.** `mpim` and `im` types are deliberately
   excluded — those are scoped to specific humans and scanning them
   would be the wrong product behaviour.
3. **No archived.** `exclude_archived=true` and a defensive client-side
   filter on `is_archived` keep dead channels out of the scan, even
   if Slack's API behaviour drifts.
4. **No mixing modes.** Passing `--channel auto,C1` is rejected with
   a clear error. An operator gets either auto-discovery or an
   explicit list; the union mode is not supported, because the
   "I'll just add one extra" pattern usually means the operator
   doesn't actually know what's in scope.
5. **Fallback before zero.** Auto-discovery first tries
   `users.conversations`. If that returns zero joined channels, the
   CLI falls back to `conversations.list` and filters
   `is_member=true`. This exists because live dogfood saw
   `users.conversations` return zero while `conversations.list`
   correctly showed dozens of joined channels.
6. **Zero channels = explicit failure.** If both discovery paths return
   nothing, the CLI exits non-zero with a hint to invite the bot
   somewhere. Silent "0 candidates" reports are a confusing
   anti-pattern.

## Persisted state merge (slice 3 piece A)

Driver's #186 ships a live triage path that persists "wait for human,
revisit in 90 min" decisions into `slack_heartbeat_followups`. Slice 3
piece A makes the backfill report respect that state instead of
re-discovering everything from scratch.

Opt in via `--persistence-dir`:

```
oneesama-triage-replay \
  --live --channel auto --since 24h \
  --persistence-dir /var/lib/oneesama/state \
  --persistence-provider json-file \
  > replay.md
```

The merge runs after fresh classification, using
`(channelID, threadRootTS, classification)` as the dedupe key:

- **`persisted+fresh`** — backfill scan found the candidate AND a
  live #186 followup matches the same key. Keep the fresh draft (it
  has channel history context), but mark `FromPersistedState=true`
  and cite the followup id.
- **`persisted` (only)** — the followup exists in live state but the
  backfill scan didn't see the root (e.g. window cut it off). The
  candidate is synthesized using the followup's Title + Summary
  **verbatim**, no re-classification or paraphrasing — the live
  triage already wrote those with full thread context and the
  backfill report respects that authority.
- **`fresh`** — backfill scan only; no matching followup.

Each candidate in the rendered Markdown shows a `Source` line with
one of those three labels plus the `Followup ID` when applicable so
the reviewer can correlate against live debug surfaces.

If `--persistence-dir` is omitted, the merge is skipped silently and
the report contains only fresh candidates. If the dir exists but
opening the collection fails, the merge falls back to fresh
candidates only with a stderr warning — non-fatal.

## What's NOT in slice 2 yet

- **`--post`**. Driver owns the live `--post` toggle path. The dry-run
  CLI cannot send Slack messages.
- **Auto-discovery of channels**. You still pass `--channel` explicitly.
  Auto-pulling the bot's joined channel list from `slack_channels`
  typed collection is queued for a later slice.
- **Persisted-state merge**. Driver's #186 persists "wait-for-human"
  decisions; reading those to enrich/dedupe candidates is queued for
  a later slice.
- **External link content enrichment**. The classifier already detects
  shared-link / article shares; pulling the article body for richer
  drafts is a follow-up.

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
