// The connect screen. Built from Apple's HIG: grouped inset lists, one prominent default button,
// labelled fields, a hero that earns its place, and motion that is brief and optional.

import AppKit

struct DeviceInfo: Equatable {
    var serial: String
    var state: String
    var model: String
}

/// Text colors are tuned for contrast on the dark surface (secondary ≈ 7:1, tertiary ≈ 5.5:1; HIG asks for 4.5:1).
enum Palette {
    static let secondary = NSColor(white: 1, alpha: 0.64)
    static let tertiary = NSColor(white: 1, alpha: 0.54)
    static let cardFill = NSColor(white: 1, alpha: 0.075)
    static let hairline = NSColor(white: 1, alpha: 0.10)
    static let red = NSColor(srgbRed: 1.0, green: 0.45, blue: 0.42, alpha: 1)
    static let green = NSColor(srgbRed: 0.36, green: 0.86, blue: 0.52, alpha: 1)
    static let orange = NSColor(srgbRed: 1.0, green: 0.72, blue: 0.30, alpha: 1)
}

/// A wrapping label that measures its height using the width it is actually given (otherwise the last line gets clipped).
final class WrapLabel: NSTextField {
    override func layout() {
        super.layout()
        if bounds.width > 0, abs(preferredMaxLayoutWidth - bounds.width) > 0.5 {
            preferredMaxLayoutWidth = bounds.width
            invalidateIntrinsicContentSize()
        }
    }
}

func makeLabel(_ s: String, size: CGFloat, weight: NSFont.Weight = .regular, color: NSColor = .white, align: NSTextAlignment = .left, wraps: Bool = false) -> NSTextField {
    let f = wraps ? WrapLabel(wrappingLabelWithString: s) : NSTextField(labelWithString: s)
    f.font = .systemFont(ofSize: size, weight: weight)
    f.textColor = color
    f.alignment = align
    f.isSelectable = false
    return f
}

// MARK: - Building blocks

/// Top-down coordinates, and dragging the empty background moves the window.
final class FlippedView: NSView {
    override var isFlipped: Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with event: NSEvent) { window?.performDrag(with: event) }
}

/// A grouped, inset container: rows separated by hairlines. Content only — never glass (HIG: glass is for the controls layer).
final class Card: NSView {
    private let stack = NSStackView()

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.cornerRadius = 12
        layer?.cornerCurve = .continuous
        layer?.masksToBounds = true
        layer?.backgroundColor = Palette.cardFill.cgColor
        layer?.borderWidth = 0.5
        layer?.borderColor = Palette.hairline.cgColor
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 0
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }
    required init?(coder: NSCoder) { fatalError() }
    override var mouseDownCanMoveWindow: Bool { false }

    func setRows(_ rows: [NSView]) {
        stack.arrangedSubviews.forEach { stack.removeArrangedSubview($0); $0.removeFromSuperview() }
        for (i, r) in rows.enumerated() {
            if i > 0 {
                let sep = NSView()
                sep.wantsLayer = true
                sep.layer?.backgroundColor = Palette.hairline.cgColor
                sep.translatesAutoresizingMaskIntoConstraints = false
                stack.addArrangedSubview(sep)
                NSLayoutConstraint.activate([
                    sep.heightAnchor.constraint(equalToConstant: 0.5),
                    sep.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -16),
                ])
                stack.setCustomSpacing(0, after: sep)
                // inset the separator from the leading edge like a native list
                sep.leadingAnchor.constraint(equalTo: stack.leadingAnchor, constant: 16).isActive = true
            }
            stack.addArrangedSubview(r)
            r.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }
    }

    /// The card's edge lights up in the accent color while a field inside it is being edited.
    func setFocused(_ on: Bool) {
        guard let l = layer else { return }
        let color = on ? NSColor.controlAccentColor.withAlphaComponent(0.85) : Palette.hairline
        let width: CGFloat = on ? 1.5 : 0.5
        l.animate("borderColor", to: color.cgColor, duration: Motion.reduced ? 0.01 : 0.2, key: "bc")
        l.animate("borderWidth", to: width, duration: Motion.reduced ? 0.01 : 0.2, key: "bw")
    }
}

/// Borderless text field that lives inside a Card row.
final class PlainField: NSTextField {
    var onFocus: ((Bool) -> Void)?
    var onChange: (() -> Void)?

    init(placeholder: String) {
        super.init(frame: .zero)
        isBordered = false
        drawsBackground = false
        focusRingType = .none
        font = .monospacedDigitSystemFont(ofSize: 13, weight: .regular)
        textColor = .white
        usesSingleLineMode = true
        cell?.isScrollable = true
        cell?.wraps = false
        lineBreakMode = .byTruncatingTail
        placeholderAttributedString = NSAttributedString(string: placeholder, attributes: [
            .foregroundColor: Palette.tertiary,
            .font: NSFont.monospacedDigitSystemFont(ofSize: 13, weight: .regular),
        ])
    }
    required init?(coder: NSCoder) { fatalError() }
    override var mouseDownCanMoveWindow: Bool { false }
    override func becomeFirstResponder() -> Bool {
        let r = super.becomeFirstResponder()
        if r { onFocus?(true) }
        return r
    }
    override func textDidEndEditing(_ notification: Notification) {
        super.textDidEndEditing(notification)
        onFocus?(false)
    }
    override func textDidChange(_ notification: Notification) {
        super.textDidChange(notification)
        onChange?()
    }
}

