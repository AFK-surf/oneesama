import AppKit
import ApplicationServices
import CoreGraphics
import CoreImage
import CoreMedia
import CoreVideo
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

enum HelperError: Error, CustomStringConvertible {
  case invalidRequest(String)
  case methodNotFound(String)
  case targetNotFound(String)
  case accessibilityRequired
  case unsupported(String)

  var description: String {
    switch self {
    case .invalidRequest(let message): return message
    case .methodNotFound(let method): return "method_not_found:\(method)"
    case .targetNotFound(let message): return message
    case .accessibilityRequired: return "accessibility_permission_required"
    case .unsupported(let message): return message
    }
  }
}

func jsonData(_ value: Any) throws -> Data {
  try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
}

func writeJSONLine(_ value: Any) {
  do {
    if let text = String(data: try jsonData(value), encoding: .utf8) {
      print(text)
      fflush(stdout)
    }
  } catch {
    fputs("{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{\"code\":-32603,\"message\":\"json_encode_failed\"}}\n", stderr)
  }
}

func text(_ value: Any?) -> String {
  String(describing: value ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
}

func intValue(_ value: Any?) -> Int {
  if let value = value as? Int { return value }
  if let value = value as? Int64 { return Int(value) }
  if let value = value as? Double { return Int(value) }
  if let value = value as? NSNumber { return value.intValue }
  if let value = value as? String { return Int(value.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0 }
  return 0
}

func doubleValue(_ value: Any?) -> Double {
  if let value = value as? Double { return value }
  if let value = value as? Int { return Double(value) }
  if let value = value as? NSNumber { return value.doubleValue }
  if let value = value as? String { return Double(value.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0 }
  return 0
}

func boolValue(_ value: Any?) -> Bool {
  if let value = value as? Bool { return value }
  if let value = value as? NSNumber { return value.boolValue }
  let normalized = text(value).lowercased()
  return normalized == "1" || normalized == "true" || normalized == "yes"
}

func rectPayload(_ rect: CGRect) -> [String: Any] {
  [
    "x": rect.origin.x,
    "y": rect.origin.y,
    "width": rect.size.width,
    "height": rect.size.height,
  ]
}

func backingScaleFactor(for frame: CGRect) -> CGFloat {
  let center = CGPoint(x: frame.midX, y: frame.midY)
  if let screen = NSScreen.screens.first(where: { $0.frame.contains(center) }) {
    return max(1, screen.backingScaleFactor)
  }
  return max(1, NSScreen.main?.backingScaleFactor ?? 1)
}

func runningAppPayload(_ app: NSRunningApplication) -> [String: Any] {
  [
    "applicationName": app.localizedName ?? "",
    "name": app.localizedName ?? "",
    "bundleIdentifier": app.bundleIdentifier ?? "",
    "processId": Int(app.processIdentifier),
    "pid": Int(app.processIdentifier),
    "active": app.isActive,
    "hidden": app.isHidden,
  ]
}

func listRunningApps() -> [[String: Any]] {
  NSWorkspace.shared.runningApplications
    .filter { $0.activationPolicy == .regular }
    .map(runningAppPayload)
}

func shareableContent() throws -> SCShareableContent {
  var result: Result<SCShareableContent, Error>?
  let semaphore = DispatchSemaphore(value: 0)
  Task {
    do {
      result = .success(try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true))
    } catch {
      result = .failure(error)
    }
    semaphore.signal()
  }
  semaphore.wait()
  return try result!.get()
}

func writeCGImagePNG(_ cgImage: CGImage, outputURL: URL) throws {
  let context = CIContext(options: nil)
  let image = CIImage(cgImage: cgImage)
  guard let normalized = context.createCGImage(image, from: image.extent) else {
    throw HelperError.unsupported("create_cg_image_failed")
  }
  guard let destination = CGImageDestinationCreateWithURL(
    outputURL as CFURL,
    UTType.png.identifier as CFString,
    1,
    nil
  ) else {
    throw HelperError.unsupported("create_image_destination_failed")
  }
  CGImageDestinationAddImage(destination, normalized, nil)
  guard CGImageDestinationFinalize(destination) else {
    throw HelperError.unsupported("write_image_failed")
  }
}

@available(macOS 12.3, *)
func writePixelBufferPNG(_ pixelBuffer: CVPixelBuffer, outputURL: URL) throws {
  let context = CIContext(options: nil)
  let image = CIImage(cvPixelBuffer: pixelBuffer)
  guard let cgImage = context.createCGImage(image, from: image.extent) else {
    throw HelperError.unsupported("create_cg_image_failed")
  }
  try writeCGImagePNG(cgImage, outputURL: outputURL)
}

@available(macOS 12.3, *)
final class OneFrameOutput: NSObject, SCStreamOutput {
  let outputURL: URL
  let semaphore = DispatchSemaphore(value: 0)
  var result: Result<Void, Error>?

  init(outputURL: URL) {
    self.outputURL = outputURL
  }

  func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
    guard outputType == .screen, result == nil else { return }
    guard CMSampleBufferIsValid(sampleBuffer), let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else {
      return
    }
    do {
      try writePixelBufferPNG(pixelBuffer, outputURL: outputURL)
      result = .success(())
    } catch {
      result = .failure(error)
    }
    semaphore.signal()
  }
}

func windowPayload(_ window: SCWindow, index: Int) -> [String: Any] {
  let app = window.owningApplication
  return [
    "index": index,
    "windowId": Int(window.windowID),
    "windowID": Int(window.windowID),
    "title": window.title ?? "",
    "name": window.title ?? "",
    "applicationName": app?.applicationName ?? "",
    "bundleIdentifier": app?.bundleIdentifier ?? "",
    "processId": Int(app?.processID ?? 0),
    "pid": Int(app?.processID ?? 0),
    "frame": rectPayload(window.frame),
    "source": "macos_screencapturekit",
  ]
}

func listWindows(appFilter: String = "") throws -> [[String: Any]] {
  let lowered = appFilter.lowercased()
  return try shareableContent().windows.enumerated().compactMap { index, window in
    let payload = windowPayload(window, index: index)
    if lowered.isEmpty { return payload }
    let haystack = [
      text(payload["applicationName"]),
      text(payload["bundleIdentifier"]),
      text(payload["title"]),
    ].joined(separator: " ").lowercased()
    return haystack.contains(lowered) ? payload : nil
  }
}

func targetFromParams(_ params: [String: Any]) -> [String: Any] {
  if let target = params["target"] as? [String: Any] { return target }
  return params
}

func contextFromParams(_ params: [String: Any]) -> [String: Any] {
  params["context"] as? [String: Any] ?? [:]
}

func firstParam(_ params: [String: Any], _ key: String) -> Any? {
  if let value = params[key] { return value }
  return contextFromParams(params)[key]
}

func matchesWindow(_ window: [String: Any], target: [String: Any]) -> Bool {
  let windowId = intValue(target["window_id"]) != 0 ? intValue(target["window_id"]) : intValue(target["windowId"])
  if windowId != 0 && intValue(window["windowId"]) == windowId { return true }
  let processId = intValue(target["process_id"]) != 0 ? intValue(target["process_id"]) : intValue(target["processId"])
  if processId != 0 && intValue(window["processId"]) == processId { return true }
  let bundle = text(target["bundle_identifier"]).isEmpty ? text(target["bundleIdentifier"]) : text(target["bundle_identifier"])
  if !bundle.isEmpty && text(window["bundleIdentifier"]).caseInsensitiveCompare(bundle) == .orderedSame { return true }
  let appName = text(target["application_name"]).isEmpty ? text(target["applicationName"]) : text(target["application_name"])
  if appName.isEmpty { return false }
  return [text(window["applicationName"]), text(window["title"]), text(window["name"])]
    .map { $0.lowercased() }
    .contains { $0 == appName.lowercased() || $0.contains(appName.lowercased()) }
}

func windowArea(_ window: [String: Any]) -> Double {
  guard let frame = window["frame"] as? [String: Any] else { return 0 }
  return doubleValue(frame["width"]) * doubleValue(frame["height"])
}

func findWindow(target: [String: Any]) throws -> [String: Any] {
  let windows = try listWindows()
  let windowId = intValue(target["window_id"]) != 0 ? intValue(target["window_id"]) : intValue(target["windowId"])
  if windowId != 0, let exact = windows.first(where: { intValue($0["windowId"]) == windowId }) {
    return exact
  }
  let candidates = windows.filter { matchesWindow($0, target: target) }
  if let best = candidates.max(by: { windowArea($0) < windowArea($1) }) {
    return best
  }
  throw HelperError.targetNotFound("shared_window_not_found")
}

func captureWindowScreenshot(windowId: Int, outputPath: String, timeoutMs: Int) throws -> [String: Any] {
  var result: Result<[String: Any], Error>?
  let semaphore = DispatchSemaphore(value: 0)
  Task {
    do {
      let content = try shareableContent()
      guard let window = content.windows.first(where: { Int($0.windowID) == windowId }) else {
        throw HelperError.targetNotFound("shared_window_not_found")
      }
      let outputURL = URL(fileURLWithPath: outputPath)
      try FileManager.default.createDirectory(
        at: outputURL.deletingLastPathComponent(),
        withIntermediateDirectories: true
      )
      let scaleFactor = max(2, backingScaleFactor(for: window.frame))
      let width = max(320, Int((window.frame.width * scaleFactor).rounded()))
      let height = max(180, Int((window.frame.height * scaleFactor).rounded()))
      let filter = SCContentFilter(desktopIndependentWindow: window)
      let configuration = SCStreamConfiguration()
      configuration.width = width
      configuration.height = height
      configuration.minimumFrameInterval = CMTime(value: 1, timescale: 30)
      configuration.queueDepth = 3
      configuration.pixelFormat = kCVPixelFormatType_32BGRA
      configuration.scalesToFit = true
      configuration.showsCursor = true

      let outputSink = OneFrameOutput(outputURL: outputURL)
      let stream = SCStream(filter: filter, configuration: configuration, delegate: nil)
      try stream.addStreamOutput(outputSink, type: .screen, sampleHandlerQueue: DispatchQueue(label: "oneesama.app-control.capture"))
      try await stream.startCapture()
      let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000.0)
      while outputSink.result == nil && Date() < deadline {
        try await Task.sleep(nanoseconds: 25_000_000)
      }
      try await stream.stopCapture()

      if outputSink.result == nil {
        throw HelperError.unsupported("frame_timeout")
      }
      switch outputSink.result {
      case .success:
        result = .success([
          "path": outputPath,
          "width": width,
          "height": height,
          "scaleFactor": scaleFactor,
          "source": "macos_screencapturekit",
        ])
      case .failure(let error):
        throw error
      case .none:
        throw HelperError.unsupported("no_frame")
      }
    } catch {
      result = .failure(error)
    }
    semaphore.signal()
  }
  semaphore.wait()
  return try result!.get()
}

