(() => {
  "use strict";

  // seasons — сезонное оформление: у зимы шарики на главной, погода — на canvas
  const root = document.documentElement;
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");

  // Сезон выбирается вручную или определяется по календарю (метеорологические сезоны)
  function currentSeason() {
    const mode = root.dataset.seasonMode;
    if (mode === "winter" || mode === "spring" || mode === "summer" || mode === "autumn") return mode;
    const month = new Date().getMonth();
    if (month === 11 || month <= 1) return "winter";
    if (month <= 4) return "spring";
    if (month <= 7) return "summer";
    return "autumn";
  }

  // В авто-режиме летом оформление отключается: лето превращается в «нет сезона».
  // Выбранное вручную лето работает: летают солнечные блики
  function effectiveSeason() {
    const season = currentSeason();
    if (season === "summer" && root.dataset.seasonMode !== "summer") return "off";
    return season;
  }

  // Палитры частиц: тёмные и светлые темы используют разные оттенки
  const PALETTES = {
    winter: { dark: { snow: ["#dcecf7"] }, light: { snow: ["#5b7a88"] } },
    autumn: {
      dark: { leaf: ["#d9863f", "#c0562e", "#caa23d"], rain: ["#8fa8bd"] },
      light: { leaf: ["#a05a24", "#8f3f1d", "#8f6d1f"], rain: ["#5c7186"] },
    },
    spring: {
      dark: { petal: ["#f2c4ce", "#e8a7bb", "#f7dde3"] },
      light: { petal: ["#c98aa0", "#bb6f8c", "#d8a9b8"] },
    },
    summer: {
      dark: { mote: ["#ffd98a", "#f4c268"] },
      light: { mote: ["#b98a24", "#a3761c"] },
    },
  };

  // Множители плотности эффектов: редкая, обычная, густая
  const DENSITY_FACTORS = { low: 0.5, normal: 1, high: 1.7 };

  // Зимняя сцена: оригинальные ёлочные шары на золотых нитях (как в новогоднем модуле)
  const WINTER_SCENE = `<div class="season-bokeh"></div>
    <svg class="season-ornaments" viewBox="0 0 280 240" aria-hidden="true"><defs><radialGradient id="season-gold" cx="32%" cy="26%"><stop stop-color="#f7e7c2"/><stop offset=".55" stop-color="#c3a465"/><stop offset="1" stop-color="#6b5634"/></radialGradient><radialGradient id="season-accent" cx="32%" cy="26%"><stop stop-color="#e8fff8"/><stop offset=".5" style="stop-color:var(--accent)"/><stop offset="1" stop-color="#1b4a40"/></radialGradient><radialGradient id="season-berry" cx="32%" cy="26%"><stop stop-color="#ffd3d6"/><stop offset=".55" stop-color="#c05a63"/><stop offset="1" stop-color="#5e2229"/></radialGradient></defs><g class="season-ornament season-ornament-one"><path class="season-string" d="M46 0V72"/><rect class="season-cap" x="41" y="70" width="10" height="7" rx="2"/><circle cx="46" cy="100" r="23" fill="url(#season-gold)"/><path class="season-ball-detail" d="M27 91Q46 106 65 91M26 101Q46 116 66 101"/></g><g class="season-ornament season-ornament-two"><path class="season-string" d="M138 0V112"/><rect class="season-cap" x="133" y="110" width="10" height="7" rx="2"/><circle cx="138" cy="144" r="30" fill="url(#season-accent)"/><path class="season-ball-detail" d="M138 128v32M124 144h28M128 134l20 20M148 134l-20 20"/></g><g class="season-ornament season-ornament-three"><path class="season-string" d="M216 0V40"/><rect class="season-cap" x="211" y="38" width="10" height="7" rx="2"/><circle cx="216" cy="61" r="16" fill="url(#season-berry)"/><path class="season-ball-detail" d="M208 55Q216 62 224 55"/></g></svg>`;

  // Сцена на главной: зимой — шары, остальным сезонам — только мягкое свечение,
  // без фигур возле маскота
  function sceneTemplate(season) {
    if (season === "winter") return WINTER_SCENE;
    return `<div class="season-bokeh"></div>`;
  }

  // Погодный canvas: снег зимой, дождь с листьями осенью, лепестки весной
  function mountWeather() {
    const canvas = document.createElement("canvas");
    canvas.className = "season-weather";
    canvas.setAttribute("aria-hidden", "true");
    document.body.append(canvas);
    const context = canvas.getContext("2d");
    if (!context) return;

    const SPRITE_SIZE = 72;
    const SPRITE_RATIO = 2;
    const spriteCache = new Map();
    let particles = [];
    let frame = 0;
    let previous = 0;
    let width = 1;
    let height = 1;

    // Полупрозрачный цвет из hex нужен для мягких градиентов
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

    // Активная палитра зависит от сезона и темы
    function palette() {
      const scheme = root.dataset.theme === "light" ? "light" : "dark";
      const season = root.dataset.season || "winter";
      const tones = PALETTES[season] || PALETTES.winter;
      return tones[scheme];
    }

    function pick(list) {
      return list[Math.floor(Math.random() * list.length)];
    }

    // Две формы снежинок: дендрит с веточками и папоротник с густыми веточками
    function drawSnowflake(g, variant) {
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
    }

    // Лист: вытянутый контур, центральная жилка и пары боковых прожилок
    function drawLeaf(g, variant) {
      const scale = variant === 0 ? 1 : 0.84;
      g.beginPath();
      g.moveTo(0, -25 * scale);
      g.bezierCurveTo(16 * scale, -17 * scale, 18 * scale, 7 * scale, 0, 26 * scale);
      g.bezierCurveTo(-18 * scale, 7 * scale, -16 * scale, -17 * scale, 0, -25 * scale);
      g.closePath();
      g.globalAlpha = 0.32;
      g.fill();
      g.globalAlpha = 0.9;
      g.stroke();
      g.globalAlpha = 0.55;
      line(g, 0, -18 * scale, 0, 20 * scale);
      for (const t of [-0.5, -0.12, 0.28, 0.6]) {
        const y = t * 22 * scale;
        const length = 8 * scale * (1 - Math.abs(t) * 0.55);
        line(g, 0, y, length, y + 4 * scale);
        line(g, 0, y, -length, y + 4 * scale);
      }
      g.globalAlpha = 0.92;
    }

    // Лепесток: мягкая заливка с контуром; второй вариант чуть асимметричен
    function drawPetal(g, variant) {
      g.beginPath();
      if (variant === 0) {
        g.moveTo(0, -16);
        g.bezierCurveTo(11, -9, 10, 9, 0, 19);
        g.bezierCurveTo(-10, 9, -11, -9, 0, -16);
      } else {
        g.moveTo(0, -15);
        g.bezierCurveTo(12, -7, 10, 10, 0, 20);
        g.bezierCurveTo(-7, 9, -8, -8, 0, -15);
      }
      g.closePath();
      g.globalAlpha = 0.5;
      g.fill();
      g.globalAlpha = 0.85;
      g.stroke();
      g.globalAlpha = 0.92;
    }

    // Солнечный блик: радиальное свечение с плотной сердцевиной
    function drawMote(g, ink) {
      const gradient = g.createRadialGradient(0, 0, 0, 0, 0, 26);
      gradient.addColorStop(0, tint(ink, 0.85));
      gradient.addColorStop(0.4, tint(ink, 0.28));
      gradient.addColorStop(1, tint(ink, 0));
      g.globalAlpha = 1;
      g.shadowBlur = 0;
      g.fillStyle = gradient;
      g.beginPath();
      g.arc(0, 0, 26, 0, Math.PI * 2);
      g.fill();
      g.globalAlpha = 0.95;
      g.fillStyle = ink;
      g.beginPath();
      g.arc(0, 0, 5.5, 0, Math.PI * 2);
      g.fill();
    }

    // Частица рисуется один раз в отдельный canvas и потом масштабируется при выводе
    function createSprite(kind, variant, ink) {
      const sprite = document.createElement("canvas");
      sprite.width = SPRITE_SIZE * SPRITE_RATIO;
      sprite.height = SPRITE_SIZE * SPRITE_RATIO;
      const g = sprite.getContext("2d");
      g.scale(SPRITE_RATIO, SPRITE_RATIO);
      g.translate(SPRITE_SIZE / 2, SPRITE_SIZE / 2);
      g.strokeStyle = ink;
      g.fillStyle = ink;
      g.lineWidth = kind === "snow" ? 1.7 : 1.4;
      g.lineCap = "round";
      g.lineJoin = "round";
      g.globalAlpha = 0.92;
      g.shadowColor = ink;
      g.shadowBlur = kind === "snow" ? 2.5 : kind === "mote" ? 0 : 1.5;
      if (kind === "snow") drawSnowflake(g, variant);
      else if (kind === "leaf") drawLeaf(g, variant);
      else if (kind === "petal") drawPetal(g, variant);
      else drawMote(g, ink);
      return sprite;
    }

    // Свечение вокруг ближних снежинок
    function createGlow(ink) {
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

    function spriteFor(kind, variant, ink) {
      const key = `${kind}:${variant}:${ink}`;
      let sprite = spriteCache.get(key);
      if (!sprite) {
        sprite = createSprite(kind, variant, ink);
        spriteCache.set(key, sprite);
      }
      return sprite;
    }

    function glowFor(ink) {
      const key = `glow:${ink}`;
      let glow = spriteCache.get(key);
      if (!glow) {
        glow = createGlow(ink);
        spriteCache.set(key, glow);
      }
      return glow;
    }

    // Количество частиц масштабируется настройкой плотности эффектов
    function countFor(value, per, min, max) {
      const factor = DENSITY_FACTORS[root.dataset.seasonDensity] ?? 1;
      return Math.max(1, Math.round(Math.min(max * factor, Math.max(min * factor, (value / per) * factor))));
    }

    // Набор частиц собирается под сезон: у дождя и листьев разная плотность
    function createParticles() {
      const season = root.dataset.season || "winter";
      // В авто-режиме летом оформление отключается — частиц нет
      if (season === "off") return [];
      const pal = palette();
      const random = Math.random;
      const list = [];
      if (season === "winter") {
        // Три плана: дальние мелкие и тусклые, ближние крупные, яркие и вращающиеся
        const count = countFor(width, 18, 36, 88);
        for (let i = 0; i < count; i += 1) {
          const depth = random();
          list.push({
            kind: "snow",
            x: random(), y: random(),
            size: 11 + depth * 19,
            speed: 9 + depth * 27,
            drift: 6 + random() * 16,
            phase: random() * Math.PI * 2,
            twinkle: random() * Math.PI * 2,
            rotation: random() * Math.PI * 2,
            spin: (random() - 0.5) * (0.1 + depth * 0.8),
            alpha: 0.3 + depth * 0.48,
            variant: random() < 0.5 ? 0 : 1,
            ink: pick(pal.snow),
            glow: depth > 0.7,
          });
        }
      } else if (season === "autumn") {
        // Косой дождь порывами; листьев сопоставимо меньше, но заметно больше,
        // чем раньше — особенно в густой плотности
        const drops = countFor(width, 10, 60, 120);
        for (let i = 0; i < drops; i += 1) {
          list.push({
            kind: "rain",
            x: random(), y: random(),
            speed: 460 + random() * 320,
            length: 11 + random() * 15,
            alpha: 0.16 + random() * 0.26,
            ink: pick(pal.rain),
          });
        }
        const leaves = countFor(width, 38, 16, 32);
        for (let i = 0; i < leaves; i += 1) {
          list.push({
            kind: "leaf",
            x: random(), y: random(),
            size: 13 + random() * 12,
            speed: 32 + random() * 40,
            drift: 34 + random() * 40,
            phase: random() * Math.PI * 2,
            twinkle: random() * Math.PI * 2,
            rotation: random() * Math.PI * 2,
            spin: (random() - 0.5) * 3.2,
            alpha: 0.55 + random() * 0.35,
            variant: random() < 0.5 ? 0 : 1,
            ink: pick(pal.leaf),
          });
        }
      } else if (season === "summer") {
        // Солнечные блики медленно поднимаются и мерцают, как искры в тёплом воздухе
        const count = countFor(width, 30, 20, 46);
        for (let i = 0; i < count; i += 1) {
          list.push({
            kind: "mote",
            x: random(), y: random(),
            size: 16 + random() * 14,
            speed: 9 + random() * 15,
            drift: 12 + random() * 30,
            phase: random() * Math.PI * 2,
            twinkle: random() * Math.PI * 2,
            alpha: 0.4 + random() * 0.45,
            ink: pick(pal.mote),
          });
        }
      } else {
        // Лепестки медленно планируют и переворачиваются в полёте
        const count = countFor(width, 24, 26, 60);
        for (let i = 0; i < count; i += 1) {
          list.push({
            kind: "petal",
            x: random(), y: random(),
            size: 9 + random() * 10,
            speed: 22 + random() * 30,
            drift: 22 + random() * 34,
            phase: random() * Math.PI * 2,
            twinkle: random() * Math.PI * 2,
            rotation: random() * Math.PI * 2,
            spin: (random() - 0.5) * 2.2,
            alpha: 0.5 + random() * 0.35,
            variant: random() < 0.5 ? 0 : 1,
            ink: pick(pal.petal),
          });
        }
      }
      return list;
    }

    // Погода рисуется только при включённом оформлении и без ограничений доступности
    function enabled() {
      return root.dataset.seasonal === "on"
        && ["winter", "spring", "summer", "autumn"].includes(root.dataset.season)
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
      particles = createParticles();
    }

    function draw(time) {
      frame = 0;
      if (!enabled()) return;
      frame = requestAnimationFrame(draw);
      const seconds = time / 1000;
      const delta = previous ? Math.min((time - previous) / 1000, 0.05) : 0;
      previous = time;
      context.clearRect(0, 0, width, height);
      // Порывы ветра слегка меняют наклон дождевых штрихов
      const slant = 0.16 + 0.08 * Math.sin(seconds * 0.32);
      for (const p of particles) {
        if (p.kind === "rain") {
          p.y += (p.speed * delta) / height;
          if (p.y > 1.08) { p.y = -0.08; p.x = Math.random(); }
          const x = p.x * width;
          const y = p.y * height;
          context.globalAlpha = p.alpha;
          context.strokeStyle = p.ink;
          context.lineWidth = p.length > 20 ? 1.5 : 1.1;
          line(context, x, y, x - Math.sin(slant) * p.length, y - Math.cos(slant) * p.length);
          continue;
        }
        if (p.kind === "mote") {
          // Блики медленно поднимаются вверх и мерцают
          p.y -= (p.speed * delta) / height;
          if (p.y < -0.08) { p.y = 1.08; p.x = Math.random(); }
          const x = p.x * width + Math.sin(seconds * 0.45 + p.phase) * p.drift;
          const y = p.y * height;
          const twinkle = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(seconds * 1.4 + p.twinkle));
          context.globalAlpha = Math.min(1, p.alpha * twinkle);
          context.drawImage(spriteFor("mote", 0, p.ink), x - p.size / 2, y - p.size / 2, p.size, p.size);
          continue;
        }
        // Снежинки, листья и лепестки падают вниз
        p.y += (p.speed * delta) / height;
        if (p.y > 1.08) { p.y = -0.08; p.x = Math.random(); }
        p.rotation += p.spin * delta;
        const x = p.x * width + Math.sin(seconds * (p.kind === "snow" ? 0.7 : 0.5) + p.phase) * p.drift;
        const y = p.y * height;
        const shimmer = 0.82 + 0.18 * Math.sin(seconds * 1.3 + p.twinkle);
        const alpha = Math.min(1, p.alpha * shimmer);
        // Мягкое свечение у ближних снежинок добавляет глубины
        if (p.glow) {
          context.globalAlpha = alpha * 0.16;
          context.drawImage(glowFor(p.ink), x - p.size * 1.4, y - p.size * 1.4, p.size * 2.8, p.size * 2.8);
        }
        context.globalAlpha = alpha;
        context.save();
        context.translate(x, y);
        context.rotate(p.rotation);
        if (p.kind !== "snow") {
          // Разворот вокруг вертикальной оси: листья и лепестки переворачиваются в полёте
          context.scale(Math.max(0.25, Math.abs(Math.sin(seconds * 1.6 + p.twinkle))), 1);
        }
        context.drawImage(spriteFor(p.kind, p.variant, p.ink), -p.size / 2, -p.size / 2, p.size, p.size);
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
        root.dataset.seasonal,
        root.dataset.season,
        root.dataset.seasonDensity,
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
      attributeFilter: ["data-seasonal", "data-season", "data-season-density", "data-contrast", "data-theme", "class"],
    });
    window.addEventListener("resize", sync);
    document.addEventListener("visibilitychange", syncIfChanged);
    reducedMotion?.addEventListener("change", syncIfChanged);
    sync();
  }

  let scene = null;

  function mountScene(season) {
    const hero = document.querySelector(".home-hero");
    if (!hero) return null;
    const node = document.createElement("div");
    node.className = "season-scene";
    node.setAttribute("aria-hidden", "true");
    node.innerHTML = sceneTemplate(season);
    hero.append(node);
    return node;
  }

  // Смена сезона (режимом или календарём) обновляет атрибут и сцену;
  // canvas пересобирается наблюдателем атрибутов.
  // В авто-режиме летом оформление отключается: сцена не монтируется.
  // Вручную выбранное лето работает: блики на canvas и тёплое свечение
  function refresh() {
    const season = effectiveSeason();
    root.dataset.season = season;
    if (scene) {
      scene.remove();
      scene = null;
    }
    if (season !== "off") scene = mountScene(season);
  }

  window.cgsSeasons = { refresh };
  refresh();
  mountWeather();
  // Календарный переход сезона проверяем раз в минуту — этого достаточно
  window.setInterval(refresh, 60000);
})();
