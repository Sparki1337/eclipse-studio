#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bash "${root}/scripts/setup_rust.sh"

# Версии библиотек Tauri одобрены для Ubuntu 24.04.
packages=(
  libgtk-3-dev=3.24.41-4ubuntu1.3
  libwebkit2gtk-4.1-dev=2.52.6-0ubuntu0.24.04.1
  libxdo-dev=1:3.20160805.1-5build1
  libayatana-appindicator3-dev=0.5.93-1build3
)
missing=()
for package in "${packages[@]}"; do
  installed="$(dpkg-query -W -f='${Status} ${Version}' "${package%%=*}" 2>/dev/null || true)"
  if [[ "$installed" != "install ok installed ${package#*=}" ]]; then
    missing+=("$package")
  fi
done
if (( ${#missing[@]} )); then
  if (( EUID != 0 )); then
    printf 'Для установки одобренных библиотек Tauri требуются права root.\n' >&2
    exit 1
  fi
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${missing[@]}"
fi
pkg-config --modversion gtk+-3.0 webkit2gtk-4.1
