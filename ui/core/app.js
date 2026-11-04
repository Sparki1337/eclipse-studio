(() => {
  "use strict";

  const tauri = window.__TAURI__;
  const invoke = window.cgsApi?.invoke;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  // Текущие операции разделов: обновление программы не начинается, пока они не завершены
  // id → источник: "button" (кнопка с setBusy) или "module" (сообщение раздела через cgsReportBusy)
  const activeOperations = new Map();
  // Кнопки самого обновления не считаются посторонней операцией
  const UPDATE_OWN_BUSY_IDS = new Set(["check-update-button", "update-install-button", "app-update-install", "app-update-cancel", "app-update-defer", "app-update-close"]);
  function reportOperation(id, busy, source) {
    if (!id || UPDATE_OWN_BUSY_IDS.has(id)) return;
    if (busy) activeOperations.set(id, source); else activeOperations.delete(id);
  }
  window.cgsReportBusy = (id, busy) => reportOperation(id, busy, "module");
  window.addEventListener("cgs:busy-changed", ({ detail }) => reportOperation(detail?.id, detail?.busy, "button"));

  // Кэш прямых ссылок на обложки добавленных игр в window.cgsStorage
  const LUA_COVERS_STORAGE_KEY = "cgs-lua-covers";

  function loadStoredLuaCovers() {
    try {
      const data = JSON.parse(window.cgsStorage.getItem(LUA_COVERS_STORAGE_KEY) || "{}");
      return typeof data === "object" && data !== null ? data : {};
    } catch (_) {
      return {};
    }
  }

  function saveStoredLuaCover(appid, url) {
    if (!appid || !url) return;
    try {
      const data = loadStoredLuaCovers();
      data[String(appid)] = url;
      window.cgsStorage.setItem(LUA_COVERS_STORAGE_KEY, JSON.stringify(data));
    } catch (_) {}
  }

  const state = {
    version: "9.0.0",
    gameDir: "",
    appid: null,
    gameName: "",
    banner: "",
    engine: "—",
    exes: [],
    steamApis: [],
    dlcs: {},
    status: "clean",
    hasEos: false,
    hasEosBackup: false,
    hasEpicfix: false,
    scanning: false,
    saveLocations: [],
    savesScanned: false,
    dlc: {
      gameDir: "",
      appid: null,
      name: "",
      banner: "",
      source: "",
      targets: [],
      installed: false,
      catalog: [],
      loaded: false,
      scanning: false,
      games: [],
      libraryScanned: false,
      libraryScanning: false,
      extraLibrary: window.cgsStorage.getItem("dlcExtraLibrary") || "",
      detail: false,
      method: "cream",
      exes: [],
      exePath: "",
      proxy: "version.dll",
      requestId: 0,
      catalogLoading: false,
      catalogError: "",
      catalogStatus: "",
      operating: false,
      configuredDlcs: [],
      configUnlockAll: true,
      coverObjectUrls: [],
    },
    lua: {
      steamPath: "",
      luaFolder: "",
      loaderStatus: "unknown",
      loaderName: "",
      loaderIssue: "",
      games: [],
      names: {},
      headers: loadStoredLuaCovers(),
      loaded: false,
      service: "ryuu",
      hubcapKey: "",
      ryuuKey: "",
      ryuuKeySource: "crocodile",
      hubcapUsage: { dailyUsage: 0, dailyLimit: 25, remaining: 25 },
      hubcapUsageError: "",
      hubcapUsageLoading: false,
      millennium: {
        status: "checking",
        message: "Проверяем Millennium и установленную версию плагина.",
        millenniumInstalled: false,
        pluginInstalled: false,
        pluginCurrent: false,
        pluginVersion: "",
        bundledVersion: "0.5.2",
        pluginPath: "",
      },
      millenniumPrompted: false,
      crocluaPrompted: false,
      // Источник загрузчика манифестов: "v1" (базовый) или "v2" (с десктопа)
      loaderSource: (window.cgsStorage.getItem("manifestLoaderSource") === "v2" || window.cgsStorage.getItem("manifestLoaderSource") === "desktop") ? "v2" : "v1",
      // Подробные сведения о файлах загрузчика OpenSteamTool и статусе в Steam
      loaderInfo: null,
      // Сведения о доступности обновлений библиотек OpenSteamTool с GitHub
      loaderUpdate: null,
      loaderChecking: false,
    },
    updates: {
      checking: false,
      promptedVersion: "",
      latest: null,
      // Ход установки обновления внутри программы
      installing: false,
      cancelling: false,
      committing: false,
      downloadSamples: [],
      // Отложено пользователем на этот запуск или подавлено после неудачной установки
      snoozedThisLaunch: false,
      suppressAuto: false,
      ready: null,
    },
  };

  const viewMeta = {
    home: ["", "Главная"],
    fix: ["", "Online Fix"],
    dlc: ["", "DLC Unlocker"],
    lua: ["", "Eclipse Manifest"],
    hypervisor: ["", "Гипервизор"],
    files: ["", "Кряки"],
    utilities: ["", "Утилиты"],
    saves: ["", "Менеджер сохранений"],
    settings: ["", "Настройки"],
  };

  function now() {
    return new Date().toLocaleTimeString(window.cgsI18n?.locale?.() || "ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function log(message, type = "info") {
    const container = $("#activity-log");
    if (!container) return;
    const entry = document.createElement("div");
    entry.className = `log-entry ${type}`;

    const time = document.createElement("time");
    time.textContent = now();

    const msg = document.createElement("div");
    msg.className = "log-msg";

    const icon = document.createElement("span");
    icon.className = "log-icon";
    const glyphs = {
      success: "✓",
      error: "✕",
      system: "›",
      info: "•",
    };
    icon.textContent = glyphs[type] || "•";

    const text = document.createElement("span");
    text.className = "log-text";
    text.textContent = String(message);

    msg.append(icon, text);
    entry.append(time, msg);
    container.appendChild(entry);
    container.scrollTop = container.scrollHeight;
  }

  function toast(message, type = "success") {
    // Воспроизведение звука успешного действия
    if (type === "success") {
      try {
        window.cgsAudio?.playSuccess();
      } catch (_) {}
    }
    const item = document.createElement("div");
    item.className = `toast ${type}`;
    // Уведомление: значок, текст и полоса времени
    const TOAST_ICONS = {
      success: '<path d="M20 6 9 17l-5-5"/>',
      error: '<path d="M18 6 6 18M6 6l12 12"/>',
      warning: '<path d="M12 8v5m0 3.5h.01"/>',
      info: '<path d="M12 11v6m0-9.5h.01"/>'
    };
    const icon = document.createElement("span");
    icon.className = "toast-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = `<svg viewBox="0 0 24 24">${TOAST_ICONS[type] || TOAST_ICONS.info}</svg>`;
    const text = document.createElement("span");
    text.className = "toast-text";
    text.textContent = message;
    const bar = document.createElement("span");
    bar.className = "toast-bar";
    bar.setAttribute("aria-hidden", "true");
    item.append(icon, text, bar);
    $("#toast-stack").appendChild(item);
    setTimeout(() => {
      item.style.opacity = "0";
      item.style.transform = "translateX(15px)";
      setTimeout(() => item.remove(), 250);
    }, 3600);
  }

  function errorText(error) {
    if (typeof error === "string") return error;
    return error?.message || "Неизвестная ошибка";
  }

  async function call(command, args = {}) {
    if (!invoke) throw new Error("Системный модуль недоступен. Перезапустите приложение.");
    return invoke(command, args);
  }

  function setBusy(button, busy, label) {
    if (!button) return;
    if (busy) {
      button.dataset.original = button.innerHTML;
      button.classList.add("busy");
      button.disabled = true;
      if (label) button.innerHTML = `<span>${label}</span>`;
    } else {
      button.classList.remove("busy");
      button.disabled = false;
      if (button.dataset.original) button.innerHTML = button.dataset.original;
      delete button.dataset.original;
    }
    window.dispatchEvent(new CustomEvent("cgs:busy-changed", { detail: { id: button.id, busy } }));
  }

  function switchView(name) {
    // Во время обновления доступен только раздел настроек с ходом установки
    if (state.updates.installing && name !== "settings") return;
    if (!viewMeta[name]) return;
    $$("[data-view-panel]").forEach((panel) => panel.classList.toggle("active", panel.dataset.viewPanel === name));
    $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === name));
    $("#page-eyebrow").textContent = viewMeta[name][0];
    $("#page-title").textContent = viewMeta[name][1];
    if (name === "lua" || name === "settings") {
      luaRefresh();
      updateAboutInfo();
    }
    window.dispatchEvent(new CustomEvent("cgs:view-changed", { detail: name }));
    const mainArea = $(".main-area");
    if (mainArea) mainArea.scrollTop = 0;
  }

  const showModal = (...args) => window.cgsDialogs.show(...args);

  window.cgsShowModal = showModal;
  window.cgsToast = toast;

  function basename(path) {
    return String(path || "").split(/[\\/]/).filter(Boolean).pop() || "Неизвестная игра";
  }

  function pluralPackages(count) {
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (mod10 === 1 && mod100 !== 11) return `${count} пакет`;
    if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) return `${count} пакета`;
    return `${count} пакетов`;
  }

  function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return `${value} Б`;
    const units = ["КБ", "МБ", "ГБ", "ТБ"];
    let amount = value / 1024;
    let unit = 0;
    while (amount >= 1024 && unit < units.length - 1) {
      amount /= 1024;
      unit += 1;
    }
    return `${amount >= 10 ? amount.toFixed(1) : amount.toFixed(2)} ${units[unit]}`;
  }

  const { updateSaveSelection, renderSaveLocations, scanSaveLocations, createSaveArchive, restoreSaveArchive } = window.cgsSaves.create({ state, $, $$, call, setBusy, log, toast, errorText, consumeResult, showModal, formatBytes });

  function dlcExe() {
    return state.dlc.exes.find((exe) => exe.path === state.dlc.exePath);
  }

  function dlcInstalled() {
    return state.dlc.method === "smaki" ? Boolean(dlcExe()?.proxy) : state.dlc.installed;
  }

  function dlcShowDetail(detail) {
    state.dlc.detail = detail;
    $("#view-dlc").classList.toggle("dlc-detail", detail);
    $("#dlc-library-panel").classList.toggle("hidden", detail);
    $("#dlc-manual-panel").classList.toggle("hidden", detail);
    $("#dlc-workspace").classList.toggle("hidden", !detail);
    $("#dlc-library-scan").classList.toggle("hidden", detail);
  }

  function renderDlcLibrary() {
    const list = $("#dlc-game-list");
    const filter = $("#dlc-library-search").value.trim().toLowerCase();
    const games = state.dlc.games.filter((game) => !filter || game.name.toLowerCase().includes(filter) || String(game.appid).includes(filter));
    state.dlc.coverObjectUrls.forEach((url) => URL.revokeObjectURL(url));
    state.dlc.coverObjectUrls = [];
    list.replaceChildren();
    list.classList.toggle("hidden", !games.length);
    $("#dlc-library-empty").classList.toggle("hidden", games.length > 0);
    $("#dlc-library-count").textContent = state.dlc.games.length;
    $("#dlc-library-empty h3").textContent = state.dlc.libraryScanned ? "Игры не найдены" : "Ваша библиотека игр";
    for (const game of games) {
      const button = document.createElement("button");
      button.className = "dlc-library-game";
      button.disabled = state.dlc.scanning || state.dlc.libraryScanning;
      const cover = document.createElement("div"); cover.className = "dlc-library-cover";
      const placeholder = document.createElement("span");
      placeholder.innerHTML = '<svg viewBox="0 0 24 24" style="width:26px;height:26px;stroke:currentColor;fill:none;stroke-width:1.6"><line x1="6" x2="10" y1="12" y2="12"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="15" x2="15.01" y1="13" y2="13"/><line x1="18" x2="18.01" y1="11" y2="11"/><rect width="20" height="12" x="2" y="6" rx="6"/></svg>';
      const image = document.createElement("img"); image.src = game.headerImage; image.alt = ""; image.loading = "lazy";
      image.onerror = async () => {
        image.onerror = null;
        try {
          const cover = await call("steam_library_cover", { appid: Number(game.appid), steamPath: state.lua.steamPath || null });
          if (!cover?.bytes?.length || !image.isConnected) return image.remove();
          const url = URL.createObjectURL(new Blob([new Uint8Array(cover.bytes)], { type: cover.mime || "image/jpeg" }));
          state.dlc.coverObjectUrls.push(url);
          image.src = url;
        } catch (_) { image.remove(); }
      };
      cover.append(placeholder, image);
      const copy = document.createElement("div"); copy.className = "dlc-library-copy";
      const name = document.createElement("strong"); name.textContent = game.name;
      const id = document.createElement("small"); id.textContent = `AppID ${game.appid}`;
      const path = document.createElement("code"); path.textContent = game.gameDir; path.title = game.gameDir;
      copy.append(name, id, path);
      const arrow = document.createElement("span"); arrow.className = "dlc-library-arrow";
      arrow.innerHTML = '<svg viewBox="0 0 16 16" style="width:16px;height:16px;stroke-width:2"><path d="M3 8h10m-4-4 4 4-4 4"/></svg>';
      button.append(cover, copy, arrow);
      button.addEventListener("click", () => scanDlcDirectory(game.gameDir, game));
      list.append(button);
    }
  }

  async function scanDlcLibrary() {
    if (state.dlc.libraryScanning || state.dlc.operating) return;
    state.dlc.libraryScanning = true;
    const button = $("#dlc-library-scan");
    setBusy(button, true, "Сканирование…");
    $("#dlc-library-folder").disabled = true;
    $("#dlc-library-status").textContent = "Проверяем библиотеки Steam…";
    renderDlcLibrary();
    try {
      const result = await call("scan_installed_steam_games", { steamPath: state.lua.steamPath || null, libraryPath: state.dlc.extraLibrary || null });
      state.dlc.games = result.games || [];
      state.dlc.libraryScanned = true;
      $("#dlc-library-status").textContent = `Установлено игр: ${state.dlc.games.length} · Библиотек: ${result.libraries.length}`;
      for (const warning of result.warnings || []) log(warning, "error");
      if (result.warnings?.length) $("#dlc-library-status").textContent += " · Часть библиотек не удалось прочитать";
    } catch (error) {
      $("#dlc-library-status").textContent = errorText(error);
      toast(errorText(error), "error");
    } finally {
      state.dlc.libraryScanning = false;
      setBusy(button, false);
      $("#dlc-library-folder").disabled = false;
      renderDlcLibrary();
    }
  }

  function renderDlcMethod() {
    const smaki = state.dlc.method === "smaki";
    $$("[data-dlc-method]").forEach((button) => {
      const active = button.dataset.dlcMethod === state.dlc.method;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
      button.disabled = state.dlc.operating;
    });
    $$("[data-dlc-proxy]").forEach((button) => {
      const active = button.dataset.dlcProxy === state.dlc.proxy;
      button.classList.toggle("active", active); button.setAttribute("aria-pressed", String(active));
      button.disabled = state.dlc.operating;
    });
    $("#dlc-exe-select").disabled = state.dlc.operating;
    $("#dlc-back").disabled = state.dlc.operating;
    $("#dlc-smaki-options").classList.toggle("hidden", !smaki);
    $("#dlc-cream-options").classList.toggle("hidden", smaki);
    const exe = dlcExe();
    const destination = exe ? exe.path.replace(/[^\\/]+$/, state.dlc.proxy) : "—";
    $("#dlc-proxy-destination").textContent = destination;
    const supportedSmaki = exe && (exe.bitness === "x64" || exe.bitness === "x86");
    $("#dlc-smaki-note").textContent = !exe ? "EXE игры не найден. Установка недоступна." : !supportedSmaki ? "SmokeAPI поддерживает только x64 и x86 EXE. Для этой игры выберите CreamAPI." : `Будет использована ${exe.bitness}-версия SmokeAPI. Если прокси не загружается игрой, попробуйте другое имя DLL.`;
    $("#dlc-install-note").textContent = smaki ? "Прокси и конфигурация устанавливаются рядом с выбранным EXE. Steam API не изменяется." : "Оригинальная библиотека Steam сохраняется и восстанавливается при удалении.";
    const installed = dlcInstalled();
    const conflict = smaki ? state.dlc.installed : state.dlc.exes.some((item) => item.proxy);
    $("#dlc-method-conflict").classList.toggle("hidden", !conflict);
    $("#dlc-method-conflict").textContent = smaki ? "Установлен CreamAPI. Выберите CreamAPI и удалите его, затем установите SmokeAPI." : "Установлен SmokeAPI. Выберите SmokeAPI и удалите его, затем установите CreamAPI.";
    $("#dlc-state").textContent = installed ? "UNLOCKED" : "CLEAN";
    $("#dlc-state").classList.toggle("installed", installed);
    $("#dlc-uninstall-button").classList.toggle("hidden", !installed);
    $("#dlc-uninstall-button").disabled = state.dlc.operating;
    $("#dlc-target-count").textContent = smaki ? (exe ? 1 : 0) : state.dlc.targets.length;
    $("#dlc-target-count").parentElement.querySelector("small").textContent = smaki ? "ПРОКСИ РЯДОМ С EXE" : "БИБЛИОТЕК";
    $("#dlc-target-count").parentElement.querySelector("span").textContent = smaki ? state.dlc.proxy : "steam_api для подмены";
    updateDlcSelection();
  }

  function restoreDlcSelection() {
    const exe = dlcExe();
    const installed = dlcInstalled();
    if (!installed) return;
    const configured = state.dlc.method === "smaki" ? Object.entries(exe.configuredDlcs || {}).map(([id, name]) => ({ id, name })) : state.dlc.configuredDlcs;
    const ids = new Set(configured.map((item) => item.id));
    $("#dlc-unlock-all").checked = state.dlc.method === "smaki" ? exe.unlockAll : state.dlc.configUnlockAll;
    for (const item of configured) if (!state.dlc.catalog.some((entry) => entry.id === item.id)) state.dlc.catalog.push({ ...item, enabled: true });
    state.dlc.catalog.forEach((item) => { item.enabled = ids.has(item.id); });
  }

  function updateDlcSelection() {
    const catalog = state.dlc.catalog;
    const selected = catalog.filter((item) => item.enabled);
    const unlockAll = $("#dlc-unlock-all").checked;
    $("#dlc-total-count").textContent = catalog.length.toLocaleString(window.cgsI18n?.locale?.() || "ru-RU");
    $("#dlc-count-value").textContent = catalog.length ? catalog.length : (state.dlc.appid ? "0" : "—");
    $("#dlc-selected-count").textContent = unlockAll ? "ВСЕ" : selected.length.toLocaleString(window.cgsI18n?.locale?.() || "ru-RU");
    const toggle = $("#dlc-toggle-selection");
    toggle.disabled = catalog.length === 0 || unlockAll;
    toggle.textContent = catalog.length > 0 && selected.length === catalog.length ? "Снять выделение" : "Выделить все";
    $("#dlc-catalog").classList.toggle("dimmed", unlockAll);

    const install = $("#dlc-install-button");
    const compatible = state.dlc.method === "smaki" ? ["x64", "x86"].includes(dlcExe()?.bitness) : state.dlc.targets.length > 0;
    const otherInstalled = state.dlc.method === "smaki" ? state.dlc.installed : state.dlc.exes.some((exe) => exe.proxy);
    install.disabled = state.dlc.operating || state.dlc.scanning || state.dlc.catalogLoading || !state.dlc.gameDir || !state.dlc.appid || !compatible || otherInstalled || (!unlockAll && !selected.length);
    const label = install.querySelector("span");
    if (label) label.textContent = dlcInstalled() ? "Переустановить анлокер" : "Установить DLC Unlocker";
    $("#dlc-catalog-retry").disabled = state.dlc.operating || state.dlc.scanning || state.dlc.catalogLoading;
    $("#dlc-rescan-button").disabled = state.dlc.operating || state.dlc.scanning || state.dlc.catalogLoading;
    $("#dlc-manual-button").disabled = state.dlc.operating || state.dlc.scanning || state.dlc.catalogLoading;
  }

  function renderDlcCatalog(filter = "") {
    const container = $("#dlc-catalog");
    const empty = $("#dlc-empty");
    const catalog = state.dlc.catalog;
    $("#dlc-catalog-status").textContent = state.dlc.catalogLoading ? "Сканируем DLC…" : state.dlc.catalogError || state.dlc.catalogStatus;
    $("#dlc-catalog-status").classList.toggle("warning", Boolean(state.dlc.catalogError));
    container.replaceChildren();
    container.classList.toggle("hidden", catalog.length === 0);
    empty.classList.toggle("hidden", catalog.length > 0);
    if (!catalog.length) {
      $("#dlc-empty h3").textContent = state.dlc.catalogLoading ? "Сканируем DLC…" : state.dlc.catalogError ? "Каталог недоступен" : state.dlc.loaded ? "Дополнения не найдены" : "Каталог ещё не загружен";
      $("#dlc-empty p").textContent = state.dlc.catalogLoading ? "Проверяем каталоги Steam и локальный кэш клиента." : state.dlc.catalogError ? "Не удалось проверить список DLC. Повторите сканирование; ошибка сети не означает, что дополнений нет." : state.dlc.loaded ? "Доступные источники не вернули DLC. Для некоторых игр полный каталог может быть недоступен." : "Определите игру, чтобы загрузить список её дополнений.";
      updateDlcSelection();
      return;
    }

    const normalized = filter.trim().toLowerCase();
    const visible = catalog.filter((item) => !normalized || item.id.includes(normalized) || item.name.toLowerCase().includes(normalized));
    if (!visible.length) {
      const inline = document.createElement("div");
      inline.className = "empty-inline";
      inline.textContent = "Ничего не найдено";
      container.appendChild(inline);
      updateDlcSelection();
      return;
    }

    visible.forEach((entry) => {
      const row = document.createElement("label");
      row.className = "save-location dlc-row";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = entry.enabled;
      checkbox.addEventListener("change", () => {
        entry.enabled = checkbox.checked;
        updateDlcSelection();
      });

      const icon = document.createElement("span");
      icon.className = "save-location-icon";
      icon.textContent = "DLC";

      const copy = document.createElement("span");
      copy.className = "save-location-copy";
      const title = document.createElement("strong");
      title.textContent = entry.name;
      title.title = entry.name;
      const id = document.createElement("code");
      id.textContent = `AppID ${entry.id}`;
      copy.append(title, id);

      row.append(checkbox, icon, copy);
      container.appendChild(row);
    });
    updateDlcSelection();
  }

  function renderDlcGame() {
    dlcShowDetail(true);
    $("#dlc-detail-path").textContent = state.dlc.gameDir;
    $("#dlc-detail-path").title = state.dlc.gameDir;
    const { name, gameDir, appid, targets, installed, catalog, banner, source } = state.dlc;
    $("#dlc-title").textContent = name || basename(gameDir);
    $("#dlc-appid-value").textContent = appid || "Не определён";
    const apis = [...new Set(targets.map((item) => item.bitness))];
    $("#dlc-api-value").textContent = targets.length ? (targets.length > 1 ? `${targets.length} × ${apis.join("/")}` : apis[0] || "—") : "Не найдена";
    $("#dlc-count-value").textContent = catalog.length ? catalog.length : (appid ? "0" : "—");
    $("#dlc-target-count").textContent = targets.length.toLocaleString(window.cgsI18n?.locale?.() || "ru-RU");
    $("#dlc-source-value").textContent = source || "—";
    $("#dlc-source-value").title = source || "";

    const chip = $("#dlc-config-chip");
    chip.textContent = installed ? "АНЛОКЕР УСТАНОВЛЕН" : targets.length ? "БИБЛИОТЕКА НАЙДЕНА" : "STEAM API НЕ НАЙДЕН";
    chip.classList.toggle("installed", installed);

    const badge = $("#dlc-state");
    badge.classList.toggle("installed", installed);
    badge.textContent = installed ? "UNLOCKED" : "CLEAN";
    $("#dlc-uninstall-button").classList.toggle("hidden", !installed);

    const image = $("#dlc-banner");
    const fallback = $("#dlc-cover-fallback");
    image.classList.remove("loaded");
    fallback.classList.remove("hidden");
    if (banner) {
      image.onload = () => { image.classList.add("loaded"); fallback.classList.add("hidden"); };
      image.onerror = () => { image.classList.remove("loaded"); fallback.classList.remove("hidden"); };
      image.src = banner;
    } else {
      image.removeAttribute("src");
    }
    renderDlcMethod();
  }

  async function loadDlcCatalog(appid, token = state.dlc.requestId) {
    if (!appid) {
      state.dlc.catalog = [];
      state.dlc.loaded = false;
      renderDlcCatalog();
      return;
    }
    state.dlc.catalogLoading = true;
    state.dlc.catalogError = "";
    renderDlcCatalog();
    try {
      const result = await call("scan_dlc_catalog", { appid, steamPath: state.lua.steamPath || null });
      if (token !== state.dlc.requestId) return;
      const previous = new Map(state.dlc.catalog.map((item) => [item.id, item]));
      for (const item of result.entries || []) {
        const old = previous.get(item.id);
        previous.set(item.id, { ...item, enabled: old ? old.enabled : !(dlcInstalled() && !$("#dlc-unlock-all").checked) });
      }
      state.dlc.catalog = [...previous.values()]
        .sort((left, right) => Number(left.id) - Number(right.id));
      state.dlc.loaded = true;
      state.dlc.catalogStatus = (result.warnings || []).join(" ");
      renderDlcCatalog($("#dlc-search").value);
      log(`Каталог DLC загружен: ${state.dlc.catalog.length} дополнений`, state.dlc.catalog.length ? "success" : "info");
    } catch (error) {
      if (token !== state.dlc.requestId) return;
      state.dlc.catalogError = errorText(error);
      state.dlc.loaded = false;
      renderDlcCatalog();
      log(`Каталог DLC не загружен: ${errorText(error)}`, "error");
    } finally {
      if (token === state.dlc.requestId) {
        state.dlc.catalogLoading = false;
        renderDlcCatalog($("#dlc-search").value);
      }
    }
  }

  async function scanDlcDirectory(rawPath, selectedGame = null, operationRefresh = false) {
    const path = String(rawPath || "").trim().replace(/^"|"$/g, "");
    if (!path || state.dlc.scanning || (state.dlc.operating && !operationRefresh)) {
      if (!path) toast("Сначала укажите папку игры", "error");
      return;
    }
    state.dlc.scanning = true;
    const token = ++state.dlc.requestId;
    state.dlc.catalog = [];
    state.dlc.loaded = false;
    state.dlc.catalogError = "";
    state.dlc.catalogStatus = "";
    $("#dlc-search").value = "";
    renderDlcLibrary();
    if (state.dlc.detail) updateDlcSelection();
    $("#dlc-library-status").textContent = "Анализируем выбранную игру…";
    window.cgsStorage.setItem("lastDlcPath", path);
    $("#dlc-path").value = path;
    const button = $("#dlc-scan-button");
    setBusy(button, true, "Определяем…");
    log(`DLC Unlocker · определение игры: ${path}`, "system");
    try {
      const result = await call("scan_dlc_target", { gameDir: path });
      if (token !== state.dlc.requestId) return;
      state.dlc.gameDir = result.gameDir;
      state.dlc.appid = result.appid || null;
      state.dlc.name = selectedGame?.name || (result.detected ? result.name : basename(path));
      state.dlc.banner = result.headerImage || "";
      state.dlc.source = result.source || "";
      state.dlc.targets = result.targets || [];
      state.dlc.installed = Boolean(result.installed);
      state.dlc.exes = result.exes || [];
      const currentExe = state.dlc.exes.find((exe) => exe.path === state.dlc.exePath);
      const exe = currentExe || state.dlc.exes.find((exe) => exe.proxy) || state.dlc.exes[0];
      state.dlc.exePath = exe?.path || "";
      state.dlc.proxy = exe?.proxy || state.dlc.proxy;
      state.dlc.configuredDlcs = result.configuredDlcs || [];
      state.dlc.configUnlockAll = Boolean(result.unlockAll);
      if (!currentExe) state.dlc.method = result.installed ? "cream" : state.dlc.exes.some((item) => item.proxy) ? "smaki" : "cream";
      const selector = $("#dlc-exe-select"); selector.replaceChildren();
      for (const item of state.dlc.exes) {
        const option = document.createElement("option"); option.value = item.path;
        option.textContent = `${item.relativePath} · ${item.bitness}${item.recommended ? " ★" : ""}`;
        selector.append(option);
      }
      selector.value = state.dlc.exePath;
      $("#dlc-unlock-all").checked = true;
      restoreDlcSelection();
      $("#dlc-path").value = result.gameDir;
      renderDlcGame();

      log(`Библиотек steam_api найдено: ${state.dlc.targets.length}`, state.dlc.targets.length ? "info" : "error");
      if (!state.dlc.targets.length) toast("В папке не найдена библиотека steam_api", "error");
      if (result.detected) log(`Игра определена: ${state.dlc.name} · AppID ${state.dlc.appid}`, "success");
      else log("Steam AppID не определён автоматически. Используйте ручной поиск.", "error");
      if (state.dlc.installed) log("В игре уже установлен DLC-анлокер", "info");
      await loadDlcCatalog(state.dlc.appid, token);
      if (token !== state.dlc.requestId) return;
      toast("Готово: игра проанализирована");
    } catch (error) {
      if (token !== state.dlc.requestId) return;
      $("#dlc-library-status").textContent = errorText(error);
      log(`Определение не выполнено: ${errorText(error)}`, "error");
      toast(errorText(error), "error");
    } finally {
      if (token === state.dlc.requestId) {
        setBusy(button, false);
        state.dlc.scanning = false;
        renderDlcLibrary();
        updateDlcSelection();
      }
    }
  }

  async function chooseDlcDirectory() {
    const button = $("#dlc-browse-button");
    setBusy(button, true, "Открываем…");
    try {
      const path = await call("pick_game_directory");
      if (path) await scanDlcDirectory(path);
    } catch (error) {
      toast(errorText(error), "error");
    } finally {
      setBusy(button, false);
    }
  }

  async function dlcManualSearch() {
    if (state.dlc.operating || state.dlc.scanning || state.dlc.catalogLoading) return;
    const query = $("#dlc-manual-query").value.trim();
    if (!query) return toast("Введите название игры", "error");
    const button = $("#dlc-manual-button");
    const token = ++state.dlc.requestId;
    setBusy(button, true, "Поиск…");
    log(`DLC Unlocker · поиск в Steam: «${query}»`, "system");
    try {
      const game = await call("search_game", { query });
      if (token !== state.dlc.requestId) return;
      if (!game) throw new Error("Игра не найдена в Steam Store");
      state.dlc.appid = game.appid;
      state.dlc.name = game.name;
      state.dlc.banner = game.headerImage || state.dlc.banner;
      state.dlc.source = `Steam Store · ${query}`;
      state.dlc.catalog = [];
      state.dlc.loaded = false;
      state.dlc.configuredDlcs = [];
      renderDlcGame();
      log(`Выбрана игра: ${game.name} · AppID ${game.appid}`, "success");
      await loadDlcCatalog(game.appid, token);
      if (token !== state.dlc.requestId) return;
      toast("Метаданные игры обновлены");
    } catch (error) {
      if (token !== state.dlc.requestId) return;
      log(`Ошибка поиска: ${errorText(error)}`, "error");
      toast(errorText(error), "error");
    } finally {
      if (token === state.dlc.requestId) setBusy(button, false);
    }
  }

  async function installDlcUnlocker() {
    if (state.dlc.operating || state.dlc.scanning || state.dlc.catalogLoading) return;
    if (!state.dlc.gameDir) return toast("Сначала выберите папку игры", "error");
    if (!state.dlc.appid) return toast("Сначала определите Steam AppID (ручной поиск)", "error");
    const smaki = state.dlc.method === "smaki";
    if (smaki && !["x64", "x86"].includes(dlcExe()?.bitness)) return toast("SmokeAPI поддерживает только x64 и x86 EXE", "error");
    if (!smaki && !state.dlc.targets.length) return toast("В папке не найдена библиотека steam_api", "error");
    const unlockAll = $("#dlc-unlock-all").checked;
    const selected = unlockAll ? state.dlc.catalog.slice() : state.dlc.catalog.filter((item) => item.enabled);
    if (!unlockAll && !selected.length) return toast("Выберите хотя бы одно DLC или включите «Разблокировать все»", "error");

    const target = { ...state.dlc, exePath: state.dlc.exePath };
    const button = $("#dlc-install-button");
    state.dlc.operating = true;
    renderDlcMethod();
    setBusy(button, true, "Устанавливаем…");
    log(`Установка DLC Unlocker · AppID ${state.dlc.appid} · ${unlockAll ? "все DLC" : selected.length + " DLC"}`, "system");
    try {
      const accepted = await showModal(
        dlcInstalled() ? "Переустановить DLC Unlocker?" : "Установить DLC Unlocker?",
        smaki ? `SmokeAPI: ${target.proxy}\n${target.exePath.replace(/[^\\/]+$/, target.proxy)}\nБиблиотеки Steam не изменяются. DLC-файлы должны уже присутствовать в игре.` : `CreamAPI: библиотека Steam будет подменена в ${target.targets.length} директориях. Оригиналы сохраняются и восстанавливаются при удалении.`,
        { confirm: true, confirmText: dlcInstalled() ? "Переустановить" : "Установить", symbol: "↓" },
      );
      if (!accepted) return;
      const request = {
        gameDir: target.gameDir,
        appid: Number(target.appid),
        dlcs: Object.fromEntries(selected.map((item) => [item.id, item.name])),
        unlockAll,
        extraProtection: $("#dlc-extra-protection").checked,
      };
      if (smaki) { request.exePath = target.exePath; request.proxy = target.proxy; }
      const result = await call(smaki ? "install_smaki" : "install_dlc_unlocker", { request });
      if (consumeResult(result)) {
        await scanDlcDirectory(target.gameDir, null, true);
        await showModal("Анлокер установлен", smaki ? "Прокси установлен рядом с EXE. Библиотеки Steam не изменялись." : "Библиотека Steam подменена, оригинал сохранён. Запустите игру и проверьте доступ к DLC.", { symbol: "✓" });
      }
    } catch (error) {
      log(`Ошибка установки: ${errorText(error)}`, "error");
      toast(errorText(error), "error");
    } finally {
      setBusy(button, false);
      state.dlc.operating = false;
      renderDlcMethod();
    }
  }

  async function uninstallDlcUnlocker() {
    if (!state.dlc.gameDir || !dlcInstalled() || state.dlc.operating || state.dlc.scanning || state.dlc.catalogLoading) return;
    const smaki = state.dlc.method === "smaki";
    const target = { gameDir: state.dlc.gameDir, exePath: state.dlc.exePath };
    const button = $("#dlc-uninstall-button");
    state.dlc.operating = true;
    renderDlcMethod();
    setBusy(button, true, "Восстановление…");
    log("Удаление DLC Unlocker и восстановление оригинала", "system");
    try {
      const accepted = await showModal("Удалить DLC Unlocker?", smaki ? "Будут удалены только установленные программой прокси и конфигурация SmokeAPI рядом с выбранным EXE. Steam API не изменяется." : "Оригинальная библиотека Steam будет восстановлена из резервной копии, а cream_api.ini удалён.", { confirm: true, confirmText: "Удалить и восстановить", symbol: "↺" });
      if (!accepted) return;
      const result = await call(smaki ? "uninstall_smaki" : "uninstall_dlc_unlocker", smaki ? target : { gameDir: target.gameDir });
      if (consumeResult(result)) await scanDlcDirectory(target.gameDir, null, true);
    } catch (error) {
      log(`Ошибка удаления: ${errorText(error)}`, "error");
      toast(errorText(error), "error");
    } finally {
      setBusy(button, false);
      state.dlc.operating = false;
      renderDlcMethod();
    }
  }

  function steamHeaderUrls(appid) {
    return [
      `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`,
      `https://cdn.akamai.steamstatic.com/steam/apps/${appid}/header.jpg`,
      `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appid}/header.jpg`,
    ];
  }

  function loadCover(cover, img, appid) {
    const key = String(appid);
    // Проверяем сохранённый URL обложки из кэша
    const cached = state.lua.headers[key];
    if (cached) {
      img.onload = () => cover.classList.add("loaded");
      img.onerror = () => tryStaticUrls();
      img.src = cached;
      return;
    }

    tryStaticUrls();

    function tryStaticUrls() {
      const urls = steamHeaderUrls(appid);
      let index = 0;
      img.onload = () => cover.classList.add("loaded");
      img.onerror = async () => {
        index += 1;
        if (index < urls.length) {
          img.src = urls[index];
        } else {
          // Если статические пути вернули 404, запрашиваем точный URL обложки из Steam Store API
          try {
            const storeUrl = await call("game_artwork_store_url", { appid: Number(appid) });
            if (storeUrl) {
              state.lua.headers[key] = storeUrl;
              saveStoredLuaCover(key, storeUrl);
              img.onload = () => cover.classList.add("loaded");
              img.onerror = () => cover.classList.remove("loaded");
              img.src = storeUrl;
              return;
            }
          } catch (_) {}
          cover.classList.remove("loaded");
        }
      };
      img.src = urls[0];
    }
  }

  function renderLuaGames() {
    const container = $("#lua-games");
    const empty = $("#lua-empty");
    const games = state.lua.games;
    const renderId = ++luaDrmRenderId;
    luaDrmObserver?.disconnect();
    luaDrmQueue.clear();
    clearTimeout(luaDrmQueueTimer);
    container.replaceChildren();
    container.classList.toggle("hidden", games.length === 0);
    empty.classList.toggle("hidden", games.length > 0);
    if (!games.length) return;

    luaDrmObserver = "IntersectionObserver" in window
      ? new IntersectionObserver((entries) => {
          entries.forEach((entry) => {
            if (!entry.isIntersecting) return;
            luaDrmObserver?.unobserve(entry.target);
            const badge = entry.target.querySelector(".lua-drm-badge");
            if (badge) queueDrmBadge(entry.target.dataset.appid, badge, renderId);
          });
        }, { root: null, rootMargin: "120px 0px" })
      : null;

    games.forEach((game) => {
      const card = document.createElement("div");
      const needsAttention = game.status === "missing_manifests" || game.status === "invalid_lua";
      card.className = `lua-game${game.enabled ? "" : " disabled"}${needsAttention ? " needs-attention" : ""}`;
      card.dataset.appid = String(game.appid);

      const cover = document.createElement("div");
      cover.className = "lua-game-cover";
      const img = document.createElement("img");
      const fallback = document.createElement("span");
      fallback.className = "lua-cover-fallback";
      fallback.textContent = game.appid;
      cover.append(img, fallback);
      loadCover(cover, img, game.appid);
      cover.style.cursor = "pointer";
      cover.title = "Подробнее";
      cover.addEventListener("click", () => luaOpenDetail(game.appid));

      const info = document.createElement("div");
      info.className = "lua-game-info";
      const title = document.createElement("strong");
      title.textContent = state.lua.names[game.appid] || `AppID ${game.appid}`;
      title.title = title.textContent;
      const status = document.createElement("span");
      const statusKey = game.status || (game.enabled ? "ready" : "disabled");
      status.className = `lua-game-status ${statusKey}`;
      if (statusKey === "missing_manifests") {
        status.textContent = `Нет manifest: ${game.missingManifestCount || 0}`;
        status.title = `Установлено: ${game.manifestCount || 0}. Отсутствует: ${game.missingManifestCount || 0}.`;
      } else if (statusKey === "invalid_lua") {
        status.textContent = "Lua повреждён";
        status.title = "Lua-файл пустой, недоступен или не содержит addappid";
      } else if (statusKey === "disabled") {
        status.textContent = "Отключена";
      } else {
        status.textContent = game.manifestCount ? `Готова · ${game.manifestCount} manifest` : "Готова";
      }
      const infoMain = document.createElement("div");
      infoMain.className = "lua-game-info-main";
      infoMain.append(title, status);
      const drmBadge = document.createElement("span");
      drmBadge.className = "lua-drm-badge loading";
      drmBadge.textContent = "Защита…";
      drmBadge.title = "Получаем сведения о защите из Steam";
      info.append(infoMain, drmBadge);

      const actions = document.createElement("div");
      actions.className = "lua-game-actions";
      const details = document.createElement("button");
      details.className = "ghost-button lua-action-btn lua-action-details";
      details.textContent = "Подробнее";
      details.addEventListener("click", () => luaOpenDetail(game.appid));
      const toggle = document.createElement("button");
      toggle.className = `ghost-button lua-action-btn lua-action-toggle${game.enabled ? "" : " is-disabled"}`;
      toggle.textContent = game.enabled ? "Отключить" : "Включить";
      toggle.addEventListener("click", () => luaToggle(game.appid, !game.enabled));
      const remove = document.createElement("button");
      remove.className = "ghost-button danger-ghost lua-action-btn lua-action-remove";
      remove.textContent = "Удалить";
      remove.addEventListener("click", () => luaRemove(game.appid));
      actions.append(details, toggle, remove);

      card.append(cover, info, actions);
      container.appendChild(card);
      const cachedDrm = luaDrmCache.get(String(game.appid));
      if (cachedDrm) applyDrmBadge(drmBadge, cachedDrm);
      else if (luaDrmObserver) luaDrmObserver.observe(card);
      else queueDrmBadge(game.appid, drmBadge, renderId);
    });
  }

  async function luaLoadNames() {
    const missingNames = state.lua.games.map((g) => g.appid).filter((id) => !state.lua.names[id]);
    const missingHeaders = state.lua.games.map((g) => g.appid).filter((id) => !state.lua.headers[id]);
    if (!missingNames.length && !missingHeaders.length) return;
    try {
      const [names, headers] = await Promise.all([
        missingNames.length ? call("luatools_names", { appids: missingNames.map(Number) }) : null,
        missingHeaders.length ? call("luatools_headers", { appids: missingHeaders.map(Number) }) : null,
      ]);
      if (names) Object.assign(state.lua.names, names);
      if (headers) {
        Object.assign(state.lua.headers, headers);
        try {
          const stored = loadStoredLuaCovers();
          Object.assign(stored, headers);
          window.cgsStorage.setItem(LUA_COVERS_STORAGE_KEY, JSON.stringify(stored));
        } catch (_) {}
      }
      renderLuaGames();
    } catch (error) {
      log(`Не удалось получить сведения об играх: ${errorText(error)}`, "info");
    }
  }

  function luaDetailDate(unix) {
    if (!unix) return "";
    return new Date(Number(unix) * 1000).toLocaleDateString(window.cgsI18n?.locale?.() || "ru-RU", { day: "2-digit", month: "short", year: "numeric" });
  }

  function renderDepotList(container, items) {
    container.replaceChildren();
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "empty-inline";
      empty.textContent = "Ничего нет";
      container.appendChild(empty);
      return;
    }
    items.forEach((item) => {
      const row = document.createElement("div");
      row.className = "lua-depot";
      const copy = document.createElement("div");
      copy.className = "lua-depot-copy";
      const name = document.createElement("strong");
      name.textContent = item.name;
      name.title = item.name;
      const id = document.createElement("code");
      id.textContent = item.id;
      copy.append(name, id);
      row.append(copy);
      const badge = document.createElement("span");
      badge.className = "lua-depot-badge";
      badge.textContent = "DLC";
      row.append(badge);
      container.appendChild(row);
    });
  }

  async function luaOpenDetail(appid) {
    const backdrop = $("#lua-detail-backdrop");
    $("#lua-detail-name").textContent = state.lua.names[appid] || `AppID ${appid}`;
    $("#lua-detail-appid").textContent = appid;
    $("#lua-detail-added").textContent = "";
    $("#lua-detail-released").textContent = "";
    $("#lua-detail-fallback").textContent = appid;
    const banner = $("#lua-detail-banner");
    banner.removeAttribute("src");
    banner.parentElement.classList.remove("loaded");
    loadCover(banner.parentElement, banner, appid);
    const loading = () => { const d = document.createElement("div"); d.className = "empty-inline"; d.textContent = "Загрузка из Steam…"; return d; };
    $("#lua-detail-in").replaceChildren(loading());
    $("#lua-detail-missing").replaceChildren();
    $("#lua-detail-in-count").textContent = "(…)";
    $("#lua-detail-missing-count").textContent = "(…)";
    backdrop.classList.remove("hidden");

    try {
      const detail = await call("luatools_game_detail", { appid, steamPath: state.lua.steamPath || null });
      if (detail.name) { $("#lua-detail-name").textContent = detail.name; state.lua.names[appid] = detail.name; }
      if (detail.header) {
        state.lua.headers[appid] = detail.header;
        saveStoredLuaCover(appid, detail.header);
        banner.src = detail.header;
        banner.parentElement.classList.add("loaded");
      }
      $("#lua-detail-added").textContent = detail.addedUnix ? `Добавлено ${luaDetailDate(detail.addedUnix)}` : "";
      $("#lua-detail-released").textContent = detail.releaseDate ? `Вышла ${detail.releaseDate}` : "";
      $("#lua-detail-in-count").textContent = `(${detail.inLua.length})`;
      $("#lua-detail-missing-count").textContent = `(${detail.missing.length})`;
      renderDepotList($("#lua-detail-in"), detail.inLua);
      renderDepotList($("#lua-detail-missing"), detail.missing);
    } catch (error) {
      $("#lua-detail-in-count").textContent = "(0)";
      $("#lua-detail-missing-count").textContent = "(0)";
      toast(errorText(error), "error");
    }
  }

  function renderLuaStatus() {
    const { steamPath, luaFolder, loaderStatus, loaderName, loaderIssue, games } = state.lua;
    $("#lua-count").textContent = games.length.toLocaleString(window.cgsI18n?.locale?.() || "ru-RU");
    $("#lua-steam-path").value = steamPath || "";
    if (loaderIssue) {
      $("#lua-steam-hint").textContent = loaderIssue;
    } else if (steamPath && luaFolder) {
      const relative = luaFolder.toLowerCase().startsWith(steamPath.toLowerCase())
        ? luaFolder.slice(steamPath.length).replace(/^[\\/]+/, "")
        : luaFolder;
      $("#lua-steam-hint").textContent = `${loaderName || "SteamTools"} · Lua: ${relative}`;
    } else {
      $("#lua-steam-hint").textContent = steamPath
        ? `Загрузчик: ${loaderStatus}`
        : "Steam не найден — укажите папку вручную";
    }
    renderMillenniumStatus();
    renderLoaderInfo();
    renderLuaGames();
    updateAboutInfo();
  }

  function renderMillenniumStatus() {
    const info = state.lua.millennium || {};
    const badge = $("#millennium-plugin-badge");
    const installButton = $("#millennium-install-button");
    const installLabel = installButton.querySelector("span");
    const migrateButton = $("#millennium-migrate-button");
    const siteButton = $("#millennium-site-button");
    const removeButton = $("#millennium-remove-button");

    const labels = {
      checking: "Проверка…",
      steam_missing: "Steam не найден",
      steam_invalid: "Неверная папка Steam",
      millennium_missing: "Millennium не установлен",
      croclua_detected: "Обнаружен CrocLua",
      plugin_missing: "Плагин не установлен",
      update_available: `Обновление · ${info.bundledVersion || ""}`,
      ready: `Установлен · ${info.pluginVersion || info.bundledVersion || ""}`,
    };
    badge.textContent = labels[info.status] || "Неизвестный статус";
    badge.className = "millennium-plugin-badge";
    if (info.status === "ready") badge.classList.add("ready");
    else if (["plugin_missing", "update_available", "croclua_detected"].includes(info.status)) badge.classList.add("warning");
    else if (["steam_missing", "steam_invalid", "millennium_missing"].includes(info.status)) badge.classList.add("error");
    else badge.classList.add("checking");

    const canInstall = Boolean(info.millenniumInstalled) && !["checking", "steam_invalid", "steam_missing"].includes(info.status);
    installButton.disabled = !canInstall;
    installButton.classList.toggle("hidden", info.status === "croclua_detected" || !["plugin_missing", "update_available"].includes(info.status));
    siteButton.classList.toggle("hidden", info.status !== "millennium_missing");
    removeButton.classList.toggle("hidden", !info.pluginInstalled);

    if (migrateButton) {
      const showMigrate = Boolean(info.legacyCrocluaFound) && Boolean(info.millenniumInstalled);
      migrateButton.classList.toggle("hidden", !showMigrate);
      const migrateLabel = migrateButton.querySelector("span");
      if (migrateLabel) {
        migrateLabel.textContent = info.pluginInstalled
          ? "Удалить старый CrocLua"
          : "Заменить CrocLua на Eclipse Manifest";
      }
    }

    if (installLabel) {
      installLabel.textContent = info.status === "ready"
        ? "Переустановить"
        : info.status === "update_available"
          ? "Обновить плагин"
          : "Установить плагин";
    }
  }

  // Нормализация источника загрузчика манифестов ("v1" или "v2")
  function normalizeLoaderSource(raw) {
    return (raw === "v2" || raw === "desktop") ? "v2" : "v1";
  }

  // Отображение состояния загрузчика OpenSteamTool (вкладка манифестов и настройки)
  function renderLoaderInfo() {
    const info = state.lua.loaderInfo;
    const currentSource = normalizeLoaderSource(state.lua.loaderSource);

    // Обновляем выделение карточек (в view-lua и в view-settings)
    $$(".loader-option").forEach((card) => {
      card.classList.toggle("active", normalizeLoaderSource(card.dataset.loaderSource) === currentSource);
    });

    // Текст и оформление текущего статуса загрузчика в Steam
    const defaultLabel = currentSource === "v2" ? "Версия 2 (Альтернативная)" : "Версия 1 (Основная)";
    const activeLabel = info?.activeInSteamLabel || defaultLabel;
    const activeKind = info?.activeInSteam || currentSource;

    const manifestBadge = $("#manifest-loader-active-badge");
    const settingsBadge = $("#settings-loader-active-badge");

    [manifestBadge, settingsBadge].forEach((badge) => {
      if (!badge) return;
      badge.textContent = `В Steam: ${activeLabel}`;
      badge.className = "manifest-loader-badge";
      if (activeKind === "v1" || activeKind === "v2" || activeKind === "bundled" || activeKind === "desktop") {
        badge.classList.add("ready");
      } else if (activeKind === "custom" || activeKind === "mismatch") {
        badge.classList.add("warning");
      } else if (activeKind === "none") {
        badge.classList.add("error");
      } else {
        badge.classList.add("checking");
      }
    });
  }

  // Проверка запущенного процесса Steam с предложением завершить его
  async function ensureSteamClosedForLoader() {
    try {
      const isRunning = await call("luatools_is_steam_running");
      if (!isRunning) return true;

      const shouldClose = await showModal(
        "Steam запущен",
        "Клиент Steam в данный момент запущен и блокирует файлы загрузчика OpenSteamTool.\n\nЗавершить процесс Steam сейчас, чтобы применить выбранную версию?",
        { confirm: true, confirmText: "Завершить Steam", cancelText: "Отмена", symbol: "⚠" }
      );
      if (!shouldClose) return false;

      toast("Завершаем процесс Steam…");
      const closeResult = await call("luatools_close_steam", { steamPath: state.lua.steamPath || null });
      if (closeResult && !closeResult.success) {
        toast(closeResult.message || "Не удалось завершить Steam", "error");
        return false;
      }
      return true;
    } catch (_) {
      return true;
    }
  }

  // Переключение источника загрузчика манифестов
  async function applyLoaderSource(source) {
    const valid = normalizeLoaderSource(source);

    // Если Steam запущен, предлагаем его завершить перед перезаписью файлов
    const canProceed = await ensureSteamClosedForLoader();
    if (!canProceed) {
      renderLoaderInfo();
      return;
    }

    state.lua.loaderSource = valid;
    window.cgsStorage.setItem("manifestLoaderSource", valid);
    renderLoaderInfo();

    try {
      const result = await call("luatools_set_loader_source", {
        source: valid,
        steamPath: state.lua.steamPath || null,
      });

      if (result && !result.success) {
        toast(result.message || "Ошибка применения загрузчика", "error");
      } else {
        const verName = valid === "v2" ? "Версия 2 (Альтернативная)" : "Версия 1 (Основная)";
        toast(result?.message || `Выбрана ${verName}`, "success");
        await luaRefresh();

        // Предлагаем запустить Steam для применения изменений
        const shouldRestart = await showModal(
          "Версия загрузчика обновлена",
          `В Steam установлена ${verName} OpenSteamTool.\n\nЗапустить клиент Steam сейчас?`,
          { confirm: true, confirmText: "Запустить Steam", cancelText: "Позже", symbol: "✓" }
        );
        if (shouldRestart) {
          const restartResult = await call("luatools_restart_steam", { steamPath: state.lua.steamPath || null });
          consumeResult(restartResult);
        }
      }
    } catch (error) {
      toast(errorText(error), "error");
    }
  }

  // Принудительная установка выбранной версии загрузчика в Steam
  async function applyLoaderToSteam(triggerButton) {
    // Если Steam запущен, предлагаем его завершить перед перезаписью файлов
    const canProceed = await ensureSteamClosedForLoader();
    if (!canProceed) return;

    if (triggerButton) setBusy(triggerButton, true, "Применяем…");
    try {
      const result = await call("luatools_apply_loader", {
        steamPath: state.lua.steamPath || null,
      });
      if (consumeResult(result)) {
        await luaRefresh();
        const shouldRestart = await showModal(
          "Загрузчик обновлен в Steam",
          `${result.message}\n\nЧтобы применить изменения, требуется запустить клиент Steam. Запустить сейчас?`,
          { confirm: true, confirmText: "Запустить Steam", cancelText: "Позже", symbol: "✓" }
        );
        if (shouldRestart) {
          const restartResult = await call("luatools_restart_steam", { steamPath: state.lua.steamPath || null });
          consumeResult(restartResult);
        }
      }
    } catch (error) {
      toast(errorText(error), "error");
    } finally {
      if (triggerButton) setBusy(triggerButton, false);
      renderLoaderInfo();
    }
  }

  const LOADER_POSTPONE_LAUNCH_COUNT = 5;

  // Проверка: нужно ли показывать напоминание об обновлении DLL загрузчика при запуске
  function shouldPromptLoaderStartupUpdate() {
    try {
      const launchesLeftStr = window.cgsStorage.getItem("cgs-postpone-loader-launches");
      if (!launchesLeftStr) return true;
      const launchesLeft = Number(launchesLeftStr) || 0;
      if (launchesLeft > 0) {
        window.cgsStorage.setItem("cgs-postpone-loader-launches", String(launchesLeft - 1));
        return false;
      }
      window.cgsStorage.removeItem("cgs-postpone-loader-launches");
      return true;
    } catch (_) {
      return true;
    }
  }

  // Отложить напоминание об обновлении DLL загрузчика на 5 запусков
  function postponeLoaderUpdate() {
    try {
      window.cgsStorage.setItem("cgs-postpone-loader-launches", String(LOADER_POSTPONE_LAUNCH_COUNT));
    } catch (_) {}
  }

  // Сбросить отсрочку напоминания об обновлении DLL загрузчика
  function clearLoaderPostpone() {
    try {
      window.cgsStorage.removeItem("cgs-postpone-loader-launches");
    } catch (_) {}
  }

  // Закрытие модального окна обновления библиотек загрузчика
  function closeLoaderUpdateModal() {
    const backdrop = $("#loader-update-backdrop");
    if (!backdrop) return;
    backdrop.classList.add("closing");
    setTimeout(() => {
      backdrop.classList.add("hidden");
      backdrop.classList.remove("closing");
    }, 190);
  }

  // Отображение модального окна обновления библиотек OpenSteamTool
  function promptLoaderUpdateModal(updateInfo) {
    if (!updateInfo) return;
    const isEn = window.cgsI18n?.language === "en";
    const backdrop = $("#loader-update-backdrop");
    const bundleNameEl = $("#loader-modal-bundle-name");
    const badgeEl = $("#loader-modal-bundle-badge");
    const fileListEl = $("#loader-modal-file-list");
    const cancelBtn = $("#loader-modal-cancel");
    const snoozeBtn = $("#loader-modal-snooze");
    const confirmBtn = $("#loader-modal-confirm");

    if (!backdrop || !fileListEl) return;

    // Определяем имя комплекта по выбранному варианту
    const selectedVariant = updateInfo.selectedVariant || state.lua.loaderSource || "standard";
    const isV2 = selectedVariant === "compatibility" || selectedVariant === "v2" || selectedVariant === "desktop";
    if (bundleNameEl) {
      bundleNameEl.textContent = isV2
        ? (isEn ? "Версия 2 (Альтернативная)" : "Версия 2 (Альтернативная)")
        : (isEn ? "Версия 1 (Основная)" : "Версия 1 (Основная)");
    }

    // Отображение статуса комплекта
    if (badgeEl) {
      const isUpToDate = !updateInfo.updateAvailable;
      badgeEl.dataset.status = isUpToDate ? "synced" : "update";
      badgeEl.textContent = isUpToDate
        ? (isEn ? "Актуально" : "Актуально")
        : (isEn ? "Обновление" : "Обновление");
    }

    // Очистка и наполнение списка файлов комплекта
    fileListEl.innerHTML = "";
    const activeVariant = updateInfo.variants?.find((v) => v.variant === selectedVariant)
      || updateInfo.variants?.find((v) => v.updateAvailable)
      || updateInfo.variants?.[0];

    const files = activeVariant?.files || [];
    if (files.length === 0) {
      const emptyItem = document.createElement("div");
      emptyItem.className = "loader-file-item";
      emptyItem.textContent = isEn ? "No files detected" : "Файлы не обнаружены";
      fileListEl.appendChild(emptyItem);
    } else {
      // Функция форматирования размера DLL в мегабайтах с обработкой отсутствующего файла
      const formatDllSize = (bytes) => {
        if (bytes === null || bytes === undefined) {
          return isEn ? "missing" : "отсутствует";
        }
        if (bytes === 0) return isEn ? "0 MB" : "0 МБ";
        return (bytes / 1024 / 1024).toFixed(2) + (isEn ? " MB" : " МБ");
      };

      files.forEach((file) => {
        const item = document.createElement("div");
        item.className = "loader-file-item";

        const nameSpan = document.createElement("span");
        nameSpan.className = "loader-file-name";
        nameSpan.textContent = file.path;

        const stateWrap = document.createElement("div");
        stateWrap.className = "loader-file-state";

        // Отображение конкретного веса старой (текущей) и новой скачиваемой DLL
        const oldSpan = document.createElement("span");
        oldSpan.className = "loader-file-size-old";
        oldSpan.innerHTML = `<small>${isEn ? "Current:" : "Текущий:"}</small><strong>${formatDllSize(file.currentBytes)}</strong>`;

        const arrow = document.createElement("span");
        arrow.className = "loader-file-size-arrow";
        arrow.textContent = "→";

        const newSpan = document.createElement("span");
        newSpan.className = "loader-file-size-new";
        if (file.currentBytes != null && file.currentBytes !== file.bytes) {
          newSpan.classList.add("highlight");
        }
        newSpan.innerHTML = `<small>${isEn ? "New:" : "Новый:"}</small><strong>${formatDllSize(file.bytes)}</strong>`;

        stateWrap.appendChild(oldSpan);
        stateWrap.appendChild(arrow);
        stateWrap.appendChild(newSpan);

        item.appendChild(nameSpan);
        item.appendChild(stateWrap);
        fileListEl.appendChild(item);
      });
    }

    backdrop.classList.remove("hidden", "closing");

    if (cancelBtn) {
      cancelBtn.onclick = () => closeLoaderUpdateModal();
    }

    if (snoozeBtn) {
      snoozeBtn.onclick = () => {
        postponeLoaderUpdate();
        closeLoaderUpdateModal();
        toast(isEn ? "Library update postponed for 5 launches" : "Обновление библиотек отложено на 5 запусков");
      };
    }

    if (confirmBtn) {
      confirmBtn.onclick = async () => {
        setBusy(confirmBtn, true, isEn ? "Updating…" : "Обновление…");
        try {
          const ok = await performLoaderUpdate(selectedVariant);
          if (ok) {
            closeLoaderUpdateModal();
          }
        } finally {
          setBusy(confirmBtn, false);
        }
      };
    }
  }

  // Выполнение обновления библиотек OpenSteamTool с проверкой запущенного Steam
  async function performLoaderUpdate(variant) {
    const isEn = window.cgsI18n?.language === "en";

    // Проверяем, запущен ли Steam
    const canProceed = await ensureSteamClosedForLoader();
    if (!canProceed) return false;

    toast(isEn ? "Updating OpenSteamTool libraries…" : "Обновление библиотек OpenSteamTool…");
    try {
      const result = await call("luatools_update_loader", {
        steamPath: state.lua.steamPath || null,
        variant: variant || state.lua.loaderSource || null,
      });

      if (result && !result.success) {
        toast(result.message || (isEn ? "Failed to update libraries" : "Не удалось обновить библиотеки"), "error");
        return false;
      }

      // Сбрасываем счетчик отсрочки и скрываем баннер
      clearLoaderPostpone();
      $("#loader-update-banner")?.classList.add("hidden");
      if (state.lua.loaderUpdate) {
        state.lua.loaderUpdate.updateAvailable = false;
      }

      // Закрываем список обновлений DLL перед показом итогового диалога
      closeLoaderUpdateModal();

      toast(result?.message || (isEn ? "OpenSteamTool libraries updated successfully" : "Библиотеки OpenSteamTool успешно обновлены"), "success");
      await luaRefresh();

      // Кидаем на экран уведомление о том, что всё успешно обновилось, и предлагаем запустить Steam
      const shouldRestart = await showModal(
        isEn ? "Libraries updated" : "Библиотеки обновлены",
        isEn
          ? "OpenSteamTool libraries were successfully updated in Steam.\n\nLaunch Steam client now?"
          : "Библиотеки OpenSteamTool успешно обновлены в Steam.\n\nЗапустить клиент Steam сейчас?",
        {
          confirm: true,
          confirmText: isEn ? "Launch Steam" : "Запустить Steam",
          cancelText: isEn ? "Later" : "Позже",
          symbol: "✓",
        }
      );
      if (shouldRestart) {
        const restartResult = await call("luatools_restart_steam", { steamPath: state.lua.steamPath || null });
        consumeResult(restartResult);
      }
      return true;
    } catch (error) {
      toast(errorText(error), "error");
      return false;
    }
  }

  // Проверка обновлений библиотек OpenSteamTool с GitHub
  async function checkLoaderDllUpdates(interactive = false, force = false) {
    if (state.lua.loaderChecking) return null;
    state.lua.loaderChecking = true;
    const isEn = window.cgsI18n?.language === "en";

    const syncBtn = $("#manifest-loader-sync-btn");
    const settingsSyncBtn = $("#settings-loader-sync-btn");
    if (interactive) {
      if (syncBtn) setBusy(syncBtn, true, isEn ? "Checking…" : "Проверка…");
      if (settingsSyncBtn) setBusy(settingsSyncBtn, true, isEn ? "Checking…" : "Проверка…");
    }

    try {
      const updateInfo = await call("luatools_check_loader_updates", {
        steamPath: state.lua.steamPath || null,
        force,
      });
      state.lua.loaderUpdate = updateInfo;

      // Видимость баннера обновлений LuaTools
      const banner = $("#loader-update-banner");
      if (banner) {
        banner.classList.toggle("hidden", !updateInfo?.updateAvailable);
      }

      if (interactive) {
        if (updateInfo?.updateAvailable) {
          promptLoaderUpdateModal(updateInfo);
        } else {
          toast(isEn ? "You already have the latest libraries installed" : "У вас уже установлены актуальные библиотеки", "info");
        }
      }

      return updateInfo;
    } catch (error) {
      const msg = errorText(error);
      log(`Проверка обновлений библиотек OpenSteamTool: ${msg}`, "warn");
      if (interactive) {
        toast(`${isEn ? "Failed to check library updates" : "Не удалось проверить обновления библиотек"}: ${msg}`, "error");
      }
      return null;
    } finally {
      state.lua.loaderChecking = false;
      if (syncBtn) setBusy(syncBtn, false);
      if (settingsSyncBtn) setBusy(settingsSyncBtn, false);
    }
  }

  // Функция тестирования окна и процесса обновления библиотек OpenSteamTool
  async function testLoaderUpdate(triggerButton) {
    const isEn = window.cgsI18n?.language === "en";
    if (triggerButton) setBusy(triggerButton, true, isEn ? "Testing…" : "Тест…");

    try {
      let info = null;
      try {
        info = await call("luatools_check_loader_updates", {
          steamPath: state.lua.steamPath || null,
          force: true,
        });
      } catch (err) {
        log(`Проверка обновлений библиотек для теста: ${err}`, "info");
      }

      const selectedVariant = state.lua.loaderSource || "v1";

      // Без данных бэкенда используем демонстрационный список библиотек
      if (!info || !info.variants || !info.variants.length) {
        info = {
          selectedVariant,
          updateAvailable: true,
          variants: [
            {
              variant: "v1",
              name: isEn ? "Version 1 (Primary)" : "Версия 1 (Основная)",
              available: true,
              updateAvailable: true,
              status: "update",
              files: [
                { path: "OpenSteamTool.dll", bytes: 1583104, currentBytes: 1515520, status: "changed" },
                { path: "dwmapi.dll", bytes: 114688, currentBytes: 112640, status: "changed" },
                { path: "xinput1_4.dll", bytes: 122880, currentBytes: null, status: "missing" },
              ],
            },
            {
              variant: "v2",
              name: isEn ? "Version 2 (Alternative)" : "Версия 2 (Альтернативная)",
              available: true,
              updateAvailable: true,
              status: "update",
              files: [
                { path: "bin/OpenSteamTool.dll", bytes: 1782579, currentBytes: 1720320, status: "changed" },
                { path: "bin/dwmapi.dll", bytes: 114688, currentBytes: 112640, status: "changed" },
              ],
            },
          ],
        };
      } else {
        // Клонируем объект данных, чтобы принудительно перевести модальное окно в режим обновления
        info = JSON.parse(JSON.stringify(info));
        info.updateAvailable = true;

        // В деморежиме различаем размеры одинаковых версий для проверки подсветки
        info.variants?.forEach((v) => {
          v.updateAvailable = true;
          let hasDiff = false;
          v.files?.forEach((f) => {
            if (f.currentBytes !== f.bytes) {
              hasDiff = true;
            }
          });
          if (!hasDiff && v.files && v.files.length > 0) {
            v.files[0].currentBytes = Math.round(v.files[0].bytes * 0.95);
          }
        });
      }

      state.lua.loaderUpdate = info;
      promptLoaderUpdateModal(info);
    } finally {
      if (triggerButton) setBusy(triggerButton, false);
    }
  }

  async function downloadMillenniumInstaller() {
    const button = $("#millennium-site-button");
    setBusy(button, true, "Устанавливаем…");
    try {
      const result = await call("millennium_install_bundled", { steamPath: state.lua.steamPath || null });
      if (!consumeResult(result)) return;
      await luaRefresh();
      if (!state.lua.millennium?.pluginInstalled) {
        const installPlugin = await showModal(
          "Millennium установлен",
          "Файлы размещены прямо в папке Steam. Установить Eclipse Manifest сейчас? После этого потребуется полностью перезапустить Steam.",
          { confirm: true, confirmText: "Установить плагин", cancelText: "Позже", symbol: "🌒" },
        );
        if (installPlugin) await installMillenniumPlugin();
      }
    } catch (error) {
      toast(errorText(error), "error");
    } finally {
      setBusy(button, false);
      renderMillenniumStatus();
    }
  }

  async function offerMillenniumInstall() {
    const accepted = await showModal(
      "Для плагина нужен Millennium",
      "Eclipse Manifest установит встроенные файлы Millennium напрямую в выбранную папку Steam — без отдельного установщика. После установки потребуется полностью перезапустить Steam.",
      { confirm: true, confirmText: "Установить", cancelText: "Позже", symbol: "M" },
    );
    if (accepted) await downloadMillenniumInstaller();
  }

  const CROCLUA_POSTPONE_LAUNCH_COUNT = 5;

  // Проверка: нужно ли показывать предложение удалить CrocLua (с учётом отсрочки на 5 перезапусков)
  function shouldPromptCrocluaMigration() {
    try {
      const launchesLeftStr = window.cgsStorage.getItem("cgs-postpone-croclua-launches");
      if (!launchesLeftStr) return true;
      const launchesLeft = Number(launchesLeftStr) || 0;
      if (launchesLeft > 0) {
        window.cgsStorage.setItem("cgs-postpone-croclua-launches", String(launchesLeft - 1));
        return false;
      }
      window.cgsStorage.removeItem("cgs-postpone-croclua-launches");
      return true;
    } catch (_) {
      return true;
    }
  }

  // Отложить напоминание о CrocLua на 5 перезапусков приложения
  function postponeCrocluaMigration() {
    try {
      window.cgsStorage.setItem("cgs-postpone-croclua-launches", String(CROCLUA_POSTPONE_LAUNCH_COUNT));
    } catch (_) {}
  }

  // Сбросить отсрочку напоминания о CrocLua при удалении или замене
  function clearCrocluaPostpone() {
    try {
      window.cgsStorage.removeItem("cgs-postpone-croclua-launches");
    } catch (_) {}
  }

  async function offerCrocluaMigration() {
    const accepted = await showModal(
      "Обнаружен старый плагин CrocLua",
      "В Millennium обнаружен плагин CrocLua (папка crocodile-manifest). Хотите удалить его и установить обновлённый Eclipse Manifest?",
      { confirm: true, confirmText: "Заменить на Eclipse Manifest", cancelText: "Оставить", symbol: "🌒" },
    );
    if (accepted) {
      clearCrocluaPostpone();
      await migrateCrocluaToEclipseManifest();
    } else {
      postponeCrocluaMigration();
      toast("Напоминание о CrocLua отложено на 5 перезапусков");
    }
  }

  async function migrateCrocluaToEclipseManifest() {
    const info = state.lua.millennium || {};
    const onlyRemove = Boolean(info.pluginInstalled);
    const button = $("#millennium-migrate-button");
    if (button) setBusy(button, true, onlyRemove ? "Удаляем…" : "Заменяем…");
    try {
      const result = onlyRemove
        ? await call("millennium_remove_legacy_croclua", { steamPath: state.lua.steamPath || null })
        : await call("millennium_migrate_from_croclua", { steamPath: state.lua.steamPath || null });
      if (!consumeResult(result)) return;
      clearCrocluaPostpone();
      await luaRefresh();
      const restart = await showModal(
        onlyRemove ? "CrocLua удалён" : "Eclipse Manifest установлен",
        onlyRemove
          ? "Старый плагин CrocLua удалён из Millennium. Перезапустить Steam сейчас?"
          : "Старый CrocLua удалён, Eclipse Manifest успешно установлен. Перезапустить Steam сейчас?",
        { confirm: true, confirmText: "Перезапустить Steam", cancelText: "Позже", symbol: "🌒" },
      );
      if (restart) {
        const restartResult = await call("luatools_restart_steam", { steamPath: state.lua.steamPath || null });
        consumeResult(restartResult);
      }
    } catch (error) {
      toast(errorText(error), "error");
    } finally {
      if (button) setBusy(button, false);
      renderMillenniumStatus();
    }
  }

  async function luaRefresh() {
    try {
      const [status, millennium, loaderInfo] = await Promise.all([
        call("luatools_status", { steamPath: state.lua.steamPath || null }),
        call("millennium_plugin_status", { steamPath: state.lua.steamPath || null }),
        call("luatools_get_loader_info", { steamPath: state.lua.steamPath || null }).catch(() => null),
      ]);
      state.lua.steamPath = status.steamPath || state.lua.steamPath || "";
      state.lua.luaFolder = status.luaFolder || "";
      state.lua.loaderStatus = status.loaderStatus || "unknown";
      state.lua.loaderName = status.loaderName || "";
      state.lua.loaderIssue = status.loaderIssue || "";
      state.lua.games = status.games || [];
      state.lua.millennium = millennium || state.lua.millennium;
      if (loaderInfo) {
        state.lua.loaderInfo = loaderInfo;
        state.lua.loaderSource = loaderInfo.loaderSource || state.lua.loaderSource;
      }
      state.lua.loaded = true;
      if (state.lua.steamPath) window.cgsStorage.setItem("luaSteamPath", state.lua.steamPath);
      renderLuaStatus();
      renderLoaderInfo();
      luaLoadNames();
      if (millennium?.status === "millennium_missing" && !state.lua.millenniumPrompted) {
        state.lua.millenniumPrompted = true;
        await offerMillenniumInstall();
      } else if (millennium?.legacyCrocluaFound && !state.lua.crocluaPrompted) {
        state.lua.crocluaPrompted = true;
        if (shouldPromptCrocluaMigration()) {
          await offerCrocluaMigration();
        }
      }
    } catch (error) {
      log(`LuaTools: ошибка статуса — ${errorText(error)}`, "error");
    }
  }

  let millenniumStatusRefreshing = false;

  async function refreshMillenniumStatus() {
    if (millenniumStatusRefreshing || !invoke) return;
    millenniumStatusRefreshing = true;
    try {
      const millennium = await call("millennium_plugin_status", { steamPath: state.lua.steamPath || null });
      state.lua.millennium = millennium || state.lua.millennium;
      renderMillenniumStatus();
    } catch (_) {
      // Ошибку покажет последующий полный luaRefresh
    } finally {
      millenniumStatusRefreshing = false;
    }
  }

  async function luaInstall(paths) {
    const files = (paths || []).filter(Boolean);
    if (!files.length) return;
    log(`Eclipse Manifest: добавление файлов — ${files.length}`, "system");
    try {
      const result = await call("luatools_install", {
        paths: files,
        steamPath: state.lua.steamPath || null,
        autoUpdate: $("#lua-auto-update").checked,
      });
      if (consumeResult(result)) {
        await luaRefresh();
        await showModal("Игра добавлена", "Файлы размещены в папках Steam. Нажмите «Перезапустить Steam», чтобы игра появилась в библиотеке.", { symbol: "✓" });
      }
    } catch (error) {
      log(`Ошибка добавления: ${errorText(error)}`, "error");
      toast(errorText(error), "error");
    }
  }

  async function luaBrowseFiles() {
    const button = $("#lua-browse-button");
    setBusy(button, true, "Открываем…");
    try {
      const files = await call("luatools_pick_files");
      if (files && files.length) await luaInstall(files);
    } catch (error) {
      toast(errorText(error), "error");
    } finally {
      setBusy(button, false);
    }
  }

  async function luaToggle(appid, enable) {
    try {
      const result = await call("luatools_toggle", { appid, enable, steamPath: state.lua.steamPath || null });
      if (consumeResult(result)) await luaRefresh();
    } catch (error) {
      toast(errorText(error), "error");
    }
  }

  async function luaRemove(appid) {
    const accepted = await showModal("Удалить игру из загрузчика?", `Файл lua для AppID ${appid} будет удалён. После этого перезапустите Steam.`, { confirm: true, confirmText: "Удалить", symbol: "↺" });
    if (!accepted) return;
    try {
      const result = await call("luatools_remove", { appid, steamPath: state.lua.steamPath || null });
      if (consumeResult(result)) await luaRefresh();
    } catch (error) {
      toast(errorText(error), "error");
    }
  }

  async function luaRestartSteam() {
    const accepted = await showModal("Перезапустить Steam?", "Клиент Steam будет закрыт и запущен заново, чтобы применить изменения. Незавершённые загрузки могут прерваться.", { confirm: true, confirmText: "Перезапустить", symbol: "↻" });
    if (!accepted) return;
    const button = $("#lua-restart-button");
    setBusy(button, true, "Перезапуск…");
    try {
      const result = await call("luatools_restart_steam", { steamPath: state.lua.steamPath || null });
      consumeResult(result);
    } catch (error) {
      toast(errorText(error), "error");
    } finally {
      setBusy(button, false);
    }
  }

  async function installMillenniumPlugin() {
    if (!state.lua.millennium?.millenniumInstalled) {
      await offerMillenniumInstall();
      return;
    }
    const button = $("#millennium-install-button");
    setBusy(button, true, state.lua.millennium.pluginInstalled ? "Обновляем…" : "Устанавливаем…");
    try {
      const result = await call("millennium_install_plugin", { steamPath: state.lua.steamPath || null });
      if (!consumeResult(result)) return;
      await luaRefresh();
      const restart = await showModal(
        "Eclipse Manifest установлен",
        "Плагин размещён в папке Millennium. Перезапустить Steam сейчас, чтобы он появился в настройках плагинов?",
        { confirm: true, confirmText: "Перезапустить Steam", cancelText: "Позже", symbol: "🌒" },
      );
      if (restart) {
        const restartResult = await call("luatools_restart_steam", { steamPath: state.lua.steamPath || null });
        consumeResult(restartResult);
      }
    } catch (error) {
      toast(errorText(error), "error");
    } finally {
      setBusy(button, false);
      renderMillenniumStatus();
    }
  }

  async function removeMillenniumPlugin() {
    const accepted = await showModal(
      "Удалить Eclipse Manifest?",
      "Папка плагина будет полностью удалена из Millennium. Сохранённая история операций останется на компьютере и будет доступна после повторной установки.",
      { confirm: true, confirmText: "Удалить плагин", cancelText: "Отмена", symbol: "↺" },
    );
    if (!accepted) return;

    const button = $("#millennium-remove-button");
    setBusy(button, true, "Удаляем…");
    try {
      const result = await call("millennium_remove_plugin", { steamPath: state.lua.steamPath || null });
      if (!consumeResult(result)) return;
      await luaRefresh();
      const restart = await showModal(
        "Eclipse Manifest удалён",
        "Перезапустить Steam сейчас, чтобы полностью выгрузить плагин?",
        { confirm: true, confirmText: "Перезапустить Steam", cancelText: "Позже", symbol: "✓" },
      );
      if (restart) {
        const restartResult = await call("luatools_restart_steam", { steamPath: state.lua.steamPath || null });
        consumeResult(restartResult);
      }
    } catch (error) {
      toast(errorText(error), "error");
    } finally {
      setBusy(button, false);
      renderMillenniumStatus();
    }
  }

  let luaSearchTimer = null;
  const secretSaveTimers = {};
  const secretSaveVersions = {};
  function saveApiSecret(service, input) {
    clearTimeout(secretSaveTimers[service]); delete secretSaveTimers[service];
    const value = input.value.trim(); const version = (secretSaveVersions[service] || 0) + 1;
    secretSaveVersions[service] = version;
    return window.cgsStorage.setSecret(service, value).then(configured => {
      if (version !== secretSaveVersions[service] || input.value.trim() !== value) return;
      state.lua[service + "Key"] = configured ? "stored" : "";
      input.value = "";
      input.placeholder = configured ? "Ключ сохранён в Windows. Введите новый для замены" : "Ключ не указан";
      service === "hubcap" ? updateHubcapKeyStatus() : updateRyuuKeyStatus();
    }).catch(error => { toast("Ключ не сохранён: " + errorText(error), "error"); throw error; });
  }
  window.cgsFlushSecrets = async () => {
    for (const service of Object.keys(secretSaveTimers)) {
      const input = document.querySelector(service === "hubcap" ? "#hubcap-key" : "#ryuu-key");
      if (input) await saveApiSecret(service, input);
    }
  };
  let hubcapKeyTimer = null;
  let luaDrmRenderId = 0;
  let luaDrmObserver = null;
  let luaDrmQueueTimer = null;
  const luaDrmCache = new Map();
  const luaDrmQueue = new Map();

  function applyDrmBadge(badge, info) {
    const allowedKinds = new Set(["denuvo", "launcher", "steam", "third-party", "unknown"]);
    const kind = allowedKinds.has(info?.kind) ? info.kind : "unknown";
    badge.className = `lua-drm-badge ${kind}`;
    badge.textContent = info?.label || "Не указано";
    badge.title = info?.notice || "Steam не указывает сведения о защите для этой игры.";
  }

  async function flushDrmQueue() {
    luaDrmQueueTimer = null;
    const entries = [...luaDrmQueue.values()];
    luaDrmQueue.clear();
    const active = entries.filter((entry) => entry.badge.isConnected);
    if (!active.length) return;
    const appids = [...new Set(active.map((entry) => entry.appid))];
    try {
      const batches = [];
      for (let index = 0; index < appids.length; index += 12) {
        batches.push(appids.slice(index, index + 12));
      }
      const infos = (await Promise.all(
        batches.map((batch) => call("steam_drm_info", { appids: batch }))
      )).flat();
      const byAppid = new Map();
      (infos || []).forEach((info) => {
        const appid = String(info.appid);
        luaDrmCache.set(appid, info);
        byAppid.set(appid, info);
      });
      active.forEach((entry) => {
        if (!entry.badge.isConnected || entry.renderId !== luaDrmRenderId) return;
        applyDrmBadge(entry.badge, byAppid.get(entry.appid) || {
          label: "Нет данных",
          kind: "unknown",
          notice: "Не удалось получить сведения о защите из Steam. Они появятся при следующем обновлении списка.",
        });
      });
    } catch {
      active.forEach((entry) => {
        if (!entry.badge.isConnected || entry.renderId !== luaDrmRenderId) return;
        applyDrmBadge(entry.badge, {
          label: "Нет данных",
          kind: "unknown",
          notice: "Не удалось получить сведения о защите из Steam. Они появятся при следующем обновлении списка.",
        });
      });
    }
  }

  function queueDrmBadge(appid, badge, renderId) {
    const normalized = String(appid);
    const cached = luaDrmCache.get(normalized);
    if (cached) {
      applyDrmBadge(badge, cached);
      return;
    }
    luaDrmQueue.set(normalized, { appid: normalized, badge, renderId });
    clearTimeout(luaDrmQueueTimer);
    luaDrmQueueTimer = setTimeout(flushDrmQueue, 90);
  }

  function renderSearchDropdown(results) {
    const dropdown = $("#lua-search-dropdown");
    dropdown.replaceChildren();
    if (!results.length) {
      const empty = document.createElement("div");
      empty.className = "lua-search-empty";
      empty.textContent = "Ничего не найдено";
      dropdown.append(empty);
      dropdown.classList.remove("hidden");
      return;
    }
    results.forEach((game) => {
      const row = document.createElement("button");
      row.className = "lua-search-item";
      row.type = "button";
      const img = document.createElement("img");
      img.loading = "lazy";
      img.src = game.headerImage || steamHeaderUrls(game.appid)[0];
      img.onerror = () => { img.style.visibility = "hidden"; };
      const copy = document.createElement("span");
      copy.className = "lua-search-copy";
      const name = document.createElement("strong");
      name.textContent = game.name;
      name.title = game.name;
      const id = document.createElement("code");
      id.textContent = `AppID ${game.appid}`;
      copy.append(name, id);
      const get = document.createElement("span");
      get.className = "lua-search-get";
      get.textContent = "Получить";
      row.append(img, copy, get);
      row.addEventListener("click", () => luaGet(game.appid, game.name));
      dropdown.append(row);
    });
    dropdown.classList.remove("hidden");
  }

  function luaDropdownMessage(text) {
    const dropdown = $("#lua-search-dropdown");
    dropdown.replaceChildren();
    const item = document.createElement("div");
    item.className = "lua-search-empty";
    item.textContent = text;
    dropdown.append(item);
    dropdown.classList.remove("hidden");
  }

  async function luaSearch(query) {
    const dropdown = $("#lua-search-dropdown");
    const q = String(query || "").trim();
    const hubcap = state.lua.service === "hubcap";
    const minLen = hubcap ? 3 : 2;
    if (q.length < minLen) {
      dropdown.classList.add("hidden");
      dropdown.replaceChildren();
      return;
    }
    if (hubcap && !state.lua.hubcapKey.trim()) {
      luaDropdownMessage("Укажите API-ключ HubCap в настройках");
      return;
    }
    if (!hubcap && !hasRyuuKey()) {
      luaDropdownMessage("Укажите свой API-ключ Ryuu в настройках");
      return;
    }
    $("#lua-search-spin").classList.remove("hidden");
    try {
      const results = hubcap
        ? await call("hubcap_search", { query: q })
        : await call("ryuu_search", { query: q });
      renderSearchDropdown(results || []);
    } catch (error) {
      dropdown.replaceChildren();
      const err = document.createElement("div");
      err.className = "lua-search-empty";
      err.textContent = errorText(error);
      dropdown.append(err);
      dropdown.classList.remove("hidden");
    } finally {
      $("#lua-search-spin").classList.add("hidden");
    }
  }

  async function luaGet(appid, name) {
    $("#lua-search-dropdown").classList.add("hidden");
    const label = name || `AppID ${appid}`;
    const hubcap = state.lua.service === "hubcap";
    log(`Получение из ${hubcap ? "HubCap" : "генератора"}: ${label} (${appid})`, "system");
    toast("Загрузка манифестов…");
    try {
      const result = hubcap
        ? await call("hubcap_get", {
            appid: String(appid),
            steamPath: state.lua.steamPath || null,
            autoUpdate: $("#lua-auto-update").checked,
          })
        : await call("ryuu_get", {
            appid: String(appid),
            steamPath: state.lua.steamPath || null,
            autoUpdate: $("#lua-auto-update").checked,
          });
      if (consumeResult(result)) {
        if (!state.lua.names[appid] && name) state.lua.names[appid] = name;
        await luaRefresh();
        await showModal("Игра получена", `${label} добавлена. Нажмите «Перезапустить Steam», чтобы она появилась в библиотеке.`, { symbol: "✓" });
      }
    } catch (error) {
      log(`Ошибка получения: ${errorText(error)}`, "error");
      toast(errorText(error), "error");
    } finally {
      if (hubcap) refreshHubcapUsage();
    }
  }

  function renderDlcs(filter = "") {
    const container = $("#dlc-list");
    const entries = Object.entries(state.dlcs || {});
    $("#dlc-count").textContent = pluralPackages(entries.length);
    container.replaceChildren();
    const normalized = filter.trim().toLowerCase();
    const visible = entries.filter(([id, name]) => !normalized || id.includes(normalized) || String(name).toLowerCase().includes(normalized));
    if (!visible.length) {
      const empty = document.createElement("div");
      empty.className = "empty-inline";
      empty.textContent = entries.length ? "Ничего не найдено" : "У этой игры DLC не обнаружены";
      container.appendChild(empty);
      return;
    }
    visible.forEach(([id, name]) => {
      const chip = document.createElement("div");
      chip.className = "dlc-chip";
      const code = document.createElement("b");
      code.textContent = id;
      chip.append(code, document.createTextNode(name));
      chip.title = `${id} · ${name}`;
      container.appendChild(chip);
    });
  }

  function renderGame() {
    $("#game-workspace").classList.remove("hidden");
    $("#game-title").textContent = state.gameName || basename(state.gameDir);
    $("#game-appid").textContent = state.appid || "Нужно определить";
    $("#game-engine").textContent = state.engine || "Другой";
    $("#game-exe").textContent = state.exes.length > 1 ? `${state.exes.length} файлов` : (state.exes[0] || "Не найден");
    $("#game-exe").title = state.exes.join("\n");
    $("#game-steam").textContent = state.steamApis.length > 1 ? `${state.steamApis.length} библиотек` : (state.steamApis[0] || "Не найден");
    $("#game-steam").title = state.steamApis.join("\n");

    const status = $("#game-status");
    status.classList.toggle("installed", state.status !== "clean");
    status.textContent = state.status === "installed" ? "FIX INSTALLED" : state.status === "backup_exists" ? "BACKUP READY" : "CLEAN BUILD";
    $("#uninstall-button").classList.toggle("hidden", state.status === "clean");

    const image = $("#game-banner");
    const fallback = $("#cover-fallback");
    image.classList.remove("loaded");
    fallback.classList.remove("hidden");
    if (state.banner) {
      image.onload = () => { image.classList.add("loaded"); fallback.classList.add("hidden"); };
      image.onerror = () => { image.classList.remove("loaded"); fallback.classList.remove("hidden"); };
      image.src = state.banner;
    } else {
      image.removeAttribute("src");
    }

    const eosAvailable = state.hasEos || state.hasEpicfix;
    const canInstallEpicfix = state.hasEos && !state.hasEpicfix;
    const canRestoreEos = state.hasEpicfix && state.hasEosBackup;
    const eosStatus = $("#eos-status");
    eosStatus.textContent = !eosAvailable
      ? "EOS не обнаружен"
      : canRestoreEos
        ? "EpicFix установлен · можно восстановить EOS"
        : state.hasEpicfix
          ? "Оригинальный EOS активен"
          : "EOS обнаружен";
    eosStatus.classList.toggle("offline", !eosAvailable);
    $("#epicfix-button").disabled = !canInstallEpicfix;
    $("#restore-eos-button").disabled = !canRestoreEos;
    renderDlcs();
  }

  async function chooseDirectory() {
    const button = $("#browse-button");
    setBusy(button, true, "Открываем…");
    try {
      const path = await call("pick_game_directory");
      if (path) {
        $("#game-path").value = path;
        window.cgsStorage.setItem("lastGamePath", path);
    window.cgsHome?.recordGame(path);
        await scanDirectory(path);
      }
    } catch (error) {
      log(`Ошибка выбора папки: ${errorText(error)}`, "error");
      toast(errorText(error), "error");
    } finally {
      setBusy(button, false);
    }
  }

  async function scanDirectory(rawPath) {
    const path = String(rawPath || "").trim().replace(/^"|"$/g, "");
    if (!path || state.scanning) {
      if (!path) toast("Сначала укажите папку игры", "error");
      return;
    }
    state.scanning = true;
    window.cgsStorage.setItem("lastGamePath", path);
    window.cgsHome?.recordGame(path);
    $("#game-path").value = path;
    $("#scan-progress").classList.remove("hidden");
    $("#game-workspace").classList.add("hidden");
    const scanButton = $("#scan-button");
    setBusy(scanButton, true, "Анализ…");
    log(`Запущено сканирование: ${path}`, "system");
    const messages = ["Ищем исполняемые файлы и сетевые библиотеки…", "Определяем игровой движок…", "Запрашиваем метаданные Steam и DLC…"];
    let index = 0;
    const ticker = setInterval(() => { index = (index + 1) % messages.length; $("#scan-progress-text").textContent = messages[index]; }, 1800);

    try {
      const result = await call("scan_game_directory", { path });
      state.gameDir = result.gameDir;
      state.exes = result.exes || [];
      state.steamApis = result.steamApiPaths || [];
      state.engine = result.engine;
      state.status = result.status;
      state.hasEos = Boolean(result.hasEos);
      state.hasEosBackup = Boolean(result.hasEosBackup);
      state.hasEpicfix = Boolean(result.hasEpicfix);
      const detected = result.detectedGame || {};
      state.appid = detected.detected ? detected.appid : null;
      state.gameName = detected.detected ? detected.name : basename(path);
      state.banner = detected.headerImage || "";
      state.dlcs = detected.dlcs || {};
      renderGame();
      log(`Найдено EXE: ${state.exes.length}; Steam API: ${state.steamApis.length}`, "info");
      if (detected.detected) log(`Игра определена: ${state.gameName} · AppID ${state.appid}`, "success");
      else log("Steam AppID не определён. Используйте ручной поиск.", "error");
      if (state.hasEos) log("Обнаружена библиотека Epic Online Services", "info");
      toast("Сканирование завершено");
    } catch (error) {
      const message = errorText(error);
      log(`Сканирование не выполнено: ${message}`, "error");
      toast(message, "error");
    } finally {
      clearInterval(ticker);
      $("#scan-progress").classList.add("hidden");
      setBusy(scanButton, false);
      state.scanning = false;
    }
  }

  async function manualSearch() {
    const query = $("#manual-query").value.trim();
    if (!query) return toast("Введите название игры", "error");
    const button = $("#manual-search-button");
    setBusy(button, true, "Поиск…");
    log(`Ручной поиск в Steam: «${query}»`, "system");
    try {
      const game = await call("search_game", { query });
      if (!game) throw new Error("Игра не найдена в Steam Store");
      const details = await call("get_app_details", { appid: game.appid });
      state.appid = game.appid;
      state.gameName = game.name;
      state.banner = details?.headerImage || game.headerImage || "";
      state.dlcs = details?.dlcs || {};
      renderGame();
      log(`Выбрана игра: ${game.name} · AppID ${game.appid}`, "success");
      toast("Метаданные игры обновлены");
    } catch (error) {
      log(`Ошибка поиска: ${errorText(error)}`, "error");
      toast(errorText(error), "error");
    } finally {
      setBusy(button, false);
    }
  }

  function consumeResult(result) {
    (result.logs || []).forEach((message) => log(message, String(message).startsWith("⚠") ? "error" : "info"));
    const skipped = [...new Set([...(result.skipped || []), ...(result.failed || [])])];
    skipped.forEach(message => log("Пропущено: " + message, "error"));
    const complete = result.success === true && result.status !== "partial" && !skipped.length;
    const message = result.status === "partial" && !String(result.message).includes("частично") ? "Выполнено частично. " + result.message : result.message;
    log(message, complete ? "success" : "error");
    toast(message, complete ? "success" : "error");
    return complete;
  }

  async function installFix() {
    if (!state.gameDir) return toast("Сначала просканируйте папку игры", "error");
    if (!state.appid) return toast("Сначала определите Steam AppID через ручной поиск", "error");
    const button = $("#install-button");
    setBusy(button, true, "Устанавливаем…");
    log(`Установка Online Fix для AppID ${state.appid}`, "system");
    try {
      const request = {
        gameDir: state.gameDir,
        realAppid: Number(state.appid),
        fakeAppid: Number($("#fake-appid").value) || 480,
        dlcs: state.dlcs,
        installEpicfix: false,
        unlockAllDlcs: $("#unlock-dlc").checked,
      };
      const result = await call("install_fix", { request });
      if (consumeResult(result)) {
        state.status = "installed";
        if (state.hasEos) state.hasEosBackup = true;
        renderGame();
        await showModal("Установка завершена", "Компоненты размещены рядом с исполняемым файлом игры. Оригинальные файлы сохранены автоматически.", { symbol: "✓" });
      }
    } catch (error) {
      log(`Ошибка установки: ${errorText(error)}`, "error");
      toast(errorText(error), "error");
    } finally {
      setBusy(button, false);
    }
  }

  async function uninstallFix() {
    if (!state.gameDir) return;
    const accepted = await showModal("Удалить Online Fix?", "Компоненты фикса будут удалены, а сохранённые оригинальные файлы — возвращены на свои места.", { confirm: true, confirmText: "Удалить и восстановить", symbol: "↺" });
    if (!accepted) return;
    const button = $("#uninstall-button");
    setBusy(button, true, "Восстановление…");
    log("Запущено удаление фикса и восстановление оригиналов", "system");
    try {
      const result = await call("uninstall_fix", { gameDir: state.gameDir });
      if (consumeResult(result)) {
        state.status = "clean";
        state.hasEosBackup = false;
        state.hasEpicfix = false;
        renderGame();
      }
    } catch (error) {
      log(`Ошибка удаления: ${errorText(error)}`, "error");
      toast(errorText(error), "error");
    } finally {
      setBusy(button, false);
    }
  }

  async function installEpicfix() {
    if (!state.gameDir || !state.hasEos || state.hasEpicfix) return;
    const accepted = await showModal(
      "Установить EpicFix?",
      "Используйте этот шаг, если сразу после установки Online Fix игра не запускается или не создаётся лобби. После установки EpicFix запустите игру и снова проверьте подключение. Если проблема останется, нажмите восстановление оригинального EOS - обычно это решает проблему.",
      { confirm: true, confirmText: "Установить", cancelText: "Не устанавливать", symbol: "!" },
    );
    if (!accepted) return;
    const button = $("#epicfix-button");
    setBusy(button, true, "Установка…");
    log("Отдельная установка компонентов EpicFix", "system");
    try {
      const result = await call("install_epicfix_only", { gameDir: state.gameDir });
      if (consumeResult(result)) {
        state.hasEpicfix = true;
        renderGame();
      }
    } catch (error) {
      log(`Ошибка EpicFix: ${errorText(error)}`, "error");
      toast(errorText(error), "error");
    } finally {
      setBusy(button, false);
    }
  }

  async function restoreEos() {
    if (!state.gameDir || !state.hasEpicfix || !state.hasEosBackup) return;
    const accepted = await showModal("Восстановить оригинальный EOS?", "Если после установки EpicFix игра всё ещё не запускается или лобби не создаётся, восстановите оригинальную библиотеку EOS. В большинстве случаев после этого игра начинает работать корректно.", { confirm: true, confirmText: "Восстановить", cancelText: "Не восстанавливать", symbol: "↺" });
    if (!accepted) return;
    const button = $("#restore-eos-button");
    setBusy(button, true, "Восстановление…");
    try {
      const result = await call("restore_eos_only", { gameDir: state.gameDir });
      if (consumeResult(result)) {
        state.hasEosBackup = false;
        renderGame();
      }
    } catch (error) {
      log(`Ошибка восстановления EOS: ${errorText(error)}`, "error");
      toast(errorText(error), "error");
    } finally {
      setBusy(button, false);
    }
  }

  function applyAccent(name) {
    // Палитра и адаптация к светлой теме — в bootstrap.js (window.cgsAccent)
    const accent = window.cgsAccent.apply(name);
    $$(".accent").forEach((button) => {
      const active = button.dataset.accent === accent.name;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    window.cgsStorage.setItem("accent", accent.name);
  }

  function applyManifestService(service) {
    const svc = service === "hubcap" ? "hubcap" : "ryuu";
    state.lua.service = svc;
    $$(".svc-option").forEach((button) => button.classList.toggle("active", button.dataset.service === svc));
    $("#svc-key-block")?.classList.toggle("hidden", svc !== "hubcap");
    $("#ryuu-key-block")?.classList.toggle("hidden", svc !== "ryuu");
    $("#hubcap-limit-badge")?.classList.toggle("hidden", svc !== "hubcap");
    window.cgsStorage.setItem("manifestService", svc);
    const input = $("#lua-search-input");
    if (input) input.placeholder = svc === "hubcap"
      ? "Поиск через HubCap — название или AppID…"
      : "Введите название игры или AppID…";
    // Ошибка лимита HubCap не должна «висеть» после переключения на Ryuu
    if (svc !== "hubcap") state.lua.hubcapUsageError = "";
    renderHubcapUsage();
    if (svc === "hubcap" && state.lua.hubcapKey.trim()) refreshHubcapUsage();
  }

  function updateHubcapKeyStatus() {
    const status = $("#hubcap-key-status");
    if (status) {
      const hasKey = Boolean(state.lua.hubcapKey.trim());
      status.textContent = hasKey ? "Ключ активен" : "Ключ не указан";
      status.classList.toggle("active", hasKey);
    }
  }

  function hasRyuuKey() {
    return state.lua.ryuuKeySource === "crocodile" || Boolean(state.lua.ryuuKey.trim());
  }

  function applyRyuuKeySource(source) {
    const selected = source === "custom" ? "custom" : "crocodile";
    const builtin = selected === "crocodile";
    state.lua.ryuuKeySource = selected;
    $$('input[name="ryuu-key-source"]').forEach((input) => {
      input.checked = input.value === selected;
      input.closest(".ryuu-key-source-option")?.classList.toggle("active", input.checked);
    });
    $("#ryuu-custom-key-fields")?.classList.toggle("hidden", builtin);
    if ($("#ryuu-key")) $("#ryuu-key").disabled = builtin;
    const help = $("#ryuu-key-help");
    if (help) help.textContent = builtin
      ? "Общий ключ встроен в программу. Его доступность зависит от Crocodile Gena Studio."
      : "Свой ключ хранится в защищённом хранилище Windows. Переключение режима не удаляет его.";
    window.cgsStorage.setItem("ryuuKeySource", selected);
    updateRyuuKeyStatus();
  }

  function updateRyuuKeyStatus() {
    const status = $("#ryuu-key-status");
    if (status) {
      const hasKey = hasRyuuKey();
      status.textContent = state.lua.ryuuKeySource === "crocodile"
        ? "Встроенный ключ"
        : hasKey ? "Свой ключ указан" : "Ключ не указан";
      status.classList.toggle("active", hasKey);
    }
  }

  function renderHubcapUsage() {
    const usage = state.lua.hubcapUsage || { dailyUsage: 0, dailyLimit: 25, remaining: 25 };
    const unlimited = usage.dailyLimit >= 999999;
    const limit = unlimited ? "∞" : usage.dailyLimit;
    const remaining = unlimited ? "∞" : usage.remaining;
    const badge = $("#hubcap-limit-badge");
    const status = $("#hubcap-usage-status");
    if (badge) {
      badge.textContent = state.lua.hubcapUsageError
        ? "HubCap: лимит недоступен"
        : `HubCap: ${usage.dailyUsage}/${limit} · осталось ${remaining}`;
      badge.classList.toggle("error", Boolean(state.lua.hubcapUsageError));
    }
    const usedEl = $("#hubcap-usage-used");
    if (usedEl) usedEl.textContent = `${usage.dailyUsage}/${limit}`;
    const remEl = $("#hubcap-usage-remaining");
    if (remEl) remEl.textContent = String(remaining);
    if (status) {
      status.classList.toggle("error", Boolean(state.lua.hubcapUsageError));
      status.textContent = state.lua.hubcapUsageError
        || (state.lua.hubcapUsageLoading
          ? "Обновление данных HubCap…"
          : state.lua.hubcapKey.trim()
            ? "Данные HubCap · обновляются каждые 30 секунд"
            : "Добавьте ключ для синхронизации");
    }
    const progressBar = $("#hubcap-progress-bar");
    if (progressBar) {
      const pct = (usage.dailyLimit > 0 && !unlimited)
        ? Math.min(100, Math.max(0, Math.round((usage.dailyUsage / usage.dailyLimit) * 100)))
        : 0;
      progressBar.style.width = `${pct}%`;
    }
  }


  async function refreshHubcapUsage() {
    // Запрашиваем лимит HubCap только при выборе этого источника
    if (!invoke || state.lua.hubcapUsageLoading || state.lua.service !== "hubcap") return;
    if (!state.lua.hubcapKey.trim()) {
      state.lua.hubcapUsage = { dailyUsage: 0, dailyLimit: 25, remaining: 25 };
      state.lua.hubcapUsageError = "";
      renderHubcapUsage();
      return;
    }
    state.lua.hubcapUsageLoading = true;
    state.lua.hubcapUsageError = "";
    renderHubcapUsage();
    try {
      state.lua.hubcapUsage = await call("hubcap_usage", {});
    } catch (error) {
      state.lua.hubcapUsageError = errorText(error);
    } finally {
      state.lua.hubcapUsageLoading = false;
      renderHubcapUsage();
    }
  }

  // Обновление полезной системной информации в блоке «О программе»
  async function updateAboutInfo() {
    // Версия программы (без суффикса Portable x64, так как других сборок нет)
    const appVerEl = $("#about-app-version");
    if (appVerEl) {
      const currentVer = state.version || $("#update-current-version")?.textContent?.trim() || $(".titlebar-version")?.textContent?.trim() || "9.0.0";
      state.version = currentVer;
      appVerEl.textContent = currentVer;
    }

    // Версия Eclipse HV (без буквы v)
    const hvVerEl = $("#about-hv-version");
    if (hvVerEl) {
      if (invoke) {
        try {
          const hvStatus = await call("eclipse_hv_status");
          if (hvStatus && hvStatus.installed) {
            const rawVer = hvStatus.version || "9.0.0";
            hvVerEl.textContent = rawVer.replace(/^v/i, "");
          } else {
            hvVerEl.textContent = "Не установлен";
          }
        } catch (_) {
          hvVerEl.textContent = "Не установлен";
        }
      } else {
        hvVerEl.textContent = "1.1.0";
      }
    }

    // Права доступа
    const adminEl = $("#about-admin-rights");
    if (adminEl) {
      if (invoke) {
        try {
          const isElevated = await call("process_is_elevated");
          adminEl.textContent = isElevated ? "Администратор (UAC ✓)" : "Обычный пользователь";
        } catch (_) {
          adminEl.textContent = "Обычный пользователь";
        }
      } else {
        adminEl.textContent = "Администратор (UAC ✓)";
      }
    }

    // Путь к Steam
    const steamEl = $("#about-steam-path");
    if (steamEl) {
      const path = state.lua.steamPath || window.cgsStorage.getItem("luaSteamPath") || "";
      if (path) {
        steamEl.textContent = path;
        steamEl.title = path;
      } else {
        steamEl.textContent = "Не обнаружен";
        steamEl.title = "";
      }
    }
  }

  // Извлечение полного списка изменений (changelog) на выбранном языке (RU / EN)
  function extractChangelog(notesRaw, lang = "ru") {
    if (!notesRaw || typeof notesRaw !== "string") return "";
    const clean = notesRaw.trim();
    if (!clean) return "";

    let enPart = "";
    let ruPart = "";

    // Ищем русскую секцию Markdown или HTML; границы RU исключают совпадение с Antivirus
    const ruHeaderRegex = /(?:(?:^|\n)##?\s*(?:Русский|\b(?:Russian|RU)\b)|<h[1-3][^>]*>(?:(?!<\/h[1-3]>).)*?(?:(?<=^|[\s>"'«])Русский(?=$|[\s<"'».,:;])|\b(?:Russian|RU)\b)(?:(?!<\/h[1-3]>).)*?<\/h[1-3]>)/iu;
    const ruHeaderMatch = clean.match(ruHeaderRegex);

    const hrRegex = /(?:---|(?<!<[^>]*)<hr\s*\/?>)/i;
    const hrMatch = clean.match(hrRegex);

    if (ruHeaderMatch) {
      enPart = clean.slice(0, ruHeaderMatch.index).replace(/(?:---|<hr\s*\/?>)[\s\r\n]*$/, "").trim();
      ruPart = clean.slice(ruHeaderMatch.index + ruHeaderMatch[0].length).trim();
    } else if (hrMatch) {
      enPart = clean.slice(0, hrMatch.index).trim();
      ruPart = clean.slice(hrMatch.index + hrMatch[0].length).replace(/^[^>]*>/, "").trim();
    } else {
      enPart = clean;
      ruPart = clean;
    }

    let target = (lang === "en" ? enPart : ruPart) || clean;

    // Удаляем верхний дублирующий H1-заголовок релиза
    target = target.replace(/^(?:#\s*Eclipse\s*Studio[^\n]*\n+|<h1[^>]*>[\s\S]*?<\/h1>)/i, "").trim();

    // Преобразуем HTML элементы в читаемый текстовый формат
    target = target.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "• $1\n");
    target = target.replace(/<h[2-4][^>]*>(.*?)<\/h[2-4]>/gi, "\n$1:\n");
    target = target.replace(/<br\s*\/?>/gi, "\n");
    target = target.replace(/<[^>]+>/g, "");

    // Убираем возможный остаточный префикс заголовка языка
    target = target.replace(/^(?:##?\s*(?:Русский|Russian|RU|English|EN)[^\n]*\n+)+/i, "").trim();

    // Форматируем подзаголовки ### в аккуратный текст
    target = target.replace(/^###?\s*(.+)$/gm, "$1:");

    // Преобразуем markdown-буллеты (* **Пункт**: описание) в читаемый список (• Пункт: описание)
    target = target.replace(/^[\*\-]\s+\*\*([^\*]+)\*\*:\s*/gm, "• $1: ");
    target = target.replace(/^[\*\-]\s+/gm, "• ");

    // Снимаем оставшиеся markdown-выделения жирным шрифтом
    target = target.replace(/\*\*([^\*]+)\*\*/g, "$1");

    // Декодируем часто встречающиеся HTML сущности
    target = target
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");

    return target.replace(/^[ \t]+/gm, "").replace(/\n\s*\n\s*\n/g, "\n\n").trim();
  }

  // Окно обновления программы: проверенная загрузка EXE, замена с откатом и перезапуск
  const UPDATE_SNOOZE_KEY = "cgs-update-snooze-launches";
  const UPDATE_SESSIONS_KEY = "cgs-update-snooze-sessions";
  const UPDATE_SNOOZE_LAUNCHES = 5;
  const UPDATE_CANCELLED = "Обновление отменено.";
  let activeUpdatePrompt = null;

  const updateText = (ru, en) => (window.cgsI18n?.language === "en" ? en : ru);
  const formatMegabytes = (bytes) => (Math.max(0, Number(bytes) || 0) / 1048576).toFixed(1);

  // Идентификатор запуска процесса: перезагрузка окна не расходует откладывание
  function updateSessionId() {
    if (window.cgsAppSession) return window.cgsAppSession;
    let id = sessionStorage.getItem("cgs-update-preview-session");
    if (!id) {
      id = crypto.randomUUID();
      sessionStorage.setItem("cgs-update-preview-session", id);
    }
    return id;
  }

  function readUpdateSessions() {
    try {
      const entries = JSON.parse(window.cgsStorage.getItem(UPDATE_SESSIONS_KEY) || "[]");
      return Array.isArray(entries) ? entries : [];
    } catch (_) {
      return [];
    }
  }

  function rememberUpdateSnooze(skipped) {
    const id = updateSessionId();
    const entries = readUpdateSessions().filter((item) => item?.id !== id).slice(-19);
    entries.push({ id, skipped });
    window.cgsStorage.setItem(UPDATE_SESSIONS_KEY, JSON.stringify(entries));
  }

  // Каждый новый запуск расходует одно откладывание; на шестом запуске окно появится снова
  function consumeUpdateSnooze() {
    try {
      const previous = readUpdateSessions().find((item) => item?.id === updateSessionId());
      if (previous) return Boolean(previous.skipped);
      const count = Number(window.cgsStorage.getItem(UPDATE_SNOOZE_KEY));
      if (Number.isInteger(count) && count > 0 && count <= UPDATE_SNOOZE_LAUNCHES) {
        window.cgsStorage.setItem(UPDATE_SNOOZE_KEY, String(count - 1));
        rememberUpdateSnooze(true);
        return true;
      }
      window.cgsStorage.removeItem(UPDATE_SNOOZE_KEY);
      rememberUpdateSnooze(false);
    } catch (_) {}
    return false;
  }

  // Посторонние операции: обновление ждёт их завершения, чтобы не прервать запись файлов
  function otherOperationsRunning() {
    for (const [id, source] of [...activeOperations]) {
      // Кнопка, удалённая из DOM или снятая с занятости без события, больше не блокирует обновление
      if (source === "button" && !document.getElementById(id)?.classList.contains("busy")) activeOperations.delete(id);
    }
    if (activeOperations.size) return true;
    const jobs = window.cgsJobs?.list?.() || [];
    if (jobs.some((job) => job.status === "running" && job.command !== "install_update")) return true;
    return Boolean(document.querySelector('[aria-busy="true"], [data-busy="true"]'));
  }

  // Строка состояния в карточке «Обновления» с переводом при смене языка
  function setUpdateStatus(ru, en = ru, kind = "") {
    state.updates.status = { ru, en, kind };
    renderUpdateStatus();
  }

  function renderUpdateStatus() {
    const status = $("#update-status");
    const value = state.updates.status;
    if (!status || !value) return;
    status.textContent = updateText(value.ru, value.en);
    status.classList.toggle("available", value.kind === "available");
    status.classList.toggle("error", value.kind === "error");
  }

  // Видимая часть приложения недоступна, пока открыто окно; кнопки окна Windows остаются
  function setUpdateShellInert(inert) {
    const shell = $(".app-shell");
    if (!shell) return;
    [...shell.children]
      .filter((node) => !node.classList.contains("titlebar"))
      .concat([$("#titlebar-search"), $("#open-telegram-hub")])
      .filter(Boolean)
      .forEach((node) => { node.inert = inert; });
  }

  function updatePhaseLabel(phase) {
    return {
      loader: updateText("Обновление библиотек OpenSteamTool…", "Updating OpenSteamTool libraries…"),
      preparing: updateText("Подготовка обновления…", "Preparing update…"),
      downloading: updateText("Скачивание обновления", "Downloading update"),
      retrying: updateText("Переподключение к серверу…", "Reconnecting to the server…"),
      verifying: updateText("Проверка целостности и версии EXE…", "Verifying EXE integrity and version…"),
      installing: updateText("Подготовка установки…", "Preparing installation…"),
      restarting: updateText("Установка и перезапуск программы…", "Installing and restarting the app…"),
    }[phase] || updateText("Подготовка обновления…", "Preparing update…");
  }

  function setUpdateProgress(percent, indeterminate = false) {
    const bar = $("#app-update-progress");
    const fill = $("#app-update-progress-fill");
    bar.classList.toggle("indeterminate", indeterminate);
    if (indeterminate) {
      bar.removeAttribute("aria-valuenow");
      fill.style.width = "";
      $("#app-update-percent").textContent = "…";
      return;
    }
    const value = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
    bar.setAttribute("aria-valuenow", String(value));
    fill.style.width = `${value}%`;
    $("#app-update-percent").textContent = `${value}%`;
  }

  // Подписи этапа, полосы и подробностей для текущего состояния установки
  function renderUpdateProgress(view) {
    const phaseNode = $("#app-update-phase");
    const detailNode = $("#app-update-detail");
    $("#app-update-progress-wrap").dataset.state = view;
    if (view === "ready") {
      phaseNode.textContent = updateText("Готово к загрузке", "Ready to download");
      detailNode.textContent = updateText(
        "Перед заменой EXE проверяются SHA-256 и версия файла. Напоминание можно отложить на 5 запусков.",
        "The EXE's SHA-256 and version are verified before replacement. You can postpone the reminder for 5 launches."
      );
      setUpdateProgress(0);
      return;
    }
    if (view === "error" || view === "cancelled") {
      // Заголовок окна уже называет итог, здесь — пояснение к подробностям
      phaseNode.textContent = view === "error"
        ? updateText("Что пошло не так", "What went wrong")
        : updateText("Загрузка остановлена", "Download stopped");
      detailNode.textContent = view === "error"
        ? state.updates.failure
        : updateText("Загруженные файлы удалены, текущая версия не изменена.", "Downloaded files were removed; the current version is unchanged.");
      return;
    }
    const value = state.updates.progress || { phase: "preparing" };
    const phase = value.phase || "preparing";
    let detail = updateText("До начала замены EXE обновление можно отменить.", "You can cancel until the EXE replacement begins.");
    if (phase === "downloading") {
      const total = Number(value.total) || 0;
      const downloaded = Number(value.downloaded) || 0;
      const speed = state.updates.speed || 0;
      detail = total
        ? `${formatMegabytes(downloaded)} / ${formatMegabytes(total)} ${updateText("МБ", "MB")}`
        : `${formatMegabytes(downloaded)} ${updateText("МБ", "MB")}`;
      if (speed > 0) {
        detail += ` · ${(speed / 1048576).toFixed(2)} ${updateText("МБ/с", "MB/s")}`;
        if (total > downloaded) {
          const seconds = Math.max(1, Math.ceil((total - downloaded) / speed));
          detail += updateText(` · осталось примерно ${seconds} с`, ` · about ${seconds}s remaining`);
        }
      }
      setUpdateProgress(value.percent ?? (total ? (downloaded / total) * 100 : 0), !total);
    } else if (phase === "retrying") {
      const attempt = Number(value.attempt) || 2;
      detail = updateText(`Попытка ${attempt} из 3. ${value.message || ""}`, `Attempt ${attempt} of 3. ${value.message || ""}`).trim();
      setUpdateProgress(0, true);
    } else if (phase === "verifying") {
      detail = updateText("Сверяем SHA-256 из релиза GitHub, разрядность и версию EXE.", "Checking the GitHub release SHA-256, architecture and EXE version.");
      setUpdateProgress(100);
    } else if (phase === "installing") {
      detail = updateText("Текущая версия сохраняется для автоматического отката.", "The current version is kept for an automatic rollback.");
      setUpdateProgress(100);
    } else if (phase === "restarting") {
      detail = updateText("Программа закроется и запустится уже обновлённой. Отмена больше недоступна.", "The app closes and starts again updated. Cancelling is no longer possible.");
      setUpdateProgress(100);
    } else {
      setUpdateProgress(0, true);
    }
    phaseNode.textContent = state.updates.cancelling
      ? updateText("Отменяем обновление…", "Cancelling update…")
      : updatePhaseLabel(phase);
    detailNode.textContent = detail;
  }

  // Полная отрисовка окна на текущем языке и этапе
  function renderUpdateDialog() {
    const prompt = activeUpdatePrompt;
    const update = prompt?.update || state.updates.latest;
    if (!update) return;
    const installing = state.updates.installing;
    const view = installing ? "working" : (state.updates.dialogState || "ready");
    const step2 = view === "ready" && prompt?.step === 2;
    const hasLoader = Boolean(prompt?.loaderUpdate);
    const version = update.latestVersion;

    $("#app-update-symbol").textContent = { working: "↓", error: "!" }[view] || "↑";
    $("#app-update-title").textContent = view === "error"
      ? updateText("Обновление не выполнено", "Update failed")
      : view === "cancelled"
        ? updateText("Обновление отменено", "Update cancelled")
        : installing
          ? updateText(`Обновление до версии ${version}`, `Updating to version ${version}`)
          : updateText(`Доступна версия ${version}`, `Version ${version} available`);
    $("#app-update-message").textContent = installing
      ? updateText("Не закрывайте программу: после проверки файла она перезапустится сама.", "Keep the app open: it restarts by itself after the file is verified.")
      : view === "ready"
        ? updateText("Программа обновится и запустится автоматически. Настройки и ярлыки сохранятся.", "The app updates and restarts automatically. Your settings and shortcuts stay in place.")
        : updateText("Текущая версия не изменена. Можно повторить попытку или отложить обновление.", "The current version is unchanged. You can try again or postpone the update.");

    const changelogText = extractChangelog(update.notes, window.cgsI18n?.language === "en" ? "en" : "ru");
    $("#app-update-changelog").classList.toggle("hidden", !changelogText || installing || step2);
    $("#app-update-changelog-toggle-text").textContent = updateText(`Список изменений (v${version})`, `Changelog (v${version})`);
    $("#app-update-changelog-body").textContent = changelogText;
    $("#app-update-step2").classList.toggle("hidden", !step2);
    $("#app-update-progress-wrap").classList.toggle("hidden", step2);
    renderUpdateProgress(view);

    const install = $("#app-update-install");
    const defer = $("#app-update-defer");
    const cancel = $("#app-update-cancel");
    const close = $("#app-update-close");
    install.classList.toggle("hidden", installing);
    defer.classList.toggle("hidden", installing);
    cancel.classList.toggle("hidden", !installing);
    cancel.disabled = state.updates.cancelling || state.updates.committing;
    close.disabled = state.updates.committing;
    install.textContent = hasLoader && view === "ready" && !step2
      ? updateText("Далее →", "Next →")
      : view === "error" || view === "cancelled"
        ? updateText("Повторить", "Try again")
        : updateText("Обновить и перезапустить", "Update and restart");
    defer.textContent = step2 ? updateText("Назад", "Back") : updateText("Отложить на 5 запусков", "Remind me after 5 launches");
    cancel.textContent = state.updates.cancelling ? updateText("Отменяем…", "Cancelling…") : updateText("Отменить обновление", "Cancel update");
    const closeLabel = installing ? updateText("Отменить обновление", "Cancel update") : updateText("Закрыть", "Close");
    close.setAttribute("aria-label", closeLabel);
    close.title = closeLabel;
  }

  function updateDialogOpen() {
    return !$("#app-update-backdrop").classList.contains("hidden");
  }

  function showUpdateDialog(loaderUpdate = null) {
    const update = state.updates.latest;
    if (!update?.available) return;
    if (!update.inAppSupported && !state.updates.installing) return;
    if (!activeUpdatePrompt || activeUpdatePrompt.update !== update) activeUpdatePrompt = { update, loaderUpdate: null, step: 1 };
    if (loaderUpdate?.updateAvailable) activeUpdatePrompt.loaderUpdate = loaderUpdate;
    if (!state.updates.installing) {
      state.updates.dialogState = "ready";
      activeUpdatePrompt.step = 1;
      $("#app-update-changelog").open = false;
    }
    renderUpdateDialog();
    const backdrop = $("#app-update-backdrop");
    backdrop.classList.remove("hidden", "closing");
    setUpdateShellInert(true);
    (state.updates.installing ? $("#app-update-cancel") : $("#app-update-install")).focus({ preventScroll: true });
  }

  function hideUpdateDialog() {
    const backdrop = $("#app-update-backdrop");
    if (backdrop.classList.contains("hidden")) return;
    setUpdateShellInert(false);
    backdrop.classList.add("closing");
    setTimeout(() => {
      backdrop.classList.add("hidden");
      backdrop.classList.remove("closing");
    }, 190);
  }

  // Крестик и Esc во время установки отменяют её, иначе просто закрывают окно
  function closeUpdateDialog() {
    if (state.updates.installing) {
      cancelAppUpdate();
      return;
    }
    hideUpdateDialog();
  }

  function deferUpdate() {
    if (state.updates.installing) return;
    if (activeUpdatePrompt?.step === 2 && (state.updates.dialogState || "ready") === "ready") {
      activeUpdatePrompt.step = 1;
      renderUpdateDialog();
      return;
    }
    try {
      window.cgsStorage.setItem(UPDATE_SNOOZE_KEY, String(UPDATE_SNOOZE_LAUNCHES));
      rememberUpdateSnooze(true);
    } catch (_) {}
    state.updates.snoozedThisLaunch = true;
    hideUpdateDialog();
    setUpdateStatus("Напомним об обновлении после следующих пяти запусков.", "We will remind you after the next five launches.", "available");
    toast(updateText("Обновление отложено на 5 запусков", "Update postponed for 5 launches"));
  }

  async function cancelAppUpdate() {
    if (!state.updates.installing || state.updates.cancelling || state.updates.committing) return;
    state.updates.cancelling = true;
    renderUpdateDialog();
    // До запуска загрузки отмена применяется после текущего шага (обновления библиотек)
    if (!state.updates.nativeStarted) return;
    try {
      await call("cancel_update");
    } catch (error) {
      state.updates.cancelling = false;
      renderUpdateDialog();
      toast(errorText(error), "error");
    }
  }

  // Библиотеки OpenSteamTool обновляются перед программой, если пользователь выбрал оба пункта
  async function updateLoaderBeforeApp() {
    const closed = await ensureSteamClosedForLoader();
    if (!closed) return false;
    try {
      const result = await call("luatools_update_loader", {
        steamPath: state.lua.steamPath || null,
        variant: state.lua.loaderSource || null,
      });
      if (result?.success) {
        clearLoaderPostpone();
        toast(updateText("Библиотеки OpenSteamTool успешно обновлены", "OpenSteamTool libraries updated successfully"), "success");
        $("#loader-update-banner")?.classList.add("hidden");
        if (state.lua.loaderUpdate) state.lua.loaderUpdate.updateAvailable = false;
      } else {
        log(`Обновление DLL перед обновлением программы: ${result?.message || "без подробностей"}`, "warn");
      }
    } catch (error) {
      log(`Ошибка обновления DLL в комбинированном режиме: ${errorText(error)}`, "warn");
    }
    return true;
  }

  function finishUpdateAttempt(view, message = "") {
    state.updates.installing = false;
    state.updates.cancelling = false;
    state.updates.committing = false;
    state.updates.nativeStarted = false;
    state.updates.dialogState = view;
    state.updates.failure = message;
    $("#check-update-button").disabled = false;
    renderUpdateDownloads(state.updates.latest);
    if (updateDialogOpen()) renderUpdateDialog();
  }

  async function installAppUpdate() {
    const update = state.updates.latest;
    const prompt = activeUpdatePrompt;
    if (state.updates.installing || !update?.inAppSupported) return;
    const view = state.updates.dialogState || "ready";
    // Комбинированный режим: сначала выбор, обновлять ли библиотеки Steam
    if (prompt?.loaderUpdate && view === "ready" && prompt.step !== 2) {
      prompt.step = 2;
      renderUpdateDialog();
      $("#app-update-install").focus({ preventScroll: true });
      return;
    }
    if (otherOperationsRunning()) {
      toast(updateText("Дождитесь завершения текущих операций перед обновлением.", "Wait for current operations to finish before updating."), "info");
      return;
    }
    const scope = prompt?.loaderUpdate && prompt.step === 2
      ? ($("input[name='app-update-scope']:checked")?.value || "both")
      : "app_only";
    const loaderPending = scope === "both" && state.lua.loaderUpdate?.updateAvailable !== false;
    state.updates.installing = true;
    state.updates.cancelling = false;
    state.updates.committing = false;
    state.updates.nativeStarted = false;
    state.updates.downloadSamples = [];
    state.updates.speed = 0;
    state.updates.failure = "";
    state.updates.progress = { phase: loaderPending ? "loader" : "preparing" };
    try { window.cgsStorage.removeItem(UPDATE_SNOOZE_KEY); } catch (_) {}
    $("#check-update-button").disabled = true;
    renderUpdateDialog();
    renderUpdateDownloads(update);
    setUpdateStatus(updateText("Обновление программы…", "Updating the app…"));
    $("#app-update-cancel").focus({ preventScroll: true });
    try {
      if (loaderPending) {
        const proceed = await updateLoaderBeforeApp();
        if (!proceed && !state.updates.cancelling) {
          finishUpdateAttempt("ready");
          setUpdateStatus(`Доступна версия ${update.latestVersion}`, `Version ${update.latestVersion} available`, "available");
          return;
        }
      }
      if (state.updates.cancelling) throw UPDATE_CANCELLED;
      state.updates.progress = { phase: "preparing" };
      state.updates.nativeStarted = true;
      renderUpdateDialog();
      await call("install_update", { version: update.latestVersion });
      // Программа закроется сама: окно остаётся в состоянии перезапуска
      state.updates.committing = true;
      state.updates.progress = { phase: "restarting" };
      renderUpdateDialog();
      setUpdateStatus("Установка и перезапуск программы…", "Installing and restarting the app…");
    } catch (error) {
      const message = errorText(error);
      const cancelled = state.updates.cancelling || message === UPDATE_CANCELLED;
      finishUpdateAttempt(cancelled ? "cancelled" : "error", cancelled ? "" : message);
      if (cancelled) setUpdateStatus("Обновление отменено", "Update cancelled", "available");
      else setUpdateStatus(message, message, "error");
      log(cancelled ? "Обновление программы отменено" : `Обновление программы: ${message}`, cancelled ? "info" : "error");
      if (!updateDialogOpen()) toast(cancelled ? updateText("Обновление отменено", "Update cancelled") : message, cancelled ? "info" : "error");
    }
  }

  // Ход установки из бэкенда (событие cgs-update-progress)
  function updateProgress(value = {}) {
    if (!state.updates.installing || !value) return;
    const phase = value.phase || "preparing";
    if (phase === "downloading") {
      const now = performance.now();
      let samples = state.updates.downloadSamples || [];
      const downloaded = Number(value.downloaded) || 0;
      if (samples.length && downloaded < samples.at(-1).bytes) samples = [];
      samples.push({ time: now, bytes: downloaded });
      while (samples.length > 2 && now - samples[0].time > 3000) samples.shift();
      state.updates.downloadSamples = samples;
      const elapsed = (now - samples[0].time) / 1000;
      state.updates.speed = elapsed > 0.05 ? Math.max(0, (downloaded - samples[0].bytes) / elapsed) : 0;
    } else {
      state.updates.downloadSamples = [];
      state.updates.speed = 0;
    }
    state.updates.committing = phase === "restarting";
    state.updates.progress = value;
    renderUpdateDialog();
    renderUpdateDownloads(state.updates.latest);
    const label = updatePhaseLabel(phase);
    state.updates.status = { ru: label, en: label, kind: "" };
    $("#update-status").textContent = label;
    $("#update-status").classList.remove("available", "error");
  }

  // Запуск: сигнал здоровья новой версии, итог прошлой установки и счётчик откладываний
  async function initUpdates() {
    if (!invoke) return;
    try {
      const outcome = await call("update_launch_ready");
      if (typeof outcome?.success === "boolean") {
        if (outcome.success) window.cgsStorage.removeItem(UPDATE_SNOOZE_KEY);
        else state.updates.suppressAuto = true;
        setUpdateStatus(outcome.message, outcome.message, outcome.success ? "" : "error");
        log(outcome.message, outcome.success ? "success" : "error");
        toast(outcome.message, outcome.success ? "success" : "error");
      }
    } catch (error) {
      log(`Итог обновления: ${errorText(error)}`, "error");
    }
    // Старый счётчик «10 запусков» больше не используется
    for (const key of ["cgs-postpone-update-version", "cgs-postpone-update-launches"]) {
      try { window.cgsStorage.removeItem(key); } catch (_) {}
    }
    try {
      const info = await call("platform_info");
      window.cgsAppSession = info?.sessionId || null;
    } catch (_) {}
    state.updates.snoozedThisLaunch = consumeUpdateSnooze();
    try {
      await tauri?.event?.listen?.("cgs-update-progress", (event) => updateProgress(event.payload));
    } catch (error) {
      log(`Ход обновления: ${errorText(error)}`, "error");
    }
  }

  function renderUpdateDownloads(update = null) {
    state.updates.latest = update;
    const available = Boolean(update?.available);
    const installBtn = $("#update-install-button");
    if (installBtn) {
      installBtn.classList.toggle("hidden", !available);
      installBtn.disabled = !update?.inAppSupported && !state.updates.installing;
      installBtn.textContent = state.updates.installing
        ? updateText("Ход обновления", "Update progress")
        : updateText("Обновить и перезапустить", "Update and restart");
      installBtn.title = update?.inAppSupported || !available
        ? ""
        : updateText("В релизе нет проверяемого EXE для обновления внутри программы.", "This release has no verified EXE for in-app updates.");
    }
    $("#download-portable-button").classList.toggle("hidden", !update?.portableUrl);
    $("#download-installer-button").classList.toggle("hidden", !update?.installerUrl);
    $("#update-download-actions").classList.toggle("hidden", !available);
  }

  async function openUpdateDownload(kind) {
    const update = state.updates.latest;
    if (!update) return;
    const url = kind === "portable" ? update.portableUrl : update.installerUrl;
    await call("open_external", { url: url || update.releaseUrl });
  }

  async function checkForUpdates(interactive = false) {
    if (!interactive) await state.updates.ready;
    if (state.updates.checking || state.updates.installing) return;

    if (!invoke) {
      if (interactive) toast(updateText("Режим разработки (без Tauri backend).", "Development mode (no Tauri backend)."));
      return;
    }
    state.updates.checking = true;
    const button = $("#check-update-button");
    setBusy(button, true, updateText("Проверяем…", "Checking…"));
    setUpdateStatus("Подключение к GitHub…", "Connecting to GitHub…");

    try {
      // При фоновой проверке на старте параллельно проверяем библиотеки OpenSteamTool
      const [update, loaderUpdate] = await Promise.all([
        call("check_for_update"),
        !interactive
          ? call("luatools_check_loader_updates", { steamPath: state.lua.steamPath || null, force: false }).catch(() => null)
          : Promise.resolve(null),
      ]);

      if (loaderUpdate) {
        state.lua.loaderUpdate = loaderUpdate;
        $("#loader-update-banner")?.classList.toggle("hidden", !loaderUpdate.updateAvailable);
      }

      $("#update-current-version").textContent = update.currentVersion;
      state.version = update.currentVersion;
      const aboutVerEl = $("#about-app-version");
      if (aboutVerEl) aboutVerEl.textContent = update.currentVersion;
      const promptLoader = () => {
        if (!interactive && loaderUpdate?.updateAvailable && shouldPromptLoaderStartupUpdate()) promptLoaderUpdateModal(loaderUpdate);
      };

      if (!update.available) {
        renderUpdateDownloads();
        setUpdateStatus(`Установлена актуальная версия ${update.currentVersion}`, `Version ${update.currentVersion} is up to date`);
        if (interactive) toast(updateText("У вас установлена последняя версия", "You have the latest version installed"));
        promptLoader();
        return;
      }

      renderUpdateDownloads(update);
      if (!update.inAppSupported) {
        setUpdateStatus(
          `Доступна версия ${update.latestVersion}. В релизе нет проверяемого EXE для обновления внутри программы — скачайте его вручную.`,
          `Version ${update.latestVersion} is available. This release has no verified EXE for in-app updates, so download it manually.`,
          "available"
        );
        if (interactive || state.updates.promptedVersion !== update.latestVersion) {
          state.updates.promptedVersion = update.latestVersion;
          toast(updateText(`Доступна версия ${update.latestVersion}: скачайте её в разделе «Обновления»`, `Version ${update.latestVersion} is available: download it in Updates`));
        }
        promptLoader();
        return;
      }
      setUpdateStatus(`Доступна версия ${update.latestVersion}`, `Version ${update.latestVersion} available`, "available");
      if (!interactive) {
        // Отложено, подавлено после неудачной установки, уже показано или идут операции
        const skip = state.updates.snoozedThisLaunch || state.updates.suppressAuto
          || state.updates.promptedVersion === update.latestVersion || otherOperationsRunning();
        if (skip) {
          promptLoader();
          return;
        }
      }
      state.updates.promptedVersion = update.latestVersion;
      showUpdateDialog(loaderUpdate);
    } catch (error) {
      const message = errorText(error);
      setUpdateStatus(message, message, "error");
      log(`Проверка обновлений: ${message}`, "error");
      if (interactive) toast(message, "error");
    } finally {
      state.updates.checking = false;
      setBusy(button, false);
      button.disabled = state.updates.installing;
    }
  }

  function bindEvents() {
    // Мгновенное обновление окна обновления при смене языка интерфейса
    window.addEventListener("cgs:language-changed", () => {
      if (updateDialogOpen()) renderUpdateDialog();
      renderUpdateStatus();
      if (state.updates.latest) renderUpdateDownloads(state.updates.latest);
    });

    document.addEventListener("contextmenu", (event) => event.preventDefault(), { capture: true });
    document.addEventListener("auxclick", (event) => {
      if (event.button === 2) event.preventDefault();
    }, { capture: true });

    const titlebar = $(".titlebar");
    titlebar.addEventListener("mousedown", (event) => {
      if (event.button !== 0 || event.target.closest(".window-actions")) return;
      call("start_dragging_window").catch(() => {});
    });
    titlebar.addEventListener("dblclick", (event) => {
      if (event.target.closest(".window-actions")) return;
      call("toggle_maximize_window").catch(() => {});
    });

    $$(".nav-item").forEach((item) => item.addEventListener("click", () => switchView(item.dataset.view)));
    // Делегирование: карточки модулей главная пересобирает и прячет, обработчик не должен теряться
    document.addEventListener("click", (event) => {
      const item = event.target.closest?.("[data-open-view]");
      if (item) switchView(item.dataset.openView);
    });
    $("#browse-button").addEventListener("click", chooseDirectory);
    $("#drop-zone").addEventListener("dblclick", chooseDirectory);
    $("#scan-button").addEventListener("click", () => scanDirectory($("#game-path").value));
    $("#rescan-button").addEventListener("click", () => scanDirectory(state.gameDir));
    $("#game-path").addEventListener("keydown", (event) => { if (event.key === "Enter") scanDirectory(event.currentTarget.value); });
    $("#manual-query").addEventListener("keydown", (event) => { if (event.key === "Enter") manualSearch(); });
    $("#manual-search-button").addEventListener("click", manualSearch);
    $("#dlc-filter").addEventListener("input", (event) => renderDlcs(event.currentTarget.value));
    $("#install-button").addEventListener("click", installFix);
    $("#uninstall-button").addEventListener("click", uninstallFix);
    $("#epicfix-button").addEventListener("click", installEpicfix);
    $("#restore-eos-button").addEventListener("click", restoreEos);
    $("#scan-saves-button").addEventListener("click", scanSaveLocations);
    $("#save-toggle-selection").addEventListener("click", () => {
      const checkboxes = $$("#save-list input[type='checkbox']");
      const shouldSelect = checkboxes.some((item) => !item.checked);
      checkboxes.forEach((item) => { item.checked = shouldSelect; });
      updateSaveSelection();
    });
    $("#create-save-archive").addEventListener("click", createSaveArchive);
    $("#restore-save-archive").addEventListener("click", restoreSaveArchive);

    $("#dlc-browse-button").addEventListener("click", chooseDlcDirectory);
    $("#dlc-library-scan").addEventListener("click", scanDlcLibrary);
    $("#dlc-library-search").addEventListener("input", renderDlcLibrary);
    $("#dlc-library-folder").addEventListener("click", async () => {
      if (state.dlc.libraryScanning || state.dlc.operating) return;
      try {
        const path = await call("pick_game_directory");
        if (!path) return;
        state.dlc.extraLibrary = path;
        // Проверка папки перед сохранением пути
        const result = await call("scan_installed_steam_games", { steamPath: state.lua.steamPath || null, libraryPath: path });
        state.dlc.games = result.games || []; state.dlc.libraryScanned = true;
        window.cgsStorage.setItem("dlcExtraLibrary", path);
        $("#dlc-library-status").textContent = `Установлено игр: ${state.dlc.games.length} · Библиотек: ${result.libraries.length}`;
        renderDlcLibrary();
      } catch (error) { state.dlc.extraLibrary = window.cgsStorage.getItem("dlcExtraLibrary") || ""; toast(errorText(error), "error"); }
    });
    $("#dlc-back").addEventListener("click", () => {
      if (state.dlc.operating) return;
      ++state.dlc.requestId;
      state.dlc.scanning = false; state.dlc.catalogLoading = false;
      setBusy($("#dlc-scan-button"), false);
      dlcShowDetail(false); renderDlcLibrary();
      $("#dlc-library-status").textContent = `Установлено игр: ${state.dlc.games.length}`;
    });
    $$("[data-dlc-method]").forEach((button) => button.addEventListener("click", () => {
      if (state.dlc.operating) return;
      state.dlc.method = button.dataset.dlcMethod;
      restoreDlcSelection(); renderDlcMethod(); renderDlcCatalog($("#dlc-search").value);
    }));
    $$("[data-dlc-proxy]").forEach((button) => button.addEventListener("click", () => {
      if (state.dlc.operating) return;
      state.dlc.proxy = button.dataset.dlcProxy; renderDlcMethod();
    }));
    $("#dlc-exe-select").addEventListener("change", (event) => {
      if (state.dlc.operating) return;
      state.dlc.exePath = event.currentTarget.value;
      if (dlcExe()?.proxy) state.dlc.proxy = dlcExe().proxy;
      restoreDlcSelection(); renderDlcMethod(); renderDlcCatalog($("#dlc-search").value);
    });
    $("#dlc-catalog-retry").addEventListener("click", () => {
      if (!state.dlc.operating && !state.dlc.scanning && !state.dlc.catalogLoading) loadDlcCatalog(state.dlc.appid);
    });
    $("#dlc-drop-zone").addEventListener("dblclick", chooseDlcDirectory);
    $("#dlc-scan-button").addEventListener("click", () => scanDlcDirectory($("#dlc-path").value));
    $("#dlc-rescan-button").addEventListener("click", () => scanDlcDirectory(state.dlc.gameDir));
    $("#dlc-path").addEventListener("keydown", (event) => { if (event.key === "Enter") scanDlcDirectory(event.currentTarget.value); });
    $("#dlc-manual-query").addEventListener("keydown", (event) => { if (event.key === "Enter") dlcManualSearch(); });
    $("#dlc-manual-button").addEventListener("click", dlcManualSearch);
    $("#dlc-search").addEventListener("input", (event) => renderDlcCatalog(event.currentTarget.value));
    $("#dlc-unlock-all").addEventListener("change", updateDlcSelection);
    $("#dlc-toggle-selection").addEventListener("click", () => {
      const shouldSelect = state.dlc.catalog.some((item) => !item.enabled);
      state.dlc.catalog.forEach((item) => { item.enabled = shouldSelect; });
      renderDlcCatalog($("#dlc-search").value);
    });
    $("#dlc-install-button").addEventListener("click", installDlcUnlocker);
    $("#dlc-uninstall-button").addEventListener("click", uninstallDlcUnlocker);

    $("#lua-browse-button").addEventListener("click", luaBrowseFiles);
    $("#lua-drop-zone").addEventListener("dblclick", luaBrowseFiles);
    $("#lua-refresh-button").addEventListener("click", luaRefresh);
    $("#lua-restart-button").addEventListener("click", luaRestartSteam);
    $("#millennium-site-button").addEventListener("click", downloadMillenniumInstaller);
    $("#millennium-migrate-button")?.addEventListener("click", migrateCrocluaToEclipseManifest);
    $("#millennium-install-button").addEventListener("click", installMillenniumPlugin);
    $("#millennium-remove-button").addEventListener("click", removeMillenniumPlugin);
    $("#lua-steam-browse").addEventListener("click", async () => {
      try {
        const path = await call("pick_game_directory");
        if (path) { state.lua.steamPath = path; window.cgsStorage.setItem("luaSteamPath", path); await luaRefresh(); window.cgsLocalCloud?.refresh(); }
      } catch (error) { toast(errorText(error), "error"); }
    });
    $("#lua-steam-path").addEventListener("change", (event) => {
      state.lua.steamPath = event.currentTarget.value.trim();
      window.cgsStorage.setItem("luaSteamPath", state.lua.steamPath);
      luaRefresh();
    });
    const luaDrop = $("#lua-drop-zone");
    ["dragenter", "dragover"].forEach((name) => luaDrop.addEventListener(name, (event) => { event.preventDefault(); luaDrop.classList.add("dragover"); }));
    ["dragleave", "drop"].forEach((name) => luaDrop.addEventListener(name, (event) => { event.preventDefault(); luaDrop.classList.remove("dragover"); }));
    luaDrop.addEventListener("drop", (event) => {
      const files = [...(event.dataTransfer?.files || [])].map((file) => file.path).filter(Boolean);
      if (files.length) luaInstall(files);
    });
    const luaDetail = $("#lua-detail-backdrop");
    const closeLuaDetail = () => {
      if (!luaDetail || luaDetail.classList.contains("hidden")) return;
      luaDetail.classList.add("closing");
      setTimeout(() => {
        luaDetail.classList.add("hidden");
        luaDetail.classList.remove("closing");
      }, 190);
    };
    $("#lua-detail-close")?.addEventListener("click", closeLuaDetail);
    luaDetail?.addEventListener("click", (event) => { if (event.target === luaDetail) closeLuaDetail(); });

    const luaSearchInput = $("#lua-search-input");
    luaSearchInput.addEventListener("input", (event) => {
      clearTimeout(luaSearchTimer);
      const value = event.currentTarget.value;
      luaSearchTimer = setTimeout(() => luaSearch(value), 280);
    });
    luaSearchInput.addEventListener("focus", () => {
      if ($("#lua-search-dropdown").childElementCount) $("#lua-search-dropdown").classList.remove("hidden");
    });
    document.addEventListener("click", (event) => {
      if (!event.target.closest(".lua-search-wrap")) $("#lua-search-dropdown").classList.add("hidden");
    });
    const dlcDrop = $("#dlc-drop-zone");
    ["dragenter", "dragover"].forEach((name) => dlcDrop.addEventListener(name, (event) => { event.preventDefault(); dlcDrop.classList.add("dragover"); }));
    ["dragleave", "drop"].forEach((name) => dlcDrop.addEventListener(name, (event) => { event.preventDefault(); dlcDrop.classList.remove("dragover"); }));
    dlcDrop.addEventListener("drop", (event) => {
      const path = event.dataTransfer?.files?.[0]?.path;
      if (path) scanDlcDirectory(path);
    });

    $("#clear-log").addEventListener("click", () => { $("#activity-log").replaceChildren(); log("Журнал очищен", "system"); });
    const telegramModal = $("#telegram-hub-backdrop");
    let telegramClosing = false;
    const openTelegramHub = () => {
      if (!telegramModal) return;
      telegramModal.classList.remove("hidden", "closing");
      telegramClosing = false;
    };
    const closeTelegramHub = () => {
      if (!telegramModal || telegramClosing || telegramModal.classList.contains("hidden")) return;
      telegramClosing = true;
      telegramModal.classList.add("closing");
      setTimeout(() => {
        telegramModal.classList.add("hidden");
        telegramModal.classList.remove("closing");
        telegramClosing = false;
      }, 190);
    };

    $("#open-telegram-hub")?.addEventListener("click", openTelegramHub);
    $("#telegram-hub-close")?.addEventListener("click", closeTelegramHub);
    telegramModal?.addEventListener("click", (event) => {
      if (event.target === telegramModal) closeTelegramHub();
    });
    const appUpdateModal = $("#app-update-backdrop");
    // Щелчок мимо окна закрывает его, но не отменяет идущую установку
    appUpdateModal?.addEventListener("click", (event) => {
      if (event.target === appUpdateModal && !state.updates.installing) hideUpdateDialog();
    });

    const loaderModalBackdrop = $("#loader-update-backdrop");

    document.addEventListener("keydown", (event) => {
      if (event.key === "Tab" && updateDialogOpen()) {
        const controls = [...appUpdateModal.querySelectorAll("button:not(:disabled), summary, input:not(:disabled)")].filter((node) => node.getClientRects().length);
        const first = controls[0];
        const last = controls.at(-1);
        if (event.shiftKey && (document.activeElement === first || !controls.includes(document.activeElement))) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !controls.includes(document.activeElement))) { event.preventDefault(); first?.focus(); }
        return;
      }
      if (event.key === "Escape") {
        if (updateDialogOpen()) {
          event.preventDefault();
          closeUpdateDialog();
        } else if (loaderModalBackdrop && !loaderModalBackdrop.classList.contains("hidden")) {
          closeLoaderUpdateModal();
        } else if (telegramModal && !telegramModal.classList.contains("hidden")) {
          closeTelegramHub();
        } else if (luaDetail && !luaDetail.classList.contains("hidden")) {
          closeLuaDetail();
        }
      }
    });

    const openChannelUrl = async (url) => {
      try { await call("open_external", { url }); }
      catch (error) { toast(errorText(error), "error"); }
    };

    $("#hub-channel-personal")?.addEventListener("click", () => openChannelUrl("https://t.me/crocodilehub2"));
    $("#hub-channel-fork")?.addEventListener("click", () => openChannelUrl("https://t.me/gde_sparki"));
    $("#hub-channel-community")?.addEventListener("click", () => openChannelUrl("https://t.me/piratestationn"));

    $("#open-personal-channel")?.addEventListener("click", () => openChannelUrl("https://t.me/crocodilehub2"));
    $("#open-fork-channel")?.addEventListener("click", () => openChannelUrl("https://t.me/gde_sparki"));
    $("#open-community-channel")?.addEventListener("click", () => openChannelUrl("https://t.me/piratestationn"));
    $("#window-minimize").addEventListener("click", () => call("minimize_window").catch(() => {}));
    $("#window-maximize").addEventListener("click", () => call("toggle_maximize_window").catch(() => {}));
    $("#window-close").addEventListener("click", () => call("close_window").catch(() => {}));
    $$(".accent").forEach((button) => button.addEventListener("click", () => applyAccent(button.dataset.accent)));

    $$(".svc-option").forEach((button) => {
      button.addEventListener("click", () => {
        applyManifestService(button.dataset.service);
        updateHubcapKeyStatus();
      });
      button.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          applyManifestService(button.dataset.service);
          updateHubcapKeyStatus();
        }
      });
    });

    // Выбор версии загрузчика манифестов в Steam (OpenSteamTool)
    $$(".loader-option").forEach((button) => {
      button.addEventListener("click", () => applyLoaderSource(button.dataset.loaderSource));
      button.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          applyLoaderSource(button.dataset.loaderSource);
        }
      });
    });

    // Кнопки принудительного применения загрузчика в Steam
    $("#manifest-loader-apply-btn")?.addEventListener("click", (e) => applyLoaderToSteam(e.currentTarget));
    $("#settings-loader-apply-btn")?.addEventListener("click", (e) => applyLoaderToSteam(e.currentTarget));

    // Кнопки синхронизации файлов загрузчика OpenSteamTool с GitHub
    $("#manifest-loader-sync-btn")?.addEventListener("click", () => checkLoaderDllUpdates(true, true));
    $("#settings-loader-sync-btn")?.addEventListener("click", () => checkLoaderDllUpdates(true, true));

    // Кнопки тестирования системы обновления библиотек OpenSteamTool
    $("#manifest-loader-test-btn")?.addEventListener("click", (e) => testLoaderUpdate(e.currentTarget));
    $("#settings-loader-test-btn")?.addEventListener("click", (e) => testLoaderUpdate(e.currentTarget));
    $("#test-loader-update-button")?.addEventListener("click", (e) => testLoaderUpdate(e.currentTarget));
    $("#loader-update-action")?.addEventListener("click", () => {
      if (state.lua.loaderUpdate?.updateAvailable) {
        promptLoaderUpdateModal(state.lua.loaderUpdate);
      } else {
        checkLoaderDllUpdates(true, true);
      }
    });

    // Обработчики модального окна обновления библиотек загрузчика
    $("#loader-modal-cancel")?.addEventListener("click", closeLoaderUpdateModal);
    loaderModalBackdrop?.addEventListener("click", (event) => {
      if (event.target === loaderModalBackdrop) closeLoaderUpdateModal();
    });

    // Переключение радиокнопок параметров в комбинированном обновлении
    $$("input[name='app-update-scope']").forEach((radio) => {
      radio.addEventListener("change", () => {
        $$(".loader-choice").forEach((choice) => {
          const input = choice.querySelector("input[name='app-update-scope']");
          choice.classList.toggle("active", Boolean(input?.checked));
        });
      });
    });
    $("#hubcap-key").addEventListener("input", (event) => {
      state.lua.hubcapKey = event.currentTarget.value.trim();
      clearTimeout(secretSaveTimers.hubcap); secretSaveTimers.hubcap = setTimeout(() => saveApiSecret("hubcap", event.target).catch(() => {}), 500);
      updateHubcapKeyStatus();
      clearTimeout(hubcapKeyTimer);
      hubcapKeyTimer = setTimeout(() => refreshHubcapUsage(), 650);
    });
    $("#hubcap-key-visibility")?.addEventListener("click", () => {
      const input = $("#hubcap-key");
      if (!input) return;
      const isPassword = input.type === "password";
      input.type = isPassword ? "text" : "password";
      $(".eye-show", "#hubcap-key-visibility")?.classList.toggle("hidden", isPassword);
      $(".eye-hide", "#hubcap-key-visibility")?.classList.toggle("hidden", !isPassword);
    });
    $("#hubcap-key-paste")?.addEventListener("click", async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (text) {
          const input = $("#hubcap-key");
          input.value = text.trim();
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
      } catch (_) {}
    });
    $$('input[name="ryuu-key-source"]').forEach((input) => {
      input.addEventListener("change", () => {
        if (input.checked) applyRyuuKeySource(input.value);
      });
    });
    $("#ryuu-key")?.addEventListener("input", (event) => {
      state.lua.ryuuKey = event.currentTarget.value.trim();
      clearTimeout(secretSaveTimers.ryuu); secretSaveTimers.ryuu = setTimeout(() => saveApiSecret("ryuu", event.target).catch(() => {}), 500);
      updateRyuuKeyStatus();
    });
    $("#ryuu-key-visibility")?.addEventListener("click", () => {
      const input = $("#ryuu-key");
      if (!input) return;
      const isPassword = input.type === "password";
      input.type = isPassword ? "text" : "password";
      $(".eye-show", "#ryuu-key-visibility")?.classList.toggle("hidden", isPassword);
      $(".eye-hide", "#ryuu-key-visibility")?.classList.toggle("hidden", !isPassword);
    });
    $("#ryuu-key-paste")?.addEventListener("click", async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (text) {
          const input = $("#ryuu-key");
          input.value = text.trim();
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
      } catch (_) {}
    });
    $("#check-update-button").addEventListener("click", () => checkForUpdates(true));
    $("#update-install-button")?.addEventListener("click", () => showUpdateDialog());
    $("#app-update-install").addEventListener("click", installAppUpdate);
    $("#app-update-defer").addEventListener("click", deferUpdate);
    $("#app-update-cancel").addEventListener("click", cancelAppUpdate);
    $("#app-update-close").addEventListener("click", closeUpdateDialog);
    $("#download-portable-button").addEventListener("click", () => openUpdateDownload("portable").catch((error) => toast(errorText(error), "error")));
    $("#download-installer-button").addEventListener("click", () => openUpdateDownload("installer").catch((error) => toast(errorText(error), "error")));

    const dropZone = $("#drop-zone");
    ["dragenter", "dragover"].forEach((name) => dropZone.addEventListener(name, (event) => { event.preventDefault(); dropZone.classList.add("dragover"); }));
    ["dragleave", "drop"].forEach((name) => dropZone.addEventListener(name, (event) => { event.preventDefault(); dropZone.classList.remove("dragover"); }));
    dropZone.addEventListener("drop", (event) => {
      const path = event.dataTransfer?.files?.[0]?.path;
      if (path) scanDirectory(path);
    });

    if (tauri?.event?.listen) {
      call("enable_file_drop").catch(() => {});
      const onDropPaths = (paths) => {
        // Перетаскивание файлов не запускает операции во время обновления программы
        if (state.updates.installing) return;
        const path = (paths || [])[0];
        if (!path) return;
        if ($("#view-lua").classList.contains("active")) {
          luaInstall(paths);
        } else if ($("#view-dlc").classList.contains("active")) {
          scanDlcDirectory(path);
        } else {
          switchView("fix");
          scanDirectory(path);
        }
      };
      tauri.event.listen("cgs-file-drop", (event) => onDropPaths(event.payload?.paths)).catch(() => {});
      tauri.event.listen("tauri://drag-drop", (event) => onDropPaths(event.payload?.paths)).catch(() => {});
      tauri.event.listen("tauri://drag-enter", () => dropZone.classList.add("dragover")).catch(() => {});
      tauri.event.listen("tauri://drag-leave", () => dropZone.classList.remove("dragover")).catch(() => {});
    }
  }

  function boot() {
    bindEvents();
    // Сигнал здоровья после обновления и счётчик откладываний — до фоновой проверки версий
    state.updates.ready = initUpdates().catch(() => {});
    applyAccent(window.cgsStorage.getItem("accent") || "white");
    // Раздел при запуске: ?view= в адресе важнее настройки «Открывать при запуске»
    const requestedView = new URLSearchParams(window.location.search).get("view");
    const start = requestedView && viewMeta[requestedView] ? { view: requestedView, tab: "" }
      : window.cgsHome?.startTarget?.(Object.keys(viewMeta)) || { view: "home", tab: "" };
    switchView(viewMeta[start.view] ? start.view : "home");
    if (start.tab) $(`[data-hv-tab="${start.tab}"]`)?.click();
    const lastPath = window.cgsStorage.getItem("lastGamePath");
    if (lastPath) $("#game-path").value = lastPath;
    state.lua.steamPath = window.cgsStorage.getItem("luaSteamPath") || "";
    state.lua.service = window.cgsStorage.getItem("manifestService") === "hubcap" ? "hubcap" : "ryuu";
    state.lua.hubcapKey = window.cgsStorage.isSecretConfigured("hubcap") ? "stored" : "";
    state.lua.ryuuKey = window.cgsStorage.isSecretConfigured("ryuu") ? "stored" : "";
    const savedRyuuKeySource = window.cgsStorage.getItem("ryuuKeySource");
    applyRyuuKeySource(["crocodile", "custom"].includes(savedRyuuKeySource)
      ? savedRyuuKeySource
      : state.lua.ryuuKey ? "custom" : "crocodile");
    applyManifestService(state.lua.service);
    $("#hubcap-key").value = ""; $("#hubcap-key").placeholder = state.lua.hubcapKey ? "Ключ сохранён в Windows. Введите новый для замены" : "API-ключ HubCap";
    if ($("#ryuu-key")) { $("#ryuu-key").value = ""; $("#ryuu-key").placeholder = state.lua.ryuuKey ? "Ключ сохранён в Windows. Введите новый для замены" : "API-ключ Ryuu"; }
    updateHubcapKeyStatus();
    updateRyuuKeyStatus();
    renderLoaderInfo();
    updateAboutInfo();
    log("Eclipse Studio 9.0.0 инициализирован", "system");
    log(invoke ? "Все компоненты готовы к работе" : "Запустите установленное приложение", invoke ? "success" : "error");

    // Страховочный вызов отображения окна, если заставка была отключена в параметрах
    call("show_window").catch(() => {});

    // Воспроизведение звука запуска, если графическая заставка была отключена
    if (window.cgsStorage.getItem("cgs-splash") === "0") {
      try {
        window.cgsAudio?.playStartup();
      } catch (_) {}
    }

    // Отложенный запуск фоновых задач после окончания заставки для обеспечения максимальной производительности интерфейса
    let idleTasksStarted = false;
    function scheduleIdleTasks() {
      if (idleTasksStarted) return;
      idleTasksStarted = true;
      const hubcapActive = () => state.lua.service === "hubcap" && Boolean(state.lua.hubcapKey.trim());
      if (hubcapActive()) refreshHubcapUsage();
      if (invoke) checkForUpdates(false);
      setInterval(() => {
        if (hubcapActive()) refreshHubcapUsage();
      }, 30_000);
      setInterval(() => {
        if ($("#view-lua")?.classList.contains("active")) refreshMillenniumStatus();
        // Диагностика не изменяет папку Steam в фоне
      }, 4_000);
    }

    const splashEl = document.getElementById("app-splash");
    if (!splashEl || splashEl.classList.contains("hidden") || window.cgsStorage.getItem("cgs-splash") === "0") {
      setTimeout(scheduleIdleTasks, 600);
    } else {
      window.addEventListener("splash-finished", () => {
        setTimeout(scheduleIdleTasks, 800);
      }, { once: true });
      // Страховочный таймер на случай быстрого пропуска или непредвиденного поведения
      setTimeout(scheduleIdleTasks, 5500);
    }
  }

  window.cgsOpenGame = path => { switchView("fix"); $("#game-path").value = path; scanDirectory(path); };
  // Тихо загружаем игры Manifest и Steam для быстрого поиска без обновления страниц и уведомлений
  window.cgsLibrary = {
    manifest: () => state.lua.loaded ? state.lua.games.map((game) => ({ appid: String(game.appid), name: state.lua.names[game.appid] || "" })) : null,
    steam: () => state.dlc.libraryScanned ? state.dlc.games.map((game) => ({ ...game })) : null,
    async loadManifest(known = {}) {
      const status = await call("luatools_status", { steamPath: state.lua.steamPath || null });
      const ids = (status?.games || []).map((game) => String(game.appid));
      const missing = ids.filter((appid) => !state.lua.names[appid] && !known[appid]);
      if (missing.length) {
        const names = await call("luatools_names", { appids: missing.map(Number) }).catch(() => null);
        if (names) Object.assign(state.lua.names, names);
      }
      return ids.map((appid) => ({ appid, name: state.lua.names[appid] || known[appid] || "" }));
    },
    async loadSteam() {
      const result = await call("scan_installed_steam_games", { steamPath: state.lua.steamPath || null, libraryPath: state.dlc.extraLibrary || null });
      return (result?.games || []).map((game) => ({ ...game }));
    },
    openManifest(appid) {
      switchView("lua");
      luaOpenDetail(String(appid));
    },
    // Как нажатие на карточку игры в библиотеке Steam раздела DLC
    openSteam(game) {
      if (!game?.gameDir || state.dlc.scanning || state.dlc.libraryScanning || state.dlc.operating) return false;
      switchView("dlc");
      scanDlcDirectory(game.gameDir, game);
      return true;
    },
  };
  if (window.cgsModulesLoading) window.addEventListener("cgs:modules-loaded", boot, {once:true});
  else if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true }); else boot();
})();