/// "Address  [ field ]  (x)" — a labelled field row with a clear button at the trailing end.
final class FieldRow: NSView {
    static let labelWidth: CGFloat = 64
    let field: PlainField
    private let clear = NSButton()

    init(title: String, placeholder: String, card: @escaping () -> Card?) {
        field = PlainField(placeholder: placeholder)
        super.init(frame: .zero)
        let label = makeLabel(title, size: 13, weight: .medium, color: NSColor(white: 1, alpha: 0.92))
        label.setContentHuggingPriority(.required, for: .horizontal)
        clear.isBordered = false
        clear.refusesFirstResponder = true  // Tab goes field to field; the clear button is for the pointer (and VoiceOver)
        clear.image = NSImage(systemSymbolName: "xmark.circle.fill", accessibilityDescription: "Clear")
        clear.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 13, weight: .regular)
        clear.contentTintColor = Palette.tertiary
        clear.imagePosition = .imageOnly
        clear.isHidden = true
        clear.target = self
        clear.action = #selector(clearTapped)
        clear.setAccessibilityLabel("Clear \(title)")
        field.setAccessibilityLabel(title)
        field.onFocus = { on in card()?.setFocused(on) }
        field.onChange = { [weak self] in self?.refreshClear() }

        let row = NSStackView(views: [label, field, clear])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 8
        row.edgeInsets = NSEdgeInsets(top: 0, left: 16, bottom: 0, right: 12)
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)
        label.widthAnchor.constraint(equalToConstant: FieldRow.labelWidth).isActive = true
        field.setContentHuggingPriority(.defaultLow, for: .horizontal)
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: leadingAnchor),
            row.trailingAnchor.constraint(equalTo: trailingAnchor),
            row.topAnchor.constraint(equalTo: topAnchor),
            row.bottomAnchor.constraint(equalTo: bottomAnchor),
            heightAnchor.constraint(equalToConstant: 46),
        ])
    }
    required init?(coder: NSCoder) { fatalError() }
    override var mouseDownCanMoveWindow: Bool { false }
    /// Clicking anywhere on the row focuses the field.
    override func mouseDown(with event: NSEvent) { window?.makeFirstResponder(field) }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    func refreshClear() { clear.isHidden = field.stringValue.isEmpty || !field.isEnabled }
    @objc private func clearTapped() {
        field.stringValue = ""
        refreshClear()
        window?.makeFirstResponder(field)
    }
    func setEnabled(_ on: Bool) { field.isEnabled = on; refreshClear() }
}

/// "Sound  [ Phone | Mac ]" with a one-line explanation that follows the choice.
final class SoundRow: NSView {
    let control = NSSegmentedControl(labels: ["Phone", "Mac"], trackingMode: .selectOne, target: nil, action: nil)
    private let detail = makeLabel("", size: 12, color: Palette.tertiary)

    init() {
        super.init(frame: .zero)
        let title = makeLabel("Sound", size: 13, weight: .medium, color: NSColor(white: 1, alpha: 0.92))
        detail.lineBreakMode = .byTruncatingTail
        let texts = NSStackView(views: [title, detail])
        texts.orientation = .vertical
        texts.alignment = .leading
        texts.spacing = 1
        texts.setContentHuggingPriority(.defaultLow, for: .horizontal)
        control.segmentStyle = .rounded
        control.controlSize = .regular
        control.selectedSegment = 0
        control.setWidth(58, forSegment: 0)
        control.setWidth(58, forSegment: 1)
        control.setAccessibilityLabel("Play sound on")
        control.setContentHuggingPriority(.required, for: .horizontal)
        let row = NSStackView(views: [texts, control])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 8
        row.edgeInsets = NSEdgeInsets(top: 0, left: 16, bottom: 0, right: 12)
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: leadingAnchor),
            row.trailingAnchor.constraint(equalTo: trailingAnchor),
            row.topAnchor.constraint(equalTo: topAnchor),
            row.bottomAnchor.constraint(equalTo: bottomAnchor),
            heightAnchor.constraint(equalToConstant: 52),
        ])
        refresh()
    }
    required init?(coder: NSCoder) { fatalError() }
    override var mouseDownCanMoveWindow: Bool { false }
    func refresh() {
        detail.stringValue = control.selectedSegment == 1 ? "Plays on this Mac" : "Plays on your phone"
    }
}

/// One detected phone: tinted badge, name, serial, and a trailing status.
final class DeviceRow: NSView {
    let serial: String
    var onClick: ((String) -> Void)?
    private let ready: Bool
    private let highlight = CALayer()

