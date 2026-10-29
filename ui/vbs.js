// Модуль VBS 2.0: управление изоляцией ядра, защитой целостности памяти (HVCI),
// безопасностью BitLocker, Meltdown mitigation (KVA Shadow), UEFI Lock и системным гипервизором Windows.

(() => {
  "use strict";

  const invoke = window.__TAURI__?.core?.invoke;
  const $ = (selector, root = document) => root.querySelector(selector);
  const state = { report: null, scanning: false, changing: false, troubleshooting: false };

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function call(command, args = {}) {
    if (!invoke) return Promise.reject(new Error("Системный модуль VBS 2.0 недоступен"));
    return invoke(command, args);
  }

  function isActive() {
    return $('[data-hv-tab-panel="vbs"]')?.classList.contains("active") === true;
  }

  // Установка состояния занятости интерфейса при длительных операциях
  function setBusy(busy, label = "") {
    state.scanning = busy;
    $("#vbs-loading")?.classList.toggle("hidden", !busy);
    $("#vbs-components")?.classList.toggle("hidden", busy);

    const buttons = [
      "#vbs-scan-button",
      "#vbs-enable-all-btn",
      "#vbs-enable-button",
      "#vbs-disable-button",
      "#vbs-test-button",
      "#vbs-uefi-optout-btn",
      "#vbs-fix-wmi",
      "#vbs-run-sfc",
      "#vbs-run-dism"
    ];

    buttons.forEach((selector) => {
      const button = $(selector);
      if (button) {
        button.disabled = busy || state.changing || state.troubleshooting || (selector === "#vbs-test-button" && !state.report);
      }
    });

    if (label) $("#vbs-scan-time").textContent = label;
  }

  function testModeEnabled(report = state.report) {
    if (typeof report?.testSigningConfigured === "boolean") return report.testSigningConfigured;
    return report?.testSigningActive === true || report?.dse?.state === "testsigning";
  }

  function stateLabel(component) {
    if (component.locked) return "Заблокирован";
    if (component.state === "configured") return "Настроен";
    return component.enabled ? "Включён" : "Выключен";
  }

  // Отрисовка актуального состояния параметров VBS 2.0
  function render() {
    const report = state.report;
    if (!report) return;

    // 1. Статус BitLocker Safe Guard
    const bitlocker = report.bitlocker;
    if (bitlocker) {
      const badge = $("#vbs-bitlocker-badge");
      const detail = $("#vbs-bitlocker-detail");
      if (badge) {
        if (bitlocker.protected) {
          if (bitlocker.suspended) {
            badge.textContent = "ПРИОСТАНОВЛЕН";
            badge.dataset.state = "warning";
          } else {
            badge.textContent = "ЗАЩИЩЁН";
            badge.dataset.state = "protected";
          }
        } else {
          badge.textContent = "НЕ АКТИВЕН";
          badge.dataset.state = "off";
        }
      }
      if (detail) {
        detail.textContent = bitlocker.message || "Шифрование BitLocker на системном томе не обнаружено";
      }
    }

    // 2. Статус Meltdown Mitigation (KVA Shadow)
    const kva = report.kvaShadow;
    if (kva) {
      const badge = $("#vbs-kva-badge");
      const detail = $("#vbs-kva-detail");
      if (badge) {
        if (kva.disabled) {
          badge.textContent = "ОТКЛЮЧЕНА";
          badge.dataset.state = "disabled";
        } else if (kva.needed) {
          badge.textContent = "АКТИВНА";
          badge.dataset.state = "active";
        } else {
          badge.textContent = "НЕ ТРЕБУЕТСЯ";
          badge.dataset.state = "neutral";
        }
      }
      if (detail) {
        detail.textContent = kva.label || "Состояние KVA Shadow определено";
      }
    }

    // 3. Блокировка Device Guard в UEFI (UEFI Lock)
    const uefi = report.uefiLock;
    const uefiCard = $("#vbs-uefi-card");
    if (uefiCard) {
      const isLocked = uefi && uefi.isLocked;
      uefiCard.classList.toggle("hidden", !isLocked);
      const optoutBtn = $("#vbs-uefi-optout-btn");
      if (optoutBtn && isLocked) {
        optoutBtn.disabled = !uefi.secConfigAvailable;
      }
    }

    // 4. Список конфликтующего стороннего ПО
    const conflicts = Array.isArray(report.conflicts) ? report.conflicts : [];
    const conflictsPanel = $("#vbs-conflicts-panel");
    const conflictsList = $("#vbs-conflicts-list");
    if (conflictsPanel && conflictsList) {
      conflictsPanel.classList.toggle("hidden", conflicts.length === 0);
      conflictsList.innerHTML = conflicts.map((c) => `
        <div class="vbs-conflict-item">
          <div class="vbs-conflict-info">
            <div class="vbs-conflict-title-row">
              <strong>${escapeHtml(c.name)}</strong>
              <span class="vbs-conflict-badge ${c.severity === "high" ? "danger" : "warning"}">
                ${c.severity === "high" ? "КРИТИЧНО" : "ВНИМАНИЕ"}
              </span>
            </div>
            <p>${escapeHtml(c.description)}</p>
          </div>
          ${c.canFix && c.id === "faceit" ? `
            <button class="vbs-conflict-fix-btn" data-action="faceit" type="button">
              <span>Отключить службу</span>
            </button>
          ` : ""}
        </div>
      `).join("");
    }

    // 5. Driver Signature Enforcement (DSE)
    const dse = report.dse || {};
    const dseCard = $("#vbs-dse-card");
    if (dseCard) dseCard.dataset.state = dse.state || "unknown";
    $("#vbs-dse-label").textContent = dse.label || "Не определено";
    $("#vbs-dse-detail").textContent = dse.detail || "Windows не вернула состояние Code Integrity";
    const dseBadge = $("#vbs-dse-badge");
    if (dseBadge) {
      dseBadge.dataset.state = dse.state || "unknown";
      dseBadge.textContent =
        dse.state === "testsigning"
          ? "TEST MODE"
          : dse.state === "disabled"
          ? "DSE OFF"
          : dse.state === "enabled"
          ? "DSE ON"
          : "DSE TEST";
    }

    // 6. Компоненты VBS (HVCI, Credential Guard, System Guard и др.)
    const components = Array.isArray(report.components) ? report.components : [];
    $("#vbs-components").innerHTML = components.map((item) => `
      <article class="vbs-component ${item.enabled ? "enabled" : "disabled"} ${item.locked ? "locked" : ""}">
        <div>
          <h4>${escapeHtml(item.name)}</h4>
          <p>${escapeHtml(item.description)}</p>
        </div>
        <span>${escapeHtml(stateLabel(item))}</span>
      </article>`).join("");

    // 7. Предупреждения и замечания
    const warnings = Array.isArray(report.warnings) ? report.warnings : [];
    $("#vbs-warning-panel").classList.toggle("hidden", warnings.length === 0);
    $("#vbs-warnings").innerHTML = warnings.map((warning) => `<p>${escapeHtml(warning)}</p>`).join("");

    // 8. Кнопки переключения режимов
    const dseIsOff = dse.state === "disabled";
    const rollbackMode = report.canRestore && dse.state === "enabled";
    const testEnabled = testModeEnabled(report);

    $("#vbs-test-label").textContent = testEnabled ? "Выключить тестовый" : "Включить тестовый";
    $("#vbs-test-button").dataset.enabled = String(testEnabled);

    const testActive = report.testSigningActive === true || dse.state === "testsigning";
    $("#vbs-test-status").textContent = testEnabled !== testActive
      ? testEnabled ? "Тестовый режим включится после перезагрузки." : "Тестовый режим выключится после перезагрузки."
      : testActive ? "Тестовый режим активен." : "Тестовый режим выключен.";

    $("#vbs-enable-button").classList.toggle("hidden", testEnabled || (report.canRestore && dseIsOff));
    $("#vbs-disable-button").classList.toggle("hidden", testEnabled || !report.canRestore);
    $("#vbs-disable-label").textContent = rollbackMode ? "Откатить визор" : "Выключить визор";
  }

  // Запуск глубокого сканирования подсистем Windows
  async function scan() {
    if (state.scanning || state.changing || state.troubleshooting) return;
    setBusy(true, "Проверка VBS 2.0…");
    try {
      state.report = await call("vbs_scan");
      $("#vbs-scan-time").textContent = `Последняя проверка: ${new Date().toLocaleTimeString(window.cgsI18n?.locale?.() || "ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
    } catch (error) {
      $("#vbs-scan-time").textContent = "Ошибка проверки";
      if (typeof window.cgsShowModal === "function") {
        await window.cgsShowModal("Не удалось проверить VBS 2.0", String(error), { symbol: "!" });
      }
    } finally {
      setBusy(false);
      render();
    }
  }

  // Диалог подтверждения изменений режимов защиты
  async function confirmChange(mode) {
    if (mode === "test-enable" || mode === "test-disable") {
      const enabling = mode === "test-enable";
      const title = enabling ? "Включить тестовый режим?" : "Выключить тестовый режим?";
      const message = enabling
        ? "Программа отключит VBS, HVCI, Credential Guard и системный гипервизор, затем включит Test Signing. Если BitLocker активен, защита будет автоматически приостановлена на 1 перезагрузку. Для запуска игры отключите Secure Boot в BIOS/UEFI. После обычной перезагрузки Windows тестовый режим станет активным."
        : "Программа выключит Test Signing и вернёт сохранённые системные защиты. Для применения потребуется обычная перезагрузка Windows.";
      return typeof window.cgsShowModal === "function"
        ? window.cgsShowModal(title, message, { confirm: true, confirmText: enabling ? "Включить" : "Выключить", cancelText: "Отмена", symbol: "🧪" })
        : window.confirm(`${title}\n\n${message}`);
    }

    const enabling = mode === "enable";
    const rollbackMode = !enabling && state.report?.canRestore && state.report?.dse?.state === "enabled";
    const title = enabling ? "Включить визор?" : rollbackMode ? "Откатить визор?" : "Выключить визор?";
    const message = enabling
      ? "Программа отключит VBS, HVCI, Credential Guard и системный гипервизор, оптимизирует KVA Shadow и подготовит одноразовое меню загрузки Windows. Если BitLocker активен, защита автоматически временно приостановится на 1 цикл перезагрузки. После перезапуска выберите «Отключить обязательную проверку подписи драйверов»."
      : "Программа вернёт системные защиты и параметры загрузчика, сохранённые до включения визора. Для применения потребуется перезапуск Windows.";

    if (typeof window.cgsShowModal === "function") {
      return window.cgsShowModal(title, message, { confirm: true, confirmText: enabling ? "Включить" : rollbackMode ? "Откатить" : "Выключить", cancelText: "Отмена", symbol: "!" });
    }
    return window.confirm(`${title}\n\n${message}`);
  }

  // Запрос перезапуска системы после применения изменений
  async function askRestart(mode) {
    const message = mode === "test-enable"
      ? "Сохраните открытые файлы. После обычной перезагрузки Windows включится тестовый режим. Secure Boot должен быть отключён в BIOS/UEFI."
      : mode === "test-disable"
      ? "Сохраните открытые файлы. После обычной перезагрузки Windows тестовый режим будет выключен, а сохранённые системные защиты восстановлены."
      : mode === "enable"
      ? "Сохраните открытые файлы. После перезапуска Windows откроет дополнительные параметры загрузки — выберите «Отключить обязательную проверку подписи драйверов». После входа в систему программа покажет DSE OFF."
      : mode === "uefi"
      ? "Сохраните открытые файлы. При следующей перезагрузке микрокод UEFI запросит подтверждение отключения Device Guard. Нажмите предложенную клавишу на экране включения."
      : "Сохранённые системные защиты будут полностью включены после обычного перезапуска Windows.";

    const accepted = typeof window.cgsShowModal === "function"
      ? await window.cgsShowModal("Требуется перезапуск", message, { confirm: true, confirmText: "Перезапустить", cancelText: "Позже", symbol: "↻" })
      : window.confirm(`Требуется перезапуск\n\n${message}`);
    if (accepted) await call("vbs_restart");
  }

  // Проверка прав администратора с предложением перезапуска программы с повышением UAC
  async function ensureAdmin() {
    try {
      const isElevated = await call("process_is_elevated");
      if (isElevated) return true;
    } catch {
      // Игнорируем ошибку опроса
    }

    if (state.report && state.report.admin) return true;

    const title = "Требуются права администратора";
    const msg = "Для изменения параметров изоляции ядра, тестового режима и загрузчика BCD требуются права администратора Windows.\n\nПерезапустить Eclipse Studio от имени администратора прямо сейчас?";
    const accepted = typeof window.cgsShowModal === "function"
      ? await window.cgsShowModal(title, msg, { confirm: true, confirmText: "Перезапустить с правами админа", cancelText: "Отмена", symbol: "🛡️" })
      : window.confirm(`${title}\n\n${msg}`);

    if (accepted) {
      try {
        await call("relaunch_as_admin");
      } catch (err) {
        if (typeof window.cgsToast === "function") {
          window.cgsToast(`Не удалось повысить права: ${err}`);
        }
      }
    }
    return false;
  }

  // Применение изменения состояния гипервизора или тестового режима
  async function change(mode) {
    if (state.scanning || state.changing || state.troubleshooting) return;
    if (!(await ensureAdmin())) return;
    state.changing = true;
    const enabling = mode === "enable";
    const testMode = mode === "test-enable" || mode === "test-disable";
    const rollbackMode = !enabling && state.report?.canRestore && state.report?.dse?.state === "enabled";
    setBusy(false);

    const logPanel = $("#vbs-log-panel");
    const log = $("#vbs-log");

    try {
      if (!(await confirmChange(mode))) return;
      setBusy(false, testMode ? (mode === "test-enable" ? "Включение тестового режима…" : "Выключение тестового режима…") : (enabling ? "Включение визора…" : (rollbackMode ? "Откат визора…" : "Выключение визора…")));

      const result = testMode
        ? await call("vbs_set_test_mode", { enabled: mode === "test-enable" })
        : await call(enabling ? "vbs_disable" : "vbs_restore");

      const lines = [result.message, `Изменено параметров: ${result.changed || 0}`];
      if (result.restartRequired) lines.push("Для применения изменений требуется перезагрузка Windows.");
      if (Array.isArray(result.failed) && result.failed.length) {
        lines.push("", "Ошибки:", ...result.failed.map((value) => `• ${value}`));
      }

      if (logPanel && log) {
        logPanel.classList.remove("hidden");
        log.textContent = lines.join("\n");
      }

      if (result.success && result.restartRequired) {
        await askRestart(mode);
      } else if (typeof window.cgsShowModal === "function") {
        await window.cgsShowModal(result.success ? "Операция завершена" : "Операция выполнена частично", lines.join("\n"), { symbol: result.success ? "✓" : "!" });
      }
    } catch (error) {
      if (logPanel && log) {
        logPanel.classList.remove("hidden");
        log.textContent = String(error);
      }
      if (typeof window.cgsShowModal === "function") {
        await window.cgsShowModal("Ошибка VBS 2.0", String(error), { symbol: "!" });
      }
    } finally {
      state.changing = false;
      await scan();
    }
  }

  // Подготовка снятия аппаратной блокировки UEFI (SecConfig.efi)
  async function prepareUefiOptOut() {
    if (state.scanning || state.changing || state.troubleshooting) return;
    const title = "Снять блокировку Device Guard в UEFI?";
    const message = "Программа смонтирует системный EFI-раздел, установит модуль SecConfig.efi и создаст однократную загрузочную запись DGOptOut. При следующей перезагрузке появится экран подтверждения отключения Device Guard со стороны UEFI.";

    const confirmed = typeof window.cgsShowModal === "function"
      ? await window.cgsShowModal(title, message, { confirm: true, confirmText: "Подготовить", cancelText: "Отмена", symbol: "🛡️" })
      : window.confirm(`${title}\n\n${message}`);
    if (!confirmed) return;

    state.troubleshooting = true;
    setBusy(true, "Подготовка SecConfig.efi…");
    const logPanel = $("#vbs-log-panel");
    const log = $("#vbs-log");

    try {
      const msg = await call("vbs_prepare_uefi_optout");
      if (logPanel && log) {
        logPanel.classList.remove("hidden");
        log.textContent = msg;
      }
      if (typeof window.cgsShowModal === "function") {
        await window.cgsShowModal("UEFI Opt-Out готов", msg, { symbol: "✓" });
      }
      await askRestart("uefi");
    } catch (error) {
      if (logPanel && log) {
        logPanel.classList.remove("hidden");
        log.textContent = String(error);
      }
      if (typeof window.cgsShowModal === "function") {
        await window.cgsShowModal("Ошибка настройки UEFI", String(error), { symbol: "!" });
      }
    } finally {
      state.troubleshooting = false;
      setBusy(false);
      await scan();
    }
  }

  // Отключение службы FACEIT, вызывающей блокировку гипервизорного драйвера
  async function disableFaceit() {
    if (state.scanning || state.changing || state.troubleshooting) return;
    const title = "Отключить службу FACEIT?";
    const message = "Драйвер античита FACEIT блокирует запуск сторонних гипервизоров. Программа остановит службу FACEIT и переведёт её запуск в состояние Отключено.";

    const confirmed = typeof window.cgsShowModal === "function"
      ? await window.cgsShowModal(title, message, { confirm: true, confirmText: "Отключить", cancelText: "Отмена", symbol: "⚠️" })
      : window.confirm(`${title}\n\n${message}`);
    if (!confirmed) return;

    state.troubleshooting = true;
    setBusy(true, "Отключение FACEIT…");
    try {
      const msg = await call("vbs_disable_faceit");
      if (typeof window.cgsShowModal === "function") {
        await window.cgsShowModal("Служба FACEIT отключена", msg, { symbol: "✓" });
      }
    } catch (error) {
      if (typeof window.cgsShowModal === "function") {
        await window.cgsShowModal("Ошибка отключения FACEIT", String(error), { symbol: "!" });
      }
    } finally {
      state.troubleshooting = false;
      setBusy(false);
      await scan();
    }
  }

  // Выполнение системной диагностики и восстановления (WMI, SFC, DISM)
  async function runTroubleshoot(action) {
    if (state.scanning || state.changing || state.troubleshooting) return;

    const descriptions = {
      wmi: {
        title: "Восстановить репозиторий WMI?",
        prompt: "Будет произведён сброс и сальваж репозитория WMI. Служба winmgmt будет временно перезапущена. Это устраняет сбои получения отчётов об устройствах.",
        busy: "Восстановление репозитория WMI…"
      },
      sfc: {
        title: "Запустить проверку SFC Scannow?",
        prompt: "Утилита System File Checker выполнит сканирование всех защищённых системных файлов и заменит повреждённые версии. Процесс может занять несколько минут.",
        busy: "Проверка системных файлов (SFC)…"
      },
      dism: {
        title: "Запустить восстановление DISM?",
        prompt: "Будет выполнена проверка и восстановление образа Windows (/restorehealth). Для загрузки компонентов может потребоваться подключение к сети. Процесс занимает от 5 до 15 минут.",
        busy: "Восстановление хранилища компонентов DISM…"
      }
    };

    const cfg = descriptions[action] || {
      title: "Выполнить диагностику?",
      prompt: "Будет запущена выбранная системная утилита Windows.",
      busy: "Выполнение операции…"
    };

    const confirmed = typeof window.cgsShowModal === "function"
      ? await window.cgsShowModal(cfg.title, cfg.prompt, { confirm: true, confirmText: "Запустить", cancelText: "Отмена", symbol: "🔧" })
      : window.confirm(`${cfg.title}\n\n${cfg.prompt}`);
    if (!confirmed) return;

    state.troubleshooting = true;
    setBusy(true, cfg.busy);

    const logPanel = $("#vbs-log-panel");
    const log = $("#vbs-log");

    try {
      const output = await call("vbs_troubleshoot", { action });
      if (logPanel && log) {
        logPanel.classList.remove("hidden");
        log.textContent = output;
      }
      if (typeof window.cgsShowModal === "function") {
        await window.cgsShowModal("Диагностика завершена", output, { symbol: "✓" });
      }
    } catch (error) {
      if (logPanel && log) {
        logPanel.classList.remove("hidden");
        log.textContent = String(error);
      }
      if (typeof window.cgsShowModal === "function") {
        await window.cgsShowModal("Ошибка диагностики", String(error), { symbol: "!" });
      }
    } finally {
      state.troubleshooting = false;
      setBusy(false);
      await scan();
    }
  }

  // Принудительное включение всех механизмов защиты системы Windows (VBS, HVCI, Blocklist, etc.)
  async function enableAll() {
    if (state.scanning || state.changing || state.troubleshooting) return;
    if (!(await ensureAdmin())) return;

    const title = "Включить все системные защиты Windows?";
    const message = "Будут принудительно включены:\n" +
      "• Изоляция ядра и системный гипервизор (VBS / Hypervisor Auto)\n" +
      "• Целостность памяти (HVCI / Memory Integrity)\n" +
      "• Черный список уязвимых драйверов Microsoft (Blocklist)\n" +
      "• Защита учетных записей (Credential Guard & LSA)\n" +
      "• System Guard, HyperGuard и биометрия Windows Hello\n" +
      "• Выключение тестового режима (Test Signing OFF)\n" +
      "• Восстановление штатных служб безопасности\n\n" +
      "Для применения параметров потребуется перезагрузка Windows.";

    const confirmed = typeof window.cgsShowModal === "function"
      ? await window.cgsShowModal(title, message, { confirm: true, confirmText: "Включить защиты", cancelText: "Отмена", symbol: "🛡️" })
      : window.confirm(`${title}\n\n${message}`);
    if (!confirmed) return;

    const askRebootMsg = "Для применения всех параметров изоляции ядра и гипервизора Windows требуется перезагрузка. Перезагрузить компьютер прямо сейчас (через 5 секунд)?";
    const reboot = typeof window.cgsShowModal === "function"
      ? await window.cgsShowModal("Перезагрузка Windows", askRebootMsg, { confirm: true, confirmText: "Перезагрузить сейчас", cancelText: "Позже вручную", symbol: "↻" })
      : window.confirm(`Перезагрузка Windows\n\n${askRebootMsg}`);

    state.changing = true;
    setBusy(true, "Включение всех защит Windows…");
    const logPanel = $("#vbs-log-panel");
    const log = $("#vbs-log");

    try {
      const result = await call("vbs_enable_all", { reboot });
      const lines = [result.message, `Изменено параметров: ${result.changed || 0}`];
      if (result.restartRequired) {
        lines.push("Для применения параметров перезагрузите компьютер вручную.");
      }
      if (Array.isArray(result.failed) && result.failed.length) {
        lines.push("", "Ошибки:", ...result.failed.map((value) => `• ${value}`));
      }

      if (logPanel && log) {
        logPanel.classList.remove("hidden");
        log.textContent = lines.join("\n");
      }

      if (typeof window.cgsShowModal === "function") {
        await window.cgsShowModal(result.success ? "Все защиты включены" : "Включение выполнено частично", lines.join("\n"), { symbol: result.success ? "✓" : "!" });
      }
    } catch (error) {
      if (logPanel && log) {
        logPanel.classList.remove("hidden");
        log.textContent = String(error);
      }
      if (typeof window.cgsShowModal === "function") {
        await window.cgsShowModal("Ошибка включения защит", String(error), { symbol: "!" });
      }
    } finally {
      state.changing = false;
      setBusy(false);
      await scan();
    }
  }

  // Привязка обработчиков событий
  $("#vbs-scan-button")?.addEventListener("click", scan);
  $("#vbs-enable-all-btn")?.addEventListener("click", enableAll);
  $("#vbs-enable-button")?.addEventListener("click", () => change("enable"));
  $("#vbs-disable-button")?.addEventListener("click", () => change("disable"));
  $("#vbs-test-button")?.addEventListener("click", () => change(testModeEnabled() ? "test-disable" : "test-enable"));
  $("#vbs-uefi-optout-btn")?.addEventListener("click", prepareUefiOptOut);

  // Обработка клика по устранению конфликтов (делегирование)
  $("#vbs-conflicts-list")?.addEventListener("click", (event) => {
    const btn = event.target.closest(".vbs-conflict-fix-btn");
    if (!btn) return;
    const act = btn.dataset.action;
    if (act === "faceit") {
      disableFaceit();
    }
  });

  // Диагностические инструменты
  $("#vbs-fix-wmi")?.addEventListener("click", () => runTroubleshoot("wmi"));
  $("#vbs-run-sfc")?.addEventListener("click", () => runTroubleshoot("sfc"));
  $("#vbs-run-dism")?.addEventListener("click", () => runTroubleshoot("dism"));

  document.addEventListener("cgs:hv-tab-changed", (event) => {
    if (event.detail === "vbs" && !state.report && !state.scanning) scan();
  });

  if (isActive()) scan();
})();
