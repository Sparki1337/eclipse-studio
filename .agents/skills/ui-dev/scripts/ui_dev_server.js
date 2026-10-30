// Локальный HTTP-сервер для разработки и тестирования интерфейса Eclipse Studio в браузере.
// Внедряет полный мок системного API Tauri с реалистичными данными, позволяя отлаживать UI без компиляции Rust.

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..");
const UI_DIR = path.join(ROOT_DIR, "ui");
const DOCS_DIR = path.join(ROOT_DIR, "docs");

// Чтение каталога кряков для мока Crack Vault
const cracksJsonPath = path.join(DOCS_DIR, "data", "cracks.json");
let cracksData = { cracks: [] };
try {
  cracksData = JSON.parse(fs.readFileSync(cracksJsonPath, "utf8"));
} catch (_) {}

// Закреплённые элементы каталога
const pinnedFiles = [
  {
    name: "Кряк для RDR2",
    build: "Закидывать в корен...",
    password: "",
    pinned: true,
    url: "https://github.com/LeoBanned/pirate-station-cracks/releases/download/1/rdr2.zip",
  },
  {
    name: "Эмулятор для Microsoft",
    build: "Закидывать в корен...",
    password: "",
    pinned: true,
    url: "https://github.com/LeoBanned/pirate-station-cracks/releases/download/1/ms.zip",
  },
  {
    name: "Эмулятор для EA",
    build: "Закидывать в корен...",
    password: "",
    pinned: true,
    url: "https://github.com/LeoBanned/pirate-station-cracks/releases/download/1/ea.zip",
  },
  {
    name: "Crocodile Gena Studio",
    build: "Build 8.1.0",
    password: "",
    pinned: true,
    url: "https://github.com/LeoBanned/crocodile-gena-studio-releases/download/v8.1.0/setup.exe",
  },
  {
    name: "Eclipse Studio",
    build: "Build 8.1.0",
    password: "",
    pinned: true,
    url: "https://github.com/Sparki1337/eclipse-studio/download/v8.1.0/Eclipse-Studio-v8.1.0.exe",
  },
];

const regularFiles = cracksData.cracks
  .filter((item) => !item.pinned)
  .reverse()
  .map((item) => ({
    name: item.name,
    build: item.build,
    password: item.password || "",
    url: item.url,
    pinned: false,
  }));

const fullCatalogFiles = [...pinnedFiles, ...regularFiles];

