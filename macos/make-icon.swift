import AppKit

// Draws the FliskOS icon at 1024px and writes an .iconset for iconutil.
let size: CGFloat = 1024
func render(_ px: Int) -> Data {
    let s = CGFloat(px)
    let image = NSImage(size: NSSize(width: s, height: s))
    image.lockFocus()
    let ctx = NSGraphicsContext.current!.cgContext
    let k = s / size
    // Standard macOS icon grid: artwork inset with a squircle-ish corner radius.
    let inset = 100 * k
    let rect = CGRect(x: inset, y: inset, width: s - 2 * inset, height: s - 2 * inset)
    let radius = rect.width * 0.2237
    let path = CGPath(roundedRect: rect, cornerWidth: radius, cornerHeight: radius, transform: nil)

    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -12 * k), blur: 28 * k, color: NSColor(white: 0, alpha: 0.35).cgColor)
    ctx.addPath(path); ctx.setFillColor(NSColor(red: 0.04, green: 0.35, blue: 0.9, alpha: 1).cgColor); ctx.fillPath()
    ctx.restoreGState()

    ctx.saveGState()
    ctx.addPath(path); ctx.clip()
    let colors = [NSColor(red: 0.36, green: 0.66, blue: 1.0, alpha: 1).cgColor, NSColor(red: 0.03, green: 0.38, blue: 0.93, alpha: 1).cgColor] as CFArray
    let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: [0, 1])!
    ctx.drawLinearGradient(gradient, start: CGPoint(x: rect.midX, y: rect.maxY), end: CGPoint(x: rect.midX, y: rect.minY), options: [])
    // Soft top highlight.
    let hi = [NSColor(white: 1, alpha: 0.28).cgColor, NSColor(white: 1, alpha: 0).cgColor] as CFArray
    let hg = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: hi, locations: [0, 1])!
    ctx.drawLinearGradient(hg, start: CGPoint(x: rect.midX, y: rect.maxY), end: CGPoint(x: rect.midX, y: rect.midY), options: [])
    ctx.restoreGState()

    // Activity ring (three quarters) with round caps.
    let center = CGPoint(x: rect.midX, y: rect.midY)
    let ringRadius = rect.width * 0.34
    ctx.setLineCap(.round)
    ctx.setLineWidth(rect.width * 0.075)
    ctx.setStrokeColor(NSColor(white: 1, alpha: 0.28).cgColor)
    ctx.addArc(center: center, radius: ringRadius, startAngle: 0, endAngle: .pi * 2, clockwise: false); ctx.strokePath()
    ctx.setStrokeColor(NSColor.white.cgColor)
    ctx.addArc(center: center, radius: ringRadius, startAngle: .pi / 2, endAngle: -.pi, clockwise: true); ctx.strokePath()

    // "F" monogram.
    let font = NSFont.systemFont(ofSize: rect.width * 0.36, weight: .bold)
    let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor.white]
    let text = NSAttributedString(string: "F", attributes: attrs)
    let ts = text.size()
    text.draw(at: CGPoint(x: center.x - ts.width / 2, y: center.y - ts.height / 2))
    image.unlockFocus()
    let rep = NSBitmapImageRep(data: image.tiffRepresentation!)!
    return rep.representation(using: .png, properties: [:])!
}

let out = CommandLine.arguments[1]
try FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)
for (name, px) in [("icon_16x16", 16), ("icon_16x16@2x", 32), ("icon_32x32", 32), ("icon_32x32@2x", 64), ("icon_128x128", 128), ("icon_128x128@2x", 256), ("icon_256x256", 256), ("icon_256x256@2x", 512), ("icon_512x512", 512), ("icon_512x512@2x", 1024)] {
    try render(px).write(to: URL(fileURLWithPath: "\(out)/\(name).png"))
}
