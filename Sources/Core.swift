// Android Mirroring — an iPhone-Mirroring-style front end for scrcpy.
// Talks to scrcpy-server directly (video over a socket, input over the control socket).

import AppKit
import AVFoundation
import CoreMedia
import Darwin

// MARK: - Byte helpers

extension Data {
    mutating func be(_ v: UInt8) { append(v) }
    mutating func be(_ v: UInt16) { append(UInt8(v >> 8)); append(UInt8(v & 0xff)) }
    mutating func be(_ v: UInt32) { for s in stride(from: 24, through: 0, by: -8) { append(UInt8((v >> UInt32(s)) & 0xff)) } }
    mutating func be(_ v: UInt64) { for s in stride(from: 56, through: 0, by: -8) { append(UInt8((v >> UInt64(s)) & 0xff)) } }
}
func be32(_ b: [UInt8], _ o: Int) -> UInt32 {
    (UInt32(b[o]) << 24) | (UInt32(b[o + 1]) << 16) | (UInt32(b[o + 2]) << 8) | UInt32(b[o + 3])
}
func be64(_ b: [UInt8], _ o: Int) -> UInt64 {
    (UInt64(be32(b, o)) << 32) | UInt64(be32(b, o + 4))
}

// MARK: - Process / socket helpers

@discardableResult
func shell(_ exe: String, _ args: [String]) -> (status: Int32, out: String) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: exe)
    p.arguments = args
    let pipe = Pipe()
    p.standardOutput = pipe
    p.standardError = pipe
    do { try p.run() } catch { return (-1, "\(error)") }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return (p.terminationStatus, String(decoding: data, as: UTF8.self))
}

func readExact(_ fd: Int32, _ n: Int) -> Data? {
    guard n > 0 else { return Data() }
    var buf = Data(count: n)
    var got = 0
    let ok = buf.withUnsafeMutableBytes { (raw: UnsafeMutableRawBufferPointer) -> Bool in
        while got < n {
            let r = read(fd, raw.baseAddress! + got, n - got)
            if r < 0 && errno == EINTR { continue }
            if r <= 0 { return false }
            got += r
        }
        return true
    }
    return ok ? buf : nil
}

func writeAll(_ fd: Int32, _ data: Data) -> Bool {
    var sent = 0
    return data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) -> Bool in
        while sent < data.count {
            let r = write(fd, raw.baseAddress! + sent, data.count - sent)
            if r < 0 && errno == EINTR { continue }
            if r <= 0 { return false }
            sent += r
        }
        return true
    }
}

func tcpConnect(port: Int) -> Int32 {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    if fd < 0 { return -1 }
    var one: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
    setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, socklen_t(MemoryLayout<Int32>.size))
    var addr = sockaddr_in()
    addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = in_port_t(UInt16(port).bigEndian)
    addr.sin_addr.s_addr = inet_addr("127.0.0.1")
    let r = withUnsafePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
    }
    if r != 0 { close(fd); return -1 }
    return fd
}

// MARK: - Tools discovery

enum Tools {
    static func first(_ paths: [String]) -> String? {
        paths.first { FileManager.default.fileExists(atPath: $0) }
    }
    static let adb: String? = first(["/opt/homebrew/bin/adb", "/usr/local/bin/adb"])
    static let scrcpy: String? = first(["/opt/homebrew/bin/scrcpy", "/usr/local/bin/scrcpy"])
    static let serverJar: String? = {
        if let e = ProcessInfo.processInfo.environment["SCRCPY_SERVER_PATH"] { return e }
        return first(["/opt/homebrew/share/scrcpy/scrcpy-server", "/usr/local/share/scrcpy/scrcpy-server"])
    }()
    /// The server refuses to run unless this matches its own version exactly.
    static let version: String = {
        guard let s = scrcpy else { return "0" }
        let line = shell(s, ["--version"]).out.split(separator: "\n").first.map(String.init) ?? ""
        let parts = line.split(separator: " ")
        return parts.count >= 2 ? String(parts[1]) : "0"
    }()
}

// MARK: - Control messages (scrcpy control protocol)

enum Key {
    static let home: UInt32 = 3, back: UInt32 = 4, up: UInt32 = 19, down: UInt32 = 20, left: UInt32 = 21, right: UInt32 = 22
    static let tab: UInt32 = 61, enter: UInt32 = 66, del: UInt32 = 67, fwdDel: UInt32 = 112, appSwitch: UInt32 = 187
}

