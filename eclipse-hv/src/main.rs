//! Eclipse-HV — автономный лаунчер гипервизорного окружения.
//! Конвейер из 7 шагов с журналированием; сбой формирует отчёт и восстанавливает состояние.

#![windows_subsystem = "windows"]

mod avcheck;
mod avguard;
mod cert;
mod conflicts;
mod dse;
mod error;
mod game;
mod logging;
mod offsets;
mod preflight;
mod process;
mod rtcore;
mod status;
mod sys;

/// Макрос записи события в журнал: `hvlog!(Уровень, "категория", "текст")`.
#[macro_export]
macro_rules! hvlog {
    ($level:ident, $category:expr, $($arg:tt)*) => {{
        $crate::logging::log(
            $crate::logging::Level::$level,
            $category,
            &format!($($arg)*),
        );
    }};
}

use std::{env, path::PathBuf, process::Command};

use error::{Diagnostics, HvError};

const STEP_PRIVILEGES: &str = "Шаг 1/7: права администратора";
const STEP_PREFLIGHT: &str = "Шаг 2/7: проверка системы";
const STEP_CONFLICTS: &str = "Шаг 3/7: нейтрализация конфликтов";
const STEP_LOADER: &str = "Шаг 4/7: подготовка окружения";
const STEP_SEARCH: &str = "Шаг 5/7: поиск исполняемого файла игры";
const STEP_LAUNCH: &str = "Шаг 6/7: запуск игры";
const STEP_RESTORE: &str = "Шаг 7/7: восстановление и очистка";

const HELP_TEXT: &str = "Eclipse-HV — автономный лаунчер гипервизорного окружения.

Использование:
  Eclipse-HV.exe [игра.exe] [ключи]

Аргументы:
  игра.exe      прямой путь к исполняемому файлу игры; без него файл
                ищется автоматически рядом с лаунчером
  --debug, -d   режим отладки: консоль с подробным журналом
  --status      осмотр системы: защиты, службы, конфликты, сертификат,
                антивирус (только чтение, настройки защиты не меняются)
  cert <операция>  управление тестовым сертификатом подписи
                    (install / remove / sign <файл> / status)
  --help, -h    эта справка

Порядок работы:
  1. Запрос прав администратора
  2. Проверка изоляции ядра (HVCI), VBS, фактического состояния защит,
     состояния процессора и антивируса
  3. Нейтрализация конфликтующих программ
  4. Подготовка окружения: временный обход проверки подписей
  5. Поиск и запуск игры
  6. Восстановление защиты и автоперезапуск остановленных программ

Журнал работы: Eclipse-HV.log (рядом с лаунчером)
Отчёты: Eclipse-HV-error.json, Eclipse-HV-status.json

Настройки антивируса: на время сессии лаунчер добавляет себя, свой каталог
и временный каталог драйвера в исключения Защитника Windows, а при
завершении снимает их. Исключения пользователя не изменяются; если сессию
прервали принудительно, следы снимаются при следующем запуске.";

const CERT_USAGE_TEXT: &str = "Управление тестовым сертификатом подписи кода.

Использование:
  Eclipse-HV.exe cert install       создать сертификат «Eclipse-HV Test CA»
                                     и установить его в доверенные хранилища
                                     (требуются права администратора)
  Eclipse-HV.exe cert remove        удалить сертификат из всех хранилищ
                                     (требуются права администратора)
  Eclipse-HV.exe cert sign <файл>   подписать файл тестовым сертификатом
  Eclipse-HV.exe cert status        показать состояние сертификата

Сертификат работает в режиме тестовой подписи Windows.
Включение: bcdedit /set testsigning on (затем перезагрузка)
либо через Eclipse Studio, раздел «Гипервизор» → VBS 2.0.
Выключение: bcdedit /set testsigning off.";

/// Подкоманда лаунчера (не запускает конвейер игры).
#[derive(Debug, Clone, PartialEq)]
enum Subcommand {
    Status,
    Cert(cert::CertOp),
}

