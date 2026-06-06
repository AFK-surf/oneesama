import ApplicationServices
import CoreGraphics
import Foundation

func operationFromCUActionEnvelope(_ value: Any?) -> [String: Any] {
  guard let action = value as? [String: Any] else { return [:] }
  let scope = text(action["scope"])
  if !scope.isEmpty && scope != "foreground" && scope != "background" && scope != "global" {
    return ["kind": "unsupported_scope:\(scope)"]
  }
  let actionName = text(action["action"])
  let args = action["args"] as? [String: Any] ?? [:]
  func merged(_ kind: String) -> [String: Any] {
    var operation = args
    operation["kind"] = kind
    return operation
  }
  switch actionName {
  case "get-app-state":
    return ["kind": "state"]
  case "click":
    return merged("click")
  case "double-click", "double_click":
    return merged("double_click")
  case "type-text":
    return merged("type_text")
  case "set-value", "set_value":
    return merged("set_value")
  case "press-key":
    return merged("press_key")
  case "scroll":
    return merged("scroll")
  case "perform-secondary-action", "perform_secondary_action":
    return merged("perform_secondary_action")
  case "drag":
    return merged("drag")
  default:
    return actionName.isEmpty ? [:] : ["kind": "unsupported_action:\(actionName)"]
  }
}

func operationFromActionParams(_ params: [String: Any]) -> [String: Any] {
  if let operation = params["operation"] as? [String: Any] { return operation }
  return operationFromCUActionEnvelope(params["action"])
}

var kwwkCUActiveSession: [String: Any]?

func cuControlSchemaPayload() -> [String: Any] {
  [
    "schema": "oneesama.kwwk-cu-control.v1",
    "source": "cueboard_bridge_computer_use_port",
    "methodFamily": "kwwk.cu",
  ]
}

func cuControlCommand(_ params: [String: Any]) -> String {
  if let control = params["control"] as? [String: Any] {
    for key in ["command", "op", "kind", "name"] {
      let value = text(control[key])
      if !value.isEmpty { return value }
    }
  }
  let control = text(params["control"])
  if !control.isEmpty { return control }
  let op = text(params["op"])
  if !op.isEmpty { return op }
  if let session = params["session"] as? [String: Any] {
    return text(session["op"])
  }
  return ""
}

func cuControlSessionPayload(_ params: [String: Any]) -> [String: Any] {
  if let session = params["session"] as? [String: Any] { return session }
  return params
}

func cuControlMode(_ params: [String: Any], default fallback: String = "") -> String {
  let session = cuControlSessionPayload(params)
  let mode = text(session["mode"]).isEmpty ? text(params["mode"]) : text(session["mode"])
  if mode == "foreground" || mode == "background" { return mode }
  return fallback
}

func stringArray(_ value: Any?) -> [String] {
  guard let values = value as? [Any] else { return [] }
  return values.map { text($0) }.filter { !$0.isEmpty }
}

func cuSessionID(_ params: [String: Any]) -> String {
  let session = cuControlSessionPayload(params)
  let candidate = text(session["id"]).isEmpty
    ? text(params["session_id"])
    : text(session["id"])
  if !candidate.isEmpty { return candidate }
  return "cu_session_\(UUID().uuidString.lowercased())"
}

func cuSessionFromStartRequest(_ params: [String: Any], mode: String) -> [String: Any] {
  let session = cuControlSessionPayload(params)
  let foreground = session["foreground"] as? [String: Any] ?? params["foreground"] as? [String: Any] ?? [:]
  let background = session["background"] as? [String: Any] ?? params["background"] as? [String: Any] ?? [:]
  var payload: [String: Any] = [
    "id": cuSessionID(params),
    "mode": mode,
    "status": "running",
    "startedAtMs": Int(Date().timeIntervalSince1970 * 1000),
  ]
  if mode == "foreground" {
    var foregroundPayload: [String: Any] = ["apps": stringArray(foreground["apps"])]
    if foreground["display"] != nil {
      foregroundPayload["display"] = intValue(foreground["display"])
    }
    payload["foreground"] = foregroundPayload
  }
  if mode == "background" {
    payload["background"] = background
  }
  return payload
}

func screenRecordingTrusted() -> Bool {
  CGPreflightScreenCaptureAccess()
}

