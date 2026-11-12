#!/bin/sh
# Modified for Triune; reuse the installer and prerequisite/PATH setup.
set -eu

main() {
  installer=$(mktemp "${TMPDIR:-/tmp}/triune-install.XXXXXX")
  trap 'rm -f "$installer"' EXIT
  trap 'exit 1' HUP INT TERM
  curl -fsSL \
    https://raw.githubusercontent.com/MrStrenggeheim/triune/main/scripts/install_oss.sh \
    -o "$installer"
  sh "$installer" \
    --repo https://github.com/MrStrenggeheim/triune.git@main \
    --no-databricks "$@"
}

main "$@"
