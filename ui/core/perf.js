(() => {
  "use strict";

  // perf — временные замеры производительности.
  // Включаются флагом cgs-perf=1 в хранилище или ?perf=1 в адресе.
  const STORAGE_KEY = "cgs-perf";
  let enabled = false;
  try {
    enabled = window.cgsStorage?.getItem(STORAGE_KEY) === "1"
      || new URLSearchParams(window.location.search).get("perf") === "1";
  } catch (_) {}

  const marks = new Map();
  const stats = new Map();
  const lines = [];
  let phase = "запуск";

  function setPhase(name) {
    phase = String(name || "");
  }

  function log(message) {
    if (!enabled) return;
    const line = String(message);
    lines.push(line);
    if (lines.length > 200) lines.shift();
    console.info(`[perf] ${line}`);
    // Строка уходит в файл, чтобы замеры можно было прочитать после запуска с --perf
    try {
      const pending = window.__TAURI__?.core?.invoke?.("perf_log", { line });
      pending?.catch?.(() => {});
    } catch (_) {}
  }

  function mark(name) {
    if (!enabled) return;
    marks.set(String(name), performance.now());
  }

  function measure(name, startMark) {
    if (!enabled) return null;
    const start = marks.get(String(startMark));
    if (start === undefined) return null;
    marks.delete(String(startMark));
    const value = Math.round(performance.now() - start);
    log(`${name}: ${value} мс`);
    return value;
  }

  function record(command, value) {
    if (!enabled) return;
    const entry = stats.get(command) || { count: 0, total: 0, max: 0 };
    entry.count += 1;
    entry.total += value;
    entry.max = Math.max(entry.max, value);
    stats.set(command, entry);
  }

  window.cgsPerf = {
    get enabled() { return enabled; },
    setEnabled(value) { enabled = Boolean(value); },
    setPhase,
    mark,
    measure,
    record,
    log,
    lines: () => [...lines],
    report() {
      return [...stats.entries()]
        .map(([command, entry]) => ({
          command,
          count: entry.count,
          avg: Math.round(entry.total / entry.count),
          max: Math.round(entry.max),
        }))
        .sort((left, right) => right.avg - left.avg);
    },
  };

  // Долгие задачи главного потока — именно они ощущаются как фриз
  if (enabled && "PerformanceObserver" in window) {
    try {
      const observer = new PerformanceObserver((list) => {
        list.getEntries().forEach((entry) => {
          if (entry.duration >= 50) {
            log(`Долгая задача главного потока: ${Math.round(entry.duration)} мс · фаза: ${phase}`);
          }
        });
      });
      observer.observe({ entryTypes: ["longtask"] });
    } catch (_) {}
  }
})();
