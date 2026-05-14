# Contributing

Thanks for contributing to `oneesama`.

## Before You Start

- Read [README.md](README.md) for the project shape and local commands.
- Read [SECURITY.md](SECURITY.md) before reporting security-sensitive issues.
- Keep secrets, private meeting data, and local workspace state out of commits.

## Development Flow

1. Install dependencies:

```bash
npm ci
```

2. Run the default local gate:

```bash
npm run ci
```

3. If you touch a narrow subsystem, also run the most relevant focused smoke(s).

## Pull Requests

- Keep changes scoped.
- Prefer small, reviewable commits.
- Update docs when behavior, env vars, or operator steps change.
- Include the exact validation you ran in the PR description.

## What Not To Commit

- `.env` files or secret-bearing local config
- private meeting URLs, screenshots, recordings, or transcripts
- machine-local absolute paths unless they are examples and clearly marked as placeholders

## Design Notes

- The repo is a thin shell around meeting/runtime/workspace orchestration.
- Agent intelligence is provider-selected; avoid hard-wiring a single backend into the product surface.
- Keep live-provider checks opt-in and make fixture/local smoke coverage strong by default.
