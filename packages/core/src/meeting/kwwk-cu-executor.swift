import Foundation

func operationsFromParams(_ value: Any?) -> [[String: Any]] {
  guard let operations = value as? [[String: Any]] else { return [] }
  return operations
}

func executeOperation(_ operation: [String: Any], target: [String: Any]) throws -> (action: String, cursorEvents: [[String: Any]]) {
  let kind = text(operation["kind"])
  switch kind {
  case "state":
    _ = try state(params: ["target": target])
    return ("state", [])
  case "click":
    let event = try click(target: target, x: doubleValue(operation["x"]), y: doubleValue(operation["y"]))
    return ("click", [event])
  case "double_click":
    let event = try doubleClick(target: target, x: doubleValue(operation["x"]), y: doubleValue(operation["y"]))
    return ("double_click", [event])
  case "type_text":
    try pasteText(target: target, value: text(operation["text"]))
    return ("type_text", [])
  case "press_key":
    try pressKey(target: target, key: text(operation["key"]))
    return ("press_key", [])
  case "scroll":
    try scroll(target: target, direction: text(operation["direction"]).isEmpty ? "down" : text(operation["direction"]))
    return ("scroll", [])
  case "drag":
    let events = try drag(
      target: target,
      fromX: doubleValue(operation["from_x"]),
      fromY: doubleValue(operation["from_y"]),
      toX: doubleValue(operation["to_x"]),
      toY: doubleValue(operation["to_y"])
    )
    return ("drag", events)
  default:
    throw HelperError.unsupported("unsupported_operation:\(kind)")
  }
}

func operationUsesForegroundCursor(_ operation: [String: Any]) -> Bool {
  switch text(operation["kind"]) {
  case "click", "double_click", "drag":
    return true
  default:
    return false
  }
}

func cursorPolicyPayload(operations: [[String: Any]], cursorEvents: [[String: Any]]) -> [String: Any] {
  let actionKinds = operations.map { text($0["kind"]) }.filter { !$0.isEmpty }
  let pointerAction = operations.contains { operationUsesForegroundCursor($0) }
  return [
    "schema": "oneesama.kwwk-cursor-events.v1",
    "events": cursorEvents,
    "actionKinds": actionKinds,
    "pointerAction": pointerAction,
    "foregroundSessionStarted": pointerAction && !cursorEvents.isEmpty,
    "policy": pointerAction ? "native_foreground_cursor_for_pointer_action" : "no_foreground_cursor_for_keyboard_scroll_or_state",
  ]
}

func actionTelemetryEntry(operation: [String: Any], action: String, durationMs: Int, success: Bool, error: String = "") -> [String: Any] {
  var target: [String: Any] = [:]
  for key in ["targetRole", "targetLabel", "key", "direction"] {
    let value = text(operation[key])
    if !value.isEmpty { target[key] = value }
  }
  for key in ["x", "y", "from_x", "from_y", "to_x", "to_y"] {
    if operation[key] != nil { target[key] = doubleValue(operation[key]) }
  }
  if action == "type_text" {
    target["textLength"] = text(operation["text"]).count
  }
  var entry: [String: Any] = [
    "kind": action,
    "target": target,
    "durationMs": max(0, durationMs),
    "success": success,
    "source": "kwwk",
  ]
  if !error.isEmpty { entry["error"] = error }
  return entry
}

func finalPlannerBlockerCanSkipObservation(_ blocker: String, status: String) -> Bool {
  if status == "needs_background_agent" { return true }
  if blocker.hasPrefix("blocked_planner_model_") { return true }
  switch blocker {
  case "model_plan_invalid_json",
       "model_plan_operations_required",
       "planner_action_budget_exceeded":
    return true
  default:
    return false
  }
}

func operationNeedsFullObservation(_ operation: [String: Any]) -> Bool {
  switch text(operation["kind"]) {
  case "state", "click", "double_click", "drag":
    return true
  default:
    return false
  }
}

func appControlNeedsFullObservation(params: [String: Any], operations: [[String: Any]]) -> Bool {
  if boolValue(firstParam(params, "includeScreenshot")) { return true }
  if operations.contains(where: operationNeedsFullObservation) { return true }
  let expectations = verificationExpectationsFromParams(params)
  if !text(expectations["expectedAccessibilityLabelContains"]).isEmpty { return true }
  return false
}

func appControlInstructionNeedsVisualObservation(_ instruction: String) -> Bool {
  let lower = instruction.lowercased()
  return containsAny(lower, [
    "click",
    "double-click",
    "double click",
    "tap",
    "button",
    "control",
    "drag",
    "drop",
    "select",
    "choose",
    "press the",
    "点击",
    "点一下",
    "双击",
    "按钮",
    "控件",
    "拖",
    "选择",
    "选中",
  ])
}

