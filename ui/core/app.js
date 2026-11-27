(() => {
  "use strict";

  // app — координатор интерфейса: навигация, тосты, IPC-события, обновление
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

  const state = {
    version: "10.4.0",
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
      // Галочка «Сторонние добавления»: игры, добавленные LuaTools и другими
      // Сторонние добавления включены по умолчанию, выключение запоминается
      showExternal: window.cgsStorage.getItem("cgs-lua-external") !== "0",
      externalCount: 0,
      names: {},
      headers: {},
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
    if (type === "success") {
      try {
        window.cgsAudio?.playSuccess();
      } catch (_) {}
    }
    const item = document.createElement("div");
    item.className = `toast ${type}`;
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
    window.cgsPerf?.setPhase("вкладка " + name);
    // Во время обновления доступен только раздел настроек с ходом установки
    if (state.updates.installing && name !== "settings") return;
    if (!viewMeta[name]) return;
    $$("[data-view-panel]").forEach((panel) => panel.classList.toggle("active", panel.dataset.viewPanel === name));
    $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === name));
    $("#page-eyebrow").textContent = viewMeta[name][0];
    $("#page-title").textContent = viewMeta[name][1];
    if (name === "lua" || name === "settings") {
      if (name === "lua") {
        window.cgsPerf?.mark("lua-open");
        primeLuaFromCache();
      }
      // Автоматический переход не сканирует диск, если данные свежие
      luaRefresh({ force: false });
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

  let luaSearchTimer = null;
  const secretSaveTimers = {};
  let hubcapKeyTimer = null;

  const {
    dlcExe, dlcInstalled, dlcShowDetail, renderDlcLibrary, scanDlcLibrary,
    renderDlcMethod, restoreDlcSelection, updateDlcSelection, renderDlcCatalog,
    renderDlcGame, loadDlcCatalog, scanDlcDirectory, chooseDlcDirectory,
    dlcManualSearch, installDlcUnlocker, uninstallDlcUnlocker,
  } = window.cgsDlc.create({ state, $, $$, call, setBusy, log, toast, errorText, consumeResult, showModal, basename });

  const {
    primeLuaFromCache, luaRefresh, refreshMillenniumStatus, renderLoaderInfo,
    applyManifestService, updateHubcapKeyStatus, hasRyuuKey, applyRyuuKeySource,
    updateRyuuKeyStatus, renderHubcapUsage, refreshHubcapUsage,
    luaOpenDetail, luaBrowseFiles, luaRestartSteam, luaToggle, luaRemove,
    downloadMillenniumInstaller, offerMillenniumInstall, migrateCrocluaToEclipseManifest,
    installMillenniumPlugin, removeMillenniumPlugin, luaInstall, luaSearch,
    applyLoaderSource, applyLoaderToSteam, checkLoaderDllUpdates, testLoaderUpdate,
    promptLoaderUpdateModal, closeLoaderUpdateModal, performLoaderUpdate,
    shouldPromptLoaderStartupUpdate, saveApiSecret,
  } = window.cgsManifest.create({ state, $, $$, invoke, call, setBusy, log, toast, errorText, consumeResult, showModal, updateAboutInfo, secretSaveTimers });

  const {
    extractChangelog, renderUpdateNotes, updateText, setUpdateStatus,
    renderUpdateStatus, renderUpdateDownloads, updateDialogOpen,
    renderUpdateDialog, showUpdateDialog, hideUpdateDialog, closeUpdateDialog,
    deferUpdate, cancelAppUpdate, installAppUpdate, updateProgress,
    initUpdates, openUpdateDownload, checkForUpdates,
  } = window.cgsUpdates.create({
    state, $, $$, tauri, invoke, call, setBusy, log, toast, errorText, showModal,
    activeOperations, checkLoaderDllUpdates, performLoaderUpdate,
    shouldPromptLoaderStartupUpdate, promptLoaderUpdateModal,
  });

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
    const accepted = await showModal("Удалить Online Fix?", "Будет применён весь общий журнал .backup_orig в папке игры, включая файлы архивного установщика и других операций. Это не выборочный откат одного модуля. Изменённые после установки и неизвестные файлы не перезаписываются и не удаляются; при конфликте журнал сохраняется.", { confirm: true, confirmText: "Удалить и восстановить", symbol: "↺" });
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

  async function updateAboutInfo() {
    // Версия без суффикса Portable x64 — других сборок нет
    const appVerEl = $("#about-app-version");
    if (appVerEl) {
      const currentVer = state.version || $("#update-current-version")?.textContent?.trim() || $(".titlebar-version")?.textContent?.trim() || "10.4.0";
      state.version = currentVer;
      appVerEl.textContent = currentVer;
    }

    // Версия Eclipse HV без буквы v
    const hvVerEl = $("#about-hv-version");
    if (hvVerEl) {
      if (invoke) {
        try {
          const hvStatus = await call("eclipse_hv_status");
          if (hvStatus && hvStatus.installed) {
            const rawVer = hvStatus.version || "10.4.0";
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

  function bindEvents() {
    // Смена языка обновляет карточку обновления
    window.addEventListener("cgs:language-changed", () => {
      if (updateDialogOpen()) renderUpdateDialog();
      renderUpdateStatus();
      if (state.updates.latest) renderUpdateDownloads(state.updates.latest);
      // Карточки исключены из глобального перевода — обновляем их отдельно
      window.cgsI18n?.translate($("#lua-games"));
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
        // Папку проверяем до сохранения пути
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
    // Галочка «Сторонние добавления»: показывать игры, добавленные другими инструментами
    const luaExternalToggle = $("#lua-show-external");
    if (luaExternalToggle) {
      luaExternalToggle.checked = Boolean(state.lua.showExternal);
      luaExternalToggle.addEventListener("change", () => {
        state.lua.showExternal = luaExternalToggle.checked;
        window.cgsStorage.setItem("cgs-lua-external", luaExternalToggle.checked ? "1" : "0");
        luaRefresh();
      });
    }
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
        if (window.cgsLocalCloud?.updateOpen?.()) {
          event.preventDefault();
          window.cgsLocalCloud.closeUpdate();
        } else if (updateDialogOpen()) {
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
    $("#hub-channel-discord")?.addEventListener("click", () => openChannelUrl("https://discord.gg/Vwp5DAnFG"));

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

    // ── Загрузчик OpenSteamTool
    $$(".loader-option").forEach((button) => {
      button.addEventListener("click", () => applyLoaderSource(button.dataset.loaderSource));
      button.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          applyLoaderSource(button.dataset.loaderSource);
        }
      });
    });

    $("#manifest-loader-apply-btn")?.addEventListener("click", (e) => applyLoaderToSteam(e.currentTarget));
    $("#settings-loader-apply-btn")?.addEventListener("click", (e) => applyLoaderToSteam(e.currentTarget));

    $("#manifest-loader-sync-btn")?.addEventListener("click", () => checkLoaderDllUpdates(true, true));
    $("#settings-loader-sync-btn")?.addEventListener("click", () => checkLoaderDllUpdates(true, true));

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

    $("#loader-modal-cancel")?.addEventListener("click", closeLoaderUpdateModal);
    loaderModalBackdrop?.addEventListener("click", (event) => {
      if (event.target === loaderModalBackdrop) closeLoaderUpdateModal();
    });

    // Радиокнопки режима комбинированного обновления
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

  async function boot() {
    bindEvents();
    // Замеры включаются запуском приложения с флагом --perf
    try {
      if (await call("perf_mode_enabled")) window.cgsPerf?.setEnabled(true);
    } catch (_) {
      // В сборке без команды замеры просто выключены
    }
    // Сигнал здоровья после обновления и счётчик откладываний — до фоновой проверки версий
    // Проверка обновлений не мешает первому кадру: запускаем в простое
    const startUpdateCheck = () => {
      state.updates.ready = initUpdates().catch(() => {});
    };
    if ("requestIdleCallback" in window) requestIdleCallback(startUpdateCheck, { timeout: 1500 });
    else setTimeout(startUpdateCheck, 400);
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
    log("Eclipse Studio 10.4.0 инициализирован", "system");
    log(invoke ? "Все компоненты готовы к работе" : "Запустите установленное приложение", invoke ? "success" : "error");

    // Страховочный показ окна, если заставка отключена
    call("show_window").catch(() => {});

    // Звук запуска при отключённой заставке
    if (window.cgsStorage.getItem("cgs-splash") === "0") {
      try {
        window.cgsAudio?.playStartup();
      } catch (_) {}
    }

    // Фоновые задачи — после заставки, чтобы не тормозить интерфейс
    let idleTasksStarted = false;
    function scheduleIdleTasks() {
      if (idleTasksStarted) return;
      idleTasksStarted = true;
      const hubcapActive = () => state.lua.service === "hubcap" && Boolean(state.lua.hubcapKey.trim());
      if (hubcapActive()) refreshHubcapUsage();
      if (invoke) checkForUpdates(false);
      setInterval(() => {
        if (hubcapActive() && !document.hidden) refreshHubcapUsage();
      }, 30_000);
      // Вместо постоянного 4-секундного опроса обновляем статус плагина при возврате фокуса окна
      let lastFocusRefresh = 0;
      document.addEventListener("visibilitychange", () => {
        if (document.hidden || !$("#view-lua")?.classList.contains("active")) return;
        const now = Date.now();
        if (now - lastFocusRefresh < 15_000) return;
        lastFocusRefresh = now;
        refreshMillenniumStatus();
      });
    }

    const splashEl = document.getElementById("app-splash");
    if (!splashEl || splashEl.classList.contains("hidden") || window.cgsStorage.getItem("cgs-splash") === "0") {
      setTimeout(scheduleIdleTasks, 600);
    } else {
      window.addEventListener("splash-finished", () => {
        setTimeout(scheduleIdleTasks, 800);
      }, { once: true });
      // Страховочный таймер на случай зависания заставки
      setTimeout(scheduleIdleTasks, 5500);
    }
  }

  window.cgsOpenGame = path => { switchView("fix"); $("#game-path").value = path; scanDirectory(path); };
  // Тихая загрузка библиотек Manifest и Steam для быстрого поиска
  window.cgsLibrary = {
    manifest: () => state.lua.loaded ? state.lua.games.map((game) => ({ appid: String(game.appid), name: state.lua.names[game.appid] || "" })) : null,
    steam: () => state.dlc.libraryScanned ? state.dlc.games.map((game) => ({ ...game })) : null,
    async loadManifest(known = {}) {
      const status = await call("luatools_status", { steamPath: state.lua.steamPath || null, includeExternal: state.lua.showExternal });
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
    // Эквивалент клика по карточке игры в библиотеке Steam раздела DLC
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
