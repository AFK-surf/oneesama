# Cueboard → Oneesama Migration Lessons

This document is the migration guardrail checklist for porting Cueboard behavior
into Oneesama. It is intentionally operational: future agents should use it
before claiming migration work, while reviewing code, and before moving a task
to `in_review`.

The core lesson from the migration incidents is simple:

> Do not port function shape and then infer the product. First name the old
> product contract, then make the new implementation prove it.

## What Actually Went Wrong

The migration failure was not only a collection of isolated bugs. The deeper
failure mode was that "function-by-function migration" turned into
"function-by-function inventory plus approximate reimplementation".

The audit work did enumerate functions, but too many rows stopped at
`partial`, `drift`, or "similar helper exists" without forcing the new runtime
to prove the old behavior. That allowed agents to ship plausible Go code that
matched the names and rough shapes of Cueboard functions, while missing hidden
contracts carried by timing, persisted state, old config defaults, Slack social
etiquette, and production entrypoints.

The main ways this happened:

1. **Inventory became backlog, not acceptance.**
   Function rows often recorded `missing` / `partial` / `drift` correctly, but
   a later implementation was allowed to close the gap without pointing back to
   the exact row, the old behavior, and a regression test. The row proved we had
   looked; it did not prove we had preserved behavior.

2. **Tests did not migrate with the behavior.**
   New tests usually covered the new helper's happy path. They often did not
   reproduce the old Cueboard race, restart, timeout, stale-state, output
   artifact, or social-timing scenario. A test named after the new function is
   weaker than a test named after the old product contract.

3. **Direct/manual paths were mistaken for full parity.**
   Meeting direct join worked, but Calendar-driven approval scanning was absent.
   Follow-up write APIs existed, but heartbeat tickers and startup
   normalization were absent. Canvas publishing existed internally, but generic
   tool exposure and fetch/edit/read surfaces were missing or unavailable.

4. **State and loops were split apart.**
   Cueboard behavior often came from a pair: store + ticker, pending row +
   cleanup, scanner cursor + restart recovery, active thread case + scanner
   suppression. Porting only the data structure or only the helper produced fake
   parity.

5. **Runtime protocols were treated as ordinary code.**
   Slack Socket Mode ack deadlines, stdout JSON-RPC, `response_url` behavior,
   child-process env export, Slack 429 semantics, Slack file auth, and ffmpeg /
   recorder artifacts are protocols. Approximate code that compiles is not
   enough at those boundaries.

6. **Old defaults and normalizers were invisible.**
   Cueboard had implicit contracts in YAML strictness, env variable names and
   units, Slack message normalization, bot/user detection, timestamps, and
   field aliases. Rewriting in Go changed defaults unless the contract was
   explicitly locked.

7. **Model/prompt behavior was treated as "soft" and therefore under-tested.**
   Link synthesis, delayed no-reply, wait-for-human, stale direct replies, and
   "read an article and give a light opinion" are product behavior, not just
   prompt taste. They need canaries, replay/backfill, and examples from real
   Slack history.

8. **Real-environment acceptance arrived too late.**
   Peng's simple dogfood repeatedly crossed six or more layers at once: Meet
   DOM/captions, recorder artifacts, ASR/summary, Slack upload, Canvas format,
   and thread notification. Earlier tests proved pieces could run, but did not
   prove that the delivered artifact looked and behaved like Cueboard.

9. **Marathon throughput hid review depth problems.**
   A long run of commits can close many obvious gaps quickly, but it also makes
   it easy to accept "shape looks right" patches. The exact failure mode is
   especially bad for migrations: reviewers get tired of asking whether every
   old edge behavior was proven.

## Historical Signals Re-read For This Retrospective

This section exists because the failure pattern was visible before the latest
incidents. The project had already produced multiple warnings that "green" did
not mean "Cueboard behavior preserved".

