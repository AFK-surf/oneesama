import Foundation

let geminiPlannerURLSession: URLSession = {
  let configuration = URLSessionConfiguration.ephemeral
  configuration.httpMaximumConnectionsPerHost = 32
  configuration.timeoutIntervalForRequest = 3
  configuration.timeoutIntervalForResource = 3
  configuration.waitsForConnectivity = false
  return URLSession(configuration: configuration)
}()

func plannerModelSchema(allowedOperations: [[String: Any]] = [], fixedDeterministicEnvelope: Bool = false) -> [String: Any] {
  func actionSchema(kind: String, properties: [String: Any], required: [String]) -> [String: Any] {
    var allProperties = properties
    allProperties["kind"] = ["type": "string", "enum": [kind]]
    return [
      "type": "object",
      "additionalProperties": false,
      "properties": allProperties,
      "required": ["kind"] + required,
    ]
  }

  func literalActionSchema(_ operation: [String: Any]) -> [String: Any] {
    let kind = text(operation["kind"])
    var properties: [String: Any] = ["kind": ["type": "string", "enum": [kind]]]
    var required = ["kind"]
    for key in operation.keys.sorted() where key != "kind" {
      guard let value = operation[key] else { continue }
      required.append(key)
      if value is NSNumber || value is Int || value is Double || value is Float {
        properties[key] = ["type": "number"]
      } else {
        properties[key] = ["type": "string", "enum": [text(value)]]
      }
    }
    return [
      "type": "object",
      "additionalProperties": false,
      "properties": properties,
      "required": required,
    ]
  }

  let operationSchema: [String: Any]
  if !allowedOperations.isEmpty {
    operationSchema = allowedOperations.count == 1
      ? literalActionSchema(allowedOperations[0])
      : [
        "anyOf": allowedOperations.map { literalActionSchema($0) },
      ]
  } else {
    operationSchema = [
      "anyOf": [
      actionSchema(kind: "state", properties: [:], required: []),
      actionSchema(
        kind: "click",
        properties: [
          "x": ["type": "number"],
          "y": ["type": "number"],
          "elementIndex": ["type": "number"],
          "targetRole": ["type": "string"],
          "targetLabel": ["type": "string"],
        ],
        required: []
      ),
      actionSchema(
        kind: "double_click",
        properties: [
          "x": ["type": "number"],
          "y": ["type": "number"],
          "elementIndex": ["type": "number"],
          "targetRole": ["type": "string"],
          "targetLabel": ["type": "string"],
        ],
        required: []
      ),
      actionSchema(
        kind: "type_text",
        properties: [
          "text": ["type": "string"],
          "elementIndex": ["type": "number"],
        ],
        required: ["text"]
      ),
      actionSchema(
        kind: "press_key",
        properties: ["key": ["type": "string"]],
        required: ["key"]
      ),
      actionSchema(
        kind: "scroll",
        properties: [
          "direction": ["type": "string", "enum": ["up", "down", "left", "right"]],
          "elementIndex": ["type": "number"],
          "pages": ["type": "number"],
        ],
        required: ["direction"]
      ),
      actionSchema(
        kind: "drag",
        properties: [
          "from_x": ["type": "number"],
          "from_y": ["type": "number"],
          "to_x": ["type": "number"],
          "to_y": ["type": "number"],
        ],
        required: ["from_x", "from_y", "to_x", "to_y"]
      ),
      ],
    ]
  }
  var operationsSchema: [String: Any] = ["type": "array", "items": operationSchema]
  if !allowedOperations.isEmpty {
    operationsSchema["minItems"] = allowedOperations.count
    operationsSchema["maxItems"] = allowedOperations.count
  }
  let deterministicEnvelope = fixedDeterministicEnvelope && !allowedOperations.isEmpty
  return [
    "type": "object",
    "additionalProperties": false,
    "properties": [
      "status": deterministicEnvelope
        ? ["type": "string", "enum": ["planned"]]
        : ["type": "string", "enum": ["planned", "blocked", "needs_background_agent"]],
      "summary": deterministicEnvelope
        ? ["type": "string", "enum": ["ok"]]
        : ["type": "string"],
      "blocker": deterministicEnvelope
        ? ["type": "string", "enum": ["none"]]
        : ["type": "string"],
      "operations": operationsSchema,
    ],
    "required": ["status", "summary", "blocker", "operations"],
  ]
}

func compactPlannerModelSchema() -> [String: Any] {
  [
    "type": "object",
    "additionalProperties": false,
    "properties": [
      "status": ["type": "string", "enum": ["planned", "blocked", "needs_background_agent"]],
      "summary": ["type": "string"],
      "blocker": ["type": "string"],
      "operations": [
        "type": "array",
        "items": [
          "type": "object",
          "additionalProperties": false,
          "properties": [
            "kind": ["type": "string", "enum": ["state", "click", "double_click", "type_text", "press_key", "scroll", "drag", "set_value", "perform_secondary_action"]],
            "x": ["type": "number"],
            "y": ["type": "number"],
            "elementIndex": ["type": "number"],
            "targetRole": ["type": "string"],
            "targetLabel": ["type": "string"],
            "text": ["type": "string"],
            "value": ["type": "string"],
            "action": ["type": "string"],
            "key": ["type": "string"],
            "direction": ["type": "string", "enum": ["up", "down", "left", "right"]],
            "pages": ["type": "number"],
            "from_x": ["type": "number"],
            "from_y": ["type": "number"],
            "to_x": ["type": "number"],
            "to_y": ["type": "number"],
          ],
          "required": ["kind"],
        ],
        "maxItems": intValue(plannerConfig()["maxActions"]),
      ],
    ],
    "required": ["status", "summary", "blocker", "operations"],
  ]
}

func geminiCompactOperation(_ operation: [String: Any]) -> [String: Any] {
  var compact: [String: Any] = [:]
  if !text(operation["kind"]).isEmpty { compact["k"] = text(operation["kind"]) }
  if operation["x"] != nil { compact["x"] = doubleValue(operation["x"]) }
  if operation["y"] != nil { compact["y"] = doubleValue(operation["y"]) }
  if let elementIndex = kwwkElementIndex(operation) { compact["i"] = elementIndex }
  if !text(operation["targetRole"]).isEmpty { compact["r"] = text(operation["targetRole"]) }
  if !text(operation["targetLabel"]).isEmpty { compact["l"] = text(operation["targetLabel"]) }
  if !text(operation["text"]).isEmpty { compact["t"] = text(operation["text"]) }
  if !text(operation["value"]).isEmpty { compact["v"] = text(operation["value"]) }
  if !text(operation["action"]).isEmpty { compact["a"] = text(operation["action"]) }
  if !text(operation["key"]).isEmpty { compact["key"] = text(operation["key"]) }
  if !text(operation["direction"]).isEmpty { compact["d"] = text(operation["direction"]) }
  if operation["pages"] != nil { compact["p"] = doubleValue(operation["pages"]) }
  if operation["from_x"] != nil { compact["fx"] = doubleValue(operation["from_x"]) }
  if operation["from_y"] != nil { compact["fy"] = doubleValue(operation["from_y"]) }
  if operation["to_x"] != nil { compact["tx"] = doubleValue(operation["to_x"]) }
  if operation["to_y"] != nil { compact["ty"] = doubleValue(operation["to_y"]) }
  return compact
}

func operationFromGeminiCompact(_ operation: [String: Any]) -> [String: Any] {
  var expanded: [String: Any] = [:]
  if !text(operation["k"]).isEmpty { expanded["kind"] = text(operation["k"]) }
  if operation["x"] != nil { expanded["x"] = doubleValue(operation["x"]) }
  if operation["y"] != nil { expanded["y"] = doubleValue(operation["y"]) }
  if operation["i"] != nil { expanded["elementIndex"] = intValue(operation["i"]) }
  if !text(operation["r"]).isEmpty { expanded["targetRole"] = text(operation["r"]) }
  if !text(operation["l"]).isEmpty { expanded["targetLabel"] = text(operation["l"]) }
  if !text(operation["t"]).isEmpty { expanded["text"] = text(operation["t"]) }
  if !text(operation["v"]).isEmpty { expanded["value"] = text(operation["v"]) }
  if !text(operation["a"]).isEmpty { expanded["action"] = text(operation["a"]) }
  if !text(operation["key"]).isEmpty { expanded["key"] = text(operation["key"]) }
  if !text(operation["d"]).isEmpty { expanded["direction"] = text(operation["d"]) }
  if operation["p"] != nil { expanded["pages"] = doubleValue(operation["p"]) }
  if operation["fx"] != nil { expanded["from_x"] = doubleValue(operation["fx"]) }
  if operation["fy"] != nil { expanded["from_y"] = doubleValue(operation["fy"]) }
  if operation["tx"] != nil { expanded["to_x"] = doubleValue(operation["tx"]) }
  if operation["ty"] != nil { expanded["to_y"] = doubleValue(operation["ty"]) }
  return expanded
}

func expandGeminiCompactPlanObject(_ object: [String: Any]) -> [String: Any]? {
  if let operationIds = object["o"] as? [String] {
    return [
      "status": text(object["s"]).isEmpty ? "planned" : text(object["s"]),
      "summary": text(object["m"]).isEmpty ? "ok" : text(object["m"]),
      "blocker": text(object["b"]).isEmpty ? "none" : text(object["b"]),
      "operationIds": operationIds,
      "operations": [],
    ]
  }
  guard let operations = object["o"] as? [[String: Any]] else { return nil }
  return [
    "status": text(object["s"]).isEmpty ? "planned" : text(object["s"]),
    "summary": text(object["m"]).isEmpty ? "ok" : text(object["m"]),
    "blocker": text(object["b"]).isEmpty ? "none" : text(object["b"]),
    "operations": operations.map(operationFromGeminiCompact),
  ]
}

func geminiDeterministicOperationIDs(count: Int) -> [String] {
  if count <= 0 { return [] }
  return (0..<count).map { "op\($0)" }
}

