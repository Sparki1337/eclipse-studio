(() => {
  "use strict";

  const invoke = window.cgsApi?.invoke;
  const listen = window.__TAURI__?.event?.listen;
  const $ = (selector, root = document) => root.querySelector(selector);
  const PAGE_SIZE = 12;

  const DOWNLOAD_DIR_KEY = "filesDownloadDir";
  const AUTO_INSTALL_KEY = "filesAutoInstall";
  const INSTALLED_KEY = "filesInstalledMap";
  const VIEW_MODE_KEY = "filesViewMode";
  const PAUSED_KEY = "filesPausedDownloads";
  const state = {
    files: [],
    page: 1,
    query: "",
    loaded: false,
    loading: false,
    refreshing: false,
    cached: false,
    error: "",
    progress: new Map(readPaused().map(entry => [entry.url, { ...entry, paused: true, resumable: true, status: "Приостановлено" }])),
    downloads: new Map(),
    installed: readInstalledMap(),
    autoInstall: readAutoInstall(),
    pinnedCollapsed: readPinnedCollapsed(),
    viewMode: readViewMode(),
  };

  let defaultDownloadDir = "";

  function readPaused() { try { const value = JSON.parse(window.cgsStorage.getItem(PAUSED_KEY) || "[]"); return Array.isArray(value) ? value : []; } catch (_) { return []; } }
  function rememberDownload(item, targetDir) {
    const list = readPaused().filter(entry => entry.url !== item.url);
    list.push({ url: item.url, suggestedName: fileNameFromUrl(item.url), targetDir: targetDir || null, percent: state.progress.get(item.url)?.percent || 0 });
    window.cgsStorage.setItem(PAUSED_KEY, JSON.stringify(list));
  }
  function forgetDownload(url) { window.cgsStorage.setItem(PAUSED_KEY, JSON.stringify(readPaused().filter(entry => entry.url !== url))); }
  function downloadFailed(item, error) {
    const message = String(error); const previous = state.progress.get(item.url) || {};
    if (message.includes("приостановлена") || (previous.resumable && !message.includes("отменена"))) {
      state.progress.set(item.url, { ...previous, paused: true, cancelling: false, status: "Можно продолжить" });
      rememberDownload(item, previous.targetDir);
    } else { state.progress.delete(item.url); forgetDownload(item.url); }
    render();
    $("#files-status").textContent = message.includes("приостановлена") ? "Пауза: сегменты сохранены. Продолжить можно и после перезапуска." : message.includes("отменена") ? "Загрузка отменена, временные сегменты удалены" : "Загрузка не завершена: " + message;
  }
  async function pauseDownload(item) {
    try { await invoke("files_pause_download", { url: item.url }); }
    catch (error) { $("#files-status").textContent = String(error); }
  }
  function installationComplete(item, gameDir, result) {
    state.progress.delete(item.url);
    if (result?.success !== true || result?.status === "partial" || result?.skipped?.length) {
      state.installed.delete(item.url); saveInstalledMap(); render();
      const message = ["Выполнено частично или с ошибкой. Архив и оригиналы сохранены.", result?.message, ...(result?.skipped || [])].filter(Boolean).join("\n");
      $("#files-status").textContent = message; notify(message, true); return false;
    }
    state.downloads.delete(item.url); state.installed.set(item.url, { gameDir, result });
    saveInstalledMap(); render(); showSuccessState(item.url); return true;
  }

  function readViewMode() {
    try {
      const mode = window.cgsStorage.getItem(VIEW_MODE_KEY);
      return mode === "list" ? "list" : "grid";
    } catch (_) {
      return "grid";
    }
  }

  function setViewMode(mode) {
    const valid = mode === "list" ? "list" : "grid";
    state.viewMode = valid;
    try { window.cgsStorage.setItem(VIEW_MODE_KEY, valid); } catch (_) {}
    applyViewMode();
  }

  function applyViewMode() {
    const catalog = $(".files-catalog");
    if (!catalog) return;
    const isList = state.viewMode === "list";
    catalog.classList.toggle("view-list", isList);

    document.querySelectorAll(".files-view-btn").forEach((btn) => {
      const active = btn.dataset.mode === state.viewMode;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-pressed", String(active));
    });
  }

  function readInstalledMap() {
    try {
      const raw = window.cgsStorage.getItem(INSTALLED_KEY);
      if (!raw) return new Map();
      const parsed = JSON.parse(raw);
      const map = new Map();
      for (const [k, v] of Object.entries(parsed)) {
        if (!k.toLowerCase().includes("studio")) {
          map.set(k, v);
        }
      }
      return map;
    } catch (_) {
      return new Map();
    }
  }

  function saveInstalledMap() {
    try {
      const obj = Object.fromEntries(state.installed.entries());
      window.cgsStorage.setItem(INSTALLED_KEY, JSON.stringify(obj));
    } catch (_) {}
  }

  function readAutoInstall() {
    try {
      const val = window.cgsStorage.getItem(AUTO_INSTALL_KEY);
      return val === null ? true : val !== "false";
    } catch (_) {
      return true;
    }
  }

  function readDownloadDir() {
    try { return (window.cgsStorage.getItem(DOWNLOAD_DIR_KEY) || "").trim(); } catch (_) { return ""; }
  }

  function folderName(path) {
    const parts = String(path).split(/[\\/]+/).filter(Boolean);
    return parts[parts.length - 1] || path;
  }

  function notify(message, error = false) {
    const stack = document.getElementById("toast-stack");
    if (!stack) return;
    const toast = document.createElement("div");
    toast.className = `toast ${error ? "error" : "success"}`;
    toast.textContent = message;
    stack.append(toast);
    setTimeout(() => {
      toast.classList.add("closing");
      setTimeout(() => toast.remove(), 290);
    }, 3200);
  }

  function notifyCrackSuccess(message = "Кряк установлен успешно!") {
    const stack = document.getElementById("toast-stack");
    if (!stack) return;
    const toast = document.createElement("div");
    toast.className = "toast toast-crack-success";
    toast.innerHTML = `
      <div class="toast-success-icon-wrap">
        <svg viewBox="0 0 28 28" class="toast-checkmark-svg">
          <circle class="toast-checkmark-circle" cx="14" cy="14" r="12" fill="none" />
          <path class="toast-checkmark-check" d="M8.5 14.5 L12.2 18.2 L19.8 10.2" fill="none" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </div>
      <div class="toast-success-content">
        <strong class="toast-success-title">${escapeHtml(message)}</strong>
      </div>
      <div class="toast-progress-bar"></div>
    `;
    stack.append(toast);

    let closed = false;
    const dismiss = () => {
      if (closed) return;
      closed = true;
      toast.classList.add("closing");
      setTimeout(() => toast.remove(), 360);
    };

    toast.addEventListener("click", dismiss);
    setTimeout(dismiss, 3200);
  }

  const isMissingCommand = (error) => /command\s+\S+\s+not\s+found/i.test(String(error));
  let backendWarningShown = false;

  function warnOutdatedBackend() {
    if (backendWarningShown) return;
    backendWarningShown = true;
    notify("Бэкенд программы устарел: пересоберите её вместе с папкой src-tauri из архива", true);
  }

  function sameFolder(filePath, folder) {
    const normalize = (value) => String(value || "").replace(/[\\/]+/g, "\\").replace(/\\$/, "").toLowerCase();
    const file = normalize(filePath);
    const dir = normalize(folder);
    return Boolean(dir) && file.startsWith(`${dir}\\`);
  }

  function parentFolder(path) {
    const value = String(path || "");
    const index = Math.max(value.lastIndexOf("\\"), value.lastIndexOf("/"));
    return index > 0 ? value.slice(0, index) : "";
  }

  function renderDownloadDir() {
    const custom = readDownloadDir();
    const path = custom || defaultDownloadDir;
    const pathNode = $("#download-dir-path");
    if (!pathNode) return;
    $("#download-dir-kind").textContent = custom ? "Своя папка" : "По умолчанию";
    pathNode.textContent = path || "Папка «Загрузки»";
    pathNode.title = path;
    $("#download-dir-reset").classList.toggle("hidden", !custom);
  }

  async function pickDownloadDir() {
    if (!invoke) return;
    const button = $("#download-dir-pick");
    button.disabled = true;
    try {
      let path;
      try {
        path = await invoke("files_pick_download_dir");
      } catch (error) {
        if (!isMissingCommand(error)) throw error;
        // Фоллбэк выбора папки для старых версий бэкенда
        path = await invoke("pick_game_directory");
      }
      if (path) {
        try { window.cgsStorage.setItem(DOWNLOAD_DIR_KEY, path); } catch (_) {}
        renderDownloadDir();
        notify("Папка загрузки сохранена");
      }
    } catch (error) {
      notify(String(error), true);
    } finally {
      button.disabled = false;
    }
  }

  function resetDownloadDir() {
    try { window.cgsStorage.removeItem(DOWNLOAD_DIR_KEY); } catch (_) {}
    renderDownloadDir();
    notify("Папка загрузки сброшена");
  }

  async function openDownloadDir() {
    if (!invoke) return;
    try {
      await invoke("files_open_download_dir", { path: readDownloadDir() || null });
    } catch (error) {
      if (!isMissingCommand(error)) { notify(String(error), true); return; }
      // Фоллбэк открытия папки через последний файл
      const last = [...state.downloads.values()].pop();
      if (last?.path) {
        try { await invoke("files_reveal", { path: last.path }); return; } catch (_) {}
      }
      warnOutdatedBackend();
    }
  }

  async function initDownloadDir() {
    $("#download-dir-pick")?.addEventListener("click", pickDownloadDir);
    $("#download-dir-reset")?.addEventListener("click", resetDownloadDir);
    $("#download-dir-open")?.addEventListener("click", openDownloadDir);
    const autoInstallBox = $("#files-auto-install");
    if (autoInstallBox) {
      autoInstallBox.checked = state.autoInstall;
      autoInstallBox.addEventListener("change", () => {
        state.autoInstall = autoInstallBox.checked;
        try { window.cgsStorage.setItem(AUTO_INSTALL_KEY, state.autoInstall ? "true" : "false"); } catch (_) {}
        render();
      });
    }
    renderDownloadDir();
    if (invoke) {
      try { defaultDownloadDir = await invoke("files_default_download_dir"); }
      catch (error) { if (isMissingCommand(error)) defaultDownloadDir = ""; }
      renderDownloadDir();
    }
  }

  function readPinnedCollapsed() {
    try { return window.cgsStorage.getItem("filesPinnedCollapsed") === "1"; } catch (_) { return false; }
  }

  function applyPinnedCollapsed() {
    const collapsed = state.pinnedCollapsed;
    $("#files-featured")?.classList.toggle("collapsed", collapsed);
    $("#files-featured-toggle")?.setAttribute("aria-expanded", String(!collapsed));
    const label = $("#files-featured-label");
    if (label) label.textContent = collapsed ? "Показать" : "Скрыть";
  }

  function togglePinned() {
    state.pinnedCollapsed = !state.pinnedCollapsed;
    try { window.cgsStorage.setItem("filesPinnedCollapsed", state.pinnedCollapsed ? "1" : "0"); } catch (_) {}
    applyPinnedCollapsed();
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function filteredFiles() {
    const query = state.query.trim().toLocaleLowerCase("ru-RU");
    return state.files.filter((item) => {
      if (isFeatured(item)) return false;
      return !query || `${item.name} ${item.build}`.toLocaleLowerCase("ru-RU").includes(query);
    });
  }

  function isFeatured(item) {
    return item?.pinned === true;
  }

  function isStudio(item) {
    const name = String(item?.name || "").toLowerCase().trim();
    return name.includes("studio") || name.includes("студи");
  }

  function featuredFiles() {
    return state.files.filter(isFeatured);
  }

  function fileNameFromUrl(url) {
    try {
      return decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() || "Архив");
    } catch (_) {
      return "Архив";
    }
  }

  function pageNumbers(current, total) {
    if (total <= 5) return Array.from({ length: total }, (_, index) => index + 1);
    let start = Math.max(1, current - 2);
    let end = Math.min(total, start + 4);
    start = Math.max(1, end - 4);
    return Array.from({ length: end - start + 1 }, (_, index) => start + index);
  }

  function showSuccessState(url) {
    notifyCrackSuccess("Кряк установлен успешно!");
    const status = $("#files-status");
    if (status) {
      status.innerHTML = '<span class="files-status-dot"></span> Кряк установлен успешно!';
    }
    const card = document.querySelector(`[data-card-url="${CSS.escape(url)}"]`);
    if (card) {
      card.classList.remove("crack-install-success");
      void card.offsetWidth;
      card.classList.add("crack-install-success");

      const reinstallBtn = card.querySelector('[data-files-action="reinstall"]');
      if (reinstallBtn) {
        reinstallBtn.classList.add("file-success-burst");
        reinstallBtn.innerHTML = '<svg viewBox="0 0 16 16" style="width:13px;height:13px;stroke-width:2.2;fill:none;stroke:#2ed573;vertical-align:-1px"><polyline points="13 4 6 11 3 8"/></svg> <span>Кряк установлен успешно!</span>';
        setTimeout(() => {
          if (!reinstallBtn.isConnected) return;
          reinstallBtn.classList.add("btn-text-fading");
          setTimeout(() => {
            if (!reinstallBtn.isConnected) return;
            reinstallBtn.classList.remove("file-success-burst", "btn-text-fading");
            reinstallBtn.innerHTML = '<svg viewBox="0 0 24 24" style="width:13px;height:13px;stroke-width:2;fill:none;stroke:currentColor;vertical-align:-1px"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg> <span>Переустановить</span>';
          }, 180);
        }, 2200);
      }

      setTimeout(() => {
        if (card.isConnected) card.classList.remove("crack-install-success");
      }, 1100);
    }
  }

  function renderCard(item, position, featured = false) {
    const password = item.password || "Не требуется";
    const progress = state.progress.get(item.url);
    const downloaded = state.downloads.get(item.url);
    const installed = state.installed.get(item.url);
    const url = escapeHtml(item.url);
    const newest = !featured && !state.query && position < 3;
    const marker = featured ? "ЗАКРЕПЛЕНО" : `ФАЙЛ ${String(position + 1).padStart(3, "0")}`;
    const studio = isStudio(item);
    const autoInstall = state.autoInstall && !studio;
    return `
      <article class="file-card ${featured ? "featured" : ""} ${installed && !studio ? "is-installed" : ""}" data-card-url="${url}">
        <div class="file-card-top">
          <span class="file-icon"><svg viewBox="0 0 24 24" style="width:18px;height:18px"><path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg></span>
          <div class="file-title">
            <div>
              <span>${marker}</span>
              ${installed && !studio ? `<b class="file-badge-installed"><svg viewBox="0 0 16 16"><polyline points="13 4 6 11 3 8"/></svg> УСТАНОВЛЕНО</b>` : (newest ? "<b>НОВОЕ</b>" : "")}
            </div>
            <h3 title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</h3>
          </div>
        </div>
        <div class="file-details">
          <div><small>БИЛД</small><strong>${escapeHtml(item.build || "Не указан")}</strong></div>
          <div><small>ПАРОЛЬ</small><strong class="file-password ${item.password ? "" : "empty"}">${escapeHtml(password)}</strong></div>
        </div>
        <div class="file-actions">
          ${item.password ? `<button class="file-copy" data-files-action="copy" data-files-url="${url}"><svg viewBox="0 0 16 16" style="width:13px;height:13px;stroke-width:1.8;vertical-align:-1px"><rect width="9" height="9" x="5.5" y="5.5" rx="1.5"/><path d="M10.5 5.5V3a1.5 1.5 0 0 0-1.5-1.5H3A1.5 1.5 0 0 0 1.5 3v6A1.5 1.5 0 0 0 3 10.5h2.5"/></svg> <span>Копировать пароль</span></button>` : '<span class="file-no-password">Без пароля</span>'}
          ${installed && !studio
            ? `<button class="file-download downloaded file-reinstall-btn" data-files-action="reinstall" data-files-url="${url}" title="Переустановить кряк"><svg viewBox="0 0 24 24" style="width:13px;height:13px;stroke-width:2;fill:none;stroke:currentColor;vertical-align:-1px"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg> <span>Переустановить</span></button>`
            : downloaded
              ? studio
                ? `<button class="file-download downloaded" data-files-action="reveal" data-files-url="${url}" title="Открыть папку с файлом"><svg viewBox="0 0 16 16" style="width:13px;height:13px;stroke-width:1.8;vertical-align:-1px"><path d="M2.5 5.5A1.5 1.5 0 0 1 4 4h3.5l1.8 2H16A1.5 1.5 0 0 1 17.5 7.5v8a1.5 1.5 0 0 1-1.5 1.5H4a1.5 1.5 0 0 1-1.5-1.5z"/></svg> <span>Папка</span></button>`
                : `<button class="file-download downloaded" data-files-action="install-existing" data-files-url="${url}" title="Установить скачанный кряк в игру"><svg viewBox="0 0 16 16" style="width:13px;height:13px;stroke-width:1.8;vertical-align:-1px"><path d="M8 2.5v8m-3.5-3.5 3.5 3.5 3.5-3.5M2.5 13.5h11"/></svg> <span>Установить в игру</span></button>`
              : progress
                ? progress.paused
                  ? `<button class="file-download" data-files-action="resume" data-files-url="${url}">Продолжить ${progress.percent || 0}%</button><button class="file-cancel" data-files-action="cancel" data-files-url="${url}">Удалить загрузку</button>`
                  : `<button class="file-cancel" data-files-action="cancel" data-files-url="${url}" ${progress.cancelling || progress.installing ? "disabled" : ""}>${progress.installing ? "Установка…" : progress.cancelling ? "Отменяем…" : `Отменить ${progress.percent ?? ""}%`}</button>${progress.resumable && !progress.installing ? `<button class="file-download" data-files-action="pause" data-files-url="${url}">Пауза</button>` : ""}`
                : autoInstall
                  ? `<button class="file-download" data-files-action="install-flow" data-files-url="${url}"><svg viewBox="0 0 16 16" style="width:13px;height:13px;stroke-width:1.8;vertical-align:-1px"><path d="M8 2.5v8m-3.5-3.5 3.5 3.5 3.5-3.5M2.5 13.5h11"/></svg> <span>Установить в игру</span></button>`
                  : `<button class="file-download" data-files-action="download" data-files-url="${url}"><svg viewBox="0 0 16 16" style="width:13px;height:13px;stroke-width:1.8;vertical-align:-1px"><path d="M8 2.5v8m-3.5-3.5 3.5 3.5 3.5-3.5M2.5 13.5h11"/></svg> <span>Скачать</span></button>`}
        </div>
      </article>`;
  }

  function render() {
    const pinned = featuredFiles();
    const all = filteredFiles();
    const totalPages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
    state.page = Math.min(Math.max(1, state.page), totalPages);
    const start = (state.page - 1) * PAGE_SIZE;
    const pageItems = all.slice(start, start + PAGE_SIZE);

    $("#files-total").textContent = String(state.files.length || 0);
    $("#files-loading").classList.toggle("hidden", !state.loading);
    $("#files-featured").classList.toggle("hidden", state.loading || pinned.length === 0);
    $("#files-regular-divider").classList.toggle("hidden", state.loading || pinned.length === 0);
    $("#files-empty").classList.toggle("hidden", state.loading || pageItems.length > 0);
    $("#files-grid").classList.toggle("hidden", state.loading || pageItems.length === 0);
    $("#files-pagination").classList.toggle("hidden", state.loading || all.length <= PAGE_SIZE);

    $("#files-featured-count").textContent = String(pinned.length);
    applyPinnedCollapsed();
    $("#files-featured-grid").innerHTML = pinned
      .map((item, index) => renderCard(item, index, true))
      .join("");
    $("#files-grid").innerHTML = pageItems
      .map((item, pageIndex) => renderCard(item, start + pageIndex))
      .join("");

    $("#files-pages").innerHTML = pageNumbers(state.page, totalPages)
      .map((page) => `<button class="${page === state.page ? "active" : ""}" data-files-page="${page}">${page}</button>`)
      .join("");
    $("#files-prev").disabled = state.page <= 1;
    $("#files-next").disabled = state.page >= totalPages;
    $("#files-page-state").textContent = `Страница ${state.page} из ${totalPages}`;

    if (!state.loading && state.error) {
      $("#files-status").textContent = state.error;
    } else if (!state.loading) {
      const range = all.length ? `${start + 1}–${start + pageItems.length} из ${all.length}` : "0 файлов";
      const source = state.cached ? " · локальная копия" : "";
      $("#files-status").textContent = `${range}${source}`;
    }
  }

  async function checkEclipseStudioRelease() {
    if (!invoke) return null;
    try {
      const update = await invoke("check_for_update");
      if (!update || !update.latestVersion) return null;
      const tag = update.latestVersion;
      const url = update.portableUrl || update.installerUrl || update.releaseUrl;
      if (!url || !url.startsWith("https://")) return null;
      return {
        name: "Eclipse Studio",
        build: `Build ${tag}`,
        url: url,
        password: "",
        pinned: true,
      };
    } catch (_) {
      return null;
    }
  }

  async function loadCatalog(force = false, silent = false) {
    if (state.refreshing || (state.loaded && !force)) return;
    state.refreshing = true;
    state.loading = !silent;
    state.error = "";
    if (!silent) $("#files-status").textContent = "Загрузка списка из Gist…";
    $("#files-refresh").disabled = true;
    if (!silent) render();

    try {
      if (!invoke) throw new Error("Системный модуль недоступен");
      const catalog = await invoke("files_catalog");
      state.files = Array.isArray(catalog?.files) ? catalog.files : [];
      state.cached = Boolean(catalog?.cached);
      state.error = "";
      state.loaded = true;
      if (!silent) state.page = 1;

      if (!state.files.some((f) => f.name.toLowerCase() === "eclipse studio")) {
        try {
          const eclipseItem = await checkEclipseStudioRelease();
          if (eclipseItem && !state.files.some((f) => f.name.toLowerCase() === "eclipse studio")) {
            const crocIndex = state.files.findIndex((f) => f.name.toLowerCase().includes("crocodile gena studio"));
            if (crocIndex !== -1) {
              state.files.splice(crocIndex + 1, 0, eclipseItem);
            } else {
              state.files.unshift(eclipseItem);
            }
          }
        } catch (_) {}
      }
    } catch (error) {
      if (!silent) {
        state.files = [];
        state.loaded = false;
        state.error = `Не удалось получить каталог: ${String(error)}`;
      }
    } finally {
      state.loading = false;
      state.refreshing = false;
      $("#files-refresh").disabled = false;
      render();
    }
  }

  async function copyPassword(item, button) {
    if (!item?.password) return;
    try {
      await navigator.clipboard.writeText(item.password);
      const original = button.innerHTML;
      button.innerHTML = '<svg viewBox="0 0 16 16" style="width:13px;height:13px;stroke-width:2;vertical-align:-1px"><polyline points="13 4 6 11 3 8"/></svg> <span>Скопировано</span>';
      window.setTimeout(() => { button.innerHTML = original; }, 1400);
    } catch (error) {
      $("#files-status").textContent = `Не удалось скопировать пароль: ${String(error)}`;
    }
  }

  async function download(item) {
    if (!item?.url || !invoke) return;
    const saved = state.progress.get(item.url);
    const targetDir = saved?.targetDir || readDownloadDir();
    state.progress.set(item.url, { percent: saved?.percent || 0, targetDir });
    render();
    try {
      const result = await invoke("files_download", {
        url: item.url,
        suggestedName: fileNameFromUrl(item.url),
        targetDir: targetDir || null,
        expectedSha256: item.sha256 || null,
      });
      state.downloads.set(item.url, result);
      forgetDownload(item.url);
      state.progress.delete(item.url);
      render();
      const savedTo = parentFolder(result.path);
      if (targetDir && !sameFolder(result.path, targetDir)) warnOutdatedBackend();
      $("#files-status").textContent = savedTo
        ? `Файл «${result.fileName}» сохранён в папку «${folderName(savedTo)}»`
        : `Файл «${result.fileName}» сохранён в папку «Загрузки»`;
    } catch (error) { downloadFailed(item, error); }
  }

  async function cancelDownload(item) {
    const progress = state.progress.get(item?.url);
    if (!progress || !invoke) return;
    if (progress.paused) {
      try { await invoke("files_discard_download", { url: item.url, suggestedName: fileNameFromUrl(item.url), targetDir: progress.targetDir || null }); forgetDownload(item.url); state.progress.delete(item.url); render(); }
      catch (error) { $("#files-status").textContent = String(error); }
      return;
    }
    state.progress.set(item.url, { ...progress, cancelling: true });
    render();
    try {
      await invoke("files_cancel_download", { url: item.url });
    } catch (error) {
      state.progress.set(item.url, { ...progress, cancelling: false });
      render();
      $("#files-status").textContent = `Не удалось отменить скачивание: ${String(error)}`;
    }
  }

  async function installFlow(item) {
    if (!item?.url || !invoke) return;
    if (isStudio(item)) {
      download(item);
      return;
    }
    let gameDir;
    try {
      gameDir = await invoke("pick_game_directory");
    } catch (err) {
      notify("Не удалось открыть выбор папки: " + err, true);
      return;
    }
    if (!gameDir) return;

    state.progress.set(item.url, { percent: 0, targetDir: readDownloadDir(), status: "Скачивание…" });
    render();

    try {
      const targetDir = readDownloadDir();
      const downloadResult = await invoke("files_download", {
        url: item.url,
        suggestedName: fileNameFromUrl(item.url),
        targetDir: targetDir || null,
        expectedSha256: item.sha256 || null,
      });

      forgetDownload(item.url);
      state.downloads.set(item.url, downloadResult);
      state.progress.set(item.url, { percent: 100, installing: true, status: "Установка в игру…" });
      render();

      const installResult = await invoke("files_install_crack", {
        archivePath: downloadResult.path,
        gameDir: gameDir,
        password: item.password || null,
        deleteArchive: true,
      });

      installationComplete(item, gameDir, installResult);
    } catch (error) {
      if (!state.progress.get(item.url)?.installing) downloadFailed(item, error);
      else { state.progress.delete(item.url); render(); $("#files-status").textContent = "Ошибка установки: " + String(error); }
    }
  }

  async function installExisting(item) {
    const downloaded = state.downloads.get(item?.url);
    if (!downloaded?.path || !invoke) return;
    let gameDir;
    try {
      gameDir = await invoke("pick_game_directory");
    } catch (err) {
      notify("Не удалось открыть выбор папки: " + err, true);
      return;
    }
    if (!gameDir) return;

    state.progress.set(item.url, { percent: 100, installing: true, status: "Установка в игру…" });
    render();

    try {
      const installResult = await invoke("files_install_crack", {
        archivePath: downloaded.path,
        gameDir: gameDir,
        password: item.password || null,
        deleteArchive: true,
      });

      installationComplete(item, gameDir, installResult);
    } catch (error) {
      state.progress.delete(item.url);
      render();
      notify(`Ошибка установки: ${error}`, true);
      $("#files-status").textContent = `Ошибка установки: ${String(error)}`;
    }
  }

  async function reveal(item) {
    const downloaded = state.downloads.get(item?.url);
    if (!downloaded?.path || !invoke) return;
    try {
      await invoke("files_reveal", { path: downloaded.path });
    } catch (error) {
      $("#files-status").textContent = `Не удалось открыть папку: ${String(error)}`;
    }
  }

  function updateProgress(payload) {
    if (!payload?.url || !state.progress.has(payload.url)) return;
    const prev = state.progress.get(payload.url) || {};
    const resumable = payload.resumable === true;
    state.progress.set(payload.url, { ...prev, resumable, percent: Number.isFinite(payload.percent) ? payload.percent : null });
    if (resumable) {
      const item = state.files.find(entry => entry.url === payload.url);
      if (item && (!prev.resumable || Math.floor((prev.percent || 0) / 10) !== Math.floor((payload.percent || 0) / 10))) rememberDownload(item, prev.targetDir);
    }
    if (prev.resumable !== resumable) render();
    else document.querySelectorAll('[data-files-action="cancel"]').forEach(button => {
      if (button.dataset.filesUrl === payload.url && !prev.cancelling && !prev.installing) button.textContent = `Отменить ${payload.percent ?? ""}%`;
    });
  }

  function bindEvents() {
    $("#files-featured-toggle")?.addEventListener("click", togglePinned);
    $("#files-refresh")?.addEventListener("click", () => loadCatalog(true));
    $("#files-search")?.addEventListener("input", (event) => {
      state.query = event.currentTarget.value;
      state.page = 1;
      render();
    });
    $("#files-prev")?.addEventListener("click", () => { state.page -= 1; render(); });
    $("#files-next")?.addEventListener("click", () => { state.page += 1; render(); });
    $("#files-pages")?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-files-page]");
      if (!button) return;
      state.page = Number(button.dataset.filesPage) || 1;
      render();
      document.querySelector("#view-files")?.scrollIntoView({ block: "start", behavior: "smooth" });
    });
    $("#view-files")?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-files-action]");
      if (!button) return;
      const item = state.files.find((entry) => entry.url === button.dataset.filesUrl);
      if (button.dataset.filesAction === "copy") copyPassword(item, button);
      if (button.dataset.filesAction === "download") download(item);
      if (button.dataset.filesAction === "install-flow") installFlow(item);
      if (button.dataset.filesAction === "install-existing") installExisting(item);
      if (button.dataset.filesAction === "reinstall") installFlow(item);
      if (button.dataset.filesAction === "installed-info") {
        notifyCrackSuccess("Кряк установлен успешно!");
      }
      if (button.dataset.filesAction === "pause") pauseDownload(item);
      if (button.dataset.filesAction === "resume") download(item);
      if (button.dataset.filesAction === "cancel") cancelDownload(item);
      if (button.dataset.filesAction === "reveal") reveal(item);
    });
    window.addEventListener("cgs:view-changed", (event) => {
      if (event.detail === "files") loadCatalog(true);
    });
    document.querySelectorAll(".files-view-btn").forEach((btn) => {
      btn.addEventListener("click", () => setViewMode(btn.dataset.mode));
    });
    if (listen) {
      listen("files-download-progress", (event) => updateProgress(event.payload ?? event)).catch(() => {});
    }
  }

  bindEvents();
  initDownloadDir();
  applyViewMode();
})();
