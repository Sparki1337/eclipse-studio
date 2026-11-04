// Управление VBS, HVCI, BitLocker, KVA Shadow, UEFI Lock и гипервизором Windows

(() => {
  "use strict";

  const invoke = window.cgsApi?.invoke;
  const $ = (selector, root = document) => root.querySelector(selector);
  const state = { report: null, scanning: false, changing: false, troubleshooting: false, lastScanAt: 0, scanFailed: false };

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function call(command, args = {}) {
    if (!invoke) return Promise.reject(new Error("Системный модуль VBS 2.0.1 недоступен"));
    return invoke(command, args);
  }

  function isActive() {
    return $("#view-hypervisor")?.classList.contains("active") === true
      && $('[data-hv-tab-panel="vbs"]')?.classList.contains("active") === true;
  }

  // Кнопки, меняющие параметры загрузки: блокируются, пока состояние BitLocker не подтверждено
  const BOOT_BUTTONS = ["#vbs-enable-all-btn", "#vbs-enable-button", "#vbs-disable-button", "#vbs-test-button", "#vbs-external-restore"];
  const BOOT_BUTTON_TITLES = { "#vbs-enable-all-btn": "Принудительно включить все механизмы защиты ядра Windows" };
  const BLOCKED_TITLE = "Заблокировано: состояние BitLocker не подтверждено";
  const BLOCKED_ADMIN_TITLE = "Заблокировано: запустите программу от имени администратора, чтобы проверить BitLocker";

  // Источник отката и причина блокировки проверяются отдельно от текущего состояния DSE.
  function bootBlockReason(selector) {
    const report = state.report;
    if (!report || state.scanFailed) return "Сначала выполните успешную проверку состояния Windows.";
    if (report.bitlocker?.state === "unknown") return report.bitlocker?.needsAdmin ? BLOCKED_ADMIN_TITLE : BLOCKED_TITLE;
    if (selector === "#vbs-external-restore") return report.external?.canRestore ? "" : report.external?.blockedReason || "Внешний журнал не прошёл проверку.";
    if (selector === "#vbs-disable-button") return report.canRestore ? "" : "Нет проверенного снимка Eclipse для точного отката.";
    if (selector === "#vbs-test-button" && testModeEnabled() && !report.external?.detected && !report.external?.pendingRestart) {
      return report.canRestore ? "" : "Нет проверенного снимка Eclipse для точного отката.";
    }
    if (report.external?.detected || report.external?.pendingRestart) return report.external.blockedReason || "Сначала выключите внешний режим VBS.cmd по его журналу.";
    if (selector === "#vbs-enable-all-btn") return "";
    return report.enableBlockReason || "";
  }

  // Подсказка на кнопке загрузки: причина блокировки или исходный текст
  function updateBootButtonTitle(button, selector, reason) {
    const title = reason || BOOT_BUTTON_TITLES[selector] || "";
    if ((button.dataset.titleSource || "") === title) return;
    if (title) button.setAttribute("title", title);
    else button.removeAttribute("title");
    button.dataset.titleSource = title;
  }

  // Установка состояния занятости интерфейса при длительных операциях
  function setBusy(busy, label = "") {
    state.scanning = busy;
    // Обновление программы ждёт окончания проверки и изменения параметров Windows
    window.cgsReportBusy?.("vbs", busy || state.changing);
    $("#vbs-loading")?.classList.toggle("hidden", !busy);
    $("#vbs-components")?.classList.toggle("hidden", busy);

    const buttons = [
      "#vbs-scan-button",
      "#vbs-enable-all-btn",
      "#vbs-enable-button",
      "#vbs-disable-button",
      "#vbs-test-button",
      "#vbs-external-restore",
      "#vbs-uefi-optout-btn",
      "#vbs-fix-wmi",
      "#vbs-fix-sfc",
      "#vbs-fix-dism"
    ];

    buttons.forEach((selector) => {
      const button = $(selector);
      if (button) {
        const reason = BOOT_BUTTONS.includes(selector) ? bootBlockReason(selector) : "";
        button.disabled = busy || state.changing || state.troubleshooting || Boolean(reason);
        if (BOOT_BUTTONS.includes(selector)) updateBootButtonTitle(button, selector, reason);
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

  // Отрисовка актуального состояния параметров VBS 2.0.1
  function render() {
    const report = state.report;
    if (!report) return;

    // Статус BitLocker Safe Guard
    const bitlocker = report.bitlocker;
    if (bitlocker) {
      const badge = $("#vbs-bitlocker-badge");
      const detail = $("#vbs-bitlocker-detail");
      if (badge) {
        if (bitlocker.state === "unknown") {
          badge.textContent = "НЕИЗВЕСТНО"; badge.dataset.state = "warning";
        } else if (bitlocker.suspended) {
          badge.textContent = "ПРИОСТАНОВЛЕН"; badge.dataset.state = "warning";
        } else if (bitlocker.protected) {
          badge.textContent = "ЗАЩИЩЁН"; badge.dataset.state = "protected";
        } else {
          badge.textContent = "НЕ АКТИВЕН"; badge.dataset.state = "off";
        }
      }
      if (detail) {
        // Сообщение отдельно, техническая диагностика — мелкой строкой с полным текстом в подсказке
        const diagnostics = (Array.isArray(bitlocker.diagnostics) ? bitlocker.diagnostics : [])
          .map((item) => String(item ?? "").trim())
          .filter(Boolean);
        detail.textContent = bitlocker.message || "Состояние не подтверждено";
        if (diagnostics.length) {
          const small = document.createElement("small");
          small.className = "vbs-card-diagnostics";
          small.textContent = diagnostics.join(" · ");
          small.title = diagnostics.join("\n");
          detail.append(small);
        }
      }
      // Без прав администратора Windows не сообщает состояние BitLocker
      $("#vbs-bitlocker-admin")?.classList.toggle("hidden", !(bitlocker.state === "unknown" && (bitlocker.needsAdmin === true || report.admin === false)));
    }

    // Статус Meltdown Mitigation (KVA Shadow)
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

    // Блокировка Device Guard в UEFI (UEFI Lock)
    const uefi = report.uefiLock;
    const uefiCard = $("#vbs-uefi-card");
    if (uefiCard) {
      const isLocked = uefi && uefi.isLocked;
      uefiCard.classList.toggle("hidden", !isLocked);
      const optoutBtn = $("#vbs-uefi-optout-btn");
      if (optoutBtn && isLocked) {
        optoutBtn.disabled = false;
        optoutBtn.title = "Изменение UEFI отключено: показать причину";
      }
    }

    // Список конфликтующего стороннего ПО
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

    // Проверка подписи драйверов DSE
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

    // Компоненты VBS (HVCI, Credential Guard, System Guard и др.)
    const components = Array.isArray(report.components) ? report.components : [];
    $("#vbs-components").innerHTML = components.map((item) => `
      <article class="vbs-component ${item.enabled ? "enabled" : "disabled"} ${item.locked ? "locked" : ""}">
        <div>
          <h4>${escapeHtml(item.name)}</h4>
          <p>${escapeHtml(item.description)}</p>
        </div>
        <span>${escapeHtml(stateLabel(item))}</span>
      </article>`).join("");

    // Предупреждения и замечания
    const warnings = Array.isArray(report.warnings) ? report.warnings : [];
    $("#vbs-warning-panel").classList.toggle("hidden", warnings.length === 0);
    $("#vbs-warnings").innerHTML = warnings.map((warning) => `<p>${escapeHtml(warning)}</p>`).join("");

    // Кнопки переключения режимов
    const dseIsOff = dse.state === "disabled";
    const rollbackMode = report.canRestore && dse.state === "enabled";
    const testEnabled = testModeEnabled(report);

    $("#vbs-test-label").textContent = testEnabled ? "Выключить тестовый" : "Включить тестовый";
    $("#vbs-test-button").dataset.enabled = String(testEnabled);

    const testActive = report.testSigningActive === true || dse.state === "testsigning";
    $("#vbs-test-status").textContent = testEnabled !== testActive
      ? testEnabled ? "Тестовый режим включится после перезагрузки." : "Тестовый режим выключится после перезагрузки."
      : testActive ? "Тестовый режим активен." : "Тестовый режим выключен.";

    const external = report.external || {};
    const externalVisible = external.detected === true || external.pendingRestart === true;
    $("#vbs-external-card")?.classList.toggle("hidden", !externalVisible);
    if (externalVisible) {
      $("#vbs-external-detail").textContent = external.detail || "Найден журнал VBS.cmd / ARTIFACT.";
      $("#vbs-external-count").textContent = String(external.trackedChanges || 0);
      $("#vbs-external-badge").textContent = external.pendingRestart ? "ПЕРЕЗАГРУЗКА" : external.canRestore ? "ВНЕШНИЙ" : "ПРОВЕРЬТЕ";
      $("#vbs-external-reason").textContent = external.blockedReason || "";
      $("#vbs-external-reason").classList.toggle("hidden", !external.blockedReason);
      $("#vbs-external-restore").classList.toggle("hidden", external.pendingRestart && !external.detected);
    }
    $("#vbs-enable-button").classList.toggle("hidden", externalVisible || testEnabled || (report.canRestore && dseIsOff));
    $("#vbs-disable-button").classList.toggle("hidden", !report.canRestore || (testEnabled && !externalVisible));
    $("#vbs-disable-label").textContent = external.detected ? "Откатить изменения Eclipse" : rollbackMode ? "Откатить визор" : "Выключить визор";
    setBusy(state.scanning);
  }

  // Запуск глубокого сканирования подсистем Windows
  async function scan(options = {}) {
    if (options.automatic && (!isActive() || document.hidden || Date.now() - state.lastScanAt < 2000)) return;
    if (state.scanning || state.changing || state.troubleshooting) return;
    setBusy(true, "Проверка VBS 2.0.1…");
    try {
      state.report = await call("vbs_scan");
      state.scanFailed = false;
      state.lastScanAt = Date.now();
      $("#vbs-scan-time").textContent = `Последняя проверка: ${new Date().toLocaleTimeString(window.cgsI18n?.locale?.() || "ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
    } catch (error) {
      state.scanFailed = true;
      $("#vbs-scan-time").textContent = "Ошибка проверки";
      if (!options.automatic && typeof window.cgsShowModal === "function") {
        await window.cgsShowModal("Не удалось проверить VBS 2.0.1", String(error), { symbol: "!" });
      }
    } finally {
      setBusy(false);
      render();
    }
  }

  // Диалог подтверждения изменений режимов защиты
  async function confirmChange(mode) {
    if (mode === "external-restore") {
      const title = "Выключить внешний режим VBS.cmd?";
      const message = "Программа восстановит только настройки, отмеченные журналом VBS.cmd / ARTIFACT: защиты Windows, параметры BCD и учтённые службы. Это не принудительное включение всех защит. Перед изменениями создаётся проверяемый DPAPI-снимок. Для завершения потребуется перезагрузка Windows.";
      return typeof window.cgsShowModal === "function"
        ? window.cgsShowModal(title, message, { confirm: true, confirmText: "Восстановить по журналу", cancelText: "Отмена", symbol: "↶" })
        : window.confirm(`${title}\n\n${message}`);
    }
    if (mode === "test-enable" || mode === "test-disable") {
      const enabling = mode === "test-enable";
      const title = enabling ? "Включить тестовый режим?" : "Выключить тестовый режим?";
      const message = enabling
        ? "Программа отключит VBS, HVCI, Credential Guard и системный гипервизор, затем включит Test Signing. Сначала проверяется состояние BitLocker. При неизвестном состоянии изменения отменяются; активная защита приостанавливается только после подтверждённого снимка на 1 перезагрузку. Для запуска игры отключите Secure Boot в BIOS/UEFI. После обычной перезагрузки Windows тестовый режим станет активным."
        : "Программа вернёт точные значения Test Signing и системных параметров из проверенного снимка. Они могут отличаться от настроек по умолчанию. Для применения потребуется перезагрузка Windows.";
      return typeof window.cgsShowModal === "function"
        ? window.cgsShowModal(title, message, { confirm: true, confirmText: enabling ? "Включить" : "Выключить", cancelText: "Отмена", symbol: "🧪" })
        : window.confirm(`${title}\n\n${message}`);
    }

    const enabling = mode === "enable";
    const rollbackMode = !enabling && state.report?.canRestore && state.report?.dse?.state === "enabled";
    const title = enabling ? "Включить визор?" : rollbackMode ? "Откатить визор?" : "Выключить визор?";
    const message = enabling
      ? (state.report?.preferredBootMode === "testsigning"
        ? "Secure Boot отключён: как в VBS.cmd 2.0.1, программа подготовит Test Signing вместо одноразового меню. Сначала создаётся проверенный снимок и проверяется BitLocker. Для применения потребуется обычная перезагрузка Windows."
        : "Программа отключит VBS, HVCI, Credential Guard и системный гипервизор, оптимизирует KVA Shadow и подготовит одноразовое меню загрузки Windows. Если BitLocker активен, защита автоматически временно приостановится на 1 цикл перезагрузки. После перезапуска выберите «Отключить обязательную проверку подписи драйверов».")
      : "Программа вернёт системные защиты и параметры загрузчика, сохранённые до включения визора. Для применения потребуется перезапуск Windows.";

    if (typeof window.cgsShowModal === "function") {
      return window.cgsShowModal(title, message, { confirm: true, confirmText: enabling ? "Включить" : rollbackMode ? "Откатить" : "Выключить", cancelText: "Отмена", symbol: "!" });
    }
    return window.confirm(`${title}\n\n${message}`);
  }

  // Запрос перезапуска системы после применения изменений
  async function askRestart(mode) {
    const message = mode === "external-restore"
      ? "Внешние настройки восстановлены по журналу VBS.cmd. Сохраните файлы и перезагрузите Windows. После этого режим можно снова включить из Eclipse с собственным снимком восстановления."
      : mode === "test-enable" || (mode === "enable" && state.report?.preferredBootMode === "testsigning")
      ? "Сохраните открытые файлы. После обычной перезагрузки Windows включится тестовый режим. Secure Boot должен быть отключён в BIOS/UEFI."
      : mode === "test-disable"
      ? "Сохраните открытые файлы. После перезагрузки вступят в силу исходные значения из снимка, включая исходное состояние тестового режима."
      : mode === "enable"
      ? "Сохраните открытые файлы. После перезапуска Windows откроет дополнительные параметры загрузки — выберите «Отключить обязательную проверку подписи драйверов». После входа в систему программа покажет DSE OFF."
      : mode === "uefi"
      ? "Сохраните открытые файлы. При следующей перезагрузке микрокод UEFI запросит подтверждение отключения Device Guard. Нажмите предложенную клавишу на экране включения."
      : "После перезапуска вступят в силу исходные значения из снимка; это не обязательно все настройки «включено».";

    const accepted = typeof window.cgsShowModal === "function"
      ? await window.cgsShowModal("Требуется перезапуск", message, { confirm: true, confirmText: "Перезапустить", cancelText: "Позже", symbol: "↻" })
      : window.confirm(`Требуется перезапуск\n\n${message}`);
    if (accepted) await call("vbs_restart");
  }

  // Проверка прав администратора с предложением перезапуска программы с повышением UAC
  async function ensureAdmin(reason = "") {
    try {
      const isElevated = await call("process_is_elevated");
      if (isElevated) return true;
    } catch {
      // Игнорируем ошибку опроса
    }

    if (state.report && state.report.admin) return true;

    const title = "Требуются права администратора";
    const msg = `${reason || "Для изменения параметров изоляции ядра, тестового режима и загрузчика BCD требуются права администратора Windows."}\n\nПерезапустить Eclipse Studio от имени администратора прямо сейчас?`;
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
    const preparing = enabling || mode === "test-enable";
    const externalRestore = mode === "external-restore";
    const testMode = mode === "test-enable" || mode === "test-disable";
    const rollbackMode = !enabling && state.report?.canRestore && state.report?.dse?.state === "enabled";
    setBusy(false);

    const logPanel = $("#vbs-log-panel");
    const log = $("#vbs-log");

    try {
      if (!(await confirmChange(mode))) return;
      setBusy(false, externalRestore ? "Восстановление внешнего режима…" : testMode ? (mode === "test-enable" ? "Включение тестового режима…" : "Выключение тестового режима…") : (enabling ? "Включение визора…" : (rollbackMode ? "Откат визора…" : "Выключение визора…")));

      let allowUefi = false;
      if (externalRestore && state.report?.external?.requiresUefiConsent) {
        const consent = typeof window.cgsShowModal === "function"
          ? await window.cgsShowModal("Восстановить UEFI Lock?", "Журнал VBS.cmd содержит восстановление блокировок VBS/HVCI/Credential Guard в UEFI. Это может потребовать физического подтверждения для последующего отключения. Применять только на личном, не управляемом организацией устройстве.", { confirm: true, confirmText: "Восстановить блокировки", cancelText: "Отмена", symbol: "!" })
          : false;
        if (!consent) return;
        allowUefi = true;
      }
      if (preparing && state.report?.uefiLock?.isLocked) {
        const uefiConsent = typeof window.cgsShowModal === "function"
          ? await window.cgsShowModal(
              "Обнаружена аппаратная блокировка UEFI",
              "В системе активен UEFI Lock (VBS защищён прошивкой материнской платы).\n\nНастроить автоматический UEFI Opt-Out (SecConfig.efi) в EFI-раздел для отключения защиты при перезагрузке?",
              { confirm: true, confirmText: "Настроить UEFI Opt-Out", cancelText: "Продолжить без UEFI", symbol: "⚠️" }
            )
          : false;
        allowUefi = Boolean(uefiConsent);
      }

      const result = externalRestore
        ? await call("vbs_restore_external", { allowUefi })
        : testMode
        ? await call("vbs_set_test_mode", { enabled: mode === "test-enable", allowUefi })
        : (enabling ? await call("vbs_disable", { allowUefi }) : await call("vbs_restore"));

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
        await window.cgsShowModal("Ошибка VBS 2.0.1", String(error), { symbol: "!" });
      }
    } finally {
      state.changing = false;
      await scan();
    }
  }

  // Настройка UEFI Opt-Out (SecConfig.efi) с симметричным восстановлением
  async function prepareUefiOptOut() {
    if (state.scanning || state.changing || state.troubleshooting) return;
    if (!(await ensureAdmin())) return;

    const title = "Настроить UEFI Opt-Out (SecConfig.efi)?";
    const message = "Программа смонтирует системный EFI-раздел, скопирует официальный инструмент Microsoft SecConfig.efi и зарегистрирует загрузочную запись DGOptOut в BCD.\n\n" +
      "При следующей перезагрузке микрокод материнской платы покажет экран подтверждения отключения аппаратной защиты VBS.\n\n" +
      "Защита BitLocker будет автоматически приостановлена на время перезагрузки, чтобы не требовался ключ восстановления.";

    const confirmed = typeof window.cgsShowModal === "function"
      ? await window.cgsShowModal(title, message, { confirm: true, confirmText: "Настроить", cancelText: "Отмена", symbol: "⚠️" })
      : window.confirm(`${title}\n\n${message}`);
    if (!confirmed) return;

    state.changing = true;
    setBusy(true, "Настройка SecConfig.efi…");
    try {
      const result = await call("vbs_prepare_uefi_optout");
      if (typeof window.cgsShowModal === "function") {
        await window.cgsShowModal(result.success ? "SecConfig.efi настроен" : "Настройка не удалась", result.message, { symbol: result.success ? "✓" : "!" });
      }
    } catch (err) {
      if (typeof window.cgsShowModal === "function") {
        await window.cgsShowModal("Ошибка UEFI Opt-Out", String(err), { symbol: "!" });
      }
    } finally {
      state.changing = false;
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
        title: "Проверить репозиторий WMI?",
        prompt: "Только проверка /verifyrepository. Сброс, восстановление и перезапуск службы не выполняются.",
        busy: "Проверка репозитория WMI…"
      },
      sfc: {
        title: "Проверить системные файлы без изменений?",
        prompt: "SFC /verifyonly проверит защищённые файлы без замены. Процесс может занять несколько минут.",
        busy: "Проверка системных файлов (SFC)…"
      },
      dism: {
        title: "Проверить образ Windows без ремонта?",
        prompt: "DISM /scanhealth проверит хранилище компонентов. Автоматическое восстановление /restorehealth не запускается.",
        busy: "Проверка хранилища компонентов DISM…"
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

  // Выполнение активного восстановления компонентов Windows (WMI, SFC, DISM)
  async function runRepair(kind) {
    if (state.scanning || state.changing || state.troubleshooting) return;
    if (!(await ensureAdmin())) return;

    const descriptions = {
      wmi: {
        title: "Восстановить репозиторий WMI?",
        prompt: "Будет выполнена остановка службы winmgmt, восстановление /salvagerepository или сброс /resetrepository, перерегистрация библиотек WMI и перезапуск службы.",
        busy: "Восстановление репозитория WMI…"
      },
      sfc: {
        title: "Запустить ремонт системных файлов SFC?",
        prompt: "Команда sfc /scannow проверит и автоматически восстановит повреждённые системные файлы Windows. Процесс может занять несколько минут.",
        busy: "Восстановление системных файлов (SFC /scannow)…"
      },
      dism: {
        title: "Запустить восстановление хранилища DISM?",
        prompt: "Команда DISM /Online /Cleanup-Image /RestoreHealth восстановит хранилище компонентов Windows через Центр обновления. Процесс может занять несколько минут.",
        busy: "Восстановление хранилища компонентов DISM…"
      }
    };

    const cfg = descriptions[kind] || {
      title: "Выполнить восстановление?",
      prompt: "Будет запущена операция восстановления системных компонентов Windows.",
      busy: "Выполнение восстановления…"
    };

    const confirmed = typeof window.cgsShowModal === "function"
      ? await window.cgsShowModal(cfg.title, cfg.prompt, { confirm: true, confirmText: "Восстановить", cancelText: "Отмена", symbol: "🔧" })
      : window.confirm(`${cfg.title}\n\n${cfg.prompt}`);
    if (!confirmed) return;

    state.troubleshooting = true;
    setBusy(true, cfg.busy);

    const logPanel = $("#vbs-log-panel");
    const log = $("#vbs-log");
    if (logPanel && log) {
      logPanel.classList.remove("hidden");
      log.textContent = `[${new Date().toLocaleTimeString()}] Запуск восстановления (${kind.toUpperCase()})…\n`;
    }

    try {
      const output = await call("vbs_repair", { kind });
      if (logPanel && log) {
        logPanel.classList.remove("hidden");
        log.textContent = output;
      }
      if (typeof window.cgsShowModal === "function") {
        await window.cgsShowModal("Восстановление завершено", output, { symbol: "✓" });
      }
    } catch (error) {
      if (logPanel && log) {
        logPanel.classList.remove("hidden");
        log.textContent += `\nОшибка: ${error}`;
      }
      if (typeof window.cgsShowModal === "function") {
        await window.cgsShowModal("Ошибка восстановления", String(error), { symbol: "!" });
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
      "\nПеред изменениями сохраняется точный снимок управляемых параметров. После записи выполняется проверка. Остальные службы и настройки Windows не изменяются.\n\n" +
      "Для применения параметров потребуется перезагрузка Windows. Это не проверка всей системы безопасности.";

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
  $("#vbs-external-restore")?.addEventListener("click", () => change("external-restore"));
  $("#vbs-test-button")?.addEventListener("click", () => change(testModeEnabled() ? "test-disable" : "test-enable"));
  $("#vbs-uefi-optout-btn")?.addEventListener("click", prepareUefiOptOut);
  $("#vbs-bitlocker-admin")?.addEventListener("click", async () => {
    if (await ensureAdmin("Windows сообщает состояние BitLocker только программам с правами администратора. Без него изменения загрузки остаются заблокированными.")) scan();
  });

  // Обработка клика по устранению конфликтов (делегирование)
  $("#vbs-conflicts-list")?.addEventListener("click", (event) => {
    const btn = event.target.closest(".vbs-conflict-fix-btn");
    if (!btn) return;
    const act = btn.dataset.action;
    if (act === "faceit") {
      disableFaceit();
    }
  });

  // Потоковый вывод прогресса в реальном времени
  function appendProgress(line) {
    const logPanel = $("#vbs-log-panel");
    const log = $("#vbs-log");
    if (logPanel && log) {
      logPanel.classList.remove("hidden");
      log.textContent += (log.textContent ? "\n" : "") + line;
      log.scrollTop = log.scrollHeight;
    }
  }

  if (window.__TAURI__?.event?.listen) {
    window.__TAURI__.event.listen("vbs-progress", (event) => {
      const payload = event?.payload ?? event;
      if (typeof payload === "string") {
        appendProgress(payload);
      } else if (payload?.message) {
        appendProgress(payload.message);
      }
    });
  }

  // Инструменты системного восстановления и ремонта Windows
  $("#vbs-fix-wmi")?.addEventListener("click", () => runRepair("wmi"));
  $("#vbs-fix-sfc")?.addEventListener("click", () => runRepair("sfc"));
  $("#vbs-fix-dism")?.addEventListener("click", () => runRepair("dism"));


  // Управление отдельными защитами
  const pState = { items: [], loading: false, changing: false };

  function renderProtections() {
    const list = $("#protections-list");
    if (!list) return;
    if (!pState.items.length) {
      list.innerHTML = '<div class="muted-box">Нажмите «Обновить статус», чтобы загрузить параметры защит.</div>';
      return;
    }
    list.innerHTML = pState.items.map((item) => {
      const isEnabled = Boolean(item.enabled);
      const isLocked = Boolean(item.locked);
      const statusClass = isLocked ? "locked" : isEnabled ? "enabled" : "disabled";
      const statusText = isLocked ? (item.lockReason || "Заблокировано") : isEnabled ? "Включен" : "Отключен";
      const btnAction = isEnabled ? "disable" : "enable";
      const btnText = isEnabled ? "Отключить" : "Включить";
      const btnClass = isEnabled ? "btn-disable" : "btn-enable";

      return `
        <article class="protection-card ${statusClass}" data-protection-id="${escapeHtml(item.id)}">
          <div class="protection-info">
            <div class="protection-meta">
              <span class="protection-cat">${escapeHtml(item.category || "Система")}</span>
              <span class="protection-badge">${escapeHtml(statusText)}</span>
            </div>
            <h4>${escapeHtml(item.name)}</h4>
            <p>${escapeHtml(item.description)}</p>
          </div>
          <div class="protection-actions">
            ${isLocked ? `<span class="badge-lock" title="${escapeHtml(item.lockReason || "")}">UEFI Lock</span>` : `
              <button class="protection-toggle-btn ${btnClass}" data-prot-id="${escapeHtml(item.id)}" data-prot-action="${btnAction}" ${pState.changing ? "disabled" : ""}>
                <span>${btnText}</span>
              </button>
            `}
          </div>
        </article>
      `;
    }).join("");
  }

  async function scanProtections() {
    if (pState.loading || pState.changing) return;
    pState.loading = true;
    $("#protections-loading")?.classList.remove("hidden");
    $("#protections-list")?.classList.add("hidden");
    const scanBtn = $("#protections-scan-btn");
    if (scanBtn) scanBtn.disabled = true;

    try {
      pState.items = await call("vbs_get_protections");
      const scanTime = $("#protections-scan-time");
      if (scanTime) {
        scanTime.textContent = `Проверка: ${new Date().toLocaleTimeString(window.cgsI18n?.locale?.() || "ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
      }
    } catch (error) {
      if (typeof window.cgsShowModal === "function") {
        await window.cgsShowModal("Ошибка чтения защит", String(error), { symbol: "!" });
      }
    } finally {
      pState.loading = false;
      $("#protections-loading")?.classList.add("hidden");
      $("#protections-list")?.classList.remove("hidden");
      if (scanBtn) scanBtn.disabled = false;
      renderProtections();
    }
  }

  async function toggleProtection(id, enable) {
    if (pState.changing || !invoke) return;
    const item = pState.items.find((x) => x.id === id);
    const title = enable ? `Включить: ${item?.name || id}?` : `Отключить: ${item?.name || id}?`;
    const actionWord = enable ? "включение" : "отключение";
    const msg = `Будет выполнено ${actionWord} компонента «${item?.name || id}». Исходное состояние параметров сохраняется в снимке отката.`;

    const confirmed = typeof window.cgsShowModal === "function"
      ? await window.cgsShowModal(title, msg, { confirm: true, confirmText: enable ? "Включить" : "Отключить", cancelText: "Отмена", symbol: "🛡️" })
      : window.confirm(`${title}\n\n${msg}`);
    if (!confirmed) return;

    pState.changing = true;
    renderProtections();
    const logPanel = $("#protections-log-panel");
    const log = $("#protections-log");

    try {
      const res = await call("vbs_set_protection", { id, enabled: enable });
      const lines = [res.message, `Изменено параметров: ${res.changed || 0}`];
      if (res.restartRequired) {
        lines.push("Для применения параметров требуется перезагрузка Windows.");
      }
      if (Array.isArray(res.failed) && res.failed.length) {
        lines.push("", "Ошибки:", ...res.failed.map((v) => `• ${v}`));
      }
      if (logPanel && log) {
        logPanel.classList.remove("hidden");
        log.textContent = lines.join("\n");
      }
      if (typeof window.cgsShowModal === "function") {
        await window.cgsShowModal(res.success ? "Параметр изменён" : "Ошибка изменения", lines.join("\n"), { symbol: res.success ? "✓" : "!" });
      }
    } catch (error) {
      if (logPanel && log) {
        logPanel.classList.remove("hidden");
        log.textContent = String(error);
      }
      if (typeof window.cgsShowModal === "function") {
        await window.cgsShowModal("Ошибка изменения защиты", String(error), { symbol: "!" });
      }
    } finally {
      pState.changing = false;
      await scanProtections();
    }
  }

  $("#protections-scan-btn")?.addEventListener("click", scanProtections);
  $("#protections-list")?.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-prot-id]");
    if (!btn || btn.disabled) return;
    const id = btn.dataset.protId;
    const enable = btn.dataset.protAction === "enable";
    toggleProtection(id, enable);
  });

  document.addEventListener("cgs:hv-tab-changed", (event) => {
    if (event.detail === "vbs") scan();
    if (event.detail === "protections" && !pState.items.length && !pState.loading) scanProtections();
  });

  // Внешний CMD может изменить систему, пока Eclipse свёрнут. Только чтение, без таймера и записей.
  window.addEventListener("cgs:view-changed", (event) => { if (event.detail === "hypervisor" && isActive()) scan({ automatic: true }); });
  window.addEventListener("focus", () => scan({ automatic: true }));
  document.addEventListener("visibilitychange", () => { if (!document.hidden) scan({ automatic: true }); });

  if (isActive()) scan();
})();
