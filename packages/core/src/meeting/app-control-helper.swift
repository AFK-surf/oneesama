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

private final class AutomationClickIndicatorView: NSView {
  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    wantsLayer = true
    layer?.backgroundColor = NSColor.systemRed.cgColor
    layer?.cornerRadius = frameRect.width / 2
    layer?.borderWidth = 1
    layer?.borderColor = NSColor.white.withAlphaComponent(0.9).cgColor
    layer?.shadowColor = NSColor.black.withAlphaComponent(0.35).cgColor
    layer?.shadowOpacity = 1
    layer?.shadowRadius = 3
    layer?.shadowOffset = .zero
  }

  @available(*, unavailable)
  required init?(coder _: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  override func hitTest(_: NSPoint) -> NSView? {
    nil
  }
}

private final class KWWKForegroundCursorPanel: NSPanel {
  override var canBecomeKey: Bool {
    false
  }

  override var canBecomeMain: Bool {
    false
  }
}

private enum KWWKForegroundCursorGeometry {
  static let panelSize = CGSize(width: 160, height: 160)
  static let renderSize: CGFloat = 28
  static let hotspot = CGPoint(x: 17.0 / 101.0, y: 13.0 / 101.0)
}

private enum KWWKForegroundCursorTiming {
  static var bootstrapHold: TimeInterval {
    milliseconds(from: "ONEESAMA_KWWK_CURSOR_BOOTSTRAP_MS", fallback: 10)
  }

  static var preActionHold: TimeInterval {
    milliseconds(from: "ONEESAMA_KWWK_CURSOR_PRE_MS", fallback: 20)
  }

  static var postApproachDwell: TimeInterval {
    milliseconds(from: "ONEESAMA_KWWK_CURSOR_DWELL_MS", fallback: 90)
  }

  static var finalHold: TimeInterval {
    milliseconds(from: "ONEESAMA_KWWK_CURSOR_HOLD_MS", fallback: 40)
  }

  static var approachDuration: TimeInterval {
    milliseconds(from: "ONEESAMA_KWWK_CURSOR_APPROACH_MS", fallback: 230)
  }

  static var approachStep: TimeInterval {
    milliseconds(from: "ONEESAMA_KWWK_CURSOR_APPROACH_STEP_MS", fallback: 12)
  }

  static var dragDuration: TimeInterval {
    milliseconds(from: "ONEESAMA_KWWK_CURSOR_DRAG_MS", fallback: 150)
  }

  static var dragStep: TimeInterval {
    milliseconds(from: "ONEESAMA_KWWK_CURSOR_DRAG_STEP_MS", fallback: 10)
  }

  private static func milliseconds(from key: String, fallback: Double) -> TimeInterval {
    guard
      let raw = ProcessInfo.processInfo.environment[key],
      let value = Double(raw),
      value >= 0
    else {
      return fallback / 1000
    }
    return value / 1000
  }
}

private struct KWWKActionOverlayBezierSample {
  let point: CGPoint
  let theta: CGFloat
}

private enum KWWKActionOverlayBezierMode {
  case quartic(handleScale: CGFloat)
  case spiral(rotationDir: CGFloat, d1Scale: CGFloat)
  case degenerate

  var name: String {
    switch self {
    case .quartic: return "quartic"
    case .spiral: return "spiral"
    case .degenerate: return "degenerate"
    }
  }

  var payload: [String: Any] {
    switch self {
    case .quartic(let handleScale):
      return ["kind": name, "handleScale": Double(handleScale)]
    case .spiral(let rotationDir, let d1Scale):
      return ["kind": name, "rotationDir": Double(rotationDir), "d1Scale": Double(d1Scale)]
    case .degenerate:
      return ["kind": name]
    }
  }
}

private struct KWWKActionOverlayTurnBoundTest {
  let passed: Bool
  let sampleCount: Int
  let violations: Int
  let worstRatio: CGFloat
  let worstWindow: CGFloat
  let maxDegPerPx: CGFloat
  let windowPx: CGFloat
}

private struct KWWKActionOverlayCandidatePool {
  let total: Int
  let passing: Int
}

private struct KWWKActionOverlayBezierDiagnostics {
  let test: KWWKActionOverlayTurnBoundTest
  let turning: CGFloat
  let pool: KWWKActionOverlayCandidatePool
}

private struct KWWKActionOverlayBezierPlan {
  let startPoint: CGPoint
  let endPoint: CGPoint
  let startHeading: CGFloat
  let endHeading: CGFloat
  let samples: [KWWKActionOverlayBezierSample]
  let cumLen: [CGFloat]
  let totalLength: CGFloat
  let controlPoints: [CGPoint]
  let mode: KWWKActionOverlayBezierMode
  var diagnostics: KWWKActionOverlayBezierDiagnostics
}

private struct KWWKActionOverlayBezierPlanner {
  var turnRate: CGFloat
  var bulgeMax: CGFloat

  static let `default` = KWWKActionOverlayBezierPlanner(
    turnRate: 2.0,
    bulgeMax: 0.45
  )

  private struct Candidate {
    let plan: KWWKActionOverlayBezierPlan
    let test: KWWKActionOverlayTurnBoundTest
    let turning: CGFloat
  }

  private static let baseHandleScale: CGFloat = 0.4
  private static let maxHandleScale: CGFloat = 4.0
  private static let handleScaleGrowth: CGFloat = 1.4
  private static let turnBoundWindowPx: CGFloat = 10
  private static let turnToleranceRad: CGFloat = 0.02

  func buildPlan(
    startPoint: CGPoint,
    startHeading: CGFloat,
    endPoint: CGPoint,
    endHeading: CGFloat
  ) -> KWWKActionOverlayBezierPlan {
    let d = dist(startPoint, endPoint)
    if d < 0.5 {
      return degeneratePlan(
        startPoint: startPoint,
        startHeading: startHeading,
        endPoint: endPoint,
        endHeading: endHeading,
        distance: d
      )
    }

    let maxBulge = max(0, bulgeMax)
    let quarticCandidates = quarticHandleScaleSweep().map { scale in
      evaluateCandidate(buildQuarticPlan(
        startPoint: startPoint,
        startHeading: startHeading,
        endPoint: endPoint,
        endHeading: endHeading,
        handleScale: scale,
        maxBulge: maxBulge
      ))
    }
    let quarticPassing = quarticCandidates.filter(\.test.passed)
    if !quarticPassing.isEmpty {
      return finalizePlan(
        rankCandidates(quarticPassing),
        evaluated: quarticCandidates.count,
        passingCount: quarticPassing.count
      )
    }

    var spiralCandidates: [Candidate] = []
    for dir in [CGFloat(1), CGFloat(-1)] {
      var value: CGFloat = 0.08
      while value <= 1.6 + 1e-9 {
        let d1Scale = CGFloat(round(value * 1000) / 1000)
        if let plan = buildSpiralQuarticPlan(
          startPoint: startPoint,
          startHeading: startHeading,
          endPoint: endPoint,
          endHeading: endHeading,
          d1Scale: d1Scale,
          rotationDir: dir
        ) {
          spiralCandidates.append(evaluateCandidate(plan))
        }
        value += 0.04
      }
    }

    let all = quarticCandidates + spiralCandidates
    let passing = all.filter(\.test.passed)
    let pool = passing.isEmpty ? all : passing
    return finalizePlan(
      rankCandidates(pool),
      evaluated: all.count,
      passingCount: passing.count
    )
  }

  func samplePlan(
    _ plan: KWWKActionOverlayBezierPlan,
    atArcLength arcLength: CGFloat
  ) -> KWWKActionOverlayBezierSample {
    let samples = plan.samples
    let cumLen = plan.cumLen
    let n = samples.count
    if arcLength <= 0 { return samples[0] }
    if arcLength >= plan.totalLength {
      return KWWKActionOverlayBezierSample(point: plan.endPoint, theta: plan.endHeading)
    }

    var lo = 0
    var hi = n - 1
    while lo + 1 < hi {
      let mid = (lo + hi) >> 1
      if cumLen[mid] <= arcLength {
        lo = mid
      } else {
        hi = mid
      }
    }
    let span = cumLen[hi] - cumLen[lo]
    let t = span > 0 ? (arcLength - cumLen[lo]) / span : 0
    let a = samples[lo]
    let b = samples[hi]
    return KWWKActionOverlayBezierSample(
      point: CGPoint(
        x: a.point.x + (b.point.x - a.point.x) * t,
        y: a.point.y + (b.point.y - a.point.y) * t
      ),
      theta: wrapAngle(a.theta + shortestAngleDelta(a.theta, b.theta) * t)
    )
  }

