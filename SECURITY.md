# Security

## Supported Scope

This project is an experimental meeting avatar bot framework. Treat it as a local development tool until you have reviewed the deployment, browser, and workspace-permission boundaries for your environment.

## Secret Handling

- Store secrets in `.env` or your deployment secret manager.
- Do not commit `.env`, Slack tokens, OpenAI keys, Google credentials, meeting URLs from private calls, recordings, or screenshots.
- `npm run doctor` reports whether tokens are present without printing token values.

## Worker Delegation

The first worker runner is Codex CLI. By default, smoke tests run in dry-run/read-only mode. Only enable write-capable workers for trusted tasks and trusted workspaces.

## Browser Automation

The Meeting Agent controls a Chromium browser through Playwright. Run it in a dedicated browser profile and avoid logging into unrelated personal accounts from that profile.

## Reporting Issues

For a public repository, report vulnerabilities through the repository's security advisory flow when available. For private forks, contact the maintainer directly.