enum Ctl {
    static func position(_ x: Int, _ y: Int, _ w: Int, _ h: Int) -> Data {
        var d = Data()
        d.be(UInt32(bitPattern: Int32(x))); d.be(UInt32(bitPattern: Int32(y)))
        d.be(UInt16(clamping: w)); d.be(UInt16(clamping: h))
        return d
    }
    /// action: 0 down, 1 up, 2 move
    static func touch(action: UInt8, x: Int, y: Int, w: Int, h: Int, pressure: Float, buttons: UInt32) -> Data {
        var d = Data([2, action])
        d.be(UInt64.max - 1)  // generic finger
        d.append(position(x, y, w, h))
        d.be(UInt16(max(0, min(1, pressure)) * 65535))
        d.be(UInt32(0))
        d.be(buttons)
        return d
    }
    static func scroll(x: Int, y: Int, w: Int, h: Int, hscroll: Float, vscroll: Float) -> Data {
        func fp(_ v: Float) -> UInt16 {
            let n = max(-1, min(1, v / 16))
            return UInt16(bitPattern: Int16(max(-32768, min(32767, Int(n * 32768)))))
        }
        var d = Data([3])
        d.append(position(x, y, w, h))
        d.be(fp(hscroll)); d.be(fp(vscroll)); d.be(UInt32(0))
        return d
    }
    static func key(action: UInt8, code: UInt32) -> Data {
        var d = Data([0, action])
        d.be(code); d.be(UInt32(0)); d.be(UInt32(0))
        return d
    }
    static func text(_ s: String) -> Data {
        let bytes = Array(s.utf8)
        var d = Data([1])
        d.be(UInt32(bytes.count)); d.append(contentsOf: bytes)
        return d
    }
    static func backOrScreenOn(action: UInt8) -> Data { Data([4, action]) }
    static func simple(_ type: UInt8) -> Data { Data([type]) }
    static let expandNotifications: UInt8 = 5, collapsePanels: UInt8 = 7, resetVideo: UInt8 = 17
    /// SET_DISPLAY_POWER: turns the phone's physical screen off/on while mirroring and control carry on.
    static func displayPower(on: Bool) -> Data { Data([10, on ? 1 : 0]) }
    static func clipboard(_ s: String, paste: Bool) -> Data {
        let bytes = Array(String(decoding: s.utf8.prefix(262_000), as: UTF8.self).utf8)  // a cut character becomes U+FFFD, never invalid UTF-8
        var d = Data([9])
        d.be(UInt64(0)); d.be(UInt8(paste ? 1 : 0))
        d.be(UInt32(bytes.count)); d.append(contentsOf: bytes)
        return d
    }
}

// MARK: - H.264 -> AVSampleBufferDisplayLayer

final class H264Feeder {
    let layer: AVSampleBufferDisplayLayer
    var onFormat: ((Int, Int) -> Void)?
    var onNeedKeyframe: (() -> Void)?
    private var fmt: CMVideoFormatDescription?
    private var sps: [UInt8]?
    private var pps: [UInt8]?
    private var needKey = true

    init(layer: AVSampleBufferDisplayLayer) { self.layer = layer }

    static func splitNALs(_ d: Data) -> [[UInt8]] {
        let b = [UInt8](d)
        var starts: [(pos: Int, len: Int)] = []
        var i = 0
        while i + 3 <= b.count {
            if b[i] == 0 && b[i + 1] == 0 {
                if b[i + 2] == 1 { starts.append((i, 3)); i += 3; continue }
                if i + 4 <= b.count && b[i + 2] == 0 && b[i + 3] == 1 { starts.append((i, 4)); i += 4; continue }
            }
            i += 1
        }
        var out: [[UInt8]] = []
        for (k, s) in starts.enumerated() {
            let begin = s.pos + s.len
            let end = k + 1 < starts.count ? starts[k + 1].pos : b.count
            if end > begin { out.append(Array(b[begin..<end])) }
        }
        return out
    }

