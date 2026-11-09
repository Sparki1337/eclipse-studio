-- Изолированные контрактные тесты бэкенда: без подпроцессов, сети, диска и Steam
local scenario = "corrupt"
local writes, requests, removed = {}, {}, {}
local decoded_state
local function seed_state()
  decoded_state = { history = {}, installedGames = {}, installedVersions = {}, ryuuKey = "fixture", hubcapKey = "", service = "ryuu", theme = "midnight", cardMode = "full" }
end
local files = {}
package.preload.fs = function() return {
  join = function(...) return table.concat({...}, "/") end,
  filename = function(p) return p:match("([^/\\]+)$") end,
  is_file = function(p) return p:match("%.ps1$") ~= nil or files[p] ~= nil end,
  is_directory = function() return false end,
  create_directories = function() return true end,
  remove = function(p) removed[#removed+1] = p; files[p] = nil; return true end,
  remove_all = function() error("Unexpected recursive deletion") end,
  list = function() return {} end,
} end
package.preload.http = function() return { request = function() error("Unexpected network") end } end
package.preload.json = function() return {
  decode = function(text)
    if text == "BAD" then error("invalid JSON") end
    if text == "STATE" then return { success = true, exists = true, revision = "fixture-revision", state = decoded_state } end
    if text == "FAIL" then return { success = false, message = "fixture write denied" } end
    error("Unexpected JSON token")
  end,
  encode = function(value) return value end,
} end
package.preload.logger = function() return { error = function() end, info = function() end } end
package.preload.millennium = function() return { steam_path = function() return "fixture-Steam" end, ready = function() end } end
package.preload.utils = function() return {
  getenv = function(key) return key == "SystemRoot" and "fixture-Windows" or "fixture-AppData" end,
  uuid = function() return "fixture-nonce" end,
  trim = function(s) return s:match("^%s*(.-)%s*$") end,
  read_file = function(p) return files[p] end,
  write_file = function(p,v) writes[#writes+1] = p; files[p] = v; return true end,
  exec = function(command)
    requests[#requests+1] = command
    local output = command:match('%-ReplyFile "([^"]+)"')
    if output then files[output] = "FAIL" end
    return "", 1
  end,
} end
jit = { os = "Windows" }
io.popen = function(command, mode)
  assert(mode == "r", "Unexpected secret/state write")
  return { read = function() return scenario == "corrupt" and "BAD" or "STATE" end, close = function() return true end }
end
seed_state()
assert(loadfile("eclipse-manifest/backend/main.lua"))()
local result = get_plugin_state()
assert(result.success == false and #writes == 0, "corrupt state was reset or persisted")
scenario = "state"
decoded_state.installedGames["100"] = { name = "fixture", manifestFiles = { "../escape.manifest" } }
result = remove_manifest("100")
assert(result.success == false and #requests == 0 and #removed == 0, "traversal triggered file operations")
decoded_state.installedGames["100"].manifestFiles = { "10_20.manifest" }
result = remove_manifest("100")
assert(result.success == false and decoded_state.installedGames["100"] ~= nil, "failed remove forgot ownership metadata")
assert(#requests == 1 and requests[1]:find("%-Action Remove"), "remove did not use the transactional helper")
for _,p in ipairs(removed) do assert(p:match("%.request%.json$") or p:match("%.reply%.json$"), "removed a non-IPC file") end
result = get_plugin_state()
assert(result.success == true and decoded_state.installedGames["100"] ~= nil, "missing Lua forgot installation")
assert(#result.installedGames == 1 and result.installedGames[1].missingLua == true, "missing Lua not reported")
assert(result.installedGames[1].appid == "100", "missing AppID in retained record")
seed_state()
decoded_state.history = { { appid = "100", status = "removed" }, { appid = "100", status = "success", name = "old installation" } }
files["fixture-Steam/config/lua/100.lua"] = "restored original Lua"
result = get_plugin_state()
assert(result.success == true and #result.installedGames == 0, "old success resurrected a removed installation")
print("PASS: Lua corrupt-state, traversal, failed-removal, missing-Lua and removed-history regressions")
