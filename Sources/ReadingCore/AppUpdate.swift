import Foundation

public enum AppUpdateError: LocalizedError, Equatable {
    case missingServer, invalidServer, invalidVersion, invalidManifest, unsupportedSchema, responseTooLarge, unavailable

    public var errorDescription: String? {
        switch self {
        case .missingServer: return "请先在「账号与同步」设置服务器。"
        case .invalidServer: return "请在「账号与同步」设置有效的 HTTPS 服务器。"
        case .invalidVersion: return "无法识别版本信息，请稍后重试。"
        case .invalidManifest: return "更新信息格式无效，请稍后重试。"
        case .unsupportedSchema: return "当前版本无法读取这份更新信息。"
        case .responseTooLarge: return "更新信息过大，已停止检查。"
        case .unavailable: return "暂时无法获取更新信息，请稍后重试。"
        }
    }
}

/// Stable numeric semantic versions. A remote label is never interpreted as an
/// executable URL or compared lexicographically (for example, 0.9 versus 0.11).
public struct AppReleaseVersion: Comparable, Equatable, Sendable {
    public let value: String
    private let components: [UInt64]

    public init(_ value: String) throws {
        let parts = value.split(separator: ".", omittingEmptySubsequences: false)
        guard value.utf8.count <= 64, parts.count == 3,
              parts.allSatisfy({ !$0.isEmpty && ($0.count == 1 || $0.first != "0") && $0.utf8.allSatisfy { (48...57).contains($0) } }),
              parts.allSatisfy({ UInt64($0) != nil }) else { throw AppUpdateError.invalidVersion }
        self.value = value
        components = parts.map { UInt64($0)! }
    }

    public static func < (lhs: Self, rhs: Self) -> Bool { lhs.components.lexicographicallyPrecedes(rhs.components) }
    public static func == (lhs: Self, rhs: Self) -> Bool { lhs.components == rhs.components }
}

public enum AppUpdateComparison: Equatable, Sendable { case available, current, installedNewer }

public struct IOSAppRelease: Equatable, Sendable {
    public let version: String
    public let build: String
    public let notes: [String]
    public let publishedAt: Date

    public func compare(installedVersion: String, installedBuild: String) throws -> AppUpdateComparison {
        let remote = try AppReleaseVersion(version), local = try AppReleaseVersion(installedVersion)
        if remote > local { return .available }
        if remote < local { return .installedNewer }
        let remoteBuild = try Self.buildComponents(build), localBuild = try Self.buildComponents(installedBuild)
        if remoteBuild.lexicographicallyPrecedes(localBuild) { return .installedNewer }
        if localBuild.lexicographicallyPrecedes(remoteBuild) { return .available }
        return .current
    }

    private static func buildComponents(_ value: String) throws -> [UInt64] {
        let parts = value.split(separator: ".", omittingEmptySubsequences: false)
        guard value.utf8.count <= 32, (1...3).contains(parts.count),
              parts.allSatisfy({ !$0.isEmpty && $0.utf8.allSatisfy { (48...57).contains($0) } && UInt64($0) != nil }) else { throw AppUpdateError.invalidVersion }
        return parts.map { UInt64($0)! } + Array(repeating: 0, count: 3 - parts.count)
    }

    /// Only the iOS entry is decoded. Other clients' artifacts are irrelevant to
    /// native self-signed updates and never become install actions in this app.
    public static func parse(_ data: Data) throws -> Self {
        guard data.count <= 64 * 1024 else { throw AppUpdateError.responseTooLarge }
        let manifest: Manifest
        do { manifest = try JSONDecoder().decode(Manifest.self, from: data) }
        catch { throw AppUpdateError.invalidManifest }
        guard manifest.schemaVersion == 1 else { throw AppUpdateError.unsupportedSchema }
        let ios = manifest.platforms.ios
        _ = try AppReleaseVersion(ios.version)
        _ = try buildComponents(ios.build)
        guard manifest.publishedAt.utf8.count <= 64,
              let publishedAt = isoDate(manifest.publishedAt),
              ios.notes.count <= 20, ios.notes.allSatisfy({ !$0.isEmpty && $0.utf16.count <= 500 && !$0.contains("\0") }) else { throw AppUpdateError.invalidManifest }
        return Self(version: ios.version, build: ios.build, notes: ios.notes, publishedAt: publishedAt)
    }

    private static func isoDate(_ value: String) -> Date? {
        let format = ISO8601DateFormatter()
        if let date = format.date(from: value) { return date }
        format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return format.date(from: value)
    }

    private struct Manifest: Decodable {
        let schemaVersion: Int
        let publishedAt: String
        let platforms: Platforms
        struct Platforms: Decodable { let ios: Release }
        struct Release: Decodable { let version: String; let build: String; let notes: [String] }
    }
}

public enum AppUpdateEndpoint {
    public static func url(serverAddress: String, manifestPath: String = "/qingread/releases.json") throws -> URL {
        let address = serverAddress.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !address.isEmpty else { throw AppUpdateError.missingServer }
        guard var parts = URLComponents(string: address), parts.scheme?.lowercased() == "https",
              let host = parts.host, !host.isEmpty, parts.user == nil, parts.password == nil,
              manifestPath.hasPrefix("/"), !manifestPath.hasPrefix("//"),
              !manifestPath.contains("?"), !manifestPath.contains("#"), !manifestPath.contains("\\"), !manifestPath.contains("..") else { throw AppUpdateError.invalidServer }
        parts.scheme = "https"
        parts.path = manifestPath
        parts.query = nil
        parts.fragment = nil
        guard let url = parts.url else { throw AppUpdateError.invalidServer }
        return url
    }
}

/// A fixed allowlist keeps account, server, device identifiers and book data out
/// of the text offered to the clipboard and the public issue form.
public struct AppFeedbackInformation: Equatable, Sendable {
    public let version: String
    public let build: String
    public let systemVersion: String
    public let deviceCategory: String

    public init(version: String, build: String, systemVersion: String, deviceCategory: String) {
        self.version = version; self.build = build; self.systemVersion = systemVersion; self.deviceCategory = deviceCategory
    }

    public var text: String { "清读版本：\(version)\n构建版本：\(build)\niOS 版本：\(systemVersion)\n设备类别：\(deviceCategory)" }
}
