(() => {
  "use strict";

  // updates — проверка обновлений приложения, примечания к релизу, скачивание и безопасная замена EXE
  window.cgsUpdates = {
    create({
      state, $, $$, tauri, invoke, call, setBusy, log, toast, errorText, showModal,
      activeOperations, checkLoaderDllUpdates, performLoaderUpdate,
      shouldPromptLoaderStartupUpdate, promptLoaderUpdateModal,
    }) {
  function extractChangelog(notesRaw, lang = "ru", markdown = false) {
    if (!notesRaw || typeof notesRaw !== "string") return "";
    const clean = notesRaw.trim();
    if (!clean) return "";

    let enPart = "";
    let ruPart = "";

    // Русская секция (Markdown или HTML); границы исключают совпадение с Antivirus
    const ruHeaderRegex = /(?:(?:^|\n)##?\s*(?:Русский|\b(?:Russian|RU)\b)|<h[1-3][^>]*>(?:(?!<\/h[1-3]>).)*?(?:(?<=^|[\s>"'«])Русский(?=$|[\s<"'».,:;])|\b(?:Russian|RU)\b)(?:(?!<\/h[1-3]>).)*?<\/h[1-3]>)/iu;
    const ruHeaderMatch = clean.match(ruHeaderRegex);

    const hrRegex = /(?:---|(?<!<[^>]*)<hr\s*\/?>)/i;
    const hrMatch = clean.match(hrRegex);

    if (ruHeaderMatch) {
      enPart = clean.slice(0, ruHeaderMatch.index).replace(/(?:---|<hr\s*\/?>)[\s\r\n]*$/, "").trim();
      ruPart = clean.slice(ruHeaderMatch.index + ruHeaderMatch[0].length).trim();
    } else if (hrMatch) {
      enPart = clean.slice(0, hrMatch.index).trim();
      ruPart = clean.slice(hrMatch.index + hrMatch[0].length).replace(/^[^>]*>/, "").trim();
    } else {
      enPart = clean;
      ruPart = clean;
    }

    let target = (lang === "en" ? enPart : ruPart) || clean;

    // Дублирующий H1-заголовок релиза
    target = target.replace(/^(?:#\s*Eclipse\s*Studio[^\n]*\n+|<h1[^>]*>[\s\S]*?<\/h1>)/i, "").trim();

    // HTML → читаемый текст
    target = target.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "• $1\n");
    target = target.replace(/<h[2-4][^>]*>(.*?)<\/h[2-4]>/gi, "\n$1:\n");
    target = target.replace(/<br\s*\/?>/gi, "\n");
    target = target.replace(/<[^>]+>/g, "");

    // Остаточный префикс заголовка языка
    target = target.replace(/^(?:##?\s*(?:Русский|Russian|RU|English|EN)[^\n]*\n+)+/i, "").trim();

    // Частые HTML-сущности
    target = target
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");

    // Для DOM-рендера возвращаем Markdown: заголовки и списки сохранятся
    if (markdown) {
      return target.replace(/^[ \t]+/gm, "").replace(/\n\s*\n\s*\n/g, "\n\n").trim();
    }

    // Подзаголовки ### → аккуратный текст
    target = target.replace(/^###?\s*(.+)$/gm, "$1:");

    // Буллеты (* **Пункт**) → «• Пункт»
    target = target.replace(/^[\*\-]\s+\*\*([^\*]+)\*\*:\s*/gm, "• $1: ");
    target = target.replace(/^[\*\-]\s+/gm, "• ");

    // Оставшееся выделение жирным
    target = target.replace(/\*\*([^\*]+)\*\*/g, "$1");

    return target.replace(/^[ \t]+/gm, "").replace(/\n\s*\n\s*\n/g, "\n\n").trim();
  }

  // Рендер заметок только DOM-узлами — HTML из заметок не интерпретируется
  function renderUpdateNotes(container, notes) {
    if (!container) return;
    container.replaceChildren();

    // Разметка **жирного** и `кода` внутри строки без innerHTML
    const inline = (parent, text) => {
      for (const part of String(text).split(/(\*\*[^*]+\*\*|`[^`]+`)/g)) {
        if (part.startsWith("**") && part.endsWith("**")) {
          const strong = document.createElement("strong");
          strong.textContent = part.slice(2, -2);
          parent.append(strong);
        } else if (part.startsWith("`") && part.endsWith("`")) {
          const code = document.createElement("code");
          code.textContent = part.slice(1, -1);
          parent.append(code);
        } else if (part) {
          parent.append(document.createTextNode(part));
        }
      }
    };

    let list = null;
    let paragraph = null;
    for (const line of String(notes || "").replace(/\r/g, "").split("\n")) {
      const text = line.trim();
      // Пустая строка завершает текущий список и абзац
      if (!text) {
        list = null;
        paragraph = null;
        continue;
      }
      const heading = text.match(/^#{1,6}\s+(.+)$/);
      const item = text.match(/^(?:[-*+] |\d+\. |• )(.+)$/);
      if (heading) {
        // Заголовок всегда сбрасывает список и абзац
        list = null;
        paragraph = null;
        const title = document.createElement("h4");
        inline(title, heading[1]);
        container.append(title);
      } else if (item) {
        // Новый список начинается после абзаца, заголовка или пустой строки
        paragraph = null;
        if (!list) {
          list = document.createElement("ul");
          container.append(list);
        }
        const entry = document.createElement("li");
        inline(entry, item[1]);
        list.append(entry);
      } else {
        // Абзац сбрасывает список; продолжение строки дополняет текущий абзац
        list = null;
        if (!paragraph) {
          paragraph = document.createElement("p");
          container.append(paragraph);
        } else {
          paragraph.append(document.createTextNode(" "));
        }
        inline(paragraph, text);
      }
    }
    container.scrollTop = 0;
  }

  // ── Обновление программы: проверенная загрузка, замена с откатом, перезапуск
  const UPDATE_SNOOZE_KEY = "cgs-update-snooze-launches";
  const UPDATE_SESSIONS_KEY = "cgs-update-snooze-sessions";
  const UPDATE_SNOOZE_LAUNCHES = 5;
  const UPDATE_CANCELLED = "Обновление отменено.";
  let activeUpdatePrompt = null;

  const updateText = (ru, en) => (window.cgsI18n?.language === "en" ? en : ru);
  const formatMegabytes = (bytes) => (Math.max(0, Number(bytes) || 0) / 1048576).toFixed(1);

  // Идентификатор запуска процесса: перезагрузка окна не расходует откладывание
  function updateSessionId() {
    if (window.cgsAppSession) return window.cgsAppSession;
    let id = sessionStorage.getItem("cgs-update-preview-session");
    if (!id) {
      id = crypto.randomUUID();
      sessionStorage.setItem("cgs-update-preview-session", id);
    }
    return id;
  }

  function readUpdateSessions() {
    try {
      const entries = JSON.parse(window.cgsStorage.getItem(UPDATE_SESSIONS_KEY) || "[]");
      return Array.isArray(entries) ? entries : [];
    } catch (_) {
      return [];
    }
  }

  function rememberUpdateSnooze(skipped) {
    const id = updateSessionId();
    const entries = readUpdateSessions().filter((item) => item?.id !== id).slice(-19);
    entries.push({ id, skipped });
    window.cgsStorage.setItem(UPDATE_SESSIONS_KEY, JSON.stringify(entries));
  }

  // Каждый новый запуск расходует одно откладывание; на шестом запуске окно появится снова
  function consumeUpdateSnooze() {
    try {
      const previous = readUpdateSessions().find((item) => item?.id === updateSessionId());
      if (previous) return Boolean(previous.skipped);
      const count = Number(window.cgsStorage.getItem(UPDATE_SNOOZE_KEY));
      if (Number.isInteger(count) && count > 0 && count <= UPDATE_SNOOZE_LAUNCHES) {
        window.cgsStorage.setItem(UPDATE_SNOOZE_KEY, String(count - 1));
        rememberUpdateSnooze(true);
        return true;
      }
      window.cgsStorage.removeItem(UPDATE_SNOOZE_KEY);
      rememberUpdateSnooze(false);
    } catch (_) {}
    return false;
  }

  // Посторонние операции: обновление ждёт их завершения, чтобы не прервать запись файлов
  function otherOperationsRunning() {
    for (const [id, source] of [...activeOperations]) {
      // Кнопка, удалённая из DOM или снятая с занятости без события, больше не блокирует обновление
      if (source === "button" && !document.getElementById(id)?.classList.contains("busy")) activeOperations.delete(id);
    }
    if (activeOperations.size) return true;
    const jobs = window.cgsJobs?.list?.() || [];
    if (jobs.some((job) => job.status === "running" && job.command !== "install_update")) return true;
    return Boolean(document.querySelector('[aria-busy="true"], [data-busy="true"]'));
  }

  // Строка состояния в карточке «Обновления» с переводом при смене языка
  function setUpdateStatus(ru, en = ru, kind = "") {
    state.updates.status = { ru, en, kind };
    renderUpdateStatus();
  }

  function renderUpdateStatus() {
    const status = $("#update-status");
    const value = state.updates.status;
    if (!status || !value) return;
    status.textContent = updateText(value.ru, value.en);
    status.classList.toggle("available", value.kind === "available");
    status.classList.toggle("error", value.kind === "error");
  }

  // Видимая часть приложения недоступна, пока открыто окно; кнопки окна Windows остаются
  function setUpdateShellInert(inert) {
    const shell = $(".app-shell");
    if (!shell) return;
    [...shell.children]
      .filter((node) => !node.classList.contains("titlebar"))
      .concat([$("#titlebar-search"), $("#open-telegram-hub")])
      .filter(Boolean)
      .forEach((node) => { node.inert = inert; });
  }

  function updatePhaseLabel(phase) {
    return {
      loader: updateText("Обновление библиотек OpenSteamTool…", "Updating OpenSteamTool libraries…"),
      preparing: updateText("Подготовка обновления…", "Preparing update…"),
      downloading: updateText("Скачивание обновления", "Downloading update"),
      retrying: updateText("Переподключение к серверу…", "Reconnecting to the server…"),
      verifying: updateText("Проверка целостности и версии EXE…", "Verifying EXE integrity and version…"),
      installing: updateText("Подготовка установки…", "Preparing installation…"),
      restarting: updateText("Установка и перезапуск программы…", "Installing and restarting the app…"),
    }[phase] || updateText("Подготовка обновления…", "Preparing update…");
  }

  function setUpdateProgress(percent, indeterminate = false) {
    const bar = $("#app-update-progress");
    const fill = $("#app-update-progress-fill");
    bar.classList.toggle("indeterminate", indeterminate);
    if (indeterminate) {
      bar.removeAttribute("aria-valuenow");
      fill.style.width = "";
      $("#app-update-percent").textContent = "…";
      return;
    }
    const value = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
    bar.setAttribute("aria-valuenow", String(value));
    fill.style.width = `${value}%`;
    $("#app-update-percent").textContent = `${value}%`;
  }

  function renderUpdateProgress(view) {
    const phaseNode = $("#app-update-phase");
    const detailNode = $("#app-update-detail");
    $("#app-update-progress-wrap").dataset.state = view;
    if (view === "ready") {
      phaseNode.textContent = updateText("Готово к загрузке", "Ready to download");
      detailNode.textContent = updateText(
        "Перед заменой EXE проверяются SHA-256 и версия файла. Напоминание можно отложить на 5 запусков.",
        "The EXE's SHA-256 and version are verified before replacement. You can postpone the reminder for 5 launches."
      );
      setUpdateProgress(0);
      return;
    }
    if (view === "error" || view === "cancelled") {
      // Заголовок окна уже называет итог, здесь — пояснение к подробностям
      phaseNode.textContent = view === "error"
        ? updateText("Что пошло не так", "What went wrong")
        : updateText("Загрузка остановлена", "Download stopped");
      detailNode.textContent = view === "error"
        ? state.updates.failure
        : updateText("Загруженные файлы удалены, текущая версия не изменена.", "Downloaded files were removed; the current version is unchanged.");
      return;
    }
    const value = state.updates.progress || { phase: "preparing" };
    const phase = value.phase || "preparing";
    let detail = updateText("До начала замены EXE обновление можно отменить.", "You can cancel until the EXE replacement begins.");
    if (phase === "downloading") {
      const total = Number(value.total) || 0;
      const downloaded = Number(value.downloaded) || 0;
      const speed = state.updates.speed || 0;
      detail = total
        ? `${formatMegabytes(downloaded)} / ${formatMegabytes(total)} ${updateText("МБ", "MB")}`
        : `${formatMegabytes(downloaded)} ${updateText("МБ", "MB")}`;
      if (speed > 0) {
        detail += ` · ${(speed / 1048576).toFixed(2)} ${updateText("МБ/с", "MB/s")}`;
        if (total > downloaded) {
          const seconds = Math.max(1, Math.ceil((total - downloaded) / speed));
          detail += updateText(` · осталось примерно ${seconds} с`, ` · about ${seconds}s remaining`);
        }
      }
      setUpdateProgress(value.percent ?? (total ? (downloaded / total) * 100 : 0), !total);
    } else if (phase === "retrying") {
      const attempt = Number(value.attempt) || 2;
      detail = updateText(`Попытка ${attempt} из 3. ${value.message || ""}`, `Attempt ${attempt} of 3. ${value.message || ""}`).trim();
      setUpdateProgress(0, true);
    } else if (phase === "verifying") {
      detail = updateText("Сверяем SHA-256 из релиза GitHub, разрядность и версию EXE.", "Checking the GitHub release SHA-256, architecture and EXE version.");
      setUpdateProgress(100);
    } else if (phase === "installing") {
      detail = updateText("Текущая версия сохраняется для автоматического отката.", "The current version is kept for an automatic rollback.");
      setUpdateProgress(100);
    } else if (phase === "restarting") {
      detail = updateText("Программа закроется и запустится уже обновлённой. Отмена больше недоступна.", "The app closes and starts again updated. Cancelling is no longer possible.");
      setUpdateProgress(100);
    } else {
      setUpdateProgress(0, true);
    }
    phaseNode.textContent = state.updates.cancelling
      ? updateText("Отменяем обновление…", "Cancelling update…")
      : updatePhaseLabel(phase);
    detailNode.textContent = detail;
  }

  function renderUpdateDialog() {
    const prompt = activeUpdatePrompt;
    const update = prompt?.update || state.updates.latest;
    if (!update) return;
    const installing = state.updates.installing;
    const view = installing ? "working" : (state.updates.dialogState || "ready");
    const step2 = view === "ready" && prompt?.step === 2;
    const hasLoader = Boolean(prompt?.loaderUpdate);
    const version = update.latestVersion;

    $("#app-update-symbol").textContent = { working: "↓", error: "!" }[view] || "↑";
    $("#app-update-title").textContent = view === "error"
      ? updateText("Обновление не выполнено", "Update failed")
      : view === "cancelled"
        ? updateText("Обновление отменено", "Update cancelled")
        : installing
          ? updateText(`Обновление до версии ${version}`, `Updating to version ${version}`)
          : updateText(`Доступна версия ${version}`, `Version ${version} available`);
    $("#app-update-message").textContent = installing
      ? updateText("Не закрывайте программу: после проверки файла она перезапустится сама.", "Keep the app open: it restarts by itself after the file is verified.")
      : view === "ready"
        ? updateText("Программа обновится и запустится автоматически. Настройки и ярлыки сохранятся.", "The app updates and restarts automatically. Your settings and shortcuts stay in place.")
        : updateText("Текущая версия не изменена. Можно повторить попытку или отложить обновление.", "The current version is unchanged. You can try again or postpone the update.");

    const changelogText = extractChangelog(update.notes, window.cgsI18n?.language === "en" ? "en" : "ru", true);
    $("#app-update-changelog").classList.toggle("hidden", !changelogText || installing || step2);
    $("#app-update-changelog-toggle-text").textContent = updateText(`Список изменений (v${version})`, `Changelog (v${version})`);
    renderUpdateNotes($("#app-update-changelog-body"), changelogText);
    $("#app-update-step2").classList.toggle("hidden", !step2);
    $("#app-update-progress-wrap").classList.toggle("hidden", step2);
    renderUpdateProgress(view);

    const install = $("#app-update-install");
    const defer = $("#app-update-defer");
    const cancel = $("#app-update-cancel");
    const close = $("#app-update-close");
    install.classList.toggle("hidden", installing);
    defer.classList.toggle("hidden", installing);
    cancel.classList.toggle("hidden", !installing);
    cancel.disabled = state.updates.cancelling || state.updates.committing;
    close.disabled = state.updates.committing;
    install.textContent = hasLoader && view === "ready" && !step2
      ? updateText("Далее →", "Next →")
      : view === "error" || view === "cancelled"
        ? updateText("Повторить", "Try again")
        : updateText("Обновить и перезапустить", "Update and restart");
    defer.textContent = step2 ? updateText("Назад", "Back") : updateText("Отложить на 5 запусков", "Remind me after 5 launches");
    cancel.textContent = state.updates.cancelling ? updateText("Отменяем…", "Cancelling…") : updateText("Отменить обновление", "Cancel update");
    const closeLabel = installing ? updateText("Отменить обновление", "Cancel update") : updateText("Закрыть", "Close");
    close.setAttribute("aria-label", closeLabel);
    close.title = closeLabel;
  }

  function updateDialogOpen() {
    return !$("#app-update-backdrop").classList.contains("hidden");
  }

  function showUpdateDialog(loaderUpdate = null) {
    // Окно обновления программы важнее напоминания о локальном облаке
    if (window.cgsLocalCloud?.updateOpen?.()) window.cgsLocalCloud.closeUpdate();
    const update = state.updates.latest;
    if (!update?.available) return;
    if (!update.inAppSupported && !state.updates.installing) return;
    if (!activeUpdatePrompt || activeUpdatePrompt.update !== update) activeUpdatePrompt = { update, loaderUpdate: null, step: 1 };
    if (loaderUpdate?.updateAvailable) activeUpdatePrompt.loaderUpdate = loaderUpdate;
    if (!state.updates.installing) {
      state.updates.dialogState = "ready";
      activeUpdatePrompt.step = 1;
      $("#app-update-changelog").open = false;
    }
    renderUpdateDialog();
    const backdrop = $("#app-update-backdrop");
    backdrop.classList.remove("hidden", "closing");
    setUpdateShellInert(true);
    (state.updates.installing ? $("#app-update-cancel") : $("#app-update-install")).focus({ preventScroll: true });
  }

  function hideUpdateDialog() {
    const backdrop = $("#app-update-backdrop");
    if (backdrop.classList.contains("hidden")) return;
    setUpdateShellInert(false);
    backdrop.classList.add("closing");
    setTimeout(() => {
      backdrop.classList.add("hidden");
      backdrop.classList.remove("closing");
    }, 190);
  }

  // Крестик и Esc во время установки отменяют её, иначе просто закрывают окно
  function closeUpdateDialog() {
    if (state.updates.installing) {
      cancelAppUpdate();
      return;
    }
    hideUpdateDialog();
  }

  function deferUpdate() {
    if (state.updates.installing) return;
    if (activeUpdatePrompt?.step === 2 && (state.updates.dialogState || "ready") === "ready") {
      activeUpdatePrompt.step = 1;
      renderUpdateDialog();
      return;
    }
    try {
      window.cgsStorage.setItem(UPDATE_SNOOZE_KEY, String(UPDATE_SNOOZE_LAUNCHES));
      rememberUpdateSnooze(true);
    } catch (_) {}
    state.updates.snoozedThisLaunch = true;
    hideUpdateDialog();
    setUpdateStatus("Напомним об обновлении после следующих пяти запусков.", "We will remind you after the next five launches.", "available");
    toast(updateText("Обновление отложено на 5 запусков", "Update postponed for 5 launches"));
  }

  async function cancelAppUpdate() {
    if (!state.updates.installing || state.updates.cancelling || state.updates.committing) return;
    state.updates.cancelling = true;
    renderUpdateDialog();
    // До запуска загрузки отмена применяется после текущего шага (обновления библиотек)
    if (!state.updates.nativeStarted) return;
    try {
      await call("cancel_update");
    } catch (error) {
      state.updates.cancelling = false;
      renderUpdateDialog();
      toast(errorText(error), "error");
    }
  }

  // Библиотеки OpenSteamTool обновляются перед программой, если пользователь выбрал оба пункта
  async function updateLoaderBeforeApp() {
    const closed = await ensureSteamClosedForLoader();
    if (!closed) return false;
    try {
      const result = await call("luatools_update_loader", {
        steamPath: state.lua.steamPath || null,
        variant: state.lua.loaderSource || null,
      });
      if (result?.success) {
        clearLoaderPostpone();
        toast(updateText("Библиотеки OpenSteamTool успешно обновлены", "OpenSteamTool libraries updated successfully"), "success");
        $("#loader-update-banner")?.classList.add("hidden");
        if (state.lua.loaderUpdate) state.lua.loaderUpdate.updateAvailable = false;
      } else {
        log(`Обновление DLL перед обновлением программы: ${result?.message || "без подробностей"}`, "warn");
      }
    } catch (error) {
      log(`Ошибка обновления DLL в комбинированном режиме: ${errorText(error)}`, "warn");
    }
    return true;
  }

  function finishUpdateAttempt(view, message = "") {
    state.updates.installing = false;
    state.updates.cancelling = false;
    state.updates.committing = false;
    state.updates.nativeStarted = false;
    state.updates.dialogState = view;
    state.updates.failure = message;
    $("#check-update-button").disabled = false;
    renderUpdateDownloads(state.updates.latest);
    if (updateDialogOpen()) renderUpdateDialog();
  }

  async function installAppUpdate() {
    const update = state.updates.latest;
    const prompt = activeUpdatePrompt;
    if (state.updates.installing || !update?.inAppSupported) return;
    const view = state.updates.dialogState || "ready";
    // Комбинированный режим: сначала выбор, обновлять ли библиотеки Steam
    if (prompt?.loaderUpdate && view === "ready" && prompt.step !== 2) {
      prompt.step = 2;
      renderUpdateDialog();
      $("#app-update-install").focus({ preventScroll: true });
      return;
    }
    if (otherOperationsRunning()) {
      toast(updateText("Дождитесь завершения текущих операций перед обновлением.", "Wait for current operations to finish before updating."), "info");
      return;
    }
    const scope = prompt?.loaderUpdate && prompt.step === 2
      ? ($("input[name='app-update-scope']:checked")?.value || "both")
      : "app_only";
    const loaderPending = scope === "both" && state.lua.loaderUpdate?.updateAvailable !== false;
    state.updates.installing = true;
    state.updates.cancelling = false;
    state.updates.committing = false;
    state.updates.nativeStarted = false;
    state.updates.downloadSamples = [];
    state.updates.speed = 0;
    state.updates.failure = "";
    state.updates.progress = { phase: loaderPending ? "loader" : "preparing" };
    try { window.cgsStorage.removeItem(UPDATE_SNOOZE_KEY); } catch (_) {}
    $("#check-update-button").disabled = true;
    renderUpdateDialog();
    renderUpdateDownloads(update);
    setUpdateStatus(updateText("Обновление программы…", "Updating the app…"));
    $("#app-update-cancel").focus({ preventScroll: true });
    try {
      if (loaderPending) {
        const proceed = await updateLoaderBeforeApp();
        if (!proceed && !state.updates.cancelling) {
          finishUpdateAttempt("ready");
          setUpdateStatus(`Доступна версия ${update.latestVersion}`, `Version ${update.latestVersion} available`, "available");
          return;
        }
      }
      if (state.updates.cancelling) throw UPDATE_CANCELLED;
      state.updates.progress = { phase: "preparing" };
      state.updates.nativeStarted = true;
      renderUpdateDialog();
      await call("install_update", { version: update.latestVersion });
      // Программа закроется сама: окно остаётся в состоянии перезапуска
      state.updates.committing = true;
      state.updates.progress = { phase: "restarting" };
      renderUpdateDialog();
      setUpdateStatus("Установка и перезапуск программы…", "Installing and restarting the app…");
    } catch (error) {
      const message = errorText(error);
      const cancelled = state.updates.cancelling || message === UPDATE_CANCELLED;
      finishUpdateAttempt(cancelled ? "cancelled" : "error", cancelled ? "" : message);
      if (cancelled) setUpdateStatus("Обновление отменено", "Update cancelled", "available");
      else setUpdateStatus(message, message, "error");
      log(cancelled ? "Обновление программы отменено" : `Обновление программы: ${message}`, cancelled ? "info" : "error");
      if (!updateDialogOpen()) toast(cancelled ? updateText("Обновление отменено", "Update cancelled") : message, cancelled ? "info" : "error");
    }
  }

  // Ход установки из бэкенда (событие cgs-update-progress)
  function updateProgress(value = {}) {
    if (!state.updates.installing || !value) return;
    const phase = value.phase || "preparing";
    if (phase === "downloading") {
      const now = performance.now();
      let samples = state.updates.downloadSamples || [];
      const downloaded = Number(value.downloaded) || 0;
      if (samples.length && downloaded < samples.at(-1).bytes) samples = [];
      samples.push({ time: now, bytes: downloaded });
      while (samples.length > 2 && now - samples[0].time > 3000) samples.shift();
      state.updates.downloadSamples = samples;
      const elapsed = (now - samples[0].time) / 1000;
      state.updates.speed = elapsed > 0.05 ? Math.max(0, (downloaded - samples[0].bytes) / elapsed) : 0;
    } else {
      state.updates.downloadSamples = [];
      state.updates.speed = 0;
    }
    state.updates.committing = phase === "restarting";
    state.updates.progress = value;
    renderUpdateDialog();
    renderUpdateDownloads(state.updates.latest);
    const label = updatePhaseLabel(phase);
    state.updates.status = { ru: label, en: label, kind: "" };
    $("#update-status").textContent = label;
    $("#update-status").classList.remove("available", "error");
  }

  // Запуск: сигнал здоровья новой версии, итог прошлой установки и счётчик откладываний
  async function initUpdates() {
    if (!invoke) return;
    try {
      const outcome = await call("update_launch_ready");
      if (typeof outcome?.success === "boolean") {
        if (outcome.success) window.cgsStorage.removeItem(UPDATE_SNOOZE_KEY);
        else state.updates.suppressAuto = true;
        setUpdateStatus(outcome.message, outcome.message, outcome.success ? "" : "error");
        log(outcome.message, outcome.success ? "success" : "error");
        toast(outcome.message, outcome.success ? "success" : "error");
      }
    } catch (error) {
      log(`Итог обновления: ${errorText(error)}`, "error");
    }
    // Старый счётчик «10 запусков» больше не используется
    for (const key of ["cgs-postpone-update-version", "cgs-postpone-update-launches"]) {
      try { window.cgsStorage.removeItem(key); } catch (_) {}
    }
    try {
      const info = await call("platform_info");
      window.cgsAppSession = info?.sessionId || null;
    } catch (_) {}
    state.updates.snoozedThisLaunch = consumeUpdateSnooze();
    try {
      await tauri?.event?.listen?.("cgs-update-progress", (event) => updateProgress(event.payload));
    } catch (error) {
      log(`Ход обновления: ${errorText(error)}`, "error");
    }
  }

  function renderUpdateDownloads(update = null) {
    state.updates.latest = update;
    const available = Boolean(update?.available);
    const installBtn = $("#update-install-button");
    if (installBtn) {
      installBtn.classList.toggle("hidden", !available);
      installBtn.disabled = !update?.inAppSupported && !state.updates.installing;
      installBtn.textContent = state.updates.installing
        ? updateText("Ход обновления", "Update progress")
        : updateText("Обновить и перезапустить", "Update and restart");
      installBtn.title = update?.inAppSupported || !available
        ? ""
        : updateText("В релизе нет проверяемого EXE для обновления внутри программы.", "This release has no verified EXE for in-app updates.");
    }
    $("#download-portable-button").classList.toggle("hidden", !update?.portableUrl);
    $("#download-installer-button").classList.toggle("hidden", !update?.installerUrl);
    $("#update-download-actions").classList.toggle("hidden", !available);
  }

  async function openUpdateDownload(kind) {
    const update = state.updates.latest;
    if (!update) return;
    const url = kind === "portable" ? update.portableUrl : update.installerUrl;
    await call("open_external", { url: url || update.releaseUrl });
  }

  async function checkForUpdates(interactive = false) {
    if (!interactive) {
      await state.updates.ready;
      // Первый выбор языка не должен перекрываться окном автообновления
      await window.cgsLanguageReady;
      if (document.querySelector("dialog[open]")) {
        setTimeout(() => checkForUpdates(false), 1500);
        return;
      }
    }
    if (state.updates.checking || state.updates.installing) return;

    if (!invoke) {
      if (interactive) toast(updateText("Режим разработки (без Tauri backend).", "Development mode (no Tauri backend)."));
      return;
    }
    state.updates.checking = true;
    const button = $("#check-update-button");
    setBusy(button, true, updateText("Проверяем…", "Checking…"));
    setUpdateStatus("Подключение к GitHub…", "Connecting to GitHub…");

    try {
      // При фоновой проверке на старте параллельно проверяем библиотеки OpenSteamTool
      const [update, loaderUpdate] = await Promise.all([
        call("check_for_update"),
        !interactive
          ? call("luatools_check_loader_updates", { steamPath: state.lua.steamPath || null, force: false }).catch(() => null)
          : Promise.resolve(null),
      ]);

      if (loaderUpdate) {
        state.lua.loaderUpdate = loaderUpdate;
        $("#loader-update-banner")?.classList.toggle("hidden", !loaderUpdate.updateAvailable);
      }

      $("#update-current-version").textContent = update.currentVersion;
      state.version = update.currentVersion;
      const aboutVerEl = $("#about-app-version");
      if (aboutVerEl) aboutVerEl.textContent = update.currentVersion;
      const promptLoader = () => {
        if (!interactive && loaderUpdate?.updateAvailable && shouldPromptLoaderStartupUpdate()) promptLoaderUpdateModal(loaderUpdate);
      };

      if (!update.available) {
        renderUpdateDownloads();
        setUpdateStatus(`Установлена актуальная версия ${update.currentVersion}`, `Version ${update.currentVersion} is up to date`);
        if (interactive) toast(updateText("У вас установлена последняя версия", "You have the latest version installed"));
        promptLoader();
        return;
      }

      renderUpdateDownloads(update);
      if (!update.inAppSupported) {
        setUpdateStatus(
          `Доступна версия ${update.latestVersion}. В релизе нет проверяемого EXE для обновления внутри программы — скачайте его вручную.`,
          `Version ${update.latestVersion} is available. This release has no verified EXE for in-app updates, so download it manually.`,
          "available"
        );
        if (interactive || state.updates.promptedVersion !== update.latestVersion) {
          state.updates.promptedVersion = update.latestVersion;
          toast(updateText(`Доступна версия ${update.latestVersion}: скачайте её в разделе «Обновления»`, `Version ${update.latestVersion} is available: download it in Updates`));
        }
        promptLoader();
        return;
      }
      setUpdateStatus(`Доступна версия ${update.latestVersion}`, `Version ${update.latestVersion} available`, "available");
      if (!interactive) {
        // Отложено, подавлено после неудачной установки, уже показано или идут операции
        const skip = state.updates.snoozedThisLaunch || state.updates.suppressAuto
          || state.updates.promptedVersion === update.latestVersion || otherOperationsRunning();
        if (skip) {
          promptLoader();
          return;
        }
      }
      if (!interactive && document.querySelector("dialog[open]")) {
        setTimeout(() => checkForUpdates(false), 1500);
        return;
      }
      state.updates.promptedVersion = update.latestVersion;
      showUpdateDialog(loaderUpdate);
    } catch (error) {
      const message = errorText(error);
      setUpdateStatus(message, message, "error");
      log(`Проверка обновлений: ${message}`, "error");
      if (interactive) toast(message, "error");
    } finally {
      state.updates.checking = false;
      setBusy(button, false);
      button.disabled = state.updates.installing;
    }
  }


    return {
      extractChangelog, renderUpdateNotes, updateText, setUpdateStatus,
      renderUpdateStatus, renderUpdateDownloads, updateDialogOpen,
      renderUpdateDialog, showUpdateDialog, hideUpdateDialog, closeUpdateDialog,
      deferUpdate, cancelAppUpdate, installAppUpdate, updateProgress,
      initUpdates, openUpdateDownload, checkForUpdates,
    };
    },
  };
})();