func appControlShouldPreObserveBeforePlanning(
  params: [String: Any],
  instruction: String,
  explicitOperations: [[String: Any]],
  explicitObservation: [String: Any]
) -> Bool {
  if !explicitOperations.isEmpty { return false }
  if !explicitObservation.isEmpty { return false }
  if boolValue(firstParam(params, "includeScreenshot")) { return true }
  return appControlInstructionNeedsVisualObservation(instruction)
}

func appControlLightObservationNeedsWindow(params: [String: Any]) -> Bool {
  let expectations = verificationExpectationsFromParams(params)
  if !text(expectations["expectedWindowTitleContains"]).isEmpty { return true }
  if let includeWindow = firstParam(params, "includeWindow") {
    return boolValue(includeWindow)
  }
  return false
}

func appControlObservationContext(params: [String: Any], full: Bool) -> [String: Any] {
  var context = contextFromParams(params)
  if full { return context }
  context["includeApplications"] = false
  context["includeWindow"] = appControlLightObservationNeedsWindow(params: params)
  context["includeAccessibility"] = false
  context["includeScreenshot"] = false
  return context
}

func targetForExecution(target: [String: Any], snapshot: [String: Any]) -> [String: Any] {
  guard let window = snapshot["window"] as? [String: Any] else { return target }
  var merged = target
  for key in ["applicationName", "bundleIdentifier", "processId", "windowId"] {
    if merged[key] == nil, window[key] != nil {
      merged[key] = window[key]
    }
  }
  if merged["process_id"] == nil, window["processId"] != nil {
    merged["process_id"] = window["processId"]
  }
  if merged["window_id"] == nil, window["windowId"] != nil {
    merged["window_id"] = window["windowId"]
  }
  return merged
}

