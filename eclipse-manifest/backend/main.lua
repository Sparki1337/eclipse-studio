local fs = require("fs")
local http = require("http")
local json = require("json")
local logger = require("logger")
local millennium = require("millennium")
local utils = require("utils")

local RYUU_DOWNLOAD_BASE = "https://generator.ryuu.lol/api/download/"
local HUBCAP_BASE = "https://hubcapmanifest.com/api/v1"
local USER_AGENT =
"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
local HISTORY_LIMIT = 50
local REMOTE_VERSION_TTL = 60
local HUBCAP_USAGE_TTL = 15
local version_cache = {}
local hubcap_usage_cache = nil

local function reply(success, message, extra)
    local payload = extra or {}
    payload.success = success
    payload.message = message
    return json.encode(payload)
end

local function is_windows()
    return jit.os == "Windows"
end

local function powershell_quote(value)
    return "'" .. tostring(value):gsub("'", "''") .. "'"
end

local function read_binary(path)
    return utils.read_file(path)
end

local function write_binary(path, data)
    return utils.write_file(path, data)
end

local function manifest_cache_directory(appid)
    local local_app_data = utils.getenv("LOCALAPPDATA")
    if not local_app_data or local_app_data == "" then
        return nil
    end
    local primary = fs.join(local_app_data, "EclipseManifest", "manifest-cache", tostring(appid))
    local legacy = fs.join(local_app_data, "CrocodileManifest", "manifest-cache", tostring(appid))
    if not fs.is_directory(primary) and fs.is_directory(legacy) then
        return legacy
    end
    return primary
end

local function safe_manifest_name(value)
    local name = tostring(value or "")
    if not name:match("^%d+_%d+%.manifest$") then return nil end
    return name
end

-- Значения ключей идут только через приватный stdin/stdout PowerShell, не через
-- аргументы, временный JSON, логи или localStorage. DPAPI привязан к пользователю.
local state_revisions = setmetatable({}, { __mode = "k" })
-- Millennium роняет backend на логах с многобайтовыми символами и на длинных
-- сообщениях, поэтому в лог уходит только короткий ASCII-текст.
local function log_text(value)
    local message = tostring(value or ""):gsub("[^ -~]", " "):gsub("%s+", " ")
    if #message > 100 then message = message:sub(1, 100) end
    return message
end
local log = {
    info = function(message) logger:info(log_text(message)) end,
    error = function(message) logger:error(log_text(message)) end
}
local state_ok = false
local function shell_path(path)
    local value = tostring(path or "")
    if value == "" or value:find('["%%\r\n]') then error("Недопустимый путь PowerShell") end
    return '"' .. value .. '"'
end

