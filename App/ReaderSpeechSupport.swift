import Foundation

/// Names and identifiers always come from AVSpeechSynthesisVoice.speechVoices().
struct ReaderSpeechVoice: Identifiable, Equatable, Sendable {
    enum Quality: Int, Sendable { case standard = 1, enhanced = 2, premium = 3 }
    let id: String
    let name: String
    let language: String
    let quality: Quality

    var qualityLabel: String {
        switch quality { case .standard: return "标准"; case .enhanced: return "增强"; case .premium: return "高品质" }
    }

    static func isChinese(_ language: String) -> Bool {
        let code = language.lowercased()
        return code == "zh" || code.hasPrefix("zh-") || code == "yue" || code.hasPrefix("yue-")
    }

    /// Prefer Mandarin, then quality, with mainland Mandarin breaking equal ties.
    static func sorted(_ voices: [Self]) -> [Self] {
        voices.filter { isChinese($0.language) }.sorted {
            if $0.isMandarin != $1.isMandarin { return $0.isMandarin }
            if $0.quality != $1.quality { return $0.quality.rawValue > $1.quality.rawValue }
            if $0.isMainland != $1.isMainland { return $0.isMainland }
            if $0.name != $1.name { return $0.name.localizedStandardCompare($1.name) == .orderedAscending }
            return $0.id < $1.id
        }
    }

    private var isMandarin: Bool {
        let code = language.lowercased()
        return code.hasPrefix("zh") && !code.hasPrefix("zh-hk") && !code.hasPrefix("zh-mo")
    }
    private var isMainland: Bool { language.lowercased().hasPrefix("zh-cn") || language.lowercased().hasPrefix("zh-hans") }
}

/// AVSpeech's callback ranges refer to the currently submitted utterance, in
/// UTF-16. Keep that base separate from the paragraph offset when replacing it.
struct ReaderSpeechCursor: Equatable {
    let text: String
    private(set) var utf16Offset: Int
    private(set) var utteranceStart: Int

    init(text: String, utf16Offset: Int = 0) {
        self.text = text
        let offset = Self.safeOffset(utf16Offset, in: text)
        self.utf16Offset = offset
        utteranceStart = offset
    }

    mutating func beginUtterance() -> String {
        utteranceStart = utf16Offset
        return (text as NSString).substring(from: utf16Offset)
    }

    @discardableResult mutating func willSpeak(_ range: NSRange) -> Bool {
        let count = (text as NSString).length - utteranceStart
        guard range.location != NSNotFound, range.location >= 0, range.length >= 0,
              range.location < count, range.length <= count - range.location else { return false }
        let offset = Self.safeOffset(utteranceStart + range.location, in: text)
        guard offset >= utf16Offset else { return false }
        utf16Offset = offset
        return true
    }

    private static func safeOffset(_ offset: Int, in text: String) -> Int {
        let value = text as NSString
        let bounded = min(value.length, max(0, offset))
        return bounded < value.length ? value.rangeOfComposedCharacterSequence(at: bounded).location : bounded
    }
}

struct ReaderSpeechChunk: Equatable, Sendable {
    let text: String
    let range: NSRange

    static func split(_ text: String, fromUTF16 offset: Int, limit: Int = 48) -> [Self] {
        let source = text as NSString
        let start = ReaderSpeechCursor(text: text, utf16Offset: offset).utf16Offset
        let remainder = source.substring(from: start)
        var chunks: [Self] = []
        var chunkStart = start
        var end = start
        var count = 0
        func appendChunk() {
            let range = NSRange(location: chunkStart, length: end - chunkStart)
            let value = source.substring(with: range)
            if value.unicodeScalars.contains(where: { CharacterSet.alphanumerics.contains($0) }) {
                chunks.append(Self(text: value, range: range))
            }
            chunkStart = end
            count = 0
        }
        for character in remainder {
            end += String(character).utf16.count
            count += 1
            let sentenceEnd = "。！？!?；;\n".contains(character)
            let clauseEnd = count >= 20 && "，,：:".contains(character)
            if sentenceEnd || clauseEnd || count >= max(1, limit) { appendChunk() }
        }
        if end > chunkStart { appendChunk() }
        return chunks
    }
}

enum ReaderSpeechPCM {
    enum InvalidAudio: Error { case invalid }

    static func wav(samples: [Float], sampleRate: Int) throws -> Data {
        guard !samples.isEmpty, (8_000...96_000).contains(sampleRate),
              samples.count < (Int(UInt32.max) - 36) / 2 else { throw InvalidAudio.invalid }
        let byteCount = UInt32(samples.count * 2)
        var result = Data(capacity: 44 + Int(byteCount))
        func append<T: FixedWidthInteger>(_ value: T) {
            var littleEndian = value.littleEndian
            withUnsafeBytes(of: &littleEndian) { result.append(contentsOf: $0) }
        }
        result.append(contentsOf: "RIFF".utf8)
        append(UInt32(36) + byteCount)
        result.append(contentsOf: "WAVEfmt ".utf8)
        append(UInt32(16)); append(UInt16(1)); append(UInt16(1))
        append(UInt32(sampleRate)); append(UInt32(sampleRate * 2))
        append(UInt16(2)); append(UInt16(16))
        result.append(contentsOf: "data".utf8)
        append(byteCount)
        for sample in samples {
            let bounded = sample.isFinite ? min(1, max(-1, sample)) : 0
            append(Int16(bounded * 32767))
        }
        return result
    }
}
