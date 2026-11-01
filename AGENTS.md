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
| **Crack Installation** | Multi-step staging dialog, leaves archives in Downloads | **1-Click Auto-Installation**: detects ZIP/RAR layout, extracts nested game root, creates `.backup_orig`, handles passwords, auto-deletes archive |
| **Folder Dialog & Drop** | Originally WinForms / Web drop (backported native dialog from Eclipse) | **Pioneered Modern COM `IFileOpenDialog` & Subclassed `WM_DROPFILES`** (`native_dialog.rs`, `native_drop.rs`) across UAC levels |
| **Themes & Styling** | Fixed gradients with permanent blue tint in dark themes | **14 Curated Themes** (OLED, Graphite, Steel, Light, Forest, Cosmos, Wine, Coffee, etc.) with neutralized halos, **12 Neon Accents** (each accent has a darker light-theme variant with ≥ 4.5:1 contrast) |
| **UI Customization** | Fixed scale and layout (max 125% zoom, fixed sidebar) | **Compact mode toggle**, **font scaling (85% – 140%)**, **resizable draggable sidebar (180px–380px)**, **customizable Home dashboard** (block order/visibility, module cards, list length) and **startup view selection** |
| **Icons & Visuals** | Mixed emojis and low-res raster icons | **Crisp Lucide SVG vector icon system** with 60 FPS CSS micro-animations |
| **Application Startup** | Static white/blank window while checking environment | **Hardware-accelerated Canvas splash screen** with animated logo, status steps, and click-to-skip |
| **Updates & Manifests** | External browser tabs and single fixed loader DLL | **In-app 1-Click Auto-Updater** (live theme-colored progress bar, collapsible bilingual RU/EN changelog, safe restart), **Dual OpenSteamTool loader (v1/v2)**, **GitHub cloud DLL sync & Schema 2 transactional layout**, active Steam detection & safe termination (v7.0.3) |
| **Audio FX & Menus** | Browser default select menus, no sound effects | **Custom Audio Profile designer** with 1-click preview and **theme-adaptive custom dropdown menus** |
| **Download Storage** | Hardcoded download destination | **Configurable folder** with quick Explorer access and 1-click default reset |
| **CSS Architecture** | Monolithic `styles.css` (2700+ lines) | **Modular CSS files** in `ui/styles/` (`base.css`, `modules.css`, `hypervisor-artwork.css`, `themes.css`, `appearance.css`) |

---

## 2. Directory Locations & Paths

### 2.1 Workspace Root
- **Local Git Repository Path:** `E:\Projects\eclipse-studio`
- **Git Remotes:**
  - `origin`: `https://github.com/Sparki1337/eclipse-studio.git` (Fork branch `main`)
  - `upstream`: `https://github.com/LeoBanned/crocodile-gena-studio-releases.git` (Upstream)

### 2.2 Output Directory for Portable Builds & Tools
- **Mandatory Output Path:** `C:\Users\Sparki\Desktop\Programms\Hypervisor`
- **Mandatory Artifact Filename:** `Eclipse-Studio-vX.X.X.exe` (strictly portable build; e.g. `Eclipse-Studio-v8.0.0.exe`).
- **Configuration File:** `scripts/build_config.json` next to `scripts/build.py`, git-ignored (`"output_dir": "C:\\Users\\Sparki\\Desktop\\Programms\\Hypervisor"`, `"last_build_type": "portable"`).
- **Purpose:** This folder is Sparki's dedicated hub for all portable builds, releases, and tools. When building, the model must **NEVER** save binaries elsewhere and must **NEVER** build installer bundles.