struct Args {
    debug: bool,
    help: bool,
    subcommand: Option<Subcommand>,
    cert_requested: bool,
    explicit_target: Option<PathBuf>,
    raw: Vec<String>,
}

#[derive(Default)]
struct Session {
    diagnostics: Diagnostics,
    dse: Option<dse::DseSession>,
    conflict_state: conflicts::ConflictState,
    av_guard: avguard::AvGuard,
}

fn main() {
    let args = parse_args();

    if args.help {
        sys::show_info_box(&format!("{} — справка", sys::APP_TITLE), HELP_TEXT);
        return;
    }

    // Подкоманда сертификата с нераспознанной операцией: справка и выход
    if args.cert_requested && args.subcommand.is_none() {
        sys::show_info_box(&format!("{} — сертификат", sys::APP_TITLE), CERT_USAGE_TEXT);
        std::process::exit(1);
    }

    let code = match &args.subcommand {
        Some(Subcommand::Status) => run_status(&args),
        Some(Subcommand::Cert(op)) => run_cert(&args, op),
        None => launch(&args),
    };
    std::process::exit(code);
}

fn parse_args() -> Args {
    parse_args_from(env::args().collect())
}

fn parse_args_from(raw: Vec<String>) -> Args {
    let matches_flag = |names: &[&str], arg: &str| {
        let value = arg.trim().to_lowercase();
        names.contains(&value.as_str())
    };

    let debug = raw
        .iter()
        .skip(1)
        .any(|arg| matches_flag(&["--debug", "-debug", "/debug", "-d", "/d"], arg));
    let help = raw
        .iter()
        .skip(1)
        .any(|arg| matches_flag(&["--help", "-help", "/help", "-h", "/h", "help", "?"], arg));

    // Ключи — в любом месте, «голое» слово status — только первым,
    // чтобы не конфликтовать с операцией «cert status»
    let status_requested = raw
        .iter()
        .skip(1)
        .any(|arg| matches_flag(&["--status", "-status", "/status"], arg))
        || raw.get(1).is_some_and(|arg| matches_flag(&["status"], arg));

    // Подкоманда сертификата: первый позиционный аргумент «cert» (приоритет выше)
    let cert_requested = raw
        .get(1)
        .is_some_and(|arg| arg.trim().eq_ignore_ascii_case("cert"));

    let subcommand = if cert_requested {
        raw.get(2)
            .map(|op| op.trim().to_lowercase())
            .and_then(|op| match op.as_str() {
                "install" => Some(Subcommand::Cert(cert::CertOp::Install)),
                "remove" => Some(Subcommand::Cert(cert::CertOp::Remove)),
                "status" => Some(Subcommand::Cert(cert::CertOp::Status)),
                "sign" => raw
                    .get(3)
                    .map(|path| Subcommand::Cert(cert::CertOp::Sign(PathBuf::from(path)))),
                _ => None,
            })
    } else if status_requested {
        Some(Subcommand::Status)
    } else {
        None
    };

    // Явный путь к игре — существующий exe; в режимах подкоманд не интерпретируется
    let explicit_target = if subcommand.is_some() || cert_requested {
        None
    } else {
        raw.iter().skip(1).find_map(|arg| {
            if arg.starts_with('-') || arg.starts_with('/') {
                return None;
            }
            let path = PathBuf::from(arg);
            if path.is_file() && path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("exe")) {
                Some(path)
            } else {
                None
            }
        })
    };

    Args {
        debug,
        help,
        subcommand,
        cert_requested,
        explicit_target,
        raw,
    }
}

/// Инициализация: журнал, обработчик прерывания, рабочий каталог.
fn bootstrap(args: &Args) -> PathBuf {
    // Базовый каталог: папка, в которой размещён сам лаунчер
    let base_dir = env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(|path| path.to_path_buf()))
        .unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let _ = env::set_current_dir(&base_dir);

    logging::init(&base_dir);
    sys::install_interrupt_handler();

    hvlog!(
        Info,
        "старт",
        "{} запущен (аргументы: {:?}), каталог: {}",
        sys::app_name_with_version(),
        args.raw.iter().skip(1).collect::<Vec<_>>(),
        base_dir.display()
    );

    base_dir
}