    private func rebuildFormat() {
        guard let sps = sps, let pps = pps else { return }
        var fd: CMVideoFormatDescription?
        let st: OSStatus = sps.withUnsafeBufferPointer { s in
            pps.withUnsafeBufferPointer { p in
                var ptrs: [UnsafePointer<UInt8>] = [s.baseAddress!, p.baseAddress!]
                var sizes: [Int] = [s.count, p.count]
                return CMVideoFormatDescriptionCreateFromH264ParameterSets(
                    allocator: nil, parameterSetCount: 2, parameterSetPointers: &ptrs,
                    parameterSetSizes: &sizes, nalUnitHeaderLength: 4, formatDescriptionOut: &fd)
            }
        }
        guard st == noErr, let fd = fd else { return }
        let old = fmt.map { CMVideoFormatDescriptionGetDimensions($0) }
        fmt = fd
        let dim = CMVideoFormatDescriptionGetDimensions(fd)
        if old?.width != dim.width || old?.height != dim.height { onFormat?(Int(dim.width), Int(dim.height)) }
    }

    /// Returns true if a frame was handed to the display layer.
    @discardableResult
    func handle(packet: Data, pts: Int64, key: Bool) -> Bool {
        var nals = H264Feeder.splitNALs(packet)
        var sawParams = false
        nals.removeAll { nal in
            let t = nal[0] & 0x1f
            if t == 7 { sps = nal; sawParams = true; return true }
            if t == 8 { pps = nal; sawParams = true; return true }
            return t == 9  // access unit delimiter
        }
        if sawParams { rebuildFormat() }
        guard let fmt = fmt, !nals.isEmpty else { return false }

        let isKey = key || nals.contains { ($0[0] & 0x1f) == 5 }
        let r = layer.sampleBufferRenderer
        if r.status == .failed {
            r.flush()
            needKey = true
            onNeedKeyframe?()
        }
        if needKey && !isKey { return false }
        if isKey { needKey = false }

        var avcc = Data()
        for nal in nals {
            avcc.be(UInt32(nal.count))
            avcc.append(contentsOf: nal)
        }
        var block: CMBlockBuffer?
        guard CMBlockBufferCreateWithMemoryBlock(
            allocator: nil, memoryBlock: nil, blockLength: avcc.count, blockAllocator: nil,
            customBlockSource: nil, offsetToData: 0, dataLength: avcc.count, flags: 0,
            blockBufferOut: &block) == noErr, let block = block else { return false }
        let rep = avcc.withUnsafeBytes {
            CMBlockBufferReplaceDataBytes(with: $0.baseAddress!, blockBuffer: block, offsetIntoDestination: 0, dataLength: avcc.count)
        }
        guard rep == noErr else { return false }

        var timing = CMSampleTimingInfo(duration: .invalid,
                                        presentationTimeStamp: CMTime(value: pts, timescale: 1_000_000),
                                        decodeTimeStamp: .invalid)
        var size = avcc.count
        var sb: CMSampleBuffer?
        guard CMSampleBufferCreateReady(
            allocator: nil, dataBuffer: block, formatDescription: fmt, sampleCount: 1,
            sampleTimingEntryCount: 1, sampleTimingArray: &timing,
            sampleSizeEntryCount: 1, sampleSizeArray: &size, sampleBufferOut: &sb) == noErr, let sb = sb else { return false }

        if let arr = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: true), CFArrayGetCount(arr) > 0 {
            let dict = unsafeBitCast(CFArrayGetValueAtIndex(arr, 0), to: CFMutableDictionary.self)
            CFDictionarySetValue(dict,
                                 Unmanaged.passUnretained(kCMSampleAttachmentKey_DisplayImmediately).toOpaque(),
                                 Unmanaged.passUnretained(kCFBooleanTrue).toOpaque())
        }
        r.enqueue(sb)
        return true
    }
}


// MARK: - Audio playback (scrcpy "raw" codec: 48 kHz, stereo, signed 16-bit little-endian)

