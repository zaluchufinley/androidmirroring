// Views: floating glass window controls, connect screen, mirror surface.

import AppKit
import AVFoundation

// MARK: - Motion

enum Motion {
    /// Quick start, long soft landing (Apple's standard "ease-out" feel).
    static let easeOut = CAMediaTimingFunction(controlPoints: 0.22, 1.0, 0.36, 1.0)
    static let easeInOut = CAMediaTimingFunction(controlPoints: 0.42, 0.0, 0.2, 1.0)
    static var reduced: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }
}

extension CALayer {
    /// Animates from whatever is on screen right now, so rapid hover in/out never jumps.
    func animate(_ keyPath: String, to target: Any, duration: CFTimeInterval, timing: CAMediaTimingFunction = Motion.easeOut, key: String? = nil) {
        let from = presentation()?.value(forKeyPath: keyPath) ?? value(forKeyPath: keyPath)
        setValue(target, forKeyPath: keyPath)
        let a = CABasicAnimation(keyPath: keyPath)
        a.fromValue = from
        a.toValue = target
        a.duration = duration
        a.timingFunction = timing
        add(a, forKey: key ?? keyPath)
    }
    func spring(_ keyPath: String, to target: Any, stiffness: CGFloat = 260, damping: CGFloat = 22, key: String? = nil) {
        let from = presentation()?.value(forKeyPath: keyPath) ?? value(forKeyPath: keyPath)
        setValue(target, forKeyPath: keyPath)
        let a = CASpringAnimation(keyPath: keyPath)
        a.fromValue = from
        a.toValue = target
        a.mass = 1; a.stiffness = stiffness; a.damping = damping
        a.duration = a.settlingDuration
        add(a, forKey: key ?? keyPath)
    }
}

extension CALayer {
    /// Core Animation tweens sublayer frame changes over 0.25 s by default. For anything that must track the window
    /// while it is being resized, that lag shows up as a background that stops short of the content.
    static func withoutAnimation(_ body: () -> Void) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        body()
        CATransaction.commit()
    }
}

// MARK: - Glass

enum Glass {
    /// Real Liquid Glass where the OS has it, a blurred material elsewhere.
    static func wrap(_ content: NSView, radius: CGFloat) -> NSView {
        if #available(macOS 26.0, *) {
            let g = NSGlassEffectView()
            g.cornerRadius = radius
            g.contentView = content
            g.appearance = NSAppearance(named: .darkAqua)
            return g
        }
        let v = NSVisualEffectView()
        v.material = .hudWindow
        v.blendingMode = .withinWindow
        v.state = .active
        v.appearance = NSAppearance(named: .vibrantDark)
        v.wantsLayer = true
        v.layer?.cornerRadius = radius
        v.layer?.masksToBounds = true
        content.autoresizingMask = [.width, .height]
        v.addSubview(content)
        return v
    }
}

// MARK: - Traffic lights

final class TrafficLight: NSView {
    enum Kind { case close, minimize, zoom }
    let kind: Kind
    var active = true { didSet { needsDisplay = true } }
    var groupHover = false { didSet { needsDisplay = true } }
    var pressed = false { didSet { needsDisplay = true } }
    var onClick: (() -> Void)?

    init(kind: Kind) {
        self.kind = kind
        super.init(frame: NSRect(x: 0, y: 0, width: 12, height: 12))
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityLabel(kind == .close ? "Close" : kind == .minimize ? "Minimize" : "Zoom")
    }
    required init?(coder: NSCoder) { fatalError() }
    override var mouseDownCanMoveWindow: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        let base: NSColor
        switch kind {
        case .close: base = NSColor(srgbRed: 1.0, green: 0.373, blue: 0.341, alpha: 1)
        case .minimize: base = NSColor(srgbRed: 0.996, green: 0.737, blue: 0.180, alpha: 1)
        case .zoom: base = NSColor(srgbRed: 0.157, green: 0.784, blue: 0.251, alpha: 1)
        }
        let c = active ? base : NSColor(white: 0.62, alpha: 0.55)
        let circle = NSBezierPath(ovalIn: bounds.insetBy(dx: 0.5, dy: 0.5))
        (pressed ? c.blended(withFraction: 0.3, of: .black) ?? c : c).setFill()
        circle.fill()
        NSColor(white: 0, alpha: 0.18).setStroke()
        circle.lineWidth = 0.5
        circle.stroke()
        guard groupHover && active else { return }
        NSColor(white: 0, alpha: 0.55).setStroke()
        let g = NSBezierPath()
        g.lineWidth = 1.2
        g.lineCapStyle = .round
        let m = bounds.midX, n = bounds.midY
        switch kind {
        case .close:
            g.move(to: NSPoint(x: m - 2.2, y: n - 2.2)); g.line(to: NSPoint(x: m + 2.2, y: n + 2.2))
            g.move(to: NSPoint(x: m - 2.2, y: n + 2.2)); g.line(to: NSPoint(x: m + 2.2, y: n - 2.2))
        case .minimize:
            g.move(to: NSPoint(x: m - 2.8, y: n)); g.line(to: NSPoint(x: m + 2.8, y: n))
        case .zoom:
            g.move(to: NSPoint(x: m - 2.6, y: n)); g.line(to: NSPoint(x: m + 2.6, y: n))
            g.move(to: NSPoint(x: m, y: n - 2.6)); g.line(to: NSPoint(x: m, y: n + 2.6))
        }
        g.stroke()
    }
    override func mouseDown(with event: NSEvent) { pressed = true }
    override func mouseUp(with event: NSEvent) {
        pressed = false
        if bounds.contains(convert(event.locationInWindow, from: nil)) { onClick?() }
    }
}

