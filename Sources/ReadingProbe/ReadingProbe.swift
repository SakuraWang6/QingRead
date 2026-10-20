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
        var arguments = Array(CommandLine.arguments.dropFirst())
        var selectedSourceID: String?
        if let flag = arguments.firstIndex(of: "--source") {
            guard arguments.indices.contains(flag + 1) else {
                print("用法：reading-probe [--source 来源ID] [书名]")
                exit(64)
            }
            selectedSourceID = arguments[flag + 1]
            arguments.removeSubrange(flag...(flag + 1))
        }
        if let selectedSourceID, !SourceDefinition.builtIn.contains(where: { $0.id == selectedSourceID }) {
            print("未知来源：\(selectedSourceID)")
            exit(64)
        }
        let query = arguments.first ?? "桃花源記"
        let service = ReadingService()
        let result = await service.search(query: query, enabledSourceIDs: selectedSourceID.map { Set([$0]) })
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
            if content.paragraphs.isEmpty { exit(3) }
        } catch {
            print("读取失败：\(error.localizedDescription)")
            exit(4)
        }
    }
}
