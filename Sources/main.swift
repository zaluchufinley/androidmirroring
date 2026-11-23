// Android Mirroring — an iPhone-Mirroring-style front end for scrcpy.

import AppKit
import AVFoundation
import Darwin

final class AppController: NSObject, NSApplicationDelegate, NSWindowDelegate, NSMenuItemValidation {
    var window: MirrorWindow!
    var root: RootView!
    var session: MirrorSession?
    var videoSize = CGSize(width: 1080, height: 2400)
    var devices: [DeviceInfo] = []
    var polling = false
    var panelOpen = false  // our best guess whether the phone's notification panel is open
    var generation = 0  // bumps whenever a connect attempt is cancelled or replaced
    var restoreWidth: CGFloat?
    var targetWidth: CGFloat = 340
    var animTimer: Timer?
    var animating = false
    let baseShortSide: CGFloat = 340
    let defaults = UserDefaults.standard

    /// Stays above other windows. On by default.
    var keepOnTop: Bool {
        get { defaults.object(forKey: "keepOnTop") as? Bool ?? true }
        set { defaults.set(newValue, forKey: "keepOnTop") }
    }
    /// false: sound stays on the phone. true: sound plays on the Mac (and the phone is silent).
    var audioOnMac: Bool {
        get { defaults.bool(forKey: "audioOnMac") }
        set { defaults.set(newValue, forKey: "audioOnMac") }
    }
    /// true: the phone's own screen stays off while mirroring (it keeps running; the Mac window still shows and controls it).
    var phoneScreenOff: Bool {
        get { defaults.bool(forKey: "phoneScreenOff") }
        set { defaults.set(newValue, forKey: "phoneScreenOff") }
    }

    // MARK: launch

    func applicationDidFinishLaunching(_ n: Notification) {
        buildMenu()
        root = RootView(frame: .zero)
        let w = baseShortSide, h = (w * videoSize.height / videoSize.width).rounded()
        window = MirrorWindow(contentRect: NSRect(x: 0, y: 0, width: w, height: h),
                              styleMask: [.borderless, .resizable, .miniaturizable, .closable], backing: .buffered, defer: false)
        window.contentView = root
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = true
        window.acceptsMouseMovedEvents = true
        window.isReleasedWhenClosed = false
        window.title = "Android Mirroring"
        window.delegate = self
        applyKeepOnTop()
        root.aspect = { [unowned self] in self.videoSize.height / self.videoSize.width }
        root.limits = { [unowned self] in (self.window.minSize.width, self.maxWidth()) }
        updateAspect()
        centerOnPointerScreen()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        let bar = root.bar
        bar.lights.close.onClick = { [weak self] in self?.window.close() }
        bar.lights.minimize.onClick = { [weak self] in self?.window.miniaturize(nil) }
        bar.lights.zoom.onClick = { [weak self] in self?.toggleZoom() }
        bar.home.onClick = { [weak self] in self?.goHome() }
        bar.switcher.onClick = { [weak self] in self?.appSwitcher() }
        bar.notifications.onClick = { [weak self] in self?.notifications() }
        bar.more.onClick = { [weak self] in self?.showMoreMenu() }
        root.onDrop = { [weak self] in self?.sendFiles($0) }
        // Keep the bell in step with what the phone is doing: a pull down from the top edge opens the panel; a push up or Back closes it.
        root.mirror.onSwipe = { [weak self] from, to in
            if from < 0.06 && to - from > 0.12 { self?.panelOpen = true }
            else if from - to > 0.12 { self?.panelOpen = false }
        }
        root.mirror.onBack = { [weak self] in self?.panelOpen = false }

        let c = root.connect
        c.addressField.stringValue = defaults.string(forKey: "lastAddress") ?? ""
        c.audioOnMac = audioOnMac
        c.onConnect = { [weak self] in self?.connect(address: $0) }
        c.onPair = { [weak self] in self?.pair(address: $0, code: $1) }
        c.onPick = { [weak self] in self?.startSession(serial: $0) }
        c.onCancel = { [weak self] in self?.cancelConnect() }
        c.onAudioChange = { [weak self] in self?.setAudio(onMac: $0) }
        window.makeFirstResponder(c.addressField)

        NotificationCenter.default.addObserver(self, selector: #selector(keyChanged), name: NSWindow.didBecomeKeyNotification, object: window)
        NotificationCenter.default.addObserver(self, selector: #selector(keyChanged), name: NSWindow.didResignKeyNotification, object: window)

        if Tools.adb == nil {
            c.show("adb was not found. Install it with: brew install android-platform-tools", tone: .error)
        }
        tick()
        Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in self?.tick() }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ n: Notification) { session?.stop(waitingUpTo: 0.5) }  // wakes the phone screen if we turned it off
    @objc func keyChanged() { root.bar.lights.active = window.isKeyWindow }

    /// Opens on the display the pointer is on, centered in its usable area.
    func centerOnPointerScreen() {
        let screen = NSScreen.screens.first { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) } ?? NSScreen.main ?? NSScreen.screens[0]
        let vis = screen.visibleFrame
        let f = window.frame
        window.setFrameOrigin(NSPoint(x: (vis.midX - f.width / 2).rounded(), y: (vis.midY - f.height / 2).rounded()))
    }