  private func buildQuarticPlan(
    startPoint: CGPoint,
    startHeading: CGFloat,
    endPoint: CGPoint,
    endHeading: CGFloat,
    handleScale: CGFloat,
    maxBulge: CGFloat
  ) -> KWWKActionOverlayBezierPlan {
    let startTangent = CGPoint(x: cos(startHeading), y: sin(startHeading))
    let endTangent = CGPoint(x: cos(endHeading), y: sin(endHeading))
    let d = dist(startPoint, endPoint)
    let h = d * handleScale

    let p0 = startPoint
    let p4 = endPoint
    let p1 = CGPoint(x: p0.x + h * startTangent.x, y: p0.y + h * startTangent.y)
    let p3 = CGPoint(x: p4.x - h * endTangent.x, y: p4.y - h * endTangent.y)

    let directX = (p4.x - p0.x) / d
    let directY = (p4.y - p0.y) / d
    let normalX = -directY
    let normalY = directX
    let crossSum = (startTangent.x + endTangent.x) * directY - (startTangent.y + endTangent.y) * directX
    let sign: CGFloat = crossSum >= 0 ? 1 : -1
    let alignment = startTangent.x * directX + startTangent.y * directY
    let bulgeFactor = (1 - alignment) * 0.5
    let bulge = d * maxBulge * bulgeFactor * sign

    let p2 = CGPoint(
      x: 0.5 * (p1.x + p3.x) + normalX * bulge,
      y: 0.5 * (p1.y + p3.y) + normalY * bulge
    )
    let approxLen = d + abs(bulge) * 2 + h * 2
    let sampleCount = clamp(ceil(approxLen / 2), 120, 1600)
    return sampledPlan(
      startPoint: startPoint,
      startHeading: startHeading,
      endPoint: endPoint,
      endHeading: endHeading,
      controlPoints: [p0, p1, p2, p3, p4],
      sampleCount: Int(sampleCount),
      mode: .quartic(handleScale: handleScale)
    )
  }

  private func buildSpiralQuarticPlan(
    startPoint: CGPoint,
    startHeading: CGFloat,
    endPoint: CGPoint,
    endHeading: CGFloat,
    d1Scale: CGFloat,
    rotationDir: CGFloat
  ) -> KWWKActionOverlayBezierPlan? {
    let d = dist(startPoint, endPoint)
    if d < 0.5 { return nil }

    let shortest = shortestAngleDelta(startHeading, endHeading)
    let totalRotation = shortest + rotationDir * 2 * .pi
    let delta = totalRotation / 3
    let a0 = startHeading
    let a1 = startHeading + delta
    let a2 = startHeading + 2 * delta
    let a3 = startHeading + 3 * delta
    let u0 = CGPoint(x: cos(a0), y: sin(a0))
    let u1 = CGPoint(x: cos(a1), y: sin(a1))
    let u2 = CGPoint(x: cos(a2), y: sin(a2))
    let u3 = CGPoint(x: cos(a3), y: sin(a3))
    let d1 = d * d1Scale
    let d4 = d1
    let rx = (endPoint.x - startPoint.x) - d1 * u0.x - d4 * u3.x
    let ry = (endPoint.y - startPoint.y) - d1 * u0.y - d4 * u3.y
    let det = u1.x * u2.y - u1.y * u2.x
    if abs(det) < 1e-6 { return nil }
    let d2 = (rx * u2.y - ry * u2.x) / det
    let d3 = (u1.x * ry - u1.y * rx) / det
    if d2 <= 0 || d3 <= 0 { return nil }

    let p0 = startPoint
    let p1 = CGPoint(x: p0.x + d1 * u0.x, y: p0.y + d1 * u0.y)
    let p2 = CGPoint(x: p1.x + d2 * u1.x, y: p1.y + d2 * u1.y)
    let p3 = CGPoint(x: p2.x + d3 * u2.x, y: p2.y + d3 * u2.y)
    let p4 = endPoint
    let sampleCount = clamp(ceil((d1 + d2 + d3 + d4) / 1.5), 200, 2400)
    return sampledPlan(
      startPoint: startPoint,
      startHeading: startHeading,
      endPoint: endPoint,
      endHeading: endHeading,
      controlPoints: [p0, p1, p2, p3, p4],
      sampleCount: Int(sampleCount),
      mode: .spiral(rotationDir: rotationDir, d1Scale: d1Scale)
    )
  }

  private func sampledPlan(
    startPoint: CGPoint,
    startHeading: CGFloat,
    endPoint: CGPoint,
    endHeading: CGFloat,
    controlPoints: [CGPoint],
    sampleCount: Int,
    mode: KWWKActionOverlayBezierMode
  ) -> KWWKActionOverlayBezierPlan {
    let samples = buildQuarticSamples(
      controlPoints: controlPoints,
      count: sampleCount,
      startHeading: startHeading,
      endHeading: endHeading
    )
    var cumLen = [CGFloat](repeating: 0, count: samples.count)
    for index in 1 ..< samples.count {
      cumLen[index] = cumLen[index - 1] + dist(samples[index - 1].point, samples[index].point)
    }
    return KWWKActionOverlayBezierPlan(
      startPoint: startPoint,
      endPoint: endPoint,
      startHeading: startHeading,
      endHeading: endHeading,
      samples: samples,
      cumLen: cumLen,
      totalLength: cumLen.last ?? 0,
      controlPoints: controlPoints,
      mode: mode,
      diagnostics: KWWKActionOverlayBezierDiagnostics(
        test: verifyTurnBound(samples: samples),
        turning: totalTurning(samples),
        pool: KWWKActionOverlayCandidatePool(total: 0, passing: 0)
      )
    )
  }

  private func buildQuarticSamples(
    controlPoints: [CGPoint],
    count: Int,
    startHeading: CGFloat,
    endHeading: CGFloat
  ) -> [KWWKActionOverlayBezierSample] {
    let n = max(1, count)
    var samples: [KWWKActionOverlayBezierSample] = []
    samples.reserveCapacity(n + 1)
    for index in 0 ... n {
      let t = CGFloat(index) / CGFloat(n)
      let value = evalQuartic(controlPoints: controlPoints, t: t)
      let mag = hypot(value.dx, value.dy)
      let theta: CGFloat
      if mag < 1e-6 {
        if index == 0 {
          theta = startHeading
        } else if index == n {
          theta = endHeading
        } else {
          theta = samples[index - 1].theta
        }
      } else {
        theta = atan2(value.dy, value.dx)
      }
      samples.append(KWWKActionOverlayBezierSample(
        point: CGPoint(x: value.x, y: value.y),
        theta: theta
      ))
    }
    samples[0] = KWWKActionOverlayBezierSample(point: controlPoints[0], theta: startHeading)
    samples[n] = KWWKActionOverlayBezierSample(point: controlPoints[4], theta: endHeading)
    return samples
  }

  private func evalQuartic(
    controlPoints: [CGPoint],
    t: CGFloat
  ) -> (x: CGFloat, y: CGFloat, dx: CGFloat, dy: CGFloat) {
    let p0 = controlPoints[0]
    let p1 = controlPoints[1]
    let p2 = controlPoints[2]
    let p3 = controlPoints[3]
    let p4 = controlPoints[4]
    let u = 1 - t
    let u4 = u * u * u * u
    let u3t = u * u * u * t
    let u2t2 = u * u * t * t
    let ut3 = u * t * t * t
    let t4 = t * t * t * t
    let x = u4 * p0.x + 4 * u3t * p1.x + 6 * u2t2 * p2.x + 4 * ut3 * p3.x + t4 * p4.x
    let y = u4 * p0.y + 4 * u3t * p1.y + 6 * u2t2 * p2.y + 4 * ut3 * p3.y + t4 * p4.y

    let u3 = u * u * u
    let u2t = u * u * t
    let ut2 = u * t * t
    let t3 = t * t * t
    let dx = 4 * (
      u3 * (p1.x - p0.x)
        + 3 * u2t * (p2.x - p1.x)
        + 3 * ut2 * (p3.x - p2.x)
        + t3 * (p4.x - p3.x)
    )
    let dy = 4 * (
      u3 * (p1.y - p0.y)
        + 3 * u2t * (p2.y - p1.y)
        + 3 * ut2 * (p3.y - p2.y)
        + t3 * (p4.y - p3.y)
    )
    return (x, y, dx, dy)
  }

  private func verifyTurnBound(
    samples: [KWWKActionOverlayBezierSample]
  ) -> KWWKActionOverlayTurnBoundTest {
    let n = samples.count
    if n < 2 {
      return KWWKActionOverlayTurnBoundTest(
        passed: true,
        sampleCount: n,
        violations: 0,
        worstRatio: 0,
        worstWindow: 0,
        maxDegPerPx: turnRate,
        windowPx: Self.turnBoundWindowPx
      )
    }

    var cumLen = [CGFloat](repeating: 0, count: n)
    for index in 1 ..< n {
      cumLen[index] = cumLen[index - 1] + dist(samples[index - 1].point, samples[index].point)
    }

    let maxRadPerPx = (turnRate * .pi) / 180
    let tolerance: CGFloat = 1.002
    var worstRatio: CGFloat = 0
    var worstWindow: CGFloat = 0
    var violations = 0
    var j = 0
    for i in 0 ..< n {
      if j < i { j = i }
      while j < n, cumLen[j] - cumLen[i] <= Self.turnBoundWindowPx {
        let arcLen = cumLen[j] - cumLen[i]
        if arcLen > 1e-6 {
          let dTheta = abs(shortestAngleDelta(samples[i].theta, samples[j].theta))
          let allowed = maxRadPerPx * arcLen
          if dTheta > allowed * tolerance { violations += 1 }
          let ratio = dTheta / allowed
          if ratio > worstRatio {
            worstRatio = ratio
            worstWindow = arcLen
          }
        }
        j += 1
      }
    }

    return KWWKActionOverlayTurnBoundTest(
      passed: violations == 0,
      sampleCount: n,
      violations: violations,
      worstRatio: worstRatio,
      worstWindow: worstWindow,
      maxDegPerPx: turnRate,
      windowPx: Self.turnBoundWindowPx
    )
  }