func expandGeminiOperationIDPlanObject(_ object: [String: Any], deterministicOperations: [[String: Any]]) -> [String: Any] {
  guard let operationIds = object["operationIds"] as? [String] else { return object }
  var operations: [[String: Any]] = []
  for operationId in operationIds {
    guard operationId.hasPrefix("op"),
          let index = Int(String(operationId.dropFirst(2))),
          index >= 0,
          index < deterministicOperations.count
    else {
      continue
    }
    operations.append(deterministicOperations[index])
  }
  var expanded = object
  expanded["operations"] = operations
  return expanded
}

func geminiCompactDeterministicPlannerSchema(allowedOperations: [[String: Any]]) -> [String: Any] {
  let operationIds = geminiDeterministicOperationIDs(count: allowedOperations.count)
  return [
    "type": "object",
    "properties": [
      "s": ["type": "string", "enum": ["planned"]],
      "b": ["type": "string", "enum": ["none"]],
      "o": [
        "type": "array",
        "minItems": allowedOperations.count,
        "maxItems": allowedOperations.count,
        "items": ["type": "string", "enum": operationIds],
      ],
    ],
    "required": ["s", "b", "o"],
  ]
}

func geminiResponseSchema(_ value: Any) -> Any {
  if var object = value as? [String: Any] {
    object.removeValue(forKey: "additionalProperties")
    for (key, child) in object {
      object[key] = geminiResponseSchema(child)
    }
    return object
  }
  if let array = value as? [Any] {
    return array.map { geminiResponseSchema($0) }
  }
  return value
}

func plannerPrewarmPayload() -> [String: Any] {
  let config = plannerConfig()
  let provider = text(config["provider"])
  let model = text(config["model"])
  let schema = provider == "openrouter" ? compactPlannerModelSchema() : plannerModelSchema()
  let schemaData = try? jsonData(schema)
  let schemaValid = JSONSerialization.isValidJSONObject(schema) && schemaData != nil
  let baseURL = openAIBaseURL().trimmingCharacters(in: CharacterSet(charactersIn: "/"))
  let responsesURL = URL(string: "\(baseURL)/responses")
  let apiKeyConfigured = !openAIPlannerAPIKey().isEmpty
  var blocker = ""
  if !schemaValid {
    blocker = "planner_schema_invalid"
  } else if provider.isEmpty || model.isEmpty {
    blocker = "blocked_planner_model_unavailable"
  } else if provider == "openai" && responsesURL == nil {
    blocker = "blocked_planner_model_unavailable"
  } else if provider == "openai" && !apiKeyConfigured {
    blocker = "blocked_planner_model_unavailable"
  } else if provider == "openrouter" && openRouterChatCompletionsURL() == nil {
    blocker = "blocked_planner_model_unavailable"
  } else if provider == "openrouter" && openRouterPlannerAPIKey().isEmpty {
    blocker = "blocked_planner_model_unavailable"
  } else if provider == "gemini" && geminiGenerateContentURL(model: model) == nil {
    blocker = "blocked_planner_model_unavailable"
  } else if provider == "gemini" && geminiPlannerAPIKey().isEmpty {
    blocker = "blocked_planner_model_unavailable"
  }
  let ok = blocker.isEmpty
  var client: [String: Any] = [
    "provider": provider,
    "initialized": true,
    "urlSession": "shared",
  ]
  if provider == "openai" {
    client["baseURLConfigured"] = responsesURL != nil
    client["apiKeyConfigured"] = apiKeyConfigured
    client["endpointPath"] = "/responses"
  } else if provider == "openrouter" {
    client["baseURLConfigured"] = openRouterChatCompletionsURL() != nil
    client["apiKeyConfigured"] = !openRouterPlannerAPIKey().isEmpty
    client["endpointPath"] = "/chat/completions"
  } else if provider == "gemini" {
    client["baseURLConfigured"] = geminiGenerateContentURL(model: model) != nil
    client["apiKeyConfigured"] = !geminiPlannerAPIKey().isEmpty
    client["endpointPath"] = "/models/{model}:generateContent"
  }
  let modelPrewarm: [String: Any] = !plannerModelPrewarmEnabled()
    ? [
      "ok": true,
      "status": "skipped",
      "blocker": "",
      "reason": "planner_model_prewarm_disabled",
    ]
    : ok ? plannerModelPrewarmProbe(config: config) : [
      "ok": false,
      "status": "blocked",
      "blocker": blocker,
    ]
  return [
    "ok": ok && (modelPrewarm["ok"] as? Bool == true),
    "status": ok && (modelPrewarm["ok"] as? Bool == true) ? "ready" : "blocked",
    "blocker": ok ? text(modelPrewarm["blocker"]) : blocker,
    "planner": [
      "provider": provider,
      "model": model,
      "timeoutMs": intValue(config["timeoutMs"]),
      "maxActions": intValue(config["maxActions"]),
      "reasoningEffort": text(config["reasoningEffort"]),
      "serviceTier": text(config["serviceTier"]),
    ],
    "plannerSchema": [
      "name": "kwwk_cu_plan",
      "strict": true,
      "valid": schemaValid,
      "bytes": schemaData?.count ?? 0,
    ],
    "client": client,
    "modelPrewarm": modelPrewarm,
  ]
}

func plannerModelPrewarmEnabled() -> Bool {
  let raw = envFirstText([
    "ONEESAMA_KWWK_CU_PLANNER_MODEL_PREWARM",
    "MAB_KWWK_CU_PLANNER_MODEL_PREWARM",
  ], default: "1").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  return !["0", "false", "no", "off"].contains(raw)
}

func plannerModelPrewarmProbe(config: [String: Any]) -> [String: Any] {
  let instruction = "Press Escape"
  let target: [String: Any] = [
    "applicationName": "KWWK Planner Prewarm",
    "windowTitle": "KWWK Planner Prewarm",
  ]
  let observation: [String: Any] = [
    "ok": true,
    "source": "planner_prewarm",
    "accessibilityElements": [],
  ]
  let started = Date()
  let modelPlan = plannerModelPlan(
    params: ["prewarm": true],
    instruction: instruction,
    target: target,
    observation: observation,
    planner: config
  )
  let validation = validatePlanOperations(modelPlan.operations, planner: config)
  let validationOK = validation["ok"] as? Bool == true
  let validationBlocker = text(validation["blocker"])
  let blocker = !modelPlan.blocker.isEmpty
    ? modelPlan.blocker
    : !validationBlocker.isEmpty
      ? validationBlocker
      : modelPlan.operations.isEmpty ? "planner_prewarm_plan_empty" : ""
  let latencyMs = max(0, Int(Date().timeIntervalSince(started) * 1000))
  let actionKinds = modelPlan.operations.map { text($0["kind"]) }.filter { !$0.isEmpty }
  let ok = blocker.isEmpty && validationOK && !modelPlan.operations.isEmpty
  return [
    "ok": ok,
    "status": ok ? "ready" : "blocked",
    "blocker": blocker,
    "provider": modelPlan.provider,
    "modelUsed": modelPlan.modelUsed,
    "modelName": modelPlan.modelName,
    "serviceTier": modelPlan.serviceTier,
    "latencyMs": latencyMs,
    "modelLatencyMs": modelPlan.latencyMs,
    "actionKinds": actionKinds,
  ]
}

func validScrollDirection(_ value: String) -> Bool {
  value.isEmpty || value == "up" || value == "down" || value == "left" || value == "right"
}

func operationValidationError(_ operation: [String: Any]) -> String {
  let kind = text(operation["kind"])
  switch kind {
  case "state":
    return ""
  case "click":
    if kwwkElementIndex(operation) == nil && (operation["x"] == nil || operation["y"] == nil) {
      return "click_requires_element_index_or_x_y"
    }
    return ""
  case "double_click":
    if kwwkElementIndex(operation) == nil && (operation["x"] == nil || operation["y"] == nil) {
      return "double_click_requires_element_index_or_x_y"
    }
    return ""
  case "type_text":
    return text(operation["text"]).isEmpty ? "type_text_requires_text" : ""
  case "press_key":
    return text(operation["key"]).isEmpty ? "press_key_requires_key" : ""
  case "scroll":
    return validScrollDirection(text(operation["direction"])) ? "" : "scroll_direction_invalid"
  case "set_value":
    if kwwkElementIndex(operation) == nil { return "set_value_requires_element_index" }
    return text(operation["value"]).isEmpty ? "set_value_requires_value" : ""
  case "perform_secondary_action":
    if kwwkElementIndex(operation) == nil { return "perform_secondary_action_requires_element_index" }
    return text(operation["action"]).isEmpty ? "perform_secondary_action_requires_action" : ""
  case "drag":
    for key in ["from_x", "from_y", "to_x", "to_y"] {
      if operation[key] == nil { return "drag_requires_\(key)" }
    }
    return ""
  default:
    return kind.isEmpty ? "operation_kind_required" : "unsupported_operation:\(kind)"
  }
}

func validatePlanOperations(_ operations: [[String: Any]], planner: [String: Any] = plannerConfig()) -> [String: Any] {
  let maxActions = intValue(planner["maxActions"])
  if operations.count > maxActions {
    return [
      "ok": false,
      "status": "blocked",
      "blocker": "planner_action_budget_exceeded",
      "operations": [],
      "validation": [
        "ok": false,
        "reason": "planner_action_budget_exceeded",
        "maxActions": maxActions,
        "receivedActions": operations.count,
      ],
    ]
  }
  for (index, operation) in operations.enumerated() {
    let error = operationValidationError(operation)
    if !error.isEmpty {
      return [
        "ok": false,
        "status": "blocked",
        "blocker": error,
        "operations": [],
        "validation": [
          "ok": false,
          "reason": error,
          "index": index,
          "kind": text(operation["kind"]),
        ],
      ]
    }
  }
  return [
    "ok": true,
    "status": "valid",
    "blocker": "",
    "operations": operations,
    "validation": [
      "ok": true,
      "maxActions": maxActions,
      "actionKinds": operations.map { text($0["kind"]) }.filter { !$0.isEmpty },
    ],
  ]
}