    init(device: DeviceInfo) {
        serial = device.serial
        ready = device.state == "device"
        super.init(frame: .zero)
        wantsLayer = true
        highlight.backgroundColor = NSColor(white: 1, alpha: 0.09).cgColor
        highlight.opacity = 0
        layer?.addSublayer(highlight)

        let name = device.model.isEmpty ? "Android phone" : device.model
        let badge = NSView()
        badge.wantsLayer = true
        badge.translatesAutoresizingMaskIntoConstraints = false
        let grad = CAGradientLayer()
        grad.colors = ready
            ? [NSColor(srgbRed: 0.34, green: 0.62, blue: 1.0, alpha: 1).cgColor, NSColor(srgbRed: 0.10, green: 0.38, blue: 0.95, alpha: 1).cgColor]
            : [NSColor(white: 0.42, alpha: 1).cgColor, NSColor(white: 0.30, alpha: 1).cgColor]
        grad.startPoint = CGPoint(x: 0.5, y: 1); grad.endPoint = CGPoint(x: 0.5, y: 0)
        grad.frame = CGRect(x: 0, y: 0, width: 34, height: 34)
        grad.cornerRadius = 9
        grad.cornerCurve = .continuous
        badge.layer?.addSublayer(grad)
        let glyph = NSImageView(image: NSImage(systemSymbolName: "candybarphone", accessibilityDescription: nil)
                                ?? NSImage(systemSymbolName: "iphone", accessibilityDescription: nil) ?? NSImage())
        glyph.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 16, weight: .medium)
        glyph.contentTintColor = .white
        glyph.translatesAutoresizingMaskIntoConstraints = false
        badge.addSubview(glyph)
        NSLayoutConstraint.activate([
            badge.widthAnchor.constraint(equalToConstant: 34), badge.heightAnchor.constraint(equalToConstant: 34),
            glyph.centerXAnchor.constraint(equalTo: badge.centerXAnchor), glyph.centerYAnchor.constraint(equalTo: badge.centerYAnchor),
        ])

        let title = makeLabel(name, size: 13, weight: .semibold, color: NSColor(white: 1, alpha: ready ? 1 : 0.6))
        title.lineBreakMode = .byTruncatingTail
        let sub = makeLabel(DeviceRow.readableSerial(device.serial), size: 12, color: Palette.tertiary)
        sub.lineBreakMode = .byTruncatingMiddle  // keeps both ends of long serials readable
        for l in [title, sub] {
            l.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            l.setContentHuggingPriority(.defaultLow, for: .horizontal)
        }
        let texts = NSStackView(views: [title, sub])
        texts.orientation = .vertical
        texts.alignment = .leading
        texts.spacing = 1
        texts.setContentHuggingPriority(.defaultLow, for: .horizontal)
        texts.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let trailing: NSView
        if ready {
            let chev = NSImageView(image: NSImage(systemSymbolName: "chevron.right", accessibilityDescription: nil) ?? NSImage())
            chev.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 11, weight: .semibold)
            chev.contentTintColor = Palette.tertiary
            trailing = chev
        } else {
            let t = device.state == "unauthorized" ? "Allow on phone" : device.state.capitalized
            trailing = makeLabel(t, size: 12, weight: .medium, color: Palette.orange)
        }
        trailing.setContentHuggingPriority(.required, for: .horizontal)
        trailing.setContentCompressionResistancePriority(.required, for: .horizontal)

        let row = NSStackView(views: [badge, texts, trailing])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 12
        row.edgeInsets = NSEdgeInsets(top: 0, left: 14, bottom: 0, right: 14)
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: leadingAnchor),
            row.trailingAnchor.constraint(equalTo: trailingAnchor),
            row.topAnchor.constraint(equalTo: topAnchor),
            row.bottomAnchor.constraint(equalTo: bottomAnchor),
            heightAnchor.constraint(equalToConstant: 58),
        ])
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self))
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityLabel(ready ? "\(name), connect" : "\(name), \(device.state)")
    }
    required init?(coder: NSCoder) { fatalError() }
    /// Wireless-debugging phones are listed as "adb-<serial>-<id>._adb-tls-connect._tcp"; show them as "Wireless · <serial>".
    static func readableSerial(_ s: String) -> String {
        guard let r = s.range(of: "._adb-tls-connect._tcp") else { return s }
        var core = String(s[..<r.lowerBound])
        if core.hasPrefix("adb-") { core.removeFirst(4) }
        return "Wireless · " + core
    }
    override var mouseDownCanMoveWindow: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func layout() { super.layout(); CALayer.withoutAnimation { highlight.frame = bounds } }
    override func resetCursorRects() { if ready { addCursorRect(bounds, cursor: .pointingHand) } }

    private func setHighlight(_ v: Float, _ d: CFTimeInterval) {
        highlight.animate("opacity", to: v, duration: Motion.reduced ? 0.01 : d, key: "hl")
    }
    override func mouseEntered(with event: NSEvent) { if ready { setHighlight(0.6, 0.15) } }
    override func mouseExited(with event: NSEvent) { setHighlight(0, 0.25) }
    override func mouseDown(with event: NSEvent) { if ready { setHighlight(1, 0.05) } }
    override func mouseUp(with event: NSEvent) {
        guard ready else { return }
        setHighlight(0.6, 0.2)
        if bounds.contains(convert(event.locationInWindow, from: nil)) { onClick?(serial) }
    }
}