  private func quarticHandleScaleSweep() -> [CGFloat] {
    var scales: [CGFloat] = [Self.baseHandleScale]
    var scale = Self.baseHandleScale
    while scale < Self.maxHandleScale {
      scale = min(scale * Self.handleScaleGrowth, Self.maxHandleScale)
      scales.append(scale)
      if scale >= Self.maxHandleScale - 1e-6 { break }
    }
    return scales
  }

  private func evaluateCandidate(_ plan: KWWKActionOverlayBezierPlan) -> Candidate {
    let test = verifyTurnBound(samples: plan.samples)
    return Candidate(plan: plan, test: test, turning: totalTurning(plan.samples))
  }

  private func rankCandidates(_ pool: [Candidate]) -> Candidate {
    pool.sorted { a, b in
      if a.test.passed != b.test.passed { return a.test.passed }
      let turnDiff = a.turning - b.turning
      if abs(turnDiff) > Self.turnToleranceRad { return turnDiff < 0 }
      return a.plan.totalLength < b.plan.totalLength
    }[0]
  }

  private func finalizePlan(
    _ winner: Candidate,
    evaluated: Int,
    passingCount: Int
  ) -> KWWKActionOverlayBezierPlan {
    var plan = winner.plan
    plan.diagnostics = KWWKActionOverlayBezierDiagnostics(
      test: winner.test,
      turning: winner.turning,
      pool: KWWKActionOverlayCandidatePool(total: evaluated, passing: passingCount)
    )
    return plan
  }

  private func degeneratePlan(
    startPoint: CGPoint,
    startHeading: CGFloat,
    endPoint: CGPoint,
    endHeading: CGFloat,
    distance: CGFloat
  ) -> KWWKActionOverlayBezierPlan {
    let samples = [
      KWWKActionOverlayBezierSample(point: startPoint, theta: startHeading),
      KWWKActionOverlayBezierSample(point: endPoint, theta: endHeading),
    ]
    return KWWKActionOverlayBezierPlan(
      startPoint: startPoint,
      endPoint: endPoint,
      startHeading: startHeading,
      endHeading: endHeading,
      samples: samples,
      cumLen: [0, distance],
      totalLength: distance,
      controlPoints: [startPoint, startPoint, startPoint, endPoint, endPoint],
      mode: .degenerate,
      diagnostics: KWWKActionOverlayBezierDiagnostics(
        test: KWWKActionOverlayTurnBoundTest(
          passed: true,
          sampleCount: 2,
          violations: 0,
          worstRatio: 0,
          worstWindow: 0,
          maxDegPerPx: turnRate,
          windowPx: Self.turnBoundWindowPx
        ),
        turning: 0,
        pool: KWWKActionOverlayCandidatePool(total: 1, passing: 1)
      )
    )
  }

  private func totalTurning(_ samples: [KWWKActionOverlayBezierSample]) -> CGFloat {
    var sum: CGFloat = 0
    for index in 1 ..< samples.count {
      sum += abs(shortestAngleDelta(samples[index - 1].theta, samples[index].theta))
    }
    return sum
  }

  private func dist(_ a: CGPoint, _ b: CGPoint) -> CGFloat {
    hypot(b.x - a.x, b.y - a.y)
  }

  private func clamp(_ value: CGFloat, _ lo: CGFloat, _ hi: CGFloat) -> CGFloat {
    min(hi, max(lo, value))
  }

  private func wrapAngle(_ angle: CGFloat) -> CGFloat {
    var value = angle
    while value > .pi {
      value -= 2 * .pi
    }
    while value <= -.pi {
      value += 2 * .pi
    }
    return value
  }

  private func shortestAngleDelta(_ from: CGFloat, _ to: CGFloat) -> CGFloat {
    wrapAngle(to - from)
  }
}

private final class KWWKForegroundCursorView: NSView {
  var kind = "cursor" {
    didSet { needsDisplay = true }
  }
  var trailPoints: [CGPoint] = [] {
    didSet { needsDisplay = true }
  }

  override func hitTest(_: NSPoint) -> NSView? {
    nil
  }

  override func draw(_ dirtyRect: NSRect) {
    super.draw(dirtyRect)

    let tip = CGPoint(x: bounds.midX, y: bounds.midY)
    let isDrag = kind.contains("drag")
    let ringColor = isDrag ? NSColor.systemOrange : NSColor.systemGreen

    if isDrag && trailPoints.count >= 2 {
      let trail = NSBezierPath()
      trail.move(to: trailPoints[0])
      for point in trailPoints.dropFirst() {
        trail.line(to: point)
      }
      NSColor.systemOrange.withAlphaComponent(0.28).setStroke()
      trail.lineWidth = 10
      trail.lineCapStyle = .round
      trail.lineJoinStyle = .round
      trail.stroke()

      NSColor.white.withAlphaComponent(0.72).setStroke()
      trail.lineWidth = 3
      trail.stroke()

      for point in trailPoints.dropLast() {
        let dot = NSBezierPath(ovalIn: CGRect(x: point.x - 3, y: point.y - 3, width: 6, height: 6))
        NSColor.systemOrange.withAlphaComponent(0.70).setFill()
        dot.fill()
      }
    }

    let ring = NSBezierPath(ovalIn: CGRect(
      x: tip.x - 22,
      y: tip.y - 22,
      width: 44,
      height: 44
    ))
    ringColor.withAlphaComponent(isDrag ? 0.26 : 0.20).setFill()
    ring.fill()
    ringColor.withAlphaComponent(0.85).setStroke()
    ring.lineWidth = 2.5
    ring.stroke()

    let arrow = NSBezierPath()
    arrow.move(to: tip)
    arrow.line(to: CGPoint(x: tip.x + 7, y: tip.y - 30))
    arrow.line(to: CGPoint(x: tip.x + 13, y: tip.y - 20))
    arrow.line(to: CGPoint(x: tip.x + 20, y: tip.y - 33))
    arrow.line(to: CGPoint(x: tip.x + 27, y: tip.y - 29))
    arrow.line(to: CGPoint(x: tip.x + 20, y: tip.y - 17))
    arrow.line(to: CGPoint(x: tip.x + 32, y: tip.y - 17))
    arrow.close()

    NSColor.black.withAlphaComponent(0.42).setStroke()
    arrow.lineWidth = 6
    arrow.lineJoinStyle = .round
    arrow.stroke()

    NSColor.white.setFill()
    arrow.fill()
    NSColor.black.withAlphaComponent(0.92).setStroke()
    arrow.lineWidth = 2
    arrow.stroke()
  }
}

private final class KWWKForegroundCursorOverlay {
  static let shared = KWWKForegroundCursorOverlay()

  private var panel: KWWKForegroundCursorPanel?
  private var view: KWWKForegroundCursorView?
  private var materialized = false
  private var poseAppKitPoint: CGPoint?
  private var poseHeading: CGFloat?
  private var dragTrailAppKitPoints: [CGPoint] = []

  private init() {}

  func present(quartzPoint: CGPoint, kind: String, label: String = "") -> [String: Any] {
    if Thread.isMainThread {
      return presentOnMain(quartzPoint: quartzPoint, kind: kind, label: label)
    }

    var result: [String: Any] = [
      "schema": "oneesama.kwwk-native-foreground-cursor.v1",
      "materialized": false,
      "blocker": "not_main_thread",
    ]
    DispatchQueue.main.sync {
      result = self.presentOnMain(quartzPoint: quartzPoint, kind: kind, label: label)
    }
    return result
  }

  func drag(fromQuartzPoint: CGPoint, toQuartzPoint: CGPoint, label: String = "") -> [String: Any] {
    if Thread.isMainThread {
      return dragOnMain(fromQuartzPoint: fromQuartzPoint, toQuartzPoint: toQuartzPoint, label: label)
    }

    var result: [String: Any] = [
      "schema": "oneesama.kwwk-native-foreground-cursor.v1",
      "materialized": false,
      "blocker": "not_main_thread",
    ]
    DispatchQueue.main.sync {
      result = self.dragOnMain(fromQuartzPoint: fromQuartzPoint, toQuartzPoint: toQuartzPoint, label: label)
    }
    return result
  }

