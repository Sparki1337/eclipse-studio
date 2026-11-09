(() => {
  "use strict";

  // motion — анимации интерфейса: вход, списки, аккордеоны, выключение
  const root = document.documentElement;
  const STORAGE_KEY = "cgs-motion";
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  const EASING = "cubic-bezier(0.22, 1, 0.36, 1)";
  const LIST_SELECTORS = [
    "#files-grid", "#files-featured-grid", "#dlc-game-list", "#dlc-list", "#dlc-catalog",
    "#save-list", "#lua-games", "#hv-game-list", "#ac-list", "#lua-search-results",
    "#lua-detail-in", "#lua-detail-missing", ".vbs-components-list", "#files-pages",
    "#home-recent-games", "#home-recent-backups", "#home-pending-jobs", "#home-attention",
  ];
  const ENTRY_SELECTORS = [
    ".premium-panel:not(.settings-card):not(.files-catalog)", ".metric-card",
    ".settings-segmented-tabs", ".hv-module-tabs", ".settings-collapsible", ".files-toolbar",
    "#files-featured", "#files-grid", "#files-empty", "#files-loading", "#files-pagination", ".home-footer",
  ].join(",");
  const SELECTION_SELECTORS = [
    ".nav-item", "[data-hv-tab]", ".settings-tab-btn", ".files-view-btn", ".svc-option",
    ".dlc-method", ".sidebar-mode-btn", "[data-sidebar-dock]", "[data-search-dock]", ".loader-option",
  ].join(",");
  const animations = new Map();
  const classRuns = new Map();
  const pendingReveals = new Map();
  const signatures = new WeakMap();
  const enabled = () => !root.classList.contains("no-motion");
  let requested = true;
  let currentView = null;
  let recolorTimer;

  function readSetting() {
    try { return window.cgsStorage.getItem(STORAGE_KEY) !== "0"; }
    catch (_) { return true; }
  }

  function forget(record) {
    const channels = animations.get(record.element);
    if (channels?.get(record.channel) !== record) return;
    channels.delete(record.channel);
    if (!channels.size) animations.delete(record.element);
  }

  function stop(record, settle = false) {
    record.animation.onfinish = null;
    record.animation.oncancel = null;
    forget(record);
    record.animation.cancel();
    if (settle) record.complete?.();
  }

  function animate(element, keyframes, options = {}, channel = "enter", complete) {
    if (!element || !enabled() || !element.animate) return null;
    const previous = animations.get(element)?.get(channel);
    if (previous) stop(previous);
    const animation = element.animate(keyframes, { duration: 300, easing: EASING, fill: "backwards", ...options });
    animation.id = `cgs-${channel}`;
    const record = { element, channel, animation, complete };
    if (!animations.has(element)) animations.set(element, new Map());
    animations.get(element).set(channel, record);
    animation.onfinish = () => { forget(record); complete?.(); };
    animation.oncancel = () => forget(record);
    return animation;
  }

  function visible(element) {
    return !!element?.getClientRects().length && !element.closest(".hidden,[hidden],.view:not(.active),[data-hv-tab-panel]:not(.active)") && getComputedStyle(element).visibility !== "hidden";
  }

  function enteringParent(element) {
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (animations.get(parent)?.has("enter")) return true;
    }
    return false;
  }

  function enter(element, delay = 0, horizontal = 0) {
    if (!visible(element) || enteringParent(element)) return;
    animate(element, [
      { opacity: 0, translate: horizontal ? `${horizontal}px 0` : "0 8px" },
      { opacity: 1, translate: "0 0" },
    ], { delay, duration: 320 });
  }

  const revealObserver = typeof IntersectionObserver === "function" ? new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const options = pendingReveals.get(entry.target);
      pendingReveals.delete(entry.target);
      revealObserver.unobserve(entry.target);
      if (options && enabled()) enter(entry.target, 0, options.horizontal);
    }
  }, { threshold: 0.04 }) : null;

  function clearReveals(scope) {
    for (const element of pendingReveals.keys()) {
      if (scope && !scope.contains(element)) continue;
      revealObserver?.unobserve(element);
      pendingReveals.delete(element);
    }
  }

  function enterSequence(elements, horizontal = 0) {
    const main = document.querySelector(".main-area")?.getBoundingClientRect();
    let index = 0;
    for (const element of elements.slice(0, 60)) {
      if (!visible(element)) continue;
      const rect = element.getBoundingClientRect();
      const inFrame = rect.bottom > (main?.top || 0) && rect.top < Math.min(innerHeight, main?.bottom || innerHeight);
      if (inFrame || !revealObserver) enter(element, Math.min(index++, 6) * 26, horizontal);
      else { pendingReveals.set(element, { horizontal }); revealObserver.observe(element); }
    }
  }

  function animateSection(scope, horizontal = 0) {
    if (!scope || !enabled()) return;
    const items = [...scope.querySelectorAll(ENTRY_SELECTORS)].filter(visible);
    const candidates = new Set(items);
    enterSequence(items.filter(element => {
      for (let parent = element.parentElement; parent && parent !== scope; parent = parent.parentElement) {
        if (candidates.has(parent)) return false;
      }
      return true;
    }), horizontal);
  }

  function removeClassRun(element, className) {
    const runs = classRuns.get(element);
    clearTimeout(runs?.get(className));
    runs?.delete(className);
    if (!runs?.size) classRuns.delete(element);
    element.classList.remove(className);
    if (className === "motion-rise") element.style.removeProperty("--motion-delay");
  }

  function play(element, className, duration = 700) {
    if (!element || !enabled()) return;
    removeClassRun(element, className);
    void element.offsetWidth;
    element.classList.add(className);
    if (!classRuns.has(element)) classRuns.set(element, new Map());
    classRuns.get(element).set(className, setTimeout(() => removeClassRun(element, className), duration));
  }

  function stopWithin(scope) {
    for (const channels of [...animations.values()]) {
      for (const record of [...channels.values()]) if (scope.contains(record.element)) stop(record, true);
    }
    for (const [element, runs] of [...classRuns]) {
      if (scope.contains(element)) for (const className of [...runs.keys()]) removeClassRun(element, className);
    }
    clearReveals(scope);
  }

  function applyMotion(on, save = true) {
    requested = !!on;
    const active = requested && !reducedMotion?.matches;
    root.classList.toggle("no-motion", !active);
    const input = document.getElementById("motion-mode");
    if (input) input.checked = requested;
    if (save) { try { window.cgsStorage.setItem(STORAGE_KEY, requested ? "1" : "0"); } catch (_) {} }
    if (active) return;
    stopWithin(document.documentElement);
    clearTimeout(recolorTimer);
    root.classList.remove("motion-recolor");
    // Завершаем внешние анимации, сохраняя их обработчики
    document.getAnimations().forEach(animation => {
      if ((typeof CSSAnimation !== "undefined" && animation instanceof CSSAnimation) || (typeof CSSTransition !== "undefined" && animation instanceof CSSTransition)) return;
      try { animation.finish(); } catch (_) { animation.cancel(); }
    });
  }

  function animateView(view) {
    if (!view || !enabled()) return;
    play(document.getElementById("page-title"), "motion-title", 470);
    play(document.getElementById("page-eyebrow"), "motion-title", 370);
    animateSection(view);
  }

  window.addEventListener("cgs:view-changed", event => {
    const view = document.querySelector(`[data-view-panel="${event.detail}"]`);
    if (!view || view === currentView) return;
    if (currentView) stopWithin(currentView);
    currentView = view;
    requestAnimationFrame(() => { if (view === currentView) animateView(view); });
  });

  function animateTab(panel) {
    const view = panel?.closest(".view.active");
    if (!view) return;
    stopWithin(view);
    requestAnimationFrame(() => { if (visible(panel)) animateSection(panel, 8); });
  }

  document.addEventListener("cgs:hv-tab-changed", event => animateTab(document.querySelector(`[data-hv-tab-panel="${event.detail}"]`)));
  document.addEventListener("cgs:settings-tab-changed", event => animateTab(document.querySelector(`[data-tab-panel="${event.detail}"]`)));

  const visibilityObserver = new MutationObserver(records => {
    if (!enabled()) return;
    const revealed = new Set();
    for (const record of records) {
      const element = record.target;
      if (record.attributeName === "class") {
        const before = new Set((record.oldValue || "").split(/\s+/));
        if (before.has("hidden") && !element.classList.contains("hidden")) revealed.add(element);
        const selected = ["active", "selected"].some(name => !before.has(name) && element.classList.contains(name));
        if (selected && element.matches(SELECTION_SELECTORS) && visible(element)) {
          const icon = element.querySelector("svg") || element;
          animate(icon, [{ opacity: 0.55, translate: "0 2px" }, { opacity: 1, translate: "0 0" }], { duration: 220 }, "select");
        }
        if (element.classList.contains("files-catalog") && before.has("view-list") !== element.classList.contains("view-list")) {
          requestAnimationFrame(() => enterSequence([...document.querySelectorAll("#files-grid > *,#files-featured-grid > *")].filter(visible)));
        }
      } else if (record.oldValue !== null && !element.hidden) revealed.add(element);
    }
    for (const element of revealed) {
      if (!visible(element) || element.matches(".settings-tab-panel,.modal-backdrop,.nav-context-menu")) continue;
      if (element.closest(".toast-stack,.modal-backdrop,.nav-context-menu,.k-search") || enteringParent(element)) continue;
      enter(element);
    }
  });

  const itemKey = child => (child.querySelector("h3,strong,b")?.textContent || child.textContent || "").replace(/\d+(?:[.,]\d+)?\s*%/g, "").trim().slice(0, 48);
  const signature = container => [...container.children].map(itemKey).join("|");

  function watchList(container) {
    signatures.set(container, signature(container));
    new MutationObserver(() => {
      const next = signature(container);
      const previous = signatures.get(container);
      if (next === previous) return;
      signatures.set(container, next);
      if (!enabled() || !visible(container) || enteringParent(container)) return;
      const previousItems = new Set((previous || "").split("|"));
      let index = 0;
      [...container.children].slice(0, 60).forEach(child => {
        if (previous && previousItems.has(itemKey(child))) return;
        const delay = Math.min(index++, 8) * 20;
        play(child, "motion-rise", 560 + delay);
        child.style.setProperty("--motion-delay", `${delay}ms`);
      });
    }).observe(container, { childList: true });
  }

  function watchValue(element) {
    let previous = element.textContent.trim();
    let changedAt = 0;
    new MutationObserver(() => {
      const value = element.textContent.trim();
      if (value === previous) return;
      previous = value;
      const now = performance.now();
      if (!value || !enabled() || !visible(element) || enteringParent(element) || now - changedAt < 350) return;
      changedAt = now;
      animate(element, [{ opacity: 0.45, translate: "0 3px" }, { opacity: 1, translate: "0 0" }], { duration: 240 }, "value");
    }).observe(element, { childList: true, characterData: true, subtree: true });
  }

  function softRecolor() {
    if (!enabled()) return;
    root.classList.add("motion-recolor");
    clearTimeout(recolorTimer);
    recolorTimer = setTimeout(() => root.classList.remove("motion-recolor"), 450);
  }

  function setupDetailsAccordion(details) {
    const summary = details.querySelector(":scope > summary");
    if (!summary) return;
    const state = { targetOpen: details.open, running: false, overflow: details.style.overflow };
    details.addEventListener("toggle", () => {
      if (!state.running) state.targetOpen = details.open;
      details.classList.toggle("is-open", details.open);
    });
    summary.addEventListener("click", event => {
      if (!enabled() || event.defaultPrevented || event.target.closest("a,button,input,select,textarea")) return;
      event.preventDefault();
      const target = !(state.running ? state.targetOpen : details.open);
      const start = details.getBoundingClientRect().height;
      const previous = animations.get(details)?.get("accordion");
      if (previous) stop(previous);
      if (!state.running) state.overflow = details.style.overflow;
      // Высоты обоих состояний меряем синхронно, до отрисовки
      details.open = target;
      const end = details.getBoundingClientRect().height;
      details.open = true;
      details.style.overflow = "hidden";
      state.targetOpen = target;
      state.running = true;
      animate(details, [{ height: `${start}px` }, { height: `${end}px` }], { duration: target ? 260 : 200 }, "accordion", () => {
        state.running = false;
        details.open = target;
        details.classList.toggle("is-open", target);
        details.style.overflow = state.overflow;
      });
    });
  }

  function dismiss(element, complete) {
    if (!element || !enabled() || !visible(element)) { complete(); return; }
    animate(element, [{ opacity: getComputedStyle(element).opacity }, { opacity: 0 }], { duration: 140 }, "exit", complete);
  }

  function init() {
    applyMotion(readSetting(), false);
    reducedMotion?.addEventListener("change", () => applyMotion(requested, false));
    document.getElementById("motion-mode")?.addEventListener("change", event => applyMotion(event.currentTarget.checked));
    document.querySelectorAll("[data-theme-option],.accent").forEach(button => button.addEventListener("click", softRecolor, true));
    document.querySelectorAll("details").forEach(setupDetailsAccordion);
    visibilityObserver.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["class", "hidden"], attributeOldValue: true });
    LIST_SELECTORS.forEach(selector => document.querySelectorAll(selector).forEach(watchList));
    document.querySelectorAll(".save-stat strong,#files-total,#ac-detected-count,#ac-status,#hv-selected-state,#hv-eclipse-status,#eos-status").forEach(watchValue);
    root.classList.add("motion-ready");
    currentView = document.querySelector(".view.active");
    animateView(currentView);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
  window.cgsMotion = { play, applyMotion, animateView, dismiss, transition: animate };
})();