func requireAccessibility() throws {
  if !AXIsProcessTrusted() {
    throw HelperError.accessibilityRequired
  }
}

func activateTarget(_ target: [String: Any]) {
  let pid = intValue(target["process_id"]) != 0 ? intValue(target["process_id"]) : intValue(target["processId"])
  if pid > 0, let app = NSRunningApplication(processIdentifier: pid_t(pid)) {
    app.activate(options: [])
  }
}

func windowPoint(_ target: [String: Any], x: Double, y: Double) throws -> CGPoint {
  let window = try findWindow(target: target)
  guard let frame = window["frame"] as? [String: Any] else {
    throw HelperError.targetNotFound("shared_window_frame_unavailable")
  }
  return CGPoint(x: doubleValue(frame["x"]) + x, y: doubleValue(frame["y"]) + y)
}

func postMouse(_ type: CGEventType, point: CGPoint, button: CGMouseButton = .left) {
  CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: button)?
    .post(tap: .cghidEventTap)
}

func click(target: [String: Any], x: Double, y: Double) throws {
  try requireAccessibility()
  activateTarget(target)
  let point = try windowPoint(target, x: x, y: y)
  postMouse(.leftMouseDown, point: point)
  postMouse(.leftMouseUp, point: point)
}

func drag(target: [String: Any], fromX: Double, fromY: Double, toX: Double, toY: Double) throws {
  try requireAccessibility()
  activateTarget(target)
  let start = try windowPoint(target, x: fromX, y: fromY)
  let end = try windowPoint(target, x: toX, y: toY)
  postMouse(.leftMouseDown, point: start)
  postMouse(.leftMouseDragged, point: end)
  postMouse(.leftMouseUp, point: end)
}