final class TrafficLights: NSView {
    let close = TrafficLight(kind: .close)
    let minimize = TrafficLight(kind: .minimize)
    let zoom = TrafficLight(kind: .zoom)
    private var lights: [TrafficLight] { [close, minimize, zoom] }

    init() {
        super.init(frame: NSRect(x: 0, y: 0, width: 12 * 3 + 8 * 2, height: 12))
        for (i, l) in lights.enumerated() {
            l.frame.origin = NSPoint(x: CGFloat(i) * 20, y: 0)
            addSubview(l)
        }
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self))
    }
    required init?(coder: NSCoder) { fatalError() }
    var active = true { didSet { lights.forEach { $0.active = active } } }
    override func mouseEntered(with event: NSEvent) { lights.forEach { $0.groupHover = true } }
    override func mouseExited(with event: NSEvent) { lights.forEach { $0.groupHover = false } }
    override var mouseDownCanMoveWindow: Bool { false }
}

// MARK: - Icon button (glass capsule member)

final class IconButton: NSView {
    let symbol: String
    var onClick: (() -> Void)?
    private let highlight = CALayer()
    private var pressed = false { didSet { needsDisplay = true } }

    init(symbol: String, tip: String) {
        self.symbol = symbol
        super.init(frame: NSRect(x: 0, y: 0, width: 36, height: 26))
        toolTip = tip
        wantsLayer = true
        highlight.backgroundColor = NSColor(white: 1, alpha: 0.24).cgColor
        highlight.cornerRadius = 13
        highlight.cornerCurve = .continuous
        highlight.opacity = 0
        layer?.addSublayer(highlight)
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self))
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityLabel(tip)
    }
    required init?(coder: NSCoder) { fatalError() }
    override var mouseDownCanMoveWindow: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func layout() { super.layout(); CALayer.withoutAnimation { highlight.frame = bounds } }

    private func setHighlight(_ v: Float, _ d: CFTimeInterval) {
        highlight.animate("opacity", to: v, duration: Motion.reduced ? 0.01 : d, key: "hl")
    }
    override func mouseEntered(with event: NSEvent) { setHighlight(0.55, 0.18) }
    override func mouseExited(with event: NSEvent) { pressed = false; setHighlight(0, 0.28) }
    override func mouseDown(with event: NSEvent) { pressed = true; setHighlight(1, 0.06) }
    override func mouseUp(with event: NSEvent) {
        let inside = bounds.contains(convert(event.locationInWindow, from: nil))
        pressed = false
        setHighlight(inside ? 0.55 : 0, 0.3)
        if inside { onClick?() }
    }
    override func draw(_ dirtyRect: NSRect) {
        let cfg = NSImage.SymbolConfiguration(pointSize: 14, weight: .medium)
            .applying(NSImage.SymbolConfiguration(paletteColors: [.white]))
        if let img = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)?.withSymbolConfiguration(cfg) {
            let s = img.size
            img.draw(in: NSRect(x: bounds.midX - s.width / 2, y: bounds.midY - s.height / 2, width: s.width, height: s.height),
                     from: .zero, operation: .sourceOver, fraction: pressed ? 0.65 : 1)
        }
    }
}

// MARK: - Floating chrome over the mirrored screen

final class ChromeBar: NSView {
    static let height: CGFloat = 60
    let lights = TrafficLights()
    let home = IconButton(symbol: "house", tip: "Home Screen  ⌘1")
    let switcher = IconButton(symbol: "square.on.square", tip: "App Switcher  ⌘2")
    let notifications = IconButton(symbol: "bell", tip: "Notifications  ⌘3")
    let more = IconButton(symbol: "ellipsis", tip: "Sound, Keep on Top, Disconnect")
    private(set) var shown = true
    private let scrim = CAGradientLayer()
    private let leftContent = NSView(frame: NSRect(x: 0, y: 0, width: 88, height: 32))
    private let rightContent = NSView(frame: NSRect(x: 0, y: 0, width: 158, height: 32))
    private var leftGlass: NSView!
    private var rightGlass: NSView!

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        scrim.colors = [NSColor(white: 0, alpha: 0.42).cgColor, NSColor(white: 0, alpha: 0).cgColor]
        scrim.startPoint = CGPoint(x: 0.5, y: 1)
        scrim.endPoint = CGPoint(x: 0.5, y: 0)
        layer?.addSublayer(scrim)

