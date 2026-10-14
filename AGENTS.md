# 🌒 AGENT.md — Developer & AI Agent Guide for Eclipse Studio

> **CRITICAL DIRECTIVE FOR THE AI AGENT / MODEL:**
> 1. **LANGUAGE REQUIREMENT:** When interacting with the user, you must **ALWAYS communicate and respond in RUSSIAN** (`Всегда отвечай пользователю на русском языке`), unless explicitly requested otherwise by the user.
> 2. **CODE COMMENTS REQUIREMENT:** ALL code comments across ALL languages (Rust, JavaScript, CSS, HTML, Python) **MUST BE WRITTEN IN RUSSIAN** (`Все комментарии в коде обязаны быть строго на русском языке`). No English code comments in new or modified code.
> 3. **EXCLUSIVE BUILD RULES (PORTABLE ONLY, HYPERVISOR ONLY, EXACT NAME):**
>    - **BUILD TYPE:** You must build **EXCLUSIVELY PORTABLE** builds (`--type portable` / `cargo build --release`). NEVER build NSIS installers, debug builds, or multi-target builds unless explicitly ordered by the user.
>    - **TARGET DIRECTORY:** Output destination must be **EXCLUSIVELY** `C:\Users\Sparki\Desktop\Programms\Hypervisor` (the Hypervisor folder).
>    - **EXACT FILE NAME:** The output binary must be named **EXCLUSIVELY** `Eclipse-Studio-vX.X.X.exe` (where `X.X.X` is the project version, e.g. `Eclipse-Studio-v6.6.6.exe`). **NEVER** use `-Portable`, `-Setup`, or any other suffixes.
> 4. **GIT SAFETY PROTOCOL:** You must **NEVER commit (`git commit`) or push (`git push`) without explicit confirmation** from the user. Never perform destructive git commands (`git reset --hard`, `git checkout .`, `git clean -fd`) autonomously.
> 5. **POST-CHANGE VERIFICATION:** After making any changes to files, you must **ALWAYS verify** that the project remains healthy:
>    - For Rust backend: run `cargo check --manifest-path src-tauri/Cargo.toml` and `cargo test --manifest-path src-tauri/Cargo.toml`.
>    - For UI / Frontend: inspect changes, ensure all invoked Tauri commands are registered in `src-tauri/src/lib.rs`, and verify JS/CSS syntax.
>    - For Git: check `git status` and `git diff` to confirm only the intended files were modified.

---

## 1. Project Overview & Lineage

### 1.1 What is Eclipse Studio?
**Eclipse Studio** is a high-performance desktop application for Windows 10/11 (x64) built on **Rust (Tauri v2)** and modern vanilla web technologies. It serves as a unified control center for:
- Steam game library analysis and DLC unlocking (SmokeAPI and CreamAPI).
- Universal Online Fix injection (Spacewar 480 / Fake AppIDs and Epic Online Services EOS SDK patches).
- Game save file discovery, automated backup (ZIP/RAR), and safe restoration across 15+ save directories.
- Steam game manifest acquisition via Ryuu Generator, HubCap, and the embedded Millennium framework plugin.
- Windows Virtualization-Based Security (VBS/HVCI), Driver Signature Enforcement (DSE), and Testsigning mode control.
- Residual anti-cheat driver and service auditing/cleanup for 12 anti-cheat vendors.
- Cloud-synced Crack Vault with a 6-part parallel downloader and 1-click automatic crack installer.