func pasteText(target: [String: Any], value: String) throws {
  try requireAccessibility()
  activateTarget(target)
  let pasteboard = NSPasteboard.general
  pasteboard.clearContents()
  pasteboard.setString(value, forType: .string)
  let keyCodeV: CGKeyCode = 9
  let down = CGEvent(keyboardEventSource: nil, virtualKey: keyCodeV, keyDown: true)
  down?.flags = .maskCommand
  let up = CGEvent(keyboardEventSource: nil, virtualKey: keyCodeV, keyDown: false)
  up?.flags = .maskCommand
  down?.post(tap: .cghidEventTap)
  up?.post(tap: .cghidEventTap)
}

func keyCode(_ key: String) -> CGKeyCode? {
  let normalized = key.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  let table: [String: CGKeyCode] = [
    "return": 36, "enter": 36, "tab": 48, "escape": 53, "esc": 53,
    "space": 49, "backspace": 51, "delete": 51,
    "arrowleft": 123, "left": 123, "arrowright": 124, "right": 124,
    "arrowdown": 125, "down": 125, "arrowup": 126, "up": 126,
    "v": 9, "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6,
    "x": 7, "c": 8, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15,
    "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22,
    "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29,
    "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37,
    "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44,
    "n": 45, "m": 46, ".": 47, "`": 50,
  ]
  return table[normalized]
}