        lights.frame.origin = NSPoint(x: 17, y: 10)
        leftContent.addSubview(lights)
        home.frame.origin = NSPoint(x: 4, y: 3)
        switcher.frame.origin = NSPoint(x: 42, y: 3)
        notifications.frame.origin = NSPoint(x: 80, y: 3)
        more.frame.origin = NSPoint(x: 118, y: 3)
        rightContent.addSubview(home)
        rightContent.addSubview(switcher)
        rightContent.addSubview(notifications)
        rightContent.addSubview(more)
        leftGlass = Glass.wrap(leftContent, radius: 16)
        rightGlass = Glass.wrap(rightContent, radius: 16)
        leftGlass.frame.size = NSSize(width: 88, height: 32)
        rightGlass.frame.size = NSSize(width: 158, height: 32)
        addSubview(leftGlass)
        addSubview(rightGlass)
    }
    required init?(coder: NSCoder) { fatalError() }

    override var mouseDownCanMoveWindow: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    /// While the strip is showing, all of it belongs to the window: the capsule buttons take clicks and everything else
    /// drags the window around the screen. The notification panel is opened with the bell button (or ⌘3).
    override func hitTest(_ point: NSPoint) -> NSView? {
        guard shown else { return nil }
        return super.hitTest(point)
    }
    override func mouseDown(with event: NSEvent) { window?.performDrag(with: event) }  // drag the window by the strip

    override func layout() {
        super.layout()
        CALayer.withoutAnimation { scrim.frame = bounds }
        let y = bounds.height - 12 - 32
        leftGlass.frame.origin = NSPoint(x: 12, y: y)
        rightGlass.frame.origin = NSPoint(x: bounds.width - 12 - rightGlass.frame.width, y: y)
    }

    /// Fades and slides in with a soft spring; out with a quick ease. Always interruptible.
    func setVisible(_ visible: Bool) {
        guard visible != shown, let l = layer else { return }
        shown = visible
        let hiddenOffset: CGFloat = 8
        if Motion.reduced {
            l.animate("opacity", to: Float(visible ? 1 : 0), duration: 0.15, key: "fade")
            l.transform = CATransform3DIdentity
            return
        }
        if visible {
            l.animate("opacity", to: Float(1), duration: 0.32, timing: Motion.easeOut, key: "fade")
            l.spring("transform.translation.y", to: CGFloat(0), stiffness: 240, damping: 24, key: "slide")
        } else {
            l.animate("opacity", to: Float(0), duration: 0.28, timing: Motion.easeInOut, key: "fade")
            l.animate("transform.translation.y", to: hiddenOffset, duration: 0.28, timing: Motion.easeInOut, key: "slide")
        }
    }
    func snap(visible: Bool) {
        shown = visible
        layer?.removeAllAnimations()
        layer?.opacity = visible ? 1 : 0
        layer?.transform = visible ? CATransform3DIdentity : CATransform3DMakeTranslation(0, 8, 0)
    }
}

// MARK: - Mirror view (video + input)

final class MirrorView: NSView {
    private let display = AVSampleBufferDisplayLayer()
    weak var session: MirrorSession?
    var videoSize = CGSize(width: 1080, height: 2400)
    /// Called with true when a touch starts on the phone and false when it ends.
    var onTouch: ((Bool) -> Void)?
    /// A finished swipe, as fractions (0 top … 1 bottom) of the phone screen's height: where it began and where it ended.
    var onSwipe: ((_ from: CGFloat, _ to: CGFloat) -> Void)?
    /// The Esc key was pressed (sent to the phone as Back).
    var onBack: (() -> Void)?
    private var gestureStartY: CGFloat = 0
    private var pressing = false
    private var swiping = false
    private var swipePos = CGPoint.zero

    static let touchCursor: NSCursor = {
        let d: CGFloat = 26
        let img = NSImage(size: NSSize(width: d, height: d), flipped: false) { r in
            let c = NSBezierPath(ovalIn: r.insetBy(dx: 2, dy: 2))
            NSColor(white: 0.55, alpha: 0.55).setFill(); c.fill()
            NSColor(white: 1, alpha: 0.9).setStroke(); c.lineWidth = 1.5; c.stroke()
            return true
        }
        return NSCursor(image: img, hotSpot: NSPoint(x: d / 2, y: d / 2))
    }()