  private func presentOnMain(quartzPoint: CGPoint, kind: String, label: String) -> [String: Any] {
    _ = NSApplication.shared.setActivationPolicy(.accessory)
    let placement = Self.appKitScreenPoint(fromQuartzScreenPoint: quartzPoint)
    ensureMaterialized()
    guard let panel, let view else {
      return evidence(
        quartzPoint: quartzPoint,
        appKitPoint: placement.point,
        displayID: placement.displayID,
        screenFrame: placement.screenFrame,
        quartzFrame: placement.quartzFrame,
        kind: kind,
        label: label,
        materialized: false
      )
    }

    defer {
      hideOnMain()
    }
    view.kind = kind
    if !kind.contains("drag") {
      dragTrailAppKitPoints = []
      view.trailPoints = []
    }
    panel.orderFrontRegardless()
    let startPoint = poseAppKitPoint ?? Self.defaultApproachStart(
      for: placement.point,
      in: placement.screenFrame
    )
    let approach = animateCursor(
      from: startPoint,
      to: placement.point,
      kind: kind,
      duration: KWWKForegroundCursorTiming.approachDuration,
      step: KWWKForegroundCursorTiming.approachStep,
      mode: "approach"
    )
    Self.pump(for: KWWKForegroundCursorTiming.preActionHold)
    var payload = evidence(
      quartzPoint: quartzPoint,
      appKitPoint: placement.point,
      displayID: placement.displayID,
      screenFrame: placement.screenFrame,
      quartzFrame: placement.quartzFrame,
      kind: kind,
      label: label,
      materialized: materialized
    )
    payload["animation"] = [
      "style": "cueboard_style_ease_in_out",
      "approach": approach,
      "drag": ["enabled": false],
    ]
    Self.pump(for: KWWKForegroundCursorTiming.finalHold)
    return payload
  }

  private func dragOnMain(fromQuartzPoint: CGPoint, toQuartzPoint: CGPoint, label: String) -> [String: Any] {
    _ = NSApplication.shared.setActivationPolicy(.accessory)
    let startPlacement = Self.appKitScreenPoint(fromQuartzScreenPoint: fromQuartzPoint)
    let endPlacement = Self.appKitScreenPoint(fromQuartzScreenPoint: toQuartzPoint)
    ensureMaterialized()
    guard let panel, let view else {
      return evidence(
        quartzPoint: toQuartzPoint,
        appKitPoint: endPlacement.point,
        displayID: endPlacement.displayID,
        screenFrame: endPlacement.screenFrame,
        quartzFrame: endPlacement.quartzFrame,
        kind: "drag",
        label: label,
        materialized: false
      )
    }

    defer {
      hideOnMain()
    }
    view.kind = "drag"
    view.trailPoints = []
    dragTrailAppKitPoints = []
    panel.orderFrontRegardless()
    let approachStart = poseAppKitPoint ?? Self.defaultApproachStart(
      for: startPlacement.point,
      in: startPlacement.screenFrame
    )
    let approach = animateCursor(
      from: approachStart,
      to: startPlacement.point,
      kind: "drag.begin",
      duration: KWWKForegroundCursorTiming.approachDuration,
      step: KWWKForegroundCursorTiming.approachStep,
      mode: "approach"
    )
    Self.pump(for: KWWKForegroundCursorTiming.postApproachDwell)
    dragTrailAppKitPoints = [startPlacement.point]
    let drag = animateCursor(
      from: startPlacement.point,
      to: endPlacement.point,
      kind: "drag",
      duration: KWWKForegroundCursorTiming.dragDuration,
      step: KWWKForegroundCursorTiming.dragStep,
      mode: "drag"
    )
    var payload = evidence(
      quartzPoint: toQuartzPoint,
      appKitPoint: endPlacement.point,
      displayID: endPlacement.displayID,
      screenFrame: endPlacement.screenFrame,
      quartzFrame: endPlacement.quartzFrame,
      kind: "drag",
      label: label,
      materialized: materialized
    )
    payload["screenPointStart"] = ["x": Double(fromQuartzPoint.x), "y": Double(fromQuartzPoint.y)]
    payload["appKitPointStart"] = ["x": Double(startPlacement.point.x), "y": Double(startPlacement.point.y)]
    payload["animation"] = [
      "style": "cueboard_style_ease_in_out",
      "approach": approach,
      "drag": drag,
    ]
    payload["nativeDragTrail"] = [
      "enabled": dragTrailAppKitPoints.count >= 2,
      "pointCount": dragTrailAppKitPoints.count,
      "style": "native_foreground_orange_trail",
    ]
    Self.pump(for: KWWKForegroundCursorTiming.finalHold)
    return payload
  }

  private func hideOnMain() {
    panel?.orderOut(nil)
    view?.trailPoints = []
    panel?.displayIfNeeded()
  }

