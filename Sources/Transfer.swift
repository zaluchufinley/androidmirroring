// Sending files dropped on the window to the phone: APKs are installed, everything else goes to Downloads.

import AppKit

enum Transfer {
    struct Result {
        var sentFiles = 0
        var installedApps = 0
        var failures: [String] = []
    }

    /// Runs on a background queue; `progress` and `completion` are called on the main queue.
    static func send(_ urls: [URL], serial: String, progress: @escaping (String) -> Void, completion: @escaping (Result) -> Void) {
        guard let adb = Tools.adb else {
            completion(Result(failures: ["adb was not found."]))
            return
        }
        DispatchQueue.global().async {
            var r = Result()
            for (i, url) in urls.enumerated() {
                let name = url.lastPathComponent
                DispatchQueue.main.async {
                    progress(urls.count > 1 ? "Sending \(i + 1) of \(urls.count): \(name)" : "Sending \(name)…")
                }
                if url.pathExtension.lowercased() == "apk" {
                    let out = shell(adb, ["-s", serial, "install", "-r", url.path])
                    if out.status == 0 && out.out.contains("Success") {
                        r.installedApps += 1
                    } else {
                        r.failures.append("\(name): \(reason(out.out))")
                    }
                } else {
                    let out = shell(adb, ["-s", serial, "push", url.path, "/sdcard/Download/" + freeName(adb: adb, serial: serial, name: name)])
                    if out.status == 0 {
                        r.sentFiles += 1
                    } else {
                        r.failures.append("\(name): \(reason(out.out))")
                    }
                }
            }
            DispatchQueue.main.async { completion(r) }
        }
    }

    /// "a.pdf" -> "a (1).pdf", "notes" -> "notes (2)": the name to try when the phone already has the file.
    static func numberedName(_ name: String, _ n: Int) -> String {
        if n == 0 { return name }
        let ext = (name as NSString).pathExtension
        if ext.isEmpty { return "\(name) (\(n))" }
        return "\(name.dropLast(ext.count + 1)) (\(n)).\(ext)"
    }

    /// The phone's shell reads a file name, so quote it: '...' with each ' written as '\''
    private static func quote(_ s: String) -> String { "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'" }

    /// The first name in Downloads the phone does not have yet, so a drop never overwrites an existing file.
    private static func freeName(adb: String, serial: String, name: String) -> String {
        for n in 0..<100 {
            let candidate = numberedName(name, n)
            let r = shell(adb, ["-s", serial, "shell", "test -e " + quote("/sdcard/Download/" + candidate)])
            if r.status == 1 { return candidate }  // exit 1 = "no such file"; anything else (adb trouble) falls through to a plain push
            if r.status != 0 { break }
        }
        return name
    }

    /// The last meaningful line adb printed, shortened.
    private static func reason(_ output: String) -> String {
        let line = output.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.last { !$0.isEmpty } ?? "unknown error"
        return line.count > 110 ? String(line.prefix(110)) + "…" : line
    }

    /// "Sent 2 files to Downloads · Installed 1 app"
    static func summary(_ r: Result) -> String {
        var parts: [String] = []
        if r.sentFiles > 0 { parts.append("Sent \(r.sentFiles) file\(r.sentFiles == 1 ? "" : "s") to Downloads") }
        if r.installedApps > 0 { parts.append("Installed \(r.installedApps) app\(r.installedApps == 1 ? "" : "s")") }
        return parts.joined(separator: " · ")
    }
}
