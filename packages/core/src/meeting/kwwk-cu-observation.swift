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

func focusedApplicationPayload() -> [String: Any] {
  guard let app = NSWorkspace.shared.frontmostApplication else { return [:] }
  var payload = runningAppPayload(app)
  payload["focused"] = true
  payload["source"] = "macos_frontmost_application"
  return payload
}

func shareableContent() throws -> SCShareableContent {
  var result: Result<SCShareableContent, Error>?
  let semaphore = DispatchSemaphore(value: 0)
  Task.detached {
    do {
      result = .success(try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true))
    } catch {
      result = .failure(error)
    }
    semaphore.signal()
  }
  if semaphore.wait(timeout: .now() + .seconds(5)) == .timedOut {
    throw HelperError.unsupported("shareable_content_timeout")
  }
  guard let result else {
    throw HelperError.unsupported("shareable_content_missing_result")
  }
  return try result.get()
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
  Task.detached {
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
  let hardTimeoutMs = max(1000, timeoutMs + 1000)
  if semaphore.wait(timeout: .now() + .milliseconds(hardTimeoutMs)) == .timedOut {
    throw HelperError.unsupported("capture_hard_timeout")
  }
  guard let result else {
    throw HelperError.unsupported("capture_missing_result")
  }
  return try result.get()
}

func axAttribute(_ element: AXUIElement, _ attribute: String) -> Any? {
  var value: CFTypeRef?
  let error = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
  guard error == .success else { return nil }
  return value
}

func axStringAttribute(_ element: AXUIElement, _ attributes: [String]) -> String {
  for attribute in attributes {
    if let value = axAttribute(element, attribute) {
      let textValue = text(value)
      if !textValue.isEmpty { return textValue }
    }
  }
  return ""
}

func axPointAttribute(_ element: AXUIElement, _ attribute: String) -> CGPoint? {
  guard let value = axAttribute(element, attribute),
        CFGetTypeID(value as CFTypeRef) == AXValueGetTypeID() else { return nil }
  let axValue = value as! AXValue
  var point = CGPoint.zero
  if AXValueGetValue(axValue, .cgPoint, &point) {
    return point
  }
  return nil
}

func axSizeAttribute(_ element: AXUIElement, _ attribute: String) -> CGSize? {
  guard let value = axAttribute(element, attribute),
        CFGetTypeID(value as CFTypeRef) == AXValueGetTypeID() else { return nil }
  let axValue = value as! AXValue
  var size = CGSize.zero
  if AXValueGetValue(axValue, .cgSize, &size) {
    return size
  }
  return nil
}

func axElementArrayAttribute(_ element: AXUIElement, _ attribute: String) -> [AXUIElement] {
  guard let values = axAttribute(element, attribute) as? [Any] else { return [] }
  return values.compactMap { value in
    guard CFGetTypeID(value as CFTypeRef) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
  }
}

func axElementFrame(_ element: AXUIElement) -> CGRect? {
  guard let position = axPointAttribute(element, kAXPositionAttribute),
        let size = axSizeAttribute(element, kAXSizeAttribute),
        size.width > 0,
        size.height > 0 else {
    return nil
  }
  return CGRect(origin: position, size: size)
}