  private func ensureMaterialized() {
    if materialized {
      return
    }

    let newView = KWWKForegroundCursorView(frame: CGRect(origin: .zero, size: KWWKForegroundCursorGeometry.panelSize))
    let newPanel = KWWKForegroundCursorPanel(
      contentRect: CGRect(origin: .zero, size: KWWKForegroundCursorGeometry.panelSize),
      styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered,
      defer: false
    )
    newPanel.backgroundColor = .clear
    newPanel.isOpaque = false
    newPanel.hasShadow = false
    newPanel.ignoresMouseEvents = true
    newPanel.animationBehavior = .none
    newPanel.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
    newPanel.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.screenSaverWindow)) + 2)
    newPanel.contentView = newView

    panel = newPanel
    view = newView
    newPanel.orderFrontRegardless()
    newPanel.displayIfNeeded()
    Self.pump(for: KWWKForegroundCursorTiming.bootstrapHold)
    materialized = true
  }

  private func animateCursor(
    from start: CGPoint,
    to end: CGPoint,
    kind: String,
    duration: TimeInterval,
    step: TimeInterval,
    mode: String
  ) -> [String: Any] {
    guard let panel, let view else {
      return ["enabled": false, "blocker": "native_cursor_panel_missing"]
    }

    view.kind = kind
    let safeStep = max(step, 0.001)
    let frameCount = max(2, Int(ceil(max(duration, safeStep) / safeStep)) + 1)
    let heading = Self.animationHeadings(
      from: start,
      to: end,
      previousHeading: poseHeading,
      mode: mode
    )
    let plan = KWWKActionOverlayBezierPlanner.default.buildPlan(
      startPoint: start,
      startHeading: heading.start,
      endPoint: end,
      endHeading: heading.end
    )
    for index in 0 ..< frameCount {
      let raw = frameCount <= 1 ? 1 : CGFloat(index) / CGFloat(frameCount - 1)
      let eased = Self.easeInOut(raw)
      let sample = KWWKActionOverlayBezierPlanner.default.samplePlan(
        plan,
        atArcLength: plan.totalLength * eased
      )
      let point = sample.point
      panel.setFrameOrigin(Self.panelOrigin(forAppKitPoint: point))
      if mode == "drag" {
        dragTrailAppKitPoints.append(point)
        if dragTrailAppKitPoints.count > 18 {
          dragTrailAppKitPoints.removeFirst(dragTrailAppKitPoints.count - 18)
        }
        view.trailPoints = Self.localTrailPoints(history: dragTrailAppKitPoints, current: point)
      }
      panel.displayIfNeeded()
      poseAppKitPoint = point
      poseHeading = sample.theta
      if index < frameCount - 1 {
        Self.pump(for: safeStep)
      }
    }

    return [
      "enabled": true,
      "mode": mode,
      "durationMs": Int(max(duration, safeStep) * 1000),
      "stepMs": Int(safeStep * 1000),
      "frameCount": frameCount,
      "pathLength": Double(plan.totalLength),
      "startAppKitPoint": ["x": Double(start.x), "y": Double(start.y)],
      "endAppKitPoint": ["x": Double(end.x), "y": Double(end.y)],
      "easing": "arc_length_smoothstep",
      "pathPlanner": "cueboard_action_overlay_bezier",
      "pathPlannerSource": "bridge/cueboard/ActionOverlayBezierPath.swift",
      "bezier": Self.bezierPayload(plan),
    ]
  }

  private func evidence(
    quartzPoint: CGPoint,
    appKitPoint: CGPoint,
    displayID: CGDirectDisplayID,
    screenFrame: CGRect,
    quartzFrame: CGRect,
    kind: String,
    label: String,
    materialized: Bool
  ) -> [String: Any] {
    [
      "schema": "oneesama.kwwk-native-foreground-cursor.v1",
      "source": "cueboard_bridge_computer_use_port",
      "evidenceMode": "native_ns_panel",
      "materialized": materialized,
      "visible": panel?.isVisible == true,
      "windowNumber": panel?.windowNumber ?? 0,
      "level": panel?.level.rawValue ?? 0,
      "nonActivating": true,
      "ignoresMouseEvents": panel?.ignoresMouseEvents == true,
      "transparent": panel?.isOpaque == false,
      "displayAnchor": "foreground",
      "displayID": Int(displayID),
      "screenPoint": ["x": Double(quartzPoint.x), "y": Double(quartzPoint.y)],
      "appKitPoint": ["x": Double(appKitPoint.x), "y": Double(appKitPoint.y)],
      "screenFrame": rectPayload(screenFrame),
      "quartzFrame": rectPayload(quartzFrame),
      "hotspot": [
        "x": Double(KWWKForegroundCursorGeometry.hotspot.x),
        "y": Double(KWWKForegroundCursorGeometry.hotspot.y),
      ],
      "renderSize": Double(KWWKForegroundCursorGeometry.renderSize),
      "kind": kind,
      "label": label,
      "at": Int(Date().timeIntervalSince1970 * 1000),
    ]
  }

  private static func panelOrigin(forAppKitPoint point: CGPoint) -> CGPoint {
    CGPoint(
      x: point.x - KWWKForegroundCursorGeometry.panelSize.width / 2,
      y: point.y - KWWKForegroundCursorGeometry.panelSize.height / 2
    )
  }

  private static func localTrailPoints(history: [CGPoint], current: CGPoint) -> [CGPoint] {
    history.map { point in
      CGPoint(
        x: KWWKForegroundCursorGeometry.panelSize.width / 2 + (point.x - current.x),
        y: KWWKForegroundCursorGeometry.panelSize.height / 2 + (point.y - current.y)
      )
    }
  }

  private static func animationHeadings(
    from start: CGPoint,
    to end: CGPoint,
    previousHeading: CGFloat?,
    mode: String
  ) -> (start: CGFloat, end: CGFloat) {
    let dx = end.x - start.x
    let dy = end.y - start.y
    if hypot(dx, dy) < 0.5 {
      let fallback = previousHeading ?? 0
      return (fallback, fallback)
    }
    let direct = atan2(dy, dx)
    let sign: CGFloat = dx >= 0 ? 1 : -1
    let bend: CGFloat = mode == "drag" ? 0.10 : 0.18
    let inheritedHeading: CGFloat?
    if let previousHeading,
       abs(Self.shortestAngleDelta(from: previousHeading, to: direct)) <= (.pi / 2)
    {
      inheritedHeading = previousHeading
    } else {
      inheritedHeading = nil
    }
    return (
      inheritedHeading ?? direct + bend * sign,
      direct - bend * sign
    )
  }

  private static func shortestAngleDelta(from: CGFloat, to: CGFloat) -> CGFloat {
    var value = to - from
    while value > .pi {
      value -= 2 * .pi
    }
    while value <= -.pi {
      value += 2 * .pi
    }
    return value
  }

  private static func bezierPayload(_ plan: KWWKActionOverlayBezierPlan) -> [String: Any] {
    [
      "schema": "oneesama.kwwk-cueboard-bezier-plan.v1",
      "planner": "cueboard_action_overlay_bezier",
      "mode": plan.mode.payload,
      "controlPointCount": plan.controlPoints.count,
      "controlPoints": plan.controlPoints.map { point in
        ["x": Double(point.x), "y": Double(point.y)]
      },
      "sampleCount": plan.samples.count,
      "totalLength": Double(plan.totalLength),
      "startHeading": Double(plan.startHeading),
      "endHeading": Double(plan.endHeading),
      "turning": Double(plan.diagnostics.turning),
      "turnBound": [
        "passed": plan.diagnostics.test.passed,
        "sampleCount": plan.diagnostics.test.sampleCount,
        "violations": plan.diagnostics.test.violations,
        "worstRatio": Double(plan.diagnostics.test.worstRatio),
        "worstWindow": Double(plan.diagnostics.test.worstWindow),
        "maxDegPerPx": Double(plan.diagnostics.test.maxDegPerPx),
        "windowPx": Double(plan.diagnostics.test.windowPx),
      ],
      "candidatePool": [
        "total": plan.diagnostics.pool.total,
        "passing": plan.diagnostics.pool.passing,
      ],
    ]
  }

  static func renderProbe(outputDir: String = "") throws -> [String: Any] {
    let directory = outputDir.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      ? "\(NSTemporaryDirectory())oneesama-native-cursor-render-\(UUID().uuidString)"
      : outputDir
    try FileManager.default.createDirectory(
      at: URL(fileURLWithPath: directory),
      withIntermediateDirectories: true
    )
    let light = try renderProbeImage(
      kind: "click",
      background: NSColor(calibratedWhite: 1, alpha: 1),
      outputPath: "\(directory)/native-cursor-light.png"
    )
    let dark = try renderProbeImage(
      kind: "click",
      background: NSColor(calibratedWhite: 0.08, alpha: 1),
      outputPath: "\(directory)/native-cursor-dark.png"
    )
    let drag = try renderProbeImage(
      kind: "drag",
      background: NSColor(calibratedWhite: 0.08, alpha: 1),
      outputPath: "\(directory)/native-cursor-drag-trail.png",
      trailPoints: [
        CGPoint(x: 42, y: 104),
        CGPoint(x: 70, y: 96),
        CGPoint(x: 100, y: 88),
        CGPoint(x: 126, y: 80),
      ]
    )
    return [
      "schema": "oneesama.kwwk-native-cursor-render.v1",
      "evidenceMode": "native_view_rendered_png_pixels",
      "outputDir": directory,
      "light": light,
      "dark": dark,
      "dragTrail": drag,
    ]
  }

  private static func renderProbeImage(
    kind: String,
    background: NSColor,
    outputPath: String,
    trailPoints: [CGPoint] = []
  ) throws -> [String: Any] {
    let size = CGSize(width: 240, height: 240)
    guard let rep = NSBitmapImageRep(
      bitmapDataPlanes: nil,
      pixelsWide: Int(size.width),
      pixelsHigh: Int(size.height),
      bitsPerSample: 8,
      samplesPerPixel: 4,
      hasAlpha: true,
      isPlanar: false,
      colorSpaceName: .deviceRGB,
      bitmapFormat: [],
      bytesPerRow: 0,
      bitsPerPixel: 0
    ) else {
      throw HelperError.unsupported("native_cursor_render_bitmap_failed")
    }
    guard let context = NSGraphicsContext(bitmapImageRep: rep) else {
      throw HelperError.unsupported("native_cursor_render_context_failed")
    }
    do {
      let previous = NSGraphicsContext.current
      NSGraphicsContext.current = context
      defer {
        NSGraphicsContext.current = previous
      }
      background.setFill()
      NSRect(origin: .zero, size: size).fill()
      let view = KWWKForegroundCursorView(frame: CGRect(origin: .zero, size: size))
      view.kind = kind
      view.trailPoints = trailPoints
      view.draw(CGRect(origin: .zero, size: size))
    }
    guard let data = rep.representation(using: .png, properties: [:]) else {
      throw HelperError.unsupported("native_cursor_render_png_failed")
    }
    try data.write(to: URL(fileURLWithPath: outputPath), options: [.atomic])
    let ratio = nonBackgroundRatio(rep: rep, background: background)
    return [
      "kind": kind,
      "outputPath": outputPath,
      "width": Int(size.width),
      "height": Int(size.height),
      "nonBackgroundRatio": ratio,
      "trailPointCount": trailPoints.count,
    ]
  }

  private static func nonBackgroundRatio(rep: NSBitmapImageRep, background: NSColor) -> Double {
    let bg = background.usingColorSpace(.deviceRGB) ?? background
    var changed = 0
    let total = max(1, rep.pixelsWide * rep.pixelsHigh)
    for y in 0 ..< rep.pixelsHigh {
      for x in 0 ..< rep.pixelsWide {
        guard let color = rep.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB) else { continue }
        let delta = abs(color.redComponent - bg.redComponent)
          + abs(color.greenComponent - bg.greenComponent)
          + abs(color.blueComponent - bg.blueComponent)
        if delta > 0.08 {
          changed += 1
        }
      }
    }
    return Double(changed) / Double(total)
  }

  private static func defaultApproachStart(for point: CGPoint, in screenFrame: CGRect) -> CGPoint {
    CGPoint(
      x: min(max(screenFrame.minX + 24, point.x - 120), screenFrame.maxX - 24),
      y: min(max(screenFrame.minY + 24, point.y - 90), screenFrame.maxY - 24)
    )
  }

  private static func easeInOut(_ value: CGFloat) -> CGFloat {
    let x = min(max(value, 0), 1)
    return (10 * pow(x, 3)) - (15 * pow(x, 4)) + (6 * pow(x, 5))
  }

  private static func appKitScreenPoint(
    fromQuartzScreenPoint point: CGPoint
  ) -> (point: CGPoint, displayID: CGDirectDisplayID, screenFrame: CGRect, quartzFrame: CGRect) {
    let spaces = NSScreen.screens.compactMap { screen -> (displayID: CGDirectDisplayID, screenFrame: CGRect, quartzFrame: CGRect)? in
      guard
        let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber
      else {
        return nil
      }
      let displayID = CGDirectDisplayID(number.uint32Value)
      return (displayID, screen.frame, CGDisplayBounds(displayID))
    }

    let space = spaces.first(where: { $0.quartzFrame.contains(point) })
      ?? spaces.min(by: {
        distanceSquared(from: point, to: $0.quartzFrame) < distanceSquared(from: point, to: $1.quartzFrame)
      })

    if let space {
      let localX = point.x - space.quartzFrame.minX
      let localY = point.y - space.quartzFrame.minY
      return (
        CGPoint(x: space.screenFrame.minX + localX, y: space.screenFrame.maxY - localY),
        space.displayID,
        space.screenFrame,
        space.quartzFrame
      )
    }

    let mainDisplayID = CGMainDisplayID()
    let quartzFrame = CGDisplayBounds(mainDisplayID)
    let screenFrame = NSScreen.main?.frame ?? quartzFrame
    let fallback = CGPoint(x: screenFrame.minX + point.x, y: screenFrame.maxY - point.y)
    return (fallback, mainDisplayID, screenFrame, quartzFrame)
  }

  private static func distanceSquared(from point: CGPoint, to rect: CGRect) -> CGFloat {
    let dx: CGFloat
    if point.x < rect.minX {
      dx = rect.minX - point.x
    } else if point.x > rect.maxX {
      dx = point.x - rect.maxX
    } else {
      dx = 0
    }

    let dy: CGFloat
    if point.y < rect.minY {
      dy = rect.minY - point.y
    } else if point.y > rect.maxY {
      dy = point.y - rect.maxY
    } else {
      dy = 0
    }

    return (dx * dx) + (dy * dy)
  }

  private static func pump(for duration: TimeInterval) {
    guard duration > 0 else { return }
    let until = Date(timeIntervalSinceNow: duration)
    while Date() < until {
      _ = RunLoop.current.run(mode: .default, before: until)
      _ = RunLoop.current.run(mode: .eventTracking, before: until)
    }
  }
}

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

