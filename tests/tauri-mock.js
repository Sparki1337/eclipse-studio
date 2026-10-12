// Мок Tauri API для UI-тестов. Подключается через page.addInitScript до загрузки страницы.
// window.__CGS_MOCK_CONFIG__ = { missing: ["files_pick_download_dir", ...] } — эмуляция старого бэкенда.
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
    minimize_window: () => null, toggle_maximize_window: () => null, close_window: () => null, start_dragging_window: () => null,
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
    check_for_update: () => ({ available: false, current_version: "5.2.0", latest_version: "5.2.0", currentVersion: "5.2.0", latestVersion: "5.2.0" }),
    luatools_restore_manifests: () => null,
    luatools_detect_steam: () => "C:\\Program Files (x86)\\Steam",
    luatools_status: () => ({ games: [], steamPath: "C:\\Program Files (x86)\\Steam" }),
    luatools_names: () => ({}),
    millennium_plugin_status: () => ({ installed: false, millenniumInstalled: false }),
    hubcap_usage: () => ({ used: 3, limit: 25, remaining: 22 }),
    list_games: () => [], get_app_status: () => ({}), check_asset_updates: () => ({}),
    is_selected_game_running: () => false,
    scan_installed_steam_games: () => [],
    scan_save_locations: () => [],
    vbs_scan: () => ({ components: [] }),
    anticheat_scan: () => ({ items: [] }),
    updates_page_url: () => "https://example.com",
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