func collectAccessibilityElements(window: [String: Any]?, target: [String: Any], limit: Int = 180) -> [[String: Any]] {
  guard AXIsProcessTrusted() else { return [] }
  let windowProcessId = intValue(window?["processId"])
  let snakeProcessId = intValue(target["process_id"])
  let camelProcessId = intValue(target["processId"])
  let processId = windowProcessId != 0 ? windowProcessId : snakeProcessId != 0 ? snakeProcessId : camelProcessId
  guard processId > 0 else { return [] }
  let windowFrame = window?["frame"] as? [String: Any] ?? [:]
  let originX = doubleValue(windowFrame["x"])
  let originY = doubleValue(windowFrame["y"])
  let width = max(1, doubleValue(windowFrame["width"]))
  let height = max(1, doubleValue(windowFrame["height"]))
  let windowRect = CGRect(x: originX, y: originY, width: width, height: height)
  let app = AXUIElementCreateApplication(pid_t(processId))
  var out: [[String: Any]] = []

  func visit(_ element: AXUIElement, depth: Int) {
    if out.count >= limit || depth > 7 { return }
    let role = axStringAttribute(element, [kAXRoleAttribute])
    let label = axStringAttribute(element, [
      kAXTitleAttribute,
      kAXDescriptionAttribute,
      kAXValueAttribute,
      kAXIdentifierAttribute,
      kAXHelpAttribute,
    ])
    if let frame = axElementFrame(element) {
      let center = CGPoint(x: frame.midX, y: frame.midY)
      if windowRect.contains(center) {
        let relativeFrame = [
          "x": max(0, frame.minX - originX),
          "y": max(0, frame.minY - originY),
          "width": frame.width,
          "height": frame.height,
        ]
        if containsAny(role.lowercased(), ["button", "checkbox", "radio", "menu item", "textfield", "text field"]) || !label.isEmpty {
          out.append([
            "role": role,
            "label": label,
            "visible": true,
            "enabled": true,
            "frame": relativeFrame,
          ])
        }
      }
    }
    for child in axElementArrayAttribute(element, kAXChildrenAttribute).prefix(80) {
      visit(child, depth: depth + 1)
      if out.count >= limit { return }
    }
  }

  let windows = axElementArrayAttribute(app, kAXWindowsAttribute)
  if windows.isEmpty {
    visit(app, depth: 0)
  } else {
    for axWindow in windows.prefix(12) {
      visit(axWindow, depth: 0)
      if out.count >= limit { break }
    }
  }
  return out
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
    return
  }
  let bundle = text(target["bundle_identifier"]).isEmpty ? text(target["bundleIdentifier"]) : text(target["bundle_identifier"])
  if !bundle.isEmpty,
     let app = NSWorkspace.shared.runningApplications.first(where: {
       text($0.bundleIdentifier).caseInsensitiveCompare(bundle) == .orderedSame
     }) {
    app.activate(options: [])
    return
  }
  let appName = text(target["application_name"]).isEmpty ? text(target["applicationName"]) : text(target["application_name"])
  if !appName.isEmpty,
     let app = NSWorkspace.shared.runningApplications.first(where: {
       let name = text($0.localizedName).lowercased()
       let wanted = appName.lowercased()
       return name == wanted || name.contains(wanted)
     }) {
    app.activate(options: [])
  }
}

func state(params: [String: Any]) throws -> [String: Any] {
  let target = targetFromParams(params)
  let includeApplicationsParam = firstParam(params, "includeApplications")
  let includeWindowParam = firstParam(params, "includeWindow")
  let includeAccessibilityParam = firstParam(params, "includeAccessibility")
  let includeScreenshot = boolValue(firstParam(params, "includeScreenshot"))
  let includeApplications = includeApplicationsParam == nil ? true : boolValue(includeApplicationsParam)
  let includeWindow = includeWindowParam == nil ? true : boolValue(includeWindowParam)
  let includeAccessibility = includeAccessibilityParam == nil ? true : boolValue(includeAccessibilityParam)
  let needsWindow = includeWindow || includeAccessibility || includeScreenshot
  let window = needsWindow ? try? findWindow(target: target) : nil
  var result: [String: Any] = [
    "ok": true,
    "source": "oneesama_app_control_helper",
    "accessibilityTrusted": AXIsProcessTrusted(),
    "applicationsIncluded": includeApplications,
    "windowIncluded": includeWindow,
    "accessibilityIncluded": includeAccessibility,
  ]
  if includeApplications {
    result["applications"] = listRunningApps()
  }
  let focusedApplication = focusedApplicationPayload()
  if !focusedApplication.isEmpty {
    result["focusedApplication"] = focusedApplication
  }
  if includeWindow && window != nil {
    result["window"] = window
  }
  if includeAccessibility {
    let accessibility = collectAccessibilityElements(window: window, target: target)
    if !accessibility.isEmpty {
      result["accessibility"] = accessibility
    }
  }
  if includeScreenshot {
    guard let window else {
      result["screenshotIncluded"] = false
      result["screenshotBlocker"] = "shared_window_not_found"
      return result
    }
    let windowId = intValue(window["windowId"])
    let outputPath = text(firstParam(params, "screenshotOutput")).isEmpty
      ? "\(NSTemporaryDirectory())oneesama-app-control-state-\(UUID().uuidString).png"
      : text(firstParam(params, "screenshotOutput"))
    let requestedTimeoutMs = intValue(firstParam(params, "timeoutMs"))
    let screenshotTimeoutMs = min(3000, max(250, requestedTimeoutMs == 0 ? 1500 : requestedTimeoutMs))
    do {
      var screenshot = try captureWindowScreenshot(
        windowId: windowId,
        outputPath: outputPath,
        timeoutMs: screenshotTimeoutMs
      )
      screenshot["coordinateSpaceId"] = "kwwk_window_points"
      screenshot["coordinateSpace"] = cursorCoordinateSpace(target: target)
      result["screenshot"] = screenshot
      result["screenshotIncluded"] = true
    } catch {
      result["screenshotIncluded"] = false
      result["screenshotBlocker"] = String(describing: error)
    }
  }
  return result
}