### 1.2 Original vs. Fork
| Aspect | Original: Crocodile Gena Studio | Fork: Eclipse Studio |
| :--- | :--- | :--- |
| **Author / Maintainer** | @LeoBanned (Крокодил Гена) | @Sparki1337 (Sparki) |
| **Repository** | `https://github.com/LeoBanned/crocodile-gena-studio-releases` | `https://github.com/Sparki1337/eclipse-studio` |
| **Official Website** | N/A | `https://sparki1337.github.io/eclipse-studio/` |
| **Release Type** | Often bundled with loose external `.bat` & `.exe` files | **100% Standalone Portable single EXE** (or clean NSIS installer) |
| **Crack Installation** | Manual download, manual password copy, manual extraction | **1-Click Auto-Installation**: detects ZIP/RAR layout, extracts nested game root, creates `.backup_orig`, handles passwords, auto-deletes archive |
| **Folder Selection Dialog** | Outdated legacy WinForms tree folder browser | **Modern Native Windows COM `IFileOpenDialog`** (`native_dialog.rs`) |
| **Drag & Drop** | Basic browser drop (often blocked by UAC/WebView2) | **Subclassed Windows Shell `WM_DROPFILES`** (`native_drop.rs`) across UAC integrity levels |
| **Themes & Styling** | Fixed gradients with permanent blue halo in dark themes | **9 Curated Themes** (OLED, Graphite, Steel, Light, Forest, Cosmos, Wine, Coffee, etc.) with neutralized halos, **12 Neon Accents** |
| **UI Customization** | Fixed scale and layout | **Compact mode toggle**, **font scaling (85% – 140%)**, and **resizable draggable sidebar (180px–380px)** |
| **Icons & Visuals** | Mixed emojis and low-res raster icons | **Crisp Lucide SVG vector icon system** with 60 FPS CSS micro-animations |
| **Application Startup** | Static white/blank window while checking environment | **Hardware-accelerated Canvas splash screen** with animated logo, status steps, and click-to-skip |
| **Updates** | Intrusive modal dialogues | **Non-intrusive notification** with a "Snooze for 10 launches" option |
| **Download Storage** | Hardcoded download destination | **Configurable folder** with quick Explorer access and 1-click default reset |
| **CSS Architecture** | Monolithic `styles.css` (2700+ lines) | **Modular CSS files** (`styles-base.css`, `styles-modules.css`, `styles-themes.css`, `styles-appearance.css`, `hypervisor-artwork.css`) |

---

## 2. Directory Locations & Paths

### 2.1 Workspace Root
- **Local Git Repository Path:** `E:\Projects\eclipse-studio`
- **Git Remotes:**
  - `origin`: `https://github.com/Sparki1337/eclipse-studio.git` (Fork branch `main`)
  - `upstream`: `https://github.com/LeoBanned/crocodile-gena-studio-releases.git` (Upstream)

### 2.2 Output Directory for Portable Builds & Tools
- **Mandatory Output Path:** `C:\Users\Sparki\Desktop\Programms\Hypervisor`
- **Mandatory Artifact Filename:** `Eclipse-Studio-vX.X.X.exe` (strictly portable build; e.g. `Eclipse-Studio-v6.6.6.exe`).
- **Configuration File:** `build_config.json` at repo root (`"output_dir": "C:\\Users\\Sparki\\Desktop\\Programms\\Hypervisor"`, `"last_build_type": "portable"`).
- **Purpose:** This folder is Sparki's dedicated hub for all portable builds, releases, and tools. When building, the model must **NEVER** save binaries elsewhere and must **NEVER** build installer bundles.