| Date / source                                     | Signal                                                                                                                                                                                                       | What it should have changed immediately                                                                                                                                                             |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-05-11 Slack migration thread                 | The work was described as "搬运优先、薄适配", but implementation still added new seams and approximations.                                                                                                   | Every patch should have identified which Cueboard function/test was copied, adapted, or intentionally excluded.                                                                                     |
| 2026-05-13 `notes/oneesama-go-parity-audit-v2.md` | Route matrix showed many `❌ missing` and `⚠ partial` Slack/meeting surfaces, including rich mention context, runtime loops, worker reporting, pending actions, scanner/followups, and meet/chat surfaces.   | The route matrix should have become acceptance gates. No route should move from missing/partial without caller coverage and behavior tests.                                                         |
| 2026-05-13 `notes/oneesama-replacement-gate.md`   | Replacement gate named concrete Cueboard contracts across Slack events, interactivity, tools, rendering, intelligence loops, meeting control plane, meetd config/API/store/runtime, and oneesama extensions. | Each gate should have had an owner, status, and evidence column tied to tests and live dogfood.                                                                                                     |
| 2026-05-14 Peng dogfood of meeting summary        | A simple real meeting test exposed wrong Canvas content, inline transcript instead of file, missing audio, and bad key points.                                                                               | "Summary appeared" should never again count as success. Release gate must check delivered artifacts: transcript file, audio file, Canvas format, thread notification, and semantic summary quality. |
| 2026-05-14 follow-up question                     | Peng asked whether discovered issues were added to tests. Some were, but the response still separated "unit-testable" from "real environment" too loosely.                                                   | Every real dogfood bug needs either a regression test, a replay fixture, a golden artifact, or a named live-only gate.                                                                              |
| 2026-05-17 function audit launch                  | The team created #162-#171 for function-level audit, but early progress reports celebrated task count and docs before implementation evidence.                                                               | Audit docs must not be mistaken for parity. They are only useful when every gap is driven into a patch, test, or explicit exclusion.                                                                |
| 2026-05-17 #171 consolidation                     | Consolidation correctly found themes: state durability, duplicate/unsafe Slack behavior, pending-action/heartbeat loops, meeting automation, and capability surfaces.                                        | Those themes should have become migration gate categories earlier, before a marathon of small fixes.                                                                                                |

The uncomfortable conclusion: Peng had already asked for the right method
multiple times. The team often acknowledged it in words, but the enforcement was
too weak. Future migrations must make the method mechanical enough that an agent
cannot "agree" and then continue shipping approximate behavior.

## Incidents That Shaped This Checklist

| Area                                         | What broke                                                                               | Root cause                                                                                                                                              | Guardrail now required                                                                                                    |
| -------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Slack triage timing / task #187              | oneesama replied "link 404 / need context" after a human had already answered.           | Cueboard's 5 minute "wait for humans" social contract was treated as a buffer implementation detail; direct `post_thread_reply` had no freshness check. | Event buffer default is 5m; direct replies re-check thread freshness; tests cover newer human activity.                   |
| Socket Mode join button / task #181          | First click looked like no response.                                                     | Handler posted to `response_url` before acking the Socket Mode envelope, violating Slack's 3s ack contract.                                             | Slow interaction work goes through an ack-first helper; latency tests guard the boundary.                                 |
| meet-runner JSON-RPC / task #182             | join failed because `console.log` polluted stdout.                                       | meet-runner stdout is the JSON-RPC protocol channel, but code treated it as normal logs.                                                                | stdout discipline is documented/tested; diagnostics go to stderr; decoder skips non-JSON defensively.                     |
| live triage token outage / task #176/#183    | 6h of triage silently failed after restart because provider token was not exported.      | Restart sourced env files without a robust export/preflight contract; audit flags did not scream on real failures.                                      | live wrapper sources env with allexport, preflights required provider env, runtime audit has red `real_outcome_failures`. |
| scanner state / task #168                    | scanner restart could replay or miss work because cursors were in-memory.                | Cueboard's durable state tables were recognized as data structures but not as restart safety contracts.                                                 | Cursor/channel/thread-case persistence is required before scanner/ownership changes.                                      |
| mention/scanner overlap / task #163/#164     | scanner could triage inside a mention-owned thread.                                      | active thread ownership was not ported into live paths.                                                                                                 | mention queue, thread cases, active-thread guard, and scanner suppression must land together.                             |
| tool parity / task #165                      | tools looked active but were validation-only or unavailable.                             | parity reports described registration, not runtime behavior.                                                                                            | parity status must mean runtime truth: `active`, `validation_only`, `registered_unavailable`, or `product_excluded`.      |
| heartbeat/self-growth / task #166            | follow-ups were persisted but not surfaced.                                              | delivery loop and startup normalization were not included in the port.                                                                                  | every persistence feature needs a production surfacing path, ticker, status, and cleanup story.                           |
| Slack file/Canvas/image surfaces / task #167 | active upload path lacked safety; Canvas/image tools were partially exposed.             | safety and capability boundaries were not bundled with the feature.                                                                                     | user-visible mutations require path guards, confirmation/dedupe where needed, ledger, and tests.                          |
| Calendar scanner / task #169                 | scheduled meeting approval was absent despite direct join working.                       | direct/manual path was mistaken for feature parity.                                                                                                     | migration must cover all entrypoints: manual, scheduled, background scanner, status, and disabled reason.                 |
| backfill/no-reply / tasks #184-#186          | "shared link nobody responds to" and "waited for human but nobody replied" were missing. | old behavior was a social workflow, not just a triage prompt rule.                                                                                      | add explicit canaries/backfill reports for weak invitations, delayed no-reply, and high-info links.                       |

