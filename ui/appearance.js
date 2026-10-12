// Темы, компактный режим и масштаб шрифта
(() => {
  "use strict";

  const invoke = window.__TAURI__?.core?.invoke;
  const root = document.documentElement;
  const THEMES = new Set(["graphite", "midnight", "oled", "forest", "cosmos", "wine", "coffee", "steel"]);
  const THEME_COLORS = {
    graphite: "#090a0d", midnight: "#060a16", oled: "#000000", forest: "#050c09",
    cosmos: "#09061a", wine: "#0d0609", coffee: "#0c0907", steel: "#11141a",
  };
  const FONT_MIN = 85;
  const FONT_MAX = 140;

  const read = (key, fallback) => {
    try { return localStorage.getItem(key) ?? fallback; } catch (_) { return fallback; }
  };
  const write = (key, value) => {
    try { localStorage.setItem(key, value); } catch (_) {}
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
    document.getElementById("font-scale")?.addEventListener("input", (event) => {
      applyFontScale(event.currentTarget.value);
    });
    document.querySelectorAll("[data-font-preset]").forEach((button) => {
      button.addEventListener("click", () => applyFontScale(button.dataset.fontPreset));
    });
    document.querySelectorAll("[data-external-url]").forEach((button) => {
      button.addEventListener("click", async () => {
        if (button.disabled) return;
        button.disabled = true;
        try { await openExternal(button.dataset.externalUrl); }
        finally { button.disabled = false; }
      });
    });
  }

  // Настройка ширины левой панели
  const SIDEBAR_MIN = 180;
  const SIDEBAR_MAX = 380;

  function applySidebarWidth(width, save = true) {
    if (width == null) {
      root.classList.remove("sidebar-sized");
      root.style.removeProperty("--sidebar-w");
      if (save) { try { localStorage.removeItem("cgs-sidebar-width"); } catch (_) {} }
      return;
    }
    const value = Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, width)));
    root.style.setProperty("--sidebar-w", `${value}px`);
    root.classList.add("sidebar-sized");
    if (save) write("cgs-sidebar-width", String(value));
  }

  function bindSidebarResizer() {
    const handle = document.getElementById("sidebar-resizer");
    const sidebar = document.querySelector(".sidebar");
    if (!handle || !sidebar) return;
    let startX = 0;
    let startWidth = 0;
    let dragging = false;

    const move = (event) => {
      if (!dragging) return;
      applySidebarWidth(startWidth + (event.clientX - startX), false);
    };
    const stop = (event) => {
      if (!dragging) return;
      dragging = false;
      root.classList.remove("sidebar-resizing");
      try { handle.releasePointerCapture(event.pointerId); } catch (_) {}
      applySidebarWidth(sidebar.getBoundingClientRect().width, true);
    };

    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      dragging = true;
      startX = event.clientX;
      startWidth = sidebar.getBoundingClientRect().width;
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

  bind();
  bindSidebarResizer();
  const savedSidebar = parseInt(read("cgs-sidebar-width", ""), 10);
  if (savedSidebar >= SIDEBAR_MIN && savedSidebar <= SIDEBAR_MAX) applySidebarWidth(savedSidebar, false);
  applyTheme(read("cgs-theme", "graphite"));
  applyCompact(read("cgs-compact", "1") === "1");
  applyFontScale(read("cgs-font-scale", "120"));

  window.cgsAppearance = { applyTheme, applyCompact, applyFontScale, applySidebarWidth };
})();
