# Cueboard → Oneesama Migration Lessons

This document is the migration guardrail checklist for porting Cueboard behavior
into Oneesama. It is intentionally operational: future agents should use it
before claiming migration work, while reviewing code, and before moving a task
to `in_review`.

The core lesson from the migration incidents is simple:

> Do not port function shape and then infer the product. First name the old
> product contract, then make the new implementation prove it.

## Incidents That Shaped This Checklist

| Area | What broke | Root cause | Guardrail now required |
| --- | --- | --- | --- |
| Slack triage timing / task #187 | oneesama replied "link 404 / need context" after a human had already answered. | Cueboard's 5 minute "wait for humans" social contract was treated as a buffer implementation detail; direct `post_thread_reply` had no freshness check. | Event buffer default is 5m; direct replies re-check thread freshness; tests cover newer human activity. |
| Socket Mode join button / task #181 | First click looked like no response. | Handler posted to `response_url` before acking the Socket Mode envelope, violating Slack's 3s ack contract. | Slow interaction work goes through an ack-first helper; latency tests guard the boundary. |
| meet-runner JSON-RPC / task #182 | join failed because `console.log` polluted stdout. | meet-runner stdout is the JSON-RPC protocol channel, but code treated it as normal logs. | stdout discipline is documented/tested; diagnostics go to stderr; decoder skips non-JSON defensively. |
| live triage token outage / task #176/#183 | 6h of triage silently failed after restart because provider token was not exported. | Restart sourced env files without a robust export/preflight contract; audit flags did not scream on real failures. | live wrapper sources env with allexport, preflights required provider env, runtime audit has red `real_outcome_failures`. |
| scanner state / task #168 | scanner restart could replay or miss work because cursors were in-memory. | Cueboard's durable state tables were recognized as data structures but not as restart safety contracts. | Cursor/channel/thread-case persistence is required before scanner/ownership changes. |
| mention/scanner overlap / task #163/#164 | scanner could triage inside a mention-owned thread. | active thread ownership was not ported into live paths. | mention queue, thread cases, active-thread guard, and scanner suppression must land together. |
| tool parity / task #165 | tools looked active but were validation-only or unavailable. | parity reports described registration, not runtime behavior. | parity status must mean runtime truth: `active`, `validation_only`, `registered_unavailable`, or `product_excluded`. |
| heartbeat/self-growth / task #166 | follow-ups were persisted but not surfaced. | delivery loop and startup normalization were not included in the port. | every persistence feature needs a production surfacing path, ticker, status, and cleanup story. |
| Slack file/Canvas/image surfaces / task #167 | active upload path lacked safety; Canvas/image tools were partially exposed. | safety and capability boundaries were not bundled with the feature. | user-visible mutations require path guards, confirmation/dedupe where needed, ledger, and tests. |
| Calendar scanner / task #169 | scheduled meeting approval was absent despite direct join working. | direct/manual path was mistaken for feature parity. | migration must cover all entrypoints: manual, scheduled, background scanner, status, and disabled reason. |
| backfill/no-reply / tasks #184-#186 | "shared link nobody responds to" and "waited for human but nobody replied" were missing. | old behavior was a social workflow, not just a triage prompt rule. | add explicit canaries/backfill reports for weak invitations, delayed no-reply, and high-info links. |

## Non-Negotiable Migration Gates

Every Cueboard → Oneesama migration slice must pass these gates before
`in_review`.

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

### Gate 2: Migrate Configuration By Behavior

Old and new config must be compared by semantics, not by string similarity.

Checklist:

- Record old key(s), new key(s), old default, new default, old unit, new unit.
- Decide whether old keys are supported or intentionally ignored.
- Add a test for the chosen behavior.
- Update live env/runbook to canonical new keys.
- Check live process env after restart.

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

### Gate 9: No Marathon Without Contract Checkpoints

Large agent marathons are good for throughput but bad for protocol/product
subtleties.

Checklist:

- Split broad audits from behavior patches.
- After every risky patch, name the exact contract now protected.
- Ask a second reviewer to attack races and production boundaries, not just
  syntax.
- If a bug class repeats twice, add a guardrail task immediately.

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

If any answer is missing, the migration is not done.

## Where To Record Future Lessons

- Add incident-specific rows to this file.
- Cross-link fixed gaps in the relevant module audit file.
- Update `consolidated-backlog.md` when a gap is resolved or reclassified.
- Prefer executable checks over narrative notes.
