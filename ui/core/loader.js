(async () => {
  "use strict";
  try {
    await window.cgsStorage.ready;
    window.cgsModulesLoading = true;
    // Порядок важен: ядро (core/) и разделы (features/) подключаются последовательно
    for (const source of ["core/bootstrap.js", "core/api.js", "core/dialogs.js", "core/jobs.js", "features/saves.js", "core/audio.js", "core/splash.js", "core/scale.js", "core/i18n.js", "core/app.js", "features/hypervisor.js", "features/anticheat.js", "features/vbs.js", "features/files.js", "features/utilities.js", "features/appearance.js", "core/custom-select.js", "core/motion.js", "features/home.js"]) {
      await new Promise((resolve, reject) => {
        const script = document.createElement("script"); script.src = "./" + source;
        script.onload = resolve; script.onerror = () => reject(new Error("Не загружен модуль: " + source)); document.body.append(script);
      });
    }
    window.cgsModulesLoading = false;
    window.dispatchEvent(new Event("cgs:modules-loaded"));
    window.dispatchEvent(new Event("cgs:ready"));
    document.documentElement.dataset.ready = "true";
  } catch (error) {
    document.querySelector("#app-splash")?.remove();
    const panel = document.createElement("section"); panel.className = "startup-error"; panel.setAttribute("role", "alert");
    const title = document.createElement("h1"); title.textContent = "Не удалось безопасно загрузить данные";
    const message = document.createElement("p"); message.textContent = String(error?.message || error);
    const note = document.createElement("p"); note.textContent = "Старое хранилище не очищается без подтверждённой миграции. Закройте другие экземпляры и перезапустите приложение.";
    panel.append(title, message, note); document.body.replaceChildren(panel);
  }
})();
