import Foundation
import KWWKComputerUseCore

struct KWWKCUCoreExecution {
  let action: String
  let cursorEvents: [[String: Any]]
  let metadata: [String: Any]
}

private final class KWWKCUCoreRuntime {
  static let shared = KWWKCUCoreRuntime()

  private let client: ComputerUseClient

  private init() {
    client = ComputerUseClient()
    if kwwkCoreVisualEffectsEnabled() {
      client.session.visualEffectHook = AppKitComputerUseVisualEffects()
    }
  }

  func finish() {
    client.finish()
  }

  func seed(target: [String: Any], includeScreenshot: Bool) throws -> ComputerUseCommandOutput {
    let app = kwwkTargetAppIdentifier(target)
    if app.isEmpty {
      throw HelperError.targetNotFound("kwwk_cu_target_app_required")
    }
    return try client.getAppState(
      app: app,
      windowTitle: kwwkTargetWindowTitle(target),
      windowID: kwwkTargetWindowID(target),
      includeScreenshot: includeScreenshot
    )
  }

  func execute(operation: [String: Any], target: [String: Any]) throws -> KWWKCUCoreExecution {
    try runAsync(timeoutMs: kwwkCoreActionTimeoutMs()) {
      try await self.executeAsync(operation: operation, target: target)
    }
  }

  private func executeAsync(operation: [String: Any], target: [String: Any]) async throws -> KWWKCUCoreExecution {
    let kind = text(operation["kind"])
    let includeScreenshot = kwwkOperationNeedsScreenshotSeed(operation)
    let seedStarted = Date()
    let seedOutput = try seed(target: target, includeScreenshot: includeScreenshot)
    let seedMs = Int(Date().timeIntervalSince(seedStarted) * 1000)
    let actionStarted = Date()
    let outputs: [ComputerUseCommandOutput]
    let action: String

    switch kind {
    case "state":
      action = "state"
      outputs = [seedOutput]
    case "click":
      action = "click"
      outputs = [try await runClick(operation: operation)]
    case "double_click":
      action = "double_click"
      outputs = [
        try await runClick(operation: operation),
        try await runClick(operation: operation),
      ]
    case "type_text":
      let value = text(operation["text"])
      if value.isEmpty { throw HelperError.unsupported("type_text_requires_text") }
      action = "type_text"
      outputs = [
        try await client.typeText(
          text: value,
          elementIndex: kwwkElementIndex(operation),
          includeScreenshotAfter: false
        ),
      ]
    case "press_key":
      let key = kwwkNormalizedKey(text(operation["key"]))
      if key.isEmpty { throw HelperError.unsupported("press_key_requires_key") }
      action = "press_key"
      outputs = [try await client.pressKey(key: key, includeScreenshotAfter: false)]
    case "scroll":
      action = "scroll"
      let direction = text(operation["direction"]).isEmpty ? "down" : text(operation["direction"])
      let pages = kwwkPages(operation)
      if let elementIndex = kwwkElementIndex(operation) {
        outputs = [
          try await client.scroll(
            elementIndex: elementIndex,
            direction: direction,
            pages: pages,
            includeScreenshotAfter: false
          ),
        ]
      } else {
        let key = kwwkFallbackScrollKey(direction)
        let repeats = max(1, min(6, Int(ceil(pages))))
        var fallbackOutputs: [ComputerUseCommandOutput] = []
        for _ in 0 ..< repeats {
          fallbackOutputs.append(try await client.pressKey(key: key, includeScreenshotAfter: false))
        }
        outputs = fallbackOutputs
      }
    case "drag":
      action = "drag"
      outputs = [
        try await client.drag(
          fromX: doubleValue(operation["from_x"]),
          fromY: doubleValue(operation["from_y"]),
          toX: doubleValue(operation["to_x"]),
          toY: doubleValue(operation["to_y"]),
          includeScreenshotAfter: false
        ),
      ]
    case "set_value":
      guard let elementIndex = kwwkElementIndex(operation) else {
        throw HelperError.unsupported("set_value_requires_element_index")
      }
      let value = text(operation["value"])
      if value.isEmpty { throw HelperError.unsupported("set_value_requires_value") }
      action = "set_value"
      outputs = [
        try await client.setValue(
          elementIndex: elementIndex,
          value: value,
          includeScreenshotAfter: false
        ),
      ]
    case "perform_secondary_action":
      guard let elementIndex = kwwkElementIndex(operation) else {
        throw HelperError.unsupported("perform_secondary_action_requires_element_index")
      }
      let secondaryAction = text(operation["action"])
      if secondaryAction.isEmpty {
        throw HelperError.unsupported("perform_secondary_action_requires_action")
      }
      action = "perform_secondary_action"
      outputs = [
        try await client.performSecondaryAction(
          elementIndex: elementIndex,
          action: secondaryAction,
          includeScreenshotAfter: false
        ),
      ]
    default:
      throw HelperError.unsupported("unsupported_operation:\(kind)")
    }

    let actionMs = Int(Date().timeIntervalSince(actionStarted) * 1000)
    let cursorEvents = kwwkCursorEvidenceEvents(operation: operation, target: target)
    return KWWKCUCoreExecution(
      action: action,
      cursorEvents: cursorEvents,
      metadata: kwwkExecutionMetadata(
        operation: operation,
        seedOutput: seedOutput,
        outputs: outputs,
        seedMs: seedMs,
        actionMs: actionMs
      )
    )
  }

