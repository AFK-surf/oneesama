# Operator visual composition produces the shareable video track

Status: accepted

The host Mac publishes one-way Host Visual Stream source tracks, but the LAN
Operator Surface owns the final visual layout and synthesizes a local Operator
Composed Video Track from its browser canvas. In product terms, this is the
user-side synthesized video track: the remote operator browser receives visual
ingredients, arranges them locally, then exposes one stable track for preview
and future sharing/recording/export.

This keeps the operator free to move, resize, hide, or foreground sources
without asking the host to recapture or reconnect, and it gives future
Meet/recording/export consumers one stable video track without streaming the
operator computer's screen back to Oneesama. Drag, resize, focus, and KWWK
overlay changes are applied before `canvas.captureStream()`, so the composed
track reflects the operator's current layout while raw Host Visual Stream tracks
remain source inputs.

Layout is therefore user-side UI state, not capture protocol state. Source
rectangles use normalized coordinates in the operator browser, and arbitrary
placement/scale edits must update the local canvas and synthesized track while
preserving the raw WebRTC source track identities. Acceptance evidence should
show both sides: the before/after layout changed, and the host source tracks did
not reconnect merely because the operator moved or resized a source.

The rejected alternative is a host-side baked composite track. That would make
the host Mac responsible for every operator layout change, couple capture to UI
preferences, and make "move this avatar bigger for me" look like a transport or
capture problem. In V1 the remote operator browser is the flexible visual mixer;
the host publishes visual ingredients, and the operator-side synthesized track
is the shareable output boundary.
