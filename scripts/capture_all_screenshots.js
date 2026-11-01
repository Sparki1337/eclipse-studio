// Скрипт автоматического фонового снятия скриншотов интерфейса для раздела docs

const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");

// Путь к системному браузеру Microsoft Edge
const EDGE_PATH = process.env.CHROMIUM || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

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
    build: "Build 8.2.0",
    password: "",
    pinned: true,
    url: "https://github.com/LeoBanned/crocodile-gena-studio-releases/download/v8.2.0/setup.exe",
  },
  {
    name: "Eclipse Studio",
    build: "Build 8.2.0",
    password: "",
    pinned: true,
    url: "https://github.com/Sparki1337/eclipse-studio/download/v8.2.0/Eclipse-Studio-v8.2.0.exe",
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
      let decoded;
    try { decoded = decodeURIComponent(urlPath); } catch (_) { res.writeHead(400); res.end(); return; }
    const filePath = path.resolve(UI_DIR, "." + decoded);
    const relative = path.relative(UI_DIR, filePath);
    if (decoded.includes("\0") || relative.startsWith("..") || path.isAbsolute(relative)) { res.writeHead(403); res.end(); return; }

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

  // Тот же мок и те же IPC-контракты, что в npm test.
  await page.evaluateOnNewDocument(require("./dev-mock.cjs")(fullCatalogFiles));

  const baseUrl = `http://127.0.0.1:${port}/index.html`;

  // 1. Главная
  console.log("Снятие скриншота: Главная.png");
  await page.goto(`${baseUrl}?view=home`);
  await page.waitForFunction(() => document.documentElement.dataset.ready === "true");
  await sleep(800);
  const homePath = path.join(SCREENSHOTS_DIR, "Главная.png");
  await page.screenshot({ path: homePath });
  const comparePath = path.join(ASSETS_DIR, "compare-eclipse.png");
  fs.copyFileSync(homePath, comparePath);
  console.log("  ✓ Главная.png и compare-eclipse.png сохранены");

  // 2. Online Fix
  console.log("Снятие скриншота: Online_Fix.png");
  await page.goto(`${baseUrl}?view=fix`);
  await page.waitForFunction(() => document.documentElement.dataset.ready === "true");
  await sleep(800);
  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "Online_Fix.png") });
  console.log("  ✓ Online_Fix.png сохранён");

  // 3. Менеджер сохранений
  console.log("Снятие скриншота: Менеджер_сохранений.png");
  await page.goto(`${baseUrl}?view=saves`);
  await page.waitForFunction(() => document.documentElement.dataset.ready === "true");
  await sleep(800);
  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "Менеджер_сохранений.png") });
  console.log("  ✓ Менеджер_сохранений.png сохранён");

  // 4. DLC Unlocker
  console.log("Снятие скриншота: DLC_Unlocker.png");
  await page.goto(`${baseUrl}?view=dlc`);
  await page.waitForFunction(() => document.documentElement.dataset.ready === "true");
  await sleep(400);
  await page.click("#dlc-library-scan");
  await sleep(1400);
  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "DLC_Unlocker.png") });
  console.log("  ✓ DLC_Unlocker.png сохранён");

  // 5. Eclipse Manifest
  console.log("Снятие скриншота: Eclipse_Manifest.png");
  await page.goto(`${baseUrl}?view=lua`);
  await page.waitForFunction(() => document.documentElement.dataset.ready === "true");
  await sleep(1200);
  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "Eclipse_Manifest.png") });
  console.log("  ✓ Eclipse_Manifest.png сохранён");

  // 6. Гипервизор (вкладка Гипервизор)
  console.log("Снятие скриншота: Гипервизор.png");
  await page.goto(`${baseUrl}?view=hypervisor`);
  await page.waitForFunction(() => document.documentElement.dataset.ready === "true");
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
  await page.waitForFunction(() => document.documentElement.dataset.ready === "true");
  await sleep(1200);
  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "Кряки.png") });
  console.log("  ✓ Кряки.png сохранён");

  // 10. Утилиты
  console.log("Снятие скриншота: Утилиты.png");
  await page.goto(`${baseUrl}?view=utilities`);
  await page.waitForFunction(() => document.documentElement.dataset.ready === "true");
  await sleep(800);
  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "Утилиты.png") });
  console.log("  ✓ Утилиты.png сохранён");

  // 11. Настройки
  console.log("Снятие скриншота: Настройки.png");
  await page.goto(`${baseUrl}?view=settings`);
  await page.waitForFunction(() => document.documentElement.dataset.ready === "true");
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