func operationFieldMatches(_ left: Any?, _ right: Any?) -> Bool {
  if left == nil && right == nil { return true }
  if left == nil || right == nil { return false }
  if left is NSNumber || left is Int || left is Int64 || left is Double || left is Float ||
     right is NSNumber || right is Int || right is Int64 || right is Double || right is Float {
    return abs(doubleValue(left) - doubleValue(right)) < 0.001
  }
  return text(left) == text(right)
}

func operationsMatchDeterministicHints(_ operations: [[String: Any]], expected: [[String: Any]]) -> Bool {
  if expected.isEmpty { return true }
  if operations.count != expected.count { return false }
  for (index, expectedOperation) in expected.enumerated() {
    let operation = operations[index]
    for key in expectedOperation.keys {
      if !operationFieldMatches(operation[key], expectedOperation[key]) {
        return false
      }
    }
  }
  return true
}

func normalizedKeyFromInstruction(_ lower: String) -> String {
  if containsAny(lower, ["上一个 tab", "上一个标签", "上一个页签", "上一标签", "previous tab", "prev tab"]) {
    return "control+shift+tab"
  }
  if containsAny(lower, ["切换 tab", "切换标签", "切换页签", "下一个 tab", "下一个标签", "下一个页签", "next tab"]) {
    return "control+tab"
  }
  if containsAny(lower, ["刷新", "reload", "refresh"]) {
    return "command+r"
  }
  if containsAny(lower, ["关闭弹窗", "关掉弹窗", "关闭对话框", "close popup", "dismiss popup"]) {
    return "escape"
  }
  if containsAny(lower, ["确认", "提交", "回车", "press enter", "hit enter"]) {
    return "return"
  }
  let mappings: [(String, String)] = [
    ("return", "return"),
    ("enter", "return"),
    ("回车", "return"),
    ("tab", "tab"),
    ("escape", "escape"),
    ("esc", "escape"),
    ("左", "left"),
    ("left", "left"),
    ("右", "right"),
    ("right", "right"),
    ("上", "up"),
    ("up", "up"),
    ("下", "down"),
    ("down", "down"),
  ]
  if containsAny(lower, ["press", "按", "敲"]) {
    for (needle, key) in mappings {
      if lower.contains(needle) { return key }
    }
  }
  return ""
}

func scrollDirectionFromInstruction(_ lower: String) -> String {
  if containsAny(lower, ["scroll up", "向上滚", "上滑", "往上滚"]) { return "up" }
  if containsAny(lower, ["scroll", "滚动", "下滑", "向下滚", "往下滚"]) { return "down" }
  return ""
}

func quotedTextFromInstruction(_ instruction: String) -> String {
  let delimiters: [(Character, Character)] = [("\"", "\""), ("“", "”"), ("'", "'"), ("「", "」")]
  for (open, close) in delimiters {
    guard let start = instruction.firstIndex(of: open) else { continue }
    let afterStart = instruction.index(after: start)
    guard let end = instruction[afterStart...].firstIndex(of: close) else { continue }
    let value = String(instruction[afterStart..<end]).trimmingCharacters(in: .whitespacesAndNewlines)
    if !value.isEmpty { return value }
  }
  return ""
}

