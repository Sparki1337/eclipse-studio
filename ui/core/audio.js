// Звуковая система Eclipse Studio (Web Audio API)
// Процедурный синтез звуковых эффектов для запуска программы, кликов по кнопкам и успешных операций
(() => {
  "use strict";

  const STORAGE_KEY_ENABLED = "cgs-audio-enabled";
  const STORAGE_KEY_VOLUME = "cgs-audio-volume";
  const STORAGE_KEY_STARTUP = "cgs-audio-startup";
  const STORAGE_KEY_CLICK = "cgs-audio-click";
  const STORAGE_KEY_SUCCESS = "cgs-audio-success";
  const STORAGE_KEY_PROFILES = "cgs-audio-custom-profiles";
  const STORAGE_KEY_ACTIVE_PROFILE = "cgs-audio-active-profile";

  const DEFAULT_VOLUME = 65;
  const DEFAULT_STARTUP = "eclipse-dawn";
  const DEFAULT_CLICK = "cyber-click";
  const DEFAULT_SUCCESS = "eclipse-success";

  // Стандартные профили по умолчанию
  // Базовые звуковые профили отсутствуют по умолчанию
  const DEFAULT_PROFILES = [];

  let audioCtx = null;
  let masterGain = null;
  let lastClickTime = 0;

  // Кэш декодированных AudioBuffer для пользовательских звуков в оперативной памяти
  const customAudioBuffers = new Map();
  // Список метаданных сохранённых звуков [{ id, name, sizeBytes }]
  let customSoundsList = [];

  // Ленивая инициализация Web Audio контекста
  function getContext() {
    if (!audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return null;
      try {
        audioCtx = new AudioContextClass();
        masterGain = audioCtx.createGain();
        masterGain.connect(audioCtx.destination);
        applyVolumeGain();
      } catch (_) {
        return null;
      }
    }
    if (audioCtx.state === "suspended") {
      audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  }

  // Разблокировка аудиоконтекста по первому взаимодействию пользователя
  function ensureUnlocked() {
    const ctx = getContext();
    if (ctx && ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }
  }

  window.addEventListener("pointerdown", ensureUnlocked, { passive: true, once: true });
  window.addEventListener("keydown", ensureUnlocked, { passive: true, once: true });

  // Проверка активности звуков
  function isEnabled() {
    try {
      return window.cgsStorage.getItem(STORAGE_KEY_ENABLED) !== "0";
    } catch (_) {
      return true;
    }
  }

  function setEnabled(on, save = true) {
    if (save) {
      try {
        window.cgsStorage.setItem(STORAGE_KEY_ENABLED, on ? "1" : "0");
      } catch (_) {}
    }
    const toggle = document.getElementById("audio-master-toggle");
    if (toggle) toggle.checked = on;
    updateAudioControlsState(on);
  }

  // Получение громкости (0..100)
  function getVolumePercent() {
    try {
      const stored = window.cgsStorage.getItem(STORAGE_KEY_VOLUME);
      if (stored !== null) {
        const val = parseInt(stored, 10);
        if (!isNaN(val) && val >= 0 && val <= 100) return val;
      }
    } catch (_) {}
    return DEFAULT_VOLUME;
  }

  // Применение уровня усиления к главной мастер-ноде
  function applyVolumeGain() {
    if (!masterGain || !audioCtx) return;
    const vol = getVolumePercent() / 100;
    // Логарифмическая характеристика для естественного восприятия громкости слухом
    const gainValue = isEnabled() ? Math.pow(vol, 1.6) : 0;
    masterGain.gain.setValueAtTime(gainValue, audioCtx.currentTime);
  }

  // Установка громкости
  function setVolume(val, save = true) {
    const clamped = Math.max(0, Math.min(100, Math.round(val)));
    if (save) {
      try {
        window.cgsStorage.setItem(STORAGE_KEY_VOLUME, String(clamped));
      } catch (_) {}
    }
    const input = document.getElementById("audio-volume");
    const label = document.getElementById("audio-volume-value");
    if (input) {
      input.value = clamped;
      input.style.setProperty("--fill", `${clamped}%`);
    }
    if (label) {
      label.textContent = `${clamped}%`;
    }
    applyVolumeGain();
    return clamped;
  }

  // Чтение выбранного звука для категории
  function getSound(type) {
    try {
      if (type === "startup") return window.cgsStorage.getItem(STORAGE_KEY_STARTUP) || DEFAULT_STARTUP;
      if (type === "click") return window.cgsStorage.getItem(STORAGE_KEY_CLICK) || DEFAULT_CLICK;
      if (type === "success") return window.cgsStorage.getItem(STORAGE_KEY_SUCCESS) || DEFAULT_SUCCESS;
    } catch (_) {}
    if (type === "startup") return DEFAULT_STARTUP;
    if (type === "click") return DEFAULT_CLICK;
    return DEFAULT_SUCCESS;
  }

  // Сохранение выбранного звука
  function setSound(type, soundId, save = true) {
    if (save) {
      try {
        if (type === "startup") window.cgsStorage.setItem(STORAGE_KEY_STARTUP, soundId);
        if (type === "click") window.cgsStorage.setItem(STORAGE_KEY_CLICK, soundId);
        if (type === "success") window.cgsStorage.setItem(STORAGE_KEY_SUCCESS, soundId);
      } catch (_) {}
    }
    const select = document.getElementById(`audio-sound-${type}`);
    if (select) {
      select.value = soundId;
      if (window.cgsCustomSelect?.sync) {
        window.cgsCustomSelect.sync(select);
      }
    }
    syncProfileHighlight();
  }

  // Загрузка сохранённых звуковых профилей из хранилища (базовые отсутствуют)
  function loadProfiles() {
    try {
      const raw = window.cgsStorage.getItem(STORAGE_KEY_PROFILES);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          // Исключаем любые базовые пресеты
          const customOnly = parsed.filter((p) => {
            if (!p) return false;
            const id = String(p.id || "").toLowerCase();
            const name = String(p.name || "").toLowerCase();
            if (id.startsWith("preset")) return false;
            if (["cyber", "soft", "arcade", "scifi", "sci-fi"].includes(id)) return false;
            if (["cyber", "soft", "arcade", "sci-fi"].includes(name) && !p.custom) return false;
            return true;
          });
          if (customOnly.length !== parsed.length) {
            saveProfiles(customOnly);
          }
          return customOnly;
        }
      }
    } catch (_) {}
    return [];
  }

  // Сохранение списка профилей в хранилище
  function saveProfiles(profiles) {
    try {
      window.cgsStorage.setItem(STORAGE_KEY_PROFILES, JSON.stringify(profiles));
    } catch (_) {}
  }

  // Форматирование названия звука для подсказок
  function formatSoundTitle(soundId) {
    if (!soundId || soundId === "none") return "Без звука";
    if (typeof soundId === "string" && soundId.startsWith("custom_")) {
      const found = customSoundsList.find((s) => s.id === soundId);
      return found ? found.name : soundId.replace(/^custom_/, "");
    }
    const titles = {
      "eclipse-dawn": "Eclipse Dawn",
      "cyber-pulse": "Cyber Pulse",
      "soft-glow": "Soft Glow",
      "arcade-fanfare": "Arcade Fanfare",
      "cyber-click": "Cyber Click",
      "soft-pop": "Soft Pop",
      "mechanical-key": "Mechanical Key",
      "arcade-beep": "Arcade Beep",
      "eclipse-success": "Eclipse Success",
      "chime-win": "Chime Win",
      "scifi-ping": "Sci-Fi Ping",
      "arcade-coin": "Arcade Coin"
    };
    return titles[soundId] || soundId;
  }

  // Подсветка активного звукового профиля
  function syncProfileHighlight() {
    const curStartup = getSound("startup");
    const curClick = getSound("click");
    const curSuccess = getSound("success");
    const profiles = loadProfiles();

    let matchedId = null;
    for (const p of profiles) {
      if (p.startup === curStartup && p.click === curClick && p.success === curSuccess) {
        matchedId = p.id;
        break;
      }
    }

    const chips = document.querySelectorAll("#audio-profiles-bar .audio-profile-chip");
    chips.forEach((chip) => {
      chip.classList.toggle("active", chip.dataset.profileId === matchedId);
    });

    if (matchedId) {
      try {
        window.cgsStorage.setItem(STORAGE_KEY_ACTIVE_PROFILE, matchedId);
      } catch (_) {}
    } else {
      try {
        window.cgsStorage.removeItem(STORAGE_KEY_ACTIVE_PROFILE);
      } catch (_) {}
    }
  }

  // Применение звукового профиля
  function applyProfile(profileId, save = true) {
    const profiles = loadProfiles();
    const profile = profiles.find((p) => p.id === profileId);
    if (!profile) return;

    setSound("startup", profile.startup, save);
    setSound("click", profile.click, save);
    setSound("success", profile.success, save);

    syncProfileHighlight();

    if (save) {
      try {
        window.cgsStorage.setItem(STORAGE_KEY_ACTIVE_PROFILE, profileId);
      } catch (_) {}
    }

    const isEn = document.documentElement.lang === "en" || window.cgsStorage.getItem("cgs-language") === "en";
    if (window.cgsToast) {
      window.cgsToast(isEn ? `Applied profile "${profile.name}"` : `Применён профиль «${profile.name}»`, "success");
    }
  }

  // Создание или обновление пользовательского звукового профиля
  function createCustomProfile(name) {
    const trimmed = (name || "").trim();
    const isEn = document.documentElement.lang === "en" || window.cgsStorage.getItem("cgs-language") === "en";
    if (!trimmed) {
      if (window.cgsToast) {
        window.cgsToast(isEn ? "Enter a profile name" : "Введите название профиля", "warning");
      }
      return false;
    }

    const curStartup = getSound("startup");
    const curClick = getSound("click");
    const curSuccess = getSound("success");

    const profiles = loadProfiles();
    const existingIndex = profiles.findIndex((p) => p.name.toLowerCase() === trimmed.toLowerCase());

    let targetId;
    if (existingIndex >= 0) {
      profiles[existingIndex].startup = curStartup;
      profiles[existingIndex].click = curClick;
      profiles[existingIndex].success = curSuccess;
      targetId = profiles[existingIndex].id;
      if (window.cgsToast) {
        window.cgsToast(isEn ? `Profile "${trimmed}" updated` : `Профиль «${trimmed}» обновлён`, "success");
      }
    } else {
      targetId = "profile_" + Date.now();
      profiles.push({
        id: targetId,
        name: trimmed,
        startup: curStartup,
        click: curClick,
        success: curSuccess,
        custom: true
      });
      if (window.cgsToast) {
        window.cgsToast(isEn ? `Profile "${trimmed}" created` : `Профиль «${trimmed}» сохранён`, "success");
      }
    }

    saveProfiles(profiles);
    renderProfiles();
    applyProfile(targetId, true);
    playSuccess();
    return true;
  }

  // Удаление звукового профиля
  async function deleteProfile(profileId) {
    const profiles = loadProfiles();
    const profile = profiles.find((p) => p.id === profileId);
    if (!profile) return;

    const isEn = document.documentElement.lang === "en" || window.cgsStorage.getItem("cgs-language") === "en";
    const modal = window.cgsShowModal;
    if (modal) {
      const accepted = await modal(
        isEn ? "Delete Profile?" : "Удалить профиль?",
        isEn ? `Delete sound profile "${profile.name}"?` : `Удалить звуковой профиль «${profile.name}»?`,
        { confirm: true, confirmText: isEn ? "Delete" : "Удалить", cancelText: isEn ? "Cancel" : "Отмена", symbol: "✕" }
      );
      if (!accepted) return;
    }

    const updated = profiles.filter((p) => p.id !== profileId);
    saveProfiles(updated);
    renderProfiles();
    syncProfileHighlight();

    if (window.cgsToast) {
      window.cgsToast(isEn ? `Profile "${profile.name}" deleted` : `Профиль «${profile.name}» удалён`, "info");
    }
  }

  // Очистка звуковых профилей
  function restoreDefaultProfiles() {
    saveProfiles([]);
    renderProfiles();
    syncProfileHighlight();
  }

  // Отрисовка списка звуковых профилей в виде интерактивных чипов
  function renderProfiles() {
    const container = document.getElementById("audio-profiles-bar");
    const desc = document.getElementById("audio-profile-desc");
    if (!container) return;

    const profiles = loadProfiles();
    container.innerHTML = "";

    const isEn = document.documentElement.lang === "en" || window.cgsStorage.getItem("cgs-language") === "en";

    // Обновляем статусное описание: если профилей ещё нет — сообщаем «Создайте свой первый профиль»
    if (desc) {
      if (!profiles.length) {
        desc.textContent = isEn ? "Create your first profile" : "Создайте свой первый профиль";
      } else {
        desc.textContent = isEn ? "Create and switch sound profiles" : "Создание и переключение наборов звуков";
      }
    }

    if (!profiles.length) {
      container.style.display = "none";
      return;
    }

    container.style.display = "";

    const curStartup = getSound("startup");
    const curClick = getSound("click");
    const curSuccess = getSound("success");

    profiles.forEach((p) => {
      const chip = document.createElement("div");
      const isActive = p.startup === curStartup && p.click === curClick && p.success === curSuccess;
      chip.className = `audio-profile-chip${isActive ? " active" : ""}`;
      chip.dataset.profileId = p.id;
      chip.setAttribute("role", "button");
      chip.setAttribute("tabindex", "0");
      chip.title = `${isEn ? "Startup" : "Запуск"}: ${formatSoundTitle(p.startup)}, ${isEn ? "Click" : "Клик"}: ${formatSoundTitle(p.click)}, ${isEn ? "Success" : "Успех"}: ${formatSoundTitle(p.success)}`;

      const nameSpan = document.createElement("span");
      nameSpan.className = "audio-profile-chip-name";
      nameSpan.textContent = p.name;
      chip.appendChild(nameSpan);

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "audio-profile-chip-del";
      delBtn.title = isEn ? `Delete profile "${p.name}"` : `Удалить профиль «${p.name}»`;
      delBtn.setAttribute("aria-label", isEn ? "Delete profile" : "Удалить профиль");
      delBtn.innerHTML = `<svg viewBox="0 0 16 16"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M4 4l8 8m0-8l-8 8"/></svg>`;

      delBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteProfile(p.id);
      });

      chip.addEventListener("click", () => {
        applyProfile(p.id, true);
        playClick();
      });

      chip.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          applyProfile(p.id, true);
          playClick();
        }
      });

      chip.appendChild(delBtn);
      container.appendChild(chip);
    });
  }

  // Для обратной совместимости
  function applyPack(packId, save = true) {
    applyProfile(packId, save);
  }

  // Включение/отключение интерактивности контролов
  function updateAudioControlsState(enabled) {
    const group = document.getElementById("audio-settings-group");
    if (group) {
      group.classList.toggle("audio-disabled", !enabled);
    }
    applyVolumeGain();
  }

  // ==========================================
  // ПРОЦЕДУРНЫЙ СИНТЕЗАТОР ЗВУКОВЫХ ЭФФЕКТОВ
  // ==========================================

  // --- ЗВУКИ ЗАПУСКА ---
  function synthStartupDawn(ctx, dest) {
    const now = ctx.currentTime;
    // 1. Глубокий суб-бас
    const sub = ctx.createOscillator();
    const subGain = ctx.createGain();
    sub.type = "sine";
    sub.frequency.setValueAtTime(80, now);
    sub.frequency.exponentialRampToValueAtTime(130, now + 0.5);
    sub.frequency.exponentialRampToValueAtTime(65, now + 1.6);

    subGain.gain.setValueAtTime(0.001, now);
    subGain.gain.linearRampToValueAtTime(0.45, now + 0.12);
    subGain.gain.exponentialRampToValueAtTime(0.001, now + 1.6);

    sub.connect(subGain);
    subGain.connect(dest);
    sub.start(now);
    sub.stop(now + 1.65);

    // 2. Гармонический неоновый аккорд (C4 -> G4 -> C5)
    const freqs = [261.63, 392.00, 523.25];
    freqs.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(freq, now + idx * 0.08);

      gain.gain.setValueAtTime(0.001, now + idx * 0.08);
      gain.gain.linearRampToValueAtTime(0.22, now + idx * 0.08 + 0.14);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 1.5);

      osc.connect(gain);
      gain.connect(dest);
      osc.start(now + idx * 0.08);
      osc.stop(now + 1.55);
    });
  }

  function synthStartupCyberPulse(ctx, dest) {
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();

    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(120, now);
    osc.frequency.exponentialRampToValueAtTime(880, now + 0.38);

    filter.type = "bandpass";
    filter.Q.value = 3.5;
    filter.frequency.setValueAtTime(300, now);
    filter.frequency.exponentialRampToValueAtTime(2400, now + 0.4);

    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.35, now + 0.06);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.75);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(dest);

    osc.start(now);
    osc.stop(now + 0.8);
  }

  function synthStartupSoftGlow(ctx, dest) {
    const now = ctx.currentTime;
    const freqs = [261.63, 329.63, 392.00, 493.88]; // Аккорд До-Ми-Соль-Си
    freqs.forEach((f) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(f, now);

      gain.gain.setValueAtTime(0.001, now);
      gain.gain.linearRampToValueAtTime(0.18, now + 0.1);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 1.3);

      osc.connect(gain);
      gain.connect(dest);
      osc.start(now);
      osc.stop(now + 1.35);
    });
  }

  function synthStartupArcadeFanfare(ctx, dest) {
    const now = ctx.currentTime;
    const notes = [261.63, 329.63, 392.00, 523.25]; // Ноты До4, Ми4, Соль4, До5
    notes.forEach((f, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const t = now + i * 0.085;

      osc.type = "square";
      osc.frequency.setValueAtTime(f, t);

      gain.gain.setValueAtTime(0.001, t);
      gain.gain.linearRampToValueAtTime(0.2, t + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, t + (i === notes.length - 1 ? 0.45 : 0.08));

      osc.connect(gain);
      gain.connect(dest);
      osc.start(t);
      osc.stop(t + (i === notes.length - 1 ? 0.5 : 0.085));
    });
  }

  // --- ЗВУКИ КЛИКА ---
  function synthClickCyber(ctx, dest) {
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "triangle";
    osc.frequency.setValueAtTime(1600, now);
    osc.frequency.exponentialRampToValueAtTime(380, now + 0.022);

    gain.gain.setValueAtTime(0.28, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.024);

    osc.connect(gain);
    gain.connect(dest);
    osc.start(now);
    osc.stop(now + 0.026);
  }

  function synthClickSoftPop(ctx, dest) {
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "sine";
    osc.frequency.setValueAtTime(420, now);
    osc.frequency.exponentialRampToValueAtTime(80, now + 0.028);

    gain.gain.setValueAtTime(0.3, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.03);

    osc.connect(gain);
    gain.connect(dest);
    osc.start(now);
    osc.stop(now + 0.032);
  }

  function synthClickMechanical(ctx, dest) {
    const now = ctx.currentTime;
    // Щелчок контакта
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = "triangle";
    osc1.frequency.setValueAtTime(2200, now);
    osc1.frequency.exponentialRampToValueAtTime(700, now + 0.012);
    gain1.gain.setValueAtTime(0.25, now);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.014);

    osc1.connect(gain1);
    gain1.connect(dest);
    osc1.start(now);
    osc1.stop(now + 0.015);

    // Глухой удар кейкапа
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = "sine";
    osc2.frequency.setValueAtTime(170, now + 0.004);
    osc2.frequency.exponentialRampToValueAtTime(50, now + 0.026);
    gain2.gain.setValueAtTime(0.22, now + 0.004);
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.028);

    osc2.connect(gain2);
    gain2.connect(dest);
    osc2.start(now + 0.004);
    osc2.stop(now + 0.03);
  }

  function synthClickArcadeBeep(ctx, dest) {
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "square";
    osc.frequency.setValueAtTime(880, now);

    gain.gain.setValueAtTime(0.18, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.024);

    osc.connect(gain);
    gain.connect(dest);
    osc.start(now);
    osc.stop(now + 0.026);
  }

  // --- ЗВУКИ УСПЕХА ---
  function synthSuccessEclipse(ctx, dest) {
    const now = ctx.currentTime;
    const notes = [523.25, 783.99]; // Ноты До5, Соль5
    notes.forEach((f, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const t = now + idx * 0.075;

      osc.type = "sine";
      osc.frequency.setValueAtTime(f, t);

      gain.gain.setValueAtTime(0.001, t);
      gain.gain.linearRampToValueAtTime(0.32, t + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.65);

      osc.connect(gain);
      gain.connect(dest);
      osc.start(t);
      osc.stop(t + 0.7);
    });
  }

  function synthSuccessChime(ctx, dest) {
    const now = ctx.currentTime;
    const notes = [659.25, 830.61, 987.77]; // Ноты Ми5, Соль-диез5, Си5
    notes.forEach((f, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const t = now + idx * 0.085;

      osc.type = "sine";
      osc.frequency.setValueAtTime(f, t);

      gain.gain.setValueAtTime(0.001, t);
      gain.gain.linearRampToValueAtTime(0.28, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.75);

      osc.connect(gain);
      gain.connect(dest);
      osc.start(t);
      osc.stop(t + 0.8);
    });
  }

  function synthSuccessSciFiPing(ctx, dest) {
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();

    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(780, now);
    osc.frequency.exponentialRampToValueAtTime(1320, now + 0.09);

    filter.type = "bandpass";
    filter.Q.value = 4;
    filter.frequency.setValueAtTime(1400, now);

    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.3, now + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.48);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(dest);
    osc.start(now);
    osc.stop(now + 0.5);
  }

  function synthSuccessArcadeCoin(ctx, dest) {
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "square";
    osc.frequency.setValueAtTime(987.77, now); // Нота Си5
    osc.frequency.setValueAtTime(1318.51, now + 0.065); // Нота Ми6

    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.22, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

    osc.connect(gain);
    gain.connect(dest);
    osc.start(now);
    osc.stop(now + 0.38);
  }

  // Форматирование размера файла звука в байтах
  function formatAudioBytes(bytes) {
    const b = Number(bytes) || 0;
    if (b < 1024) return `${b} Б`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} КБ`;
    return `${(b / (1024 * 1024)).toFixed(1)} МБ`;
  }

  // Загрузка и декодирование аудиоданных в оперативной памяти
  async function loadAndDecodeSound(id) {
    if (customAudioBuffers.has(id)) return customAudioBuffers.get(id);
    const tauri = window.__TAURI__;
    const invoke = window.cgsApi?.invoke;
    if (!invoke) return null;
    try {
      const bytes = await invoke("audio_read_custom_sound", { id });
      if (!bytes || !bytes.length) return null;
      const ctx = getContext();
      if (!ctx) return null;
      const uint8 = new Uint8Array(bytes);
      const arrayBuffer = uint8.buffer.slice(uint8.byteOffset, uint8.byteOffset + uint8.byteLength);
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
      customAudioBuffers.set(id, audioBuffer);
      return audioBuffer;
    } catch (e) {
      console.warn("Не удалось декодировать пользовательский звук:", id, e);
      return null;
    }
  }

  // Воспроизведение пользовательского аудиофайла из кэша
  function playCustomBuffer(soundId) {
    const ctx = getContext();
    if (!ctx || !masterGain) return;
    const buf = customAudioBuffers.get(soundId);
    if (buf) {
      try {
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(masterGain);
        src.start(0);
      } catch (_) {}
      return;
    }
    // Если еще не кэширован в памяти, лениво читаем и декодируем
    loadAndDecodeSound(soundId).then((decoded) => {
      if (decoded && ctx && masterGain) {
        try {
          const src = ctx.createBufferSource();
          src.buffer = decoded;
          src.connect(masterGain);
          src.start(0);
        } catch (_) {}
      }
    });
  }

  // Склонение слова «звук»
  function pluralAudioSounds(count) {
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (mod10 === 1 && mod100 !== 11) return "звук";
    if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) return "звука";
    return "звуков";
  }

  // Обновление опций в выпадающих списках звуков
  function updateDropdownCustomOptions() {
    ["startup", "click", "success"].forEach((type) => {
      const select = document.getElementById(`audio-sound-${type}`);
      if (!select) return;

      const currentValue = getSound(type);

      // Удаляем старые кастомные опции и разделитель
      const oldItems = select.querySelectorAll(".custom-sound-opt, .custom-sound-sep");
      oldItems.forEach((el) => el.remove());

      if (customSoundsList.length > 0) {
        // Добавляем аккуратный разделитель
        const sep = document.createElement("option");
        sep.disabled = true;
        sep.className = "custom-sound-sep";
        sep.textContent = "── Мои звуки ──";
        select.appendChild(sep);

        customSoundsList.forEach((sound) => {
          const opt = document.createElement("option");
          opt.className = "custom-sound-opt";
          opt.value = sound.id;
          opt.textContent = sound.name;
          select.appendChild(opt);
        });
      }

      // Восстанавливаем выбранное значение
      select.value = currentValue;
      if (window.cgsCustomSelect?.sync) {
        window.cgsCustomSelect.sync(select);
      }
    });

    syncProfileHighlight();
  }

  // Отрисовка списка пользовательских звуков в настройках
  function renderCustomSoundsList() {
    const container = document.getElementById("audio-custom-list");
    const summary = document.getElementById("audio-custom-summary");
    if (!container) return;

    const isEn = document.documentElement.lang === "en" || window.cgsStorage.getItem("cgs-language") === "en";

    if (summary) {
      if (customSoundsList.length > 0) {
        const count = customSoundsList.length;
        summary.textContent = isEn
          ? `Cached: ${count} ${count === 1 ? "sound" : "sounds"}`
          : `Загружено в кэш: ${count} ${pluralAudioSounds(count)}`;
      } else {
        summary.textContent = isEn
          ? "Upload custom audio files (MP3, OGG, WAV, FLAC) to app cache"
          : "Загрузка своих аудиофайлов (MP3, OGG, WAV, FLAC) в кэш программы";
      }
    }

    if (!customSoundsList.length) {
      container.classList.add("hidden");
      container.innerHTML = "";
      return;
    }

    container.classList.remove("hidden");
    container.innerHTML = "";
    customSoundsList.forEach((sound) => {
      const item = document.createElement("div");
      item.className = "custom-sound-item";
      item.dataset.soundId = sound.id;
      item.title = isEn ? "Click anywhere to preview sound" : "Нажмите в любом месте строки для прослушивания";

      // Воспроизведение звука при клике в любое место строки (кроме кнопки удаления)
      item.addEventListener("click", (e) => {
        if (e.target.closest(".btn-delete")) return;
        e.preventDefault();
        playCustomBuffer(sound.id);
      });

      const playBtn = document.createElement("button");
      playBtn.type = "button";
      playBtn.className = "custom-sound-btn";
      playBtn.title = isEn ? "Preview" : "Прослушать";
      playBtn.setAttribute("aria-label", isEn ? "Preview" : "Прослушать");
      playBtn.innerHTML = `<svg viewBox="0 0 16 16"><path fill="currentColor" d="M4.5 3.5v9l8-4.5-8-4.5z"/></svg>`;

      const meta = document.createElement("div");
      meta.className = "custom-sound-meta";

      const name = document.createElement("span");
      name.className = "custom-sound-name";
      name.title = sound.name;
      name.textContent = sound.name;

      const size = document.createElement("span");
      size.className = "custom-sound-size";
      size.textContent = formatAudioBytes(sound.sizeBytes);

      meta.append(name, size);

      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "custom-sound-btn btn-delete";
      deleteBtn.title = isEn ? "Delete from cache" : "Удалить из кэша";
      deleteBtn.setAttribute("aria-label", isEn ? "Delete" : "Удалить");
      deleteBtn.innerHTML = `<svg viewBox="0 0 16 16"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M3 4h10M6 4V2.5a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 .5.5V4m2 0v9a1.5 1.5 0 0 1-1.5 1.5h-6A1.5 1.5 0 0 1 3 13V4"/></svg>`;
      deleteBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await deleteCustomSound(sound.id, sound.name);
      });

      item.append(playBtn, meta, deleteBtn);
      container.appendChild(item);
    });
  }

  // Пакетная загрузка новых аудиофайлов в кэш
  async function handleSoundsUpload(files) {
    if (!files || !files.length) return;
    const ctx = getContext();
    if (!ctx) return;

    const tauri = window.__TAURI__;
    const invoke = window.cgsApi?.invoke;
    let addedCount = 0;
    let lastSoundId = null;

    for (const file of files) {
      if (!file) continue;
      // Ограничение размера 15 МБ на файл
      if (file.size > 15 * 1024 * 1024) {
        if (window.cgsToast) {
          window.cgsToast(`Файл «${file.name}» слишком большой (макс. 15 МБ)`, "error");
        }
        continue;
      }

      try {
        const arrayBuffer = await file.arrayBuffer();

        // Проверка декодирования Web Audio API
        let decodedBuffer;
        try {
          decodedBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
        } catch (_) {
          if (window.cgsToast) {
            window.cgsToast(`Не удалось декодировать «${file.name}»`, "error");
          }
          continue;
        }

        const bytes = Array.from(new Uint8Array(arrayBuffer));

        let meta;
        if (invoke) {
          meta = await invoke("audio_save_custom_sound", {
            name: file.name,
            bytes
          });
        } else {
          meta = {
            id: "custom_" + file.name,
            name: file.name,
            sizeBytes: file.size
          };
        }

        customAudioBuffers.set(meta.id, decodedBuffer);
        customSoundsList = customSoundsList.filter((s) => s.id !== meta.id);
        customSoundsList.push(meta);
        addedCount++;
        lastSoundId = meta.id;
      } catch (err) {
        console.error("Ошибка при сохранении звука:", file.name, err);
      }
    }

    if (addedCount > 0) {
      customSoundsList.sort((a, b) => a.name.localeCompare(b.name));
      updateDropdownCustomOptions();
      renderCustomSoundsList();

      // Воспроизводим последний добавленный звук для быстрой проверки
      if (lastSoundId) {
        playCustomBuffer(lastSoundId);
      }

      if (window.cgsToast) {
        if (addedCount === 1) {
          const sound = customSoundsList.find((s) => s.id === lastSoundId);
          window.cgsToast(`Звук добавлен в кэш: ${sound?.name || ""}`, "success");
        } else {
          window.cgsToast(`Добавлено звуков в кэш: ${addedCount}`, "success");
        }
      }
    }
  }

  // Удаление пользовательского звука из кэша
  async function deleteCustomSound(id, name) {
    const modal = window.cgsShowModal;
    if (modal) {
      const accepted = await modal(
        "Удаление звука",
        `Удалить звук «${name}» из кэша программы?`,
        { confirm: true, confirmText: "Удалить", cancelText: "Отмена", symbol: "✕" }
      );
      if (!accepted) return;
    }

    try {
      const tauri = window.__TAURI__;
      const invoke = window.cgsApi?.invoke;
      if (invoke) {
        await invoke("audio_delete_custom_sound", { id });
      }

      customAudioBuffers.delete(id);
      customSoundsList = customSoundsList.filter((s) => s.id !== id);

      // Сброс на дефолтные звуки, если удаляемый звук был активен
      if (getSound("startup") === id) setSound("startup", DEFAULT_STARTUP, true);
      if (getSound("click") === id) setSound("click", DEFAULT_CLICK, true);
      if (getSound("success") === id) setSound("success", DEFAULT_SUCCESS, true);

      updateDropdownCustomOptions();
      renderCustomSoundsList();

      if (window.cgsToast) {
        window.cgsToast("Звук удалён из кэша", "success");
      }
    } catch (err) {
      console.error("Ошибка при удалении звука:", err);
      if (window.cgsToast) {
        window.cgsToast("Не удалось удалить звук из кэша", "error");
      }
    }
  }

  // Обновление списка звуков из бекенда
  async function refreshCustomSounds() {
    const tauri = window.__TAURI__;
    const invoke = window.cgsApi?.invoke;
    if (!invoke) return;
    try {
      const list = await invoke("audio_list_custom_sounds");
      customSoundsList = Array.isArray(list) ? list : [];
      updateDropdownCustomOptions();
      renderCustomSoundsList();

      // Фоновое чтение и декодирование звуков
      for (const item of customSoundsList) {
        loadAndDecodeSound(item.id);
      }
    } catch (err) {
      console.warn("Не удалось прочитать список пользовательских звуков:", err);
    }
  }

  // Диспетчер воспроизведения конкретного звука
  function playSoundById(type, soundId) {
    if (!soundId || soundId === "none") return;
    const ctx = getContext();
    if (!ctx || !masterGain) return;

    // Воспроизведение пользовательского файла из кэша
    if (typeof soundId === "string" && soundId.startsWith("custom_")) {
      playCustomBuffer(soundId);
      return;
    }

    if (type === "startup") {
      if (soundId === "eclipse-dawn") synthStartupDawn(ctx, masterGain);
      else if (soundId === "cyber-pulse") synthStartupCyberPulse(ctx, masterGain);
      else if (soundId === "soft-glow") synthStartupSoftGlow(ctx, masterGain);
      else if (soundId === "arcade-fanfare") synthStartupArcadeFanfare(ctx, masterGain);
    } else if (type === "click") {
      if (soundId === "cyber-click") synthClickCyber(ctx, masterGain);
      else if (soundId === "soft-pop") synthClickSoftPop(ctx, masterGain);
      else if (soundId === "mechanical-key") synthClickMechanical(ctx, masterGain);
      else if (soundId === "arcade-beep") synthClickArcadeBeep(ctx, masterGain);
    } else if (type === "success") {
      if (soundId === "eclipse-success") synthSuccessEclipse(ctx, masterGain);
      else if (soundId === "chime-win") synthSuccessChime(ctx, masterGain);
      else if (soundId === "scifi-ping") synthSuccessSciFiPing(ctx, masterGain);
      else if (soundId === "arcade-coin") synthSuccessArcadeCoin(ctx, masterGain);
    }
  }

  // Публичные методы воспроизведения
  function playStartup() {
    if (!isEnabled()) return;
    const soundId = getSound("startup");
    playSoundById("startup", soundId);
  }

  function playClick() {
    if (!isEnabled()) return;
    const now = performance.now();
    // Троттлинг 35 мс от случайного дребезга
    if (now - lastClickTime < 35) return;
    lastClickTime = now;
    const soundId = getSound("click");
    playSoundById("click", soundId);
  }

  function playSuccess() {
    if (!isEnabled()) return;
    const soundId = getSound("success");
    playSoundById("success", soundId);
  }

  // Предпросмотр звука из выпадающего списка
  function previewSound(type, soundId) {
    const ctx = getContext();
    if (!ctx) return;
    playSoundById(type, soundId || getSound(type));
  }

  // Глобальный перехватчик кликов по интерактивным элементам
  document.addEventListener("click", (e) => {
    // Исключаем ползунки громкости и слайдеры (при драге клики не нужны)
    if (e.target.closest("input[type='range']")) return;

    // Проверяем явные интерактивные элементы UI
    const interactive = e.target.closest(
      "button, [role='button'], a[href], summary, select, " +
      "input[type='checkbox'], input[type='radio'], " +
      ".nav-item, .module-card, [data-open-view], [data-view], " +
      ".theme-option, [data-theme-option], .accent-chip, [data-accent-option], " +
      ".switch, .tab-btn, .svc-option, .loader-option, .personalization-segment button, " +
      ".window-button, .sidebar-mode-btn, .channel-card, " +
      ".save-location, .dlc-library-game, .dlc-item, .dlc-unlock-all, " +
      ".hv-game-card, .file-card, .utility-card, .crack-card, " +
      ".lua-game-card, .lua-search-item, .custom-sound-item, .custom-sound-btn, " +
      ".audio-upload-btn, .clickable"
    );

    if (interactive) {
      playClick();
      return;
    }

    // Дополнительная проверка на элементы с курсором-указателем
    let el = e.target;
    let depth = 0;
    while (el && el !== document.body && depth < 4) {
      try {
        const cursor = window.getComputedStyle(el).cursor;
        if (cursor === "pointer") {
          playClick();
          return;
        }
      } catch (_) {}
      el = el.parentElement;
      depth++;
    }
  }, { capture: true, passive: true });

  // Привязка управляющих элементов раздела Настроек
  function bindSettings() {
    const masterToggle = document.getElementById("audio-master-toggle");
    if (masterToggle) {
      masterToggle.checked = isEnabled();
      masterToggle.addEventListener("change", (e) => {
        setEnabled(e.target.checked);
        if (e.target.checked) playSuccess();
      });
    }

    // Ползунок громкости
    const volumeSlider = document.getElementById("audio-volume");
    setVolume(getVolumePercent(), false);
    if (volumeSlider) {
      volumeSlider.addEventListener("input", (e) => {
        setVolume(e.target.value, true);
      });
      volumeSlider.addEventListener("change", () => {
        playClick();
      });
    }

    const volumeReset = document.getElementById("audio-volume-reset");
    if (volumeReset) {
      volumeReset.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        setVolume(DEFAULT_VOLUME, true);
        playClick();
      });
    }

    // Выпадающие списки звуков
    ["startup", "click", "success"].forEach((type) => {
      const select = document.getElementById(`audio-sound-${type}`);
      if (select) {
        select.value = getSound(type);
        select.addEventListener("change", (e) => {
          setSound(type, e.target.value, true);
          previewSound(type, e.target.value);
        });
      }

      const previewBtn = document.getElementById(`play-sound-${type}`);
      if (previewBtn) {
        previewBtn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          const curSelect = document.getElementById(`audio-sound-${type}`);
          const soundId = curSelect ? curSelect.value : getSound(type);
          previewSound(type, soundId);
        });
      }
    });

    // Привязка элементов управления пользовательскими звуковыми профилями
    const createProfileBtn = document.getElementById("audio-create-profile-btn");
    const profileForm = document.getElementById("audio-profile-form");
    const profileInput = document.getElementById("audio-profile-name-input");
    const profileSubmit = document.getElementById("audio-profile-submit-btn");
    const profileCancel = document.getElementById("audio-profile-cancel-btn");

    if (createProfileBtn && profileForm && profileInput) {
      createProfileBtn.addEventListener("click", (e) => {
        e.preventDefault();
        const isHidden = profileForm.classList.contains("hidden");
        if (isHidden) {
          profileForm.classList.remove("hidden");
          profileInput.value = "";
          profileInput.focus();
        } else {
          profileForm.classList.add("hidden");
        }
      });

      const submitAction = () => {
        const val = profileInput.value.trim();
        if (createCustomProfile(val)) {
          profileInput.value = "";
          profileForm.classList.add("hidden");
        }
      };

      if (profileSubmit) {
        profileSubmit.addEventListener("click", (e) => {
          e.preventDefault();
          submitAction();
        });
      }

      if (profileCancel) {
        profileCancel.addEventListener("click", (e) => {
          e.preventDefault();
          profileForm.classList.add("hidden");
        });
      }

      profileInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          submitAction();
        } else if (e.key === "Escape") {
          e.preventDefault();
          profileForm.classList.add("hidden");
        }
      });
    }

    // Кнопка загрузки своего звука
    const uploadBtn = document.getElementById("audio-upload-btn");
    const fileInput = document.getElementById("audio-file-input");
    if (uploadBtn && fileInput) {
      uploadBtn.addEventListener("click", (e) => {
        e.preventDefault();
        fileInput.value = "";
        fileInput.click();
      });

      fileInput.addEventListener("change", (e) => {
        const files = Array.from(e.target.files || []);
        if (files.length) {
          handleSoundsUpload(files);
        }
      });
    }

    renderProfiles();
    syncProfileHighlight();
    updateAudioControlsState(isEnabled());

    // Инициализация списка пользовательских звуков
    refreshCustomSounds();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindSettings);
  } else {
    bindSettings();
  }

  // Экспорт звуковой системы в глобальное пространство
  window.cgsAudio = {
    playStartup,
    playClick,
    playSuccess,
    previewSound,
    isEnabled,
    setEnabled,
    getVolumePercent,
    setVolume,
    getSound,
    setSound,
    loadProfiles,
    saveProfiles,
    renderProfiles,
    applyProfile,
    createCustomProfile,
    deleteProfile,
    restoreDefaultProfiles,
    applyPack,
    refreshCustomSounds,
    handleSoundsUpload,
    deleteCustomSound
  };
})();
