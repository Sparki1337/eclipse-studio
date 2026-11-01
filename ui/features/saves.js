(() => {
  "use strict";
  window.cgsSaves = { create({ state, $, $$, call, setBusy, log, toast, errorText, consumeResult, showModal, formatBytes }) {
  function updateSaveSelection() {
    const checkboxes = $$("#save-list input[type='checkbox']");
    const selected = checkboxes.filter((item) => item.checked);
    const button = $("#create-save-archive");
    button.disabled = selected.length === 0;
    const label = button.querySelector("span");
    if (label) label.textContent = selected.length ? `Создать архив · ${selected.length}` : "Создать архив";
    const toggle = $("#save-toggle-selection");
    toggle.disabled = checkboxes.length === 0;
    toggle.textContent = checkboxes.length > 0 && selected.length === checkboxes.length
      ? "Снять выделение"
      : "Выделить все";
  }

  function renderSaveLocations() {
    const locations = state.saveLocations || [];
    const fileCount = locations.reduce((sum, item) => sum + (Number(item.fileCount) || 0), 0);
    const totalBytes = locations.reduce((sum, item) => sum + (Number(item.totalBytes) || 0), 0);
    $("#save-location-count").textContent = locations.length.toLocaleString(window.cgsI18n?.locale?.() || "ru-RU");
    $("#save-file-count").textContent = fileCount.toLocaleString(window.cgsI18n?.locale?.() || "ru-RU");
    $("#save-total-size").textContent = formatBytes(totalBytes);

    const list = $("#save-list");
    const empty = $("#save-empty");
    list.replaceChildren();
    list.classList.toggle("hidden", locations.length === 0);
    empty.classList.toggle("hidden", locations.length > 0);
    if (!locations.length) {
      $("#save-empty h3").textContent = state.savesScanned ? "Сохранения не найдены" : "Сканирование ещё не запускалось";
      $("#save-empty p").textContent = state.savesScanned
        ? "Популярные расположения проверены. Возможно, игра хранит прогресс в собственной папке."
        : "Нажмите «Найти сохранения», чтобы проверить популярные расположения.";
      updateSaveSelection();
      return;
    }

    locations.forEach((location) => {
      const row = document.createElement("label");
      row.className = "save-location";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = true;
      checkbox.dataset.path = location.path;
      checkbox.addEventListener("change", updateSaveSelection);

      const icon = document.createElement("span");
      icon.className = "save-location-icon";
      icon.textContent = "SV";

      const copy = document.createElement("span");
      copy.className = "save-location-copy";
      const title = document.createElement("strong");
      title.textContent = location.label;
      const path = document.createElement("code");
      path.textContent = location.path;
      path.title = location.path;
      copy.append(title, path);

      const meta = document.createElement("span");
      meta.className = "save-location-meta";
      const numbers = document.createElement("b");
      numbers.textContent = `${Number(location.fileCount).toLocaleString(window.cgsI18n?.locale?.() || "ru-RU")} файлов · ${formatBytes(location.totalBytes)}`;
      const category = document.createElement("span");
      category.textContent = location.category;
      category.title = location.category;
      meta.append(numbers, category);
      const exclude = document.createElement("button"); exclude.type = "button"; exclude.className = "ghost-button save-exclude";
      exclude.textContent = "Исключить"; exclude.setAttribute("aria-label", `Исключить ${location.label}`);
      exclude.addEventListener("click", async event => { event.preventDefault(); await call("save_exclude_location", { path: location.path, reset: false }); await scanSaveLocations(); });
      row.append(checkbox, icon, copy, meta, exclude);
      list.appendChild(row);
    });
    updateSaveSelection();
  }

  async function scanSaveLocations() {
    const button = $("#scan-saves-button");
    setBusy(button, true, "Сканируем…");
    log("Запущен поиск папок с игровыми сохранениями", "system");
    try {
      const result = await call("scan_save_locations");
      state.saveLocations = Array.isArray(result) ? result : [];
      state.savesScanned = true;
      renderSaveLocations();
      const files = state.saveLocations.reduce((sum, item) => sum + (Number(item.fileCount) || 0), 0);
      log(`Найдено папок сохранений: ${state.saveLocations.length}; файлов: ${files}`, "success");
      toast(state.saveLocations.length ? `Найдено папок: ${state.saveLocations.length}` : "Сохранения не найдены", state.saveLocations.length ? "success" : "error");
    } catch (error) {
      log(`Ошибка поиска сохранений: ${errorText(error)}`, "error");
      toast(errorText(error), "error");
    } finally {
      setBusy(button, false);
    }
  }

  async function createSaveArchive() {
    const paths = $$("#save-list input[type='checkbox']:checked").map((item) => item.dataset.path).filter(Boolean);
    if (!paths.length) return toast("Выберите хотя бы одну папку", "error");
    const format = $("#save-format").value === "rar" ? "rar" : "zip";
    let destination;
    try {
      destination = await call("pick_save_archive", { format });
    } catch (error) {
      return toast(errorText(error), "error");
    }
    if (!destination) return;
    let preview;
    try { preview = await call("preview_save_backup", { paths }); }
    catch (error) { return toast(errorText(error), "error"); }
    if (preview.skipped?.length) return showModal("Есть недоступные файлы", preview.skipped.join("\n"), { symbol: "!" });
    const accepted = await showModal(
      "Создать архив сохранений?",
      `Папок: ${paths.length}; файлов: ${preview.fileCount}; размер: ${formatBytes(preview.totalBytes)}.\n${preview.files.slice(0, 30).join("\n")}${preview.truncated || preview.files.length > 30 ? "\n…Полный состав проверяется при создании" : ""}\nОригинальные файлы не изменятся. Формат: ${format.toUpperCase()}.`,
      { confirm: true, confirmText: "Создать архив", cancelText: "Отмена", symbol: "↓" },
    );
    if (!accepted) return;

    const button = $("#create-save-archive");
    setBusy(button, true, "Архивация…");
    log(`Создание ${format.toUpperCase()}-архива сохранений`, "system");
    try {
      const result = await call("create_save_archive", { paths, destination, format });
      if (consumeResult(result)) {
        await showModal("Архив готов", `Резервная копия успешно создана:\n${result.archivePath || destination}`, { symbol: "✓" });
      }
    } catch (error) {
      log(`Ошибка архивации: ${errorText(error)}`, "error");
      toast(errorText(error), "error");
    } finally {
      setBusy(button, false);
      updateSaveSelection();
    }
  }

  async function restoreSaveArchive() {
    let archive;
    try {
      archive = await call("pick_save_restore_archive");
    } catch (error) {
      return toast(errorText(error), "error");
    }
    if (!archive) return;
    let preview;
    try { preview = await call("inspect_save_archive", { archive }); }
    catch (error) { return toast(errorText(error), "error"); }
    const accepted = await showModal(
      "Восстановить сохранения?",
      `Архив проверен. Файлов: ${preview.fileCount}; размер: ${formatBytes(preview.totalBytes)}.\n${preview.files.join("\n")}\nПеред изменениями будет создан снимок для кнопки «Вернуть как было». Закройте игры.`,
      { confirm: true, confirmText: "Восстановить", cancelText: "Отмена", symbol: "↺" },
    );
    if (!accepted) return;

    const button = $("#restore-save-archive");
    setBusy(button, true, "Восстановление…");
    log(`Восстановление сохранений из архива: ${archive}`, "system");
    try {
      const result = await call("restore_save_archive", { archive });
      if (consumeResult(result)) {
        await showModal(
          "Сохранения восстановлены",
          "Файлы автоматически разложены по исходным папкам. Можно запускать игры и проверять прогресс.",
          { symbol: "✓" },
        );
        await scanSaveLocations();
      }
    } catch (error) {
      log(`Ошибка восстановления сохранений: ${errorText(error)}`, "error");
      toast(errorText(error), "error");
    } finally {
      setBusy(button, false);
    }
  }

  document.querySelector("#save-add-location")?.addEventListener("click", async () => { try { const path = await call("save_add_location"); if (path) await scanSaveLocations(); } catch (error) { toast(errorText(error), "error"); } });
  document.querySelector("#save-reset-exclusions")?.addEventListener("click", async () => { try { await call("save_exclude_location", { path: "", reset: true }); await scanSaveLocations(); } catch (error) { toast(errorText(error), "error"); } });
  document.querySelector("#save-undo-restore")?.addEventListener("click", async () => { if (!await showModal("Вернуть как было?", "Будут возвращены файлы до последнего восстановления. Новые изменения существующих файлов будут защищены отдельной копией. Созданные восстановлением файлы удаляются только при совпадении хеша.", { confirm: true, confirmText: "Вернуть как было" })) return;
    try { consumeResult(await call("save_undo_restore")); } catch (error) { toast(errorText(error), "error"); } });
  document.querySelector("#save-discard-rollback")?.addEventListener("click", async () => { if (!await showModal("Удалить резервную копию отката?", "Отменить прошлое восстановление после этого будет нельзя. Архивы сохранений не удаляются.", { confirm: true, confirmText: "Удалить копию отката" })) return;
    try { await call("save_discard_restore_backup", { confirmed: true }); toast("Копия отката удалена"); } catch (error) { toast(errorText(error), "error"); } });
  return { updateSaveSelection, renderSaveLocations, scanSaveLocations, createSaveArchive, restoreSaveArchive };
  } };
})();