/// Shown instead of rows when nothing is plugged in.
final class EmptyDevicesRow: NSView {
    init() {
        super.init(frame: .zero)
        let icon = NSImageView(image: NSImage(systemSymbolName: "cable.connector", accessibilityDescription: nil) ?? NSImage())
        icon.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 18, weight: .regular)
        icon.contentTintColor = Palette.tertiary
        let title = makeLabel("No phones found", size: 13, weight: .medium, color: NSColor(white: 1, alpha: 0.9))
        let sub = makeLabel("Plug one in with USB, or use an address below.", size: 12, color: Palette.tertiary)
        sub.lineBreakMode = .byTruncatingTail
        let texts = NSStackView(views: [title, sub])
        texts.orientation = .vertical
        texts.alignment = .leading
        texts.spacing = 1
        let row = NSStackView(views: [icon, texts])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 12
        row.edgeInsets = NSEdgeInsets(top: 0, left: 16, bottom: 0, right: 14)
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: leadingAnchor),
            row.trailingAnchor.constraint(equalTo: trailingAnchor),
            row.topAnchor.constraint(equalTo: topAnchor),
            row.bottomAnchor.constraint(equalTo: bottomAnchor),
            heightAnchor.constraint(equalToConstant: 58),
        ])
    }
    required init?(coder: NSCoder) { fatalError() }
    override var mouseDownCanMoveWindow: Bool { false }
}

/// Inline status message: icon centred on the first line of text, even padding, tinted by tone.
/// The icon always accompanies the color, so meaning never rests on color alone.
final class Banner: NSView {
    private let icon = NSImageView()
    private let text = makeLabel("", size: 12, color: .white, wraps: true)

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.cornerRadius = 10
        layer?.cornerCurve = .continuous
        icon.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 13, weight: .semibold)
        icon.setContentHuggingPriority(.required, for: .horizontal)
        icon.setContentCompressionResistancePriority(.required, for: .horizontal)
        icon.translatesAutoresizingMaskIntoConstraints = false
        text.maximumNumberOfLines = 4
        text.translatesAutoresizingMaskIntoConstraints = false
        addSubview(icon)
        addSubview(text)
        NSLayoutConstraint.activate([
            icon.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            icon.widthAnchor.constraint(equalToConstant: 16),
            // the icon sits on the first line's centre, whatever the number of lines
            icon.centerYAnchor.constraint(equalTo: text.firstBaselineAnchor, constant: -4.5),
            text.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 8),
            text.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
            text.topAnchor.constraint(equalTo: topAnchor, constant: 10),
            text.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -10),
        ])
        isHidden = true
    }
    required init?(coder: NSCoder) { fatalError() }
    override var mouseDownCanMoveWindow: Bool { false }

    func show(_ message: String, tone: ConnectView.Tone) {
        guard !message.isEmpty else { isHidden = true; return }
        let (color, symbol): (NSColor, String)
        switch tone {
        case .error: (color, symbol) = (Palette.red, "exclamationmark.circle.fill")
        case .success: (color, symbol) = (Palette.green, "checkmark.circle.fill")
        case .info: (color, symbol) = (NSColor.controlAccentColor.blended(withFraction: 0.35, of: .white) ?? .controlAccentColor, "info.circle.fill")
        }
        icon.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)
        icon.contentTintColor = color
        text.stringValue = message
        text.textColor = NSColor(white: 1, alpha: 0.92)
        layer?.backgroundColor = color.withAlphaComponent(0.14).cgColor
        isHidden = false
        setAccessibilityLabel(message)
    }
}

/// Soft accent glow behind a large symbol; the symbol pulses while a connection is in progress.
final class HeroView: NSView {
    private let glow = CAGradientLayer()
    private let icon = NSImageView()

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.masksToBounds = false
        glow.type = .radial
        glow.startPoint = CGPoint(x: 0.5, y: 0.5)
        glow.endPoint = CGPoint(x: 1, y: 1)
        glow.colors = [NSColor.controlAccentColor.withAlphaComponent(0.34).cgColor, NSColor.controlAccentColor.withAlphaComponent(0).cgColor]
        layer?.addSublayer(glow)
        icon.image = NSImage(systemSymbolName: "iphone.gen3.radiowaves.left.and.right", accessibilityDescription: nil)
        icon.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 54, weight: .light)
            .applying(NSImage.SymbolConfiguration(paletteColors: [.white, NSColor(white: 1, alpha: 0.7)]))
        icon.translatesAutoresizingMaskIntoConstraints = false
        addSubview(icon)
        NSLayoutConstraint.activate([
            icon.centerXAnchor.constraint(equalTo: centerXAnchor),
            icon.centerYAnchor.constraint(equalTo: centerYAnchor),
            widthAnchor.constraint(equalToConstant: 96),
            heightAnchor.constraint(equalToConstant: 84),
        ])
        icon.setAccessibilityElement(false)
    }
    required init?(coder: NSCoder) { fatalError() }
    override var mouseDownCanMoveWindow: Bool { false }
    override func layout() {
        super.layout()
        let d: CGFloat = 230
        CALayer.withoutAnimation { glow.frame = CGRect(x: bounds.midX - d / 2, y: bounds.midY - d / 2, width: d, height: d) }
    }
    func setBusy(_ busy: Bool) {
        guard #available(macOS 14.0, *), !Motion.reduced else { return }
        if busy {
            icon.addSymbolEffect(.variableColor.iterative.reversing, options: .repeating, animated: true)
        } else {
            icon.removeAllSymbolEffects(animated: true)
        }
    }
}