// Генерация скрипта мока Tauri
function generateMockScript() {
  return `// Мок Tauri API для локальной отладки UI в браузере
(() => {
  "use strict";

  // Установка начальных параметров (белый акцент, тёмная тема, пропуск заставки)
  if (!localStorage.getItem("theme")) localStorage.setItem("theme", "graphite");
  if (!localStorage.getItem("accent")) localStorage.setItem("accent", "white");
  localStorage.setItem("cgs-splash", "0");
  if (!localStorage.getItem("manifestService")) localStorage.setItem("manifestService", "hubcap");
  if (!localStorage.getItem("hubcapKey")) localStorage.setItem("hubcapKey", "demo-hubcap-key");

  const catalog = ${JSON.stringify(fullCatalogFiles)};

  const responses = {
    check_for_update: () => ({
      available: false,
      current_version: "8.1.0",
      latest_version: "8.1.0",
      currentVersion: "8.1.0",
      latestVersion: "8.1.0",
    }),
    get_app_status: () => ({}),
    check_asset_updates: () => ({ status: "ok" }),
    is_selected_game_running: () => false,
    list_games: () => [],
    open_external: (args) => { console.log("[Mock] open_external:", args?.url); return null; },
    minimize_window: () => null,
    toggle_maximize_window: () => null,
    close_window: () => null,
    start_dragging_window: () => null,
    pick_game_directory: () => "D:\\\\Games\\\\Cyberpunk 2077",

    scan_save_locations: () => ({
      totalCount: 0,
      totalFiles: 0,
      totalSizeBytes: 0,
      locations: [],
    }),

    scan_installed_steam_games: () => ({
      games: [
        { appid: 284160, name: "BeamNG.drive", gameDir: "E:\\\\Program Files\\\\Steam\\\\steamapps\\\\common\\\\BeamNG.drive", libraryPath: "E:\\\\Program Files\\\\Steam", headerImage: "https://cdn.cloudflare.steamstatic.com/steam/apps/284160/header.jpg" },
        { appid: 705210, name: "Cube Racer", gameDir: "E:\\\\Program Files\\\\Steam\\\\steamapps\\\\common\\\\Cube Racer", libraryPath: "E:\\\\Program Files\\\\Steam", headerImage: "https://cdn.cloudflare.steamstatic.com/steam/apps/705210/header.jpg" },
        { appid: 2495100, name: "Hello Kitty Island Adventure", gameDir: "E:\\\\Program Files\\\\Steam\\\\steamapps\\\\common\\\\Hello Kitty Island Adventure", libraryPath: "E:\\\\Program Files\\\\Steam", headerImage: "https://cdn.cloudflare.steamstatic.com/steam/apps/2495100/header.jpg" },
        { appid: 486860, name: "MMORPG Tycoon 2", gameDir: "E:\\\\Program Files\\\\Steam\\\\steamapps\\\\common\\\\MMORPG Tycoon 2", libraryPath: "E:\\\\Program Files\\\\Steam", headerImage: "https://cdn.cloudflare.steamstatic.com/steam/apps/486860/header.jpg" },
        { appid: 636480, name: "Ravenfield", gameDir: "E:\\\\Program Files\\\\Steam\\\\steamapps\\\\common\\\\Ravenfield", libraryPath: "E:\\\\Program Files\\\\Steam", headerImage: "https://cdn.cloudflare.steamstatic.com/steam/apps/636480/header.jpg" },
        { appid: 1174180, name: "Red Dead Redemption 2", gameDir: "E:\\\\Program Files\\\\Steam\\\\steamapps\\\\common\\\\Red Dead Redemption 2", libraryPath: "E:\\\\Program Files\\\\Steam", headerImage: "https://cdn.cloudflare.steamstatic.com/steam/apps/1174180/header.jpg" },
        { appid: 1643320, name: "S.T.A.L.K.E.R. 2: Heart of Chornobyl", gameDir: "E:\\\\Program Files\\\\Steam\\\\steamapps\\\\common\\\\S.T.A.L.K.E.R. 2 Heart of Chornobyl", libraryPath: "E:\\\\Program Files\\\\Steam", headerImage: "https://cdn.cloudflare.steamstatic.com/steam/apps/1643320/header.jpg" },
        { appid: 480, name: "Spacewar", gameDir: "E:\\\\Program Files\\\\Steam\\\\steamapps\\\\common\\\\Spacewar", libraryPath: "E:\\\\Program Files\\\\Steam", headerImage: "https://cdn.cloudflare.steamstatic.com/steam/apps/480/header.jpg" }
      ],
      libraries: ["C:\\\\Program Files (x86)\\\\Steam", "E:\\\\Program Files\\\\Steam"],
      warnings: [],
    }),

    luatools_status: () => ({
      steamPath: "E:\\\\Program Files\\\\Steam",
      steamDetected: true,
      steamExe: true,
      pluginFolder: true,
      luaFolder: "E:\\\\Program Files\\\\Steam\\\\config\\\\lua",
      loaderStatus: "ok",
      loaderName: "OpenSteamTool",
      luaCount: 1,
      games: [
        { appid: "1174180", enabled: true, status: "ready", manifestCount: 2, missingManifestCount: 0 }
      ],
    }),
    luatools_names: () => ({ "1174180": "Red Dead Redemption 2" }),
    luatools_get_loader_info: () => ({
      loaderSource: "v1",
      v1Name: "Версия 1 (Основная)",
      v1Desc: "Основная стабильная сборка OpenSteamTool (1.57 МБ)",
      v2Name: "Версия 2 (Альтернативная)",
      v2Desc: "Альтернативная встроенная сборка OpenSteamTool (1.75 МБ). Включайте, если не работает основная версия.",
      activeInSteam: "v1",
      activeInSteamLabel: "Версия 1 (Основная)",
      steamDetected: true,
    }),
    luatools_set_loader_source: () => ({ success: true, message: "Загрузчик применен" }),
    luatools_apply_loader: () => ({ success: true, message: "Загрузчик успешно обновлен в Steam" }),
    luatools_is_steam_running: () => false,
    luatools_close_steam: () => ({ success: true, message: "Steam успешно завершён" }),
    millennium_plugin_status: () => ({
      status: "ready",
      pluginVersion: "0.5.0",
      bundledVersion: "0.5.0",
      installed: true,
      millenniumInstalled: true,
    }),
    ryuu_usage: () => ({ dailyUsage: 0, dailyLimit: 50, remaining: 50 }),
    hubcap_usage: () => ({ used: 1, limit: 25, remaining: 24 }),
    luatools_restore_manifests: () => null,

    files_catalog: () => ({
      files: catalog,
      total: catalog.length,
      cached: false,
    }),
    files_default_download_dir: () => "C:\\\\Users\\\\Sparki\\\\Downloads",
    files_pick_download_dir: () => "C:\\\\Users\\\\Sparki\\\\Downloads",
    files_open_download_dir: () => null,

    anticheat_scan: () => ({
      detected: 0,
      total: 12,
      items: [
        { id: "eac", name: "Easy Anti-Cheat (EAC)", vendor: "Epic Games", detected: false },
        { id: "battleye", name: "BattlEye", vendor: "BattlEye Innovations", detected: false },
        { id: "vanguard", name: "Riot Vanguard", vendor: "Riot Games", detected: false },
        { id: "faceit", name: "FACEIT Anti-Cheat", vendor: "FACEIT", detected: false },
        { id: "ea", name: "EA AntiCheat", vendor: "Electronic Arts", detected: false },
        { id: "punkbuster", name: "PunkBuster", vendor: "Even Balance", detected: false },
        { id: "xigncode", name: "XIGNCODE3", vendor: "Wellbia", detected: false },
        { id: "gameguard", name: "nProtect GameGuard", vendor: "INCA Internet", detected: false },
        { id: "ace", name: "Anti-Cheat Expert (ACE)", vendor: "Tencent", detected: false },
        { id: "trueprotect", name: "TrueProtect / MoMo", vendor: "Tencent", detected: false },
        { id: "denuvo_ac", name: "Denuvo Anti-Cheat", vendor: "Irdeto", detected: false },
        { id: "equ8", name: "EQU8 Anti-Cheat", vendor: "EQU8", detected: false },
      ],
    }),

    vbs_scan: () => ({
      testSigningConfigured: true,
      testSigningActive: true,
      dse: { state: "testsigning", label: "Test Signing", detail: "Включён тестовый режим подписи драйверов" },
      components: [
        { id: "vbs", name: "Virtualization-based Security (VBS)", description: "Основа всей VBS-защиты Windows 10/11", enabled: false, locked: false, state: "disabled" },
        { id: "hvci", name: "Memory Integrity (HVCI)", description: "Hyper-V Protected Code Integrity — изоляция памяти ядра", enabled: false, locked: false, state: "disabled" },
        { id: "credguard", name: "Credential Guard", description: "Защита хешей NTLM и Kerberos-учётных данных", enabled: false, locked: false, state: "disabled" },
      ],
    }),
  };

  const listeners = {};

  window.__TAURI__ = {
    core: {
      invoke: async (cmd, args = {}) => {
        if (responses[cmd]) {
          return responses[cmd](args);
        }
        console.warn("[Mock] Необработанная команда:", cmd, args);
        return null;
      },
    },
    event: {
      listen: async (name, handler) => {
        (listeners[name] ||= []).push(handler);
        return () => {
          listeners[name] = (listeners[name] || []).filter((h) => h !== handler);
        };
      },
      emit: async (name, payload) => {
        for (const handler of listeners[name] || []) {
          try { handler({ payload }); } catch (e) { console.error(e); }
        }
      },
    },
  };
})();
`;
}

