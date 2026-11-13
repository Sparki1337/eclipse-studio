// ── Исправленные названия каталога кряков
// Каталог приходит из внешнего Gist, поэтому устаревшие названия заменяем
// у себя и не зависим от правки источника.
(() => {
  "use strict";

  // Ключ — название без регистра и знаков пунктуации
  const CANONICAL_NAMES = new Map([
    ["call of duty 4 modern warfare", "Call of Duty Modern Warfare 4"],
  ]);

  function canonicalGameName(name) {
    const cleaned = String(name || "")
      .replace(/[\uFFFD]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!cleaned) return "";
    const key = cleaned
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
    return CANONICAL_NAMES.get(key) || cleaned;
  }

  window.cgsCanonicalGameName = canonicalGameName;
})();