    var layerRef: AVSampleBufferDisplayLayer { display }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        display.videoGravity = .resizeAspect  // exact when the window keeps the phone's ratio, letterboxed in full screen
        display.backgroundColor = NSColor.black.cgColor
    }
    required init?(coder: NSCoder) { fatalError() }

    override func makeBackingLayer() -> CALayer { display }
    override var mouseDownCanMoveWindow: Bool { false }
    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func resetCursorRects() { addCursorRect(bounds, cursor: MirrorView.touchCursor) }
    override func layout() { super.layout(); window?.invalidateCursorRects(for: self) }

    /// Where the phone screen actually sits inside the view (aspect-fit).
    private func videoRect() -> CGRect {
        let s = videoSize
        guard s.width > 0, s.height > 0, bounds.width > 0, bounds.height > 0 else { return bounds }
        let k = min(bounds.width / s.width, bounds.height / s.height)
        let w = s.width * k, h = s.height * k
        return CGRect(x: (bounds.width - w) / 2, y: (bounds.height - h) / 2, width: w, height: h)
    }
    private func devicePoint(_ p: NSPoint) -> CGPoint {
        let r = videoRect()
        let fx = max(0, min(1, (p.x - r.minX) / max(1, r.width)))
        let fy = max(0, min(1, 1 - (p.y - r.minY) / max(1, r.height)))
        return CGPoint(x: fx * videoSize.width, y: fy * videoSize.height)
    }
    private func sendTouch(_ action: UInt8, at p: CGPoint) {
        let w = Int(videoSize.width), h = Int(videoSize.height)
        session?.send(Ctl.touch(action: action, x: Int(p.x), y: Int(p.y), w: w, h: h,
                                pressure: action == 1 ? 0 : 1, buttons: action == 1 ? 0 : 1))
    }

    override func mouseDown(with e: NSEvent) {
        if e.modifierFlags.contains(.option) { window?.performDrag(with: e); return }  // ⌥-drag moves the window
        window?.makeFirstResponder(self)
        pressing = true
        onTouch?(true)
        let p = devicePoint(convert(e.locationInWindow, from: nil))
        gestureStartY = p.y / max(1, videoSize.height)
        sendTouch(0, at: p)
    }
    override func mouseDragged(with e: NSEvent) {
        guard pressing else { return }
        sendTouch(2, at: devicePoint(convert(e.locationInWindow, from: nil)))
    }
    override func mouseUp(with e: NSEvent) {
        guard pressing else { return }
        pressing = false
        onTouch?(false)
        let p = devicePoint(convert(e.locationInWindow, from: nil))
        onSwipe?(gestureStartY, p.y / max(1, videoSize.height))
        sendTouch(1, at: p)
    }
    override func rightMouseDown(with e: NSEvent) { onBack?(); session?.send(Ctl.backOrScreenOn(action: 0)) }
    override func rightMouseUp(with e: NSEvent) { session?.send(Ctl.backOrScreenOn(action: 1)) }

    override func scrollWheel(with e: NSEvent) {
        guard let s = session else { return }
        if e.hasPreciseScrollingDeltas {
            if !e.momentumPhase.isEmpty { return }  // let Android compute its own fling
            let k = videoSize.width / max(1, videoRect().width)
            if e.phase.contains(.began) {
                swiping = true
                onTouch?(true)
                swipePos = devicePoint(convert(e.locationInWindow, from: nil))
                gestureStartY = swipePos.y / max(1, videoSize.height)
                sendTouch(0, at: swipePos)
            }
            guard swiping else { return }
            if e.scrollingDeltaX != 0 || e.scrollingDeltaY != 0 {
                swipePos.x = max(0, min(videoSize.width, swipePos.x + e.scrollingDeltaX * k))
                swipePos.y = max(0, min(videoSize.height, swipePos.y + e.scrollingDeltaY * k))
                sendTouch(2, at: swipePos)
            }
            if e.phase.contains(.ended) || e.phase.contains(.cancelled) {
                swiping = false
                onTouch?(false)
                onSwipe?(gestureStartY, swipePos.y / max(1, videoSize.height))
                sendTouch(1, at: swipePos)
            }
        } else {
            let p = devicePoint(convert(e.locationInWindow, from: nil))
            s.send(Ctl.scroll(x: Int(p.x), y: Int(p.y), w: Int(videoSize.width), h: Int(videoSize.height),
                              hscroll: Float(e.scrollingDeltaX), vscroll: Float(e.scrollingDeltaY)))
        }
    }

    override func keyDown(with e: NSEvent) {
        guard let s = session else { return }
        if e.modifierFlags.contains(.command) { super.keyDown(with: e); return }
        switch e.keyCode {
        case 36, 76: s.tapKey(Key.enter)
        case 51: s.tapKey(Key.del)
        case 117: s.tapKey(Key.fwdDel)
        case 48: s.tapKey(Key.tab)
        case 53: onBack?(); s.send(Ctl.backOrScreenOn(action: 0)); s.send(Ctl.backOrScreenOn(action: 1))
        case 123: s.tapKey(Key.left)
        case 124: s.tapKey(Key.right)
        case 125: s.tapKey(Key.down)
        case 126: s.tapKey(Key.up)
        default:
            if let t = e.characters, !t.isEmpty, !e.modifierFlags.contains(.control),
               t.unicodeScalars.allSatisfy({ $0.value >= 32 && !(0xF700...0xF8FF).contains($0.value) }) {
                s.sendText(t)
            }
        }
    }

    @objc func paste(_ sender: Any?) {
        if let t = NSPasteboard.general.string(forType: .string) {
            session?.send(Ctl.clipboard(t, paste: true))
        }
    }
}


