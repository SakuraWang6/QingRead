import Foundation
import ReadingCore
#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

@main
struct ReadingProbe {
    static func main() async {
        let query = CommandLine.arguments.dropFirst().first ?? "桃花源記"
        let service = ReadingService()
        let result = await service.search(query: query)
        print("搜索：\(query)，结果：\(result.books.count)")
        for failure in result.failures {
            print("来源失败：\(failure.sourceName)：\(failure.message)")
        }
        for book in result.books.prefix(5) {
            print("\(book.title) · \(book.sourceName) · \(book.url.absoluteString)")
        }
        guard let first = result.books.first else {
            print("未验证到可读结果。请检查网络或更换查询词。")
            exit(1)
        }
        do {
            let chapters = try await service.chapters(for: first)
            print("目录：\(chapters.count) 章")
            guard let chapter = chapters.first else { exit(2) }
            let content = try await service.content(for: chapter, in: first)
            print("首章：\(chapter.title)，\(content.paragraphs.count) 段")
            print(content.paragraphs.prefix(2).joined(separator: "\n"))
            if content.paragraphs.isEmpty { exit(3) }
        } catch {
            print("读取失败：\(error.localizedDescription)")
            exit(4)
        }
    }
}
