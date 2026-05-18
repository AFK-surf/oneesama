# Persona Runtime Protocol

The Meeting Avatar foreground persona is a pluggable runtime. Go owns Slack /
Meet orchestration, persistence, safety, and audit. The persona runtime owns the
social decision. Pi is the first sidecar, not a privileged code path.

## Runtime Contract

Every implementation must expose the same logical interface:

- `Decide(ctx, Request) (Response, error)`
- `Status(ctx) Status`

In Go this is `internal/persona.Runtime`. External implementations can be
registered with `persona.RegisterRuntimeFactory(provider, factory)`, or can use
the built-in HTTP adapter.

## HTTP Adapter Shape

Any HTTP sidecar provider must implement:

- `GET /persona/status`
- `POST /persona/decide`

The built-in `http` and `pi` providers both use this adapter. Swapping between
Pi, OpenClaw-style runtimes, or another local service should require config
changes or a new factory registration, not Slack/triage code changes.

## Request

Fields use snake_case JSON names and should remain language-neutral:

- `id`
- `mode`: `shadow` or `live`
- `event`: `{kind, text, language, created_at}`
- `actor`: `{id, name, display_name, aliases}`
- `anchor`: `{surface, channel_id, thread_ts, message_ts, meeting_id, url}`
- `context`: array of `{kind, text, source_ref}`
- `evidence`: `{summary, citations}`
- `memory`: `{summary, items}`
- `safety`: `{allow_visible_reply, allow_speech, allow_worker_request, max_visible_chars, allowed_workers}`
- `metadata`

## Response

Decision values:

- `stay_silent`
- `reply`
- `delegate_worker`
- `memory_write`

Response fields:

- `runtime`
- `decision`
- `visible_text`
- `speech_intent`
- `worker_requests`
- `memory_writes`
- `confidence`
- `citations`
- `reason`
- `shadow_only`
- `metadata`

## Safety Rules

- Shadow mode must never post to Slack, speak in meetings, or write durable
  memory directly.
- A runtime must respect `safety.allow_visible_reply`,
  `safety.allow_speech`, and `safety.allow_worker_request`.
- If a runtime cannot decide safely, it should return `stay_silent` with a
  reason instead of inventing missing context.
- Slow runtime calls must not block live Slack/Meet user-visible flows. Go
  queues live shadow requests and writes shadow metadata after completion.

## Status

`Status` should expose at least:

- `provider`
- `mode`
- `healthy`
- `ready`
- `shadow_only`
- `version`
- `last_request_at`
- `last_latency_ms`
- `last_error`
- `state_summary`

These fields let Go audit the sidecar without peeking into runtime internals.