/// Осмотр системы без изменений (`--status`).
fn run_status(args: &Args) -> i32 {
    let base_dir = bootstrap(args);
    if args.debug {
        sys::init_debug_console();
        logging::enable_console();
    }

    hvlog!(Info, "диагностика", "запрошен осмотр системы (--status)");

    let status = status::collect();
    status::log_summary(&status);

    let report_path = status::write_report(&status, &base_dir);
    let mut text = status::summary(&status).join("\n");
    match &report_path {
        Some(path) => {
            hvlog!(Info, "диагностика", "отчёт записан: {}", path.display());
            text.push_str(&format!("\n\nПодробный отчёт: {}", path.display()));
        }
        None => text.push_str("\n\nНе удалось записать файл отчёта (подробности в журнале)."),
    }

    sys::show_info_box(&format!("{} — состояние системы", sys::APP_TITLE), &text);
    hvlog!(Info, "диагностика", "осмотр системы завершён");
    0
}

fn run_cert(args: &Args, op: &cert::CertOp) -> i32 {
    let _base_dir = bootstrap(args);
    if args.debug {
        sys::init_debug_console();
        logging::enable_console();
    }
    hvlog!(Info, "сертификат", "операция: {op:?}");

    let result = match op {
        cert::CertOp::Install => cert::install().map(|thumbprint| {
            format!(
                "Тестовый сертификат «Eclipse-HV Test CA» создан и установлен.\n\
                 Отпечаток: {thumbprint}\n\n\
                 Сертификат работает в режиме тестовой подписи Windows:\n\
                 bcdedit /set testsigning on и перезагрузка\n\
                 (или раздел «Гипервизор» → VBS 2.0 в Eclipse Studio)."
            )
        }),
        cert::CertOp::Remove => cert::remove().map(|count| {
            format!("Тестовый сертификат удалён из хранилищ (записей: {count}).")
        }),
        cert::CertOp::Sign(path) => cert::sign(path).map(|()| {
            format!("Файл подписан тестовым сертификатом:\n{}", path.display())
        }),
        cert::CertOp::Status => {
            let state = cert::status();
            if state.installed() {
                Ok(format!(
                    "Тестовый сертификат установлен.\nОтпечаток: {}\nХранилища: {}",
                    state.thumbprint.unwrap_or_default(),
                    state.stores.join(", ")
                ))
            } else {
                Ok(
                    "Тестовый сертификат не установлен.\nВыполните: Eclipse-HV.exe cert install"
                        .to_string(),
                )
            }
        }
    };

    match result {
        Ok(message) => {
            hvlog!(Info, "сертификат", "операция завершена успешно");
            sys::show_info_box(&format!("{} — сертификат", sys::APP_TITLE), &message);
            0
        }
        Err(cause) => HvError::new(
            "Сертификат подписи",
            cert_error_code(op),
            "Не удалось выполнить операцию с тестовым сертификатом.",
        )
        .with_cause(cause)
        .report(),
    }
}

fn cert_error_code(op: &cert::CertOp) -> &'static str {
    match op {
        cert::CertOp::Install => "CERT_INSTALL",
        cert::CertOp::Remove => "CERT_REMOVE",
        cert::CertOp::Sign(_) => "CERT_SIGN",
        cert::CertOp::Status => "CERT_STATUS",
    }
}

fn launch(args: &Args) -> i32 {
    let base_dir = bootstrap(args);

    let mut session = Session::default();

    let result = run(args, &base_dir, &mut session);

    match result {
        Ok(code) => {
            hvlog!(Info, "старт", "сессия завершена успешно (код {code})");
            code
        }
        Err(err) => {
            // Аварийное восстановление состояния системы перед отчётом
            emergency_cleanup(&mut session);
            err.report()
        }
    }
}