func pressKey(target: [String: Any], key: String) throws {
  try requireAccessibility()
  activateTarget(target)
  guard let code = keyCode(key) else {
    throw HelperError.unsupported("unsupported_key:\(key)")
  }
  CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true)?.post(tap: .cghidEventTap)
  CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)?.post(tap: .cghidEventTap)
}

func scroll(target: [String: Any], direction: String) throws {
  try requireAccessibility()
  activateTarget(target)
  let normalized = direction.lowercased()
  let vertical = normalized == "up" ? 8 : normalized == "down" ? -8 : 0
  let horizontal = normalized == "left" ? 8 : normalized == "right" ? -8 : 0
  CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2, wheel1: Int32(vertical), wheel2: Int32(horizontal), wheel3: 0)?
    .post(tap: .cghidEventTap)
}

func state(params: [String: Any]) throws -> [String: Any] {
  let target = targetFromParams(params)
  let window = try? findWindow(target: target)
  var result: [String: Any] = [
    "ok": true,
    "source": "oneesama_app_control_helper",
    "accessibilityTrusted": AXIsProcessTrusted(),
    "applications": listRunningApps(),
  ]
  if window != nil {
    result["window"] = window
  }
  if boolValue(firstParam(params, "includeScreenshot")) {
    guard let window else {
      result["screenshotIncluded"] = false
      result["screenshotBlocker"] = "shared_window_not_found"
      return result
    }
    let windowId = intValue(window["windowId"])
    let outputPath = text(firstParam(params, "screenshotOutput")).isEmpty
      ? "\(NSTemporaryDirectory())oneesama-app-control-state-\(UUID().uuidString).png"
      : text(firstParam(params, "screenshotOutput"))
    do {
      result["screenshot"] = try captureWindowScreenshot(
        windowId: windowId,
        outputPath: outputPath,
        timeoutMs: max(250, intValue(firstParam(params, "timeoutMs")) == 0 ? 1500 : intValue(firstParam(params, "timeoutMs")))
      )
      result["screenshotIncluded"] = true
    } catch {
      result["screenshotIncluded"] = false
      result["screenshotBlocker"] = String(describing: error)
    }
  }
  return result
}

func operationsFromParams(_ params: [String: Any]) -> [[String: Any]] {
  if let operations = params["operations"] as? [[String: Any]] { return operations }
  if let context = params["context"] as? [String: Any], let operations = context["operations"] as? [[String: Any]] {
    return operations
  }
  return []
}

