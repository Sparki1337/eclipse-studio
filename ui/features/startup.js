(() => {
  "use strict";

  // startup — настройка «Запускать от имени администратора»; применяется со следующего запуска
  const input = document.getElementById("run-as-admin");
  const note = document.getElementById("run-as-admin-note");
  if (!input) return;
  const KEY = "cgs-run-as-admin";
  const enabled = () => window.cgsStorage.getItem(KEY) !== "0";
  const text = value => window.cgsI18n?.t?.(value) || value;
  function status(value, error = false) {
    if (!note) return;
    note.dataset.sourceText = value;
    note.textContent = text(value);
    note.hidden = !value;
    note.setAttribute("role", error ? "alert" : "status");
  }
  input.checked = enabled();
  input.addEventListener("change", async () => {
    const before = enabled();
    const requested = input.checked;
    input.disabled = true;
    try {
      await window.cgsStorage.setItemVerified(KEY, requested ? "1" : "0");
      input.checked = requested;
      status("Сохранено. Изменение применится при следующем запуске приложения.");
    } catch (_) {
      input.checked = before;
      status("Не удалось сохранить настройку запуска. Повторите попытку.", true);
    } finally {
      input.disabled = false;
    }
  });
  window.addEventListener("cgs:language-changed", () => {
    if (note?.dataset.sourceText) note.textContent = text(note.dataset.sourceText);
  });
})();