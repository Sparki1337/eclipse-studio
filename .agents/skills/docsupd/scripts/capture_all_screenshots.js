// Скрипт автоматического фонового снятия скриншотов интерфейса для раздела docs
// Запускается в фоновом безголовом (headless) режиме браузера без открытия окон и без помех пользователю.

const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");

// Путь к системному браузеру Microsoft Edge
const EDGE_PATH = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

// Каталоги проекта
const ROOT_DIR = path.resolve(__dirname, "..");
const UI_DIR = path.join(ROOT_DIR, "ui");
const DOCS_DIR = path.join(ROOT_DIR, "docs");
const SCREENSHOTS_DIR = path.join(DOCS_DIR, "screenshots");
const ASSETS_DIR = path.join(DOCS_DIR, "assets");

// Загрузка реального каталога кряков
const cracksJsonPath = path.join(DOCS_DIR, "data", "cracks.json");
const cracksData = JSON.parse(fs.readFileSync(cracksJsonPath, "utf8"));

// Формирование закреплённых файлов, как в реальном бэкенде
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

// Обычные файлы из каталога (в обратном порядке по дате)
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

// Встроенный HTTP-сервер для отдачи файлов интерфейса
function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let urlPath = req.url.split("?")[0];
      if (urlPath === "/" || urlPath === "") urlPath = "/index.html";
      const filePath = path.join(UI_DIR, urlPath);

      if (!fs.existsSync(filePath)) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Файл не найден");
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
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

      res.writeHead(200, { "Content-Type": mimeTypes[ext] || "application/octet-stream" });
      fs.createReadStream(filePath).pipe(res);
    });

    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ server, port });
    });
  });
}

