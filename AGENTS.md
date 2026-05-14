# oneesama Go Rewrite

## Scope
- This branch hosts the Go rewrite of the oneesama host services.
- Keep the existing TypeScript implementation as the reference implementation until parity is proven.
- Keep browser-injected code in TypeScript/JavaScript for now:
  - `google-meet-joiner.ts` host stays TS initially
  - `realtime-browser-bridge.ts`
  - `hiyori-avatar-inject.ts`
  - DOM/caption/worker-result/local-dialog injectors

## Layout
- `cmd/<binary>` for executable entrypoints
- `internal/<feature>` for host-service implementation
- `pkg/<shared>` for shared contracts/config/version/observability

## Defaults
- HTTP: `gin-gonic/gin`
- Logging: `log/slog`
- Config: env-first with optional `config.json`
- Database target: `modernc.org/sqlite` for OSS-first local usage and cgo-free builds
- Tracing: defer OpenTelemetry until the host-service seams settle

## Guardrails
- Do not delete the TS implementation during early rewrite slices.
- Prefer explicit `context.Context` plumbing on service methods.
- Wrap errors with context using `fmt.Errorf("context: %w", err)`.
- Favor small, testable seams over giant ported files.