### 2.3 Project Tree Overview
```text
E:\Projects\eclipse-studio\
├── .agents\skills\                     # Agent skills build, docsupd, ui-dev (SKILL.md only; scripts live in scripts\)
├── .git\                               # Git version control metadata
├── .gitignore                          # Build artifacts & local config exclusions
├── AGENTS.md                           # This developer and AI agent guide
├── BUILD.md                            # Human-facing build instructions
├── README.md                           # Main repository documentation & overview
├── package.json                        # Node.js project (@tauri-apps/cli) and npm scripts
├── package-lock.json                   # Locked npm dependencies
│
├── docs\                               # GitHub Pages website (location is fixed, do not move)
│   ├── index.html                      # Landing page with comparison slider
│   ├── app.js                          # Interactive scripts, release fetcher, crack preview
│   ├── style.css                       # Website styling
│   ├── assets\                         # Branding images and comparison screenshots
│   ├── data\cracks.json                # Offline snapshot of available cracks
│   └── screenshots\                    # UI screenshots for each module
│
├── eclipse-hv\                         # Standalone Rust launcher Eclipse-HV (separate Cargo crate)
│   ├── Cargo.toml, build.rs            # Crate manifest; build.rs embeds app-icon.ico via winres
│   ├── src\main.rs                     # Launcher source code
│   ├── resources\drvloader.exe         # Embedded into Eclipse-HV.exe (include_bytes!)
│   └── reference\                      # HV-Launcher.bat, HV-PlugNPlay.bat, kvc.exe — reference only, not embedded
│
├── eclipse-manifest\                   # Millennium plugin "Eclipse Manifest" (own npm project)
│   ├── plugin.json, package.json       # Plugin metadata; npm scripts build / typecheck
│   ├── frontend\, webkit\              # TypeScript sources (index.tsx)
│   ├── backend\                        # main.lua, install-loader.ps1
│   └── .millennium\Dist\               # Built index.js, webkit.js, build-integrity.json (hidden folder!)
│
├── millenium\                          # External Millennium client assets (location is fixed)
│   ├── wsock32.dll                     # Millennium hook loader
│   └── millennium\bin & lib            # Millennium runtime DLLs and helper executables
│
├── scripts\                            # Developer scripts, run from the repo root
│   ├── build.py                        # Build orchestrator (portable / nsis / all / debug)
│   ├── build_config.json               # Local build preferences (git-ignored)
│   ├── bump_version.py                 # Version synchronization across the repository
│   ├── release.py                      # /build skill: portable build, SHA-256, release notes
│   ├── ui_dev_server.js                # /ui-dev: browser UI server with the Tauri mock
│   ├── capture_all_screenshots.js      # /docsupd: headless screenshots for docs\
│   ├── dev-mock.cjs                    # Shared Tauri mock bootstrap (dev server, screenshots)
│   └── plugin-integrity.cjs            # SHA-256 map: eclipse-manifest sources ↔ Dist
│
├── src-tauri\                          # Rust backend (Tauri v2 application)
│   ├── Cargo.toml, Cargo.lock          # Rust manifest and locked dependencies
│   ├── tauri.conf.json                 # Tauri v2 configuration (window, bundle, security)
│   ├── build.rs                        # Tauri build script (application manifest)
│   ├── capabilities\                   # Tauri permissions
│   ├── icons\icon.ico                  # Application icon (bundle.icon)
│   ├── resources\                      # Binary payloads embedded into the EXE or bundled
│   │   ├── core_engine\                # Online Fix DLLs, EpicFix.ini, EOS SDK
│   │   ├── creamapi\                   # CreamAPI steam_api.dll, steam_api64.dll
│   │   ├── smokeapi\                   # SmokeAPI64.dll, SmokeAPI86.dll
│   │   ├── opensteamtool\v1\           # OpenSteamTool v1 (standard) + opensteamtool.toml
│   │   ├── opensteamtool\v2\           # OpenSteamTool v2 (compatibility)
│   │   └── hypervisor\                 # Eclipse-HV.exe built from eclipse-hv\
│   └── src\                            # Rust source code only (*.rs, see Section 3.1)
│
├── tests\                              # Test suite
│   ├── contracts.cjs                   # Static checks: IPC contracts, storage, DOM ids, paths
│   ├── tauri-mock.js                   # Mock implementation of Tauri IPC for browser tests
│   ├── ui.test.js                      # Playwright E2E and regression test suite
│   └── safety-core\                    # Cargo tests of shared modules (#[path] into src-tauri\src)
│
├── ui\                                 # Frontend (Vanilla JS + CSS), Tauri frontendDist
│   ├── index.html                      # Single-page UI markup
│   ├── core\                           # Infrastructure modules (see Section 3.2)
│   ├── features\                       # Section controllers (see Section 3.2)
│   ├── styles\                         # base, modules, hypervisor-artwork, themes, appearance
│   └── assets\                         # fonts\ (JetBrains Mono, Monocraft), images\
│
└── dist\                               # Default build output directory (git-ignored)
```

