(() => {
  "use strict";

  // layout — расположение рейки и строки поиска: настройки или перетаскивание
  const root = document.documentElement;
  const SIDEBAR_KEY = "cgs-sidebar-dock";
  const SEARCH_KEY = "cgs-search-dock";
  const SEARCH_WIDTH_KEY = "cgs-search-width";
  const SIDEBAR_DOCKS = ["left", "right", "top", "bottom"];
  const SEARCH_DOCKS = ["left", "center", "right"];
  const SEARCH_WIDTHS = ["compact", "normal", "wide"];
  const LABELS = { left: "Слева", right: "Справа", top: "Сверху", bottom: "Снизу", center: "По центру" };
  // Сдвиг указателя, после которого нажатие считается перетаскиванием, а не щелчком
  const DRAG_THRESHOLD = 8;

  const $ = (selector, scope = document) => scope.querySelector(selector);
  const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];
  const read = (key, fallback) => {
    try { return window.cgsStorage.getItem(key) ?? fallback; } catch (_) { return fallback; }
  };
  const write = (key, value) => {
    try { window.cgsStorage.setItem(key, value); } catch (_) {}
  };

  // Одноразовая чистка после возврата к трём позициям: нестандартное значение
  // (край окна из старой системы) заменяется на «По центру», лишний ключ убирается
  (function cleanupSearchStorage() {
    const stored = read(SEARCH_KEY, null);
    if (stored === null || !SEARCH_DOCKS.includes(stored)) write(SEARCH_KEY, "center");
    try { window.cgsStorage.removeItem?.("cgs-search-align"); } catch (_) {}
  })();

  // Отсутствующий или неизвестный ключ даёт прежнюю раскладку: рейка слева, поиск по центру
  const sidebarDock = () => {
    const value = read(SIDEBAR_KEY, "left");
    return SIDEBAR_DOCKS.includes(value) ? value : "left";
  };
  const searchDock = () => {
    const value = read(SEARCH_KEY, "center");
    return SEARCH_DOCKS.includes(value) ? value : "center";
  };
  const searchWidth = () => {
    const value = read(SEARCH_WIDTH_KEY, "normal");
    return SEARCH_WIDTHS.includes(value) ? value : "normal";
  };
  const isHorizontal = (dock) => dock === "top" || dock === "bottom";
  // Прямое редактирование (перетаскивание рейки и строки поиска) разрешено только в режиме «На лету»
  const liveEdit = () => root.classList.contains("sidebar-live-edit");

  function syncButtons() {
    const side = sidebarDock();
    const search = searchDock();
    $$("[data-sidebar-dock]").forEach((button) => {
      const on = button.dataset.sidebarDock === side;
      button.classList.toggle("active", on);
      button.setAttribute("aria-pressed", String(on));
    });
    $$("[data-search-dock]").forEach((button) => {
      const on = button.dataset.searchDock === search;
      button.classList.toggle("active", on);
      button.setAttribute("aria-pressed", String(on));
    });
    const size = searchWidth();
    $$("[data-search-width]").forEach((button) => {
      const on = button.dataset.searchWidth === size;
      button.classList.toggle("active", on);
      button.setAttribute("aria-pressed", String(on));
    });
  }

  function setSidebarClasses(dock) {
    ["right", "top", "bottom"].forEach((side) => root.classList.toggle(`sidebar-dock-${side}`, side === dock));
    root.classList.toggle("sidebar-horizontal", isHorizontal(dock));
  }

  function setSearchClasses(dock) {
    root.classList.toggle("search-dock-left", dock === "left");
    root.classList.toggle("search-dock-right", dock === "right");
  }

  // Размер строки поиска: обычный — базовый, компактный и широкий — модификаторы
  function setSearchSizeClasses(width) {
    root.classList.toggle("search-size-compact", width === "compact");
    root.classList.toggle("search-size-wide", width === "wide");
  }

  // Плавная смена раскладки; без анимаций (или без View Transitions) — мгновенно
  function withTransition(change, animate) {
    if (!animate || root.classList.contains("no-motion") || typeof document.startViewTransition !== "function") {
      change();
      return;
    }
    root.classList.add("k-dock-transition");
    try {
      const transition = document.startViewTransition(change);
      transition.ready.catch(() => {});
      transition.finished.catch(() => {}).finally(() => root.classList.remove("k-dock-transition"));
    } catch (_) {
      root.classList.remove("k-dock-transition");
      change();
    }
  }

  function notify() {
    window.dispatchEvent(new CustomEvent("cgs:layout-changed", { detail: { sidebar: sidebarDock(), search: searchDock() } }));
  }

  function applySidebarDock(dock, { save = true, animate = false, before } = {}) {
    const value = SIDEBAR_DOCKS.includes(dock) ? dock : "left";
    if (save) write(SIDEBAR_KEY, value);
    withTransition(() => {
      before?.();
      setSidebarClasses(value);
      syncButtons();
      fitRail();
      updateRailSize();
    }, animate);
    notify();
  }

  function applySearchDock(dock, { save = true, animate = false, before } = {}) {
    const value = SEARCH_DOCKS.includes(dock) ? dock : "center";
    if (save) write(SEARCH_KEY, value);
    withTransition(() => {
      before?.();
      setSearchClasses(value);
      syncButtons();
    }, animate);
    notify();
  }

  function applySearchWidth(width, { save = true } = {}) {
    const value = SEARCH_WIDTHS.includes(width) ? width : "normal";
    if (save) write(SEARCH_WIDTH_KEY, value);
    setSearchSizeClasses(value);
    syncButtons();
    notify();
  }

  // Высота горизонтальной рейки нужна уведомлениям, чтобы не наезжать на неё
  function updateRailSize() {
    const sidebar = $(".sidebar");
    if (sidebar) root.style.setProperty("--k-dock-h", `${Math.round(sidebar.getBoundingClientRect().height)}px`);
  }

  // Узкая горизонтальная рейка уплотняется, затем скрывает подписи и включает прокрутку
  function fitRail() {
    const nav = $(".sidebar .navigation");
    // Во время перестановки пунктов сдвинутые элементы расширяют прокрутку — не пересчитываем
    if (!nav || document.body.classList.contains("sidebar-dragging-active")) return;
    nav.classList.remove("fit-tight", "fit-icons");
    if (!root.classList.contains("sidebar-horizontal") || root.classList.contains("sidebar-icons")) return;
    const overflows = () => nav.scrollWidth > nav.clientWidth + 1;
    if (!overflows()) return;
    nav.classList.add("fit-tight");
    if (overflows()) nav.classList.add("fit-icons");
  }
  let fitFrame = 0;
  const scheduleFit = () => {
    if (fitFrame) return;
    fitFrame = requestAnimationFrame(() => { fitFrame = 0; fitRail(); });
  };

  // Ближайший к указателю край окна (расстояния нормированы на размер окна)
  function railZoneAt(x, y) {
    const width = Math.max(1, window.innerWidth);
    const top = 52;
    const height = Math.max(1, window.innerHeight - top);
    const distances = {
      left: x / width,
      right: (width - x) / width,
      top: (y - top) / height,
      bottom: (window.innerHeight - y) / height,
    };
    return Object.keys(distances).reduce((best, side) => (distances[side] < distances[best] ? side : best), "left");
  }

  function showRailZones(current) {
    const layer = document.createElement("div");
    layer.className = "k-dock-zones";
    layer.setAttribute("aria-hidden", "true");
    SIDEBAR_DOCKS.forEach((side) => {
      const zone = document.createElement("div");
      zone.className = "k-dock-zone";
      zone.dataset.zone = side;
      zone.classList.toggle("current", side === current);
      const label = document.createElement("span");
      label.textContent = LABELS[side];
      zone.append(label);
      layer.append(zone);
    });
    document.body.append(layer);
    return layer;
  }

  function hideLayer(layer) {
    if (!layer) return;
    layer.classList.add("closing");
    setTimeout(() => layer.remove(), 170);
  }

  // Перетаскивание рейки за свободное место (не за пункт и не за ручку ширины)
  function bindRailDrag() {
    const sidebar = $(".sidebar");
    if (!sidebar) return;
    const nav = $(".navigation", sidebar);

    // Подсказка о перетаскивании показывается только в режиме редактирования «На лету»
    const RAIL_HINT = "В режиме «На лету»: перетащите за свободное место, чтобы переместить панель";
    const syncRailHint = () => {
      if (!nav) return;
      if (liveEdit()) nav.setAttribute("title", RAIL_HINT);
      else nav.removeAttribute("title");
    };
    syncRailHint();
    new MutationObserver(syncRailHint).observe(root, {
      attributes: true,
      attributeFilter: ["class"],
    });

    sidebar.addEventListener("pointerdown", (event) => {
      // Рейку можно переставлять только в режиме редактирования «На лету»
      if (event.button !== 0 || !liveEdit() || event.target.closest(".nav-item, .sidebar-resizer, button, a, input, select, textarea")) return;
      const startX = event.clientX;
      const startY = event.clientY;
      const current = sidebarDock();
      let target = current;
      let dragging = false;
      let layer = null;

      const cleanup = () => {
        root.classList.remove("k-rail-dragging");
        sidebar.style.removeProperty("--k-drag-x");
        sidebar.style.removeProperty("--k-drag-y");
      };
      const move = (ev) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (!dragging) {
          if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
          dragging = true;
          layer = showRailZones(current);
          root.classList.add("k-rail-dragging");
        }
        ev.preventDefault();
        sidebar.style.setProperty("--k-drag-x", `${dx}px`);
        sidebar.style.setProperty("--k-drag-y", `${dy}px`);
        target = railZoneAt(ev.clientX, ev.clientY);
        $$(".k-dock-zone", layer).forEach((zone) => zone.classList.toggle("target", zone.dataset.zone === target));
      };
      const finish = (commit) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", cancel);
        window.removeEventListener("keydown", key, true);
        if (!dragging) return;
        hideLayer(layer);
        if (commit && target !== current) {
          // Старый снимок перехода — рейка там, где её отпустили; новый — у выбранного края
          applySidebarDock(target, { animate: true, before: cleanup });
          return;
        }
        root.classList.add("k-rail-returning");
        cleanup();
        setTimeout(() => root.classList.remove("k-rail-returning"), 280);
      };
      const up = () => finish(true);
      const cancel = () => finish(false);
      const key = (ev) => {
        if (ev.key !== "Escape") return;
        ev.preventDefault();
        ev.stopPropagation();
        finish(false);
      };
      window.addEventListener("pointermove", move, { passive: false });
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", cancel);
      window.addEventListener("keydown", key, true);
    });

    // Колесо мыши прокручивает горизонтальную рейку, если пункты не помещаются
    nav?.addEventListener("wheel", (event) => {
      if (!root.classList.contains("sidebar-horizontal") || nav.scrollWidth <= nav.clientWidth + 1) return;
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      event.preventDefault();
      nav.scrollLeft += event.deltaY;
    }, { passive: false });

    if (typeof ResizeObserver === "function") {
      new ResizeObserver(updateRailSize).observe(sidebar);
      if (nav) new ResizeObserver(scheduleFit).observe(nav);
    }
    // Ширина пунктов меняется с режимом, масштабом шрифта, порядком и открытым разделом
    new MutationObserver(scheduleFit).observe(root, { attributes: true, attributeFilter: ["class", "style"] });
    if (nav) {
      new MutationObserver((mutations) => {
        if (mutations.some((mutation) => mutation.target !== nav)) scheduleFit();
      }).observe(nav, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
    }
    window.addEventListener("cgs:sidebar-changed", scheduleFit);
    fitRail();
    updateRailSize();
  }

  // Места строки поиска в заголовке: те же размеры, что у самой строки
  function searchSlots(titlebar, trigger) {
    const bar = titlebar.getBoundingClientRect();
    const brand = $(".titlebar-brand", titlebar)?.getBoundingClientRect();
    const actions = $(".window-actions", titlebar)?.getBoundingClientRect();
    const width = trigger.offsetWidth;
    const gap = parseFloat(getComputedStyle(titlebar).columnGap) || 16;
    const left = (brand ? brand.right - bar.left : 0) + gap + 8;
    const right = (actions ? actions.left - bar.left : bar.width) - gap - 2 - width;
    return {
      left: Math.max(0, left),
      center: (bar.width - width) / 2,
      right: Math.max(0, right),
    };
  }

  function bindSearchDrag() {
    const titlebar = $(".titlebar");
    const trigger = $("#titlebar-search");
    if (!titlebar || !trigger) return;
    let suppressClick = false;

    // После перетаскивания щелчок не должен открывать палитру поиска
    titlebar.addEventListener("click", (event) => {
      if (!suppressClick || !event.target.closest("#titlebar-search")) return;
      event.preventDefault();
      event.stopPropagation();
      suppressClick = false;
    }, true);

    trigger.addEventListener("pointerdown", (event) => {
      // Строку поиска можно переставлять только в режиме редактирования «На лету»
      if (event.button !== 0 || !liveEdit()) return;
      const startX = event.clientX;
      const current = searchDock();
      let target = current;
      let dragging = false;
      let ghost = null;
      let positions = null;
      let origin = 0;

      const cleanup = () => {
        root.classList.remove("k-search-dragging");
        trigger.style.removeProperty("--k-drag-x");
      };
      // В пересекающихся зонах показываем только фактическое место отпускания строки поиска
      const showGhost = (side) => {
        ghost.dataset.zone = side;
        ghost.style.left = `${Math.round(positions[side])}px`;
        ghost.textContent = LABELS[side];
      };
      const move = (ev) => {
        const dx = ev.clientX - startX;
        if (!dragging) {
          if (Math.abs(dx) < DRAG_THRESHOLD) return;
          dragging = true;
          positions = searchSlots(titlebar, trigger);
          origin = trigger.getBoundingClientRect().left - titlebar.getBoundingClientRect().left;
          ghost = document.createElement("div");
          ghost.className = "k-search-slot";
          ghost.setAttribute("aria-hidden", "true");
          ghost.style.width = `${trigger.offsetWidth}px`;
          showGhost(current);
          titlebar.append(ghost);
          root.classList.add("k-search-dragging");
        }
        ev.preventDefault();
        trigger.style.setProperty("--k-drag-x", `${dx}px`);
        const center = origin + dx + trigger.offsetWidth / 2;
        target = SEARCH_DOCKS.reduce((best, side) => {
          const distance = Math.abs(positions[side] + trigger.offsetWidth / 2 - center);
          const bestDistance = Math.abs(positions[best] + trigger.offsetWidth / 2 - center);
          return distance < bestDistance ? side : best;
        }, current);
        if (ghost.dataset.zone !== target) showGhost(target);
        ghost.classList.toggle("target", target !== current);
      };
      const finish = (commit) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", cancel);
        window.removeEventListener("keydown", key, true);
        if (!dragging) return;
        suppressClick = true;
        setTimeout(() => { suppressClick = false; }, 0);
        ghost?.remove();
        if (commit && target !== current) {
          applySearchDock(target, { animate: true, before: cleanup });
          return;
        }
        root.classList.add("k-search-returning");
        cleanup();
        setTimeout(() => root.classList.remove("k-search-returning"), 260);
      };
      const up = () => finish(true);
      const cancel = () => finish(false);
      const key = (ev) => {
        if (ev.key !== "Escape") return;
        ev.preventDefault();
        ev.stopPropagation();
        finish(false);
      };
      window.addEventListener("pointermove", move, { passive: false });
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", cancel);
      window.addEventListener("keydown", key, true);
    });
  }

  function bindSettings() {
    $$("[data-sidebar-dock]").forEach((button) => {
      button.addEventListener("click", () => {
        if (button.dataset.sidebarDock !== sidebarDock()) applySidebarDock(button.dataset.sidebarDock, { animate: true });
      });
    });
    $$("[data-search-dock]").forEach((button) => {
      button.addEventListener("click", () => {
        if (button.dataset.searchDock !== searchDock()) applySearchDock(button.dataset.searchDock, { animate: true });
      });
    });
    $$("[data-search-width]").forEach((button) => {
      button.addEventListener("click", () => {
        if (button.dataset.searchWidth !== searchWidth()) applySearchWidth(button.dataset.searchWidth);
      });
    });
  }

  // bootstrap.js уже расставил классы до первой отрисовки; здесь — то же из сохранённых значений
  setSidebarClasses(sidebarDock());
  setSearchClasses(searchDock());
  setSearchSizeClasses(searchWidth());
  syncButtons();
  bindSettings();
  bindRailDrag();
  bindSearchDrag();

  window.cgsLayout = {
    sidebarDock,
    searchDock,
    searchWidth,
    applySidebarDock,
    applySearchDock,
    applySearchWidth,
  };
})();
