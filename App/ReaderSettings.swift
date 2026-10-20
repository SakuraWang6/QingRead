import Foundation
import SwiftUI
import UIKit
import ReadingCore

enum ReadingTheme: String, Codable, CaseIterable, Identifiable {
    case paper, dusk, mint, gray, rose, night
    var id: String { rawValue }
    static var daytimeCases: [Self] { allCases.filter { $0 != .night } }
    var name: String {
        switch self {
        case .paper: return "纸白"
        case .dusk: return "暖杏"
        case .mint: return "豆绿"
        case .gray: return "雾灰"
        case .rose: return "淡粉"
        case .night: return "夜间"
        }
    }
    var background: Color {
        switch self {
        case .paper: return Color(red: 0.97, green: 0.96, blue: 0.93)
        case .dusk: return Color(red: 0.91, green: 0.85, blue: 0.74)
        case .mint: return Color(red: 0.82, green: 0.88, blue: 0.81)
        case .gray: return Color(red: 0.86, green: 0.88, blue: 0.88)
        case .rose: return Color(red: 0.94, green: 0.87, blue: 0.86)
        case .night: return Color(red: 0.09, green: 0.10, blue: 0.11)
        }
    }
    var foreground: Color {
        self == .night ? Color(red: 0.66, green: 0.66, blue: 0.65) : Color(red: 0.23, green: 0.22, blue: 0.20)
    }
}

enum ReaderTurnMode: String, Codable, CaseIterable, Identifiable {
    case slide, cover, scroll
    var id: String { rawValue }
    var name: String {
        switch self { case .slide: return "左右滑动"; case .cover: return "覆盖翻页"; case .scroll: return "上下滚动" }
    }
}

enum ReaderFont: String, Codable, CaseIterable, Identifiable {
    case song, system, rounded
    var id: String { rawValue }
    var name: String {
        switch self { case .song: return "宋体"; case .system: return "黑体"; case .rounded: return "圆体" }
    }
    func uiFont(size: CGFloat, bold: Bool = false) -> UIFont {
        switch self {
        case .song: return UIFont(name: bold ? "SongtiSC-Bold" : "SongtiSC-Regular", size: size) ?? .systemFont(ofSize: size, weight: bold ? .semibold : .regular)
        case .system: return .systemFont(ofSize: size, weight: bold ? .semibold : .regular)
        case .rounded:
            let font = UIFont.systemFont(ofSize: size, weight: bold ? .semibold : .regular)
            return font.fontDescriptor.withDesign(.rounded).map { UIFont(descriptor: $0, size: size) } ?? font
        }
    }
}

enum SpeechEngine: String, Codable, CaseIterable, Identifiable {
    case system, melo, kokoro
    var id: String { rawValue }
    var name: String { switch self { case .system: return "系统语音"; case .melo: return "Melo"; case .kokoro: return "Kokoro" } }
}

struct ReaderSettings: Codable, Equatable {
    var fontSize: Double = 21
    var lineSpacing: Double = 9
    var paragraphSpacing: Double = 6
    var theme: ReadingTheme = .paper
    var isNightMode = false
    var turnMode: ReaderTurnMode = .slide
    var font: ReaderFont = .song
    var isBold = false
    var horizontalMargin: Double = 24
    var followsSystemBrightness = true
    var brightness: Double = 0.55
    var speechRate: Double = 1
    /// Empty means the best available on-device Chinese voice.
    var speechVoiceIdentifier: String = ""
    var speechEngine: SpeechEngine = .system
    var kokoroVoiceID: Int = 46

    var activeTheme: ReadingTheme { isNightMode ? .night : theme }
    init() {}

