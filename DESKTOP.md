# 🖥️ Subvid Desktop App (Electron for PC)

Subvid Desktop is the native PC application build for Linux, Windows, and macOS, powered by **Electron** and **Astro**.

---

## 🚀 Key Features
- **100% Local & Private:** Whisper AI transcription and video processing run on your computer without sending any media to external cloud servers.
- **Q8 INT8 Quantized Acceleration:** Default 8-bit Whisper quantization for 2x–3x faster subtitle generation and minimal RAM overhead.
- **Hardware Acceleration:** Native WebGL, WebGPU, and VAAPI video decoding enabled.
- **Cross-Platform Installers:**
  - **Linux:** `.AppImage` (portable universal), `.deb` (Debian/Ubuntu), `.tar.gz`.
  - **Windows:** NSIS Setup `.exe` installer and Portable `.exe`.
  - **macOS:** `.dmg` installer and `.zip` bundle (Intel x64 & Apple Silicon arm64).

---

## 🛠️ Development & Building

### Prerequisites
- Node.js `22.12.0+`
- pnpm `10+`

### Local Development
```bash
# 1. Install dependencies
pnpm install

# 2. Build static desktop assets
pnpm run build:desktop

# 3. Launch Electron app in development mode
pnpm run electron:dev
```

### Packaging & Executable Compilation
```bash
# Package for current OS
pnpm run electron:dist

# Target specific platforms
pnpm run electron:dist:linux   # AppImage, .deb, .tar.gz
pnpm run electron:dist:win     # Windows NSIS .exe & Portable .exe
pnpm run electron:dist:mac     # macOS .dmg & .zip
```

---

## ☁️ Cloud CI/CD (GitHub Actions)
Every commit to `main` triggers automated multi-platform builds:
- **`.github/workflows/desktop-ci.yml`**: Compiles and packages binaries for Linux, Windows, and macOS in parallel.
- **`.github/workflows/desktop-release.yml`**: Automatically publishes compiled desktop binaries to GitHub Releases on tag creation (`v*`).

---

## 📁 Architecture Structure
- `astro.config.desktop.mjs` — Standalone static Astro compilation configuration.
- `electron/main.cjs` — Electron main process, secure `app://` protocol bridge, native menus, IPC handlers.
- `electron/preload.cjs` — Context bridge exposing safe desktop dialogs and system integration.
- `electron-builder.json` — Multi-platform packaging and installer configuration.
- `resources/` — High-resolution application icons (`icon.png`, `icon.ico`, `icon.icns`, `icon.svg`).