// Запуск HTTP-сервера
function startDevServer(requestedPort = 8080) {
  const mimeTypes = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".json": "application/json; charset=utf-8",
  };

  const server = http.createServer((req, res) => {
    let urlPath = req.url.split("?")[0];

    // Отдача виртуального мок-скрипта
    if (urlPath === "/tauri-dev-mock.js") {
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
      res.end(generateMockScript());
      return;
    }

    if (urlPath === "/" || urlPath === "") urlPath = "/index.html";
    const filePath = path.join(UI_DIR, urlPath);

    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Файл не найден");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();

    // Если запрашивается HTML-файл, внедряем мок-скрипт перед остальными скриптами
    if (ext === ".html") {
      let html = fs.readFileSync(filePath, "utf8");
      const injectTag = '<script src="/tauri-dev-mock.js"></script>';
      if (!html.includes("/tauri-dev-mock.js")) {
        html = html.replace("</head>", `  ${injectTag}\n</head>`);
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    res.writeHead(200, { "Content-Type": mimeTypes[ext] || "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.log(`[!] Порт ${requestedPort} занят, пробуем случайный свободный порт...`);
      server.listen(0, "127.0.0.1");
    } else {
      console.error("[-] Ошибка сервера:", err);
      process.exit(1);
    }
  });

  server.listen(requestedPort, "127.0.0.1", () => {
    const port = server.address().port;
    console.log("=" * 64);
    console.log(`🌒 Сервер разработки Eclipse Studio UI запущен!`);
    console.log(`📍 Адрес: http://127.0.0.1:${port}/`);
    console.log(`✨ Мок Tauri API активен: каталог кряков, библиотека Steam, VBS, античиты.`);
    console.log(`🎨 Акцент по умолчанию: Белый (white), тема: Графит (graphite).`);
    console.log(`🔄 Редактируйте файлы в папке ui/ — изменения вступают в силу при обновлении страницы.`);
    console.log("=" * 64);
  });
}

const args = process.argv.slice(2);
const portIndex = args.indexOf("--port");
const port = portIndex !== -1 && args[portIndex + 1] ? parseInt(args[portIndex + 1], 10) : 8080;

startDevServer(port);