// MARK: - Edge / corner resize handles (borderless windows have none of their own)

final class ResizeHandle: NSView {
    enum Edge { case left, right, top, bottom, topLeft, topRight, bottomLeft, bottomRight }
    let edge: Edge
    var aspect: () -> CGFloat = { 2.2 }       // height / width of the phone screen
    var limits: () -> (min: CGFloat, max: CGFloat) = { (280, 1200) }
    private var startFrame = NSRect.zero
    private var startMouse = NSPoint.zero

    init(edge: Edge) {
        self.edge = edge
        super.init(frame: .zero)
    }
    required init?(coder: NSCoder) { fatalError() }
    override var mouseDownCanMoveWindow: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func resetCursorRects() {
        let c: NSCursor
        if #available(macOS 15.0, *) {
            switch edge {
            case .left: c = .frameResize(position: .left, directions: .all)
            case .right: c = .frameResize(position: .right, directions: .all)
            case .top: c = .frameResize(position: .top, directions: .all)
            case .bottom: c = .frameResize(position: .bottom, directions: .all)
            case .topLeft: c = .frameResize(position: .topLeft, directions: .all)
            case .topRight: c = .frameResize(position: .topRight, directions: .all)
            case .bottomLeft: c = .frameResize(position: .bottomLeft, directions: .all)
            case .bottomRight: c = .frameResize(position: .bottomRight, directions: .all)
            }
        } else {
            c = (edge == .left || edge == .right) ? .resizeLeftRight : .resizeUpDown
        }
        addCursorRect(bounds, cursor: c)
    }

    override func mouseDown(with event: NSEvent) {
        startFrame = window?.frame ?? .zero
        startMouse = NSEvent.mouseLocation
    }

    override func mouseDragged(with event: NSEvent) {
        guard let win = window else { return }
        let a = aspect()
        let m = NSEvent.mouseLocation
        let dx = m.x - startMouse.x, dy = m.y - startMouse.y
        let sw = startFrame.width
        var w: CGFloat
        switch edge {
        case .right: w = sw + dx
        case .left: w = sw - dx
        case .top: w = sw + dy / a
        case .bottom: w = sw - dy / a
        case .topRight, .bottomRight, .topLeft, .bottomLeft:
            let wx = (edge == .topRight || edge == .bottomRight) ? sw + dx : sw - dx
            let wy = (edge == .topRight || edge == .topLeft) ? sw + dy / a : sw - dy / a
            w = abs(wx - sw) >= abs(wy - sw) ? wx : wy
        }
        let lim = limits()
        w = max(lim.min, min(lim.max, w))
        let h = w * a
        var f = NSRect(x: 0, y: 0, width: w.rounded(), height: h.rounded())
        switch edge {
        case .left, .topLeft, .bottomLeft: f.origin.x = startFrame.maxX - f.width
        case .right, .topRight, .bottomRight: f.origin.x = startFrame.minX
        case .top, .bottom: f.origin.x = startFrame.midX - f.width / 2
        }
        switch edge {
        case .top, .topLeft, .topRight: f.origin.y = startFrame.minY
        case .bottom, .bottomLeft, .bottomRight: f.origin.y = startFrame.maxY - f.height
        case .left, .right: f.origin.y = startFrame.midY - f.height / 2
        }
        win.setFrame(f, display: true)
    }
}


// MARK: - Drop overlay and toast (controls layer, so they use glass)

/// Shown while files are dragged over the window.
final class DropOverlay: NSView {
    private var visible = false
    private let card: NSView
    private let ring = CAShapeLayer()

    override init(frame: NSRect) {
        let content = NSView(frame: NSRect(x: 0, y: 0, width: 232, height: 128))
        let icon = NSImageView(image: NSImage(systemSymbolName: "arrow.down.doc.fill", accessibilityDescription: nil) ?? NSImage())
        icon.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 30, weight: .regular)
            .applying(NSImage.SymbolConfiguration(paletteColors: [.white]))
        icon.frame = NSRect(x: 96, y: 74, width: 40, height: 38)
        let title = makeLabel("Drop to Send to Phone", size: 14, weight: .semibold, align: .center)
        title.frame = NSRect(x: 8, y: 46, width: 216, height: 20)
        let sub = makeLabel("Apps (.apk) are installed.\nOther files go to Downloads.", size: 12, color: Palette.secondary, align: .center, wraps: true)
        sub.frame = NSRect(x: 12, y: 8, width: 208, height: 34)
        [icon, title, sub].forEach { content.addSubview($0) }
        card = Glass.wrap(content, radius: 22)
        card.frame.size = NSSize(width: 232, height: 128)
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = NSColor(white: 0, alpha: 0.42).cgColor
        ring.fillColor = nil
        ring.strokeColor = NSColor.controlAccentColor.withAlphaComponent(0.9).cgColor
        ring.lineWidth = 2.5
        ring.lineDashPattern = [9, 7]
        layer?.addSublayer(ring)
        addSubview(card)
        layer?.opacity = 0
        setAccessibilityElement(false)
    }
    required init?(coder: NSCoder) { fatalError() }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }  // never steals drags or clicks

    override func layout() {
        super.layout()
        card.frame.origin = NSPoint(x: (bounds.width - card.frame.width) / 2, y: (bounds.height - card.frame.height) / 2)
        CALayer.withoutAnimation {
            ring.frame = bounds
            ring.path = CGPath(roundedRect: bounds.insetBy(dx: 14, dy: 14), cornerWidth: 18, cornerHeight: 18, transform: nil)
        }
    }

    func setVisible(_ on: Bool) {
        guard on != visible, let l = layer else { return }
        visible = on
        l.animate("opacity", to: Float(on ? 1 : 0), duration: Motion.reduced ? 0.01 : (on ? 0.22 : 0.18), key: "fade")
    }
}