func executeOperation(_ operation: [String: Any], target: [String: Any]) throws -> String {
  let kind = text(operation["kind"])
  switch kind {
  case "state":
    _ = try state(params: ["target": target])
    return "state"
  case "click":
    try click(target: target, x: doubleValue(operation["x"]), y: doubleValue(operation["y"]))
    return "click"
  case "type_text":
    try pasteText(target: target, value: text(operation["text"]))
    return "type_text"
  case "press_key":
    try pressKey(target: target, key: text(operation["key"]))
    return "press_key"
  case "scroll":
    try scroll(target: target, direction: text(operation["direction"]).isEmpty ? "down" : text(operation["direction"]))
    return "scroll"
  case "drag":
    try drag(
      target: target,
      fromX: doubleValue(operation["from_x"]),
      fromY: doubleValue(operation["from_y"]),
      toX: doubleValue(operation["to_x"]),
      toY: doubleValue(operation["to_y"])
    )
    return "drag"
  default:
    throw HelperError.unsupported("unsupported_operation:\(kind)")
  }
}

func controlSharedAppWindow(params: [String: Any]) throws -> [String: Any] {
  let target = targetFromParams(params)
  let operations = operationsFromParams(params)
  let snapshot: [String: Any]
  do {
    snapshot = try state(params: [
      "target": target,
      "context": contextFromParams(params),
    ])
  } catch {
    return [
      "ok": false,
      "summary": "Could not inspect the shared app/window.",
      "actions": [],
      "confidence": 0.2,
      "blocker": String(describing: error),
      "operations": operations,
      "metadata": [:],
    ]
  }
  if operations.isEmpty {
    return [
      "ok": false,
      "summary": "Captured shared app state; structured operations are required for direct app control.",
      "actions": ["state"],
      "confidence": 0.4,
      "blocker": "structured_operations_required",
      "operations": [],
      "metadata": ["state": snapshot],
    ]
  }
  let nonStateOperations = operations.filter { text($0["kind"]) != "state" }
  if nonStateOperations.isEmpty {
    return [
      "ok": true,
      "summary": "Captured shared app state. Continue with concrete click/type_text/press_key/scroll/drag operations.",
      "actions": ["state"],
      "confidence": 0.6,
      "operations": operations,
      "metadata": ["state": snapshot],
    ]
  }
  var actions: [String] = []
  for operation in operations {
    do {
      actions.append(try executeOperation(operation, target: target))
    } catch {
      return [
        "ok": false,
        "summary": "Stopped after \(actions.count) app-control operation(s).",
        "actions": actions,
        "confidence": 0.3,
        "blocker": String(describing: error),
        "operations": operations,
        "metadata": ["state": snapshot],
      ]
    }
  }
  return [
    "ok": true,
    "summary": "Executed \(actions.count) app-control operation(s).",
    "actions": actions,
    "confidence": 0.8,
    "operations": operations,
    "metadata": ["state": snapshot],
  ]
}

func resultFor(method: String, params: [String: Any]) throws -> Any {
  switch method {
  case "list_apps":
    return ["ok": true, "applications": listRunningApps()]
  case "list_windows":
    return ["ok": true, "windows": try listWindows(appFilter: text(params["app"]))]
  case "state":
    return try state(params: params)
  case "click":
    try click(target: targetFromParams(params), x: doubleValue(params["x"]), y: doubleValue(params["y"]))
    return ["ok": true, "actions": ["click"]]
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
    try drag(
      target: targetFromParams(params),
      fromX: doubleValue(params["from_x"]),
      fromY: doubleValue(params["from_y"]),
      toX: doubleValue(params["to_x"]),
      toY: doubleValue(params["to_y"])
    )
    return ["ok": true, "actions": ["drag"]]
  case "app_control.control_shared_app_window":
    return try controlSharedAppWindow(params: params)
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

if CommandLine.arguments.contains("--help") {
  print("usage: app-control-helper --stdio")
} else {
  while let line = readLine(strippingNewline: true) {
    let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
    if !trimmed.isEmpty { handleLine(trimmed) }
  }
}