// Задержка в миллисекундах
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  console.log("Запуск сервера статики...");
  const { server, port } = await startServer();
  console.log(`Сервер запущен на 127.0.0.1:${port}`);

  console.log("Запуск Edge в безголовом (headless) режиме...");
  const browser = await puppeteer.launch({
    executablePath: EDGE_PATH,
    headless: "new",
    args: [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--window-size=1440,900",
      "--force-device-scale-factor=1",
    ],
    defaultViewport: {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
    },
  });

  const page = await browser.newPage();

  // Инициализация окружения и мока Tauri
  await page.evaluateOnNewDocument((catalog) => {
    // Начальные настройки темы и отключение заставки
    localStorage.clear();
    localStorage.setItem("cgs-splash", "0");
    localStorage.setItem("theme", "graphite");
    localStorage.setItem("accent", "white");
    localStorage.setItem("manifestService", "hubcap");
    localStorage.setItem("hubcapKey", "demo-hubcap-key");

    const responses = {
      // Базовые системные вызовы
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
      open_external: () => null,
      minimize_window: () => null,
      toggle_maximize_window: () => null,
      close_window: () => null,
      start_dragging_window: () => null,

      // Менеджер сохранений
      scan_save_locations: () => ({
        totalCount: 0,
        totalFiles: 0,
        totalSizeBytes: 0,
        locations: [],
      }),

      // DLC Unlocker: установленные игры Steam
      scan_installed_steam_games: () => ({
        games: [
          {
            appid: 284160,
            name: "BeamNG.drive",
            gameDir: "E:\\Program Files\\Steam\\steamapps\\common\\BeamNG.drive",
            libraryPath: "E:\\Program Files\\Steam",
            headerImage: "https://cdn.cloudflare.steamstatic.com/steam/apps/284160/header.jpg",
          },
          {
            appid: 705210,
            name: "Cube Racer",
            gameDir: "E:\\Program Files\\Steam\\steamapps\\common\\Cube Racer",
            libraryPath: "E:\\Program Files\\Steam",
            headerImage: "https://cdn.cloudflare.steamstatic.com/steam/apps/705210/header.jpg",
          },
          {
            appid: 2495100,
            name: "Hello Kitty Island Adventure",
            gameDir: "E:\\Program Files\\Steam\\steamapps\\common\\Hello Kitty Island Adventure",
            libraryPath: "E:\\Program Files\\Steam",
            headerImage: "https://cdn.cloudflare.steamstatic.com/steam/apps/2495100/header.jpg",
          },
          {
            appid: 486860,
            name: "MMORPG Tycoon 2",
            gameDir: "E:\\Program Files\\Steam\\steamapps\\common\\MMORPG Tycoon 2",
            libraryPath: "E:\\Program Files\\Steam",
            headerImage: "https://cdn.cloudflare.steamstatic.com/steam/apps/486860/header.jpg",
          },
          {
            appid: 636480,
            name: "Ravenfield",
            gameDir: "E:\\Program Files\\Steam\\steamapps\\common\\Ravenfield",
            libraryPath: "E:\\Program Files\\Steam",
            headerImage: "https://cdn.cloudflare.steamstatic.com/steam/apps/636480/header.jpg",
          },
          {
            appid: 1174180,
            name: "Red Dead Redemption 2",
            gameDir: "E:\\Program Files\\Steam\\steamapps\\common\\Red Dead Redemption 2",
            libraryPath: "E:\\Program Files\\Steam",
            headerImage: "https://cdn.cloudflare.steamstatic.com/steam/apps/1174180/header.jpg",
          },
          {
            appid: 1643320,
            name: "S.T.A.L.K.E.R. 2: Heart of Chornobyl",
            gameDir: "E:\\Program Files\\Steam\\steamapps\\common\\S.T.A.L.K.E.R. 2 Heart of Chornobyl",
            libraryPath: "E:\\Program Files\\Steam",
            headerImage: "https://cdn.cloudflare.steamstatic.com/steam/apps/1643320/header.jpg",
          },
          {
            appid: 480,
            name: "Spacewar",
            gameDir: "E:\\Program Files\\Steam\\steamapps\\common\\Spacewar",
            libraryPath: "E:\\Program Files\\Steam",
            headerImage: "https://cdn.cloudflare.steamstatic.com/steam/apps/480/header.jpg",
          },
        ],
        libraries: ["C:\\Program Files (x86)\\Steam", "E:\\Program Files\\Steam"],
        warnings: [],
      }),

      // Eclipse Manifest
      luatools_status: () => ({
        steamPath: "E:\\Program Files\\Steam",
        steamDetected: true,
        steamExe: true,
        pluginFolder: true,
        luaFolder: "E:\\Program Files\\Steam\\config\\lua",
        loaderStatus: "ok",
        loaderName: "OpenSteamTool",
        luaCount: 1,
        games: [
          {
            appid: "1174180",
            enabled: true,
            status: "ready",
            manifestCount: 2,
            missingManifestCount: 0,
          },
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

      // Кряки
      files_catalog: () => ({
        files: catalog,
        total: catalog.length,
        cached: false,
      }),
      files_default_download_dir: () => "C:\\Users\\Sparki\\Downloads",
      files_pick_download_dir: () => "C:\\Users\\Sparki\\Downloads",
      files_open_download_dir: () => null,

      // Античиты
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

      // VBS & HVCI
      vbs_scan: () => ({
        testSigningConfigured: true,
        testSigningActive: true,
        dse: {
          state: "testsigning",
          label: "Test Signing",
          detail: "Включён тестовый режим подписи драйверов",
        },
        components: [
          {
            id: "vbs",
            name: "Virtualization-based Security (VBS)",
            description: "Основа всей VBS-защиты Windows 10/11",
            enabled: false,
            locked: false,
            state: "disabled",
          },
          {
            id: "hvci",
            name: "Memory Integrity (HVCI)",
            description: "Hyper-V Protected Code Integrity — изоляция памяти ядра",
            enabled: false,
            locked: false,
            state: "disabled",
          },
          {
            id: "credguard",
            name: "Credential Guard",
            description: "Защита хешей NTLM и Kerberos-учётных данных",
            enabled: false,
            locked: false,
            state: "disabled",
          },
        ],
      }),
    };

    window.__TAURI__ = {
      core: {
        invoke: async (cmd, args) => {
          if (responses[cmd]) return responses[cmd](args);
          return null;
        },
      },
      event: {
        listen: async () => () => {},
        emit: async () => {},
      },
    };
  }, fullCatalogFiles);

  const baseUrl = `http://127.0.0.1:${port}/index.html`;

  // 1. Главная
  console.log("Снятие скриншота: Главная.png");
  await page.goto(`${baseUrl}?view=home`);
  await sleep(800);
  const homePath = path.join(SCREENSHOTS_DIR, "Главная.png");
  await page.screenshot({ path: homePath });
  const comparePath = path.join(ASSETS_DIR, "compare-eclipse.png");
  fs.copyFileSync(homePath, comparePath);
  console.log("  ✓ Главная.png и compare-eclipse.png сохранены");

  // 2. Online Fix
  console.log("Снятие скриншота: Online_Fix.png");
  await page.goto(`${baseUrl}?view=fix`);
  await sleep(800);
  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "Online_Fix.png") });
  console.log("  ✓ Online_Fix.png сохранён");

  // 3. Менеджер сохранений
  console.log("Снятие скриншота: Менеджер_сохранений.png");
  await page.goto(`${baseUrl}?view=saves`);
  await sleep(800);
  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "Менеджер_сохранений.png") });
  console.log("  ✓ Менеджер_сохранений.png сохранён");

  // 4. DLC Unlocker
  console.log("Снятие скриншота: DLC_Unlocker.png");
  await page.goto(`${baseUrl}?view=dlc`);
  await sleep(400);
  await page.click("#dlc-library-scan");
  await sleep(1400);
  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "DLC_Unlocker.png") });
  console.log("  ✓ DLC_Unlocker.png сохранён");

  // 5. Eclipse Manifest
  console.log("Снятие скриншота: Eclipse_Manifest.png");
  await page.goto(`${baseUrl}?view=lua`);
  await sleep(1200);
  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "Eclipse_Manifest.png") });
  console.log("  ✓ Eclipse_Manifest.png сохранён");

  // 6. Гипервизор (вкладка Гипервизор)
  console.log("Снятие скриншота: Гипервизор.png");
  await page.goto(`${baseUrl}?view=hypervisor`);
  await sleep(600);
  await page.evaluate(() => {
    const log = document.getElementById("hv-log");
    if (log && log.children.length === 1) {
      const now = new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      const line1 = document.createElement("div");
      line1.className = "hv-log-line info";
      line1.innerHTML = `<time>${now}</time><span>Проверяю обновления профилей с GitHub через async/await и несколько потоков.</span>`;
      const line2 = document.createElement("div");
      line2.className = "hv-log-line success";
      line2.innerHTML = `<time>${now}</time><span>Профили запуска уже актуальны.</span>`;
      log.appendChild(line1);
      log.appendChild(line2);
    }
  });
  await sleep(300);
  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "Гипервизор.png") });
  console.log("  ✓ Гипервизор.png сохранён");

  // 7. Античиты (вкладка Античиты)
  console.log("Снятие скриншота: Античиты.png");
  await page.evaluate(() => {
    const btn = document.querySelector('button[data-hv-tab="anticheat"]');
    if (btn) btn.click();
  });
  await sleep(800);
  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "Античиты.png") });
  console.log("  ✓ Античиты.png сохранён");

  // 8. VBS & HVCI (вкладка VBS)
  console.log("Снятие скриншота: VBS.png");
  await page.evaluate(() => {
    const btn = document.querySelector('button[data-hv-tab="vbs"]');
    if (btn) btn.click();
  });
  await sleep(800);
  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "VBS.png") });
  console.log("  ✓ VBS.png сохранён");

  // 9. Кряки
  console.log("Снятие скриншота: Кряки.png");
  await page.goto(`${baseUrl}?view=files`);
  await sleep(1200);
  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "Кряки.png") });
  console.log("  ✓ Кряки.png сохранён");

  // 10. Утилиты
  console.log("Снятие скриншота: Утилиты.png");
  await page.goto(`${baseUrl}?view=utilities`);
  await sleep(800);
  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "Утилиты.png") });
  console.log("  ✓ Утилиты.png сохранён");

  // 11. Настройки
  console.log("Снятие скриншота: Настройки.png");
  await page.goto(`${baseUrl}?view=settings`);
  await sleep(800);
  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "Настройки.png") });
  console.log("  ✓ Настройки.png сохранён");

  // 12. Telegram Каналы
  console.log("Снятие скриншота: Telegram_Каналы.png");
  await page.click("#open-telegram-hub");
  await sleep(600);
  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "Telegram_Каналы.png") });
  console.log("  ✓ Telegram_Каналы.png сохранён");

  console.log("Закрытие браузера и сервера...");
  await browser.close();
  server.close();
  console.log("Все 12 скриншотов и compare-eclipse.png успешно обновлены!");
}

main().catch((err) => {
  console.error("Ошибка при снятии скриншотов:", err);
  process.exit(1);
});
