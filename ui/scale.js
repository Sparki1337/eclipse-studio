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
    for (const rule of rules) {
      if (rule.type === CSSRule.STYLE_RULE) {
        if (rule.selectorText && rule.selectorText.includes("[data-scale-skip]")) continue;
        rewriteStyle(rule.style);
      } else if (rule.cssRules && rule.type !== CSSRule.KEYFRAMES_RULE) {
        walk(rule.cssRules);
      }
    }
  }

  // Пропуск внешних таблиц стилей
  for (const sheet of document.styleSheets) {
    try { walk(sheet.cssRules); } catch (_) {}
  }
  document.documentElement.classList.add("scale-ready");
})();
