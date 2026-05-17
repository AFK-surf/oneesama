// Package processutil exposes shared helpers for managing subprocess
// lifecycles across oneesama subcommands. The agentrunner and meetrunner
// packages both spawn long-running child processes (Codex / Claude / Ollama
// runners, the meet-runner Node bridge); both previously hand-rolled
// near-identical pgroup/SIGKILL helpers. Consolidating them here keeps the
// behavior consistent and gives the codebase a single place to extend the
// termination semantics later (e.g. SIGTERM grace before SIGKILL).
package processutil