### 2.4 Placement Rules
- **Fixed locations:** `docs/` (GitHub Pages) and `millenium/` (external Millennium assets) must not be moved.
- **Separate projects** with their own `Cargo.toml` / `package.json` live at the root: `eclipse-hv/`, `eclipse-manifest/`.
- **Binary payloads** of the app (`include_bytes!` or Tauri `bundle.resources`) go to `src-tauri/resources/<component>/` with lowercase folder names. `src-tauri/src/` contains Rust sources only.
- **Developer scripts** go to `scripts/`. Skills in `.agents/skills/` contain only `SKILL.md` and call `scripts/…`; do not keep copies of scripts inside skills.
- **UI:** infrastructure → `ui/core/`, section logic → `ui/features/`, CSS → `ui/styles/`, fonts and images → `ui/assets/`. Every JS module must be listed in `ui/core/loader.js` (order matters) or linked from `ui/index.html`.
- **Path guard:** `npm run test:contracts` fails when an `include_bytes!` / `include_str!` / `#[path]` target, a `tauri.conf.json` path, a UI `src`/`href`/`url()`, a loader module or an npm/CI script path does not exist.

---

## 3. Comprehensive File-by-File Technical Guide

### 3.1 Rust Backend (`src-tauri/src/`)
All backend operations run asynchronously or via `tauri::async_runtime::spawn_blocking` to prevent WebView2 main-thread blocking.