## Broader Drift Inventory

This table is intentionally wider than the recent incidents. It records the
classes of Cueboard behavior that were missed or weakened during the migration.
Future migration work should check every row before claiming parity.

| Drift class                       | Examples observed during audit / dogfood                                                                                                                                  | Why it matters                                                                                            | Required proof                                                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Scanner ownership and suppression | scanner triage could run inside mention-owned threads; mention queue helpers existed but live handler bypassed them; active-thread guard callback was dormant.            | Bot can duplicate itself or answer while another owner is already handling the thread.                    | mention queue, thread-case lifecycle, active-thread guard, scanner suppression, and tests for duplicate mention + scanner overlap.      |
| Triage social timing              | 5m wait-for-human behavior became 30s; direct replies did not re-check freshness; link/article synthesis initially had no delayed no-reply path.                          | oneesama answers too fast, looks socially clumsy, or replies after a human already answered.              | debounce contract test, stale direct reply test, delayed no-reply follow-up test, replay/backfill report.                               |
| Tool truth vs registration        | `suggest_action` looked active but was validation-only; unavailable Canvas/image/DM actions looked like generic failures; `usage_api` was a stub.                         | Model and operators trust a tool surface that cannot actually perform the side effect.                    | parity matrix with four statuses and runtime tests for active/unavailable/product-excluded paths.                                       |
| Slack mutation side effects       | public thread replies lacked centralized ledger in some paths; pending cards were not updated on confirm/dismiss; `add_reaction` could not resolve digest refs.           | State, audit, and duplicate suppression drift from actual Slack behavior.                                 | ledger tests, card-state tests, digest-ref tests, idempotency tests.                                                                    |
| Persistence and restart safety    | scanner cursors were in-memory; channel/membership/thread-case tables were absent; recommendation/action cleanup was partial.                                             | Restart changes behavior, replays work, loses ownership, or forgets pending actions.                      | typed store exists, live writes/reads exist, restart-oriented test or status evidence exists.                                           |
| Heartbeat and follow-up loops     | follow-up primitives existed but `Service.Start` had no ticker; pending-action/commitment/meeting-action hooks were missing; startup normalization was absent.            | The bot records promises but never surfaces them, or accumulates duplicate/stale follow-ups.              | ticker, enqueue hooks, startup prime/normalize, status counters, tests for open/closed follow-up lifecycle.                             |
| Meeting output fidelity           | Canvas format initially looked wrong; transcript was inline instead of a Slack file; audio artifact was missing; key points were low quality.                             | A "successful summary" that does not match Cueboard's delivered artifact is still a user-visible failure. | golden-style Canvas sections, `transcript.txt` file card, `audio.mp3` file card, thread notification, and real/fake audio dogfood gate. |
| Meeting automation                | manual join path existed but Calendar scanner, approval anchor, linked thread lookup, ASR chunking, and official API fallback were missing/deferred.                      | Direct demo works but real meeting workflow is not preserved.                                             | scheduled scanner test, real Slack root anchor test, fail-closed status, long recording ASR plan/test.                                  |
| Rendering and content ingestion   | upload path safety was absent; Canvas fetch/create/edit were unavailable or internal-only; image fetch missing; Canvas markdown fallback missing; safe Block Kit missing. | The assistant cannot read/write real Slack artifacts safely, or exposes unsafe file/content paths.        | path guards, read-only fetch tests, confirmation flow for writes, sanitize/retry tests, block allowlist tests.                          |
| Runtime/config/ops                | backend auth probe was dead code; provider env missing after restart; YAML strict unknown-field behavior was lost; runtime status was raw and not operator-readable.      | Operators get false green starts and weak alerts; broken live service looks quiet.                        | startup preflight, runtime red flags, restart wrapper, strict config tests, human-readable status.                                      |
| Normalization and codec defaults  | snake_case fields were not normalized at CLI/API boundary; `subtype=bot_message` not recognized; Go JSON/YAML defaults differ from JS/Cueboard behavior.                  | Same Slack event behaves differently depending on caller or language defaults.                            | normalization inside public API, bot/user subtype tests, strict codec/default tests.                                                    |
| Git/agent workflow                | parallel marathon commits caused index/reset hazards; broad changes were reviewed for syntax more than contract preservation.                                             | Correct patches can be mixed, lost, or reviewed shallowly.                                                | fetch-before-commit discipline, small scopes, explicit contract checkpoint per patch.                                                   |