### 2.3 Project Tree Overview
```text
E:\Projects\eclipse-studio\
├── .git\                               # Git version control metadata
├── .gitignore                          # Build artifacts & local config exclusions
├── AGENT.md                            # This developer and AI agent guide
├── BUILD.md                            # Human-facing build instructions
├── README.md                           # Main repository documentation & overview
├── build.py                            # Automated Python build orchestrator
├── build_config.json                   # Local build preferences (output directory, last build type)
├── bump_version.py                     # Version synchronization script (updates 13+ files)
├── package.json                        # Node.js project definition (@tauri-apps/cli)
├── package-lock.json                   # Locked npm dependencies
│
├── backend\
│   └── core_engine\                    # Bundled Online Fix libraries (compiled into binary)
│       ├── EOSSDK-Win64-Shipping.dll   # Clean/mocked EOS SDK
│       ├── EpicFix.ini                 # Epic emulator configuration
│       ├── EpicFix64.dll               # Epic Online Services 64-bit emulator
│       ├── SteamFix64.dll              # Steam networking emulator
│       ├── winmm.dll                   # System proxy DLL (standard)
│       └── winmm_unity.dll             # System proxy DLL for Unity games
│
├── CreamAPI\                           # Bundled CreamAPI unlocker binaries
│   ├── steam_api.dll                   # 32-bit CreamAPI hook
│   └── steam_api64.dll                 # 64-bit CreamAPI hook
│
├── SmokeAPI\                           # Bundled SmokeAPI unlocker binaries
│   ├── SmokeAPI64.dll                  # 64-bit SmokeAPI DLL
│   └── SmokeAPI86.dll                  # 32-bit SmokeAPI DLL
│
├── millenium\                          # External Millennium client assets
│   ├── wsock32.dll                     # Millennium hook loader
│   └── millennium\bin & lib            # Millennium runtime DLLs and helper executables
│
├── src-tauri\                          # Rust backend (Tauri v2 application)
│   ├── Cargo.toml                      # Rust manifest and dependencies
│   ├── Cargo.lock                      # Locked Rust dependencies
│   ├── tauri.conf.json                 # Tauri v2 configuration (window, bundle, security)
│   ├── build.rs                        # Tauri build script
│   └── src\                            # Rust source code (detailed in Section 3)
│       ├── assets\                     # Embedded runtime assets & Millennium plugin
│       ├── anticheat.rs
│       ├── dlc.rs
│       ├── dlc_catalog.rs
│       ├── engine.rs
│       ├── files.rs
│       ├── game_artwork.rs
│       ├── hubcap.rs
│       ├── hypervisor.rs
│       ├── lib.rs                      # Tauri entry point and command registration
│       ├── luatools.rs
│       ├── main.rs                     # Process entry point
│       ├── millennium.rs
│       ├── models.rs
│       ├── native_dialog.rs
│       ├── native_drop.rs
│       ├── ryuu.rs
│       ├── saves.rs
│       ├── smaki.rs
│       ├── steam.rs
│       ├── steam_library.rs
│       ├── updates.rs
│       └── vbs.rs
│
├── ui\                                 # Frontend web assets (Vanilla JS + CSS)
│   ├── index.html                      # Single-page UI markup
│   ├── app.js                          # Core UI event orchestrator & state manager
│   ├── appearance.js                   # Themes, font scaling, compact mode, sidebar resizer
│   ├── files.js                        # Crack Vault catalog, downloader, 1-click installer UI
│   ├── hypervisor.js                   # Hypervisor launcher profiles & game cards
│   ├── i18n.js                         # Bilingual localization dictionary (RU / EN)
│   ├── motion.js                       # Smooth UI animations and transitions
│   ├── scale.js                        # DPI scaling helper
│   ├── splash.js                       # Hardware-accelerated canvas splash screen
│   ├── utilities.js                    # External utilities hub logic (Zapret, Cirno, Sigma)
│   ├── vbs.js                          # Windows VBS/HVCI & Test Mode UI
│   ├── anticheat.js                    # Anti-Cheat auditor UI
│   ├── styles.css                      # Root CSS stylesheet (imports modular stylesheets)
│   ├── styles-base.css                 # CSS variables, typography, reset, scrollbars
│   ├── styles-themes.css               # 9+ themes and 12 accent definitions
│   ├── styles-appearance.css           # Compact mode, font scaling, toasts, modals
│   ├── styles-modules.css              # Module-specific styling (Fix, Saves, DLC, Lua, etc.)
│   ├── hypervisor-artwork.css          # Game artwork card layouts and glows
│   └── fonts\                          # Local font assets (JetBrains Mono, Monocraft)
│
├── docs\                               # Promotional & documentation GitHub Pages website
│   ├── index.html                      # Landing page with comparison slider
│   ├── app.js                          # Interactive scripts, release fetcher, crack preview
│   ├── style.css                       # Website styling
│   ├── assets\                         # Branding images and comparison screenshots
│   ├── data\cracks.json                # Offline snapshot of available cracks
│   └── screenshots\                    # UI screenshots for each module
│
├── tests\                              # Test suite
│   ├── tauri-mock.js                   # Mock implementation of Tauri IPC for browser tests
│   └── ui.test.js                      # Playwright E2E and regression test suite
│
└── dist\                               # Default build output directory for compiled packages
```

---

## 3. Comprehensive File-by-File Technical Guide

