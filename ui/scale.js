// Масштабирование интерфейса через CSS-переменные
(() => {
  "use strict";

  const PX = /(-?\d*\.?\d+)px/g;
  const FONT = new Set(["font-size"]);
  const SPACE = new Set([
    "padding-top", "padding-right", "padding-bottom", "padding-left",
    "margin-top", "margin-right", "margin-bottom", "margin-left",
    "row-gap", "column-gap", "padding-inline-start", "padding-inline-end",
    "padding-block-start", "padding-block-end", "margin-inline-start",
    "margin-inline-end", "margin-block-start", "margin-block-end",
  ]);
  const HEIGHT = new Set(["height", "min-height"]);

  function scaled(value, variable, minPx = 0) {
    if (!value || !value.includes("px") || value.includes("var(--" + variable)) return null;
    let changed = false;
    const next = value.replace(PX, (match, number) => {
      const amount = Math.abs(parseFloat(number));
      if (amount === 0 || amount < minPx) return match;
      changed = true;
      return `calc(${number}px * var(--${variable}, 1))`;
    });
    return changed ? next : null;
  }

  function rewriteStyle(style) {
    if (!style) return;
    const names = [];
    for (let index = 0; index < style.length; index += 1) names.push(style[index]);
    // Элементы с фиксированной шириной не масштабируем по высоте
    const fixedWidth = /px/.test(style.getPropertyValue("width"));
    for (const name of names) {
      const value = style.getPropertyValue(name);
      const priority = style.getPropertyPriority(name);
      let next = null;
      if (FONT.has(name)) next = scaled(value, "fs");
      else if (SPACE.has(name)) next = scaled(value, "sp", 3);
      else if (HEIGHT.has(name) && !fixedWidth) next = scaled(value, "hs", 28);
      if (next) style.setProperty(name, next, priority);
    }
  }

  function walk(rules) {
    if (!rules) return;
    for (const rule of rules) {
      try {
        if (rule.type === CSSRule.STYLE_RULE || rule.type === 1) {
          if (rule.selectorText && rule.selectorText.includes("[data-scale-skip]")) continue;
          rewriteStyle(rule.style);
        } else if ((rule.type === CSSRule.IMPORT_RULE || rule.type === 3) && rule.styleSheet) {
          walk(rule.styleSheet.cssRules);
        } else if (rule.styleSheet && rule.styleSheet.cssRules) {
          walk(rule.styleSheet.cssRules);
        } else if (rule.cssRules && rule.type !== CSSRule.KEYFRAMES_RULE && rule.type !== 7) {
          walk(rule.cssRules);
        }
      } catch (_) {}
    }
  }

  function runScale() {
    for (const sheet of document.styleSheets) {
      try {
        walk(sheet.cssRules);
      } catch (_) {}
    }
    document.documentElement.classList.add("scale-ready");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", runScale);
  } else {
    runScale();
  }
  window.addEventListener("load", runScale);
})();
