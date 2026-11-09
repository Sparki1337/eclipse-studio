# CrocLua local cloud engine

Upstream: https://github.com/crghofficial/cloudredirect

Pinned source: `4e81e492e4678c1d907fbeaef2625846f6afaad8` (upstream 2.6.6 source).
License: MIT, preserved in LICENSE. This is a modified build, `2.6.6-cgs-local.2`.

CGS changes:

- Native namespace registration and RPC handling require an active numeric root
  Lua in `config/lua` or `config/stplug-in`, a self `addappid`, and at least one
  referenced depot manifest. Commented auto-update pins are accepted, even
  after Steam evicts downloaded manifest files from its cache.
- Depot IDs, disabled Lua, Lua without manifest references and games without Lua pass through
  to Steam. Removing a Lua is checked again when an RPC arrives.
- Deferred seed receives the filtered namespace list.
- Provider configuration is isolated at `<Steam>/config/cgs-local-cloud.json`.
  Only the folder provider is accepted. Stats, achievements, playtime, Lua
  synchronization and parental features are off in CGS-generated configuration.
- Local working data is isolated at `<Steam>/cgs-local-cloud`.
  The selected folder holds the local provider's save data; the Steam directory
  retains its working cache and synchronization metadata.
- Automatic binary updates and global legacy save cleanup are disabled.

Build from an x64 MSVC developer environment:

```powershell
./scripts/build_local_cloud.ps1
```

Eclipse Studio: `scripts/build_local_cloud.ps1` is the port of upstream
`tools/Build-LocalCloud.ps1` (same compiler flags and source lists).

The helper builds only the C++ DLL with the static MSVC runtime. No upstream
companion app, batch scripts, credentials or external cloud account is used.
The resulting DLL is embedded in the Rust application. Standard application
builds can use the committed DLL without installing C++ tools.

Configuration is applied with Steam stopped, backed up before changes, and
Steam is restarted normally. Disabling restores the previous `[cloud]` section
without deleting saves. Folder changes copy existing provider data and reject
conflicting destination files. Originals remain in the old location.

This uses undocumented Steam interfaces. A successful configuration operation
does not establish that a particular Steam build/game has synchronized; verify
a save/load and a Steam restart using a test save before relying on it.

Compatibility repair (local.2): wrapper header/body offsets are derived from the
Steam transport forwarding code before hooks are installed. Unknown layouts are
rejected. The active-account fallback reads Steam's per-process registry identity,
not remembered accounts or userdata directory names. Headers are re-read to detect
account switches. Save data and the manifest-only scope are unchanged.

The application checks for an outdated managed DLL on startup and offers a
component-only update. The update uses the embedded binary, backs up the previous
DLL/state, preserves the cloud toggle/provider configuration, and restarts Steam
only if it was running. Externally modified DLLs are not silently replaced.

## Eclipse safety changes (2026-11-05)

- The existing Steam-PID HTTP authentication is retained and matched against the
  complete loopback TCP 4-tuple, rather than only a client source port.
- Blob requests must name the active account, positive uint32 identifiers and a
  safe relative filename confined to the account/app namespace. Body length must
  match even for an empty upload.
- `tests/cloud-path-policy.cpp` exercises the portable path policy without
  loading the DLL. The rebuilt DLL has not been injected or tested against a
  real Steam session by these checks.
- `build-provenance.json` records compiler, source hashes and the exact output
  digest. It is local build evidence, not a publisher signature or an independent
  reproducibility/antivirus certificate.
