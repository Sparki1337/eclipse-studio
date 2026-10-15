// Мок Tauri API для UI-тестов
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

  const responses = {
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
      return { fileName: name, path: `${dir}\\${name}` };
    },
    files_cancel_download: () => true,
    files_reveal: () => null,
    check_for_update: () => ({ available: false, current_version: "7.0.1", latest_version: "7.0.1", currentVersion: "7.0.1", latestVersion: "7.0.1" }),
    download_app_update: async (args) => {
      const ver = args?.version || "6.6.8";
      const name = `Eclipse-Studio-v${ver}.exe`;
      return { filePath: `C:\\Users\\Test\\Desktop\\Programms\\Hypervisor\\${name}`, fileName: name, version: ver, readyToInstall: true };
    },
    launch_app_update: () => null,
    cleanup_old_app_versions: () => 0,
    luatools_restore_manifests: () => null,
    luatools_detect_steam: () => "C:\\Program Files (x86)\\Steam",
    luatools_status: () => ({ games: [], steamPath: "C:\\Program Files (x86)\\Steam" }),
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
    game_artwork_store_url: () => null,
    millennium_plugin_status: () => ({ installed: false, millenniumInstalled: false }),
    hubcap_usage: () => ({ used: 3, limit: 25, remaining: 22 }),
    list_games: () => [], get_app_status: () => ({}), check_asset_updates: () => ({}),
    is_selected_game_running: () => false,
    scan_installed_steam_games: () => [],
    scan_save_locations: () => [],
    vbs_scan: () => ({ components: [] }),
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
