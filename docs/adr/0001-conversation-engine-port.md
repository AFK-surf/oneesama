# Conversation Engine Port owns provider-neutral conversation events

Status: accepted

Oneesama surfaces, KWWK/tool routing, Debug Panel, and acceptance reports consume
canonical conversation events through the Conversation Engine Port instead of
depending on OpenAI Realtime raw event names or Agents SDK history. OpenAI
Realtime/Agents sidecar is the V1 Conversation Engine adapter, not the product
contract, because direct SDK coupling would make LAN operator acceptance,
diagnostic engines, mocks, and future realtime providers brittle.

Diagnostic and mock Conversation Engines must emit the same canonical event
vocabulary as live provider adapters. They can be deterministic, but they cannot
be a separate product API with weaker semantics; harnesses and failure injection
need to exercise `engine_connected`, speech, transcript, assistant output, tool,
tool-result, and `engine_error` events through the same port. Provider raw events
may remain available as labeled drill-down diagnostics, but they are not accepted
as the primary proof for surface, KWWK, or Debug Panel behavior.
