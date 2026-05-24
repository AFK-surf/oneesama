# RFC: Meeting Realtime Visual Intent Routing

Date: 2026-05-25
Status: implementation in progress for task #401
Owner: @劲霸仁波切

## Context

Peng's live smoke exposed a product-level bug, not a single prompt wording bug:
when he repeatedly asked the realtime avatar to use Pencil or share the code editor
screen, the avatar kept falling back to the synthetic demo surface. One failed
run even treated "Pencil" as the website `pencil.app`, then showed the parked
domain instead of the local app.

The immediate reason was that the realtime foreground contract only exposed
generic demo tools. The native app share path existed behind `/screen-share/app`,
but the realtime model did not receive a clear app/window-share tool. The prompt
also used "share/show/demo" examples that were biased toward generated demo
work, so "演示 Pencil" and "做一个贪吃蛇给我看" collapsed into the same tool lane.

This RFC replaces that overloaded lane with a visual-intent router that is
small enough for realtime to use, explicit enough to test, and replayable through
actual Realtime smoke.

## Product Goal

In a live meeting, a user can naturally say:

- "用 Pencil 演示一下"
- "共享 VS Code 屏幕"
- "用编辑器演示当前画面"
- "打开这个 URL 给我看"
- "做一个贪吃蛇，然后给我看"
- "停止分享"

Oneesama should route each utterance to the right visual surface without asking
the user to restate implementation details:

- existing local app/window -> native ScreenCaptureKit app share;
- URL/browser page -> bot-owned browser surface;
- newly created/generated artifact -> shared workspace creation;
- current shared browser surface manipulation -> browser control tool;
- stop -> stop the active visual surface.

## Non-Goals

- Do not expose raw Computer Use primitives directly to Realtime.
- Do not let Realtime perform arbitrary shell or filesystem operations.
- Do not use one prompt example per app name as the safety mechanism.
- Do not require Peng to choose a local window through Meet's native picker.
- Do not make the synthetic demo surface responsible for native app/window
  sharing.

## Diagnosis Loop

The bug must be judged by a loop that observes the realtime tool choice, not by
reading logs after the fact.

### Required Signals

- The realtime session config exposes the intended tool names.
- The browser bridge accepts those tool names and records the model's function
  call.
- A live Realtime smoke with `tool_choice=auto` sends user utterances and checks
  the selected tool before any human-visible success claim.
- Real meeting smoke is the final integration check, but local live Realtime
  routing smoke is the repeatable gate.

### Minimal Replay Cases

| User utterance | Expected tool | Why |
| --- | --- | --- |
| "用 Pencil 演示当前画面" | `share_existing_app_window` | Pencil is an existing local app/window. |
| "共享 VS Code 屏幕" | `share_existing_app_window` | VS Code is a concrete existing desktop app/window. |
| "用编辑器演示当前画面" | `list_shareable_windows` | "editor" is a generic category; list candidates before choosing. |
| "打开 https://example.com 给我看" | `open_shared_browser_surface` | Explicit URL belongs to browser surface. |
| "做一个贪吃蛇，然后给我看" | `create_shared_workspace` | User asks to create/build a new artifact. |
| "停止分享" | `stop_video_stage` or `stop_shared_browser_surface` | Stop the active visual surface, depending on active surface state. |

## Tool Taxonomy

### Stable Realtime Foreground Tools

- `share_existing_app_window`
  - Boundary: existing macOS app/window.
  - Backing path: native ScreenCaptureKit app-share via `/screen-share/app`.
  - Expected for: Pencil, code editor, browser window, Terminal, dashboard,
    Notion, Activity Monitor, and other named local windows.

- `list_shareable_windows`
  - Boundary: disambiguation only.
  - Backing path: `/screen-share/apps`.
  - Expected when: app name is absent or ambiguous.

- `present_video_stage` / `stop_video_stage`
  - Boundary: prepared video/stage stream.
  - Expected for: stage/canvas/video presentation and stopping native/stage share.

### Optional Shared Workspace/Browser Surface Tools

These stay behind the shared-surface runtime flag.

- `open_shared_browser_surface`
  - Boundary: URL, web page, or bot-owned browser/synthetic surface.
  - Not for: named local app/window.

- `create_shared_workspace`
  - Boundary: create/build/implement/generate new artifacts, then present them.
  - Not for: "show existing app" requests.

