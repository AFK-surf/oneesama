# Config migration: cueboard YAML → oneesama JSON

oneesama-go-rewrite reads configuration as JSON only. The cueboard-era
loader accepted YAML at `$MEETD_CONFIG_FILE` / `$SLACK_AGENT_CONFIG_FILE`.
On first startup against an old YAML config the loader will fail with
something like:

```
parse config: invalid character '-' in numeric literal (looks like YAML at
/etc/oneesama/config.yaml; run `oneesama-config-migrate --input <yaml>
--output <json>` to convert (see docs/config-migrate.md))
```

This is the breaking change the consolidated audit flagged. The
migration is one-shot and the binary is checked into this repo:
`cmd/oneesama-config-migrate`.

## Usage

```
go run ./cmd/oneesama-config-migrate \
  --input  /etc/oneesama/config.yaml \
  --output /etc/oneesama/config.json
```

or build it once:

```
go build -o /usr/local/bin/oneesama-config-migrate ./cmd/oneesama-config-migrate
oneesama-config-migrate --input config.yaml --output config.json
```

Either form also accepts stdin/stdout (`--input -` or no flag).

## What it enforces at migration time

The tool intentionally mirrors the runtime loader's strict policy:

- **Unknown fields fail loudly.** A cueboard-era key that
  oneesama-go-rewrite has dropped (e.g. agent-framework filesystem paths)
  produces an error like `unknown field "agent_framework_path"`. Remove
  the dead field from the source YAML and re-run.
- **Trailing content fails loudly.** Two top-level JSON objects in one
  file (merge-conflict residue, botched manual edits) are reported
  instead of being silently merged.

This is the same `DisallowUnknownFields` discipline the runtime now
applies, so any config that survives migration will also survive
startup.

## What it does NOT do

- It does not move or back up the original YAML file. Make a backup
  yourself before overwriting `config.yaml`.
- It does not migrate dropped keys with semantic renames. The Go
  runtime intentionally dropped some cueboard concepts (typed
  runtimepath layout, embedded workspace templates, etc.). The tool
  errors on those keys; the operator decides whether to drop them or
  re-introduce the matching feature.
- It does not validate runtime semantics (timeouts > 0, secrets format,
  etc.). The real loader still does that on next startup.

## Why JSON only

JSON gives us a single canonical encoding, no YAML quoting footguns
(`yes`, `on`, `1.10`, indentation drift, `tab` characters), and the
ability to use `encoding/json`'s strict mode directly. Cueboard's YAML
loader had to reimplement strict unknown-field rejection on top of
gopkg.in/yaml.v3; oneesama-go-rewrite gets it from the standard library
for free.
