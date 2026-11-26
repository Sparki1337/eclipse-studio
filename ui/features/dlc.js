(() => {
  "use strict";

  // dlc — раздел «DLC Unlocker»: сканирование библиотеки Steam, каталог DLC, CreamAPI и SmokeAPI
  window.cgsDlc = {
    create({ state, $, $$, call, setBusy, log, toast, errorText, consumeResult, showModal, basename }) {
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

  let dlcCatalogRenderToken = 0;

  function renderDlcCatalog(filter = "") {
    const token = ++dlcCatalogRenderToken;
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

    const buildRow = (entry) => {
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
      return row;
    };

    // Порционная отрисовка крупных каталогов DLC (сотни позиций) без блокировки кадра
    const CHUNK = 45;
    let index = 0;
    const renderChunk = () => {
      if (token !== dlcCatalogRenderToken) return;
      const fragment = document.createDocumentFragment();
      const end = Math.min(index + CHUNK, visible.length);
      for (; index < end; index += 1) {
        fragment.appendChild(buildRow(visible[index]));
      }
      container.appendChild(fragment);
      if (index < visible.length) {
        (window.requestAnimationFrame || ((cb) => setTimeout(cb, 16)))(renderChunk);
      }
    };
    renderChunk();
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


    return {
      dlcExe, dlcInstalled, dlcShowDetail, renderDlcLibrary, scanDlcLibrary,
      renderDlcMethod, restoreDlcSelection, updateDlcSelection, renderDlcCatalog,
      renderDlcGame, loadDlcCatalog, scanDlcDirectory, chooseDlcDirectory,
      dlcManualSearch, installDlcUnlocker, uninstallDlcUnlocker,
    };
    },
  };
})();
