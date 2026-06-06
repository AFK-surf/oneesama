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
    return try directOperationResult(kind: "click", params: params)
  case "double_click":
    return try directOperationResult(kind: "double_click", params: params)
  case "type", "type_text":
    return try directOperationResult(kind: "type_text", params: params)
  case "press_key":
    return try directOperationResult(kind: "press_key", params: params)
  case "scroll":
    return try directOperationResult(kind: "scroll", params: params)
  case "drag":
    return try directOperationResult(kind: "drag", params: params)
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
    let executeStarted = Date()
    let executed = try executeOperation(operation, target: target)
    let actionTelemetry = [
      actionTelemetryEntry(
        operation: operation,
        action: executed.action,
        durationMs: Int(Date().timeIntervalSince(executeStarted) * 1000),
        success: true,
        metadata: executed.metadata
      ),
    ]
    let verification = verifyPostActionState(
      params: params,
      target: target,
      operations: [operation],
      beforeState: beforeState,
      actions: [executed.action],
      actionTelemetry: actionTelemetry
    )
    if verification["ok"] as? Bool != true {
      return [
        "ok": false,
        "status": "failed",
        "blocker": "failed_verification",
        "actions": [executed.action],
        "metadata": [
          "cursor": cursorPolicyPayload(operations: [operation], cursorEvents: executed.cursorEvents),
          "actionTelemetry": actionTelemetry,
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
        "actionTelemetry": actionTelemetry,
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

func directOperationResult(kind: String, params: [String: Any]) throws -> [String: Any] {
  var operation = params["operation"] as? [String: Any] ?? params
  operation["kind"] = kind
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
  let started = Date()
  let executed = try executeOperation(operation, target: target)
  let durationMs = Int(Date().timeIntervalSince(started) * 1000)
  return [
    "ok": true,
    "status": "completed",
    "actions": [executed.action],
    "metadata": [
      "cursor": cursorPolicyPayload(operations: [operation], cursorEvents: executed.cursorEvents),
      "actionTelemetry": [
        actionTelemetryEntry(
          operation: operation,
          action: executed.action,
          durationMs: durationMs,
          success: true,
          metadata: executed.metadata
        ),
      ],
    ],
  ]
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