fn run(args: &Args, base_dir: &std::path::Path, session: &mut Session) -> Result<i32, HvError> {
    // ── Шаг 1: права администратора
    hvlog!(Info, "старт", "── {STEP_PRIVILEGES} ──");
    let elevated = sys::is_elevated().map_err(|cause| {
        HvError::new(STEP_PRIVILEGES, "ADMIN_CHECK", "Не удалось проверить права администратора.")
            .with_cause(cause)
            .with_diagnostics(session.diagnostics.clone())
    })?;

    if !elevated {
        hvlog!(Info, "старт", "права администратора отсутствуют, запрос повышения");
        sys::elevate_self(&args.raw).map_err(|cause| {
            HvError::new(
                STEP_PRIVILEGES,
                "UAC_ELEVATION",
                "Не удалось запросить повышение прав администратора.",
            )
            .with_cause(cause)
            .with_diagnostics(session.diagnostics.clone())
        })?;
        // Продолжает повышенный дочерний процесс; родитель завершается
        hvlog!(Info, "старт", "повышенный процесс запущен, родительский завершается");
        return Ok(0);
    }
    hvlog!(Info, "старт", "права администратора подтверждены");

    // Консоль отладки создаётся только в повышенном процессе
    if args.debug {
        sys::init_debug_console();
        logging::enable_console();
        hvlog!(Info, "старт", "режим отладки: консольный вывод журнала включён");
    }
    session.diagnostics.steps_completed.push(STEP_PRIVILEGES.into());

    // ── Шаг 2: проверка системы
    hvlog!(Info, "среда", "── {STEP_PREFLIGHT} ──");
    hvlog!(Info, "среда", "операционная система: {}", sys::os_description());
    let summary = preflight::inspect();
    session.diagnostics.hvci_enabled = Some(summary.hvci_running || summary.hvci_configured);
    session.diagnostics.hvci_running = Some(summary.hvci_running);
    session.diagnostics.vbs_running = Some(summary.vbs_running);
    session.diagnostics.xcr0_value = Some(summary.xcr0);
    hvlog!(Info, "среда", "регистр XCR0: {}", summary.xcr0);
    for line in summary.summary_lines() {
        hvlog!(Info, "среда", "{line}");
    }

    if summary.protections_require_action() {
        let state = summary.summary_lines().join("\n");

        // UEFI-блокировка и групповая политика перекрывают правку реестра — перезагрузка бессмысленна
        if summary.hvci_locked || summary.policy_managed {
            return Err(protections_locked_error(&summary, &state)
                .with_diagnostics(session.diagnostics.clone()));
        }

        let question = format!(
            "Защиты Windows несовместимы с гипервизорным окружением:\n\n{state}\n\n\
             Отключить изоляцию ядра (HVCI) и виртуальную защиту (VBS), а также \
             гипервизор Windows в загрузчике, и перезагрузить компьютер прямо сейчас?"
        );

        if sys::ask_user_yes_no(
            &format!("{} — требуется отключение защит", sys::APP_TITLE),
            &question,
        ) {
            preflight::disable_hvci_and_reboot().map_err(|cause| {
                HvError::new(
                    STEP_PREFLIGHT,
                    "HVCI_DISABLE_FAILED",
                    "Не удалось применить параметры отключения изоляции ядра и VBS.",
                )
                .with_cause(cause)
                .with_diagnostics(session.diagnostics.clone())
            })?;
            hvlog!(Info, "среда", "параметры применены, ожидание перезагрузки");
            return Ok(0);
        }

        return Err(HvError::new(
            STEP_PREFLIGHT,
            "CORE_ISOLATION_CHECK",
            &format!(
                "Защиты Windows остались включёнными.\n\n{state}\n\n\
                 Для работы гипервизора отключите их одним из способов:\n\
                 1. Eclipse Studio → «Гипервизор» → «VBS 2.0» → «Выключить визор»;\n\
                 2. «Безопасность Windows» → «Безопасность устройства» → «Изоляция ядра»;\n\
                 3. вручную: параметры DeviceGuard в реестре и bcdedit /set hypervisorlaunchtype off.\n\n\
                 После отключения перезагрузите компьютер и запустите игру повторно."
            ),
        )
        .with_diagnostics(session.diagnostics.clone()));
    }

    // Современные процессоры с расширенными состояниями (XCR0 > 7)
    if summary.xcr0 > 7 {
        hvlog!(Warn, "среда", "обнаружен XCR0 = {} (> 7), рекомендуется ограничение контекста", summary.xcr0);
        let question = "Обнаружен современный процессор с расширенными инструкциями (XCR0 > 7: AVX-512 / Zen 4 / Intel 12+).\n\n\
            Для совместимости с гипервизорным окружением требуется ограничить размер\
            контекста процессора в BCD (xsaveremovefeature).\n\n\
            Применить оптимизацию BCD и перезагрузить компьютер прямо сейчас?";

        if sys::ask_user_yes_no(&format!("{} — оптимизация процессора", sys::APP_TITLE), question) {
            preflight::configure_xsave_and_reboot().map_err(|cause| {
                HvError::new(
                    STEP_PREFLIGHT,
                    "XCR0_OPTIMIZATION_FAILED",
                    "Не удалось применить оптимизацию BCD xsaveremovefeature.",
                )
                .with_cause(cause)
                .with_diagnostics(session.diagnostics.clone())
            })?;
            hvlog!(Info, "среда", "параметр BCD применён, ожидание перезагрузки");
            return Ok(0);
        }

        hvlog!(Warn, "среда", "пользователь отклонил оптимизацию, продолжаем на свой риск");
    }

    session.diagnostics.steps_completed.push(STEP_PREFLIGHT.into());
    check_interrupted(STEP_PREFLIGHT, session)?;

    // ── Шаг 3: нейтрализация конфликтов
    hvlog!(Info, "конфликты", "── {STEP_CONFLICTS} ──");

    // Защита в реальном времени может блокировать запись драйвера: лаунчер добавляет свои пути
    // в исключения на время сессии; исключения пользователя не трогаются.
    let mut defender = avcheck::inspect(base_dir);
    avcheck::log(&defender);

    let guard = avguard::AvGuard::arm(&defender, &avguard::default_targets(base_dir));
    if guard.active() {
        let added = guard.added().to_vec();
        // Каталог уже в исключениях (пользовательских или временных) — предупреждение не требуется
        defender.launcher_excluded =
            defender.launcher_excluded || avcheck::path_is_excluded(base_dir, &added);
        defender.exclusions.extend(added.iter().cloned());
        session.diagnostics.defender_exclusions = added;
        hvlog!(Info, "антивирус", "временные исключения защиты добавлены на время сессии");
    }
    session.av_guard = guard;

    if defender.should_warn() {
        hvlog!(
            Warn,
            "антивирус",
            "защита активна, добавить исключения автоматически не удалось: загрузка драйвера может быть заблокирована"
        );
        if sys::ask_user_yes_no(&format!("{} — антивирус", sys::APP_TITLE), avcheck::WARNING_TEXT) {
            sys::open_uri(avcheck::SETTINGS_URI);
            hvlog!(Info, "антивирус", "открыты настройки защиты по выбору пользователя");
        }
    }

    session.conflict_state = conflicts::neutralize();
    session.diagnostics.vanguard_detected = session.conflict_state.vanguard_detected;
    session.diagnostics.msi_afterburner_detected = session.conflict_state.msi_detected;
    session.diagnostics.msi_relaunch_path = session
        .conflict_state
        .msi_path
        .as_ref()
        .map(|path| path.to_string_lossy().to_string());
    session.diagnostics.steps_completed.push(STEP_CONFLICTS.into());
    check_interrupted(STEP_CONFLICTS, session)?;

    // ── Шаг 4: подготовка окружения
    hvlog!(Info, "dse", "── {STEP_LOADER} ──");
    let mut dse_session = match dse::DseSession::prepare(base_dir) {
        Ok(session) => session,
        Err(dse::PrepareError::DriverBlocked(attempts)) => {
            let products = defender.third_party_products();
            hvlog!(
                Error,
                "антивирус",
                "драйвер заблокирован защитой: {}",
                rtcore::describe_attempts(&attempts)
            );
            return Err(driver_blocked_error(base_dir, &attempts, &products)
                .with_diagnostics(session.diagnostics.clone()));
        }
        Err(dse::PrepareError::Other(cause)) => {
            return Err(HvError::new(
                STEP_LOADER,
                "DSE_PREPARE",
                "Не удалось подготовить обход проверки подписей: смещения ядра или доступ к памяти.",
            )
            .with_cause(cause)
            .with_diagnostics(session.diagnostics.clone()));
        }
    };
    session.diagnostics.driver_temp_path = Some(dse_session.driver_path().to_string_lossy().to_string());
    session.diagnostics.dse_offsets_source = Some(dse_session.offsets.source.clone());
    session.diagnostics.dse_kernel_base = Some(format!("0x{:X}", dse_session.offsets.se_ci_callbacks));

    // Сессия DSE сохраняется для аварийной очистки независимо от исхода
    if let Err(cause) = dse_session.bypass() {
        session.dse = Some(dse_session);
        session.diagnostics.dse_patched = Some(false);

        // Причина блокировки поясняется в отчёте, а не выдаётся сырым кодом
        let av_suspected = avcheck::looks_like_av_block(&cause);
        let mut failure = HvError::new(
            STEP_LOADER,
            "DSE_BYPASS",
            "Не удалось применить временный обход проверки подписей драйверов.",
        )
        .with_cause(cause);

        if av_suspected {
            let products = defender.third_party_products();
            let products_text = if products.is_empty() {
                String::new()
            } else {
                format!("Обнаружено: {}. ", products.join(", "))
            };
            failure = failure.with_cause(format!(
                "Причина похожа на блокировку антивирусом: файл драйвера RTCore64.sys доступен, \
                 но загрузку службы запрещает защита. {products_text}Добавьте каталог игры ({}) \
                 в исключения антивируса и разрешите загрузку драйверов в правилах HIPS \
                 (ESET: «Защита от вторжений»).",
                base_dir.display()
            ));
            hvlog!(
                Warn,
                "антивирус",
                "загрузку службы драйвера заблокировала защита: проверьте исключения и HIPS антивируса"
            );
        }

        return Err(failure.with_diagnostics(session.diagnostics.clone()));
    }
    session.dse = Some(dse_session);
    session.diagnostics.dse_patched = Some(true);
    hvlog!(Info, "dse", "окружение подготовлено (обход проверки подписей применён)");
    session.diagnostics.steps_completed.push(STEP_LOADER.into());
    check_interrupted(STEP_LOADER, session)?;

    // ── Шаг 5: поиск исполняемого файла игры
    hvlog!(Info, "поиск", "── {STEP_SEARCH} ──");
    let search = game::find_game_executable(base_dir, args.explicit_target.as_ref());
    session.diagnostics.candidate_count = search.candidate_count;

    let Some(game_exe) = search.exe else {
        return Err(HvError::new(
            STEP_SEARCH,
            "GAME_NOT_FOUND",
            &format!(
                "Не удалось обнаружить исполняемый файл игры в каталоге:\n{}\n\n\
                Поместите Eclipse-HV.exe в корневую директорию игры.",
                base_dir.display()
            ),
        )
        .with_diagnostics(session.diagnostics.clone()));
    };

    let game_dir = game_exe
        .parent()
        .unwrap_or(base_dir)
        .to_path_buf();
    session.diagnostics.target_executable = Some(game_exe.to_string_lossy().to_string());
    hvlog!(Info, "поиск", "исполняемый файл: {}", game_exe.display());
    hvlog!(Info, "поиск", "рабочая директория: {}", game_dir.display());
    session.diagnostics.steps_completed.push(STEP_SEARCH.into());
    check_interrupted(STEP_SEARCH, session)?;

    // ── Шаг 6: запуск игры
    hvlog!(Info, "запуск", "── {STEP_LAUNCH} ──");
    hvlog!(Info, "запуск", "запуск игрового процесса: {}", game_exe.display());
    let mut command = Command::new(&game_exe);
    command.current_dir(&game_dir);
    command
        .spawn()
        .map_err(|cause| {
            HvError::new(
                STEP_LAUNCH,
                "GAME_LAUNCH",
                format!("Ошибка при запуске {}: {cause}", game_exe.display()),
            )
            .with_diagnostics(session.diagnostics.clone())
        })?;
    hvlog!(Info, "запуск", "процесс игры запущен");

    // Ожидание инициализации гипервизорного окружения игрой
    hvlog!(Info, "запуск", "ожидание 5 секунд для инициализации окружения");
    if !preflight::wait_interruptible(5) {
        return Err(interrupted_error(STEP_LAUNCH, session));
    }
    session.diagnostics.steps_completed.push(STEP_LAUNCH.into());

    // ── Шаг 7: восстановление и очистка
    hvlog!(Info, "очистка", "── {STEP_RESTORE} ──");
    finalize_session(session);

    hvlog!(Info, "очистка", "игра запущена, состояние системы восстановлено, лаунчер завершает работу");
    session.diagnostics.steps_completed.push(STEP_RESTORE.into());
    Ok(0)
}

