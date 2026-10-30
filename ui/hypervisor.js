(() => {
  "use strict";

  const invoke = window.__TAURI__?.core?.invoke;
  const listen = window.__TAURI__?.event?.listen;
  const $ = (selector, root = document) => root.querySelector(selector);

  const steps = [
    ["Проверка системы", "Core Isolation и права администратора"],
    ["Подготовка запуска", "Конфигурация гипервизора и DSE"],
    ["Служебные файлы", "Проверка загрузчика и BAT-файла"],
    ["Запуск сценария", "Системная подготовка Windows"],
    ["Запуск игры", "Старт выбранного EXE"],
    ["Возврат DSE", "Восстановление после запуска"],
    ["Очистка", "Завершение сценария"],
  ];

  const defaultLaunchers = [
    { id: "hv_launcher", badge: "HV", name: "Eclipse-HV", batch_name: "Eclipse-HV.exe", helper_label: "Eclipse-HV.exe" },

  ];

  const state = {
    selectedId: null,
    launchers: [...defaultLaunchers],
    games: [],
    running: false,
    launching: false,
    gameRunning: false,
    processMonitorToken: 0,
    initialized: false,
    confirmingRemove: "",
    profileSwitching: false,
    pendingProfile: null,
  };

  const call = (command, args = {}) => {
    if (!invoke) return Promise.reject(new Error("Системный модуль недоступен"));
    return invoke(command, args);
  };

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  // Кэш и очередь загрузки обложек игр
  const artworkRequests = new Map();
  const artworkAssets = new Map();
  const artworkUrls = new Set();
  const artworkQueue = [];
  let artworkActive = 0;
  function artworkJob(task) {
    return new Promise(resolve => { artworkQueue.push({ task, resolve }); pumpArtwork(); });
  }
  function pumpArtwork() {
    while (artworkActive < 4 && artworkQueue.length) {
      const { task, resolve } = artworkQueue.shift(); artworkActive++;
      Promise.resolve().then(task).catch(() => null).then(resolve).finally(() => { artworkActive--; pumpArtwork(); });
    }
  }
  function artworkKey(game) { return String(game?.exe_path || "").toLowerCase(); }
  function coverMarkup(game) {
    const initials = String(game?.name || "").trim().split(/\s+/).map(word => [...word][0] || "").slice(0, 2).join("").toLocaleUpperCase();
    return `<span class="hv-cover-fallback"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 8h10c3 0 5 10 3 11-2 1-4-3-5-3H9c-1 0-3 4-5 3C2 18 4 8 7 8zM7 10v5m-2.5-2.5h5M16 11h.01M18 14h.01"/></svg><span>${escapeHtml(initials || "—")}</span></span><img class="hv-cover-image" alt="" draggable="false" decoding="async" referrerpolicy="no-referrer" />`;
  }
  function allowedArtworkUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && (url.hostname === "steamstatic.com" || url.hostname.endsWith(".steamstatic.com") || url.hostname === "steamcdn-a.akamaihd.net") ? url.href : null;
    } catch (_) { return null; }
  }
  function probeArtwork(url) {
    return new Promise(resolve => {
      const img = new Image(); let timer;
      const finish = success => { clearTimeout(timer); img.onload = img.onerror = null; if (!success) img.removeAttribute("src"); resolve(success ? url : null); };
      img.onload = () => finish(img.naturalWidth > 0); img.onerror = () => finish(false);
      img.referrerPolicy = "no-referrer";
      timer = setTimeout(() => finish(false), 8000);
      img.src = url;
    });
  }
  async function loadArtwork(meta) {
    if (meta?.local?.bytes?.length) {
      const url = URL.createObjectURL(new Blob([new Uint8Array(meta.local.bytes)], { type: meta.local.mime || "image/jpeg" }));
      if (await probeArtwork(url)) { artworkUrls.add(url); return url; }
      URL.revokeObjectURL(url);
    }
    for (const candidate of meta?.urls || []) {
      const url = allowedArtworkUrl(candidate);
      if (url && await probeArtwork(url)) return url;
    }
    if (meta?.appid) {
      const url = allowedArtworkUrl(await call("game_artwork_store_url", { appid: Number(meta.appid) }).catch(() => null));
      if (url) return probeArtwork(url);
    }
    return null;
  }
  function artworkFor(game) {
    const key = artworkKey(game);
    if (!artworkRequests.has(key)) artworkRequests.set(key, artworkJob(async () => {
      const meta = await call("game_artwork", { exePath: game.exe_path }).catch(() => null);
      if (!meta?.appid) return null;
      const assetKey = String(meta.appid);
      if (!artworkAssets.has(assetKey)) artworkAssets.set(assetKey, loadArtwork(meta).catch(() => null));
      return artworkAssets.get(assetKey);
    }));
    return artworkRequests.get(key);
  }
  // Фоновая предзагрузка обложки игры в память браузера
  function preloadArtwork(game) {
    if (!game?.exe_path) return;
    artworkFor(game).then(url => {
      if (url) {
        const pre = new Image();
        pre.referrerPolicy = "no-referrer";
        pre.src = url;
      }
    });
  }

  // Привязка обложек к элементам интерфейса
  function hydrateArtwork() {
    document.querySelectorAll(".hv-cover[data-artwork-key]").forEach(cover => {
      const key = cover.dataset.artworkKey;
      if (!key || cover.dataset.artworkRequested === key) return;
      const game = state.games.find(game => artworkKey(game) === key);
      if (!game) return;
      cover.dataset.artworkRequested = key;
      const img = cover.querySelector("img");
      artworkFor(game).then(url => {
        if (!url || !cover.isConnected || cover.dataset.artworkKey !== key || !img?.isConnected) return;
        img.onload = () => { if (cover.dataset.artworkKey === key) cover.classList.add("has-artwork"); };
        img.onerror = () => { img.removeAttribute("src"); cover.classList.remove("has-artwork"); };
        img.src = url;
        if (img.complete && img.naturalWidth > 0) cover.classList.add("has-artwork");
      });
    });
  }
  function selectedArtwork(game) {
    const cover = $("#hv-selected-cover");
    if (!cover) return;
    const key = artworkKey(game);
    if (cover.dataset.artworkKey !== key || !cover.firstChild) {
      cover.dataset.artworkKey = key; delete cover.dataset.artworkRequested;
      cover.classList.remove("has-artwork"); cover.innerHTML = coverMarkup(game);
    }
    hydrateArtwork();
  }
  document.addEventListener("cgs:hv-tab-changed", event => { if (event.detail === "hypervisor") hydrateArtwork(); });
  window.addEventListener("pagehide", () => { artworkUrls.forEach(url => URL.revokeObjectURL(url)); artworkUrls.clear(); });

  function timeNow() {
    return new Date().toLocaleTimeString(window.cgsI18n?.locale?.() || "ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function appendLog(kind, message) {
    const output = $("#hv-log");
    if (!output) return;
    const line = document.createElement("div");
    line.className = `hv-log-line ${kind || "info"}`;
    const time = document.createElement("time");
    time.textContent = timeNow();
    const text = document.createElement("span");
    text.textContent = String(message || "");
    line.append(time, text);
    output.appendChild(line);
    output.scrollTop = output.scrollHeight;
  }

  function setBusy(busy, label = "") {
    state.running = busy;
    const addBtn = $("#hv-add-game");
    if (addBtn) addBtn.disabled = busy;
    updateLaunchButton();
    if (label) $("#hv-run-state").textContent = label;
    renderGames();
  }

  function updateLaunchButton() {
    const button = $("#hv-launch-button");
    if (!button) return;
    button.disabled = state.running || state.gameRunning || !state.selectedId;
    button.classList.toggle("game-running", state.gameRunning);
    button.classList.toggle("launching", state.launching);
    const label = button.querySelector("span:last-child");
    if (label) label.textContent = state.gameRunning ? "Игра запущена" : state.launching ? "Запуск..." : "Запустить";
  }

  function setGameRunning(running) {
    state.gameRunning = Boolean(running);
    updateLaunchButton();
  }

  const wait = (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

  async function monitorGameProcess(waitForStart = false) {
    const token = ++state.processMonitorToken;
    const selectedId = state.selectedId;
    let processSeen = !waitForStart && state.gameRunning;
    let startMisses = 0;

    while (token === state.processMonitorToken && selectedId === state.selectedId) {
      let running;
      try {
        running = await call("is_selected_game_running");
      } catch (error) {
        appendLog("warning", `Не удалось проверить процесс игры: ${error}`);
        setGameRunning(false);
        return;
      }

      if (running) {
        processSeen = true;
        setGameRunning(true);
      } else if (processSeen) {
        setGameRunning(false);
        appendLog("info", "Процесс игры завершён. Кнопка запуска снова доступна.");
        return;
      } else {
        startMisses += 1;
        if (startMisses >= 10) {
          setGameRunning(false);
          return;
        }
      }

      await wait(1500);
    }
  }

  function renderSteps() {
    $("#hv-steps").innerHTML = steps.map(([title, detail], index) => `
      <article class="hv-step" data-hv-step="${index + 1}">
        <span>${index + 1}</span><div><strong>${title}</strong><p>${detail}</p></div>
      </article>`).join("");
  }

  function resetSteps() {
    document.querySelectorAll("[data-hv-step]").forEach((item) => item.classList.remove("active", "done", "error"));
  }

  function activateStep(step) {
    const number = Number(step) || 1;
    document.querySelectorAll("[data-hv-step]").forEach((item) => {
      const current = Number(item.dataset.hvStep);
      item.classList.toggle("done", current < number);
      item.classList.toggle("active", current === number);
      item.classList.remove("error");
    });
  }

  function completeSteps() {
    document.querySelectorAll("[data-hv-step]").forEach((item) => {
      item.classList.remove("active", "error");
      item.classList.add("done");
    });
  }

  function markStepError() {
    const current = $(".hv-step.active") || $("[data-hv-step='1']");
    current?.classList.add("error");
    current?.classList.remove("active");
  }

  function pluralGames(count) {
    const n10 = count % 10;
    const n100 = count % 100;
    if (n10 === 1 && n100 !== 11) return `${count} игра`;
    if (n10 >= 2 && n10 <= 4 && !(n100 >= 12 && n100 <= 14)) return `${count} игры`;
    return `${count} игр`;
  }

  function selectedGame() {
    return state.games.find((game) => game.id === state.selectedId) || null;
  }

  function applyLibrary(library) {
    state.selectedId = library?.selected_id || null;
    state.launchers = Array.isArray(library?.launchers) && library.launchers.length ? library.launchers : defaultLaunchers;
    state.games = Array.isArray(library?.games) ? library.games : [];
    renderGames();
    const sel = selectedGame();
    if (sel) selectedArtwork(sel);
    // Немедленная фоновая предзагрузка всех обложек сразу при запуске приложения
    for (const game of state.games) {
      preloadArtwork(game);
    }
  }

  function renderGames() {
    const list = $("#hv-game-list");
    const empty = $("#hv-empty");
    $("#hv-library-count").textContent = pluralGames(state.games.length);
    $("#hv-games-count").textContent = String(state.games.length);
    empty.classList.toggle("hidden", state.games.length > 0);
    list.classList.toggle("hidden", state.games.length === 0);

    list.innerHTML = state.games.map((game) => {
      const selected = game.id === state.selectedId;
      const confirm = state.confirmingRemove === game.id;
      return `
        <article class="hv-game-card ${selected ? "selected" : ""}" data-game-id="${escapeHtml(game.id)}" role="button" tabindex="0" title="Нажмите, чтобы выбрать игру">
          <div class="hv-game-symbol hv-cover hv-game-cover" data-artwork-key="${escapeHtml(artworkKey(game))}">${coverMarkup(game)}</div>
          <div class="hv-game-main">
            <div class="hv-game-heading"><strong>${escapeHtml(game.name)}</strong><b class="${game.ready ? "ready" : ""}"><i></i>${game.ready ? "Готова к запуску" : "Нужна проверка"}</b></div>
            <div class="hv-game-path" title="${escapeHtml(game.exe_path)}">${escapeHtml(game.exe_path)}</div>
            <div class="hv-game-bottom">
              <div class="hv-game-actions">
                ${selected ? '<span class="hv-active-game"><i></i>Активна</span>' : ''}
                <button class="hv-game-action danger ${confirm ? "confirm" : ""}" data-hv-action="remove" data-game-id="${escapeHtml(game.id)}" ${state.running ? "disabled" : ""}>${confirm ? "Точно удалить?" : "Удалить"}</button>
              </div>
            </div>
          </div>
        </article>`;
    }).join("");
    hydrateArtwork();
  }

  function renderStatus(status) {
    const game = status?.selected_game || selectedGame();
    selectedArtwork(game);
    $("#hv-admin-status").textContent = status?.admin ? "Admin" : "Через UAC";
    $("#hv-games-count").textContent = String(status?.games_count ?? state.games.length);
    if (!game) {
      state.processMonitorToken += 1;
      state.gameRunning = false;
      $("#hv-selected-title").textContent = "Игра не выбрана";
      $("#hv-selected-path").textContent = "Добавьте исполняемый файл игры.";
      $("#hv-selected-state").textContent = "Нет игры";
      $("#hv-selected-state").className = "";
      $("#hv-ready-status").textContent = "Нет игры";
      updateLaunchButton();
      return;
    }
    if (!state.running && typeof status?.game_running === "boolean") {
      state.gameRunning = status.game_running;
    }
    $("#hv-selected-title").textContent = game.name;
    $("#hv-selected-path").textContent = game.exe_path;
    $("#hv-selected-state").textContent = "Готова";
    $("#hv-selected-state").className = "ready";
    $("#hv-ready-status").textContent = "Готово";
    updateLaunchButton();
  }

  async function refreshAll(silent = false) {
    try {
      const [library, status] = await Promise.all([call("list_games"), call("get_app_status")]);
      applyLibrary(library);
      renderStatus(status);
      if (status?.game_running && !state.running) monitorGameProcess(false);
      if (!silent) appendLog("success", "Библиотека и состояние профилей обновлены.");
    } catch (error) {
      appendLog("error", `Не удалось обновить модуль: ${error}`);
    }
  }

  async function addGame() {
    if (state.running) return;
    try {
      const exePath = await call("select_game_exe");
      if (!exePath) return;
      setBusy(true, "Подготовка");
      appendLog("info", `Выбран EXE: ${exePath}`);
      const library = await call("add_game", { exePath, launcherId: "hv_launcher" });
      applyLibrary(library);
      await refreshAll(true);
    refreshEclipseHvStatus();
      appendLog("success", "Игра добавлена в библиотеку гипервизора.");
    } catch (error) {
      appendLog("error", String(error));
    } finally {
      setBusy(false, "Ожидание");
    }
  }

  async function selectGame(id) {
    try {
      state.processMonitorToken += 1;
      setGameRunning(false);
      const library = await call("set_selected_game", { id });
      applyLibrary(library);
      await refreshAll(true);
    } catch (error) { appendLog("error", String(error)); }
  }

  async function verifyGame(id) {
    try {
      setBusy(true, "Проверка");
      const library = await call("verify_game", { id });
      applyLibrary(library);
      appendLog("success", "Файлы игры проверены и восстановлены при необходимости.");
    } catch (error) {
      appendLog("error", String(error));
    } finally {
      setBusy(false, "Ожидание");
      await refreshAll(true);
    }
  }

  async function removeGame(id) {
    if (state.confirmingRemove !== id) {
      state.confirmingRemove = id;
      renderGames();
      return;
    }
    try {
      const library = await call("remove_game", { id });
      state.confirmingRemove = "";
      applyLibrary(library);
      await refreshAll(true);
      appendLog("warning", "Игра удалена из библиотеки модуля. Файлы в папке игры не удалялись.");
    } catch (error) { appendLog("error", String(error)); }
  }

  async function launchSelected() {
    if (state.running || state.gameRunning || !state.selectedId) return;
    resetSteps();
    activateStep(1);
    state.launching = true;
    setBusy(true, "Запуск");
    appendLog("info", "Запущен сценарий гипервизора.");
    let launchSucceeded = false;
    try {
      const report = await call("launch_selected_game");
      launchSucceeded = Boolean(report?.success);
      appendLog(report?.success ? "success" : "error", report?.message || "Сценарий завершён.");
      if (report?.success) {
        completeSteps();
        $("#hv-run-state").textContent = "Готово";
      } else {
        markStepError();
        $("#hv-run-state").textContent = "Ошибка";
      }
    } catch (error) {
      appendLog("error", String(error));
      markStepError();
      $("#hv-run-state").textContent = "Ошибка";
    } finally {
      state.launching = false;
      setBusy(false);
      if (launchSucceeded) {
        setGameRunning(true);
        monitorGameProcess(true);
      } else {
        setGameRunning(false);
      }
    }
  }

  function handleStationEvent(payload) {
    if (!payload) return;
    appendLog(payload.kind || "info", payload.message || "Событие модуля");
    if (payload.step) activateStep(payload.step);
    if (payload.kind === "error") markStepError();
  }

  async function copyLog() {
    const text = [...document.querySelectorAll("#hv-log .hv-log-line")]
      .map((line) => `${line.querySelector("time")?.textContent || ""} ${line.querySelector("span")?.textContent || ""}`.trim())
      .join("\n");
    if (!text) return appendLog("warning", "Журнал пока пуст.");
    try {
      await navigator.clipboard.writeText(text);
      appendLog("success", "Журнал скопирован.");
    } catch (error) { appendLog("error", `Не удалось скопировать журнал: ${error}`); }
  }


  // Управление универсальным автономным лаунчером Eclipse-HV
  async function checkEclipseHvUpdate(interactive = false) {
    const statusEl = $("#hv-eclipse-status");
    const pathEl = $("#hv-eclipse-path");
    const checkBtn = $("#hv-eclipse-check-btn");
    const dlBtn = $("#hv-eclipse-download-btn");
    const dlLabel = $("#hv-eclipse-dl-label");

    if (!statusEl) return;

    // Включаем плавную анимацию вращения векторной иконки и состояние проверки
    if (checkBtn) {
      checkBtn.classList.add("is-checking", "busy");
      checkBtn.disabled = true;
      const span = checkBtn.querySelector("span");
      if (span) span.textContent = "Проверяем…";
    }

    if (statusEl) {
      statusEl.dataset.status = "checking";
      statusEl.textContent = "Проверка версии…";
    }

    if (interactive) {
      appendLog("info", "Подключение к репозиторию и проверка актуальности Eclipse-HV…");
    }

    try {
      // Запрашиваем проверку на бэкенде с минимальной анимационной паузой 400мс
      const [status] = await Promise.all([
        call("eclipse_hv_check_update").catch(() => call("eclipse_hv_status")),
        new Promise((resolve) => setTimeout(resolve, 400)),
      ]);

      const destShort = status.destinationDir || "папка не определена";
      if (pathEl) {
        pathEl.textContent = `Папка: ${destShort}`;
        pathEl.title = status.destinationDir || "";
      }

      const cleanVer = (status.version || "1.1.0").replace(/^v/i, "");
      const sizeKb = status.sizeBytes ? ` (${Math.round(status.sizeBytes / 1024)} КБ)` : "";

      if (status.installed) {
        if (status.updateAvailable) {
          statusEl.dataset.status = "update";
          statusEl.textContent = "Доступно обновление";
          if (dlLabel) dlLabel.textContent = "Обновить Eclipse-HV";
          if (dlBtn) dlBtn.classList.add("highlight");

          if (interactive) {
            appendLog("warning", `Обнаружено обновление Eclipse-HV для папки: ${destShort}`);
            window.cgsToast?.("Доступно обновление Eclipse-HV!", "accent");

            if (typeof window.cgsShowModal === "function") {
              const confirmed = await window.cgsShowModal(
                "Обновление Eclipse-HV",
                `Доступна новая версия автономного лаунчера Eclipse-HV.

Текущая версия: ${cleanVer}
Целевая папка: ${destShort}

Обновить исполняемый файл прямо сейчас?`,
                { confirm: true, confirmText: "Обновить сейчас", cancelText: "Позже", symbol: "↑" }
              );
              if (confirmed) {
                await downloadEclipseHv();
                return;
              }
            }
          }
        } else {
          statusEl.dataset.status = "installed";
          statusEl.textContent = `Установлен ${cleanVer}${sizeKb}`;
          if (dlLabel) dlLabel.textContent = "Переустановить Eclipse-HV";
          if (dlBtn) dlBtn.classList.remove("highlight");

          if (interactive) {
            appendLog("success", `Установлена последняя актуальная версия Eclipse-HV (${cleanVer}).`);
            window.cgsToast?.(`Установлена актуальная версия Eclipse-HV ${cleanVer}`, "info");
          }
        }
      } else {
        statusEl.dataset.status = "missing";
        statusEl.textContent = "Не установлен";
        if (dlLabel) dlLabel.textContent = "Загрузить актуальную версию";
        if (dlBtn) dlBtn.classList.remove("highlight");

        if (interactive) {
          appendLog("warning", `Файл Eclipse-HV.exe не обнаружен в папке: ${destShort}`);
          window.cgsToast?.("Eclipse-HV не найден в папке с игрой", "warning");

          if (typeof window.cgsShowModal === "function") {
            const confirmed = await window.cgsShowModal(
              "Установка Eclipse-HV",
              `Исполняемый файл Eclipse-HV.exe не найден в папке:
${destShort}

Развернуть лаунчер в папку игры в 1 клик?`,
              { confirm: true, confirmText: "Установить в 1 клик", cancelText: "Отмена", symbol: "↓" }
            );
            if (confirmed) {
              await downloadEclipseHv();
              return;
            }
          }
        }
      }
    } catch (err) {
      if (statusEl) {
        statusEl.dataset.status = "missing";
        statusEl.textContent = "Ошибка проверки";
      }
      const message = String(err?.message || err);
      appendLog("error", `Ошибка проверки Eclipse-HV: ${message}`);
      if (interactive) {
        window.cgsToast?.(`Ошибка проверки Eclipse-HV: ${message}`, "error");
      }
    } finally {
      if (checkBtn) {
        checkBtn.classList.remove("is-checking", "busy");
        checkBtn.disabled = false;
        const span = checkBtn.querySelector("span");
        if (span) span.textContent = "Проверить версию";
      }
    }
  }

  // Быстрое фоновое обновление статуса лаунчера без интерактивных тостов
  async function refreshEclipseHvStatus() {
    await checkEclipseHvUpdate(false);
  }

  async function downloadEclipseHv() {
    const dlBtn = $("#hv-eclipse-download-btn");
    const dlLabel = $("#hv-eclipse-dl-label");
    const statusEl = $("#hv-eclipse-status");
    if (dlBtn) {
      dlBtn.disabled = true;
      dlBtn.classList.add("busy");
    }
    if (dlLabel) dlLabel.textContent = "Развёртывание…";
    if (statusEl) {
      statusEl.dataset.status = "checking";
      statusEl.textContent = "Развёртывание…";
    }

    try {
      const msg = await call("eclipse_hv_download");
      appendLog("success", msg);
      window.cgsToast?.("Eclipse-HV успешно развёрнут в папке игры!", "success");
      try { window.cgsAudio?.playSuccess?.(); } catch (_) {}
      if (typeof window.cgsShowModal === "function") {
        await window.cgsShowModal("Eclipse-HV", msg, { symbol: "✓" });
      }
    } catch (err) {
      appendLog("error", `Ошибка загрузки Eclipse-HV: ${err}`);
      window.cgsToast?.(`Ошибка загрузки: ${err}`, "error");
      if (typeof window.cgsShowModal === "function") {
        await window.cgsShowModal("Ошибка загрузки Eclipse-HV", String(err), { symbol: "!" });
      }
    } finally {
      if (dlBtn) {
        dlBtn.disabled = false;
        dlBtn.classList.remove("busy", "highlight");
      }
      await refreshEclipseHvStatus();
    }
  }

  function showEclipseHvInstructions() {
    const backdrop = document.getElementById("eclipse-hv-instructions-backdrop");
    if (!backdrop) return;
    backdrop.classList.remove("hidden", "closing");

    const close = () => {
      backdrop.classList.add("closing");
      setTimeout(() => {
        backdrop.classList.add("hidden");
        backdrop.classList.remove("closing");
      }, 190);
    };

    const closeBtn = document.getElementById("eclipse-hv-instructions-close");
    const okBtn = document.getElementById("eclipse-hv-instructions-ok");
    if (closeBtn) closeBtn.onclick = close;
    if (okBtn) okBtn.onclick = close;
    backdrop.onclick = (e) => {
      if (e.target === backdrop) close();
    };
  }

  function bindEvents() {
    $("#hv-add-game")?.addEventListener("click", addGame);
    $("#hv-help-button")?.addEventListener("click", () => {
      const message = [
        "1. Нажмите «Добавить игру» и выберите основной EXE игры.",
        "2. Нажмите кнопку «Запустить» и подтвердите запрос UAC.",
        "3. Гипервизор подготовит систему и запустит игру с защитой ядра.",
        "4. Пока игра работает, повторный запуск заблокирован. После закрытия игры кнопка включится сама.",
      ].join("\n\n");
      if (typeof window.cgsShowModal === "function") {
        const modal = document.querySelector("#modal-backdrop .modal");
        modal?.classList.add("hv-help-modal");
        window.cgsShowModal("Как пользоваться Гипервизором", message, { symbol: "💡" })
          .finally(() => modal?.classList.remove("hv-help-modal"));
      } else {
        appendLog("info", message.replaceAll("\n\n", " "));
      }
    });
    $("#hv-launch-button")?.addEventListener("click", launchSelected);
    $("#hv-eclipse-instructions-btn")?.addEventListener("click", showEclipseHvInstructions);
    $("#hv-eclipse-check-btn")?.addEventListener("click", () => {
      checkEclipseHvUpdate(true);
    });
    $("#hv-eclipse-download-btn")?.addEventListener("click", downloadEclipseHv);
    $("#hv-copy-log")?.addEventListener("click", copyLog);
    $("#hv-clear-log")?.addEventListener("click", () => { $("#hv-log").innerHTML = ""; });
    $("#hv-game-list")?.addEventListener("click", (event) => {
      const removeBtn = event.target.closest('[data-hv-action="remove"]');
      if (removeBtn) {
        if (!removeBtn.disabled) removeGame(removeBtn.dataset.gameId);
        return;
      }
      const card = event.target.closest(".hv-game-card");
      if (card && card.dataset.gameId) {
        selectGame(card.dataset.gameId);
      }
    });
    $("#hv-game-list")?.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        const card = event.target.closest(".hv-game-card");
        if (card && card.dataset.gameId && !event.target.closest("button")) {
          event.preventDefault();
          selectGame(card.dataset.gameId);
        }
      }
    });
    window.addEventListener("cgs:view-changed", (event) => {
      if (event.detail === "hypervisor") {
        refreshAll(true);
        refreshEclipseHvStatus();
        hydrateArtwork();
      }
    });
  }

  async function boot() {
    if (state.initialized) return;
    state.initialized = true;
    renderSteps();
    bindEvents();
    appendLog("info", "Модуль «Гипервизор» готов.");
    if (listen) {
      try { await listen("station-event", (event) => handleStationEvent(event.payload ?? event)); }
      catch (error) { appendLog("warning", `События запуска недоступны: ${error}`); }
    }
    await refreshAll(true);
    call("check_asset_updates").catch((error) => appendLog("warning", `Обновление профилей пропущено: ${error}`));
  }

  boot();
})();
