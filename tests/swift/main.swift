// Golden-vector test for the Swift side: the control-message encoder (Ctl) and the Downloads file naming.
// The hex is the same as windows/test/protocol.test.js, so a change to Ctl that is not mirrored there fails CI.
//   swiftc -o /tmp/swifttests Sources/Core.swift Sources/Transfer.swift tests/swift/main.swift -framework AppKit -framework AVFoundation -framework CoreMedia && /tmp/swifttests

import Foundation

var failures = 0
func check(_ name: String, _ got: String, _ want: String) {
    if got != want { failures += 1; print("FAIL \(name)\n  got  \(got)\n  want \(want)") }
}
func hex(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined() }

check("touch down", hex(Ctl.touch(action: 0, x: 540, y: 1200, w: 1080, h: 2400, pressure: 1, buttons: 1)),
      "0200fffffffffffffffe0000021c000004b004380960ffff0000000000000001")
check("touch up", hex(Ctl.touch(action: 1, x: 1079, y: 2399, w: 1080, h: 2400, pressure: 0, buttons: 0)),
      "0201fffffffffffffffe000004370000095f0438096000000000000000000000")
check("touch move", hex(Ctl.touch(action: 2, x: 12, y: 34, w: 1080, h: 2400, pressure: 0.5, buttons: 1)),
      "0202fffffffffffffffe0000000c00000022043809607fff0000000000000001")
check("touch clamp", hex(Ctl.touch(action: 2, x: -5, y: -7, w: 70000, h: 2400, pressure: 1, buttons: 1)),
      "0202fffffffffffffffefffffffbfffffff9ffff0960ffff0000000000000001")
check("scroll up", hex(Ctl.scroll(x: 100, y: 200, w: 1080, h: 2400, hscroll: 0, vscroll: -1)),
      "0300000064000000c8043809600000f80000000000")
check("scroll clamp", hex(Ctl.scroll(x: 100, y: 200, w: 1080, h: 2400, hscroll: 99, vscroll: 5.5)),
      "0300000064000000c8043809607fff2c0000000000")
check("key home", hex(Ctl.key(action: 0, code: 3)), "0000000000030000000000000000")
check("key switcher", hex(Ctl.key(action: 1, code: 187)), "0001000000bb0000000000000000")
check("text", hex(Ctl.text("héllo 世界 🙂")), "010000001268c3a96c6c6f20e4b896e7958c20f09f9982")
check("back down", hex(Ctl.backOrScreenOn(action: 0)), "0400")
check("display off", hex(Ctl.displayPower(on: false)), "0a00")
check("clipboard", hex(Ctl.clipboard("copy me ✓", paste: true)), "090000000000000000010000000b636f7079206d6520e29c93")

check("name 0", Transfer.numberedName("a.pdf", 0), "a.pdf")
check("name ext", Transfer.numberedName("a.pdf", 2), "a (2).pdf")
check("name no ext", Transfer.numberedName("notes", 1), "notes (1)")
check("name dotfile", Transfer.numberedName(".bashrc", 1), ".bashrc (1)")
check("name two dots", Transfer.numberedName("x.tar.gz", 1), "x.tar (1).gz")

if failures == 0 { print("Swift tests passed") }
exit(failures == 0 ? 0 : 1)
