# Migration Lessons — Audit-method drift (companion to migration-lessons.md)

This is a companion to `migration-lessons.md` (the canonical incident table
+ gates + Definition of Done). Read that first.

This file adds the v1 audit author's perspective: I wrote
`notes/oneesama-go-parity-audit.md` (5/13), the cross-check
(`oneesama-go-parity-cross-check.md`), and the R0–R7 specs
(`go-rewrite-r0-spec.md` ... `r7-meet-runner-spec.md`). When Peng asked us
to migrate by function and by test, those documents were the artefact I
produced. They did not prevent the drift. This file reflects on **why my
own audit method failed**, with specific commit SHAs and audit-row
citations that the canonical doc abstracts away.

## What the canonical doc covers

`migration-lessons.md` covers the 9 failure modes ("What Actually Went
Wrong"), historical signal timeline, broader drift inventory, gates
0–9, function-by-function Definition of Done, and test migration
requirements. Everything here is meant to add evidence and the
audit-author's-own-eye perspective, not duplicate those sections.

## How the v1 audit drifted from acceptance gate to backlog

`oneesama-go-parity-audit.md` produced a table of 43 TS routes vs Go ~17
and a "🚨 必须有才能算 1:1 production parity" list. It looks like an
acceptance gate. It became a backlog.

Concrete trail of how that happened:

- `POST /slack/post-message` was marked ✓ done in v1 audit because the
  Go route existed and accepted the same input shape. The actual
  product behavior — digest `message_ref` IDs resolve to
  channel/timestamp at post time, `add_reaction` falls back to the
  latest digest entry per channel — was not part of my ✓ test.
  Symptom: `a3913d5 fix(slack): resolve add reaction digest targets`
  shipped weeks later when the gap surfaced in real use. The original
  ✓ was lying.

- `/slack/tools/parity` was marked ✓ done in v1 audit. The endpoint
  returned a list. The 4-class `active / validation_only /
  registered_unavailable / product_excluded` semantic that the report
  was supposed to advertise had to be retrofitted later (see commit
  trail `slack_tool_parity_status_test.go`). ✓ meant "endpoint
  returns JSON", not "endpoint tells runtime truth".

- `POST /slack/interactions` was marked ✓ done. The full
  `suggest_action` confirmation flow (pending-action persistence,
  card update on confirm/dismiss, executor goroutine, ledger,
  freshness re-check) was nowhere near complete. We then shipped that
  full flow over many slices.

The pattern: shape ✓ ≠ contract ✓. The v1 audit checked shape only.
Canonical fix: see `migration-lessons.md` Gate 0 + Gate 6.

## Files marked ❌ MISSING that never got a direct port

Cross-check Section 8 enumerated ~5000 LOC of Slack intelligence as
❌ MISSING by file:

| TS file | LOC | What got ported |
| --- | --- | --- |
| `app-mention-context.ts` | 572 | partial — rich context shipped in Phase 2 via new Go helpers, not as a 1:1 port |
| `legacy-slack-domain-store.ts` | 1720 | not ported as a file; subsumed into typed collections + cognition |
| `legacy-slack-tool-registry.ts` | 489 | not ported as a file; tool gating handled by parity matrix |
| `local-memory.ts` | 363 | partial via persistence layer; workspace memory shape differs |
| `meeting-copilot-runner.ts` | 501 | deferred / not ported |
| `mrkdwn-renderer.ts` | 384 | partial; Slack-side rendering uses different shape |
| `scanner-compaction.ts` | 104 | partial via service_scanner_poll |
| `slack-context.ts` | 261 | partial |
| `triage-context.ts` | 306 | partial via service_triage |
| `triage-flow.ts` | 446 | rebuilt as multiple Go files; not a per-function port |

Few of those got a "port file X → Go file Y, prove byte-equivalent
output on a TS fixture" sequence. Most got new Go code solving similar
problems differently. We then ticked the row as "covered" without a
test that would fail if the original TS behavior was no longer met.

Canonical fix: see `migration-lessons.md` Gate 0 + Function-By-Function
Definition of Done.

## Decision trees enumerated, but no per-step pin test

Cross-check Section 1 enumerated 11 steps of TS `events_api` handling
(message buffering, mention dedup, command build, empty-text skip,
assistant status, command execute, response post, status keep/clear,
return). Each step had a Go ✓/⚠/❌ status.

There is still no single Go test that walks through all 11 steps in
order, verifies each step against a TS fixture, and fails if any step's
branch shifts. We have scattered tests for individual behaviors but no
canonical 11-step pin.

Symptom: when step 3's `claimSlackMentionEvent` dedup was missed in
the early Go port, the bug only surfaced when a Slack retry produced
a duplicate event. The 11-step audit row was there; the test wasn't.

Canonical fix: see `migration-lessons.md` Test Migration Requirements.

## R-specs locked types, not product contracts

`notes/go-rewrite-r0-spec.md` through `r7-meet-runner-spec.md` were
TS-to-Go interface mappings: function signatures, type definitions,
route shapes. They did NOT specify the product contracts:

- "scanner waits 5 minutes by default before posting" (task #187 root
  cause, surfaced today 2026-05-18)
- "mention queue rejects duplicate event_id within an N-second window"
- "assistant.threads.setStatus dedupes by lastStatus per
  (channel, thread)"
- "delegate response text is suppressed for events_api path when
  `job.status === running`" (the
  `slackImmediateWorkerAckText` 3-branch)

These are user-visible promises. R-specs read like a port-compatibility
spec for a library, not acceptance criteria for a product. The
5-minute scanner wait was nowhere in any spec; that's why driver had
to land it as a fix today, not as a port.

Canonical fix: see `migration-lessons.md` Gate 1 (Name The Product
Contract) + Gate 5 (Re-Check Freshness).

## Wire-format duals at the call-site level

The v1 audit enumerated TS files with bot-detection logic, not the
per-call-site behavior of bot detection across the codebase. The
audit's idea of "we recognize bot messages" was correct at the file
level and wrong at the call-site level.

Today's repair trail (all from #185 slice 2/3):

- `af4e097 fix(triage-replay): normalize snake_case inputs in backfill
  scan` — backfill classifier didn't run `normalizeSlackInboundMessage`
  internally, so a snake-case `channel_id` input came out with empty
  ChannelID and grouping was wrong. Driver caught.
- `fbb6c46 fix(triage-replay): treat subtype=bot_message as
  bot-authored` — `isAuthoredByBot` only checked `bot_id`, missing
  Slackbot/incoming-webhook posts that use `subtype=bot_message`
  without `bot_id`. Driver caught.
- `c381045 refactor(triage-replay): exclude bot replies from candidate
  draft bundle` — bot reply text was leaking into the draft summary
  because the classifier saw all replies in the bundle.

All three are the same root failure: a wire-format dual (snake/camel
field names, multi-source bot identity, bot-vs-human reply roles)
that Cueboard normalized at ingress but the Go port handled
piecemeal at each call-site.

Canonical fix: see `migration-lessons.md` Broader Drift Inventory row
"Normalization and codec defaults" + Test Migration Requirements
"normalization".

## Marathon incentive structure ("port + prove" pairs)

Driver names this in their #9 ("Marathon throughput hid review depth
problems"). One concrete pattern not yet structurally fixed:

Throughout today's marathon, my slice 2 and slice 3 piece B each
shipped with a real bug that driver's audit caught. The bugs were:

- snake_case normalize gap → fixed in `af4e097`
- subtype=bot_message gap → fixed in `fbb6c46`
- bot reply leaking into draft → fixed in `c381045`

In each case the fix was small and quick. But the AUDIT ITSELF was
the safety net, not my pre-ship verification. If driver hadn't been
auditing every slice, those would have landed silently.

Suggested structural fix: marathon slices ship in **port + prove
pairs**. The same agent does not get to mark a slice in_review unless
either (a) a contract test that fails on the unported state exists,
or (b) a second agent's audit signature is attached. A marathon of
30 ships should be 15 ship+audit pairs, not 30 unaudited ships.

(This is more specific than driver's Gate 9 wording. It is a process
proposal, not a tested claim. Worth Peng's attention if a future
marathon is planned.)

## Entry-level parity gap and the "re-derive vs port" lesson (2026-05-19 #215)

After Pi cutover (`adc0182`, 2026-05-18 ~18:30 SHA) the system reported
0 red / 11/11 canary / 16/16 Pi foreground for ~14 hours. Then Peng
shared 4 real Slack `app_mention` cases in `#meeting-avatar:4c1afcac`
that showed degraded quality vs old Slack Agent D. Within ~60 minutes
driver shipped 4 fixes that exposed three distinct bugs — all in the
same `app_mention` entry-point:

| Case | Bug                                                                  | Fix         | Drift pattern                                  |
| ---- | -------------------------------------------------------------------- | ----------- | ---------------------------------------------- |
| 1    | App_mention worker prompt missing related-memory evidence            | `36993d1`   | shape ≠ contract (caller drift)                |
| 2    | Job orphaned by deploy restart                                       | `a6407dc`   | lifecycle invariant (persisted ↔ runtime)      |
| 3    | Socket app_mention event lost; scanner cursor advanced without compensation | `f9629fe` | compensation path partial implementation       |
| 4    | meet-runner pipe closed; meeting-agent kept polling joined state     | `9f9f99d`   | lifecycle invariant (persisted ↔ runtime)      |

Three separate bugs in the same entry-point in one diagnostic session
is the proof that "by subsystem" audit was wrong and "by user entry"
audit is right. The system was 0-red on every health surface and still
shipping degraded user-facing replies for 14h. Driver named this in
their 10:11 reflection in `#meeting-avatar:4c1afcac msg=b1586a3f`:

> 把"能力存在"误判成"真实路径可用" — subsystem 验了 #195 SearchRelatedMemory、Pi triage、backfill；漏了 app_mention → Codex worker 这条用户实际入口。结果 triage 有 memory evidence，mention worker 没有。

### The 7-point entry-parity contract (anchor for `app_mention`)

To prevent the same drift recurring at a different entry-point, the
new shape is a per-entry-point parity contract. For `app_mention`:

1. Socket event received → worker job created (basic path)
2. Socket event lost but scanner sees @bot → compensation creates job (`f9629fe`)
3. Job survives across restart / orphan recovery (`a6407dc`)
4. Worker prompt injected with related-memory evidence (`36993d1`)
5. Worker can read/write/reuse Slack Canvas (`b2114ff`; old-code parity completed by `240d9e2`)
6. Worker hits person/project memory for entity attribution (`555feac`)
7. Worker tool failure is fail-closed; never exposes localhost/curl/internals to user (tool-fail-closed change)

The contract is in the canonical doc style: each item has a fixture
test. `TestAppMentionContextIncludesRelatedMemoryEvidence` is the
anchor fixture for item 4. Future entry-points (DM-initiated worker,
heartbeat-triggered followup, meeting-result publisher, etc.) get
their own N-point contracts, derived by reading the cueboard source
behavior at that entry, not by reasoning about goals.

### "Re-derive vs port" — the drift pattern Peng named at 11:10 SHA

In `#meeting-avatar:4c1afcac msg=d0051b14` Peng wrote:

> 记住了，migration 具体实现时不要自己直接写，而是先参考老代码；
> 比如说这个 Canvas，read，write，reuse 之类的，是你们自己现编的吗

Driver answered honestly (`msg=f3ed39bc`): `b2114ff fix(slack):
hydrate linked threads for app mention canvas` was **constructed from
existing Go capabilities + the stated behavioral goal**, not ported
from cueboard's `slack_api_tool_canvas.go`. The behavior goal is
right; the implementation path was re-derived.

This is a drift class distinct from "shape ≠ contract":

- Shape ≠ contract = audit checked surface, missed semantics.
- Re-derive vs port = implementation was reasoned from scratch
  instead of read from the old code's actual behavior. Even with
  identical behavior goals, the new implementation diverges at edge
  cases the old code encoded after production hardening.

The fix is a hard rule for future migration work: **before
implementing any migration target, read the cueboard source at the
corresponding path**. Cueboard slack-agentd source is locally
available at:

```
~/Documents/cueboard/agent-framework/deploy/docker/data/slack-agent/runtime/repos/cueboard-main/agent-framework/internal/bridge/slack/
```

This is the docker runtime repo for the live slack-agentd binary. It
includes `slack_api_tool_canvas.go`, `slack_api_tool.go`,
`meet_publish.go`, `bridge.go`, `assistant_context.go` and ~140
others. No GitHub round-trip needed.

For each migration item: read old → diff new → write "old does X, new
does Y, difference justified because Z, fixture pins both". Without
that audit doc per item, the implementation has not been ported.

### Six drift patterns from driver's 10:11 reflection (mapped)

Driver's 5 self-reflection items in `msg=b1586a3f`, plus the new
"re-derive vs port" pattern, mapped to drift classes:

