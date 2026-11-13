// tauri-mock — мок IPC Tauri для UI-тестов и dev-сервера
(() => {
  const config = window.__CGS_MOCK_CONFIG__ || {};
  const registered = new Set(config.commands || []);
  const missing = new Set(config.missing || []);
  const calls = [];
  const listeners = {};
  window.__mockCalls = calls;

  const catalog = {
    cached: false,
    files: [
      { name: "Pinned Game One", build: "v1.0", password: "online-fix.me", url: "https://example.com/one.zip", pinned: true },
      { name: "Pinned Game Two", build: "v2.0", password: "", url: "https://example.com/two.zip", pinned: true },
      ...Array.from({ length: 20 }, (_, i) => ({ name: `Regular Game ${i + 1}`, build: `b${i}`, password: i % 2 ? "pw" : "", url: `https://example.com/r${i}.zip`, pinned: false })),
    ],
  };

  const nativeKey = "__native_state";
  const nativeRead = () => JSON.parse(sessionStorage.getItem(nativeKey) || '{"migrated":false,"values":{}}');
  const nativeSave = data => sessionStorage.setItem(nativeKey, JSON.stringify(data));
  const localCloudKey = "__local_cloud_state";
  const localCloudState = () => JSON.parse(sessionStorage.getItem(localCloudKey) || "null") || {
    enabled: false, managed: false, folder: null, eligibleApps: [480, 620], loaderSupported: true, issue: null,
    steamPath: "C:\\Program Files (x86)\\Steam", componentVersion: "1.0.0", componentOutdated: false,
    ...(config.localCloud || {}),
  };
  // Патч appcache: состояние и список файлов живут в sessionStorage между вызовами
  const steamPatchKey = "__steam_patch_state";
  const steamPatchFiles = (state) => [
    { name: "appinfo.vdf", exists: true, size: state === "stock" ? 4096 : 0, readonly: state !== "stock", patched: state === "patched" || state === "partial" },
    { name: "packageinfo.vdf", exists: true, size: state === "patched" ? 0 : 2048, readonly: state === "patched", patched: state === "patched" },
  ];
  const steamPatchStatus = (state, extra = {}) => ({
    steamPath: "C:\\Program Files (x86)\\Steam", appcacheFound: true, state, files: steamPatchFiles(state),
    backupAvailable: false, backupAt: null, canApply: state !== "patched", canRestore: state === "patched" || state === "partial",
    ...extra,
  });
  const savedSteamPatch = () => JSON.parse(sessionStorage.getItem(steamPatchKey) || "null");
  const currentSteamPatch = () => savedSteamPatch() || steamPatchStatus(config.steamPatch?.state || "stock");

  window.__mockEmit = (name, payload) => (listeners[name] || []).forEach(handler => handler({ payload }));
  const defaults = {
    state_bootstrap: ({legacy}) => {
      if (config.migrationFailure) throw new Error("DPAPI write verification failed");
      const data=nativeRead(); if (!data.migrated) { data.values={...legacy,...data.values}; data.migrated=true; nativeSave(data); }
      const {hubcapKey,ryuuKey,...values}=data.values;
      return {values,secretConfigured:{hubcapKey:!!hubcapKey,ryuuKey:!!ryuuKey},migrationVerified:true};
    },
    state_apply: ({changes}) => {
      if (config.gradientPreferenceSaveError && Object.hasOwn(changes, "cgs-background-gradient")) throw new Error("fixture: gradient write denied");
      if (config.startupPreferenceSaveError && Object.hasOwn(changes, "cgs-run-as-admin")) throw new Error("fixture: preference write denied");
      const data=nativeRead(); for(const [key,value] of Object.entries(changes)){if(value===null)delete data.values[key];else data.values[key]=value;} nativeSave(data); return null;
    },
    state_set_secret: ({service,value}) => {const data=nativeRead();data.values[service+"Key"]=value;nativeSave(data);return !!value;},
    jobs_list: () => config.jobs || [],
    files_install_crack: () => ({success:true,status:"success",installedFiles:["game.dll"],skipped:[],message:"Установлено и проверено"}),
    files_pause_download: () => true,
    files_discard_download: () => null,
    save_add_location: () => "D:\\Games\\Saves",
    save_exclude_location: () => null,
    preview_save_backup: () => ({fileCount:2,totalBytes:100,files:["slot/save.dat"],skipped:[],truncated:false}),
    inspect_save_archive: () => ({fileCount:2,totalBytes:100,files:["slot/save.dat"],skipped:[],truncated:false}),
    save_undo_restore: () => ({success:true,message:"Восстановлено",logs:[]}),
    save_discard_restore_backup: () => null,
    anticheat_restore: () => ({success:true,message:"Восстановлено",removed:1,failed:[]}),
  };
  const responses = {
    ...defaults,
    process_is_elevated: () => config.admin ?? true,
    startup_admin: () => {
      if (sessionStorage.getItem("__startup_admin_checked")) return false;
      sessionStorage.setItem("__startup_admin_checked", "1");
      if (nativeRead().values["cgs-run-as-admin"] === "0" || (config.admin ?? true)
          || config.elevatedHandoff || config.launchOutcome) return false;
      window.__startupAdminAttempts = (window.__startupAdminAttempts || 0) + 1;
      if (config.startupAdminRelaunch) return true;
      // Не-админ фикстуры: имитируем отказ от автозапроса UAC
      throw new Error(config.startupAdminError || "Запрос прав администратора отменён");
    },
    relaunch_as_admin: () => null,
    enable_file_drop: () => null,
    open_external: () => null,
    minimize_window: () => null, toggle_maximize_window: () => null, close_window: () => null, start_dragging_window: () => null, show_window: () => null,
    pick_game_directory: () => config.pickResult ?? "D:\\Games\\Picked",
    files_pick_download_dir: () => config.pickResult ?? "D:\\Cracks",
    files_default_download_dir: () => "C:\\Users\\Test\\Downloads",
    files_open_download_dir: () => null,
    files_catalog: () => catalog,
    files_download: (args) => {
      const dir = args.targetDir || "C:\\Users\\Test\\Downloads";
      const name = args.suggestedName || "file.zip";
      if (config.pausable) return new Promise((resolve,reject) => {
        window.__pendingDownload = {resolve,reject,args};
        window.__mockEmit("files-download-progress", {url:args.url,downloaded:50,total:100,percent:50,resumable:true});
      });
      return { fileName: name, path: `${dir}\\${name}` };
    },
    files_pause_download: () => {window.__pendingDownload?.reject("Загрузка приостановлена; проверенные сегменты сохранены для докачки");return true;},
    files_cancel_download: () => {window.__pendingDownload?.reject("Загрузка отменена");return true;},
    files_reveal: () => null,
    check_for_update: () => ({ available: false, current_version: "10.1.0", latest_version: "10.1.0", currentVersion: "10.1.0", latestVersion: "10.1.0" }),
    platform_info: () => ({ os: "windows", windows: true, windowsOnlyModules: [], sessionId: config.sessionId || "test-session" }),
    update_launch_ready: () => config.launchOutcome ?? null,
    // Установка обновления: с installPending остаётся ожидающей, ход задаётся через __mockEmit
    install_update: (args) => {
      if (config.installError) throw config.installError;
      if (!config.installPending) return null;
      return new Promise((resolve, reject) => {
        window.__pendingInstall = { resolve, reject, args };
        window.__mockEmit("cgs-update-progress", { phase: "preparing", downloaded: 0, total: 0, percent: 0, attempt: 0, message: "" });
      });
    },
    cancel_update: () => {
      const pending = window.__pendingInstall;
      window.__pendingInstall = null;
      pending?.reject("Обновление отменено.");
      return Boolean(pending);
    },
    // Локальное облако: состояние хранится в sessionStorage, чтобы переживать перезагрузку страницы
    local_cloud_status: () => localCloudState(),
    local_cloud_set: ({ enabled, folder }) => {
      if (config.localCloudSetError) throw config.localCloudSetError;
      const next = { ...localCloudState(), enabled, folder: folder || localCloudState().folder, issue: null };
      sessionStorage.setItem(localCloudKey, JSON.stringify(next));
      return next;
    },
    local_cloud_pick_folder: () => (config.localCloudPick === undefined ? "D:\\Cloud Saves" : config.localCloudPick),
    // Обновление только DLL: режим, папка и состояние копируются, флаг устаревания снимается
    local_cloud_update_component: () => {
      if (config.localCloudUpdateError) throw config.localCloudUpdateError;
      if (!localCloudState().componentOutdated) throw "Встроенная DLL уже установлена: обновление не требуется.";
      const next = { ...localCloudState(), componentOutdated: false, issue: null };
      sessionStorage.setItem(localCloudKey, JSON.stringify(next));
      return next;
    },
    cleanup_old_app_versions: () => 0,
    steam_patch_status: () => currentSteamPatch(),
    steam_patch_apply: () => {
      if (config.steamPatchApplyError) throw config.steamPatchApplyError;
      const next = steamPatchStatus("patched", { backupAvailable: true, backupAt: 1762000000, canApply: false, canRestore: true });
      sessionStorage.setItem(steamPatchKey, JSON.stringify(next));
      return { status: next, usedBackup: true, steamRestarted: false };
    },
    steam_patch_restore: () => {
      if (config.steamPatchRestoreError) throw config.steamPatchRestoreError;
      const before = currentSteamPatch();
      const next = steamPatchStatus("stock");
      sessionStorage.setItem(steamPatchKey, JSON.stringify(next));
      return { status: next, usedBackup: Boolean(before.backupAvailable), steamRestarted: false };
    },
    luatools_restore_manifests: () => null,
    luatools_detect_steam: () => "C:\\Program Files (x86)\\Steam",
    // Сторонние добавления приходят в списке только при includeExternal
    luatools_status: (args = {}) => ({
      games: [],
      externalCount: 0,
      steamPath: "C:\\Program Files (x86)\\Steam",
      includeExternal: Boolean(args.includeExternal),
    }),
    luatools_names: () => ({}),
    luatools_headers: () => ({}),
    luatools_get_loader_info: () => ({
      loaderSource: "v1",
      v1Name: "Версия 1 (Основная)",
      v1Desc: "Основная стабильная сборка OpenSteamTool (1.57 МБ)",
      v2Name: "Версия 2 (Альтернативная)",
      v2Desc: "Альтернативная встроенная сборка OpenSteamTool (1.75 МБ). Включайте, если не работает основная версия.",
      activeInSteam: "v1",
      activeInSteamLabel: "Версия 1 (Основная)",
      steamDetected: true,
    }),
    luatools_set_loader_source: () => ({ success: true, message: "Загрузчик применен" }),
    luatools_apply_loader: () => ({ success: true, message: "Загрузчик успешно обновлен в Steam" }),
    luatools_is_steam_running: () => false,
    luatools_close_steam: () => ({ success: true, message: "Steam успешно завершён" }),
    luatools_loader_info: () => ({
      loaderSource: "standard",
      selected: "standard",
      installed: "standard",
      variants: [
        {
          variant: "standard",
          name: "Версия 1 (Основная)",
          desc: "Основная сборка OpenSteamTool",
          installed: true,
          files: [{ path: "dwmapi.dll", bytes: 1640000, exists: true }]
        },
        {
          variant: "compatibility",
          name: "Версия 2 (Альтернативная)",
          desc: "Совместимая сборка OpenSteamTool",
          installed: false,
          files: [{ path: "bin/dwmapi.dll", bytes: 1830000, exists: false }]
        }
      ]
    }),
    luatools_check_loader_updates: () => ({
      commit: "abcdef1",
      selectedVariant: "standard",
      updateAvailable: false,
      variants: [
        {
          variant: "standard",
          available: true,
          updateAvailable: false,
          status: "synced",
          files: [{ path: "dwmapi.dll", bytes: 1640000, currentBytes: 1640000, status: "match" }]
        },
        {
          variant: "compatibility",
          available: true,
          updateAvailable: false,
          status: "synced",
          files: [{ path: "bin/dwmapi.dll", bytes: 1830000, currentBytes: 1830000, status: "match" }]
        }
      ]
    }),
    luatools_update_loader: () => ({ success: true, message: "Библиотеки OpenSteamTool успешно обновлены" }),
    game_artwork_store_url: () => null,
    millennium_plugin_status: () => ({ installed: false, millenniumInstalled: false }),
    perf_mode_enabled: () => false,
    perf_log: () => null,
    ryuu_usage: () => ({ dailyUsage: 0, dailyLimit: 50, remaining: 50 }),
    hubcap_usage: () => ({ used: 3, limit: 25, remaining: 22 }),
    list_games: () => [], get_app_status: () => ({}), check_asset_updates: () => ({}),
    is_selected_game_running: () => false,
    steam_launch_accounts: () => [{ id: "76561198000000000", name: "EclipseUser", preferred: true }],
    steam_launch_status: () => ({ appid: 480, account: "76561198000000000", enabled: false, managed: false, command: '"Eclipse-HV.exe" %command%' }),
    set_steam_launch: (args) => ({ appid: 480, account: args?.account || "76561198000000000", enabled: Boolean(args?.enabled), managed: Boolean(args?.enabled), command: '"Eclipse-HV.exe" %command%' }),
    scan_installed_steam_games: () => [],
    scan_save_locations: () => [],
    eclipse_hv_status: () => ({
      installed: true,
      path: "C:\\Games\\Eclipse-HV.exe",
      sizeBytes: 559104,
      version: "1.1.0",
      remoteVersion: "1.1.0",
      updateAvailable: false,
      destinationDir: "C:\\Games"
    }),
    eclipse_hv_check_update: () => ({
      installed: true,
      path: "C:\\Games\\Eclipse-HV.exe",
      sizeBytes: 559104,
      version: "1.1.0",
      remoteVersion: "1.1.0",
      updateAvailable: false,
      destinationDir: "C:\\Games"
    }),
    eclipse_hv_download: () => "Eclipse-HV.exe успешно загружен в C:\\Games",
    vbs_scan: () => ({
      admin: config.admin ?? true,
      secureBoot: "false",
      virtualizationEnabled: true,
      hypervisorPresent: false,
      restartRequired: false,
      canRestore: false,
      testSigningConfigured: false,
      testSigningActive: false,
      dse: { state: "enabled", label: "DSE включён", detail: "Проверка цифровой подписи активна" },
      components: [
        { id: "hvci", name: "Memory Integrity (HVCI)", description: "Hyper-V Protected Code Integrity", state: "enabled", enabled: true, locked: false },
        { id: "vbs", name: "Virtualization-based Security (VBS)", description: "Базовая изоляция ядра и системный гипервизор Windows", state: "enabled", enabled: true, locked: false },
        { id: "credential-guard", name: "Credential Guard", description: "Защита учётных данных LSA", state: "disabled", enabled: false, locked: false }
      ],
      enabledCount: 2,
      warnings: config.vbsWarnings || [],
      bitlocker: config.bitlocker || { state: "off", protected: false, suspended: false, message: "BitLocker не используется на системном диске" },
      kvaShadow: { needed: false, disabled: false, label: "Не требуется (современный CPU)" },
      uefiLock: { isLocked: false, vbsLocked: false, hvciLocked: false, credentialLocked: false, secConfigAvailable: true },
      conflicts: [],
      external: { detected: false, canRestore: false, trackedChanges: 0, requiresUefiConsent: false, pendingRestart: false, detail: "", blockedReason: null },
      preferredBootMode: "testsigning",
      enableBlockReason: null,
      ...(config.vbs || {})
    }),
    vbs_restore_external: () => {
      config.vbs = { ...(config.vbs || {}), canRestore: false, testSigningConfigured: false,
        external: { detected: false, canRestore: false, trackedChanges: 0, requiresUefiConsent: false, pendingRestart: true,
          detail: "Внешний режим восстановлен. Изменения загрузки вступят в силу после перезагрузки Windows.", blockedReason: "Сначала перезагрузите Windows для завершения отката внешнего режима." } };
      return { success: true, message: "Внешние настройки восстановлены по журналу VBS.cmd.", changed: 3, failed: [], restartRequired: true };
    },
    vbs_disable: () => {
      if (config.vbs?.uefiOptout?.active) config.vbs.uefiOptout.canContinue = false;
      return { success: true, message: "VBS 2.0.1: гипервизор отключён", changed: 3, failed: [], restartRequired: true };
    },
    hv_disable_protections: () => ({
      success: true,
      message: "Защиты Windows подготовлены к отключению. Перезагрузите Windows.",
      changed: 2,
      failed: [],
      restartRequired: true
    }),
    vbs_restore: (args) => {
      if (config.vbs?.uefiOptout?.active) {
        if (args?.allowUefi !== true) throw new Error("Требуется согласие на возврат UEFI Lock");
        config.vbs = { ...config.vbs, uefiOptout: null, canRestore: false,
          uefiLock: config.uefiOriginalLock || config.vbs.uefiLock };
      }
      return { success: true, message: "VBS 2.0.1: параметры восстановлены", changed: 3, failed: [], restartRequired: true };
    },
    vbs_set_test_mode: (args) => ({ success: true, message: args?.enabled ? "Тестовый режим включён" : "Тестовый режим выключен", changed: 1, failed: [], restartRequired: true }),
    vbs_restart: () => ({ success: true }),
    vbs_repair: (args) => `Восстановление ${args?.kind || "компонентов"} успешно завершено.`,
    create_game_shortcut: () => "C:\\Users\\Sparki\\Desktop\\Game.lnk",
    remove_game_shortcut: () => null,
    vbs_prepare_uefi_optout: (args) => {
      if (args?.allowUefi !== true) throw new Error("Требуется отдельное согласие на UEFI Opt-Out");
      config.uefiOriginalLock = config.vbs?.uefiLock;
      config.vbs = { ...(config.vbs || {}), canRestore: true, restartRequired: true,
        uefiLock: { isLocked: false, vbsLocked: false, hvciLocked: false, credentialLocked: false, secConfigAvailable: true },
        uefiOptout: { active: true, prepared: true, canContinue: false, pendingRestart: true, requiresRelock: true,
          blockedReason: "Сначала перезагрузите Windows и подтвердите UEFI Opt-Out либо выполните откат", detail: "UEFI Opt-Out подготовлен. Снимок сохранён; можно выполнить откат." } };
      return "UEFI Opt-Out подготовлен и проверен; исходные параметры сохранены в журнале.";
    },
    vbs_disable_faceit: () => "Служба FACEIT успешно остановлена и отключена.",
    vbs_troubleshoot: (args) => `Диагностика ${args?.action || "unknown"} успешно завершена.`,
    vbs_get_protections: () => [
      { id: "vbs", name: "Virtualization-based Security (VBS)", category: "Ядро и гипервизор", description: "Базовая изоляция ядра и системный гипервизор Windows", enabled: false, locked: false, lockReason: null },
      { id: "hvci", name: "Целостность памяти (HVCI)", category: "Ядро и гипервизор", description: "Изоляция памяти ядра и проверка целостности исполняемого кода", enabled: false, locked: false, lockReason: null },
      { id: "vulnerable-drivers", name: "Черный список уязвимых драйверов", category: "Целостность драйверов", description: "Блокировка загрузки драйверов из списка Microsoft Vulnerable Driver Blocklist", enabled: true, locked: false, lockReason: null },
      { id: "credential-guard", name: "Credential Guard и защита LSA", category: "Учётные данные", description: "Изоляция подсистемы LSA для защиты паролей и билетов Kerberos", enabled: false, locked: false, lockReason: null },
      { id: "system-guard", name: "System Guard и HyperGuard", category: "Аппаратная защита", description: "Контроль целостности при загрузке системы и защита гипервизора", enabled: false, locked: false, lockReason: null },
      { id: "kva-shadow", name: "KVA Shadow (Meltdown Mitigation)", category: "Процессор", description: "Теневое разделение адресных пространств ядра для защиты от Meltdown", enabled: false, locked: false, lockReason: null },
      { id: "xsave-mask", name: "Маска XSAVE в загрузчике (xsaveremovefeature)", category: "Параметры загрузчика (BCD)", description: "Скрытие AVX-512 и расширенных наборов инструкций процессора от программ", enabled: false, locked: false, lockReason: null },
      { id: "testsigning", name: "Тестовый режим (Testsigning / DSE)", category: "Параметры загрузчика (BCD)", description: "Разрешение загрузки неподписанных и тестовых драйверов Windows", enabled: false, locked: false, lockReason: null }
    ],
    vbs_set_protection: (args) => ({ success: true, message: `Параметр ${args?.id || ""} успешно изменён`, changed: 1, failed: [], restartRequired: true }),
    anticheat_scan: () => ({ items: [] }),
    updates_page_url: () => "https://example.com",
    // Моки управления пользовательскими звуками в кэше
    audio_save_custom_sound: (args) => {
      const name = args.name || "custom.mp3";
      const id = `custom_${name}`;
      const sizeBytes = Array.isArray(args.bytes) ? args.bytes.length : 12000;
      window.__mockCustomSounds = window.__mockCustomSounds || [];
      const meta = { id, name, sizeBytes };
      window.__mockCustomSounds = window.__mockCustomSounds.filter((s) => s.id !== id);
      window.__mockCustomSounds.push(meta);
      window.__mockSoundBytes = window.__mockSoundBytes || {};
      window.__mockSoundBytes[id] = args.bytes || [];
      return meta;
    },
    audio_list_custom_sounds: () => window.__mockCustomSounds || [],
    audio_delete_custom_sound: (args) => {
      window.__mockCustomSounds = (window.__mockCustomSounds || []).filter((s) => s.id !== args.id);
      if (window.__mockSoundBytes) delete window.__mockSoundBytes[args.id];
      return null;
    },
    audio_read_custom_sound: (args) => {
      return (window.__mockSoundBytes && window.__mockSoundBytes[args.id]) || [];
    },
  };

  async function invoke(command, args = {}) {
    calls.push({ command, args: JSON.parse(JSON.stringify(args ?? {})) });
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (missing.has(command) || (registered.size && !registered.has(command))) {
      throw `Command ${command} not found`;
    }
    if (Object.hasOwn(config.responses || {}, command)) {
      // Ответ может быть функцией: так тест отвечает по аргументам запроса
      const override = config.responses[command];
      return typeof override === "function" ? override(args) : override;
    }
    if (responses[command]) return responses[command](args);
    throw `mock: нет ответа для ${command}`;
  }

  window.__TAURI__ = {
    core: { invoke },
    event: {
      listen: async (name, handler) => { (listeners[name] ||= []).push(handler); return () => {}; },
      emit: async () => {},
    },
  };
})();