  private func runClick(operation: [String: Any]) async throws -> ComputerUseCommandOutput {
    if let elementIndex = kwwkElementIndex(operation) {
      return try await client.click(elementIndex: elementIndex, includeScreenshotAfter: false)
    }
    if operation["x"] != nil, operation["y"] != nil {
      return try await client.click(
        x: doubleValue(operation["x"]),
        y: doubleValue(operation["y"]),
        includeScreenshotAfter: false
      )
    }
    throw HelperError.unsupported("click_requires_element_index_or_x_y")
  }
}

func executeKWWKCUCoreOperation(operation: [String: Any], target: [String: Any]) throws -> KWWKCUCoreExecution {
  try KWWKCUCoreRuntime.shared.execute(operation: operation, target: target)
}

func observeKWWKCUCoreState(target: [String: Any], includeScreenshot: Bool) throws -> [String: Any] {
  let started = Date()
  let output = try KWWKCUCoreRuntime.shared.seed(target: target, includeScreenshot: includeScreenshot)
  return [
    "schema": "oneesama.kwwk-cu-core-state.v1",
    "text": output.text,
    "metadata": kwwkSnapshotPayload(output.metadata),
    "includeScreenshot": includeScreenshot,
    "durationMs": max(0, Int(Date().timeIntervalSince(started) * 1000)),
    "source": "kwwk_computer_use_core",
  ]
}

func finishKWWKCUCoreSession() {
  KWWKCUCoreRuntime.shared.finish()
}

private func runAsync<T>(timeoutMs: Int, _ operation: @escaping @Sendable () async throws -> T) throws -> T {
  let semaphore = DispatchSemaphore(value: 0)
  var result: Result<T, Error>?
  let task = Task.detached {
    do {
      result = .success(try await operation())
    } catch {
      result = .failure(error)
    }
    semaphore.signal()
  }
  if semaphore.wait(timeout: .now() + .milliseconds(timeoutMs)) == .timedOut {
    task.cancel()
    throw HelperError.unsupported("kwwk_core_action_timeout:\(timeoutMs)ms")
  }
  guard let result else {
    throw HelperError.unsupported("kwwk_core_action_missing_result")
  }
  return try result.get()
}

private func kwwkTargetAppIdentifier(_ target: [String: Any]) -> String {
  for key in ["bundleIdentifier", "bundle_identifier", "applicationName", "application_name", "app", "application"] {
    let value = text(target[key])
    if !value.isEmpty { return value }
  }
  return ""
}

private func kwwkTargetWindowTitle(_ target: [String: Any]) -> String? {
  for key in ["windowTitle", "window_title", "title", "name"] {
    let value = text(target[key])
    if !value.isEmpty { return value }
  }
  return nil
}