## Non-Negotiable Migration Gates

Every Cueboard → Oneesama migration slice must pass these gates before
`in_review`.

### Gate 0: Function Rows Must Close With Evidence

An audit row is not closed because a new helper exists. It is closed only when
the row links to behavior evidence.

Checklist:

- Each Cueboard function row has a status, Oneesama target, and evidence.
- `partial`, `drift`, and `missing` rows have either a follow-up task or a
  product-excluded decision.
- A row changed to covered includes a commit SHA and at least one of:
  - a regression test named after the old behavior;
  - a replay/backfill output proving the behavior on real recent data;
  - a live dogfood result with the exact observed Slack/thread/process state.
- The reviewer can answer: "What would fail if Cueboard's original behavior
  disappeared again?"

Bad evidence:

- "Equivalent helper exists."
- "Looks similar."
- "Compiles."
- "Prompt should handle it."

### Gate 1: Name The Product Contract

Before porting code, write the user-facing contract in the task thread or audit
row.

Examples:

- Scanner debounce = "wait long enough for humans to answer before the bot
  speaks".
- `suggest_action` = "show a confirmation card, persist the pending action,
  and follow up if nobody decides".
- Calendar scanner = "notice upcoming meetings and ask in Slack before joining".
- Canvas create/edit = "write only after explicit confirmation and leave an
  audit trail".

Acceptance:

- The test name should describe the contract, not just the function name.
- If the contract is timing-sensitive, the test must simulate the race.
- If the contract was previously implicit, make it explicit in the audit row.
- If the old runtime normalized input at ingress, the new exported/public API
  must do that normalization internally instead of trusting every caller.

### Gate 2: Migrate Configuration By Behavior

Old and new config must be compared by semantics, not by string similarity.

Checklist:

- Record old key(s), new key(s), old default, new default, old unit, new unit.
- Decide whether old keys are supported or intentionally ignored.
- Add a test for the chosen behavior.
- Update live env/runbook to canonical new keys.
- Check live process env after restart.
- Verify codec defaults: strict unknown fields, number precision, null handling,
  timezone parsing, map/field ordering assumptions, and timestamp units.

Do not leave stale old env names around if the new binary does not read them.
They create false confidence.

### Gate 3: Preserve Protocol Boundaries

Protocol streams and ack budgets are APIs.

Known boundaries:

- Slack Socket Mode: ack first; slow work must be async.
- Slack interaction `response_url`: never block envelope ack.
- meet-runner stdout: JSON-RPC only; logs go to stderr.
- agent runner provider env: required token must be exported to child process.
- Slack Web API calls: 429 and non-OK responses must become explicit warnings
  or failures.

Checklist:

- Add a top-of-file warning near the boundary.
- Provide a helper that makes the safe path the easiest path.
- Add a regression test that fails on blocking, wrong stream, or missing env.

### Gate 4: Port Durable State With The Behavior

If Cueboard had a table/store, ask what production guarantee it provided.

Common guarantees:

- restart safety (`scanner_cursors`);
- duplicate suppression (`thread_cases`, recommendation reservations);
- ownership (`active mention thread`);
- delayed surfacing (`heartbeat_followup`);
- operator visibility (status/admin/debug endpoints).

Checklist:

- State schema or typed collection exists.
- Writes happen in the live path, not just tests.
- Reads happen in the live path after restart.
- Status/audit endpoint exposes counts or last activity.
- Cleanup/normalization exists for stale rows.
- The paired loop exists: ticker, scanner, delivery path, callback, or cleanup
  worker. A store without its loop is not parity.
- Restart behavior is checked explicitly.

### Gate 5: Re-Check Freshness Before Mutating

Any action proposed from a snapshot can become stale.

Mutation examples:

- Slack reply / reaction / edit / delete;
- pending-action card post;
- Canvas create/edit;
- meeting join;
- heartbeat follow-up post;
- delayed no-reply follow-up.

