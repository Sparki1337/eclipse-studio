// Палитра акцентов: единый источник для заставки, app.js и appearance.js.
// В светлой теме яркие акценты (белый, мятный, жёлтый, лаймовый…) почти не видны на белом фоне,
// поэтому для неё используется затемнённый оттенок того же цвета с контрастом не ниже 4.5:1.
// Белый акцент в светлой теме становится графитовым. --accent-contrast — цвет текста на заливке акцентом.
(function () {
  var ACCENTS = {
    white:  ["#ffffff", "#1e293b"],
    red:    ["#ff5252", "#dc2626"],
    orange: ["#ff8c42", "#c2410c"],
    amber:  ["#ffc83b", "#b45309"],
    gold:   ["#e5c158", "#a16207"],
    lime:   ["#b4f043", "#4d7c0f"],
    mint:   ["#52ebb5", "#047857"],
    cyan:   ["#38d9f5", "#0e7490"],
    blue:   ["#4d9fff", "#2563eb"],
    violet: ["#a77bfe", "#7c3aed"],
    pink:   ["#f768b7", "#db2777"],
    rose:   ["#ff6987", "#e11d48"]
  };
  function normalize(name) {
    if (name === "ice") name = "white";
    return Object.prototype.hasOwnProperty.call(ACCENTS, name) ? name : "mint";
  }
  function rgb(hex) {
    var n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255].join(", ");
  }
  function resolve(name, theme) {
    var key = normalize(name);
    var light = theme === "light";
    var color = ACCENTS[key][light ? 1 : 0];
    return { name: key, color: color, rgb: rgb(color), contrast: light ? "#ffffff" : "#07110e", light: light };
  }
  function apply(name, theme) {
    var root = document.documentElement;
    var value = resolve(name || root.dataset.accent, theme || root.dataset.theme);
    root.style.setProperty("--accent", value.color);
    root.style.setProperty("--accent-rgb", value.rgb);
    root.style.setProperty("--accent-2", value.color);
    root.style.setProperty("--accent-contrast", value.contrast);
    root.dataset.accent = value.name;
    // Образцы в настройках показывают цвет, который реально получит интерфейс в текущей теме
    var swatches = document.querySelectorAll(".accent[data-accent]");
    for (var i = 0; i < swatches.length; i++) {
      var key = normalize(swatches[i].dataset.accent);
      swatches[i].style.setProperty("--swatch", ACCENTS[key][value.light ? 1 : 0]);
    }
    return value;
  }
  window.cgsAccent = { names: Object.keys(ACCENTS), normalize: normalize, resolve: resolve, apply: apply };
})();

(function () {
      try {
        var root = document.documentElement;
        var theme = window.cgsStorage.getItem("cgs-theme") || "graphite";
        root.dataset.theme = theme;
        var themeBgMap = {
          graphite: "#090a0d",
          midnight: "#060a16",
          oled: "#000000",
          light: "#f8fafc",
          forest: "#050c09",
          cosmos: "#09061a",
          wine: "#0d0609",
          coffee: "#0c0907",
          steel: "#11141a"
        };
        var bg = themeBgMap[theme] || "#090a0d";
        root.style.setProperty("--theme-bg", bg);
        root.style.backgroundColor = bg;
        var meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.setAttribute("content", bg);
        if (window.cgsStorage.getItem("cgs-compact") === "1") root.classList.add("compact");
        var motion = window.cgsStorage.getItem("cgs-motion");
        if (motion === "0" || (motion === null && window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches)) root.classList.add("no-motion");
        var fontFamily = window.cgsStorage.getItem("cgs-font-family") || "system";
        var FONTS = {
          system: '"Segoe UI Variable", "Segoe UI", system-ui, sans-serif',
          jetbrains: '"JetBrains Mono", "Cascadia Code", Consolas, monospace',
          minecraft: '"Minecraft", "Minecraftia", "Monocraft", monospace',
          bahnschrift: 'Bahnschrift, "Segoe UI", system-ui, sans-serif',
          verdana: 'Verdana, "Segoe UI", sans-serif',
          tahoma: 'Tahoma, "Segoe UI", sans-serif',
          consolas: 'Consolas, "Cascadia Mono", monospace'
        };
        root.style.setProperty("--font", FONTS[fontFamily] || FONTS.system);
        var font = parseInt(window.cgsStorage.getItem("cgs-font-scale") || "120", 10);
        if (font >= 85 && font <= 140) root.style.setProperty("--fs", String(font / 100));
        var side = parseInt(window.cgsStorage.getItem("cgs-sidebar-width") || "", 10);
        if (side >= 180 && side <= 380) { root.style.setProperty("--sidebar-w", side + "px"); root.classList.add("sidebar-sized"); }
        if (window.cgsStorage.getItem("cgs-splash") === "0") root.classList.add("no-splash");
        window.cgsAccent.apply(window.cgsStorage.getItem("accent") || "mint", theme);
        // Мгновенная предварительная загрузка логотипа заставки для исключения черного экрана
        window.__splashLogo = new Image();
        window.__splashLogo.src = "./assets/images/icon-loader.png";
      } catch (_) {}
    })();
