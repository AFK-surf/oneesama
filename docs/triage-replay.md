# Triage backfill replay (task #185, slice 1)

`oneesama-triage-replay` is the dry-run companion to the live triage
path. It scans a batch of recent Slack messages, classifies which ones
oneesama probably should have caught, and emits a Markdown report for a
human to review. **Nothing is posted.** The report distinguishes
postable `Draft reply` entries from non-postable leads that still need
more context or delegated link/article reading.

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
- Link/article candidates must be handed to the connected agent/runner
  for source-backed reading before they are labelled `review_ready`.
  Backfill does not grow built-in PDF/article parsers in Go; it emits a
  delegated read request instead. Until an agent returns evidence, the
  report marks the item `needs_agent_read` and labels its text
  `Context note (not a reply)`.

## Report quality gates

Every rendered candidate carries a `Quality gate` line:

- `review_ready` — local quality gates passed; the text is labelled
  `Draft reply`.
- `needs_agent_read` — the item is a readable-link lead, but the
  linked material has not yet been read by the connected agent with
  source evidence.
- `needs_context` — the message mentions a specific owner/user, asks a
  technical workflow / CI / deploy question, or otherwise needs repo /
  runtime context before posting.
- `needs_thread_refetch` — the item came only from persisted
  `delayed_no_reply` state; the thread must be refetched before any
  reply is considered.

This is intentionally stricter than "candidate found == reply ready".
Dogfood showed that generic fallback text can look like oneesama is
pretending to read a PR/article when it has not.

## Delegated reading requests

When the report contains `needs_agent_read` candidates, it also appends
a `Delegated agent read requests` section. Each request is a ready
prompt for the connected agent/runner:

- It names the Slack channel/thread anchor and the URL.
- It includes the original Slack message.
- It explicitly says not to post to Slack.
- It requires source-backed synthesis and an honest blocker if the URL
  cannot be read.

This is deliberate. Backfill is an orchestration layer, not a document
parser or cognition engine. PDFs, articles, and rich pages should be
read by the agent that already owns browsing / file / code-reading
tools; only that result can later promote a lead to `review_ready`.

## Triage reply templates

Default reply wording lives under `internal/slackagent/templates/triage/`
and is also bootstrapped into the runtime workspace at
`templates/triage/`. Operators can override the same filenames via:

- `ONEESAMA_TRIAGE_TEMPLATE_DIR=/path/to/templates/triage`
- `$ONEESAMA_SLACK_WORKSPACE_DIR/templates/triage/`

Current default template names:

- `link_synthesis.{zh,en}.tmpl`
- `delayed_no_reply_link.{zh,en}.tmpl`
- `delayed_no_reply_stuck.{zh,en}.tmpl`
- `delayed_no_reply_default.{zh,en}.tmpl`

The templates are a workspace behaviour contract, not an implementation
detail. They exist because each Slack workspace has its own norms for
how "lightweight opinion" replies should sound.

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
  backfill scan didn't see the root (e.g. window cut it off). These
  entries are leads, not postable candidates: they are labelled
  `needs_thread_refetch` because the current thread state may have
  changed since the followup was recorded.
- **`fresh`** — backfill scan only; no matching followup.

Each candidate in the rendered Markdown shows a `Source` line with
one of those three labels plus the `Followup ID` when applicable so
the reviewer can correlate against live debug surfaces.

If `--persistence-dir` is omitted, the merge is skipped silently and
the report contains only fresh candidates. If the dir exists but
opening the collection fails, the merge falls back to fresh
candidates only with a stderr warning — non-fatal.

## What's NOT implemented yet

- **`--post`**. The dry-run CLI cannot send Slack messages. The live
  triage path remains the only component allowed to post.
- **Persisted followup auto-resolve.** The CLI now refetches
  persisted-only threads when a Slack token is available and drops
  leads that humans already answered, but it does not yet write
  `superseded_by_human` back into live followup state.
- **Automatic delegated read execution.** Link candidates now render
  agent read requests, but the CLI does not yet submit those requests
  to a runner and merge the returned evidence.
- **Full LLM re-run for backfill.** The broader "rerun the complete
  triage LLM prompt over each candidate" path is still future work.

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