/// A small glass capsule at the bottom: progress while sending, then the result.
final class Toast: NSView {
    private var shown = false
    private var hideTimer: Timer?
    private let icon = NSImageView()
    private let spinner = NSProgressIndicator()
    private let label = makeLabel("", size: 13, weight: .medium, color: .white)
    private let content = NSView()
    private var glass: NSView!

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        icon.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 14, weight: .semibold)
        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.isIndeterminate = true
        spinner.appearance = NSAppearance(named: .darkAqua)
        label.lineBreakMode = .byTruncatingMiddle
        [icon, spinner, label].forEach { content.addSubview($0) }
        glass = Glass.wrap(content, radius: 20)
        addSubview(glass)
        layer?.opacity = 0
    }
    required init?(coder: NSCoder) { fatalError() }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    /// `busy` shows a spinner; otherwise `symbol` (tinted by `tint`). `autoHide` seconds, or nil to stay.
    func show(_ text: String, symbol: String? = nil, tint: NSColor = .white, busy: Bool = false, autoHide: TimeInterval? = nil) {
        hideTimer?.invalidate()
        label.stringValue = text
        icon.isHidden = busy || symbol == nil
        icon.image = symbol.flatMap { NSImage(systemSymbolName: $0, accessibilityDescription: nil) }
        icon.contentTintColor = tint
        spinner.isHidden = !busy
        busy ? spinner.startAnimation(nil) : spinner.stopAnimation(nil)
        setAccessibilityLabel(text)
        needsLayout = true
        layoutSubtreeIfNeeded()
        setVisible(true)
        if let t = autoHide {
            hideTimer = Timer.scheduledTimer(withTimeInterval: t, repeats: false) { [weak self] _ in self?.setVisible(false) }
        }
    }

    override func layout() {
        super.layout()
        let lead: CGFloat = (icon.isHidden && spinner.isHidden) ? 0 : 24
        let maxLabel = max(80, bounds.width - 32 - 36 - lead)
        label.sizeToFit()
        let lw = min(label.frame.width, maxLabel)
        let w = 18 + lead + lw + 18
        let h: CGFloat = 40
        content.frame = NSRect(x: 0, y: 0, width: w, height: h)
        glass.frame = NSRect(x: ((bounds.width - w) / 2).rounded(), y: 18, width: w, height: h)
        icon.frame = NSRect(x: 16, y: (h - 20) / 2, width: 20, height: 20)
        spinner.frame = NSRect(x: 18, y: (h - 16) / 2, width: 16, height: 16)
        label.frame = NSRect(x: 18 + lead, y: (h - 18) / 2, width: lw, height: 18)
    }

    func setVisible(_ on: Bool) {
        guard let l = layer else { return }
        if on == shown && on == false { return }
        shown = on
        if Motion.reduced {
            l.animate("opacity", to: Float(on ? 1 : 0), duration: 0.15, key: "fade")
            return
        }
        if on {
            l.animate("opacity", to: Float(1), duration: 0.25, key: "fade")
            l.spring("transform.translation.y", to: CGFloat(0), stiffness: 260, damping: 24, key: "slide")
        } else {
            l.animate("opacity", to: Float(0), duration: 0.3, timing: Motion.easeInOut, key: "fade")
            l.animate("transform.translation.y", to: CGFloat(-6), duration: 0.3, timing: Motion.easeInOut, key: "slide")
        }
    }
}

// MARK: - Root view (rounded phone-shaped surface)

