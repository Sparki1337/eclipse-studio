// Журнал операций интерфейса за текущую сессию (дополняет нативный журнал jobs_list)
(() => {
  "use strict";
  // Понятные названия пользовательских операций: [подпись, раздел, подпись в нативном журнале].
  // Фоновые и читающие команды (лимиты, статусы, поиск) сюда не входят и на главной не показываются.
  // Для команд с нативным журналом третья колонка совпадает с подписью в Rust (jobs::run),
  // чтобы главная не показывала одну и ту же ошибку дважды.
  const OPERATIONS = {
    install_fix: ["Установка Online Fix", "fix", "Установка Online Fix"],
    uninstall_fix: ["Возврат оригинальных файлов", "fix", "Возврат оригинальных файлов"],
    install_epicfix_only: ["Установка EOS-компонентов", "fix", "Установка EOS-компонентов"],
    restore_eos_only: ["Возврат EOS", "fix", "Возврат EOS"],
    create_save_archive: ["Архив сохранений", "saves", "Архив сохранений"],
    restore_save_archive: ["Восстановление сохранений", "saves", "Восстановление сохранений"],
    save_undo_restore: ["Вернуть сохранения как было", "saves", "Вернуть сохранения как было"],
    save_discard_restore_backup: ["Удалить резервную копию отката", "saves", "Удалить резервную копию отката"],
    install_dlc_unlocker: ["Установка DLC-компонентов", "dlc", "Установка DLC-компонентов"],
    uninstall_dlc_unlocker: ["Удаление DLC-компонентов", "dlc", "Удаление DLC-компонентов"],
    install_smaki: ["Установка SmokeAPI", "dlc", "Установка SmokeAPI"],
    uninstall_smaki: ["Удаление SmokeAPI", "dlc", "Удаление SmokeAPI"],
    files_download: ["Загрузка файла", "files", "Загрузка файла"],
    files_install_crack: ["Установка файлов игры", "files", "Установка файлов игры"],
    add_game: ["Добавление игры в гипервизор", "hypervisor", "Проверить встроенный лаунчер"],
    verify_game: ["Проверка файлов игры", "hypervisor", "Проверить встроенный лаунчер"],
    launch_selected_game: ["Запуск игры", "hypervisor", "Проверить встроенный лаунчер"],
    remove_game: ["Удаление игры из гипервизора", "hypervisor"],
    eclipse_hv_download: ["Загрузка Eclipse-HV", "hypervisor"],
    anticheat_remove: ["Удаление выбранных компонентов", "hypervisor:anticheat", "Удаление выбранных компонентов"],
    anticheat_remove_all: ["Удаление системных компонентов", "hypervisor:anticheat", "Удаление системных компонентов"],
    anticheat_restore: ["Вернуть системные компоненты как было", "hypervisor:anticheat", "Вернуть системные компоненты как было"],
    vbs_disable: ["Изменение VBS", "hypervisor:vbs", "Изменение VBS"],
    vbs_restore: ["Возврат исходных параметров Windows", "hypervisor:vbs", "Возврат исходных параметров Windows"],
    vbs_enable_all: ["Включение защит Windows", "hypervisor:vbs", "Включение защит Windows"],
    vbs_set_test_mode: ["Тестовый режим Windows", "hypervisor:vbs", "Тестовый режим Windows"],
    vbs_disable_faceit: ["Изменение служб FACEIT", "hypervisor:vbs", "Изменение служб FACEIT"],
    vbs_troubleshoot: ["Диагностика Windows без изменений", "hypervisor:vbs", "Диагностика Windows без изменений"],
    luatools_install: ["Добавление манифестов", "lua"],
    luatools_toggle: ["Переключение игры в загрузчике", "lua"],
    luatools_remove: ["Удаление игры из загрузчика", "lua"],
    luatools_restart_steam: ["Перезапуск Steam", "lua"],
    luatools_close_steam: ["Закрытие Steam", "lua"],
    luatools_set_loader_source: ["Смена версии OpenSteamTool", "lua"],
    luatools_apply_loader: ["Применение OpenSteamTool", "lua"],
    luatools_update_loader: ["Обновление OpenSteamTool", "lua"],
    ryuu_get: ["Загрузка манифестов Ryuu", "lua"],
    hubcap_get: ["Загрузка манифестов HubCap", "lua"],
    millennium_install_bundled: ["Установка Millennium", "lua"],
    millennium_install_plugin: ["Установка плагина Millennium", "lua"],
    millennium_remove_plugin: ["Удаление плагина Millennium", "lua"],
    millennium_migrate_from_croclua: ["Замена CrocLua", "lua"],
    millennium_remove_legacy_croclua: ["Удаление CrocLua", "lua"],
    download_app_update: ["Загрузка обновления программы", "settings"],
    launch_app_update: ["Запуск обновления программы", "settings"],
  };
  // Раздел по подписи нативного задания — для кнопки «Открыть» на главной
  const NATIVE_VIEWS = new Map();
  for (const [, view, native] of Object.values(OPERATIONS)) if (native && !NATIVE_VIEWS.has(native)) NATIVE_VIEWS.set(native, view);

  function describe(command) {
    const operation = OPERATIONS[command];
    if (!operation) return null;
    const [label, view, native] = operation;
    // Источник манифестов, к которому относится операция: при другом выбранном сервисе запись не показывается
    const service = /^(hubcap|ryuu)_/.exec(command)?.[1] || "";
    return { label, view, native: native || "", service };
  }

  const entries = new Map();
  window.addEventListener("cgs:request", event => {
    const item = event.detail;
    const info = describe(item.command);
    if (!info) return;
    const previous = entries.get(item.id);
    // Время старта запоминается один раз: по нему сравниваем запись с нативным журналом
    entries.set(item.id, { ...item, ...info, time: previous?.time || Date.now() });
    if (entries.size > 100) entries.delete(entries.keys().next().value);
    window.dispatchEvent(new Event("cgs:jobs-changed"));
  });
  window.addEventListener("cgs:storage-error", event => {
    const id = "storage";
    entries.delete(id);
    entries.set(id, { id, command: "storage", label: "Сохранение настроек", view: "settings", native: "", service: "", status: "failed", message: String(event.detail || ""), time: Date.now() });
    window.cgsToast?.("Настройки не сохранены в Windows: " + event.detail, "error"); window.dispatchEvent(new Event("cgs:jobs-changed"));
  });
  window.cgsJobs = {
    // Новые записи первыми
    list: () => [...entries.values()].reverse(),
    describe,
    viewForLabel: label => NATIVE_VIEWS.get(label) || "",
  };
})();