### 3.1 Rust Backend (`src-tauri/src/`)
All backend operations run asynchronously or via `tauri::async_runtime::spawn_blocking` to prevent WebView2 main-thread blocking.

| File | Responsibilities & Tauri Commands |
| :--- | :--- |
| **`lib.rs`** | Core library entry point. Registers all `#[tauri::command]` handlers. Handles embedded asset extraction (`core_engine_path`, `dlc_unlocker_path`), window controls (`minimize_window`, `toggle_maximize_window`, `close_window`, `start_dragging_window`), and administrative elevation (`relaunch_as_admin`, `process_is_elevated`). |
| **`main.rs`** | Application binary entry point. Hides Windows console window in release builds (`windows_subsystem = "windows"`). |
| **`native_dialog.rs`** | Uses Windows COM API (`IFileOpenDialog` with `FOS_PICKFOLDERS`) to provide a modern, Explorer-style folder picker. Avoids legacy WinForms dialogs. Provides `rfd` fallback on Linux. |
| **`native_drop.rs`** | Subclasses the top-level and WebView2 child `HWND`s to handle native Shell `WM_DROPFILES` messages. Bypasses WebView2 drag-and-drop restrictions across UAC integrity levels. |
| **`engine.rs`** | Universal Online Fix module. Scans game directories, analyzes PE headers (x86/x64 architecture), detects game engines (Unreal Engine, Unity, CryEngine), writes `OnlineFix.ini` / `OnlineFix64.ini` with Spacewar (480) or custom AppIDs, installs/removes `SteamFix64.dll` / `winmm.dll`, and manages Epic Online Services (`EOSSDK-Win64-Shipping.dll` / `EpicFix64.dll`). Provides byte-for-byte backups in `.backup_orig`. |
| **`dlc.rs`** | Classic CreamAPI DLC unlocker. Replaces `steam_api.dll` / `steam_api64.dll`, creates `steam_api_o.dll` backup, handles ExtraProtection bypass, generates `cream_api.ini`, and restores originals on uninstall. |
| **`dlc_catalog.rs`** | Parses binary Steam `appcache/appinfo.vdf` (formats v27, v28, v29) and queries the official Steam Store API to build a complete DLC catalog including hidden/delisted DLCs. |
| **`smaki.rs`** | Modern SmokeAPI (v4.1.3) unlocker. Places proxy libraries (`version.dll`, `winhttp.dll`, or `winmm.dll`) next to the game executable. Leaves original Steam libraries completely untouched. Tracks state in `.cgs-smaki.json` for 100% clean uninstallation. |
| **`steam_library.rs`** | Parses Steam library folders across all drives (`libraryfolders.vdf`, `appmanifest_*.acf`). Filters out non-game runtimes, downloads, and tools. Reads local cover artwork from Steam cache. |
| **`steam.rs`** | Direct interface to Steam Store Web APIs. Queries AppID details, searches games by title, and inspects DRM metadata. |
| **`game_artwork.rs`** | Resolves game AppIDs from folder structures, manifest files, or `steam_appid.txt`. Returns Akamai/Cloudflare Steam header URLs and local client artwork paths. |
| **`saves.rs`** | Save Manager engine. Scans 15+ save directories (Saved Games, Documents, LocalAppData, LocalLow, AppData, Steam userdata, Goldberg, GSE, SmartSteamEmu, CODEX, EMPRESS, RUNE, FLT, TENOKE, SKIDROW, OnlineFix). Filters out temporary cache and shaders. Creates ZIP or RAR archives with embedded `cgs-save-manifest.json`. Restores saves with path-traversal security checks. |
| **`luatools.rs`** | Eclipse Manifest & Manifest manager. Reads Steam path from Windows Registry (`HKCU\Software\Valve\Steam`). Installs Lua scripts into `config/stplug-in/` and manifest files into `depotcache/`. Controls game activation, detail inspection, and Steam client restarts. |
| **`ryuu.rs`** | Ryuu Generator API (`generator.ryuu.lol`) client with Cloudflare user-agent emulation for searching and downloading manifest files. |
| **`hubcap.rs`** | HubCap Manifest API (`hubcapmanifest.com`) client. Supports custom user API keys, tracks daily download quota (e.g. 0/25), and downloads `.manifest` files. |
| **`millennium.rs`** | Millennium plugin ("Eclipse Manifest" v0.5.0) manager. Compiles and extracts embedded plugin assets (`index.js`, `webkit.js`, `main.lua`) to inject a "Get Manifest" button directly into the official Steam store interface. |
| **`hypervisor.rs`** | Hypervisor workspace and game launcher manager. Manages profiles for launching games via KVC/DRV loaders. Checks UAC elevation and monitors running game processes. |
| **`anticheat.rs`** | Anti-Cheat Auditor. Scans Windows services and filesystem for 12 anti-cheat solutions (EAC, BattlEye, Vanguard, FACEIT, EA AntiCheat, PunkBuster, XIGNCODE3, GameGuard, ACE, TrueProtect/MoMo, Denuvo AC, EQU8). Backs up service registry keys and driver binaries before removal. |
| **`vbs.rs`** | Windows VBS (Virtualization-Based Security), HVCI, and Driver Signature Enforcement auditor. Inspects registry settings under `HKLM\SYSTEM\CurrentControlSet\Control\DeviceGuard`. Modifies Windows Test Mode via `bcdedit /set testsigning on/off`. Creates rollback snapshots in `cgs-vbs-snapshot.json`. |
| **`files.rs`** | Crack Vault cloud sync and downloader. Fetches catalog from GitHub Gist. Runs 6-part parallel chunk downloads with cancellation tokens. Implements **1-click crack auto-installation**: inspects archive directory structure, determines root directory vs nested game folders, extracts files (ZIP or RAR with password support), creates backups in `.backup_orig`, and optionally deletes the archive. |
| **`updates.rs`** | In-app update checker. Queries GitHub Releases API for `Sparki1337/eclipse-studio`. Compares semver versions, returns release notes, and links to Portable EXE or NSIS Setup. |
| **`models.rs`** | Shared Rust data structures (`PlatformInfo`, `GameInfo`, etc.) with `Serialize` / `Deserialize`. |

