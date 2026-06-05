import Foundation

func resultFor(method: String, params: [String: Any]) throws -> Any {
  switch method {
  case "list_apps":
    return ["ok": true, "applications": listRunningApps()]
  case "list_windows":
    return ["ok": true, "windows": try listWindows(appFilter: text(params["app"]))]
  case "state":
    return try state(params: params)
  case "click":
    let event = try click(target: targetFromParams(params), x: doubleValue(params["x"]), y: doubleValue(params["y"]))
    return ["ok": true, "actions": ["click"], "metadata": ["cursor": ["schema": "oneesama.kwwk-cursor-events.v1", "events": [event]]]]
  case "double_click":
    let event = try doubleClick(target: targetFromParams(params), x: doubleValue(params["x"]), y: doubleValue(params["y"]))
    return ["ok": true, "actions": ["double_click"], "metadata": ["cursor": ["schema": "oneesama.kwwk-cursor-events.v1", "events": [event]]]]
  case "type", "type_text":
    try pasteText(target: targetFromParams(params), value: text(params["text"]))
    return ["ok": true, "actions": ["type_text"]]
  case "press_key":
    try pressKey(target: targetFromParams(params), key: text(params["key"]))
    return ["ok": true, "actions": ["press_key"]]
  case "scroll":
    try scroll(target: targetFromParams(params), direction: text(params["direction"]).isEmpty ? "down" : text(params["direction"]))
    return ["ok": true, "actions": ["scroll"]]
  case "drag":
    let events = try drag(
      target: targetFromParams(params),
      fromX: doubleValue(params["from_x"]),
      fromY: doubleValue(params["from_y"]),
      toX: doubleValue(params["to_x"]),
      toY: doubleValue(params["to_y"])
    )
    return ["ok": true, "actions": ["drag"], "metadata": ["cursor": ["schema": "oneesama.kwwk-cursor-events.v1", "events": events]]]
  case "app_control.native_cursor_overlay_probe":
    return nativeCursorOverlayProbe(params: params)
  case "app_control.native_cursor_render_probe":
    return try nativeCursorRenderProbe(params: params)
  case "kwwk.cu.control":
    return cuControl(params: params)
  case "kwwk.cu.plan":
    return try resultWithTraceArtifact(
      planInstruction(params: params),
      params: params,
      method: method
    )
  case "kwwk.cu.action":
    let operation = operationFromActionParams(params)
    if operation.isEmpty {
      throw HelperError.invalidRequest("operation_required")
    }
    let validation = validatePlanOperations([operation], planner: plannerConfig())
    guard validation["ok"] as? Bool == true else {
      return [
        "ok": false,
        "status": "blocked",
        "blocker": text(validation["blocker"]),
        "actions": [],
        "metadata": [
          "validation": validation["validation"] ?? [:],
        ],
      ]
    }
    let target = targetFromParams(params)
    let beforeState = (try? state(params: [
      "target": target,
      "context": contextFromParams(params),
    ])) ?? [:]
    let executed = try executeOperation(operation, target: target)
    let verification = verifyPostActionState(
      params: params,
      target: target,
      operations: [operation],
      beforeState: beforeState,
      actions: [executed.action]
    )
    if verification["ok"] as? Bool != true {
      return [
        "ok": false,
        "status": "failed",
        "blocker": "failed_verification",
        "actions": [executed.action],
        "metadata": [
          "cursor": cursorPolicyPayload(operations: [operation], cursorEvents: executed.cursorEvents),
          "verification": verification,
        ],
      ]
    }
    return [
      "ok": true,
      "status": "completed",
      "actions": [executed.action],
      "metadata": [
        "cursor": cursorPolicyPayload(operations: [operation], cursorEvents: executed.cursorEvents),
        "verification": verification,
      ],
    ]
  case "kwwk.cu.execute":
    return try resultWithTraceArtifact(
      controlSharedAppWindow(params: params),
      params: params,
      method: method
    )
  case "app_control.validate_plan":
    return validatePlanOperations(operationsFromParams(params["operations"]), planner: plannerConfig())
  default:
    throw HelperError.methodNotFound(method)
  }
}

func errorCode(_ error: Error) -> Int {
  if case HelperError.methodNotFound = error { return -32601 }
  if case HelperError.invalidRequest = error { return -32600 }
  return -32000
}

func handleLine(_ line: String) {
  do {
    guard let request = try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] else {
      throw HelperError.invalidRequest("request_must_be_object")
    }
    let id = request["id"] ?? NSNull()
    let method = text(request["method"])
    guard !method.isEmpty else { throw HelperError.invalidRequest("method_required") }
    let params = request["params"] as? [String: Any] ?? [:]
    writeJSONLine(["jsonrpc": "2.0", "id": id, "result": try resultFor(method: method, params: params)])
  } catch {
    let id: Any = ((try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any])?["id"]) ?? NSNull()
    writeJSONLine([
      "jsonrpc": "2.0",
      "id": id,
      "error": ["code": errorCode(error), "message": String(describing: error)],
    ])
  }
}
