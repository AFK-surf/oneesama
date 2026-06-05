import Foundation

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

func writeJSONFile(_ value: Any, path: String) throws {
  let data = try JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys])
  try data.write(to: URL(fileURLWithPath: path), options: [.atomic])
}

func resultWithTraceArtifact(_ result: [String: Any], params: [String: Any], method: String) throws -> [String: Any] {
  let traceOutput = text(firstParam(params, "traceOutput"))
  if traceOutput.isEmpty { return result }
  var trace = result
  trace["schema"] = "oneesama.kwwk-app-control-trace.v1"
  trace["method"] = method
  trace["recordedAt"] = Int(Date().timeIntervalSince1970 * 1000)
  try writeJSONFile(trace, path: traceOutput)
  var compact = result
  compact["traceArtifact"] = traceOutput
  return compact
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

func envText(_ key: String, default fallback: String = "") -> String {
  let value = ProcessInfo.processInfo.environment[key] ?? ""
  let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
  return trimmed.isEmpty ? fallback : trimmed
}

func envFirstText(_ keys: [String], default fallback: String = "") -> String {
  for key in keys {
    let value = envText(key)
    if !value.isEmpty { return value }
  }
  return fallback
}

func envInt(_ key: String, default fallback: Int, min: Int, max: Int) -> Int {
  let value = Int(envText(key)) ?? fallback
  return Swift.max(min, Swift.min(max, value))
}

func plannerProvider() -> String {
  let provider = envFirstText(
    ["ONEESAMA_KWWK_CU_PLANNER_PROVIDER", "ONEESAMA_KWWK_PLANNER_PROVIDER", "MAB_KWWK_CU_PLANNER_PROVIDER", "MAB_KWWK_PLANNER_PROVIDER"],
    default: "gemini"
  ).lowercased()
  if provider == "openai" || provider == "openrouter" || provider == "gemini" || provider == "local" || provider == "fixture" { return provider }
  return "gemini"
}

func plannerConfig() -> [String: Any] {
  let provider = plannerProvider()
  return [
    "provider": provider,
    "model": envFirstText(
      ["ONEESAMA_KWWK_CU_PLANNER_MODEL", "ONEESAMA_KWWK_PLANNER_MODEL", "MAB_KWWK_CU_PLANNER_MODEL", "MAB_KWWK_PLANNER_MODEL"],
      default: provider == "gemini" ? "gemini-3.5-flash" : "google/gemini-3.5-flash"
    ),
    "timeoutMs": envInt("ONEESAMA_KWWK_CU_PLANNER_TIMEOUT_MS", default: envInt("ONEESAMA_KWWK_PLANNER_TIMEOUT_MS", default: 3000, min: 100, max: 10000), min: 100, max: 10000),
    "maxActions": envInt("ONEESAMA_KWWK_CU_PLANNER_MAX_ACTIONS", default: envInt("ONEESAMA_KWWK_PLANNER_MAX_ACTIONS", default: 3, min: 1, max: 8), min: 1, max: 8),
    "reasoningEffort": envFirstText(
      ["ONEESAMA_KWWK_CU_PLANNER_REASONING_EFFORT", "ONEESAMA_KWWK_PLANNER_REASONING_EFFORT", "MAB_KWWK_CU_PLANNER_REASONING_EFFORT", "MAB_KWWK_PLANNER_REASONING_EFFORT"],
      default: provider == "openrouter" || provider == "gemini" ? "minimal" : "low"
    ),
    "serviceTier": envFirstText(
      ["ONEESAMA_KWWK_CU_PLANNER_SERVICE_TIER", "ONEESAMA_KWWK_PLANNER_SERVICE_TIER", "MAB_KWWK_CU_PLANNER_SERVICE_TIER", "MAB_KWWK_PLANNER_SERVICE_TIER"]
    ),
  ]
}

func containsAny(_ value: String, _ needles: [String]) -> Bool {
  for needle in needles {
    if value.contains(needle) { return true }
  }
  return false
}

func observationFromParams(_ params: [String: Any]) -> [String: Any] {
  if let observation = params["observation"] as? [String: Any] { return observation }
  if let context = params["context"] as? [String: Any],
     let observation = context["observation"] as? [String: Any] {
    return observation
  }
  return [:]
}