- `control_shared_browser_surface`
  - Boundary: operate the active bot-owned browser/synthetic surface.

- `stop_shared_browser_surface`
  - Boundary: stop the bot-owned browser/synthetic surface.

### Deprecated Compatibility Aliases

The server may continue to accept old endpoint names for old clients, but the
realtime foreground contract must not expose them:

- `start_demo_surface`
- `start_demo_execution`
- `control_demo_surface`
- `cancel_demo_surface`
- `list_shareable_apps`
- `present_app_share`

## Prompt Contract

The prompt should describe the taxonomy, not memorize a demo:

- Existing named app/window + show/share/present/演示 -> native app share.
- Explicit URL/web page/browser surface -> browser surface.
- Create/build/implement/generate new artifact -> `create_shared_workspace`.
- If the user asks for an app/window and the exact app is ambiguous, list
  shareable windows once, then share the best match.
- Generic categories like "editor", "browser", "window", "app", or "design
  tool" are ambiguous; they are not concrete app names.
- Never invent a URL from an app name.
- Never route an existing app/window request into the generated shared workspace.

## Implementation Checklist

- [x] Add explicit native app/window foreground tools to the Go realtime schema.
- [x] Add explicit browser/shared workspace tools with non-overlapping names.
- [x] Keep old `/tools/*` endpoint aliases backend-compatible.
- [x] Keep browser bridge compatible with both old and new names while exposing
  only new names to Realtime.
- [x] Update TypeScript realtime schema to match Go exactly.
- [x] Update foreground tool inventory and golden schema hashes.
- [x] Add local unit tests for exposed/hidden tool names.
- [x] Add live Realtime routing smoke for the replay cases above.
- [ ] Run real meeting smoke after deploy: app share Pencil/code editor, browser
  URL surface, generated shared workspace, stop share.

## Smoke Acceptance

### Local deterministic gate

- `go test ./internal/meetingagent -run 'TestRealtimeTool|TestRealtimeClientSecret|TestRealtimeDemoSurfaceRuntimeFlagEnablesSmoke|TestRealtimeDemoExecutionStartsWorkerSurfaceAndApprovalGate' -count=1`
- `npm run smoke:realtime-session-update`

### Live Realtime routing gate

Add and run:

```bash
MAB_RUN_REALTIME_LIVE_ROUTING=1 npm run smoke:realtime-live-routing
```

Acceptance:

- Pencil/app utterance calls `share_existing_app_window`.
- Ambiguous app utterance calls `list_shareable_windows`.
- URL utterance calls `open_shared_browser_surface`.
- build-new utterance calls `create_shared_workspace`.
- non-demo build utterance calls `create_shared_workspace`.
- stop utterance calls a stop tool.
- stop-when-idle utterance produces either a harmless stop/no-op tool result or
  a short no-active-share answer; it must not create or open a surface.
- The smoke records tool call names and arguments in JSON for regression review.

### Real meeting gate

Peng-facing final smoke:

- [ ] Join with realtime.
- [ ] Say "共享 Pencil 屏幕" and verify the shared surface is Pencil, not fallback.
- [ ] Say "共享 VS Code 屏幕" and verify the shared surface switches to VS Code.
- [ ] Say "用编辑器演示当前画面" and verify the model lists shareable windows instead of guessing.
- [ ] Say "打开 https://example.com 给我看" and verify the browser surface opens the URL.
- [ ] Say "做一个贪吃蛇，然后给我看" and verify generated shared workspace is used.
- [ ] Say "做一个 Q3 metrics dashboard" and verify generated shared workspace is used for a non-demo artifact request.
- [ ] Say "停止分享" and verify sharing stops.

## Open Design Notes

- The live routing smoke proves model/tool-choice behavior, not native capture
  quality. Capture quality remains covered by the ScreenCaptureKit frame-rate
  and visual real-meeting smokes from task #401.
- If live Realtime still picks the wrong tool after taxonomy cleanup, the next
  fix must change the prompt/tool contract and update the replay fixture. Do not
  add app-name-specific patches without a smoke case.
- If an app name is not found, the correct response is one short blocker plus
  available candidates from `list_shareable_windows`; it is not acceptable
  to invent a website or generate a placeholder workspace.