local function helper_command(name)
    local system_root = utils.getenv("SystemRoot") or "C:\\Windows"
    local executable = fs.join(system_root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    local script = fs.join(millennium.steam_path(), "millennium", "plugins", "eclipse-manifest", "backend", name)
    if not fs.is_file(script) then error("Компонент безопасного хранения не установлен: обновите плагин") end
    -- Путь powershell.exe не заключается в кавычки: cmd.exe при нескольких
    -- кавычках в строке срезает первый и последний символ и ломает команду,
    -- из-за чего помощник падал с синтаксической ошибкой.
    if executable:find(" ") then error("Недопустимый путь PowerShell") end
    return executable .. " -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File " .. shell_path(script)
end

local function ipc_directory()
    local root = utils.getenv("LOCALAPPDATA")
    if not root or root == "" then error("LOCALAPPDATA недоступна") end
    local directory = fs.join(root, "EclipseManifest", "ipc")
    local ok, err = fs.create_directories(directory)
    if ok == nil then error("Не удалось подготовить обмен: " .. tostring(err)) end
    return directory
end

-- Запросы файловой транзакции не содержат ключей. Результат не считается
-- успешным, пока помощник не подтвердил атомарный commit или полный rollback.
local function file_transaction(action, request)
    local token = utils.uuid()
    local directory = ipc_directory()
    local input = fs.join(directory, token .. ".request.json")
    local output = fs.join(directory, token .. ".reply.json")
    local written, err = write_binary(input, json.encode(request))
    if not written then return false, tostring(err) end
    local command = helper_command("file-transaction.ps1") .. " -Action " .. action ..
        " -RequestFile " .. shell_path(input) .. " -ReplyFile " .. shell_path(output) .. " 2>NUL"
    local ran, run_err = pcall(utils.exec, command)
    local content = read_binary(output)
    fs.remove(input)
    if fs.is_file(output) then fs.remove(output) end
    local ok, result = pcall(json.decode, tostring(content or ""))
    if not ok or type(result) ~= "table" then return false, "Помощник не подтвердил транзакцию; журнал сохранён" end
    if result.success ~= true then return false, tostring(result.message or run_err or "Ошибка транзакции") end
    if not ran then return false, "Транзакция не подтверждена" end
    return true, result
end

-- Пакеты скачиваются потоком с жёстким лимитом байт и общим дедлайном.
-- io.popen в процессе плагина небезопасен, поэтому запрос передаётся файлом
-- UTF-8 с немедленным удалением, а ответ приходит в файл-квитанцию.
local function download_package(url, output, headers, timeout)
    local token = utils.uuid()
    local directory = ipc_directory()
    local request = fs.join(directory, token .. ".download-request.json")
    local acknowledgement = fs.join(directory, token .. ".download-reply.json")
    local written, write_error = write_binary(request, json.encode({ url = url, headers = headers }))
    if not written then return nil, "Не удалось подготовить скачивание: " .. tostring(write_error) end
    local command = helper_command("download-package.ps1") .. " -OutputFile " .. shell_path(output) ..
        " -ReplyFile " .. shell_path(acknowledgement) .. " -RequestPath " .. shell_path(request) ..
        " -TimeoutSeconds " .. tostring(timeout) .. " 2>NUL"
    pcall(utils.exec, command)
    if fs.is_file(request) then fs.remove(request) end
    local content = read_binary(acknowledgement)
    if fs.is_file(acknowledgement) then fs.remove(acknowledgement) end
    local ok, result = pcall(json.decode, tostring(content or ""))
    if not ok or type(result) ~= "table" then return nil, "Скачивание не подтверждено" end
    return result
end

local VALID_THEMES = {
    graphite = true, oled = true, steel = true, light = true,
    ruby = true, amber = true, gold = true, forest = true,
    cyan = true, midnight = true, cosmos = true, rose = true
}

local function default_state()
    return {
        cardMode = "full",
        theme = "midnight",
        service = "ryuu",
        ryuuKey = "",
        hubcapKey = "",
        history = {},
        installedGames = {},
        installedVersions = {}
    }
end

-- Ответ помощника читается из файла UTF-8: консольная кодировка процесса
-- плагина портит кириллицу, а io.popen роняет backend.
local function read_state_once()
    local ok, result = pcall(function()
        local reply = fs.join(ipc_directory(), utils.uuid() .. ".state-reply.json")
        local command = helper_command("state-store.ps1") .. " -Action Read -ReplyPath " .. shell_path(reply) .. " 2>&1"
        local output, status = utils.exec(command)
        local content = read_binary(reply)
        if not content or #tostring(content) == 0 then content = tostring(output or "") end
        if fs.is_file(reply) then fs.remove(reply) end
        local decoded_ok, decoded = pcall(json.decode, tostring(content or ""))
        if not decoded_ok or type(decoded) ~= "table" then
            error("помощник вернул код " .. tostring(status) .. ": " .. log_text(tostring(output or "")):sub(1, 90))
        end
        if decoded.success ~= true then
            error("помощник отклонил чтение: " .. tostring(decoded.message or ""))
        end
        return decoded
    end)
    if not ok then return nil, tostring(result) end
    return result
end

local function load_state()
    local result = read_state_once()
    if not result then
        -- Хранилище недоступно: работаем без записи, но загрузка плагина
        -- завершается штатно (аварийная ветка Millennium роняет backend).
        log.error("state unavailable, storage disabled")
        return default_state()
    end
    local decoded = result.exists and result.state or default_state()
    if type(decoded) ~= "table" or type(result.revision) ~= "string" then error("Некорректное подтверждение состояния") end
    for _, field in ipairs({ "history", "installedVersions", "installedGames" }) do
        if decoded[field] == nil then decoded[field] = {} end
        if type(decoded[field]) ~= "table" then error("Повреждена коллекция состояния: " .. field) end
    end
    for _, field in ipairs({ "ryuuKey", "hubcapKey" }) do
        if decoded[field] == nil then decoded[field] = "" end
        if type(decoded[field]) ~= "string" then error("Повреждён тип ключа; состояние не изменено") end
    end
    if decoded.cardMode ~= "full" and decoded.cardMode ~= "button" and decoded.cardMode ~= "crocodile" and decoded.cardMode ~= "eclipse" then
        decoded.cardMode = decoded.compactMode == true and "button" or "full"
    end
    if not VALID_THEMES[decoded.theme] then decoded.theme = "midnight" end
    if decoded.service ~= "ryuu" and decoded.service ~= "hubcap" then decoded.service = "ryuu" end
    decoded.compactMode = nil
    state_revisions[decoded] = result.revision
    state_ok = true
    return decoded
end

local function save_state(state)
    local revision = state_revisions[state]
    if not revision then return false, "Неподтверждённое состояние: сначала перечитайте настройки" end
    local token = utils.uuid()
    local request = fs.join(ipc_directory(), token .. ".state-request.json")
    local output = fs.join(ipc_directory(), token .. ".reply.json")
    local written, write_error = write_binary(request, json.encode({ revision = revision, state = state }))
    if not written then return false, "Не удалось подготовить запись: " .. tostring(write_error) end
    pcall(utils.exec, helper_command("state-store.ps1") .. " -Action Write -ReplyPath " .. shell_path(output) ..
        " -RequestPath " .. shell_path(request) .. " 2>NUL")
    if fs.is_file(request) then fs.remove(request) end
    local content = read_binary(output)
    if fs.is_file(output) then fs.remove(output) end
    local ok, result = pcall(json.decode, tostring(content or ""))
    if not written or not ok or type(result) ~= "table" or result.success ~= true or type(result.revision) ~= "string" then
        return false, "Запись состояния не подтверждена; перечитайте настройки и повторите действие"
    end
    state_revisions[state] = result.revision
    return true
end

local function add_history(appid, name, status, message, extra)
    local state = load_state()
    local entry = {
        appid = appid,
        name = name ~= "" and name or ("AppID " .. appid),
        status = status,
        message = message,
        timestamp = os.time(),
        pendingRestart = status == "success" and (not extra or extra.pendingRestart ~= false),
        luaCount = extra and tonumber(extra.luaCount) or 0,
        manifestCount = extra and tonumber(extra.manifestCount) or 0,
        manifestFiles = extra and extra.manifestFiles or {},
        packageVersion = extra and tostring(extra.packageVersion or "") or "",
        service = extra and tostring(extra.service or "") or ""
    }
    if status == "success" and entry.packageVersion ~= "" then
        state.installedVersions[appid] = entry.packageVersion
    end
    if status == "success" then
        state.installedGames[appid] = {
            appid = appid,
            name = entry.name,
            installedAt = entry.timestamp,
            luaCount = entry.luaCount,
            manifestCount = entry.manifestCount,
            manifestFiles = entry.manifestFiles,
            packageVersion = entry.packageVersion,
            service = entry.service
        }
    end
    table.insert(state.history, 1, entry)
    while #state.history > HISTORY_LIMIT do
        table.remove(state.history)
    end
    local ok, err = save_state(state)
    if not ok then
        log.error("history save failed")
    end
    return ok, err
end

local function latest_history(state, appid)
    for _, entry in ipairs(state.history) do
        if tostring(entry.appid) == appid then
            return entry
        end
    end
    return nil
end

local function installed_lua_path(steam_path, appid)
    local primary = fs.join(steam_path, "config", "lua")
    local legacy_stplugin = fs.join(steam_path, "config", "stplug-in")
    local legacy_root_lua = fs.join(steam_path, "lua")
    local primary_enabled = fs.join(primary, appid .. ".lua")
    if fs.is_file(primary_enabled) then
        return primary_enabled
    end
    local primary_disabled = fs.join(primary, appid .. ".lua.disabled")
    if fs.is_file(primary_disabled) then
        return primary_disabled
    end
    local legacy_enabled = fs.join(legacy_stplugin, appid .. ".lua")
    if fs.is_file(legacy_enabled) then
        return legacy_enabled
    end
    local legacy_disabled = fs.join(legacy_stplugin, appid .. ".lua.disabled")
    if fs.is_file(legacy_disabled) then
        return legacy_disabled
    end
    local root_enabled = fs.join(legacy_root_lua, appid .. ".lua")
    if fs.is_file(root_enabled) then
        return root_enabled
    end
    local root_disabled = fs.join(legacy_root_lua, appid .. ".lua.disabled")
    if fs.is_file(root_disabled) then
        return root_disabled
    end
    return nil
end

local function recorded_manifest_files(steam_path, appid, installed_game, latest)
    local result = {}
    local seen = {}

    local function add(value)
        local name = safe_manifest_name(value)
        local key = name and name:lower() or nil
        if name and not seen[key] then
            seen[key] = true
            table.insert(result, name)
        end
    end

    -- Слияние источников manifestFiles
    local function merge(source)
        if type(source) == "table" then
            for _, value in pairs(source) do
                add(value)
            end
        end
    end
    merge(type(installed_game) == "table" and installed_game.manifestFiles or nil)
    merge(type(latest) == "table" and latest.manifestFiles or nil)

    -- Проверка манифестов в установленном Lua-скрипте
    local lua_path = installed_lua_path(steam_path, appid)
    if lua_path then
        local content = read_binary(lua_path)
        if content then
            for depot, manifest in content:gmatch("[sS][eE][tT][mM][aA][nN][iI][fF][eE][sS][tT][iI][dD][^%d]*(%d+)[^%d]+(%d+)") do
                add(depot .. "_" .. manifest .. ".manifest")
            end
        end
    end

    -- Поиск файлов в кэше манифестов
    local cache_dir = manifest_cache_directory(appid)
    if cache_dir and fs.is_directory(cache_dir) then
        local entries = fs.list_recursive(cache_dir)
        if entries then
            for _, entry in ipairs(entries) do
                if entry.is_file then
                    add(fs.filename(entry.path))
                end
            end
        end
    end

    table.sort(result)
    return result
end

-- Синхронизация манифестов с depotcache
local function sync_manifest_cache(steam_path, appid, manifest_files)
    local missing = 0
    for _, name in ipairs(manifest_files or {}) do
        local clean = safe_manifest_name(name)
        if not clean or not fs.is_file(fs.join(steam_path, "depotcache", clean)) then missing = missing + 1 end
    end
    return { missingBefore = missing, missingCount = missing, restoredCount = 0, missingFiles = {} }
end

local function service_key(state, service)
    if service == "hubcap" then
        return utils.trim(tostring(state.hubcapKey or ""))
    end
    return utils.trim(tostring(state.ryuuKey or ""))
end

local function request_headers(service, key)
    if service == "hubcap" then
        return {
            ["Authorization"] = "Bearer " .. key,
            ["Accept"] = "application/zip, application/octet-stream, */*",
            ["Accept-Encoding"] = "identity"
        }
    end
    return {
        ["X-Auth-Key"] = key,
        ["Accept"] = "application/zip, application/octet-stream, */*",
        ["Accept-Encoding"] = "identity",
        ["Cache-Control"] = "no-cache",
        ["Pragma"] = "no-cache",
        ["Referer"] = "https://generator.ryuu.lol/"
    }
end

local function header_value(headers, wanted)
    if type(headers) ~= "table" then
        return nil
    end
    local lower_wanted = wanted:lower()
    for key, value in pairs(headers) do
        if tostring(key):lower() == lower_wanted then
            local text = utils.trim(tostring(value or ""))
            if text ~= "" then
                return text
            end
        end
    end
    return nil
end

local function map_service_status(status, service)
    local name = service == "hubcap" and "HubCap" or "Ryuu"
    if status == 401 or status == 403 then
        return "Неверный или просроченный API-ключ " .. name
    elseif status == 404 then
        return "Для этой игры пока нет манифестов в " .. name
    elseif status == 429 then
        return service == "hubcap"
            and "Достигнут дневной лимит HubCap"
            or "Слишком много запросов к Ryuu. Попробуйте позже"
    end
    return name .. " вернул ошибку " .. tostring(status)
end

local function fetch_hubcap_usage(key, force)
    if key == "" then
        return false, "Укажите API-ключ HubCap в настройках плагина"
    end
    if not force and hubcap_usage_cache and hubcap_usage_cache.key == key
        and os.time() - hubcap_usage_cache.checkedAt < HUBCAP_USAGE_TTL then
        return true, hubcap_usage_cache.usage
    end

    local response, request_err = http.request(HUBCAP_BASE .. "/user/stats", {
        method = "GET",
        headers = {
            ["Authorization"] = "Bearer " .. key,
            ["Accept"] = "application/json"
        },
        timeout = 15,
        follow_redirects = true,
        verify_ssl = true,
        user_agent = USER_AGENT
    })
    if not response then
        return false, "HubCap недоступен: " .. tostring(request_err)
    end
    local status = tonumber(response.status) or 0
    if status < 200 or status >= 300 then
        return false, map_service_status(status, "hubcap")
    end
    local ok, decoded = pcall(json.decode, tostring(response.body or ""))
    if not ok or type(decoded) ~= "table" then
        return false, "HubCap вернул некорректные данные лимита"
    end
    local used = tonumber(decoded.daily_usage or decoded.dailyUsage or 0) or 0
    local limit = tonumber(decoded.daily_limit or decoded.dailyLimit or 25) or 25
    local remaining = tonumber(decoded.remaining)
    if remaining == nil then
        remaining = math.max(0, limit - used)
    end
    local usage = {
        used = used,
        limit = limit,
        remaining = math.max(0, remaining),
        checkedAt = os.time()
    }
    hubcap_usage_cache = {
        key = key,
        checkedAt = os.time(),
        usage = usage
    }
    return true, usage
end

local function fetch_remote_version(appid, force, service, key)
    if service ~= "ryuu" or key == "" then
        return nil
    end
    local cache_key = service .. ":" .. appid
    local cached = version_cache[cache_key]
    if not force and cached and os.time() - cached.checkedAt < REMOTE_VERSION_TTL then
        return cached.token
    end

    local response = http.request(RYUU_DOWNLOAD_BASE .. appid, {
        method = "HEAD",
        headers = request_headers(service, key),
        timeout = 8,
        follow_redirects = true,
        verify_ssl = true,
        user_agent = USER_AGENT
    })
    local token = nil
    if response and tonumber(response.status) and tonumber(response.status) >= 200 and tonumber(response.status) < 300 then
        local etag = header_value(response.headers, "etag")
        local modified = header_value(response.headers, "last-modified")
        local length = header_value(response.headers, "content-length")
        if etag or modified then
            token = table.concat({ etag or "", modified or "", length or "" }, "|")
        end
    end
    version_cache[cache_key] = {
        token = token,
        checkedAt = os.time()
    }
    return token
end

local function run_powershell(script_path, success_marker)
    local command = 'powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' ..
        script_path:gsub('"', '""') .. '" 2>&1'
    local output, status = utils.exec(command)
    if fs.is_file(success_marker) then
        return true
    end
    local detail = output and utils.trim(output) or ""
    if detail == "" then
        detail = "PowerShell завершился с кодом " .. tostring(status or "неизвестно")
    end
    return false, detail
end

-- Пины setManifestid сохраняются: Steam больше не выдаёт коды запроса манифестов
-- для неприобретённых игр, поэтому Lua должен ссылаться на установленные GID.
local function patch_lua(content)
    return (content:gsub("\r\n", "\n"):gsub("\r", "\n"))
end

local function legacy_manifests_match(appid, service, key, installed_game)
    if service ~= "ryuu" or key == "" then
        return nil
    end

    local steam_path = millennium.steam_path()
    local temp_root = utils.getenv("TEMP") or utils.getenv("TMP")
    if not steam_path or steam_path == "" or not temp_root or temp_root == "" then
        return nil
    end

    local token = tostring(os.time()) .. "-" .. utils.uuid()
    local work_dir = fs.join(temp_root, "ryuu-version-check-" .. appid .. "-" .. token)
    local extract_dir = fs.join(work_dir, "package")
    local zip_path = fs.join(work_dir, appid .. "-manifests.zip")
    local created = fs.create_directories(extract_dir)
    if created == nil then
        return nil
    end

    local download = download_package(RYUU_DOWNLOAD_BASE .. appid .. "?file_type=manifest", zip_path,
        request_headers(service, key), 45)
    local status = download and (tonumber(download.status) or 0) or 0
    if not download or not download.success or status < 200
        or status >= 300 or (tonumber(download.bytes_written) or 0) < 4 then
        fs.remove_all(work_dir)
        return nil
    end

    local expanded = file_transaction("Extract", { appid = appid, archive = zip_path,
        destination = extract_dir, manifestsOnly = true })
    if not expanded then fs.remove_all(work_dir); return nil end

    local entries = fs.list_recursive(extract_dir)
    if not entries then
        fs.remove_all(work_dir)
        return nil
    end

    local depotcache = fs.join(steam_path, "depotcache")
    local remote_files = {}
    local remote_count = 0
    local matches = true
    for _, entry in ipairs(entries) do
        if entry.is_file then
            local name = fs.filename(entry.path)
            if name:lower():match("%.manifest$") then
                remote_files[name:lower()] = true
                remote_count = remote_count + 1
                local remote_content = read_binary(entry.path)
                local local_content = read_binary(fs.join(depotcache, name))
                if not remote_content or not local_content or remote_content ~= local_content then
                    matches = false
                    break
                end
            end
        end
    end

    if matches and type(installed_game) == "table" and type(installed_game.manifestFiles) == "table" then
        for _, name in pairs(installed_game.manifestFiles) do
            local clean_name = tostring(name or "")
            if clean_name:lower():match("%.manifest$") and not remote_files[clean_name:lower()] then
                matches = false
                break
            end
        end
    end

    fs.remove_all(work_dir)
    if remote_count == 0 then
        return nil
    end
    return matches
end

local function install_package(appid, service, key)
    local steam_path = millennium.steam_path()
    if not steam_path or steam_path == "" then
        return false, "Millennium не смог определить папку Steam"
    end

    local temp_root = utils.getenv("TEMP") or utils.getenv("TMP")
    if not temp_root or temp_root == "" then
        return false, "Не удалось определить временную папку Windows"
    end

    local token = tostring(os.time()) .. "-" .. utils.uuid()
    local service_name = service == "hubcap" and "HubCap" or "Ryuu"
    local download_url = service == "hubcap"
        and (HUBCAP_BASE .. "/manifest/" .. appid)
        or (RYUU_DOWNLOAD_BASE .. appid)
    local work_dir = fs.join(temp_root, service .. "-manifest-" .. appid .. "-" .. token)
    local extract_dir = fs.join(work_dir, "package")
    local zip_path = fs.join(work_dir, appid .. ".zip")

    local created, create_err = fs.create_directories(extract_dir)
    if created == nil then
        return false, "Не удалось подготовить временную папку: " .. tostring(create_err)
    end

    -- Получение версии пакета перед загрузкой
    local package_version = ""
    if service == "ryuu" then
        package_version = tostring(fetch_remote_version(appid, true, service, key) or "")
    end

    local download, download_err = download_package(download_url, zip_path, request_headers(service, key), 90)
    if service == "hubcap" then
        hubcap_usage_cache = nil
    end
    if not download then
        fs.remove_all(work_dir)
        return false, service_name .. " недоступен: " .. tostring(download_err)
    end
    local status = tonumber(download.status) or 0
    if status < 200 or status >= 300 then
        fs.remove_all(work_dir)
        return false, map_service_status(status, service)
    end
    if not download.success or (tonumber(download.bytes_written) or 0) < 4 then
        fs.remove_all(work_dir)
        return false, service_name .. " не смог сохранить архив с манифестом"
    end

    if service == "ryuu" then
        local etag = header_value(download.headers, "etag")
        local modified = header_value(download.headers, "last-modified")
        local length = header_value(download.headers, "content-length")
        if etag or modified then
            package_version = table.concat({ etag or "", modified or "", length or "" }, "|")
        end
    end

    local expanded, extract_result = file_transaction("Extract", {
        appid = appid, archive = zip_path, destination = extract_dir
    })
    if not expanded then fs.remove_all(work_dir); return false, "Пакет отклонён: " .. tostring(extract_result) end
    local lua_path = fs.join(extract_dir, appid .. ".lua")
    local content, read_err = read_binary(lua_path)
    if not content then fs.remove_all(work_dir); return false, tostring(read_err) end
    local patched, patch_err = write_binary(lua_path, patch_lua(content))
    if not patched then fs.remove_all(work_dir); return false, tostring(patch_err) end
    local installed, result = file_transaction("Install", { appid = appid, steamRoot = steam_path, sourceRoot = extract_dir })
    fs.remove_all(work_dir)
    if not installed then return false, "Установка не завершена; исходные файлы и журнал сохранены: " .. tostring(result) end
    -- Кеш содержит только копии подтверждённых манифестов. Не переписываем Steam
    -- из устаревшего кеша и не считаем кеш доказательством владения.
    return true, "Файлы установлены и подтверждены общим журналом транзакции", {
        luaCount = result.luaCount, manifestCount = result.manifestCount,
        manifestFiles = result.manifestFiles, service = service, packageVersion = package_version
    }
end

function install_manifest(appid, name)
    if type(appid) == "table" then
        name = name or appid.name or appid[2]
        appid = appid.appid or appid[1]
    end
    local clean = tostring(appid or ""):match("^(%d+)$")
    if not clean then
        return reply(false, "Некорректный AppID")
    end
    if not is_windows() then
        return reply(false, "Первая версия плагина поддерживает только Windows")
    end

    local game_name = utils.trim(tostring(name or ""))
    local state = load_state()
    local steam_path = millennium.steam_path()
    local latest = latest_history(state, clean)
    local installed_game = state.installedGames[clean]
    local installed_path = steam_path and installed_lua_path(steam_path, clean) or nil
    local manifest_files = recorded_manifest_files(steam_path, clean, installed_game, latest)
    local health = steam_path and sync_manifest_cache(steam_path, clean, manifest_files)
        or { missingBefore = 0, missingCount = 0 }
    local repairing = installed_path ~= nil and health.missingBefore > 0
    local service = state.service == "hubcap" and "hubcap" or "ryuu"
    local key = service_key(state, service)
    if key == "" then
        local service_name = service == "hubcap" and "HubCap" or "Ryuu"
        return reply(false, "Укажите личный API-ключ " .. service_name .. " в настройках плагина", {
            service = service,
            configured = false
        })
    end

    log.info("Eclipse Manifest is downloading data for AppID " .. clean .. " via " .. service)
    local ok, message, extra = install_package(clean, service, key)
    if not ok then
        log.error(message)
        add_history(clean, game_name, "error", message)
        return reply(false, message, {
            service = service,
            configured = true
        })
    end
    extra.repaired = repairing
    extra.pendingRestart = not repairing
    local saved, save_err = add_history(clean, game_name, "success", message, extra)
    if not saved then return reply(false, "Файлы установлены, но история не сохранена. Журнал владения сохранён; повторите действие: " .. tostring(save_err), extra) end
    log.info("Eclipse Manifest installed data for AppID " .. clean)
    extra.configured = true
    return reply(true, message, extra)
end

function get_game_status(appid)
    local raw = type(appid) == "table" and (appid.appid or appid[1]) or appid
    local clean = tostring(raw or ""):match("^(%d+)$")
    if not clean then
        return reply(false, "Некорректный AppID")
    end
    local steam_path = millennium.steam_path()
    if not steam_path or steam_path == "" then
        return reply(false, "Millennium не смог определить папку Steam")
    end

    local state = load_state()
    local service = state.service == "hubcap" and "hubcap" or "ryuu"
    local key = service_key(state, service)
    local configured = key ~= ""
    local latest = latest_history(state, clean)
    local installed_path = installed_lua_path(steam_path, clean)
    local installed_game = state.installedGames[clean]
    local manifest_files = recorded_manifest_files(steam_path, clean, installed_game, latest)
    local manifest_health = sync_manifest_cache(steam_path, clean, manifest_files)
    local game_state = configured and "available" or "configuration_required"
    local update_available = false
    if installed_path then
        if manifest_health.missingCount > 0 then
            game_state = configured and "repair_required" or "configuration_required"
        elseif latest and latest.status == "success" and latest.pendingRestart == true then
            game_state = "pending_restart"
        else
            -- Запрос актуальной версии пакета (кеш TTL, без принудительного обхода)
            local remote_version = fetch_remote_version(clean, false, service, key)
            local installed_version = tostring(state.installedVersions[clean] or "")
            local trusted_version = type(installed_game) == "table"
                and tostring(installed_game.packageVersion or "") or ""
            if remote_version and trusted_version == "" then
                local matches = legacy_manifests_match(clean, service, key, installed_game)
                if matches == false then
                    game_state = "update_available"
                    update_available = true
                elseif matches == true then
                    if type(installed_game) == "table" then
                        state.installedVersions[clean] = remote_version
                        installed_game.packageVersion = remote_version
                        local saved, save_err = save_state(state)
                        if not saved then return reply(false, "Версия не сохранена: " .. tostring(save_err)) end
                    end
                    game_state = "installed"
                else
                    game_state = "installed"
                end
            elseif remote_version and installed_version ~= remote_version then
                game_state = "update_available"
                update_available = true
            else
                game_state = "installed"
            end
        end
    elseif type(installed_game) == "table" then
        game_state = configured and "repair_required" or "configuration_required"
    elseif configured and latest and latest.status == "error" then
        game_state = "error"
    end

    local response = {
        state = game_state,
        cardMode = state.cardMode,
        theme = state.theme,
        service = service,
        configured = configured,
        installed = installed_path ~= nil,
        updateAvailable = update_available,
        lastMessage = latest and tostring(latest.message or "") or "",
        lastTimestamp = latest and tonumber(latest.timestamp) or 0,
        luaCount = latest and tonumber(latest.luaCount) or 0,
        manifestCount = latest and tonumber(latest.manifestCount) or 0,
        missingManifestCount = manifest_health.missingCount,
        restoredManifestCount = manifest_health.restoredCount
    }
    if service == "hubcap" and configured then
        local usage_ok, usage_or_error = fetch_hubcap_usage(key, false)
        if usage_ok then
            response.hubcapUsage = usage_or_error
        else
            response.hubcapUsageError = tostring(usage_or_error)
        end
    end
    return reply(true, "Статус определён", response)
end

function restore_manifest_cache()
    local steam_path = millennium.steam_path()
    if not steam_path or steam_path == "" then
        return reply(false, "Millennium не смог определить папку Steam")
    end

    local state = load_state()
    local restored_count = 0
    local missing_count = 0
    for appid, installed_game in pairs(state.installedGames) do
        local latest = latest_history(state, tostring(appid))
        local manifest_files = recorded_manifest_files(steam_path, tostring(appid), installed_game, latest)
        local health = sync_manifest_cache(steam_path, tostring(appid), manifest_files)
        restored_count = restored_count + health.restoredCount
        missing_count = missing_count + health.missingCount
    end
    return reply(true, "Резервные копии проверены", {
        restoredCount = restored_count,
        missingCount = missing_count
    })
end

function get_plugin_state()
    local state = load_state()
    local steam_path = millennium.steam_path()
    local changed = false
    if steam_path and steam_path ~= "" then
        for _, entry in ipairs(state.history) do
            local appid = tostring(entry.appid or "")
            if appid:match("^%d+$") and entry.status == "success" and latest_history(state, appid) == entry
                and not state.installedGames[appid] and installed_lua_path(steam_path, appid) then
                state.installedGames[appid] = {
                    appid = appid,
                    name = tostring(entry.name or ("AppID " .. appid)),
                    installedAt = tonumber(entry.timestamp) or 0,
                    luaCount = tonumber(entry.luaCount) or 0,
                    manifestCount = tonumber(entry.manifestCount) or 0,
                    manifestFiles = type(entry.manifestFiles) == "table" and entry.manifestFiles or {},
                    packageVersion = tostring(entry.packageVersion or ""),
                    service = tostring(entry.service or "")
                }
                changed = true
            end
        end
    end

    local installed_games = {}
    for appid, game in pairs(state.installedGames) do
        if type(game) ~= "table" then error("Повреждена запись установки; данные сохранены") end
        local displayed = {}
        for key, value in pairs(game) do displayed[key] = value end
        displayed.appid = tostring(appid)
        displayed.missingLua = not (steam_path and installed_lua_path(steam_path, tostring(appid)))
        table.insert(installed_games, displayed)
    end
    table.sort(installed_games, function(a, b)
        return tostring(a.name or a.appid):lower() < tostring(b.name or b.appid):lower()
    end)
    if changed then
        local saved, save_err = save_state(state)
        if not saved then return reply(false, "Изменение состояния не подтверждено: " .. tostring(save_err)) end
    end

    return reply(true, "Состояние загружено", {
        cardMode = state.cardMode,
        theme = state.theme,
        service = state.service,
        hasRyuuKey = utils.trim(tostring(state.ryuuKey or "")) ~= "",
        hasHubcapKey = utils.trim(tostring(state.hubcapKey or "")) ~= "",
        history = state.history,
        installedGames = installed_games
    })
end

function set_service_settings(payload)
    local decoded_ok, settings = pcall(json.decode, tostring(payload or ""))
    if not decoded_ok or type(settings) ~= "table" then
        return reply(false, "Не удалось прочитать настройки сервиса")
    end
    local clean_service = tostring(settings.service or ""):lower()
    if clean_service ~= "ryuu" and clean_service ~= "hubcap" then
        return reply(false, "Неизвестный сервис манифестов")
    end

    local state = load_state()
    state.service = clean_service
    local clean_ryuu = utils.trim(tostring(settings.ryuuKey or ""))
    local clean_hubcap = utils.trim(tostring(settings.hubcapKey or ""))
    if settings.clearRyuu == true then
        state.ryuuKey = ""
    elseif clean_ryuu ~= "" then
        state.ryuuKey = clean_ryuu
    end
    if settings.clearHubcap == true then
        state.hubcapKey = ""
    elseif clean_hubcap ~= "" then
        state.hubcapKey = clean_hubcap
    end

    local ok, err = save_state(state)
    if not ok then
        return reply(false, "Не удалось сохранить настройки сервиса: " .. tostring(err))
    end
    for cache_key in pairs(version_cache) do
        version_cache[cache_key] = nil
    end
    hubcap_usage_cache = nil

    local response = {
        service = state.service,
        hasRyuuKey = utils.trim(tostring(state.ryuuKey or "")) ~= "",
        hasHubcapKey = utils.trim(tostring(state.hubcapKey or "")) ~= ""
    }
    if state.service == "hubcap" and response.hasHubcapKey then
        local usage_ok, usage_or_error = fetch_hubcap_usage(state.hubcapKey, true)
        if usage_ok then
            response.hubcapUsage = usage_or_error
        else
            response.validationError = tostring(usage_or_error)
        end
    end
    return reply(true, "Настройки сервиса сохранены", response)
end

function set_card_mode(mode)
    local raw = type(mode) == "table" and (mode.mode or mode[1]) or mode
    local clean = tostring(raw or ""):lower()
    if clean ~= "full" and clean ~= "button" and clean ~= "crocodile" and clean ~= "eclipse" then
        return reply(false, "Неизвестный режим карточки")
    end
    local state = load_state()
    state.cardMode = clean
    local ok, err = save_state(state)
    if not ok then
        return reply(false, "Не удалось сохранить настройку: " .. tostring(err))
    end
    return reply(true, "Режим карточки изменён", {
        cardMode = state.cardMode
    })
end

function set_theme(theme_name)
    local raw = type(theme_name) == "table" and (theme_name.theme or theme_name[1]) or theme_name
    local clean = tostring(raw or ""):lower()
    if not VALID_THEMES[clean] then
        return reply(false, "Неизвестная тема оформления")
    end
    local state = load_state()
    state.theme = clean
    local ok, err = save_state(state)
    if not ok then
        return reply(false, "Не удалось сохранить тему: " .. tostring(err))
    end
    return reply(true, "Тема оформления изменена", {
        theme = state.theme
    })
end

function remove_manifest(appid)
    local raw = type(appid) == "table" and (appid.appid or appid[1]) or appid
    local clean = tostring(raw or ""):match("^(%d+)$")
    if not clean then
        return reply(false, "Некорректный AppID")
    end
    local steam_path = millennium.steam_path()
    if not steam_path or steam_path == "" then
        return reply(false, "Millennium не смог определить папку Steam")
    end

    local state = load_state()
    local latest = latest_history(state, clean)
    local installed_game = state.installedGames[clean]
    local game_name = installed_game and tostring(installed_game.name or "")
        or (latest and tostring(latest.name or "") or ("AppID " .. clean))
    -- Сначала проверяем все имена из старого состояния, не удаляя ничего.
    local recorded = installed_game and installed_game.manifestFiles or (latest and latest.manifestFiles)
    if type(recorded) == "table" then
        for _, name in pairs(recorded) do
            if not safe_manifest_name(name) then return reply(false, "Некорректный путь в истории; файлы сохранены") end
        end
    end
    local removed, result = file_transaction("Remove", { appid = clean, steamRoot = steam_path })
    if not removed then
        -- Не очищаем историю, кеш и список установки при частичном результате.
        return reply(false, "Удаление не завершено; журнал и данные игры сохранены: " .. tostring(result))
    end
    state.installedVersions[clean] = nil
    state.installedGames[clean] = nil
    local saved, save_err = save_state(state)
    if not saved then return reply(false, "Файлы восстановлены, но состояние не сохранено: " .. tostring(save_err)) end
    version_cache["ryuu:" .. clean] = nil
    version_cache["hubcap:" .. clean] = nil
    local message = "Файлы из подтверждённого журнала удалены либо восстановлены; общие манифесты других игр сохранены"
    local history_ok, history_err = add_history(clean, game_name, "removed", message)
    if not history_ok then return reply(false, "Удаление завершено, но запись истории не подтверждена: " .. tostring(history_err)) end
    return reply(true, message, { removedCount = result.changedCount or 0 })
end

function clear_history()
    local state = load_state()
    state.history = {}
    local ok, err = save_state(state)
    if not ok then
        return reply(false, "Не удалось очистить историю: " .. tostring(err))
    end
    return reply(true, "История очищена")
end

function restart_steam()
    if not is_windows() then
        return reply(false, "Перезапуск поддерживается только на Windows")
    end
    local steam_path = millennium.steam_path()
    if not steam_path or steam_path == "" then
        return reply(false, "Millennium не смог определить папку Steam")
    end
    local steam_exe = fs.join(steam_path, "steam.exe")
    if not fs.is_file(steam_exe) then
        return reply(false, "steam.exe не найден")
    end

    local temp_root = utils.getenv("TEMP") or utils.getenv("TMP")
    if not temp_root or temp_root == "" then
        return reply(false, "Не удалось определить временную папку Windows")
    end
    local token = tostring(os.time()) .. "-" .. utils.uuid()
    local script_path = fs.join(temp_root, "eclipse-manifest-restart-" .. token .. ".ps1")
    local launcher_path = fs.join(temp_root, "eclipse-manifest-launcher-" .. token .. ".ps1")
    local success_marker = fs.join(temp_root, "eclipse-manifest-launcher-" .. token .. ".ok")
    local script = "$ErrorActionPreference = 'SilentlyContinue'\n" ..
        "$steam = " .. powershell_quote(steam_exe) .. "\n" ..
        "$steamDir = " .. powershell_quote(steam_path) .. "\n" ..
        "$launcher = " .. powershell_quote(launcher_path) .. "\n" ..
        "$marker = " .. powershell_quote(success_marker) .. "\n" ..
        "try {\n" ..
        "  & $steam -shutdown | Out-Null\n" ..
        "  $deadline = (Get-Date).AddSeconds(15)\n" ..
        "  while ((Get-Process steam -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {\n" ..
        "    Start-Sleep -Milliseconds 500\n" ..
        "  }\n" ..
        "  Get-Process steamwebhelper -ErrorAction SilentlyContinue | Stop-Process -Force\n" ..
        "  Get-Process steam -ErrorAction SilentlyContinue | Stop-Process -Force\n" ..
        "  Start-Sleep -Seconds 2\n" ..
        "  Start-Process -FilePath $steam -WorkingDirectory $steamDir\n" ..
        "} finally {\n" ..
        "  Start-Sleep -Seconds 1\n" ..
        "  Remove-Item -LiteralPath $launcher, $marker, $MyInvocation.MyCommand.Path -Force\n" ..
        "}\n"
    local ok, err = write_binary(script_path, script)
    if not ok then
        return reply(false, "Не удалось подготовить перезапуск: " .. tostring(err))
    end

    local child_command = 'powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' ..
        script_path:gsub('"', '""') .. '"'
    local launcher = "$ErrorActionPreference = 'Stop'\n" ..
        "$commandLine = " .. powershell_quote(child_command) .. "\n" ..
        "$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $commandLine }\n" ..
        "if ([int]$result.ReturnValue -ne 0) { throw \"Win32_Process.Create: $($result.ReturnValue)\" }\n" ..
        "Set-Content -LiteralPath " .. powershell_quote(success_marker) .. " -Value 'ok' -NoNewline\n"
    local launcher_ok, launcher_err = write_binary(launcher_path, launcher)
    if not launcher_ok then
        fs.remove_all(script_path)
        return reply(false, "Не удалось подготовить скрытый перезапуск: " .. tostring(launcher_err))
    end
    local started, start_err = run_powershell(launcher_path, success_marker)
    if not started then
        fs.remove_all(script_path)
        fs.remove_all(launcher_path)
        fs.remove_all(success_marker)
        return reply(false, "Не удалось запустить перезапуск Steam: " .. tostring(start_err))
    end
    return reply(true, "Steam перезапускается")
end

-- После старта Steam OST подхватывает Lua при изменении файлов: перезапись
-- тем же содержимым запускает переинжект пакетов до первой установки игры,
-- иначе Steam строит план загрузки с нулём депотов и показывает 0 байт.
local function touch_lua_files()
    local steam_path = millennium.steam_path()
    if not steam_path or steam_path == "" then return 0 end
    local touched = 0
    for _, relative in ipairs({ "config/lua", "config/stplug-in" }) do
        local directory = fs.join(steam_path, relative)
        if fs.is_directory(directory) then
            local listed, entries = pcall(fs.list_recursive, directory)
            if listed and entries then
                for _, entry in ipairs(entries) do
                    if entry.is_file and tostring(entry.path):lower():match("%.lua$") then
                        local content = utils.read_file(entry.path)
                        if content and #content > 0 and #content < 2 * 1024 * 1024 then
                            if pcall(utils.write_file, entry.path, content) then
                                touched = touched + 1
                            end
                        end
                    end
                end
            end
        end
    end
    return touched
end

-- Загрузка не должна ронять процесс плагина: ошибка состояния или помощника
-- только логируется, а Millennium всё равно получает ready.
local function on_load()
    local ok, err = pcall(function()
        local state = load_state()
        local changed = false
        for _, entry in ipairs(state.history) do
            if entry.pendingRestart == true then
                entry.pendingRestart = false
                changed = true
            end
        end
        if changed then
            local saved = save_state(state)
            if not saved then log.error("restart flag not saved") end
        end
        local steam_path = millennium.steam_path()
        if steam_path and steam_path ~= "" then
            for appid, installed_game in pairs(state.installedGames) do
                local latest = latest_history(state, tostring(appid))
                local manifest_files = recorded_manifest_files(steam_path, tostring(appid), installed_game, latest)
                sync_manifest_cache(steam_path, tostring(appid), manifest_files)
            end
        end
        local touched = touch_lua_files()
        if touched > 0 then log.info("Eclipse Manifest: lua reloaded, files=" .. touched) end
        log.info("Eclipse Manifest loaded, state=" .. (state_ok and "ok" or "fail"))
    end)
    if not ok then
        log.error("Eclipse Manifest: load aborted, data kept: " .. tostring(err))
    end
    millennium.ready()
end

local function on_unload()
    log.info("Eclipse Manifest unloaded")
end

-- Ошибки чтения/миграции не превращаются в запись пустого состояния.
for _, name in ipairs({ "install_manifest", "get_game_status", "restore_manifest_cache", "get_plugin_state",
    "set_service_settings", "set_card_mode", "set_theme", "remove_manifest", "clear_history", "restart_steam" }) do
    local action = _G[name]
    _G[name] = function(...)
        local ok, result = pcall(action, ...)
        if not ok then
            log.error("Eclipse Manifest: operation aborted, state kept")
            return reply(false, "Операция остановлена: состояние или безопасный помощник недоступны. Данные не сброшены. Обновите плагин и проверьте хранилище.")
        end
        return result
    end
end

return {
    on_load = on_load,
    on_unload = on_unload
}
