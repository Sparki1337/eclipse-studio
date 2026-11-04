// UI-тесты интерфейса
const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const PAGE = "file://" + path.join(ROOT, "ui", "index.html");
const MOCK = fs.readFileSync(path.join(__dirname, "tauri-mock.js"), "utf8");
const LIB_RS = fs.readFileSync(path.join(ROOT, "src-tauri", "src", "lib.rs"), "utf8");
const VBS_RS = fs.readFileSync(path.join(ROOT, "src-tauri", "src", "vbs.rs"), "utf8");
const COMMANDS = [...LIB_RS.matchAll(/^\s+(?:[a-z_]+::)?([a-z_0-9]+),\s*$/gm)].map((m) => m[1]);
const SHOTS = process.env.SCREENSHOTS || "";

const results = [];
let browser;

function assert(condition, message) { if (!condition) throw new Error(message); }

async function open({ storage = {}, mock = {}, view = "home", viewport = { width: 1440, height: 900 }, reducedMotion = "no-preference" } = {}) {
  const context = await browser.newContext({ viewport, reducedMotion });
  // Подменяем внешние обложки, чтобы тесты не зависели от CDN Steam
  await context.route(/^https?:\/\//, route => route.request().resourceType() === "image"
    ? route.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1YQAAAAASUVORK5CYII=", "base64") })
    : route.continue());
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
  page.setDefaultTimeout(6000);
  if (!mock.migrationFailure) {
    await page.waitForFunction(() => document.documentElement.dataset.ready === "true");
    await page.locator("#app-splash").waitFor({state:"hidden",timeout:12000});
  }
  await page.waitForTimeout(450);
  return { page, context, errors };
}

async function reload(page) {
  await page.evaluate(() => window.cgsStorage?.flush());
  await page.reload();
  await page.waitForFunction(() => document.documentElement.dataset.ready === "true");
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
  } finally { for (const context of browser.contexts()) await context.close(); }
}

async function trackMotion(page) {
  await page.evaluate(() => {
    window.__motionRecords = [];
    const original = Element.prototype.animate;
    Element.prototype.animate = function (...args) {
      const animation = original.apply(this, args);
      window.__motionRecords.push({ element: this, animation });
      return animation;
    };
  });
}

async function freezeSearchExit(page) {
  await page.evaluate(() => {
    const transition = window.cgsMotion.transition;
    window.cgsMotion.transition = (...args) => {
      const animation = transition(...args);
      if (animation && args[0].closest("#cgs-search") && args[3] === "exit") {
        animation.pause();
        animation.currentTime = 90;
      }
      return animation;
    };
  });
}