func envInt(_ key: String, default fallback: Int, min: Int, max: Int) -> Int {
  let value = Int(envText(key)) ?? fallback
  return Swift.max(min, Swift.min(max, value))
}

func plannerProvider() -> String {
  let provider = envText("ONEESAMA_KWWK_PLANNER_PROVIDER", default: "off").lowercased()
  if provider == "openai" || provider == "local" { return provider }
  return "off"
}

func plannerConfig() -> [String: Any] {
  [
    "provider": plannerProvider(),
    "model": envText("ONEESAMA_KWWK_PLANNER_MODEL"),
    "timeoutMs": envInt("ONEESAMA_KWWK_PLANNER_TIMEOUT_MS", default: 1200, min: 100, max: 10000),
    "maxActions": envInt("ONEESAMA_KWWK_PLANNER_MAX_ACTIONS", default: 3, min: 1, max: 8),
  ]
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
  }
}

func capturedPixelScale(capturedWidth: Double, windowFrameWidth: Double, fallbackScale: Double) -> Double {
  if capturedWidth > 0 && windowFrameWidth > 0 {
    return max(0.1, capturedWidth / windowFrameWidth)
  }
  return max(0.1, fallbackScale)
}

func capturedPixelToAppKitPoint(
  x: Double,
  y: Double,
  capturedWidth: Double,
  capturedHeight: Double,
  windowFrame: [String: Any],
  flipped: Bool,
  fallbackScale: Double
) -> CGPoint {
  let frameWidth = max(1, doubleValue(windowFrame["width"]))
  let frameHeight = max(1, doubleValue(windowFrame["height"]))
  let scale = capturedPixelScale(
    capturedWidth: capturedWidth,
    windowFrameWidth: frameWidth,
    fallbackScale: fallbackScale
  )
  let pointX = doubleValue(windowFrame["x"]) + x / scale
  let sourceHeight = capturedHeight > 0 ? capturedHeight : frameHeight * scale
  let unflippedY = doubleValue(windowFrame["y"]) + y / scale
  let flippedY = doubleValue(windowFrame["y"]) + (sourceHeight - y) / scale
  return CGPoint(x: pointX, y: flipped ? flippedY : unflippedY)
}

func postMouse(_ type: CGEventType, point: CGPoint, button: CGMouseButton = .left) {
  CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: button)?
    .post(tap: .cghidEventTap)
}

func cursorCoordinateSpace(window: [String: Any]?, target: [String: Any]) -> [String: Any] {
  let frame = window?["frame"] as? [String: Any] ?? [:]
  let width = max(1, doubleValue(frame["width"]))
  let height = max(1, doubleValue(frame["height"]))
  return [
    "id": "kwwk_window_points",
    "source": "window",
    "origin": "top_left",
    "windowId": intValue(window?["windowId"]),
    "processId": intValue(window?["processId"]),
    "applicationName": text(window?["applicationName"]).isEmpty ? text(target["application_name"]) : text(window?["applicationName"]),
    "scaleFactor": backingScaleFactor(for: CGRect(
      x: doubleValue(frame["x"]),
      y: doubleValue(frame["y"]),
      width: width,
      height: height
    )),
    "originX": doubleValue(frame["x"]),
    "originY": doubleValue(frame["y"]),
    "width": width,
    "height": height,
  ]
}

func cursorCoordinateSpace(target: [String: Any]) -> [String: Any] {
  cursorCoordinateSpace(window: try? findWindow(target: target), target: target)
}

func requireCursorCoordinateSpace(target: [String: Any]) throws -> [String: Any] {
  guard let window = try? findWindow(target: target),
        let frame = window["frame"] as? [String: Any],
        doubleValue(frame["width"]) > 0,
        doubleValue(frame["height"]) > 0 else {
    throw HelperError.unsupported("cursor_unmappable")
  }
  return cursorCoordinateSpace(window: window, target: target)
}

func windowPoint(coordinateSpace: [String: Any], x: Double, y: Double) -> CGPoint {
  CGPoint(
    x: doubleValue(coordinateSpace["originX"]) + x,
    y: doubleValue(coordinateSpace["originY"]) + y
  )
}

func cursorEvent(kind: String, coordinateSpace: [String: Any], x: Double, y: Double, label: String = "") -> [String: Any] {
  let width = max(1, doubleValue(coordinateSpace["width"]))
  let height = max(1, doubleValue(coordinateSpace["height"]))
  return [
    "kind": kind,
    "x": x,
    "y": y,
    "normalizedX": max(0, min(1, x / width)),
    "normalizedY": max(0, min(1, y / height)),
    "label": label,
    "at": Int(Date().timeIntervalSince1970 * 1000),
    "coordinateSpaceId": text(coordinateSpace["id"]),
    "coordinateSpace": coordinateSpace,
  ]
}

func click(target: [String: Any], x: Double, y: Double) throws -> [String: Any] {
  let coordinateSpace = try requireCursorCoordinateSpace(target: target)
  try requireAccessibility()
  activateTarget(target)
  let point = windowPoint(coordinateSpace: coordinateSpace, x: x, y: y)
  let nativeCursor = KWWKForegroundCursorOverlay.shared.present(quartzPoint: point, kind: "click", label: "click")
  postMouse(.leftMouseDown, point: point)
  postMouse(.leftMouseUp, point: point)
  var event = cursorEvent(kind: "cursor.click", coordinateSpace: coordinateSpace, x: x, y: y, label: "click")
  event["nativeForegroundCursor"] = nativeCursor
  return event
}

func doubleClick(target: [String: Any], x: Double, y: Double) throws -> [String: Any] {
  let coordinateSpace = try requireCursorCoordinateSpace(target: target)
  try requireAccessibility()
  activateTarget(target)
  let point = windowPoint(coordinateSpace: coordinateSpace, x: x, y: y)
  let nativeCursor = KWWKForegroundCursorOverlay.shared.present(quartzPoint: point, kind: "double_click", label: "double click")
  postMouse(.leftMouseDown, point: point)
  postMouse(.leftMouseUp, point: point)
  postMouse(.leftMouseDown, point: point)
  postMouse(.leftMouseUp, point: point)
  var event = cursorEvent(kind: "cursor.double_click", coordinateSpace: coordinateSpace, x: x, y: y, label: "double click")
  event["nativeForegroundCursor"] = nativeCursor
  return event
}

func drag(target: [String: Any], fromX: Double, fromY: Double, toX: Double, toY: Double) throws -> [[String: Any]] {
  let coordinateSpace = try requireCursorCoordinateSpace(target: target)
  try requireAccessibility()
  activateTarget(target)
  let start = windowPoint(coordinateSpace: coordinateSpace, x: fromX, y: fromY)
  let end = windowPoint(coordinateSpace: coordinateSpace, x: toX, y: toY)
  let nativeCursor = KWWKForegroundCursorOverlay.shared.drag(fromQuartzPoint: start, toQuartzPoint: end, label: "drag")
  postMouse(.leftMouseDown, point: start)
  postMouse(.leftMouseDragged, point: end)
  postMouse(.leftMouseUp, point: end)
  var begin = cursorEvent(kind: "cursor.drag.begin", coordinateSpace: coordinateSpace, x: fromX, y: fromY, label: "drag")
  begin["nativeForegroundCursor"] = nativeCursor
  var finish = cursorEvent(kind: "cursor.drag.end", coordinateSpace: coordinateSpace, x: toX, y: toY, label: "drag")
  finish["nativeForegroundCursor"] = nativeCursor
  return [begin, finish]
}

func nativeCursorOverlayProbe(params: [String: Any]) -> [String: Any] {
  let bounds = CGDisplayBounds(CGMainDisplayID())
  let kind = text(firstParam(params, "kind")).isEmpty ? "probe" : text(firstParam(params, "kind"))
  let label = text(firstParam(params, "label"))
  if kind.lowercased().contains("drag") {
    let fromX = firstParam(params, "fromX") ?? firstParam(params, "from_x")
    let fromY = firstParam(params, "fromY") ?? firstParam(params, "from_y")
    let toX = firstParam(params, "toX") ?? firstParam(params, "to_x")
    let toY = firstParam(params, "toY") ?? firstParam(params, "to_y")
    let start = CGPoint(
      x: fromX == nil ? bounds.midX - min(160, bounds.width * 0.12) : doubleValue(fromX),
      y: fromY == nil ? bounds.midY : doubleValue(fromY)
    )
    let end = CGPoint(
      x: toX == nil ? bounds.midX + min(160, bounds.width * 0.12) : doubleValue(toX),
      y: toY == nil ? bounds.midY + min(80, bounds.height * 0.08) : doubleValue(toY)
    )
    return [
      "ok": true,
      "source": "oneesama_app_control_helper",
      "nativeForegroundCursor": KWWKForegroundCursorOverlay.shared.drag(
        fromQuartzPoint: start,
        toQuartzPoint: end,
        label: label
      ),
    ]
  }

  let xParam = firstParam(params, "x")
  let yParam = firstParam(params, "y")
  let point = CGPoint(
    x: xParam == nil ? bounds.midX : doubleValue(xParam),
    y: yParam == nil ? bounds.midY : doubleValue(yParam)
  )
  return [
    "ok": true,
    "source": "oneesama_app_control_helper",
    "nativeForegroundCursor": KWWKForegroundCursorOverlay.shared.present(
      quartzPoint: point,
      kind: kind,
      label: label
    ),
  ]
}

