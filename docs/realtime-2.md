# OpenAI Realtime 2 Provider

OpenAI Realtime is an optional dialog provider for `meeting-avatar-bot`. The
default provider contract now targets `gpt-realtime-2` while keeping the
bring-your-own-agent runner path as the main product architecture.

## Official migration notes

- Official docs list `gpt-realtime-2` as the model to start with for
  low-latency voice agents.
- Voice-agent sessions still use the Realtime conversation lifecycle on
  `/v1/realtime`; this is not a `/v2` REST endpoint switch.
- Realtime 2 adds reasoning to speech-to-speech workflows. This demo defaults
  to `reasoning.effort: "high"` so the voice agent can use the stronger
  reasoning behavior Peng expects; lower values remain configurable when a
  deployment needs less latency.
- The current `session.update` shape uses `output_modalities` and nested
  `audio.input` / `audio.output` settings, including `semantic_vad` and the
  `marin` or `cedar` voices. OpenAI docs list the voice names but do not label
  them by gender; `marin` stays the default until we do a human A/B listen.
- Function calling remains session/response `tools` plus
  `function_call_output`; `response.done.response.output[]` may also contain
  commentary/final phases in Realtime 2 responses.

Sources:

- <https://developers.openai.com/api/docs/guides/realtime>
- <https://developers.openai.com/api/docs/guides/realtime-conversations>
- <https://developers.openai.com/api/docs/guides/realtime-models-prompting>
- <https://developers.openai.com/api/docs/models/gpt-realtime-2>

## Configuration

```bash
MAB_OPENAI_API_KEY=...
MAB_OPENAI_BASE_URL=https://api.openai.com/v1
MAB_OPENAI_REALTIME_MODEL=gpt-realtime-2
MAB_OPENAI_REALTIME_REASONING_EFFORT=high
MAB_OPENAI_REALTIME_VOICE=marin
MAB_OPENAI_REALTIME_TURN_DETECTION=semantic_vad
MAB_OPENAI_REALTIME_SESSION_SCHEMA=realtime-2
```

Endpoint overrides remain available for OpenAI-compatible gateways that support
Realtime client-secret and SDP call routes:

```bash
MAB_OPENAI_REALTIME_CLIENT_SECRETS_URL=https://your-gateway.example/v1/realtime/client_secrets
MAB_OPENAI_REALTIME_SDP_URL=https://your-gateway.example/v1/realtime/calls
```

Use `MAB_OPENAI_REALTIME_SESSION_SCHEMA=legacy` only when a compatible endpoint
requires the older `modalities` / `input_audio_format` session shape. The
default demo path should stay on `realtime-2`.

## Verification

Default local CI does not require an OpenAI key:

```bash
npm run smoke:realtime
npm run smoke:realtime-session-update
npm run smoke:realtime-sdp
npm run smoke:realtime-live-tool
```

The first two smokes assert the Realtime 2 session contract locally. The last
two skip unless an OpenAI-compatible key is present.

Live checks:

```bash
MAB_OPENAI_API_KEY=... MAB_RUN_REALTIME_SDP=1 npm run smoke:realtime-sdp
MAB_OPENAI_API_KEY=... MAB_RUN_REALTIME_LIVE_TOOL=1 npm run smoke:realtime-live-tool
```

These smokes verify the actual WebRTC SDP/data-channel path and the
`delegate_to_worker` tool loop.
