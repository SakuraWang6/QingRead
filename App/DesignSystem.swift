import SwiftUI
import ReadingCore

enum Palette {
    static let paper = Color(red: 0.965, green: 0.953, blue: 0.921)
    static let surface = Color(red: 0.995, green: 0.985, blue: 0.960)
    static let ink = Color(red: 0.16, green: 0.19, blue: 0.18)
    static let secondary = Color(red: 0.45, green: 0.46, blue: 0.42)
    static let cinnabar = Color(red: 0.69, green: 0.23, blue: 0.17)
    static let rule = Color(red: 0.84, green: 0.82, blue: 0.76)
}

extension Font {
    static func bookTitle(_ size: CGFloat) -> Font {
        .custom("SongtiSC-Regular", size: size, relativeTo: .title)
    }
}

struct PageHeading: View {
    let eyebrow: String
    let title: String
    let subtitle: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Rectangle().fill(Palette.cinnabar).frame(width: 24, height: 2)
                Text(eyebrow).font(.system(size: 11, weight: .medium, design: .monospaced))
                    .tracking(2).foregroundStyle(Palette.secondary)
            }
            Text(title).font(.bookTitle(36)).foregroundStyle(Palette.ink)
            Text(subtitle).font(.subheadline).foregroundStyle(Palette.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 16)
    }
}

struct QuietEmptyState: View {
    let symbol: String
    let title: String
    let message: String

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: symbol).font(.system(size: 31, weight: .ultraLight))
                .foregroundStyle(Palette.cinnabar).padding(.bottom, 4)
            Text(title).font(.bookTitle(24)).foregroundStyle(Palette.ink)
            Text(message).font(.subheadline).foregroundStyle(Palette.secondary)
                .multilineTextAlignment(.center).lineSpacing(5)
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 24).padding(.vertical, 48)
    }
}

struct InlineNotice: View {
    let message: String
    var isError = false

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: isError ? "exclamationmark.circle" : "info.circle")
            Text(message).font(.footnote).lineSpacing(3).textSelection(.enabled)
        }
        .foregroundStyle(isError ? Palette.cinnabar : Palette.secondary)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Palette.surface, in: RoundedRectangle(cornerRadius: 8))
    }
}

struct BookSpine: View {
    let book: Book
    var compact = false

    private var coverColor: Color {
        let colors: [Color] = [Color(red: 0.27, green: 0.38, blue: 0.35),
                               Color(red: 0.46, green: 0.32, blue: 0.27),
                               Color(red: 0.31, green: 0.37, blue: 0.45)]
        let value = book.title.unicodeScalars.reduce(0) { ($0 + Int($1.value)) % 3 }
        return colors[value]
    }

    var body: some View {
        ZStack(alignment: .topLeading) {
            coverColor
            Rectangle().fill(.black.opacity(0.12)).frame(width: 5)
            VStack(alignment: .leading, spacing: 8) {
                Text(book.title).font(.bookTitle(compact ? 16 : 22))
                    .lineLimit(compact ? 3 : 4).foregroundStyle(Palette.paper)
                Spacer(minLength: 0)
                Rectangle().fill(Palette.paper.opacity(0.5)).frame(width: 14, height: 1)
            }.padding(compact ? 10 : 15).padding(.leading, 3)
        }
        .frame(width: compact ? 64 : 104, height: compact ? 90 : 145)
        .clipShape(RoundedRectangle(cornerRadius: 3))
        .accessibilityHidden(true)
    }
}

struct BookRow: View {
    let book: Book
    var annotation: String? = nil

    var body: some View {
        HStack(alignment: .top, spacing: 17) {
            BookSpine(book: book, compact: true)
            VStack(alignment: .leading, spacing: 7) {
                Text(book.title).font(.bookTitle(21)).foregroundStyle(Palette.ink).lineLimit(2)
                Text(book.author.isEmpty ? "作者未标注" : book.author)
                    .font(.subheadline).foregroundStyle(Palette.secondary)
                Text(annotation ?? book.sourceName).font(.caption).foregroundStyle(Palette.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right").font(.caption).foregroundStyle(Palette.secondary)
                .padding(.top, 8)
        }
        .padding(.vertical, 14)
        .contentShape(Rectangle())
    }
}

struct PrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.system(size: 15, weight: .medium))
            .frame(maxWidth: .infinity).padding(.vertical, 15)
            .foregroundStyle(Palette.surface)
            .background(Palette.ink.opacity(configuration.isPressed ? 0.75 : 1),
                        in: RoundedRectangle(cornerRadius: 8))
    }
}
