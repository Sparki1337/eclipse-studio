(() => {
  "use strict";

  // steam-patch — патч appcache: фикс ошибки «0 байт» / «Нет соединения»
  const $ = (id) => document.getElementById(id);
  const panel = $("steam-patch-panel");
  if (!panel) return;
  const invoke = window.cgsApi?.invoke;
  // Команды, после которых меняется состояние загрузчика или Steam
  const REFRESH_COMMANDS = new Set(["luatools_apply_loader", "luatools_set_loader_source", "luatools_update_loader", "luatools_restart_steam", "luatools_close_steam"]);
  const PROMPT_KEY = "cgs-steam-patch-prompt-version";
  let busy = false;
  let loaded = false;
  let applying = false;
  let result = null;
  let failure = "";
  let sequence = 0;
  let timer = 0;
  let promptShown = false;
  let promptAttempts = 0;
  let promptTimer = 0;
  let previousFocus = null;

  const errorText = (error) => String(error?.message || error || "Неизвестная ошибка");
  const t = (text) => (window.cgsI18n?.t ? window.cgsI18n.t(text) : text);
  const steamPath = () => $("lua-steam-path")?.value.trim() || window.cgsStorage?.getItem("luaSteamPath") || null;
  const luaActive = () => $("view-lua")?.classList.contains("active");
  const patchEnabled = () => result?.state === "patched" || result?.state === "partial";
  const appVersion = () => (document.querySelector(".titlebar-version")?.textContent || document.getElementById("about-app-version")?.textContent || "").trim();
  const promptBackdrop = $("sp-prompt-backdrop");
  const promptOpen = () => Boolean(promptBackdrop && !promptBackdrop.classList.contains("hidden"));

  function message(text, kind = "info") {
    const node = $("sp-status");
    node.textContent = text;
    node.dataset.kind = kind;
  }

  function badge() {
    let text = "Патч выключен";
    let tone = "";
    if (applying) text = "Применение…";
    else if (!loaded) { text = failure ? "Ошибка" : "Проверка…"; tone = failure ? "error" : "checking"; }
    else if (result?.state === "patched") { text = "Патч активен"; tone = "ready"; }
    else if (result?.state === "partial") { text = "Частично"; tone = "warning"; }
    else if (result?.state === "unknown" || !result?.appcacheFound) { text = "Недоступно"; tone = "warning"; }
    const node = $("sp-badge");
    node.className = "millennium-plugin-badge" + (tone ? ` ${tone}` : "");
    node.textContent = t(text);
  }

  function statusMessage() {
    if (failure) return message(failure, "error");
    if (!loaded) return message(t("Проверка состояния патча…"));
    if (!result?.steamPath) return message(t("Steam не найден. Укажите папку Steam выше."), "warning");
    if (!result.appcacheFound) return message(t("В папке Steam не найден appcache. Запустите Steam и нажмите «Проверить»."), "warning");
    if (result.state === "patched") return message(t("Патч активен"));
    if (result.state === "partial") return message(t("Патч активен частично"), "warning");
    message(t("Патч не активен"));
  }

  function render() {
    panel.dataset.busy = String(busy);
    panel.dataset.state = !loaded ? (failure ? "error" : "checking") : result?.state || "unknown";
    const active = patchEnabled();
    $("sp-toggle-label").textContent = applying ? t("Применение…") : active ? t("Включено") : t("Включить");
    const toggle = $("sp-enabled");
    toggle.checked = active;
    toggle.disabled = busy || !loaded || (active ? !result?.canRestore : !result?.canApply);
    $("sp-refresh").disabled = busy;
    badge();
  }

  function setBusy(value) {
    busy = value;
    window.cgsReportBusy?.("steam-patch", value);
    render();
  }

  async function refresh() {
    if (!invoke || busy) return;
    const ticket = ++sequence;
    if (!loaded) { failure = ""; render(); message(t("Проверка состояния патча…")); }
    try {
      const data = await invoke("steam_patch_status", { steamPath: steamPath() });
      if (ticket !== sequence || busy) return;
      result = data;
      loaded = true;
      failure = "";
      render();
      statusMessage();
      maybePrompt();
    } catch (error) {
      if (ticket !== sequence || busy) return;
      loaded = false;
      failure = errorText(error);
      render();
      message(failure, "error");
    }
  }

  // Несколько событий подряд (раздел, путь Steam, загрузчик) дают одну проверку
  function scheduleRefresh() {
    clearTimeout(timer);
    timer = setTimeout(refresh, 60);
  }

  function promptSeen() {
    try {
      return window.cgsStorage?.getItem(PROMPT_KEY) === appVersion();
    } catch (_) {
      return false;
    }
  }

  function markPromptSeen() {
    try {
      window.cgsStorage?.setItem(PROMPT_KEY, appVersion());
    } catch (_) {}
  }

  function showPrompt() {
    if (!promptBackdrop || promptOpen()) return;
    promptShown = true;
    previousFocus = document.activeElement;
    promptBackdrop.classList.remove("hidden");
    $("sp-prompt-skip").focus({ preventScroll: true });
  }

  function closePrompt() {
    if (!promptBackdrop || !promptOpen()) return;
    promptBackdrop.classList.add("hidden");
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    previousFocus = null;
  }

  // Окно показывается один раз на версию программы, только если патч не активен
  function maybePrompt() {
    if (promptShown || !loaded || applying || busy || !promptBackdrop) return;
    if (result?.state === "patched") {
      // Патч уже активен — для этой версии окно не нужно
      if (!promptSeen()) markPromptSeen();
      return;
    }
    if (!result?.appcacheFound || !result?.canApply) return;
    const version = appVersion();
    if (!version || promptSeen()) return;
    // Не перекрываем заставку, выбор языка и другие модальные окна
    if (document.querySelector(".modal-backdrop:not(.hidden), dialog[open]")) {
      if (++promptAttempts > 120) return;
      clearTimeout(promptTimer);
      promptTimer = setTimeout(maybePrompt, 1000);
      return;
    }
    const splash = $("app-splash");
    if (splash && !splash.classList.contains("hidden")) {
      if (++promptAttempts > 120) return;
      clearTimeout(promptTimer);
      promptTimer = setTimeout(maybePrompt, 800);
      return;
    }
    showPrompt();
  }

  function skipPrompt() {
    markPromptSeen();
    closePrompt();
    statusMessage();
  }

  async function applyFromPrompt() {
    markPromptSeen();
    closePrompt();
    if (!patchEnabled()) await apply(true);
  }

  async function apply(enabled) {
    if (busy || !invoke) return;
    applying = true;
    ++sequence;
    setBusy(true);
    message(t(enabled
      ? "Применяем патч: закрываем Steam и сохраняем оригиналы…"
      : "Возвращаем оригинальные файлы Steam…"));
    try {
      const data = await invoke(enabled ? "steam_patch_apply" : "steam_patch_restore", { steamPath: steamPath() });
      result = data?.status || data || result;
      loaded = true;
      failure = "";
      const restarted = Boolean(data?.steamRestarted);
      if (enabled) {
        message(t(restarted
          ? "Патч применён. Steam запущен снова."
          : "Патч применён. Запустите Steam, чтобы применить изменения."), "ok");
        window.cgsToast?.(t("Патч appcache включён"), "success");
      } else if (data?.usedBackup) {
        message(t(restarted
          ? "Патч отключён. Оригинальные файлы восстановлены, Steam запущен снова."
          : "Патч отключён. Оригинальные файлы восстановлены. Запустите Steam."), "ok");
        window.cgsToast?.(t("Патч appcache отключён"), "success");
      } else {
        message(t("Патч отключён. Steam восстановит стандартные файлы при запуске."), "ok");
        window.cgsToast?.(t("Патч appcache отключён"), "success");
      }
    } catch (error) {
      message(errorText(error), "error");
      window.cgsToast?.(errorText(error), "error");
    } finally {
      applying = false;
      setBusy(false);
    }
  }

  $("sp-enabled").addEventListener("change", async (event) => {
    const enabled = event.target.checked;
    // Переключатель отражает только подтверждённое бэкендом состояние
    event.target.checked = patchEnabled();
    if (busy || !loaded) return;
    await apply(enabled);
  });

  $("sp-refresh").addEventListener("click", () => refresh());
  $("lua-steam-path")?.addEventListener("change", scheduleRefresh);
  window.addEventListener("cgs:view-changed", (event) => {
    if (event.detail === "lua") scheduleRefresh();
  });
  window.addEventListener("cgs:request", (event) => {
    const { command, status } = event.detail || {};
    if (REFRESH_COMMANDS.has(command) && status !== "running" && luaActive()) scheduleRefresh();
  });
  window.addEventListener("cgs:language-changed", () => {
    render();
    if (!applying) statusMessage();
    setTimeout(maybePrompt, 300);
  });
  window.addEventListener("splash-finished", () => setTimeout(maybePrompt, 300));

  // Окно первого запуска: «Применить», «Пропустить», Esc и клавиатурный фокус
  $("sp-prompt-skip")?.addEventListener("click", skipPrompt);
  $("sp-prompt-apply")?.addEventListener("click", applyFromPrompt);
  promptBackdrop?.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      skipPrompt();
      return;
    }
    if (event.key !== "Tab") return;
    const controls = [...promptBackdrop.querySelectorAll("button:not(:disabled)")].filter((node) => node.getClientRects().length);
    if (!controls.length) return;
    const index = controls.indexOf(document.activeElement);
    event.preventDefault();
    controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length].focus();
  });

  window.cgsSteamPatch = { refresh: scheduleRefresh, apply, get state() { return result?.state || null; }, get busy() { return busy; } };
  render();
  scheduleRefresh();
  // Повторная проверка после первичного определения пути Steam в app.js
  setTimeout(scheduleRefresh, 900);
})();
