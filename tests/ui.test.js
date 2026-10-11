/*
 * UI-тесты Crocodile Gena Studio 5.2.
 * Запуск:  node tests/ui.test.js        (нужны playwright и Chromium)
 * Переменные: CHROMIUM=/путь/к/chromium, SCREENSHOTS=папка для скриншотов
 */
const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const PAGE = "file://" + path.join(ROOT, "ui", "index.html");
const MOCK = fs.readFileSync(path.join(__dirname, "tauri-mock.js"), "utf8");
const LIB_RS = fs.readFileSync(path.join(ROOT, "src-tauri", "src", "lib.rs"), "utf8");
const COMMANDS = [...LIB_RS.matchAll(/^\s+(?:[a-z_]+::)?([a-z_0-9]+),\s*$/gm)].map((m) => m[1]);
const SHOTS = process.env.SCREENSHOTS || "";

const results = [];
let browser;

function assert(condition, message) { if (!condition) throw new Error(message); }

async function open({ storage = {}, mock = {}, view = "home", viewport = { width: 1440, height: 900 } } = {}) {
  const context = await browser.newContext({ viewport });
  const errors = [];
  await context.addInitScript(({ storage, mock, commands, script }) => {
    if (!sessionStorage.getItem("__seeded")) {
      localStorage.clear();
      for (const [key, value] of Object.entries(storage)) localStorage.setItem(key, value);
      sessionStorage.setItem("__seeded", "1");
    }
    window.__CGS_MOCK_CONFIG__ = { commands, ...mock };
    new Function(script)();
  }, { storage, mock, commands: COMMANDS, script: MOCK });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push("pageerror: " + error.message));
  page.on("console", (msg) => { if (msg.type() === "error") errors.push("console: " + msg.text()); });
  await page.goto(`${PAGE}?view=${view}`);
  await page.waitForTimeout(400);
  return { page, context, errors };
}

const calls = (page, name) => page.evaluate((n) => window.__mockCalls.filter((c) => !n || c.command === n), name);