    private enum CodingKeys: String, CodingKey {
        case fontSize, lineSpacing, paragraphSpacing, theme, isNightMode, turnMode, font, isBold
        case horizontalMargin, followsSystemBrightness, brightness, speechRate, speechVoiceIdentifier, speechEngine, kokoroVoiceID
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let oldTheme = (try? values.decode(ReadingTheme.self, forKey: .theme)) ?? .paper
        theme = oldTheme == .night ? .paper : oldTheme
        isNightMode = (try? values.decode(Bool.self, forKey: .isNightMode)) ?? (oldTheme == .night)
        fontSize = Self.bounded((try? values.decode(Double.self, forKey: .fontSize)) ?? 21, in: 16...34, fallback: 21)
        lineSpacing = Self.bounded((try? values.decode(Double.self, forKey: .lineSpacing)) ?? 9, in: 4...22, fallback: 9)
        paragraphSpacing = Self.bounded((try? values.decode(Double.self, forKey: .paragraphSpacing)) ?? 6, in: 0...28, fallback: 6)
        turnMode = (try? values.decode(ReaderTurnMode.self, forKey: .turnMode)) ?? .slide
        font = (try? values.decode(ReaderFont.self, forKey: .font)) ?? .song
        isBold = (try? values.decode(Bool.self, forKey: .isBold)) ?? false
        horizontalMargin = Self.bounded((try? values.decode(Double.self, forKey: .horizontalMargin)) ?? 24, in: 16...40, fallback: 24)
        followsSystemBrightness = (try? values.decode(Bool.self, forKey: .followsSystemBrightness)) ?? true
        brightness = Self.bounded((try? values.decode(Double.self, forKey: .brightness)) ?? 0.55, in: 0.05...1, fallback: 0.55)
        speechRate = Self.bounded((try? values.decode(Double.self, forKey: .speechRate)) ?? 1, in: 0.6...1.8, fallback: 1)
        speechVoiceIdentifier = (try? values.decode(String.self, forKey: .speechVoiceIdentifier)) ?? ""
        speechEngine = (try? values.decode(SpeechEngine.self, forKey: .speechEngine)) ?? .system
        let voice = (try? values.decode(Int.self, forKey: .kokoroVoiceID)) ?? 46
        kokoroVoiceID = (3...102).contains(voice) ? voice : 46
    }

    private static func bounded(_ value: Double, in range: ClosedRange<Double>, fallback: Double) -> Double {
        value.isFinite ? min(range.upperBound, max(range.lowerBound, value)) : fallback
    }
}

/// The same UTF-16 document backs pagination, scroll position and speech seeking.
struct ReaderDocument {
    let content: ReadingCore.ChapterContent
    let text: NSAttributedString
    let paragraphRanges: [NSRange]

    init(content: ReadingCore.ChapterContent, settings: ReaderSettings) {
        self.content = content
        let color = UIColor(settings.activeTheme.foreground)
        let titleStyle = NSMutableParagraphStyle()
        titleStyle.paragraphSpacing = 26
        titleStyle.lineSpacing = 5
        let bodyStyle = NSMutableParagraphStyle()
        bodyStyle.lineSpacing = settings.lineSpacing
        bodyStyle.paragraphSpacing = settings.paragraphSpacing
        bodyStyle.firstLineHeadIndent = settings.fontSize * 2
        bodyStyle.lineBreakMode = .byWordWrapping
        let result = NSMutableAttributedString(string: content.chapter.title + "\n", attributes: [
            .font: settings.font.uiFont(size: settings.fontSize + 6, bold: true),
            .foregroundColor: color, .paragraphStyle: titleStyle
        ])
        var ranges: [NSRange] = []
        for (index, paragraph) in content.paragraphs.enumerated() {
            ranges.append(NSRange(location: result.length, length: (paragraph as NSString).length))
            result.append(NSAttributedString(string: paragraph + (index < content.paragraphs.count - 1 ? "\n" : ""), attributes: [
                .font: settings.font.uiFont(size: settings.fontSize, bold: settings.isBold),
                .foregroundColor: color, .paragraphStyle: bodyStyle
            ]))
        }
        text = result
        paragraphRanges = ranges
    }

    func paragraph(atUTF16 offset: Int) -> Int {
        paragraphRanges.lastIndex { $0.location <= offset } ?? 0
    }
}
