(() => {
  "use strict";

  // api — обёртка над Tauri invoke: сброс хранилища до вызова и события cgs:request
  const rawInvoke = window.__TAURI__?.core?.invoke;
  // Остановка операции не зависит от записи несвязанных настроек или секретов.
  const immediateCommands = new Set([
    "files_cancel_download", "files_pause_download", "files_discard_download", "cancel_update",
  ]);
  async function invoke(command, args = {}) {
    if (!rawInvoke) throw new Error("Системный модуль недоступен. Запустите приложение Windows.");
    if (!immediateCommands.has(command)) {
      await window.cgsStorage.ready;
      if (/^(hubcap|ryuu)_/.test(command)) await window.cgsFlushSecrets?.();
      await window.cgsStorage.flush();
    }
    const id = crypto.randomUUID();
    window.dispatchEvent(new CustomEvent("cgs:request", { detail: { id, command, status: "running" } }));
    // Замеры: длительность каждой команды для отчёта window.cgsPerf.report()
    const startedAt = window.cgsPerf?.enabled ? performance.now() : 0;
    try {
      let result = await rawInvoke(command, args);
      if (result && typeof result === "object" && typeof result.success === "boolean") {
        const warnings = (result.logs || []).filter(line => String(line).trimStart().startsWith("⚠"));
        const skipped = [...new Set([...(result.skipped || []), ...(result.failed || []), ...warnings])];
        if (result.status === "partial" || (result.success && skipped.length)) {
          result = { ...result, success: false, status: "partial", skipped };
          if (!String(result.message || "").includes("частично")) result.message = "Выполнено частично. " + (result.message || "Проверьте список пропусков.");
        }
      }
      const status = result?.status || (result?.success === false ? ((result?.changed || result?.removed || result?.installedFiles?.length) ? "partial" : "failed") : "success");
      window.dispatchEvent(new CustomEvent("cgs:request", { detail: { id, command, status, message: result?.message || "", result } }));
      return result;
    } catch (error) {
      window.dispatchEvent(new CustomEvent("cgs:request", { detail: { id, command, status: String(error).includes("приостановлена") ? "paused" : String(error).includes("отменена") ? "cancelled" : "failed", message: String(error?.message || error) } }));
      throw error;
    } finally {
      if (startedAt) window.cgsPerf?.record?.(command, performance.now() - startedAt);
    }
  }
  window.cgsApi = { invoke };
})();