/// Восстановление защиты, очистка служб, автоперезапуск, удаление временных файлов.
fn finalize_session(session: &mut Session) {
    restore_and_cleanup_dse(session);
    conflicts::cleanup_driver_services();
    conflicts::restart_msi(&session.conflict_state);
    // Временные исключения защиты снимаются последними: драйвер уже удалён
    session.av_guard.disarm();
}

fn emergency_cleanup(session: &mut Session) {
    hvlog!(Warn, "очистка", "выполняется аварийное восстановление состояния системы");
    finalize_session(session);
}

fn restore_and_cleanup_dse(session: &mut Session) {
    let Some(dse) = session.dse.as_mut() else {
        return;
    };

    // Восстановление выполняется, только если bypass был успешен
    if dse.bypassed {
        match dse.restore() {
            Ok(()) => {
                hvlog!(Info, "dse", "проверка подписей успешно восстановлена");
                session.diagnostics.dse_restored = Some(true);
            }
            Err(cause) => {
                hvlog!(Error, "dse", "сбой восстановления проверки подписей: {cause}");
                session.diagnostics.dse_restored = Some(false);
            }
        }
    } else {
        hvlog!(Debug, "dse", "обход не выполнялся, восстановление не требуется");
    }

    dse.cleanup();
    session.dse = None;
}