Checklist:

- Re-read the target thread/resource before posting.
- If newer human activity exists, skip with a structured reason such as
  `thread_has_newer_activity`.
- Skipped actions count as no mutation.
- The skip reason is visible in tool calls/audit, not silently swallowed.

### Gate 6: Make Capability Reports Tell The Truth

Registration is not capability.

Allowed statuses:

- `active`: tool works end-to-end in runtime.
- `validation_only`: arguments are accepted/normalized, but no side effect.
- `registered_unavailable`: route exists and returns a truthful unavailable
  error.
- `product_excluded`: intentionally not exposed.

Checklist:

- Parity endpoint status matches runtime behavior.
- Tests call the advertised path.
- Stubs and fake-green surfaces are rejected.

### Gate 7: Observability Must Scream On Real Failure

Audit dashboards should not require a human to smell smoke.

Checklist:

- Real user traffic failures are red flags.
- Synthetic probe failures are separated from real failures.
- Failure samples include a short sanitized error summary.
- Process health includes required env presence, reconnects, 429s, and newest
  run age.
- Yellow/info flags distinguish quiet windows from real brokenness.

### Gate 8: Backfill And Replay Are Part Of Migration

Old Cueboard behavior often lived in "what it did over time", not in one event.

Checklist:

- Provide a dry-run replay/backfill tool for the migrated behavior.
- Replay should classify candidates and show proposed output without posting.
- Include coverage stats: scanned channels, truncated windows, API retries,
  warnings, and persisted-state merges.
- Use real recent history before enabling auto-post.
- Backfill candidates should distinguish fresh scan, persisted state, and merged
  sources. A report must say what it did not scan.

### Gate 9: No Marathon Without Contract Checkpoints

Large agent marathons are good for throughput but bad for protocol/product
subtleties.

Checklist:

- Split broad audits from behavior patches.
- After every risky patch, name the exact contract now protected.
- Ask a second reviewer to attack races and production boundaries, not just
  syntax.
- If a bug class repeats twice, add a guardrail task immediately.
- Fetch `origin/main` before every commit in a shared marathon worktree.
- Commit only changes intentionally stacked on current `origin/main`; do not
  reset/rebase shared refs to repair local confusion.

## Function-By-Function Definition Of Done

For future migrations, "function-by-function" means this, not just an inventory
table:

1. **Inventory the function.**
   Record source file, function, line range, and category.
2. **Extract the contract.**
   Say what user-visible, operator-visible, or runtime guarantee this function
   contributed. If it is only an implementation helper, name the parent
   contract it supports.
3. **Find all callers and entrypoints.**
   Include background scanners, scheduled jobs, HTTP handlers, Slack
   interactions, CLI commands, startup hooks, and cleanup loops.
4. **Find state and config dependencies.**
   Include env keys, default values, stores, cursors, dedupe keys, timers,
   filesystem paths, and external API contracts.
5. **Port or explicitly exclude.**
   Do not leave "not needed" implicit. Write the product decision.
6. **Move old tests or write equivalent behavior tests.**
   The test should fail on the exact old/new mismatch, not just exercise the new
   helper.
7. **Run the behavior in the live-like path.**
   Use a fake Slack/Meet server, replay tool, dogfood, or dry-run report when
   unit tests cannot cover the contract.
8. **Update the audit row with evidence.**
   Add commit SHA, test name, and any remaining limitation.

If any step is skipped, the row remains `partial` or `drift`.

## Test Migration Requirements

Every migration slice needs tests in these buckets when applicable:

- **Happy path**: the intended direct behavior works.
- **Race/stale path**: humans or external systems change state before mutation.
- **Restart path**: state survives process restart or intentionally does not.
- **Protocol path**: ack deadlines, stdout/stderr streams, 429s, auth failures,
  and child-process env are handled.
- **Old config path**: old keys/defaults/units are supported or rejected with a
  clear test.
- **Normalization path**: snake_case/camelCase, Slack subtype/bot fields, and
  timestamp aliases normalize at the boundary.
- **Negative truth path**: unavailable/product-excluded tools fail honestly.
- **Replay path**: recent real history can be inspected without posting.

Tests should be named after behavior, for example:

- `TestDirectReplySkipsWhenHumanAnsweredAfterSnapshot`
- `TestSocketModeInteractionAcksBeforeResponseURLUpdate`
- `TestSessionCallSkipsStdoutLogLines`
- `TestConfigRejectsUnknownFields`
- `TestBackfillReplayTreatsBotOnlyReplyAsUnanswered`