### 3.2 Frontend Files (`ui/`)
All frontend code is written in clean, modern vanilla JavaScript (ES6+) without heavy external frameworks.

| File | Purpose |
| :--- | :--- |
| **`index.html`** | Single-page UI layout: titlebar with window controls, resizable sidebar with navigation links (`fix`, `saves`, `dlc`, `lua`, `hypervisor`, `files`, `utilities`, `settings`), social channels, and content panels for each view. |
| **`app.js`** | Central frontend coordinator. Handles navigation between panels, toast notifications, modal dialogs, IPC event listeners, and drag-and-drop feedback. |
| **`appearance.js`** | Appearance controller: 9+ base themes, 12 neon accents, compact mode toggle, font scale slider (85%–140%), and sidebar drag-resizer logic with keyboard arrow support. |
| **`files.js`** | Crack Vault UI: catalog rendering, search filter, pagination, pinned items toggle, download progress display, and 1-click crack install workflow. |
| **`hypervisor.js`** | Hypervisor workspace UI: game profile list, status badges, game launch triggers, and artwork display. |
| **`i18n.js`** | Internationalization engine with complete Russian (`ru`) and English (`en`) dictionaries. Allows instant language switching without page reload. |
| **`motion.js`** | Orchestrates staggered entrance animations (`motion-rise`, `motion-appear`) and respects the `no-motion` setting. |
| **`splash.js`** | Canvas-based splash screen displayed during initial hardware/environment checks with animated logo and status steps. |
| **`scale.js`** | Window and DPI scaling utilities. |
| **`vbs.js`** | Windows VBS/HVCI status card and Test Mode toggle UI. |
| **`anticheat.js`** | Anti-Cheat auditor UI: detected services table, backup directory selector, and removal buttons. |
| **`utilities.js`** | Utilities hub: launcher buttons and setup guides for Zapret2, CirnoDownloader, and Sigma. |
| **`styles.css`** | Root stylesheet importing modular CSS files. |
| **`styles-base.css`** | Base variables, CSS reset, layout containers, titlebar, and custom scrollbars. |
| **`styles-themes.css`** | Color palettes for all 9+ themes (`oled`, `graphite`, `steel`, `light`, `forest`, `cosmos`, etc.) and 12 accent colors. |
| **`styles-appearance.css`** | Appearance modifiers: compact mode adjustments, font scaling rules, toast messages, and modal styling. |
| **`styles-modules.css`** | Layouts and controls for specific modules (DLC Unlocker, Online Fix, Saves, Crack Vault, Lua). |
| **`hypervisor-artwork.css`**| Styling for game cards, cover artwork, and glow effects. |