| File | Responsibilities & Tauri Commands |
| :--- | :--- |
| **`lib.rs`** | Core library entry point. Registers all `#[tauri::command]` handlers. Handles embedded asset extraction (`core_engine_path`, `dlc_unlocker_path`; payloads from `src-tauri/resources/core_engine/` and `resources/creamapi/`), window controls (`minimize_window`, `toggle_maximize_window`, `close_window`, `start_dragging_window`), and administrative elevation (`relaunch_as_admin`, `process_is_elevated`). |
| **`main.rs`** | Application binary entry point. Hides Windows console window in release builds (`windows_subsystem = "windows"`). |
| **`native_dialog.rs`** | Uses Windows COM API (`IFileOpenDialog` with `FOS_PICKFOLDERS`) to provide a modern, Explorer-style folder picker. Avoids legacy WinForms dialogs. Provides `rfd` fallback on Linux. |
| **`native_drop.rs`** | Subclasses the top-level and WebView2 child `HWND`s to handle native Shell `WM_DROPFILES` messages. Bypasses WebView2 drag-and-drop restrictions across UAC integrity levels. |
| **`engine.rs`** | Universal Online Fix module. Scans game directories, analyzes PE headers (x86/x64 architecture), detects game engines (Unreal Engine, Unity, CryEngine), writes `OnlineFix.ini` / `OnlineFix64.ini` with Spacewar (480) or custom AppIDs, installs/removes `SteamFix64.dll` / `winmm.dll`, and manages Epic Online Services (`EOSSDK-Win64-Shipping.dll` / `EpicFix64.dll`). Provides byte-for-byte backups in `.backup_orig`. |
| **`dlc.rs`** | Classic CreamAPI DLC unlocker. Replaces `steam_api.dll` / `steam_api64.dll`, creates `steam_api_o.dll` backup, handles ExtraProtection bypass, generates `cream_api.ini`, and restores originals on uninstall. |
| **`dlc_catalog.rs`** | Parses binary Steam `appcache/appinfo.vdf` (formats v27, v28, v29) and queries the official Steam Store API to build a complete DLC catalog including hidden/delisted DLCs. |
| **`smaki.rs`** | Modern SmokeAPI (v4.1.3) unlocker. Places proxy libraries (`version.dll`, `winhttp.dll`, or `winmm.dll`) next to the game executable. Leaves original Steam libraries completely untouched. Tracks state in `.cgs-smaki.json` for 100% clean uninstallation. Embeds `src-tauri/resources/smokeapi/`. |
| **`steam_library.rs`** | Parses Steam library folders across all drives (`libraryfolders.vdf`, `appmanifest_*.acf`). Filters out non-game runtimes, downloads, and tools. Reads local cover artwork from Steam cache. |
| **`steam.rs`** | Direct interface to Steam Store Web APIs. Queries AppID details, searches games by title, and inspects DRM metadata. |
| **`game_artwork.rs`** | Resolves game AppIDs from folder structures, manifest files, or `steam_appid.txt`. Returns Akamai/Cloudflare Steam header URLs and local client artwork paths. |
| **`saves.rs`** | Save Manager engine. Scans 15+ save directories (Saved Games, Documents, LocalAppData, LocalLow, AppData, Steam userdata, Goldberg, GSE, SmartSteamEmu, CODEX, EMPRESS, RUNE, FLT, TENOKE, SKIDROW, OnlineFix). Filters out temporary cache and shaders. Creates ZIP or RAR archives with embedded `cgs-save-manifest.json`. Restores saves with path-traversal security checks. |
| **`luatools.rs`** | Eclipse Manifest & Manifest manager. Reads Steam path from Windows Registry (`HKCU\Software\Valve\Steam`). Installs Lua scripts into `config/stplug-in/` and manifest files into `depotcache/`. Features **Dual OpenSteamTool loader versions** (Version 1 Primary and Version 2 Alternative embedded in binary from `src-tauri/resources/opensteamtool/v1/` and `v2/`), active Steam detection (`luatools_is_steam_running`), 1-click safe shutdown (`luatools_close_steam`), and OS error 32/5 sharing violation protection. Controls game activation, detail inspection, and Steam client restarts. |
| **`ryuu.rs`** | Ryuu Generator API (`generator.ryuu.lol`) client with Cloudflare user-agent emulation for searching and downloading manifest files. |
| **`hubcap.rs`** | HubCap Manifest API (`hubcapmanifest.com`) client. Supports custom user API keys, tracks daily download quota (e.g. 0/25), and downloads `.manifest` files. |
| **`millennium.rs`** | Millennium plugin ("Eclipse Manifest" v0.5.0) manager. Compiles and extracts embedded plugin assets (`index.js`, `webkit.js`, `main.lua` from `eclipse-manifest/`, Millennium runtime from `millenium/`) to inject a "Get Manifest" button directly into the official Steam store interface. |
| **`hypervisor.rs`** | Hypervisor workspace and launcher manager. Deploys and manages the standalone Rust `Eclipse-HV.exe` launcher (embedded from `src-tauri/resources/hypervisor/`, sources in `eclipse-hv/`), checks UAC elevation, handles DSE bypass in RAM, and coordinates process launch and monitoring. |
| **`anticheat.rs`** | Anti-Cheat Auditor. Scans Windows services and filesystem for 12 anti-cheat solutions (EAC, BattlEye, Vanguard, FACEIT, EA AntiCheat, PunkBuster, XIGNCODE3, GameGuard, ACE, TrueProtect/MoMo, Denuvo AC, EQU8). Backs up service registry keys and driver binaries before removal. |
| **`vbs.rs`** | Windows VBS (Virtualization-Based Security), HVCI, and Driver Signature Enforcement auditor. Inspects registry settings under `HKLM\SYSTEM\CurrentControlSet\Control\DeviceGuard`. Modifies Windows Test Mode via `bcdedit /set testsigning on/off`. Creates rollback snapshots in `cgs-vbs-snapshot.json`. |
| **`files.rs`** | Crack Vault cloud sync and downloader. Fetches catalog from GitHub Gist. Runs 6-part parallel chunk downloads with cancellation tokens. Implements **1-click crack auto-installation**: inspects archive directory structure, determines root directory vs nested game folders, extracts files (ZIP or RAR with password support), creates backups in `.backup_orig`, and optionally deletes the archive. |
| **`updates.rs`** | In-app 1-click auto-updater. Queries GitHub Releases API for `Sparki1337/eclipse-studio`. Compares semver versions, returns release notes, downloads Portable EXE directly to app directory with live speed/progress events (`download_app_update`), launches new binary with automatic legacy cleanup (`launch_app_update`), and powers localized collapsible changelog in UI. |
| **`models.rs`** | Shared Rust data structures (`PlatformInfo`, `GameInfo`, etc.) with `Serialize` / `Deserialize`. |

