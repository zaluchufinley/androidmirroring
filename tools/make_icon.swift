// Draws the app icon (an original design: a phone with radio waves on both sides) and builds Resources/AppIcon.icns.
// Usage: swift tools/make_icon.swift   (run from the project folder)

import AppKit

func drawIcon(in ctx: CGContext, size s: CGFloat) {
    ctx.saveGState()
    ctx.scaleBy(x: s / 1024, y: s / 1024)

    // macOS icon grid: 824 pt body centred in a 1024 pt canvas, with room for the shadow.
    let body = CGRect(x: 100, y: 100, width: 824, height: 824)
    let radius: CGFloat = 186
    let path = CGPath(roundedRect: body, cornerWidth: radius, cornerHeight: radius, transform: nil)
    let rgb = CGColorSpaceCreateDeviceRGB()

    // Shadow under the body
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -14), blur: 32, color: CGColor(gray: 0, alpha: 0.38))
    ctx.setFillColor(CGColor(gray: 0.05, alpha: 1))
    ctx.addPath(path); ctx.fillPath()
    ctx.restoreGState()

    // Clip to the body
    ctx.saveGState()
    ctx.addPath(path); ctx.clip()

    // Deep blue-black background
    let bg = CGGradient(colorsSpace: rgb, colors: [
        CGColor(srgbRed: 0.13, green: 0.17, blue: 0.30, alpha: 1),
        CGColor(srgbRed: 0.02, green: 0.03, blue: 0.08, alpha: 1),
    ] as CFArray, locations: [0, 1])!
    ctx.drawLinearGradient(bg, start: CGPoint(x: 512, y: 924), end: CGPoint(x: 512, y: 100), options: [])

    // Soft accent glow behind the phone
    let glow = CGGradient(colorsSpace: rgb, colors: [
        CGColor(srgbRed: 0.18, green: 0.52, blue: 1.0, alpha: 0.62),
        CGColor(srgbRed: 0.18, green: 0.52, blue: 1.0, alpha: 0.0),
    ] as CFArray, locations: [0, 1])!
    ctx.drawRadialGradient(glow, startCenter: CGPoint(x: 512, y: 520), startRadius: 0,
                           endCenter: CGPoint(x: 512, y: 520), endRadius: 430, options: [])

    // Phone
    let pw: CGFloat = 250, ph: CGFloat = 430
    let phone = CGRect(x: 512 - pw / 2, y: 512 - ph / 2 - 6, width: pw, height: ph)
    let phonePath = CGPath(roundedRect: phone, cornerWidth: 62, cornerHeight: 62, transform: nil)
    ctx.setFillColor(CGColor(gray: 1, alpha: 0.10))
    ctx.addPath(phonePath); ctx.fillPath()
    ctx.setStrokeColor(CGColor(gray: 1, alpha: 0.97))
    ctx.setLineWidth(26)
    ctx.addPath(phonePath); ctx.strokePath()
    // speaker slot and home bar
    ctx.setLineCap(.round)
    ctx.setLineWidth(15)
    ctx.move(to: CGPoint(x: 512 - 34, y: phone.maxY - 52)); ctx.addLine(to: CGPoint(x: 512 + 34, y: phone.maxY - 52)); ctx.strokePath()
    ctx.setLineWidth(13)
    ctx.setStrokeColor(CGColor(gray: 1, alpha: 0.85))
    ctx.move(to: CGPoint(x: 512 - 42, y: phone.minY + 46)); ctx.addLine(to: CGPoint(x: 512 + 42, y: phone.minY + 46)); ctx.strokePath()

    // Radio waves, left and right, fading outward
    let center = CGPoint(x: 512, y: 512 - 6)
    let radii: [CGFloat] = [212, 288, 364]
    let alphas: [CGFloat] = [0.95, 0.70, 0.45]
    let half: CGFloat = 34 * .pi / 180
    ctx.setLineCap(.round)
    ctx.setLineWidth(24)
    for (r, a) in zip(radii, alphas) {
        ctx.setStrokeColor(CGColor(gray: 1, alpha: a))
        // right
        ctx.addArc(center: center, radius: r, startAngle: -half, endAngle: half, clockwise: false)
        ctx.strokePath()
        // left
        ctx.addArc(center: center, radius: r, startAngle: .pi - half, endAngle: .pi + half, clockwise: false)
        ctx.strokePath()
    }

    // Subtle top highlight
    let hi = CGGradient(colorsSpace: rgb, colors: [
        CGColor(gray: 1, alpha: 0.10), CGColor(gray: 1, alpha: 0.0),
    ] as CFArray, locations: [0, 1])!
    ctx.drawLinearGradient(hi, start: CGPoint(x: 512, y: 924), end: CGPoint(x: 512, y: 700), options: [])
    ctx.restoreGState()

    // Hairline edge
    ctx.setStrokeColor(CGColor(gray: 1, alpha: 0.10))
    ctx.setLineWidth(2)
    ctx.addPath(path); ctx.strokePath()
    ctx.restoreGState()
}

func png(size: Int) -> Data {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4,
                               hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    let gc = NSGraphicsContext(bitmapImageRep: rep)!
    NSGraphicsContext.current = gc
    drawIcon(in: gc.cgContext, size: CGFloat(size))
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

let fm = FileManager.default
let iconset = "Resources/AppIcon.iconset"
try? fm.removeItem(atPath: iconset)
try fm.createDirectory(atPath: iconset, withIntermediateDirectories: true)
let sizes: [(String, Int)] = [
    ("icon_16x16", 16), ("icon_16x16@2x", 32), ("icon_32x32", 32), ("icon_32x32@2x", 64),
    ("icon_128x128", 128), ("icon_128x128@2x", 256), ("icon_256x256", 256), ("icon_256x256@2x", 512),
    ("icon_512x512", 512), ("icon_512x512@2x", 1024),
]
for (name, px) in sizes { try png(size: px).write(to: URL(fileURLWithPath: "\(iconset)/\(name).png")) }
try png(size: 1024).write(to: URL(fileURLWithPath: "Resources/AppIcon-preview.png"))

let p = Process()
p.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
p.arguments = ["-c", "icns", iconset, "-o", "Resources/AppIcon.icns"]
try p.run(); p.waitUntilExit()
try? fm.removeItem(atPath: iconset)
print(p.terminationStatus == 0 ? "Wrote Resources/AppIcon.icns" : "iconutil failed")
