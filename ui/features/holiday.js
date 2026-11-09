(() => {
  "use strict";

  // holiday — новогодние украшения: гирлянда-бейдж, сцена на главной и снег
  const root = document.documentElement;
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  // Русская строка — источник для словаря i18n (английский подставляется словарём EN)
  const SEASON_LABEL = "Зимний сезон";

  // Сезон по календарю: в январе — текущий год, в остальные месяцы — следующий
  function seasonYear() {
    const now = new Date();
    return now.getMonth() === 0 ? now.getFullYear() : now.getFullYear() + 1;
  }

  // Гирлянда-бейдж: компактная праздничная плашка в заголовке окна
  function mountBadge() {
    const actions = document.querySelector(".window-actions");
    const host = actions || document.querySelector(".titlebar-brand") || document.querySelector(".page-topbar");
    if (!host) return;
    const badge = document.createElement("div");
    badge.className = "holiday-season";
    // Статичная SVG-разметка: мини-гирлянда с тремя лампочками и искрой
    badge.innerHTML = '<span class="holiday-season-icon" aria-hidden="true"><svg viewBox="0 0 40 26">' +
      '<path class="holiday-wire" d="M3 5Q20 22 37 5"/>' +
      '<path class="holiday-wire" d="M9 9v4M20 14v4M31 9v4"/>' +
      '<ellipse class="holiday-bulb" cx="9" cy="16" rx="2.4" ry="3.2"/>' +
      '<ellipse class="holiday-bulb" cx="20" cy="21" rx="2.6" ry="3.4"/>' +
      '<ellipse class="holiday-bulb" cx="31" cy="16" rx="2.4" ry="3.2"/>' +
      '<path class="holiday-spark" d="M35 3v4M33 5h4"/>' +
      "</svg></span>";
    const label = document.createElement("span");
    label.className = "holiday-season-label";
    label.textContent = SEASON_LABEL;
    const year = document.createElement("span");
    year.className = "holiday-season-year";
    year.textContent = String(seasonYear());
    badge.append(label, year);
    // В основной раскладке плашка висит слева от кнопок окна, не сдвигая заголовок
    if (actions) {
      badge.classList.add("holiday-season-docked");
      actions.prepend(badge);
    } else {
      badge.classList.add("holiday-season-inline");
      host.append(badge);
    }
  }

  // Праздничная сцена внутри приветственного блока главной
  function mountScene() {
    const hero = document.querySelector(".home-hero");
    if (!hero) return;
    const scene = document.createElement("div");
    scene.className = "holiday-hero-scene";
    scene.setAttribute("aria-hidden", "true");
    // Статичная SVG-разметка: мягкое свечение, ёлочные шары, звезда и искры
    scene.innerHTML = `<div class="holiday-hero-bokeh"></div>
    <svg class="holiday-ornaments" viewBox="0 0 280 240" aria-hidden="true"><defs><radialGradient id="holiday-gold" cx="32%" cy="26%"><stop stop-color="#f7e7c2"/><stop offset=".55" stop-color="#c3a465"/><stop offset="1" stop-color="#6b5634"/></radialGradient><radialGradient id="holiday-accent" cx="32%" cy="26%"><stop stop-color="#e8fff8"/><stop offset=".5" style="stop-color:var(--accent)"/><stop offset="1" stop-color="#1b4a40"/></radialGradient><radialGradient id="holiday-berry" cx="32%" cy="26%"><stop stop-color="#ffd3d6"/><stop offset=".55" stop-color="#c05a63"/><stop offset="1" stop-color="#5e2229"/></radialGradient></defs><g class="holiday-ornament holiday-ornament-one"><path class="holiday-string" d="M46 0V72"/><rect class="holiday-cap" x="41" y="70" width="10" height="7" rx="2"/><circle cx="46" cy="100" r="23" fill="url(#holiday-gold)"/><path class="holiday-ball-detail" d="M27 91Q46 106 65 91M26 101Q46 116 66 101"/></g><g class="holiday-ornament holiday-ornament-two"><path class="holiday-string" d="M138 0V112"/><rect class="holiday-cap" x="133" y="110" width="10" height="7" rx="2"/><circle cx="138" cy="144" r="30" fill="url(#holiday-accent)"/><path class="holiday-ball-detail" d="M138 128v32M124 144h28M128 134l20 20M148 134l-20 20"/></g><g class="holiday-ornament holiday-ornament-three"><path class="holiday-string" d="M216 0V40"/><rect class="holiday-cap" x="211" y="38" width="10" height="7" rx="2"/><circle cx="216" cy="61" r="16" fill="url(#holiday-berry)"/><path class="holiday-ball-detail" d="M208 55Q216 62 224 55"/></g><g class="holiday-star"><path d="M252 22v24m-12-12h24m-20-9 17 17m0-17-17 17"/></g></svg>
    <svg class="holiday-glint holiday-glint-a" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 0v12M0 6h12"/></svg>
    <svg class="holiday-glint holiday-glint-b" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 0v12M0 6h12"/></svg>
    <svg class="holiday-glint holiday-glint-c" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 0v12M0 6h12"/></svg>
    <svg class="holiday-glint holiday-glint-d" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 0v12M0 6h12"/></svg>`;
    hero.append(scene);
  }

  // Снег на фиксированном canvas: кристаллические снежинки вместо белых точек
  function mountSnow() {
    const canvas = document.createElement("canvas");
    canvas.className = "holiday-snow";
    canvas.setAttribute("aria-hidden", "true");
    document.body.append(canvas);
    const context = canvas.getContext("2d");
    if (!context) return;

    const SPRITE_SIZE = 72;
    const SPRITE_RATIO = 2;
    let flakes = [];
    let sprites = [];
    let glowSprite = null;
    let spriteInk = "";
    let frame = 0;
    let previous = 0;
    let width = 1;
    let height = 1;
    let ink = "#dcecf7";

    // Полупрозрачный цвет из hex нужен для мягкого свечения вокруг снежинок
    function tint(hex, alpha) {
      const value = parseInt(hex.slice(1), 16);
      return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
    }

    function line(g, x1, y1, x2, y2) {
      g.beginPath();
      g.moveTo(x1, y1);
      g.lineTo(x2, y2);
      g.stroke();
    }

    // Две формы снежинок: дендрит с веточками и папоротник с густыми веточками
    function drawVariant(g, variant) {
      const arms = 6;
      if (variant === 0) {
        for (let i = 0; i < arms; i += 1) {
          const angle = (i * Math.PI) / 3;
          const cos = Math.cos(angle);
          const sin = Math.sin(angle);
          line(g, 0, 0, cos * 25, sin * 25);
          for (const t of [0.36, 0.56, 0.74]) {
            const px = cos * 25 * t;
            const py = sin * 25 * t;
            const length = 25 * (0.34 - t * 0.24);
            for (const side of [-1, 1]) {
              const branch = angle + side * (Math.PI / 3);
              line(g, px, py, px + Math.cos(branch) * length, py + Math.sin(branch) * length);
            }
          }
        }
        g.beginPath();
        g.arc(0, 0, 3.2, 0, Math.PI * 2);
        g.stroke();
        return;
      }
      if (variant === 1) {
        for (let i = 0; i < arms; i += 1) {
          const angle = (i * Math.PI) / 3;
          const cos = Math.cos(angle);
          const sin = Math.sin(angle);
          line(g, 0, 0, cos * 26, sin * 26);
          [0.3, 0.48, 0.64, 0.78].forEach((t, index) => {
            const px = cos * 26 * t;
            const py = sin * 26 * t;
            const length = 7.5 - index * 1.6;
            for (const side of [-1, 1]) {
              const branch = angle + side * (Math.PI / 3);
              line(g, px, py, px + Math.cos(branch) * length, py + Math.sin(branch) * length);
            }
          });
        }
        return;
      }
    }

    // Снежинка рисуется один раз в отдельный canvas и потом масштабируется при выводе
    function createSprite(variant) {
      const sprite = document.createElement("canvas");
      sprite.width = SPRITE_SIZE * SPRITE_RATIO;
      sprite.height = SPRITE_SIZE * SPRITE_RATIO;
      const g = sprite.getContext("2d");
      g.scale(SPRITE_RATIO, SPRITE_RATIO);
      g.translate(SPRITE_SIZE / 2, SPRITE_SIZE / 2);
      g.strokeStyle = ink;
      g.fillStyle = ink;
      g.lineWidth = 1.7;
      g.lineCap = "round";
      g.lineJoin = "round";
      g.globalAlpha = 0.92;
      g.shadowColor = ink;
      g.shadowBlur = 2.5;
      drawVariant(g, variant);
      return sprite;
    }

    function createGlow() {
      const glow = document.createElement("canvas");
      glow.width = SPRITE_SIZE * SPRITE_RATIO;
      glow.height = SPRITE_SIZE * SPRITE_RATIO;
      const g = glow.getContext("2d");
      g.scale(SPRITE_RATIO, SPRITE_RATIO);
      const gradient = g.createRadialGradient(SPRITE_SIZE / 2, SPRITE_SIZE / 2, 0, SPRITE_SIZE / 2, SPRITE_SIZE / 2, SPRITE_SIZE / 2);
      gradient.addColorStop(0, tint(ink, 0.5));
      gradient.addColorStop(0.45, tint(ink, 0.16));
      gradient.addColorStop(1, tint(ink, 0));
      g.fillStyle = gradient;
      g.fillRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);
      return glow;
    }

    function buildSprites() {
      if (spriteInk === ink && sprites.length) return;
      spriteInk = ink;
      sprites = [0, 1].map(createSprite);
      glowSprite = createGlow();
    }

    // Три плана: дальние мелкие и тусклые, ближние крупные, яркие и вращающиеся
    function createFlakes(count) {
      return Array.from({ length: count }, () => {
        const depth = Math.random();
        return {
          x: Math.random(),
          y: Math.random(),
          size: 11 + depth * 19,
          speed: 9 + depth * 27,
          drift: 6 + Math.random() * 16,
          phase: Math.random() * Math.PI * 2,
          twinkle: Math.random() * Math.PI * 2,
          rotation: Math.random() * Math.PI * 2,
          spin: (Math.random() - 0.5) * (0.1 + depth * 0.8),
          alpha: 0.3 + depth * 0.48,
          variant: Math.random() < 0.5 ? 0 : 1,
          glow: depth > 0.7,
        };
      });
    }

    function countFor(value) {
      return Math.round(Math.min(88, Math.max(36, value / 18)));
    }

    // Снег рисуется только при включённом оформлении и без ограничений доступности
    function enabled() {
      return root.dataset.holiday === "on"
        && !root.classList.contains("no-motion")
        && root.dataset.contrast !== "high"
        && !reducedMotion?.matches
        && !document.hidden;
    }

    function resize() {
      width = canvas.clientWidth || 1;
      height = canvas.clientHeight || 1;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      // В светлой теме снежинки темнее, иначе они теряются на светлом фоне
      ink = root.dataset.theme === "light" ? "#5b7a88" : "#dcecf7";
      buildSprites();
      const count = countFor(width);
      if (count !== flakes.length) flakes = createFlakes(count);
    }

    function draw(time) {
      frame = 0;
      if (!enabled()) return;
      frame = requestAnimationFrame(draw);
      const seconds = time / 1000;
      const delta = previous ? Math.min((time - previous) / 1000, 0.05) : 0;
      previous = time;
      context.clearRect(0, 0, width, height);
      for (const flake of flakes) {
        flake.y = (flake.y + flake.speed * delta / height) % 1;
        flake.rotation += flake.spin * delta;
        const x = flake.x * width + Math.sin(seconds * 0.7 + flake.phase) * flake.drift;
        const y = flake.y * height;
        const shimmer = 0.82 + 0.18 * Math.sin(seconds * 1.3 + flake.twinkle);
        const alpha = Math.min(1, flake.alpha * shimmer);
        const size = flake.size;
        // Мягкое свечение у ближних снежинок добавляет глубины
        if (flake.glow) {
          context.globalAlpha = alpha * 0.16;
          context.drawImage(glowSprite, x - size * 1.4, y - size * 1.4, size * 2.8, size * 2.8);
        }
        context.globalAlpha = alpha;
        context.save();
        context.translate(x, y);
        context.rotate(flake.rotation);
        context.drawImage(sprites[flake.variant], -size / 2, -size / 2, size, size);
        context.restore();
      }
    }

    function sync() {
      cancelAnimationFrame(frame);
      frame = 0;
      previous = 0;
      resize();
      context.clearRect(0, 0, width, height);
      if (enabled()) frame = requestAnimationFrame(draw);
    }

    // Перерисовываем только при изменении значимых настроек, а не на каждый класс
    let lastState = null;
    function state() {
      return [
        root.dataset.holiday,
        root.dataset.contrast,
        root.dataset.theme,
        root.classList.contains("no-motion"),
        reducedMotion?.matches,
        document.hidden,
      ].join("|");
    }
    function syncIfChanged() {
      const next = state();
      if (next === lastState) return;
      lastState = next;
      sync();
    }

    new MutationObserver(syncIfChanged).observe(root, {
      attributes: true,
      attributeFilter: ["data-holiday", "data-contrast", "data-theme", "class"],
    });
    window.addEventListener("resize", sync);
    document.addEventListener("visibilitychange", syncIfChanged);
    reducedMotion?.addEventListener("change", syncIfChanged);
    sync();
  }

  mountBadge();
  mountScene();
  mountSnow();
})();
