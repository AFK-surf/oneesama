# Cueboard → Oneesama Migration Lessons

This is the practical checklist we apply when porting Cueboard behavior into
Oneesama. It exists because several regressions were not caused by missing code
alone; they were caused by preserving implementation shape while dropping the
old product contract.

## 1. Treat Product Semantics As Requirements

Do not collapse a Cueboard behavior into "just an implementation detail" until
the user-facing contract is named.

Examples:

- Scanner debounce is not only a timer. It is the "wait for humans to reply
  before the bot jumps in" social contract.
- `response_url` updates are not just Slack HTTP calls. Socket Mode must ack
  first or Slack shows the user a broken button.
- meet-runner stdout is not just a log stream. It is the JSON-RPC protocol
  channel.

Checklist:

- Write the user-visible contract in the task or audit row.
- Add a regression test for the contract, not just the function.
- If the contract involves timing or external systems, test the race or
  boundary explicitly.

## 2. Migrate Configuration By Behavior, Not By Name

Old env/config names are dangerous when units or defaults changed.

Checklist:

- Record old default, old unit, new default, new unit.
- Decide one of:
  - support the old key with an explicit conversion test; or
  - intentionally ignore/remove it and add a test proving stale old keys cannot
    silently change production behavior.
- Update live runbooks/env files to the new canonical key.

Regression from task #187:

- Cueboard-era `MAB_SLACK_EVENT_DEBOUNCE_MS` defaulted to 300000ms (5m).
- Go Oneesama used duration-style `MAB_SLACK_EVENT_DEBOUNCE` and defaulted to
  30s.
- Result: triage replied too quickly, before humans had a normal chance to
  answer.

## 3. Add Freshness Guards Before User-Visible Mutations

Any action proposed from a snapshot can become stale before it is executed.

Checklist:

- Before posting, editing, reacting, joining, or creating a Canvas, re-check
  whether the target thread/state changed after the snapshot.
- If newer human activity exists, skip as `thread_has_newer_activity` rather
  than posting stale output.
- Count skipped actions as no mutation, not as success.

Regression from task #187:

- First triage run saw a root-only thread and planned "need more context".
- A human replied before the direct action posted.
- The old direct `post_thread_reply` path lacked a freshness check, so it sent
  an outdated reply after the human answer.

## 4. Make Protocol Boundaries Fail Fast

If a boundary has a strict protocol, encode it in comments, helper APIs, and
tests/lints.

Recent guardrails:

- Socket Mode interactions use an ack-first helper and latency regression test.
- meet-runner stdout is guarded as JSON-RPC-only; logs must go to stderr.
- live restart wrapper preflights required provider env before starting.

Checklist:

- Add a top-of-file warning near the protocol boundary.
- Provide a small helper that makes the safe path the default.
- Add a test that fails when future code blocks, logs, or mutates in the wrong
  place.

## 5. Audit Documents Need A Follow-Through Record

Function parity tables are useful but not sufficient.

Checklist:

- Cross-link each fixed gap to the resolving commit SHA.
- Add the incident lesson here when the bug reveals a reusable migration rule.
- Prefer executable checks over narrative notes.
