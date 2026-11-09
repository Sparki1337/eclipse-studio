#!/usr/bin/env bash
set -euo pipefail

# Одобренный toolchain устанавливается отдельно от системного Rust.
version=1.99.1
target=x86_64-unknown-linux-gnu
prefix="${HOME}/.local/share/eclipse-studio/rust/${version}"
bin="${HOME}/.local/bin"

if [[ "$(uname -s)-$(uname -m)" != Linux-x86_64 ]]; then
  printf 'Подготовка Rust предназначена для Linux x86_64.\n' >&2
  exit 1
fi

if [[ ! -x "${prefix}/bin/rustc" ]] || [[ "$("${prefix}/bin/rustc" --version)" != "rustc ${version} "* ]] || [[ ! -x "${prefix}/bin/cargo-fmt" ]]; then
  staging="$(mktemp -d)"
  trap 'rm -rf "$staging"' EXIT
  while read -r component checksum; do
    archive="${component}-${version}-${target}"
    curl --fail --location --silent --show-error --retry 3 \
      "https://static.rust-lang.org/dist/2026-10-15/${archive}.tar.xz" \
      --output "${staging}/${archive}.tar.xz"
    printf '%s  %s\n' "$checksum" "${staging}/${archive}.tar.xz" | sha256sum --check --status
    tar -xJf "${staging}/${archive}.tar.xz" -C "$staging"
    bash "${staging}/${archive}/install.sh" --prefix="$prefix" --disable-ldconfig
  done <<'COMPONENTS'
rustc 2ff05ff9c08a90861e7f6e4065b40a8b87463b4576186fd613871c3e37f2091f
cargo 53f3521949404d595efb06a55c12c5658d4ed1c75566f33d3d514eaebe70bd8a
rust-std 109b074225bf5b9ea3820890876bfdf4ed161adbfaf94b2b4b5984c85ee5d958
rustfmt e3b36c4c7ec3486c059d8067ff48787676612007123aad7a4e8ec12c48ee9ba2
COMPONENTS
fi

mkdir -p "$bin"
for command in rustc rustdoc cargo rustfmt cargo-fmt; do
  if [[ -e "${bin}/${command}" && ! -L "${bin}/${command}" ]]; then
    printf 'Не заменяю существующий инструмент: %s\n' "${bin}/${command}" >&2
    exit 1
  fi
  ln -sfn "${prefix}/bin/${command}" "${bin}/${command}"
done
"${prefix}/bin/rustc" --version
"${prefix}/bin/cargo" --version
"${prefix}/bin/rustfmt" --version