func typeTextFromInstruction(_ instruction: String) -> String {
  let lower = instruction.lowercased()
  guard containsAny(lower, ["type", "输入", "键入"]) else { return "" }
  let quoted = quotedTextFromInstruction(instruction)
  if !quoted.isEmpty { return quoted }
  for marker in ["type ", "输入", "键入"] {
    if let range = instruction.range(of: marker, options: [.caseInsensitive]) {
      let value = String(instruction[range.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
      if !value.isEmpty { return value }
    }
  }
  return ""
}

func queryFromSearchInstruction(_ instruction: String) -> String {
  let lower = instruction.lowercased()
  guard containsAny(lower, ["搜索", "search for", "search "]) else { return "" }
  let quoted = quotedTextFromInstruction(instruction)
  if !quoted.isEmpty { return quoted }
  for marker in ["search for ", "search ", "搜索"] {
    if let range = instruction.range(of: marker, options: [.caseInsensitive]) {
      let value = String(instruction[range.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
      if !value.isEmpty { return value }
    }
  }
  return ""
}

func targetLooksLikeBrowser(_ target: [String: Any]) -> Bool {
  let haystack = [
    text(target["application_name"]),
    text(target["applicationName"]),
    text(target["bundle_identifier"]),
    text(target["bundleIdentifier"]),
    text(target["windowTitle"]),
  ].joined(separator: " ").lowercased()
  return containsAny(haystack, ["chrome", "safari", "arc", "firefox", "edge", "browser", "浏览器"])
}

func accessibilityElements(_ observation: [String: Any]) -> [[String: Any]] {
  if let elements = observation["accessibility"] as? [[String: Any]] { return elements }
  if let elements = observation["axTree"] as? [[String: Any]] { return elements }
  if let elements = observation["elements"] as? [[String: Any]] { return elements }
  if let screenshot = observation["screenshot"] as? [String: Any] {
    if let elements = screenshot["elements"] as? [[String: Any]] { return elements }
    if let elements = screenshot["detectedElements"] as? [[String: Any]] { return elements }
  }
  return []
}

func elementIsUsableButton(_ element: [String: Any]) -> Bool {
  let role = [
    text(element["role"]),
    text(element["type"]),
    text(element["subrole"]),
  ].joined(separator: " ").lowercased()
  if !containsAny(role, ["button", "axbutton", "按钮"]) { return false }
  if element["enabled"] != nil && !boolValue(element["enabled"]) { return false }
  if element["visible"] != nil && !boolValue(element["visible"]) { return false }
  return true
}

func elementPoint(_ element: [String: Any]) -> (Double, Double)? {
  if element["x"] != nil && element["y"] != nil {
    return (doubleValue(element["x"]), doubleValue(element["y"]))
  }
  guard let frame = element["frame"] as? [String: Any] else { return nil }
  let x = doubleValue(frame["x"]) + doubleValue(frame["width"]) / 2
  let y = doubleValue(frame["y"]) + doubleValue(frame["height"]) / 2
  return (x, y)
}

func ordinalButtonIndex(_ lower: String) -> Int {
  if containsAny(lower, ["第二个按钮", "第 2 个按钮", "2nd button", "second button"]) { return 1 }
  if containsAny(lower, ["第一个按钮", "第 1 个按钮", "1st button", "first button"]) { return 0 }
  return -1
}

func firstRegexCapture(_ value: String, pattern: String) -> String {
  guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else {
    return ""
  }
  let range = NSRange(value.startIndex..<value.endIndex, in: value)
  guard let match = regex.firstMatch(in: value, options: [], range: range),
    match.numberOfRanges > 1,
    let captureRange = Range(match.range(at: 1), in: value)
  else {
    return ""
  }
  return String(value[captureRange]).trimmingCharacters(in: .whitespacesAndNewlines)
}

func quotedLabelTargetFromInstruction(_ instruction: String) -> String {
  for pattern in [
    #"(?:labelled|labeled|named|title[d]?|called|标(?:签|记)?为|名称为|名为)\s*["“”']([^"“”']+)["“”']"#,
    #"["“”']([^"“”']+)["“”']"#,
  ] {
    let value = firstRegexCapture(instruction, pattern: pattern)
    if !value.isEmpty { return value }
  }
  return ""
}

func stripClickVerbPrefix(_ value: String) -> String {
  let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
  for marker in ["double-click ", "double click ", "click ", "双击", "点击", "点一下", "点"] {
    if let range = trimmed.range(of: marker, options: [.caseInsensitive]), range.lowerBound == trimmed.startIndex {
      return String(trimmed[range.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
    }
  }
  return trimmed
}

func sanitizeLabelTarget(_ value: String) -> String {
  var result = value
    .replacingOccurrences(of: "按钮", with: "")
    .trimmingCharacters(in: .whitespacesAndNewlines)
  let quoted = quotedLabelTargetFromInstruction(result)
  if !quoted.isEmpty { return quoted }
  for separator in ["：", ":"] {
    if let range = result.range(of: separator, options: [.backwards]) {
      let suffix = stripClickVerbPrefix(String(result[range.upperBound...]))
        .trimmingCharacters(in: CharacterSet.whitespacesAndNewlines.union(.punctuationCharacters))
      if !suffix.isEmpty { return suffix }
    }
  }
  for pattern in [
    #"(?i)\s+in\s+the\s+.*$"#,
    #"(?i)\s+in\s+current\s+.*$"#,
    #"(?i)\s+inside\s+.*$"#,
    #"(?i)\s+within\s+.*$"#,
    #"(?i)^(?:the\s+)?(?:visible|shown|enabled|available)\s+"#,
    #"(?i)\s+(?:button|control|target)$"#,
  ] {
    guard let regex = try? NSRegularExpression(pattern: pattern) else { continue }
    let range = NSRange(result.startIndex..<result.endIndex, in: result)
    result = regex.stringByReplacingMatches(in: result, options: [], range: range, withTemplate: "")
  }
  return result.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines.union(.punctuationCharacters))
}

func labelTargetFromInstruction(_ instruction: String) -> String {
  let lower = instruction.lowercased()
  let quoted = quotedLabelTargetFromInstruction(instruction)
  if !quoted.isEmpty { return quoted }
  for marker in ["double-click ", "double click ", "双击", "点击", "点一下", "点", "click "] {
    if let range = instruction.range(of: marker, options: [.caseInsensitive]) {
      let value = sanitizeLabelTarget(String(instruction[range.upperBound...]))
      if !value.isEmpty && !containsAny(lower, ["第一个按钮", "第二个按钮", "first button", "second button"]) {
        return value
      }
    }
  }
  return ""
}

func clickOperationForElement(_ element: [String: Any], kind: String = "click") -> [String: Any]? {
  guard let (x, y) = elementPoint(element) else { return nil }
  return [
    "kind": kind,
    "x": x,
    "y": y,
    "targetRole": text(element["role"]),
    "targetLabel": text(element["label"]).isEmpty ? text(element["title"]) : text(element["label"]),
  ]
}

func clickOperationsFromObservation(_ instruction: String, observation: [String: Any]) -> ([[String: Any]], String) {
  let lower = instruction.lowercased()
  guard containsAny(lower, ["double-click", "double click", "双击", "click", "点击", "点一下", "点"]) else { return ([], "") }
  let operationKind = containsAny(lower, ["double-click", "double click", "双击"]) ? "double_click" : "click"
  if observation["accessibilityTrusted"] != nil && !boolValue(observation["accessibilityTrusted"]) {
    return ([], "blocked_permission")
  }
  if text(observation["permissionBlocker"]) == "blocked_permission" {
    return ([], "blocked_permission")
  }
  let buttons = accessibilityElements(observation).filter(elementIsUsableButton)
  let ordinal = ordinalButtonIndex(lower)
  if ordinal >= 0 {
    if buttons.count <= ordinal { return ([], "blocked_ambiguous_target") }
    guard let operation = clickOperationForElement(buttons[ordinal], kind: operationKind) else {
      return ([], "blocked_unmappable_target")
    }
    return ([operation], "")
  }
  let label = labelTargetFromInstruction(instruction).lowercased()
  if label.isEmpty { return ([], "") }
  let matches = buttons.filter { element in
    let haystack = [
      text(element["label"]),
      text(element["title"]),
      text(element["name"]),
      text(element["value"]),
    ].joined(separator: " ").lowercased()
    return haystack.contains(label)
  }
  if matches.count != 1 { return ([], "blocked_ambiguous_target") }
  guard let operation = clickOperationForElement(matches[0], kind: operationKind) else {
    return ([], "blocked_unmappable_target")
  }
  return ([operation], "")
}

func appControlInstructionHasStateIntent(_ lower: String) -> Bool {
  containsAny(lower, [
    "observe", "inspect", "state", "status",
    "report", "visible page title", "page title", "window title", "current page",
    "currently shared", "blocker",
    "看看", "看一下", "观察", "状态", "报告", "标题", "阻塞", "阻碍",
  ])
}

func appControlActionIntentText(_ lower: String) -> String {
  var value = lower
  for pattern in [
    #"\bdo\s+not\b[^.。;；]*"#,
    #"\bdon't\b[^.。;；]*"#,
    #"\bwithout\b[^.。;；]*"#,
    #"不要[^.。;；]*"#,
    #"别[^.。;；]*"#,
  ] {
    guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else {
      continue
    }
    let range = NSRange(value.startIndex..<value.endIndex, in: value)
    value = regex.stringByReplacingMatches(in: value, options: [], range: range, withTemplate: " ")
  }
  return value
}

func appControlInstructionHasActionIntent(_ lower: String) -> Bool {
  let intentText = appControlActionIntentText(lower)
  return containsAny(intentText, [
    "double-click", "double click", "双击", "click", "点击", "点一下",
    "press", "按", "敲",
    "type", "输入", "键入",
    "scroll", "滚动", "下滑", "上滑",
    "drag", "拖",
    "switch", "切换",
    "close", "关闭",
    "open", "打开",
    "handle", "处理",
  ])
}

func appControlInstructionNeedsBackgroundAgent(_ lower: String) -> Bool {
  containsAny(lower, [
    "重新设计", "产品路线图", "写一个", "开发", "debug", "调试",
    "research", "analyze", "build", "implement", "create a project",
    "long task", "multi-step", "多步骤", "复杂任务",
  ])
}

func operationsFromInstruction(_ instruction: String, target: [String: Any] = [:], observation: [String: Any] = [:]) -> [[String: Any]] {
  let trimmed = instruction.trimmingCharacters(in: .whitespacesAndNewlines)
  if trimmed.isEmpty { return [] }
  let lower = trimmed.lowercased()
  let (observedOperations, _) = clickOperationsFromObservation(trimmed, observation: observation)
  if !observedOperations.isEmpty { return observedOperations }
  let key = normalizedKeyFromInstruction(lower)
  if !key.isEmpty { return [["kind": "press_key", "key": key]] }
  let query = queryFromSearchInstruction(trimmed)
  if !query.isEmpty && targetLooksLikeBrowser(target) {
    return [
      ["kind": "press_key", "key": "command+l"],
      ["kind": "type_text", "text": query],
      ["kind": "press_key", "key": "return"],
    ]
  }
  let direction = scrollDirectionFromInstruction(lower)
  if !direction.isEmpty { return [["kind": "scroll", "direction": direction]] }
  let typed = typeTextFromInstruction(trimmed)
  if !typed.isEmpty { return [["kind": "type_text", "text": typed]] }
  if appControlInstructionHasStateIntent(lower) && !appControlInstructionHasActionIntent(lower) {
    return [["kind": "state"]]
  }
  return []
}

func compactPlannerContext(instruction: String, target: [String: Any], observation: [String: Any]) -> [String: Any] {
  [
    "instruction": instruction,
    "target": target,
    "observation": observation,
    "localHints": [
      "deterministicOperations": operationsFromInstruction(instruction, target: target, observation: observation),
      "needsBackgroundHint": appControlInstructionNeedsBackgroundAgent(instruction.lowercased()),
    ],
    "constraints": [
      "maxActions": intValue(plannerConfig()["maxActions"]),
      "allowedKinds": ["state", "click", "double_click", "type_text", "press_key", "scroll", "drag", "set_value", "perform_secondary_action"],
      "kwwkActionSurface": [
        "state": "Use get-app-state.",
        "click": "Prefer elementIndex from observation.kwwkAppState.text. Coordinates are accepted only when sourced from a KWWK screenshot snapshot.",
        "double_click": "Prefer elementIndex from observation.kwwkAppState.text. Coordinates are accepted only when sourced from a KWWK screenshot snapshot.",
        "type_text": "Use text and optional elementIndex; without elementIndex it types into the focused editable element in the latest KWWK app_state.",
        "press_key": "Use key combinations like cmd+1, ctrl+tab, esc, enter.",
        "scroll": "Use direction. Prefer elementIndex from the latest KWWK app_state when obvious; without elementIndex the executor falls back to window-level scroll.",
        "drag": "Uses coordinates from a KWWK screenshot snapshot.",
      ],
      "returnNeedsBackgroundAgentForComplexTasks": true,
    ],
  ]
}

func planObjectFromAny(_ value: Any?) -> [String: Any]? {
  if let object = value as? [String: Any] { return object }
  if let raw = value as? String,
     let data = raw.data(using: .utf8),
     let decoded = try? JSONSerialization.jsonObject(with: data, options: []) as? [String: Any] {
    return decoded
  }
  return nil
}

func normalizedPlannerBlocker(_ value: Any?) -> String {
  let raw = text(value)
  let normalized = raw.lowercased()
    .replacingOccurrences(of: "_", with: " ")
    .replacingOccurrences(of: "-", with: " ")
    .trimmingCharacters(in: .whitespacesAndNewlines)
  if normalized.isEmpty ||
     normalized == "none" ||
     normalized == "null" ||
     normalized == "nil" ||
     normalized == "n/a" ||
     normalized == "no blocker" ||
     normalized == "no blockers" {
    return ""
  }
  return raw
}

func localPlannerFixture(params: [String: Any], instruction: String, target: [String: Any], observation: [String: Any]) -> [String: Any]? {
  if let object = planObjectFromAny(params["modelPlan"]) { return object }
  if let context = params["context"] as? [String: Any],
     let object = planObjectFromAny(context["modelPlan"]) {
    return object
  }
  let raw = envFirstText(["ONEESAMA_KWWK_CU_PLANNER_LOCAL_PLAN_JSON", "ONEESAMA_KWWK_PLANNER_LOCAL_PLAN_JSON"])
  if !raw.isEmpty {
    guard let data = raw.data(using: .utf8),
          let decoded = try? JSONSerialization.jsonObject(with: data, options: [])
    else {
      return ["status": "blocked", "summary": "Invalid local planner fixture JSON.", "blocker": "model_plan_invalid_json", "operations": []]
    }
    if let object = decoded as? [String: Any] {
      if let plans = object["plans"] as? [String: Any],
         let plan = planObjectFromAny(plans[instruction]) {
        return plan
      }
      return object
    }
    if let operations = decoded as? [[String: Any]] {
      return ["status": "planned", "summary": "Local fixture plan.", "blocker": "", "operations": operations]
    }
    return ["status": "blocked", "summary": "Local planner fixture did not provide operations.", "blocker": "model_plan_operations_required", "operations": []]
  }
  let lower = instruction.lowercased()
  if appControlInstructionNeedsBackgroundAgent(lower) {
    return [
      "status": "needs_background_agent",
      "summary": "Task requires a background agent.",
      "blocker": "needs_background_agent",
      "operations": [],
    ]
  }
  let (_, resolverBlocker) = clickOperationsFromObservation(instruction, observation: observation)
  if !resolverBlocker.isEmpty {
    return [
      "status": "blocked",
      "summary": "Local fixture planner found a target blocker.",
      "blocker": resolverBlocker,
      "operations": [],
    ]
  }
  let operations = operationsFromInstruction(instruction, target: target, observation: observation)
  if !operations.isEmpty {
    return [
      "status": "planned",
      "summary": "Local fixture planner produced a structured CU plan.",
      "blocker": "",
      "operations": operations,
    ]
  }
  return [
    "status": "blocked",
    "summary": "Local fixture planner could not produce a bounded CU plan.",
    "blocker": "instruction_not_directly_executable",
    "operations": [],
  ]
}

func operationsFromPlanObject(_ object: [String: Any]) -> [[String: Any]] {
  if let operations = object["operations"] as? [[String: Any]] { return operations }
  return []
}

func operationNeedsVisualTarget(_ operation: [String: Any]) -> Bool {
  switch text(operation["kind"]) {
  case "click", "double_click", "drag":
    return true
  default:
    return false
  }
}

func observationHasVisualTargets(_ observation: [String: Any]) -> Bool {
  if !accessibilityElements(observation).isEmpty { return true }
  if let screenshot = observation["screenshot"] as? [String: Any] {
    if let elements = screenshot["elements"] as? [[String: Any]], !elements.isEmpty { return true }
    if let elements = screenshot["detectedElements"] as? [[String: Any]], !elements.isEmpty { return true }
  }
  return false
}

func openAIPlannerAPIKey() -> String {
  envFirstText(["ONEESAMA_OPENAI_API_KEY", "MAB_OPENAI_API_KEY", "OPENAI_API_KEY"])
}

func openAIBaseURL() -> String {
  envFirstText(["ONEESAMA_OPENAI_BASE_URL", "MAB_OPENAI_BASE_URL", "OPENAI_BASE_URL"], default: "https://api.openai.com/v1")
}

func openRouterPlannerAPIKey() -> String {
  envFirstText([
    "ONEESAMA_OPENROUTER_API_KEY",
    "MAB_OPENROUTER_API_KEY",
    "OPENROUTER_API_KEY",
    "ONEESAMA_KWWK_CU_PLANNER_OPENROUTER_API_KEY",
    "MAB_KWWK_CU_PLANNER_OPENROUTER_API_KEY",
  ])
}

func openRouterBaseURL() -> String {
  envFirstText([
    "ONEESAMA_OPENROUTER_BASE_URL",
    "MAB_OPENROUTER_BASE_URL",
    "OPENROUTER_BASE_URL",
    "ONEESAMA_KWWK_CU_PLANNER_OPENROUTER_BASE_URL",
    "MAB_KWWK_CU_PLANNER_OPENROUTER_BASE_URL",
  ], default: "https://openrouter.ai/api/v1")
}

func openRouterChatCompletionsURL() -> URL? {
  URL(string: openRouterBaseURL().trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/chat/completions")
}

func geminiPlannerAPIKey() -> String {
  envFirstText([
    "ONEESAMA_GEMINI_API_KEY",
    "MAB_GEMINI_API_KEY",
    "GEMINI_API_KEY",
    "ONEESAMA_KWWK_CU_PLANNER_GEMINI_API_KEY",
    "MAB_KWWK_CU_PLANNER_GEMINI_API_KEY",
  ])
}

func geminiBaseURL() -> String {
  envFirstText([
    "ONEESAMA_GEMINI_BASE_URL",
    "MAB_GEMINI_BASE_URL",
    "GEMINI_BASE_URL",
    "ONEESAMA_KWWK_CU_PLANNER_GEMINI_BASE_URL",
    "MAB_KWWK_CU_PLANNER_GEMINI_BASE_URL",
  ], default: "https://generativelanguage.googleapis.com/v1beta/openai")
}

func geminiNativeBaseURL() -> String {
  let override = envFirstText([
    "ONEESAMA_GEMINI_NATIVE_BASE_URL",
    "MAB_GEMINI_NATIVE_BASE_URL",
    "ONEESAMA_KWWK_CU_PLANNER_GEMINI_NATIVE_BASE_URL",
    "MAB_KWWK_CU_PLANNER_GEMINI_NATIVE_BASE_URL",
  ])
  if !override.isEmpty {
    return override.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
  }
  let configured = geminiBaseURL().trimmingCharacters(in: CharacterSet(charactersIn: "/"))
  if configured.hasSuffix("/openai") {
    return String(configured.dropLast("/openai".count))
  }
  return configured
}

func geminiNativeModelName(_ model: String) -> String {
  var value = model.trimmingCharacters(in: .whitespacesAndNewlines)
  if value.hasPrefix("google/") {
    value = String(value.dropFirst("google/".count))
  }
  return value
}

func geminiGenerateContentURL(model: String) -> URL? {
  let modelName = geminiNativeModelName(model)
  if modelName.isEmpty { return nil }
  guard let encodedModel = modelName.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) else {
    return nil
  }
  return URL(string: geminiNativeBaseURL() + "/models/\(encodedModel):generateContent")
}

func geminiPlannerHedgeWidth(deterministicOperations: [[String: Any]]) -> Int {
  let fallback = deterministicOperations.isEmpty ? 1 : 24
  let raw = envFirstText([
    "ONEESAMA_KWWK_CU_PLANNER_GEMINI_HEDGE_WIDTH",
    "ONEESAMA_KWWK_PLANNER_GEMINI_HEDGE_WIDTH",
    "MAB_KWWK_CU_PLANNER_GEMINI_HEDGE_WIDTH",
    "MAB_KWWK_PLANNER_GEMINI_HEDGE_WIDTH",
  ], default: String(fallback))
  let value = Int(raw.trimmingCharacters(in: .whitespacesAndNewlines)) ?? fallback
  return Swift.max(1, Swift.min(32, value))
}

func openRouterPlannerHeaders() -> [String: String] {
  var headers: [String: String] = [:]
  let referer = envFirstText([
    "ONEESAMA_OPENROUTER_HTTP_REFERER",
    "MAB_OPENROUTER_HTTP_REFERER",
    "OPENROUTER_HTTP_REFERER",
    "ONEESAMA_KWWK_CU_PLANNER_OPENROUTER_HTTP_REFERER",
    "MAB_KWWK_CU_PLANNER_OPENROUTER_HTTP_REFERER",
  ])
  if !referer.isEmpty { headers["HTTP-Referer"] = referer }
  let title = envFirstText([
    "ONEESAMA_OPENROUTER_X_TITLE",
    "MAB_OPENROUTER_X_TITLE",
    "OPENROUTER_X_TITLE",
    "ONEESAMA_KWWK_CU_PLANNER_OPENROUTER_X_TITLE",
    "MAB_KWWK_CU_PLANNER_OPENROUTER_X_TITLE",
  ])
  if !title.isEmpty { headers["X-Title"] = title }
  return headers
}

func openRouterPlannerProviderPreferences() -> [String: Any] {
  let sort = envFirstText([
    "ONEESAMA_KWWK_CU_PLANNER_OPENROUTER_PROVIDER_SORT",
    "MAB_KWWK_CU_PLANNER_OPENROUTER_PROVIDER_SORT",
    "ONEESAMA_OPENROUTER_PROVIDER_SORT",
    "MAB_OPENROUTER_PROVIDER_SORT",
  ], default: "latency").lowercased()
  let requireParametersRaw = envFirstText([
    "ONEESAMA_KWWK_CU_PLANNER_OPENROUTER_REQUIRE_PARAMETERS",
    "MAB_KWWK_CU_PLANNER_OPENROUTER_REQUIRE_PARAMETERS",
    "ONEESAMA_OPENROUTER_REQUIRE_PARAMETERS",
    "MAB_OPENROUTER_REQUIRE_PARAMETERS",
  ], default: "1").lowercased()
  let allowFallbacksRaw = envFirstText([
    "ONEESAMA_KWWK_CU_PLANNER_OPENROUTER_ALLOW_FALLBACKS",
    "MAB_KWWK_CU_PLANNER_OPENROUTER_ALLOW_FALLBACKS",
    "ONEESAMA_OPENROUTER_ALLOW_FALLBACKS",
    "MAB_OPENROUTER_ALLOW_FALLBACKS",
  ])

  var provider: [String: Any] = [:]
  if ["price", "throughput", "latency"].contains(sort) {
    provider["sort"] = sort
  }
  provider["require_parameters"] = !["0", "false", "no", "off"].contains(requireParametersRaw)
  if !allowFallbacksRaw.isEmpty {
    provider["allow_fallbacks"] = !["0", "false", "no", "off"].contains(allowFallbacksRaw.lowercased())
  }
  return provider
}

func openRouterPlannerStreamingEnabled() -> Bool {
  let raw = envFirstText([
    "ONEESAMA_KWWK_CU_PLANNER_OPENROUTER_STREAM",
    "MAB_KWWK_CU_PLANNER_OPENROUTER_STREAM",
    "ONEESAMA_OPENROUTER_STREAM",
    "MAB_OPENROUTER_STREAM",
  ], default: "0").lowercased()
  return !["0", "false", "no", "off"].contains(raw)
}

func openRouterPlannerRequest(url: URL, apiKey: String, payload: [String: Any], planner: [String: Any]) -> URLRequest {
  var request = URLRequest(url: url)
  request.httpMethod = "POST"
  request.timeoutInterval = Double(intValue(planner["timeoutMs"])) / 1000.0
  request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
  request.setValue("application/json", forHTTPHeaderField: "Content-Type")
  for (key, value) in openRouterPlannerHeaders() {
    request.setValue(value, forHTTPHeaderField: key)
  }
  request.httpBody = try? jsonData(payload)
  return request
}

private final class OpenRouterPlannerStreamDelegate: NSObject, URLSessionDataDelegate {
  let semaphore = DispatchSemaphore(value: 0)
  private let lock = NSLock()
  private var buffer = ""
  private var content = ""
  private var completed = false
  private var httpStatus = 0
  weak var task: URLSessionDataTask?
  var responseObject: [String: Any]?
  var responseError = ""
  var actualModel = ""

  private func finish(cancel: Bool = false) {
    lock.lock()
    let shouldSignal = !completed
    completed = true
    let currentTask = task
    lock.unlock()
    if cancel {
      currentTask?.cancel()
    }
    if shouldSignal {
      semaphore.signal()
    }
  }

  func urlSession(
    _ session: URLSession,
    dataTask: URLSessionDataTask,
    didReceive response: URLResponse,
    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
  ) {
    httpStatus = (response as? HTTPURLResponse)?.statusCode ?? 0
    if httpStatus >= 400 {
      responseError = "blocked_planner_model_http_\(httpStatus)"
      completionHandler(.cancel)
      finish()
      return
    }
    completionHandler(.allow)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    guard responseObject == nil else { return }
    let chunk = String(data: data, encoding: .utf8) ?? ""
    if chunk.isEmpty { return }
    buffer += chunk
    var lines = buffer.components(separatedBy: "\n")
    buffer = lines.popLast() ?? ""
    for rawLine in lines {
      let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
      guard line.hasPrefix("data:") else { continue }
      let dataText = line.dropFirst(5).trimmingCharacters(in: .whitespacesAndNewlines)
      if dataText == "[DONE]" {
        finish()
        return
      }
      guard let data = dataText.data(using: .utf8),
            let decoded = try? JSONSerialization.jsonObject(with: data, options: []) as? [String: Any]
      else {
        continue
      }
      let model = text(decoded["model"])
      if !model.isEmpty { actualModel = model }
      if decoded["error"] is [String: Any] {
        responseError = "blocked_planner_model_error"
        finish(cancel: true)
        return
      }
      guard let choices = decoded["choices"] as? [[String: Any]] else { continue }
      for choice in choices {
        if let delta = choice["delta"] as? [String: Any] {
          if let refusal = delta["refusal"] as? String,
             !refusal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            responseObject = ["status": "blocked", "summary": refusal, "blocker": "planner_model_refusal", "operations": []]
            finish(cancel: true)
            return
          }
          if let text = delta["content"] as? String {
            content += text
          } else if let parts = delta["content"] as? [[String: Any]] {
            for part in parts {
              content += text(part["text"])
            }
          }
        } else if let message = choice["message"] as? [String: Any],
                  let text = message["content"] as? String {
          content += text
        }
      }
      if let object = parseJSONObjectText(content) {
        responseObject = object
        finish(cancel: true)
        return
      }
    }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    if responseObject == nil && responseError.isEmpty && error != nil {
      responseError = httpStatus >= 400 ? "blocked_planner_model_http_\(httpStatus)" : "blocked_planner_model_unavailable"
    }
    finish()
  }
}

func openRouterStreamingPlannerPlan(url: URL, apiKey: String, payload: [String: Any], planner: [String: Any]) -> (object: [String: Any]?, blocker: String, actualModel: String, actualServiceTier: String) {
  let delegate = OpenRouterPlannerStreamDelegate()
  let session = URLSession(configuration: .default, delegate: delegate, delegateQueue: nil)
  let task = session.dataTask(with: openRouterPlannerRequest(url: url, apiKey: apiKey, payload: payload, planner: planner))
  delegate.task = task
  task.resume()
  if delegate.semaphore.wait(timeout: .now() + .milliseconds(intValue(planner["timeoutMs"]))) == .timedOut {
    task.cancel()
    session.invalidateAndCancel()
    return (nil, "blocked_planner_model_timeout", delegate.actualModel, "")
  }
  session.finishTasksAndInvalidate()
  guard let object = delegate.responseObject else {
    return (nil, delegate.responseError.isEmpty ? "blocked_planner_model_invalid_response" : delegate.responseError, delegate.actualModel, "")
  }
  return (object, "", delegate.actualModel, "")
}

func geminiPlannerPlan(instruction: String, target: [String: Any], observation: [String: Any], planner: [String: Any]) -> (object: [String: Any]?, blocker: String, actualModel: String, actualServiceTier: String, runtime: [String: Any]) {
  let apiKey = geminiPlannerAPIKey()
  if apiKey.isEmpty { return (nil, "blocked_planner_model_unavailable", "", "", [:]) }
  let model = geminiNativeModelName(text(planner["model"]))
  if model.isEmpty { return (nil, "blocked_planner_model_unavailable", "", "", [:]) }
  guard let url = geminiGenerateContentURL(model: model) else {
    return (nil, "blocked_planner_model_unavailable", "", "", [:])
  }

  let context = compactPlannerContext(instruction: instruction, target: target, observation: observation)
  let deterministicOperations =
    ((context["localHints"] as? [String: Any])?["deterministicOperations"] as? [[String: Any]]) ?? []
  let schema = deterministicOperations.isEmpty
    ? compactPlannerModelSchema()
    : geminiCompactDeterministicPlannerSchema(allowedOperations: deterministicOperations)
  let compactDeterministicOperations = deterministicOperations.map(geminiCompactOperation)
  let deterministicOperationIds = geminiDeterministicOperationIDs(count: deterministicOperations.count)
  var deterministicOperationsByID: [String: Any] = [:]
  for (index, operationId) in deterministicOperationIds.enumerated() {
    deterministicOperationsByID[operationId] = compactDeterministicOperations[index]
  }
  let contextForModel: [String: Any] = deterministicOperations.isEmpty
    ? context
    : [
      "instruction": instruction,
      "target": [
        "applicationName": text(target["applicationName"]),
        "windowTitle": text(target["windowTitle"]),
      ],
      "localHints": [
        "operationIds": deterministicOperationIds,
        "operations": deterministicOperationsByID,
      ],
      "constraints": [
        "selectOperationIdsExactly": true,
        "maxActions": deterministicOperations.count,
      ],
    ]
  let contextText = (try? String(data: jsonData(contextForModel), encoding: .utf8)) ?? "{}"
  let providerSchema = geminiResponseSchema(schema) as? [String: Any] ?? schema
  let systemPrompt = deterministicOperations.isEmpty
    ? "KWWK CU planner. Output JSON only. Plan <=3 short safe macOS actions. Use elementIndex from observation.kwwkAppState.text for element actions. Do not invent click or scroll coordinates. Complex/open-ended tasks => needs_background_agent. Do not invent typed text."
    : "Return schema JSON. s=planned b=none o exactly context.localHints.operationIds."
  let reasoningEffort = text(planner["reasoningEffort"]).lowercased()
  let thinkingConfig: [String: Any] = ["low", "medium", "high"].contains(reasoningEffort)
    ? ["thinkingLevel": reasoningEffort]
    : ["thinkingBudget": 0]
  let payload: [String: Any] = [
    "contents": [
      [
        "parts": [
          [
            "text": "\(systemPrompt)\n\nContext JSON:\n\(contextText)",
          ],
        ],
      ],
    ],
    "generationConfig": [
      "responseMimeType": "application/json",
      "responseSchema": providerSchema,
      "maxOutputTokens": deterministicOperations.isEmpty ? 256 : 128,
      "temperature": 0,
      "thinkingConfig": thinkingConfig,
    ],
  ]

  var request = URLRequest(url: url)
  request.httpMethod = "POST"
  request.timeoutInterval = Double(intValue(planner["timeoutMs"])) / 1000.0
  request.setValue(apiKey, forHTTPHeaderField: "x-goog-api-key")
  request.setValue("application/json", forHTTPHeaderField: "Content-Type")
  request.httpBody = try? jsonData(payload)

  let hedgeWidth = geminiPlannerHedgeWidth(deterministicOperations: deterministicOperations)
  let attemptStarted = Date()
  let semaphore = DispatchSemaphore(value: 0)
  let lock = NSLock()
  var responseObject: [String: Any]?
  var responseError = ""
  var actualModel = ""
  var completedAttempts = 0
  var winningAttempt = 0
  var settled = false
  var attemptLatencies: [Int] = []
  var tasks: [URLSessionDataTask] = []

  func finishAttempt(attempt: Int, latencyMs: Int, object: [String: Any]?, blocker: String, modelName: String) {
    var shouldSignal = false
    lock.lock()
    if settled {
      lock.unlock()
      return
    }
    completedAttempts += 1
    attemptLatencies.append(latencyMs)
    if !modelName.isEmpty { actualModel = modelName }
    if let object {
      responseObject = object
      responseError = ""
      winningAttempt = attempt
      settled = true
      shouldSignal = true
    } else {
      responseError = blocker.isEmpty ? "blocked_planner_model_invalid_response" : blocker
      if completedAttempts >= hedgeWidth {
        settled = true
        shouldSignal = true
      }
    }
    lock.unlock()
    if shouldSignal { semaphore.signal() }
  }

  for attempt in 1...hedgeWidth {
    let started = Date()
    let task = geminiPlannerURLSession.dataTask(with: request) { data, response, error in
      let latencyMs = max(0, Int(Date().timeIntervalSince(started) * 1000))
      if let error = error as NSError?, error.code == NSURLErrorCancelled {
        return
      }
      if error != nil {
        finishAttempt(attempt: attempt, latencyMs: latencyMs, object: nil, blocker: "blocked_planner_model_unavailable", modelName: "")
        return
      }
      if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
        finishAttempt(attempt: attempt, latencyMs: latencyMs, object: nil, blocker: plannerHTTPErrorBlocker(data: data, fallbackStatus: http.statusCode), modelName: "")
        return
      }
      guard let data,
            let decoded = try? JSONSerialization.jsonObject(with: data, options: []) as? [String: Any]
      else {
        finishAttempt(attempt: attempt, latencyMs: latencyMs, object: nil, blocker: "blocked_planner_model_invalid_response", modelName: "")
        return
      }
      if let errorObject = decoded["error"] as? [String: Any] {
        let blocker = text(errorObject["message"]).isEmpty ? "blocked_planner_model_error" : "blocked_planner_model_error"
        finishAttempt(attempt: attempt, latencyMs: latencyMs, object: nil, blocker: blocker, modelName: text(decoded["modelVersion"]))
        return
      }
      finishAttempt(
        attempt: attempt,
        latencyMs: latencyMs,
        object: parseGeminiGenerateContentPlannerObject(decoded).map {
          expandGeminiOperationIDPlanObject($0, deterministicOperations: deterministicOperations)
        },
        blocker: "blocked_planner_model_invalid_response",
        modelName: text(decoded["modelVersion"])
      )
    }
    tasks.append(task)
  }

  for task in tasks { task.resume() }
  if semaphore.wait(timeout: .now() + .milliseconds(intValue(planner["timeoutMs"]))) == .timedOut {
    for task in tasks { task.cancel() }
    return (nil, "blocked_planner_model_timeout", actualModel, "", [
      "hedged": hedgeWidth > 1,
      "hedgeWidth": hedgeWidth,
      "hedgeWinner": 0,
      "hedgeCompletedAttempts": completedAttempts,
      "hedgeAttemptLatenciesMs": attemptLatencies,
      "thinkingBudget": thinkingConfig["thinkingBudget"] ?? "",
      "thinkingLevel": thinkingConfig["thinkingLevel"] ?? "",
    ])
  }
  for task in tasks { task.cancel() }
  let runtime: [String: Any] = [
    "hedged": hedgeWidth > 1,
    "hedgeWidth": hedgeWidth,
    "hedgeWinner": winningAttempt,
    "hedgeCompletedAttempts": completedAttempts,
    "hedgeAttemptLatenciesMs": attemptLatencies,
    "elapsedMs": max(0, Int(Date().timeIntervalSince(attemptStarted) * 1000)),
    "thinkingBudget": thinkingConfig["thinkingBudget"] ?? "",
    "thinkingLevel": thinkingConfig["thinkingLevel"] ?? "",
  ]
  guard let responseObject else {
    return (nil, responseError.isEmpty ? "blocked_planner_model_invalid_response" : responseError, actualModel, "", runtime)
  }
  return (responseObject, "", actualModel, "", runtime)
}

func parseJSONObjectText(_ value: String) -> [String: Any]? {
  let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !trimmed.isEmpty else { return nil }
  let candidates: [String] = {
    if trimmed.hasPrefix("```") {
      let withoutFence = trimmed
        .replacingOccurrences(of: "^```(?:json)?\\s*", with: "", options: .regularExpression)
        .replacingOccurrences(of: "\\s*```$", with: "", options: .regularExpression)
      return [withoutFence, trimmed]
    }
    return [trimmed]
  }()
  for candidate in candidates {
    if let data = candidate.data(using: .utf8),
       let object = try? JSONSerialization.jsonObject(with: data, options: []) as? [String: Any] {
      return object
    }
  }
  guard let start = trimmed.firstIndex(of: "{"),
        let end = trimmed.lastIndex(of: "}"),
        start < end
  else { return nil }
  let jsonSlice = String(trimmed[start...end])
  guard let data = jsonSlice.data(using: .utf8) else { return nil }
  return try? JSONSerialization.jsonObject(with: data, options: []) as? [String: Any]
}

func parseResponsesPlannerObject(_ response: [String: Any]) -> [String: Any]? {
  if let object = response["output_parsed"] as? [String: Any] { return object }
  var textParts: [String] = []
  if let value = response["output_text"] as? String { textParts.append(value) }
  if let output = response["output"] as? [[String: Any]] {
    for item in output {
      if let content = item["content"] as? [[String: Any]] {
        for part in content {
          if let value = part["text"] as? String { textParts.append(value) }
          if let value = part["refusal"] as? String {
            return ["status": "blocked", "summary": value, "blocker": "planner_model_refusal", "operations": []]
          }
        }
      }
    }
  }
  for value in textParts {
    if let object = parseJSONObjectText(value) {
      return expandGeminiCompactPlanObject(object) ?? object
    }
  }
  return nil
}

func parseChatCompletionsPlannerObject(_ response: [String: Any]) -> [String: Any]? {
  guard let choices = response["choices"] as? [[String: Any]] else { return nil }
  for choice in choices {
    if let message = choice["message"] as? [String: Any] {
      if let refusal = message["refusal"] as? String, !refusal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        return ["status": "blocked", "summary": refusal, "blocker": "planner_model_refusal", "operations": []]
      }
      if let content = message["content"] as? String,
         let object = parseJSONObjectText(content) {
        return object
      }
      if let content = message["content"] as? [[String: Any]] {
        for part in content {
          if let value = part["text"] as? String,
             let object = parseJSONObjectText(value) {
            return object
          }
        }
      }
    }
  }
  return nil
}

func parseGeminiGenerateContentPlannerObject(_ response: [String: Any]) -> [String: Any]? {
  guard let candidates = response["candidates"] as? [[String: Any]] else { return nil }
  var textParts: [String] = []
  for candidate in candidates {
    guard let content = candidate["content"] as? [String: Any],
          let parts = content["parts"] as? [[String: Any]]
    else {
      continue
    }
    for part in parts {
      if boolValue(part["thought"]) { continue }
      if let value = part["text"] as? String {
        textParts.append(value)
      }
    }
  }
  for value in textParts {
    if let object = parseJSONObjectText(value) {
      return expandGeminiCompactPlanObject(object) ?? object
    }
  }
  return nil
}

func plannerHTTPErrorBlocker(data: Data?, fallbackStatus: Int) -> String {
  guard let data,
        let decoded = try? JSONSerialization.jsonObject(with: data, options: []) as? [String: Any],
        let errorObject = decoded["error"] as? [String: Any]
  else {
    return "blocked_planner_model_http_\(fallbackStatus)"
  }
  let rawErrorCode = {
    let status = text(errorObject["status"])
    if !status.isEmpty { return status }
    return text(errorObject["code"])
  }()
  let code = rawErrorCode
    .lowercased()
    .map { character -> Character in
      if character.isLetter || character.isNumber { return character }
      return "_"
    }
  let normalized = String(code)
    .split(separator: "_")
    .filter { !$0.isEmpty }
    .joined(separator: "_")
  if normalized.isEmpty { return "blocked_planner_model_http_\(fallbackStatus)" }
  return "blocked_planner_model_\(normalized)"
}

func openAIPlannerPlan(instruction: String, target: [String: Any], observation: [String: Any], planner: [String: Any]) -> (object: [String: Any]?, blocker: String, actualModel: String, actualServiceTier: String) {
  let apiKey = openAIPlannerAPIKey()
  if apiKey.isEmpty { return (nil, "blocked_planner_model_unavailable", "", "") }
  let model = text(planner["model"])
  if model.isEmpty { return (nil, "blocked_planner_model_unavailable", "", "") }
  guard let url = URL(string: openAIBaseURL().trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/responses") else {
    return (nil, "blocked_planner_model_unavailable", "", "")
  }

  let context = compactPlannerContext(instruction: instruction, target: target, observation: observation)
  let contextText = (try? String(data: jsonData(context), encoding: .utf8)) ?? "{}"
  var payload: [String: Any] = [
    "model": model,
    "input": [
      [
        "role": "system",
        "content": """
          You are the KWWK Computer Use planner. Return only a short bounded macOS app-control action plan.
          The user instruction may contain routing wrapper text such as "use the Realtime tool" or "currently shared window"; ignore that wrapper and plan the actual requested app operation.
          If context.localHints.deterministicOperations is non-empty and the task is short, safe, and bounded, copy those operations exactly into the plan.
          For element actions, prefer elementIndex values from context.observation.kwwkAppState.text. Do not invent click or scroll coordinates.
          For scroll actions, include direction and prefer elementIndex when an obvious scrollable element is available; otherwise omit elementIndex and let the executor use window-level scroll.
          For keyboard requests, output press_key actions, for example "Press Escape" -> {"kind":"press_key","key":"escape"}.
          Use needs_background_agent for complex or open-ended tasks. Do not invent text that the user did not ask to type.
          """,
      ],
      [
        "role": "user",
        "content": contextText,
      ],
    ],
    "text": [
      "format": [
        "type": "json_schema",
        "name": "kwwk_cu_plan",
        "strict": true,
        "schema": plannerModelSchema(
          allowedOperations: ((context["localHints"] as? [String: Any])?["deterministicOperations"] as? [[String: Any]]) ?? []
        ),
      ],
    ],
    "max_output_tokens": 256,
  ]
  let reasoningEffort = text(planner["reasoningEffort"]).lowercased()
  if !reasoningEffort.isEmpty && reasoningEffort != "off" {
    payload["reasoning"] = ["effort": reasoningEffort]
  }
  let serviceTier = text(planner["serviceTier"]).lowercased()
  if ["auto", "default", "flex", "priority"].contains(serviceTier) {
    payload["service_tier"] = serviceTier
  }

  var request = URLRequest(url: url)
  request.httpMethod = "POST"
  request.timeoutInterval = Double(intValue(planner["timeoutMs"])) / 1000.0
  request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
  request.setValue("application/json", forHTTPHeaderField: "Content-Type")
  request.httpBody = try? jsonData(payload)

  let semaphore = DispatchSemaphore(value: 0)
  var responseObject: [String: Any]?
  var responseError = ""
  var actualModel = ""
  var actualServiceTier = ""
  let task = URLSession.shared.dataTask(with: request) { data, response, error in
    defer { semaphore.signal() }
    if error != nil {
      responseError = "blocked_planner_model_unavailable"
      return
    }
    if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
      responseError = plannerHTTPErrorBlocker(data: data, fallbackStatus: http.statusCode)
      return
    }
    guard let data,
          let decoded = try? JSONSerialization.jsonObject(with: data, options: []) as? [String: Any]
    else {
      responseError = "blocked_planner_model_invalid_response"
      return
    }
    actualModel = text(decoded["model"])
    actualServiceTier = text(decoded["service_tier"])
    if let errorObject = decoded["error"] as? [String: Any] {
      responseError = text(errorObject["message"]).isEmpty ? "blocked_planner_model_error" : "blocked_planner_model_error"
      return
    }
    responseObject = parseResponsesPlannerObject(decoded)
  }
  task.resume()
  if semaphore.wait(timeout: .now() + .milliseconds(intValue(planner["timeoutMs"]))) == .timedOut {
    task.cancel()
    return (nil, "blocked_planner_model_timeout", actualModel, actualServiceTier)
  }
  guard let responseObject else {
    return (nil, responseError.isEmpty ? "blocked_planner_model_invalid_response" : responseError, actualModel, actualServiceTier)
  }
  return (responseObject, "", actualModel, actualServiceTier)
}

func openRouterPlannerPlan(instruction: String, target: [String: Any], observation: [String: Any], planner: [String: Any]) -> (object: [String: Any]?, blocker: String, actualModel: String, actualServiceTier: String) {
  let apiKey = openRouterPlannerAPIKey()
  if apiKey.isEmpty { return (nil, "blocked_planner_model_unavailable", "", "") }
  let model = text(planner["model"])
  if model.isEmpty { return (nil, "blocked_planner_model_unavailable", "", "") }
  guard let url = openRouterChatCompletionsURL() else {
    return (nil, "blocked_planner_model_unavailable", "", "")
  }

  let context = compactPlannerContext(instruction: instruction, target: target, observation: observation)
  let contextText = (try? String(data: jsonData(context), encoding: .utf8)) ?? "{}"
  let deterministicOperations =
    ((context["localHints"] as? [String: Any])?["deterministicOperations"] as? [[String: Any]]) ?? []
  let schema = deterministicOperations.isEmpty
    ? compactPlannerModelSchema()
    : plannerModelSchema(allowedOperations: deterministicOperations)
  let systemPrompt = """
    KWWK CU planner. Output JSON only. Plan <=3 short safe macOS actions. Ignore routing wrapper text. Copy context.localHints.deterministicOperations exactly when non-empty. Use elementIndex from context.observation.kwwkAppState.text for element/scroll actions. Do not invent click or scroll coordinates. Complex/open-ended tasks => needs_background_agent. Do not invent typed text.
    """
  var payload: [String: Any] = [
    "model": model,
    "messages": [
      ["role": "system", "content": systemPrompt],
      ["role": "user", "content": contextText],
    ],
    "response_format": [
      "type": "json_schema",
      "json_schema": [
        "name": "kwwk_cu_plan",
        "strict": true,
        "schema": schema,
      ],
    ],
    "max_tokens": 128,
    "temperature": 0,
    "provider": openRouterPlannerProviderPreferences(),
  ]
  let reasoningEffort = text(planner["reasoningEffort"]).lowercased()
  if !reasoningEffort.isEmpty && reasoningEffort != "off" {
    payload["reasoning"] = [
      "effort": reasoningEffort,
      "exclude": true,
    ]
  }
  if openRouterPlannerStreamingEnabled() {
    var streamingPayload = payload
    streamingPayload["stream"] = true
    return openRouterStreamingPlannerPlan(url: url, apiKey: apiKey, payload: streamingPayload, planner: planner)
  }

  let request = openRouterPlannerRequest(url: url, apiKey: apiKey, payload: payload, planner: planner)

  let semaphore = DispatchSemaphore(value: 0)
  var responseObject: [String: Any]?
  var responseError = ""
  var actualModel = ""
  let task = URLSession.shared.dataTask(with: request) { data, response, error in
    defer { semaphore.signal() }
    if error != nil {
      responseError = "blocked_planner_model_unavailable"
      return
    }
    if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
      responseError = plannerHTTPErrorBlocker(data: data, fallbackStatus: http.statusCode)
      return
    }
    guard let data,
          let decoded = try? JSONSerialization.jsonObject(with: data, options: []) as? [String: Any]
    else {
      responseError = "blocked_planner_model_invalid_response"
      return
    }
    actualModel = text(decoded["model"])
    if let errorObject = decoded["error"] as? [String: Any] {
      responseError = text(errorObject["message"]).isEmpty ? "blocked_planner_model_error" : "blocked_planner_model_error"
      return
    }
    responseObject = parseChatCompletionsPlannerObject(decoded)
  }
  task.resume()
  if semaphore.wait(timeout: .now() + .milliseconds(intValue(planner["timeoutMs"]))) == .timedOut {
    task.cancel()
    return (nil, "blocked_planner_model_timeout", actualModel, "")
  }
  guard let responseObject else {
    return (nil, responseError.isEmpty ? "blocked_planner_model_invalid_response" : responseError, actualModel, "")
  }
  return (responseObject, "", actualModel, "")
}