final class RootView: NSView {
    enum Mode { case connect, streaming }
    let mirror = MirrorView()
    let connect = ConnectView()
    let bar = ChromeBar(frame: .zero)
    let dropOverlay = DropOverlay(frame: .zero)
    let toast = Toast(frame: .zero)
    /// Called with the files dropped onto the window while mirroring.
    var onDrop: (([URL]) -> Void)?
    private var nearTop = false
    private var touching = false
    private var hideTimer: Timer?
    private(set) var mode: Mode = .connect
    /// Matches the corner radius macOS gives its own windows (measured on this system: ~16 pt, independent of size).
    static let cornerRadius: CGFloat = 16
    var aspect: () -> CGFloat = { 2.2 } { didSet { handles.forEach { $0.aspect = aspect } } }
    var limits: () -> (min: CGFloat, max: CGFloat) = { (280, 1200) } { didSet { handles.forEach { $0.limits = limits } } }
    private let handles: [ResizeHandle] = [.left, .right, .top, .bottom, .topLeft, .topRight, .bottomLeft, .bottomRight].map { ResizeHandle(edge: $0) }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.masksToBounds = true
        layer?.cornerCurve = .continuous
        layer?.borderWidth = 0.5
        layer?.borderColor = NSColor(white: 1, alpha: 0.16).cgColor
        addSubview(connect)
        addSubview(mirror)
        addSubview(dropOverlay)
        addSubview(toast)
        addSubview(bar)
        handles.forEach { addSubview($0) }
        registerForDraggedTypes([.fileURL])
        mirror.isHidden = true
        mirror.alphaValue = 0
        // While a finger is down on the phone (for example pulling the notification panel down), the controls step aside.
        mirror.onTouch = { [weak self] down in
            guard let self = self, self.mode == .streaming else { return }
            self.touching = down
            if down {
                self.hideTimer?.invalidate(); self.hideTimer = nil
                self.nearTop = false
                self.bar.setVisible(false)
            }
        }
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseMoved, .mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self))
    }
    required init?(coder: NSCoder) { fatalError() }
    override var mouseDownCanMoveWindow: Bool { false }

    override func layout() {
        super.layout()
        layer?.cornerRadius = RootView.cornerRadius
        mirror.frame = bounds
        connect.frame = bounds
        bar.frame = NSRect(x: 0, y: bounds.height - ChromeBar.height, width: bounds.width, height: ChromeBar.height)
        dropOverlay.frame = bounds
        toast.frame = NSRect(x: 0, y: 0, width: bounds.width, height: 84)
        layoutHandles()
        window?.invalidateShadow()
    }

    private func layoutHandles() {
        let e: CGFloat = 6, c: CGFloat = 14, w = bounds.width, h = bounds.height
        for hd in handles {
            switch hd.edge {
            case .left: hd.frame = NSRect(x: 0, y: c, width: e, height: h - 2 * c)
            case .right: hd.frame = NSRect(x: w - e, y: c, width: e, height: h - 2 * c)
            case .bottom: hd.frame = NSRect(x: c, y: 0, width: w - 2 * c, height: e)
            case .top: hd.frame = NSRect(x: c, y: h - e, width: w - 2 * c, height: e)
            case .bottomLeft: hd.frame = NSRect(x: 0, y: 0, width: c, height: c)
            case .bottomRight: hd.frame = NSRect(x: w - c, y: 0, width: c, height: c)
            case .topLeft: hd.frame = NSRect(x: 0, y: h - c, width: c, height: c)
            case .topRight: hd.frame = NSRect(x: w - c, y: h - c, width: c, height: c)
            }
            hd.window?.invalidateCursorRects(for: hd)
        }
    }

    /// A transform that scales `v` about its centre, whatever anchor point AppKit gave its layer.
    private func zoomTransform(_ v: NSView, _ k: CGFloat) -> CATransform3D {
        guard let l = v.layer else { return CATransform3DIdentity }
        let w = l.bounds.width, h = l.bounds.height
        let tx = (w / 2 - l.anchorPoint.x * w) * (1 - k)
        let ty = (h / 2 - l.anchorPoint.y * h) * (1 - k)
        return CATransform3DScale(CATransform3DMakeTranslation(tx, ty, 0), k, k, 1)
    }

    /// Connect <-> mirroring, in the manner of an iOS app opening: the new screen zooms in from slightly smaller on a
    /// spring with a hint of overshoot while the old one drifts toward the viewer and fades. Reversed on the way back.
    func setMode(_ m: Mode) {
        guard m != mode else { return }
        mode = m
        touching = false
        let slow = Float(ProcessInfo.processInfo.environment["AM_SLOW"] ?? "") ?? 1  // test only: slow-motion factor
        let reduce = Motion.reduced
        let streaming = (m == .streaming)
        let incoming: NSView = streaming ? mirror : connect
        let outgoing: NSView = streaming ? connect : mirror
        guard let inL = incoming.layer, let outL = outgoing.layer else { return }

        incoming.isHidden = false
        outgoing.isHidden = false
        hideTimer?.invalidate(); hideTimer = nil
        if streaming {
            bar.setVisible(true)
            scheduleHide(after: 2.4 * Double(slow))
        } else {
            nearTop = false
            bar.setVisible(true)
        }
        // keep the incoming screen above the outgoing one while it animates
        addSubview(incoming, positioned: .below, relativeTo: dropOverlay)

        // Starting state, applied without any implicit animation. Every animation below names its own start value:
        // reading it back from the presentation layer would return the stale pre-change value and the zoom would not play.
        let inStart: CGFloat = streaming ? 0.9 : 1.12    // mirroring grows from smaller; connect settles back from larger
        let outEnd: CGFloat = streaming ? 1.16 : 0.92    // connect flies toward you; mirroring recedes
        let inFrom = reduce ? CATransform3DIdentity : zoomTransform(incoming, inStart)
        CALayer.withoutAnimation {
            inL.opacity = 0
            inL.transform = inFrom
            outL.opacity = 1
            outL.transform = CATransform3DIdentity
            inL.speed = 1 / slow; outL.speed = 1 / slow
        }
        func tween(_ l: CALayer, _ kp: String, from: Any, to: Any, _ dur: CFTimeInterval, _ timing: CAMediaTimingFunction) {
            l.setValue(to, forKeyPath: kp)
            let a = CABasicAnimation(keyPath: kp)
            a.fromValue = from; a.toValue = to; a.duration = dur; a.timingFunction = timing
            l.add(a, forKey: kp + ".enter")
        }
        let standard = CAMediaTimingFunction(controlPoints: 0.25, 0.1, 0.25, 1)
        if reduce {
            tween(inL, "opacity", from: Float(0), to: Float(1), 0.2, standard)
            tween(outL, "opacity", from: Float(1), to: Float(0), 0.2, standard)
        } else {
            tween(inL, "opacity", from: Float(0), to: Float(1), 0.42, standard)
            // iOS-like spring: ~0.55 s response, a little overshoot
            inL.setValue(NSValue(caTransform3D: CATransform3DIdentity), forKeyPath: "transform")
            let sp = CASpringAnimation(keyPath: "transform")
            sp.fromValue = NSValue(caTransform3D: inFrom)
            sp.toValue = NSValue(caTransform3D: CATransform3DIdentity)
            sp.mass = 1; sp.stiffness = 150; sp.damping = 19
            sp.duration = sp.settlingDuration
            inL.add(sp, forKey: "transform.enter")
            // the outgoing screen leaves while the new one is already coming in
            tween(outL, "opacity", from: Float(1), to: Float(0), 0.38, Motion.easeInOut)
            tween(outL, "transform", from: NSValue(caTransform3D: CATransform3DIdentity),
                  to: NSValue(caTransform3D: zoomTransform(outgoing, outEnd)), 0.5, Motion.easeInOut)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.1 * Double(slow)) { [weak self] in
            guard let self = self, self.mode == m else { return }
            CALayer.withoutAnimation {
                inL.speed = 1; outL.speed = 1
                inL.removeAllAnimations(); outL.removeAllAnimations()
                inL.opacity = 1; inL.transform = CATransform3DIdentity
                outL.opacity = 1; outL.transform = CATransform3DIdentity
            }
            outgoing.isHidden = true
            incoming.alphaValue = 1
            outgoing.alphaValue = 1
        }
    }

    // MARK: drag and drop of files from the Mac

    private func fileURLs(_ info: NSDraggingInfo) -> [URL] {
        (info.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL]) ?? []
    }
    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        if ProcessInfo.processInfo.environment["AM_DEBUG"] != nil { NSLog("AndroidMirroring: drag entered mode=\(mode) files=\(fileURLs(sender).count)") }
        guard mode == .streaming, !fileURLs(sender).isEmpty else { return [] }  // only while mirroring
        dropOverlay.setVisible(true)
        return .copy
    }
    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation { mode == .streaming ? .copy : [] }
    override func draggingExited(_ sender: NSDraggingInfo?) { dropOverlay.setVisible(false) }
    override func draggingEnded(_ sender: NSDraggingInfo) { dropOverlay.setVisible(false) }
    override func prepareForDragOperation(_ sender: NSDraggingInfo) -> Bool { mode == .streaming }
    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        dropOverlay.setVisible(false)
        let urls = fileURLs(sender)
        if ProcessInfo.processInfo.environment["AM_DEBUG"] != nil { NSLog("AndroidMirroring: drop \(urls.map { $0.lastPathComponent })") }
        guard mode == .streaming, !urls.isEmpty else { return false }
        onDrop?(urls)
        return true
    }

    override func mouseMoved(with event: NSEvent) {
        guard mode == .streaming, !touching else { return }
        let p = convert(event.locationInWindow, from: nil)
        if p.y > bounds.height - (ChromeBar.height + 14) {
            hideTimer?.invalidate()
            hideTimer = nil
            nearTop = true
            bar.setVisible(true)
        } else if nearTop && hideTimer == nil {
            nearTop = false
            scheduleHide(after: 0.7)
        }
    }
    override func mouseExited(with event: NSEvent) {
        if mode == .streaming { nearTop = false; scheduleHide(after: 0.5) }
    }
    private func scheduleHide(after t: TimeInterval) {
        hideTimer?.invalidate()
        hideTimer = Timer.scheduledTimer(withTimeInterval: t, repeats: false) { [weak self] _ in
            guard let self = self else { return }
            self.hideTimer = nil
            if self.mode == .streaming && !self.nearTop { self.bar.setVisible(false) }
        }
    }
}

final class MirrorWindow: NSWindow {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}
