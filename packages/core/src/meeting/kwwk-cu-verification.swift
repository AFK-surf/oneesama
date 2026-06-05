import Foundation

func verificationExpectationsFromParams(_ params: [String: Any]) -> [String: Any] {
  if let verification = params["verification"] as? [String: Any] { return verification }
  if let contextVerification = contextFromParams(params)["verification"] as? [String: Any] {
    return contextVerification
  }
  return [:]
}

func compactVerificationState(_ value: [String: Any]) -> [String: Any] {
  var compact: [String: Any] = [
    "ok": boolValue(value["ok"]),
    "source": text(value["source"]),
    "accessibilityTrusted": boolValue(value["accessibilityTrusted"]),
  ]
  if let window = value["window"] as? [String: Any] {
    compact["window"] = [
      "title": text(window["title"]),
      "applicationName": text(window["applicationName"]),
      "bundleIdentifier": text(window["bundleIdentifier"]),
      "windowId": intValue(window["windowId"]),
    ]
  }
  if let focused = value["focusedApplication"] as? [String: Any] {
    compact["focusedApplication"] = [
      "applicationName": text(focused["applicationName"]),
      "bundleIdentifier": text(focused["bundleIdentifier"]),
      "processId": intValue(focused["processId"]),
    ]
  }
  if let accessibility = value["accessibility"] as? [[String: Any]] {
    compact["accessibilityElementCount"] = accessibility.count
    compact["accessibilityLabels"] = accessibility.prefix(12).map { text($0["label"]) }.filter { !$0.isEmpty }
  } else {
    compact["accessibilityElementCount"] = 0
    compact["accessibilityLabels"] = []
  }
  if value["screenshotIncluded"] != nil {
    compact["screenshotIncluded"] = boolValue(value["screenshotIncluded"])
  }
  let screenshotBlocker = text(value["screenshotBlocker"])
  if !screenshotBlocker.isEmpty { compact["screenshotBlocker"] = screenshotBlocker }
  return compact
}

func stateWindowTitle(_ state: [String: Any]) -> String {
  guard let window = state["window"] as? [String: Any] else { return "" }
  return text(window["title"])
}

func stateFocusedApplicationName(_ state: [String: Any]) -> String {
  guard let focused = state["focusedApplication"] as? [String: Any] else { return "" }
  return text(focused["applicationName"])
}

func stateAccessibilityLabelsContain(_ state: [String: Any], expected: String) -> Bool {
  let needle = expected.lowercased()
  guard !needle.isEmpty, let accessibility = state["accessibility"] as? [[String: Any]] else {
    return false
  }
  return accessibility.contains { element in
    text(element["label"]).lowercased().contains(needle)
  }
}

func verificationCheck(_ name: String, passed: Bool, details: [String: Any] = [:]) -> [String: Any] {
  var check = details
  check["name"] = name
  check["passed"] = passed
  return check
}

func verifyPostActionState(
  params: [String: Any],
  target: [String: Any],
  operations: [[String: Any]],
  beforeState: [String: Any],
  actions: [String]
) -> [String: Any] {
  let started = Date()
  let expectations = verificationExpectationsFromParams(params)
  let fullObservation = appControlNeedsFullObservation(params: params, operations: operations)
  var checks: [[String: Any]] = []
  let postState: [String: Any]
  do {
    postState = try state(params: [
      "target": target,
      "context": appControlObservationContext(params: params, full: fullObservation),
    ])
    checks.append(verificationCheck("post_state_observed", passed: boolValue(postState["ok"])))
  } catch {
    let durationMs = Int(Date().timeIntervalSince(started) * 1000)
    return [
      "schema": "oneesama.kwwk-cu-verification.v1",
      "ok": false,
      "status": "failed",
      "blocker": "failed_verification",
      "reason": "post_state_observation_failed:\(String(describing: error))",
      "durationMs": max(0, durationMs),
      "observationMode": fullObservation ? "full" : "light",
      "checks": [
        verificationCheck("post_state_observed", passed: false, details: [
          "error": String(describing: error),
        ]),
      ],
      "preState": compactVerificationState(beforeState),
    ]
  }

  let expectedActionCount = operations.count
  checks.append(verificationCheck("action_count_matches_plan", passed: actions.count == expectedActionCount, details: [
    "expected": expectedActionCount,
    "actual": actions.count,
  ]))

  let expectedTitle = text(expectations["expectedWindowTitleContains"])
  if !expectedTitle.isEmpty {
    let actualTitle = stateWindowTitle(postState)
    checks.append(verificationCheck("window_title_contains", passed: actualTitle.lowercased().contains(expectedTitle.lowercased()), details: [
      "expected": expectedTitle,
      "actual": actualTitle,
    ]))
  }

  let expectedFocusedApp = text(expectations["expectedFocusedApplicationNameContains"])
  if !expectedFocusedApp.isEmpty {
    let actualFocusedApp = stateFocusedApplicationName(postState)
    checks.append(verificationCheck("focused_application_contains", passed: actualFocusedApp.lowercased().contains(expectedFocusedApp.lowercased()), details: [
      "expected": expectedFocusedApp,
      "actual": actualFocusedApp,
    ]))
  }

  let expectedLabel = text(expectations["expectedAccessibilityLabelContains"])
  if !expectedLabel.isEmpty {
    checks.append(verificationCheck("accessibility_label_contains", passed: stateAccessibilityLabelsContain(postState, expected: expectedLabel), details: [
      "expected": expectedLabel,
    ]))
  }

  let passed = checks.allSatisfy { boolValue($0["passed"]) }
  let durationMs = Int(Date().timeIntervalSince(started) * 1000)
  return [
    "schema": "oneesama.kwwk-cu-verification.v1",
    "ok": passed,
    "status": passed ? "passed" : "failed",
    "blocker": passed ? "" : "failed_verification",
    "reason": passed ? "post_state_verified" : "post_state_verification_failed",
    "durationMs": max(0, durationMs),
    "observationMode": fullObservation ? "full" : "light",
    "checks": checks,
    "preState": compactVerificationState(beforeState),
    "postState": compactVerificationState(postState),
  ]
}
