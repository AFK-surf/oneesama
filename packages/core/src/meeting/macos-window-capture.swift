import AppKit
import CoreGraphics
import CoreImage
import CoreMedia
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

struct ToolError: Error, CustomStringConvertible {
  let description: String
  init(_ description: String) {
    self.description = description
  }
}

func jsonData(_ value: Any) throws -> Data {
  try JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys])
}

func printJSON(_ value: Any) throws {
  let data = try jsonData(value)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
}

func parseArgs(_ args: [String]) -> [String: String] {
  var result: [String: String] = [:]
  var index = 0
  while index < args.count {
    let arg = args[index]
    if arg.hasPrefix("--") {
      let key = String(arg.dropFirst(2))
      if index + 1 < args.count, !args[index + 1].hasPrefix("--") {
        result[key] = args[index + 1]
        index += 2
      } else {
        result[key] = "true"
        index += 1
      }
    } else {
      index += 1
    }
  }
  return result
}

func windowPayload(_ window: SCWindow, index: Int) -> [String: Any] {
  let app = window.owningApplication
  return [
    "windowId": Int(window.windowID),
    "windowID": Int(window.windowID),
    "title": window.title ?? "",
    "name": window.title ?? app?.applicationName ?? "window-\(index + 1)",
    "applicationName": app?.applicationName ?? "",
    "bundleIdentifier": app?.bundleIdentifier ?? "",
    "processId": Int(app?.processID ?? 0),
    "pid": Int(app?.processID ?? 0),
    "frame": [
      "x": window.frame.origin.x,
      "y": window.frame.origin.y,
      "width": window.frame.size.width,
      "height": window.frame.size.height,
    ],
    "source": "macos_screencapturekit",
  ]
}

func backingScaleFactor(for frame: CGRect) -> CGFloat {
  let center = CGPoint(x: frame.midX, y: frame.midY)
  if let screen = NSScreen.screens.first(where: { $0.frame.contains(center) }) {
    return max(1, screen.backingScaleFactor)
  }
  return max(1, NSScreen.main?.backingScaleFactor ?? 1)
}

@available(macOS 12.3, *)
func writePixelBufferPNG(_ pixelBuffer: CVPixelBuffer, outputURL: URL) throws {
  try writePixelBufferImage(pixelBuffer, outputURL: outputURL, type: UTType.png, properties: nil)
}

@available(macOS 12.3, *)
func writePixelBufferJPEG(_ pixelBuffer: CVPixelBuffer, outputURL: URL) throws {
  try writePixelBufferImage(
    pixelBuffer,
    outputURL: outputURL,
    type: UTType.jpeg,
    properties: [kCGImageDestinationLossyCompressionQuality as String: 0.82] as CFDictionary
  )
}

@available(macOS 12.3, *)
func writePixelBufferImage(
  _ pixelBuffer: CVPixelBuffer,
  outputURL: URL,
  type: UTType,
  properties: CFDictionary?
) throws {
  let context = CIContext(options: nil)
  let image = CIImage(cvPixelBuffer: pixelBuffer)
  guard let cgImage = context.createCGImage(image, from: image.extent) else {
    throw ToolError("create_cg_image_failed")
  }
  guard let destination = CGImageDestinationCreateWithURL(
    outputURL as CFURL,
    type.identifier as CFString,
    1,
    nil
  ) else {
    throw ToolError("create_image_destination_failed")
  }
  CGImageDestinationAddImage(destination, cgImage, properties)
  guard CGImageDestinationFinalize(destination) else {
    throw ToolError("write_image_failed")
  }
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

@available(macOS 12.3, *)
final class StreamingOutput: NSObject, SCStreamOutput {
  let outputURL: URL
  let ready = DispatchSemaphore(value: 0)
  var frameCount = 0
  var firstError: Error?
  var firstFrameWritten = false

  init(outputURL: URL) {
    self.outputURL = outputURL
  }

  func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
    guard outputType == .screen else { return }
    guard CMSampleBufferIsValid(sampleBuffer), let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else {
      return
    }
    do {
      let temporaryURL = outputURL.deletingLastPathComponent().appendingPathComponent(
        ".\(outputURL.lastPathComponent).tmp"
      )
      if outputURL.pathExtension.lowercased() == "jpg" || outputURL.pathExtension.lowercased() == "jpeg" {
        try writePixelBufferJPEG(pixelBuffer, outputURL: temporaryURL)
      } else {
        try writePixelBufferPNG(pixelBuffer, outputURL: temporaryURL)
      }
      if FileManager.default.fileExists(atPath: outputURL.path) {
        try FileManager.default.removeItem(at: outputURL)
      }
      try FileManager.default.moveItem(at: temporaryURL, to: outputURL)
      frameCount += 1
      if !firstFrameWritten {
        firstFrameWritten = true
        ready.signal()
      }
    } catch {
      if firstError == nil {
        firstError = error
        ready.signal()
      }
    }
  }
}

@available(macOS 12.3, *)
func shareableContent() async throws -> SCShareableContent {
  try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
}

