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

## Where this file sits

`migration-lessons.md` is the canonical gates + Definition of Done.
This file is the v1 audit author's evidence-cited reflection on why
the audit method she produced failed. Future migrations should read
the canonical doc first; this file is for understanding the
historical failure modes, not for enforcing the new rules.
