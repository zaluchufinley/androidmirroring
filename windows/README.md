# Android Mirroring for Windows

The Windows version of Android Mirroring: an iPhone-Mirroring-style window for your Android phone, built on
[scrcpy](https://github.com/Genymobile/scrcpy). The macOS app (in `../Sources`) is untouched; this folder is a separate
Electron app that speaks the same scrcpy protocol.

- Wired (USB) or wireless (Wi-Fi) connection, with pairing for Android 11+ wireless debugging
- Phone video decoded on the PC with WebCodecs (hardware decoder, software fallback)
- Mouse = touch, wheel = scroll, right click = Back, keyboard and IME text, paste from the PC clipboard
- Drop files on the window: `.apk` files are installed, everything else goes to the phone's Downloads
- Sound on the phone or on the PC, "phone screen off", keep on top, zoom and fit

`adb` and the scrcpy server are bundled in the installer (scrcpy 5.0.1, checked against the release's SHA-256), so there
is nothing else to install.

## Get the installer

Download it from the repository's **Releases** page: `Android-Mirroring-Setup-<version>-x64.exe` for most PCs, `-arm64.exe`
for Windows on ARM. Releases are published by the **Build** workflow (`.github/workflows/build.yml`) whenever a tag like
`v1.0.0` is pushed. Every other push builds the same installers and keeps them as run **Artifacts**.

To build locally on a Windows PC:

```powershell
cd windows
npm ci
npm run dist          # x64        -> dist\Android-Mirroring-Setup-1.0.0-x64.exe
npm run dist:arm64    # Windows ARM -> dist\Android-Mirroring-Setup-1.0.0-arm64.exe
```

The installer is not code-signed, so Windows SmartScreen shows "unknown publisher": choose *More info* > *Run anyway*.

## Run from source

```bash
cd windows
npm ci
npm run fetch-tools   # downloads adb + the scrcpy server into resources/bin (Windows only; elsewhere adb/scrcpy from PATH are used)
npm start
```

## Tests

```bash
npm test              # unit tests: protocol, H.264 handling, adb parsing, window geometry, decoder, session (fake adb)
npm run test:e2e      # the real app against a fake adb + fake scrcpy-server streaming real H.264; needs ffmpeg (libx264)
```

The protocol tests compare against bytes produced by the original Swift encoder (`../Sources/Core.swift`), so the
Windows app is wire-compatible with the Mac one. The end-to-end test drives the real window with synthetic input and
saves screenshots (set `SHOT_DIR`).

## Trying it without a Windows PC

On a Mac, run Windows 11 in a VM (VMware Fusion is free for personal use, UTM is free, Parallels has a trial). On Apple
Silicon install the ARM64 build. Connect the phone with **wireless debugging** (Developer options > Wireless debugging)
with the VM's network set to *Bridged*; USB pass-through also works but adb drivers can be fussy.

## Keyboard shortcuts

| | |
|---|---|
| `Ctrl+1` / `Ctrl+2` / `Ctrl+3` | Home / App Switcher / Notifications |
| `Ctrl+[` or `Esc` or right click | Back |
| `Ctrl+V` | Paste the PC clipboard into the phone |
| `Ctrl+0` / `Ctrl++` / `Ctrl+-` / `Ctrl+9` | Actual size / zoom in / zoom out / fit to screen |
| `Ctrl+Alt+L` | Phone screen off / on |
| `Ctrl+Alt+T` | Keep on top |
| `Ctrl+D` | Disconnect |
| `Ctrl+W` or `Ctrl+Q` | Close |
| `Alt`-drag on the picture | Move the window |

## Layout

```
src/main/       Electron main process: window, IPC, adb, the scrcpy session (controller.js is the app logic)
src/preload/    the small bridge between page and app
src/renderer/   the page: connect screen, mirror, H.264 decoding, input
src/shared/     scrcpy control protocol
scripts/        fetch-scrcpy.js (bundles adb + server)
test/           unit tests; test/e2e is the end-to-end test
```
