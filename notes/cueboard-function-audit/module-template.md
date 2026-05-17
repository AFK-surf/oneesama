# <Module> Function Parity Audit

Task: task #<number>

Cueboard root: `<absolute path>`

Oneesama comparison root: `<absolute path>`

## Summary

| Status | Count | Notes |
|---|--:|---|
| identical | 0 |  |
| verbatim_port | 0 |  |
| partial | 0 |  |
| drift | 0 |  |
| missing | 0 |  |
| product_excluded | 0 |  |
| unreviewed | 0 |  |

## Function Inventory

Start by generating rows:

```bash
go run ./cmd/cueboard-function-inventory \
  --root <label>=<cueboard-module-root> \
  --out notes/cueboard-function-audit/<module>.md
```

Then fill the review columns:

| Module | Source file | Function | Kind | Exported | Lines | Suggested status | Oneesama target | Evidence | Notes |
|---|---|---|---|---:|---:|---|---|---|---|
|  |  |  |  |  |  | unreviewed |  |  |  |

## P0 Gaps

- None yet.

## P1 Gaps

- None yet.

## Product Exclusions

- None yet.

## Open Questions

- None yet.
