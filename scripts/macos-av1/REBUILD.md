# Rebuilding the replaceable AV1 library

This directory accompanies the exact FFmpeg/SVT source archives, license texts,
bridge sources and build scripts in `Contents/Resources/licenses/av1`.
The application dynamically loads `Contents/Frameworks/libpastepanda_av1.dylib`.

To rebuild without the application repository, create an empty project directory:

1. Copy the four `macos-*.mjs` / JSON build files into `scripts/` and this entire
   `macos-av1` directory into `scripts/macos-av1/`.
2. Copy `av1_bridge.c` and `av1_bridge.h` into `src-tauri/src/macos/`.
3. Copy the two unmodified source archives into `.cache/macos-av1-build/`.
4. Use Node.js 20+, Xcode command-line tools, CMake and NASM (for Intel).
   Run `npm init -y` and `npm install openpgp@6.2.2`, then
   `node scripts/macos-av1-build.mjs --arch universal`.

The rebuilt library is `.cache/macos-av1-runtime/libpastepanda_av1.dylib`.
Inspect the included build script for all compiler flags and exported ABI symbols.
A replacement must retain ABI 1. Replace the library in a writable copy of the
application, then ad hoc sign that copy with `codesign --force --deep --sign -`
and verify with `codesign --verify --deep --strict`. Modifying signed code can
require renewed macOS privacy permission. The original app can be retained.
No developer subscription is required for this local replacement process.
