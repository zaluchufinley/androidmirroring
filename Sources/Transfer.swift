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
                    let out = shell(adb, ["-s", serial, "push", url.path, "/sdcard/Download/"])
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
