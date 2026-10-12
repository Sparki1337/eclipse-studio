/*
 * Crocodile Gena Studio 5.2 — анимации интерфейса.
 *  • плавное появление разделов и их карточек (каскадом);
 *  • появление блоков, которые раньше показывались рывком (снятие .hidden);
 *  • анимация новых элементов в списках (только когда список реально изменился,
 *    фоновые обновления каждые несколько секунд не перезапускают анимацию);
 *  • мягкая смена темы и акцента;
 *  • настройка «Анимации интерфейса» и учёт системного «уменьшить движение».
 */
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
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === "0") return false;
      if (stored === "1") return true;
    } catch (_) {}
    return !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  }

  function applyMotion(on, save = true) {
    root.classList.toggle("no-motion", !on);
    const input = document.getElementById("motion-mode");
    if (input) input.checked = on;
    if (save) { try { localStorage.setItem(STORAGE_KEY, on ? "1" : "0"); } catch (_) {} }
  }

  /** Перезапускает CSS-класс анимации на элементе. */
  function play(element, className, duration = 700) {
    if (!element || !enabled()) return;
    element.classList.remove(className);
    void element.offsetWidth; // перезапуск анимации
    element.classList.add(className);
    clearTimeout(timers.get(element));
    timers.set(element, setTimeout(() => element.classList.remove(className), duration));
  }

  function staggerChildren(container, selector, step = 45, max = 12) {
    if (!container || !enabled()) return;
    const items = [...container.querySelectorAll(selector)].slice(0, 60);
    items.forEach((item, index) => {
      item.style.setProperty("--motion-delay", `${Math.min(index, max) * step}ms`);
      play(item, "motion-rise", 650 + Math.min(index, max) * step);
    });
  }

  /* ---------- Разделы ---------- */
  function animateView(view) {
    if (!view) return;
    play(document.getElementById("page-title"), "motion-title", 600);
    play(document.getElementById("page-eyebrow"), "motion-title", 600);
    const panels = view.querySelectorAll(
      ":scope > div > .premium-panel, :scope > div > section, :scope > div > div > .premium-panel, " +
      ":scope > div > div > section, .settings-layout > section, .home-grid > *, .utilities-grid > *"
    );
    const seen = new Set();
    let index = 0;
    panels.forEach((panel) => {
      if (seen.has(panel) || panel.classList.contains("hidden") || panel.offsetParent === null) return;
      seen.add(panel);
      panel.style.setProperty("--motion-delay", `${Math.min(index, 10) * 40}ms`);
      play(panel, "motion-rise", 700 + Math.min(index, 10) * 40);
      index += 1;
    });
  }

  window.addEventListener("cgs:view-changed", (event) => {
    const view = document.querySelector(`[data-view-panel="${event.detail}"]`);
    requestAnimationFrame(() => animateView(view));
  });

  /* ---------- Вкладки внутри гипервизора ---------- */
  document.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-hv-tab]");
    if (!tab) return;
    requestAnimationFrame(() => {
      const panel = document.querySelector(`[data-hv-tab-panel="${tab.dataset.hvTab}"]`);
      play(panel, "motion-fade", 500);
      staggerChildren(panel, ":scope > div > section, :scope > section", 40, 8);
    });
  });

  /* ---------- Появление скрытых блоков ---------- */
  const visibilityObserver = new MutationObserver((records) => {
    if (!enabled()) return;
    for (const record of records) {
      const element = record.target;
      const before = record.oldValue || "";
      if (!/(^|\s)hidden(\s|$)/.test(before) || element.classList.contains("hidden")) continue;
      if (element.closest(".toast-stack")) continue;
      if (element.classList.contains("modal-backdrop")) continue; // у модалок своя анимация
      play(element, "motion-appear", 450);
    }
  });

  /* ---------- Списки ---------- */
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
        if (previousItems.has(key) && previous) return; // уже был на экране
        child.style.setProperty("--motion-delay", `${Math.min(index, 12) * 35}ms`);
        play(child, "motion-rise", 650 + Math.min(index, 12) * 35);
        index += 1;
      });
    }).observe(container, { childList: true });
  }

  /* ---------- Тема и акцент ---------- */
  function softRecolor() {
    if (!enabled()) return;
    root.classList.add("motion-recolor");
    clearTimeout(timers.get(root));
    timers.set(root, setTimeout(() => root.classList.remove("motion-recolor"), 450));
  }

  /* ---------- Раскрывающиеся блоки <details> ---------- */
  document.addEventListener("toggle", (event) => {
    const details = event.target;
    if (!(details instanceof HTMLDetailsElement) || !details.open) return;
    [...details.children].filter((child) => child.tagName !== "SUMMARY").forEach((child) => play(child, "motion-appear", 450));
  }, true);

  function init() {
    applyMotion(readSetting(), false);
    document.getElementById("motion-mode")?.addEventListener("change", (event) => applyMotion(event.currentTarget.checked));
    document.querySelectorAll("[data-theme-option], .accent").forEach((button) => button.addEventListener("click", softRecolor, true));

    visibilityObserver.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["class"], attributeOldValue: true });
    LIST_SELECTORS.forEach((selector) => document.querySelectorAll(selector).forEach(watchList));

    root.classList.add("motion-ready");
    animateView(document.querySelector(".view.active"));
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  window.cgsMotion = { play, applyMotion, animateView };
})();
