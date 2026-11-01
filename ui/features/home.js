// Главная: недавние игры, резервные копии, незавершённые операции и проблемы
(() => {
  "use strict";
  const storage = window.cgsStorage;
  const ROW_CHOICES = [3, 4, 6, 8];       // строк в панели до кнопки «Ещё» (настройка «Строк в списке»)
  const limit = () => { const value = Number(storage.getItem("cgs-home-rows")); return ROW_CHOICES.includes(value) ? value : 4; };
  const DISMISSED_KEY = "homeDismissedJobs"; // записи журнала, скрытые пользователем
  const PROBLEM = new Set(["failed", "partial"]);
  const PENDING = new Set(["running", "interrupted"]);
  let nativeJobs = [];
  let journalError = "";
  const expanded = new Set();             // панели, раскрытые кнопкой «Ещё»
  const signatures = new Map();           // отпечатки списков: без изменений DOM не перерисовывается

  const read = key => { try { const value = JSON.parse(storage.getItem(key) || "[]"); return Array.isArray(value) ? value : []; } catch (_) { return []; } };
  function remember(key, entry, identity) {
    const list = read(key).filter(item => item[identity] !== entry[identity]); list.unshift(entry); storage.setItem(key, JSON.stringify(list.slice(0, 6))); render(); renderListSettings();
  }
  const baseName = path => String(path || "").split(/[\\/]/).filter(Boolean).pop() || String(path || "");
  // Длинный путь сокращается посередине: диск и две последние папки остаются видны, полный путь — в подсказке
  function shortPath(path) {
    const value = String(path || "");
    const parts = value.split(/[\\/]/).filter(Boolean);
    if (value.length <= 42 || parts.length <= 3) return value;
    const separator = value.includes("\\") ? "\\" : "/";
    return (value.startsWith(separator) ? separator : "") + [parts[0], "…", ...parts.slice(-2)].join(separator);
  }
  const folderOf = path => String(path || "").replace(/[\\/][^\\/]*$/, "");
  const locale = () => window.cgsI18n?.locale?.() || "ru-RU";
  // Время записи: сегодня — только часы, иначе дата и время
  function when(ms) {
    if (!ms || !Number.isFinite(ms) || ms < 946684800000) return "";
    const date = new Date(ms); const now = new Date();
    const sameDay = date.toDateString() === now.toDateString();
    const options = sameDay ? { hour: "2-digit", minute: "2-digit" }
      : { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) };
    try { return new Intl.DateTimeFormat(locale(), options).format(date); } catch (_) { return ""; }
  }
  const joined = (...parts) => parts.filter(Boolean).join(" · ");
  // Ресурс задания для подписи: системная блокировка Windows пользователю не интересна
  const place = job => (job.resources || []).find(path => path && !/windows-system\.lock$/i.test(path)) || "";
  const service = () => storage.getItem("manifestService") === "hubcap" ? "hubcap" : "ryuu";
  const dismissed = () => new Set(read(DISMISSED_KEY));
  function dismiss(id) {
    const list = read(DISMISSED_KEY).filter(item => item !== id); list.unshift(id);
    storage.setItem(DISMISSED_KEY, JSON.stringify(list.slice(0, 100))); render(); renderListSettings();
  }
  // Переход в раздел операции; «раздел:вкладка» открывает вкладку гипервизора
  function openSection(target) {
    const [view, tab] = String(target || "").split(":");
    document.querySelector(`.nav-item[data-view="${view}"]`)?.click();
    if (tab) requestAnimationFrame(() => document.querySelector(`[data-hv-tab="${tab}"]`)?.click());
  }
  // Новейшая запись по каждому ключу: успешный повтор той же операции скрывает старую ошибку
  function latest(list, key) {
    const seen = new Set();
    return list.filter(item => { const id = key(item); if (seen.has(id)) return false; seen.add(id); return true; });
  }
  const nativeKey = job => `${job.label}|${(job.resources || []).join("|")}`;
  const nativeTime = job => (job.finishedUnix || job.startedUnix || 0) * 1000;
  const tone = status => status === "failed" ? "danger" : status === "running" ? "busy" : "warn";

  function button(label, action, className = "home-item-action") {
    const element = document.createElement("button"); element.type = "button"; element.className = className;
    element.textContent = label; element.addEventListener("click", action); return element;
  }
  function row(data) {
    const li = document.createElement("li"); li.className = "home-item";
    if (data.tone) li.dataset.tone = data.tone;
    const copy = document.createElement("div"); copy.className = "home-item-copy";
    const head = document.createElement("div"); head.className = "home-item-head";
    const title = document.createElement("strong"); title.textContent = data.title; title.title = data.title;
    head.append(title);
    if (data.code) { const code = document.createElement("code"); code.className = "home-item-id"; code.textContent = data.code; code.title = data.code; head.append(code); }
    const detail = document.createElement("span"); detail.className = "home-item-detail"; detail.textContent = data.detail || "";
    if (data.hint) detail.title = data.hint;
    copy.append(head, detail); li.append(copy);
    const actions = document.createElement("div"); actions.className = "home-item-actions";
    for (const action of data.actions || []) actions.append(button(action.label, action.run));
    if (data.dismiss) { const close = button("×", () => dismiss(data.dismiss), "home-item-dismiss"); close.title = "Скрыть"; close.setAttribute("aria-label", "Скрыть"); actions.append(close); }
    if (actions.childElementCount) li.append(actions);
    return li;
  }
  function fill(id, rows, empty, state = "") {
    const list = document.getElementById(id); if (!list) return;
    const panel = list.closest(".home-status-panel");
    if (panel) { if (state) panel.dataset.state = state; else delete panel.dataset.state; }
    const count = document.getElementById(id + "-count"); if (count) count.textContent = rows.length ? String(rows.length) : "";
    const LIMIT = limit();
    const open = expanded.has(id) && rows.length > LIMIT;
    const signature = JSON.stringify([open, LIMIT, empty, window.cgsI18n?.language, rows.map(item => [item.title, item.detail, item.hint, item.tone, item.code, item.dismiss, (item.actions || []).map(action => action.label)])]);
    if (signatures.get(id) === signature) return;
    signatures.set(id, signature);
    const children = (open ? rows : rows.slice(0, LIMIT)).map(row);
    if (rows.length > LIMIT) {
      const li = document.createElement("li"); li.className = "home-more";
      li.append(button(open ? "Показать меньше" : `Ещё ${rows.length - LIMIT}`, () => { if (open) expanded.delete(id); else expanded.add(id); render(); }));
      children.push(li);
    }
    if (!rows.length) { const li = document.createElement("li"); li.className = "home-empty"; li.textContent = empty; children.push(li); }
    list.replaceChildren(...children);
  }

  function render() {
    fill("home-recent-games", read("recentGames").filter(game => game?.path).map(game => ({
      title: game.name || baseName(game.path), detail: shortPath(game.path), hint: game.path,
      actions: [{ label: "Открыть", run: () => window.cgsOpenGame?.(game.path) }],
    })), "Откройте папку игры — она появится здесь.");

    fill("home-recent-backups", read("recentBackups").filter(backup => backup?.path).map(backup => ({
      title: baseName(backup.path), detail: joined(when(backup.time), shortPath(folderOf(backup.path))), hint: backup.path,
      actions: [{ label: "Папка", run: () => window.cgsApi.invoke("files_reveal", { path: backup.path }).catch(error => window.cgsToast?.(String(error), "error")) }],
    })), "Резервных копий пока нет — архив появится после сохранения в разделе «Сохранения».");

    const hidden = dismissed();
    const freshNative = latest(nativeJobs, nativeKey);
    const pending = freshNative.filter(job => PENDING.has(job.status) && !(job.status === "interrupted" && hidden.has(job.id)));
    fill("home-pending-jobs", pending.map(job => ({
      title: job.label, code: job.id, tone: tone(job.status),
      detail: joined(job.status === "running" ? "Выполняется" : "Прервано — проверьте результат", when(nativeTime(job)), shortPath(place(job))),
      hint: joined(job.status === "running" ? "Операция выполняется" : "Операция прервана (например, при закрытии программы). Проверьте результат и резервную копию", place(job), job.id && `ID ${job.id}`),
      actions: window.cgsJobs?.viewForLabel(job.label) ? [{ label: "Открыть", run: () => openSection(window.cgsJobs.viewForLabel(job.label)) }] : [],
      dismiss: job.status === "interrupted" ? job.id : "",
    })), "Незавершённых операций нет.", pending.some(job => job.status === "running") ? "busy" : pending.length ? "warn" : "");

    // Ошибки интерфейса: только пользовательские операции, по одной (новейшей) на команду,
    // без операций другого источника манифестов и без дублей нативного журнала
    const current = service();
    const uiProblems = latest(window.cgsJobs?.list() || [], job => job.command)
      .filter(job => PROBLEM.has(job.status) && !hidden.has(job.id) && (!job.service || job.service === current))
      .filter(job => !(job.native && nativeJobs.some(native => native.label === job.native && PROBLEM.has(native.status) && (native.startedUnix || 0) * 1000 >= job.time - 2000)))
      .map(job => ({ time: job.time, data: {
        title: job.label, tone: tone(job.status), hint: job.message || "",
        detail: joined(job.message || (job.status === "partial" ? "Выполнено частично" : "Операция не выполнена"), when(job.time)),
        actions: job.view ? [{ label: "Открыть", run: () => openSection(job.view) }] : [], dismiss: job.id,
      } }));
    const nativeProblems = freshNative.filter(job => PROBLEM.has(job.status) && !hidden.has(job.id)).map(job => ({ time: nativeTime(job), data: {
      title: job.label, tone: tone(job.status), hint: place(job),
      detail: joined(job.status === "partial" ? "Выполнено частично" : "Завершилось с ошибкой", when(nativeTime(job)), shortPath(place(job))),
      actions: window.cgsJobs?.viewForLabel(job.label) ? [{ label: "Открыть", run: () => openSection(window.cgsJobs.viewForLabel(job.label)) }] : [],
      dismiss: job.id,
    } }));
    const problems = [...uiProblems, ...nativeProblems].sort((a, b) => b.time - a.time).map(item => item.data);
    if (journalError) problems.unshift({ title: "Журнал операций недоступен", detail: journalError, hint: journalError, tone: "warn" });
    fill("home-attention", problems, "Проблем, требующих внимания, не обнаружено.", problems.some(item => item.tone === "danger") ? "danger" : problems.length ? "warn" : "");
  }

  async function refresh() {
    try { nativeJobs = await window.cgsApi.invoke("jobs_list"); if (!Array.isArray(nativeJobs)) nativeJobs = []; journalError = ""; }
    catch (error) { journalError = String(error?.message || error); }
    render(); renderListSettings();
  }
  window.addEventListener("cgs:request", event => {
    const { command, status, result } = event.detail;
    if (command === "create_save_archive" && status === "success" && result?.archivePath) remember("recentBackups", { path: result.archivePath, time: Date.now() }, "path");
  });
  window.addEventListener("cgs:jobs-changed", render);
  window.addEventListener("cgs:language-changed", () => { signatures.clear(); render(); });
  window.addEventListener("cgs:view-changed", event => { if (event.detail === "home") refresh(); });
  // Карточки модулей открываются и с клавиатуры (Enter или пробел)
  document.getElementById("view-home")?.addEventListener("keydown", event => {
    const card = event.target.closest?.(".module-card[data-open-view]");
    if (!card || card !== event.target || !["Enter", " "].includes(event.key)) return;
    event.preventDefault(); card.click();
  });
  // ── Настройки главной: блоки, карточки модулей, длина списков и раздел при запуске ──
  const LAYOUT_KEY = "cgs-home-layout";            // { order: [...], hidden: [...] }
  const MODULES_KEY = "cgs-home-modules-hidden";   // карточки модулей, выключенные на главной
  const IDS_KEY = "cgs-home-ids";                  // "0" — не показывать ID операций
  const START_KEY = "cgs-start-view";              // раздел при запуске: home | last | раздел | раздел:вкладка
  const LAST_VIEW_KEY = "cgs-last-view";
  const STATUS_BLOCKS = new Set(["games", "backups", "pending", "attention"]);
  const HV_TABS = ["hypervisor", "anticheat", "vbs"];
  const svg = body => `<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
  const BLOCKS = [
    { id: "hero", title: "Приветствие", hint: "Баннер Eclipse Studio", icon: svg('<path d="M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.14-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.14a.5.5 0 0 1 .96 0l1.58 6.14a2 2 0 0 0 1.44 1.44l6.14 1.58a.5.5 0 0 1 0 .96l-6.14 1.58a2 2 0 0 0-1.44 1.44l-1.58 6.14a.5.5 0 0 1-.96 0z"/>') },
    { id: "games", title: "Недавние игры", hint: "Папки игр, открытые в Online Fix" },
    { id: "backups", title: "Последние резервные копии", hint: "Архивы из менеджера сохранений" },
    { id: "pending", title: "Незавершённые операции", hint: "Выполняемые и прерванные задания" },
    { id: "attention", title: "Требует внимания", hint: "Ошибки и частично выполненные операции" },
    { id: "modules", title: "Карточки модулей", hint: "Быстрый переход в разделы", icon: svg('<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>') },
  ];
  // Названия хранятся здесь, а не читаются из DOM: в английском интерфейсе текст карточек уже переведён
  const VIEW_TITLES = { home: "Главная", fix: "Online Fix", saves: "Менеджер сохранений", dlc: "DLC Unlocker", lua: "Eclipse Manifest", hypervisor: "Гипервизор", files: "Кряки", utilities: "Утилиты", settings: "Настройки" };

  const layout = document.querySelector("#view-home .home-layout");
  const moduleGrid = layout?.querySelector(".home-grid");
  const footer = layout?.querySelector(".home-footer");
  const blockNodes = { hero: layout?.querySelector(".home-hero"), modules: moduleGrid };
  layout?.querySelectorAll(".home-status-panel[data-kind]").forEach(panel => { blockNodes[panel.dataset.kind] = panel; });
  const statusGrids = [layout?.querySelector(".home-status-grid")].filter(Boolean);
  const cards = new Map([...(moduleGrid?.querySelectorAll(".module-card[data-open-view]") || [])].map(card => [card.dataset.openView, card]));
  const defaultCardOrder = [...cards.keys()];
  let emptyNote = null;

  function readObject(key) { try { const value = JSON.parse(storage.getItem(key) || "{}"); return value && typeof value === "object" && !Array.isArray(value) ? value : {}; } catch (_) { return {}; } }
  function layoutConfig() {
    const saved = readObject(LAYOUT_KEY);
    const ids = BLOCKS.map(block => block.id);
    const order = (Array.isArray(saved.order) ? saved.order : []).filter((id, index, list) => ids.includes(id) && list.indexOf(id) === index);
    for (const id of ids) if (!order.includes(id)) order.push(id);
    return { order, hidden: new Set((Array.isArray(saved.hidden) ? saved.hidden : []).filter(id => ids.includes(id))) };
  }
  const saveLayout = config => storage.setItem(LAYOUT_KEY, JSON.stringify({ order: config.order, hidden: [...config.hidden] }));
  const hiddenModules = () => new Set(read(MODULES_KEY).filter(id => cards.has(id)));
  // Порядок карточек повторяет порядок разделов в боковой панели
  function moduleOrder() {
    const sidebar = read("cgs-sidebar-order");
    const rank = id => { const index = sidebar.indexOf(id); return index === -1 ? sidebar.length + defaultCardOrder.indexOf(id) : index; };
    return [...defaultCardOrder].sort((a, b) => rank(a) - rank(b));
  }
  const idsShown = () => storage.getItem(IDS_KEY) !== "0";
  function statusGrid() {
    const grid = document.createElement("div"); grid.className = "home-status-grid";
    grid.setAttribute("aria-label", "Текущее состояние"); return grid;
  }
  function createEmptyNote() {
    const note = document.createElement("div"); note.className = "premium-panel home-layout-empty";
    const title = document.createElement("strong"); title.textContent = "Все блоки главной скрыты";
    const text = document.createElement("p"); text.textContent = "Включите нужные блоки в настройках или верните все сразу.";
    note.append(title, text, button("Показать все блоки", showAllBlocks, "secondary-button"));
    return note;
  }

  // Пересборка главной: подряд идущие панели состояния делят одну сетку, скрытые блоки и карточки убираются из DOM,
  // чтобы правила раскладки по nth-child считали только видимые элементы. DOM меняется, только если порядок другой
  const sameChildren = (parent, nodes) => parent.childElementCount === nodes.length && nodes.every((node, index) => parent.children[index] === node);
  function applyLayout() {
    if (!layout || !footer) return;
    const config = layoutConfig();
    const off = hiddenModules();
    const visibleCards = moduleOrder().filter(id => !off.has(id)).map(id => cards.get(id));
    if (moduleGrid && !sameChildren(moduleGrid, visibleCards)) moduleGrid.replaceChildren(...visibleCards);
    const plan = [];
    for (const id of config.order) {
      const node = blockNodes[id];
      if (!node || config.hidden.has(id) || (id === "modules" && !visibleCards.length)) continue;
      if (!STATUS_BLOCKS.has(id)) { plan.push(node); continue; }
      if (Array.isArray(plan.at(-1))) plan.at(-1).push(node); else plan.push([node]);
    }
    let used = 0;
    const nodes = plan.map(item => {
      if (!Array.isArray(item)) return item;
      if (used === statusGrids.length) statusGrids.push(statusGrid());
      const grid = statusGrids[used]; used += 1;
      if (!sameChildren(grid, item)) grid.replaceChildren(...item);
      if (grid.dataset.count !== String(item.length)) grid.dataset.count = String(item.length);
      return grid;
    });
    statusGrids.slice(used).forEach(grid => { if (grid.childElementCount) grid.replaceChildren(); });
    if (!nodes.length) nodes.push(emptyNote ||= createEmptyNote());
    nodes.push(footer);
    const ids = idsShown() ? "on" : "off";
    if (layout.dataset.ids !== ids) layout.dataset.ids = ids;
    if (!sameChildren(layout, nodes)) layout.replaceChildren(...nodes);
    render();
  }

  // Строки блоков в настройках: стрелки меняют порядок, переключатель скрывает блок
  const blocksList = document.getElementById("home-blocks-list");
  function blockIcon(block) {
    return block.icon || blockNodes[block.id]?.querySelector(".home-status-icon")?.innerHTML || "";
  }
  function orderButton(direction, disabled, action) {
    const element = document.createElement("button"); element.type = "button";
    element.className = `sidebar-module-order-btn order-${direction}`;
    element.title = direction === "up" ? "Поднять" : "Опустить";
    element.setAttribute("aria-label", element.title);
    element.disabled = disabled;
    element.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" d="${direction === "up" ? "M3 10l5-5 5 5" : "M3 6l5 5 5-5"}"/></svg>`;
    element.addEventListener("click", action);
    return element;
  }
  function renderBlockRows(focus) {
    if (!blocksList) return;
    const config = layoutConfig();
    const noCards = hiddenModules().size >= cards.size;
    blocksList.replaceChildren(...config.order.map((id, index) => {
      const block = BLOCKS.find(item => item.id === id);
      const shown = !config.hidden.has(id);
      const row = document.createElement("div"); row.className = "sidebar-module-row home-block-row"; row.dataset.block = id;
      row.classList.toggle("is-off", !shown);
      const arrows = document.createElement("div"); arrows.className = "sidebar-module-order-btns";
      arrows.append(orderButton("up", index === 0, () => moveBlock(id, -1)), orderButton("down", index === config.order.length - 1, () => moveBlock(id, 1)));
      const number = document.createElement("span"); number.className = "sidebar-module-index"; number.textContent = String(index + 1).padStart(2, "0");
      const icon = document.createElement("span"); icon.className = "sidebar-module-icon"; icon.innerHTML = blockIcon(block);
      const copy = document.createElement("div"); copy.className = "home-block-copy";
      const title = document.createElement("strong"); title.className = "sidebar-module-title"; title.textContent = block.title;
      const hint = document.createElement("small"); hint.textContent = id === "modules" && noCards ? "Все карточки выключены — блок не показывается" : block.hint;
      copy.append(title, hint);
      const toggle = document.createElement("label"); toggle.className = "switch"; toggle.title = "Показывать на главной";
      const input = document.createElement("input"); input.type = "checkbox"; input.className = "home-block-toggle"; input.checked = shown;
      input.setAttribute("aria-label", block.title);
      input.addEventListener("change", () => setBlockShown(id, input.checked));
      toggle.append(input, document.createElement("i"));
      row.append(arrows, number, icon, copy, toggle);
      return row;
    }));
    if (focus) {
      const row = blocksList.querySelector(`[data-block="${focus.id}"]`);
      const target = row?.querySelector(`.order-${focus.direction}:not(:disabled)`) || row?.querySelector(".sidebar-module-order-btn:not(:disabled)");
      target?.focus();
    }
  }
  function moveBlock(id, step) {
    const config = layoutConfig();
    const from = config.order.indexOf(id); const to = from + step;
    if (from < 0 || to < 0 || to >= config.order.length) return;
    config.order.splice(to, 0, config.order.splice(from, 1)[0]);
    saveLayout(config); applyLayout(); renderBlockRows({ id, direction: step < 0 ? "up" : "down" });
  }
  function setBlockShown(id, shown) {
    const config = layoutConfig();
    if (shown) config.hidden.delete(id); else config.hidden.add(id);
    saveLayout(config); applyLayout();
    blocksList?.querySelector(`[data-block="${id}"]`)?.classList.toggle("is-off", !shown);
  }
  function showAllBlocks() {
    const config = layoutConfig(); config.hidden.clear(); saveLayout(config);
    storage.setItem(MODULES_KEY, "[]");
    applyLayout(); renderBlockRows(); renderModuleChips();
  }
  function resetBlockOrder() {
    const config = layoutConfig(); config.order = BLOCKS.map(block => block.id); saveLayout(config);
    applyLayout(); renderBlockRows();
  }

  // Чипы карточек модулей
  const chips = document.getElementById("home-module-chips");
  function renderModuleChips() {
    if (!chips) return;
    const off = hiddenModules();
    chips.replaceChildren(...moduleOrder().map(id => {
      const chip = document.createElement("button"); chip.type = "button"; chip.className = "home-module-chip"; chip.dataset.module = id;
      chip.setAttribute("aria-pressed", String(!off.has(id)));
      const icon = document.createElement("span"); icon.className = "home-module-chip-icon"; icon.setAttribute("aria-hidden", "true");
      icon.innerHTML = cards.get(id)?.querySelector(".metric-icon")?.innerHTML || "";
      const label = document.createElement("span"); label.textContent = VIEW_TITLES[id] || id;
      const check = document.createElement("span"); check.className = "home-module-chip-check"; check.setAttribute("aria-hidden", "true");
      check.innerHTML = svg('<path d="M20 6 9 17l-5-5"/>');
      chip.append(icon, label, check);
      chip.addEventListener("click", () => toggleModule(id));
      return chip;
    }));
  }
  function toggleModule(id) {
    const off = hiddenModules();
    if (off.has(id)) off.delete(id); else off.add(id);
    storage.setItem(MODULES_KEY, JSON.stringify([...off]));
    applyLayout();
    chips?.querySelector(`[data-module="${id}"]`)?.setAttribute("aria-pressed", String(!off.has(id)));
    renderBlockRows();
  }

  // Длина списков, номера операций, скрытые уведомления и история.
  // Текст меняется только при изменении: любая правка DOM запускает перевод всей страницы
  // (сравнивается исходный русский текст: в английском интерфейсе textContent уже переведён)
  const shownText = new WeakMap();
  const setText = (element, text) => { if (!element || shownText.get(element) === text) return; shownText.set(element, text); element.textContent = text; };
  const rowsPicker = document.getElementById("home-rows-picker");
  const idsToggle = document.getElementById("home-show-ids");
  function renderListSettings() {
    rowsPicker?.querySelectorAll("[data-home-rows]").forEach(choice => {
      const active = Number(choice.dataset.homeRows) === limit();
      choice.classList.toggle("active", active); choice.setAttribute("aria-pressed", String(active));
    });
    if (idsToggle) idsToggle.checked = idsShown();
    // Считаются только скрытые записи, которые ещё есть в журнале: старые ID не показываются
    const known = new Set([...nativeJobs, ...(window.cgsJobs?.list() || [])].map(job => job.id));
    const hiddenCount = read(DISMISSED_KEY).filter(id => known.has(id)).length;
    setText(document.getElementById("home-dismissed-info"), hiddenCount ? `Скрыто записей: ${hiddenCount}` : "Скрытых записей нет");
    const restore = document.getElementById("home-restore-dismissed");
    if (restore) restore.disabled = !hiddenCount;
    const games = read("recentGames").length; const backups = read("recentBackups").length;
    setText(document.getElementById("home-history-info"), games || backups ? `Игр: ${games} · резервных копий: ${backups}` : "История пуста");
    const clear = document.getElementById("home-clear-history");
    if (clear) clear.disabled = !(games || backups);
  }
  rowsPicker?.addEventListener("click", event => {
    const choice = event.target.closest("[data-home-rows]"); if (!choice) return;
    storage.setItem("cgs-home-rows", choice.dataset.homeRows); renderListSettings(); render();
  });
  idsToggle?.addEventListener("change", () => {
    storage.setItem(IDS_KEY, idsToggle.checked ? "1" : "0");
    if (layout) layout.dataset.ids = idsToggle.checked ? "on" : "off";
  });
  document.getElementById("home-restore-dismissed")?.addEventListener("click", () => {
    storage.setItem(DISMISSED_KEY, "[]"); render(); renderListSettings();
    window.cgsToast?.("Скрытые записи снова показываются на главной", "success");
  });
  document.getElementById("home-clear-history")?.addEventListener("click", () => {
    storage.setItem("recentGames", "[]"); storage.setItem("recentBackups", "[]"); render(); renderListSettings();
    window.cgsToast?.("История главной очищена", "success");
  });
  document.getElementById("home-blocks-show-all")?.addEventListener("click", showAllBlocks);
  document.getElementById("home-blocks-reset")?.addEventListener("click", resetBlockOrder);

  // Раздел при запуске. Скрытый в боковой панели раздел не открывается: вместо него главная или первый видимый
  const startSelect = document.getElementById("start-view");
  const startNote = document.getElementById("start-view-note");
  const viewVisible = (view, known) => Boolean(VIEW_TITLES[view]) && (!known || known.includes(view))
    && !document.querySelector(`.nav-item[data-view="${view}"]`)?.classList.contains("nav-item-hidden");
  function startTarget(known, setting = storage.getItem(START_KEY) || "home") {
    const choice = setting === "last" ? storage.getItem(LAST_VIEW_KEY) || "home" : setting;
    const [view, tab = setting === "hypervisor" ? "hypervisor" : ""] = String(choice).split(":");
    if (viewVisible(view, known)) return { view, tab: view === "hypervisor" && HV_TABS.includes(tab) ? tab : "" };
    if (viewVisible("home", known)) return { view: "home", tab: "" };
    const first = [...document.querySelectorAll(".navigation .nav-item[data-view]")].find(item => viewVisible(item.dataset.view, known));
    return { view: first?.dataset.view || "home", tab: "" };
  }
  function renderStartView() {
    if (!startSelect) return;
    const stored = storage.getItem(START_KEY) || "home";
    const value = [...startSelect.options].some(option => option.value === stored) ? stored : "home";
    if (startSelect.value !== value) startSelect.value = value;
    if (!startNote) return;
    const view = value.split(":")[0];
    const fallback = value === "last" || viewVisible(view) ? null : startTarget(null, value).view;
    startNote.hidden = !fallback;
    setText(startNote, fallback ? `Раздел скрыт в боковой панели — при запуске откроется «${VIEW_TITLES[fallback]}».` : "");
  }
  startSelect?.addEventListener("change", () => { storage.setItem(START_KEY, startSelect.value); renderStartView(); });

  // «Настроить главную» открывает вкладку «Главная и запуск»
  function openHomeSettings() {
    document.querySelector('.nav-item[data-view="settings"]')?.click();
    window.cgsAppearance?.applySettingsTab?.("home");
  }
  document.getElementById("home-customize")?.addEventListener("click", openHomeSettings);

  window.addEventListener("cgs:sidebar-changed", () => { applyLayout(); renderModuleChips(); renderStartView(); });
  window.addEventListener("cgs:view-changed", event => {
    const view = event.detail;
    if (VIEW_TITLES[view] && storage.getItem(LAST_VIEW_KEY) !== view) storage.setItem(LAST_VIEW_KEY, view);
    if (view === "settings") { renderListSettings(); renderStartView(); }
  });

  window.cgsHome = {
    recordGame(path, name) { if (path) remember("recentGames", { path, name: name || baseName(path) }, "path"); },
    startTarget,
    openSettings: openHomeSettings,
  };
  // Последняя игра попадает в историю только при первом запуске: очищенная история не заполняется снова
  const last = storage.getItem("lastGamePath"); if (last && storage.getItem("recentGames") === null) window.cgsHome.recordGame(last);
  applyLayout(); renderBlockRows(); renderModuleChips(); renderListSettings(); renderStartView();
  refresh();
  setInterval(() => { if (document.querySelector("#view-home.active")) refresh(); }, 4000);
})();
