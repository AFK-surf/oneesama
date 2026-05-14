# Architecture

Meeting Avatar Bot is a thin shell around meeting runtime, workspace control, and user-selected agent providers. It ports an existing `slack-agentd` / `meetd` deployment shape into this repo, but it does not bake in the old private agent brain; complex work routes into whichever local or remote runner the operator selects, with Codex as the primary migration path.

## System Shape

```mermaid
flowchart LR
    Slack[Slack workspace] --> SlackAgent[Slack Agent service]
    SlackAgent --> Store[(State provider)]
    SlackAgent --> MeetingAgent[Meeting Agent service]
    MeetingAgent --> Meet[Google Meet]
    MeetingAgent --> Avatar[Hiyori / Live2D fake mic-cam]
    MeetingAgent --> Dialog[Dialog bridge]
    Dialog --> STT[STT provider]
    Dialog --> TTS[TTS provider]
    Dialog --> Runner[AgentRunner provider]
    Runner --> Codex[Codex CLI]
    Runner --> Claude[Claude Code CLI]
    Runner --> Ollama[Ollama HTTP API]
    Runner --> SlackAgentD[Slack Agent D bridge]
    Runner --> Command[Command runner]
    Runner --> HTTP[HTTP runner]
    MeetingAgent --> Worker[Worker result loop]
    Worker --> SlackAgent
```

## Core Boundaries

| Boundary            | Owned Here                                                                                  | Replaceable Provider                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Workspace control   | Slack slash-command HTTP surface, session lifecycle, join/status/stop/help commands, and natural-language mention routing | Slack app deployment mode, poster backend, old Slack Agent D adapter                              |
| Meeting runtime     | Playwright Google Meet joiner, fake mic/cam injection, diagnostics, stop-before-start guard | Meeting provider, browser strategy, real-room canary policy                                       |
| Avatar output       | Hiyori/fallback renderer contract, fake camera track, fake mic bus                          | Avatar model/runtime, true Live2D WebGL gate                                                      |
| Dialog input/output | Browser-side local dialog bridge and optional Realtime bridge                               | STT provider, TTS provider, OpenAI Realtime endpoint                                              |
| Agent work          | Job payload format, status/result reporting, delivery dedup, Slack/Meet worker handoff      | Codex as primary replacement backend, plus Claude Code, Ollama, command, HTTP, OpenHands wrappers |
| Persistence         | State provider contract for sessions and worker reports                                     | memory, json-file, sqlite, future Postgres/Redis                                                  |
| Cutover             | shadow/canary/rollback decisions and evidence reports                                       | legacy old-stack transmitter hook, live canary cohorts                                            |

## Request Flow

```mermaid
sequenceDiagram
    participant U as User
    participant S as Slack Agent
    participant M as Meeting Agent
    participant G as Google Meet
    participant D as Dialog Bridge
    participant R as AgentRunner
    participant T as TTS Provider

    U->>S: /avatar join <meet-url>
    S->>S: verify Slack signature and parse command
    S->>M: POST /sessions or /join/google-meet
    M->>G: Playwright join with fake camera/mic
    G-->>M: participant audio / meeting state
    U->>G: speaks in meeting
    G-->>D: STT event or Realtime event
    D->>R: run selected provider with task payload
    R-->>D: text result
    D->>T: synthesize response audio
    T-->>D: WAV/data URL/stream
    D->>G: route audio to avatar fake mic
    M->>S: worker/job result available
    S-->>U: Slack status/result
```

## Provider Selection

Agent runners are selected with `MAB_AGENT_RUNNER`:

```bash
MAB_AGENT_RUNNER=dry-run
MAB_AGENT_RUNNER=codex
MAB_AGENT_RUNNER=claude
MAB_AGENT_RUNNER=ollama
MAB_AGENT_RUNNER=slack-agent-d
MAB_AGENT_RUNNER=command
MAB_AGENT_RUNNER=http
```

For the primary Codex migration path, `MAB_AGENT_RUNNER=codex-app-server` keeps stable Codex App Server threads per Slack thread or Meet session. See [Codex App Server Session Management](codex-app-server-session-management.md) for the exact session-key rules and restart behavior.

Speech is split into independent seams:

```bash
MAB_STT_PROVIDER=event
MAB_TTS_PROVIDER=tone-wav
MAB_TTS_PROVIDER=command
MAB_TTS_PROVIDER=http
```

OpenAI Realtime remains optional. It is configured separately with `MAB_OPENAI_API_KEY` and OpenAI-compatible endpoint overrides, and it is not required for local Codex/Claude demos.

## Cutover Modes

```mermaid
flowchart TD
    Inbound[Slack command / meeting request] --> Guard{MAB_CUTOVER_MODE}
    Guard -->|new| NewStack[Run new repo as primary]
    Guard -->|shadow| OldPrimary[Keep old D stack primary]
    OldPrimary --> ShadowRecord[Record new-stack parse/report without side effects]
    Guard -->|canary| Bucket{Stable user/channel bucket}
    Bucket -->|inside %| NewStack
    Bucket -->|outside %| OldPrimary
    Guard -->|rollback| Rollback[Force old D stack primary]
    NewStack --> Evidence[Cutover report JSONL]
    ShadowRecord --> Evidence
    Rollback --> Evidence
```

Default development should stay on `new` or local fixture mode. Production migration should start with `shadow`, then `canary`, then `new`, with rollback evidence preserved.

## Verification Layers

| Layer                      | Command                                                                                |
| -------------------------- | -------------------------------------------------------------------------------------- |
| Full local default gate    | `npm run ci`                                                                           |
| Slack contract matrix      | `npm run smoke:slack-contract`                                                         |
| Meet contract matrix       | `npm run smoke:meet-contract`                                                          |
| Local dialog loop          | `npm run smoke:local-agent-dialog`                                                     |
| Runtime integrated fixture | `npm run smoke:runtime-acceptance`                                                     |
| Optional real Meet room    | `MAB_REAL_MEET_URL=... npm run smoke:real-meet`                                        |
| Optional real local dialog | `MAB_REAL_MEET_URL=... MAB_AGENT_RUNNER=codex npm run smoke:real-local-dialog`         |
| Optional OpenAI Realtime 2 | `MAB_OPENAI_API_KEY=... MAB_RUN_REALTIME_LIVE_TOOL=1 npm run smoke:realtime-live-tool` |

## Non-Committed Private State

Do not publish tokens, live Slack app secrets, Google credentials, or bundled Hiyori assets with unclear redistribution rights. Keep provider credentials in environment variables or operator-local config.