Avoid tests whose only claim is "new function returns some value".

## Mandatory Review Questions

Ask these before merging any future migration slice:

1. What Cueboard user-visible behavior is being preserved?
2. What old config/env/state is being replaced, and with what unit/default?
3. Could a human reply or external state change make this action stale?
4. What happens after process restart?
5. Is the tool/status endpoint telling runtime truth?
6. Does a real failure become red/yellow/info correctly?
7. Is there a replay/dogfood path for the behavior?
8. Which test would fail if this exact incident came back?
9. Which function-audit row is being closed, and what evidence is attached?
10. Did the implementation cover every old caller/entrypoint, not just the
    easiest path?
11. Did the new language/runtime change any default parser, timer, map,
    timezone, process, or async behavior?

If any answer is missing, the migration is not done.

## Incident Log

### 2026-05-18: Link Synthesis Replied Twice With Low-Quality X Summary

Symptom:

- In `C09KVPBMLJ3/1779090616.617509`, oneesama posted the same link-synthesis
  reply twice about one minute apart.
- The reply quality was poor: it summarized X/Jina login/signup/trending
  boilerplate as if it were substantive content.

Root cause:

- The model explicitly returned `actions: []`, but Go finalization still
  injected a deterministic `slackTriageSharedLinkSynthesisAction` fallback
  because the message had an external-link context.
- The stale-direct-reply guard skipped bot-authored messages when deciding
  whether the thread had newer activity, so oneesama's own first reply did not
  block the second direct reply.
- The deterministic link-synthesis fallback treated low-signal social status
  pages (`x.com` / `twitter.com`) as synthesis-eligible when the reader output
  contained enough boilerplate text.

Why tests did not catch it:

- Tests covered "model chooses a direct link reply" but not "model explicitly
  says no action and fallback must not override it".
- Tests intentionally allowed bot-only activity to be ignored, which is right
  for human-answer detection but wrong for duplicate direct-reply prevention.
- No negative test existed for login-wall/social-status reader output.

New hard rules:

- Deterministic helpers may not override a parsed explicit `actions: []`.
- Before posting a direct reply, freshness must treat this bot's own newer
  thread reply as a blocking activity.
- Fetched-link synthesis must reject low-signal social status/login-wall output
  unless the model deliberately produces a reply from the fetched context.

### 2026-05-18: Backfill Replay Used Hard-Coded Generic Templates Instead Of Cueboard-Style Triage Judgment

Symptom:

- The 24h backfill report surfaced a GitHub PR review request as a "补读这条分享"
  candidate and generated a generic "this is a material worth discussing" reply.
- For a shared PDF/article, the report produced a generic link-share template
  instead of reading the linked body and giving a real lightweight opinion.
- Peng correctly pointed out that Cueboard's triage quality was higher because
  workspace-specific prompt/template behavior was part of the product, not a
  hard-coded Go fallback.

Root cause:

- The Go rewrite treated triage reply text as implementation detail (`fmt.Sprintf`
  literals in `buildDelayedNoReplySummary` and `buildSharedLinkSynthesisReply`)
  instead of a workspace behavior contract.
- Backfill replay reused the delayed-no-reply classifier/template path but did
  not reuse live triage's fetched-link synthesis path.
- "Candidate found" was presented as "Draft reply" even when the candidate only
  had a generic fallback note or persisted state without fresh thread context.

Why tests did not catch it:

- Tests asserted that a candidate was produced, not whether the reply was safe to
  post.
- There was no report-level quality gate (`review_ready`, `needs_link_read`,
  `needs_thread_refetch`) to make non-postable leads explicit.
- Migration audit looked for function coverage but did not require prompt /
  template / workspace policy parity evidence.

New hard rules:

- Prompt text, reply templates, workspace tone rules, and "when to speak" policy
  are migration contracts. They belong in templates/workspace overrides, not
  hidden Go string literals.
- Backfill reports must label candidate quality. A non-ready lead must not be
  called a "Draft reply".
- Link/article candidates must fetch and synthesize linked content before they
  can be `review_ready`; otherwise they are `needs_link_read`.
- Persisted-only followups are leads, not replies. They must be refetched before
  posting.

## Where To Record Future Lessons

- Add incident-specific rows to this file.
- Cross-link fixed gaps in the relevant module audit file.
- Update `consolidated-backlog.md` when a gap is resolved or reclassified.
- Prefer executable checks over narrative notes.