final class AudioPlayer {
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let format = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 2)!
    private let lock = NSLock()
    private var pending = 0
    private var running = false
    private(set) var bytesReceived = 0

    func start() {
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: format)
        do {
            try engine.start()
            player.play()
            running = true
        } catch {
            NSLog("AndroidMirroring: audio engine failed: \(error)")
        }
    }

    func stop() {
        guard running else { return }
        running = false
        player.stop()
        engine.stop()
    }

    /// Plays one chunk. If playback falls behind (~250 ms), chunks are dropped so sound never lags the picture.
    func enqueue(_ pcm: Data) {
        guard running else { return }
        bytesReceived += pcm.count
        let frames = pcm.count / 4
        guard frames > 0, let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)),
              let left = buf.floatChannelData?[0], let right = buf.floatChannelData?[1] else { return }
        lock.lock()
        if pending > 14 { lock.unlock(); return }
        pending += 1
        lock.unlock()
        buf.frameLength = AVAudioFrameCount(frames)
        pcm.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            let s = raw.bindMemory(to: Int16.self)
            for i in 0..<frames {
                left[i] = Float(Int16(littleEndian: s[2 * i])) / 32768
                right[i] = Float(Int16(littleEndian: s[2 * i + 1])) / 32768
            }
        }
        player.scheduleBuffer(buf, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            self?.lock.lock(); self?.pending -= 1; self?.lock.unlock()
        }
    }
}

// MARK: - Mirror session (scrcpy-server connection)

struct SessionError: Error { let message: String }

final class MirrorSession {
    enum Event { case streaming(String), size(Int, Int), ended(String?) }
    var onEvent: ((Event) -> Void)?
    let feeder: H264Feeder
    let serial: String
    let audioOnMac: Bool
    let audioPlayer = AudioPlayer()

    private var vfd: Int32 = -1
    private var afd: Int32 = -1
    private var cfd: Int32 = -1
    private var proc: Process?
    private var fwdPort: Int?
    private let lock = NSLock()
    private var stopped = false
    private var displayOff = false  // we turned the phone's screen off, so it must be turned on again when we leave
    private var serverLog = ""
    private let ctlQ = DispatchQueue(label: "mirror.control")
    private var sawSessionPacket = false
    private let readers = DispatchGroup()  // the audio and control-drain threads

    init(layer: AVSampleBufferDisplayLayer, serial: String, audioOnMac: Bool) {
        feeder = H264Feeder(layer: layer)
        self.serial = serial
        self.audioOnMac = audioOnMac
        feeder.onNeedKeyframe = { [weak self] in self?.send(Ctl.simple(Ctl.resetVideo)) }
        feeder.onFormat = { [weak self] w, h in
            guard let self = self, !self.sawSessionPacket else { return }
            self.emit(.size(w, h))
        }
    }

    private var isStopped: Bool { lock.lock(); defer { lock.unlock() }; return stopped }
    private func emit(_ e: Event) { DispatchQueue.main.async { self.onEvent?(e) } }

    func start() { Thread.detachNewThread { [self] in self.run() } }

    /// Stops the session. If we turned the phone's screen off, it is switched back on first (the message is written before
    /// the sockets are shut down). `wait` lets a quitting app give that message a moment to leave.
    func stop(waitingUpTo wait: TimeInterval = 0) {
        lock.lock()
        let restore = displayOff && !stopped
        stopped = true
        displayOff = false
        lock.unlock()
        guard restore else { shutdownAll(); return }
        let done = DispatchSemaphore(value: 0)
        ctlQ.async { [self] in
            lock.lock(); let fd = cfd; lock.unlock()
            if fd >= 0 { _ = writeAll(fd, Ctl.displayPower(on: true)) }
            shutdownAll()
            done.signal()
        }
        if wait > 0 { _ = done.wait(timeout: .now() + wait) }
    }

    /// shut down (never close) here: closing is the run thread's job, so a descriptor number can't be reused under us
    private func shutdownAll() {
        lock.lock()
        for fd in [vfd, afd, cfd] where fd >= 0 { shutdown(fd, SHUT_RDWR) }
        let p = proc
        lock.unlock()
        p?.terminate()
    }

    /// Turns the phone's own screen off (or back on) without interrupting the mirror or the controls.
    func setPhoneScreen(on: Bool) {
        lock.lock(); displayOff = !on; lock.unlock()
        send(Ctl.displayPower(on: on))
    }

    func send(_ d: Data) {
        ctlQ.async { [self] in
            lock.lock(); let fd = cfd; lock.unlock()
            guard fd >= 0 else { return }
            _ = writeAll(fd, d)
        }
    }

    func sendText(_ s: String) {
        var chunk = ""
        for ch in s {
            if chunk.utf8.count + String(ch).utf8.count > 300 { send(Ctl.text(chunk)); chunk = "" }
            chunk.append(ch)
        }
        if !chunk.isEmpty { send(Ctl.text(chunk)) }
    }