func cuPermissionsPayload() -> [String: Any] {
  let accessibilityTrusted = AXIsProcessTrusted()
  let screenTrusted = screenRecordingTrusted()
  let missing = [
    accessibilityTrusted ? "" : "accessibility",
    screenTrusted ? "" : "screen_recording",
  ].filter { !$0.isEmpty }
  return [
    "accessibilityTrusted": accessibilityTrusted,
    "screenRecordingTrusted": screenTrusted,
    "screenRecording": screenTrusted,
    "missing": missing,
  ]
}

func cuModeHelpPayload(mode: String) -> [String: Any] {
  let foregroundActions = ["click", "mouse-down", "mouse-up", "mouse-move", "drag", "type-text", "press-key", "hold-key", "scroll", "wait", "screenshot", "zoom", "screen-size", "cursor-position", "focus", "focus-window", "get-app-state", "thinking"]
  let backgroundActions = ["list-apps", "open-app", "list-windows", "get-app-state", "click", "type-text", "set-value", "press-key", "scroll", "perform-secondary-action", "drag"]
  var payload: [String: Any] = [
    "modes": ["foreground", "background"],
    "foregroundActions": foregroundActions,
    "backgroundActions": backgroundActions,
  ]
  if mode == "foreground" {
    payload["mode"] = mode
    payload["actions"] = foregroundActions
  } else if mode == "background" {
    payload["mode"] = mode
    payload["actions"] = backgroundActions
  }
  return payload
}

func cuControl(params: [String: Any]) -> [String: Any] {
  let command = cuControlCommand(params)
  var base = cuControlSchemaPayload()
  switch command {
  case "ping", "":
    base["ok"] = true
    base["status"] = "ready"
    base["text"] = "pong"
    return base
  case "permissions-status":
    let permissions = cuPermissionsPayload()
    base["ok"] = true
    base["status"] = (permissions["missing"] as? [String] ?? []).isEmpty ? "ready" : "missing_permissions"
    base["permissions"] = permissions
    return base
  case "session-status":
    base["ok"] = true
    base["status"] = kwwkCUActiveSession == nil ? "idle" : "running"
    base["daemon"] = "running"
    base["pid"] = ProcessInfo.processInfo.processIdentifier
    if let active = kwwkCUActiveSession {
      base["mode"] = text(active["mode"])
      base["session"] = active
    } else {
      base["mode"] = NSNull()
    }
    return base
  case "mode-help":
    let mode = cuControlMode(params)
    base["ok"] = true
    base["status"] = "ready"
    base["help"] = cuModeHelpPayload(mode: mode)
    return base
  case "planner-prewarm", "planner-status":
    for (key, value) in plannerPrewarmPayload() {
      base[key] = value
    }
    return base
  case "cursor-prewarm", "cursor-status":
    for (key, value) in nativeCursorPrewarmPayload() {
      base[key] = value
    }
    return base
  case "start":
    guard kwwkCUActiveSession == nil else {
      base["ok"] = false
      base["status"] = "blocked"
      base["blocker"] = "session_already_active"
      base["session"] = kwwkCUActiveSession ?? [:]
      return base
    }
    let mode = cuControlMode(params)
    guard !mode.isEmpty else {
      base["ok"] = false
      base["status"] = "blocked"
      base["blocker"] = "start_missing_mode"
      return base
    }
    let session = cuSessionFromStartRequest(params, mode: mode)
    kwwkCUActiveSession = session
    base["ok"] = true
    base["status"] = "running"
    base["text"] = "session started (mode=\(mode))"
    base["mode"] = mode
    base["session"] = session
    return base
  case "stop":
    guard let active = kwwkCUActiveSession else {
      finishKWWKCUCoreSession()
      base["ok"] = true
      base["status"] = "idle"
      base["text"] = "no active session"
      return base
    }
    kwwkCUActiveSession = nil
    finishKWWKCUCoreSession()
    base["ok"] = true
    base["status"] = "stopped"
    base["text"] = "session stopped"
    base["mode"] = text(active["mode"])
    base["session"] = active
    return base
  case "open-permission-flow":
    base["ok"] = false
    base["status"] = "blocked"
    base["blocker"] = "permission_flow_unavailable_in_helper"
    return base
  default:
    base["ok"] = false
    base["status"] = "blocked"
    base["blocker"] = "unsupported_cu_control:\(command)"
    return base
  }
}
