(async () => {
  "use strict";

  // loader — последовательная загрузка модулей после готовности хранилища
  try {
    await window.cgsStorage.ready;
    // Проверяем сохранённую нативную настройку до загрузки модулей и запуска заданий.
    // Нативный код выполняется один раз за процесс и не повторяется после UAC-отказа.
    let startupAdminError = "";
    if (window.__TAURI__?.core?.invoke) {
      try {
        if (await window.__TAURI__.core.invoke("startup_admin")) return;
      } catch (error) {
        startupAdminError = String(error?.message || error);
      }
    }
    window.cgsModulesLoading = true;
    // Порядок важен: ядро (core/) и разделы (features/) подключаются последовательно
    for (const source of ["core/gradient.js", "core/bootstrap.js", "core/api.js", "core/dialogs.js", "core/jobs.js", "features/saves.js", "core/audio.js", "core/splash.js", "core/scale.js", "core/i18n.js", "core/onboarding.js", "core/app.js", "features/startup.js", "features/hypervisor.js", "features/anticheat.js", "features/vbs.js", "features/local-cloud.js", "features/files.js", "features/utilities.js", "features/appearance.js", "features/gradient.js", "features/layout.js", "core/custom-select.js", "core/motion.js", "features/holiday.js", "features/home.js", "features/search.js"]) {
      await new Promise((resolve, reject) => {
        const script = document.createElement("script"); script.src = "./" + source;
        script.onload = resolve; script.onerror = () => reject(new Error("Не загружен модуль: " + source)); document.body.append(script);
      });
    }
    window.cgsModulesLoading = false;
    window.dispatchEvent(new Event("cgs:modules-loaded"));
    window.dispatchEvent(new Event("cgs:ready"));
    document.documentElement.dataset.ready = "true";
    if (startupAdminError) {
      window.cgsToast?.(`Автозапуск без прав администратора: ${startupAdminError}`, "error");
    }
  } catch (error) {
    document.querySelector("#app-splash")?.remove();
    const panel = document.createElement("section"); panel.className = "startup-error"; panel.setAttribute("role", "alert");
    const title = document.createElement("h1"); title.textContent = "Не удалось безопасно загрузить данные";
    const message = document.createElement("p"); message.textContent = String(error?.message || error);
    const note = document.createElement("p"); note.textContent = "Старое хранилище не очищается без подтверждённой миграции. Закройте другие экземпляры и перезапустите приложение.";
    panel.append(title, message, note); document.body.replaceChildren(panel);
  }
})();