fn interrupted_error(step: &'static str, session: &Session) -> HvError {
    HvError::new(
        step,
        "INTERRUPTED",
        "Работа прервана пользователем (Ctrl+C). Состояние системы восстановлено.",
    )
    .with_exit_code(130)
    .with_diagnostics(session.diagnostics.clone())
}

fn check_interrupted(step: &'static str, session: &Session) -> Result<(), HvError> {
    if sys::interrupted() {
        return Err(interrupted_error(step, session));
    }
    Ok(())
}

/// Ошибка: защиты включены, но автоматически отключить их нельзя.
fn protections_locked_error(
    summary: &preflight::PreflightSummary,
    state: &str,
) -> HvError {
    let mut reason = String::new();
    if summary.hvci_locked {
        reason.push_str(
            "• параметры изоляции ядра защищены блокировкой UEFI (Locked=1): \
             изменение реестра не применится после перезагрузки;\n",
        );
    }
    if summary.policy_managed {
        reason.push_str(
            "• защиты заданы групповой политикой \
             (HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\DeviceGuard): \
             локальные параметры будут перезаписаны после перезагрузки;\n",
        );
    }

    HvError::new(
        STEP_PREFLIGHT,
        "PROTECTIONS_LOCKED",
        &format!(
            "Защиты Windows включены, но автоматическое отключение невозможно:\n\
             {reason}\nТекущее состояние:\n{state}\n\n\
             Снимите блокировку или политику:\n\
             • блокировка UEFI: Eclipse Studio → «Гипервизор» → «VBS 2.0» → UEFI opt-out \
             (SecConfig.efi) либо сброс UEFI-переменных;\n\
             • групповая политика: отключите политику Device Guard в редакторе групповых \
             политик или Intune и перезагрузите компьютер.\n\n\
             После этого запустите игру повторно."
        ),
    )
}

