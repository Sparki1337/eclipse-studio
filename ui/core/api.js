(() => {
  "use strict";
  const rawInvoke = window.__TAURI__?.core?.invoke;
  async function invoke(command, args = {}) {
    if (!rawInvoke) throw new Error("Системный модуль недоступен. Запустите приложение Windows.");
    await window.cgsStorage.ready;
    if (/^(hubcap|ryuu)_/.test(command)) await window.cgsFlushSecrets?.();
    await window.cgsStorage.flush();
    const id = crypto.randomUUID();
    window.dispatchEvent(new CustomEvent("cgs:request", { detail: { id, command, status: "running" } }));
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
    }
  }
  window.cgsApi = { invoke };
})();
