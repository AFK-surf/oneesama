import Foundation

@main
struct AppControlHelperMain {
  static func main() {
    if CommandLine.arguments.contains("--help") {
      print("usage: app-control-helper --stdio")
      return
    }
    while let line = readLine(strippingNewline: true) {
      let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
      if !trimmed.isEmpty { handleLine(trimmed) }
    }
  }
}
