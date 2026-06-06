// swift-tools-version: 6.1

import PackageDescription

let package = Package(
  name: "OneesamaAppControlHelper",
  platforms: [
    .macOS(.v14),
  ],
  products: [
    .executable(
      name: "OneesamaAppControlHelper",
      targets: ["OneesamaAppControlHelper"]
    ),
  ],
  dependencies: [
    .package(url: "https://github.com/EYHN/kwwk-computer-use-core.git", branch: "main"),
  ],
  targets: [
    .executableTarget(
      name: "OneesamaAppControlHelper",
      dependencies: [
        .product(name: "KWWKComputerUseCore", package: "kwwk-computer-use-core"),
      ],
      path: ".",
      sources: [
        "kwwk-cu-runtime.swift",
        "kwwk-cu-router.swift",
        "kwwk-cu-protocol.swift",
        "kwwk-cu-planner.swift",
        "kwwk-cu-core.swift",
        "kwwk-cu-executor.swift",
        "kwwk-cu-observation.swift",
        "kwwk-cu-cursor.swift",
        "kwwk-cu-verification.swift",
        "app-control-helper.swift",
      ],
      swiftSettings: [
        .swiftLanguageMode(.v5),
      ],
      linkerSettings: [
        .linkedFramework("AppKit"),
        .linkedFramework("ApplicationServices"),
        .linkedFramework("CoreGraphics"),
        .linkedFramework("CoreServices"),
        .linkedFramework("Metal"),
        .linkedFramework("QuartzCore"),
        .linkedFramework("ScreenCaptureKit"),
      ]
    ),
  ]
)