// MARK: - The screen

final class ConnectView: NSView {
    enum Tone { case info, error, success }

    var onConnect: ((String) -> Void)?
    var onPair: ((String, String) -> Void)?
    var onPick: ((String) -> Void)?
    var onCancel: (() -> Void)?
    var onAudioChange: ((Bool) -> Void)?
    var audioOnMac: Bool {
        get { soundRow.control.selectedSegment == 1 }
        set { soundRow.control.selectedSegment = newValue ? 1 : 0; soundRow.refresh() }
    }
    var addressField: PlainField { addressRow.field }

    private let gradient = CAGradientLayer()
    private let scroll = NSScrollView()
    /// Everything is laid out at a fixed 340 pt design width inside this view, whose bounds are scaled to the window,
    /// so small and large windows look exactly alike (no cramped rows, nothing spilling out).
    private let scaled = NSView()
    /// Holds `scaled` and carries the scale (via its bounds). Auto Layout is solved in `scaled`, whose frame equals its
    /// own bounds, so the constraints see the true 340 pt design width. Scaling `scaled` itself would not work:
    /// Auto Layout uses a view's frame size, not its scaled bounds.
    private let scaler = NSView()
    static let designWidth: CGFloat = 340
    static let designHeight: CGFloat = 640
    private let hero = HeroView()
    private let devicesCard = Card()
    private let connectionCard = Card()
    private var addressRow: FieldRow!
    private let soundRow = SoundRow()
    private let connectButton = NSButton(title: "Connect", target: nil, action: nil)
    private let spinner = NSProgressIndicator()
    private let cancelButton = NSButton(title: "Cancel", target: nil, action: nil)
    private let banner = Banner()
    private let pairToggle = NSButton(title: "Pair a New Phone", target: nil, action: nil)
    /// Pairing is its own page (pushed over the connect page, like a navigation stack) instead of an expanding panel, so
    /// nothing has to squeeze in below the other content and nothing can overflow at any window size.
    private var mainPage: NSStackView!
    private let pairPage = NSStackView()
    private let pairCard = Card()
    private let pairBanner = Banner()
    private let backButton = NSButton(title: "Connect", target: nil, action: nil)
    private let pairSpinner = NSProgressIndicator()
    private var mainPin: [NSLayoutConstraint] = []
    private var pairPin: [NSLayoutConstraint] = []
    private var onPairPage = false
    private var pageToken = 0
    private var pairAddressRow: FieldRow!
    private var pairCodeRow: FieldRow!
    private let pairButton = NSButton(title: "Pair", target: nil, action: nil)
    private var devices: [DeviceInfo] = []
    private var locked = false

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        appearance = NSAppearance(named: .darkAqua)
        gradient.colors = [NSColor(srgbRed: 0.13, green: 0.14, blue: 0.18, alpha: 1).cgColor,
                           NSColor(srgbRed: 0.035, green: 0.035, blue: 0.045, alpha: 1).cgColor]
        gradient.startPoint = CGPoint(x: 0.5, y: 1)
        gradient.endPoint = CGPoint(x: 0.5, y: 0)
        layer?.addSublayer(gradient)

        addressRow = FieldRow(title: "Address", placeholder: "192.168.0.101:42799") { [weak self] in self?.connectionCard }
        pairAddressRow = FieldRow(title: "Address", placeholder: "192.168.0.101:37123") { [weak self] in self?.pairCard }
        pairCodeRow = FieldRow(title: "Code", placeholder: "6-digit pairing code") { [weak self] in self?.pairCard }
        connectionCard.setRows([addressRow, soundRow])
        pairCard.setRows([pairAddressRow, pairCodeRow])

        // Primary (default) button: the one most likely action, answers Return.
        connectButton.bezelStyle = .rounded
        connectButton.controlSize = .large
        connectButton.keyEquivalent = "\r"
        connectButton.bezelColor = .controlAccentColor
        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.isIndeterminate = true
        spinner.isHidden = true
        spinner.translatesAutoresizingMaskIntoConstraints = false
        connectButton.addSubview(spinner)
        NSLayoutConstraint.activate([
            spinner.leadingAnchor.constraint(equalTo: connectButton.leadingAnchor, constant: 18),
            spinner.centerYAnchor.constraint(equalTo: connectButton.centerYAnchor),
        ])
        cancelButton.isBordered = false
        cancelButton.font = .systemFont(ofSize: 13, weight: .medium)
        cancelButton.contentTintColor = NSColor.controlAccentColor
        cancelButton.isHidden = true

