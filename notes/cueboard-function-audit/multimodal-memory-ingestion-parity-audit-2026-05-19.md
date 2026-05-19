# Multimodal Memory Ingestion Parity Audit — 2026-05-19

Task: #233 — Multimodal Memory ingestion: delegated file/image/video/PDF readers feeding searchable evidence.

## Scope

This audit is deliberately **bounded**:

- Port the old Slack Agent D behavior that file/image artifacts are first-class context, not invisible attachment metadata.
- Add a searchable Memory trail for Slack file/media evidence.
- Preserve content boundaries: video/PDF/binary files are metadata-only unless a separate reader result exists.

This does **not** implement a full video/PDF understanding pipeline. That requires delegated media readers and is a later layer.

## Old Does

Cueboard Slack Agent D makes Slack images fetchable as a native tool:

- `slack_api_tool_fetch.go:179-224` implements `actionFetchImage`.
- It requires a `file_id`, fetches Slack `files.info`, refuses non-images with "Content cannot be viewed", bounds oversized files, downloads the protected Slack file, normalizes it, and returns both a text part and an `input_image` part for the model.
- `defaults.go:172-175` instructs the worker to fetch Slack thread links/images before answering and to use `slack.fetchImage` for transcript image references when relevant.

Hermes/Supermemory establishes the Memory-side shape:

- `supermemory/README.md:1-3` describes semantic long-term memory.
- `supermemory/README.md:57-62` captures the important architecture: automatic turn/session ingest and explicit memory tools make read artifacts available for later recall.

## New Before #233

Oneesama had:

- `slack.fetchImage` parity as a tool.
- #220 `slack_file_context` evidence for media/file requests.
- #221 worker tool-loop bridge, so a worker can ask for `slack_api(fetch_image)` and receive dispatcher evidence.

But the evidence was ephemeral:

- File/video/PDF metadata lived only in the current worker prompt.
- Fetched image/canvas tool summaries were only continuation evidence.
- A future user asking about `bridge_cold_open_montage_v15.mp4` had no dedicated Memory record to search.

## New After #233

Implementation:

- `multimodal_memory_provider.go:23-96` adds a local `multimodal_memory` provider that searches `memory/multimodal/**` files and emits provider-tagged `SearchRelatedMemory` records.
- `multimodal_memory_provider.go:98-140` writes reviewable multimodal Memory candidates under `memory/multimodal/candidates/YYYY-MM-DD/`.
- `app_mention_tool_evidence.go:20-57` records file/media app-mention evidence after first-class context collection.
- `worker_tool_bridge.go:41-120` records worker-requested reader/tool evidence, so delegated image/canvas reads can become searchable Memory.
- `multimodal_memory_provider.go:231-245` scrubs inline image payloads (`base64`, `mime_data_url`, data URLs, markdown image embeds) before writing Memory.

Tests:

- `multimodal_memory_provider_test.go:13-70` proves a media-heavy app mention writes a Memory candidate and later `SearchRelatedMemory` returns `multimodal_memory` evidence.
- `multimodal_memory_provider_test.go:72-110` proves inline image payloads are redacted before Memory persistence.
- `case_006_multimodal_ingestion.json` pins the canary scenario in the Memory quality suite.

## Diff / Decision

Decision: **port the evidence boundary, not fake media understanding**.

Why:

- Old Agent D could fetch image content but still explicitly refused non-image content.
- Oneesama should not claim video/PDF/binary contents were read until a real reader result exists.
- However, metadata and reader results are Memory, not throwaway prompt garnish. They should be searchable later, like Supermemory-style auto-capture.

## Remaining Work

- Add delegated PDF/text/video readers that produce safe summaries.
- Add multimodal provider trust scoring once task #232 grows trust fixtures.
- Add true image semantic embedding / caption extraction if product usage proves high value.