private func kwwkTargetWindowID(_ target: [String: Any]) -> Int? {
  for key in ["windowId", "window_id", "windowID"] {
    if target[key] != nil {
      let value = intValue(target[key])
      if value > 0 { return value }
    }
  }
  return nil
}

func kwwkElementIndex(_ operation: [String: Any]) -> Int? {
  for key in ["elementIndex", "element_index", "index"] {
    if operation[key] != nil {
      return intValue(operation[key])
    }
  }
  return nil
}

private func kwwkPages(_ operation: [String: Any]) -> Double {
  let pages = doubleValue(operation["pages"])
  return pages > 0 ? pages : 1
}

private func kwwkFallbackScrollKey(_ direction: String) -> String {
  switch direction.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
  case "up":
    return "pageup"
  case "left":
    return "left"
  case "right":
    return "right"
  default:
    return "pagedown"
  }
}

private func kwwkCoreVisualEffectsEnabled() -> Bool {
  boolValue(envFirstText([
    "ONEESAMA_KWWK_CU_CORE_VISUAL_EFFECTS",
    "MAB_KWWK_CU_CORE_VISUAL_EFFECTS",
  ], default: "false"))
}

private func kwwkCoreActionTimeoutMs() -> Int {
  envInt(
    "ONEESAMA_KWWK_CU_CORE_ACTION_TIMEOUT_MS",
    default: envInt("MAB_KWWK_CU_CORE_ACTION_TIMEOUT_MS", default: 10000, min: 250, max: 15000),
    min: 250,
    max: 15000
  )
}

private func kwwkOperationNeedsScreenshotSeed(_ operation: [String: Any]) -> Bool {
  switch text(operation["kind"]) {
  case "click", "double_click":
    return kwwkElementIndex(operation) == nil
  case "drag":
    return true
  default:
    return false
  }
}

private func kwwkNormalizedKey(_ key: String) -> String {
  let parts = key
    .trimmingCharacters(in: .whitespacesAndNewlines)
    .lowercased()
    .split(separator: "+")
    .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
    .filter { !$0.isEmpty }
  if parts.isEmpty { return "" }
  return parts.map { part in
    switch part {
    case "command", "meta": return "cmd"
    case "control": return "ctrl"
    case "option": return "alt"
    case "return", "enter": return "enter"
    case "escape": return "esc"
    default: return part
    }
  }.joined(separator: "+")
}

private func kwwkCursorEvidenceEvents(operation: [String: Any], target: [String: Any]) -> [[String: Any]] {
  guard operationUsesForegroundCursor(operation) else { return [] }
  let kind = text(operation["kind"])
  switch kind {
  case "click", "double_click":
    guard operation["x"] != nil, operation["y"] != nil,
          let event = try? cursorEvidenceEvent(
            kind: kind == "double_click" ? "cursor.double_click" : "cursor.click",
            target: target,
            x: doubleValue(operation["x"]),
            y: doubleValue(operation["y"]),
            label: kind == "double_click" ? "double click" : "click"
          ) else {
      return centerCursorEvidenceEvent(
        kind: kind == "double_click" ? "cursor.double_click" : "cursor.click",
        target: target,
        label: kind == "double_click" ? "double click" : "click"
      ).map { [$0] } ?? []
    }
    return [event]
  case "scroll":
    return centerCursorEvidenceEvent(
      kind: "cursor.scroll",
      target: target,
      label: text(operation["direction"]).isEmpty ? "scroll" : "scroll \(text(operation["direction"]))"
    ).map { [$0] } ?? []
  case "drag":
    guard let begin = try? cursorEvidenceEvent(
      kind: "cursor.drag.begin",
      target: target,
      x: doubleValue(operation["from_x"]),
      y: doubleValue(operation["from_y"]),
      label: "drag"
    ), let end = try? cursorEvidenceEvent(
      kind: "cursor.drag.end",
      target: target,
      x: doubleValue(operation["to_x"]),
      y: doubleValue(operation["to_y"]),
      label: "drag"
    ) else {
      return []
    }
    return [begin, end]
  default:
    return []
  }
}