    func tapKey(_ code: UInt32) {
        send(Ctl.key(action: 0, code: code))
        send(Ctl.key(action: 1, code: code))
    }

    private func logTail() -> String {
        lock.lock(); defer { lock.unlock() }
        let lines = serverLog.split(separator: "\n").suffix(4).joined(separator: "\n")
        return lines
    }

    private func run() {
        var reason: String?
        do { try connectAndStream() } catch let e as SessionError { reason = e.message } catch { reason = "\(error)" }
        cleanup()
        if !isStopped { emit(.ended(reason)) }
    }

    private func cleanup() {
        lock.lock()
        for fd in [vfd, afd, cfd] where fd >= 0 { shutdown(fd, SHUT_RDWR) }  // wakes any thread blocked in read/write
        let p = proc
        lock.unlock()
        p?.terminate()
        // The helper threads keep reading their descriptors until the shutdown above wakes them; wait for them before
        // closing, so a read can never land on a descriptor number that has been reused.
        readers.wait()
        audioPlayer.stop()
        // Close the control socket only after queued writes have drained, so none can hit a reused descriptor.
        ctlQ.sync { lock.lock(); if cfd >= 0 { close(cfd); cfd = -1 }; lock.unlock() }
        lock.lock()
        if vfd >= 0 { close(vfd); vfd = -1 }
        if afd >= 0 { close(afd); afd = -1 }
        lock.unlock()
        if let p = fwdPort, let adb = Tools.adb {
            let s = serial
            shell(adb, ["-s", s, "forward", "--remove", "tcp:\(p)"])
            fwdPort = nil
        }
    }

