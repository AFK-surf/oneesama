# Browser / Computer Use External Write Approval Gate RFC

Status: Proposed
Date: 2026-05-21
Anchor task: #328
Parent RFCs:
- `notes/rfc/oneesama-harness-cache-tool-stability-rfc-2026-05-21.md`
- `notes/rfc/kwwk-cu-demo-surface-poc-rfc-2026-05-21.md`

## Context

Peng's target workflow is real and useful:

1. In realtime, the user asks Oneesama to find a task, implement it with a
   worker/Codex lane, open the resulting app, demo it in the bot-owned browser,
   and then close the Linear/GitHub issue.
2. Read/show/scroll/highlight/capture actions are safe enough for the current
   demo-surface lane.
3. External writes such as "close Linear issue", "comment on GitHub", "merge",
   or "edit production dashboard" must not happen just because the realtime
   model inferred intent.

The current implementation already keeps active browser control behind
`AllowActiveControl`, and production defaults keep active click/type disabled.
This RFC defines the approval-token gate needed before enabling external
Browser / Computer Use writes.

## Decision

Keep the realtime foreground tool schema stable. Do not add one-off tools like
`close_linear_issue` or `update_github_pr`.

External writes must flow through the existing demo-surface boundary:

```text
start_demo_surface / control_demo_surface
  -> DemoSafetyPolicy
  -> approval token check
  -> Browser/CU adapter
  -> audit row + token consumption/revocation
```

## Action Taxonomy

| Class | Examples | Default |
|---|---|---|
| `read_only` | `open_url`, `capture`, read URL, screenshot observation | allow when URL is allowlisted/session-approved |
| `passive_mutation` | scroll, highlight, focus visible element | allow or dry-run based on `DryRun` |
| `local_demo_write` | click a local fixture button, type into a bot-owned local demo app | requires `AllowActiveControl=true`; no external approval token if URL is loopback session-approved |
| `external_write` | Linear close/update/comment, GitHub issue/PR comment/update/merge, Notion edit, Slack/Meet message send through browser UI | requires approval token |
| `forbidden_write` | file download exfiltration, credential changes, billing/payment/admin/security actions, deleting production data | block even with token unless a later RFC explicitly permits |

## Approval Token Shape

Future implementation should persist tokens as structured audit data:

```json
{
  "token_id": "demo_approval_...",
  "demo_session_id": "demo_...",
  "surface": "linear",
  "url_prefix": "https://linear.app/cue/issue/ENG-42",
  "action": "close_issue",
  "verb": "click",
  "requested_by": "peng-xiao",
  "approved_by": "peng-xiao",
  "scope_summary": "Close ENG-42 after the Snake demo is verified",
  "expires_at": "2026-05-21T12:20:00Z",
  "single_use": true,
  "created_from": {
    "channel": "meeting",
    "thread_ts": "..."
  }
}
```

Token matching rules:

- `demo_session_id` must match the active demo session.
- current URL must match `url_prefix`.
- normalized action class must match `action`.
- low-level Browser/CU verb must match `verb`.
- token must not be expired or consumed.
- a single-use token is consumed immediately before the adapter executes the
  write, and the result audit row records success/failure.

## Approval UX

Support both meeting realtime and Slack/operator paths, but implement them
through the same token store.

1. **Realtime spoken approval**: Oneesama asks a concise confirmation question
   and only mints a token after a direct affirmative reply from the current
   user/speaker identity.
2. **Slack approval card**: Oneesama posts an approval card with scope,
   target URL, action, expiry, and approve/reject buttons.
3. **Operator CLI/test mint**: local/dev smoke can mint a token directly for a
   fixture URL, never for production systems by default.

The model never invents approval. The host service mints tokens only from a
verified user action.

## Config Defaults

Task #328 adds configuration/status fields so operators can see the gate state
before implementation:

- `demo_surface.require_external_write_approval` default `true`
- `demo_surface.external_write_approval_token_ttl` default `10m`
- env aliases:
  - `ONEESAMA_DEMO_SURFACE_REQUIRE_EXTERNAL_WRITE_APPROVAL`
  - `MAB_DEMO_SURFACE_REQUIRE_EXTERNAL_WRITE_APPROVAL`
  - `ONEESAMA_DEMO_SURFACE_APPROVAL_TOKEN_TTL`
  - `MAB_DEMO_SURFACE_APPROVAL_TOKEN_TTL`

These fields do not expand the realtime tool schema. They make the future gate
observable and keep the current default conservative.

## Implementation Slices

- [x] #328-A. RFC and config/status seam.
  Done when the default config requires approval for external writes and the
  meeting status exposes the approval policy state.
- [ ] #328-B. Add `DemoApprovalTokenStore` with in-memory fake + persistent
  interface.
  Done when tests cover mint / match / consume / expire / revoke.
- [ ] #328-C. Extend `DemoSafetyPolicy` to accept an approval token reference
  for `click` / `type` and classify external write vs local demo write.
  Done when external writes block without a matching token even if
  `AllowActiveControl=true`.
- [ ] #328-D. Add Slack approval-card mint/reject path.
  Done when a deterministic test mints a token from a button payload and audit
  stores requester/approver/scope.
- [ ] #328-E. Add realtime approval capture path.
  Done when an affirmative current-speaker reply can mint a single-use token
  and a negative/ambiguous reply cannot.
- [ ] #328-F. Add live smoke for local fixture issue close.
  Done when the Snake/Linear-like fixture can close its issue only after a
  scoped token is minted.
- [ ] #328-G. Add production denylist for forbidden writes.
  Done when billing/admin/security/delete flows are blocked with
  `external_write_forbidden`.

## Acceptance Gates

- Browser/CU read/show actions keep working with no token.
- Active local fixture click/type can be tested when `AllowActiveControl=true`.
- External writes are blocked by default even when active control is enabled.
- Tokens are scoped, expiring, single-use by default, and audit-visible.
- Reject/no-answer/ambiguous realtime replies do not mint tokens.
- No external write tool is added to the realtime foreground schema; the
  `control_demo_surface` boundary remains the stable tool.