1. "Subsystem 看了没按用户入口看" → shape ≠ contract (the audit
   already had this class; the new emphasis is "audit by user entry,
   not module").
2. "Prompt 写 tool 当 tool 已集成" → **prompt as behavior contract,
   not implementation**. A tool exposed only by prompt instructions
   to `curl http://127.0.0.1:8780/...` is not integrated; it's a
   string in a prompt. End-to-end "tool actually callable from the
   worker's runtime" test is what makes it integrated.
3. "Parity 审计粒度太粗" → **action-level vs entry-level parity**.
   "Tool parity 15 active" is a module claim. Entry-level parity is:
   what did old Agent D do at THIS entry-point with THIS user prompt;
   does new oneesama produce the same evidence + tool call + reply.
4. "质量没被 canary 化" → **acceptance gate not audit health**.
   Health green ≠ quality parity. #197-style canaries must test
   regression of user-visible reply quality (cite source, decision
   accuracy, tool-call set), not only system aliveness.
5. "降级路径太危险"（gateway 错误吐给用户）→ **silent fallback
   exposes internals**. Fallback paths must fail-closed (refuse to
   answer) or substitute a user-safe message; they must never expose
   `localhost`, internal hostnames, curl error strings, stack traces.
6. **Re-derive vs port** (new, Peng 11:10) — as above.

Patterns 1, 3, 5 are entry-point sharpenings of patterns the audit
already had. Patterns 2, 4, 6 are new classes added today.

### Action items folded into this doc

- Future migration work: read old cueboard source FIRST. Cite the
  cueboard file path in the commit message or PR description.
- Each user-facing entry-point gets an N-point parity contract before
  any fix is marked done.
- Each contract item gets a fixture test (or explicit deferral with
  a tracking task).
- Quality canaries (`#197` spirit) are an acceptance gate, separate
  from health canaries.
- Audit reports map findings to drift-pattern classes, not just
  symptoms.

This is now the v1 audit author's resolution: I did not enforce
"read old code first" in the audit method I produced; that was a
gap. Future migration audits I write will start from the cueboard
source path for that entry-point.

### Worked example: `240d9e2 fix(slack): restore direct canvas tool parity`

Driver's `240d9e2` (2026-05-19 11:27 SHA) is the first commit applying
the read-old-first rule end to end. It is the worked example future
migrations should imitate.

What driver did:

1. Read cueboard `slack_api_tool_canvas.go` and `slack_api_tool.go`.
2. Wrote `notes/cueboard-function-audit/canvas-parity-audit-2026-05-19.md`,
   five behaviors each with `Old does (file:line) / New does (file:line) /
   Diff / Decision / Fixtures`.
3. Caught two real drifts that the previous re-derived implementation
   (`b2114ff`) had missed:
   - `slack_api(create_canvas)` / `slack_api(edit_canvas)` had been
     `registered_unavailable` in the new code; old Agent D listed both
     in `assistantAllowedSlackActions` as first-class. The
     `registered_unavailable` status was a re-derived guardrail (assume
     destructive Canvas writes need human confirmation), not a port of
     old behavior.
   - `workerResultCanvasInput` was always creating a new Canvas even
     when `CanvasFiles` already contained one. The notification text
     said "已更新" while the input lacked any `CanvasID` — a
     user-visible-text ↔ actual-behavior decoupling that "read new code
     only" review would not surface.
4. Shipped fixes for both drifts + 22 new tests, kept sanitize-retry,
   logged remaining nits in "Open Follow-Ups".

What this proves about the audit method:

- The audit doc itself caught drift in the same commit window. The
  doc is not write-only.
- The "Decision" column does honest work: behavior 1 keeps the new
  stricter read path with an explicit justification; behavior 2/3
  ports the old direct tool; behavior 5 keeps the new publisher.
  Not every old behavior gets ported; the audit captures WHICH and
  WHY.
- Fixture names are cited per behavior. A future audit can grep for
  the fixture to know exactly what the contract is.
- The doc lives next to the canonical migration docs in
  `notes/cueboard-function-audit/`, not in a side folder.

The shape future migration items should imitate: cite the cueboard
file:line for the old behavior, cite the new oneesama file:line, write
the diff bullets, write the decision, name the fixture. Without the
fixture name an audit item has not been ported. With it, the contract
is locked.

### Worked example: entity attribution parity

The follow-up audit
`notes/cueboard-function-audit/entity-attribution-parity-audit-2026-05-19.md`
applies the same method to Peng's Cumora/yetone production case.

What it found:

1. Old Slack Agent D's `person_memory` surface included `briefing`;
   new Oneesama had re-derived only `lookup/list/correct`.
2. Old people-memory search scored the whole profile, including
   durable context, responsibilities, and recent meetings; new
   Oneesama only searched name, identity, and operator notes.
3. The strongest evidence for the Cumora/yetone answer was not in a
   person profile at all. It lived in old
   `memory/triage-archive/*.json` raw tool output: `person_memory`
   returned no `yetone`, then search results connected `yetone` to
   Isoform/Alma and found no visible Cumora link. The first import
   skipped this JSON because it only copied Markdown.
4. New related-memory URL tokenization allowed scheme/TLD noise
   (`https`, `ai`) to compete with entity evidence.

What this proves:

- Entity attribution is not one subsystem. It crosses person memory,
  workspace memory import, historical tool-result memory, URL query
  tokenization, and fresh search tools.
- "We migrated memory" was too coarse; the parity question is "can
  the new entry point recover the same evidence old Agent D used for
  this exact user question?"
- Old runtime traces are memory. They are not disposable logs when
  they contain the tool calls and evidence that made a prior answer
  good.

## Worked example: tool fail-closed and prompt-as-implementation

The follow-up audit
`notes/cueboard-function-audit/tool-fail-closed-parity-audit-2026-05-19.md`
applies the same method to the app-mention worker tool failure case.

What it found:

1. Old Slack Agent D registered Slack helpers, memory, search/content,
   and action tools as native `agent.Tool` implementations via
   `RegisterSlackTools`.
2. New Oneesama had re-derived that behavior as prompt text telling
   Codex to curl `127.0.0.1:8780/slack/tools/call`.
3. When the command-provider runtime could not reach that loopback
   gateway, the worker final answer exposed `curl`, localhost, and
   connection failure details to the Slack thread.

What this proves:

- Prompt text is not a tool bridge. If the old runtime had a native
  tool registry, a migration is not complete just because the new
  prompt describes a way to call tools.
- Delivery must be fail-closed at the user boundary. Even when an
  internal worker leaks a gateway or stack detail, Slack-visible output
  should be user-safe.
- Fresh search parity remains an entry-level behavior, not a wording
  promise. Unknown future entities need either a real worker tool
  bridge or a delegated-reader/persona path that can cite evidence.

The next audit
`notes/cueboard-function-audit/worker-tool-bridge-parity-audit-2026-05-19.md`
closed the immediate entry-level gap by adding first-class Go-side
tool evidence dispatch for app-mention fresh entity questions:

- Old Agent D had a native tool registry. New Oneesama cannot count
  prompt text as parity, so app-mention now dispatches `exa_search`
  via `Service.ExecuteSlackTool` before starting the Codex worker when
  related memory has no hit.
- The worker sees `slackToolEvidence` as injected evidence and still
  cannot reach localhost/internal gateways.
- This is not a full interactive CLI tool loop. It is a bounded port
  of the production behavior that failed: unknown entity questions
  need fresh cited evidence or a safe refusal.

## Runtime traces as memory (new drift pattern, promoted 2026-05-19)

The entity attribution audit (`555feac`) surfaced a drift class worth
naming separately from "shape ≠ contract":

> Old runtime traces are memory. They are not disposable logs when
> they contain the tool calls and evidence that made a prior answer
> good.

When a migration thinks of "memory" only as the markdown/structured
data the old system stored deliberately, it skips the history of
actions and tool outputs the old system accumulated. For an agent
whose product behavior is "answer with cited evidence from past
work", the trace IS the evidence base, not a debug log.

Concrete on 2026-05-19: cueboard's `memory/triage-archive/*.json`
held the exact `person_memory → search → Isoform/Alma` chain that
made the old Cumora/yetone answer good. The first import pass
(`8542aa4`) copied `.md` artefacts and skipped `.json` traces. The
old agent's "best answer for this kind of question" was unreachable
to new oneesama until `555feac` imported the trace JSONs as
queryable markdown.

Symptoms that catch this drift in audit:

- Old runtime has a "trace archive", "tool ledger", "decision log",
  or "audit/history" directory.
- New runtime imports the curated memory but not the trace store.
- A real production case (here: Cumora/yetone) cannot retrieve
  evidence the old agent could.

Audit rule for future migrations:

- List every persisted-evidence directory the old runtime maintained,
  not only the ones tagged "memory".
- For each, decide: port as-is / project into queryable form / drop
  with justification.
- If the migration cannot point to a fixture that recovers a real
  prior answer chain, the trace-as-memory question has not been
  answered.

Scope distinction from "shape ≠ contract":

- shape ≠ contract = audit checked surface, missed semantics.
- runtime traces as memory = audit checked the wrong universe of
  artefacts entirely; the "memory" scope was too narrow.

This is now a first-class drift class on this page.

### Worked example: task #222 memory ranking parity

Task #222 showed the second half of the same drift class. Importing
old runtime traces is necessary but not sufficient: ranking has to
treat a matching old trace as decision evidence, not as a generic
Markdown note.

Production anchor:

- old Slack Agent D `slack.db` run `13289`;
- archived run `49eeb085-e5e1-43a3-b458-d935df43a5d6` in
  `memory/legacy/slack-agent-d/workspace/memory/triage-archive/2026-05-17.md`;
- old trace called `memory_get {"path":"memory/2026-05-17.md"}` and
  `memory_search {"query":"Twitter reply review workflow"}`;
- old decision: the Twitter reply review card was waiting for human
  approval, so the bot should not act on it.

Pre-fix Oneesama could import both a generic recent daily note and the
old trace, but sorted the recent note first:

- daily note: lexical `1.00` + recency `0.18`;
- legacy trace: lexical `1.00` + legacy family `0.14`.

That was a product-quality regression: the old trace contained the
actual tool path and decision, while the recent note only proved the
topic existed.

Fix:

- `relatedMemoryLegacyToolTraceBoost` gives a narrow boost only to
  legacy triage archive chunks that have a meaningful lexical match,
  contain `Tool calls:`, and include `memory_search`, `memory_get`,
  or `person_memory`.
- `TestSearchRelatedMemoryRanksLegacyToolTraceAboveGenericRecentNote`
  is the direct red/green regression.
- `case_004_twitter_review_memory_ranking.json` adds C222 to the
  Bridge quality canary suite and requires the legacy archive citation
  to be the first related-memory evidence line.

Reference audit:
`notes/cueboard-function-audit/memory-ranking-parity-audit-2026-05-19.md`.

## Identity migration ≠ traffic interception (new drift pattern, 2026-05-19 afternoon)

The Bridge validation sweep (`bdd274c` → `a2d00b3` revert, recorded in
`notes/cueboard-function-audit/post-cutover-bridge-validation-sweep-2026-05-19.md`)
surfaced a drift class distinct from "shape ≠ contract" and from
"re-derive vs port":

When migrating from agent A to agent B, the natural intuition is "any
mention of A is now B's responsibility." That is wrong when A is still
a live, intentionally addressed identity:

- 343 Bridge-related triage runs in the past week included the old
  Bridge bot user ID `<@U09SF0MQZ5M>`.
- The first pass of the sweep proposed adding that ID as a mention
  alias for the new Oneesama (`<@U0AP5UFU0FR>`).
- Peng corrected within 6 minutes: those users intentionally
  addressed old Bridge. The new Oneesama must not intercept.
- `a2d00b3 Revert "fix(slack): accept legacy bridge mentions"` undid
  the code and the live env var.

The product semantics:

- Identity migration = retire identity A; B inherits A's role.
- Traffic interception = B answers messages addressed to A while A
  is still live.
- These are not the same. Inheriting A's traffic without retiring A
  is identity hijacking: the user's intent (address A specifically)
  is silently overridden.

Audit rule for future migrations:

- Before any alias / mention-routing fix, answer in writing: "is
  identity A being retired in this migration? If yes, who decided,
  and when does A's bot user actually go away?"
- If A is not being retired, traffic to A is not a parity gap.
- The sweep data showing "A has traffic" is not the failure signal;
  the failure signal would be "users who intended to address B got
  routed to A or nowhere."

Symptoms that catch this drift:

- A proposed migration fix routes events addressed to an old
  identifier into the new system.
- The old identifier is still a live bot account (not a deprecated
  string).
- No retirement plan exists for the old identifier.

Scope distinction:

- shape ≠ contract = surface matched, semantics missed.
- re-derive vs port = reasoned from scratch instead of reading the
  old code.
- runtime traces as memory = audited the wrong universe of
  artefacts.
- identity migration ≠ traffic interception = audited a real signal
  (Bridge mentions exist) but conflated identity ownership with
  inherited-traffic responsibility.

This is now a first-class drift class on this page.

### Worked example: bdd274c → a2d00b3 revert

What got read:

- `slack.db` 1824 triage runs, 343 Bridge-related, 17 mutating.
- New Oneesama live state mention IDs.

What got assumed (wrong):

- "Users still address old Bridge; new Oneesama should accept old
  ID as a mention alias."

What got shipped (reverted):

- New `slack.bot_mention_user_ids` config + env var.
- Scanner / mention fallback / event command stripping all accepted
  the alias.
- Live `ONEESAMA_SLACK_BOT_MENTION_USER_IDS=U09SF0MQZ5M`.

What Peng said:

- Users intentionally addressed old Bridge; do not intervene.

What got recovered:

- Revert within 6 minutes; live env unset; memory recorded; pivot
  to the actual quality gaps (#219–#223).

Why this is the worked example:

- The audit author had been disciplined about reading old code
  earlier today, but skipped the "is A being retired?" question and
  treated "A has traffic" as a parity signal. The audit method now
  requires that question explicitly before any alias / mention
  routing fix lands.

## Prompt-only tool surface ≠ tool integration (worked example, task #221)

Cueboard's Slack Agent D gave app-mention assistants a native tool loop:

- `Bridge.RegisterSlackTools` attached Slack proxy/helper/credentialed
  tools into an `agent.ToolRegistry`.
- app mentions ran through `SendMessageAndWait(..., b.newMentionHooks(...))`.
- session/agent hooks forwarded tool starts/results/status back into
  the same assistant run.

The Go rewrite initially copied the prompt shape ("available tools",
"call X first") into a command-provider worker where those tools were
not actually callable. That produced two failure modes:

- the model believed a tool existed, then failed via localhost/curl;
- later fixes removed the unsafe curl path, but left no way for a
  worker to ask for one more piece of first-class evidence mid-answer.

The task #221 fix is the current bounded contract:

- the prompt describes a real `<oneesama_tool_request>` protocol, not
  old native tool names as if they were directly callable;
- `handleSlackWorkerToolRequest` intercepts the request before Slack
  delivery, executes allowed tools through `Service.ExecuteSlackTool`,
  injects `slackToolEvidence`, and starts a continuation job;
- direct Slack posting/upload/delete/edit/reaction requests from the
  app-mention worker bridge fail closed.

Audit rule:

- A prompt may mention a tool only if the current runtime has a
  reachable execution path for that tool in that entry point.
- If the runtime is a command-provider without native function calls,
  add an explicit bridge protocol or do not list the tool as available.
- "The old prompt says call slack_api" is not parity evidence unless
  the new entry point can prove an equivalent call reaches a dispatcher.

Reference audit: `notes/cueboard-function-audit/worker-interactive-tool-loop-parity-audit-2026-05-19.md`.

## Scanner entry parity is its own contract (worked example, task #224)

The app-mention parity sweep did not prove automatic triage parity.
Cueboard's scanner was a separate entry:

- Slack history/event buffer produced a `=== Slack Activity ===`
  digest with message refs.
- A hidden planner session received workspace memory hints, previous
  triage context, and planner tools.
- The scanner advanced cursors only after triage completed
  successfully.

The Go rewrite has the same shape, but this needed an entry-level
fixture rather than trust by module inspection. Task #224 added a
scanner-history fixture that starts from a Slack Web API history poll
and asserts the runner prompt/context includes:

- the scanner digest ref (`ref:m1`);
- relevant local workspace memory;
- previous triage context;
- planner session capabilities with `slack_api`,
  `followup_memory`, and `person_memory`;
- exclusion of assistant-only image/audio tools.

Audit rule:

- Do not let an app-mention canary stand in for automatic scanner
  triage. They are different entries with different freshness,
  memory, and compensation paths.
- If an old behavior was scheduled / scanner-driven, the new fixture
  must start from the scanner or scheduler entry, not from the helper
  function behind it.

Reference audit: `notes/cueboard-function-audit/triage-scanner-entry-parity-audit-2026-05-19.md`.

## Turn sync must start as reviewable Memory, not silent truth (worked example, task #230)

Hermes Memory providers treat user/assistant turns as a first-class
Memory event:

- `mem0.sync_turn` sends the turn to the backend for server-side fact
  extraction.
- `supermemory.sync_turn` captures cleaned user/assistant turns as
  conversation-turn Memory.
- `byterover.sync_turn` curates substantive turns in the background.

Cueboard's old Slack Agent D did not expose the same generic provider
hook, but it did have a self-growth loop:

- detect self-growth / feedback signals from user text + transcript;
- cluster those signals;
- write lesson candidates and self-growth Memory blocks only when
  the cluster is eligible.

The porting trap is to hear "auto-extraction" and immediately write
new stable Memory facts. That would create a new quality failure:
assistant phrasing and unverified inference would become durable
truth.

Task #230 makes the safer contract:

- `slackMemoryProviderManager.SyncTurn` routes non-empty turns to
  initialized providers;
- Slack worker result turns call `SyncTurn` after successful Slack
  or Canvas delivery;
- the default `turn_extractor` provider writes **reviewable**
  candidate Markdown under `memory/extractions/candidates/...`;
- the candidate file carries source turn, assistant turn, metadata,
  redaction count, and review guidance;
- it does not auto-promote facts into stable people/project/team
  Memory.

Audit rule:

- A turn-ingestion provider may persist source material immediately,
  but high-confidence Memory promotion needs either explicit
  `memory_write`, a trusted backend with visible provenance, or a
  review/quality gate.
- Auto-extraction should be fixture-pinned at two layers: hook
  routing (`SyncTurn` fired) and candidate safety (`review_candidate`
  written, not stable Memory silently mutated).
- The moment marker/intent lists decide what counts as a Memory turn,
  they join the Class 2 routing keyword externalization queue.

Reference audit: `notes/cueboard-function-audit/memory-auto-extraction-parity-audit-2026-05-19.md`.

## Entity graph parity starts with negative relationships too (worked example, task #231)

The Cumora / yetone / Isoform / Alma case exposed a subtle Memory
quality requirement: entity recall is not just "find all names in the
same paragraph." The **negative** relationship matters too. If the
system remembers yetone and Alma but drops "Cumora is not related to
Alma," it can synthesize the wrong attribution with high confidence.

The reference implementations show two tiers:

- Cueboard projected identity notes and team memory into flat
  `memory/people/*.md` profiles and exposed them through
  `person_memory`.
- Hermes Hindsight / Holographic models entities, fact/entity links,
  structural retrieval, and trust.

Task #231 ports the first local graph slice:

- `entity_graph` is a Memory provider that scans workspace Memory
  and emits relationship evidence through `SearchRelatedMemory`;
- it expands bounded multi-hop context (Cumora -> yetone -> Isoform);
- it preserves `not_related_to` as an explicit predicate;
- case_005 asserts positive relationships and the negative Alma
  disambiguation.

Audit rule:

- Entity Memory fixtures must include both positive and negative
  relationship anchors when production quality depends on
  disambiguation.
- A graph provider may start as a source-cited local relationship
  emitter; do not overbuild a graph database before the contract
  fixture demands trust, contradiction, or merge UI.
- If a query asks "A 与 B 有没有关系", the canary should prove both
  "yes" and "no" answers can be sourced.

Reference audit: `notes/cueboard-function-audit/entity-graph-memory-parity-audit-2026-05-19.md`.

## Multimodal evidence is Memory, but content boundaries must survive (worked example, task #233)

File/image/video/PDF requests exposed a different Memory trap:
attachment evidence can be first-class for the current answer, then
evaporate before the next related question. If the worker saw
`bridge_cold_open_montage_v15.mp4` today but Memory cannot recall it
tomorrow, multimodal context is prompt garnish, not durable Memory.

Cueboard's old Slack Agent D set the content boundary correctly:

- `slack.fetchImage` could fetch images by `file_id`;
- non-image files returned "Content cannot be viewed";
- defaults told the worker to fetch Slack images only when relevant.

Task #233 ports that boundary into Memory:

- `slack_file_context` app-mention evidence writes a reviewable
  `memory/multimodal/candidates/...` file;
- worker-requested reader evidence (for example `slack.fetchImage`
  or canvas fetch) is also eligible for the same candidate path;
- `multimodal_memory` provider searches those candidates through
  `SearchRelatedMemory`;
- inline payloads such as `base64` and `data:image/...` are redacted
  before persistence;
- case_006 asserts video/PDF metadata is searchable while the
  "not decoded" boundary remains visible.

Audit rule:

- Treat reader/tool output as Memory source material when it affects
  a user-visible answer.
- Never promote binary/media content into Memory as if it had been
  understood unless a reader produced an explicit summary.
- Multimodal Memory fixtures must assert both positive recall
  anchors (file/title/project) and negative boundary anchors
  ("video/binary contents are not decoded").

Reference audit: `notes/cueboard-function-audit/multimodal-memory-ingestion-parity-audit-2026-05-19.md`.

## No-action traces are not answer evidence (worked example, task #235)

The quota reset case showed a self-reinforcing Memory failure:
Oneesama skipped a direct question, then the skip itself became a
high-overlap `triage_projection` Memory record. On the next search,
"we skipped this" could outrank the imported team fact that actually
answered the user.

The production shape was:

- user asked `没付费的用户 reset quota 了吗`;
- old Bridge answered from meeting/team Memory;
- new Oneesama saw the message but classified it as out of scope;
- the digest-level Memory query included stale context about `bridge`
  and `apple watch`;
- the no-action triage projection competed with the real meeting 84
  fact.

Task #235 fixes the contract:

- scanner triage searches Memory from the fresh message text/files,
  not the full low-context expansion digest;
- no-action / skip / stay-silent triage projections are suppressed as
  local-memory and related-memory evidence;
- local Memory keyword extraction uses the same CJK / mixed-language
  token expansion as related Memory, so Chinese questions can match
  stored facts phrased with slightly different word boundaries;
- source-cited team facts and meeting memories get a narrow boost for
  quota/reset/user questions;
- the fixture asserts meeting 84 wins over stale digest context and
  the bad no-action projection.

Audit rule:

- Triage projections are useful history only when they carry a real
  action, decision, or unresolved follow-up. A "no action" projection
  must not become evidence for why a later identical question should
  be skipped again.
- For low-context scanner messages, separate **fresh user ask** from
  **channel expansion context**. Use the fresh ask for Memory
  retrieval and the expansion only for conversational disambiguation.

Reference audit: `notes/cueboard-function-audit/triage-memory-question-parity-audit-2026-05-19.md`.

## Mutation-rate parity catches healthy-but-timid migrations (worked example, task #237)

The old-vs-new triage sweep showed a product regression that health
checks and entry-shape canaries missed:

- old Slack Agent D had 8 mutation runs in today's window;
- new Oneesama had 2 mutation runs, both live-positive probes;
- the system was green, but automatic triage had become materially
  more timid.

Two failure modes combined:

- Pi foreground `stay_silent` dropped already-filtered runner
  candidate replies, so useful one-fact replies disappeared.
- The scanner prompt did not explicitly include casual-but-factual
  current-events questions as synthesis-eligible, even though old
  Slack Agent D answered these lightly after search.

Task #237 fixes the first production contract slice:

- already-filtered runner direct-reply actions are injected into the
  Pi persona request as `triage_candidate_actions`;
- Go must not execute those candidate replies directly after Pi
  returns `stay_silent`; Pi remains the only owner of foreground
  visible replies;
- if the user addressed another bot identity, those actions have
  already been filtered to empty, so new Oneesama still does not
  hijack old Bridge traffic;
- persona requests now include the concrete candidate action text,
  so Pi can approve or override the actual vetted action instead of
  re-inferring intent from a count;
- the scanner prompt explicitly treats fresh factual/current-events
  questions as lightweight synthesis candidates after tool
  verification.

Audit rule:

- Compare old and new mutation rates by entry point, not only final
  health status. A migration can be "all green" while no longer
  speaking when the old agent did.
- Every old mutating run should be classified as: should-port,
  product-decision-not-to-port, or out-of-scope. Do not average them
  away.
- Old bot identity traffic is a benchmark for quality, not traffic to
  intercept, unless the product explicitly retires that identity.
- Never fix silence by bypassing the foreground persona. Preserve
  candidate evidence for Pi, then tune Pi/persona behavior if the
  candidate should become visible.

Reference audit: `notes/cueboard-function-audit/triage-log-delta-sweep-2026-05-19.md`.

## Candidate-generator as cognition in main path (new drift pattern, task #237 cleanup)

After Pi foreground cutover (`adc0182` 2026-05-18 18:30 SHA), the
`StartSlackTriage` path still unconditionally calls
`s.runner.StartTask` (Codex agent runner) to produce a
`SlackTriageDecision` with `actions[]`. Persona shadow / foreground
then runs AFTER Codex, taking Codex's decision as input and
"refining" it. This looks like Pi-foreground but is in fact:

```
Slack event → Codex (candidate decision) → Pi (review/replace) → execute
```

not the intended:

```
Slack event → Pi (decide) → if delegate_worker: Codex (worker) → execute
```

The drift was caught at 17:28 SHA when driver started cleaning the
worker tool bridge: removing direct Codex-publishes-to-Slack was
correct, but keeping "Codex produces reply candidate for Pi to look
at" was the same drift in a quieter form.

The product semantics:

- Foreground decision owner = whoever makes the "reply / stay_silent /
  delegate_worker" call. If Codex runs at all before that decision is
  made, the decision owner is still partly Codex.
- "Candidate for Pi to review" is identical in shape to "Codex runs
  the foreground." The handoff disguise does not change which model
  shaped the visible reply space.
- Migration is complete only when the foreground entry point can be
  cold-started with Codex offline and the only observable difference
  is that `delegate_worker` decisions fall back / fail.

Audit rule for future migrations:

- Before any "decision_layer = NewModel" cutover ships, instrument the
  foreground path with a count of OldModel invocations per decision.
  Expectation post-cutover is zero OldModel invocations on the
  foreground path unless `decision = delegate_worker`.
- Acceptance fixture: simulate a Slack event end-to-end with an
  injection that errors any direct OldModel call; the test must still
  succeed (Pi decides + Slack reply lands) because OldModel was not
  on the foreground path.
- Code-side anchor: every call site of `s.runner.StartTask` should
  document in a comment which layer it serves (foreground decision,
  delegated worker, scanner compaction, etc.). Drift returns the
  moment a new caller adds another foreground-flavored invocation.

Symptoms that catch this drift:

- New decision-owner code takes an `OldModelDecision` parameter "for
  reference."
- Persona shadow / foreground takes Codex's `SlackTriageDecision`
  as input and "refines" it — this is the canonical shape.
- Audit shows healthy Pi foreground stats AND simultaneous Codex
  runner stats with the same time signature — both ran for the same
  event.
- Live `MAB_AGENT_RUNNER=disabled` (or equivalent) breaks foreground
  replies even when Pi is healthy.

Scope distinction:

- shape ≠ contract = surface matched, semantics missed.
- re-derive vs port = reasoned from scratch instead of reading old
  code.
- identity migration ≠ traffic interception = audited a real signal
  (old identity has traffic) but conflated it with inherited-traffic
  responsibility.
- candidate-generator as cognition in main path = decommissioned the
  visible output of the old model but kept its cognition silently
  shaping the new model's input space.

This is now a first-class drift class on this page.

### Worked example: foreground triage path cleanup (task #237)

What got read:

- `internal/slackagent/service_triage.go:1055` — `StartSlackTriage`
  unconditionally calls `s.runner.StartTask`.
- `internal/slackagent/persona_shadow.go:130` —
  `queueSlackTriagePersonaForeground` takes `decision
  SlackTriageDecision` as a parameter, runs Pi AFTER Codex's
  decision.

What got assumed (wrong) earlier today:

- Driver's first Pi cutover commit removed Codex-publishes-to-Slack
  but kept Codex-produces-decision-for-Pi-to-review. That is the same
  drift in a quieter form.

What Peng said at 17:29 SHA:

- "你们应该需要清理一下实现，太乱了现在."
- Pi handles most triage directly; Codex only runs on explicit
  `delegate_worker`; the foreground path must not have Codex baked
  in.

What the cleanup looks like (driver in flight as of this doc):

- `StartSlackTriage` must reach Pi first.
- Pi's response with `decision = reply` executes its own actions
  via `slackPersonaForegroundActions` directly.
- Only when Pi returns `decision = delegate_worker` does the service
  start a Codex job, scoped to the requested worker task.
- Codex never runs as part of "produce a candidate for Pi to look
  at."

Why this is the worked example:

- The previous Pi cutover audit (`#200` / `#205` / `adc0182`) called
  the path "Pi foreground" while Pi was actually downstream of Codex
  per event. The audit had no fixture that errored if Codex ran on
  the foreground path. Adding that fixture is the durable fix; the
  cleanup ship is the immediate fix.

## Workspace preference as universal model behavior (new drift pattern, 2026-05-19 evening)

Today's incident (`92b8ddb` then driver's #238 sweep that became
`ad070ec` / `4ab81a6` / `9359251`) surfaced a drift class distinct
from the previous five on this page. The pattern is:

**A team's product preference is encoded as the model's universal
behavior.**

Concrete shape on 2026-05-19:

- Peng observed Pi declining to comment on antirez's AI-agent
  article in `C09L0TAN31T:1779192707778889`. Pi's scope was too
  narrow for the Bridge team's needs.
- First fix (`92b8ddb fix(persona): treat product-adjacent articles
  as in scope`) widened Pi's universal scope to include AI-agent /
  coding tools / Memory / Bridge-like products.
- Second fix (`76c1165 docs(persona): scope product article policy
  to workspace`) scoped the prompt to "Oneesama/Bridge workspace"
  but kept the topic list hardcoded inside the Pi prompt.
- Peng corrected: "应该这个作为每个 workspace 自定义的 triage 行为."
- Third fix (`ad070ec` / `4ab81a6` / `9359251` / supervisor sweep
  audit `16fcedf`) externalized the policy: Pi prompt now reads
  `workspace_triage_policy` from request context; Go side injects
  per-workspace policy; same Pi binary deployed to two workspaces
  can produce different engagement decisions purely from policy
  diff.

Why this is its own drift class:

- shape ≠ contract = surface matched, semantics missed.
- re-derive vs port = reasoned from scratch instead of reading old
  code.
- runtime traces as memory = audited the wrong universe of
  artefacts.
- identity migration ≠ traffic interception = audited a real signal
  (old identity has traffic) but conflated identity ownership with
  inherited-traffic responsibility.
- candidate-generator as cognition in main path = OldModel hidden
  in new decision path.
- **workspace preference as universal model behavior** (this class):
  one deployment's product policy encoded into the universal model
  layer.

Symptoms that catch this drift:

- The same fix request would not be appropriate for a different
  workspace deployment (sales team, support team, research lab).
- The fix touches universal prompt content or model code rather
  than per-deployment configuration.
- After the fix ships, the model behaves Bridge-flavored for any
  new deployment.
- The Pi prompt contains the literal name of a specific workspace
  or product line.

Audit rule for future migrations:

- Before any prompt or runtime edit that widens "what counts as in
  scope" or "what topics matter," answer in writing: "would this
  change be appropriate for a sales team Slack? a customer support
  Slack? a research lab Slack?" If the answer is "not all," the
  edit belongs in workspace configuration, not universal model
  prompt.
- Acceptance fixture: deploy the same Pi binary with two different
  workspace policies; the same input must produce different
  engagement decisions purely from the policy diff. Anchor:
  `case_NNN_workspace_policy_engagement` (proposed in
  `bridge_quality_fixtures` once Phase 2 of the Pi-first RFC ships
  and the policy is reachable at the fixture layer).

Scope distinction from previous classes:

- candidate-generator = OldModel still running in main path under
  new name.
- workspace preference = one deployment's product policy encoded
  in the universal model layer.

Scope distinction from Class 2 routing keywords (#199 polish queue):

- Class 2 routing keyword = "what input shape needs which evidence
  emitter," universal to all deployments, externalized to templates
  for code-hygiene reasons.
- Workspace preference = "what topics this workspace cares about,"
  per-deployment, externalized to workspace config for product
  reasons.
- Both end up as configurable, but the configuration scope and
  authoring audience differ.

This is now the 6th first-class drift class on this page.

### Worked example: 92b8ddb → 9359251 policy externalization

What got read:

- Pi sidecar prompt (pre-fix): hardcoded list of "in-scope" topics
  in the Pi universal prompt body.
- Go cueboard triage prompts, legacy TS prompt, shared-link
  deterministic fallback: hardcoded "office helper / cold-link
  weak-invitation" preferences in universal templates.

What got shipped wrong twice:

1. `92b8ddb`: widened Pi's universal scope. The widening was correct
   for Bridge; the location was wrong (universal prompt vs workspace
   config).
2. `76c1165`: scoped the prompt to "Oneesama/Bridge workspace" via
   a comment. Still hardcoded inside the universal Pi prompt.

What Peng said:

- "应该这个作为每个 workspace 自定义的 triage 行为."

What the third pass did:

- Pi prompt: replaced the topic list with `{{workspace_triage_policy}}`
  placeholder; prompt no longer mentions any workspace name.
- Go side: introduced `WorkspaceTriagePolicy` config + plumbing
  through `persona.Request.workspace_policy`.
- Live deployment: `ONEESAMA_SLACK_TRIAGE_WORKSPACE_POLICY` env var
  carries the Bridge workspace's policy; the policy lives outside
  Pi sidecar code.
- Independent supervisor sweep (`16fcedf`) verified 0 hardcoded
  workspace name strings remain in active runtime.

Why this is the worked example:

- The first two fixes look reasonable in isolation but bake
  Bridge-specific product preferences into the universal model
  layer. The third pass is the right shape: workspace operators
  define their engagement policy; Pi consumes it via request
  context; the universal prompt is workspace-agnostic.

## Compensator without downstream-activity check (new drift pattern, 2026-05-20 morning)

Today's batch incident (`2183678` + `c8caa90` + `8bbadb8` + `4198996`
fixes for #240 / #241 / #242 / #243) surfaced a drift class distinct
from the previous six on this page. The pattern is:

**A compensator path posts based on stale state without checking
downstream assistant activity that would have resolved the original
need.**

Three concrete shapes shipped on 2026-05-20:

- **#242**: heartbeat followup mechanism added a template `:heartbeat:`
  comment to an already-handled Slack thread. Root cause: heartbeat
  surface scanned its own pending followups but never checked the
  workspace ledger to see if the original prompt had already
  produced a Bridge / Oneesama reply.
- **#243**: scanner reconciliation re-processed a successful Meet
  join as a "missed app_mention" 2 minutes after the join card had
  already posted. Root cause: `f9629fe` scanner reconciliation only
  checked `HasMentionReaction`, not "any assistant activity after
  the mention." Meet join flow uses a different reaction shape, so
  the reconciler thought the mention was still unhandled. (This is
  the production case of the edge-case flag in the 5/19 `f9629fe`
  audit at 10:56 SHA.)
- **#240**: channel brain summary cached "policy says no-action /
  pure link / not in scope" as a long-term fact. Heartbeat followup
  + future triage runs both consumed that cache. The cache was
  state from a now-superseded policy decision, but nothing
  invalidated it when the policy changed at 23:55.

Driver's named pattern from the post-incident retro (`task #240/#242/#243`
in_review):

> 任何 heartbeat/scanner/backfill 这类"补偿路径"要先查后续 assistant
> activity，不能只凭旧 pending 状态往 Slack 里补东西

The product semantics:

- A compensator path exists because the primary path can miss
  events (Socket disconnect, restart, race conditions).
- Compensator-correct: when about to post, check that the original
  need still exists (no downstream activity has resolved it).
- Compensator-drifted: post because the original pending state says
  to, even though downstream activity already handled the need.

Why this is its own drift class:

- shape ≠ contract = surface matched, semantics missed.
- re-derive vs port = reasoned from scratch instead of reading old
  code.
- runtime traces as memory = audited the wrong universe of
  artefacts.
- identity migration ≠ traffic interception = inherited old
  identity's traffic without owning it.
- candidate-generator as cognition in main path = OldModel hidden
  in new decision path.
- workspace preference as universal model behavior = one deployment's
  product policy encoded into the universal model layer.
- **compensator without downstream-activity check** (this class):
  a fallback path acts on its own pending state without verifying
  the need is still open.

Symptoms that catch this drift:

- Slack thread receives a duplicate / late / generic comment N
  seconds or minutes after the original interaction was already
  handled by another path.
- The compensator's check is anchored on its own pending ledger
  (heartbeat_followup status, scanner cursor, backfill candidate)
  rather than on workspace ledger (assistant activity in the
  thread).
- The fix consists of "check downstream activity before posting,"
  not "remove the compensator." The compensator is still useful;
  it just needs a downstream guard.
- A state cache stores policy-derived facts (no-action reasons,
  scope decisions) as if they were long-term truths.

Audit rule for future migrations:

- Every compensator path in `service_*.go` (heartbeat,
  scanner reconciliation, backfill replay, retry/followup) must
  have a written-down "downstream-activity guard" before any
  Slack-visible post.
- Every state cache that records policy-derived facts (channel
  brain, summary cache, candidate ledger) must invalidate or
  sanitize entries when the upstream policy changes.
- Acceptance fixture: simulate a successful primary path completion
  for an event, then trigger the compensator path on the same
  event; assert no duplicate or late post emits.

Scope distinction from earlier drift classes:

- candidate-generator = OldModel runs in main path producing a
  decision.
- workspace preference = one workspace's policy encoded in
  universal model layer.
- compensator without downstream-activity check = a fallback path
  acts on its own pending state without verifying downstream.

This is now a first-class drift class on this page.

### Worked example: 2026-05-20 morning batch (#240 / #241 / #242 / #243)

What got read:

- `f9629fe` scanner reconciliation: only `HasMentionReaction` check;
  no general "post-mention assistant activity" check.
- `service_heartbeat_*.go`: pending heartbeat followups; no
  cross-ledger workspace-activity check.
- Channel-brain summary cache: persisted no-action reasons as
  long-term facts.
- `bridge_quality_canary` link-commentary canary: passed if Pi
  returned `reply` to a shared link regardless of synthesis depth.

What got shipped wrong before (pre-fix state):

- Compensator paths posted based on their own pending state, with
  no downstream check.
- Channel brain accumulated stale policy reasons that survived
  policy changes.
- Canary did not require workspace Memory + multi-source synthesis,
  so headline-restatement replies passed.

What Peng / driver said on 2026-05-20:

- 09:49 SHA Peng dropped `C09L0TAN31T/1779238855102199`: "这是什么
  东西，好像不对."
- 10:07 SHA Peng dropped `C0AQ0C0KVMH/1779242470100329`: "不对劲."
- 10:19 SHA driver retro: 任何 heartbeat/scanner/backfill 这类
  "补偿路径" 要先查后续 assistant activity.

What the fix did:

- `2183678`: heartbeat followup checks workspace ledger before
  posting; successful triage auto-closes same-thread
  timeout/empty-final followups.
- `c8caa90`: scanner reconciliation checks assistant activity after
  the mention, not just `HasMentionReaction`.
- `8bbadb8`: channel brain filters and clears no-action / policy
  reasons; they no longer survive policy changes as long-term
  facts.
- `4198996`: link-commentary canary requires workspace Memory anchor
  + second-source synthesis; headline-only fails. case_009
  flipped from pending to active.

Why this is the worked example:

- All four fixes share the same drift shape: post / cache /
  validate based on local pending state without checking downstream.
- The fixes individually look surgical but collectively name the
  drift class. Each compensator now has a downstream-activity
  guard; each policy-derived cache has an invalidation path; each
  canary has a synthesis requirement.

### Deploy SOP gap discovered same morning (operational, not a drift class)

At 10:05 SHA, driver realized the live wrapper was running a stale
`./oneesama` binary from 23:00 the previous night. The wrapper
`scripts/oneesama-live.sh` did not auto-rebuild before restart, so
shipped fixes that passed `go test` were not actually running
in production until the binary was rebuilt manually.

This is an operational drift, not a code drift class. The fix
belongs in the deploy runbook: every live restart must either
`go build -o ./oneesama ./cmd/oneesama` first, or the wrapper must
fail loudly if the binary mtime predates the latest commit.

Recording here so future operators see it; not promoting as a
first-class drift class because it's a tooling SOP rather than a
code pattern.

## Drift class 8: tool surface without cognition affordance

Definition:

- The new system contains the raw tool/API operation.
- The audit marks parity green because the tool can be called.
- The old system also injected a catalog, policy, or usage surface
  into the model's decision context.
- The new system does not inject that affordance, so the capability
  exists mechanically but is rarely used naturally.

This is distinct from earlier classes:

- **prompt-as-implementation**: the prompt tells the model how to
  implement a backend operation.
- **tool surface without cognition affordance**: the backend
  operation exists, but the model lacks the old decision-time
  knowledge needed to choose it.

Symptoms:

- Tool inventory says "active", but production behavior almost never
  uses it.
- The old system had startup caches, workspace catalogs, prompt
  sections, policy snippets, or examples that are absent in the new
  system.
- Fixing the tool executor alone does not change visible behavior;
  the fix has to move context into the cognition surface and add an
  output action path.

Audit rule:

- Tool parity checks must cover three layers:
  1. backend executor,
  2. cognition affordance / prompt context,
  3. visible action path.
- A migrated tool is not "done" until all three are covered or the
  missing layers are explicitly declared out of scope.

### Worked example: 2026-05-20 custom emoji reaction triage

What got read:

- Old Cueboard `bridge.go:76-77`: cached `customEmoji []string`.
- Old Cueboard `bridge.go:668-685`: startup `emoji.list` refresh,
  alias filtering, and loaded-count log.
- Old Cueboard `bridge.go:478-482`: custom emoji catalog appended
  to the assistant system prompt.
- Old Cueboard `scanner_triage.go:112-116`: same catalog appended to
  scanner triage prompt.
- Old Cueboard `slack_api_tool.go` / `slack_api_tool_messages.go`:
  `add_reaction` and `list_emoji` tool surfaces.

What got shipped wrong before:

- New Oneesama had `add_reaction` and `list_emoji`, but no startup
  workspace custom emoji cache.
- Pi / triage prompts did not receive `## Workspace custom emoji`.
- Persona decisions had no first-class `react` output shape.
- Direct triage execution could not turn a Pi reaction decision into
  `reactions.add` without pretending it was a text reply.

What Peng said on 2026-05-20:

- "cueboard slackd还会用到emoji去回应某些发在Slock里面的消息来着，
  甚至都会使用当前Workspace自己上传的那些。但是我们新的有做吗？"
- "不需要考虑工作量，做得越好越好。而且现在好像 oneesama 不太会去用
  这些表情? 这个应该就是 triage 的一种，能来对一些消息做回应"
- "反思一下，为什么这个能力没迁移到？"

What the fix did:

- Added workspace custom emoji startup refresh/cache/status.
- Injected the cached custom emoji catalog into triage prompts and
  Pi persona request context.
- Added persona `decision=react` and `reactions[]`, gated by
  `allow_reactions`.
- Converted persona reaction decisions into direct `add_reaction`
  triage actions.
- Made cached custom emoji available through `list_emoji`.

Why this is the worked example:

- The original audit failed because it treated a tool list as a
  behavior contract.
- The actual contract was "the model knows the workspace emoji
  catalog before deciding and can use reaction as a triage response."
- This is now a first-class audit rule for future tool migrations.

## Where this file sits

`migration-lessons.md` is the canonical gates + Definition of Done.
This file is the v1 audit author's evidence-cited reflection on why
the audit method she produced failed. Future migrations should read
the canonical doc first; this file is for understanding the
historical failure modes, not for enforcing the new rules.
