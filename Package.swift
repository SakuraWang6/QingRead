// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "QingRead",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [
        .library(name: "ReadingCore", targets: ["ReadingCore"]),
        .executable(name: "reading-probe", targets: ["ReadingProbe"])
    ],
    dependencies: [
        .package(url: "https://github.com/scinfu/SwiftSoup.git", from: "2.7.0")
    ],
    targets: [
        .target(name: "ReadingCore", dependencies: [.product(name: "SwiftSoup", package: "SwiftSoup")]),
        .executableTarget(name: "ReadingProbe", dependencies: ["ReadingCore"]),
        .testTarget(name: "ReadingCoreTests", dependencies: ["ReadingCore"])
    ],
    swiftLanguageModes: [.v5]
)
