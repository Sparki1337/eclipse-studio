(() => {
  "use strict";

  // storage — защищённое хранилище window.cgsStorage (DPAPI, миграция из localStorage)
  // Только миграция читает старое хранилище. После подтверждения данные живут в Windows
  const rawInvoke = window.__TAURI__?.core?.invoke;
  const values = new Map();
  const configured = new Map();
  let pending = Promise.resolve();
  const persistenceErrors = new Map();
  const secrets = new Set(["hubcapKey", "ryuuKey"]);
  function report(error) {
    window.dispatchEvent(new CustomEvent("cgs:storage-error", { detail: String(error?.message || error) }));
  }
  function enqueue(key, action) {
    const next = pending.then(action).then(value => {
      persistenceErrors.delete(key);
      return value;
    });
    pending = next.catch(error => { persistenceErrors.set(key, error); report(error); });
    return next;
  }
  const storage = {
    getItem(key) { return values.get(String(key)) ?? null; },
    setItem(key, value) {
      key = String(key); value = String(value);
      if (secrets.has(key)) throw new Error("Для ключей используется защищённая команда");
      values.set(key, value);
      if (rawInvoke) enqueue(key, () => rawInvoke("state_apply", { changes: { [key]: value } }));
    },
    async setItemVerified(key, value) {
      key = String(key); value = String(value);
      if (secrets.has(key)) throw new Error("Для ключей используется защищённая команда");
      return enqueue(key, async () => {
        if (rawInvoke) await rawInvoke("state_apply", { changes: { [key]: value } });
        values.set(key, value);
      });
    },
    removeItem(key) {
      key = String(key); if (secrets.has(key)) throw new Error("Для ключей используется защищённая команда");
      values.delete(key); if (rawInvoke) enqueue(key, () => rawInvoke("state_apply", { changes: { [key]: null } }));
    },
    clear() { for (const key of [...values.keys()]) this.removeItem(key); },
    key(index) { return [...values.keys()][index] ?? null; },
    get length() { return values.size; },
    isSecretConfigured(service) { return configured.get(service + "Key") === true; },
    async setSecret(service, value) {
      if (!rawInvoke) throw new Error("Сохранение ключей доступно только в приложении Windows");
      const result = await enqueue(service + "Key", () => rawInvoke("state_set_secret", { service, value }));
      configured.set(service + "Key", result === true); return result;
    },
    async flush() {
      await pending;
      if (persistenceErrors.size) throw new Error("Не сохранены настройки: " + [...persistenceErrors.keys()].join(", ") + ". " + String(persistenceErrors.values().next().value));
    },
  };
  storage.ready = (async () => {
    const legacy = Object.create(null);
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i); legacy[key] = localStorage.getItem(key);
    }
    if (!rawInvoke) {
      // Предпросмотр не пишет ни настройки, ни секреты на диск браузера
      for (const [key, value] of Object.entries(legacy)) if (!secrets.has(key)) values.set(key, value);
      return;
    }
    const result = await rawInvoke("state_bootstrap", { legacy });
    if (!result?.migrationVerified || !result.values || !result.secretConfigured) throw new Error("Миграция не подтверждена. Старые данные сохранены; приложение не запущено.");
    for (const [key, value] of Object.entries(result.values)) if (!secrets.has(key)) values.set(key, String(value));
    for (const [key, value] of Object.entries(result.secretConfigured)) configured.set(key, value === true);
    // Не удаляем значение, изменённое другим окном за время миграции
    for (const [key, value] of Object.entries(legacy)) if (localStorage.getItem(key) === value) localStorage.removeItem(key);
  })();
  // Ошибка доступна загрузчику и не теряется в необработанном Promise
  storage.ready.catch(report);
  window.cgsStorage = storage;
})();