func plannerModelPlan(params: [String: Any], instruction: String, target: [String: Any], observation: [String: Any], planner: [String: Any]) -> (operations: [[String: Any]], status: String, blocker: String, summary: String, modelUsed: Bool, provider: String, modelName: String, latencyMs: Int, serviceTier: String, runtime: [String: Any]) {
  let provider = text(planner["provider"]).lowercased()
  let model = text(planner["model"])
  let started = Date()
  let object: [String: Any]?
  let blocker: String
  let actualModel: String
  let actualServiceTier: String
  let runtime: [String: Any]
  if provider == "local" || provider == "fixture" {
    object = localPlannerFixture(params: params, instruction: instruction, target: target, observation: observation)
    blocker = object == nil ? "blocked_planner_model_unavailable" : ""
    actualModel = model
    actualServiceTier = text(planner["serviceTier"])
    runtime = [:]
  } else if provider == "openrouter" {
    let result = openRouterPlannerPlan(instruction: instruction, target: target, observation: observation, planner: planner)
    object = result.object
    blocker = result.blocker
    actualModel = result.actualModel.isEmpty ? model : result.actualModel
    actualServiceTier = result.actualServiceTier.isEmpty ? text(planner["serviceTier"]) : result.actualServiceTier
    runtime = [:]
  } else if provider == "gemini" {
    let result = geminiPlannerPlan(instruction: instruction, target: target, observation: observation, planner: planner)
    object = result.object
    blocker = result.blocker
    actualModel = result.actualModel.isEmpty ? model : result.actualModel
    actualServiceTier = result.actualServiceTier.isEmpty ? text(planner["serviceTier"]) : result.actualServiceTier
    runtime = result.runtime
  } else {
    let result = openAIPlannerPlan(instruction: instruction, target: target, observation: observation, planner: planner)
    object = result.object
    blocker = result.blocker
    actualModel = result.actualModel.isEmpty ? model : result.actualModel
    actualServiceTier = result.actualServiceTier.isEmpty ? text(planner["serviceTier"]) : result.actualServiceTier
    runtime = [:]
  }
  let latencyMs = max(0, Int(Date().timeIntervalSince(started) * 1000))
  guard let object else {
    return ([], "blocked", blocker.isEmpty ? "blocked_planner_model_unavailable" : blocker, "Planner model unavailable.", true, "model_first_\(provider)", actualModel, latencyMs, actualServiceTier, runtime)
  }
  let status = text(object["status"]).isEmpty ? "planned" : text(object["status"])
  let objectBlocker = normalizedPlannerBlocker(object["blocker"])
  let summary = text(object["summary"]).isEmpty ? "Planner produced a structured CU plan." : text(object["summary"])
  return (
    operationsFromPlanObject(object),
    status,
    objectBlocker.isEmpty ? blocker : objectBlocker,
    summary,
    true,
    provider == "local" || provider == "fixture" ? "model_first_local_fixture" : "model_first_\(provider)",
    actualModel,
    latencyMs,
    actualServiceTier,
    runtime
  )
}

