// Темы, компактный режим и масштаб шрифта
(() => {
  "use strict";

  const invoke = window.cgsApi?.invoke;
  const root = document.documentElement;
  const THEMES = new Set([
    "oled", "graphite", "steel", "light",
    "ruby", "amber", "gold", "forest",
    "cyan", "midnight", "cosmos", "rose",
    "wine", "coffee"
  ]);
  const THEME_COLORS = {
    oled: "#000000", graphite: "#090a0d", steel: "#11141a", light: "#f8fafc",
    ruby: "#0e0508", amber: "#0e0804", gold: "#0c0a04", forest: "#050c09",
    cyan: "#040c10", midnight: "#060a16", cosmos: "#09061a", rose: "#0e050c",
    wine: "#0e0508", coffee: "#0c0a04"
  };
  const FONT_MIN = 85;
  const FONT_MAX = 140;

  const read = (key, fallback) => {
    try { return window.cgsStorage.getItem(key) ?? fallback; } catch (_) { return fallback; }
  };
  const write = (key, value) => {
    try { window.cgsStorage.setItem(key, value); } catch (_) {}
  };

  function applyTheme(name) {
    const theme = THEMES.has(name) ? name : "graphite";
    root.dataset.theme = theme;
    document.querySelectorAll("[data-theme-option]").forEach((button) => {
      const active = button.dataset.themeOption === theme;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLORS[theme]);
    write("cgs-theme", theme);
    // Акцент зависит от темы: в светлой используется затемнённый оттенок
    window.cgsAccent?.apply(read("accent", "mint"), theme);
  }

  function applyCompact(enabled) {
    root.classList.toggle("compact", enabled);
    const input = document.getElementById("compact-mode");
    if (input) input.checked = enabled;
    write("cgs-compact", enabled ? "1" : "0");
  }

  function applyFontScale(value) {
    const percent = Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(Number(value) / 5) * 5 || 100));
    root.style.setProperty("--fs", String(percent / 100));
    const slider = document.getElementById("font-scale");
    if (slider) {
      slider.value = String(percent);
      slider.style.setProperty("--fill", `${((percent - FONT_MIN) / (FONT_MAX - FONT_MIN)) * 100}%`);
    }
    const label = document.getElementById("font-scale-value");
    if (label) label.textContent = `${percent}%`;
    document.querySelectorAll("[data-font-preset]").forEach((button) => {
      button.classList.toggle("active", Number(button.dataset.fontPreset) === percent);
    });
    write("cgs-font-scale", String(percent));
  }

  const SHAPES = new Set(["sharp", "soft", "round"]);
  const FONTS = {
    system: '"Segoe UI Variable", "Segoe UI", system-ui, sans-serif',
    jetbrains: '"JetBrains Mono", "Cascadia Code", Consolas, monospace',
    minecraft: '"Minecraft", "Minecraftia", "Monocraft", monospace',
    bahnschrift: 'Bahnschrift, "Segoe UI", system-ui, sans-serif',
    verdana: 'Verdana, "Segoe UI", sans-serif',
    tahoma: 'Tahoma, "Segoe UI", sans-serif',
    consolas: 'Consolas, "Cascadia Mono", monospace'
  };

  const FONT_NAMES = {
    system: "Segoe UI Variable",
    jetbrains: "JetBrains Mono",
    minecraft: "Minecraft",
    bahnschrift: "Bahnschrift",
    verdana: "Verdana",
    tahoma: "Tahoma",
    consolas: "Consolas"
  };
  const WEIGHTS = new Set(["light", "regular", "bold"]);

  function applyShape(shape) {
    const value = SHAPES.has(shape) ? shape : "soft";
    root.dataset.shape = value;
    document.querySelectorAll("[data-shape-choice]").forEach((button) => {
      const active = button.dataset.shapeChoice === value;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    write("cgs-shape", value);
  }

  function applyFontFamily(fontKey) {
    const key = FONTS[fontKey] ? fontKey : "system";
    root.dataset.font = key;
    root.style.setProperty("--font", FONTS[key]);
    const select = document.getElementById("ui-font");
    if (select && select.value !== key) select.value = key;
    const preview = document.getElementById("ui-font-preview");
    if (preview) {
      preview.style.setProperty("font-family", FONTS[key], "important");
    }
    const nameLabel = document.getElementById("ui-font-current-name");
    if (nameLabel) {
      nameLabel.textContent = FONT_NAMES[key] || key;
    }
    write("cgs-font-family", key);
  }

  function applyTextWeight(weight) {
    const value = WEIGHTS.has(weight) ? weight : "regular";
    root.dataset.weight = value;
    document.querySelectorAll("[data-weight-choice]").forEach((button) => {
      const active = button.dataset.weightChoice === value;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    write("cgs-text-weight", value);
  }

  function applyContrast(enabled) {
    root.dataset.contrast = enabled ? "high" : "normal";
    const input = document.getElementById("ui-contrast");
    if (input) input.checked = enabled;
    write("cgs-contrast", enabled ? "1" : "0");
  }

  function applyGlow(enabled) {
    root.dataset.glow = enabled ? "on" : "off";
    const input = document.getElementById("ui-glow");
    if (input) input.checked = enabled;
    write("cgs-glow", enabled ? "1" : "0");
  }

  async function openExternal(url) {
    try {
      if (invoke) await invoke("open_external", { url });
      else window.open(url, "_blank", "noopener,noreferrer");
    } catch (error) {
      if (typeof window.cgsShowModal === "function") {
        await window.cgsShowModal("Не удалось открыть страницу", String(error), { symbol: "!" });
      }
    }
  }

  function bind() {
    document.querySelectorAll("[data-theme-option]").forEach((button) => {
      button.addEventListener("click", () => applyTheme(button.dataset.themeOption));
    });
    document.getElementById("compact-mode")?.addEventListener("change", (event) => {
      applyCompact(event.currentTarget.checked);
    });
    document.querySelectorAll("[data-shape-choice]").forEach((button) => {
      button.addEventListener("click", () => applyShape(button.dataset.shapeChoice));
    });
    document.getElementById("ui-font")?.addEventListener("change", (event) => {
      applyFontFamily(event.currentTarget.value);
    });
    document.querySelectorAll("[data-weight-choice]").forEach((button) => {
      button.addEventListener("click", () => applyTextWeight(button.dataset.weightChoice));
    });
    document.getElementById("ui-contrast")?.addEventListener("change", (event) => {
      applyContrast(event.currentTarget.checked);
    });
    document.getElementById("ui-glow")?.addEventListener("change", (event) => {
      applyGlow(event.currentTarget.checked);
    });
    document.getElementById("font-scale")?.addEventListener("input", (event) => {
      applyFontScale(event.currentTarget.value);
    });
    document.querySelectorAll("[data-font-preset]").forEach((button) => {
      button.addEventListener("click", () => applyFontScale(button.dataset.fontPreset));
    });
    bindCollapsibles();
    document.querySelectorAll("[data-external-url]").forEach((button) => {
      button.addEventListener("click", async (event) => {
        event.stopPropagation();
        if (button.disabled) return;
        button.disabled = true;
        try { await openExternal(button.dataset.externalUrl); }
        finally { button.disabled = false; }
      });
    });
  }

  function bindCollapsibles() {
    document.querySelectorAll("details.settings-collapsible").forEach((details) => {
      const id = details.id;
      if (id) {
        const saved = window.cgsStorage.getItem("cgs-collapse-" + id);
        if (saved !== null) {
          details.open = saved === "1";
        }
        details.addEventListener("toggle", () => {
          window.cgsStorage.setItem("cgs-collapse-" + id, details.open ? "1" : "0");
        });
      }

      const summary = details.querySelector("summary");
      const content = details.querySelector(".settings-collapsible-content");
      if (!summary || !content) return;

      summary.addEventListener("click", (e) => {
        if (details.open && !details.dataset.animating) {
          if (root.classList.contains("no-motion")) return;
          e.preventDefault();
          details.dataset.animating = "true";
          const startHeight = content.offsetHeight;
          content.style.overflow = "hidden";
          const anim = content.animate(
            [
              { height: `${startHeight}px`, opacity: "1" },
              { height: "0px", opacity: "0" }
            ],
            { duration: 180, easing: "cubic-bezier(0.16, 1, 0.3, 1)" }
          );
          const cleanup = () => {
            content.style.overflow = "";
            delete details.dataset.animating;
            details.open = false;
          };
          anim.onfinish = cleanup;
          anim.oncancel = cleanup;
        }
      });
    });
  }

  const SETTINGS_TAB_ORDER = ["interface", "home", "sidebar", "modules", "storage"];
  let previousSettingsTab = null;

  function applySettingsTab(tabName, animated = true) {
    const tab = SETTINGS_TAB_ORDER.includes(tabName) ? tabName : "interface";
    const currentActive = document.querySelector(".settings-tab-btn.active")?.dataset.settingsTab;
    if (tab === currentActive && document.querySelector(`.settings-tab-panel[data-tab-panel="${tab}"].active`)) {
      return;
    }

    const prevTab = currentActive || previousSettingsTab;
    const prevIndex = SETTINGS_TAB_ORDER.indexOf(prevTab);
    const nextIndex = SETTINGS_TAB_ORDER.indexOf(tab);
    let motionClass = "tab-fade";
    if (animated && prevTab && prevIndex !== -1 && nextIndex !== -1 && prevIndex !== nextIndex) {
      motionClass = nextIndex > prevIndex ? "slide-from-right" : "slide-from-left";
    }
    previousSettingsTab = tab;

    document.querySelectorAll(".settings-tab-btn").forEach((btn) => {
      const active = btn.dataset.settingsTab === tab;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-selected", String(active));
    });

    const isReduced = root.classList.contains("no-motion");
    document.querySelectorAll(".settings-tab-panel").forEach((panel) => {
      const active = panel.dataset.tabPanel === tab;
      panel.classList.remove("slide-from-right", "slide-from-left", "tab-fade");
      if (active) {
        panel.classList.remove("hidden");
        panel.classList.add("active");
        if (animated && motionClass && !isReduced) {
          void panel.offsetWidth;
          panel.classList.add(motionClass);
        }
      } else {
        panel.classList.remove("active");
        panel.classList.add("hidden");
      }
    });
    write("cgs-settings-tab", tab);
  }

  function bindSettingsTabs() {
    document.querySelectorAll(".settings-tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => applySettingsTab(btn.dataset.settingsTab, true));
    });
    applySettingsTab(read("cgs-settings-tab", "interface"), false);
  }

  // Настройка ширины левой панели
  const SIDEBAR_MIN = 180;
  const SIDEBAR_MAX = 380;

  function applySidebarWidth(width, save = true) {
    const mode = read("cgs-sidebar-mode", "default");
    if (mode === "icons") return;

    if (width == null) {
      root.classList.remove("sidebar-sized");
      if (mode === "compact") {
        root.style.setProperty("--sidebar-w", "185px");
        if (save) { try { window.cgsStorage.removeItem("cgs-sidebar-w-compact"); } catch (_) {} }
      } else {
        root.style.setProperty("--sidebar-w", "245px");
        if (save) { try { window.cgsStorage.removeItem("cgs-sidebar-width"); } catch (_) {} }
      }
      return;
    }
    const minW = mode === "compact" ? 160 : SIDEBAR_MIN;
    const maxW = mode === "compact" ? 220 : SIDEBAR_MAX;
    const value = Math.round(Math.min(maxW, Math.max(minW, width)));
    root.style.setProperty("--sidebar-w", `${value}px`);
    root.classList.add("sidebar-sized");
    if (save) {
      if (mode === "compact") write("cgs-sidebar-w-compact", String(value));
      else write("cgs-sidebar-width", String(value));
    }
  }

  function bindSidebarResizer() {
    const handle = document.getElementById("sidebar-resizer");
    const sidebar = document.querySelector(".sidebar");
    if (!handle || !sidebar) return;
    let startX = 0;
    let startWidth = 0;
    let requestedWidth = 0;
    let dragging = false;

    const move = (event) => {
      if (!dragging) return;
      requestedWidth = startWidth + (event.clientX - startX);
      applySidebarWidth(requestedWidth, false);
    };
    const stop = (event) => {
      if (!dragging) return;
      dragging = false;
      root.classList.remove("sidebar-resizing");
      try { handle.releasePointerCapture(event.pointerId); } catch (_) {}
      applySidebarWidth(requestedWidth, true);
    };

    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      dragging = true;
      startX = event.clientX;
      startWidth = sidebar.getBoundingClientRect().width; requestedWidth = startWidth;
      root.classList.add("sidebar-resizing");
      handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
    handle.addEventListener("dblclick", () => applySidebarWidth(null));
    handle.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const current = sidebar.getBoundingClientRect().width;
      applySidebarWidth(current + (event.key === "ArrowRight" ? 10 : -10));
    });
    handle.tabIndex = 0;
  }

  // Настройка боковой панели (порядок, видимость, режимы, drag-and-drop и контекстное меню)
  const DEFAULT_MODULES = [
    { id: "home", title: "Главная", icon: '<svg viewBox="0 0 24 24"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>' },
    { id: "fix", title: "Online Fix", icon: '<svg viewBox="0 0 24 24"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>' },
    { id: "saves", title: "Сохранения", icon: '<svg viewBox="0 0 24 24"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>' },
    { id: "dlc", title: "DLC Unlocker", icon: '<svg viewBox="0 0 24 24"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>' },
    { id: "lua", title: "Eclipse Manifest", icon: '<svg viewBox="0 0 24 24"><path d="m18 16 4-4-4-4"/><path d="m6 8-4 4 4 4"/><path d="m14.5 4-5 16"/></svg>' },
    { id: "hypervisor", title: "Гипервизор", icon: '<svg viewBox="0 0 24 24"><rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9" rx="1"/><path d="M15 2v2"/><path d="M15 20v2"/><path d="M2 15h2"/><path d="M2 9h2"/><path d="M20 15h2"/><path d="M20 9h2"/><path d="M9 2v2"/><path d="M9 20v2"/></svg>' },
    { id: "files", title: "Кряки", icon: '<svg viewBox="0 0 24 24"><path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>' },
    { id: "utilities", title: "Утилиты", icon: '<svg viewBox="0 0 24 24"><path d="M16 6V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/><rect width="20" height="14" x="2" y="6" rx="2"/><path d="M2 11h20"/><path d="M10 11v2a2 2 0 0 0 4 0v-2"/></svg>' },
    { id: "settings", title: "Настройки", icon: '<svg viewBox="0 0 24 24"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>' }
  ];

  function getSidebarConfig() {
    let order = [];
    try {
      const stored = window.cgsStorage.getItem("cgs-sidebar-order");
      if (stored) order = JSON.parse(stored);
    } catch (_) {}
    if (!Array.isArray(order) || !order.length) {
      order = DEFAULT_MODULES.map((m) => m.id);
    }
    DEFAULT_MODULES.forEach((m) => {
      if (!order.includes(m.id)) order.push(m.id);
    });

    let hidden = [];
    try {
      const stored = window.cgsStorage.getItem("cgs-sidebar-hidden");
      if (stored) hidden = JSON.parse(stored);
    } catch (_) {}
    if (!Array.isArray(hidden)) hidden = [];

    let sizes = {};
    try {
      const stored = window.cgsStorage.getItem("cgs-sidebar-sizes");
      if (stored) sizes = JSON.parse(stored);
    } catch (_) {}
    if (!sizes || typeof sizes !== "object") sizes = {};

    const mode = read("cgs-sidebar-mode", "default");
    return { order, hidden: new Set(hidden), sizes, mode };
  }

  function saveSidebarConfig(config) {
    write("cgs-sidebar-order", JSON.stringify(config.order));
    write("cgs-sidebar-hidden", JSON.stringify([...config.hidden]));
    write("cgs-sidebar-sizes", JSON.stringify(config.sizes));
    write("cgs-sidebar-mode", config.mode);
  }

  function isSidebarLiveEditEnabled() {
    return read("cgs-sidebar-live-edit", "0") === "1";
  }

  function setSidebarLiveEdit(enabled) {
    write("cgs-sidebar-live-edit", enabled ? "1" : "0");
    applySidebarLiveEdit();
  }

  function applySidebarLiveEdit() {
    const enabled = isSidebarLiveEditEnabled();
    root.classList.toggle("sidebar-live-edit", enabled);

    const toggle = document.getElementById("sidebar-live-edit-toggle");
    if (toggle) toggle.checked = enabled;

    const ctxLiveText = document.getElementById("nav-context-live-text");
    if (ctxLiveText) {
      ctxLiveText.textContent = enabled
        ? "Редактирование «На лету»: Вкл"
        : "Редактирование «На лету»: Выкл";
    }
  }

  function applySidebarMode(mode, save = true) {
    const validMode = ["default", "compact", "icons"].includes(mode) ? mode : "default";
    root.classList.remove("sidebar-icons", "sidebar-compact");

    if (validMode === "icons") {
      root.classList.add("sidebar-icons");
      root.style.setProperty("--sidebar-w", "68px");
    } else if (validMode === "compact") {
      root.classList.add("sidebar-compact");
      const compactW = parseInt(read("cgs-sidebar-w-compact", "185"), 10) || 185;
      root.style.setProperty("--sidebar-w", `${compactW}px`);
    } else {
      const defaultW = parseInt(read("cgs-sidebar-width", "245"), 10) || 245;
      root.style.setProperty("--sidebar-w", `${defaultW}px`);
    }

    document.querySelectorAll(".sidebar-mode-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.sidebarMode === validMode);
    });

    if (save) {
      const config = getSidebarConfig();
      config.mode = validMode;
      saveSidebarConfig(config);
    }
  }

  function applySidebarState() {
    const config = getSidebarConfig();
    const nav = document.querySelector(".navigation");
    if (!nav) return;

    applySidebarMode(config.mode, false);
    applySidebarLiveEdit();

    const itemsMap = new Map();
    nav.querySelectorAll(".nav-item").forEach((item) => {
      const view = item.dataset.view;
      if (view) itemsMap.set(view, item);
    });

    config.order.forEach((id) => {
      const el = itemsMap.get(id);
      if (el) {
        nav.appendChild(el);
        const isHidden = config.hidden.has(id);
        el.classList.toggle("nav-item-hidden", isHidden);
        const isSize2 = config.sizes[id] === 2;
        el.classList.toggle("size-2", isSize2);
        const mod = DEFAULT_MODULES.find((m) => m.id === id);
        if (mod) el.title = mod.title;
      }
    });

    renderSidebarSettingsList();
    // Главная повторяет порядок разделов в карточках модулей и проверяет раздел при запуске
    window.dispatchEvent(new CustomEvent("cgs:sidebar-changed"));
  }

  function renderSidebarSettingsList() {
    const container = document.getElementById("sidebar-modules-list");
    if (!container) return;
    const config = getSidebarConfig();
    const map = new Map(DEFAULT_MODULES.map((m) => [m.id, m]));

    container.innerHTML = "";
    config.order.forEach((id, index) => {
      const mod = map.get(id);
      if (!mod) return;
      const isHidden = config.hidden.has(id);
      const isSize2 = config.sizes[id] === 2;

      const row = document.createElement("div");
      row.className = "sidebar-module-row";
      row.dataset.moduleId = id;

      row.innerHTML = `
        <span class="sidebar-module-drag-handle" title="Зажмите и перетащите для изменения порядка">
          <svg viewBox="0 0 16 16"><circle cx="5" cy="4" r="1.5" fill="currentColor"/><circle cx="11" cy="4" r="1.5" fill="currentColor"/><circle cx="5" cy="8" r="1.5" fill="currentColor"/><circle cx="11" cy="8" r="1.5" fill="currentColor"/><circle cx="5" cy="12" r="1.5" fill="currentColor"/><circle cx="11" cy="12" r="1.5" fill="currentColor"/></svg>
        </span>
        <div class="sidebar-module-order-btns">
          <button type="button" class="sidebar-module-order-btn order-up" title="Поднять" ${index === 0 ? "disabled" : ""}>
            <svg viewBox="0 0 16 16"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" d="M3 10l5-5 5 5"/></svg>
          </button>
          <button type="button" class="sidebar-module-order-btn order-down" title="Опустить" ${index === config.order.length - 1 ? "disabled" : ""}>
            <svg viewBox="0 0 16 16"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" d="M3 6l5 5 5-5"/></svg>
          </button>
        </div>
        <span class="sidebar-module-index">${String(index + 1).padStart(2, "0")}</span>
        <span class="sidebar-module-icon">${mod.icon}</span>
        <strong class="sidebar-module-title">${mod.title}</strong>
        <button type="button" class="sidebar-module-size-btn ${isSize2 ? "active" : ""}" title="Переключить размер кнопки x1 / x2">
          ${isSize2 ? "2× Размер" : "1× Размер"}
        </button>
        <label class="switch" title="Видимость в боковой панели">
          <input type="checkbox" class="sidebar-module-toggle" ${!isHidden ? "checked" : ""} />
          <i></i>
        </label>
      `;

      row.querySelector(".order-up")?.addEventListener("click", (e) => {
        e.stopPropagation();
        if (index > 0) {
          const newOrder = [...config.order];
          [newOrder[index - 1], newOrder[index]] = [newOrder[index], newOrder[index - 1]];
          config.order = newOrder;
          saveSidebarConfig(config);
          applySidebarState();
        }
      });
      row.querySelector(".order-down")?.addEventListener("click", (e) => {
        e.stopPropagation();
        if (index < config.order.length - 1) {
          const newOrder = [...config.order];
          [newOrder[index], newOrder[index + 1]] = [newOrder[index + 1], newOrder[index]];
          config.order = newOrder;
          saveSidebarConfig(config);
          applySidebarState();
        }
      });

      row.querySelector(".sidebar-module-size-btn")?.addEventListener("click", (e) => {
        e.stopPropagation();
        config.sizes[id] = config.sizes[id] === 2 ? 1 : 2;
        saveSidebarConfig(config);
        applySidebarState();
      });

      row.querySelector(".sidebar-module-toggle")?.addEventListener("change", (e) => {
        if (e.currentTarget.checked) config.hidden.delete(id);
        else config.hidden.add(id);
        saveSidebarConfig(config);
        applySidebarState();
      });

      const handle = row.querySelector(".sidebar-module-drag-handle");
      if (handle) {
        handle.addEventListener("pointerdown", (e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          let isDragging = false;
          const startY = e.clientY;
          let dropRow = null;
          let placeAfter = false;

          const clearRowDrop = () => {
            container.querySelectorAll(".sidebar-module-row").forEach((r) => {
              r.classList.remove("drop-target-before", "drop-target-after");
            });
          };

          const move = (ev) => {
            if (!isDragging) {
              if (Math.abs(ev.clientY - startY) > 3) {
                isDragging = true;
                row.classList.add("dragging");
              } else {
                return;
              }
            }
            ev.preventDefault();
            clearRowDrop();

            const rows = Array.from(container.querySelectorAll(".sidebar-module-row"));
            dropRow = null;

            for (const r of rows) {
              if (r === row) continue;
              const rect = r.getBoundingClientRect();
              if (ev.clientY >= rect.top && ev.clientY <= rect.bottom) {
                dropRow = r;
                placeAfter = ev.clientY > (rect.top + rect.height / 2);
                break;
              }
            }

            if (dropRow) {
              dropRow.classList.toggle("drop-target-after", placeAfter);
              dropRow.classList.toggle("drop-target-before", !placeAfter);
            }
          };

          const stop = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", stop);
            row.classList.remove("dragging");
            clearRowDrop();

            if (isDragging && dropRow && dropRow !== row) {
              const targetId = dropRow.dataset.moduleId;
              if (targetId && targetId !== id) {
                const currentOrder = config.order.filter((x) => x !== id);
                const targetIdx = currentOrder.indexOf(targetId);
                currentOrder.splice(placeAfter ? targetIdx + 1 : targetIdx, 0, id);
                config.order = currentOrder;
                saveSidebarConfig(config);
                applySidebarState();
              }
            }
          };

          window.addEventListener("pointermove", move, { passive: false });
          window.addEventListener("pointerup", stop);
        });
      }

      container.appendChild(row);
    });
  }

  function showToast(message, type = "success") {
    if (typeof window.cgsToast === "function") {
      window.cgsToast(message, type);
    } else {
      const stack = document.getElementById("toast-stack");
      if (!stack) return;
      const item = document.createElement("div");
      item.className = `toast ${type}`;
      item.textContent = message;
      stack.appendChild(item);
      setTimeout(() => {
        item.style.opacity = "0";
        item.style.transform = "translateX(15px)";
        setTimeout(() => item.remove(), 250);
      }, 3600);
    }
  }

  function bindSidebarDirectDnD() {
    const nav = document.querySelector(".navigation");
    if (!nav) return;

    let suppressNextClick = false;

    nav.addEventListener("click", (e) => {
      if (suppressNextClick) {
        e.preventDefault();
        e.stopPropagation();
        suppressNextClick = false;
      }
    }, true);

    nav.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || !isSidebarLiveEditEnabled()) return;
      const item = e.target.closest(".nav-item");
      if (!item) return;

      const viewId = item.dataset.view;
      if (!viewId) return;

      const startX = e.clientX;
      const startY = e.clientY;
      let isDragging = false;

      let visibleItems = [];
      let itemMetrics = [];
      let fromIndex = -1;
      let toIndex = -1;
      let draggedDisplacement = 0;

      const onPointerMove = (ev) => {
        const dist = Math.hypot(ev.clientX - startX, ev.clientY - startY);
        if (!isDragging) {
          if (dist > 4) {
            isDragging = true;
            item.classList.add("nav-item-dragging");
            document.body.classList.add("sidebar-dragging-active");

            visibleItems = Array.from(nav.querySelectorAll(".nav-item:not(.nav-item-hidden)"));
            fromIndex = visibleItems.indexOf(item);
            toIndex = fromIndex;

            const itemRect = item.getBoundingClientRect();
            draggedDisplacement = itemRect.height + 4;

            itemMetrics = visibleItems.map((el) => {
              const r = el.getBoundingClientRect();
              return {
                el,
                id: el.dataset.view,
                top: r.top,
                bottom: r.bottom,
                height: r.height,
                midY: r.top + r.height / 2
              };
            });
          } else {
            return;
          }
        }

        ev.preventDefault();
        const dy = ev.clientY - startY;
        item.style.setProperty("transform", `translateY(${dy}px)`, "important");

        const currentCenterY = itemMetrics[fromIndex].midY + dy;

        // Определение слота перемещения
        let newTarget = fromIndex;
        for (let i = 0; i < itemMetrics.length; i++) {
          if (i === fromIndex) continue;
          if (fromIndex < i) {
            if (currentCenterY > itemMetrics[i].midY) {
              newTarget = i;
            }
          } else {
            if (currentCenterY < itemMetrics[i].midY) {
              newTarget = i;
              break;
            }
          }
        }

        if (newTarget !== toIndex) {
          toIndex = newTarget;
        }

        // Смещение соседних элементов
        for (let i = 0; i < itemMetrics.length; i++) {
          if (i === fromIndex) continue;
          const targetEl = itemMetrics[i].el;
          if (fromIndex < toIndex) {
            if (i > fromIndex && i <= toIndex) {
              targetEl.style.transform = `translateY(-${draggedDisplacement}px)`;
            } else {
              targetEl.style.transform = "translateY(0px)";
            }
          } else if (fromIndex > toIndex) {
            if (i >= toIndex && i < fromIndex) {
              targetEl.style.transform = `translateY(${draggedDisplacement}px)`;
            } else {
              targetEl.style.transform = "translateY(0px)";
            }
          } else {
            targetEl.style.transform = "translateY(0px)";
          }
        }
      };

      const onPointerUp = () => {
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        document.body.classList.remove("sidebar-dragging-active");

        if (isDragging) {
          suppressNextClick = true;

          if (toIndex !== fromIndex && toIndex >= 0 && toIndex < itemMetrics.length) {
            const landingOffset = itemMetrics[toIndex].top - itemMetrics[fromIndex].top;
            item.classList.add("nav-item-animating");
            item.style.setProperty("transform", `translateY(${landingOffset}px)`, "important");

            setTimeout(() => {
              visibleItems.forEach((el) => { el.style.transform = ""; });
              item.classList.remove("nav-item-dragging", "nav-item-animating");
              item.style.transform = "";

              const config = getSidebarConfig();
              const newOrder = config.order.filter((id) => id !== viewId);
              const targetViewId = itemMetrics[toIndex].id;
              const targetIdx = newOrder.indexOf(targetViewId);
              newOrder.splice(toIndex > fromIndex ? targetIdx + 1 : targetIdx, 0, viewId);
              config.order = newOrder;
              saveSidebarConfig(config);
              applySidebarState();
            }, 210);
          } else {
            item.classList.add("nav-item-animating");
            item.style.setProperty("transform", "translateY(0px)", "important");
            setTimeout(() => {
              visibleItems.forEach((el) => { el.style.transform = ""; });
              item.classList.remove("nav-item-dragging", "nav-item-animating");
              item.style.transform = "";
            }, 210);
          }
        }
      };

      window.addEventListener("pointermove", onPointerMove, { passive: false });
      window.addEventListener("pointerup", onPointerUp);
    });
  }

  let activeContextViewId = null;
  let contextCloseTimer = null;

  function closeSidebarContextMenu(immediate = false) {
    const menu = document.getElementById("nav-context-menu");
    if (!menu || menu.classList.contains("hidden")) return;

    if (contextCloseTimer) {
      clearTimeout(contextCloseTimer);
      contextCloseTimer = null;
    }

    if (immediate) {
      menu.classList.remove("closing");
      menu.classList.add("hidden");
      return;
    }

    menu.classList.add("closing");
    contextCloseTimer = setTimeout(() => {
      menu.classList.remove("closing");
      menu.classList.add("hidden");
      contextCloseTimer = null;
    }, 100);
  }

  function openSidebarContextMenu(item, clientX, clientY) {
    const menu = document.getElementById("nav-context-menu");
    if (!menu) return;

    if (contextCloseTimer) {
      clearTimeout(contextCloseTimer);
      contextCloseTimer = null;
    }

    activeContextViewId = item.dataset.view;
    const config = getSidebarConfig();
    const mod = DEFAULT_MODULES.find((m) => m.id === activeContextViewId);
    if (!mod) return;

    // Заполнение данных меню
    const iconContainer = document.getElementById("nav-context-icon");
    if (iconContainer) iconContainer.innerHTML = mod.icon;
    const titleContainer = document.getElementById("nav-context-title");
    if (titleContainer) titleContainer.textContent = mod.title;

    const isSize2 = config.sizes[activeContextViewId] === 2;
    const sizeText = document.getElementById("nav-context-size-text");
    if (sizeText) {
      sizeText.textContent = isSize2 ? "Вернуть обычный размер" : "Растянуть на 2 слота";
    }

    const idx = config.order.indexOf(activeContextViewId);
    const moveUpBtn = document.getElementById("nav-context-move-up");
    if (moveUpBtn) moveUpBtn.disabled = idx <= 0;
    const moveDownBtn = document.getElementById("nav-context-move-down");
    if (moveDownBtn) moveDownBtn.disabled = idx >= config.order.length - 1;

    const liveEnabled = isSidebarLiveEditEnabled();
    const liveText = document.getElementById("nav-context-live-text");
    if (liveText) {
      liveText.textContent = liveEnabled
        ? "Редактирование «На лету»: Вкл"
        : "Редактирование «На лету»: Выкл";
    }

    const menuW = 232;
    const menuH = 290;
    let x = clientX;
    let y = clientY;

    if (x + menuW > window.innerWidth - 12) x = window.innerWidth - menuW - 12;
    if (y + menuH > window.innerHeight - 12) y = window.innerHeight - menuH - 12;
    if (x < 10) x = 10;
    if (y < 10) y = 10;

    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;

    menu.classList.remove("closing", "hidden");
  }

  function bindSidebarContextMenu() {
    const menu = document.getElementById("nav-context-menu");
    if (!menu) return;

    // Контекстное меню по правой кнопке мыши
    document.addEventListener("contextmenu", (e) => {
      const item = e.target.closest(".nav-item");
      if (!item) return;
      const sidebar = item.closest(".sidebar");
      if (!sidebar) return;

      e.preventDefault();
      e.stopPropagation();

      openSidebarContextMenu(item, e.clientX, e.clientY);
    }, true);

    document.addEventListener("pointerdown", (e) => {
      if (!menu.classList.contains("hidden")) {
        if (menu.contains(e.target)) return;
        if (e.button === 2 && e.target.closest(".sidebar .nav-item")) return;
        closeSidebarContextMenu(false);
      }
    }, true);

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeSidebarContextMenu(true);
    });

    // Переключение размера кнопки (1 или 2 слота)
    document.getElementById("nav-context-toggle-size")?.addEventListener("click", () => {
      if (!activeContextViewId) return;
      const targetId = activeContextViewId;
      closeSidebarContextMenu(true);

      const item = document.querySelector(`.nav-item[data-view="${targetId}"]`);
      if (item) {
        item.classList.add("size-just-changed");
        setTimeout(() => item.classList.remove("size-just-changed"), 400);
      }

      const config = getSidebarConfig();
      config.sizes[targetId] = config.sizes[targetId] === 2 ? 1 : 2;
      saveSidebarConfig(config);
      applySidebarState();
    });

    // Скрытие кнопки
    document.getElementById("nav-context-hide")?.addEventListener("click", () => {
      if (!activeContextViewId) return;
      const targetId = activeContextViewId;
      closeSidebarContextMenu(true);

      const item = document.querySelector(`.nav-item[data-view="${targetId}"]`);
      if (item) {
        item.classList.add("nav-item-removing");
        setTimeout(() => {
          const config = getSidebarConfig();
          config.hidden.add(targetId);
          saveSidebarConfig(config);
          applySidebarState();

          const currentActive = document.querySelector(".nav-item.active")?.dataset.view;
          if (currentActive === targetId) {
            document.querySelector('.nav-item[data-view="home"]')?.click();
          }
          showToast("Кнопка скрыта из панели. Вернуть её можно в Настройках → Боковая панель", "info");
        }, 280);
      } else {
        const config = getSidebarConfig();
        config.hidden.add(targetId);
        saveSidebarConfig(config);
        applySidebarState();
      }
    });

    // Перемещение кнопки вверх
    document.getElementById("nav-context-move-up")?.addEventListener("click", () => {
      if (!activeContextViewId) return;
      const targetId = activeContextViewId;
      closeSidebarContextMenu(true);

      const config = getSidebarConfig();
      const idx = config.order.indexOf(targetId);
      if (idx > 0) {
        const prevId = config.order[idx - 1];
        const elA = document.querySelector(`.nav-item[data-view="${targetId}"]`);
        const elB = document.querySelector(`.nav-item[data-view="${prevId}"]`);
        const rectA = elA?.getBoundingClientRect();
        const rectB = elB?.getBoundingClientRect();

        [config.order[idx - 1], config.order[idx]] = [config.order[idx], config.order[idx - 1]];
        saveSidebarConfig(config);
        applySidebarState();

        if (elA && elB && rectA && rectB) {
          const newRectA = elA.getBoundingClientRect();
          const newRectB = elB.getBoundingClientRect();
          elA.style.transition = "none";
          elB.style.transition = "none";
          elA.style.transform = `translateY(${rectA.top - newRectA.top}px)`;
          elB.style.transform = `translateY(${rectB.top - newRectB.top}px)`;
          void elA.offsetHeight;
          elA.style.transition = "transform 0.26s cubic-bezier(0.16, 1, 0.3, 1)";
          elB.style.transition = "transform 0.26s cubic-bezier(0.16, 1, 0.3, 1)";
          elA.style.transform = "";
          elB.style.transform = "";
          setTimeout(() => {
            elA.style.transition = "";
            elB.style.transition = "";
          }, 270);
        }
      }
    });

    // Перемещение кнопки вниз
    document.getElementById("nav-context-move-down")?.addEventListener("click", () => {
      if (!activeContextViewId) return;
      const targetId = activeContextViewId;
      closeSidebarContextMenu(true);

      const config = getSidebarConfig();
      const idx = config.order.indexOf(targetId);
      if (idx >= 0 && idx < config.order.length - 1) {
        const nextId = config.order[idx + 1];
        const elA = document.querySelector(`.nav-item[data-view="${targetId}"]`);
        const elB = document.querySelector(`.nav-item[data-view="${nextId}"]`);
        const rectA = elA?.getBoundingClientRect();
        const rectB = elB?.getBoundingClientRect();

        [config.order[idx], config.order[idx + 1]] = [config.order[idx + 1], config.order[idx]];
        saveSidebarConfig(config);
        applySidebarState();

        if (elA && elB && rectA && rectB) {
          const newRectA = elA.getBoundingClientRect();
          const newRectB = elB.getBoundingClientRect();
          elA.style.transition = "none";
          elB.style.transition = "none";
          elA.style.transform = `translateY(${rectA.top - newRectA.top}px)`;
          elB.style.transform = `translateY(${rectB.top - newRectB.top}px)`;
          void elA.offsetHeight;
          elA.style.transition = "transform 0.26s cubic-bezier(0.16, 1, 0.3, 1)";
          elB.style.transition = "transform 0.26s cubic-bezier(0.16, 1, 0.3, 1)";
          elA.style.transform = "";
          elB.style.transform = "";
          setTimeout(() => {
            elA.style.transition = "";
            elB.style.transition = "";
          }, 270);
        }
      }
    });

    // Режим правки на лету
    document.getElementById("nav-context-live-toggle")?.addEventListener("click", () => {
      const next = !isSidebarLiveEditEnabled();
      setSidebarLiveEdit(next);
      closeSidebarContextMenu(true);
      showToast(next ? "Режим «На лету» включён: можно переставлять и растягивать иконки" : "Режим «На лету» выключен", "info");
    });

    // Переход в настройки
    document.getElementById("nav-context-settings")?.addEventListener("click", () => {
      closeSidebarContextMenu(true);
      document.querySelector('.nav-item[data-view="settings"]')?.click();
      applySettingsTab("sidebar");
    });

    // Сброс настроек
    document.getElementById("nav-context-reset")?.addEventListener("click", () => {
      resetSidebar();
      closeSidebarContextMenu(true);
      showToast("Боковая панель сброшена к исходным настройкам", "info");
    });
  }

  function resetSidebar() {
    const config = {
      order: DEFAULT_MODULES.map((m) => m.id),
      hidden: new Set(),
      sizes: {},
      mode: "default"
    };
    saveSidebarConfig(config);
    applySidebarState();
  }

  function showAllSidebarModules() {
    const config = getSidebarConfig();
    config.hidden.clear();
    saveSidebarConfig(config);
    applySidebarState();
  }

  function bindSidebarSettingsTab() {
    document.querySelectorAll(".sidebar-mode-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        applySidebarMode(btn.dataset.sidebarMode, true);
        applySidebarState();
      });
    });

    document.getElementById("sidebar-live-edit-toggle")?.addEventListener("change", (e) => {
      setSidebarLiveEdit(e.currentTarget.checked);
    });

    document.getElementById("sidebar-show-all")?.addEventListener("click", showAllSidebarModules);
    document.getElementById("sidebar-reset-order")?.addEventListener("click", resetSidebar);
    renderSidebarSettingsList();
  }

  bind();
  bindSidebarResizer();
  bindSettingsTabs();
  bindSidebarDirectDnD();
  bindSidebarContextMenu();
  bindSidebarSettingsTab();
  applySidebarState();
  applyTheme(read("cgs-theme", "graphite"));
  applyCompact(read("cgs-compact", "1") === "1");
  applyFontScale(read("cgs-font-scale", "120"));
  applyShape(read("cgs-shape", "soft"));
  applyFontFamily(read("cgs-font-family", "system"));
  applyTextWeight(read("cgs-text-weight", "regular"));
  applyContrast(read("cgs-contrast", "0") === "1");
  applyGlow(read("cgs-glow", "1") !== "0");

  window.cgsAppearance = {
    applyTheme,
    applyCompact,
    applyFontScale,
    applyShape,
    applyFontFamily,
    applyTextWeight,
    applyContrast,
    applyGlow,
    applySidebarWidth,
    applySidebarMode,
    applySettingsTab,
    applySidebarState,
    setSidebarLiveEdit,
    isSidebarLiveEditEnabled,
    resetSidebar
  };
})();