func controlSharedAppWindow(params: [String: Any]) throws -> [String: Any] {
  let callStarted = Date()
  let target = targetFromParams(params)
  let instruction = text(params["instruction"])
  let explicitOperations = operationsFromParams(params["operations"])
  let config = plannerConfig()
  let explicitValidation = explicitOperations.isEmpty
    ? ["ok": true, "validation": ["ok": true]]
    : validatePlanOperations(explicitOperations, planner: config)
  let explicitObservation = observationFromParams(params)
  let shouldPreObserve = appControlShouldPreObserveBeforePlanning(
    params: params,
    instruction: instruction,
    explicitOperations: explicitOperations,
    explicitObservation: explicitObservation
  )
  var preObservedSnapshot: [String: Any]?
  var preObservedMs = 0
  if shouldPreObserve {
    let preObserveStarted = Date()
    do {
      preObservedSnapshot = try state(params: [
        "target": target,
        "context": appControlObservationContext(params: params, full: true),
      ])
      preObservedMs = Int(Date().timeIntervalSince(preObserveStarted) * 1000)
    } catch {
      preObservedMs = Int(Date().timeIntervalSince(preObserveStarted) * 1000)
      return [
        "ok": false,
        "summary": "Could not inspect the shared app/window before planning.",
        "actions": [],
        "confidence": 0.2,
        "blocker": String(describing: error),
        "operations": [],
        "metadata": [
          "planner": [
            "provider": "pre_observation",
            "modelUsed": false,
          ],
          "observationMode": "full",
          "preObservedBeforePlanning": true,
          "timings": appControlTimingSegments(
            totalStarted: callStarted,
            planMs: 0,
            observeMs: preObservedMs
          ),
        ],
      ]
    }
  }
  let planStarted = Date()
  let plannerContext = contextFromParams(params)
  let plannerObservation = preObservedSnapshot ?? explicitObservation
  var plan = explicitOperations.isEmpty
    ? planInstruction(params: [
      "instruction": instruction,
      "target": target,
      "observation": plannerObservation,
      "context": plannerContext,
    ])
    : [
      "ok": explicitValidation["ok"] as? Bool == true,
      "status": explicitValidation["ok"] as? Bool == true ? "planned" : "blocked",
      "instruction": instruction,
      "operations": explicitValidation["ok"] as? Bool == true ? explicitOperations : [],
      "planner": [
        "provider": "explicit",
        "modelUsed": false,
        "latencyMs": 0,
        "normalizeMs": 0,
        "actionKinds": explicitOperations.map { text($0["kind"]) }.filter { !$0.isEmpty },
        "maxActions": intValue(config["maxActions"]),
        "optionalModel": config,
        "validation": explicitValidation["validation"] ?? [:],
      ],
      "blocker": text(explicitValidation["blocker"]),
    ]
  var planMs = Int(Date().timeIntervalSince(planStarted) * 1000)
  var operations = operationsFromParams(plan["operations"])
  if preObservedSnapshot != nil {
    var planner = plan["planner"] as? [String: Any] ?? [:]
    planner["preObservedBeforePlanning"] = true
    plan["planner"] = planner
  }
  if explicitOperations.isEmpty && operations.isEmpty {
    let planBlocker = text(plan["blocker"])
    let planStatus = text(plan["status"])
    if finalPlannerBlockerCanSkipObservation(planBlocker, status: planStatus) {
      let propagatedStatus = planStatus == "needs_background_agent" ? planStatus : "blocked"
      let propagatedBlocker = planBlocker.isEmpty ? propagatedStatus : planBlocker
      let planSummary = text(plan["summary"])
      return [
        "ok": false,
        "status": propagatedStatus,
        "summary": planSummary.isEmpty
          ? "Planner did not produce an executable app-control action."
          : planSummary,
        "actions": [],
        "confidence": 0.2,
        "blocker": propagatedBlocker,
        "operations": [],
        "metadata": [
          "planner": plan["planner"] ?? [:],
          "observationSkipped": [
            "reason": "final_planner_blocker",
            "blocker": propagatedBlocker,
          ],
          "preObservedBeforePlanning": preObservedSnapshot != nil,
          "timings": appControlTimingSegments(
            totalStarted: callStarted,
            planMs: planMs,
            observeMs: preObservedSnapshot == nil ? 0 : preObservedMs
          ),
        ],
      ]
    }
  }
  let snapshot: [String: Any]
  let fullObservation: Bool
  let observeMs: Int
  if let preObservedSnapshot {
    snapshot = preObservedSnapshot
    fullObservation = true
    observeMs = preObservedMs
  } else {
    let observeStarted = Date()
    fullObservation = operations.isEmpty || appControlNeedsFullObservation(params: params, operations: operations)
    do {
      snapshot = try state(params: [
        "target": target,
        "context": appControlObservationContext(params: params, full: fullObservation),
      ])
    } catch {
      let observedMs = Int(Date().timeIntervalSince(observeStarted) * 1000)
      return [
        "ok": false,
        "summary": "Could not inspect the shared app/window.",
        "actions": [],
        "confidence": 0.2,
        "blocker": String(describing: error),
        "operations": operations,
        "metadata": [
          "planner": plan["planner"] ?? [:],
          "observationMode": fullObservation ? "full" : "light",
          "timings": appControlTimingSegments(
            totalStarted: callStarted,
            planMs: planMs,
            observeMs: observedMs
          ),
        ],
      ]
    }
    observeMs = Int(Date().timeIntervalSince(observeStarted) * 1000)
  }
  if explicitOperations.isEmpty && operations.isEmpty && preObservedSnapshot == nil {
    let observedPlanStarted = Date()
    let observedPlan = planInstruction(params: [
      "instruction": instruction,
      "target": target,
      "observation": snapshot,
      "context": plannerContext,
    ])
    let observedOperations = operationsFromParams(observedPlan["operations"])
    planMs += Int(Date().timeIntervalSince(observedPlanStarted) * 1000)
    if !observedOperations.isEmpty {
      var planner = observedPlan["planner"] as? [String: Any] ?? [:]
      planner["observedReplan"] = true
      planner["initialPlanner"] = plan["planner"] ?? [:]
      var mergedPlan = observedPlan
      mergedPlan["planner"] = planner
      plan = mergedPlan
      operations = observedOperations
    }
  }
  if operations.isEmpty {
    let planBlocker = text(plan["blocker"])
    let planStatus = text(plan["status"])
    let propagatedBlocker = planBlocker.isEmpty ? "instruction_not_directly_executable" : planBlocker
    let propagatedStatus = planStatus == "needs_background_agent" ? planStatus : "blocked"
    let planSummary = text(plan["summary"])
    return [
      "ok": false,
      "status": propagatedStatus,
      "summary": planSummary.isEmpty
        ? "Captured shared app state; the planner did not produce an executable action."
        : planSummary,
      "actions": ["state"],
      "confidence": planBlocker.isEmpty ? 0.4 : 0.2,
      "blocker": propagatedBlocker,
      "operations": [],
      "metadata": [
        "state": snapshot,
        "planner": plan["planner"] ?? [:],
        "observationMode": fullObservation ? "full" : "light",
        "timings": appControlTimingSegments(
          totalStarted: callStarted,
          planMs: planMs,
          observeMs: observeMs
        ),
      ],
    ]
  }
  if operations.count == 1 && text(operations[0]["kind"]) == "state" {
    return [
      "ok": true,
      "summary": "Captured shared app state.",
      "actions": ["observe"],
      "confidence": 0.7,
      "operations": operations,
      "metadata": [
        "state": snapshot,
        "planner": plan["planner"] ?? [:],
        "observationMode": fullObservation ? "full" : "light",
        "timings": appControlTimingSegments(
          totalStarted: callStarted,
          planMs: planMs,
          observeMs: observeMs
        ),
      ],
    ]
  }
  let nonStateOperations = operations.filter { text($0["kind"]) != "state" }
  if nonStateOperations.isEmpty {
    return [
      "ok": true,
      "summary": "Captured shared app state.",
      "actions": ["state"],
      "confidence": 0.6,
      "operations": operations,
      "metadata": [
        "state": snapshot,
        "planner": plan["planner"] ?? [:],
        "observationMode": fullObservation ? "full" : "light",
        "timings": appControlTimingSegments(
          totalStarted: callStarted,
          planMs: planMs,
          observeMs: observeMs
        ),
      ],
    ]
  }
  var actions: [String] = []
  var cursorEvents: [[String: Any]] = []
  var actionTelemetry: [[String: Any]] = []
  let executeStarted = Date()
  let executionTarget = targetForExecution(target: target, snapshot: snapshot)
  for operation in operations {
    let operationStarted = Date()
    do {
      let executed = try executeOperation(operation, target: executionTarget)
      let durationMs = Int(Date().timeIntervalSince(operationStarted) * 1000)
      actions.append(executed.action)
      cursorEvents.append(contentsOf: executed.cursorEvents)
      actionTelemetry.append(actionTelemetryEntry(
        operation: operation,
        action: executed.action,
        durationMs: durationMs,
        success: true
      ))
    } catch {
      let failedAction = text(operation["kind"]).isEmpty ? "unknown" : text(operation["kind"])
      let durationMs = Int(Date().timeIntervalSince(operationStarted) * 1000)
      actionTelemetry.append(actionTelemetryEntry(
        operation: operation,
        action: failedAction,
        durationMs: durationMs,
        success: false,
        error: String(describing: error)
      ))
      return [
        "ok": false,
        "summary": "Stopped after \(actions.count) app-control operation(s).",
        "actions": actions,
        "confidence": 0.3,
        "blocker": String(describing: error),
        "operations": operations,
        "metadata": [
          "state": snapshot,
          "planner": plan["planner"] ?? [:],
          "observationMode": fullObservation ? "full" : "light",
          "cursor": cursorPolicyPayload(operations: operations, cursorEvents: cursorEvents),
          "actionTelemetry": actionTelemetry,
          "timings": appControlTimingSegments(
            totalStarted: callStarted,
            planMs: planMs,
            observeMs: observeMs,
            executeMs: Int(Date().timeIntervalSince(executeStarted) * 1000)
          ),
        ],
      ]
    }
  }
  let executeMs = Int(Date().timeIntervalSince(executeStarted) * 1000)
  let verification = verifyPostActionState(
    params: params,
    target: executionTarget,
    operations: operations,
    beforeState: snapshot,
    actions: actions
  )
  let verifyMs = intValue(verification["durationMs"])
  if verification["ok"] as? Bool != true {
    return [
      "ok": false,
      "summary": "Executed \(actions.count) app-control operation(s), but post-action verification failed.",
      "actions": actions,
      "confidence": 0.2,
      "blocker": "failed_verification",
      "operations": operations,
      "metadata": [
        "state": snapshot,
        "planner": plan["planner"] ?? [:],
        "observationMode": fullObservation ? "full" : "light",
        "cursor": cursorPolicyPayload(operations: operations, cursorEvents: cursorEvents),
        "actionTelemetry": actionTelemetry,
        "verification": verification,
        "timings": appControlTimingSegments(
          totalStarted: callStarted,
          planMs: planMs,
          observeMs: observeMs,
          executeMs: executeMs,
          verifyMs: verifyMs
        ),
      ],
    ]
  }
  return [
    "ok": true,
    "summary": "Executed \(actions.count) app-control operation(s).",
    "actions": actions,
    "confidence": 0.8,
    "operations": operations,
    "metadata": [
      "state": snapshot,
      "planner": plan["planner"] ?? [:],
      "observationMode": fullObservation ? "full" : "light",
      "cursor": cursorPolicyPayload(operations: operations, cursorEvents: cursorEvents),
      "actionTelemetry": actionTelemetry,
      "verification": verification,
      "timings": appControlTimingSegments(
        totalStarted: callStarted,
        planMs: planMs,
        observeMs: observeMs,
        executeMs: executeMs,
        verifyMs: verifyMs
      ),
    ],
  ]
}

func appControlTimingSegments(totalStarted: Date, planMs: Int, observeMs: Int, executeMs: Int = 0, verifyMs: Int = 0) -> [String: Any] {
  return [
    "schema": "oneesama.kwwk-app-control-timings.v1",
    "normalizeMs": max(0, planMs),
    "observeMs": max(0, observeMs),
    "planMs": max(0, planMs),
    "executeMs": max(0, executeMs),
    "verifyMs": max(0, verifyMs),
    "totalMs": max(0, Int(Date().timeIntervalSince(totalStarted) * 1000)),
  ]
}
