# Android Mirroring for Windows and Linux

The Windows and Linux version of Android Mirroring: an iPhone-Mirroring-style window for your Android phone, built on
[scrcpy](https://github.com/Genymobile/scrcpy). The macOS app (in `../Sources`) is untouched; this folder is a separate
Electron app that speaks the same scrcpy protocol.

- Wired (USB) or wireless (Wi-Fi) connection, with pairing for Android 11+ wireless debugging
- Phone video decoded on the PC with WebCodecs (hardware decoder, software fallback)
- Mouse = touch, wheel = scroll, right click = Back, keyboard and IME text, paste from the PC clipboard
- Drop files on the window: `.apk` files are installed, everything else goes to the phone's Downloads (a file with the same name is kept; the new one becomes `name (1)`)
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

## Linux (Arch, Bazzite and others, x64)

The same app builds for Linux x64 (scrcpy ships no Linux ARM build). `adb` and the scrcpy server are bundled here too.
The Releases page has two files:

- `Android-Mirroring-<version>-x86_64.AppImage` is for Arch and Bazzite; other distros may work, but Ubuntu 23.10 and newer
  blocks Electron's sandbox by default and needs `--no-sandbox`. `chmod +x` it and start it. On **Bazzite** (and other
  Fedora Atomic / Universal Blue images) just run it, or add it with Gear Lever; nothing is layered onto the system. On
  **Arch** install `fuse2` first (`sudo pacman -S fuse2`), or run it with `--appimage-extract-and-run`.
- `Android-Mirroring-<version>-x64.pacman` is a native package for Arch and Arch-based distros:
  `sudo pacman -U Android-Mirroring-<version>-x64.pacman`.

Wi-Fi (wireless debugging) works out of the box. For USB, your user needs access to the phone: most distros handle it
through udev; if the phone does not show up, install your distro's Android udev rules (`android-udev` on Arch).

```bash
cd windows && npm ci && npm run dist:linux    # on Linux -> dist/*.AppImage and dist/*.pacman
```

## Run from source

```bash
cd windows
npm ci
npm run fetch-tools   # downloads adb + the scrcpy server into resources/bin (Windows by default, `-- --os linux` for Linux; elsewhere adb/scrcpy from PATH are used)
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
