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

async function run() {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM || (fs.existsSync("/usr/local/bin/chromium") ? "/usr/local/bin/chromium" : undefined), args: ["--allow-file-access-from-files"] });
  console.log(`Команд бэкенда в lib.rs: ${COMMANDS.length}`);

  await test("Все команды, которые вызывает интерфейс, зарегистрированы в lib.rs", async () => {
    const ui = fs.readdirSync(path.join(ROOT,"ui"), { recursive:true }).filter(f=>f.endsWith(".js")).map(f=>fs.readFileSync(path.join(ROOT,"ui",f),"utf8")).join("\n");
    const used = new Set([...ui.matchAll(/(?:call|invoke)\("([a-z_0-9]+)"/g)].map((m) => m[1]));
    const missing = [...used].filter((c) => !COMMANDS.includes(c));
    assert(missing.length === 0, "Не зарегистрированы: " + missing.join(", "));
  });

  await test("Запуск без ошибок JS, версия 8.2.0", async () => {
    const { page, context, errors } = await open();
    const version = await page.textContent(".titlebar-version");
    assert(version.trim() === "8.2.0", "версия " + version);
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
    await page.waitForTimeout(450); // у пунктов меню плавная анимация размера
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
    await page.mouse.move(x, 400); await page.mouse.down(); await page.mouse.move(x + 80, 400, { steps: 6 }); await page.mouse.up(); await page.waitForTimeout(400);
    const dragged = await width();
    assert(Math.abs(dragged - (initial + 80)) <= 2, `ширина ${initial} → ${dragged}`);
    await page.mouse.move(x + 80, 400); await page.mouse.down(); await page.mouse.move(x + 900, 400, { steps: 6 }); await page.mouse.up(); await page.waitForTimeout(400);
    assert(await width() === 380, "максимум не соблюдается: " + await width());
    const box2 = await page.locator("#sidebar-resizer").boundingBox();
    await page.mouse.move(box2.x + 4, 400); await page.mouse.down(); await page.mouse.move(10, 400, { steps: 6 }); await page.mouse.up(); await page.waitForTimeout(400);
    assert(await width() === 180, "минимум не соблюдается: " + await width());
    await reload(page); await page.waitForTimeout(300);
    assert(await width() === 180, "позиция не сохранилась");
    await page.focus("#sidebar-resizer"); await page.keyboard.press("ArrowRight"); await page.waitForTimeout(400);
    assert(await width() === 190, "клавиатура: " + await width());
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
  await test("Частичная установка не получает метку УСТАНОВЛЕНО и показывает пропуски", async () => {
    const {page}=await open({view:"files",mock:{responses:{files_install_crack:{success:false,status:"partial",installedFiles:["one.dll"],skipped:["two.dll: отказ записи"],message:"Один файл не установлен"}}}});
    await page.waitForSelector('[data-files-action="install-flow"][data-files-url="https://example.com/r0.zip"]');
    await page.click('[data-files-action="install-flow"][data-files-url="https://example.com/r0.zip"]');await page.waitForTimeout(150);
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
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\nИтого: ${results.length - failed.length} из ${results.length} тестов пройдено`);
  fs.mkdirSync(path.join(ROOT,"test-results"),{recursive:true});
  fs.writeFileSync(path.join(ROOT,"test-results/ui.json"),JSON.stringify(results,null,2));
  process.exit(failed.length ? 1 : 0);
}

run().catch((error) => { console.error(error); process.exit(1); });
