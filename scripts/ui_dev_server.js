// Локальный HTTP-сервер для разработки и тестирования интерфейса Eclipse Studio в браузере.

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

// Общий мок используется также UI-тестами и средством снятия снимков.
const devMock = require("./dev-mock.cjs");
function generateMockScript() { return devMock(fullCatalogFiles); }

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

    // Если запрашивается HTML-файл, внедряем мок-скрипт перед остальными скриптами
    if (ext === ".html") {
      let html = fs.readFileSync(filePath, "utf8");
      const injectTag = '<script src="/tauri-dev-mock.js"></script>';
      if (!html.includes("/tauri-dev-mock.js")) {
        html = html.replace("<head>", `<head>\n  ${injectTag}`);
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
    console.log("=".repeat(64));
    console.log(`🌒 Сервер разработки Eclipse Studio UI запущен!`);
    console.log(`📍 Адрес: http://127.0.0.1:${port}/`);
    console.log(`✨ Мок Tauri API активен: каталог кряков, библиотека Steam, VBS, античиты.`);
    console.log(`🎨 Акцент по умолчанию: Белый (white), тема: Графит (graphite).`);
    console.log(`🔄 Редактируйте файлы в папке ui/ — изменения вступают в силу при обновлении страницы.`);
    console.log("=".repeat(64));
  });
}

const args = process.argv.slice(2);
const portIndex = args.indexOf("--port");
const port = portIndex !== -1 && args[portIndex + 1] ? parseInt(args[portIndex + 1], 10) : 8080;

startDevServer(port);
