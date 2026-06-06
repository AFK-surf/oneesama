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
    milliseconds(from: "ONEESAMA_KWWK_CURSOR_BOOTSTRAP_MS", fallback: 6)
  }

  static var preActionHold: TimeInterval {
    milliseconds(from: "ONEESAMA_KWWK_CURSOR_PRE_MS", fallback: 12)
  }

  static var postApproachDwell: TimeInterval {
    milliseconds(from: "ONEESAMA_KWWK_CURSOR_DWELL_MS", fallback: 70)
  }

  static var finalHold: TimeInterval {
    milliseconds(from: "ONEESAMA_KWWK_CURSOR_HOLD_MS", fallback: 28)
  }

  static var approachDuration: TimeInterval {
    milliseconds(from: "ONEESAMA_KWWK_CURSOR_APPROACH_MS", fallback: 180)
  }

  static var approachStep: TimeInterval {
    milliseconds(from: "ONEESAMA_KWWK_CURSOR_APPROACH_STEP_MS", fallback: 12)
  }

  static var dragDuration: TimeInterval {
    milliseconds(from: "ONEESAMA_KWWK_CURSOR_DRAG_MS", fallback: 130)
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

  static func assetPrewarmPayload() -> [String: Any] {
    let plan = KWWKActionOverlayBezierPlanner.default.buildPlan(
      startPoint: CGPoint(x: 0, y: 0),
      startHeading: 0,
      endPoint: CGPoint(x: 96, y: 36),
      endHeading: 0
    )
    return [
      "ok": true,
      "status": "ready",
      "nativeCursorPrewarm": [
        "schema": "oneesama.kwwk-native-cursor-prewarm.v1",
        "source": "cueboard_bridge_computer_use_port",
        "preloaded": true,
        "assetKind": "vector_drawn_cueboard_cursor",
        "foregroundSessionStarted": false,
        "materializedBeforeAction": KWWKForegroundCursorOverlay.shared.materialized,
        "panelSize": [
          "width": Double(KWWKForegroundCursorGeometry.panelSize.width),
          "height": Double(KWWKForegroundCursorGeometry.panelSize.height),
        ],
        "renderSize": Double(KWWKForegroundCursorGeometry.renderSize),
        "hotspot": [
          "x": Double(KWWKForegroundCursorGeometry.hotspot.x),
          "y": Double(KWWKForegroundCursorGeometry.hotspot.y),
        ],
        "timing": [
          "bootstrapMs": Int(KWWKForegroundCursorTiming.bootstrapHold * 1000),
          "approachMs": Int(KWWKForegroundCursorTiming.approachDuration * 1000),
          "dragMs": Int(KWWKForegroundCursorTiming.dragDuration * 1000),
          "finalHoldMs": Int(KWWKForegroundCursorTiming.finalHold * 1000),
        ],
        "bezier": Self.bezierPayload(plan),
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

func nativeCursorPrewarmPayload() -> [String: Any] {
  KWWKForegroundCursorOverlay.assetPrewarmPayload()
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