/// Ошибка: антивирус не даёт развернуть драйвер ни в одном каталоге.
fn driver_blocked_error(
    base_dir: &std::path::Path,
    attempts: &[rtcore::DeployAttempt],
    products: &[String],
) -> HvError {
    let mut text = String::from(
        "Антивирус блокирует файл драйвера RTCore64.sys, поэтому обход проверки подписей \
         невозможен.\n\nПроверенные каталоги:\n",
    );
    for attempt in attempts {
        text.push_str(&format!("• {} — {}\n", attempt.dir.display(), attempt.reason));
    }
    if !products.is_empty() {
        text.push_str(&format!("\nПродукты защиты: {}.\n", products.join(", ")));
    }
    text.push_str(&format!(
        "\nДобавьте каталог игры в исключения антивируса:\n{}\n\n\
         ESET: «Настройки» → «Защита от вирусов и угроз» → «Исключения» → «Добавить каталог».\n\
         Kaspersky: «Настройки» → «Защита» → «Исключения».\n\
         После добавления запустите игру повторно.",
        base_dir.display()
    ));

    HvError::new(STEP_LOADER, "AV_DRIVER_BLOCKED", text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build_args(list: &[&str]) -> Args {
        parse_args_from(list.iter().map(|value| value.to_string()).collect())
    }

    #[test]
    fn разбор_аргументов_запуска_игры() {
        let parsed = build_args(&["Eclipse-HV.exe", "--debug"]);
        assert!(parsed.debug);
        assert!(!parsed.help);
        assert!(parsed.subcommand.is_none());
        assert!(parsed.explicit_target.is_none());
    }

    #[test]
    fn разбор_аргументов_диагностики() {
        for flag in ["--status", "-status", "/status", "status"] {
            let parsed = build_args(&["Eclipse-HV.exe", flag]);
            assert!(matches!(parsed.subcommand, Some(Subcommand::Status)), "флаг {flag}");
            // Аргументы подкоманды не трактуются как путь к игре
            assert!(parsed.explicit_target.is_none());
        }
    }

    #[test]
    fn разбор_подкоманд_сертификата() {
        let parsed = build_args(&["Eclipse-HV.exe", "cert", "install"]);
        assert_eq!(parsed.subcommand, Some(Subcommand::Cert(cert::CertOp::Install)));

        let parsed = build_args(&["Eclipse-HV.exe", "cert", "remove"]);
        assert_eq!(parsed.subcommand, Some(Subcommand::Cert(cert::CertOp::Remove)));

        let parsed = build_args(&["Eclipse-HV.exe", "cert", "status"]);
        assert_eq!(parsed.subcommand, Some(Subcommand::Cert(cert::CertOp::Status)));

        let parsed = build_args(&["Eclipse-HV.exe", "cert", "sign", r"C:\Game\driver.sys"]);
        assert_eq!(
            parsed.subcommand,
            Some(Subcommand::Cert(cert::CertOp::Sign(PathBuf::from(
                r"C:\Game\driver.sys"
            ))))
        );

        // Нераспознанная операция: справка будет показана вызывающим кодом
        let parsed = build_args(&["Eclipse-HV.exe", "cert", "banan"]);
        assert!(parsed.cert_requested);
        assert!(parsed.subcommand.is_none());

        // Отсутствие операции после «cert»
        let parsed = build_args(&["Eclipse-HV.exe", "cert"]);
        assert!(parsed.cert_requested);
        assert!(parsed.subcommand.is_none());
    }

    #[test]
    fn флаги_регистра_не_зависят_от_регистра_символов() {
        let parsed = build_args(&["Eclipse-HV.exe", "--STATUS"]);
        assert!(matches!(parsed.subcommand, Some(Subcommand::Status)));

        let parsed = build_args(&["Eclipse-HV.exe", "CERT", "Install"]);
        assert_eq!(parsed.subcommand, Some(Subcommand::Cert(cert::CertOp::Install)));
    }
}