### 3.3 Root Python Scripts
| Script | Description & Usage |
| :--- | :--- |
| **`build.py`** | Automated build script. Supports interactive menu or CLI flags (`--type portable/nsis/all/debug`, `--out <dir>`, `--clean`, `--no-open`). Saves output path in `build_config.json` (defaults to `C:\Users\Sparki\Desktop\Programms\Hypervisor`), checks prerequisites, calculates SHA-256 hashes, and offers to open Windows Explorer. |
| **`bump_version.py`** | Updates the project version across 13+ files simultaneously (`tauri.conf.json`, `Cargo.toml`, `package.json`, `package-lock.json`, `index.html`, `app.js`, `i18n.js`, `dlc_catalog.rs`, `files.rs`, `tauri-mock.js`, `ui.test.js`, `README.md`, `BUILD.md`). Refreshes `Cargo.lock` automatically. |

---

## 4. Coding Conventions & Style Guide

To maintain pristine codebase quality, adhere to the following conventions:

### 4.1 Rust (`src-tauri/src/`)
- **Language & Edition:** Rust 2021 Edition.
- **Code Comments (MANDATORY RUSSIAN):**
  - **ALL code comments MUST be written in Russian** (`Все комментарии в коде обязаны быть строго на русском языке`). This applies to inline comments (`//`), doc comments (`///`), and module annotations (`//!`).
  - Comments must be clear, concise, and explain the intent, architecture, and non-obvious logic.
- **User-Facing Error Messages:**
  - All errors returned across Tauri commands (`Result<T, String>`) **must be in Russian** (e.g. `format!("Не удалось открыть выбор папки: {error}")`).
- **Data Serialization:**
  - Structs passed across the Tauri boundary must derive `Serialize` and/or `Deserialize`.
  - Use `#[serde(rename_all = "camelCase")]` so frontend JavaScript receives idiomatic camelCase property names.
- **Asynchronous Execution:**
  - Never execute blocking I/O (filesystem, registry, network, COM dialogs) directly on the Tauri main thread.
  - Always wrap blocking work inside `tauri::async_runtime::spawn_blocking(move || { ... })`.

### 4.2 JavaScript (`ui/`)
- **Paradigm:** Vanilla modern ES6+ without frameworks.
- **Encapsulation:** Wrap files in an IIFE with strict mode:
  ```javascript
  (() => {
    "use strict";
    // ...
  })();
  ```
- **Code Comments (MANDATORY RUSSIAN):**
  - **ALL comments in JavaScript MUST be written in Russian** (e.g. `// Темы, компактный режим и масштаб шрифта`).
  - Clear, concise descriptions of functional blocks, state mutations, and event handlers.
- **Naming Conventions:**
  - Variables & Functions: `camelCase`.
  - Constants: `UPPER_SNAKE_CASE` or `UPPERCASE`.
  - DOM data attributes: `kebab-case` (e.g., `data-view`, `data-theme-option`).
- **Error Handling:**
  - Non-critical storage operations: wrap in silent `try { ... } catch (_) {}`.
  - User-facing failures: show clean, descriptive toast notifications via the UI toast system. Avoid raw JavaScript alert popups.

### 4.3 CSS & Theming (`ui/`)
- **Structure:** Keep styles modular. Do NOT dump new styles into `styles.css`. Place them in the relevant module file (`styles-base.css`, `styles-modules.css`, `styles-themes.css`, `styles-appearance.css`, or `hypervisor-artwork.css`).
- **Code Comments:** Any comments in CSS (`/* ... */`) must also be in Russian.
- **Variables:** Always use CSS variables for colors, spacing, and scaling (`var(--accent)`, `var(--fs)`, `var(--bg-card)`).
- **Theme Safety:** Never hardcode fixed dark background or foreground colors that break the `light` theme or custom themes.