func nativeCursorRenderProbe(params: [String: Any]) throws -> [String: Any] {
  let outputDir = text(firstParam(params, "outputDir")).isEmpty
    ? text(firstParam(params, "output_dir"))
    : text(firstParam(params, "outputDir"))
  return [
    "ok": true,
    "source": "oneesama_app_control_helper",
    "nativeCursorRender": try KWWKForegroundCursorOverlay.renderProbe(outputDir: outputDir),
  ]
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

func showClickIndicator(at point: CGPoint, in rootView: NSView) {
  let indicatorDiameter: CGFloat = 12
  let frame = CGRect(
    x: point.x - indicatorDiameter / 2,
    y: point.y - indicatorDiameter / 2,
    width: indicatorDiameter,
    height: indicatorDiameter
  )
  let indicator = AutomationClickIndicatorView(frame: frame)
  indicator.alphaValue = 0.95
  rootView.addSubview(indicator)

  DispatchQueue.main.asyncAfter(deadline: .now() + .seconds(3)) {
    guard indicator.superview != nil else {
      return
    }
    indicator.removeFromSuperview()
  }
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
  let focusedApplication = focusedApplicationPayload()
  if !focusedApplication.isEmpty {
    result["focusedApplication"] = focusedApplication
  }
  if window != nil {
    result["window"] = window
  }
  let accessibility = collectAccessibilityElements(window: window, target: target)
  if !accessibility.isEmpty {
    result["accessibility"] = accessibility
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

func containsAny(_ value: String, _ needles: [String]) -> Bool {
  for needle in needles {
    if value.contains(needle) { return true }
  }
  return false
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

func observationFromParams(_ params: [String: Any]) -> [String: Any] {
  if let observation = params["observation"] as? [String: Any] { return observation }
  if let context = params["context"] as? [String: Any],
     let observation = context["observation"] as? [String: Any] {
    return observation
  }
  return [:]
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

func optionalModelPlanOperations(instruction: String, planner: [String: Any]) -> (operations: [[String: Any]], modelUsed: Bool, latencyMs: Int, blocker: String) {
  let provider = text(planner["provider"]).lowercased()
  let model = text(planner["model"])
  if provider != "local" || model.isEmpty {
    return ([], false, 0, "")
  }
  let started = Date()
  let env = ProcessInfo.processInfo.environment
  let raw = env["ONEESAMA_KWWK_PLANNER_LOCAL_PLAN_JSON"] ?? ""
  if raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
    return ([], false, 0, "")
  }
  guard let data = raw.data(using: .utf8) else {
    return ([], true, max(0, Int(Date().timeIntervalSince(started) * 1000)), "model_plan_invalid_json")
  }
  do {
    let decoded = try JSONSerialization.jsonObject(with: data, options: [])
    let operations: [[String: Any]]
    if let array = decoded as? [[String: Any]] {
      operations = array
    } else if let object = decoded as? [String: Any],
              let objectOperations = object["operations"] as? [[String: Any]] {
      operations = objectOperations
    } else {
      return ([], true, max(0, Int(Date().timeIntervalSince(started) * 1000)), "model_plan_operations_required")
    }
    let latencyMs = max(0, Int(Date().timeIntervalSince(started) * 1000))
    return (operations, true, latencyMs, "")
  } catch {
    return ([], true, max(0, Int(Date().timeIntervalSince(started) * 1000)), "model_plan_invalid_json")
  }
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
    if operation["x"] == nil || operation["y"] == nil { return "click_requires_x_y" }
    return ""
  case "double_click":
    if operation["x"] == nil || operation["y"] == nil { return "double_click_requires_x_y" }
    return ""
  case "type_text":
    return text(operation["text"]).isEmpty ? "type_text_requires_text" : ""
  case "press_key":
    return text(operation["key"]).isEmpty ? "press_key_requires_key" : ""
  case "scroll":
    return validScrollDirection(text(operation["direction"])) ? "" : "scroll_direction_invalid"
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

func planInstruction(params: [String: Any]) -> [String: Any] {
  let target = targetFromParams(params)
  let observation = observationFromParams(params)
  let instruction = text(params["instruction"])
  let started = Date()
  var operations = operationsFromInstruction(instruction, target: target, observation: observation)
  let (_, resolverBlocker) = clickOperationsFromObservation(instruction, observation: observation)
  let needsBackground = appControlInstructionNeedsBackgroundAgent(instruction.lowercased())
  let config = plannerConfig()
  var modelUsed = false
  var modelLatencyMs = 0
  var modelBlocker = ""
  if operations.isEmpty && resolverBlocker.isEmpty && !needsBackground {
    let modelPlan = optionalModelPlanOperations(instruction: instruction, planner: config)
    if modelPlan.modelUsed {
      operations = modelPlan.operations
      modelUsed = true
      modelLatencyMs = modelPlan.latencyMs
      modelBlocker = modelPlan.blocker
    }
  }
  let normalizeMs = max(0, Int(Date().timeIntervalSince(started) * 1000))
  let actionKinds = operations.map { text($0["kind"]) }.filter { !$0.isEmpty }
  let validation = validatePlanOperations(operations, planner: config)
  let valid = validation["ok"] as? Bool == true
  let status = needsBackground ? "needs_background_agent" : operations.isEmpty || !valid || !modelBlocker.isEmpty ? "blocked" : "planned"
  return [
    "ok": !operations.isEmpty && valid && !needsBackground && modelBlocker.isEmpty,
    "status": status,
    "instruction": instruction,
    "operations": needsBackground || !modelBlocker.isEmpty ? [] : valid ? operations : [],
    "planner": [
      "provider": modelUsed ? "deterministic+local_model" : "deterministic",
      "modelUsed": modelUsed,
      "modelName": modelUsed ? text(config["model"]) : "",
      "latencyMs": normalizeMs,
      "normalizeMs": normalizeMs,
      "modelLatencyMs": modelLatencyMs,
      "actionKinds": actionKinds,
      "maxActions": intValue(config["maxActions"]),
      "optionalModel": config,
      "validation": validation["validation"] ?? [:],
    ],
    "blocker": needsBackground
      ? "needs_background_agent"
      : !modelBlocker.isEmpty ? modelBlocker : operations.isEmpty ? (resolverBlocker.isEmpty ? "instruction_not_directly_executable" : resolverBlocker) : text(validation["blocker"]),
  ]
}

func operationsFromParams(_ value: Any?) -> [[String: Any]] {
  guard let operations = value as? [[String: Any]] else { return [] }
  return operations
}

func executeOperation(_ operation: [String: Any], target: [String: Any]) throws -> (action: String, cursorEvents: [[String: Any]]) {
  let kind = text(operation["kind"])
  switch kind {
  case "state":
    _ = try state(params: ["target": target])
    return ("state", [])
  case "click":
    let event = try click(target: target, x: doubleValue(operation["x"]), y: doubleValue(operation["y"]))
    return ("click", [event])
  case "double_click":
    let event = try doubleClick(target: target, x: doubleValue(operation["x"]), y: doubleValue(operation["y"]))
    return ("double_click", [event])
  case "type_text":
    try pasteText(target: target, value: text(operation["text"]))
    return ("type_text", [])
  case "press_key":
    try pressKey(target: target, key: text(operation["key"]))
    return ("press_key", [])
  case "scroll":
    try scroll(target: target, direction: text(operation["direction"]).isEmpty ? "down" : text(operation["direction"]))
    return ("scroll", [])
  case "drag":
    let events = try drag(
      target: target,
      fromX: doubleValue(operation["from_x"]),
      fromY: doubleValue(operation["from_y"]),
      toX: doubleValue(operation["to_x"]),
      toY: doubleValue(operation["to_y"])
    )
    return ("drag", events)
  default:
    throw HelperError.unsupported("unsupported_operation:\(kind)")
  }
}

func actionTelemetryEntry(operation: [String: Any], action: String, durationMs: Int, success: Bool, error: String = "") -> [String: Any] {
  var target: [String: Any] = [:]
  for key in ["targetRole", "targetLabel", "key", "direction"] {
    let value = text(operation[key])
    if !value.isEmpty { target[key] = value }
  }
  for key in ["x", "y", "from_x", "from_y", "to_x", "to_y"] {
    if operation[key] != nil { target[key] = doubleValue(operation[key]) }
  }
  if action == "type_text" {
    target["textLength"] = text(operation["text"]).count
  }
  var entry: [String: Any] = [
    "kind": action,
    "target": target,
    "durationMs": max(0, durationMs),
    "success": success,
    "source": "kwwk",
  ]
  if !error.isEmpty { entry["error"] = error }
  return entry
}

func controlSharedAppWindow(params: [String: Any]) throws -> [String: Any] {
  let callStarted = Date()
  let target = targetFromParams(params)
  let instruction = text(params["instruction"])
  let explicitOperations = operationsFromParams(params["operations"])
  let config = plannerConfig()
  let explicitValidation = explicitOperations.isEmpty
    ? ["ok": true, "validation": ["ok": true]]
    : validatePlanOperations(explicitOperations, planner: config)
  let planStarted = Date()
  var plan = explicitOperations.isEmpty
    ? planInstruction(params: ["instruction": instruction, "target": target, "observation": observationFromParams(params)])
    : [
      "ok": explicitValidation["ok"] as? Bool == true,
      "status": explicitValidation["ok"] as? Bool == true ? "planned" : "blocked",
      "instruction": instruction,
      "operations": explicitValidation["ok"] as? Bool == true ? explicitOperations : [],
      "planner": [
        "provider": "explicit",
        "modelUsed": false,
        "latencyMs": 0,
        "normalizeMs": 0,
        "actionKinds": explicitOperations.map { text($0["kind"]) }.filter { !$0.isEmpty },
        "maxActions": intValue(config["maxActions"]),
        "optionalModel": config,
        "validation": explicitValidation["validation"] ?? [:],
      ],
      "blocker": text(explicitValidation["blocker"]),
    ]
  var planMs = Int(Date().timeIntervalSince(planStarted) * 1000)
  var operations = operationsFromParams(plan["operations"])
  let observeStarted = Date()
  let snapshot: [String: Any]
  do {
    snapshot = try state(params: [
      "target": target,
      "context": contextFromParams(params),
    ])
  } catch {
    let observeMs = Int(Date().timeIntervalSince(observeStarted) * 1000)
    return [
      "ok": false,
      "summary": "Could not inspect the shared app/window.",
      "actions": [],
      "confidence": 0.2,
      "blocker": String(describing: error),
      "operations": operations,
      "metadata": [
        "planner": plan["planner"] ?? [:],
        "timings": appControlTimingSegments(
          totalStarted: callStarted,
          planMs: planMs,
          observeMs: observeMs
        ),
      ],
    ]
  }
  let observeMs = Int(Date().timeIntervalSince(observeStarted) * 1000)
  if explicitOperations.isEmpty && operations.isEmpty {
    let observedPlanStarted = Date()
    let observedPlan = planInstruction(params: ["instruction": instruction, "target": target, "observation": snapshot])
    let observedOperations = operationsFromParams(observedPlan["operations"])
    planMs += Int(Date().timeIntervalSince(observedPlanStarted) * 1000)
    if !observedOperations.isEmpty {
      var planner = observedPlan["planner"] as? [String: Any] ?? [:]
      planner["observedReplan"] = true
      planner["initialPlanner"] = plan["planner"] ?? [:]
      var mergedPlan = observedPlan
      mergedPlan["planner"] = planner
      plan = mergedPlan
      operations = observedOperations
    }
  }
  if operations.isEmpty {
    return [
      "ok": false,
      "summary": "Captured shared app state; the instruction is not directly executable by the KWWK direct helper.",
      "actions": ["state"],
      "confidence": 0.4,
      "blocker": "instruction_not_directly_executable",
      "operations": [],
      "metadata": [
        "state": snapshot,
        "planner": plan["planner"] ?? [:],
        "timings": appControlTimingSegments(
          totalStarted: callStarted,
          planMs: planMs,
          observeMs: observeMs
        ),
      ],
    ]
  }
  if operations.count == 1 && text(operations[0]["kind"]) == "state" {
    return [
      "ok": true,
      "summary": "Captured shared app state.",
      "actions": ["observe"],
      "confidence": 0.7,
      "operations": operations,
      "metadata": [
        "state": snapshot,
        "planner": plan["planner"] ?? [:],
        "timings": appControlTimingSegments(
          totalStarted: callStarted,
          planMs: planMs,
          observeMs: observeMs
        ),
      ],
    ]
  }
  let nonStateOperations = operations.filter { text($0["kind"]) != "state" }
  if nonStateOperations.isEmpty {
    return [
      "ok": true,
      "summary": "Captured shared app state.",
      "actions": ["state"],
      "confidence": 0.6,
      "operations": operations,
      "metadata": [
        "state": snapshot,
        "planner": plan["planner"] ?? [:],
        "timings": appControlTimingSegments(
          totalStarted: callStarted,
          planMs: planMs,
          observeMs: observeMs
        ),
      ],
    ]
  }
  var actions: [String] = []
  var cursorEvents: [[String: Any]] = []
  var actionTelemetry: [[String: Any]] = []
  let executeStarted = Date()
  for operation in operations {
    let operationStarted = Date()
    do {
      let executed = try executeOperation(operation, target: target)
      let durationMs = Int(Date().timeIntervalSince(operationStarted) * 1000)
      actions.append(executed.action)
      cursorEvents.append(contentsOf: executed.cursorEvents)
      actionTelemetry.append(actionTelemetryEntry(
        operation: operation,
        action: executed.action,
        durationMs: durationMs,
        success: true
      ))
    } catch {
      let failedAction = text(operation["kind"]).isEmpty ? "unknown" : text(operation["kind"])
      let durationMs = Int(Date().timeIntervalSince(operationStarted) * 1000)
      actionTelemetry.append(actionTelemetryEntry(
        operation: operation,
        action: failedAction,
        durationMs: durationMs,
        success: false,
        error: String(describing: error)
      ))
      return [
        "ok": false,
        "summary": "Stopped after \(actions.count) app-control operation(s).",
        "actions": actions,
        "confidence": 0.3,
        "blocker": String(describing: error),
        "operations": operations,
        "metadata": [
          "state": snapshot,
          "planner": plan["planner"] ?? [:],
          "cursor": [
            "schema": "oneesama.kwwk-cursor-events.v1",
            "events": cursorEvents,
          ],
          "actionTelemetry": actionTelemetry,
          "timings": appControlTimingSegments(
            totalStarted: callStarted,
            planMs: planMs,
            observeMs: observeMs,
            executeMs: Int(Date().timeIntervalSince(executeStarted) * 1000)
          ),
        ],
      ]
    }
  }
  let executeMs = Int(Date().timeIntervalSince(executeStarted) * 1000)
  return [
    "ok": true,
    "summary": "Executed \(actions.count) app-control operation(s).",
    "actions": actions,
    "confidence": 0.8,
    "operations": operations,
    "metadata": [
      "state": snapshot,
      "planner": plan["planner"] ?? [:],
      "cursor": [
        "schema": "oneesama.kwwk-cursor-events.v1",
        "events": cursorEvents,
      ],
      "actionTelemetry": actionTelemetry,
      "timings": appControlTimingSegments(
        totalStarted: callStarted,
        planMs: planMs,
        observeMs: observeMs,
        executeMs: executeMs
      ),
    ],
  ]
}

func appControlTimingSegments(totalStarted: Date, planMs: Int, observeMs: Int, executeMs: Int = 0, verifyMs: Int = 0) -> [String: Any] {
  return [
    "schema": "oneesama.kwwk-app-control-timings.v1",
    "normalizeMs": max(0, planMs),
    "observeMs": max(0, observeMs),
    "planMs": max(0, planMs),
    "executeMs": max(0, executeMs),
    "verifyMs": max(0, verifyMs),
    "totalMs": max(0, Int(Date().timeIntervalSince(totalStarted) * 1000)),
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
    let event = try click(target: targetFromParams(params), x: doubleValue(params["x"]), y: doubleValue(params["y"]))
    return ["ok": true, "actions": ["click"], "metadata": ["cursor": ["schema": "oneesama.kwwk-cursor-events.v1", "events": [event]]]]
  case "double_click":
    let event = try doubleClick(target: targetFromParams(params), x: doubleValue(params["x"]), y: doubleValue(params["y"]))
    return ["ok": true, "actions": ["double_click"], "metadata": ["cursor": ["schema": "oneesama.kwwk-cursor-events.v1", "events": [event]]]]
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
    let events = try drag(
      target: targetFromParams(params),
      fromX: doubleValue(params["from_x"]),
      fromY: doubleValue(params["from_y"]),
      toX: doubleValue(params["to_x"]),
      toY: doubleValue(params["to_y"])
    )
    return ["ok": true, "actions": ["drag"], "metadata": ["cursor": ["schema": "oneesama.kwwk-cursor-events.v1", "events": events]]]
  case "app_control.native_cursor_overlay_probe":
    return nativeCursorOverlayProbe(params: params)
  case "app_control.native_cursor_render_probe":
    return try nativeCursorRenderProbe(params: params)
  case "app_control.control_shared_app_window":
    return try resultWithTraceArtifact(
      controlSharedAppWindow(params: params),
      params: params,
      method: method
    )
  case "app_control.plan_instruction":
    return try resultWithTraceArtifact(
      planInstruction(params: params),
      params: params,
      method: method
    )
  case "app_control.validate_plan":
    return validatePlanOperations(operationsFromParams(params["operations"]), planner: plannerConfig())
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