        pairToggle.isBordered = false
        pairToggle.font = .systemFont(ofSize: 13, weight: .medium)
        pairToggle.contentTintColor = NSColor.controlAccentColor
        pairToggle.image = NSImage(systemSymbolName: "chevron.right", accessibilityDescription: nil)
        pairToggle.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 10, weight: .bold)
        pairToggle.imagePosition = .imageTrailing
        pairToggle.setAccessibilityLabel("Pair a new phone")

        pairButton.bezelStyle = .rounded
        pairButton.controlSize = .large
        pairButton.bezelColor = .controlAccentColor
        pairSpinner.style = .spinning
        pairSpinner.controlSize = .small
        pairSpinner.isIndeterminate = true
        pairSpinner.isHidden = true
        pairSpinner.translatesAutoresizingMaskIntoConstraints = false
        pairButton.addSubview(pairSpinner)
        NSLayoutConstraint.activate([
            pairSpinner.leadingAnchor.constraint(equalTo: pairButton.leadingAnchor, constant: 18),
            pairSpinner.centerYAnchor.constraint(equalTo: pairButton.centerYAnchor),
        ])

        backButton.isBordered = false
        backButton.font = .systemFont(ofSize: 13, weight: .medium)
        backButton.contentTintColor = NSColor.controlAccentColor
        backButton.image = NSImage(systemSymbolName: "chevron.left", accessibilityDescription: nil)
        backButton.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 11, weight: .bold)
        backButton.imagePosition = .imageLeading
        backButton.setAccessibilityLabel("Back to Connect")
        backButton.translatesAutoresizingMaskIntoConstraints = false
        let backRow = NSView()
        backRow.addSubview(backButton)
        NSLayoutConstraint.activate([
            backButton.leadingAnchor.constraint(equalTo: backRow.leadingAnchor, constant: 2),
            backButton.topAnchor.constraint(equalTo: backRow.topAnchor),
            backButton.bottomAnchor.constraint(equalTo: backRow.bottomAnchor),
            backRow.heightAnchor.constraint(equalToConstant: 24),
        ])
        let pairTitle = makeLabel("Pair a New Phone", size: 26, weight: .bold, align: .center)
        let pairSubtitle = makeLabel("Pair once with a code. After that, Connect works without it.", size: 13, color: Palette.secondary, align: .center, wraps: true)
        let help = makeLabel("On the phone: Developer options › Wireless debugging › Pair device with pairing code. Enter the address and 6-digit code it shows.",
                             size: 12, color: Palette.tertiary, wraps: true)
        pairPage.orientation = .vertical
        pairPage.alignment = .centerX
        pairPage.spacing = 8
        [backRow, pairTitle, pairSubtitle, pairCard, pairButton, pairBanner, help].forEach { pairPage.addArrangedSubview($0) }
        pairPage.setCustomSpacing(14, after: backRow)
        pairPage.setCustomSpacing(4, after: pairTitle)
        pairPage.setCustomSpacing(24, after: pairSubtitle)
        pairPage.setCustomSpacing(16, after: pairCard)
        pairPage.setCustomSpacing(12, after: pairButton)
        pairPage.translatesAutoresizingMaskIntoConstraints = false
        pairPage.isHidden = true

        let title = makeLabel("Connect Your Android", size: 26, weight: .bold, align: .center)
        let subtitle = makeLabel("Control your phone from your Mac.", size: 13, color: Palette.secondary, align: .center, wraps: true)

        let phonesHeader = Self.sectionHeader("Phones")
        let connectionHeader = Self.sectionHeader("Connection")

        let main = NSStackView(views: [hero, title, subtitle, phonesHeader, devicesCard, connectionHeader, connectionCard,
                                       connectButton, cancelButton, banner, pairToggle])
        main.orientation = .vertical
        main.alignment = .centerX
        main.spacing = 8
        main.setCustomSpacing(12, after: hero)
        main.setCustomSpacing(4, after: title)
        main.setCustomSpacing(28, after: subtitle)
        main.setCustomSpacing(8, after: phonesHeader)
        main.setCustomSpacing(24, after: devicesCard)
        main.setCustomSpacing(8, after: connectionHeader)
        main.setCustomSpacing(16, after: connectionCard)
        main.setCustomSpacing(8, after: connectButton)
        main.setCustomSpacing(16, after: cancelButton)
        main.setCustomSpacing(12, after: banner)
        main.setCustomSpacing(12, after: pairToggle)
        main.translatesAutoresizingMaskIntoConstraints = false
        mainPage = main

        // Scrolls only when the content cannot fit (small window, or the Pair panel open); otherwise it is centered.
        let doc = FlippedView()
        doc.translatesAutoresizingMaskIntoConstraints = false
        doc.addSubview(main)
        doc.addSubview(pairPage)
        scroll.documentView = doc
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = false
        scroll.hasHorizontalScroller = false
        scroll.verticalScrollElasticity = .automatic
        scroll.horizontalScrollElasticity = .none
        scroll.automaticallyAdjustsContentInsets = false
        scroll.translatesAutoresizingMaskIntoConstraints = false
        addSubview(scaler)
        scaler.addSubview(scaled)
        scaled.addSubview(scroll)
        let clip = scroll.contentView
        NSLayoutConstraint.activate([
            scroll.leadingAnchor.constraint(equalTo: scaled.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: scaled.trailingAnchor),
            scroll.topAnchor.constraint(equalTo: scaled.topAnchor),
            scroll.bottomAnchor.constraint(equalTo: scaled.bottomAnchor),
            doc.leadingAnchor.constraint(equalTo: clip.leadingAnchor),
            doc.trailingAnchor.constraint(equalTo: clip.trailingAnchor),
            doc.topAnchor.constraint(equalTo: clip.topAnchor),
            doc.heightAnchor.constraint(greaterThanOrEqualTo: clip.heightAnchor),
        ])
        // Each page is centred in the scroll view, and the document is at least as tall as the page being shown (so it
        // scrolls only when that page cannot fit). Only the visible page's constraints are active, so a tall hidden page
        // can never fight the shorter one.
        func pin(_ page: NSStackView) -> [NSLayoutConstraint] {
            let lead = page.leadingAnchor.constraint(equalTo: doc.leadingAnchor, constant: 24)
            let trail = page.trailingAnchor.constraint(equalTo: doc.trailingAnchor, constant: -24)
            lead.priority = .defaultHigh; trail.priority = .defaultHigh
            let centered = page.centerYAnchor.constraint(equalTo: doc.centerYAnchor, constant: 18)
            centered.priority = .defaultHigh
            return [
                page.centerXAnchor.constraint(equalTo: doc.centerXAnchor),
                page.widthAnchor.constraint(lessThanOrEqualToConstant: 400),
                // required: long text (a wireless serial, say) must shrink or truncate, never push the page past the edges
                page.leadingAnchor.constraint(greaterThanOrEqualTo: doc.leadingAnchor, constant: 24),
                page.trailingAnchor.constraint(lessThanOrEqualTo: doc.trailingAnchor, constant: -24),
                page.topAnchor.constraint(greaterThanOrEqualTo: doc.topAnchor, constant: 68),
                page.bottomAnchor.constraint(lessThanOrEqualTo: doc.bottomAnchor, constant: -24),
                doc.heightAnchor.constraint(greaterThanOrEqualTo: page.heightAnchor, constant: 92),
                lead, trail, centered,
            ]
        }
        mainPin = pin(main)
        pairPin = pin(pairPage)
        NSLayoutConstraint.activate(mainPin)

        for v in [subtitle, phonesHeader, devicesCard, connectionHeader, connectionCard, connectButton, banner] as [NSView] {
            v.widthAnchor.constraint(equalTo: main.widthAnchor).isActive = true
        }
        for v in [backRow, pairSubtitle, pairCard, pairButton, pairBanner, help] as [NSView] {
            v.widthAnchor.constraint(equalTo: pairPage.widthAnchor).isActive = true
        }

        connectButton.target = self; connectButton.action = #selector(connectTapped)
        addressRow.field.target = self; addressRow.field.action = #selector(connectTapped)
        cancelButton.target = self; cancelButton.action = #selector(cancelTapped)
        pairToggle.target = self; pairToggle.action = #selector(openPair)
        backButton.target = self; backButton.action = #selector(backTapped)
        pairButton.target = self; pairButton.action = #selector(pairTapped)
        pairCodeRow.field.target = self; pairCodeRow.field.action = #selector(pairTapped)
        soundRow.control.target = self; soundRow.control.action = #selector(soundChanged)
        reloadDevices()
    }
    required init?(coder: NSCoder) { fatalError() }
    override var mouseDownCanMoveWindow: Bool { false }
    override func mouseDown(with event: NSEvent) { window?.performDrag(with: event) }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func layout() {
        let k = max(0.6, min(bounds.width / ConnectView.designWidth, bounds.height / ConnectView.designHeight))
        scaler.frame = bounds
        scaler.setBoundsSize(NSSize(width: bounds.width / k, height: bounds.height / k))
        scaled.frame = NSRect(origin: .zero, size: scaler.bounds.size)
        CALayer.withoutAnimation { gradient.frame = bounds }
        super.layout()
    }

    /// A section title above a card, aligned with the card's text rather than its edge.
    static func sectionHeader(_ s: String) -> NSView {
        let box = NSView()
        let l = makeLabel(s, size: 12, weight: .semibold, color: Palette.secondary)
        l.translatesAutoresizingMaskIntoConstraints = false
        box.addSubview(l)
        NSLayoutConstraint.activate([
            l.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: 4),
            l.trailingAnchor.constraint(lessThanOrEqualTo: box.trailingAnchor),
            l.topAnchor.constraint(equalTo: box.topAnchor),
            l.bottomAnchor.constraint(equalTo: box.bottomAnchor),
        ])
        return box
    }

    // MARK: actions

    @objc private func connectTapped() {
        guard !locked else { return }
        if addressRow.field.stringValue.trimmingCharacters(in: .whitespaces).isEmpty { window?.makeFirstResponder(addressRow.field) }
        onConnect?(addressRow.field.stringValue)
    }
    @objc private func cancelTapped() { onCancel?() }
    @objc private func pairTapped() {
        guard !locked else { return }
        let a = pairAddressRow.field, c = pairCodeRow.field
        if a.stringValue.trimmingCharacters(in: .whitespaces).isEmpty { window?.makeFirstResponder(a); return }
        if c.stringValue.trimmingCharacters(in: .whitespaces).isEmpty { window?.makeFirstResponder(c); return }
        onPair?(a.stringValue, c.stringValue)
    }
    @objc private func soundChanged() { soundRow.refresh(); onAudioChange?(audioOnMac) }
    @objc private func openPair() { showPairPage(true) }
    @objc private func backTapped() {
        if locked { onCancel?() }  // leaving while pairing abandons it
        showPairPage(false)
    }

    /// Swaps between the connect page and the pair page: the old page fades out, then the new one fades in, so the two
    /// are never on screen together and nothing is animated through Auto Layout.
    func showPairPage(_ show: Bool) {
        guard show != onPairPage else { return }
        onPairPage = show
        pageToken += 1
        let token = pageToken
        let from: NSView = show ? mainPage : pairPage
        let to: NSView = show ? pairPage : mainPage
        let fromPin = show ? mainPin : pairPin
        let toPin = show ? pairPin : mainPin
        connectButton.keyEquivalent = show ? "" : "\r"
        pairButton.keyEquivalent = show ? "\r" : ""
        pairBanner.show("", tone: .info)

        func finish() {
            guard token == self.pageToken else { return }
            from.isHidden = true
            from.alphaValue = 1
            NSLayoutConstraint.deactivate(fromPin)
            NSLayoutConstraint.activate(toPin)
            self.scroll.contentView.scroll(to: .zero)
            self.scroll.reflectScrolledClipView(self.scroll.contentView)
            to.alphaValue = Motion.reduced ? 1 : 0
            to.isHidden = false
            self.layoutSubtreeIfNeeded()
            self.window?.makeFirstResponder(show ? self.pairAddressRow.field : self.addressRow.field)
            guard !Motion.reduced else { return }
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.24
                ctx.timingFunction = Motion.easeOut
                to.animator().alphaValue = 1
            }
        }
        if Motion.reduced || from.isHidden {
            finish()
        } else {
            NSAnimationContext.runAnimationGroup({ ctx in
                ctx.duration = 0.14
                ctx.timingFunction = Motion.easeInOut
                from.animator().alphaValue = 0
            }, completionHandler: finish)
        }
    }

    /// Result of an attempt to pair. Success returns to the connect page with the news; failure stays and explains.
    func pairFinished(error: String?, address: String? = nil) {
        if let error = error {
            pairBanner.show(error, tone: .error)
            window?.makeFirstResponder(pairCodeRow.field)
            return
        }
        pairCodeRow.field.stringValue = ""
        pairCodeRow.refreshClear()
        if let a = address { addressRow.field.stringValue = a; addressRow.refreshClear() }
        let hint = address == nil ? "Paired. Now enter the address from the main Wireless debugging screen and tap Connect."
                                  : "Paired. The address is filled in. Tap Connect."
        banner.show(hint, tone: .success)
        showPairPage(false)
    }

    // MARK: state

    func setDevices(_ list: [DeviceInfo]) {
        guard list != devices else { return }
        devices = list
        reloadDevices()
    }

    private func reloadDevices() {
        if devices.isEmpty {
            devicesCard.setRows([EmptyDevicesRow()])
            return
        }
        let rows = devices.map { d -> DeviceRow in
            let r = DeviceRow(device: d)
            r.onClick = { [weak self] s in if self?.locked == false { self?.onPick?(s) } }
            return r
        }
        devicesCard.setRows(rows)
    }

    func show(_ text: String, tone: Tone) { (onPairPage ? pairBanner : banner).show(text, tone: tone) }

    /// While busy the default button shows an activity indicator and a progress label (HIG: buttons). `pairing` puts it
    /// on the Pair button of the pair page instead.
    func setBusy(_ text: String?, pairing: Bool = false) {
        let busy = text != nil
        locked = busy
        addressRow.setEnabled(!busy)
        pairAddressRow.setEnabled(!busy)
        pairCodeRow.setEnabled(!busy)
        soundRow.control.isEnabled = !busy
        pairButton.isEnabled = !busy
        connectButton.isEnabled = !busy
        pairToggle.isEnabled = !busy
        connectButton.title = (busy && !pairing) ? text! : "Connect"
        pairButton.title = (busy && pairing) ? text! : "Pair"
        let spin = { (s: NSProgressIndicator, on: Bool) in s.isHidden = !on; on ? s.startAnimation(nil) : s.stopAnimation(nil) }
        spin(spinner, busy && !pairing)
        spin(pairSpinner, busy && pairing)
        cancelButton.isHidden = !(busy && !pairing)
        hero.setBusy(busy && !pairing)
        if busy { banner.isHidden = true; pairBanner.isHidden = true }
    }
}
