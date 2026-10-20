import SwiftUI
import ReadingCore

enum Palette {
    static let paper = Color(red: 0.985, green: 0.984, blue: 0.980)
    static let surface = Color.white
    static let ink = Color(red: 0.15, green: 0.15, blue: 0.17)
    static let secondary = Color(red: 0.53, green: 0.53, blue: 0.56)
    static let cinnabar = Color(red: 0.96, green: 0.32, blue: 0.19)
    static let rule = Color(red: 0.91, green: 0.91, blue: 0.92)
}

extension Font {
    static func bookTitle(_ size: CGFloat) -> Font {
        .system(size: size, weight: .semibold)
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
        VStack(spacing: 10) {
            Image(systemName: symbol).font(.system(size: 30, weight: .light))
                .foregroundStyle(Palette.secondary.opacity(0.65)).padding(.bottom, 6)
            Text(title).font(.system(size: 17, weight: .medium)).foregroundStyle(Palette.ink)
            Text(message).font(.system(size: 13)).foregroundStyle(Palette.secondary)
                .multilineTextAlignment(.center).lineSpacing(4)
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 24).padding(.vertical, 40)
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
        .padding(12)
        .background(Palette.surface, in: RoundedRectangle(cornerRadius: 8))
    }
}

/// A cover that fills the proposed grid width. Fixed dimensions are optional.
@MainActor struct BookCoverView: View {
    let book: Book
    @EnvironmentObject private var store: AppStore
    @State private var artwork: UIImage?
    var width: CGFloat? = nil
    var height: CGFloat? = nil
    var aspectRatio: CGFloat = 0.72

    private var resolvedAspectRatio: CGFloat {
        if let width, let height, width > 0, height > 0 { return width / height }
        return max(0.1, aspectRatio)
    }

    private var coverColor: Color {
        let colors: [Color] = [Color(red: 0.22, green: 0.34, blue: 0.38),
                               Color(red: 0.47, green: 0.30, blue: 0.25),
                               Color(red: 0.26, green: 0.31, blue: 0.46),
                               Color(red: 0.30, green: 0.40, blue: 0.33)]
        let value = book.title.unicodeScalars.reduce(0) { ($0 + Int($1.value)) % colors.count }
        return colors[value]
    }

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                fallbackCover(size: geometry.size)
                if let image = artwork ?? BookCoverCache.shared.cachedImage(for: book) {
                    Image(uiImage: image).resizable().scaledToFill()
                        .frame(width: geometry.size.width, height: geometry.size.height)
                        .clipped()
                }
            }
        }
        .aspectRatio(resolvedAspectRatio, contentMode: .fit)
        .frame(width: width, height: height)
        .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous).stroke(.black.opacity(0.04), lineWidth: 0.5))
        .accessibilityHidden(true)
        .task(id: book) {
            let loaded = await BookCoverCache.shared.image(for: book, sources: store.sources)
            guard !Task.isCancelled else { return }
            artwork = loaded
        }
    }

    private func fallbackCover(size: CGSize) -> some View {
        ZStack(alignment: .leading) {
            coverColor
            Rectangle().fill(.black.opacity(0.10)).frame(width: max(3, size.width * 0.045))
            VStack(alignment: .leading, spacing: 8) {
                Text(book.title)
                    .font(.system(size: max(13, min(23, size.width * 0.175)), weight: .semibold, design: .serif))
                    .lineLimit(4).minimumScaleFactor(0.75)
                    .foregroundStyle(.white.opacity(0.95))
                Spacer(minLength: 4)
                Text(book.author.isEmpty ? book.sourceName : book.author)
                    .font(.system(size: max(8, min(11, size.width * 0.085))))
                    .lineLimit(1).foregroundStyle(.white.opacity(0.65))
            }.padding(max(9, size.width * 0.12))
        }
    }
}

struct BookSpine: View {
    let book: Book
    var compact = false

    var body: some View {
        BookCoverView(book: book, width: compact ? 66 : 104, height: compact ? 94 : 148)
    }
}

struct BookRow: View {
    let book: Book
    var annotation: String? = nil
    var showsChevron = true

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            BookSpine(book: book, compact: true)
            VStack(alignment: .leading, spacing: 6) {
                Text(book.title).font(.system(size: 16, weight: .semibold)).foregroundStyle(Palette.ink).lineLimit(2)
                Text(book.author.isEmpty ? "作者未标注" : book.author)
                    .font(.system(size: 12)).foregroundStyle(Palette.secondary)
                if !book.summary.isEmpty {
                    Text(book.summary).font(.system(size: 12)).foregroundStyle(Palette.secondary)
                        .lineLimit(2)
                }
                Text(annotation ?? book.sourceName).font(.system(size: 11)).foregroundStyle(Palette.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 0)
            if showsChevron {
                Image(systemName: "chevron.right").font(.caption).foregroundStyle(Palette.secondary)
                    .padding(.top, 8)
            }
        }
        .padding(.vertical, 12)
        .contentShape(Rectangle())
    }
}

struct PrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.system(size: 15, weight: .medium))
            .frame(maxWidth: .infinity).padding(.vertical, 15)
            .foregroundStyle(Palette.surface)
            .background(Palette.cinnabar.opacity(configuration.isPressed ? 0.75 : 1),
                        in: Capsule())
            .opacity(isEnabled ? 1 : 0.45)
    }
}
