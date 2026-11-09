(() => {
  "use strict";

  // gradient — положение фоновой подсветки (ключ cgs-background-gradient)
  const KEY = "cgs-background-gradient";
  const defaults = () => ({ mode: "theme", points: [{ x: 15, y: 0 }, { x: 85, y: 100 }] });
  const coordinate = (value, fallback) => typeof value === "number" && Number.isFinite(value)
    ? Math.round(Math.max(0, Math.min(100, value)) * 10) / 10 : fallback;
  function normalize(value) {
    const result = defaults();
    if (typeof value === "string") {
      if (value.length > 2048) return result;
      try { value = JSON.parse(value); } catch (_) { return result; }
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return result;
    if (!["theme", "one", "two"].includes(value.mode)) return result;
    result.mode = value.mode;
    result.points = result.points.map((point, index) => ({
      x: coordinate(value.points?.[index]?.x, point.x),
      y: coordinate(value.points?.[index]?.y, point.y)
    }));
    return result;
  }
  function apply(value) {
    const config = normalize(value);
    const root = document.documentElement;
    root.dataset.gradientMode = config.mode;
    config.points.forEach((point, index) => {
      root.style.setProperty(`--gradient-x${index + 1}`, `${point.x}%`);
      root.style.setProperty(`--gradient-y${index + 1}`, `${point.y}%`);
    });
    return config;
  }
  window.cgsGradient = { KEY, defaults, normalize, apply };
  apply(window.cgsStorage?.getItem(KEY));
})();
