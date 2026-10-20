// Offline: swiftc App/ReaderSpeechSupport.swift scripts/test-reader-speech.swift -o /tmp/qingread-speech-tests
// Runs only pure UTF-16 cursor / voice ordering checks. No audio, network or device.
import Foundation

@main enum ReaderSpeechTests {
    static func main() {
        let text = "开头👩🏽‍🚀，当前词，后面的句子。𠮷与e\u{301}完整。"
        var cursor = ReaderSpeechCursor(text: text)
        assert(cursor.beginUtterance() == text)
        let current = (text as NSString).range(of: "当前词")
        assert(cursor.willSpeak(current))
        let remaining = cursor.beginUtterance()
        assert(remaining.hasPrefix("当前词") && !remaining.hasPrefix("开头"))
        let next = (remaining as NSString).range(of: "后面的句子")
        assert(cursor.willSpeak(next))
        assert(cursor.utf16Offset == (text as NSString).range(of: "后面的句子").location)
        assert(cursor.beginUtterance().hasPrefix("后面的句子"))
        let unchanged = cursor
        assert(!cursor.willSpeak(NSRange(location: NSNotFound, length: 1)))
        assert(!cursor.willSpeak(NSRange(location: Int.max, length: Int.max)))
        assert(cursor == unchanged)

        let emoji = (text as NSString).range(of: "👩🏽‍🚀")
        let insideEmoji = ReaderSpeechCursor(text: text, utf16Offset: emoji.location + 3)
        assert(insideEmoji.utf16Offset == emoji.location)
        let combining = (text as NSString).range(of: "e\u{301}")
        assert(ReaderSpeechCursor(text: text, utf16Offset: combining.location + 1).utf16Offset == combining.location)
        assert(ReaderSpeechCursor(text: text, utf16Offset: -10).utf16Offset == 0)
        var beyondEnd = ReaderSpeechCursor(text: text, utf16Offset: Int.max)
        assert(beyondEnd.beginUtterance().isEmpty)
        var empty = ReaderSpeechCursor(text: "")
        assert(empty.beginUtterance().isEmpty && !empty.willSpeak(NSRange(location: 0, length: 0)))

        let voices = [
            ReaderSpeechVoice(id: "mandarin-standard", name: "普通话", language: "zh-CN", quality: .standard),
            ReaderSpeechVoice(id: "cantonese-premium", name: "粤语", language: "zh-HK", quality: .premium),
            ReaderSpeechVoice(id: "mandarin-enhanced", name: "普通话增强", language: "zh-CN", quality: .enhanced),
            ReaderSpeechVoice(id: "mandarin-premium", name: "普通话高品质", language: "zh-CN", quality: .premium),
            ReaderSpeechVoice(id: "english", name: "English", language: "en-US", quality: .premium),
        ]
        let ordered = ReaderSpeechVoice.sorted(voices)
        assert(ordered.map(\.id) == ["mandarin-premium", "mandarin-enhanced", "mandarin-standard", "cantonese-premium"])
        assert(ReaderSpeechVoice.isChinese("yue-HK") && !ReaderSpeechVoice.isChinese("en-US"))
        let long = String(repeating: "天地玄黄，宇宙洪荒。👩🏽‍🚀𠮷", count: 20)
        let segments = ReaderSpeechChunk.split(long, fromUTF16: 0)
        assert(segments.count > 10 && segments.allSatisfy { $0.text.count <= 48 })
        for chunk in segments { assert((long as NSString).substring(with: chunk.range) == chunk.text) }
        let afterEmoji = ReaderSpeechChunk.split(text, fromUTF16: emoji.location + 3)
        assert(afterEmoji.first?.range.location == emoji.location)
        assert(ReaderSpeechChunk.split("。！？", fromUTF16: 0).isEmpty)
        do {
            let wave = try ReaderSpeechPCM.wav(samples: [-1, 0, 1, .nan], sampleRate: 44_100)
            assert(wave.count == 52)
            assert(String(decoding: wave.prefix(4), as: UTF8.self) == "RIFF")
            assert(String(decoding: wave[8..<12], as: UTF8.self) == "WAVE")
            assert(Array(wave.suffix(2)) == [0, 0])
        } catch { assertionFailure("Valid PCM should encode") }
        do {
            _ = try ReaderSpeechPCM.wav(samples: [], sampleRate: 44_100)
            assertionFailure("Empty PCM must fail")
        } catch { }
        print("ReaderSpeechTests passed: UTF-16 restart, composed characters, invalid ranges, Chinese voice preference, short chunks, PCM WAV")
    }
}
