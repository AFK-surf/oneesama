# meet-runner

This directory is the planned TypeScript browser island for the Go rewrite.

It will keep the Chrome/Playwright-facing modules that still need to execute as
JavaScript inside the browser runtime or are tightly coupled to Playwright
automation in the short term:

- `google-meet-joiner.ts` (host process, temporary until a chromedp rewrite exists)
- `realtime-browser-bridge.ts`
- `hiyori-avatar-inject.ts`
- `caption-capture.ts`
- `meet-prompts.ts`
- `meet-admission.ts`
- `meet-local-playback-mute.ts`
- `local-dialog-bridge.ts`
- `worker-result-bridge.ts`

The Go `meeting-agent` talks to this subprocess over a small JSON-RPC / stdio
seam.

Current bootstrap entrypoint:

- `src/index.ts`

Current implemented methods:

- `runner.ping`
- `join.google_meet.prepare`
- `join.session.stop`

The current bridge keeps one long-lived Node worker per session and exchanges
one JSON-RPC request/response per line over stdio. That makes the process
model honest for later Playwright work without pretending the runtime is more
complete than it is today.

Current behavior now has two explicit lanes:

- `dry_run=true`: validate and return the Playwright join plan plus session metadata
- `dry_run=false`: launch the persistent Playwright join worker and keep the browser session attached to the Node subprocess

Browser-island install flags such as realtime bridge / worker-result bridge
are carried through the JSON-RPC request shape and reflected in the returned
join plan, so the Go host can wire them explicitly instead of relying on
hardcoded defaults.

Two small invariants matter here:

- `collect_fixture_state` is an explicit protocol field now; it is no longer
  derived from `allow_non_google_meet`
- Visual avatar injection is intentionally not a product requirement; the
  Playwright join path keeps `installAvatar=false` and `disableLive2D=true`.