func planInstruction(params: [String: Any]) -> [String: Any] {
  let target = targetFromParams(params)
  let observation = observationFromParams(params)
  let instruction = text(params["instruction"])
  let deterministicOperations = operationsFromInstruction(instruction, target: target, observation: observation)
  let started = Date()
  let config = plannerConfig()
  let modelPlan = plannerModelPlan(
    params: params,
    instruction: instruction,
    target: target,
    observation: observation,
    planner: config
  )
  var operations = modelPlan.operations
  let (_, resolverBlocker) = clickOperationsFromObservation(instruction, observation: observation)
  let visualTargetMissing = operations.contains(where: operationNeedsVisualTarget) && !observationHasVisualTargets(observation)
  let deterministicOperationsMatched = operationsMatchDeterministicHints(operations, expected: deterministicOperations)
  if visualTargetMissing { operations = [] }
  let modelStatus = text(modelPlan.status)
  let needsBackground = modelStatus == "needs_background_agent"
  let modelBlocker = text(modelPlan.blocker)
  let localBlocker = !modelBlocker.isEmpty
    ? modelBlocker
    : !resolverBlocker.isEmpty
      ? resolverBlocker
      : visualTargetMissing
        ? "blocked_observation_required"
        : !deterministicOperationsMatched ? "planner_deterministic_operations_mismatch" : ""
  let normalizeMs = max(0, Int(Date().timeIntervalSince(started) * 1000))
  let actionKinds = operations.map { text($0["kind"]) }.filter { !$0.isEmpty }
  let validation = validatePlanOperations(operations, planner: config)
  let valid = validation["ok"] as? Bool == true
  let validationBlocker = text(validation["blocker"])
  let blocker = needsBackground
    ? "needs_background_agent"
    : !localBlocker.isEmpty ? localBlocker : !validationBlocker.isEmpty ? validationBlocker : operations.isEmpty ? "blocked_planner_model_unavailable" : ""
  let status = needsBackground ? "needs_background_agent" : operations.isEmpty || !valid || !blocker.isEmpty ? "blocked" : "planned"
  if !valid || !blocker.isEmpty { operations = [] }
  return [
    "ok": !operations.isEmpty && valid && !needsBackground && blocker.isEmpty,
    "status": status,
    "instruction": instruction,
    "summary": modelPlan.summary,
    "operations": operations,
    "planner": [
      "provider": modelPlan.provider,
      "modelUsed": modelPlan.modelUsed,
      "modelName": modelPlan.modelName,
      "serviceTier": modelPlan.serviceTier,
      "latencyMs": normalizeMs,
      "normalizeMs": normalizeMs,
      "modelLatencyMs": modelPlan.latencyMs,
      "actionKinds": actionKinds,
      "maxActions": intValue(config["maxActions"]),
      "deterministicOperationsExpected": deterministicOperations.count,
      "deterministicOperationsMatched": deterministicOperationsMatched,
      "deterministicOperationsMismatch": deterministicOperationsMatched ? [:] : [
        "expected": deterministicOperations,
        "actual": operations,
      ],
      "runtime": modelPlan.runtime,
      "modelConfig": config,
      "validation": validation["validation"] ?? [:],
    ],
    "blocker": blocker,
  ]
}
