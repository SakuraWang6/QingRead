// Reproducible code-drawn icon. Run from the repository root on macOS.
import AppKit

let size = 1024
let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
NSColor(srgbRed: 0.96, green: 0.94, blue: 0.88, alpha: 1).setFill()
NSBezierPath(rect: NSRect(x: 0, y: 0, width: size, height: size)).fill()
let ink = NSColor(srgbRed: 0.16, green: 0.21, blue: 0.19, alpha: 1)
ink.setStroke()
let book = NSBezierPath()
book.move(to: NSPoint(x: 245, y: 275))
book.line(to: NSPoint(x: 245, y: 742))
book.curve(to: NSPoint(x: 512, y: 695), controlPoint1: NSPoint(x: 330, y: 765), controlPoint2: NSPoint(x: 437, y: 735))
book.curve(to: NSPoint(x: 779, y: 742), controlPoint1: NSPoint(x: 590, y: 735), controlPoint2: NSPoint(x: 697, y: 765))
book.line(to: NSPoint(x: 779, y: 275))
book.curve(to: NSPoint(x: 512, y: 235), controlPoint1: NSPoint(x: 680, y: 290), controlPoint2: NSPoint(x: 591, y: 265))
book.curve(to: NSPoint(x: 245, y: 275), controlPoint1: NSPoint(x: 426, y: 265), controlPoint2: NSPoint(x: 342, y: 290))
book.lineWidth = 28
book.lineJoinStyle = .round
book.close()
book.stroke()
let spine = NSBezierPath()
spine.move(to: NSPoint(x: 512, y: 250)); spine.line(to: NSPoint(x: 512, y: 692))
spine.lineWidth = 20; spine.stroke()
for x in [312.0, 579.0] {
    for y in [399.0, 467.0, 535.0] {
        let line = NSBezierPath()
        line.move(to: NSPoint(x: x, y: y)); line.line(to: NSPoint(x: x + 135, y: y - 18))
        line.lineWidth = 13; line.stroke()
    }
}
NSColor(srgbRed: 0.68, green: 0.23, blue: 0.18, alpha: 1).setFill()
let bookmark = NSBezierPath()
bookmark.move(to: NSPoint(x: 628, y: 749)); bookmark.line(to: NSPoint(x: 688, y: 755))
bookmark.line(to: NSPoint(x: 688, y: 604)); bookmark.line(to: NSPoint(x: 658, y: 624))
bookmark.line(to: NSPoint(x: 628, y: 602)); bookmark.close(); bookmark.fill()
NSGraphicsContext.restoreGraphicsState()
let destination = URL(fileURLWithPath: "App/Assets.xcassets/AppIcon.appiconset", isDirectory: true)
try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
try bitmap.representation(using: .png, properties: [:])!.write(to: destination.appendingPathComponent("AppIcon.png"))
print("Created AppIcon.png (1024 × 1024)")
