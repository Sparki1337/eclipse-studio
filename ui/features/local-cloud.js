// Локальное облако: CloudRedirect хранит Steam Cloud игр с манифестами в папке на диске
(() => {
  "use strict";
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

  const errorText = (error) => String(error?.message || error || "Неизвестная ошибка");
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
    panel.dataset.state = !loaded ? (failure ? "error" : "checking") : result?.issue ? "issue" : enabled ? "on" : "off";
    badge();
  }

  function statusMessage() {
    if (result?.issue) return message(result.issue, "error");
    const count = result?.eligibleApps?.length || 0;
    if (result?.enabled) {
      let text = `Локальный режим включён · игр с манифестами: ${count}.`;
      if (result.componentOutdated) text += "\nВстроенный компонент новее установленного: он обновится при следующем изменении режима.";
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

  async function refresh() {
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

  $("lc-refresh").addEventListener("click", refresh);
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

  window.cgsLocalCloud = { refresh: scheduleRefresh, get busy() { return busy; } };
  render();
  if (luaActive()) scheduleRefresh();
})();