async function run() {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM || (fs.existsSync("/usr/local/bin/chromium") ? "/usr/local/bin/chromium" : undefined), args: ["--allow-file-access-from-files"] });
  console.log(`Команд бэкенда в lib.rs: ${COMMANDS.length}`);

  await test("Все команды, которые вызывает интерфейс, зарегистрированы в lib.rs", async () => {
    const ui = fs.readdirSync(path.join(ROOT,"ui"), { recursive:true }).filter(f=>f.endsWith(".js")).map(f=>fs.readFileSync(path.join(ROOT,"ui",f),"utf8")).join("\n");
    const used = new Set([...ui.matchAll(/(?:call|invoke)\("([a-z_0-9]+)"/g)].map((m) => m[1]));
    const missing = [...used].filter((c) => !COMMANDS.includes(c));
    assert(missing.length === 0, "Не зарегистрированы: " + missing.join(", "));
  });

  await test("Запуск без ошибок JS, версия 9.0.0", async () => {
    const { page, context, errors } = await open();
    const version = await page.textContent(".titlebar-version");
    assert(version.trim() === "9.0.0", "версия " + version);
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
    await page.evaluate(()=>{window.__titleMotionCount=0;new MutationObserver(records=>{for(const record of records){if(record.target.classList.contains("motion-title"))window.__titleMotionCount++;}}).observe(document.querySelector("#page-title"),{attributes:true,attributeFilter:["class"]});});
    const views = await page.$$eval(".nav-item[data-view]", (items) => items.map((i) => i.dataset.view));
    for (const view of [...views.filter(v => v !== "home"), "home"]) {
      const animationBefore=await page.evaluate(()=>window.__titleMotionCount);
      await page.click(`.nav-item[data-view="${view}"]`);
      await page.waitForFunction(before=>window.__titleMotionCount>before,animationBefore,{timeout:3000});
      const state = await page.evaluate((v) => ({
        active: document.querySelector(`[data-view-panel="${v}"]`).classList.contains("active"),
        visible: document.querySelector(`[data-view-panel="${v}"]`).offsetParent !== null,
        animated: window.__titleMotionCount > 0,
        nav: document.querySelector(`.nav-item[data-view="${v}"]`).classList.contains("active"),
      }), view);
      assert(state.active && state.visible && state.nav, `раздел ${view} не открылся`);
      assert(state.animated, `в разделе ${view} нет анимации появления`);
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
    assert(themes.length === 12, "тем " + themes.length);
    for (const theme of themes) {
      await page.click(`[data-theme-option="${theme}"]`);
      assert(await page.evaluate(() => document.documentElement.dataset.theme) === theme, "тема " + theme);
    }
    await page.click('[data-theme-option="forest"]');
    await reload(page); await page.waitForTimeout(300);
    assert(await page.evaluate(() => document.documentElement.dataset.theme) === "forest", "тема не сохранилась");
    assert(await page.locator('[data-theme-option="forest"].active').count() === 1, "активная тема не отмечена");
    await context.close();
  });

  await test("Названия тем и цветов — обычные русские слова", async () => {
    const { page, context } = await open({ view: "settings" });
    const themeNames = await page.$$eval(".theme-name", (n) => n.map((x) => x.textContent.trim()));
    const accentNames = await page.$$eval(".accent", (n) => n.map((x) => x.title));
    const expectedThemes = ["Чёрная", "Графит", "Серая", "Белая", "Красная", "Оранжевая", "Жёлтая", "Зелёная", "Бирюзовая", "Синяя", "Фиолетовая", "Розовая"];
    const expectedAccents = ["Белый", "Красный", "Оранжевый", "Жёлтый", "Золотой", "Лаймовый", "Мятный", "Бирюзовый", "Синий", "Фиолетовый", "Розовый", "Малиновый"];
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
    await reload(page); await page.waitForTimeout(300);
    assert(await page.evaluate(() => window.cgsStorage.getItem("accent")) === accents.at(-1), "акцент не сохранился");
    await context.close();
  });

  await test("Компактный режим уменьшает интерфейс и сохраняется", async () => {
    const { page, context } = await open({ view: "settings", storage: { "cgs-compact": "0" } });
    const before = await page.evaluate(() => document.querySelector(".nav-item").getBoundingClientRect().height);
    await page.click("label.pref-row:has(#compact-mode)");
    await page.waitForTimeout(450); // У пунктов меню плавная анимация размера
    const after = await page.evaluate(() => document.querySelector(".nav-item").getBoundingClientRect().height);
    assert(after < before, `высота пункта меню ${before} → ${after}`);
    await reload(page); await page.waitForTimeout(300);
    assert(await page.evaluate(() => document.documentElement.classList.contains("compact")), "не сохранился");
    assert(await page.isChecked("#compact-mode"), "переключатель не отмечен");
    await context.close();
  });

  await test("Размер шрифта: ползунок, стандарт 120% и сохранение", async () => {
    const { page, context } = await open({ view: "settings" });
    const size = () => page.evaluate(() => parseFloat(getComputedStyle(document.querySelector(".settings-card h2")).fontSize));
    const base = await size();
    await page.locator("#font-scale").fill("130");
    await page.locator("#font-scale").dispatchEvent("input");
    const big = await size();
    assert(Math.abs(big / base - 130 / 120) < 0.02, `масштаб ${big / base}`);
    await page.locator("#font-scale").fill("120"); await page.locator("#font-scale").dispatchEvent("input");
    assert((await page.textContent("#font-scale-value")).trim() === "120%", "сброс к 120%");
    await page.locator("#font-scale").fill("85");
    await page.locator("#font-scale").dispatchEvent("input");
    assert((await page.textContent("#font-scale-value")).trim() === "85%", "подпись ползунка");
    await reload(page); await page.waitForTimeout(300);
    assert(await page.evaluate(() => window.cgsStorage.getItem("cgs-font-scale")) === "85", "не сохранился");
    // Возвращаем масштаб 120% обратно
    await page.locator("#font-scale").fill("120");
    await page.locator("#font-scale").dispatchEvent("input");
    await page.evaluate(() => window.cgsStorage?.flush());
    await context.close();
  });

  for (const [compact, font] of [["0", "100"], ["1", "100"], ["1", "120"], ["1", "140"], ["0", "140"]]) {
    await test(`Иконки меню не исчезают и ничего не вылезает (компакт=${compact}, шрифт=${font}%)`, async () => {
      const { page, context } = await open({ storage: { "cgs-compact": compact, "cgs-font-scale": font } });
      await page.waitForTimeout(600); // Дождаться окончания анимации появления иконок
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
    await page.mouse.move(x, 400); await page.mouse.down(); await page.mouse.move(x + 80, 400, { steps: 6 }); await page.mouse.up(); await page.waitForTimeout(400);
    const dragged = await width();
    assert(Math.abs(dragged - (initial + 80)) <= 2, `ширина ${initial} → ${dragged}`);
    await page.mouse.move(x + 80, 400); await page.mouse.down(); await page.mouse.move(x + 900, 400, { steps: 6 }); await page.mouse.up(); await page.waitForTimeout(400);
    assert(await width() === 380, "максимум не соблюдается: " + await width());
    const box2 = await page.locator("#sidebar-resizer").boundingBox();
    await page.mouse.move(box2.x + 4, 400); await page.mouse.down(); await page.mouse.move(10, 400, { steps: 6 }); await page.mouse.up(); await page.waitForTimeout(400);
    // Минимум равен ширине рейки из дизайна «Корона» (84px), раньше был 180px
    assert(await width() === 84, "минимум не соблюдается: " + await width());
    await reload(page); await page.waitForTimeout(300);
    assert(await width() === 84, "позиция не сохранилась");
    await page.focus("#sidebar-resizer"); await page.keyboard.press("ArrowRight"); await page.waitForTimeout(400);
    assert(await width() === 94, "клавиатура: " + await width());
    await page.dblclick("#sidebar-resizer"); await page.waitForTimeout(400);
    assert(Math.abs(await width() - initial) <= 1, "сброс не вернул ширину");
    assert(await page.evaluate(() => window.cgsStorage.getItem("cgs-sidebar-width")) === null, "сброс не очистил настройку");
    await context.close();
  });

  await test("Плашки Telegram: подписи и ссылки", async () => {
    const { page, context } = await open();
    const labels = await page.$$eval(".channel-card strong", (n) => n.map((x) => x.textContent.trim()).filter(text => text !== "Telegram каналы"));
    assert(JSON.stringify(labels) === JSON.stringify(["Телеграм разработчика", "Телеграм создателя форка", "Наш Telegram"]), labels.join(" | "));
    await page.click("#open-telegram-hub");
    for (const id of ["#hub-channel-personal", "#hub-channel-fork", "#hub-channel-community"]) await page.click(id);
    await page.waitForTimeout(100);
    const urls = (await calls(page, "open_external")).map((c) => c.args.url);
    for (const url of ["https://t.me/crocodilehub2", "https://t.me/gde_sparki", "https://t.me/piratestationn"]) assert(urls.includes(url), "нет вызова " + url);
    await context.close();
  });

  await test("Кнопка Telegram в заголовке открывает хаб и не тянет окно", async () => {
    const { page, context } = await open();
    // Кнопка Telegram исключена из области перетаскивания окна
    await page.click("#open-telegram-hub");
    await page.waitForTimeout(80);
    assert((await calls(page, "start_dragging_window")).length === 0, "нажатие на Telegram запускает перетаскивание окна");
    assert(await page.isVisible("#telegram-hub-backdrop"), "хаб Telegram не открылся");
    await page.click("#telegram-hub-close");
    await page.click(".titlebar-brand");
    assert((await calls(page, "start_dragging_window")).length === 1, "заголовок перестал перетаскивать окно");
    await context.close();
  });

  await test("Сервис манифестов: ссылки на Ryuu и HubCap", async () => {
    const { page, context } = await open({ view: "settings" });
    await page.click('[data-settings-tab="modules"]');
    await page.waitForTimeout(50);
    await page.click('[data-external-url="https://generator.ryuu.lol/"]');
    await page.click('[data-external-url="https://hubcapmanifest.com/"]');
    await page.waitForTimeout(100);
    const urls = (await calls(page, "open_external")).map((c) => c.args.url);
    assert(urls.includes("https://generator.ryuu.lol/") && urls.includes("https://hubcapmanifest.com/"), urls.join(", "));
    await context.close();
  });

  await test("Папка загрузки: по умолчанию, выбор, открытие, сброс, передача в загрузку", async () => {
    const { page, context, errors } = await open({ view: "settings" });
    await page.click('[data-settings-tab="storage"]');
    await page.waitForTimeout(150);
    assert((await page.textContent("#download-dir-path")).includes("Downloads"), "путь по умолчанию не показан");
    assert(await page.isHidden("#download-dir-reset"), "сброс виден без своей папки");
    await page.click("#download-dir-pick"); await page.waitForTimeout(100);
    assert((await page.textContent("#download-dir-path")).trim() === "D:\\Cracks", "выбранный путь не показан");
    assert((await page.textContent("#download-dir-kind")).trim() === "Своя папка", "метка");
    await page.click("#download-dir-open"); await page.waitForTimeout(100);
    const open_ = await calls(page, "files_open_download_dir");
    assert(open_.at(-1)?.args.path === "D:\\Cracks", "открытие: " + JSON.stringify(open_));
    await page.evaluate(() => { const box = document.querySelector("#files-auto-install"); if (box.checked) { box.checked = false; box.dispatchEvent(new Event("change", {bubbles:true})); } });
    await page.click('.nav-item[data-view="files"]'); await page.waitForTimeout(300);
    await page.click('.file-download[data-files-url="https://example.com/r0.zip"]'); await page.waitForTimeout(200);
    const dl = await calls(page, "files_download");
    assert(dl.at(-1)?.args.targetDir === "D:\\Cracks", "targetDir: " + JSON.stringify(dl.at(-1)));
    assert((await page.textContent("#files-status")).includes("«Cracks»"), "статус: " + await page.textContent("#files-status"));
    await page.click('.nav-item[data-view="settings"]');
    await page.click("#download-dir-reset"); await page.waitForTimeout(100);
    assert(await page.evaluate(() => window.cgsStorage.getItem("filesDownloadDir")) === null, "сброс");
    assert(errors.length === 0, errors.join("\n"));
    await context.close();
  });

  await test("Старый бэкенд без новых команд: нет ошибок «not found», работает запасной выбор", async () => {
    const { page, context } = await open({ view: "settings", mock: { missing: ["files_pick_download_dir", "files_open_download_dir", "files_default_download_dir"] } });
    await page.click('[data-settings-tab="storage"]');
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
    await reload(page); await page.waitForTimeout(400);
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
    await page.waitForTimeout(3600); // За это время каталог обновляется в фоне
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

  await test("Блок ключа HubCap появляется на вкладке модулей", async () => {
    const { page, context } = await open({ view: "settings" });
    await page.click('[data-settings-tab="modules"]');
    await page.click('.svc-option[data-service="hubcap"]'); await page.waitForTimeout(30);
    assert(await page.isVisible("#svc-key-block"), "блок ключа не показан");
    await context.close();
  });

  await test("Анимации можно отключить, настройка сохраняется", async () => {
    const { page, context } = await open({ view: "settings" });
    await page.click("label.pref-row:has(#motion-mode)");
    assert(await page.evaluate(() => document.documentElement.classList.contains("no-motion")), "не отключились");
    await page.click('.nav-item[data-view="home"]'); await page.waitForTimeout(50);
    assert(await page.locator(".motion-rise").count() === 0, "анимации идут при отключённой настройке");
    await reload(page); await page.waitForTimeout(300);
    assert(await page.evaluate(() => document.documentElement.classList.contains("no-motion")), "не сохранилось");
    await context.close();
  });

  await test("Анимации: каскад блоков во всех разделах без изменения размеров", async () => {
    const { page, errors } = await open();
    await trackMotion(page);
    const views = await page.$$eval(".nav-item[data-view]", items => items.map(item => item.dataset.view));
    for (const view of [...views.filter(name => name !== "home"), "home"]) {
      await page.evaluate(() => { window.__motionRecords = []; });
      await page.click(`.nav-item[data-view="${view}"]`);
      await page.waitForFunction(name => window.__motionRecords.some(record => record.animation.id === "cgs-enter" && record.element.closest(`[data-view-panel="${name}"]`)), view);
      const dimensions = await page.evaluate(name => {
        const record = window.__motionRecords.find(item => item.animation.id === "cgs-enter" && item.element.closest(`[data-view-panel="${name}"]`));
        const element = record.element;
        const before = element.getBoundingClientRect();
        record.animation.finish();
        const after = element.getBoundingClientRect();
        return { width: Math.abs(before.width - after.width), height: Math.abs(before.height - after.height) };
      }, view);
      assert(dimensions.width < 1 && dimensions.height < 1, `${view}: анимация меняет размеры`);
    }
    await page.waitForTimeout(850);
    assert(await page.evaluate(() => !document.getAnimations().some(animation => animation.id.startsWith("cgs-"))), "переходы не завершились");
    assert(errors.length === 0, errors.join("\n"));
  });

  await test("Анимации: содержимое вкладок гипервизора и настроек", async () => {
    const { page, errors } = await open({ view: "hypervisor" });
    await trackMotion(page);
    for (const tab of ["anticheat", "vbs", "protections", "hypervisor"]) {
      await page.evaluate(() => { window.__motionRecords = []; });
      await page.click(`[data-hv-tab="${tab}"]`);
      await page.waitForFunction(name => window.__motionRecords.some(record => record.animation.id === "cgs-enter" && record.element.closest(`[data-hv-tab-panel="${name}"].active`)), tab);
    }
    await page.click('.nav-item[data-view="settings"]');
    for (const tab of ["home", "sidebar", "modules", "storage", "interface"]) {
      await page.evaluate(() => { window.__motionRecords = []; });
      await page.click(`[data-settings-tab="${tab}"]`);
      await page.waitForFunction(name => window.__motionRecords.some(record => record.animation.id === "cgs-enter" && record.element.closest(`[data-tab-panel="${name}"].active`)), tab);
    }
    assert(errors.length === 0, errors.join("\n"));
  });

  await test("Анимации: нижние секции появляются при прокрутке только один раз", async () => {
    const { page } = await open({ view: "settings" });
    await trackMotion(page);
    const target = page.locator("#collapse-language");
    assert(await target.evaluate(element => element.getBoundingClientRect().top > innerHeight), "секция уже на экране");
    await target.scrollIntoViewIfNeeded();
    await page.waitForFunction(() => window.__motionRecords.some(record => record.element.id === "collapse-language" && record.animation.id === "cgs-enter"));
    await page.waitForTimeout(450);
    const count = await page.evaluate(() => window.__motionRecords.filter(record => record.element.id === "collapse-language").length);
    await page.locator("#collapse-theme").scrollIntoViewIfNeeded();
    await target.scrollIntoViewIfNeeded();
    await page.waitForTimeout(120);
    assert(await page.evaluate(() => window.__motionRecords.filter(record => record.element.id === "collapse-language").length) === count, "секция повторно мигает при прокрутке");
  });

  await test("Анимации: счётчики реагируют только на изменение значения", async () => {
    const { page } = await open({ view: "saves" });
    await trackMotion(page);
    await page.evaluate(() => { document.querySelector("#save-location-count").textContent = "42"; });
    await page.waitForFunction(() => window.__motionRecords.some(record => record.element.id === "save-location-count" && record.animation.id === "cgs-value"));
    const count = await page.evaluate(() => window.__motionRecords.length);
    await page.evaluate(() => { document.querySelector("#save-location-count").textContent = "42"; });
    await page.waitForTimeout(80);
    assert(await page.evaluate(() => window.__motionRecords.length) === count, "неизменный счётчик мигает");
    assert((await page.textContent("#save-location-count")) === "42", "анимация подменяет данные");
  });

  await test("Анимации: системное уменьшение движения важнее сохранённого включения", async () => {
    const { page } = await open({ storage: { "cgs-motion": "1" }, reducedMotion: "reduce" });
    assert(await page.evaluate(() => document.documentElement.classList.contains("no-motion")), "системная настройка проигнорирована");
    assert(await page.isChecked("#motion-mode"), "системное событие изменило переключатель предпочтения");
    await page.click('.nav-item[data-view="lua"]');
    await page.waitForTimeout(50);
    assert(await page.evaluate(() => !document.getAnimations().some(animation => animation.id.startsWith("cgs-"))), "переходы работают при уменьшении движения");
    const durations = await page.evaluate(() => [...document.querySelectorAll("button,.premium-panel,input,.switch i")].filter(element => element.getClientRects().length).flatMap(element => getComputedStyle(element).transitionDuration.split(",").map(parseFloat)));
    assert(durations.every(duration => duration <= 0.000001), "тема не отключает свои переходы");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.waitForFunction(() => !document.documentElement.classList.contains("no-motion"));
    await trackMotion(page);
    await page.click('.nav-item[data-view="saves"]');
    await page.waitForFunction(() => window.__motionRecords.some(record => record.animation.id === "cgs-enter"));
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.waitForFunction(() => document.documentElement.classList.contains("no-motion"));
    assert(await page.evaluate(() => !document.getAnimations().some(animation => animation.id.startsWith("cgs-"))), "переходы не прерваны");
    assert(await page.evaluate(() => window.cgsStorage.getItem("cgs-motion")) === "1", "системное событие изменило выбор пользователя");
    await page.evaluate(() => window.cgsMotion.applyMotion(false));
    await page.emulateMedia({ reducedMotion: "no-preference" });
    assert(await page.evaluate(() => document.documentElement.classList.contains("no-motion")), "системное событие отменило ручное отключение");
  });

  await test("Анимации: аккордеон меняет направление и корректно отключается", async () => {
    const { page } = await open({ view: "settings" });
    const details = page.locator("#collapse-theme");
    const overflow = await details.evaluate(element => element.style.overflow);
    await details.locator("summary").click();
    await page.waitForTimeout(45);
    assert(await page.evaluate(() => document.getAnimations().some(animation => animation.id === "cgs-accordion")), "сворачивание без перехода");
    await details.locator("summary").evaluate(element => element.click());
    await page.evaluate(() => window.cgsMotion.applyMotion(false));
    assert(await details.evaluate(element => element.open), "аккордеон завис в неверном состоянии");
    assert(await details.evaluate(element => element.style.overflow) === overflow, "после прерывания остался временный стиль");
    assert(await page.evaluate(() => !document.getAnimations().some(animation => animation.id.startsWith("cgs-"))), "выключение оставило анимации");
    await details.locator("summary").focus();
    await page.keyboard.press("Enter");
    assert(!(await details.evaluate(element => element.open)), "без анимации нарушено управление клавиатурой");
  });

  await test("Анимации: меню сортировки появляется без задержки действий", async () => {
    const { page } = await open({ view: "files" });
    await trackMotion(page);
    await page.click("#files-sort-btn");
    await page.waitForFunction(() => window.__motionRecords.some(record => record.element.id === "files-sort-menu" && record.animation.id === "cgs-enter"));
    await page.click('#files-sort-menu [data-sort="name"]');
    assert(await page.locator("#files-sort-menu").evaluate(element => element.hidden), "меню не закрылось после выбора");
    assert((await page.textContent("#files-sort-label")).includes("названию"), "сортировка не применилась");
  });

  await test("Анимации: закрытие диалога сохраняет фокус и завершается при отключении", async () => {
    const { page } = await open();
    await page.locator('.nav-item[data-view="home"]').focus();
    await page.evaluate(() => { window.__dialogResult = null; window.cgsDialogs.show("Проверка", "Текст", { confirm: true }).then(value => { window.__dialogResult = value; }); });
    await page.waitForSelector("#modal-backdrop:not(.hidden)");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.getAnimations().some(animation => animation.id === "cgs-exit"));
    await page.evaluate(() => window.cgsMotion.applyMotion(false));
    await page.waitForFunction(() => window.__dialogResult === false);
    assert(await page.locator("#modal-backdrop").evaluate(element => element.classList.contains("hidden")), "окно не скрылось");
    assert(await page.evaluate(() => !document.activeElement.closest("[inert]") && document.activeElement.dataset.view === "home"), "фокус не вернулся");
    assert(await page.locator("[inert]").count() === 0, "страница осталась заблокирована");
  });

  await test("Анимации: выбор загрузчика и закрытие выпадающего списка", async () => {
    const { page } = await open({ view: "lua" });
    await trackMotion(page);
    await page.locator('#view-lua .loader-option[data-loader-source="v2"]').click();
    await page.waitForFunction(() => window.__motionRecords.some(record => record.animation.id === "cgs-select" && record.element.closest(".loader-option")));
    await page.waitForSelector("#modal-backdrop:not(.hidden)");
    assert(await page.textContent("#modal-title") === "Версия загрузчика обновлена", "нет подтверждения смены загрузчика");
    await page.click("#modal-cancel");
    await page.waitForSelector("#modal-backdrop", { state: "hidden" });
    assert((await calls(page, "luatools_restart_steam")).length === 0, "Steam запущен без согласия");
    await page.click('.nav-item[data-view="saves"]');
    const trigger = page.locator("#save-format + .custom-select-trigger");
    await trigger.click();
    await page.waitForSelector(".custom-select-dropdown.open");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => window.__motionRecords.some(record => record.animation.id === "cgs-exit" && record.element.classList.contains("custom-select-dropdown")));
    await page.waitForSelector(".custom-select-dropdown", { state: "detached" });
    assert(await trigger.getAttribute("aria-expanded") === "false", "список остался раскрытым для скринридера");
  });

  await test("Английский язык: новые строки переведены", async () => {
    const { page, context } = await open({ view: "settings" });
    await page.click('[data-language="en"]'); await page.waitForTimeout(150);
    const text = await page.evaluate(() => document.body.innerText);
    for (const value of ["Compact mode", "Font size", "Interface animations"]) assert(text.includes(value), "нет перевода: " + value);
    await page.click('[data-settings-tab="storage"]');
    assert((await page.innerText("#settings-panel-storage")).includes("Download folder"), "нет перевода папки загрузки");
    await page.click('[data-settings-tab="modules"]');
    assert((await page.innerText("#settings-panel-modules")).includes("Ryuu"), "нет сервисов");
    await page.click('[data-settings-tab="home"]');
    const homeTab = await page.innerText("#settings-panel-home");
    for (const value of ["Open at startup", "Home blocks", "Module cards", "Rows per list"]) assert(homeTab.includes(value), "нет перевода: " + value);
    await page.click('[data-settings-tab="interface"]');
    await page.click('[data-language="ru"]'); await page.waitForTimeout(150);
    assert((await page.evaluate(() => document.body.innerText)).includes("Компактный режим"), "возврат на русский");
    await context.close();
  });

  // Регрессия: соседние действия не зависят от типа кнопки и длины подписи
  for (const mode of [
    { width: 1440, compact: "1", font: "120", theme: "graphite", language: "ru", installed: true },
    { width: 1440, compact: "0", font: "140", theme: "light", language: "ru", installed: false },
    { width: 960, compact: "1", font: "140", theme: "graphite", language: "en", installed: false },
    { width: 960, compact: "0", font: "140", theme: "light", language: "ru", installed: true },
  ]) {
    await test(`Равные кнопки: ${mode.width}px, компакт=${mode.compact}, шрифт=${mode.font}%, ${mode.language}`, async () => {
      const { page, errors } = await open({
        view: "hypervisor",
        viewport: { width: mode.width, height: 900 },
        storage: { "cgs-compact": mode.compact, "cgs-font-scale": mode.font, "cgs-theme": mode.theme },
        mock: { responses: { eclipse_hv_status: {
          installed: mode.installed, path: mode.installed ? "C:\\Games\\Eclipse-HV.exe" : "",
          version: mode.installed ? "1.1.0" : null, remoteVersion: "1.1.0",
          updateAvailable: !mode.installed, destinationDir: "C:\\Games", sizeBytes: 559104,
        } } },
      });
      if (mode.language === "en") await page.evaluate(() => window.cgsI18n.setLanguage("en"));
      const equal = async (selector) => {
        const boxes = await page.locator(`${selector} > button`).evaluateAll((buttons) => buttons
          .filter((button) => button.checkVisibility() && button.getBoundingClientRect().width > 0)
          .map((button) => {
            const box = button.getBoundingClientRect();
            return { id: button.id, width: box.width, height: box.height,
              overflowX: button.scrollWidth - button.clientWidth, overflowY: button.scrollHeight - button.clientHeight };
          }));
        assert(boxes.length >= 2, `${selector}: группа не видна`);
        assert(Math.max(...boxes.map((b) => b.width)) - Math.min(...boxes.map((b) => b.width)) <= 1,
          `${selector}: разная ширина ${JSON.stringify(boxes)}`);
        assert(Math.max(...boxes.map((b) => b.height)) - Math.min(...boxes.map((b) => b.height)) <= 1,
          `${selector}: разная высота ${JSON.stringify(boxes)}`);
        assert(boxes.every((b) => b.height >= 44 && b.overflowX <= 1 && b.overflowY <= 1),
          `${selector}: подпись обрезана или кнопка слишком мала ${JSON.stringify(boxes)}`);
      };
      await equal(".hv-hero-actions");
      await equal(".hv-eclipse-actions");
      await equal(".hv-steam-buttons");
      for (const selector of [".ac-hero-actions", ".vbs-hero-actions.equal-button-group"]) {
        const tab = await page.locator(selector).evaluate((group) => group.closest("[data-hv-tab-panel]").dataset.hvTabPanel);
        await page.click(`[data-hv-tab="${tab}"]`);
        await equal(selector);
      }
      await page.click('.nav-item[data-view="saves"]');
      await equal(".save-selection-actions.equal-button-group");
      await page.click('.nav-item[data-view="lua"]');
      await page.waitForTimeout(180);
      await equal(".manifest-loader-panel .manifest-loader-actions");
      await page.click('.nav-item[data-view="settings"]');
      await page.click('[data-settings-tab="modules"]');
      await equal("#collapse-manifest-loader .manifest-loader-actions");
      assert(errors.length === 0, errors.join("\n"));
    });
  }

  // Регрессия: ограниченная по содержимому группа центрируется относительно диалога.
  for (const mode of [
    { width: 1440, height: 900, compact: "1", font: "120", family: "manrope", theme: "graphite", language: "ru" },
    { width: 1440, height: 900, compact: "0", font: "140", family: "minecraft", theme: "light", language: "en" },
    { width: 960, height: 640, compact: "1", font: "85", family: "jetbrains", theme: "oled", language: "ru" },
    { width: 390, height: 844, compact: "1", font: "140", family: "minecraft", theme: "graphite", language: "ru" },
  ]) {
    await test(`Диалоги: кнопки по центру, ${mode.width}px, ${mode.font}%, ${mode.family}`, async () => {
      const { page, errors } = await open({
        viewport: { width: mode.width, height: mode.height },
        storage: { "cgs-compact": mode.compact, "cgs-font-scale": mode.font,
          "cgs-font-family": mode.family, "cgs-theme": mode.theme, "cgs-language": mode.language,
          "cgs-motion": "0", "cgs-splash": "0" },
      });
      await page.evaluate(() => document.fonts.ready);
      const check = async (selector, expectedCount) => {
        const report = await page.locator(selector).evaluate(dialog => {
          const rect = node => {
            const b = node.getBoundingClientRect();
            return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height };
          };
          const group = dialog.querySelector(".modal-actions");
          return { modal: rect(dialog), group: rect(group), viewport: innerWidth,
            buttons: [...group.querySelectorAll("button")].filter(node => node.checkVisibility()).map(node => {
              const brokenWords = [];
              const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
              while (walker.nextNode()) {
                const text = walker.currentNode;
                for (const match of text.textContent.matchAll(/\S+/g)) {
                  const range = document.createRange();
                  range.setStart(text, match.index); range.setEnd(text, match.index + match[0].length);
                  if (new Set([...range.getClientRects()].map(box => Math.round(box.top))).size > 1) brokenWords.push(match[0]);
                }
              }
              return { ...rect(node), brokenWords, overflowX: node.scrollWidth - node.clientWidth,
                overflowY: node.scrollHeight - node.clientHeight };
            }) };
        });
        const { modal, group, buttons } = report;
        assert(buttons.length === expectedCount, `${selector}: неверное число видимых действий`);
        assert(Math.abs((group.left + group.right - modal.left - modal.right) / 2) <= 1,
          `${selector}: группа съехала относительно центра ${JSON.stringify(report)}`);
        assert(group.left >= modal.left && group.right <= modal.right + 1 && group.bottom <= modal.bottom,
          `${selector}: кнопки вышли из диалога`);
        assert(modal.left >= 0 && modal.right <= report.viewport + 1, `${selector}: диалог шире окна`);
        assert(Math.max(...buttons.map(b => b.width)) - Math.min(...buttons.map(b => b.width)) <= 1,
          `${selector}: ширина кнопок различается`);
        assert(Math.max(...buttons.map(b => b.height)) - Math.min(...buttons.map(b => b.height)) <= 1,
          `${selector}: высота кнопок различается`);
        assert(buttons.every(b => b.height >= 44 && b.overflowX <= 1 && b.overflowY <= 1),
          `${selector}: обрезанная подпись или маленькая кнопка ${JSON.stringify(buttons)}`);
        assert(buttons.every(b => b.brokenWords.length === 0),
          `${selector}: слова или скобки разорваны переносом ${JSON.stringify(buttons)}`);
        for (let index = 1; index < buttons.length; index += 1) {
          const a = buttons[index - 1], b = buttons[index];
          assert(b.left >= a.right + 3 || b.top >= a.bottom + 3, `${selector}: кнопки перекрываются`);
        }
      };
      for (const confirm of [true, false]) {
        await page.evaluate(confirm => {
          cgsShowModal("Версия загрузчика обновлена",
            "В Steam установлена Версия 1 (Основная) OpenSteamTool.\n\nЗапустить клиент Steam сейчас?",
            { confirm, confirmText: "Запустить Steam", cancelText: "Позже", symbol: "✓" });
        }, confirm);
        await page.waitForSelector("#modal-backdrop:not(.hidden)");
        await check("#modal-backdrop .modal", confirm ? 2 : 1);
        await page.keyboard.press("Escape");
        await page.waitForSelector("#modal-backdrop", { state: "hidden" });
      }
      // Те же правила применяются к окнам с двумя и тремя вариантами обновления.
      for (const [backdrop, count] of [["#app-update-backdrop", 2], ["#loader-update-backdrop", 3]]) {
        await page.locator(backdrop).evaluate(node => node.classList.remove("hidden"));
        await check(`${backdrop} .modal`, count);
        await page.locator(backdrop).evaluate(node => node.classList.add("hidden"));
      }
      assert(errors.length === 0, errors.join("\n"));
    });
  }

  await test("Окно 960×640 (минимальный размер): без ошибок во всех разделах", async () => {
    const { page, context, errors } = await open({ viewport: { width: 960, height: 640 }, storage: { "cgs-compact": "1", "cgs-font-scale": "120" } });
    for (const view of ["home", "fix", "saves", "dlc", "lua", "hypervisor", "files", "utilities", "settings"]) {
      await page.click(`.nav-item[data-view="${view}"]`); await page.waitForTimeout(80);
      const wide = await page.evaluate(() => document.querySelector(".main-area").scrollWidth - document.querySelector(".main-area").clientWidth);
      assert(wide <= 1, `${view}: горизонтальная прокрутка ${wide}px`);
    }
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "min-window-settings.png") });
    assert(errors.length === 0, errors.join("\n"));
    await context.close();
  });


  await test("Миграция всех настроек, а не только API-ключей", async () => {
    const seed={"cgs-theme":"forest",lastGamePath:"D:\\Games\\Example",customUnknownSetting:"retained",hubcapKey:"old-test-secret",ryuuKey:"second-test-secret"};
    const {page}=await open({storage:seed});
    const migrated=await page.evaluate(()=>({length:localStorage.length,theme:cgsStorage.getItem("cgs-theme"),custom:cgsStorage.getItem("customUnknownSetting"),secret:cgsStorage.getItem("hubcapKey"),configured:cgsStorage.isSecretConfigured("hubcap"),input:document.querySelector("#hubcap-key").value}));
    assert(migrated.length===0 && migrated.theme==="forest" && migrated.custom==="retained","мигрировали не все данные");
    assert(migrated.secret===null && migrated.configured && migrated.input==="","секрет вернулся в UI");
    await reload(page);await page.waitForFunction(()=>document.documentElement.dataset.ready==="true");
    assert(await page.evaluate(()=>cgsStorage.getItem("customUnknownSetting"))==="retained","не сохранилось при перезапуске");
    assert((await calls(page,"state_bootstrap")).at(-1).args.legacy.hubcapKey===undefined,"секрет остался в старом LS");
  });
  await test("Ошибка миграции оставляет старые данные и блокирует запуск", async () => {
    const {page}=await open({storage:{hubcapKey:"migration-failure-test",ordinary:"keep"},mock:{migrationFailure:true}});
    assert(await page.isVisible(".startup-error[role=alert]"),"нет безопасного экрана ошибки");
    assert(await page.evaluate(()=>localStorage.getItem("ordinary"))==="keep","старые настройки удалены");
    assert((await calls(page,"files_catalog")).length===0,"опасные модули запущены после ошибки миграции");
  });
  await test("Модальное окно: семантика, безопасный фокус, Tab, Esc, возврат фокуса", async () => {
    const {page}=await open();await page.focus('[data-view="fix"]');
    await page.evaluate(()=>{window.__modalResult="pending";cgsShowModal("Подтверждение","Проверка",{confirm:true}).then(value=>window.__modalResult=value);});
    await page.waitForSelector('#modal-backdrop:not(.hidden)');
    assert(await page.getAttribute('.modal','role')==='dialog' && await page.getAttribute('.modal','aria-modal')==='true',"нет семантики");
    assert(await page.evaluate(()=>document.activeElement.id)==="modal-cancel","фокус не на безопасной отмене");
    assert(await page.locator("#modal-symbol svg").count()===1,"значок диалога не отрисован");
    for(let i=0;i<5;i++){await page.keyboard.press("Tab");assert(await page.evaluate(()=>!!document.activeElement.closest('.modal')),"Tab покинул диалог");}
    await page.keyboard.press("Shift+Tab");assert(await page.evaluate(()=>!!document.activeElement.closest('.modal')),"Shift+Tab покинул диалог");
    await page.keyboard.press("Escape");await page.waitForFunction(()=>window.__modalResult===false);
    assert(await page.evaluate(()=>document.activeElement.dataset.view)==="fix","фокус не возвращён");
  });
  await test("Очередь диалогов не теряет подтверждения", async () => {
    const {page}=await open();await page.evaluate(()=>{window.__modalQueue=[];cgsShowModal("Первый","1",{confirm:true}).then(v=>__modalQueue.push(v));cgsShowModal("Второй","2",{confirm:true}).then(v=>__modalQueue.push(v));});
    await page.waitForSelector('#modal-backdrop:not(.hidden)');await page.keyboard.press("Escape");
    await page.waitForFunction(()=>document.querySelector('#modal-title').textContent==="Второй");await page.click('#modal-confirm');
    await page.waitForFunction(()=>window.__modalQueue.length===2);assert(JSON.stringify(await page.evaluate(()=>__modalQueue))==='[false,true]',"перепутаны результаты");
  });
  await test("Логотип Eclipse: в заголовке тот же круглый знак, что и рядом с названием на главной", async () => {
    const { page, errors } = await open({ view: "home", viewport: { width: 960, height: 640 } });
    for (const theme of ["graphite", "light", "oled"]) {
      for (const size of [85, 120, 140]) {
        await page.evaluate(({ theme, size }) => {
          cgsAppearance.applyTheme(theme); cgsAppearance.applyFontScale(size);
        }, { theme, size });
        const icon = await page.evaluate(() => {
          const mark = document.querySelector(".mini-mark .eclipse-mark");
          const holder = mark.parentElement, name = holder.nextElementSibling;
          const style = getComputedStyle(mark);
          const chip = getComputedStyle(document.querySelector(".home-layout .hero-kicker"), "::before");
          const box = mark.getBoundingClientRect(), frame = holder.getBoundingClientRect();
          return { background: style.backgroundImage, reference: chip.backgroundImage,
            radius: style.borderRadius, referenceRadius: chip.borderRadius,
            shadow: style.boxShadow, referenceShadow: chip.boxShadow,
            w: box.width, h: box.height, inside: box.left >= frame.left && box.right <= frame.right && box.top >= frame.top && box.bottom <= frame.bottom,
            textGap: name.getBoundingClientRect().left - frame.right,
            hidden: mark.getAttribute("aria-hidden"), drag: mark.hasAttribute("data-tauri-drag-region") && holder.hasAttribute("data-tauri-drag-region"),
            tile: !!holder.querySelector("svg, .app-mark-tile") };
        });
        assert(icon.background === icon.reference && icon.background.includes("radial-gradient"), `${theme}, ${size}: значки отличаются`);
        assert(icon.radius === "50%" && icon.radius === icon.referenceRadius && icon.shadow === icon.referenceShadow, `${theme}, ${size}: оформление отличается`);
        assert(icon.w === icon.h && icon.w >= 14 && icon.inside && icon.textGap > 0, `${theme}, ${size}: размеры или отступы нарушены ${JSON.stringify(icon)}`);
        assert(icon.hidden === "true" && icon.drag && !icon.tile, "осталась квадратная плитка или нарушено перетаскивание окна");
      }
    }
    assert(errors.length === 0, errors.join("\n"));
  });
  await test("Логотип Eclipse: настройка свечения одинаково действует на оба значка", async () => {
    const { page, errors } = await open({ view: "home" });
    for (const theme of ["graphite", "light", "oled"]) {
      for (const glow of [false, true]) {
        await page.evaluate(({ theme, glow }) => {
          cgsAppearance.applyTheme(theme); cgsAppearance.applyGlow(glow);
        }, { theme, glow });
        const shadows = await page.evaluate(() => [
          getComputedStyle(document.querySelector(".mini-mark .eclipse-mark")).boxShadow,
          getComputedStyle(document.querySelector(".home-layout .hero-kicker"), "::before").boxShadow,
        ]);
        assert(shadows[0] === shadows[1] && (glow ? shadows[0] !== "none" : shadows[0] === "none"), `${theme}, glow=${glow}: ${JSON.stringify(shadows)}`);
      }
    }
    assert(errors.length === 0, errors.join("\n"));
  });

  await test("Логотип Steam: настоящий силуэт, заливка и квадратные размеры в разных темах", async () => {
    const { page, errors } = await open({ view: "lua" });
    for (const theme of ["graphite", "light", "oled"]) {
      await page.evaluate((theme) => window.cgsAppearance.applyTheme(theme), theme);
      const icon = await page.locator(".lua-steam-row .steam-logo").evaluate((svg) => {
        const style = getComputedStyle(svg), box = svg.getBoundingClientRect();
        return { fill: style.fill, color: style.color, stroke: style.stroke, width: box.width, height: box.height,
          path: svg.querySelector("path").getAttribute("d"), hidden: svg.getAttribute("aria-hidden") };
      });
      assert(icon.path.startsWith("M11.979 0C5.678"), "не стандартный логотип Steam");
      assert(icon.fill === icon.color && icon.fill !== "none" && icon.stroke === "none", `${theme}: контур вместо заливки`);
      assert(icon.width === 18 && icon.height === 18 && icon.hidden === "true", "размеры или семантика значка");
    }
    assert(errors.length === 0, errors.join("\n"));
  });

  await test("Старые отметки установки удаляются и не создают ложных установленных карточек", async () => {
    const url = "https://example.com/r0.zip";
    const { page, errors } = await open({ view: "files", storage: {
      filesInstalledMap: JSON.stringify({ [url]: { gameDir: "D:\\Games\\Deleted", result: { success: true } } }),
      filesViewMode: "grid", filesAutoInstall: "true",
    } });
    await page.waitForSelector(`[data-files-action="install-flow"][data-files-url="${url}"]`);
    assert(await page.locator(".file-badge-installed, .file-card.is-installed").count() === 0, "восстановлена старая отметка");
    await page.evaluate(() => window.cgsStorage.flush());
    assert(await page.evaluate(() => window.cgsStorage.getItem("filesInstalledMap")) === null, "старый ключ остался");
    assert(await page.evaluate(() => window.cgsStorage.getItem("filesViewMode")) === "grid", "сброшены посторонние настройки");
    assert(errors.length === 0, errors.join("\n"));
  });

  await test("Отметка установки видна после успеха и сбрасывается при повторном входе во вкладку", async () => {
    const url = "https://example.com/r0.zip", card = `[data-card-url="${url}"]`;
    const { page, errors } = await open({ view: "files" });
    await page.click(`[data-files-action="install-flow"][data-files-url="${url}"]`);
    await page.waitForSelector(`${card} .file-badge-installed`);
    assert(await page.locator(".toast-crack-success").count() > 0, "нет разового подтверждения");
    await page.evaluate(() => window.cgsStorage.flush());
    assert(await page.evaluate(() => window.cgsStorage.getItem("filesInstalledMap")) === null, "отметка записана на диск");
    await page.click('.nav-item[data-view="files"]');
    await page.waitForSelector(`${card} .file-badge-installed`);
    await page.click('.nav-item[data-view="home"]');
    await page.click('.nav-item[data-view="files"]');
    await page.waitForSelector(`${card} [data-files-action="install-flow"]`);
    assert(await page.locator(`${card} .file-badge-installed, ${card}.is-installed, ${card} [data-files-action="reinstall"]`).count() === 0,
      "после нового посещения остался установленный статус");
    assert((await page.textContent(`${card} [data-files-action="install-flow"]`)).includes("Установить в игру"), "не вернулась обычная кнопка");
    assert(errors.length === 0, errors.join("\n"));
  });

  await test("Отметка установки не восстанавливается после перезапуска страницы", async () => {
    const url = "https://example.com/r0.zip", card = `[data-card-url="${url}"]`;
    const { page, errors } = await open({ view: "files" });
    await page.click(`[data-files-action="install-flow"][data-files-url="${url}"]`);
    await page.waitForSelector(`${card} .file-badge-installed`);
    await reload(page);
    await page.locator("#app-splash").waitFor({ state: "hidden", timeout: 12000 });
    await page.waitForSelector(`${card} [data-files-action="install-flow"]`);
    assert(await page.locator(`${card} .file-badge-installed, ${card}.is-installed`).count() === 0, "отметка пережила перезапуск");
    assert(await page.evaluate(() => window.cgsStorage.getItem("filesInstalledMap")) === null, "отметка сохранена");
    assert(errors.length === 0, errors.join("\n"));
  });

  await test("Отметка установки из фонового завершения не появляется при новом входе во вкладку", async () => {
    const url = "https://example.com/r0.zip", card = `[data-card-url="${url}"]`;
    const { page, errors } = await open({ view: "files" });
    await page.evaluate(() => {
      const responses = window.__CGS_MOCK_CONFIG__.responses ||= {};
      Object.defineProperty(responses, "files_install_crack", { configurable: true, get() {
        return new Promise((resolve) => { window.__finishInstall = () => {
          resolve({ success: true, status: "success", installedFiles: ["game.dll"], skipped: [] });
          setTimeout(() => { window.__installSettled = true; }, 0);
        }; });
      } });
    });
    await page.click(`[data-files-action="install-flow"][data-files-url="${url}"]`);
    await page.waitForFunction(() => typeof window.__finishInstall === "function");
    await page.click('.nav-item[data-view="home"]');
    await page.evaluate(() => window.__finishInstall());
    await page.waitForFunction(() => window.__installSettled === true);
    await page.click('.nav-item[data-view="files"]');
    await page.waitForSelector(`${card} [data-files-action="install-flow"]`);
    assert(await page.locator(`${card} .file-badge-installed, ${card}.is-installed`).count() === 0, "фоновая отметка попала в новое посещение");
    assert(errors.length === 0, errors.join("\n"));
  });

  await test("Частичная установка не получает метку УСТАНОВЛЕНО и показывает пропуски", async () => {
    const {page}=await open({view:"files",mock:{responses:{files_install_crack:{success:false,status:"partial",installedFiles:["one.dll"],skipped:["two.dll: отказ записи"],message:"Один файл не установлен"}}}});
    await page.waitForSelector('[data-files-action="install-flow"][data-files-url="https://example.com/r0.zip"]');
    await page.click('[data-files-action="install-flow"][data-files-url="https://example.com/r0.zip"]');await page.waitForFunction(() => document.querySelector("#files-status").textContent.includes("two.dll"));
    assert((await page.textContent('#files-status')).includes("two.dll"),"список пропусков не виден");
    assert(await page.locator('[data-card-url="https://example.com/r0.zip"] .file-badge-installed').count()===0,"частичный результат отмечен полным успехом");
    const saved=await page.evaluate(()=>JSON.parse(cgsStorage.getItem("filesInstalledMap")||"{}"));assert(!saved["https://example.com/r0.zip"],"в хранилище ложный успех");
  });
  await test("Пауза отличается от отмены и доступна после перезапуска", async () => {
    const {page}=await open({view:"files",storage:{filesAutoInstall:"false"},mock:{pausable:true}});
    await page.click('[data-files-action="download"][data-files-url="https://example.com/r0.zip"]');
    await page.waitForSelector('[data-files-action="pause"][data-files-url="https://example.com/r0.zip"]');
    await page.click('[data-files-action="pause"][data-files-url="https://example.com/r0.zip"]');
    await page.waitForSelector('[data-files-action="resume"][data-files-url="https://example.com/r0.zip"]');
    assert((await calls(page,"files_cancel_download")).length===0,"пауза вызывает отмену");
    await page.evaluate(()=>cgsStorage.flush());await reload(page);await page.waitForFunction(()=>document.documentElement.dataset.ready==="true");
    await page.waitForSelector('[data-files-action="resume"][data-files-url="https://example.com/r0.zip"]');
    await page.click('[data-files-action="cancel"][data-files-url="https://example.com/r0.zip"]');await page.waitForTimeout(100);
    assert((await calls(page,"files_discard_download")).length===1,"удаление сохранённых сегментов не вызвано");
  });
  await test("Ключ немедленно сохраняется перед API-вызовом, но не передаётся в API аргументах", async () => {
    const {page}=await open({view:"settings"});await page.click('[data-settings-tab="modules"]');await page.click('.svc-option[data-service="hubcap"]');
    await page.fill('#hubcap-key','new-test-secret');await page.evaluate(()=>cgsApi.invoke('hubcap_usage'));
    const saved=await calls(page,'state_set_secret');assert(saved.at(-1).args.value==='new-test-secret',"ключ не сохранён до запроса");
    const request=(await calls(page,'hubcap_usage')).at(-1);assert(!Object.hasOwn(request.args,'apiKey'),"ключ передан через UI API");
    assert(await page.inputValue('#hubcap-key')==='',"поле хранит ключ после сохранения");
  });
  await test("Ryuu: встроенный ключ выбран по умолчанию и разрешает поиск без личного ключа", async () => {
    const { page, errors } = await open({
      view: "settings",
      mock: { responses: { ryuu_search: [{ appid: "620", name: "Portal 2" }] } },
    });
    await page.click('[data-settings-tab="modules"]');
    assert(await page.isChecked("#ryuu-key-source-crocodile"), "встроенный ключ не выбран");
    assert(!(await page.isVisible("#ryuu-custom-key-fields")), "личное поле не скрыто");
    assert(await page.isDisabled("#ryuu-key"), "скрытое поле доступно для ввода");
    assert((await page.textContent("#ryuu-key-status")).includes("Встроенный ключ"), "неверный статус");
    assert((await page.textContent("#ryuu-key-help")).includes("доступность зависит от Crocodile Gena Studio"),
      "неверно указана зависимость доступности общего ключа");
    const stored = await page.evaluate(() => ({
      source: cgsStorage.getItem("ryuuKeySource"),
      key: cgsStorage.getItem("ryuuKey"),
      personal: cgsStorage.isSecretConfigured("ryuu"),
    }));
    assert(stored.source === "crocodile" && stored.key === null && !stored.personal, "встроенный ключ записан как личный");
    await page.click('.nav-item[data-view="lua"]');
    await page.fill("#lua-search-input", "Portal");
    await page.waitForFunction(() => window.__mockCalls.some(c => c.command === "ryuu_search"));
    await page.waitForFunction(() => document.querySelector("#lua-search-dropdown").textContent.includes("Portal 2"));
    const request = (await calls(page, "ryuu_search")).at(-1);
    assert(request.args.query === "Portal" && !Object.hasOwn(request.args, "apiKey"), "поиск передаёт ключ через UI");
    assert((await calls(page, "state_set_secret")).length === 0, "встроенный ключ перезаписал личный");
    assert(errors.length === 0, errors.join("\n"));
  });
  await test("Ryuu: выбор сохраняется, личный ключ не теряется при переключении и перезапуске", async () => {
    const { page, errors } = await open({ view: "settings" });
    await page.click('[data-settings-tab="modules"]');
    await page.check("#ryuu-key-source-custom");
    assert(await page.isVisible("#ryuu-custom-key-fields"), "нет поля личного ключа");
    await page.fill("#ryuu-key", "personal-ryuu-test-key");
    await page.evaluate(() => cgsApi.invoke("ryuu_usage"));
    assert(await page.inputValue("#ryuu-key") === "", "сохранённый ключ остался в поле");
    const saved = (await calls(page, "state_set_secret")).filter(c => c.args.service === "ryuu");
    assert(saved.length === 1 && saved[0].args.value === "personal-ryuu-test-key", "личный ключ не сохранён перед запросом");
    await page.check("#ryuu-key-source-crocodile");
    await page.evaluate(() => cgsApi.invoke("ryuu_usage"));
    const native = await page.evaluate(() => JSON.parse(sessionStorage.getItem("__native_state")).values);
    assert(native.ryuuKeySource === "crocodile" && native.ryuuKey === "personal-ryuu-test-key", "переключение удалило личный ключ");
    await reload(page);
    await page.click('[data-settings-tab="modules"]');
    assert(await page.isChecked("#ryuu-key-source-crocodile"), "выбор сброшен после перезапуска");
    await page.check("#ryuu-key-source-custom");
    assert(await page.inputValue("#ryuu-key") === "", "сохранённый секрет вернулся в UI");
    assert((await page.getAttribute("#ryuu-key", "placeholder")).includes("сохранён в Windows"), "личный ключ не восстановлен");
    assert((await page.textContent("#ryuu-key-status")).includes("Свой ключ указан"), "личный ключ не отмечен");
    await page.evaluate(() => cgsApi.invoke("ryuu_usage"));
    assert((await calls(page, "ryuu_usage")).every(c => !Object.hasOwn(c.args, "apiKey")), "квота получает ключ из UI");
    assert(await page.evaluate(() => cgsStorage.getItem("ryuuKey")) === null, "секрет попал в обычные настройки");
    assert(errors.length === 0, errors.join("\n"));
  });
  await test("Ryuu: пустой свой ключ блокирует поиск и не заменяется встроенным автоматически", async () => {
    const { page, errors } = await open({
      view: "lua",
      storage: { ryuuKeySource: "custom" },
      mock: { responses: { ryuu_search: [] } },
    });
    await page.fill("#lua-search-input", "Portal");
    await page.waitForFunction(() => document.querySelector("#lua-search-dropdown").textContent.includes("Укажите свой API-ключ Ryuu"));
    assert((await calls(page, "ryuu_search")).length === 0, "поиск выполнен без своего ключа");
    await page.click('.nav-item[data-view="settings"]');
    await page.click('[data-settings-tab="modules"]');
    await page.check("#ryuu-key-source-crocodile");
    await page.click('.nav-item[data-view="lua"]');
    await page.fill("#lua-search-input", "Portal 2");
    await page.waitForFunction(() => window.__mockCalls.some(c => c.command === "ryuu_search"));
    assert(errors.length === 0, errors.join("\n"));
  });
  await test("Ryuu: при обновлении существующий личный ключ остаётся выбранным", async () => {
    const { page, errors } = await open({ view: "settings", storage: { ryuuKey: "legacy-personal-ryuu-key" } });
    await page.click('[data-settings-tab="modules"]');
    assert(await page.isChecked("#ryuu-key-source-custom"), "старый личный ключ заменён встроенным");
    assert(await page.inputValue("#ryuu-key") === "", "секрет показан после миграции");
    assert(await page.evaluate(() => cgsStorage.getItem("ryuuKeySource")) === "custom", "режим миграции не сохранён");
    assert(errors.length === 0, errors.join("\n"));
  });
  await test("Ryuu: выбор доступен с клавиатуры и переведён на английский", async () => {
    const { page, errors } = await open({
      view: "settings",
      storage: { "cgs-language": "en" },
      viewport: { width: 960, height: 640 },
    });
    await page.click('[data-settings-tab="modules"]');
    await page.waitForFunction(() => document.querySelector("#ryuu-key-help").textContent.includes(
      "availability depends on Crocodile Gena Studio"));
    await page.focus("#ryuu-key-source-crocodile");
    await page.keyboard.press("ArrowRight");
    assert(await page.isChecked("#ryuu-key-source-custom"), "клавиатура не переключает источник");
    await page.waitForFunction(() => document.querySelector("#ryuu-key-help").textContent.includes("protected Windows storage"));
    assert((await page.textContent(".ryuu-key-sources legend")).includes("Choose an API key"), "нет перевода");
    const layout = await page.locator(".ryuu-key-sources").evaluate(element => ({
      overflow: element.scrollWidth - element.clientWidth,
      heights: [...element.querySelectorAll("label")].map(label => label.getBoundingClientRect().height),
      controls: [...element.closest("#ryuu-key-block").querySelectorAll("button")].map(button => button.getBoundingClientRect().height),
      sizes: [...element.closest("#ryuu-key-block").querySelectorAll(".svc-key-label, .hubcap-status-badge, .svc-key-link")].map(node => parseFloat(getComputedStyle(node).fontSize)),
    }));
    assert(layout.overflow <= 1 && layout.heights.every(height => height >= 44), "переключатель не помещается или слишком мал");
    assert(layout.controls.every(height => height >= 44), "кнопки ключа слишком малы");
    assert(layout.sizes.every(size => size >= 14), "текст ключа слишком мелкий");
    assert(errors.length === 0, errors.join("\n"));
  });
  await test("Ryuu: весь блок использует общий масштаб 85–140% и выбранный шрифт", async () => {
    const { page, errors } = await open({ view: "settings", storage: { "cgs-motion": "0", "cgs-splash": "0" } });
    await page.click('[data-settings-tab="modules"]');
    await page.check("#ryuu-key-source-custom");
    const selectors = ["#ryuu-key-block .svc-key-label", "#ryuu-key-status", "#ryuu-key-get",
      ".ryuu-key-sources legend", ".ryuu-key-source-option strong", ".ryuu-key-source-option small",
      "#ryuu-key-help", "#ryuu-key"];
    const sizes = () => page.evaluate(selectors => selectors.map(selector =>
      parseFloat(getComputedStyle(document.querySelector(selector)).fontSize)), selectors);
    await page.evaluate(() => cgsAppearance.applyFontScale(120));
    const base = await sizes();
    for (const size of [85, 100, 120, 140]) {
      await page.evaluate(size => cgsAppearance.applyFontScale(size), size);
      const current = await sizes();
      current.forEach((value, index) => assert(Math.abs(value / base[index] - size / 120) < .01,
        `${selectors[index]}: размер не следует настройке ${size}% (${value}px)`));
    }
    for (const [family, expected] of [["manrope", "Manrope"], ["jetbrains", "JetBrains Mono"], ["minecraft", "Minecraft"], ["consolas", "Consolas"]]) {
      await page.evaluate(family => cgsAppearance.applyFontFamily(family), family);
      const fonts = await page.evaluate(selectors => selectors.map(selector =>
        getComputedStyle(document.querySelector(selector)).fontFamily), selectors);
      assert(fonts.every(font => font.includes(expected)), `${family}: шрифт блока не наследуется ${fonts.join("; ")}`);
    }
    await reload(page);
    await page.click('[data-settings-tab="modules"]');
    assert(await page.evaluate(() => cgsStorage.getItem("cgs-font-scale")) === "140", "масштаб сбросился");
    assert(await page.isChecked("#ryuu-key-source-custom"), "смена оформления сбросила источник ключа");
    assert(errors.length === 0, errors.join("\n"));
  });

  await test("Ryuu: форма, плотность, насыщенность и контраст следуют настройкам", async () => {
    const { page, errors } = await open({ view: "settings", storage: { "cgs-motion": "0", "cgs-splash": "0" } });
    await page.click('[data-settings-tab="modules"]');
    await page.check("#ryuu-key-source-custom");
    for (const shape of ["sharp", "soft", "round"]) {
      await page.evaluate(shape => cgsAppearance.applyShape(shape), shape);
      const radii = await page.evaluate(() => {
        const expected = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--k-r-ctl"));
        return { expected, values: [".ryuu-key-source-option", "#ryuu-key-get",
          "#ryuu-key-block .svc-input-box", "#ryuu-key-block .svc-tool-btn"].map(selector =>
          parseFloat(getComputedStyle(document.querySelector(selector)).borderTopLeftRadius)) };
      });
      assert(radii.values.every(value => Math.abs(value - radii.expected) < .1), `форма ${shape}: ${JSON.stringify(radii)}`);
    }
    const density = async compact => {
      await page.evaluate(compact => cgsAppearance.applyCompact(compact), compact);
      return page.locator(".ryuu-key-source-option").first().evaluate(node => parseFloat(getComputedStyle(node).paddingTop));
    };
    assert(await density(false) > await density(true), "компактный режим не уменьшает отступы");
    const weights = async weight => {
      await page.evaluate(weight => cgsAppearance.applyTextWeight(weight), weight);
      return page.evaluate(() => [".ryuu-key-source-option strong", ".ryuu-key-source-option small",
        "#ryuu-key-status", "#ryuu-key-get"].map(selector => Number(getComputedStyle(document.querySelector(selector)).fontWeight)));
    };
    const light = await weights("light"), bold = await weights("bold");
    assert(bold.every((value, index) => value > light[index]), `насыщенность не меняется: ${light} → ${bold}`);
    for (const theme of ["graphite", "light"]) {
      for (const contrast of [false, true]) {
        await page.evaluate(({ theme, contrast }) => {
          cgsAppearance.applyTheme(theme); cgsAppearance.applyContrast(contrast);
        }, { theme, contrast });
        const colors = await page.evaluate(() => {
          const probe = document.createElement("i");
          probe.style.color = "var(--k-muted)"; document.body.append(probe);
          const expected = getComputedStyle(probe).color; probe.remove();
          return { expected, actual: getComputedStyle(document.querySelector("#ryuu-key-help")).color };
        });
        assert(colors.actual === colors.expected, `${theme}, контраст=${contrast}: применён чужой цвет ${JSON.stringify(colors)}`);
      }
    }
    await page.evaluate(() => cgsAppearance.applyGlow(false));
    assert(await page.locator(".ryuu-key-source-option.active").evaluate(node => getComputedStyle(node).boxShadow) === "none",
      "у выключенного свечения осталась тень");
    assert(errors.length === 0, errors.join("\n"));
  });

  await test("Ryuu: крупный текст помещается в минимальное окно на русском и английском", async () => {
    const { page, errors } = await open({
      view: "settings", viewport: { width: 960, height: 640 },
      storage: { "cgs-font-scale": "140", "cgs-motion": "0", "cgs-splash": "0" },
    });
    await page.click('[data-settings-tab="modules"]');
    for (const language of ["ru", "en"]) {
      for (const compact of [true, false]) {
        await page.evaluate(({ language, compact }) => {
          cgsI18n.setLanguage(language); cgsAppearance.applyCompact(compact);
          cgsAppearance.applyFontFamily("minecraft");
        }, { language, compact });
        for (const source of ["crocodile", "custom"]) {
          await page.check(`#ryuu-key-source-${source}`);
          const layout = await page.locator("#ryuu-key-block").evaluate(block => ({
            overflow: block.scrollWidth - block.clientWidth,
            fields: [...block.querySelectorAll("fieldset, label, .svc-key-header, .svc-key-meta, .svc-input-box, button")]
              .filter(node => node.checkVisibility()).map(node => ({
                name: node.id || node.className, overflow: node.scrollWidth - node.clientWidth,
                height: node.getBoundingClientRect().height,
              })),
          }));
          assert(layout.overflow <= 1 && layout.fields.every(field => field.overflow <= 1),
            `${language}, компакт=${compact}, ${source}: переполнение ${JSON.stringify(layout)}`);
        }
      }
    }
    assert(errors.length === 0, errors.join("\n"));
  });

  await test("Главная показывает реальные прерванные и частичные задания", async () => {
    const {page}=await open({mock:{jobs:[{id:'job-interrupted',label:'Прерванный бэкап',status:'interrupted'},{id:'job-partial',label:'Неполное восстановление',status:'partial'}]}});
    assert((await page.textContent('#home-pending-jobs')).includes('job-interrupted'),"прерванная операция потеряна");
    assert((await page.textContent('#home-attention')).includes('Неполное восстановление'),"частичный результат скрыт");
    assert((await page.textContent('#home-recent-backups')).includes('пока нет'),"главная показывает выдуманные бэкапы");
  });
  await test("Раздел при запуске: выбранный, вкладка гипервизора, последний и скрытый в боковой панели", async () => {
    const { page, context, errors } = await open({ view: "settings" });
    const start = async () => {
      await page.evaluate(() => window.cgsStorage.flush());
      await page.goto(PAGE);
      await page.waitForFunction(() => document.documentElement.dataset.ready === "true");
      await page.waitForTimeout(150);
      return page.evaluate(() => document.querySelector("[data-view-panel].active")?.dataset.viewPanel + ":" + (document.querySelector("[data-hv-tab].active")?.dataset.hvTab || ""));
    };
    assert(await page.inputValue("#start-view") === "home", "по умолчанию должна открываться главная");
    await page.click('[data-settings-tab="home"]');
    await page.selectOption("#start-view", "files");
    assert(await page.evaluate(() => window.cgsStorage.getItem("cgs-start-view")) === "files", "выбор не сохранился");
    assert((await start()).startsWith("files:"), "при запуске не открылись Кряки");
    await page.evaluate(() => window.cgsStorage.setItem("cgs-start-view", "hypervisor:vbs"));
    assert(await start() === "hypervisor:vbs", "не открылась вкладка VBS гипервизора");
    await page.evaluate(() => { window.cgsStorage.setItem("cgs-start-view", "last"); document.querySelector('.nav-item[data-view="saves"]').click(); });
    assert((await start()).startsWith("saves:"), "не открылся последний раздел");
    await page.evaluate(() => { window.cgsStorage.setItem("cgs-start-view", "dlc"); window.cgsStorage.setItem("cgs-sidebar-hidden", JSON.stringify(["dlc"])); });
    assert((await start()).startsWith("home:"), "раздел, скрытый в боковой панели, открылся при запуске");
    await page.click('.nav-item[data-view="settings"]'); await page.click('[data-settings-tab="home"]');
    assert(await page.isVisible("#start-view-note"), "нет подсказки о скрытом разделе");
    assert(errors.length === 0, errors.join("\n"));
    await context.close();
  });
  await test("Настройки главной: блоки, карточки модулей, длина списков и скрытые записи", async () => {
    const games = Array.from({ length: 7 }, (_, i) => ({ path: `C:\\Games\\Game ${i + 1}`, name: `Game ${i + 1}` }));
    const { page, context, errors } = await open({ viewport: { width: 960, height: 640 }, storage: { recentGames: JSON.stringify(games) }, mock: { jobs: [{ id: "job-hidden", label: "Прерванный бэкап", status: "interrupted" }] } });
    const rows = () => page.$$eval("#home-recent-games .home-item", (items) => items.length);
    const active = () => page.evaluate(() => document.querySelector("[data-view-panel].active")?.dataset.viewPanel);
    assert(await rows() === 4, "по умолчанию в списке не 4 строки");
    await page.click("#home-customize"); await page.waitForTimeout(150);
    assert(await active() === "settings" && await page.isVisible("#settings-panel-home"), "кнопка не открыла вкладку «Главная и запуск»");
    const wide = await page.evaluate(() => document.querySelector(".main-area").scrollWidth - document.querySelector(".main-area").clientWidth);
    assert(wide <= 1, `горизонтальная прокрутка вкладки ${wide}px`);
    await page.click('.home-block-row[data-block="hero"] .switch');
    for (let i = 0; i < 4; i++) await page.click('.home-block-row[data-block="attention"] .order-up');
    await page.click('.home-module-chip[data-module="dlc"]');
    await page.click('[data-home-rows="6"]');
    await reload(page); await page.waitForTimeout(300);
    await page.click('.nav-item[data-view="home"]');
    const layout = await page.evaluate(() => {
      const root = document.querySelector("#view-home .home-layout");
      return { hero: Boolean(root.querySelector(".home-hero")), first: root.firstElementChild?.querySelector(".home-status-panel")?.dataset.kind, dlc: Boolean(root.querySelector('.module-card[data-open-view="dlc"]')), cards: root.querySelectorAll(".module-card").length };
    });
    assert(!layout.hero, "приветствие не скрылось");
    assert(layout.first === "attention", "порядок блоков не сохранился: " + layout.first);
    assert(!layout.dlc && layout.cards === 6, "карточка DLC не скрылась");
    assert(await rows() === 6, "настройка «Строк в списке» не применилась");
    await page.click('.home-grid .module-card[data-open-view="files"]');
    assert(await active() === "files", "карточка после пересборки главной не открывает раздел");
    await page.click('.nav-item[data-view="home"]');
    await page.click("#home-pending-jobs .home-item-dismiss");
    assert(!(await page.textContent("#home-pending-jobs")).includes("job-hidden"), "запись не скрылась");
    await page.click('.nav-item[data-view="settings"]');
    assert((await page.textContent("#home-dismissed-info")).includes("1"), "нет счётчика скрытых записей");
    await page.click("#home-restore-dismissed");
    await page.click('.nav-item[data-view="home"]');
    assert((await page.textContent("#home-pending-jobs")).includes("job-hidden"), "скрытая запись не вернулась");
    await page.setViewportSize({ width: 1440, height: 900 }); await page.waitForTimeout(150);
    assert(await page.isVisible("#home-pending-jobs .home-item-id"), "номер операции не виден в широком окне");
    await page.click('.nav-item[data-view="settings"]');
    await page.click("label.pref-row:has(#home-show-ids)");
    await page.click('.nav-item[data-view="home"]');
    assert(!(await page.isVisible("#home-pending-jobs .home-item-id")), "номер операции не скрылся");
    await page.click('.nav-item[data-view="settings"]');
    await page.click("#home-blocks-show-all");
    await page.click('.nav-item[data-view="home"]');
    assert(await page.locator("#view-home .home-hero").count() === 1 && await page.locator("#view-home .module-card").count() === 7, "«Показать все блоки» не вернул блоки");
    assert(errors.length === 0, errors.join("\n"));
    await context.close();
  });
  await test("Светлая тема: акценты затемняются до читаемого контраста, в тёмной белый остаётся белым", async () => {
    const { page, context } = await open({ view: "settings", storage: { "cgs-theme": "light", accent: "white" } });
    const contrast = () => page.evaluate(() => {
      const value = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
      const hex = value.replace("#", ""); const channels = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
      const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return { value, ratio: 1.05 / (0.2126 * r + 0.7152 * g + 0.0722 * b + 0.05) };
    });
    const accents = await page.$$eval(".accent", (items) => items.map((item) => item.dataset.accent));
    const values = new Set();
    for (const accent of accents) {
      await page.click(`.accent[data-accent="${accent}"]`);
      const { value, ratio } = await contrast();
      assert(ratio >= 4.5, `${accent}: контраст ${ratio.toFixed(2)} (${value}) ниже 4.5`);
      values.add(value);
    }
    assert(values.size === accents.length, `в светлой теме уникальных акцентов ${values.size}`);
    await page.click('[data-theme-option="graphite"]'); await page.click('.accent[data-accent="white"]');
    assert((await contrast()).value.toLowerCase() === "#ffffff", "в тёмной теме белый акцент изменился");
    await context.close();
  });
  await test("Лимит HubCap не запрашивается и не попадает на главную, когда выбран Ryuu", async () => {
    const idle=async page=>{await page.waitForFunction(()=>window.__mockCalls.some(c=>c.command==="check_for_update"),null,{timeout:9000});await page.waitForTimeout(700);};
    const {page}=await open({storage:{hubcapKey:"saved-test-secret",manifestService:"ryuu"}});await idle(page);
    assert((await calls(page,'hubcap_usage')).length===0,"лимит HubCap запрошен при выбранном Ryuu");
    await page.evaluate(()=>window.dispatchEvent(new CustomEvent("cgs:request",{detail:{id:"bg-hubcap",command:"hubcap_usage",status:"failed",message:"Неверный ключ HubCap"}})));
    assert(!/hubcap/i.test(await page.textContent('#home-attention')),"фоновая ошибка HubCap попала в «Требует внимания»");
    const hub=await open({storage:{hubcapKey:"saved-test-secret",manifestService:"hubcap"}});await idle(hub.page);
    assert((await calls(hub.page,'hubcap_usage')).length>0,"при выбранном HubCap лимит не обновляется");
  });
  await test("Открытие статуса не изменяет Steam в фоне", async () => {
    const {page}=await open({view:'lua'});await page.waitForTimeout(4300);
    assert((await calls(page,'luatools_restore_manifests')).length===0,"диагностика выполняет фоновое восстановление");
  });
  await test("Предупреждения старого формата не превращаются в полный успех", async () => {
    const {page}=await open({mock:{responses:{luatools_install:{success:true,message:"Добавлены игры",logs:["⚠ bad.lua: отказ записи"],addedAppids:["10"]}}}});
    const result=await page.evaluate(()=>cgsApi.invoke("luatools_install",{urls:[],steamPath:null}));
    assert(result.success===false && result.status==="partial","предупреждение скрыто успехом");
    assert(result.skipped.some(line=>line.includes("bad.lua")),"список пропусков потерян");
  });
  for (const [state,label] of [["unknown","НЕИЗВЕСТНО"],["suspended","ПРИОСТАНОВЛЕН"]]) {
    await test(`BitLocker ${state}: не отображается как отсутствие шифрования`, async () => {
      const {page}=await open({view:"hypervisor",mock:{bitlocker:{state,protected:false,suspended:state==="suspended",message:"Диагностика",diagnostics:["Проверка состояния"]}}});
      await page.click('[data-hv-tab="vbs"]');
      await page.waitForFunction(label=>document.querySelector('#vbs-bitlocker-badge').textContent===label,label);
      assert((await page.textContent('#vbs-bitlocker-detail')).includes("Проверка состояния"),"диагностика скрыта");
      if(state==="unknown") assert(await page.isDisabled('#vbs-enable-all-btn'),"изменения доступны при неизвестном BitLocker");
    });
  }
  await test("BitLocker без прав администратора: причина, перезапуск и текст внутри карточки", async () => {
    const message = "Windows сообщает состояние BitLocker только программам с правами администратора. Пока оно не подтверждено, изменения загрузки заблокированы.";
    const diagnostics = ["PermissionDenied", "HRESULT 0x80041003,Microsoft.Management.Infrastructure.CimCmdlets.GetCimInstanceCommand", "0x80131500"];
    const {page} = await open({view:"hypervisor", viewport:{width:960,height:640}, mock:{admin:false, bitlocker:{state:"unknown", protected:false, suspended:false, needsAdmin:true, message, diagnostics}}});
    await page.click('[data-hv-tab="vbs"]');
    await page.waitForFunction(()=>document.querySelector('#vbs-bitlocker-badge').textContent==="НЕИЗВЕСТНО");
    assert(await page.isVisible('#vbs-bitlocker-admin'), "нет кнопки перезапуска с правами администратора");
    const info = await page.evaluate((message) => {
      const card = document.querySelector('#vbs-bitlocker-card').getBoundingClientRect();
      const badge = document.querySelector('#vbs-bitlocker-badge').getBoundingClientRect();
      const small = document.querySelector('#vbs-bitlocker-detail .vbs-card-diagnostics');
      const panel = document.querySelector('[data-hv-tab-panel="vbs"]');
      const inside = [...document.querySelectorAll('#vbs-bitlocker-card *')].every((node) => {
        const r = node.getBoundingClientRect();
        return !r.width || (r.left >= card.left - 1 && r.right <= card.right + 1);
      });
      return {
        inside, badgeInside: badge.left >= card.left && badge.right <= card.right,
        overflow: document.querySelector('#vbs-bitlocker-card').scrollWidth - document.querySelector('#vbs-bitlocker-card').clientWidth,
        small: small ? small.textContent : null, title: small ? small.title : null,
        repeats: panel.innerText.split(message).length - 1,
        blockedTitle: document.querySelector('#vbs-enable-all-btn').title,
      };
    }, message);
    assert(info.inside && info.badgeInside && info.overflow <= 0, `текст выходит за карточку: ${JSON.stringify(info)}`);
    assert(info.small && info.small.includes("0x80041003") && info.title.split("\n").length === 3, "диагностика не вынесена отдельной строкой");
    assert(info.repeats === 1, `сообщение BitLocker продублировано: ${info.repeats}`);
    assert(await page.isDisabled('#vbs-enable-all-btn') && info.blockedTitle.includes("администратора"), "кнопка изменений не объясняет блокировку");
    await page.click('#vbs-bitlocker-admin');
    await page.waitForFunction(()=>document.querySelector('#modal-title').textContent==="Требуются права администратора");
    assert((await page.textContent('#modal-message')).includes("BitLocker"), "диалог не объясняет причину перезапуска");
    await page.click('#modal-confirm');
    await page.waitForFunction(()=>window.__mockCalls.some((call)=>call.command==="relaunch_as_admin"));
  });
  await test("BitLocker с правами администратора: кнопка перезапуска скрыта", async () => {
    const {page} = await open({view:"hypervisor", mock:{bitlocker:{state:"unknown", protected:false, suspended:false, message:"Не удалось определить BitLocker.", diagnostics:["ObjectNotFound"]}}});
    await page.click('[data-hv-tab="vbs"]');
    await page.waitForFunction(()=>document.querySelector('#vbs-bitlocker-badge').textContent==="НЕИЗВЕСТНО");
    assert(!(await page.isVisible('#vbs-bitlocker-admin')), "кнопка перезапуска показана администратору");
    assert((await page.getAttribute('#vbs-enable-all-btn','title')).includes("BitLocker"), "нет причины блокировки на кнопке");
  });
  await test("VBS: маска XSAVE в загрузчике видна в проверке и переведена", async () => {
    // Тексты берутся из vbs.rs, чтобы перевод не разошёлся с бэкендом
    const texts = [...VBS_RS.matchAll(/^const XSAVE_(?:OTHER_)?MASK_WARNING: &str =\s*"([^"]+)";/gm)].map((m) => m[1]);
    assert(texts.length === 2, "в vbs.rs не найдены тексты о маске XSAVE");
    const {page} = await open({view:"hypervisor", mock:{vbsWarnings:texts}});
    await page.click('[data-hv-tab="vbs"]');
    await page.waitForFunction(()=>document.querySelectorAll('#vbs-warnings p').length===2);
    assert(await page.isVisible('#vbs-warning-panel'), "панель предупреждений скрыта");
    const shown = await page.$$eval('#vbs-warnings p', (nodes) => nodes.map((node) => node.textContent));
    assert(texts.every((text) => shown.includes(text)), "предупреждение о маске XSAVE не показано");
    await page.evaluate(() => window.cgsI18n.setLanguage("en"));
    await page.waitForFunction(()=>document.querySelector('#vbs-warnings').textContent.startsWith("XSAVE mask in the boot loader"));
    const english = await page.$$eval('#vbs-warnings p', (nodes) => nodes.map((node) => node.textContent));
    assert(english.length === 2 && english.every((text) => text.startsWith("XSAVE mask in the boot loader") && !/[А-Яа-яЁё]/u.test(text)), `нет перевода: ${english.join(" | ")}`);
  });
  const externalVbs = (extra = {}) => ({
    canRestore: false, testSigningConfigured: true, testSigningActive: true,
    dse: { state: "testsigning", label: "Тестовый режим активен.", detail: "Test Signing" },
    external: { detected: true, canRestore: true, trackedChanges: 7, requiresUefiConsent: false, pendingRestart: false,
      detail: "Найден журнал VBS.cmd / ARTIFACT. Это настройки Windows, а не подтверждение запуска игрового гипервизора.", blockedReason: null },
    ...extra,
  });
  await test("VBS 2.0.1: внешний тестовый режим доступен для отката без снимка Eclipse", async () => {
    const {page, errors} = await open({view:"hypervisor", mock:{vbs:externalVbs()}});
    await page.click('[data-hv-tab="vbs"]');
    await page.waitForSelector('#vbs-external-card:not(.hidden)');
    assert(!(await page.isDisabled('#vbs-external-restore')), "внешний откат недоступен без локального снимка");
    assert(!(await page.isVisible('#vbs-enable-button')), "предлагается повторное включение поверх внешнего журнала");
    assert(await page.isDisabled('#vbs-test-button'), "тестовый режим обходит внешний журнал");
    assert((await page.textContent('#vbs-external-detail')).includes("не подтверждение запуска"), "настройки выданы за запущенный игровой гипервизор");
    assert((await page.textContent('#vbs-external-count')).trim() === "7", "не показан размер журнала");
    assert(errors.length === 0, errors.join("\n"));
  });
  await test("VBS 2.0.1: внешний откат использует отдельную команду и ждёт перезагрузку", async () => {
    const {page} = await open({view:"hypervisor", mock:{vbs:externalVbs()}});
    await page.click('[data-hv-tab="vbs"]'); await page.waitForSelector('#vbs-external-card:not(.hidden)');
    await page.click('#vbs-external-restore');
    await page.waitForFunction(()=>document.querySelector('#modal-title').textContent==="Выключить внешний режим VBS.cmd?");
    assert((await page.textContent('#modal-message')).includes("не принудительное"), "откат не отделён от включения всех защит");
    await page.click('#modal-confirm');
    await page.waitForFunction(()=>document.querySelector('#modal-title').textContent==="Требуется перезапуск");
    await page.click('#modal-cancel');
    await page.waitForFunction(()=>document.querySelector('#vbs-external-badge').textContent==="ПЕРЕЗАГРУЗКА");
    const done = await calls(page, "vbs_restore_external");
    assert(done.length === 1 && done[0].args.allowUefi === false, "неверная команда или согласие UEFI");
    assert((await calls(page,"vbs_restore")).length === 0 && (await calls(page,"vbs_enable_all")).length === 0, "внешний откат подменён локальным или принудительным");
    assert(!(await page.isVisible('#vbs-enable-button')) && await page.isDisabled('#vbs-test-button'), "повторное включение доступно до перезагрузки");
  });
  await test("VBS 2.0.1: после перезагрузки внешний откат разрешает новое включение Eclipse", async () => {
    const {page, errors} = await open({view:"hypervisor", mock:{vbs:externalVbs()}});
    await page.click('[data-hv-tab="vbs"]'); await page.waitForSelector('#vbs-external-card:not(.hidden)');
    await page.click('#vbs-external-restore'); await page.waitForSelector('#modal-backdrop:not(.hidden)');
    await page.click('#modal-confirm');
    await page.waitForFunction(()=>document.querySelector('#modal-title').textContent==="Требуется перезапуск");
    await page.click('#modal-cancel');
    await page.waitForFunction(()=>document.querySelector('#vbs-external-badge').textContent==="ПЕРЕЗАГРУЗКА");
    assert(!(await page.isVisible('#vbs-enable-button')), "новое включение разрешено до перезагрузки");
    // Подмена только отчёта ОС после перезагрузки; реальных изменений Windows тест не выполняет.
    await page.evaluate(()=>{window.__CGS_MOCK_CONFIG__.vbs={};});
    await page.click('#vbs-scan-button'); await page.waitForSelector('#vbs-enable-button:not(.hidden)');
    assert(!(await page.isVisible('#vbs-external-card')), "старый внешний режим остался после перезагрузки");
    assert(!(await page.isDisabled('#vbs-enable-button')), "новое включение осталось заблокировано");
    await page.click('#vbs-enable-button'); await page.waitForSelector('#modal-backdrop:not(.hidden)');
    await page.click('#modal-confirm');
    await page.waitForFunction(()=>document.querySelector('#modal-title').textContent==="Требуется перезапуск");
    await page.click('#modal-cancel');
    assert((await calls(page,"vbs_restore_external")).length === 1, "повторно вызван внешний откат");
    assert((await calls(page,"vbs_disable")).length === 1, "не запущена новая подготовка Eclipse");
    assert((await calls(page,"vbs_restore")).length === 0 && (await calls(page,"vbs_enable_all")).length === 0, "источники отката смешаны");
    assert(errors.length === 0, errors.join("\n"));
  });
  for (const accepted of [false, true]) {
    await test(`VBS 2.0.1: UEFI Lock ${accepted ? "требует отдельного согласия" : "не восстанавливается после отмены"}`, async () => {
      const data = externalVbs(); data.external.requiresUefiConsent = true;
      const {page} = await open({view:"hypervisor", mock:{vbs:data}});
      await page.click('[data-hv-tab="vbs"]'); await page.waitForSelector('#vbs-external-card:not(.hidden)');
      await page.click('#vbs-external-restore'); await page.waitForSelector('#modal-backdrop:not(.hidden)'); await page.click('#modal-confirm');
      await page.waitForFunction(()=>document.querySelector('#modal-title').textContent==="Восстановить UEFI Lock?");
      assert((await calls(page,"vbs_restore_external")).length === 0, "изменения начались до подтверждения UEFI");
      await page.click(accepted ? '#modal-confirm' : '#modal-cancel');
      if (accepted) {
        await page.waitForFunction(()=>document.querySelector('#modal-title').textContent==="Требуется перезапуск");
        await page.click('#modal-cancel');
        const done = await calls(page,"vbs_restore_external"); assert(done.length === 1 && done[0].args.allowUefi === true, "согласие не передано в backend");
      } else {
        await page.waitForFunction(()=>!document.querySelector('#vbs-external-restore').disabled);
        assert((await calls(page,"vbs_restore_external")).length === 0, "внешний откат запущен после отмены");
      }
    });
  }
  await test("VBS 2.0.1: неизвестный журнал блокирует изменения, а не включает все защиты", async () => {
    const data = externalVbs(); data.external.canRestore = false; data.external.blockedReason = "Неизвестный параметр ManageVBS: FutureSetting";
    const {page} = await open({view:"hypervisor", mock:{vbs:data}});
    await page.click('[data-hv-tab="vbs"]'); await page.waitForSelector('#vbs-external-card:not(.hidden)');
    assert(await page.isDisabled('#vbs-external-restore') && await page.isDisabled('#vbs-enable-all-btn'), "неподдерживаемый журнал не остановил изменения");
    assert((await page.textContent('#vbs-external-reason')).includes("FutureSetting"), "не объяснена причина блокировки");
    assert((await calls(page)).filter(c=>/^vbs_(?:restore|disable|enable_all|set_test_mode)/.test(c.command)).length === 0, "сканирование изменило систему");
  });
  await test("VBS 2.0.1: смешанные снимки требуют сначала отката Eclipse", async () => {
    const data = externalVbs({canRestore:true}); data.external.canRestore = false;
    data.external.blockedReason = "Сначала откатите изменения Eclipse по его снимку, затем восстановите внешний режим VBS.cmd.";
    const {page} = await open({view:"hypervisor", mock:{vbs:data}});
    await page.click('[data-hv-tab="vbs"]'); await page.waitForSelector('#vbs-external-card:not(.hidden)');
    assert(await page.isDisabled('#vbs-external-restore'), "смешанные снимки объединяются автоматически");
    assert(await page.isVisible('#vbs-disable-button') && !(await page.isDisabled('#vbs-disable-button')), "нет доступного отката своего снимка");
    assert((await page.textContent('#vbs-disable-label')).trim() === "Откатить изменения Eclipse", "источник отката не обозначен");
  });
  await test("VBS 2.0.1: неизвестный BitLocker блокирует и внешний откат", async () => {
    const {page} = await open({view:"hypervisor", mock:{vbs:externalVbs(), bitlocker:{state:"unknown",protected:false,suspended:false,message:"Не удалось определить BitLocker."}}});
    await page.click('[data-hv-tab="vbs"]'); await page.waitForSelector('#vbs-external-card:not(.hidden)');
    assert(await page.isDisabled('#vbs-external-restore'), "внешний откат обходит BitLocker");
    assert((await page.getAttribute('#vbs-external-restore','title')).includes("BitLocker"), "нет причины блокировки");
  });
  await test("VBS 2.0.1: вкладка перечитывает внешние изменения при каждом открытии", async () => {
    const {page} = await open({view:"hypervisor"});
    await page.click('[data-hv-tab="vbs"]'); await page.waitForFunction(()=>window.__mockCalls.some(c=>c.command==="vbs_scan"));
    await page.click('[data-hv-tab="hypervisor"]');
    await page.evaluate(data=>{window.__CGS_MOCK_CONFIG__.vbs=data;}, externalVbs());
    await page.click('[data-hv-tab="vbs"]'); await page.waitForSelector('#vbs-external-card:not(.hidden)');
    assert((await calls(page,"vbs_scan")).length >= 2, "показан кэш прошлого сканирования");
  });
  await test("VBS 2.0.1: возврат фокуса перечитывает статус без побочных эффектов", async () => {
    const {page} = await open({view:"hypervisor"});
    await page.click('[data-hv-tab="vbs"]'); await page.waitForFunction(()=>window.__mockCalls.some(c=>c.command==="vbs_scan"));
    await page.waitForTimeout(2150);
    await page.evaluate(data=>{window.__CGS_MOCK_CONFIG__.vbs=data;window.dispatchEvent(new Event('focus'));}, externalVbs());
    await page.waitForSelector('#vbs-external-card:not(.hidden)');
    assert((await calls(page,"vbs_scan")).length >= 2, "изменения после внешнего CMD не замечены");
    assert((await calls(page)).filter(c=>/^vbs_(?:restore|disable|enable_all|set_test_mode)/.test(c.command)).length === 0, "возврат фокуса изменяет систему");
  });
  await test("VBS 2.0.1: фокус вне вкладки VBS не запускает фоновое сканирование", async () => {
    const {page} = await open({view:"home"});
    await page.evaluate(()=>window.dispatchEvent(new Event('focus'))); await page.waitForTimeout(150);
    assert((await calls(page,"vbs_scan")).length === 0, "лишний опрос вне вкладки");
  });
  await test("VBS 2.0.1: скрытая главная панель не сканируется, возврат в неё обновляет статус", async () => {
    const {page} = await open({view:"hypervisor"});
    await page.click('[data-hv-tab="vbs"]'); await page.waitForFunction(()=>window.__mockCalls.some(c=>c.command==="vbs_scan"));
    await page.click('.nav-item[data-view="home"]');
    await page.waitForSelector('#view-home.active'); await page.waitForTimeout(2150);
    const before = (await calls(page,"vbs_scan")).length;
    await page.evaluate(data=>{window.__CGS_MOCK_CONFIG__.vbs=data;window.dispatchEvent(new Event('focus'));}, externalVbs());
    await page.waitForTimeout(150);
    assert((await calls(page,"vbs_scan")).length === before, "фоновый опрос скрытой панели VBS");
    await page.click('.nav-item[data-view="hypervisor"]');
    await page.waitForSelector('#vbs-external-card:not(.hidden)');
    assert((await calls(page,"vbs_scan")).length > before, "при возврате показан устаревший статус");
    assert((await calls(page)).filter(c=>/^vbs_(?:restore|disable|enable_all|set_test_mode)/.test(c.command)).length === 0, "переход по разделам изменяет систему");
  });
  await test("VBS 2.0.1: автоматический Test Signing объясняется без совета F7", async () => {
    const {page} = await open({view:"hypervisor"});
    await page.click('[data-hv-tab="vbs"]'); await page.waitForSelector('#vbs-enable-button:not(.hidden)');
    await page.click('#vbs-enable-button'); await page.waitForSelector('#modal-backdrop:not(.hidden)');
    assert((await page.textContent('#modal-message')).includes("Test Signing вместо одноразового меню"), "не объяснён режим VBS 2.0.1");
    await page.click('#modal-confirm'); await page.waitForFunction(()=>document.querySelector('#modal-title').textContent==="Требуется перезапуск");
    const message = await page.textContent('#modal-message');
    assert(message.includes("обычной перезагрузки") && !message.includes("дополнительные параметры"), "показана инструкция другого режима");
    await page.click('#modal-cancel');
    assert((await calls(page,"vbs_disable")).length === 1, "не вызвана подготовка нового режима");
  });
  await test("VBS 2.0.1: без внешнего журнала сохраняется точный откат тестового режима Eclipse", async () => {
    const {page} = await open({view:"hypervisor", mock:{vbs:{canRestore:true,testSigningConfigured:true,testSigningActive:true}}});
    await page.click('[data-hv-tab="vbs"]'); await page.waitForFunction(()=>document.querySelector('#vbs-test-label').textContent==="Выключить тестовый");
    assert(!(await page.isVisible('#vbs-external-card')), "показан несуществующий внешний режим");
    assert(!(await page.isDisabled('#vbs-test-button')), "свой снимок больше нельзя восстановить");
    await page.click('#vbs-test-button'); await page.waitForSelector('#modal-backdrop:not(.hidden)'); await page.click('#modal-confirm');
    await page.waitForFunction(()=>window.__mockCalls.some(c=>c.command==="vbs_set_test_mode"));
    assert((await calls(page,"vbs_set_test_mode"))[0].args.enabled === false, "сломано выключение тестового режима");
    assert((await calls(page,"vbs_restore_external")).length === 0, "выбран чужой источник отката");
  });
  await test("VBS 2.0.1: карточка внешнего режима переведена на английский", async () => {
    const {page} = await open({view:"hypervisor", mock:{vbs:externalVbs()}});
    await page.click('[data-hv-tab="vbs"]'); await page.waitForSelector('#vbs-external-card:not(.hidden)');
    await page.evaluate(()=>window.cgsI18n.setLanguage('en'));
    await page.waitForFunction(()=>document.querySelector('#vbs-external-restore').textContent.includes('Disable external mode'));
    assert(!/[А-Яа-яЁё]/u.test(await page.textContent('#vbs-external-card')), "карточка переведена не полностью");
  });
  await test("VBS 2.0.1: внешняя карточка учитывает крупный шрифт, тему и узкую ширину", async () => {
    const {page} = await open({view:"hypervisor",viewport:{width:390,height:844},storage:{'cgs-font-scale':'140','cgs-font-family':'jetbrains','cgs-theme':'light','cgs-shape':'sharp'},mock:{vbs:externalVbs()}});
    // В Windows минимальная ширина приложения больше; здесь проверяем сам адаптивный компонент.
    await page.evaluate(()=>document.dispatchEvent(new CustomEvent('cgs:hv-tab-changed',{detail:'vbs'})));
    await page.waitForSelector('#vbs-external-card:not(.hidden)',{state:'attached'});
    const result = await page.evaluate(()=>{
      const card=document.querySelector('#vbs-external-card');
      const frame=document.createElement('main'); frame.id='vbs-test-focus'; document.body.append(frame); frame.append(card);
      const style=document.createElement('style');style.textContent='#korona .app-shell{display:none!important}#korona #vbs-test-focus{position:fixed;inset:0;padding:16px;overflow:auto;box-sizing:border-box}';document.head.append(style);
      const box=card.getBoundingClientRect(); const button=document.querySelector('#vbs-external-restore').getBoundingClientRect();
      const inside=[...card.querySelectorAll('*')].every(n=>{const r=n.getBoundingClientRect();return !r.width||(r.left>=box.left-1&&r.right<=box.right+1)});
      return {inside,overflow:card.scrollWidth-card.clientWidth,buttonHeight:button.height,fontSize:parseFloat(getComputedStyle(document.querySelector('#vbs-external-detail')).fontSize),family:getComputedStyle(card).fontFamily,radius:getComputedStyle(document.querySelector('#vbs-external-restore')).borderRadius};
    });
    assert(result.inside && result.overflow <= 0 && result.buttonHeight >= 44, `сломана адаптивная карточка: ${JSON.stringify(result)}`);
    assert(result.fontSize > 15 && /JetBrains/i.test(result.family) && parseFloat(result.radius) <= 7, `не применены настройки программы: ${JSON.stringify(result)}`);
  });

  await test("Античиты: «Вернуть как было» оформлена как соседняя кнопка", async () => {
    const {page} = await open({view:"hypervisor"});
    await page.click('[data-hv-tab="anticheat"]');
    await page.waitForSelector('#ac-restore-button svg');
    const boxes = await page.evaluate(() => ["#ac-scan-button", "#ac-restore-button"].map((id) => {
      const node = document.querySelector(id); const r = node.getBoundingClientRect(); const style = getComputedStyle(node);
      return { h: Math.round(r.height), top: Math.round(r.top), radius: style.borderRadius, size: style.fontSize, text: node.textContent.trim() };
    }));
    assert(boxes[0].h === boxes[1].h && boxes[0].top === boxes[1].top, `кнопки разной высоты: ${JSON.stringify(boxes)}`);
    assert(boxes[0].radius === boxes[1].radius && boxes[0].size === boxes[1].size, `разное оформление: ${JSON.stringify(boxes)}`);
    assert(boxes[1].text === "Вернуть как было", "подпись кнопки изменилась");
  });
  await test("Античиты: сводка из отдельных карточек, найденные следы сверху на всю ширину", async () => {
    const report = { detected: 1, items: [
      { id: "battleye", name: "BattlEye", vendor: "BattlEye Innovations", detected: false, version: null, evidence: [] },
      { id: "faceit", name: "FACEIT Anti-Cheat", vendor: "FACEIT", detected: true, version: null, evidence: [{ kind: "ПАПКА", path: "C:\\Program Files\\FACEIT AC" }] },
    ] };
    const {page} = await open({view:"hypervisor", mock:{responses:{anticheat_scan:report}}});
    await page.click('[data-hv-tab="anticheat"]');
    await page.waitForSelector(".ac-item.detected");
    const geo = await page.evaluate(() => {
      const cards = [...document.querySelectorAll(".ac-stats > article")].map((node) => node.getBoundingClientRect()).sort((a, b) => a.left - b.left);
      const box = (selector) => document.querySelector(selector).getBoundingClientRect();
      return {
        gaps: cards.slice(1).map((rect, i) => Math.round(rect.left - cards[i].right)),
        clean: box(".ac-item:not(.detected)"), dirty: box(".ac-item.detected"), list: box("#ac-list"),
        label: parseFloat(getComputedStyle(document.querySelector(".ac-stats small")).fontSize),
        state: parseFloat(getComputedStyle(document.querySelector(".ac-item:not(.detected) .ac-state")).fontSize),
      };
    });
    assert(geo.gaps.every((gap) => gap >= 8), `карточки сводки слиплись: ${geo.gaps.join(", ")}`);
    assert(geo.dirty.top < geo.clean.top, "найденный античит не поднят наверх списка");
    assert(geo.dirty.width > geo.list.width * 0.9, "найденный античит не на всю ширину");
    assert(geo.label >= 11 && geo.state >= 11, `слишком мелкие подписи: ${geo.label}px / ${geo.state}px`);
  });
  await test("Быстрый поиск: панель и подложка плавно закрываются всеми способами", async () => {
    const { page, errors } = await open();
    await trackMotion(page);
    await freezeSearchExit(page);
    for (const method of ["escape", "backdrop", "button", "hotkey"]) {
      await page.click("#titlebar-search");
      await page.waitForFunction(() => document.querySelector(".k-search-panel").getAnimations()
        .every(animation => animation.playState === "finished"));
      if (method === "escape") await page.keyboard.press("Escape");
      if (method === "backdrop") await page.click(".k-search-backdrop", { position: { x: 8, y: 8 } });
      if (method === "button") await page.click(".k-search-esc");
      if (method === "hotkey") await page.keyboard.press("Control+KeyK");
      const state = await page.evaluate(() => {
        const overlay = document.querySelector("#cgs-search");
        return {
          open: window.cgsSearch.isOpen, hidden: overlay.hidden, inert: overlay.inert,
          aria: overlay.getAttribute("aria-hidden"), pointer: getComputedStyle(overlay).pointerEvents,
          expanded: document.querySelector("#cgs-search-input").getAttribute("aria-expanded"),
          focus: document.activeElement.id,
          opacity: [...overlay.querySelectorAll(".k-search-panel,.k-search-backdrop")]
            .map(element => Number(getComputedStyle(element).opacity)),
          entering: window.__motionRecords.filter(record => record.animation.id === "cgs-enter"
            && record.element.matches(".k-search-panel,.k-search-backdrop")).length,
        };
      });
      assert(!state.open && !state.hidden && state.inert && state.aria === "true", `${method}: поиск исчез без перехода`);
      assert(state.opacity.every(value => value > 0 && value < 1), `${method}: нет промежуточного кадра ${state.opacity}`);
      assert(state.entering >= 2, "нет анимации открытия панели и подложки");
      assert(state.pointer === "none" && state.expanded === "false", "закрывающийся поиск перехватывает действия");
      assert(state.focus === "titlebar-search", `фокус не возвращён: ${state.focus}`);
      await page.evaluate(() => document.querySelector("#cgs-search").getAnimations({ subtree: true })
        .filter(animation => animation.id === "cgs-exit").forEach(animation => animation.finish()));
      await page.waitForSelector("#cgs-search[hidden]", { state: "attached" });
    }
    assert(errors.length === 0, errors.join("\n"));
  });

  await test("Быстрый поиск: повторное открытие продолжает прерванное закрытие", async () => {
    const { page, errors } = await open();
    await freezeSearchExit(page);
    await page.click("#titlebar-search");
    await page.waitForFunction(() => document.querySelector(".k-search-panel").getAnimations()
      .every(animation => animation.playState === "finished"));
    await page.keyboard.type("громкость");
    await page.keyboard.press("Escape");
    const state = await page.evaluate(() => {
      const panel = document.querySelector(".k-search-panel");
      const before = Number(getComputedStyle(panel).opacity);
      window.cgsSearch.open();
      for (const animation of document.querySelector("#cgs-search").getAnimations({ subtree: true })) {
        if (animation.id === "cgs-enter") { animation.pause(); animation.currentTime = 0; }
      }
      return {
        before, after: Number(getComputedStyle(panel).opacity),
        inert: document.querySelector("#cgs-search").inert,
        hidden: document.querySelector("#cgs-search").hasAttribute("aria-hidden"),
        query: document.querySelector("#cgs-search-input").value, focus: document.activeElement.id,
      };
    });
    assert(Math.abs(state.before - state.after) < 0.01, `скачок прозрачности: ${state.before} → ${state.after}`);
    assert(!state.inert && !state.hidden && state.query === "громкость" && state.focus === "cgs-search-input", JSON.stringify(state));
    await page.evaluate(() => document.querySelector("#cgs-search").getAnimations({ subtree: true })
      .forEach(animation => animation.play()));
    await page.waitForFunction(() => document.querySelector(".k-search-panel").getAnimations()
      .every(animation => animation.playState === "finished"));
    assert(await page.evaluate(() => window.cgsSearch.isOpen && !document.querySelector("#cgs-search").hidden), "старое закрытие скрыло повторно открытый поиск");
    assert(errors.length === 0, errors.join("\n"));
  });

  for (const theme of ["oled", "light"]) {
    await test(`Быстрый поиск: подсветка без рамки затухает за секунду, тема ${theme}`, async () => {
      const { page, errors } = await open({ storage: { "cgs-theme": theme } });
      await freezeSearchExit(page);
      await page.click("#titlebar-search");
      await page.keyboard.type("громкость");
      await page.keyboard.press("Enter");
      await page.waitForSelector(".pref-row-audio-volume.k-search-hit");
      const effect = await page.evaluate(() => {
        const overlay = document.querySelector("#cgs-search");
        const target = document.querySelector(".pref-row-audio-volume");
        const layer = document.querySelector(".k-search-flash");
        const style = getComputedStyle(layer);
        const animation = layer.getAnimations()[0];
        animation.pause();
        const opacity = [0, 500, 950].map(time => {
          animation.currentTime = time;
          return Number(getComputedStyle(layer).opacity);
        });
        return {
          open: window.cgsSearch.isOpen, closing: !overlay.hidden,
          view: document.querySelector(".nav-item.active").dataset.view,
          border: style.borderTopWidth, shadow: style.boxShadow, outline: style.outlineStyle,
          duration: animation.effect.getTiming().duration, opacity,
          widthDelta: Math.abs(layer.getBoundingClientRect().width - target.getBoundingClientRect().width),
          visible: target.checkVisibility({ opacityProperty: true }), inlineOpacity: target.style.opacity,
        };
      });
      assert(!effect.open && effect.closing && effect.view === "settings", "переход ждёт окончания закрытия поиска");
      assert(effect.border === "0px" && effect.shadow === "none" && effect.outline === "none", "подсветка оставила рамку или свечение");
      assert(effect.duration === 1000 && effect.opacity[0] > effect.opacity[1] && effect.opacity[1] > effect.opacity[2], JSON.stringify(effect));
      assert(effect.visible && effect.inlineOpacity === "" && effect.widthDelta < 1, "подсветка меняет сам блок или выходит за него");
      await page.keyboard.press("Control+KeyK");
      await page.keyboard.press("Control+KeyA");
      await page.keyboard.type("сочетание клавиш");
      await page.keyboard.press("Enter");
      await page.waitForSelector("#pref-row-search-hotkey.k-search-hit");
      assert(await page.locator(".pref-row-audio-volume.k-search-hit").count() === 0, "предыдущая подсветка не очищена");
      assert(await page.locator(".k-search-flash").count() === 1, "слои подсветки накапливаются");
      await page.evaluate(() => document.querySelector("#cgs-search").getAnimations({ subtree: true })
        .filter(animation => animation.id === "cgs-exit").forEach(animation => animation.finish()));
      await page.waitForSelector(".k-search-flash", { state: "detached" });
      assert(await page.locator(".k-search-hit").count() === 0, "метка результата осталась после затухания");
      assert(errors.length === 0, errors.join("\n"));
    });
  }

  await test("Быстрый поиск: отключение анимаций и уменьшение движения завершают закрытие", async () => {
    const { page, errors } = await open();
    await freezeSearchExit(page);
    await page.click("#titlebar-search");
    await page.keyboard.press("Escape");
    await page.evaluate(() => window.cgsMotion.applyMotion(false));
    assert(await page.locator("#cgs-search").evaluate(element => element.hidden), "отключение анимаций оставило поиск поверх окна");
    await page.keyboard.press("Control+KeyK");
    await page.keyboard.press("Escape");
    assert(await page.locator("#cgs-search").evaluate(element => element.hidden), "без анимаций поиск не закрывается сразу");
    await page.evaluate(() => window.cgsMotion.applyMotion(true));
    await page.keyboard.press("Control+KeyK");
    await page.keyboard.press("Escape");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.waitForFunction(() => document.documentElement.classList.contains("no-motion") && document.querySelector("#cgs-search").hidden);
    await page.keyboard.press("Control+KeyK");
    const running = await page.locator("#cgs-search").evaluate(element => element.getAnimations({ subtree: true })
      .filter(animation => animation.playState === "running" || animation.playState === "paused").length);
    assert(running === 0, "системное уменьшение движения не отключило переход поиска");
    await page.keyboard.press("Escape");
    assert(await page.locator("#cgs-search").evaluate(element => element.hidden), "уменьшение движения оставило поиск открытым");
    assert(errors.length === 0, errors.join("\n"));
  });

  await test("Быстрый поиск: Ctrl+K открывает строку и переходит к найденной настройке", async () => {
    const {page, errors} = await open();
    assert(await page.isVisible("#titlebar-search"), "нет строки поиска в заголовке окна");
    await page.keyboard.press("Control+KeyK");
    await page.waitForSelector("#cgs-search:not([hidden])");
    assert(await page.evaluate(() => document.activeElement?.id === "cgs-search-input"), "поле поиска не получило фокус");
    await page.keyboard.type("громкость");
    const first = await page.textContent("#cgs-search-list .k-search-item.active .k-search-title");
    assert(first.includes("громкость"), `первый результат: ${first}`);
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector(".pref-row-audio-volume.k-search-hit"));
    const state = await page.evaluate(() => ({ view: document.querySelector(".nav-item.active")?.dataset.view, tab: document.querySelector(".settings-tab-btn.active")?.dataset.settingsTab, open: window.cgsSearch.isOpen }));
    assert(state.view === "settings" && state.tab === "interface" && !state.open, JSON.stringify(state));
    await page.click("#titlebar-search");
    assert((await calls(page, "start_dragging_window")).length === 0, "нажатие на строку поиска тянет окно");
    assert(await page.evaluate(() => window.cgsSearch.isOpen), "кнопка в заголовке не открывает поиск");
    await page.keyboard.press("Escape");
    assert(!(await page.evaluate(() => window.cgsSearch.isOpen)), "Esc не закрывает поиск");
    assert(errors.length === 0, errors.join("\n"));
  });
  await test("Быстрый поиск: вкладки, свёрнутые группы и английская раскладка", async () => {
    const {page} = await open({storage:{"cgs-collapse-collapse-search":"0"}});
    await page.click("#titlebar-search");
    await page.keyboard.type("fynbxbns"); // «античиты», набранные в английской раскладке
    assert(await page.isVisible("#cgs-search-note"), "нет подсказки об исправленной раскладке");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector('[data-hv-tab="anticheat"]')?.classList.contains("active"));
    await page.keyboard.press("Control+KeyK");
    await page.keyboard.press("Control+KeyA");
    await page.keyboard.type("сочетание клавиш");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector("#collapse-search").open && document.querySelector("#pref-row-search-hotkey.k-search-hit"));
    await page.keyboard.press("Control+KeyK");
    await page.keyboard.press("Control+KeyA");
    await page.keyboard.type("нетакогопункта");
    assert(await page.isVisible("#cgs-search-list .k-search-empty"), "нет сообщения «Ничего не найдено»");
  });
  await test("Быстрый поиск: своё сочетание и отключение сохраняются", async () => {
    const {page} = await open({view:"settings"});
    await page.click("#search-hotkey-button");
    await page.keyboard.press("Control+KeyC");
    assert(await page.isVisible("#search-hotkey-hint"), "занятое системой сочетание принято без предупреждения");
    await page.keyboard.press("Alt+KeyS");
    assert(await page.evaluate(() => window.cgsStorage.getItem("cgs-search-hotkey")) === "Alt+KeyS", "сочетание не сохранено");
    assert((await page.textContent("#titlebar-search-keys")) === "AltS", "в заголовке старое сочетание");
    await page.keyboard.press("Control+KeyK");
    assert(!(await page.evaluate(() => window.cgsSearch.isOpen)), "старое сочетание всё ещё открывает поиск");
    await page.keyboard.press("Alt+KeyS");
    assert(await page.evaluate(() => window.cgsSearch.isOpen), "новое сочетание не открывает поиск");
    await page.keyboard.press("Escape");
    await page.click('label[for="search-enabled"]');
    assert(await page.evaluate(() => window.cgsStorage.getItem("cgs-search-enabled")) === "0", "отключение не сохранено");
    assert(await page.isHidden("#titlebar-search"), "строка поиска видна при выключенном поиске");
    await page.keyboard.press("Alt+KeyS");
    assert(!(await page.evaluate(() => window.cgsSearch.isOpen)), "выключенный поиск открывается сочетанием");
    await reload(page);
    await page.waitForTimeout(450);
    assert(await page.isHidden("#titlebar-search"), "после перезапуска поиск снова включён");
    assert(!(await page.isChecked("#search-enabled")), "переключатель не отражает сохранённое значение");
  });
  await test("Быстрый поиск: результаты на английском при английском интерфейсе", async () => {
    const {page} = await open();
    await page.evaluate(() => window.cgsI18n.setLanguage("en"));
    await page.keyboard.press("Control+KeyK");
    await page.keyboard.type("theme");
    await page.waitForTimeout(60);
    const text = await page.textContent("#cgs-search .k-search-panel");
    assert(text.includes("Color theme") && !/[А-Яа-яЁё]/u.test(text), `в палитре остался русский текст: ${text}`);
  });
  await test("Быстрый поиск: недавние игры и каталог кряков (префикс #)", async () => {
    const games = [{ path: "C:\\Games\\Cyber Quest\\cq.exe", name: "Cyber Quest" }];
    const {page, errors} = await open({storage:{recentGames: JSON.stringify(games)}});
    await page.keyboard.press("Control+KeyK");
    await page.keyboard.type("cyber");
    const game = await page.textContent("#cgs-search-list .k-search-item.active .k-search-title");
    assert(game === "Cyber Quest", `первым найдена не недавняя игра: ${game}`);
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector(".nav-item.active")?.dataset.view === "fix" && document.querySelector("#game-path").value.includes("Cyber Quest"));
    await page.keyboard.press("Control+KeyK");
    await page.keyboard.press("Control+KeyA");
    await page.keyboard.type("#pinned two");
    assert(await page.isVisible("#cgs-search-scope"), "префикс # не показал область поиска");
    assert((await page.inputValue("#cgs-search-input")) === "pinned two", "префикс остался в поле");
    await page.waitForFunction(() => document.querySelector("#cgs-search-list .k-search-item.active .k-search-title")?.textContent === "Pinned Game Two");
    const kinds = await page.$$eval("#cgs-search-list .k-search-badge", (els) => [...new Set(els.map((e) => e.textContent))]);
    assert(kinds.every((k) => ["Кряк", "Поиск", "Игра", "Архив", "Игра Steam"].includes(k)), `с префиксом # найдено лишнее: ${kinds}`);
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector(".nav-item.active")?.dataset.view === "files" && document.querySelector('[data-card-url="https://example.com/two.zip"].k-search-hit'));
    assert(errors.length === 0, errors.join("\n"));
  });
  await test("Быстрый поиск: действия выполняются, опасные — только после подтверждения", async () => {
    const {page, errors} = await open();
    await page.keyboard.press("Control+KeyK");
    await page.keyboard.type(">перезапуск стим");
    assert((await page.textContent("#cgs-search-list .k-search-item.active .k-search-title")) === "Перезапустить Steam", "действие не найдено");
    assert(await page.isVisible("#cgs-search-list .k-search-item.active .k-search-badge.danger"), "опасное действие не помечено");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#modal-backdrop:not(.hidden)");
    assert((await page.textContent("#modal-title")) === "Перезапустить Steam?", "нет подтверждения перезапуска");
    await page.click("#modal-cancel");
    await page.waitForSelector("#modal-backdrop", { state: "hidden" });
    assert((await calls(page, "luatools_restart_steam")).length === 0, "Steam перезапущен без подтверждения");
    await page.keyboard.press("Control+KeyK");
    await page.keyboard.press("Control+KeyA");
    await page.keyboard.type("сканировать античиты");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector('[data-hv-tab="anticheat"]')?.classList.contains("active"));
    await page.waitForFunction(() => window.__mockCalls.some((c) => /anticheat/.test(c.command)));
    assert(!(await page.evaluate(() => window.cgsSearch.isOpen)), "палитра не закрылась после действия");
    assert(errors.length === 0, errors.join("\n"));
  });
  await test("Быстрый поиск: переключатель на месте и предпросмотр темы", async () => {
    const {page, errors} = await open();
    const before = await page.isChecked("#audio-master-toggle");
    await page.keyboard.press("Control+KeyK");
    await page.keyboard.type("включить звуковые эффекты");
    const state = () => page.getAttribute("#cgs-search-list .k-search-item.active .k-search-switch", "data-on");
    assert((await state()) === (before ? "1" : "0"), "переключатель в палитре не показывает текущее значение");
    await page.keyboard.press("Enter");
    assert(await page.evaluate(() => window.cgsSearch.isOpen), "палитра закрылась после переключения");
    assert((await page.isChecked("#audio-master-toggle")) === !before, "настройка не переключилась");
    assert((await state()) === (before ? "0" : "1"), "переключатель в палитре не обновился");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Space");
    assert((await page.isChecked("#audio-master-toggle")) === before, "Пробел после стрелок не переключает");
    const theme = await page.evaluate(() => document.documentElement.dataset.theme);
    await page.keyboard.press("Control+KeyA");
    await page.keyboard.type("красная");
    await page.waitForFunction(() => document.documentElement.dataset.theme === "ruby");
    await page.keyboard.press("Escape");
    await page.waitForFunction((t) => document.documentElement.dataset.theme === t, theme);
    assert((await page.evaluate(() => window.cgsStorage.getItem("cgs-theme"))) !== "ruby", "предпросмотр сохранил тему");
    await page.keyboard.press("Control+KeyK");
    await page.keyboard.press("Control+KeyA");
    await page.keyboard.type("красная");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.documentElement.dataset.theme === "ruby" && !window.cgsSearch.isOpen);
    assert((await page.evaluate(() => window.cgsStorage.getItem("cgs-theme"))) === "ruby", "выбранная тема не сохранена");
    assert(errors.length === 0, errors.join("\n"));
  });
  await test("Быстрый поиск: синонимы, опечатки, префикс @ и недавние", async () => {
    const {page} = await open();
    await page.keyboard.press("Control+KeyK");
    await page.keyboard.type("hvci");
    const titles = await page.$$eval("#cgs-search-list .k-search-title", (els) => els.slice(0, 4).map((e) => e.textContent));
    assert(titles.some((t) => t.includes("VBS")), `синоним hvci не нашёл VBS: ${titles}`);
    await page.keyboard.press("Control+KeyA");
    await page.keyboard.type("антчиты");
    const typo = await page.textContent("#cgs-search-list .k-search-item.active .k-search-title");
    assert(/Античит/.test(typo), `опечатка не исправлена: ${typo}`);
    await page.keyboard.press("Control+KeyA");
    await page.keyboard.type("@звук");
    assert((await page.textContent("#cgs-search-scope")) === "Настройки", "нет чипа области «Настройки»");
    const kinds = await page.$$eval("#cgs-search-list .k-search-badge", (els) => [...new Set(els.map((e) => e.textContent))]);
    assert(kinds.every((k) => ["Параметр", "Группа", "Вариант"].includes(k)), `с префиксом @ найдено лишнее: ${kinds}`);
    await page.keyboard.press("Control+KeyA");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    assert(await page.isHidden("#cgs-search-scope"), "Backspace в пустом поле не снимает область");
    await page.keyboard.type("громкость");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Control+KeyK");
    await page.keyboard.press("Control+KeyA");
    await page.keyboard.press("Backspace");
    const groups = await page.$$eval("#cgs-search-list .k-search-group", (els) => els.map((e) => e.textContent));
    const first = await page.textContent("#cgs-search-list .k-search-item .k-search-title");
    assert(groups[0] === "Недавние" && first.includes("громкость"), `нет недавних: ${groups} / ${first}`);
  });
  await test("Быстрый поиск: своё сочетание для пункта поиска", async () => {
    const {page, errors} = await open({view:"settings"});
    const before = await page.isChecked("#audio-master-toggle");
    await page.keyboard.press("Control+KeyK");
    await page.keyboard.type("включить звуковые эффекты");
    await page.keyboard.press("Alt+Enter");
    assert(await page.isVisible("#cgs-search-list .k-search-item.binding"), "нет режима записи сочетания");
    await page.keyboard.press("Control+KeyC");
    assert((await page.getAttribute("#cgs-search-note", "data-tone")) === "warn", "занятое сочетание принято");
    await page.keyboard.press("Alt+Shift+KeyJ");
    assert((await page.textContent("#cgs-search-list .k-search-item.active .k-search-keys")).includes("J"), "сочетание не показано у пункта");
    const binds = JSON.parse(await page.evaluate(() => window.cgsStorage.getItem("cgs-search-binds")));
    assert(Object.values(binds).some((b) => b.keys === "Alt+Shift+KeyJ"), "сочетание не сохранено");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Alt+Shift+KeyJ");
    assert((await page.isChecked("#audio-master-toggle")) === !before, "сочетание не переключает настройку");
    assert((await page.$$("#search-binds-list .search-bind")).length === 1, "сочетание не появилось в настройках");
    await reload(page);
    await page.waitForTimeout(450);
    assert((await page.$$("#search-binds-list .search-bind")).length === 1, "сочетание пропало после перезапуска");
    await page.click("#search-binds-list .search-bind-remove");
    assert(await page.isVisible("#search-binds-list .search-binds-empty"), "сочетание не удалено");
    await page.keyboard.press("Alt+Shift+KeyJ");
    await page.waitForTimeout(100);
    assert((await page.isChecked("#audio-master-toggle")) === !before, "удалённое сочетание всё ещё работает");
    assert(errors.length === 0, errors.join("\n"));
  });
  await test("Быстрый поиск: игры пользователя — Гипервизор, Eclipse Manifest и Steam", async () => {
    const library = { selected_id: "hv-1", games: [
      { id: "hv-1", name: "SWGR-Win64-Shipping", exe_path: "D:\\Games\\SWGR\\SWGR-Win64-Shipping.exe", dir_path: "D:\\Games\\SWGR", ready: true },
      { id: "hv-2", name: "Hollow Night", exe_path: "D:\\Games\\HN\\hollow.exe", dir_path: "D:\\Games\\HN", ready: true },
    ] };
    const steamGame = { appid: 570, name: "Dota 2", gameDir: "C:\\Steam\\steamapps\\common\\dota 2 beta", libraryPath: "C:\\Steam", headerImage: "" };
    const {page, errors} = await open({mock:{responses:{
      list_games: library, set_selected_game: { ...library, selected_id: "hv-2" },
      luatools_status: { games: [{ appid: "1245620", enabled: true, status: "ready" }], steamPath: "C:\\Steam" },
      luatools_names: { "1245620": "ELDEN RING" },
      scan_installed_steam_games: { games: [steamGame], libraries: ["C:\\Steam"], warnings: [] },
      scan_dlc_target: { gameDir: steamGame.gameDir, appid: 570, name: "Dota 2", detected: true, targets: [], exes: [] },
    }}});
    const activeIs = (title) => page.waitForFunction((title) => document.querySelector("#cgs-search-list .k-search-item.active .k-search-title")?.textContent === title, title);
    await page.keyboard.press("Control+KeyK");
    await page.keyboard.type("#");
    await page.waitForFunction(() => [...document.querySelectorAll("#cgs-search-list .k-search-badge")].some((el) => el.textContent === "Manifest"));
    const badges = await page.$$eval("#cgs-search-list .k-search-badge", (els) => [...new Set(els.map((e) => e.textContent))]);
    for (const badge of ["Игра HV", "Manifest", "Игра Steam"]) assert(badges.includes(badge), `в области # нет «${badge}»: ${badges}`);
    await page.keyboard.type("hollow");
    await activeIs("Hollow Night");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector('.hv-game-card[data-game-id="hv-2"].k-search-hit'));
    assert(await page.evaluate(() => window.__mockCalls.some((c) => c.command === "set_selected_game" && c.args.id === "hv-2")), "игра Гипервизора не выбрана");
    await page.keyboard.press("Control+KeyK");
    await page.keyboard.press("Control+KeyA");
    await page.keyboard.type("dota");
    await activeIs("Dota 2");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector("#view-dlc.dlc-detail") && window.__mockCalls.some((c) => c.command === "scan_dlc_target"));
    await page.keyboard.press("Control+KeyK");
    await page.keyboard.press("Control+KeyA");
    await page.keyboard.type("elden");
    await activeIs("ELDEN RING");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector(".nav-item.active")?.dataset.view === "lua" && document.querySelector("#lua-detail-name")?.textContent === "ELDEN RING");
    const cache = await page.evaluate(() => window.cgsStorage.getItem("cgs-search-library") || "");
    assert(cache.includes("ELDEN RING") && cache.includes("Dota 2"), `список игр не сохранён для следующего запуска: ${cache}`);
    assert(errors.length === 0, errors.join("\n"));
  });

  // Расположение панелей: ожидание конца плавного перехода и геометрия элементов
  const dockSettled = async (page) => {
    await page.waitForFunction(() => !/k-dock-transition|k-rail-returning|k-search-returning/.test(document.documentElement.className));
    await page.waitForTimeout(80);
  };
  const rectOf = (page, selector) => page.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom }; }, selector);
  const emptyRailPoint = (page) => page.evaluate(() => {
    const items = [...document.querySelectorAll(".sidebar .nav-item:not(.nav-item-hidden)")];
    const a = items[items.length - 2].getBoundingClientRect();
    const z = items[items.length - 1].getBoundingClientRect();
    const point = document.documentElement.classList.contains("sidebar-horizontal")
      ? { x: (a.right + z.left) / 2, y: a.top + a.height / 2 }
      : { x: a.left + a.width / 2, y: (a.bottom + z.top) / 2 };
    point.free = !document.elementFromPoint(point.x, point.y).closest(".nav-item");
    return point;
  });
  const dragMouse = async (page, from, to, { escape = false } = {}) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + (to.x - from.x) * 0.2, from.y + (to.y - from.y) * 0.2, { steps: 4 });
    await page.mouse.move(to.x, to.y, { steps: 8 });
    if (escape) await page.keyboard.press("Escape");
    await page.mouse.up();
  };

  await test("Расположение панелей: по умолчанию слева и по центру, выбор в настройках сохраняется после перезапуска", async () => {
    const { page, errors } = await open({ view: "settings" });
    await page.evaluate(() => window.cgsAppearance.applySettingsTab("sidebar", false));
    const html = () => page.evaluate(() => document.documentElement.className);
    assert(!/sidebar-dock-|search-dock-|sidebar-horizontal/.test(await html()), "без сохранённых ключей раскладка изменена: " + await html());
    assert(await page.getAttribute('[data-sidebar-dock="left"]', "aria-pressed") === "true", "по умолчанию не выбрано «Слева»");
    assert(await page.getAttribute('[data-search-dock="center"]', "aria-pressed") === "true", "по умолчанию не выбрано «По центру»");
    let rail = await rectOf(page, ".sidebar"), main = await rectOf(page, ".main-area"), search = await rectOf(page, "#titlebar-search");
    assert(rail.right <= main.x + 1, "рейка не слева от рабочей области");
    assert(Math.abs(search.x + search.w / 2 - 720) < 2, "строка поиска не по центру");

    await page.click('[data-sidebar-dock="right"]');
    await dockSettled(page);
    rail = await rectOf(page, ".sidebar"); main = await rectOf(page, ".main-area");
    assert(rail.x >= main.right - 1 && rail.right <= 1440, "рейка не перешла вправо");
    assert(await page.evaluate(() => window.cgsStorage.getItem("cgs-sidebar-dock")) === "right", "положение рейки не сохранено");
    // Ручка ширины у правой рейки на левом краю: стрелка влево расширяет панель
    const before = rail.w;
    await page.focus("#sidebar-resizer");
    await page.keyboard.press("ArrowLeft");
    assert((await rectOf(page, ".sidebar")).w > before, "стрелка влево не расширяет правую рейку");
    const handle = await rectOf(page, "#sidebar-resizer");
    assert(handle.x < rail.x + 6, "ручка ширины не на левом краю правой рейки");

    await page.click('[data-sidebar-dock="top"]');
    await dockSettled(page);
    rail = await rectOf(page, ".sidebar"); main = await rectOf(page, ".main-area");
    assert(rail.bottom <= main.y + 1 && rail.w > 1200 && rail.h < 80, "рейка не встала горизонтально сверху");
    assert(await page.isHidden("#sidebar-resizer"), "ручка ширины видна у горизонтальной рейки");
    const settings = await rectOf(page, '.sidebar .nav-item[data-view="settings"]');
    assert(settings.right > rail.right - 30, "«Настройки» не прижаты к правому краю горизонтальной рейки");

    await page.click('[data-sidebar-dock="bottom"]');
    await dockSettled(page);
    rail = await rectOf(page, ".sidebar"); main = await rectOf(page, ".main-area");
    assert(rail.y >= main.bottom - 1 && rail.bottom <= 900, "рейка не встала снизу");

    await page.click('[data-search-dock="left"]');
    await dockSettled(page);
    search = await rectOf(page, "#titlebar-search");
    const brand = await rectOf(page, ".titlebar-brand");
    assert(search.x > brand.right && search.x < 480, "строка поиска не слева");
    await page.click('[data-search-dock="right"]');
    await dockSettled(page);
    search = await rectOf(page, "#titlebar-search");
    const actions = await rectOf(page, ".window-actions");
    assert(search.right <= actions.x && search.right > 1000, "строка поиска не справа");

    await reload(page);
    await page.waitForTimeout(450);
    const after = await html();
    assert(/sidebar-dock-bottom/.test(after) && /sidebar-horizontal/.test(after) && /search-dock-right/.test(after), "после перезапуска положение не восстановлено: " + after);
    assert(await page.getAttribute('[data-sidebar-dock="bottom"]', "aria-pressed") === "true", "после перезапуска в настройках не отмечено «Снизу»");
    assert(await page.getAttribute('[data-search-dock="right"]', "aria-pressed") === "true", "после перезапуска в настройках не отмечено «Справа»");
    assert(errors.length === 0, errors.join("\n"));
  });

  await test("Расположение панелей: рейку и строку поиска перетаскивают мышью, Esc отменяет", async () => {
    const { page, errors } = await open({ storage: { "cgs-sidebar-live-edit": "1" } });
    const html = () => page.evaluate(() => document.documentElement.className);
    let point = await emptyRailPoint(page);
    assert(point.free, "на рейке нет свободного места для захвата");
    // Короткое движение — не перетаскивание
    await dragMouse(page, point, { x: point.x + 3, y: point.y + 2 });
    assert(!/sidebar-dock-/.test(await html()), "короткое движение сдвинуло рейку");

    await dragMouse(page, point, { x: 1400, y: 450 });
    await dockSettled(page);
    assert(/sidebar-dock-right/.test(await html()), "рейка не перетащилась вправо");
    assert(await page.evaluate(() => window.cgsStorage.getItem("cgs-sidebar-dock")) === "right", "перетаскивание не сохранено");
    await page.waitForSelector(".k-dock-zones", { state: "detached" });

    point = await emptyRailPoint(page);
    await dragMouse(page, point, { x: 720, y: 130 });
    await dockSettled(page);
    assert(/sidebar-dock-top/.test(await html()) && /sidebar-horizontal/.test(await html()), "рейка не перетащилась наверх");

    point = await emptyRailPoint(page);
    assert(point.free, "у горизонтальной рейки нет свободного места");
    await dragMouse(page, point, { x: 720, y: 860 }, { escape: true });
    await dockSettled(page);
    assert(/sidebar-dock-top/.test(await html()), "Esc не отменил перетаскивание");

    // Перестановка пунктов «На лету» в горизонтальной рейке идёт слева направо
    const home = await rectOf(page, '.sidebar .nav-item[data-view="home"]');
    const fix = await rectOf(page, '.sidebar .nav-item[data-view="fix"]');
    await dragMouse(page, { x: home.x + home.w / 2, y: home.y + home.h / 2 }, { x: fix.right - 4, y: home.y + home.h / 2 });
    await page.waitForTimeout(400);
    const order = await page.evaluate(() => JSON.parse(window.cgsStorage.getItem("cgs-sidebar-order") || "[]"));
    assert(order[0] === "fix" && order[1] === "home", "пункты горизонтальной рейки не переставились: " + order.slice(0, 3).join(","));

    // Строка поиска: перетаскивание влево не открывает палитру, обычный щелчок — открывает
    const search = await rectOf(page, "#titlebar-search");
    const start = { x: search.x + search.w / 2, y: search.y + search.h / 2 };
    await dragMouse(page, start, { x: start.x - 300, y: start.y });
    await dockSettled(page);
    assert(/search-dock-left/.test(await html()), "строка поиска не перетащилась влево");
    assert(!(await page.evaluate(() => window.cgsSearch.isOpen)), "перетаскивание открыло палитру поиска");
    assert(await page.evaluate(() => window.cgsStorage.getItem("cgs-search-dock")) === "left", "положение строки поиска не сохранено");
    await page.click("#titlebar-search");
    assert(await page.evaluate(() => window.cgsSearch.isOpen), "щелчок по строке после перетаскивания не открывает поиск");
    await page.keyboard.press("Escape");
    assert(errors.length === 0, errors.join("\n"));
  });

  // Локальное облако (CloudRedirect) и обновление программы из Crocodile Gena Studio 5.6.3
  await test("Локальное облако: выбор папки, включение и откат при ошибке", async () => {
    const { page, errors } = await open({ view: "lua", mock: { localCloudPick: null } });
    await page.waitForFunction(() => document.querySelector("#lc-badge").textContent === "Выключено");
    assert(await page.isEnabled("#lc-enabled"), "переключатель недоступен");
    assert((await page.textContent("#lc-status")).includes("Выберите папку"), "нет подсказки выбрать папку");
    // Отмена выбора папки не включает режим
    await page.click("#lc-enabled");
    await page.waitForTimeout(80);
    assert(!(await page.isChecked("#lc-enabled")), "переключатель включился без папки");
    assert((await calls(page, "local_cloud_set")).length === 0, "режим применён без папки");
    // Выбранная папка показывается до включения
    await page.evaluate(() => { window.__CGS_MOCK_CONFIG__.localCloudPick = "D:\\Cloud Saves"; });
    await page.click("#lc-browse");
    await page.waitForFunction(() => document.querySelector("#lc-folder").value === "D:\\Cloud Saves");
    assert((await page.textContent("#lc-status")).includes("Папка выбрана"), "нет подтверждения выбора");
    await page.click("#lc-enabled");
    await page.waitForFunction(() => document.querySelector("#lc-badge").textContent === "Включено");
    const set = (await calls(page, "local_cloud_set")).at(-1);
    assert(set.args.enabled === true && set.args.folder === "D:\\Cloud Saves", "неверные аргументы: " + JSON.stringify(set.args));
    assert(await page.isChecked("#lc-enabled"), "переключатель не отражает включённый режим");
    assert((await page.textContent("#lc-status")) === "Локальный режим включён · игр с манифестами: 2.", "неверный статус включения");
    assert(await page.getAttribute("#lc-status", "data-kind") === "ok", "статус не помечен успешным");
    // Ошибка выключения: переключатель остаётся включённым, причина видна
    await page.evaluate(() => { window.__CGS_MOCK_CONFIG__.localCloudSetError = "Steam не завершился за 30 секунд; настройки не изменены."; });
    await page.click("#lc-enabled");
    await page.waitForFunction(() => document.querySelector("#lc-status").dataset.kind === "error");
    assert(await page.isChecked("#lc-enabled"), "переключатель выключился при ошибке");
    assert((await page.textContent("#lc-status")).includes("30 секунд"), "причина ошибки скрыта");
    // Справка раскрывается кнопкой «Информация»
    assert(await page.isHidden("#lc-help"), "справка раскрыта по умолчанию");
    await page.click("#lc-info");
    assert(await page.isVisible("#lc-help") && await page.getAttribute("#lc-info", "aria-expanded") === "true", "справка не раскрылась");
    // Перевод на английский без кириллицы
    await page.evaluate(() => window.cgsI18n.setLanguage("en"));
    await page.waitForTimeout(120);
    const english = await page.innerText("#local-cloud-panel");
    assert(!/[А-Яа-яЁё]/.test(english), "в панели осталась кириллица: " + english);
    assert(english.includes("Local Cloud") && english.includes("Steam did not exit within 30 seconds"), "нет перевода панели");
    if (SHOTS) await page.locator("#local-cloud-panel").screenshot({ path: path.join(SHOTS, "local-cloud-en.png") });
    assert(errors.length === 0, errors.join("\n"));
  });

  await test("Локальное облако: несовместимый загрузчик блокирует включение", async () => {
    const { page, errors } = await open({ view: "lua", mock: { localCloud: { loaderSupported: false } } });
    await page.waitForFunction(() => document.querySelector("#lc-badge").textContent === "Недоступно");
    assert(await page.isDisabled("#lc-enabled"), "включение доступно без поддержки загрузчика");
    assert(await page.getAttribute("#lc-status", "data-kind") === "warning", "нет предупреждения");
    assert((await page.textContent("#lc-status")).includes("Версия OpenSteamTool"), "нет подсказки про загрузчик");
    // Применение загрузчика повторно проверяет поддержку
    await page.evaluate(() => sessionStorage.setItem("__local_cloud_state", JSON.stringify({
      enabled: false, managed: false, folder: null, eligibleApps: [], loaderSupported: true, issue: null,
      steamPath: "C:\\Program Files (x86)\\Steam", componentVersion: "1.0.0", componentOutdated: false })));
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("cgs:request", { detail: { id: "x", command: "luatools_apply_loader", status: "success" } })));
    await page.waitForFunction(() => document.querySelector("#lc-badge").textContent === "Выключено");
    assert(await page.isEnabled("#lc-enabled"), "после смены загрузчика переключатель недоступен");
    assert(errors.length === 0, errors.join("\n"));
  });

  await test("Локальное облако: находится в быстром поиске и открывает панель", async () => {
    const { page, errors } = await open();
    const firstTitle = () => page.textContent("#cgs-search-list .k-search-item.active .k-search-title");
    await page.keyboard.press("Control+KeyK");
    await page.keyboard.type("облако");
    assert((await firstTitle()) === "Локальное облако", "первым найдено не локальное облако");
    assert((await page.textContent("#cgs-search-list .k-search-item.active .k-search-badge")) === "Блок", "облако найдено не как блок страницы");
    if (SHOTS) await page.locator("#cgs-search .k-search-panel").screenshot({ path: path.join(SHOTS, "local-cloud-search.png") });
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector(".nav-item.active")?.dataset.view === "lua" && document.querySelector("#local-cloud-panel.k-search-hit"));
    assert(!(await page.evaluate(() => window.cgsSearch.isOpen)), "палитра не закрылась после перехода");
    // Английское название и запрос, а также англоязычное слово в русском интерфейсе
    for (const [query, expected, language] of [["cloudredirect", "Локальное облако", "ru"], ["local cloud", "Local Cloud", "en"], ["облако", "Local Cloud", "en"]]) {
      await page.evaluate((lang) => window.cgsI18n.setLanguage(lang), language);
      await page.keyboard.press("Control+KeyK");
      await page.keyboard.press("Control+KeyA");
      await page.keyboard.type(query);
      await page.waitForTimeout(60);
      assert((await firstTitle()) === expected, `запрос «${query}» не нашёл ${expected}`);
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !window.cgsSearch.isOpen);
    }
    assert(errors.length === 0, errors.join("\n"));
  });

  const UPDATE_RELEASE = {
    available: true, currentVersion: "9.0.0", latestVersion: "9.1.0", title: "Eclipse Studio 9.1.0",
    notes: "## Что нового\n- Локальное облако\n- Обновление с перезапуском",
    releaseUrl: "https://github.com/Sparki1337/eclipse-studio/releases/tag/v9.1.0",
    installerUrl: null, portableUrl: "https://github.com/Sparki1337/eclipse-studio/releases/download/v9.1.0/EclipseStudio.exe",
    inAppSupported: true, assetName: "EclipseStudio.exe", assetSha256: "a".repeat(64),
  };
  const updateMock = (extra = {}) => ({ responses: { check_for_update: UPDATE_RELEASE }, ...extra });
  const dialogOpen = (page) => page.waitForSelector("#app-update-backdrop:not(.hidden)", { timeout: 9000 });

  await test("Обновление: занятость, ход загрузки, блокировка интерфейса и отмена", async () => {
    const { page, errors } = await open({ view: "settings", mock: updateMock({ installPending: true }) });
    await dialogOpen(page);
    assert((await page.textContent("#app-update-title")).includes("9.1.0"), "нет версии в заголовке");
    assert(await page.textContent("#app-update-install") === "Обновить и перезапустить", "неверная кнопка установки");
    assert(await page.textContent("#app-update-defer") === "Отложить на 5 запусков", "неверная кнопка откладывания");
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "update-ready.png") });
    // Посторонняя операция не даёт начать замену EXE
    await page.evaluate(() => window.cgsReportBusy("test-operation", true));
    await page.click("#app-update-install");
    await page.waitForFunction(() => document.querySelector("#toast-stack").textContent.includes("Дождитесь завершения текущих операций"));
    assert((await calls(page, "install_update")).length === 0, "обновление началось во время операции");
    await page.evaluate(() => window.cgsReportBusy("test-operation", false));
    await page.click("#app-update-install");
    await page.waitForFunction(() => window.__pendingInstall);
    const install = (await calls(page, "install_update")).at(-1);
    assert(install.args.version === "9.1.0", "неверная версия установки");
    assert(await page.isVisible("#app-update-cancel") && await page.isHidden("#app-update-install"), "нет кнопки отмены");
    const inert = await page.evaluate(() => ({
      main: document.querySelector(".main-area")?.closest("[inert]") !== null || document.querySelector(".main-area")?.inert === true,
      titlebar: document.querySelector(".titlebar, #titlebar")?.closest("[inert]") !== null,
    }));
    assert(inert.main, "основная область доступна во время установки");
    assert(!inert.titlebar, "кнопки окна заблокированы");
    // Процент, объём и скорость загрузки
    await page.evaluate(() => window.__mockEmit("cgs-update-progress", { phase: "downloading", downloaded: 5242880, total: 10485760, percent: 50, attempt: 0, message: "" }));
    await page.waitForTimeout(400);
    await page.evaluate(() => window.__mockEmit("cgs-update-progress", { phase: "downloading", downloaded: 6291456, total: 10485760, percent: 60, attempt: 0, message: "" }));
    await page.waitForFunction(() => document.querySelector("#app-update-percent").textContent === "60%");
    const detail = await page.textContent("#app-update-detail");
    assert(detail.includes("6.0 / 10.0 МБ") && detail.includes("МБ/с"), "нет объёма и скорости: " + detail);
    assert(await page.getAttribute("#app-update-progress", "aria-valuenow") === "60", "полоса не обновила aria-valuenow");
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "update-downloading.png") });
    // Esc во время установки отменяет её
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.querySelector("#app-update-title").textContent === "Обновление отменено");
    assert((await calls(page, "cancel_update")).length === 1, "отмена не передана бэкенду");
    assert(await page.textContent("#app-update-install") === "Повторить", "нет повтора после отмены");
    // После отмены окно закрывается обычным Esc и возвращает доступ к интерфейсу
    await page.keyboard.press("Escape");
    await page.waitForSelector("#app-update-backdrop", { state: "hidden" });
    assert(await page.evaluate(() => !document.querySelector(".main-area")?.closest("[inert]")), "интерфейс остался заблокированным");
    await page.click('.nav-item[data-view="lua"]');
    assert(await page.evaluate(() => document.querySelector("#view-lua").classList.contains("active")), "разделы недоступны после отмены");
    assert(errors.length === 0, errors.join("\n"));
  });

  await test("Обновление: вместе с библиотеками OpenSteamTool выбор идёт вторым шагом", async () => {
    const { page, errors } = await open({ view: "settings", mock: updateMock({ responses: {
      check_for_update: UPDATE_RELEASE,
      luatools_check_loader_updates: { updateAvailable: true, currentVersion: "1.0", latestVersion: "1.1", bundles: [] },
    } }) });
    await dialogOpen(page);
    assert(await page.textContent("#app-update-install") === "Далее →", "нет перехода ко второму шагу");
    await page.click("#app-update-install");
    assert(await page.isVisible("#app-update-step2") && await page.isHidden("#app-update-progress-wrap"), "второй шаг не показан");
    assert(await page.textContent("#app-update-defer") === "Назад", "нет возврата к первому шагу");
    await page.click("#app-update-defer");
    assert(await page.isHidden("#app-update-step2") && await page.isVisible("#app-update-backdrop"), "«Назад» закрыло окно");
    assert(await page.textContent("#app-update-defer") === "Отложить на 5 запусков", "кнопка откладывания не вернулась");
    assert(errors.length === 0, errors.join("\n"));
  });

  await test("Обновление: ошибка проверки файла показывается в окне", async () => {
    const message = "SHA-256 скачанного EXE не совпадает с опубликованной в релизе.";
    const { page, errors } = await open({ view: "settings", mock: updateMock({ installError: message }) });
    await dialogOpen(page);
    await page.click("#app-update-install");
    await page.waitForFunction(() => document.querySelector("#app-update-progress-wrap").dataset.state === "error");
    assert(await page.textContent("#app-update-title") === "Обновление не выполнено", "нет заголовка ошибки");
    assert(await page.textContent("#app-update-detail") === message, "причина не показана");
    assert(await page.isHidden("#app-update-progress"), "полоса видна при ошибке");
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "update-error.png") });
    await page.evaluate(() => window.cgsI18n.setLanguage("en"));
    await page.waitForFunction(() => document.querySelector("#app-update-title").textContent === "Update failed");
    assert((await page.textContent("#app-update-detail")).startsWith("The SHA-256 of the downloaded EXE"), "причина не переведена");
    assert(errors.length === 0, errors.join("\n"));
  });

  await test("Обновление: откладывание на 5 запусков и ручная проверка", async () => {
    const { page, errors } = await open({ view: "settings", mock: updateMock() });
    await dialogOpen(page);
    await page.click("#app-update-defer");
    await page.waitForSelector("#app-update-backdrop", { state: "hidden" });
    assert(await page.evaluate(() => cgsStorage.getItem("cgs-update-snooze-launches")) === "5", "счётчик не сохранён");
    // Перезагрузка окна в том же запуске не расходует откладывание
    await reload(page);
    await page.waitForFunction(() => window.__mockCalls.some(c => c.command === "check_for_update"), null, { timeout: 9000 });
    await page.waitForTimeout(500);
    assert(await page.isHidden("#app-update-backdrop"), "окно показано после откладывания");
    assert(await page.evaluate(() => cgsStorage.getItem("cgs-update-snooze-launches")) === "5", "перезагрузка израсходовала запуск");
    // Ручная проверка показывает окно даже при откладывании
    await page.click('[data-settings-tab="storage"]');
    await page.click("#check-update-button");
    await dialogOpen(page);
    assert(errors.length === 0, errors.join("\n"));
  });

  await test("Обновление: новый запуск расходует откладывание, итог установки показывается", async () => {
    const { page, errors } = await open({
      view: "settings",
      storage: { "cgs-update-snooze-launches": "5", "cgs-language": "en" },
      mock: updateMock({ sessionId: "launch-2", launchOutcome: { success: true, message: "Eclipse Studio обновлён до версии 9.0.0.", version: "9.0.0" } }),
    });
    await page.waitForFunction(() => document.querySelector("#toast-stack").textContent.includes("Eclipse Studio has been updated to version 9.0.0."));
    // Успешная установка сбрасывает откладывание, поэтому новое окно показывается сразу
    await dialogOpen(page);
    assert(await page.evaluate(() => cgsStorage.getItem("cgs-update-snooze-launches")) === null, "откладывание не сброшено после успешной установки");
    assert(errors.length === 0, errors.join("\n"));
    const second = await open({ view: "settings", storage: { "cgs-update-snooze-launches": "5" }, mock: updateMock({ sessionId: "launch-3" }) });
    await second.page.waitForFunction(() => window.__mockCalls.some(c => c.command === "check_for_update"), null, { timeout: 9000 });
    await second.page.waitForTimeout(500);
    assert(await second.page.isHidden("#app-update-backdrop"), "окно показано во время откладывания");
    assert(await second.page.evaluate(() => cgsStorage.getItem("cgs-update-snooze-launches")) === "4", "новый запуск не уменьшил счётчик");
  });

  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\nИтого: ${results.length - failed.length} из ${results.length} тестов пройдено`);
  fs.mkdirSync(path.join(ROOT,"test-results"),{recursive:true});
  fs.writeFileSync(path.join(ROOT,"test-results/ui.json"),JSON.stringify(results,null,2));
  process.exit(failed.length ? 1 : 0);
}

run().catch((error) => { console.error(error); process.exit(1); });