    private func connectAndStream() throws {
        let port: Int
        do {
            guard let adb = Tools.adb else { throw SessionError(message: "adb was not found. Install it with: brew install android-platform-tools") }
            guard let jar = Tools.serverJar else { throw SessionError(message: "scrcpy-server was not found. Install scrcpy with: brew install scrcpy") }
            let s = serial
            let push = shell(adb, ["-s", s, "push", jar, "/data/local/tmp/scrcpy-server.jar"])
            guard push.status == 0 else { throw SessionError(message: "Could not copy the server to the phone.\n" + push.out.suffix(200)) }
            if isStopped { return }

            let scid = String(format: "%08x", UInt32.random(in: 1..<0x7fff_ffff))
            let fwd = shell(adb, ["-s", s, "forward", "tcp:0", "localabstract:scrcpy_\(scid)"])
            guard fwd.status == 0, let p = Int(fwd.out.trimmingCharacters(in: .whitespacesAndNewlines)) else {
                throw SessionError(message: "adb forward failed.\n" + fwd.out.suffix(200))
            }
            lock.lock(); fwdPort = p; lock.unlock()
            port = p

            let pr = Process()
            pr.executableURL = URL(fileURLWithPath: adb)
            pr.arguments = ["-s", s, "shell", "CLASSPATH=/data/local/tmp/scrcpy-server.jar", "app_process", "/",
                            "com.genymobile.scrcpy.Server", Tools.version,
                            "scid=\(scid)", "log_level=info", "tunnel_forward=true",
                            (audioOnMac ? "audio=true" : "audio=false"), "audio_codec=raw",
                            "control=true", "max_size=1920", "max_fps=60",
                            "video_bit_rate=16000000", "clipboard_autosync=false"]
            let pipe = Pipe()
            pr.standardOutput = pipe
            pr.standardError = pipe
            pipe.fileHandleForReading.readabilityHandler = { [weak self] h in
                let d = h.availableData
                if d.isEmpty { h.readabilityHandler = nil; return }
                self?.lock.lock(); self?.serverLog += String(decoding: d, as: UTF8.self); self?.lock.unlock()
            }
            try pr.run()
            lock.lock(); proc = pr; lock.unlock()
            if isStopped { pr.terminate(); return }
        }

        // Video socket first; the server sends a dummy byte once it is really listening.
        var tries = 0
        while true {
            if isStopped { return }
            if tries > 150 {
                let t = logTail()
                throw SessionError(message: t.isEmpty ? "Could not reach the server on the phone." : t)
            }
            if let p = proc, !p.isRunning {
                let t = logTail()
                throw SessionError(message: t.isEmpty ? "The server on the phone stopped unexpectedly." : t)
            }
            let fd = tcpConnect(port: port)
            if fd >= 0 {
                var b: UInt8 = 0
                if read(fd, &b, 1) == 1 { lock.lock(); vfd = fd; lock.unlock(); break }
                close(fd)
            }
            tries += 1
            usleep(100_000)
        }
        // Then the audio socket (only when sound is routed to the Mac), then control.
        if audioOnMac {
            tries = 0
            while afd < 0 {
                if isStopped { return }
                if tries > 40 { throw SessionError(message: "Could not open the audio channel.") }
                let fd = tcpConnect(port: port)
                lock.lock(); afd = fd; lock.unlock()
                if fd < 0 { tries += 1; usleep(100_000) }
            }
        }
        tries = 0
        while cfd < 0 {
            if isStopped { return }
            if tries > 40 { throw SessionError(message: "Could not open the control channel.") }
            let fd = tcpConnect(port: port)
            lock.lock(); cfd = fd; lock.unlock()
            if fd < 0 { tries += 1; usleep(100_000) }
        }

        guard let nameData = readExact(vfd, 64) else { throw SessionError(message: "The phone closed the connection.\n" + logTail()) }
        let name = String(decoding: nameData.prefix { $0 != 0 }, as: UTF8.self)
        guard let codec = readExact(vfd, 4) else { throw SessionError(message: "The phone closed the connection.\n" + logTail()) }
        guard [UInt8](codec) == [0x68, 0x32, 0x36, 0x34] else { throw SessionError(message: "Unsupported video codec.") }

        let cfdCopy = cfd
        readers.enter()
        Thread.detachNewThread {  // drain device->client messages (clipboard, acks)
            defer { self.readers.leave() }
            var buf = [UInt8](repeating: 0, count: 4096)
            while read(cfdCopy, &buf, buf.count) > 0 {}
        }

        if audioOnMac, afd >= 0 {
            let fd = afd
            let player = audioPlayer
            readers.enter()
            Thread.detachNewThread {
                defer { self.readers.leave() }
                // First 4 bytes: codec id. 0 = disabled by the device, 1 = error (e.g. Android older than 11).
                let dbg = ProcessInfo.processInfo.environment["AM_DEBUG"] != nil
                guard let cid = readExact(fd, 4) else { if dbg { NSLog("AndroidMirroring: audio socket closed before codec id") }; return }
                let codecId = be32([UInt8](cid), 0)
                if dbg { NSLog("AndroidMirroring: audio codec id = 0x\(String(codecId, radix: 16))") }
                guard codecId == 0x0072_6177 else { return }
                player.start()
                var chunks = 0
                while let hd = readExact(fd, 12) {
                    let h = [UInt8](hd)
                    let len = Int(be32(h, 8))
                    guard len <= 1 << 20, let payload = readExact(fd, len) else { break }
                    if h[0] & 0x40 != 0 { continue }  // config packet; raw audio has none
                    player.enqueue(payload)
                    chunks += 1
                    if chunks == 1, dbg { NSLog("AndroidMirroring: first audio chunk, \(payload.count) bytes") }
                    if chunks == 100, dbg {
                        NSLog("AndroidMirroring: audio flowing, \(player.bytesReceived) bytes after 100 chunks")
                    }
                }
                player.stop()
            }
        }

        var announced = false
        while !isStopped {
            guard let hd = readExact(vfd, 12) else { break }
            let h = [UInt8](hd)
            if h[0] & 0x80 != 0 {  // session packet
                sawSessionPacket = true
                emit(.size(Int(be32(h, 4)), Int(be32(h, 8))))
                continue
            }
            let key = h[0] & 0x20 != 0
            let pts = Int64(be64(h, 0) & 0x1FFF_FFFF_FFFF_FFFF)
            let len = Int(be32(h, 8))
            guard len <= 32 << 20, let payload = readExact(vfd, len) else { break }  // a frame is never this big: bad stream
            // config packets only carry SPS/PPS; the feeder picks them up either way
            if feeder.handle(packet: payload, pts: pts, key: key) && !announced {
                announced = true
                emit(.streaming(name))
            }
        }
        if !isStopped { throw SessionError(message: "The phone stopped sending video.\n" + logTail()) }
    }
}