### 4.4 Python (`build.py`, `bump_version.py`)
- **Style:** PEP 8 compliance.
- **Windows Console:** Include UTF-8 console reconfiguration at the top of scripts for Windows compatibility.
- **Typing:** Use type annotations (`str | None`, `Path`, `dict`).
- **Comments & Output (MANDATORY RUSSIAN):**
  - ALL comments, docstrings, and console prints **must be strictly in Russian**.

---

## 5. Build, Test & Release Workflow

### 5.1 Build Requirements
1. **Node.js:** 18.x or newer + `npm`.
2. **Rust & Cargo:** Stable x64 (`x86_64-pc-windows-msvc`).
3. **Visual Studio C++ Build Tools:** MSVC v143+ with Windows 10/11 SDK.

### 5.2 Building the Project (PORTABLE ONLY)
> [!IMPORTANT]
> **MANDATORY BUILD SPECIFICATION:**
> The AI agent must build **EXCLUSIVELY PORTABLE BUILDS** (`--type portable`).
> Target output directory: **EXCLUSIVELY** `C:\Users\Sparki\Desktop\Programms\Hypervisor`.
> Target executable name: **EXCLUSIVELY** `Eclipse-Studio-vX.X.X.exe` (e.g. `Eclipse-Studio-v6.6.6.exe`).
> **NEVER** build NSIS installers or debug builds, and **NEVER** append `-Portable` or any other suffix to the executable.

Run the build command:
```powershell
python build.py --type portable --out "C:\Users\Sparki\Desktop\Programms\Hypervisor" --no-open
```
The script compiles via Cargo release and copies the resulting binary to:
`C:\Users\Sparki\Desktop\Programms\Hypervisor\Eclipse-Studio-v{version}.exe`.

### 5.3 Bumping Project Version
When releasing a new version, always use `bump_version.py`:
```powershell
# Interactive prompt:
python bump_version.py

# Or pass the new version directly:
python bump_version.py 6.7.0
```
This updates all version references across `tauri.conf.json`, `Cargo.toml`, `package.json`, UI templates, Rust network user-agents, test mocks, and documentation.

### 5.4 Running Tests
1. **Rust Unit Tests:**
   ```powershell
   cargo test --manifest-path src-tauri/Cargo.toml
   ```
2. **Rust Compilation Check:**
   ```powershell
   cargo check --manifest-path src-tauri/Cargo.toml
   ```
3. **UI Playwright E2E Tests (Optional / Developer):**
   ```powershell
   npm i -D playwright
   npx playwright install chromium
   node tests/ui.test.js
   ```

---

## 6. Mandatory Agent Verification Checklist

Whenever you modify any code or configuration in this repository, you must complete this checklist before reporting completion:

1. [ ] **Rust Health:** Run `cargo check --manifest-path src-tauri/Cargo.toml`. Confirm 0 errors.
2. [ ] **Rust Unit Tests:** Run `cargo test --manifest-path src-tauri/Cargo.toml` if modifying any backend logic.
3. [ ] **Frontend Integrity:** If UI files were touched, verify that any new or changed Tauri command calls are properly registered in `src-tauri/src/lib.rs` under `generate_handler!`.
4. [ ] **Git Scope Check:** Run `git status` and `git diff` to ensure no unexpected files were modified or deleted.
5. [ ] **No Unauthorized Git Actions:** Ensure no commits or pushes were executed without explicit user consent.
6. [ ] **Strict Portable Build Rules:** If a build was performed, verify it was strictly a PORTABLE build (`--type portable`), copied to `C:\Users\Sparki\Desktop\Programms\Hypervisor`, and named exactly `Eclipse-Studio-vX.X.X.exe`.
7. [ ] **Russian Code Comments:** Verify that all newly created or updated code comments across Rust, JS, Python, and CSS are written in Russian.
8. [ ] **Russian Language Response:** Formulate your response to the user **strictly in Russian**.
