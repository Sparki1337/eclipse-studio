// Заставка запуска
(() => {
  "use strict";

  const STORAGE_KEY = "cgs-splash";
  const DURATION = 3200;
  const root = document.documentElement;

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

  function isEnabled() {
    try {
      if (root.classList.contains("no-motion")) return false;
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === "0") return false;
      return true;
    } catch (_) {
      return true;
    }
  }

  function setEnabled(on, save = true) {
    root.classList.toggle("no-splash", !on);
    const input = document.getElementById("splash-mode");
    if (input) input.checked = on;
    if (save) {
      try {
        localStorage.setItem(STORAGE_KEY, on ? "1" : "0");
      } catch (_) {}
    }
  }

  const logoImg = new Image();
  logoImg.src = "./icon-loader.png";

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

  let activeRaf = null;
  let activeDismissTimer = null;
  let isRunning = false;

  function dismiss(splash, instant = false) {
    if (!splash || splash.classList.contains("splash-dismissed")) return;
    splash.classList.add("splash-dismissed");
    isRunning = false;

    if (activeRaf) {
      cancelAnimationFrame(activeRaf);
      activeRaf = null;
    }

    const shell = document.querySelector(".app-shell");

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
      }, 500);
    }

    clearTimeout(activeDismissTimer);
    activeDismissTimer = setTimeout(() => {
      splash.classList.add("hidden");
      splash.classList.remove("splash-dismissing", "done");
    }, 500);
  }

  async function runSplash(options = {}) {
    const splash = document.getElementById("app-splash");
    if (!splash) return;

    const force = Boolean(options.force);
    if (!force && (!isEnabled() || root.classList.contains("no-splash"))) {
      dismiss(splash, true);
      return;
    }

    if (activeRaf) {
      cancelAnimationFrame(activeRaf);
      activeRaf = null;
    }
    clearTimeout(activeDismissTimer);

    isRunning = true;
    splash.classList.remove("hidden", "splash-dismissed", "splash-dismissing", "done");

    await ensureLogoReady();
    if (!isRunning) return;

    const box = splash.querySelector(".s4-box");
    const canvas = splash.querySelector("canvas");
    const letters = [...splash.querySelectorAll(".s4-name span")];
    const percentEl = document.getElementById("splash-percent") || splash.querySelector("[data-pct]");

    if (!box || !canvas) {
      dismiss(splash, true);
      return;
    }

    canvas.style.opacity = "1";
    canvas.style.transition = "";
    letters.forEach((l) => l.classList.remove("on"));
    if (percentEl) percentEl.textContent = "0%";

    const AR = (logoImg.naturalWidth && logoImg.naturalHeight)
      ? (logoImg.naturalWidth / logoImg.naturalHeight)
      : 1;

    let x, W, H, P = [], L;
    function rs() {
      const r = box.getBoundingClientRect();
      W = r.width;
      H = r.height;
      x = fitCanvas(canvas, W, H);
      L = sz();
      const lw = Math.round(L), lh = Math.round(L / AR);
      const oc = document.createElement("canvas");
      oc.width = lw;
      oc.height = lh;
      const oc2 = oc.getContext("2d", { willReadFrequently: true });
      oc2.drawImage(logoImg, 0, 0, lw, lh);
      const d = oc2.getImageData(0, 0, lw, lh).data;
      const st = Math.max(3, Math.round(L / 70));
      const [ar, ag, ab] = getThemeAccentRgb();
      const isLight = root.dataset.theme === "light";
      P = [];
      const ox = (W - lw) / 2, oy = (H - lh) / 2;
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

            const a = Math.random() * 6.283;
            const R = Math.max(W, H) * (0.45 + Math.random() * 0.6);
            P.push({
              tx: ox + xx,
              ty: oy + yy,
              sx: W / 2 + Math.cos(a) * R,
              sy: H / 2 + Math.sin(a) * R,
              th: Math.random() * 0.7 + ((yy / lh) * 0.12),
              c: `rgb(${pr},${pg},${pb})`,
              ph: Math.random() * 6.28,
            });
          }
        }
      }
      P.st = st;
    }

    rs();

    function update(p, now, done) {
      x.clearRect(0, 0, W, H);
      const st = P.st;
      const isLight = root.dataset.theme === "light";
      for (const q of P) {
        const k = done ? 1 : eo(clamp((p - q.th) / 0.25));
        const wob = done ? 0 : (1 - k) * 14;
        const px = done ? q.tx : q.sx + (q.tx - q.sx) * k + Math.cos(now * 0.002 + q.ph) * wob;
        const py = done ? q.ty : q.sy + (q.ty - q.sy) * k + Math.sin(now * 0.0017 + q.ph) * wob;
        x.globalAlpha = done ? 1 : (isLight ? 0.35 + 0.65 * k : 0.15 + 0.85 * k);
        x.fillStyle = q.c;
        const z = done ? st - 0.5 : (k < 1 ? st * 0.7 : st - 0.5);
        x.fillRect(px, py, z, z);
      }
      x.globalAlpha = 1;

      canvas.style.opacity = "1";

      const n = done ? letters.length : Math.round(ss(0.1, 0.95, p) * letters.length);
      letters.forEach((l, i) => l.classList.toggle("on", i < n));

      if (percentEl) {
        percentEl.textContent = pc(p) + "%";
      }
    }

    let doneFlag = false;
    const duration = options.duration || DURATION;
    const startTime = performance.now();

    update(0, startTime, false);

    function frame(now) {
      if (!isRunning) return;
      const t = (now - startTime) / duration;
      const p = prog(t);

      if (t >= 1 && !doneFlag) {
        doneFlag = true;
        splash.classList.add("done");
        update(1, now, true);

        setTimeout(() => {
          dismiss(splash);
        }, 600);
        return;
      }

      update(p, now, doneFlag);

      if (t < 1) {
        activeRaf = requestAnimationFrame(frame);
      }
    }

    activeRaf = requestAnimationFrame(frame);
  }

  function init() {
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

    const replayBtn = document.getElementById("replay-splash-button");
    if (replayBtn) {
      replayBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        runSplash({ force: true, duration: DURATION });
      });
    }

    runSplash();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.cgsSplash = { runSplash, isEnabled, setEnabled };
})();
