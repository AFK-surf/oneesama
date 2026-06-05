import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

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

func keySpec(_ key: String) -> (code: CGKeyCode, flags: CGEventFlags)? {
  let normalized = key.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  if let code = keyCode(normalized) {
    return (code, CGEventFlags())
  }
  var flags = CGEventFlags()
  var keyName = ""
  for rawPart in normalized.split(separator: "+") {
    let part = String(rawPart).trimmingCharacters(in: .whitespacesAndNewlines)
    switch part {
    case "cmd", "command", "meta":
      flags.insert(.maskCommand)
    case "ctrl", "control":
      flags.insert(.maskControl)
    case "option", "alt":
      flags.insert(.maskAlternate)
    case "shift":
      flags.insert(.maskShift)
    default:
      keyName = part
    }
  }
  guard !keyName.isEmpty, let code = keyCode(keyName) else {
    return nil
  }
  return (code, flags)
}

func pressKey(target: [String: Any], key: String) throws {
  try requireAccessibility()
  activateTarget(target)
  guard let spec = keySpec(key) else {
    throw HelperError.unsupported("unsupported_key:\(key)")
  }
  let down = CGEvent(keyboardEventSource: nil, virtualKey: spec.code, keyDown: true)
  down?.flags = spec.flags
  let up = CGEvent(keyboardEventSource: nil, virtualKey: spec.code, keyDown: false)
  up?.flags = spec.flags
  down?.post(tap: .cghidEventTap)
  up?.post(tap: .cghidEventTap)
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