### 3.2 Frontend Files (`ui/`)
All frontend code is written in clean, modern vanilla JavaScript (ES6+) without heavy external frameworks. `ui/index.html` links `core/storage.js`, the stylesheets and `core/loader.js`; the loader then loads the remaining modules **sequentially in a fixed order** (see the list in `ui/core/loader.js`).

| File | Purpose |
| :--- | :--- |
| **`index.html`** | Single-page UI layout: titlebar with window controls, resizable sidebar with navigation links (`home`, `fix`, `saves`, `dlc`, `lua`, `hypervisor`, `files`, `utilities`, `settings`), social channels, and content panels for each view. Settings has five tabs: Interface, Home & startup, Sidebar, Modules & API, Paths & downloads. |
| **`core/storage.js`** | Protected storage `window.cgsStorage` (native DPAPI state with migration from legacy `localStorage`). The only module allowed to touch `localStorage`. |
| **`core/loader.js`** | Waits for `cgsStorage.ready`, loads all other modules in order, then dispatches `cgs:modules-loaded` / `cgs:ready` and sets `data-ready`. Shows a startup error panel if a module fails to load. |
| **`core/bootstrap.js`** | Single source of accent colors for the splash, `app.js` and `appearance.js`: `window.cgsAccent` (`names`, `normalize`, `resolve`, `apply`). Each of the 12 accents has a dark-theme and a light-theme value; light values keep ≥ 4.5:1 contrast on white (`white` becomes graphite). Sets `--accent`, `--accent-rgb`, `--accent-2`, `--accent-contrast`. |
| **`core/api.js`** | `window.cgsApi.invoke`: wrapper over Tauri `invoke` that flushes storage and secrets first and emits `cgs:request` events. |
| **`core/dialogs.js`** | Queued modal dialogs (`window.cgsDialogs`). |
| **`core/jobs.js`** | Session journal of user-initiated operations (`OPERATIONS`: command → label, view, native job label). Feeds the Home "Pending operations" and "Needs attention" blocks with an "Open" link to the right view and avoids duplicating entries already reported by the native `jobs_list`. |
| **`core/audio.js`** | Web Audio sound profiles and custom sounds (`window.cgsAudio`). |
| **`core/splash.js`** | Canvas-based splash screen displayed during initial hardware/environment checks with animated logo and status steps. |
| **`core/scale.js`** | Window and DPI scaling utilities. |
| **`core/i18n.js`** | Internationalization engine with complete Russian (`ru`) and English (`en`) dictionaries. Allows instant language switching without page reload. |
| **`core/app.js`** | Central frontend coordinator. Handles navigation between panels, toast notifications, modal dialogs, IPC event listeners, and drag-and-drop feedback. Picks the startup view on boot (`?view=` first, then `cgsHome.startTarget()`, then the Hypervisor sub-tab) and delegates `[data-open-view]` clicks. |
| **`core/custom-select.js`** | Theme-adaptive custom dropdowns (`window.cgsCustomSelect`). |
| **`core/motion.js`** | Orchestrates staggered entrance animations (`motion-rise`, `motion-appear`) and respects the `no-motion` setting. |
| **`features/home.js`** | Home dashboard: hero, recent games, recent backups, pending operations, needs attention, module cards (ordered like the sidebar). Renders the **Home & startup** settings tab (block order/visibility, module cards, rows per list 3/4/6/8, operation IDs, hidden notifications, history) and the startup view selector. Exposes `window.cgsHome` (`recordGame`, `startTarget`, `openSettings`). `cgsStorage` keys: `cgs-home-layout`, `cgs-home-modules-hidden`, `cgs-home-rows`, `cgs-home-ids`, `cgs-start-view` (`home` \| `last` \| view \| `view:tab`), `cgs-last-view`. |
| **`features/saves.js`** | Save Manager view logic (`window.cgsSaves`): scan results, selection, archive and restore actions. |
| **`features/hypervisor.js`** | Hypervisor workspace UI: game profile list, status badges, game launch triggers, and artwork display. |
| **`features/anticheat.js`** | Anti-Cheat auditor UI: detected services table, backup directory selector, and removal buttons. |
| **`features/vbs.js`** | Windows VBS/HVCI status cards, BitLocker guard and Test Mode toggle UI. |
| **`features/files.js`** | Crack Vault UI: catalog rendering, search filter, pagination, pinned items toggle, download progress display, and 1-click crack install workflow. |
| **`features/utilities.js`** | Utilities hub: launcher buttons and setup guides for Zapret2, CirnoDownloader, and Sigma. |
| **`features/appearance.js`** | Appearance controller: 9+ base themes, 12 neon accents, compact mode toggle, font scale slider (85%–140%), and sidebar drag-resizer logic with keyboard arrow support. Owns the Settings tab order (`SETTINGS_TAB_ORDER`) and dispatches `cgs:sidebar-changed` after the sidebar order or visibility changes. |
| **`styles/base.css`** | Base variables, CSS reset, layout containers, titlebar, custom scrollbars and `@font-face` (fonts from `../assets/fonts/`). |
| **`styles/modules.css`** | Layouts and controls for specific modules (Home dashboard, DLC Unlocker, Online Fix, Saves, Crack Vault, Lua, Hypervisor, VBS, Anti-Cheat). |
| **`styles/hypervisor-artwork.css`** | Styling for game cards, cover artwork, and glow effects. |
| **`styles/themes.css`** | Color palettes for all 9+ themes (`oled`, `graphite`, `steel`, `light`, `forest`, `cosmos`, etc.) and 12 accent colors. The `light` block also redefines status tones (`--tone-ok`, `--tone-warn`, `--tone-bad`) for readable contrast. |
| **`styles/appearance.css`** | Appearance modifiers: compact mode adjustments, font scaling rules, toast messages, and modal styling. |
| **`assets/`** | `fonts/` (JetBrains Mono, Monocraft) and `images/` (`app-icon.png`, `hero-crocodile.png`, `icon-loader.png`). |

