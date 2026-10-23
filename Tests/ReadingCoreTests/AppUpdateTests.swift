import XCTest
@testable import ReadingCore

final class AppUpdateTests: XCTestCase {
    private func manifest(version: String = "0.11.0", build: String = "15", date: String = "2026-10-23T12:00:00.123Z", schema: Int = 1, notes: [String] = ["新增关于清读"]) throws -> Data {
        try JSONSerialization.data(withJSONObject: ["schemaVersion": schema, "publishedAt": date, "platforms": ["ios": ["version": version, "build": build, "notes": notes], "android": "ignored native artifact data", "web": NSNull()]])
    }

    func testReadsOnlyIOSAndComparesSemanticVersionsAndBuildsNumerically() throws {
        let release = try IOSAppRelease.parse(manifest())
        XCTAssertEqual(release.version, "0.11.0")
        XCTAssertEqual(release.notes, ["新增关于清读"])
        XCTAssertEqual(try release.compare(installedVersion: "0.9.9", installedBuild: "99"), .available)
        XCTAssertEqual(try release.compare(installedVersion: "0.11.0", installedBuild: "14"), .available)
        XCTAssertEqual(try release.compare(installedVersion: "0.11.0", installedBuild: "15.0"), .current)
        XCTAssertEqual(try release.compare(installedVersion: "0.11.0", installedBuild: "16"), .installedNewer)
        XCTAssertEqual(try release.compare(installedVersion: "0.12.0", installedBuild: "1"), .installedNewer)
    }

    func testMalformedOrIncompatibleResponsesCannotClaimCurrentVersion() throws {
        XCTAssertThrowsError(try IOSAppRelease.parse(Data("not json".utf8)))
        XCTAssertThrowsError(try IOSAppRelease.parse(Data(repeating: 32, count: 65 * 1024))) { XCTAssertEqual($0 as? AppUpdateError, .responseTooLarge) }
        XCTAssertThrowsError(try IOSAppRelease.parse(manifest(schema: 2))) { XCTAssertEqual($0 as? AppUpdateError, .unsupportedSchema) }
        for version in ["0.11", "0.11.0-beta", "0.011.0", "0.11.-1", "0.11.99999999999999999999999999", "０.１１.０"] {
            XCTAssertThrowsError(try IOSAppRelease.parse(manifest(version: version)))
        }
        XCTAssertThrowsError(try IOSAppRelease.parse(manifest(build: "15beta")))
        XCTAssertThrowsError(try IOSAppRelease.parse(manifest(date: "yesterday")))
        XCTAssertThrowsError(try IOSAppRelease.parse(manifest(notes: [String(repeating: "甲", count: 501)])))
        XCTAssertThrowsError(try IOSAppRelease.parse(manifest()).compare(installedVersion: "unknown", installedBuild: "15"))
    }

    func testEndpointKeepsOnlyConfiguredHTTPSOriginWithoutCredentialsOrQueries() throws {
        XCTAssertEqual(try AppUpdateEndpoint.url(serverAddress: " https://reader.example:8443/custom/api?token=private#old ").absoluteString, "https://reader.example:8443/qingread/releases.json")
        for address in ["", "http://reader.example", "https://user:password@reader.example", "reader.example", "file:///tmp/releases.json"] {
            XCTAssertThrowsError(try AppUpdateEndpoint.url(serverAddress: address))
        }
        for path in ["//other.example/releases.json", "https://other.example", "/../private", "/releases.json?token=private", "/releases.json#old"] {
            XCTAssertThrowsError(try AppUpdateEndpoint.url(serverAddress: "https://reader.example", manifestPath: path))
        }
    }

    func testFeedbackContainsOnlyExplicitNonIdentifyingFields() {
        let information = AppFeedbackInformation(version: "0.11.0", build: "15", systemVersion: "18.0", deviceCategory: "iPhone")
        XCTAssertEqual(information.text, "清读版本：0.11.0\n构建版本：15\niOS 版本：18.0\n设备类别：iPhone")
        XCTAssertEqual(information.text.components(separatedBy: "\n").count, 4)
    }
}
