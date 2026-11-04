// Быстрый поиск по актуальному индексу; > и ! — действия, # и № — игры, @ — настройки
(() => {
  "use strict";

  const ENABLED_KEY = "cgs-search-enabled";
  const HOTKEY_KEY = "cgs-search-hotkey";
  const RECENT_KEY = "cgs-search-recent";
  // Последний известный список игр Manifest и Steam: поиск находит их сразу после запуска
  const LIBRARY_KEY = "cgs-search-library";
  const BINDS_KEY = "cgs-search-binds";
  const DEFAULT_HOTKEY = "Ctrl+KeyK";
  const MODIFIERS = ["Ctrl", "Alt", "Shift", "Meta"];
  // Сочетания редактирования текста и закрытия окна не перехватываем
  const RESERVED = new Set(["Ctrl+KeyA", "Ctrl+KeyC", "Ctrl+KeyV", "Ctrl+KeyX", "Ctrl+KeyZ", "Ctrl+KeyY", "Ctrl+Shift+KeyZ", "Ctrl+KeyW", "Ctrl+F4", "Alt+F4", "Alt+Tab"]);
  const ROW_SELECTOR = ".pref-row, .sidebar-module-row, .sidebar-live-edit-row, .dock-row, .svc-option, .loader-option";
  const OPTION_SELECTOR = "[data-theme-option], .accent[data-accent], [data-sidebar-mode], [data-sidebar-dock], [data-search-dock]";
  const KIND = {
    view: { group: "Разделы", badge: "Раздел", weight: 14, scope: "nav" },
    tab: { group: "Вкладки", badge: "Вкладка", weight: 12, scope: "nav" },
    section: { group: "Настройки", badge: "Группа", weight: 9, scope: "settings" },
    setting: { group: "Настройки", badge: "Параметр", weight: 8, scope: "settings" },
    option: { group: "Настройки", badge: "Вариант", weight: 5, scope: "settings" },
    block: { group: "На страницах", badge: "Блок", weight: 4, scope: "nav" },
    action: { group: "Действия", badge: "Действие", weight: 10, scope: "action" },
    game: { group: "Недавние игры", badge: "Игра", weight: 13, scope: "content" },
    hv: { group: "Библиотека Гипервизора", badge: "Игра HV", weight: 13, scope: "content" },
    manifest: { group: "Игры Eclipse Manifest", badge: "Manifest", weight: 11, scope: "content" },
    backup: { group: "Резервные копии", badge: "Архив", weight: 6, scope: "content" },
    steam: { group: "Библиотека Steam", badge: "Игра Steam", weight: 8, scope: "content" },
    crack: { group: "Каталог кряков", badge: "Кряк", weight: 7, scope: "content" },
    find: { group: "Искать в разделах", badge: "Поиск", weight: 0, scope: "content" },
  };
  const PREFIXES = {
    ">": "action", "!": "action",
    "#": "content", "№": "content",
    "@": "settings", '"': "settings",
  };
  const SCOPE_LABEL = { action: "Действия", content: "Игры и файлы", settings: "Настройки" };
  const SCOPE_PREFIX = { action: ">", content: "#", settings: "@" };
  // Действия из поиска вызывают существующие кнопки со всеми проверками и подтверждениями
  const ACTIONS = [
    { key: "telegram", selector: "#open-telegram-hub", title: "Telegram каналы", keys: "telegram телеграм тг каналы", stay: true },
    { key: "ac-scan", selector: "#ac-scan-button", title: "Сканировать античиты", keys: "anticheat scan проверить античит" },
    { key: "ac-remove", selector: "#ac-remove-all", title: "Удалить найденные античиты", keys: "anticheat remove очистить", danger: true },
    { key: "ac-restore", selector: "#ac-restore-button", title: "Вернуть античиты как было", keys: "anticheat restore восстановить", danger: true },
    { key: "vbs-scan", selector: "#vbs-scan-button", title: "Проверить VBS и HVCI", keys: "vbs hvci scan сканировать виртуализация" },
    { key: "protections-scan", selector: "#protections-scan-btn", title: "Обновить статус защит", keys: "protections защиты статус" },
    { key: "hv-check", selector: "#hv-eclipse-check-btn", title: "Проверить версию Eclipse-HV", keys: "eclipse-hv гипервизор версия обновление" },
    { key: "saves-scan", selector: "#scan-saves-button", title: "Найти сохранения", keys: "saves сохранения сейвы сканировать" },
    { key: "saves-archive", selector: "#create-save-archive", title: "Создать резервную копию сохранений", keys: "backup archive бэкап архив резервная копия" },
    { key: "dlc-scan", selector: "#dlc-library-scan", title: "Сканировать библиотеку Steam", keys: "steam library dlc библиотека игры" },
    { key: "files-refresh", selector: "#files-refresh", title: "Обновить список кряков", keys: "cracks кряки каталог обновить" },
    { key: "download-dir", selector: "#download-dir-open", title: "Открыть папку загрузки", keys: "download folder загрузки папка проводник", stay: true },
    { key: "steam-restart", selector: "#lua-restart-button", title: "Перезапустить Steam", keys: "steam restart стим перезапуск",
      confirm: { title: "Перезапустить Steam?", text: "Steam будет закрыт и запущен снова. Запущенные игры Steam тоже закроются.", ok: "Перезапустить" } },
    { key: "splash", selector: "#replay-splash-button", title: "Посмотреть заставку", keys: "splash intro заставка", stay: true },
    { key: "update", selector: "#check-update-button", title: "Проверить обновления", keys: "update version обновление версия" },
    { key: "home-customize", selector: "#home-customize", title: "Настроить главную", keys: "home главная блоки" },
  ];
  // Синонимы: слово из группы находит пункты с любым другим словом группы
  const SYNONYMS = [
    ["темная", "черная", "oled", "amoled", "black", "dark"],
    ["светлая", "белая", "light", "white"],
    ["hvci", "vbs", "виртуализац", "целостност", "изоляция ядра", "core isolation"],
    ["шрифт", "типографик", "font", "текст"],
    ["язык", "language", "english", "английск", "русск"],
    ["бэкап", "бекап", "backup", "резервн", "архив"],
    ["кряк", "crack", "таблетк"],
    ["длс", "dlc", "дополнени"],
    ["манифест", "manifest", "lua", "луа"],
    ["гипервизор", "hypervisor", "eclipse-hv"],
    ["игра", "игры", "game", "games"],
    ["античит", "anticheat", "anti-cheat", "eac", "battleye"],
    ["звук", "audio", "sound", "громкост"],
    ["заставк", "splash", "интро"],
    ["обновлен", "update", "апдейт"],
    ["телеграм", "telegram", "тг", "tg"],
    ["меню", "боковая панель", "sidebar", "рейка"],
    ["цвет", "акцент", "accent", "color"],
    ["тема", "theme", "оформлени"],
    ["масштаб", "размер", "zoom", "scale"],
    ["сочетани", "горячие клавиши", "хоткей", "hotkey", "бинд", "shortcut"],
    ["папк", "folder", "директор", "путь"],
    ["сохранени", "saves", "сейв"],
    ["стим", "steam"],
    ["онлайн", "online fix", "onlinefix", "мультиплеер", "кооп"],
    ["облак", "cloud"],
  ];
  const EN_LAYOUT = "qwertyuiop[]asdfghjkl;'zxcvbnm,.`";
  const RU_LAYOUT = "йцукенгшщзхъфывапролджэячсмитьбюё";
  const SEARCH_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>';
  const ICONS = {
    game: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="7" width="19" height="11" rx="5.5"/><path d="M7 11v3M5.5 12.5h3"/><path d="M15.5 12h.01M18 13.5h.01"/></svg>',
    action: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 3 5 13.5h6L10 21l8-10.5h-6L13 3Z"/></svg>',
    recent: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  };

  const root = document.documentElement;
  const $ = (selector, scope = document) => scope.querySelector(selector);
  const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];
  const read = (key, fallback) => {
    try { return window.cgsStorage.getItem(key) ?? fallback; } catch (_) { return fallback; }
  };
  const write = (key, value) => {
    try { window.cgsStorage.setItem(key, value); } catch (_) {}
  };
  const readJson = (key, fallback) => {
    try {
      const value = JSON.parse(read(key, "") || "null");
      return value && typeof value === "object" ? value : fallback;
    } catch (_) { return fallback; }
  };
  // Статичные подписи переводит словарь i18n, подписи с подстановкой — сразу здесь
  const isEnglish = () => window.cgsI18n?.language === "en";
  const t = (text) => (window.cgsI18n?.t ? window.cgsI18n.t(text) : text);
  const tr = (ru, en) => (isEnglish() ? en : ru);
  const toast = (message, type) => { if (typeof window.cgsToast === "function") window.cgsToast(message, type); };
  const smooth = () => !root.classList.contains("no-motion");

  // Сочетание клавиш
  const isFunctionKey = (code) => /^F([1-9]|1[0-2])$/.test(code);
  const isModifierCode = (code) => /^(Control|Shift|Alt|Meta|OS)(Left|Right)?$/.test(code);

  function parseHotkey(value) {
    const parts = String(value || "").split("+").filter(Boolean);
    const code = parts.pop();
    if (!code || isModifierCode(code) || parts.some((part) => !MODIFIERS.includes(part))) return null;
    return { code, mods: new Set(parts) };
  }

  function hotkeyFromEvent(event) {
    if (!event.code || isModifierCode(event.code)) return null;
    const mods = [];
    if (event.ctrlKey) mods.push("Ctrl");
    if (event.altKey) mods.push("Alt");
    if (event.shiftKey) mods.push("Shift");
    if (event.metaKey) mods.push("Meta");
    return [...mods, event.code].join("+");
  }

  // Причина, по которой сочетание нельзя назначить (пустая строка — можно)
  function hotkeyProblem(value) {
    const parsed = parseHotkey(value);
    if (!parsed) return "Нужна клавиша Ctrl, Alt или F1–F12";
    if (!isFunctionKey(parsed.code) && !parsed.mods.has("Ctrl") && !parsed.mods.has("Alt") && !parsed.mods.has("Meta")) return "Нужна клавиша Ctrl, Alt или F1–F12";
    if (RESERVED.has(value) || parsed.code === "Escape") return "Это сочетание занято системой";
    return "";
  }

  function currentHotkey() {
    const stored = read(HOTKEY_KEY, DEFAULT_HOTKEY);
    return hotkeyProblem(stored) ? DEFAULT_HOTKEY : stored;
  }

  function keyLabel(code) {
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit\d$/.test(code)) return code.slice(5);
    if (/^Numpad\d$/.test(code)) return "Num " + code.slice(6);
    if (isFunctionKey(code)) return code;
    const names = {
      Space: "Пробел", Slash: "/", Backslash: "\\", IntlBackslash: "\\", Period: ".", Comma: ",", Semicolon: ";",
      Quote: "'", Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]",
      ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", NumpadAdd: "Num +", NumpadSubtract: "Num −",
      NumpadMultiply: "Num *", NumpadDivide: "Num /", NumpadDecimal: "Num .", NumpadEnter: "Num Enter",
    };
    return names[code] || code;
  }

  function hotkeyParts(value) {
    const parsed = parseHotkey(value);
    if (!parsed) return [];
    return [...MODIFIERS.filter((mod) => parsed.mods.has(mod)).map((mod) => (mod === "Meta" ? "Win" : mod)), keyLabel(parsed.code)];
  }

  function renderKeys(container, parts) {
    if (!container) return;
    container.replaceChildren(...parts.map((text) => {
      const key = document.createElement("kbd");
      key.textContent = text;
      return key;
    }));
  }

  function ariaShortcut(value) {
    return hotkeyParts(value).map((part) => ({ Ctrl: "Control", Win: "Meta" }[part] || part)).join("+");
  }

  const isEnabled = () => read(ENABLED_KEY, "1") !== "0";

  // Пользовательские сочетания для пунктов поиска
  function readBinds() {
    const value = readJson(BINDS_KEY, {});
    const out = {};
    for (const [id, entry] of Object.entries(value)) {
      if (entry && typeof entry.keys === "string" && !hotkeyProblem(entry.keys)) out[id] = { keys: entry.keys, title: String(entry.title || "") };
    }
    return out;
  }
  const saveBinds = (binds) => write(BINDS_KEY, JSON.stringify(binds));
  const bindOwner = (binds, keys) => Object.keys(binds).find((id) => binds[id].keys === keys);

  function applySettings() {
    const enabled = isEnabled();
    const hotkey = currentHotkey();
    root.dataset.search = enabled ? "on" : "off";
    const trigger = $("#titlebar-search");
    if (trigger) {
      trigger.hidden = !enabled;
      trigger.setAttribute("aria-keyshortcuts", ariaShortcut(hotkey));
    }
    renderKeys($("#titlebar-search-keys"), hotkeyParts(hotkey));
    const toggle = $("#search-enabled");
    if (toggle) toggle.checked = enabled;
    const row = $("#pref-row-search-hotkey");
    row?.classList.toggle("disabled", !enabled);
    const button = $("#search-hotkey-button");
    if (button) {
      button.disabled = !enabled;
      if (!recording) renderKeys(button, hotkeyParts(hotkey));
    }
    const reset = $("#search-hotkey-reset");
    if (reset) reset.disabled = !enabled || hotkey === DEFAULT_HOTKEY;
    renderBindsList();
    if (!enabled && isOpen()) close();
  }

  // Список назначенных сочетаний в настройках
  function renderBindsList() {
    const list = $("#search-binds-list");
    if (!list) return;
    const binds = readBinds();
    const ids = Object.keys(binds);
    $("#pref-row-search-binds")?.classList.toggle("disabled", !isEnabled());
    const clear = $("#search-binds-clear");
    if (clear) clear.disabled = !ids.length || !isEnabled();
    if (!ids.length) {
      const empty = document.createElement("li");
      empty.className = "search-binds-empty";
      empty.textContent = "Пока нет. В поиске выберите пункт и нажмите Alt + Enter";
      list.replaceChildren(empty);
      return;
    }
    const known = new Map(buildIndex({ content: true }).map((item) => [item.id, item]));
    list.replaceChildren(...ids.map((id) => {
      const item = known.get(id);
      const li = document.createElement("li");
      li.className = "search-bind";
      li.dataset.bindId = id;
      const text = document.createElement("span");
      text.className = "search-bind-text";
      const name = Object.assign(document.createElement("strong"), { textContent: item?.title || binds[id].title || id });
      text.append(name);
      const where = item ? (item.path.length ? item.path.join(" › ") : t(KIND[item.kind].badge)) : "Пункт сейчас недоступен";
      text.append(Object.assign(document.createElement("small"), { textContent: where }));
      const keys = document.createElement("span");
      keys.className = "search-bind-keys";
      renderKeys(keys, hotkeyParts(binds[id].keys));
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "search-bind-remove";
      remove.dataset.bindRemove = id;
      remove.title = "Убрать сочетание";
      remove.setAttribute("aria-label", "Убрать сочетание");
      remove.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8"/></svg>';
      li.append(text, keys, remove);
      return li;
    }));
  }

  // Запись нового сочетания для поиска
  let recording = false;
  let hintTimer = 0;

  function showHotkeyHint(text) {
    const hint = $("#search-hotkey-hint");
    if (!hint) return;
    hint.textContent = text;
    hint.classList.toggle("hidden", !text);
    clearTimeout(hintTimer);
    if (text) hintTimer = setTimeout(() => hint.classList.add("hidden"), 2600);
  }

  function startRecording() {
    const button = $("#search-hotkey-button");
    if (!button || !isEnabled()) return;
    recording = true;
    button.classList.add("recording");
    button.setAttribute("aria-pressed", "true");
    button.replaceChildren(Object.assign(document.createElement("span"), { textContent: "Нажмите сочетание…" }));
    button.focus({ preventScroll: true });
  }

  function stopRecording() {
    if (!recording) return;
    recording = false;
    const button = $("#search-hotkey-button");
    button?.classList.remove("recording");
    button?.setAttribute("aria-pressed", "false");
    applySettings();
  }

  const heldModifiers = (event) => [event.ctrlKey && "Ctrl", event.altKey && "Alt", event.shiftKey && "Shift", event.metaKey && "Win"].filter(Boolean);

  function recordKey(event) {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape" && !event.ctrlKey && !event.altKey && !event.metaKey) {
      stopRecording();
      return;
    }
    const value = hotkeyFromEvent(event);
    const button = $("#search-hotkey-button");
    if (!value) {
      // Пока зажаты только модификаторы — показываем их
      const mods = heldModifiers(event);
      if (button && mods.length) renderKeys(button, [...mods, "…"]);
      return;
    }
    const problem = hotkeyProblem(value);
    if (problem) {
      showHotkeyHint(problem);
      return;
    }
    // Сочетание поиска важнее: снимаем его с пункта, которому оно было назначено
    const binds = readBinds();
    const owner = bindOwner(binds, value);
    if (owner) {
      delete binds[owner];
      saveBinds(binds);
    }
    write(HOTKEY_KEY, value);
    showHotkeyHint("");
    stopRecording();
  }

  // Частота и время последнего выбора пункта
  function readUsage() {
    const value = readJson(RECENT_KEY, {});
    return Array.isArray(value) ? {} : value;
  }
  function remember(id) {
    if (!id || id.startsWith("find:")) return;
    const usage = readUsage();
    const entry = usage[id] || { n: 0, t: 0 };
    usage[id] = { n: Math.min(999, (Number(entry.n) || 0) + 1), t: Date.now() };
    const kept = Object.entries(usage).sort((a, b) => b[1].t - a[1].t).slice(0, 40);
    write(RECENT_KEY, JSON.stringify(Object.fromEntries(kept)));
  }

  // Индекс
  const INLINE = new Set(["SPAN", "B", "I", "EM", "A", "MARK", "U", "S", "SUB", "SUP", "CODE", "KBD"]);

  function readText(node) {
    if (!node) return "";
    let out = "";
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) out += child.nodeValue;
      else if (child.nodeType === Node.ELEMENT_NODE) {
        if (["SVG", "svg", "SCRIPT", "STYLE", "TEMPLATE", "INPUT", "SELECT", "TEXTAREA"].includes(child.tagName)) continue;
        if (child.tagName === "BR") out += " ";
        else out += INLINE.has(child.tagName) ? readText(child) : ` ${readText(child)} `;
      }
    }
    return out.replace(/\s+/g, " ").trim();
  }

  // Нижний регистр и ё → е с сохранением длины строки (для подсветки совпадений)
  function fold(text) {
    let out = "";
    for (const char of String(text || "")) {
      const lower = char.toLowerCase();
      const next = lower.length === char.length ? lower : char;
      out += next === "ё" ? "е" : next;
    }
    return out;
  }
  const splitWords = (text) => text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);

  const viewTitle = (view) => readText($(`.navigation .nav-item[data-view="${view}"] span`)) || view;
  const navIcon = (view) => $(`.navigation .nav-item[data-view="${view}"] svg`);
  const svgFrom = (markup) => {
    const holder = document.createElement("span");
    holder.innerHTML = markup;
    return holder.firstElementChild;
  };

  function heroText(scope) {
    if (!scope) return "";
    const heading = $("h2", scope);
    const paragraph = heading?.parentElement ? $(":scope > p", heading.parentElement) : null;
    return readText(paragraph);
  }

  // Где находится элемент: раздел, вкладка гипервизора и вкладка настроек
  function placeOf(node) {
    return {
      view: node?.closest("[data-view-panel]")?.dataset.viewPanel,
      hvTab: node?.closest("[data-hv-tab-panel]")?.dataset.hvTabPanel,
      settingsTab: node?.closest("[data-tab-panel]")?.dataset.tabPanel,
    };
  }
  function placePath(go) {
    if (!go?.view) return [];
    const tab = go.hvTab ? $(`[data-hv-tab="${go.hvTab}"]`) : go.settingsTab ? $(`.settings-tab-btn[data-settings-tab="${go.settingsTab}"]`) : null;
    return [viewTitle(go.view), readText(tab)];
  }

  // Управляющий элемент строки настроек: переключатель, список, ползунок или кнопки-варианты
  function controlOf(row) {
    const boxes = $$('input[type="checkbox"]', row);
    if (boxes.length === 1) return { type: "toggle", input: boxes[0] };
    const select = $("select", row);
    if (select) return { type: "select", input: select };
    const range = $('input[type="range"]', row);
    if (range) return { type: "range", input: range, row };
    if ($$("button.active, button[aria-pressed='true']", row).length === 1) return { type: "choice", row };
    return null;
  }

  // Текущее значение настройки для показа в результатах
  function valueOf(item) {
    const control = item.control;
    if (item.kind === "option") {
      const option = item.target;
      const on = option?.classList.contains("active") || option?.getAttribute("aria-pressed") === "true";
      return on ? t("Выбрано") : "";
    }
    if (!control) return "";
    if (control.type === "toggle") return control.input.checked ? t("Вкл") : t("Выкл");
    if (control.type === "select") return readText(control.input.selectedOptions?.[0]) || "";
    if (control.type === "range") {
      const label = $$("output, [id$='-value'], [class*='value']", control.row).map(readText).find(Boolean);
      return label || String(control.input.value);
    }
    if (control.type === "choice") return readText($("button.active, button[aria-pressed='true']", control.row));
    return "";
  }
  const isToggle = (item) => item?.kind === "setting" && item.control?.type === "toggle";

  function buildIndex({ content = true } = {}) {
    const items = [];
    const usage = readUsage();
    const add = (item) => {
      if (!item.title || !item.id) return;
      item.path = (item.path || []).filter(Boolean);
      item.hint = item.hint || "";
      item.titleKey = fold(item.title);
      item.titleWords = splitWords(item.titleKey);
      item.hay = fold([item.title, item.hint, item.path.join(" "), item.keys || ""].join(" "));
      item.allWords = [...new Set(splitWords(item.hay))];
      item.words = item.allWords.filter((word) => word.length >= 3);
      const used = usage[item.id];
      item.used = used ? Number(used.t) || 0 : 0;
      item.boost = used ? Math.min(6, Number(used.n) || 0) * 3 : 0;
      items.push(item);
    };
    const settingsTitle = viewTitle("settings");

    // Разделы
    $$(".navigation .nav-item[data-view]").forEach((nav) => {
      const view = nav.dataset.view;
      const panel = $(`[data-view-panel="${view}"]`);
      add({ kind: "view", id: `view:${view}`, title: viewTitle(view), hint: heroText(panel), icon: $("svg", nav), go: { view } });
    });

    // Вкладки гипервизора и настроек
    $$("[data-hv-tab]").forEach((button) => {
      const tab = button.dataset.hvTab;
      add({ kind: "tab", id: `tab:hv:${tab}`, title: readText(button), hint: heroText($(`[data-hv-tab-panel="${tab}"]`)), path: [viewTitle("hypervisor")], icon: $("svg", button), go: { view: "hypervisor", hvTab: tab } });
    });
    $$(".settings-tab-btn[data-settings-tab]").forEach((button) => {
      const tab = button.dataset.settingsTab;
      const panel = $(`.settings-tab-panel[data-tab-panel="${tab}"]`);
      add({ kind: "tab", id: `tab:st:${tab}`, title: readText(button), hint: readText(panel && $(".settings-card > p", panel)), path: [settingsTitle], icon: $("svg", button), go: { view: "settings", settingsTab: tab } });
    });

    // Группы настроек, их параметры и варианты выбора
    $$("#view-settings details.settings-collapsible").forEach((details, sectionIndex) => {
      const tab = details.closest("[data-tab-panel]")?.dataset.tabPanel;
      const tabTitle = readText($(`.settings-tab-btn[data-settings-tab="${tab}"]`));
      const title = readText($("summary strong", details));
      const icon = $(".settings-collapsible-icon svg", details);
      const content = $(".settings-collapsible-content", details);
      const go = { view: "settings", settingsTab: tab };
      const sectionId = details.id || `${tab}:${sectionIndex}`;
      const rows = content ? $$(ROW_SELECTOR, content).filter((row) => $("strong", row)) : [];
      let keys = "";
      if (content) {
        const copy = content.cloneNode(true);
        copy.querySelectorAll(`${ROW_SELECTOR}, ${OPTION_SELECTOR}`).forEach((node) => node.remove());
        keys = readText(copy).slice(0, 400);
      }
      add({ kind: "section", id: `sec:${sectionId}`, title, hint: readText($("summary small", details)), keys, path: [settingsTitle, tabTitle], icon, go, target: details, focus: $("summary", details) });
      rows.forEach((row, rowIndex) => {
        const strong = $("strong", row);
        const hint = [...row.querySelectorAll("small, p")].find((node) => !strong.contains(node));
        const control = controlOf(row);
        const named = row.id || control?.input?.id || $("input[id], select[id]", row)?.id;
        add({ kind: "setting", id: named ? `set:${named}` : `set:${sectionId}:${rowIndex}`, title: readText(strong), hint: readText(hint), path: [settingsTitle, tabTitle, title], icon, go, target: row, control });
      });
      $$(OPTION_SELECTOR, details).forEach((option) => {
        // Варианты положения («Слева», «Справа»…) называются вместе со строкой, к которой относятся
        const dockRow = option.closest(".dock-row");
        const ownLabel = readText(option) || option.getAttribute("aria-label") || option.title || "";
        const label = dockRow ? `${readText($("strong", dockRow))}: ${ownLabel}` : ownLabel;
        const value = option.dataset.themeOption ? `theme:${option.dataset.themeOption}`
          : option.dataset.accent ? `accent:${option.dataset.accent}`
          : option.dataset.sidebarDock ? `dock:${option.dataset.sidebarDock}`
          : option.dataset.searchDock ? `search-dock:${option.dataset.searchDock}`
          : `mode:${option.dataset.sidebarMode}`;
        add({ kind: "option", id: `opt:${value}`, title: label, hint: title, path: [settingsTitle, tabTitle, title], keys: title, icon, go, target: option });
      });
    });

    // Блоки страниц: заголовки панелей и карточки утилит
    const seen = new Set(items.filter((item) => item.kind !== "block").map((item) => item.titleKey));
    $$('[data-view-panel]:not([data-view-panel="settings"]) h3, #view-utilities .utility-card strong').forEach((heading) => {
      if (heading.id || heading.closest('[class*="empty"], .hidden')) return;
      const title = readText(heading);
      const key = fold(title);
      if (!title || seen.has(key)) return;
      seen.add(key);
      const view = heading.closest("[data-view-panel]").dataset.viewPanel;
      const hvTab = heading.closest("[data-hv-tab-panel]")?.dataset.hvTabPanel;
      const block = heading.closest(".utility-card, section, article, .premium-panel") || heading;
      const hint = $$("p, small, span", block).map(readText).find((text) => text && text !== title && text.length > 12) || "";
      const tabTitle = hvTab ? readText($(`[data-hv-tab="${hvTab}"]`)) : "";
      add({ kind: "block", id: `blk:${view}:${hvTab || ""}:${key}`, title, hint, path: [viewTitle(view), tabTitle], icon: navIcon(view), go: { view, hvTab }, target: block });
    });

    // Локальное облако: у заголовка есть id для aria-labelledby, поэтому общий обход его пропускает
    const cloud = $("#local-cloud-panel");
    const cloudTitle = cloud && !cloud.closest(".hidden") ? readText($("#lc-title", cloud)) : "";
    if (cloudTitle && !seen.has(fold(cloudTitle))) {
      seen.add(fold(cloudTitle));
      const view = cloud.closest("[data-view-panel]")?.dataset.viewPanel || "lua";
      add({
        kind: "block", id: `blk:${view}::local-cloud`, title: cloudTitle, hint: readText($("#lc-summary", cloud)),
        keys: "локальное облако облачные синхронизация cloudredirect cloud redirect steam cloud local sync",
        path: [viewTitle(view)], icon: $(".local-cloud-icon", cloud) || navIcon(view), go: { view }, target: cloud,
      });
    }

    // Действия — только доступные сейчас кнопки
    for (const def of ACTIONS) {
      const button = $(def.selector);
      if (!button || button.disabled || button.closest(".hidden")) continue;
      const go = def.stay ? null : placeOf(button);
      const title = def.key === "telegram" ? button.getAttribute("aria-label") || t(def.title) : t(def.title);
      add({ kind: "action", id: `act:${def.key}`, title, hint: button.title || "", path: placePath(go), keys: `${def.keys} ${def.title}`, icon: $("svg", button) || svgFrom(ICONS.action), run: () => runAction(def), danger: Boolean(def.confirm || def.danger) });
    }

    if (content) buildContent(add);
    return items;
  }

  // Списки игр пользователя: живые данные разделов, затем тихая загрузка, затем сохранённый список
  const quietLibrary = { manifest: null, steam: null };
  function readLibraryCache() {
    try {
      const value = JSON.parse(read(LIBRARY_KEY, "{}") || "{}");
      return value && typeof value === "object" ? value : {};
    } catch (_) { return {}; }
  }
  function userGames(kind) {
    const live = window.cgsLibrary?.[kind]?.();
    const games = Array.isArray(live) ? live : quietLibrary[kind] || readLibraryCache()[kind];
    if (Array.isArray(live) || quietLibrary[kind]) saveLibraryCache(kind, games);
    return Array.isArray(games) ? games : [];
  }
  function saveLibraryCache(kind, games) {
    const cache = readLibraryCache();
    const slim = kind === "manifest"
      ? games.map((game) => ({ appid: String(game.appid), name: game.name || "" }))
      : games.map((game) => ({ appid: game.appid, name: game.name, gameDir: game.gameDir, libraryPath: game.libraryPath || "", headerImage: game.headerImage || "" }));
    if (JSON.stringify(cache[kind] || []) === JSON.stringify(slim)) return;
    cache[kind] = slim;
    try { window.cgsStorage?.setItem(LIBRARY_KEY, JSON.stringify(cache)); } catch (_) {}
  }

  // Содержимое разделов: недавние игры, игры Гипервизора и Manifest, копии, библиотека Steam, каталог кряков
  function buildContent(add) {
    const list = (key) => {
      try {
        const value = JSON.parse(read(key, "[]") || "[]");
        return Array.isArray(value) ? value : [];
      } catch (_) { return []; }
    };
    const baseName = (path) => String(path || "").split(/[\\/]/).filter(Boolean).pop() || String(path || "");
    const home = viewTitle("home");

    list("recentGames").filter((game) => game?.path).forEach((game) => {
      add({ kind: "game", id: `game:${game.path}`, title: game.name || baseName(game.path), hint: game.path, path: [home, t("Недавние игры")], keys: `${game.path} игра game`, icon: svgFrom(ICONS.game), run: () => window.cgsOpenGame?.(game.path) });
    });
    list("recentBackups").filter((backup) => backup?.path).forEach((backup) => {
      add({ kind: "backup", id: `bak:${backup.path}`, title: baseName(backup.path), hint: backup.path, path: [viewTitle("saves"), t("Резервные копии")], keys: `${backup.path} backup архив`, icon: navIcon("saves"), run: () => revealBackup(backup.path) });
    });
    (window.cgsHypervisor?.games?.() || []).forEach((game) => {
      if (!game?.id || !game.name) return;
      const hint = game.selected ? `${t("Активна")} · ${game.exePath || ""}` : game.exePath || "";
      add({ kind: "hv", id: `hv:${game.id}`, title: game.name, hint, path: [viewTitle("hypervisor"), t("Добавленные игры")], keys: `${game.exePath || ""} ${baseName(game.exePath)} игра game гипервизор hypervisor`, icon: navIcon("hypervisor"), run: () => openHvGame(game) });
    });
    userGames("manifest").forEach((game) => {
      if (!game?.appid) return;
      add({ kind: "manifest", id: `lua:${game.appid}`, title: game.name || `AppID ${game.appid}`, hint: `AppID ${game.appid}`, path: [viewTitle("lua")], keys: `appid ${game.appid} игра game manifest lua`, icon: navIcon("lua"), run: () => window.cgsLibrary?.openManifest?.(game.appid) });
    });
    userGames("steam").forEach((game) => {
      if (!game?.name) return;
      add({ kind: "steam", id: `steam:${game.appid || game.name}`, title: game.name, hint: game.gameDir || "", path: [viewTitle("dlc"), t("Библиотека Steam")], keys: `appid ${game.appid || ""} игра game steam`, icon: navIcon("dlc"), run: () => openSteamGame(game) });
    });
    const files = window.cgsFiles?.list?.() || [];
    files.forEach((file) => {
      if (!file?.name || !file.url) return;
      add({ kind: "crack", id: `crack:${file.url}`, title: file.name, hint: file.build || "", path: [viewTitle("files"), file.group || ""], keys: `${file.build || ""} crack кряк`, icon: navIcon("files"), run: () => openCrack(file) });
    });
  }

  // Пункты «Искать «запрос» в …» — передают запрос в поиск нужного раздела
  function findItems(query) {
    const quoted = `«${query}»`;
    const out = [];
    const make = (key, view, field, ru, en) => {
      if (!$(field)) return;
      out.push({ kind: "find", id: `find:${key}`, title: tr(`Искать ${quoted} ${ru}`, `Search “${query}” ${en}`), hint: "", path: [viewTitle(view)], icon: navIcon(view), run: () => findIn(view, field, query) });
    };
    make("files", "files", "#files-search", "в каталоге кряков", "in the cracks catalog");
    make("dlc", "dlc", "#dlc-library-search", "среди игр Steam", "among Steam games");
    make("lua", "lua", "#lua-search-input", "в Eclipse Manifest", "in Eclipse Manifest");
    return out;
  }

  // Поиск
  function swapLayout(text) {
    let out = "";
    for (const char of text) {
      const en = EN_LAYOUT.indexOf(char);
      const ru = RU_LAYOUT.indexOf(char);
      out += en >= 0 ? RU_LAYOUT[en] : ru >= 0 ? EN_LAYOUT[ru] : char;
    }
    return out;
  }

  // Префикс в начале запроса ограничивает поиск одной областью
  function parseQuery(raw) {
    const text = String(raw || "").replace(/^\s+/, "");
    const scope = PREFIXES[text[0]] || "";
    return { scope, prefix: scope ? text[0] : "", text: (scope ? text.slice(1) : text).replace(/\s+/g, " ").trim() };
  }

  // Слова запроса вместе с синонимами
  function termsOf(phrase) {
    return phrase.split(" ").filter(Boolean).map((token) => {
      const alts = new Set();
      for (const group of SYNONYMS) {
        const hit = group.some((term) => term === token || (token.length >= 3 && (term.startsWith(token) || (term.length >= 3 && token.startsWith(term)))));
        if (hit) group.forEach((term) => { if (term !== token) alts.add(term); });
      }
      return { token, alts: [...alts] };
    });
  }

  // Расстояние Дамерау — Левенштейна не больше max (для опечаток)
  function near(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return false;
    let prev2 = null;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i += 1) {
      const row = [i];
      let best = i;
      for (let j = 1; j <= b.length; j += 1) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        let value = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
        if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) value = Math.min(value, prev2[j - 2] + 1);
        row.push(value);
        if (value < best) best = value;
      }
      if (best > max) return false;
      prev2 = prev;
      prev = row;
    }
    return prev[b.length] <= max;
  }

  function fuzzyHit(item, token) {
    const max = token.length >= 7 ? 2 : token.length >= 4 ? 1 : 0;
    if (!max) return 0;
    const match = (word) => {
      for (let length = token.length - max; length <= token.length + max; length += 1) {
        if (length >= 3 && length <= word.length && near(token, word.slice(0, length), max)) return true;
      }
      return false;
    };
    if (item.titleWords.some(match)) return 2;
    return item.words.some(match) ? 1 : 0;
  }

  function scoreItem(item, terms, phrase, fuzzy) {
    const title = item.titleKey;
    const hint = fold(item.hint);
    let score = KIND[item.kind].weight + item.boost;
    for (const { token, alts } of terms) {
      if (item.hay.includes(token)) {
        if (item.titleWords.some((word) => word.startsWith(token))) score += 20;
        else if (title.includes(token)) score += 10;
        else if (hint.includes(token)) score += 3;
        continue;
      }
      const alt = alts.find((term) => (term.includes(" ") ? item.hay.includes(term) : item.allWords.some((word) => word.startsWith(term))));
      if (alt) {
        score += title.includes(alt) ? 9 : 4;
        continue;
      }
      const hit = fuzzy ? fuzzyHit(item, token) : 0;
      if (!hit) return 0;
      score += hit === 2 ? 8 : 3;
    }
    if (title === phrase) score += 140;
    else if (title.startsWith(phrase)) score += 90;
    else if (title.includes(phrase)) score += 50;
    return score;
  }

  function runSearch(items, phrase, fuzzy = false) {
    if (!phrase) return [];
    const terms = termsOf(phrase);
    return items
      .map((item) => ({ item, score: scoreItem(item, terms, phrase, fuzzy) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || b.item.used - a.item.used);
  }

  // Точный поиск → другая раскладка → неточный (опечатки)
  function searchAll(items, text) {
    const phrase = fold(text);
    let results = runSearch(items, phrase);
    if (results.length) return { results, phrase, mode: "" };
    const swapped = swapLayout(phrase);
    if (swapped !== phrase) {
      results = runSearch(items, swapped);
      if (results.length) return { results, phrase: swapped, mode: "layout" };
    }
    results = runSearch(items, phrase, true);
    if (results.length) return { results, phrase, mode: "fuzzy" };
    if (swapped !== phrase) {
      results = runSearch(items, swapped, true);
      if (results.length) return { results, phrase: swapped, mode: "fuzzy-layout" };
    }
    return { results: [], phrase, mode: "" };
  }

  // Палитра
  let overlay = null;
  let input = null;
  let list = null;
  let note = null;
  let scopeChip = null;
  let footer = null;
  let index = [];
  let shown = [];
  let tokensShown = [];
  let active = 0;
  let lastFocus = null;
  let lastQuery = "";
  // Область, выбранная префиксом: сам символ убирается из поля и показывается чипом
  let scopeLock = "";
  let navMode = false; // Список листают стрелками — пробел переключает настройку
  let bindItem = null; // Пункт, для которого записывается сочетание
  let stickyNote = null; // Сообщение о сочетании, пока не изменится запрос
  let catalogTried = false;
  let paletteAnimations = [];
  let paletteRevision = 0;

  const isOpen = () => Boolean(overlay && !overlay.hidden && !overlay.classList.contains("closing"));

  function paletteFrame() {
    if (!overlay || overlay.hidden) return null;
    return [...overlay.querySelectorAll(".k-search-backdrop, .k-search-panel")].map(element => {
      const style = getComputedStyle(element);
      return { element, opacity: style.opacity, translate: style.translate };
    });
  }

  // Повторное открытие продолжает движение с текущего кадра
  function animatePalette(opening, previous) {
    const revision = ++paletteRevision;
    paletteAnimations.forEach(animation => animation.cancel());
    paletteAnimations = [];
    const finish = () => {
      if (revision !== paletteRevision) return;
      paletteAnimations = [];
      if (!opening) {
        overlay.hidden = true;
        overlay.classList.remove("closing");
      }
    };
    if (!smooth() || !window.cgsMotion?.transition) {
      finish();
      return;
    }
    for (const element of overlay.querySelectorAll(".k-search-backdrop, .k-search-panel")) {
      const panel = element.classList.contains("k-search-panel");
      const from = previous?.find(frame => frame.element === element);
      const start = from
        ? { opacity: from.opacity, translate: from.translate }
        : { opacity: opening ? 0 : 1, translate: panel && opening ? "0 -8px" : "0 0" };
      const end = { opacity: opening ? 1 : 0, translate: panel && !opening ? "0 -6px" : "0 0" };
      const animation = window.cgsMotion.transition(element, [start, end], {
        duration: opening ? 220 : 180,
        easing: opening ? "cubic-bezier(0.22, 1, 0.36, 1)" : "cubic-bezier(0.4, 0, 1, 1)",
      }, opening ? "enter" : "exit", panel ? finish : undefined);
      if (animation) paletteAnimations.push(animation);
    }
    if (!paletteAnimations.length) finish();
  }

  function ensureOverlay() {
    if (overlay) return;
    overlay = document.createElement("div");
    overlay.className = "k-search";
    overlay.id = "cgs-search";
    overlay.hidden = true;
    overlay.innerHTML = `
      <div class="k-search-backdrop" data-search-close></div>
      <div class="k-search-panel" role="dialog" aria-modal="true" aria-label="Быстрый поиск">
        <div class="k-search-field">
          ${SEARCH_ICON}
          <span class="k-search-scope hidden" id="cgs-search-scope"></span>
          <input id="cgs-search-input" type="text" role="combobox" aria-expanded="true" aria-controls="cgs-search-list" aria-autocomplete="list" autocomplete="off" spellcheck="false" placeholder="Поиск игр, разделов и настроек" />
          <button type="button" class="k-search-esc" data-search-close aria-label="Закрыть поиск"><kbd>Esc</kbd></button>
        </div>
        <div class="k-search-note hidden" id="cgs-search-note"></div>
        <div class="k-search-list" id="cgs-search-list" role="listbox" aria-label="Результаты поиска"></div>
        <div class="k-search-footer" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd><em>выбор</em></span>
          <span data-hint="primary"><kbd>Enter</kbd><em>открыть</em></span>
          <span data-hint="secondary" hidden><kbd>Shift</kbd><kbd>Enter</kbd><em>к настройке</em></span>
          <span data-hint="bind"><kbd>Alt</kbd><kbd>Enter</kbd><em>сочетание</em></span>
          <span><kbd>Esc</kbd><em>закрыть</em></span>
        </div>
      </div>`;
    document.body.append(overlay);
    input = $("#cgs-search-input", overlay);
    list = $("#cgs-search-list", overlay);
    note = $("#cgs-search-note", overlay);
    scopeChip = $("#cgs-search-scope", overlay);
    footer = $(".k-search-footer", overlay);
    input.addEventListener("input", () => {
      navMode = false;
      stickyNote = null;
      takePrefix();
      render(currentQuery());
    });
    scopeChip.addEventListener("click", () => {
      setScope("");
      input.focus({ preventScroll: true });
    });
    overlay.addEventListener("click", (event) => {
      if (event.target.closest("[data-search-close]")) {
        close();
        return;
      }
      const tip = event.target.closest("[data-search-prefix]");
      if (tip) {
        input.value = "";
        input.focus({ preventScroll: true });
        stickyNote = null;
        setScope(PREFIXES[tip.dataset.searchPrefix] || "");
        return;
      }
      const option = event.target.closest(".k-search-item");
      if (!option) return;
      const position = Number(option.dataset.index);
      if (event.target.closest(".k-search-switch")) setActive(position, false);
      choose(position, event.shiftKey ? "secondary" : "primary");
    });
    list.addEventListener("mousemove", (event) => {
      const option = event.target.closest(".k-search-item");
      if (option && Number(option.dataset.index) !== active) setActive(Number(option.dataset.index), false);
    });
  }

  function highlight(target, text, tokens) {
    const folded = fold(text);
    const marks = new Array(text.length).fill(false);
    for (const token of tokens) {
      let from = folded.indexOf(token);
      while (token && from >= 0) {
        for (let i = from; i < from + token.length; i += 1) marks[i] = true;
        from = folded.indexOf(token, from + token.length);
      }
    }
    const nodes = [];
    let start = 0;
    for (let i = 1; i <= text.length; i += 1) {
      if (i === text.length || marks[i] !== marks[start]) {
        const piece = text.slice(start, i);
        if (marks[start]) nodes.push(Object.assign(document.createElement("mark"), { textContent: piece }));
        else nodes.push(document.createTextNode(piece));
        start = i;
      }
    }
    target.replaceChildren(...nodes);
  }

  function makeOption(item, position, tokens) {
    const option = document.createElement("div");
    option.className = "k-search-item";
    option.id = `cgs-search-option-${position}`;
    option.dataset.index = String(position);
    option.dataset.kind = item.kind;
    option.setAttribute("role", "option");
    const icon = document.createElement("span");
    icon.className = "k-search-icon";
    if (item.icon) icon.append(item.icon.cloneNode(true));
    else icon.innerHTML = SEARCH_ICON;
    const text = document.createElement("span");
    text.className = "k-search-text";
    const title = document.createElement("span");
    title.className = "k-search-title";
    highlight(title, item.title, tokens);
    text.append(title);
    const subline = item.path.length ? item.path.join(" › ") : item.hint;
    if (subline) {
      const sub = document.createElement("span");
      sub.className = "k-search-sub";
      sub.textContent = subline;
      if (item.path.length && item.hint) sub.title = item.hint;
      text.append(sub);
    }
    const meta = document.createElement("span");
    meta.className = "k-search-meta";
    if (isToggle(item)) {
      const on = item.control.input.checked;
      const toggle = document.createElement("span");
      toggle.className = "k-search-switch";
      toggle.dataset.on = on ? "1" : "0";
      toggle.title = on ? "Выключить" : "Включить";
      toggle.append(Object.assign(document.createElement("i"), { className: "k-search-switch-knob" }));
      const state = Object.assign(document.createElement("span"), { className: "k-search-value", textContent: valueOf(item) });
      meta.append(state, toggle);
    } else {
      const value = valueOf(item);
      if (value) meta.append(Object.assign(document.createElement("span"), { className: "k-search-value", textContent: value }));
    }
    const binding = readBinds()[item.id];
    if (bindItem && bindItem.id === item.id) {
      const keys = Object.assign(document.createElement("span"), { className: "k-search-keys recording", textContent: "…" });
      meta.append(keys);
      option.classList.add("binding");
    } else if (binding) {
      const keys = document.createElement("span");
      keys.className = "k-search-keys";
      renderKeys(keys, hotkeyParts(binding.keys));
      meta.append(keys);
    }
    const badge = document.createElement("span");
    badge.className = "k-search-badge";
    if (item.danger) {
      // Опасное действие: перед выполнением появится окно подтверждения
      badge.classList.add("danger");
      badge.title = t("Попросит подтверждение");
    }
    badge.textContent = KIND[item.kind].badge;
    meta.append(badge);
    const enter = document.createElement("span");
    enter.className = "k-search-enter";
    enter.setAttribute("aria-hidden", "true");
    enter.textContent = "↵";
    option.append(icon, text, meta, enter);
    return option;
  }

  // Переотрисовка одного пункта (после переключения или назначения сочетания)
  function refreshOption(position) {
    const old = list && $(`#cgs-search-option-${position}`, list);
    const item = shown[position];
    if (!old || !item) return;
    const fresh = makeOption(item, position, tokensShown);
    const on = position === active;
    fresh.classList.toggle("active", on);
    fresh.setAttribute("aria-selected", String(on));
    old.replaceWith(fresh);
  }
  const refreshAll = () => shown.forEach((_, position) => refreshOption(position));

  function setNote(text, tone = "") {
    note.classList.toggle("hidden", !text);
    note.dataset.tone = tone;
    note.replaceChildren();
    if (!text) return;
    if (typeof text === "string") note.textContent = text;
    else note.append(...text);
  }

  // Пустой запрос: недавние и разделы; префикс без слов — всё из своей области
  function emptyGroups(scope, pool) {
    const byUse = (a, b) => b.used - a.used;
    if (!scope) {
      const recent = pool.filter((item) => item.used).sort(byUse).slice(0, 6);
      return [
        { name: "Недавние", items: recent },
        { name: KIND.view.group, items: pool.filter((item) => item.kind === "view") },
      ];
    }
    if (scope === "action") return [{ name: KIND.action.group, items: pool.slice().sort(byUse) }];
    if (scope === "settings") {
      const recent = pool.filter((item) => item.used).sort(byUse).slice(0, 5);
      return [
        { name: "Недавние", items: recent },
        { name: KIND.section.group, items: pool.filter((item) => item.kind === "section" && !recent.includes(item)) },
      ];
    }
    return ["game", "hv", "manifest", "steam", "backup", "crack"].map((kind) => ({
      name: KIND[kind].group,
      items: pool.filter((item) => item.kind === kind).sort((a, b) => b.used - a.used).slice(0, kind === "game" ? 6 : 8),
    }));
  }

  function maybeLoadCatalog(scope, text) {
    const files = window.cgsFiles;
    if (!files?.load || catalogTried || files.isLoaded?.()) return;
    if (scope ? scope !== "content" : text.length < 2) return;
    catalogTried = true;
    Promise.resolve(files.load()).catch(() => {}).then(() => {
      if (!isOpen() || !files.isLoaded?.()) return;
      index = buildIndex();
      render(currentQuery(), true);
    });
  }

  // Списки игр Manifest и Steam подгружаются один раз за сеанс, если разделы ещё не открывались
  let libraryTried = false;
  function maybeLoadLibrary(scope, text) {
    const api = window.cgsLibrary;
    if (!api || libraryTried) return;
    if (scope ? scope !== "content" : text.length < 2) return;
    libraryTried = true;
    const known = Object.fromEntries((readLibraryCache().manifest || []).filter((game) => game?.name).map((game) => [String(game.appid), game.name]));
    const jobs = [];
    if (!Array.isArray(api.manifest?.())) jobs.push(Promise.resolve(api.loadManifest?.(known)).then((games) => { if (Array.isArray(games)) quietLibrary.manifest = games; }));
    if (!Array.isArray(api.steam?.())) jobs.push(Promise.resolve(api.loadSteam?.()).then((games) => { if (Array.isArray(games)) quietLibrary.steam = games; }));
    if (!jobs.length) return;
    Promise.allSettled(jobs).then(() => {
      if (!isOpen()) return;
      index = buildIndex();
      render(currentQuery(), true);
    });
  }

  // Полный запрос вместе с префиксом выбранной области
  const currentQuery = () => (scopeLock ? SCOPE_PREFIX[scopeLock] : "") + (input?.value || "");

  // Префикс в начале поля превращается в чип области
  function takePrefix() {
    if (scopeLock) return;
    const value = input.value.replace(/^\s+/, "");
    const scope = PREFIXES[value[0]];
    if (!scope) return;
    scopeLock = scope;
    input.value = value.slice(1).replace(/^\s+/, "");
    input.setSelectionRange(input.value.length, input.value.length);
  }

  function setScope(scope) {
    scopeLock = scope;
    navMode = false;
    render(currentQuery());
  }

  // Восстановление прошлого запроса при открытии
  function setQuery(raw) {
    scopeLock = "";
    input.value = raw || "";
    takePrefix();
  }

  function render(query, keep = false) {
    lastQuery = query;
    const { scope, text } = parseQuery(query);
    scopeChip.classList.toggle("hidden", !scope);
    scopeChip.textContent = scope ? t(SCOPE_LABEL[scope]) : "";
    scopeChip.title = scope ? t("Убрать фильтр (Backspace)") : "";
    overlay.dataset.scope = scope;
    maybeLoadCatalog(scope, text);
    maybeLoadLibrary(scope, text);
    const pool = scope ? index.filter((item) => KIND[item.kind].scope === scope) : index;

    let groups = [];
    let tokens = [];
    let found = { results: [], mode: "", phrase: "" };
    if (!text) {
      groups = emptyGroups(scope, pool);
    } else {
      found = searchAll(pool, text);
      for (const { token, alts } of termsOf(found.phrase)) tokens.push(token, ...alts.filter((alt) => alt.length >= 2));
      const byGroup = new Map();
      for (const { item } of found.results) {
        const name = KIND[item.kind].group;
        if (!byGroup.has(name)) byGroup.set(name, []);
        byGroup.get(name).push(item);
      }
      const limit = byGroup.size === 1 ? 14 : 6;
      groups = [...byGroup].map(([name, items]) => ({ name, items: items.slice(0, limit) }));
    }
    tokensShown = tokens;

    // Подсказка под строкой: исправленная раскладка или неточные совпадения
    if (stickyNote) setNote(stickyNote.text, stickyNote.tone);
    else if (found.mode === "layout") setNote([Object.assign(document.createElement("span"), { textContent: "Показаны результаты для" }), document.createTextNode(" "), Object.assign(document.createElement("b"), { textContent: `«${found.phrase}»` })]);
    else if (found.mode) setNote([Object.assign(document.createElement("span"), { textContent: "Точных совпадений нет — показаны похожие" }), ...(found.mode === "fuzzy-layout" ? [document.createTextNode(" "), Object.assign(document.createElement("b"), { textContent: `«${found.phrase}»` })] : [])]);
    else setNote("");

    shown = [];
    const fragment = document.createDocumentFragment();
    const addGroup = (group) => {
      if (!group.items.length) return;
      const header = document.createElement("div");
      header.className = "k-search-group";
      header.setAttribute("role", "presentation");
      header.textContent = group.name;
      fragment.append(header);
      for (const item of group.items) {
        fragment.append(makeOption(item, shown.length, tokens));
        shown.push(item);
      }
    };
    groups.forEach(addGroup);
    if (text && !shown.length) {
      const empty = document.createElement("div");
      empty.className = "k-search-empty";
      const strong = Object.assign(document.createElement("strong"), { textContent: "Ничего не найдено" });
      const small = Object.assign(document.createElement("small"), { textContent: "Попробуйте другое слово или проверьте раскладку" });
      empty.append(strong, small);
      fragment.append(empty);
    }
    if (text.length >= 2 && (!scope || scope === "content")) addGroup({ name: KIND.find.group, items: findItems(text) });
    if (!text && !shown.length) {
      const empty = document.createElement("div");
      empty.className = "k-search-empty";
      empty.append(Object.assign(document.createElement("strong"), { textContent: "Здесь пока пусто" }));
      fragment.append(empty);
    }
    if (!text && !scope) {
      // Подсказка о префиксах — первой строкой, чтобы её было видно сразу
      const tips = document.createElement("div");
      tips.className = "k-search-tips";
      tips.append(Object.assign(document.createElement("span"), { textContent: "Только:" }));
      for (const [prefix, label] of [[">", "действия"], ["#", "игры и файлы"], ["@", "настройки"]]) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.dataset.searchPrefix = prefix;
        chip.append(Object.assign(document.createElement("kbd"), { textContent: prefix }), Object.assign(document.createElement("em"), { textContent: label }));
        tips.append(chip);
      }
      fragment.prepend(tips);
    }
    list.replaceChildren(fragment);
    if (!keep) list.scrollTop = 0;
    setActive(keep ? active : 0, !keep);
  }

  function updateFooter() {
    if (!footer) return;
    const item = shown[active];
    const verb = !item ? "открыть" : isToggle(item) ? "переключить" : item.kind === "option" ? "применить" : item.kind === "action" ? "выполнить" : "открыть";
    const primary = $('[data-hint="primary"] em', footer);
    if (primary.textContent !== verb) primary.textContent = verb;
    $('[data-hint="secondary"]', footer).hidden = !(item && (isToggle(item) || item.kind === "option"));
    $('[data-hint="bind"]', footer).hidden = !item || item.kind === "find";
  }

  function setActive(position, scroll) {
    active = Math.max(0, Math.min(shown.length - 1, position));
    $$(".k-search-item", list).forEach((option) => {
      const on = Number(option.dataset.index) === active;
      option.classList.toggle("active", on);
      option.setAttribute("aria-selected", String(on));
      if (on && scroll) option.scrollIntoView({ block: "nearest" });
    });
    if (shown.length) input.setAttribute("aria-activedescendant", `cgs-search-option-${active}`);
    else input.removeAttribute("aria-activedescendant");
    updateFooter();
    schedulePreview(shown[active]);
  }

  // Предпросмотр темы и акцента
  let previewTimer = 0;
  let previewBase = null;

  function schedulePreview(item) {
    clearTimeout(previewTimer);
    const option = item?.kind === "option" ? item.target : null;
    const theme = option?.dataset.themeOption;
    const accent = option?.dataset.accent;
    if (!theme && !accent) {
      endPreview();
      return;
    }
    previewTimer = setTimeout(() => startPreview(theme, accent), 110);
  }

  function startPreview(theme, accent) {
    if (!isOpen()) return;
    if (!previewBase) previewBase = { theme: root.dataset.theme || read("cgs-theme", "graphite"), accent: read("accent", "white") };
    const nextTheme = theme || previewBase.theme;
    root.dataset.theme = nextTheme;
    window.cgsAccent?.apply(accent || previewBase.accent, nextTheme);
    overlay.classList.add("previewing");
  }

  function endPreview() {
    clearTimeout(previewTimer);
    overlay?.classList.remove("previewing");
    if (!previewBase) return;
    root.dataset.theme = previewBase.theme;
    window.cgsAccent?.apply(previewBase.accent, previewBase.theme);
    previewBase = null;
  }

  function blocked() {
    const splash = $("#app-splash");
    if (splash && !splash.classList.contains("hidden")) return true;
    return Boolean($(".modal-backdrop:not(.hidden)"));
  }

  function open() {
    if (!isEnabled() || blocked()) return false;
    ensureOverlay();
    if (isOpen()) {
      input.focus();
      input.select();
      return true;
    }
    const previous = paletteFrame();
    lastFocus = document.activeElement;
    catalogTried = false;
    navMode = false;
    bindItem = null;
    stickyNote = null;
    index = buildIndex();
    overlay.hidden = false;
    overlay.inert = false;
    overlay.removeAttribute("aria-hidden");
    overlay.classList.remove("closing");
    input.setAttribute("aria-expanded", "true");
    root.classList.add("k-search-open");
    setQuery(lastQuery);
    render(currentQuery());
    input.focus({ preventScroll: true });
    input.select();
    animatePalette(true, previous);
    return true;
  }

  function close(restoreFocus = true) {
    if (!isOpen()) return;
    const previous = paletteFrame();
    endPreview();
    bindItem = null;
    stickyNote = null;
    overlay.classList.add("closing");
    if (overlay.contains(document.activeElement)) document.activeElement.blur();
    overlay.inert = true;
    overlay.setAttribute("aria-hidden", "true");
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    root.classList.remove("k-search-open");
    if (restoreFocus && lastFocus?.isConnected && typeof lastFocus.focus === "function") lastFocus.focus({ preventScroll: true });
    lastFocus = null;
    animatePalette(false, previous);
  }

  // Выполнение
  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const visible = (node) => (node && node.isConnected && node.getClientRects().length ? node : null);

  function waitFor(check, timeout = 3000) {
    return new Promise((resolve) => {
      const started = performance.now();
      const tick = () => {
        const value = check();
        if (value) resolve(value);
        else if (performance.now() - started > timeout) resolve(null);
        else setTimeout(tick, 60);
      };
      tick();
    });
  }

  function setField(field, value) {
    field.value = value;
    field.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function navigate(go = {}) {
    const { view, hvTab, settingsTab } = go;
    const nav = view && $(`.navigation .nav-item[data-view="${view}"]`);
    if (nav && !nav.classList.contains("active")) nav.click();
    if (hvTab) $(`[data-hv-tab="${hvTab}"]`)?.click();
    if (settingsTab) $(`.settings-tab-btn[data-settings-tab="${settingsTab}"]`)?.click();
  }

  function reveal(target, block = "center") {
    target.scrollIntoView({ block, behavior: smooth() ? "smooth" : "auto" });
    flash(target);
  }

  // Переход к разделу, вкладке или настройке с подсветкой
  async function goTo(item) {
    const { view, hvTab, settingsTab } = item.go || {};
    navigate(item.go);
    const target = item.target;
    if (!target) {
      const main = $(".main-area");
      if (main && view && !hvTab && !settingsTab) main.scrollTop = 0;
      return;
    }
    // Раскрываем свёрнутые группы, в которых лежит найденный элемент
    for (let node = target.closest("details"); node; node = node.parentElement?.closest("details")) {
      if (!node.open) node.open = true;
    }
    await nextFrame();
    (item.focus || target).scrollIntoView({ block: item.kind === "section" ? "start" : "center", behavior: smooth() ? "smooth" : "auto" });
    flash(target);
  }

  function flipToggle(item) {
    const control = item.control?.input;
    if (!control || control.disabled) {
      toast(t("Эта настройка сейчас недоступна"), "error");
      return false;
    }
    control.click();
    return true;
  }

  // Основное действие выполняет пункт; secondary открывает соответствующую настройку
  async function perform(item, mode = "primary") {
    remember(item.id);
    if (mode === "primary" && item.kind === "option" && item.target) {
      item.target.click();
      return;
    }
    if (item.run && (mode === "primary" || !item.target)) {
      await item.run();
      return;
    }
    await goTo(item);
  }

  async function choose(position, mode = "primary") {
    const item = shown[position];
    if (!item) return;
    // Переключатель меняется прямо в списке, палитра остаётся открытой
    if (mode === "primary" && isToggle(item)) {
      remember(item.id);
      if (flipToggle(item)) {
        refreshOption(position);
        requestAnimationFrame(() => refreshOption(position));
      }
      return;
    }
    endPreview();
    close(false);
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    await perform(item, mode);
  }

  async function runAction(def) {
    const button = $(def.selector);
    if (!button || button.disabled || button.closest(".hidden")) {
      toast(t("Действие сейчас недоступно"), "error");
      return;
    }
    if (def.confirm) {
      const accepted = typeof window.cgsShowModal === "function"
        ? await window.cgsShowModal(def.confirm.title, def.confirm.text, { confirm: true, confirmText: def.confirm.ok, cancelText: "Отмена", symbol: "!" })
        : window.confirm(def.confirm.text);
      if (!accepted) return;
    }
    if (!def.stay) {
      navigate(placeOf(button));
      await nextFrame();
    }
    button.click();
    if (!def.stay && visible(button)) reveal(button, "nearest");
  }

  async function openCrack(file) {
    navigate({ view: "files" });
    const field = $("#files-search");
    if (field && !file.pinned) setField(field, file.name);
    const selector = `[data-card-url="${CSS.escape(file.url)}"]`;
    const ready = () => !$("#files-refresh")?.disabled && visible($(selector));
    let card = await waitFor(ready, 5000);
    if (!card && file.pinned && $(selector)) {
      $("#files-featured-toggle")?.click();
      card = await waitFor(ready, 1500);
    }
    if (card) reveal(card);
  }

  // Игра Гипервизора: выбор, как нажатием на карточку, и подсветка карточки в библиотеке
  async function openHvGame(game) {
    navigate({ view: "hypervisor", hvTab: "hypervisor" });
    await window.cgsHypervisor?.select?.(game.id);
    const card = await waitFor(() => visible($(`#hv-game-list .hv-game-card[data-game-id="${CSS.escape(game.id)}"]`)), 1500);
    if (card) reveal(card);
  }

  async function openSteamGame(game) {
    const name = game.name;
    const appid = String(game.appid || "");
    navigate({ view: "dlc" });
    const back = $("#dlc-back");
    if (visible(back)) back.click();
    // Библиотека в разделе ещё не сканировалась: открываем игру по сохранённой папке
    if (!Array.isArray(window.cgsLibrary?.steam?.()) && window.cgsLibrary?.openSteam?.(game)) return;
    const find = () => visible($$("#dlc-game-list .dlc-library-game").find((button) => readText($("strong", button)) === name && (!appid || readText($("small", button)).includes(appid))));
    let button = await waitFor(find, 600);
    const field = $("#dlc-library-search");
    if (!button && field?.value) {
      setField(field, "");
      button = await waitFor(find, 600);
    }
    if (button && !button.disabled) button.click();
    else if (button) reveal(button);
    else window.cgsLibrary?.openSteam?.(game);
  }

  function revealBackup(path) {
    const call = window.cgsApi?.invoke;
    if (!call) return;
    Promise.resolve(call("files_reveal", { path })).catch((error) => toast(String(error), "error"));
  }

  async function findIn(view, selector, query) {
    navigate({ view });
    if (view === "dlc") {
      const back = $("#dlc-back");
      if (visible(back)) back.click();
    }
    await nextFrame();
    const field = $(selector);
    if (!field) return;
    setField(field, query);
    field.focus({ preventScroll: true });
    reveal(field.closest("label, .lua-search-wrap, .dlc-library-tools") || field);
  }

  // Отдельный слой подсветки следует за найденным элементом при прокрутке
  let flashLayer = null;
  let flashFrame = 0;
  let flashTarget = null;

  function clearFlash() {
    cancelAnimationFrame(flashFrame);
    flashLayer?.remove();
    flashTarget?.classList.remove("k-search-hit");
    flashLayer = null;
    flashTarget = null;
    flashFrame = 0;
  }

  function flash(target) {
    clearFlash();
    if (!visible(target)) return;
    target.classList.add("k-search-hit");
    const layer = document.createElement("div");
    layer.className = "k-search-flash";
    layer.setAttribute("aria-hidden", "true");
    const radius = getComputedStyle(target).borderRadius;
    if (radius !== "0px") layer.style.borderRadius = radius;
    flashLayer = layer;
    flashTarget = target;
    const started = performance.now();
    const duration = 1000;
    const step = (time) => {
      if (flashLayer !== layer) return;
      if (!visible(target) || time - started >= duration) {
        clearFlash();
        return;
      }
      const rect = target.getBoundingClientRect();
      const area = $(".main-area")?.getBoundingClientRect() || { top: 0, bottom: innerHeight, left: 0, right: innerWidth };
      Object.assign(layer.style, {
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        clipPath: `inset(${Math.max(0, area.top - rect.top)}px ${Math.max(0, rect.right - area.right)}px ${Math.max(0, rect.bottom - area.bottom)}px ${Math.max(0, area.left - rect.left)}px)`,
      });
      flashFrame = requestAnimationFrame(step);
    };
    step(started);
    document.body.append(layer);
  }

  // Сочетания для пунктов
  function startBind() {
    const item = shown[active];
    if (!item || item.kind === "find") return;
    bindItem = item;
    stickyNote = { text: tr(`Нажмите сочетание для «${item.title}». Esc — отмена, Backspace — убрать`, `Press a shortcut for “${item.title}”. Esc cancels, Backspace removes`), tone: "info" };
    setNote(stickyNote.text, stickyNote.tone);
    refreshOption(active);
  }

  function finishBind(message, tone) {
    bindItem = null;
    stickyNote = message ? { text: message, tone } : null;
    setNote(message || "", tone);
    refreshAll();
    renderBindsList();
  }

  function bindKey(event) {
    event.preventDefault();
    event.stopPropagation();
    const item = bindItem;
    const plain = !event.ctrlKey && !event.altKey && !event.metaKey;
    if (event.key === "Escape" && plain) {
      finishBind("", "");
      return;
    }
    if ((event.key === "Backspace" || event.key === "Delete") && plain) {
      const binds = readBinds();
      const had = Boolean(binds[item.id]);
      delete binds[item.id];
      saveBinds(binds);
      finishBind(had ? tr("Сочетание убрано", "Shortcut removed") : "", "ok");
      return;
    }
    const value = hotkeyFromEvent(event);
    if (!value) {
      const keys = $(`#cgs-search-option-${active} .k-search-keys`, list);
      const mods = heldModifiers(event);
      if (keys) {
        if (mods.length) renderKeys(keys, [...mods, "…"]);
        else keys.textContent = "…";
      }
      return;
    }
    const problem = hotkeyProblem(value) || (value === currentHotkey() ? "Это сочетание открывает поиск" : "");
    if (problem) {
      stickyNote = { text: t(problem), tone: "warn" };
      setNote(stickyNote.text, "warn");
      return;
    }
    const binds = readBinds();
    const owner = bindOwner(binds, value);
    let message = tr(`Сочетание назначено: «${item.title}»`, `Shortcut assigned: “${item.title}”`);
    if (owner && owner !== item.id) {
      message = tr(`Сочетание перенесено с «${binds[owner].title}»`, `Shortcut moved from “${binds[owner].title}”`);
      delete binds[owner];
    }
    binds[item.id] = { keys: value, title: item.title };
    saveBinds(binds);
    finishBind(message, "ok");
  }

  async function runBinding(id) {
    const item = buildIndex().find((entry) => entry.id === id);
    if (!item) {
      toast(t("Пункт для этого сочетания сейчас недоступен"), "error");
      return;
    }
    if (isToggle(item)) {
      remember(id);
      if (flipToggle(item)) requestAnimationFrame(() => toast(`${item.title}: ${valueOf(item)}`));
      return;
    }
    if (document.activeElement instanceof HTMLElement && document.activeElement.matches("input, textarea, select")) document.activeElement.blur();
    await perform(item, "primary");
  }

  // Клавиатура
  function onKeydown(event) {
    if (recording) {
      recordKey(event);
      return;
    }
    if (isOpen()) {
      if (bindItem) {
        bindKey(event);
        return;
      }
      const key = event.key;
      if (key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }
      if (key === "Enter" && event.altKey) {
        event.preventDefault();
        event.stopPropagation();
        startBind();
        return;
      }
      if (key === "Backspace" && scopeLock && event.target === input && input.selectionStart === 0 && input.selectionEnd === 0) {
        event.preventDefault();
        setScope("");
        return;
      }
      if (key === "ArrowDown" || key === "ArrowUp" || key === "Tab") {
        event.preventDefault();
        event.stopPropagation();
        navMode = true;
        const down = key === "ArrowDown" || (key === "Tab" && !event.shiftKey);
        if (shown.length) setActive((active + (down ? 1 : -1) + shown.length) % shown.length, true);
        return;
      }
      if (key === "PageDown" || key === "PageUp" || (event.ctrlKey && (key === "Home" || key === "End"))) {
        event.preventDefault();
        navMode = true;
        const last = shown.length - 1;
        setActive(key === "PageDown" ? active + 5 : key === "PageUp" ? active - 5 : key === "Home" ? 0 : last, true);
        return;
      }
      // Пробел после выбора стрелками переключает настройку, иначе — обычный пробел в запросе
      if (key === " " && navMode && isToggle(shown[active]) && !event.ctrlKey && !event.altKey && !event.metaKey) {
        event.preventDefault();
        event.stopPropagation();
        choose(active, "primary");
        return;
      }
      if (key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        choose(active, event.shiftKey ? "secondary" : "primary");
        return;
      }
    }
    if (!isEnabled() || event.repeat) return;
    const combo = hotkeyFromEvent(event);
    if (!combo) return;
    if (combo === currentHotkey()) {
      if (isOpen()) {
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }
      if (open()) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    if (isOpen() || blocked()) return;
    const id = bindOwner(readBinds(), combo);
    if (!id) return;
    event.preventDefault();
    event.stopPropagation();
    runBinding(id);
  }

  function bind() {
    window.addEventListener("keydown", onKeydown, true);
    const trigger = $("#titlebar-search");
    if (trigger) {
      // Заголовок окна запускает перетаскивание по mousedown — кнопке поиска это не нужно
      trigger.addEventListener("mousedown", (event) => event.stopPropagation());
      trigger.addEventListener("dblclick", (event) => event.stopPropagation());
      trigger.addEventListener("click", () => open());
    }
    $("#search-enabled")?.addEventListener("change", (event) => {
      write(ENABLED_KEY, event.currentTarget.checked ? "1" : "0");
      applySettings();
    });
    const button = $("#search-hotkey-button");
    button?.addEventListener("click", () => (recording ? stopRecording() : startRecording()));
    button?.addEventListener("blur", () => stopRecording());
    $("#search-hotkey-reset")?.addEventListener("click", () => {
      write(HOTKEY_KEY, DEFAULT_HOTKEY);
      const binds = readBinds();
      const owner = bindOwner(binds, DEFAULT_HOTKEY);
      if (owner) {
        delete binds[owner];
        saveBinds(binds);
      }
      showHotkeyHint("");
      applySettings();
    });
    $("#search-binds-list")?.addEventListener("click", (event) => {
      const remove = event.target.closest("[data-bind-remove]");
      if (!remove) return;
      const binds = readBinds();
      delete binds[remove.dataset.bindRemove];
      saveBinds(binds);
      renderBindsList();
    });
    $("#search-binds-clear")?.addEventListener("click", () => {
      saveBinds({});
      renderBindsList();
    });
    window.addEventListener("cgs:view-changed", (event) => {
      if (event.detail === "settings") renderBindsList();
    });
    window.addEventListener("cgs:language-changed", () => {
      renderBindsList();
      if (isOpen()) {
        index = buildIndex();
        render(currentQuery(), true);
      }
    });
    applySettings();
  }

  window.cgsSearch = { open, close, get isOpen() { return isOpen(); } };
  bind();
})();
