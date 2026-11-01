// Модуль заставки запуска с настройкой скорости и моментальным стартом без задержек
(() => {
  "use strict";

  const STORAGE_KEY = "cgs-splash";
  const SPEED_STORAGE_KEY = "cgs-splash-speed";
  const BASE_DURATION = 3200;
  const MIN_SPEED = 0.5;
  const MAX_SPEED = 3.0;
  const DEFAULT_SPEED = 1.0;
  const root = document.documentElement;

  // Вспомогательные математические функции для анимации
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const ss = (a, b, v) => {
    v = clamp((v - a) / (b - a));
    return v * v * (3 - 2 * v);
  };
  const eo = (t) => 1 - Math.pow(1 - t, 3);
  const pc = (p) => Math.floor(p * 100 + 1e-6);

  function prog(t) {
    if (t >= 1) return 1;
    if (t <= 0) return 0;
    return 1 - Math.pow(1 - t, 1.35);
  }

  function sz() {
    return Math.min(
      250,
      Math.max(
        Math.min(window.innerWidth, window.innerHeight) * 0.40,
        Math.min(window.innerWidth * 0.56, window.innerHeight * 0.30)
      )
    );
  }

  // Получение актуального RGB-цвета акцента темы
  function getThemeAccentRgb() {
    try {
      const raw = getComputedStyle(root).getPropertyValue("--accent-rgb").trim();
      if (raw) {
        const parts = raw.split(",").map((s) => parseInt(s.trim(), 10));
        if (parts.length === 3 && parts.every((n) => !isNaN(n))) {
          return parts;
        }
      }
    } catch (_) {}
    return [99, 245, 194];
  }

  function fitCanvas(c, w, h) {
    const r = window.devicePixelRatio || 1;
    c.width = Math.round(w * r);
    c.height = Math.round(h * r);
    const ctx = c.getContext("2d");
    ctx.setTransform(r, 0, 0, r, 0, 0);
    return ctx;
  }

  // Проверка включения заставки пользователем
  function isEnabled() {
    try {
      if (root.classList.contains("no-motion")) return false;
      const stored = window.cgsStorage.getItem(STORAGE_KEY);
      if (stored === "0") return false;
      return true;
    } catch (_) {
      return true;
    }
  }

  // Чтение сохранённой скорости заставки
  function getSpeed() {
    try {
      const stored = window.cgsStorage.getItem(SPEED_STORAGE_KEY);
      if (stored !== null) {
        const val = parseFloat(stored);
        if (!isNaN(val) && val >= MIN_SPEED && val <= MAX_SPEED) {
          return Math.round(val * 4) / 4;
        }
      }
    } catch (_) {}
    return DEFAULT_SPEED;
  }

  // Обновление состояния строки настройки скорости в зависимости от активности заставки
  function updateSpeedRowState(enabled) {
    const row = document.getElementById("pref-row-splash-speed");
    if (row) {
      row.classList.toggle("disabled", !enabled);
    }
  }

  // Сохранение и визуальное обновление скорости заставки
  function setSpeed(speed, save = true) {
    const clamped = Math.round(clamp(speed, MIN_SPEED, MAX_SPEED) * 4) / 4;
    const speedInput = document.getElementById("splash-speed");
    const speedVal = document.getElementById("splash-speed-value");

    if (speedInput) {
      speedInput.value = clamped;
      const fillPct = ((clamped - MIN_SPEED) / (MAX_SPEED - MIN_SPEED)) * 100;
      speedInput.style.setProperty("--fill", `${fillPct}%`);
    }

    if (speedVal) {
      speedVal.textContent = `${clamped.toFixed(1)}x`;
    }

    if (save) {
      try {
        window.cgsStorage.setItem(SPEED_STORAGE_KEY, String(clamped));
      } catch (_) {}
    }
    return clamped;
  }

  // Включение/выключение заставки
  function setEnabled(on, save = true) {
    root.classList.toggle("no-splash", !on);
    const input = document.getElementById("splash-mode");
    if (input) input.checked = on;
    updateSpeedRowState(on);
    if (save) {
      try {
        window.cgsStorage.setItem(STORAGE_KEY, on ? "1" : "0");
      } catch (_) {}
    }
  }

  // Картинка логотипа для сборки частиц (используем уже созданную в head или новую)
  const logoImg = window.__splashLogo || new Image();
  if (!logoImg.src) {
    logoImg.src = "./assets/images/icon-loader.png";
  }

  let logoReadyPromise = null;
  function ensureLogoReady() {
    if (!logoReadyPromise) {
      logoReadyPromise = new Promise((resolve) => {
        if (logoImg.complete && logoImg.naturalWidth > 0) {
          resolve(logoImg);
        } else if (typeof logoImg.decode === "function") {
          logoImg.decode().then(() => resolve(logoImg)).catch(() => {
            logoImg.onload = () => resolve(logoImg);
            logoImg.onerror = () => resolve(logoImg);
          });
        } else {
          logoImg.onload = () => resolve(logoImg);
          logoImg.onerror = () => resolve(logoImg);
        }
      });
    }
    return logoReadyPromise;
  }
  ensureLogoReady();

  // Кэш карты точек логотипа для исключения повторного сканирования пикселей
  let cachedPixelMap = null;
  let cachedKey = "";

  let activeRaf = null;
  let activeDismissTimer = null;
  let isRunning = false;

  // Мгновенное отображение окна операционной системы, когда заставка уже готова и нарисована
  let windowRevealed = false;
  function revealWindow() {
    if (windowRevealed) return;
    windowRevealed = true;
    try {
      if (window.__TAURI__?.core?.invoke) {
        window.__TAURI__.core.invoke("show_window").catch(() => {});
      }
    } catch (_) {}
  }

  // Завершение заставки и уведомление приложения о готовности
  function dismiss(splash, instant = false) {
    if (!splash || splash.classList.contains("splash-dismissed")) return;
    splash.classList.add("splash-dismissed");
    isRunning = false;

    if (activeRaf) {
      cancelAnimationFrame(activeRaf);
      activeRaf = null;
    }

    const shell = document.querySelector(".app-shell");

    // Оповещаем другие модули об окончании заставки для мягкого старта фоновых задач
    try {
      window.dispatchEvent(new CustomEvent("splash-finished"));
    } catch (_) {}

    revealWindow();

    if (instant) {
      splash.classList.add("hidden");
      if (shell) {
        shell.classList.remove("shell-entering");
        shell.classList.add("shell-ready");
      }
      return;
    }

    splash.classList.add("splash-dismissing");
    if (shell) {
      shell.classList.add("shell-entering");
      setTimeout(() => {
        shell.classList.remove("shell-entering");
        shell.classList.add("shell-ready");
      }, 450);
    }

    clearTimeout(activeDismissTimer);
    activeDismissTimer = setTimeout(() => {
      splash.classList.add("hidden");
      splash.classList.remove("splash-dismissing", "done");
    }, 480);
  }

  // Отрисовка начального свечения до готовности пикселей логотипа (полный уход от черного экрана)
  function drawInitialGlow(ctx, W, H, accentRgb) {
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);
    const rad = Math.min(W, H) * 0.42;
    const grad = ctx.createRadialGradient(W / 2, H / 2, 4, W / 2, H / 2, rad);
    const [ar, ag, ab] = accentRgb;
    grad.addColorStop(0, `rgba(${ar},${ag},${ab},0.28)`);
    grad.addColorStop(0.5, `rgba(${ar},${ag},${ab},0.08)`);
    grad.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
  }

  // Основная функция запуска анимации заставки
  async function runSplash(options = {}) {
    const splash = document.getElementById("app-splash");
    if (!splash) return;

    const force = Boolean(options.force);
    if (!force && (!isEnabled() || root.classList.contains("no-splash"))) {
      dismiss(splash, true);
      revealWindow();
      return;
    }

    if (activeRaf) {
      cancelAnimationFrame(activeRaf);
      activeRaf = null;
    }
    clearTimeout(activeDismissTimer);

    isRunning = true;
    splash.classList.remove("hidden", "splash-dismissed", "splash-dismissing", "done");

    const box = splash.querySelector(".s4-box");
    const canvas = splash.querySelector("canvas");
    const letters = [...splash.querySelectorAll(".s4-name span")];
    const percentEl = document.getElementById("splash-percent") || splash.querySelector("[data-pct]");

    if (!box || !canvas) {
      dismiss(splash, true);
      return;
    }

    // Подготавливаем холст немедленно и рисуем мягкое акцентное свечение
    const r = box.getBoundingClientRect();
    const W = r.width || 480;
    const H = r.height || 300;
    let x = fitCanvas(canvas, W, H);
    const accentRgb = getThemeAccentRgb();
    drawInitialGlow(x, W, H, accentRgb);

    // Воспроизведение звука запуска Eclipse Studio
    try {
      window.cgsAudio?.playStartup();
    } catch (_) {}

    canvas.style.opacity = "1";
    canvas.style.transition = "";
    letters.forEach((l) => l.classList.remove("on"));
    if (percentEl) percentEl.textContent = "0%";

    // Пропуск заставки по клику
    splash.onclick = (e) => {
      // Игнорируем клики по элементам управления, если заставка открыта для предпросмотра
      if (e.target.closest("button") || e.target.closest("input")) return;
      dismiss(splash);
    };

    // Ожидаем готовности картинки (при наличии preload она уже в кэше)
    await ensureLogoReady();
    if (!isRunning) return;

    const AR = (logoImg.naturalWidth && logoImg.naturalHeight)
      ? (logoImg.naturalWidth / logoImg.naturalHeight)
      : 1;

    let P = [], L = sz();
    const lw = Math.round(L), lh = Math.round(L / AR);
    const st = Math.max(3, Math.round(L / 70));
    const [ar, ag, ab] = accentRgb;
    const isLight = root.dataset.theme === "light";
    const currentKey = `${lw}x${lh}_${st}_${ar},${ag},${ab}_${isLight ? "l" : "d"}`;

    // Быстрое извлечение или переиспользование структуры частиц
    if (cachedPixelMap && cachedKey === currentKey) {
      P = cachedPixelMap.map((pt) => {
        const a = Math.random() * 6.283;
        const R = Math.max(W, H) * (0.45 + Math.random() * 0.6);
        return {
          tx: pt.tx,
          ty: pt.ty,
          sx: W / 2 + Math.cos(a) * R,
          sy: H / 2 + Math.sin(a) * R,
          th: pt.th,
          c: pt.c,
          ph: Math.random() * 6.28
        };
      });
      P.st = st;
    } else {
      const oc = document.createElement("canvas");
      oc.width = lw;
      oc.height = lh;
      const oc2 = oc.getContext("2d", { willReadFrequently: true });
      oc2.drawImage(logoImg, 0, 0, lw, lh);
      const d = oc2.getImageData(0, 0, lw, lh).data;
      const ox = (W - lw) / 2, oy = (H - lh) / 2;
      const newCache = [];
      P = [];

      for (let yy = 0; yy < lh; yy += st) {
        for (let xx = 0; xx < lw; xx += st) {
          const idx = (yy * lw + xx) * 4;
          if (d[idx + 3] > 120) {
            const origR = d[idx];
            const origG = d[idx + 1];
            const origB = d[idx + 2];
            const lum = (0.299 * origR + 0.587 * origG + 0.114 * origB) / 255;

            let pr, pg, pb;
            if (isLight) {
              const darkAccentR = Math.min(135, Math.max(14, Math.round(ar * 0.52)));
              const darkAccentG = Math.min(135, Math.max(18, Math.round(ag * 0.52)));
              const darkAccentB = Math.min(135, Math.max(28, Math.round(ab * 0.52)));
              pr = Math.round(14 + (darkAccentR - 14) * lum);
              pg = Math.round(18 + (darkAccentG - 18) * lum);
              pb = Math.round(30 + (darkAccentB - 30) * lum);
            } else {
              if (lum > 0.65) {
                const t = (lum - 0.65) / 0.35;
                pr = Math.min(255, Math.round(ar + (255 - ar) * t * 0.85));
                pg = Math.min(255, Math.round(ag + (255 - ag) * t * 0.85));
                pb = Math.min(255, Math.round(ab + (255 - ab) * t * 0.85));
              } else {
                const t = lum / 0.65;
                pr = Math.min(255, Math.round(ar * (0.22 + 0.78 * t)));
                pg = Math.min(255, Math.round(ag * (0.22 + 0.78 * t)));
                pb = Math.min(255, Math.round(ab * (0.22 + 0.78 * t)));
              }
            }

            const th = Math.random() * 0.7 + ((yy / lh) * 0.12);
            const colorStr = `rgb(${pr},${pg},${pb})`;
            const tx = ox + xx;
            const ty = oy + yy;

            newCache.push({ tx, ty, th, c: colorStr });

            const a = Math.random() * 6.283;
            const R = Math.max(W, H) * (0.45 + Math.random() * 0.6);
            P.push({
              tx,
              ty,
              sx: W / 2 + Math.cos(a) * R,
              sy: H / 2 + Math.sin(a) * R,
              th,
              c: colorStr,
              ph: Math.random() * 6.28
            });
          }
        }
      }
      P.st = st;
      cachedPixelMap = newCache;
      cachedKey = currentKey;
    }

    // Отрисовка кадра частиц и букв логотипа
    function update(p, now, done) {
      x.clearRect(0, 0, W, H);
      const stSize = P.st;
      const lightTheme = root.dataset.theme === "light";
      for (let i = 0; i < P.length; i++) {
        const q = P[i];
        const k = done ? 1 : eo(clamp((p - q.th) / 0.25));
        const wob = done ? 0 : (1 - k) * 14;
        const px = done ? q.tx : q.sx + (q.tx - q.sx) * k + Math.cos(now * 0.002 + q.ph) * wob;
        const py = done ? q.ty : q.sy + (q.ty - q.sy) * k + Math.sin(now * 0.0017 + q.ph) * wob;
        x.globalAlpha = done ? 1 : (lightTheme ? 0.35 + 0.65 * k : 0.15 + 0.85 * k);
        x.fillStyle = q.c;
        const z = done ? stSize - 0.5 : (k < 1 ? stSize * 0.7 : stSize - 0.5);
        x.fillRect(px, py, z, z);
      }
      x.globalAlpha = 1;

      const n = done ? letters.length : Math.round(ss(0.1, 0.95, p) * letters.length);
      for (let j = 0; j < letters.length; j++) {
        letters[j].classList.toggle("on", j < n);
      }

      if (percentEl) {
        percentEl.textContent = pc(p) + "%";
      }
    }

    let doneFlag = false;
    // Расчет длительности с учетом пользовательской скорости заставки
    const currentSpeed = getSpeed();
    const duration = options.duration || Math.round(BASE_DURATION / currentSpeed);
    const startTime = performance.now();

    update(0, startTime, false);
    // Как только первый кадр заставки готов, немедленно открываем окно приложения без пустого синего экрана
    requestAnimationFrame(() => {
      revealWindow();
    });

    function frame(now) {
      if (!isRunning) return;
      const t = (now - startTime) / duration;
      const p = prog(t);

      if (t >= 1 && !doneFlag) {
        doneFlag = true;
        splash.classList.add("done");
        update(1, now, true);

        // Завершение с задержкой, масштабируемой относительно скорости
        const exitDelay = Math.max(250, Math.round(520 / currentSpeed));
        setTimeout(() => {
          dismiss(splash);
        }, exitDelay);
        return;
      }

      update(p, now, doneFlag);

      if (t < 1) {
        activeRaf = requestAnimationFrame(frame);
      }
    }

    activeRaf = requestAnimationFrame(frame);
  }

  // Привязка управляющих элементов в панели Настроек
  function bindSettings() {
    const splashCheckbox = document.getElementById("splash-mode");
    if (splashCheckbox) {
      splashCheckbox.checked = isEnabled();
      splashCheckbox.addEventListener("change", (e) => {
        e.stopPropagation();
        setEnabled(e.target.checked);
      });
      splashCheckbox.addEventListener("click", (e) => {
        e.stopPropagation();
      });
    }

    // Инициализация ползунка скорости заставки
    const speedInput = document.getElementById("splash-speed");
    const initialSpeed = getSpeed();
    setSpeed(initialSpeed, false);
    updateSpeedRowState(isEnabled());

    if (speedInput) {
      speedInput.addEventListener("input", (e) => {
        const val = parseFloat(e.target.value);
        setSpeed(val, true);
      });
    }

    // Кнопка сброса скорости к стандартной (1.0x)
    const resetSpeedBtn = document.getElementById("splash-speed-reset");
    if (resetSpeedBtn) {
      resetSpeedBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        setSpeed(DEFAULT_SPEED, true);
      });
    }

    // Кнопка предпросмотра заставки
    const replayBtn = document.getElementById("replay-splash-button");
    if (replayBtn) {
      replayBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const currentSpeed = getSpeed();
        const duration = Math.round(BASE_DURATION / currentSpeed);
        runSplash({ force: true, duration });
      });
    }
  }

  // Мгновенный запуск заставки: так как скрипт подключен сразу после aside, запускаем немедленно!
  runSplash();

  // Привязку настроек делаем по DOMContentLoaded, когда секция настроек построена
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindSettings);
  } else {
    bindSettings();
  }

  window.cgsSplash = { runSplash, isEnabled, setEnabled, getSpeed, setSpeed, revealWindow };
})();