async function test(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - started });
    console.log(`  ✓ ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error: error.message });
    console.log(`  ✗ ${name}\n      ${error.message}`);
  }
}

async function run() {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ["--allow-file-access-from-files"] });
  console.log(`Команд бэкенда в lib.rs: ${COMMANDS.length}`);

  await test("Все команды, которые вызывает интерфейс, зарегистрированы в lib.rs", async () => {
    const ui = fs.readdirSync(path.join(ROOT, "ui")).filter((f) => f.endsWith(".js"))
      .map((f) => fs.readFileSync(path.join(ROOT, "ui", f), "utf8")).join("\n");
    const used = new Set([...ui.matchAll(/(?:call|invoke)\("([a-z_0-9]+)"/g)].map((m) => m[1]));
    const missing = [...used].filter((c) => !COMMANDS.includes(c));
    assert(missing.length === 0, "Не зарегистрированы: " + missing.join(", "));
  });

  await test("Запуск без ошибок JS, версия 6.0.0", async () => {
    const { page, context, errors } = await open();
    const version = await page.textContent(".titlebar-version");
    assert(version.trim() === "6.0.0", "версия " + version);
    assert(errors.length === 0, errors.join("\n"));
    await context.close();
  });

  await test("Плашек NEW у Гипервизора и Утилит нет", async () => {
    const { page, context } = await open();
    const count = await page.locator(".nav-item .nav-live").count();
    assert(count === 0, `найдено ${count}`);
    await context.close();
  });

  await test("Все разделы открываются, заголовок меняется, есть анимация появления", async () => {
    const { page, context, errors } = await open();
    const views = await page.$$eval(".nav-item[data-view]", (items) => items.map((i) => i.dataset.view));
    for (const view of views) {
      await page.click(`.nav-item[data-view="${view}"]`);
      await page.waitForTimeout(120);
      const state = await page.evaluate((v) => ({
        active: document.querySelector(`[data-view-panel="${v}"]`).classList.contains("active"),
        visible: document.querySelector(`[data-view-panel="${v}"]`).offsetParent !== null,
        animated: document.querySelectorAll(`[data-view-panel="${v}"] .motion-rise`).length,
        nav: document.querySelector(`.nav-item[data-view="${v}"]`).classList.contains("active"),
      }), view);
      assert(state.active && state.visible && state.nav, `раздел ${view} не открылся`);
      assert(state.animated > 0, `в разделе ${view} нет анимации появления`);
    }
    await page.waitForTimeout(800);
    const leftovers = await page.locator(".motion-rise").count();
    assert(leftovers === 0, "классы анимации не снимаются");
    assert(errors.length === 0, errors.join("\n"));
    await context.close();
  });

  await test("Темы: применение и сохранение после перезапуска", async () => {
    const { page, context } = await open({ view: "settings" });
    const themes = await page.$$eval("[data-theme-option]", (b) => b.map((x) => x.dataset.themeOption));
    assert(themes.length === 8, "тем " + themes.length);
    for (const theme of themes) {
      await page.click(`[data-theme-option="${theme}"]`);
      assert(await page.evaluate(() => document.documentElement.dataset.theme) === theme, "тема " + theme);
    }
    await page.click('[data-theme-option="forest"]');
    await page.reload(); await page.waitForTimeout(300);
    assert(await page.evaluate(() => document.documentElement.dataset.theme) === "forest", "тема не сохранилась");
    assert(await page.locator('[data-theme-option="forest"].active').count() === 1, "активная тема не отмечена");
    await context.close();
  });

  await test("Названия тем и цветов — обычные русские слова", async () => {
    const { page, context } = await open({ view: "settings" });
    const themeNames = await page.$$eval(".theme-name", (n) => n.map((x) => x.textContent.trim()));
    const accentNames = await page.$$eval(".accent", (n) => n.map((x) => x.title));
    const expectedThemes = ["Стандартная", "Тёмно-синяя", "Чёрная", "Зелёная", "Фиолетовая", "Бордовая", "Коричневая", "Серая"];
    const expectedAccents = ["Зелёный", "Голубой", "Синий", "Фиолетовый", "Розовый", "Малиновый", "Красный", "Оранжевый", "Жёлтый", "Салатовый", "Бежевый", "Белый"];
    assert(JSON.stringify(themeNames) === JSON.stringify(expectedThemes), "темы: " + themeNames.join(", "));
    assert(JSON.stringify(accentNames) === JSON.stringify(expectedAccents), "акценты: " + accentNames.join(", "));
    await context.close();
  });

  await test("Акценты меняют цвет и сохраняются", async () => {
    const { page, context } = await open({ view: "settings" });
    const accents = await page.$$eval(".accent", (b) => b.map((x) => x.dataset.accent));
    const colors = new Set();
    for (const accent of accents) {
      await page.click(`.accent[data-accent="${accent}"]`);
      colors.add(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()));
    }
    assert(colors.size === accents.length, `уникальных цветов ${colors.size} из ${accents.length}`);
    await page.reload(); await page.waitForTimeout(300);
    assert(await page.evaluate(() => localStorage.getItem("accent")) === accents.at(-1), "акцент не сохранился");
    await context.close();
  });

  await test("Компактный режим уменьшает интерфейс и сохраняется", async () => {
    const { page, context } = await open({ view: "settings" });
    const before = await page.evaluate(() => document.querySelector(".nav-item").getBoundingClientRect().height);
    await page.click("label.pref-row:has(#compact-mode)");
    await page.waitForTimeout(450); // у пунктов меню плавная анимация размера
    const after = await page.evaluate(() => document.querySelector(".nav-item").getBoundingClientRect().height);
    assert(after < before, `высота пункта меню ${before} → ${after}`);
    await page.reload(); await page.waitForTimeout(300);
    assert(await page.evaluate(() => document.documentElement.classList.contains("compact")), "не сохранился");
    assert(await page.isChecked("#compact-mode"), "переключатель не отмечен");
    await context.close();
  });

  await test("Размер шрифта: пресеты и ползунок", async () => {
    const { page, context } = await open({ view: "settings" });
    const size = () => page.evaluate(() => parseFloat(getComputedStyle(document.querySelector(".settings-card h2")).fontSize));
    const base = await size();
    await page.click('[data-font-preset="130"]');
    const big = await size();
    assert(Math.abs(big / base - 1.3) < 0.02, `масштаб ${big / base}`);
    await page.locator("#font-scale").fill("85");
    assert((await page.textContent("#font-scale-value")).trim() === "85%", "подпись ползунка");
    await page.reload(); await page.waitForTimeout(300);
    assert(await page.evaluate(() => localStorage.getItem("cgs-font-scale")) === "85", "не сохранился");
    await context.close();
  });

  for (const [compact, font] of [["0", "100"], ["1", "100"], ["1", "120"], ["1", "140"], ["0", "140"]]) {
    await test(`Иконки меню не исчезают и ничего не вылезает (компакт=${compact}, шрифт=${font}%)`, async () => {
      const { page, context } = await open({ storage: { "cgs-compact": compact, "cgs-font-scale": font } });
      await page.waitForTimeout(600); // дождаться окончания анимации появления иконок
      const report = await page.evaluate(() => {
        const icons = [...document.querySelectorAll(".nav-item > svg")].map((svg) => ({
          view: svg.parentElement.dataset.view, width: svg.getBoundingClientRect().width,
        }));
        const sidebar = document.querySelector(".sidebar").getBoundingClientRect();
        const overflow = [...document.querySelectorAll(".sidebar .channel-card, .sidebar .nav-item, .brand-block")]
          .filter((el) => el.getBoundingClientRect().right > sidebar.right + 1)
          .map((el) => el.className);
        return { icons, overflow };
      });
      const tiny = report.icons.filter((i) => i.width < 14);
      assert(tiny.length === 0, "сжатые иконки: " + tiny.map((i) => `${i.view}=${i.width}px`).join(", "));
      assert(report.overflow.length === 0, "выходят за панель: " + report.overflow.join(", "));
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `sidebar-c${compact}-f${font}.png`) });
      await context.close();
    });
  }

  await test("Левая панель: перетаскивание, ограничения, сохранение, сброс", async () => {
    const { page, context } = await open();
    const width = () => page.evaluate(() => document.querySelector(".sidebar").getBoundingClientRect().width);
    const initial = await width();
    const box = await page.locator("#sidebar-resizer").boundingBox();
    const x = box.x + box.width / 2;
    await page.mouse.move(x, 400); await page.mouse.down(); await page.mouse.move(x + 80, 400, { steps: 6 }); await page.mouse.up();
    const dragged = await width();
    assert(Math.abs(dragged - (initial + 80)) <= 2, `ширина ${initial} → ${dragged}`);
    await page.mouse.move(x + 80, 400); await page.mouse.down(); await page.mouse.move(x + 900, 400, { steps: 6 }); await page.mouse.up();
    assert(await width() === 380, "максимум не соблюдается: " + await width());
    const box2 = await page.locator("#sidebar-resizer").boundingBox();
    await page.mouse.move(box2.x + 4, 400); await page.mouse.down(); await page.mouse.move(10, 400, { steps: 6 }); await page.mouse.up();
    assert(await width() === 180, "минимум не соблюдается: " + await width());
    await page.reload(); await page.waitForTimeout(300);
    assert(await width() === 180, "позиция не сохранилась");
    await page.focus("#sidebar-resizer"); await page.keyboard.press("ArrowRight");
    assert(await width() === 190, "клавиатура: " + await width());
    await page.dblclick("#sidebar-resizer");
    assert(Math.abs(await width() - initial) <= 1, "сброс не вернул ширину");
    assert(await page.evaluate(() => localStorage.getItem("cgs-sidebar-width")) === null, "сброс не очистил настройку");
    await context.close();
  });

  await test("Плашки Telegram: подписи и ссылки", async () => {
    const { page, context } = await open();
    const labels = await page.$$eval(".channel-card strong", (n) => n.map((x) => x.textContent.trim()));
    assert(JSON.stringify(labels) === JSON.stringify(["Телеграм разработчика", "Телеграм создателя форка", "Наш Telegram"]), labels.join(" | "));
    for (const id of ["#open-personal-channel", "#open-fork-channel", "#open-community-channel"]) await page.click(id);
    await page.waitForTimeout(100);
    const urls = (await calls(page, "open_external")).map((c) => c.args.url);
    for (const url of ["https://t.me/crocodilehub2", "https://t.me/gde_sparki", "https://t.me/piratestationn"]) assert(urls.includes(url), "нет вызова " + url);
    await context.close();
  });

  await test("Сервис манифестов: ссылки на Ryuu и HubCap", async () => {
    const { page, context } = await open({ view: "settings" });
    await page.click('[data-external-url="https://generator.ryuu.lol/"]');
    await page.click('[data-external-url="https://hubcapmanifest.com/"]');
    await page.waitForTimeout(100);
    const urls = (await calls(page, "open_external")).map((c) => c.args.url);
    assert(urls.includes("https://generator.ryuu.lol/") && urls.includes("https://hubcapmanifest.com/"), urls.join(", "));
    await context.close();
  });

  await test("Папка загрузки: по умолчанию, выбор, открытие, сброс, передача в загрузку", async () => {
    const { page, context, errors } = await open({ view: "settings" });
    await page.waitForTimeout(150);
    assert((await page.textContent("#download-dir-path")).includes("Downloads"), "путь по умолчанию не показан");
    assert(await page.isHidden("#download-dir-reset"), "сброс виден без своей папки");
    await page.click("#download-dir-pick"); await page.waitForTimeout(100);
    assert((await page.textContent("#download-dir-path")).trim() === "D:\\Cracks", "выбранный путь не показан");
    assert((await page.textContent("#download-dir-kind")).trim() === "Своя папка", "метка");
    await page.click("#download-dir-open"); await page.waitForTimeout(100);
    const open_ = await calls(page, "files_open_download_dir");
    assert(open_.at(-1)?.args.path === "D:\\Cracks", "открытие: " + JSON.stringify(open_));
    await page.click('.nav-item[data-view="files"]'); await page.waitForTimeout(300);
    await page.click('.file-download[data-files-url="https://example.com/r0.zip"]'); await page.waitForTimeout(200);
    const dl = await calls(page, "files_download");
    assert(dl.at(-1)?.args.targetDir === "D:\\Cracks", "targetDir: " + JSON.stringify(dl.at(-1)));
    assert((await page.textContent("#files-status")).includes("«Cracks»"), "статус: " + await page.textContent("#files-status"));
    await page.click('.nav-item[data-view="settings"]');
    await page.click("#download-dir-reset"); await page.waitForTimeout(100);
    assert(await page.evaluate(() => localStorage.getItem("filesDownloadDir")) === null, "сброс");
    assert(errors.length === 0, errors.join("\n"));
    await context.close();
  });

  await test("Старый бэкенд без новых команд: нет ошибок «not found», работает запасной выбор", async () => {
    const { page, context } = await open({ view: "settings", mock: { missing: ["files_pick_download_dir", "files_open_download_dir", "files_default_download_dir"] } });
    await page.click("#download-dir-pick"); await page.waitForTimeout(150);
    assert((await page.textContent("#download-dir-path")).trim() === "D:\\Games\\Picked", "запасной диалог не сработал");
    await page.click("#download-dir-open"); await page.waitForTimeout(150);
    const toasts = await page.$$eval(".toast", (t) => t.map((x) => x.textContent));
    assert(!toasts.some((t) => /not found/i.test(t)), "сырые ошибки: " + toasts.join(" | "));
    assert(toasts.some((t) => t.includes("src-tauri")), "нет подсказки о пересборке: " + toasts.join(" | "));
    await context.close();
  });

  await test("Закреплённые кряки сворачиваются и состояние сохраняется", async () => {
    const { page, context } = await open({ view: "files" });
    await page.waitForTimeout(300);
    assert((await page.textContent("#files-featured-count")).trim() === "2", "счётчик");
    await page.click("#files-featured-toggle"); await page.waitForTimeout(1000);
    assert(await page.evaluate(() => document.querySelector("#files-featured").classList.contains("collapsed")), "не свернулось");
    assert(await page.getAttribute("#files-featured-toggle", "aria-expanded") === "false", "aria");
    const h = await page.evaluate(() => document.querySelector("#files-featured-body").getBoundingClientRect().height);
    assert(h < 2, "высота свёрнутого блока " + h);
    await page.reload(); await page.waitForTimeout(400);
    assert(await page.evaluate(() => document.querySelector("#files-featured").classList.contains("collapsed")), "не сохранилось");
    assert((await page.textContent("#files-featured-label")).trim() === "Показать", "подпись");
    await page.click("#files-featured-toggle"); await page.waitForTimeout(400);
    assert(await page.evaluate(() => document.querySelector("#files-featured-body").getBoundingClientRect().height) > 100, "не развернулось");
    await context.close();
  });

  await test("Фоновое обновление каталога не перезапускает анимацию карточек", async () => {
    const { page, context } = await open({ view: "files" });
    await page.waitForTimeout(1200);
    let restarted = 0;
    await page.exposeFunction("__restart", () => { restarted += 1; });
    await page.evaluate(() => new MutationObserver((r) => r.forEach((m) => { if (m.target.classList?.contains("motion-rise")) window.__restart(); }))
      .observe(document.querySelector("#files-grid"), { subtree: true, attributes: true, attributeFilter: ["class"] }));
    await page.waitForTimeout(3600); // за это время каталог обновляется в фоне
    assert(restarted === 0, `анимация перезапускалась ${restarted} раз`);
    await page.evaluate(() => {
      window.__risen = 0;
      new MutationObserver((r) => r.forEach((m) => {
        const nodes = m.type === "childList" ? [...m.addedNodes] : [m.target];
        nodes.forEach((n) => { if (n.nodeType === 1 && (n.classList.contains("motion-rise") || n.querySelector?.(".motion-rise"))) window.__risen += 1; });
      })).observe(document.querySelector("#files-grid"), { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
    });
    await page.click("#files-next");
    await page.waitForFunction(() => window.__risen > 0, null, { timeout: 2000 }).catch(() => {});
    assert(await page.evaluate(() => window.__risen) > 0, "смена страницы без анимации");
    await context.close();
  });

  await test("Скрытые блоки появляются с анимацией (ключ HubCap)", async () => {
    const { page, context } = await open({ view: "settings" });
    await page.click('.svc-option[data-service="hubcap"]'); await page.waitForTimeout(30);
    assert(await page.evaluate(() => document.querySelector("#svc-key-block").classList.contains("motion-appear")), "нет анимации");
    await context.close();
  });

  await test("Анимации можно отключить, настройка сохраняется", async () => {
    const { page, context } = await open({ view: "settings" });
    await page.click("label.pref-row:has(#motion-mode)");
    assert(await page.evaluate(() => document.documentElement.classList.contains("no-motion")), "не отключились");
    await page.click('.nav-item[data-view="home"]'); await page.waitForTimeout(50);
    assert(await page.locator(".motion-rise").count() === 0, "анимации идут при отключённой настройке");
    await page.reload(); await page.waitForTimeout(300);
    assert(await page.evaluate(() => document.documentElement.classList.contains("no-motion")), "не сохранилось");
    await context.close();
  });

  await test("Английский язык: новые строки переведены", async () => {
    const { page, context } = await open({ view: "settings" });
    await page.click('[data-language="en"]'); await page.waitForTimeout(150);
    const text = await page.evaluate(() => document.body.innerText);
    for (const s of ["Compact mode", "Font size", "Download folder", "Developer's Telegram", "Fork author's Telegram", "Interface animations", "Default", "Burgundy", "Open Ryuu"]) {
      assert(text.includes(s), "нет перевода: " + s);
    }
    await page.click('[data-language="ru"]'); await page.waitForTimeout(150);
    assert((await page.evaluate(() => document.body.innerText)).includes("Компактный режим"), "возврат на русский");
    await context.close();
  });

  await test("Окно 1080×700 (минимальный размер): без ошибок во всех разделах", async () => {
    const { page, context, errors } = await open({ viewport: { width: 1080, height: 700 }, storage: { "cgs-compact": "1", "cgs-font-scale": "120" } });
    for (const view of ["home", "fix", "saves", "dlc", "lua", "hypervisor", "files", "utilities", "settings"]) {
      await page.click(`.nav-item[data-view="${view}"]`); await page.waitForTimeout(80);
      const wide = await page.evaluate(() => document.querySelector(".main-area").scrollWidth - document.querySelector(".main-area").clientWidth);
      assert(wide <= 1, `${view}: горизонтальная прокрутка ${wide}px`);
    }
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "min-window-settings.png") });
    assert(errors.length === 0, errors.join("\n"));
    await context.close();
  });

  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\nИтого: ${results.length - failed.length} из ${results.length} тестов пройдено`);
  process.exit(failed.length ? 1 : 0);
}

run().catch((error) => { console.error(error); process.exit(1); });