@available(macOS 12.3, *)
func listWindows() async throws {
  let content = try await shareableContent()
  let windows = content.windows
    .enumerated()
    .filter { _, window in
      window.frame.width >= 80
        && window.frame.height >= 60
        && (window.owningApplication?.processID ?? 0) > 0
    }
    .map { index, window in windowPayload(window, index: index) }
  try printJSON([
    "ok": true,
    "source": "macos_screencapturekit",
    "count": windows.count,
    "windows": windows,
    "applications": windows,
  ])
}

@available(macOS 12.3, *)
func captureWindow(args: [String: String]) async throws {
  guard let rawWindowID = args["window-id"] ?? args["windowId"], let windowID = UInt32(rawWindowID) else {
    throw ToolError("window-id is required")
  }
  guard let output = args["output"], !output.isEmpty else {
    throw ToolError("output is required")
  }
  let timeoutMs = Int(args["timeout-ms"] ?? "") ?? 2500
  let content = try await shareableContent()
  guard let window = content.windows.first(where: { $0.windowID == windowID }) else {
    throw ToolError("window_not_found")
  }
  let outputURL = URL(fileURLWithPath: output)
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
  // ScreenCaptureKit otherwise leaves desktop-independent windows in the top-left
  // of a larger Retina-sized surface, which appears as a cropped share in Meet.
  configuration.scalesToFit = true
  configuration.showsCursor = true

  let outputSink = OneFrameOutput(outputURL: outputURL)
  let stream = SCStream(filter: filter, configuration: configuration, delegate: nil)
  try stream.addStreamOutput(outputSink, type: .screen, sampleHandlerQueue: DispatchQueue(label: "oneesama.window.capture"))
  try await stream.startCapture()
  let waitResult = outputSink.semaphore.wait(timeout: .now() + .milliseconds(timeoutMs))
  try await stream.stopCapture()

  if waitResult == .timedOut {
    throw ToolError("frame_timeout")
  }
  switch outputSink.result {
  case .success:
    try printJSON([
      "ok": true,
      "source": "macos_screencapturekit",
      "window": windowPayload(window, index: 0),
      "output": output,
      "width": width,
      "height": height,
      "scaleFactor": scaleFactor,
    ])
  case .failure(let error):
    throw error
  case .none:
    throw ToolError("no_frame")
  }
}

@available(macOS 12.3, *)
func streamWindow(args: [String: String]) async throws {
  guard let rawWindowID = args["window-id"] ?? args["windowId"], let windowID = UInt32(rawWindowID) else {
    throw ToolError("window-id is required")
  }
  guard let output = args["output"], !output.isEmpty else {
    throw ToolError("output is required")
  }
  let fps = max(1, min(30, Int(args["fps"] ?? "") ?? 25))
  let timeoutMs = Int(args["timeout-ms"] ?? "") ?? 2500
  let content = try await shareableContent()
  guard let window = content.windows.first(where: { $0.windowID == windowID }) else {
    throw ToolError("window_not_found")
  }
  let outputURL = URL(fileURLWithPath: output)
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
  configuration.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
  configuration.queueDepth = 5
  configuration.scalesToFit = true
  configuration.showsCursor = true

  let outputSink = StreamingOutput(outputURL: outputURL)
  let stream = SCStream(filter: filter, configuration: configuration, delegate: nil)
  try stream.addStreamOutput(outputSink, type: .screen, sampleHandlerQueue: DispatchQueue(label: "oneesama.window.stream"))
  try await stream.startCapture()
  let waitResult = outputSink.ready.wait(timeout: .now() + .milliseconds(timeoutMs))
  if let error = outputSink.firstError {
    try await stream.stopCapture()
    throw error
  }
  if waitResult == .timedOut {
    try await stream.stopCapture()
    throw ToolError("frame_timeout")
  }
  try printJSON([
    "ok": true,
    "source": "macos_screencapturekit",
    "window": windowPayload(window, index: 0),
    "output": output,
    "width": width,
    "height": height,
    "scaleFactor": scaleFactor,
    "fps": fps,
    "mode": "stream",
  ])

  while !Task.isCancelled {
    try await Task.sleep(nanoseconds: 1_000_000_000)
  }
  try await stream.stopCapture()
}

@main
struct Main {
  static func main() async {
    do {
      if #available(macOS 12.3, *) {
        let args = Array(CommandLine.arguments.dropFirst())
        let command = args.first ?? "help"
        let parsed = parseArgs(Array(args.dropFirst()))
        switch command {
        case "list":
          try await listWindows()
        case "capture":
          try await captureWindow(args: parsed)
        case "stream":
          try await streamWindow(args: parsed)
        default:
          try printJSON([
            "ok": false,
            "error": "usage",
            "commands": ["list", "capture --window-id <id> --output <path>", "stream --window-id <id> --output <path>"],
          ])
          Foundation.exit(2)
        }
      } else {
        throw ToolError("macos_12_3_required")
      }
    } catch {
      let message = (error as? ToolError)?.description ?? String(describing: error)
      try? printJSON(["ok": false, "error": message])
      Foundation.exit(1)
    }
  }
}
