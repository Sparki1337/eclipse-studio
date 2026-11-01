// Анимации интерфейса
(() => {
  "use strict";

  const root = document.documentElement;
  const STORAGE_KEY = "cgs-motion";
  const LIST_SELECTORS = [
    "#files-grid", "#files-featured-grid", "#dlc-game-list", "#dlc-list", "#dlc-catalog",
    "#save-list", "#lua-games", "#hv-game-list", "#ac-list", "#lua-search-results",
    "#lua-detail-in", "#lua-detail-missing", ".vbs-components-list", "#files-pages",
  ];
  const timers = new WeakMap();

  const enabled = () => !root.classList.contains("no-motion");

  function readSetting() {
    try {
      const stored = window.cgsStorage.getItem(STORAGE_KEY);
      if (stored === "0") return false;
      if (stored === "1") return true;
    } catch (_) {}
    return !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  }

  function applyMotion(on, save = true) {
    root.classList.toggle("no-motion", !on);
    const input = document.getElementById("motion-mode");
    if (input) input.checked = on;
    if (save) { try { window.cgsStorage.setItem(STORAGE_KEY, on ? "1" : "0"); } catch (_) {} }
  }

  // Перезапуск анимации элемента
  function play(element, className, duration = 700) {
    if (!element || !enabled()) return;
    element.classList.remove(className);
    void element.offsetWidth; // Перезапуск CSS-анимации
    element.classList.add(className);
    clearTimeout(timers.get(element));
    timers.set(element, setTimeout(() => element.classList.remove(className), duration));
  }

  function staggerChildren(container, selector, step = 20, max = 8) {
    if (!container || !enabled()) return;
    const items = [...container.querySelectorAll(selector)].slice(0, 60);
    items.forEach((item, index) => {
      const delay = Math.min(index, max) * step;
      item.style.setProperty("--motion-delay", `${delay}ms`);
      play(item, "motion-rise", 560 + delay);
    });
  }

  // Анимация разделов
  function animateView(view) {
    if (!view || !enabled()) return;
    play(document.getElementById("page-title"), "motion-title", 300);
    play(document.getElementById("page-eyebrow"), "motion-title", 300);
  }

  window.addEventListener("cgs:view-changed", (event) => {
    // Снятие классов анимации с неактивных разделов
    document.querySelectorAll(".view:not(.active) .motion-rise, [data-view-panel]:not(.active) .motion-rise").forEach((el) => {
      el.classList.remove("motion-rise");
      clearTimeout(timers.get(el));
    });
    const view = document.querySelector(`[data-view-panel="${event.detail}"]`);
    requestAnimationFrame(() => animateView(view));
  });

  // Вкладки гипервизора
  document.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-hv-tab]");
    if (!tab) return;
    requestAnimationFrame(() => {
      const panel = document.querySelector(`[data-hv-tab-panel="${tab.dataset.hvTab}"]`);
      play(panel, "motion-fade", 300);
    });
  });

  // Появление скрытых блоков
  const visibilityObserver = new MutationObserver((records) => {
    if (!enabled()) return;
    for (const record of records) {
      const element = record.target;
      const before = record.oldValue || "";
      if (!/(^|\s)hidden(\s|$)/.test(before) || element.classList.contains("hidden")) continue;
      if (element.closest(".toast-stack")) continue;
      if (element.classList.contains("modal-backdrop")) continue; // У модалок отдельная анимация
      if (element.classList.contains("settings-tab-panel") || element.closest(".settings-tab-panel")) continue;
      if (element.classList.contains("nav-context-menu") || element.closest(".nav-context-menu")) continue;
      play(element, "motion-appear", 450);
    }
  });

  // Анимация списков
  const signatures = new WeakMap();
  function signature(container) {
    return [...container.children]
      .map((child) => (child.querySelector("h3,strong,b")?.textContent || child.textContent || "").replace(/\d+(?:[.,]\d+)?\s*%/g, "").trim().slice(0, 48))
      .join("|");
  }
  function watchList(container) {
    signatures.set(container, signature(container));
    new MutationObserver(() => {
      const next = signature(container);
      const previous = signatures.get(container);
      if (next === previous) return;
      const previousItems = new Set((previous || "").split("|"));
      signatures.set(container, next);
      if (!enabled()) return;
      let index = 0;
      [...container.children].forEach((child) => {
        const key = (child.querySelector("h3,strong,b")?.textContent || child.textContent || "").replace(/\d+(?:[.,]\d+)?\s*%/g, "").trim().slice(0, 48);
        if (previousItems.has(key) && previous) return; // Пропуск уже отрисованных элементов
        const delay = Math.min(index, 8) * 20;
        child.style.setProperty("--motion-delay", `${delay}ms`);
        play(child, "motion-rise", 560 + delay);
        index += 1;
      });
    }).observe(container, { childList: true });
  }

  // Плавная смена темы
  function softRecolor() {
    if (!enabled()) return;
    root.classList.add("motion-recolor");
    clearTimeout(timers.get(root));
    timers.set(root, setTimeout(() => root.classList.remove("motion-recolor"), 450));
  }

  // Плавное раскрытие details (аккордеон)
  function setupDetailsAccordion(details) {
    const summary = details.querySelector("summary");
    if (!summary || details.__accordionBound) return;
    details.__accordionBound = true;

    let anim = null;
    let isClosing = false;
    let isOpening = false;

    summary.addEventListener("click", (event) => {
      if (!enabled()) return;
      event.preventDefault();
      details.style.overflow = "hidden";

      if (isClosing || !details.open) {
        isClosing = false;
        isOpening = true;
        const startH = details.offsetHeight;
        details.open = true;
        details.classList.add("is-open");
        const endH = details.offsetHeight;
        if (anim) anim.cancel();
        anim = details.animate(
          [
            { height: `${startH}px`, opacity: 0.6 },
            { height: `${endH}px`, opacity: 1 }
          ],
          { duration: 260, easing: "cubic-bezier(0.16, 1, 0.3, 1)" }
        );
        anim.onfinish = () => {
          isOpening = false;
          details.style.height = "";
          details.style.overflow = "";
        };
      } else {
        isOpening = false;
        isClosing = true;
        const startH = details.offsetHeight;
        const endH = summary.offsetHeight;
        if (anim) anim.cancel();
        anim = details.animate(
          [
            { height: `${startH}px`, opacity: 1 },
            { height: `${endH}px`, opacity: 0.6 }
          ],
          { duration: 220, easing: "cubic-bezier(0.16, 1, 0.3, 1)" }
        );
        anim.onfinish = () => {
          isClosing = false;
          details.open = false;
          details.classList.remove("is-open");
          details.style.height = "";
          details.style.overflow = "";
        };
      }
    });
  }

  function init() {
    applyMotion(readSetting(), false);
    document.getElementById("motion-mode")?.addEventListener("change", (event) => applyMotion(event.currentTarget.checked));
    document.querySelectorAll("[data-theme-option], .accent").forEach((button) => button.addEventListener("click", softRecolor, true));
    document.querySelectorAll("details").forEach(setupDetailsAccordion);

    visibilityObserver.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["class"], attributeOldValue: true });
    LIST_SELECTORS.forEach((selector) => document.querySelectorAll(selector).forEach(watchList));

    root.classList.add("motion-ready");
    animateView(document.querySelector(".view.active"));
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  window.cgsMotion = { play, applyMotion, animateView };
})();
