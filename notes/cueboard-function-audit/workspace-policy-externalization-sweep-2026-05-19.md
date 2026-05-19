# Workspace Policy Externalization Sweep — 2026-05-19 (task #238 audit)

## Goal

Audit `92b8ddb` → `76c1165` → `ad0148f` → `ad070ec` / `4ab81a6` /
`9359251` sweep to confirm Oneesama/Bridge workspace preferences are
no longer hardcoded into universal Pi runtime / Go triage code, and
inventory remaining hardcoded workspace-specific or policy-leaning
content for the #199 polish queue.

This sweep is the supervisor counterpart to driver's #238
implementation, run independently to verify nothing was missed.

## Driver Ship Coverage (task #238)

Three commits land the policy externalization across the runtime:

- `ad070ec fix(persona): read triage policy from workspace context`
  — Pi sidecar prompt removes hardcoded Oneesama/Bridge preferences;
  reads `workspace_triage_policy` from request context.
- `4ab81a6 feat(slack): inject workspace triage policy` — Go side
  adds `ONEESAMA_SLACK_TRIAGE_WORKSPACE_POLICY` config, plumbs the
  policy through `persona.Request` to Pi sidecar.
- `9359251 fix(slack): gate triage engagement by workspace policy`
  — Go triage prompt + shared-link deterministic fallback +
  legacy TS prompt all removed hardcoded "office helper / cold-link
  weak-invitation" preferences; switched to default + policy gate.

## Independent Grep Verification

### Workspace-specific name strings in active runtime

Search query: `Oneesama/Bridge | Bridge workspace | office helper`
within `internal/`, `cmd/`, `pkg/`, `templates/`, `packages/core/`.

Active-runtime matches: 0.

Remaining matches:
- `notes/rfc/foreground-cognition-pivot-rfc-2026-05-19.md:177`
  documents the policy boundary; correct usage (referring to the
  Bridge workspace's choice to opt-in, not embedding it as
  universal Pi behavior).
- `notes/cueboard-function-audit/entity-attribution-parity-audit-2026-05-19.md`
  references "Bridge" in legacy import history; documentation only.
- `cmd/oneesama-legacy-slack-memory-import/main.go` references the
  Bridge identity for one-time legacy memory import; correct usage.
- `docs/slock-workspace-import.md` documents the slock import CLI.
- `cmd/oneesama-slock-workspace-import/main.go` same.

Conclusion: driver's #238 sweep removed workspace-specific name
strings from all active prompt / runtime paths. The only remaining
references are in docs and the legacy-import CLI, both of which are
correct usage.

### Topic / role-shape language in active runtime

Search query: `协调和会议 | 会议 helper | 水群 | 不是 office`.

Active-runtime matches: 0.

These role-shape strings previously appeared in Pi prompts and Go
templates; driver's #238 sweep cleared them.

## Remaining Class 2 Routing Keywords (distinct from #238)

These are runtime decision-gate keyword arrays in Go, not prompts.
They route inputs to evidence emitters; they're not "what's in
scope" workspace policy. They remain in code as of `9359251`:

| File | Keyword purpose | Drift |
| --- | --- | --- |
| `service_worker_jobs.go` | `canvas` / `画布` → Canvas publish route | Class 2 |
| `app_mention_tool_evidence.go` | `是什么` / `是谁` / `what is` / `who is` etc → fresh exa_search dispatch | Class 2 |
| `app_mention_workflow_evidence.go` | `review` / `approve` / `merge` / `pull request` etc → workflow context evidence | Class 2 (conjunction logic) |
| `app_mention_media_evidence.go` | `视频` / `素材` / `image` / `video` etc → media file evidence | Class 2 |

These belong in the #199 polish queue per earlier audit. They are
NOT a missing externalization in #238's scope (#238 was about
"what's a casual topic worth engaging on for this workspace"; the
above are "which input shape needs which evidence emitter," which
is universal Pi/Go routing logic that does not vary by workspace).

The distinction matters: #238 externalizes workspace-specific
**product preference**; #199 externalizes universal **input
routing**. Both end up as configurable, but the configuration scope
is different (per-workspace policy vs deployment-wide template
strings).

## New Drift Class: Workspace Preference As Universal Model Behavior

Today's incident (`92b8ddb` then driver's #238 sweep) surfaced a
drift class distinct from the previous five on this audit's parent
doc. The pattern is:

**A team's product preference is encoded as the model's universal
behavior.**

Concrete shape:

- Bridge workspace observes Pi declining to comment on AI-agent
  articles. Pi's scope is too narrow for the Bridge team's needs.
- The fix that ships: widen Pi's universal scope to include AI-agent
  / coding tools / Memory / Bridge-like products.
- The drift: the next workspace inherits Bridge's product
  preferences as Pi's intrinsic personality.

Why this is its own drift class:

- shape ≠ contract = surface matched, semantics missed.
- re-derive vs port = reasoned from scratch instead of reading old
  code.
- identity migration ≠ traffic interception = inherited old
  identity's traffic without owning it.
- runtime traces as memory = audited the wrong universe of
  artefacts.
- candidate-generator as cognition in main path = OldModel hidden
  in new decision path.
- **workspace preference as universal model behavior** = new: one
  deployment's product policy hard-encoded into the universal model
  layer.

Symptoms that catch this drift:

- Same fix request would not be appropriate for a different
  workspace deployment (sales team, support team, etc.).
- The fix touches universal prompt content or model code rather
  than per-deployment configuration.
- After the fix ships, the model behaves Bridge-flavored for any
  new deployment.

Audit rule for future migrations:

- Before any prompt or runtime edit that widens "what counts as in
  scope" or "what topics matter," answer in writing: "would this
  change be appropriate for a sales team Slack? a customer support
  Slack? a research lab Slack?" If the answer is "not all," the
  edit belongs in workspace configuration, not universal model
  prompt.
- Acceptance fixture: deploy the same Pi binary with two different
  workspace policies; the same input must produce different
  engagement decisions purely from the policy diff.

Scope distinction from "candidate-generator as cognition in main
path":

- candidate-generator = OldModel still running in main path under
  new name.
- workspace preference = one deployment's product policy encoded
  in the universal model layer.

This is now a first-class drift class candidate for
`migration-lessons-audit-method.md`.

## Status

- `92b8ddb` initial fix (hardcoded scope widening): superseded by
  driver #238 sweep.
- `76c1165` Pi-prompt-scoped-to-Bridge-workspace: superseded by
  driver #238 sweep (Pi prompt now reads from policy, not
  hardcoded).
- `ad0148f` RFC documenting 3-layer separation: still valid as the
  architectural framing.
- `ad070ec` / `4ab81a6` / `9359251` driver #238 sweep:
  policy-externalized, verified by this audit.
- Class 2 routing keywords: 4 files remain hardcoded, queued for
  #199 polish (separate scope from #238).

## Action Items Folded Into This Doc

1. Add "workspace preference as universal model behavior" as 6th
   first-class drift class in `migration-lessons-audit-method.md`,
   citing `92b8ddb → 9359251` as the worked example.
2. Class 2 routing keyword externalization (4 remaining files)
   belongs in #199 polish queue as previously documented; no new
   scope.
3. Fixture proposal: `case_NNN_workspace_policy_engagement` (two
   workspace configs, same input, different decisions) for the
   bridge_quality_fixtures suite once Phase 2 of the Pi-first RFC
   ships and the policy is reachable at the fixture layer.
