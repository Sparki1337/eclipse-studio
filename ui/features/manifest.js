(() => {
  "use strict";

  // manifest — раздел «Eclipse Manifest»: обложки, игры Lua/depotcache, загрузчик OpenSteamTool, Millennium, HubCap/Ryuu
  window.cgsManifest = {
    create({ state, $, $$, invoke, call, setBusy, log, toast, errorText, consumeResult, showModal, updateAboutInfo, secretSaveTimers }) {
  // Кэш прямых ссылок на обложки добавленных игр в window.cgsStorage
  const LUA_COVERS_STORAGE_KEY = "cgs-lua-covers";

  function loadStoredLuaCovers() {
    try {
      const data = JSON.parse(window.cgsStorage.getItem(LUA_COVERS_STORAGE_KEY) || "{}");
      return typeof data === "object" && data !== null ? data : {};
    } catch (_) {
      return {};
    }
  }

  // Ссылки на обложки пишем пачкой: при большой библиотеке их приходят десятки подряд
  const luaCoverWrites = new Map();
  let luaCoverWriteTimer = null;

  function flushLuaCoverWrites() {
    luaCoverWriteTimer = null;
    if (!luaCoverWrites.size) return;
    try {
      const data = loadStoredLuaCovers();
      for (const [appid, url] of luaCoverWrites) if (url) data[appid] = url;
      luaCoverWrites.clear();
      window.cgsStorage.setItem(LUA_COVERS_STORAGE_KEY, JSON.stringify(data));
    } catch (_) {
      luaCoverWrites.clear();
    }
  }

  function saveStoredLuaCover(appid, url) {
    if (!appid || !url) return;
    luaCoverWrites.set(String(appid), url);
    clearTimeout(luaCoverWriteTimer);
    luaCoverWriteTimer = setTimeout(flushLuaCoverWrites, 600);
  }

  // Кэш названий и последнего статуса: вкладка открывается сразу из него,
  // а свежие данные догружаются в фоне
  const LUA_NAMES_STORAGE_KEY = "cgs-lua-names";
  const LUA_STATUS_STORAGE_KEY = "cgs-lua-status";
  const LUA_STATUS_TTL_MS = 10000;
  let luaStatusFetchedAt = 0;
  let luaStatusInFlight = null;
  // Запрос статуса, отложенный до конца текущего: переключение фильтра не теряется
  let luaRefreshPending = false;

  function loadStoredLuaNames() {
    try {
      const data = JSON.parse(window.cgsStorage.getItem(LUA_NAMES_STORAGE_KEY) || "{}");
      return typeof data === "object" && data !== null ? data : {};
    } catch (_) {
      return {};
    }
  }

  function saveStoredLuaNames(names) {
    try {
      window.cgsStorage.setItem(LUA_NAMES_STORAGE_KEY, JSON.stringify(names || {}));
    } catch (_) {}
  }

  function loadStoredLuaStatus() {
    try {
      const data = JSON.parse(window.cgsStorage.getItem(LUA_STATUS_STORAGE_KEY) || "null");
      return data && typeof data === "object" && Array.isArray(data.games) ? data : null;
    } catch (_) {
      return null;
    }
  }

  function saveStoredLuaStatus(status) {
    if (!status) return;
    try {
      window.cgsStorage.setItem(LUA_STATUS_STORAGE_KEY, JSON.stringify({
        steamPath: status.steamPath || "",
        luaFolder: status.luaFolder || "",
        steamDetected: Boolean(status.steamDetected),
        steamExe: Boolean(status.steamExe),
        pluginFolder: Boolean(status.pluginFolder),
        loaderStatus: status.loaderStatus || "",
        loaderName: status.loaderName || "",
        loaderIssue: status.loaderIssue || "",
        luaCount: Number(status.luaCount) || 0,
        externalCount: Number(status.externalCount) || 0,
        games: status.games || [],
        savedAt: Date.now(),
      }));
    } catch (_) {}
  }


    // Инициализируем кэш имён и обложек до первого переключения на вкладку
    state.lua.names = loadStoredLuaNames();
    state.lua.headers = loadStoredLuaCovers();

  function steamHeaderUrls(appid) {
    return [
      `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`,
      `https://cdn.akamai.steamstatic.com/steam/apps/${appid}/header.jpg`,
      `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appid}/header.jpg`,
    ];
  }

  function loadCover(cover, img, appid) {
    window.cgsPerf?.setPhase("обложки");
    const key = String(appid);
    const cached = state.lua.headers[key];
    if (cached) {
      img.onload = () => cover.classList.add("loaded");
      img.onerror = () => tryStaticUrls();
      img.src = cached;
      return;
    }

    tryStaticUrls();

    function tryStaticUrls() {
      const urls = steamHeaderUrls(appid);
      let index = 0;
      img.onload = () => cover.classList.add("loaded");
      img.onerror = async () => {
        index += 1;
        if (index < urls.length) {
          img.src = urls[index];
        } else {
          // Статические пути дали 404 — точный URL берём из Steam Store API
          try {
            const storeUrl = await call("game_artwork_store_url", { appid: Number(appid) });
            if (storeUrl) {
              state.lua.headers[key] = storeUrl;
              saveStoredLuaCover(key, storeUrl);
              img.onload = () => cover.classList.add("loaded");
              img.onerror = () => cover.classList.remove("loaded");
              img.src = storeUrl;
              return;
            }
          } catch (_) {}
          cover.classList.remove("loaded");
        }
      };
      img.src = urls[0];
    }
  }

  // Обложки грузятся только рядом с видимой областью: большой список не шлёт сотни запросов
  function ensureLuaCoverObserver() {
    if (luaCoverObserver || !("IntersectionObserver" in window)) return luaCoverObserver;
    const root = document.querySelector(".main-area");
    luaCoverObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        luaCoverObserver.unobserve(entry.target);
        const cover = entry.target;
        if (!cover.isConnected) return;
        const appid = cover.dataset.appid;
        const image = cover.querySelector("img");
        if (appid && image && !image.getAttribute("src")) loadCover(cover, image, appid);
      });
    }, { root: root || null, rootMargin: "320px 0px" });
    return luaCoverObserver;
  }

  function observeLuaCover(cover, appid) {
    const observer = ensureLuaCoverObserver();
    cover.dataset.appid = String(appid);
    if (!observer) {
      const image = cover.querySelector("img");
      if (image) loadCover(cover, image, appid);
      return;
    }
    observer.observe(cover);
  }

  // В русском интерфейсе обход карточки ради перевода только замедляет список
  function translateLuaCard(card) {
    if (window.cgsI18n?.language === "en") window.cgsI18n?.translate(card);
  }

  // Карточка создаётся один раз; дальше её обновляют, не трогая DOM целиком
  function createLuaGameCard(game) {
    const card = document.createElement("div");
    card.dataset.appid = String(game.appid);

    const cover = document.createElement("div");
    cover.className = "lua-game-cover";
    const img = document.createElement("img");
    // Обложка скрыта стилями до загрузки, поэтому loading="lazy" её не грузит
    img.decoding = "async";
    const fallback = document.createElement("span");
    fallback.className = "lua-cover-fallback";
    fallback.textContent = game.appid;
    cover.append(img, fallback);
    const knownHeader = state.lua.headers[String(game.appid)];
    if (knownHeader) {
      card.dataset.cover = knownHeader;
      loadCover(cover, img, game.appid);
    } else {
      observeLuaCover(cover, game.appid);
    }
    cover.style.cursor = "pointer";
    cover.title = "Подробнее";
    cover.addEventListener("click", () => luaOpenDetail(card.dataset.appid));

    const info = document.createElement("div");
    info.className = "lua-game-info";
    const nameLine = document.createElement("div");
    nameLine.className = "lua-game-name";
    nameLine.append(document.createElement("strong"));
    const meta = document.createElement("div");
    meta.className = "lua-game-meta";
    const status = document.createElement("span");
    status.className = "lua-game-status";
    meta.append(status);
    if (game.external) {
      const mark = document.createElement("span");
      mark.className = "lua-external-badge";
      mark.textContent = "Сторонняя";
      mark.title = "Добавлена другим инструментом";
      meta.append(mark);
    }
    info.append(nameLine, meta);
    const actions = document.createElement("div");
    actions.className = "lua-game-actions";
    const details = document.createElement("button");
    details.className = "ghost-button lua-action-btn lua-action-details";
    details.textContent = "Подробнее";
    details.addEventListener("click", () => luaOpenDetail(card.dataset.appid));
    const toggle = document.createElement("button");
    toggle.className = "ghost-button lua-action-btn lua-action-toggle";
    toggle.addEventListener("click", () => luaToggle(card.dataset.appid, card.dataset.enabled !== "1"));
    // Перекачивает манифесты игры по сервису и ключу, выбранным в настройках
    const refresh = document.createElement("button");
    refresh.className = "ghost-button lua-action-btn lua-action-refresh";
    refresh.textContent = "Обновить манифесты";
    refresh.title = "Перекачать манифесты по выбранному сервису и ключу";
    refresh.addEventListener("click", () => luaRefreshManifests(card.dataset.appid, refresh));
    const remove = document.createElement("button");
    remove.className = "ghost-button danger-ghost lua-action-btn lua-action-remove";
    remove.textContent = "Удалить";
    remove.addEventListener("click", () => luaRemove(card.dataset.appid, card.dataset.external === "1"));
    actions.append(details, toggle, refresh, remove);

    card.append(cover, info, actions);
    updateLuaGameCard(card, game);
    return card;
  }

  function luaStatusText(game) {
    const key = game.status || (game.enabled ? "ready" : "disabled");
    if (key === "missing_manifests") {
      return {
        key,
        text: `Нет manifest: ${game.missingManifestCount || 0}`,
        title: `Установлено: ${game.manifestCount || 0}. Отсутствует: ${game.missingManifestCount || 0}.`,
      };
    }
    if (key === "invalid_lua") {
      return {
        key,
        text: "Lua повреждён",
        title: "Lua-файл пустой, недоступен или не содержит addappid",
      };
    }
    if (key === "disabled") return { key, text: "Отключена", title: "" };
    return {
      key,
      text: game.manifestCount ? `Готова · ${game.manifestCount} manifest` : "Готова",
      title: "",
    };
  }

  // Обновляет карточку на месте и сообщает, изменился ли текст
  function updateLuaGameCard(card, game) {
    let changed = false;
    const needsAttention = game.status === "missing_manifests" || game.status === "invalid_lua";
    const className = `lua-game${game.enabled ? "" : " disabled"}${needsAttention ? " needs-attention" : ""}`;
    if (card.className !== className) card.className = className;
    card.dataset.enabled = game.enabled ? "1" : "0";
    card.dataset.external = game.external ? "1" : "0";

    const title = card.querySelector(".lua-game-name strong");
    const name = state.lua.names[game.appid] || `AppID ${game.appid}`;
    if (title && title.textContent !== name) {
      title.textContent = name;
      title.title = name;
      changed = true;
    }

    const status = card.querySelector(".lua-game-status");
    const info = luaStatusText(game);
    if (status) {
      const statusClass = `lua-game-status ${info.key}`;
      if (status.className !== statusClass) status.className = statusClass;
      if (status.textContent !== info.text) {
        status.textContent = info.text;
        changed = true;
      }
      if (status.title !== info.title) status.title = info.title;
    }

    const toggle = card.querySelector(".lua-action-toggle");
    if (toggle) {
      const label = game.enabled ? "Отключить" : "Включить";
      if (toggle.textContent !== label) {
        toggle.textContent = label;
        changed = true;
      }
      toggle.classList.toggle("is-disabled", !game.enabled);
    }
    const remove = card.querySelector(".lua-action-remove");
    if (remove) {
      remove.title = game.external
        ? "Удалить игру, добавленную другим инструментом"
        : "Удалить игру из загрузчика";
    }

    // Обложка: подставляем URL, когда он пришёл из Steam позже самой карточки.
    // Уже показанную обложку не перезагружаем, иначе карточка визуально мигает.
    const header = state.lua.headers[String(game.appid)];
    if (header && card.dataset.cover !== header) {
      const cover = card.querySelector(".lua-game-cover");
      const image = cover?.querySelector("img");
      if (cover && image) {
        luaCoverObserver?.unobserve(cover);
        card.dataset.cover = header;
        if (!cover.classList.contains("loaded")) loadCover(cover, image, game.appid);
      }
    }

    return changed;
  }

  function renderLuaGames() {
    window.cgsPerf?.mark("lua-render");
    window.cgsPerf?.setPhase("рендер списка игр");
    const container = $("#lua-games");
    const empty = $("#lua-empty");
    const games = state.lua.games;
    container.classList.toggle("hidden", games.length === 0);
    empty.classList.toggle("hidden", games.length > 0);
    // Счётчик сторонних добавлений виден и при выключенной галочке
    const externalCount = Number(state.lua.externalCount) || 0;
    const counter = $("#lua-external-count");
    if (counter) {
      counter.textContent = String(externalCount);
      counter.classList.toggle("hidden", externalCount === 0);
    }
    $("#lua-empty-external")?.classList.toggle("hidden", !(games.length === 0 && externalCount > 0));
    if (!games.length) {
      luaRenderInProgress = false;
      luaRenderPending = false;
      container.replaceChildren();
      container.dataset.signature = "";
      window.cgsPerf?.measure("Отрисовка списка игр", "lua-render");
      return;
    }

    // Отрисовка ещё идёт: запомним запрос и обновим подписи сразу после неё.
    // Иначе список обнуляется и все карточки мигают заново.
    if (luaRenderInProgress) {
      luaRenderPending = true;
      window.cgsPerf?.log("Список игр: обновление отложено до конца отрисовки");
      return;
    }

    // Состав игр изменился: добавляем и убираем только нужные карточки.
    // Полная пересборка списка заставляла игры мигать при прокрутке.
    const signature = games.map((game) => `${game.appid}|${game.external ? "e" : "i"}`).join(",");
    container.dataset.signature = signature;
    if (container.childElementCount) {
      syncLuaCards(container, games);
      window.cgsPerf?.measure("Отрисовка списка игр", "lua-render");
      return;
    }

    renderLuaCardsInChunks(container, games);
  }

  // Точечная синхронизация: существующие карточки не пересоздаются,
  // поэтому прокрутка и загруженные обложки сохраняются.
  function syncLuaCards(container, games) {
    const cards = new Map([...container.children].map((node) => [String(node.dataset.appid), node]));
    const wanted = new Set(games.map((game) => String(game.appid)));
    for (const [appid, card] of cards) {
      if (wanted.has(appid)) continue;
      luaCoverObserver?.unobserve(card.querySelector(".lua-game-cover"));
      card.remove();
      cards.delete(appid);
    }

    const order = games.map((game) => String(game.appid));
    const added = [];
    const changed = [];
    games.forEach((game, index) => {
      const appid = String(game.appid);
      const existing = cards.get(appid);
      if (existing) {
        if (updateLuaGameCard(existing, game)) changed.push(existing);
        return;
      }
      const card = createLuaGameCard(game);
      cards.set(appid, card);
      // Новая карточка встаёт на своё место, а не в конец списка
      const next = order.slice(index + 1).map((id) => cards.get(id)).find(Boolean) || null;
      container.insertBefore(card, next);
      added.push(card);
    });

    added.forEach(translateLuaCard);
    changed.forEach(translateLuaCard);
  }

  // Карточки рисуем порциями: длинный список не блокирует поток одним куском
  function renderLuaCardsInChunks(container, games) {
    const token = ++luaRenderToken;
    const chunkSize = 24;
    let index = 0;
    let firstScreen = false;
    luaRenderInProgress = true;
    luaRenderPending = false;
    window.cgsPerf?.mark("lua-first-screen");
    window.cgsPerf?.log(`Список игр: полная отрисовка ${games.length} карточек`);
    // Контейнер пуст: очистка здесь не нужна, иначе карточки мигают
    const finish = () => {
      luaRenderInProgress = false;
      window.cgsPerf?.measure("Отрисовка списка игр", "lua-render");
      // Пока рисовали, пришли новые данные — обновляем подписи без пересборки
      if (luaRenderPending) {
        luaRenderPending = false;
        renderLuaGames();
      }
    };
    const step = () => {
      if (token !== luaRenderToken) return;
      try {
        const fragment = document.createDocumentFragment();
        const cards = [];
        const end = Math.min(index + chunkSize, games.length);
        for (; index < end; index += 1) {
          const card = createLuaGameCard(games[index]);
          cards.push(card);
          fragment.append(card);
        }
        container.append(fragment);
        // Переводим только новые карточки, не весь документ
        cards.forEach(translateLuaCard);
      } catch (error) {
        // Сломанная карточка не должна навсегда оставить список пустым
        luaRenderInProgress = false;
        luaRenderPending = false;
        log(`Не удалось показать список игр: ${errorText(error)}`, "error");
        return;
      }
      if (!firstScreen) {
        firstScreen = true;
        window.cgsPerf?.measure("Первый экран списка игр", "lua-first-screen");
      }
      if (index < games.length) {
        (window.requestAnimationFrame || ((callback) => setTimeout(callback, 16)))(step);
      } else {
        finish();
      }
    };
    step();
  }

  let luaNamesInFlight = null;
  function luaLoadNames() {
    if (luaNamesInFlight) return luaNamesInFlight;
    luaNamesInFlight = loadLuaNames().finally(() => {
      luaNamesInFlight = null;
    });
    return luaNamesInFlight;
  }

  async function loadLuaNames() {
    const missingNames = state.lua.games.map((g) => g.appid).filter((id) => !state.lua.names[id]);
    const missingHeaders = state.lua.games.map((g) => g.appid).filter((id) => !state.lua.headers[id]);
    if (!missingNames.length && !missingHeaders.length) return;
    window.cgsPerf?.mark("lua-names");
    window.cgsPerf?.setPhase("названия и обложки");
    try {
      const [names, headers] = await Promise.all([
        missingNames.length ? call("luatools_names", { appids: missingNames.map(Number) }) : null,
        missingHeaders.length ? call("luatools_headers", { appids: missingHeaders.map(Number) }) : null,
      ]);
      window.cgsPerf?.measure("Названия и обложки из Steam", "lua-names");
      if (names && Object.keys(names).length) {
        Object.assign(state.lua.names, names);
        // Названия переживают перезапуск: сеть нужна только для новых игр
        saveStoredLuaNames(state.lua.names);
      }
      if (headers) {
        Object.assign(state.lua.headers, headers);
        // Ссылки на обложки попали в готовую карточку через updateLuaGameCard
        Object.entries(headers).forEach(([appid, url]) => saveStoredLuaCover(appid, url));
      }
      renderLuaGames();
    } catch (error) {
      log(`Не удалось получить сведения об играх: ${errorText(error)}`, "info");
    }
  }

  function luaDetailDate(unix) {
    if (!unix) return "";
    return new Date(Number(unix) * 1000).toLocaleDateString(window.cgsI18n?.locale?.() || "ru-RU", { day: "2-digit", month: "short", year: "numeric" });
  }

  function renderDepotList(container, items) {
    container.replaceChildren();
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "empty-inline";
      empty.textContent = "Ничего нет";
      container.appendChild(empty);
      return;
    }
    items.forEach((item) => {
      const row = document.createElement("div");
      row.className = "lua-depot";
      const copy = document.createElement("div");
      copy.className = "lua-depot-copy";
      const name = document.createElement("strong");
      name.textContent = item.name;
      name.title = item.name;
      const id = document.createElement("code");
      id.textContent = item.id;
      copy.append(name, id);
      row.append(copy);
      const badge = document.createElement("span");
      badge.className = "lua-depot-badge";
      badge.textContent = "DLC";
      row.append(badge);
      container.appendChild(row);
    });
  }

  let luaDetailDrmToken = 0;

  // Защита загружается только в карточке игры, а не при прокрутке списка
  async function loadLuaDetailDrm(appid) {
    const badge = $("#lua-detail-drm");
    if (!badge) return;
    const token = ++luaDetailDrmToken;
    badge.hidden = false;
    badge.className = "lua-drm-badge loading";
    badge.textContent = "Защита…";
    badge.title = "Получаем сведения о защите из Steam";
    try {
      const infos = await call("steam_drm_info", { appids: [String(appid)] });
      if (token !== luaDetailDrmToken) return;
      const info = Array.isArray(infos) ? infos[0] : null;
      applyDrmBadge(badge, info || {
        label: "Нет данных",
        kind: "unknown",
        notice: "Не удалось получить сведения о защите из Steam. Повторите позже.",
      });
    } catch {
      if (token !== luaDetailDrmToken) return;
      applyDrmBadge(badge, {
        label: "Нет данных",
        kind: "unknown",
        notice: "Не удалось получить сведения о защите из Steam. Повторите позже.",
      });
    }
  }

  async function luaOpenDetail(appid) {
    const backdrop = $("#lua-detail-backdrop");
    $("#lua-detail-name").textContent = state.lua.names[appid] || `AppID ${appid}`;
    $("#lua-detail-appid").textContent = appid;
    $("#lua-detail-added").textContent = "";
    $("#lua-detail-released").textContent = "";
    loadLuaDetailDrm(appid);
    $("#lua-detail-fallback").textContent = appid;
    const banner = $("#lua-detail-banner");
    banner.removeAttribute("src");
    banner.parentElement.classList.remove("loaded");
    loadCover(banner.parentElement, banner, appid);
    const loading = () => { const d = document.createElement("div"); d.className = "empty-inline"; d.textContent = "Загрузка из Steam…"; return d; };
    $("#lua-detail-in").replaceChildren(loading());
    $("#lua-detail-missing").replaceChildren();
    $("#lua-detail-in-count").textContent = "(…)";
    $("#lua-detail-missing-count").textContent = "(…)";
    backdrop.classList.remove("hidden");

    try {
      const detail = await call("luatools_game_detail", { appid, steamPath: state.lua.steamPath || null });
      if (detail.name) { $("#lua-detail-name").textContent = detail.name; state.lua.names[appid] = detail.name; }
      if (detail.header) {
        state.lua.headers[appid] = detail.header;
        saveStoredLuaCover(appid, detail.header);
        banner.src = detail.header;
        banner.parentElement.classList.add("loaded");
      }
      $("#lua-detail-added").textContent = detail.addedUnix ? `Добавлено ${luaDetailDate(detail.addedUnix)}` : "";
      $("#lua-detail-released").textContent = detail.releaseDate ? `Вышла ${detail.releaseDate}` : "";
      $("#lua-detail-in-count").textContent = `(${detail.inLua.length})`;
      $("#lua-detail-missing-count").textContent = `(${detail.missing.length})`;
      renderDepotList($("#lua-detail-in"), detail.inLua);
      renderDepotList($("#lua-detail-missing"), detail.missing);
    } catch (error) {
      $("#lua-detail-in-count").textContent = "(0)";
      $("#lua-detail-missing-count").textContent = "(0)";
      toast(errorText(error), "error");
    }
  }

  function renderLuaStatus() {
    const { steamPath, luaFolder, loaderStatus, loaderName, loaderIssue, games } = state.lua;
    $("#lua-count").textContent = games.length.toLocaleString(window.cgsI18n?.locale?.() || "ru-RU");
    $("#lua-steam-path").value = steamPath || "";
    if (loaderIssue) {
      $("#lua-steam-hint").textContent = loaderIssue;
    } else if (steamPath && luaFolder) {
      const relative = luaFolder.toLowerCase().startsWith(steamPath.toLowerCase())
        ? luaFolder.slice(steamPath.length).replace(/^[\\/]+/, "")
        : luaFolder;
      $("#lua-steam-hint").textContent = `${loaderName || "SteamTools"} · Lua: ${relative}`;
    } else {
      $("#lua-steam-hint").textContent = steamPath
        ? `Загрузчик: ${loaderStatus}`
        : "Steam не найден — укажите папку вручную";
    }
    renderMillenniumStatus();
    renderLoaderInfo();
    renderLuaGames();
    updateAboutInfo();
  }

  function renderMillenniumStatus() {
    const info = state.lua.millennium || {};
    const badge = $("#millennium-plugin-badge");
    const installButton = $("#millennium-install-button");
    const installLabel = installButton.querySelector("span");
    const migrateButton = $("#millennium-migrate-button");
    const siteButton = $("#millennium-site-button");
    const removeButton = $("#millennium-remove-button");

    const labels = {
      checking: "Проверка…",
      steam_missing: "Steam не найден",
      steam_invalid: "Неверная папка Steam",
      millennium_missing: "Millennium не установлен",
      croclua_detected: "Обнаружен CrocLua",
      plugin_missing: "Плагин не установлен",
      update_available: `Обновление · ${info.bundledVersion || ""}`,
      ready: `Установлен · ${info.pluginVersion || info.bundledVersion || ""}`,
    };
    badge.textContent = labels[info.status] || "Неизвестный статус";
    badge.className = "millennium-plugin-badge";
    if (info.status === "ready") badge.classList.add("ready");
    else if (["plugin_missing", "update_available", "croclua_detected"].includes(info.status)) badge.classList.add("warning");
    else if (["steam_missing", "steam_invalid", "millennium_missing"].includes(info.status)) badge.classList.add("error");
    else badge.classList.add("checking");

    const canInstall = Boolean(info.millenniumInstalled) && !["checking", "steam_invalid", "steam_missing"].includes(info.status);
    installButton.disabled = !canInstall;
    installButton.classList.toggle("hidden", info.status === "croclua_detected" || !["plugin_missing", "update_available"].includes(info.status));
    siteButton.classList.toggle("hidden", info.status !== "millennium_missing");
    removeButton.classList.toggle("hidden", !info.pluginInstalled);

    if (migrateButton) {
      const showMigrate = Boolean(info.legacyCrocluaFound) && Boolean(info.millenniumInstalled);
      migrateButton.classList.toggle("hidden", !showMigrate);
      const migrateLabel = migrateButton.querySelector("span");
      if (migrateLabel) {
        migrateLabel.textContent = info.pluginInstalled
          ? "Удалить старый CrocLua"
          : "Заменить CrocLua на Eclipse Manifest";
      }
    }

    if (installLabel) {
      installLabel.textContent = info.status === "ready"
        ? "Переустановить"
        : info.status === "update_available"
          ? "Обновить плагин"
          : "Установить плагин";
    }
  }

  function normalizeLoaderSource(raw) {
    return (raw === "v2" || raw === "desktop") ? "v2" : "v1";
  }

  // Отображение состояния загрузчика OpenSteamTool (вкладка манифестов и настройки)
  function renderLoaderInfo() {
    const info = state.lua.loaderInfo;
    const currentSource = normalizeLoaderSource(state.lua.loaderSource);

    // Выделение карточек в view-lua и view-settings
    $$(".loader-option").forEach((card) => {
      card.classList.toggle("active", normalizeLoaderSource(card.dataset.loaderSource) === currentSource);
    });

    const defaultLabel = currentSource === "v2" ? "Версия 2 (Альтернативная)" : "Версия 1 (Основная)";
    const activeLabel = info?.activeInSteamLabel || defaultLabel;
    const activeKind = info?.activeInSteam || currentSource;

    const manifestBadge = $("#manifest-loader-active-badge");
    const settingsBadge = $("#settings-loader-active-badge");

    [manifestBadge, settingsBadge].forEach((badge) => {
      if (!badge) return;
      badge.textContent = `В Steam: ${activeLabel}`;
      badge.className = "manifest-loader-badge";
      if (activeKind === "v1" || activeKind === "v2" || activeKind === "bundled" || activeKind === "desktop") {
        badge.classList.add("ready");
      } else if (activeKind === "custom" || activeKind === "mismatch") {
        badge.classList.add("warning");
      } else if (activeKind === "none") {
        badge.classList.add("error");
      } else {
        badge.classList.add("checking");
      }
    });
  }

  async function ensureSteamClosedForLoader() {
    try {
      const isRunning = await call("luatools_is_steam_running");
      if (!isRunning) return true;

      const shouldClose = await showModal(
        "Steam запущен",
        "Клиент Steam в данный момент запущен и блокирует файлы загрузчика OpenSteamTool.\n\nЗавершить процесс Steam сейчас, чтобы применить выбранную версию?",
        { confirm: true, confirmText: "Завершить Steam", cancelText: "Отмена", symbol: "⚠" }
      );
      if (!shouldClose) return false;

      toast("Завершаем процесс Steam…");
      const closeResult = await call("luatools_close_steam", { steamPath: state.lua.steamPath || null });
      if (closeResult && !closeResult.success) {
        toast(closeResult.message || "Не удалось завершить Steam", "error");
        return false;
      }
      return true;
    } catch (_) {
      return true;
    }
  }

  async function applyLoaderSource(source) {
    const valid = normalizeLoaderSource(source);

    const canProceed = await ensureSteamClosedForLoader();
    if (!canProceed) {
      renderLoaderInfo();
      return;
    }

    state.lua.loaderSource = valid;
    window.cgsStorage.setItem("manifestLoaderSource", valid);
    renderLoaderInfo();

    try {
      const result = await call("luatools_set_loader_source", {
        source: valid,
        steamPath: state.lua.steamPath || null,
      });

      if (result && !result.success) {
        toast(result.message || "Ошибка применения загрузчика", "error");
      } else {
        const verName = valid === "v2" ? "Версия 2 (Альтернативная)" : "Версия 1 (Основная)";
        toast(result?.message || `Выбрана ${verName}`, "success");
        await luaRefresh();

        const shouldRestart = await showModal(
          "Версия загрузчика обновлена",
          `В Steam установлена ${verName} OpenSteamTool.\n\nЗапустить клиент Steam сейчас?`,
          { confirm: true, confirmText: "Запустить Steam", cancelText: "Позже", symbol: "✓" }
        );
        if (shouldRestart) {
          const restartResult = await call("luatools_restart_steam", { steamPath: state.lua.steamPath || null });
          consumeResult(restartResult);
        }
      }
    } catch (error) {
      toast(errorText(error), "error");
    }
  }

  async function applyLoaderToSteam(triggerButton) {
    const canProceed = await ensureSteamClosedForLoader();
    if (!canProceed) return;

    if (triggerButton) setBusy(triggerButton, true, "Применяем…");
    try {
      const result = await call("luatools_apply_loader", {
        steamPath: state.lua.steamPath || null,
      });
      if (consumeResult(result)) {
        await luaRefresh();
        const shouldRestart = await showModal(
          "Загрузчик обновлен в Steam",
          `${result.message}\n\nЧтобы применить изменения, требуется запустить клиент Steam. Запустить сейчас?`,
          { confirm: true, confirmText: "Запустить Steam", cancelText: "Позже", symbol: "✓" }
        );
        if (shouldRestart) {
          const restartResult = await call("luatools_restart_steam", { steamPath: state.lua.steamPath || null });
          consumeResult(restartResult);
        }
      }
    } catch (error) {
      toast(errorText(error), "error");
    } finally {
      if (triggerButton) setBusy(triggerButton, false);
      renderLoaderInfo();
    }
  }

  const LOADER_POSTPONE_LAUNCH_COUNT = 5;

  function shouldPromptLoaderStartupUpdate() {
    try {
      const launchesLeftStr = window.cgsStorage.getItem("cgs-postpone-loader-launches");
      if (!launchesLeftStr) return true;
      const launchesLeft = Number(launchesLeftStr) || 0;
      if (launchesLeft > 0) {
        window.cgsStorage.setItem("cgs-postpone-loader-launches", String(launchesLeft - 1));
        return false;
      }
      window.cgsStorage.removeItem("cgs-postpone-loader-launches");
      return true;
    } catch (_) {
      return true;
    }
  }

  function postponeLoaderUpdate() {
    try {
      window.cgsStorage.setItem("cgs-postpone-loader-launches", String(LOADER_POSTPONE_LAUNCH_COUNT));
    } catch (_) {}
  }

  function clearLoaderPostpone() {
    try {
      window.cgsStorage.removeItem("cgs-postpone-loader-launches");
    } catch (_) {}
  }

  function closeLoaderUpdateModal() {
    const backdrop = $("#loader-update-backdrop");
    if (!backdrop) return;
    backdrop.classList.add("closing");
    setTimeout(() => {
      backdrop.classList.add("hidden");
      backdrop.classList.remove("closing");
    }, 190);
  }

  function promptLoaderUpdateModal(updateInfo) {
    if (!updateInfo) return;
    const isEn = window.cgsI18n?.language === "en";
    const backdrop = $("#loader-update-backdrop");
    const bundleNameEl = $("#loader-modal-bundle-name");
    const badgeEl = $("#loader-modal-bundle-badge");
    const fileListEl = $("#loader-modal-file-list");
    const cancelBtn = $("#loader-modal-cancel");
    const snoozeBtn = $("#loader-modal-snooze");
    const confirmBtn = $("#loader-modal-confirm");

    if (!backdrop || !fileListEl) return;

    // Имя комплекта по выбранному варианту
    const selectedVariant = updateInfo.selectedVariant || state.lua.loaderSource || "standard";
    const isV2 = selectedVariant === "compatibility" || selectedVariant === "v2" || selectedVariant === "desktop";
    if (bundleNameEl) {
      bundleNameEl.textContent = isV2
        ? (isEn ? "Версия 2 (Альтернативная)" : "Версия 2 (Альтернативная)")
        : (isEn ? "Версия 1 (Основная)" : "Версия 1 (Основная)");
    }

    if (badgeEl) {
      const isUpToDate = !updateInfo.updateAvailable;
      badgeEl.dataset.status = isUpToDate ? "synced" : "update";
      badgeEl.textContent = isUpToDate
        ? (isEn ? "Актуально" : "Актуально")
        : (isEn ? "Обновление" : "Обновление");
    }

    // Список файлов комплекта
    fileListEl.innerHTML = "";
    const activeVariant = updateInfo.variants?.find((v) => v.variant === selectedVariant)
      || updateInfo.variants?.find((v) => v.updateAvailable)
      || updateInfo.variants?.[0];

    const files = activeVariant?.files || [];
    if (files.length === 0) {
      const emptyItem = document.createElement("div");
      emptyItem.className = "loader-file-item";
      emptyItem.textContent = isEn ? "No files detected" : "Файлы не обнаружены";
      fileListEl.appendChild(emptyItem);
    } else {
      // Размер DLL в мегабайтах; null — файл отсутствует
      const formatDllSize = (bytes) => {
        if (bytes === null || bytes === undefined) {
          return isEn ? "missing" : "отсутствует";
        }
        if (bytes === 0) return isEn ? "0 MB" : "0 МБ";
        return (bytes / 1024 / 1024).toFixed(2) + (isEn ? " MB" : " МБ");
      };

      files.forEach((file) => {
        const item = document.createElement("div");
        item.className = "loader-file-item";

        const nameSpan = document.createElement("span");
        nameSpan.className = "loader-file-name";
        nameSpan.textContent = file.path;

        const stateWrap = document.createElement("div");
        stateWrap.className = "loader-file-state";

        const oldSpan = document.createElement("span");
        oldSpan.className = "loader-file-size-old";
        oldSpan.innerHTML = `<small>${isEn ? "Current:" : "Текущий:"}</small><strong>${formatDllSize(file.currentBytes)}</strong>`;

        const arrow = document.createElement("span");
        arrow.className = "loader-file-size-arrow";
        arrow.textContent = "→";

        const newSpan = document.createElement("span");
        newSpan.className = "loader-file-size-new";
        if (file.bytes == null || (file.currentBytes != null && file.currentBytes !== file.bytes)) {
          newSpan.classList.add("highlight");
        }
        const targetLabel = file.bytes == null
          ? (isEn ? "new version" : "новая версия")
          : formatDllSize(file.bytes);
        newSpan.innerHTML = `<small>${isEn ? "New:" : "Новый:"}</small><strong>${targetLabel}</strong>`;

        stateWrap.appendChild(oldSpan);
        stateWrap.appendChild(arrow);
        stateWrap.appendChild(newSpan);

        item.appendChild(nameSpan);
        item.appendChild(stateWrap);
        fileListEl.appendChild(item);
      });
    }

    backdrop.classList.remove("hidden", "closing");

    if (cancelBtn) {
      cancelBtn.onclick = () => closeLoaderUpdateModal();
    }

    if (snoozeBtn) {
      snoozeBtn.onclick = () => {
        postponeLoaderUpdate();
        closeLoaderUpdateModal();
        toast(isEn ? "Library update postponed for 5 launches" : "Обновление библиотек отложено на 5 запусков");
      };
    }

    if (confirmBtn) {
      confirmBtn.onclick = async () => {
        setBusy(confirmBtn, true, isEn ? "Updating…" : "Обновление…");
        try {
          const ok = await performLoaderUpdate(selectedVariant);
          if (ok) {
            closeLoaderUpdateModal();
          }
        } finally {
          setBusy(confirmBtn, false);
        }
      };
    }
  }

  async function performLoaderUpdate(variant) {
    const isEn = window.cgsI18n?.language === "en";

    const canProceed = await ensureSteamClosedForLoader();
    if (!canProceed) return false;

    toast(isEn ? "Updating OpenSteamTool libraries…" : "Обновление библиотек OpenSteamTool…");
    try {
      const result = await call("luatools_update_loader", {
        steamPath: state.lua.steamPath || null,
        variant: variant || state.lua.loaderSource || null,
      });

      if (result && !result.success) {
        toast(result.message || (isEn ? "Failed to update libraries" : "Не удалось обновить библиотеки"), "error");
        return false;
      }

      clearLoaderPostpone();
      $("#loader-update-banner")?.classList.add("hidden");
      if (state.lua.loaderUpdate) {
        state.lua.loaderUpdate.updateAvailable = false;
      }

      closeLoaderUpdateModal();

      toast(result?.message || (isEn ? "OpenSteamTool libraries updated successfully" : "Библиотеки OpenSteamTool успешно обновлены"), "success");
      await luaRefresh();

      const shouldRestart = await showModal(
        isEn ? "Libraries updated" : "Библиотеки обновлены",
        isEn
          ? "OpenSteamTool libraries were successfully updated in Steam.\n\nLaunch Steam client now?"
          : "Библиотеки OpenSteamTool успешно обновлены в Steam.\n\nЗапустить клиент Steam сейчас?",
        {
          confirm: true,
          confirmText: isEn ? "Launch Steam" : "Запустить Steam",
          cancelText: isEn ? "Later" : "Позже",
          symbol: "✓",
        }
      );
      if (shouldRestart) {
        const restartResult = await call("luatools_restart_steam", { steamPath: state.lua.steamPath || null });
        consumeResult(restartResult);
      }
      return true;
    } catch (error) {
      toast(errorText(error), "error");
      return false;
    }
  }

  async function checkLoaderDllUpdates(interactive = false, force = false) {
    if (state.lua.loaderChecking) return null;
    state.lua.loaderChecking = true;
    const isEn = window.cgsI18n?.language === "en";

    const syncBtn = $("#manifest-loader-sync-btn");
    const settingsSyncBtn = $("#settings-loader-sync-btn");
    if (interactive) {
      if (syncBtn) setBusy(syncBtn, true, isEn ? "Checking…" : "Проверка…");
      if (settingsSyncBtn) setBusy(settingsSyncBtn, true, isEn ? "Checking…" : "Проверка…");
    }

    try {
      const updateInfo = await call("luatools_check_loader_updates", {
        steamPath: state.lua.steamPath || null,
        force,
      });
      state.lua.loaderUpdate = updateInfo;

      const banner = $("#loader-update-banner");
      if (banner) {
        banner.classList.toggle("hidden", !updateInfo?.updateAvailable);
      }

      if (interactive) {
        if (updateInfo?.updateAvailable) {
          promptLoaderUpdateModal(updateInfo);
        } else {
          toast(isEn ? "You already have the latest libraries installed" : "У вас уже установлены актуальные библиотеки", "info");
        }
      }

      return updateInfo;
    } catch (error) {
      const msg = errorText(error);
      log(`Проверка обновлений библиотек OpenSteamTool: ${msg}`, "warn");
      if (interactive) {
        toast(`${isEn ? "Failed to check library updates" : "Не удалось проверить обновления библиотек"}: ${msg}`, "error");
      }
      return null;
    } finally {
      state.lua.loaderChecking = false;
      if (syncBtn) setBusy(syncBtn, false);
      if (settingsSyncBtn) setBusy(settingsSyncBtn, false);
    }
  }

  async function testLoaderUpdate(triggerButton) {
    const isEn = window.cgsI18n?.language === "en";
    if (triggerButton) setBusy(triggerButton, true, isEn ? "Testing…" : "Тест…");

    try {
      let info = null;
      try {
        info = await call("luatools_check_loader_updates", {
          steamPath: state.lua.steamPath || null,
          force: true,
        });
      } catch (err) {
        log(`Проверка обновлений библиотек для теста: ${err}`, "info");
      }

      const selectedVariant = state.lua.loaderSource || "v1";

      // Нет данных бэкенда — демонстрационный список библиотек
      if (!info || !info.variants || !info.variants.length) {
        info = {
          selectedVariant,
          updateAvailable: true,
          variants: [
            {
              variant: "v1",
              name: isEn ? "Version 1 (Primary)" : "Версия 1 (Основная)",
              available: true,
              updateAvailable: true,
              status: "update",
              files: [
                { path: "OpenSteamTool.dll", bytes: 1583104, currentBytes: 1515520, status: "changed" },
                { path: "dwmapi.dll", bytes: 114688, currentBytes: 112640, status: "changed" },
                { path: "xinput1_4.dll", bytes: 122880, currentBytes: null, status: "missing" },
              ],
            },
            {
              variant: "v2",
              name: isEn ? "Version 2 (Alternative)" : "Версия 2 (Альтернативная)",
              available: true,
              updateAvailable: true,
              status: "update",
              files: [
                { path: "bin/OpenSteamTool.dll", bytes: 1782579, currentBytes: 1720320, status: "changed" },
                { path: "bin/dwmapi.dll", bytes: 114688, currentBytes: 112640, status: "changed" },
              ],
            },
          ],
        };
      } else {
        // Клон: модальное окно принудительно в режиме обновления
        info = JSON.parse(JSON.stringify(info));
        info.updateAvailable = true;

        // В деморежиме различаем размеры — для проверки подсветки
        info.variants?.forEach((v) => {
          v.updateAvailable = true;
          let hasDiff = false;
          v.files?.forEach((f) => {
            if (f.currentBytes !== f.bytes) {
              hasDiff = true;
            }
          });
          if (!hasDiff && v.files && v.files.length > 0) {
            v.files[0].currentBytes = Math.round(v.files[0].bytes * 0.95);
          }
        });
      }

      state.lua.loaderUpdate = info;
      promptLoaderUpdateModal(info);
    } finally {
      if (triggerButton) setBusy(triggerButton, false);
    }
  }

  async function downloadMillenniumInstaller() {
    const button = $("#millennium-site-button");
    setBusy(button, true, "Устанавливаем…");
    try {
      const result = await call("millennium_install_bundled", { steamPath: state.lua.steamPath || null });
      if (!consumeResult(result)) return;
      await luaRefresh();
      if (!state.lua.millennium?.pluginInstalled) {
        const installPlugin = await showModal(
          "Millennium установлен",
          "Файлы размещены прямо в папке Steam. Установить Eclipse Manifest сейчас? После этого потребуется полностью перезапустить Steam.",
          { confirm: true, confirmText: "Установить плагин", cancelText: "Позже", symbol: "🌒" },
        );
        if (installPlugin) await installMillenniumPlugin();
      }
    } catch (error) {
      toast(errorText(error), "error");
    } finally {
      setBusy(button, false);
      renderMillenniumStatus();
    }
  }

  async function offerMillenniumInstall() {
    const accepted = await showModal(
      "Для плагина нужен Millennium",
      "Eclipse Manifest установит встроенные файлы Millennium напрямую в выбранную папку Steam — без отдельного установщика. После установки потребуется полностью перезапустить Steam.",
      { confirm: true, confirmText: "Установить", cancelText: "Позже", symbol: "M" },
    );
    if (accepted) await downloadMillenniumInstaller();
  }

  const CROCLUA_POSTPONE_LAUNCH_COUNT = 5;

  function shouldPromptCrocluaMigration() {
    try {
      const launchesLeftStr = window.cgsStorage.getItem("cgs-postpone-croclua-launches");
      if (!launchesLeftStr) return true;
      const launchesLeft = Number(launchesLeftStr) || 0;
      if (launchesLeft > 0) {
        window.cgsStorage.setItem("cgs-postpone-croclua-launches", String(launchesLeft - 1));
        return false;
      }
      window.cgsStorage.removeItem("cgs-postpone-croclua-launches");
      return true;
    } catch (_) {
      return true;
    }
  }

  function postponeCrocluaMigration() {
    try {
      window.cgsStorage.setItem("cgs-postpone-croclua-launches", String(CROCLUA_POSTPONE_LAUNCH_COUNT));
    } catch (_) {}
  }

  function clearCrocluaPostpone() {
    try {
      window.cgsStorage.removeItem("cgs-postpone-croclua-launches");
    } catch (_) {}
  }

  async function offerCrocluaMigration() {
    const accepted = await showModal(
      "Обнаружен старый плагин CrocLua",
      "В Millennium обнаружен плагин CrocLua (папка crocodile-manifest). Хотите удалить его и установить обновлённый Eclipse Manifest?",
      { confirm: true, confirmText: "Заменить на Eclipse Manifest", cancelText: "Оставить", symbol: "🌒" },
    );
    if (accepted) {
      clearCrocluaPostpone();
      await migrateCrocluaToEclipseManifest();
    } else {
      postponeCrocluaMigration();
      toast("Напоминание о CrocLua отложено на 5 перезапусков");
    }
  }

  async function migrateCrocluaToEclipseManifest() {
    const info = state.lua.millennium || {};
    const onlyRemove = Boolean(info.pluginInstalled);
    const button = $("#millennium-migrate-button");
    if (button) setBusy(button, true, onlyRemove ? "Удаляем…" : "Заменяем…");
    try {
      const result = onlyRemove
        ? await call("millennium_remove_legacy_croclua", { steamPath: state.lua.steamPath || null })
        : await call("millennium_migrate_from_croclua", { steamPath: state.lua.steamPath || null });
      if (!consumeResult(result)) return;
      clearCrocluaPostpone();
      await luaRefresh();
      const restart = await showModal(
        onlyRemove ? "CrocLua удалён" : "Eclipse Manifest установлен",
        onlyRemove
          ? "Старый плагин CrocLua удалён из Millennium. Перезапустить Steam сейчас?"
          : "Старый CrocLua удалён, Eclipse Manifest успешно установлен. Перезапустить Steam сейчас?",
        { confirm: true, confirmText: "Перезапустить Steam", cancelText: "Позже", symbol: "🌒" },
      );
      if (restart) {
        const restartResult = await call("luatools_restart_steam", { steamPath: state.lua.steamPath || null });
        consumeResult(restartResult);
      }
    } catch (error) {
      toast(errorText(error), "error");
    } finally {
      if (button) setBusy(button, false);
      renderMillenniumStatus();
    }
  }

  // Мгновенный показ последнего известного списка, пока идёт свежий запрос
  function primeLuaFromCache() {
    if (state.lua.loaded) return;
    const cached = loadStoredLuaStatus();
    if (!cached) return;
    applyLuaStatus(cached, { fromCache: true });
    luaLoadNames();
  }

  function applyLuaStatus(status, { fromCache = false, render = true } = {}) {
    if (!status) return;
    state.lua.steamPath = status.steamPath || state.lua.steamPath || "";
    state.lua.luaFolder = status.luaFolder || "";
    state.lua.loaderStatus = status.loaderStatus || "unknown";
    state.lua.loaderName = status.loaderName || "";
    state.lua.loaderIssue = status.loaderIssue || "";
    state.lua.games = Array.isArray(status.games) ? status.games : [];
    state.lua.externalCount = Number(status.externalCount) || 0;
    state.lua.loaded = true;
    if (state.lua.steamPath) window.cgsStorage.setItem("luaSteamPath", state.lua.steamPath);
    if (render) renderLuaStatus();
    if (fromCache) window.cgsPerf?.log("Список игр показан из кэша");
  }

  async function fetchLuaStatus() {
    window.cgsPerf?.mark("lua-status");
    window.cgsPerf?.setPhase("запрос статуса");
    try {
      const [status, millennium, loaderInfo] = await Promise.all([
        call("luatools_status", { steamPath: state.lua.steamPath || null, includeExternal: state.lua.showExternal }),
        call("millennium_plugin_status", { steamPath: state.lua.steamPath || null }),
        call("luatools_get_loader_info", { steamPath: state.lua.steamPath || null }).catch(() => null),
      ]);
      window.cgsPerf?.measure("Статус: три команды", "lua-status");
      if (window.cgsPerf?.enabled) {
        window.cgsPerf.log(`luatools_status на бэкенде: ${Number(status?.elapsedMs) || 0} мс`);
      }
      applyLuaStatus(status, { render: false });
      state.lua.millennium = millennium || state.lua.millennium;
      if (loaderInfo) {
        state.lua.loaderInfo = loaderInfo;
        state.lua.loaderSource = loaderInfo.loaderSource || state.lua.loaderSource;
      }
      saveStoredLuaStatus(status);
      luaStatusFetchedAt = performance.now();
      // Один рендер после применения статуса, Millennium и сведений о загрузчике
      renderLuaStatus();
      luaLoadNames();
      window.cgsPerf?.measure("Открытие вкладки Eclipse Manifest", "lua-open");
      if (window.cgsPerf?.enabled) {
        window.cgsPerf.log(`Игр в списке: ${state.lua.games.length}, сторонних: ${state.lua.externalCount}`);
        window.cgsPerf.report().slice(0, 5).forEach((entry) => {
          window.cgsPerf.log(`Команда ${entry.command}: ${entry.avg} мс (макс ${entry.max}, вызовов ${entry.count})`);
        });
      }
      if (millennium?.status === "millennium_missing" && !state.lua.millenniumPrompted) {
        state.lua.millenniumPrompted = true;
        await offerMillenniumInstall();
      } else if (millennium?.legacyCrocluaFound && !state.lua.crocluaPrompted) {
        state.lua.crocluaPrompted = true;
        if (shouldPromptCrocluaMigration()) {
          await offerCrocluaMigration();
        }
      }
    } catch (error) {
      log(`LuaTools: ошибка статуса — ${errorText(error)}`, "error");
    }
  }

  async function luaRefresh(options = {}) {
    // Автоматическое переключение вкладки не чаще раза в 10 секунд,
    // явные действия (кнопки, установка) всегда обновляют список
    const force = options?.force !== false;
    if (!force && state.lua.loaded && performance.now() - luaStatusFetchedAt < LUA_STATUS_TTL_MS) {
      window.cgsPerf?.log("Статус пропущен: данные свежие");
      return;
    }
    if (luaStatusInFlight) {
      // Пока запрос идёт, пользователь мог переключить фильтр — повторяем после него
      luaRefreshPending = true;
      return luaStatusInFlight;
    }
    luaStatusInFlight = fetchLuaStatus().finally(() => {
      luaStatusInFlight = null;
      if (luaRefreshPending) {
        luaRefreshPending = false;
        luaRefresh();
      }
    });
    return luaStatusInFlight;
  }

  let millenniumStatusRefreshing = false;

  async function refreshMillenniumStatus() {
    if (millenniumStatusRefreshing || !invoke) return;
    millenniumStatusRefreshing = true;
    try {
      const millennium = await call("millennium_plugin_status", { steamPath: state.lua.steamPath || null });
      state.lua.millennium = millennium || state.lua.millennium;
      renderMillenniumStatus();
    } catch (_) {
      // Ошибку покажет следующий полный luaRefresh
    } finally {
      millenniumStatusRefreshing = false;
    }
  }

  async function luaInstall(paths) {
    const files = (paths || []).filter(Boolean);
    if (!files.length) return;
    log(`Eclipse Manifest: добавление файлов — ${files.length}`, "system");
    try {
      const result = await call("luatools_install", {
        paths: files,
        steamPath: state.lua.steamPath || null,
        autoUpdate: $("#lua-auto-update").checked,
      });
      if (consumeResult(result)) {
        await luaRefresh();
        await showModal("Игра добавлена", "Файлы размещены в папках Steam. Нажмите «Перезапустить Steam», чтобы игра появилась в библиотеке.", { symbol: "✓" });
      }
    } catch (error) {
      log(`Ошибка добавления: ${errorText(error)}`, "error");
      toast(errorText(error), "error");
    }
  }

  async function luaBrowseFiles() {
    const button = $("#lua-browse-button");
    setBusy(button, true, "Открываем…");
    try {
      const files = await call("luatools_pick_files");
      if (files && files.length) await luaInstall(files);
    } catch (error) {
      toast(errorText(error), "error");
    } finally {
      setBusy(button, false);
    }
  }

  async function luaToggle(appid, enable) {
    try {
      const result = await call("luatools_toggle", { appid, enable, steamPath: state.lua.steamPath || null });
      if (consumeResult(result)) await luaRefresh();
    } catch (error) {
      toast(errorText(error), "error");
    }
  }

  async function luaRemove(appid, external = false) {
    // Для сторонней игры предупреждаем, что файл положил другой инструмент
    const note = external ? " Игра добавлена сторонним инструментом — Steam перестанет её видеть." : "";
    const accepted = await showModal("Удалить игру из загрузчика?", `Файл lua для AppID ${appid} будет удалён.${note} После этого перезапустите Steam.`, { confirm: true, confirmText: "Удалить", symbol: "↺" });
    if (!accepted) return;
    try {
      const result = await call("luatools_remove", { appid, steamPath: state.lua.steamPath || null });
      if (consumeResult(result)) await luaRefresh();
    } catch (error) {
      toast(errorText(error), "error");
    }
  }

  async function luaRestartSteam() {
    const accepted = await showModal("Перезапустить Steam?", "Клиент Steam будет закрыт и запущен заново, чтобы применить изменения. Незавершённые загрузки могут прерваться.", { confirm: true, confirmText: "Перезапустить", symbol: "↻" });
    if (!accepted) return;
    const button = $("#lua-restart-button");
    setBusy(button, true, "Перезапуск…");
    try {
      const result = await call("luatools_restart_steam", { steamPath: state.lua.steamPath || null });
      consumeResult(result);
    } catch (error) {
      toast(errorText(error), "error");
    } finally {
      setBusy(button, false);
    }
  }

  async function installMillenniumPlugin() {
    if (!state.lua.millennium?.millenniumInstalled) {
      await offerMillenniumInstall();
      return;
    }
    const button = $("#millennium-install-button");
    setBusy(button, true, state.lua.millennium.pluginInstalled ? "Обновляем…" : "Устанавливаем…");
    try {
      const result = await call("millennium_install_plugin", { steamPath: state.lua.steamPath || null });
      if (!consumeResult(result)) return;
      await luaRefresh();
      const restart = await showModal(
        "Eclipse Manifest установлен",
        "Плагин размещён в папке Millennium. Перезапустить Steam сейчас, чтобы он появился в настройках плагинов?",
        { confirm: true, confirmText: "Перезапустить Steam", cancelText: "Позже", symbol: "🌒" },
      );
      if (restart) {
        const restartResult = await call("luatools_restart_steam", { steamPath: state.lua.steamPath || null });
        consumeResult(restartResult);
      }
    } catch (error) {
      toast(errorText(error), "error");
    } finally {
      setBusy(button, false);
      renderMillenniumStatus();
    }
  }

  async function removeMillenniumPlugin() {
    const accepted = await showModal(
      "Удалить Eclipse Manifest?",
      "Папка плагина будет полностью удалена из Millennium. Сохранённая история операций останется на компьютере и будет доступна после повторной установки.",
      { confirm: true, confirmText: "Удалить плагин", cancelText: "Отмена", symbol: "↺" },
    );
    if (!accepted) return;

    const button = $("#millennium-remove-button");
    setBusy(button, true, "Удаляем…");
    try {
      const result = await call("millennium_remove_plugin", { steamPath: state.lua.steamPath || null });
      if (!consumeResult(result)) return;
      await luaRefresh();
      const restart = await showModal(
        "Eclipse Manifest удалён",
        "Перезапустить Steam сейчас, чтобы полностью выгрузить плагин?",
        { confirm: true, confirmText: "Перезапустить Steam", cancelText: "Позже", symbol: "✓" },
      );
      if (restart) {
        const restartResult = await call("luatools_restart_steam", { steamPath: state.lua.steamPath || null });
        consumeResult(restartResult);
      }
    } catch (error) {
      toast(errorText(error), "error");
    } finally {
      setBusy(button, false);
      renderMillenniumStatus();
    }
  }

  const secretSaveVersions = {};
  function saveApiSecret(service, input) {
    clearTimeout(secretSaveTimers[service]); delete secretSaveTimers[service];
    const value = input.value.trim(); const version = (secretSaveVersions[service] || 0) + 1;
    secretSaveVersions[service] = version;
    return window.cgsStorage.setSecret(service, value).then(configured => {
      if (version !== secretSaveVersions[service] || input.value.trim() !== value) return;
      state.lua[service + "Key"] = configured ? "stored" : "";
      input.value = "";
      input.placeholder = configured ? "Ключ сохранён в Windows. Введите новый для замены" : "Ключ не указан";
      service === "hubcap" ? updateHubcapKeyStatus() : updateRyuuKeyStatus();
    }).catch(error => { toast("Ключ не сохранён: " + errorText(error), "error"); throw error; });
  }
  window.cgsFlushSecrets = async () => {
    for (const service of Object.keys(secretSaveTimers)) {
      const input = document.querySelector(service === "hubcap" ? "#hubcap-key" : "#ryuu-key");
      if (input) await saveApiSecret(service, input);
    }
  };
  let luaCoverObserver = null;
  let luaRenderToken = 0;
  // Пока список рисуется порциями, новый проход не должен начинать всё заново
  let luaRenderInProgress = false;
  let luaRenderPending = false;

  function applyDrmBadge(badge, info) {
    const allowedKinds = new Set(["denuvo", "launcher", "steam", "third-party", "unknown"]);
    const kind = allowedKinds.has(info?.kind) ? info.kind : "unknown";
    badge.className = `lua-drm-badge ${kind}`;
    const text = drmText(info);
    badge.textContent = text.label;
    badge.title = text.notice;
    // Бейдж живёт в списке с data-i18n-skip, поэтому переводим его точечно
    window.cgsI18n?.translate(badge);
  }

  // Подписи и подсказки собираем на русском: английский вариант подставит i18n
  const DRM_FEATURES = {
    denuvo: { label: "Denuvo", notice: "В игре используется защита Denuvo." },
    ea_app: { label: "EA App", notice: "Для запуска требуется приложение EA app." },
    ea_account: { label: "Аккаунт EA", notice: "Для запуска требуется аккаунт EA." },
    ubisoft: { label: "Ubisoft Connect", notice: "Для запуска требуется Ubisoft Connect." },
    rockstar: { label: "Rockstar", notice: "Для запуска требуется аккаунт Rockstar Games." },
    steam_drm: { label: "Steam DRM", notice: "В игре используется защита Steam DRM." },
    third_party_drm: { label: "Сторонняя DRM", notice: "Steam сообщает о сторонней защите без подробностей." },
    third_party_account: { label: "Сторонний аккаунт", notice: "Для запуска требуется сторонний аккаунт." },
  };

  // Метки защиты приходят кодами, поэтому подсказка остаётся на выбранном языке
  function drmText(info) {
    const codes = Array.isArray(info?.features) ? info.features.filter((code) => DRM_FEATURES[code]) : [];
    if (!codes.length) {
      return {
        label: info?.label || "Не указано",
        notice: info?.notice || "Steam не указывает сведения о защите для этой игры.",
      };
    }
    return {
      label: codes.map((code) => DRM_FEATURES[code].label).join(" + "),
      notice: [...new Set(codes.map((code) => DRM_FEATURES[code].notice))].join(" "),
    };
  }

  function renderSearchDropdown(results) {
    const dropdown = $("#lua-search-dropdown");
    dropdown.replaceChildren();
    if (!results.length) {
      const empty = document.createElement("div");
      empty.className = "lua-search-empty";
      empty.textContent = "Ничего не найдено";
      dropdown.append(empty);
      dropdown.classList.remove("hidden");
      return;
    }
    results.forEach((game) => {
      const row = document.createElement("button");
      row.className = "lua-search-item";
      row.type = "button";
      const img = document.createElement("img");
      img.loading = "lazy";
      img.src = game.headerImage || steamHeaderUrls(game.appid)[0];
      img.onerror = () => { img.style.visibility = "hidden"; };
      const copy = document.createElement("span");
      copy.className = "lua-search-copy";
      const name = document.createElement("strong");
      name.textContent = game.name;
      name.title = game.name;
      const id = document.createElement("code");
      id.textContent = `AppID ${game.appid}`;
      copy.append(name, id);
      const get = document.createElement("span");
      get.className = "lua-search-get";
      get.textContent = "Получить";
      row.append(img, copy, get);
      row.addEventListener("click", () => luaGet(game.appid, game.name));
      dropdown.append(row);
    });
    dropdown.classList.remove("hidden");
  }

  function luaDropdownMessage(text) {
    const dropdown = $("#lua-search-dropdown");
    dropdown.replaceChildren();
    const item = document.createElement("div");
    item.className = "lua-search-empty";
    item.textContent = text;
    dropdown.append(item);
    dropdown.classList.remove("hidden");
  }

  async function luaSearch(query) {
    const dropdown = $("#lua-search-dropdown");
    const q = String(query || "").trim();
    const hubcap = state.lua.service === "hubcap";
    const minLen = hubcap ? 3 : 2;
    if (q.length < minLen) {
      dropdown.classList.add("hidden");
      dropdown.replaceChildren();
      return;
    }
    if (hubcap && !state.lua.hubcapKey.trim()) {
      luaDropdownMessage("Укажите API-ключ HubCap в настройках");
      return;
    }
    if (!hubcap && !hasRyuuKey()) {
      luaDropdownMessage("Укажите свой API-ключ Ryuu в настройках");
      return;
    }
    $("#lua-search-spin").classList.remove("hidden");
    try {
      const results = hubcap
        ? await call("hubcap_search", { query: q })
        : await call("ryuu_search", { query: q });
      renderSearchDropdown(results || []);
    } catch (error) {
      dropdown.replaceChildren();
      const err = document.createElement("div");
      err.className = "lua-search-empty";
      err.textContent = errorText(error);
      dropdown.append(err);
      dropdown.classList.remove("hidden");
    } finally {
      $("#lua-search-spin").classList.add("hidden");
    }
  }

  async function luaGet(appid, name, options = {}) {
    // refresh — перекачать манифесты уже добавленной игры по выбранному сервису
    const refresh = Boolean(options.refresh);
    $("#lua-search-dropdown").classList.add("hidden");
    const label = name || `AppID ${appid}`;
    const hubcap = state.lua.service === "hubcap";
    log(`${refresh ? "Обновление манифестов" : "Получение"} из ${hubcap ? "HubCap" : "генератора"}: ${label} (${appid})`, "system");
    toast(refresh ? "Обновляем манифесты…" : "Загрузка манифестов…");
    try {
      const result = hubcap
        ? await call("hubcap_get", {
            appid: String(appid),
            steamPath: state.lua.steamPath || null,
            autoUpdate: $("#lua-auto-update").checked,
          })
        : await call("ryuu_get", {
            appid: String(appid),
            steamPath: state.lua.steamPath || null,
            autoUpdate: $("#lua-auto-update").checked,
          });
      if (consumeResult(result)) {
        if (!state.lua.names[appid] && name) state.lua.names[appid] = name;
        await luaRefresh();
        await showModal(
          refresh ? "Манифесты обновлены" : "Игра получена",
          refresh
            ? `Манифесты для ${label} перекачаны через ${hubcap ? "HubCap" : "Ryuu"}. Перезапустите Steam, чтобы применить изменения.`
            : `${label} добавлена. Нажмите «Перезапустить Steam», чтобы она появилась в библиотеке.`,
          { symbol: "✓" },
        );
      }
    } catch (error) {
      log(`Ошибка ${refresh ? "обновления" : "получения"}: ${errorText(error)}`, "error");
      toast(errorText(error), "error");
    } finally {
      if (hubcap) refreshHubcapUsage();
    }
  }

  // Кнопка на карточке игры: перекачать манифесты выбранным сервисом
  async function luaRefreshManifests(appid, button) {
    setBusy(button, true, "Обновляем…");
    try {
      await luaGet(appid, state.lua.names[appid] || "", { refresh: true });
    } finally {
      setBusy(button, false);
    }
  }


  function applyManifestService(service) {
    const svc = service === "hubcap" ? "hubcap" : "ryuu";
    state.lua.service = svc;
    $$(".svc-option").forEach((button) => button.classList.toggle("active", button.dataset.service === svc));
    $("#svc-key-block")?.classList.toggle("hidden", svc !== "hubcap");
    $("#ryuu-key-block")?.classList.toggle("hidden", svc !== "ryuu");
    $("#hubcap-limit-badge")?.classList.toggle("hidden", svc !== "hubcap");
    window.cgsStorage.setItem("manifestService", svc);
    const input = $("#lua-search-input");
    if (input) input.placeholder = svc === "hubcap"
      ? "Поиск через HubCap — название или AppID…"
      : "Введите название игры или AppID…";
    // Ошибка лимита HubCap не должна «висеть» после переключения на Ryuu
    if (svc !== "hubcap") state.lua.hubcapUsageError = "";
    renderHubcapUsage();
    if (svc === "hubcap" && state.lua.hubcapKey.trim()) refreshHubcapUsage();
  }

  function updateHubcapKeyStatus() {
    const status = $("#hubcap-key-status");
    if (status) {
      const hasKey = Boolean(state.lua.hubcapKey.trim());
      status.textContent = hasKey ? "Ключ активен" : "Ключ не указан";
      status.classList.toggle("active", hasKey);
    }
  }

  function hasRyuuKey() {
    return state.lua.ryuuKeySource === "crocodile" || Boolean(state.lua.ryuuKey.trim());
  }

  function applyRyuuKeySource(source) {
    const selected = source === "custom" ? "custom" : "crocodile";
    const builtin = selected === "crocodile";
    state.lua.ryuuKeySource = selected;
    $$('input[name="ryuu-key-source"]').forEach((input) => {
      input.checked = input.value === selected;
      input.closest(".ryuu-key-source-option")?.classList.toggle("active", input.checked);
    });
    $("#ryuu-custom-key-fields")?.classList.toggle("hidden", builtin);
    if ($("#ryuu-key")) $("#ryuu-key").disabled = builtin;
    const help = $("#ryuu-key-help");
    if (help) help.textContent = builtin
      ? "Общий ключ встроен в программу. Его доступность зависит от Crocodile Gena Studio."
      : "Свой ключ хранится в защищённом хранилище Windows. Переключение режима не удаляет его.";
    window.cgsStorage.setItem("ryuuKeySource", selected);
    updateRyuuKeyStatus();
  }

  function updateRyuuKeyStatus() {
    const status = $("#ryuu-key-status");
    if (status) {
      const hasKey = hasRyuuKey();
      status.textContent = state.lua.ryuuKeySource === "crocodile"
        ? "Встроенный ключ"
        : hasKey ? "Свой ключ указан" : "Ключ не указан";
      status.classList.toggle("active", hasKey);
    }
  }

  function renderHubcapUsage() {
    const usage = state.lua.hubcapUsage || { dailyUsage: 0, dailyLimit: 25, remaining: 25 };
    const unlimited = usage.dailyLimit >= 999999;
    const limit = unlimited ? "∞" : usage.dailyLimit;
    const remaining = unlimited ? "∞" : usage.remaining;
    const badge = $("#hubcap-limit-badge");
    const status = $("#hubcap-usage-status");
    if (badge) {
      badge.textContent = state.lua.hubcapUsageError
        ? "HubCap: лимит недоступен"
        : `HubCap: ${usage.dailyUsage}/${limit} · осталось ${remaining}`;
      badge.classList.toggle("error", Boolean(state.lua.hubcapUsageError));
    }
    const usedEl = $("#hubcap-usage-used");
    if (usedEl) usedEl.textContent = `${usage.dailyUsage}/${limit}`;
    const remEl = $("#hubcap-usage-remaining");
    if (remEl) remEl.textContent = String(remaining);
    if (status) {
      status.classList.toggle("error", Boolean(state.lua.hubcapUsageError));
      status.textContent = state.lua.hubcapUsageError
        || (state.lua.hubcapUsageLoading
          ? "Обновление данных HubCap…"
          : state.lua.hubcapKey.trim()
            ? "Данные HubCap · обновляются каждые 30 секунд"
            : "Добавьте ключ для синхронизации");
    }
    const progressBar = $("#hubcap-progress-bar");
    if (progressBar) {
      const pct = (usage.dailyLimit > 0 && !unlimited)
        ? Math.min(100, Math.max(0, Math.round((usage.dailyUsage / usage.dailyLimit) * 100)))
        : 0;
      progressBar.style.width = `${pct}%`;
    }
  }


  async function refreshHubcapUsage() {
    // Запрашиваем лимит HubCap только при выборе этого источника
    if (!invoke || state.lua.hubcapUsageLoading || state.lua.service !== "hubcap") return;
    if (!state.lua.hubcapKey.trim()) {
      state.lua.hubcapUsage = { dailyUsage: 0, dailyLimit: 25, remaining: 25 };
      state.lua.hubcapUsageError = "";
      renderHubcapUsage();
      return;
    }
    state.lua.hubcapUsageLoading = true;
    state.lua.hubcapUsageError = "";
    renderHubcapUsage();
    try {
      state.lua.hubcapUsage = await call("hubcap_usage", {});
    } catch (error) {
      state.lua.hubcapUsageError = errorText(error);
    } finally {
      state.lua.hubcapUsageLoading = false;
      renderHubcapUsage();
    }
  }


    return {
      primeLuaFromCache, luaRefresh, refreshMillenniumStatus, renderLoaderInfo,
      applyManifestService, updateHubcapKeyStatus, hasRyuuKey, applyRyuuKeySource,
      updateRyuuKeyStatus, renderHubcapUsage, refreshHubcapUsage,
      luaOpenDetail, luaBrowseFiles, luaRestartSteam, luaToggle, luaRemove,
      downloadMillenniumInstaller, offerMillenniumInstall, migrateCrocluaToEclipseManifest,
      installMillenniumPlugin, removeMillenniumPlugin, luaInstall, luaSearch,
      applyLoaderSource, applyLoaderToSteam, checkLoaderDllUpdates, testLoaderUpdate,
      promptLoaderUpdateModal, closeLoaderUpdateModal, performLoaderUpdate,
      shouldPromptLoaderStartupUpdate, saveApiSecret,
    };
    },
  };
})();