### 3.3 Developer Scripts (`scripts/`)
All scripts are started from the repository root; paths inside them are resolved relative to the repository, so the current directory does not matter.

| Script | Description & Usage |
| :--- | :--- |
| **`build.py`** | Automated build script (`python scripts/build.py`). Supports interactive menu or CLI flags (`--type portable/nsis/all/debug`, `--out <dir>`, `--clean`, `--no-open`). Saves output path in `scripts/build_config.json` (defaults to `C:\Users\Sparki\Desktop\Programms\Hypervisor`), checks prerequisites, calculates SHA-256 hashes, and offers to open Windows Explorer. |
| **`bump_version.py`** | Updates the project version across the repository (`python scripts/bump_version.py 8.2.0`): `tauri.conf.json`, `Cargo.toml`, `package.json`, `package-lock.json`, `ui/index.html`, `ui/core/app.js`, `ui/core/i18n.js`, `dlc_catalog.rs`, `files.rs`, `tauri-mock.js`, `ui.test.js`, `README.md`, `BUILD.md`, `docs/`, the scripts in `scripts/` and `.agents/skills/build/SKILL.md`. Refreshes `Cargo.lock` automatically. |
| **`release.py`** | `/build` skill helper (`python scripts/release.py`): runs `build.py --type portable` into the Hypervisor folder, verifies `Eclipse-Studio-vX.X.X.exe`, prints SHA-256 and a bilingual GitHub release template with recent commits. |
| **`ui_dev_server.js`** | `/ui-dev` skill (`node scripts/ui_dev_server.js --port 8080`): serves `ui/` with the shared Tauri mock injected. |
| **`capture_all_screenshots.js`** | `/docsupd` skill (`node scripts/capture_all_screenshots.js`): headless Edge via `puppeteer-core`, refreshes `docs/screenshots/` and `docs/assets/compare-eclipse.png`. |
| **`dev-mock.cjs`** | Builds the mock bootstrap from `src-tauri/src/lib.rs` commands and `tests/tauri-mock.js` (single source of mock behavior). |
| **`plugin-integrity.cjs`** | `write` / `check` the SHA-256 map of `eclipse-manifest` sources, lock file and Dist bundles (`npm run check:plugin`). |

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
- **Structure:** Keep styles modular. There is no aggregate `styles.css`: `ui/index.html` links the five files from `ui/styles/` in cascade order (`base.css` → `modules.css` → `hypervisor-artwork.css` → `themes.css` → `appearance.css`). Place new styles in the relevant file; the order matters for overrides.
- **Code Comments:** Any comments in CSS (`/* ... */`) must also be in Russian.
- **Variables:** Always use CSS variables for colors, spacing, and scaling (`var(--accent)`, `var(--fs)`, `var(--bg-card)`).
- **Theme Safety:** Never hardcode fixed dark background or foreground colors that break the `light` theme or custom themes.
- **Accents & Status Colors:** Accent values come from `window.cgsAccent` (`ui/core/bootstrap.js`) — never hardcode accent hex values. Use `var(--accent)` / `rgba(var(--accent-rgb), …)`, `var(--accent-contrast)` for text on accent fills, and `var(--tone-ok)`, `var(--tone-warn)`, `var(--tone-bad)` for status colors so the `light` theme stays readable.

### 4.4 Python (`scripts/*.py`)
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
python scripts/build.py --type portable --out "C:\Users\Sparki\Desktop\Programms\Hypervisor" --no-open
```
The script compiles via Cargo release and copies the resulting binary to:
`C:\Users\Sparki\Desktop\Programms\Hypervisor\Eclipse-Studio-v{version}.exe`.

### 5.3 Bumping Project Version
When releasing a new version, always use `scripts/bump_version.py`:
```powershell
# Interactive prompt:
python scripts/bump_version.py

# Or pass the new version directly:
python scripts/bump_version.py 6.7.0
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
4. **Full frontend suite (same as CI):**
   ```powershell
   npm test
   ```
   Runs `tests/contracts.cjs` (static checks: every UI `call`/`invoke` is registered in `lib.rs`, no direct `localStorage` outside `core/storage.js`, unique DOM ids, and every resource/module path from Section 2.4 exists) and `tests/ui.test.js` (Playwright UI tests).

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