    // MARK: always on top

    func applyKeepOnTop() {
        window.level = keepOnTop ? .floating : .normal
        window.hidesOnDeactivate = false
        // No full screen (it would add black bars). When kept on top the window also follows you across Spaces
        // and floats over full-screen apps, so it can never be left behind on another desktop.
        window.collectionBehavior = keepOnTop ? [.fullScreenAuxiliary, .canJoinAllSpaces] : [.fullScreenAuxiliary, .managed]
    }

    /// Clicking the Dock icon always brings the window back (also from the Dock after minimizing).
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if window.isMiniaturized { window.deminiaturize(nil) }
        window.makeKeyAndOrderFront(nil)
        return true
    }
    @objc func toggleKeepOnTop() { keepOnTop.toggle(); applyKeepOnTop() }

    // MARK: window sizing

    func visibleFrame() -> NSRect {
        (window.screen ?? NSScreen.main)?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
    }

    /// Largest width at which the whole phone still fits on screen (so there are never black bars or clipping).
    func maxWidth() -> CGFloat {
        let a = videoSize.height / videoSize.width
        let vis = visibleFrame()
        return min(vis.width - 16, (vis.height - 16) / a).rounded(.down)
    }

    func updateAspect() {
        let aspect = videoSize.height / videoSize.width
        window.contentAspectRatio = NSSize(width: videoSize.width, height: videoSize.height)
        let minW: CGFloat = aspect >= 1 ? 300 : 300 / aspect
        window.minSize = NSSize(width: minW, height: minW * aspect)
    }

    /// Resizes to `width` (clamped), keeping the phone's aspect ratio and top-left corner, and keeping the window on screen.
    func resize(toWidth width: CGFloat, animated: Bool) {
        let aspect = videoSize.height / videoSize.width
        let vis = visibleFrame()
        let w = max(window.minSize.width, min(maxWidth(), width)).rounded()
        let h = (w * aspect).rounded()
        var f = window.frame
        f.origin.y = f.maxY - h
        f.size = NSSize(width: w, height: h)
        if f.minY < vis.minY { f.origin.y = vis.minY }
        if f.maxY > vis.maxY { f.origin.y = vis.maxY - h }
        if f.maxX > vis.maxX { f.origin.x = vis.maxX - w }
        if f.minX < vis.minX { f.origin.x = vis.minX }
        targetWidth = w
        if animated && !Motion.reduced {
            animateFrame(to: f)
        } else {
            animTimer?.invalidate(); animTimer = nil; animating = false
            window.setFrame(f, display: true)
        }
    }

    /// Our own ease-out animation (instead of NSWindow's): interruptible, keeps the aspect ratio every frame,
    /// and never blanks the video layer mid-resize.
    func animateFrame(to target: NSRect) {
        animTimer?.invalidate()
        let from = window.frame
        let aspect = videoSize.height / videoSize.width
        let t0 = CACurrentMediaTime()
        let dur = 0.34
        animating = true
        let timer = Timer(timeInterval: 1.0 / 120.0, repeats: true) { [weak self] t in
            guard let self = self else { t.invalidate(); return }
            let p = min(1, (CACurrentMediaTime() - t0) / dur)
            let e = CGFloat(1 - pow(1 - p, 4))
            let w = (from.width + (target.width - from.width) * e).rounded()
            let h = p >= 1 ? target.height : (w * aspect).rounded()
            let x = from.minX + (target.minX - from.minX) * e
            let top = from.maxY + (target.maxY - from.maxY) * e
            self.window.setFrame(NSRect(x: x.rounded(), y: (top - h).rounded(), width: p >= 1 ? target.width : w, height: h), display: true)
            if p >= 1 { t.invalidate(); self.animTimer = nil; self.animating = false }
        }
        RunLoop.main.add(timer, forMode: .common)
        animTimer = timer
    }
    @objc func zoomIn() { resize(toWidth: targetWidth * 1.15, animated: true) }
    @objc func zoomOut() { resize(toWidth: targetWidth / 1.15, animated: true) }
    @objc func actualSize() {
        let aspect = videoSize.height / videoSize.width
        resize(toWidth: aspect >= 1 ? baseShortSide : baseShortSide / aspect, animated: true)
    }
    /// Green button: grow to the biggest size that fits the screen, then back to where it was.
    @objc func toggleZoom() {
        let maxW = maxWidth()
        if targetWidth >= maxW - 2, let r = restoreWidth {
            restoreWidth = nil
            resize(toWidth: r, animated: true)
        } else {
            if targetWidth < maxW - 2 { restoreWidth = targetWidth }
            resize(toWidth: maxW, animated: true)
        }
    }
    func windowDidResize(_ n: Notification) {
        window.invalidateShadow()
        if !animating { targetWidth = window.frame.width }  // keeps zoom state right after dragging the edges
    }

    // MARK: device discovery

    func tick() {
        guard !polling, let adb = Tools.adb else { return }
        polling = true
        let gen = generation  // a poll that began before a session started must not judge that session
        DispatchQueue.global().async {
            let out = shell(adb, ["devices", "-l"]).out
            // adb also prints "* daemon ..." lines (stderr is merged) and the "List of devices attached" header.
            let states: Set<String> = ["device", "offline", "unauthorized", "authorizing", "connecting", "recovery", "sideload", "bootloader", "no", "host", "rescue"]
            let list: [DeviceInfo] = out.split(separator: "\n").compactMap { line in
                if line.hasPrefix("*") || line.hasPrefix("List of devices") { return nil }
                let p = line.split(whereSeparator: { $0 == "\t" || $0 == " " }).map(String.init)
                guard p.count >= 2, states.contains(p[1]) else { return nil }
                let model = p.first { $0.hasPrefix("model:") }.map { String($0.dropFirst(6)).replacingOccurrences(of: "_", with: " ") } ?? ""
                return DeviceInfo(serial: p[0], state: p[1], model: model)
            }
            DispatchQueue.main.async {
                self.polling = false
                self.devices = list
                self.root.connect.setDevices(list)
                if gen == self.generation, let s = self.session?.serial, !list.contains(where: { $0.serial == s && $0.state == "device" }) {
                    self.endSession(message: "The phone was disconnected.", tone: .info)
                }
            }
        }
    }

    // MARK: connecting

    func normalize(_ raw: String) -> String? {
        var a = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !a.isEmpty, !a.contains(" "), !a.hasPrefix("-") else { return nil }  // a leading "-" would be read by adb as an option
        if !a.contains(":") { a += ":5555" }
        let parts = a.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 2, !parts[0].isEmpty, let port = Int(parts[1]), (1...65535).contains(port) else { return nil }
        return a
    }

    func connect(address raw: String) {
        let c = root.connect
        guard let adb = Tools.adb else {
            c.show("adb was not found. Install it with: brew install android-platform-tools", tone: .error); return
        }
        guard let addr = normalize(raw) else {
            // Not an error: the person just hasn't typed an address yet.
            c.show("Enter your phone's address, like 192.168.0.101:42799.", tone: .info); return
        }
        defaults.set(addr, forKey: "lastAddress")
        generation += 1
        let gen = generation
        c.setBusy("Connecting to \(addr)…")
        DispatchQueue.global().async {
            let out = shell(adb, ["connect", addr]).out.trimmingCharacters(in: .whitespacesAndNewlines)
            let low = out.lowercased()
            let ok = low.contains("connected to") && !low.contains("failed") && !low.contains("cannot")
            DispatchQueue.main.async {
                guard gen == self.generation else { return }
                if ok {
                    self.startSession(serial: addr)
                } else {
                    c.setBusy(nil)
                    c.show(out.isEmpty ? "Could not reach \(addr)." : out, tone: .error)
                }
            }
        }
    }

    func pair(address raw: String, code: String) {
        let c = root.connect
        guard let adb = Tools.adb else { c.show("adb was not found. Install it with: brew install android-platform-tools", tone: .error); return }
        let addr = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let pin = code.trimmingCharacters(in: .whitespacesAndNewlines)
        // Pairing needs the pairing port (shown on the phone), so an address without one is not enough.
        guard addr.contains(":"), normalize(addr) != nil else {
            c.show("Enter the pairing address with its port, like 192.168.0.101:37123.", tone: .info); return
        }
        guard pin.count == 6, pin.allSatisfy({ $0.isASCII && $0.isNumber }) else {
            c.show("The pairing code is the 6 digits shown on the phone.", tone: .info); return
        }
        generation += 1
        let gen = generation
        c.setBusy("Pairing…", pairing: true)
        let host = String(addr.split(separator: ":")[0])
        DispatchQueue.global().async {
            let out = shell(adb, ["pair", addr, pin]).out.trimmingCharacters(in: .whitespacesAndNewlines)
            let ok = out.lowercased().contains("successfully paired")
            // After pairing, the phone announces its connect address on the network; use it if we can see it.
            var found: String?
            if ok {
                for line in shell(adb, ["mdns", "services"]).out.split(separator: "\n") where line.contains("_adb-tls-connect") {
                    if let last = line.split(whereSeparator: { $0 == "\t" || $0 == " " }).last, last.hasPrefix(host + ":") {
                        found = String(last); break
                    }
                }
            }
            DispatchQueue.main.async {
                guard gen == self.generation else { return }
                c.setBusy(nil)
                if ok {
                    c.pairFinished(error: nil, address: found)
                } else {
                    // adb's own wording ("protocol fault…") means little to most people, so say what to check instead.
                    c.pairFinished(error: "Couldn't pair. Check the address and code on the phone; both change every time.", address: nil)
                }
            }
        }
    }

    func cancelConnect() {
        generation += 1
        session?.stop()
        session = nil
        root.mirror.session = nil
        root.connect.setBusy(nil)
        root.connect.show("", tone: .info)
        root.setMode(.connect)
    }

    // MARK: session

    func startSession(serial: String) {
        generation += 1
        panelOpen = false
        root.connect.setBusy("Connecting…")
        let s = MirrorSession(layer: root.mirror.layerRef, serial: serial, audioOnMac: audioOnMac)
        s.onEvent = { [weak self, weak s] ev in
            guard let self = self, let s = s, self.session === s else { return }
            switch ev {
            case .size(let w, let h):
                guard w > 0, h > 0 else { return }
                self.phoneResized(CGSize(width: w, height: h))
            case .streaming:
                self.root.setMode(.streaming)
                self.window.makeFirstResponder(self.root.mirror)
                if self.phoneScreenOff { s.setPhoneScreen(on: false) }
                if let path = ProcessInfo.processInfo.environment["AM_TEST_SEND"] {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { self.sendFiles([URL(fileURLWithPath: path)]) }
                }
                if ProcessInfo.processInfo.environment["AM_TEST_OVERLAY"] != nil {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { self.root.dropOverlay.setVisible(true) }
                }
            case .ended(let why):
                // nil = the stream simply ended (informational); text = something actually went wrong
                self.endSession(message: why ?? "The connection to the phone was closed.", tone: why == nil ? .info : .error)
            }
        }
        session = s
        root.mirror.session = s
        s.start()
    }

    func phoneResized(_ size: CGSize) {
        let wasPortrait = videoSize.height >= videoSize.width
        videoSize = size
        root.mirror.videoSize = size
        updateAspect()
        let isPortrait = size.height >= size.width
        // On rotation, swap the window's long and short sides so it stays comfortable.
        let width = (isPortrait == wasPortrait) ? window.frame.width : window.frame.height
        resize(toWidth: width, animated: root.mode == .connect)
    }

    /// The connect screen is designed for a portrait phone; after a landscape session, go back to that shape.
    func resetAspectForConnect() {
        let d = CGSize(width: 1080, height: 2400)
        guard videoSize != d else { return }
        videoSize = d
        root.mirror.videoSize = d
        updateAspect()
        resize(toWidth: max(window.minSize.width, baseShortSide), animated: false)
    }

    func endSession(message: String, tone: ConnectView.Tone = .error) {
        session?.stop()
        session = nil
        resetAspectForConnect()
        root.mirror.session = nil
        root.connect.setBusy(nil)
        root.connect.show(message, tone: tone)
        root.setMode(.connect)
        window.makeFirstResponder(root.connect.addressField)
    }

    // MARK: files dropped on the window

    func sendFiles(_ urls: [URL]) {
        guard let serial = session?.serial else { return }
        root.toast.show("Sending…", busy: true)
        Transfer.send(urls, serial: serial, progress: { [weak self] text in
            self?.root.toast.show(text, busy: true)
        }, completion: { [weak self] result in
            guard let self = self else { return }
            if let first = result.failures.first {
                let more = result.failures.count > 1 ? " (+\(result.failures.count - 1) more)" : ""
                self.root.toast.show("Couldn't send \(first)\(more)", symbol: "exclamationmark.circle.fill", tint: Palette.red, autoHide: 7)
            } else {
                self.root.toast.show(Transfer.summary(result), symbol: "checkmark.circle.fill", tint: Palette.green, autoHide: 3.5)
            }
        })
    }

    // MARK: sound

    func setAudio(onMac: Bool) {
        guard onMac != audioOnMac else { return }
        audioOnMac = onMac
        root.connect.audioOnMac = onMac
        // The sound route is chosen when the server starts, so a live session reconnects (about a second).
        if let s = session?.serial, root.mode == .streaming {
            session?.stop()
            session = nil
            startSession(serial: s)
        }
    }
    @objc func soundOnPhone() { setAudio(onMac: false) }
    @objc func soundOnMac() { setAudio(onMac: true) }

    /// Turns the phone's screen off/on. The choice is remembered and applied to the next session too.
    @objc func togglePhoneScreenOff() {
        phoneScreenOff.toggle()
        session?.setPhoneScreen(on: !phoneScreenOff)
        if root.mode == .streaming {
            root.toast.show(phoneScreenOff ? "Phone screen off" : "Phone screen on",
                            symbol: phoneScreenOff ? "moon.fill" : "sun.max.fill", tint: Palette.green, autoHide: 2)
        }
    }

    // MARK: actions

    @objc func goHome() { panelOpen = false; session?.tapKey(Key.home) }
    @objc func appSwitcher() { panelOpen = false; session?.tapKey(Key.appSwitch) }
    @objc func goBack() { panelOpen = false; session?.send(Ctl.backOrScreenOn(action: 0)); session?.send(Ctl.backOrScreenOn(action: 1)) }
    /// Opens the phone's notification panel; the same control closes it again.
    @objc func notifications() {
        panelOpen.toggle()
        session?.send(Ctl.simple(panelOpen ? Ctl.expandNotifications : Ctl.collapsePanels))
    }
    @objc func disconnect() { if session != nil { endSession(message: "") } }

    // MARK: menus

    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        switch item.action {
        case #selector(soundOnPhone): item.state = audioOnMac ? .off : .on
        case #selector(soundOnMac): item.state = audioOnMac ? .on : .off
        case #selector(toggleKeepOnTop): item.state = keepOnTop ? .on : .off
        case #selector(togglePhoneScreenOff): item.state = phoneScreenOff ? .on : .off
        case #selector(disconnect), #selector(goHome), #selector(appSwitcher), #selector(goBack), #selector(notifications):
            return session != nil
        default: break
        }
        return true
    }

    /// The pull-down behind the "…" button in the floating controls.
    func showMoreMenu() {
        let menu = NSMenu()
        menu.autoenablesItems = true
        func item(_ title: String, _ sel: Selector, _ key: String = "", _ mods: NSEvent.ModifierFlags = [.command]) {
            let it = NSMenuItem(title: title, action: sel, keyEquivalent: key)
            it.keyEquivalentModifierMask = mods
            it.target = self
            menu.addItem(it)
        }
        let header = NSMenuItem(title: "Sound", action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)
        item("Play on Phone", #selector(soundOnPhone))
        item("Play on Mac", #selector(soundOnMac))
        menu.addItem(.separator())
        item("Phone Screen Off", #selector(togglePhoneScreenOff), "l", [.command, .option])
        item("Keep on Top", #selector(toggleKeepOnTop), "t", [.command, .option])
        menu.addItem(.separator())
        item("Disconnect", #selector(disconnect), "d")
        let b = root.bar.more
        menu.popUp(positioning: nil, at: NSPoint(x: b.bounds.maxX - 4, y: -6), in: b)
    }

    func buildMenu() {
        let main = NSMenu()
        func add(_ menu: NSMenu, _ title: String, _ sel: Selector?, _ key: String = "", _ mods: NSEvent.ModifierFlags = [.command], target: AnyObject? = nil, useSelf: Bool = true) {
            let it = NSMenuItem(title: title, action: sel, keyEquivalent: key)
            it.keyEquivalentModifierMask = mods
            if let t = target { it.target = t } else if useSelf, sel != nil { it.target = self }
            menu.addItem(it)
        }
        func submenu(_ title: String, _ build: (NSMenu) -> Void) {
            let item = NSMenuItem(); let m = NSMenu(title: title); build(m); item.submenu = m; main.addItem(item)
        }
        submenu("Android Mirroring") { m in
            add(m, "About Android Mirroring", #selector(NSApplication.orderFrontStandardAboutPanel(_:)), target: NSApp)
            m.addItem(.separator())
            add(m, "Hide Android Mirroring", #selector(NSApplication.hide(_:)), "h", target: NSApp)
            m.addItem(.separator())
            add(m, "Quit Android Mirroring", #selector(NSApplication.terminate(_:)), "q", target: NSApp)
        }
        submenu("Edit") { m in
            add(m, "Cut", #selector(NSText.cut(_:)), "x", useSelf: false)
            add(m, "Copy", #selector(NSText.copy(_:)), "c", useSelf: false)
            add(m, "Paste", #selector(NSText.paste(_:)), "v", useSelf: false)
            add(m, "Select All", #selector(NSText.selectAll(_:)), "a", useSelf: false)
        }
        submenu("View") { m in
            add(m, "Home Screen", #selector(goHome), "1")
            add(m, "App Switcher", #selector(appSwitcher), "2")
            add(m, "Notifications", #selector(notifications), "3")
            add(m, "Back", #selector(goBack), "[")
            m.addItem(.separator())
            add(m, "Actual Size", #selector(actualSize), "0")
            add(m, "Zoom In", #selector(zoomIn), "+")
            add(m, "Zoom Out", #selector(zoomOut), "-")
            add(m, "Fit to Screen", #selector(toggleZoom), "9")
        }
        submenu("Device") { m in
            let header = NSMenuItem(title: "Sound", action: nil, keyEquivalent: "")
            header.isEnabled = false
            m.addItem(header)
            add(m, "Play on Phone", #selector(soundOnPhone))
            add(m, "Play on Mac", #selector(soundOnMac))
            m.addItem(.separator())
            add(m, "Phone Screen Off", #selector(togglePhoneScreenOff), "l", [.command, .option])
            m.addItem(.separator())
            add(m, "Disconnect", #selector(disconnect), "d")
        }
        submenu("Window") { m in
            add(m, "Keep on Top", #selector(toggleKeepOnTop), "t", [.command, .option])
            m.addItem(.separator())
            add(m, "Minimize", #selector(NSWindow.performMiniaturize(_:)), "m", useSelf: false)
            add(m, "Close", #selector(NSWindow.performClose(_:)), "w", useSelf: false)
        }
        NSApp.mainMenu = main
    }
}

signal(SIGPIPE, SIG_IGN)
let app = NSApplication.shared
let controller = AppController()
app.delegate = controller
app.setActivationPolicy(.regular)
app.run()
