(() => {
  "use strict";

  // local-cloud — CloudRedirect: Steam Cloud игр с манифестами в папке на диске
  const $ = (id) => document.getElementById(id);
  const panel = $("local-cloud-panel");
  if (!panel) return;
  const invoke = window.cgsApi?.invoke;
  // Команды, после которых меняется установленный загрузчик и поддержка облака
  const LOADER_COMMANDS = new Set(["luatools_apply_loader", "luatools_set_loader_source", "luatools_update_loader"]);
  let busy = false;
  let applying = false;
  let loaded = false;
  let result = null;
  let picked = "";
  let failure = "";
  let sequence = 0;
  let timer = 0;

  // Обновление встроенной DLL: отдельное окно, чтобы не сбрасывать режим и папку
  const updateBackdrop = $("lc-update-backdrop");
  const notified = new Set();
  let noticeQueued = false;
  let updateBusy = false;
  let updateDone = false;
  let updatePath = null;
  let previousFocus = null;
  const updateOpen = () => Boolean(updateBackdrop && !updateBackdrop.classList.contains("hidden"));

  const errorText = (error) => String(error?.message || error || "Неизвестная ошибка");
  const t = (text) => (window.cgsI18n?.t ? window.cgsI18n.t(text) : text);
  const steamPath = () => $("lua-steam-path")?.value.trim() || window.cgsStorage?.getItem("luaSteamPath") || null;
  const luaActive = () => $("view-lua")?.classList.contains("active");

  function message(text, kind = "info") {
    const node = $("lc-status");
    node.textContent = text;
    node.dataset.kind = kind;
  }

  function badge() {
    let text = "Выключено";
    let tone = "";
    if (applying) text = "Применение…";
    else if (!loaded) { text = failure ? "Ошибка" : "Проверка…"; tone = failure ? "error" : ""; }
    else if (result?.issue) { text = "Требует внимания"; tone = "warning"; }
    else if (result?.componentOutdated) { text = "Обновление"; tone = "warning"; }
    else if (result?.enabled) { text = "Включено"; tone = "ready"; }
    else if (!result?.loaderSupported) { text = "Недоступно"; tone = "warning"; }
    const node = $("lc-badge");
    node.className = "millennium-plugin-badge" + (tone ? ` ${tone}` : "");
    node.textContent = text;
  }

  function render() {
    const enabled = Boolean(result?.enabled);
    const folder = picked || result?.folder || "";
    $("lc-toggle-label").textContent = enabled ? "Включено" : "Включить";
    $("lc-folder").value = folder;
    if (folder) $("lc-folder").title = folder; else $("lc-folder").removeAttribute("title");
    const toggle = $("lc-enabled");
    toggle.checked = enabled;
    toggle.disabled = busy || !loaded || (!enabled && !result?.loaderSupported);
    $("lc-browse").disabled = busy || !loaded;
    $("lc-refresh").disabled = busy;
    panel.dataset.busy = String(busy);
    panel.dataset.state = !loaded ? (failure ? "error" : "checking") : result?.issue ? "issue" : result?.componentOutdated ? "update" : enabled ? "on" : "off";
    badge();
  }

  function statusMessage() {
    if (result?.issue) return message(result.issue, "error");
    const count = result?.eligibleApps?.length || 0;
    if (result?.enabled) {
      let text = `Локальный режим включён · игр с манифестами: ${count}.`;
      if (result.componentOutdated) text += "\nДоступно обновление DLL локального облака.";
      return message(text, "ok");
    }
    if (!result?.loaderSupported) {
      return message("Загрузчик OpenSteamTool в Steam не поддерживает локальное облако. Примените Версию 1 или Версию 2 в блоке «Версия OpenSteamTool» и нажмите «Проверить».", "warning");
    }
    message(picked ? "Папка выбрана. Включите локальное облако." : "Локальный режим выключен. Выберите папку и включите переключатель.");
  }

  function setBusy(value) {
    busy = value;
    window.cgsReportBusy?.("local-cloud", value);
    render();
  }

  async function refresh(notify = false) {
    if (!invoke || busy) return;
    const ticket = ++sequence;
    if (!loaded) { failure = ""; render(); message("Проверка…"); }
    try {
      const data = await invoke("local_cloud_status", { steamPath: steamPath() });
      if (ticket !== sequence || busy) return;
      result = data;
      loaded = true;
      failure = "";
      // Выбранная, но ещё не применённая папка сохраняется до включения режима
      if (result?.enabled) picked = "";
      render();
      statusMessage();
      notifyUpdate(notify === true);
    } catch (error) {
      if (ticket !== sequence || busy) return;
      loaded = false;
      failure = errorText(error);
      render();
      message(failure, "error");
    }
  }

  // Несколько событий подряд (смена раздела, пути Steam, загрузчика) дают одну проверку
  function scheduleRefresh() {
    clearTimeout(timer);
    timer = setTimeout(refresh, 60);
  }

  // Тексты окна обновления DLL и состояние кнопок
  function renderUpdateDialog() {
    if (!updateBackdrop) return;
    $("lc-update-description").textContent = t("В программу встроен исправленный CloudRedirect. Обновите установленную DLL, чтобы синхронизация сохранений игр с Lua и манифестами работала корректно, в том числе после выхода и повторного запуска игры.");
    $("lc-update-note").textContent = t("Если Steam открыт, он перезапустится автоматически. Перед обновлением закройте игры. Прежняя DLL сохраняется в резервной копии; папка сохранений и выбранный режим останутся прежними. Скачивать файлы не требуется.");
    const later = $("lc-update-later");
    later.textContent = updateDone ? t("Закрыть") : t("Позже");
    later.disabled = updateBusy;
    const install = $("lc-update-install");
    install.textContent = updateBusy ? t("Обновляем…") : t("Обновить DLL");
    install.disabled = updateBusy;
    install.hidden = updateDone;
    $("lc-update-progress").hidden = !updateBusy;
    updateBackdrop.setAttribute("aria-busy", String(updateBusy));
  }

  // Показываем окно один раз за сеанс; не перекрываем другие модальные окна
  function notifyUpdate(force = false) {
    if (!updateBackdrop) return;
    const key = String(result?.steamPath || result?.folder || "configured").toLowerCase();
    if (!result?.componentOutdated || !result?.loaderSupported || result?.issue || busy || updateOpen() || noticeQueued || (!force && notified.has(key))) return;
    noticeQueued = true;
    const openWhenReady = () => {
      if (!result?.componentOutdated || busy) { noticeQueued = false; return; }
      if (document.querySelector(".modal-backdrop:not(.hidden)")) { setTimeout(openWhenReady, 400); return; }
      noticeQueued = false;
      notified.add(key);
      updateDone = false;
      updatePath = result.steamPath || steamPath();
      previousFocus = document.activeElement;
      $("lc-update-status").textContent = "";
      $("lc-update-status").dataset.kind = "info";
      updateBackdrop.classList.remove("hidden", "closing");
      renderUpdateDialog();
      $("lc-update-install").focus({ preventScroll: true });
    };
    openWhenReady();
  }

  function closeUpdateDialog() {
    if (!updateOpen() || updateBusy) return;
    updateBackdrop.classList.add("closing");
    setTimeout(() => {
      updateBackdrop.classList.add("hidden");
      updateBackdrop.classList.remove("closing");
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    }, 180);
  }

  // Обновляется только управляемая DLL: режим, папка и конфигурация не меняются
  async function updateComponent() {
    if (busy || updateBusy) return;
    ++sequence;
    updateBusy = true;
    setBusy(true);
    const node = $("lc-update-status");
    node.dataset.kind = "info";
    node.textContent = "Закрываем Steam, сохраняем резервную копию и обновляем DLL…";
    renderUpdateDialog();
    try {
      result = await invoke("local_cloud_update_component", { steamPath: updatePath });
      if (result?.componentOutdated) throw new Error("DLL не обновлена. Повторите операцию.");
      loaded = true;
      failure = "";
      updateDone = true;
      node.dataset.kind = "ok";
      node.textContent = "DLL обновлена. Если Steam был открыт, он запущен снова. Локальное облако готово к работе.";
      statusMessage();
      window.cgsToast?.("DLL локального облака обновлена", "success");
    } catch (error) {
      node.dataset.kind = "error";
      node.textContent = errorText(error);
    } finally {
      updateBusy = false;
      setBusy(false);
      render();
      renderUpdateDialog();
      if (updateDone) $("lc-update-later").focus({ preventScroll: true });
    }
  }

  async function pickFolder() {
    setBusy(true);
    try { return await invoke("local_cloud_pick_folder"); }
    catch (error) { message(errorText(error), "error"); return null; }
    finally { setBusy(false); }
  }

  async function apply(enabled, folder) {
    if (busy) return;
    applying = true;
    ++sequence;
    setBusy(true);
    message(enabled
      ? "Применяем локальное облако: сохраняем настройки с резервной копией. Если Steam запущен, он перезапустится…"
      : "Выключаем локальное облако: восстанавливаем настройки. Если Steam запущен, он перезапустится…");
    try {
      result = await invoke("local_cloud_set", { steamPath: steamPath(), enabled, folder: folder || null });
      picked = "";
      loaded = true;
      failure = "";
      applying = false;
      statusMessage();
      window.cgsToast?.(enabled ? "Локальное облако включено" : "Локальное облако выключено", "success");
    } catch (error) {
      // Бэкенд откатывает изменения: прежнее состояние остаётся, показываем причину
      applying = false;
      message(errorText(error), "error");
    } finally {
      applying = false;
      setBusy(false);
    }
  }

  $("lc-enabled").addEventListener("change", async (event) => {
    const enabled = event.target.checked;
    // Переключатель отражает только подтверждённое бэкендом состояние
    event.target.checked = Boolean(result?.enabled);
    if (busy || !loaded) return;
    let folder = picked || result?.folder || "";
    if (enabled && !folder) {
      folder = await pickFolder();
      if (!folder) return;
      picked = folder;
      render();
    }
    await apply(enabled, folder);
  });

  $("lc-browse").addEventListener("click", async () => {
    if (busy || !loaded) return;
    const folder = await pickFolder();
    if (!folder) return;
    if (result?.enabled) { await apply(true, folder); return; }
    picked = folder;
    render();
    statusMessage();
  });

  $("lc-refresh").addEventListener("click", () => refresh(true));
  $("lc-info").addEventListener("click", () => {
    const expanded = $("lc-info").getAttribute("aria-expanded") !== "true";
    $("lc-info").setAttribute("aria-expanded", String(expanded));
    $("lc-help").hidden = !expanded;
  });
  $("lua-steam-path")?.addEventListener("change", scheduleRefresh);
  window.addEventListener("cgs:view-changed", (event) => { if (event.detail === "lua") scheduleRefresh(); });
  window.addEventListener("cgs:request", (event) => {
    const { command, status } = event.detail || {};
    if (LOADER_COMMANDS.has(command) && status !== "running" && luaActive()) scheduleRefresh();
  });

  // Окно обновления DLL: «Позже», установка, клик мимо окна и клавиатура
  $("lc-update-later")?.addEventListener("click", closeUpdateDialog);
  $("lc-update-install")?.addEventListener("click", updateComponent);
  updateBackdrop?.addEventListener("click", (event) => { if (event.target === updateBackdrop) closeUpdateDialog(); });
  updateBackdrop?.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    const controls = [...updateBackdrop.querySelectorAll("button:not(:disabled):not([hidden])")].filter((node) => node.getClientRects().length);
    if (!controls.length) return;
    const index = controls.indexOf(document.activeElement);
    event.preventDefault();
    controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length].focus();
  });
  window.addEventListener("cgs:language-changed", renderUpdateDialog);

  window.cgsLocalCloud = { refresh: scheduleRefresh, closeUpdate: closeUpdateDialog, updateOpen, get busy() { return busy; } };
  render();
  // Проверяем установленный компонент после заставки, чтобы не открыть окно поверх неё
  let startupChecked = false;
  const startupCheck = () => {
    if (startupChecked) return;
    startupChecked = true;
    scheduleRefresh();
  };
  const splash = document.getElementById("app-splash");
  if (!splash || splash.classList.contains("hidden") || window.cgsStorage?.getItem("cgs-splash") === "0") {
    setTimeout(startupCheck, 700);
  } else {
    window.addEventListener("splash-finished", () => setTimeout(startupCheck, 400), { once: true });
    // Страховка, если событие заставки не пришло
    setTimeout(startupCheck, 8000);
  }
})();