private func centerCursorEvidenceEvent(kind: String, target: [String: Any], label: String) -> [String: Any]? {
  guard let coordinateSpace = try? requireCursorCoordinateSpace(target: target) else { return nil }
  let width = max(1, doubleValue(coordinateSpace["width"]))
  let height = max(1, doubleValue(coordinateSpace["height"]))
  var event = cursorEvent(
    kind: kind,
    coordinateSpace: coordinateSpace,
    x: width * 0.5,
    y: height * 0.5,
    label: label
  )
  event["presentationOnly"] = true
  event["executionSurface"] = "kwwk_computer_use_core"
  event["coordinateSource"] = "target_center_fallback"
  return event
}

private func cursorEvidenceEvent(kind: String, target: [String: Any], x: Double, y: Double, label: String) throws -> [String: Any] {
  let coordinateSpace = try requireCursorCoordinateSpace(target: target)
  var event = cursorEvent(kind: kind, coordinateSpace: coordinateSpace, x: x, y: y, label: label)
  event["presentationOnly"] = true
  event["executionSurface"] = "kwwk_computer_use_core"
  return event
}

private func kwwkExecutionMetadata(
  operation: [String: Any],
  seedOutput: ComputerUseCommandOutput,
  outputs: [ComputerUseCommandOutput],
  seedMs: Int,
  actionMs: Int
) -> [String: Any] {
  let seedSnapshot = kwwkSnapshotPayload(seedOutput.metadata)
  let outputSnapshots = outputs.map { kwwkSnapshotPayload($0.metadata) }
  var payload: [String: Any] = [
    "executionSurface": "kwwk_computer_use_core",
    "corePackage": "github.com/EYHN/kwwk-computer-use-core",
    "coreSessionSeeded": seedOutput.metadata != nil,
    "coreSeedSnapshot": seedSnapshot,
    "coreOutputSnapshots": outputSnapshots,
    "coreOutputTextPreview": outputs.map { kwwkTextPreview($0.text) },
    "coreTimings": [
      "seedMs": max(0, seedMs),
      "actionMs": max(0, actionMs),
    ],
    "coreCoordinateSource": kwwkOperationNeedsScreenshotSeed(operation)
      ? "kwwk_core_screenshot_snapshot"
      : "kwwk_core_accessibility_snapshot",
    "coreVisualEffects": kwwkCoreVisualEffectsEnabled()
      ? "AppKitComputerUseVisualEffects"
      : "disabled_in_stdio_helper",
  ]
  if text(operation["kind"]) == "scroll", kwwkElementIndex(operation) == nil {
    let direction = text(operation["direction"]).isEmpty ? "down" : text(operation["direction"])
    payload["fallbackWindowScroll"] = true
    payload["fallbackScrollKey"] = kwwkFallbackScrollKey(direction)
  }
  return payload
}

private func kwwkSnapshotPayload(_ metadata: ComputerUseSnapshotMetadata?) -> [String: Any] {
  guard let metadata else { return [:] }
  var payload: [String: Any] = [
    "id": metadata.id,
    "appName": metadata.appName,
    "bundleID": metadata.bundleID,
    "pid": Int(metadata.pid),
    "windowTitle": metadata.windowTitle,
    "windowID": metadata.windowID,
    "fingerprint": metadata.fingerprint,
    "nodeCount": metadata.nodeSignatures.count,
    "windowFrame": [
      "x": metadata.windowFrame.x,
      "y": metadata.windowFrame.y,
      "width": metadata.windowFrame.width,
      "height": metadata.windowFrame.height,
    ],
  ]
  if let screenshotPath = metadata.screenshotPath {
    payload["screenshotPath"] = screenshotPath
  }
  if let screenshotSize = metadata.screenshotSize {
    payload["screenshotSize"] = [
      "width": screenshotSize.width,
      "height": screenshotSize.height,
    ]
  }
  return payload
}

private func kwwkTextPreview(_ value: String) -> String {
  let normalized = value
    .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
    .trimmingCharacters(in: .whitespacesAndNewlines)
  if normalized.count <= 320 { return normalized }
  return String(normalized.prefix(319)) + "…"
}
