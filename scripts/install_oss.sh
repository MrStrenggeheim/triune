#!/bin/sh

# Modified for Triune: install this repository, never the upstream package.
#
# Installs Triune with matching SDKs from the latest published GitHub release.
# Without a release it builds this repository's main branch from source.
# The small install.sh entry point omits optional Databricks integration.
#
# Options:
#   --version TAG install that published release, e.g. 0.20.0-7be0236a9dca
#   --source      build main from source (requires Node 22.13+ and pnpm)
#   --repo URL    build that repository and ref from source, e.g. URL@branch
#   --extra NAME  install an optional-dependency extra (repeatable, or
#                 comma-separated), in addition to databricks
#   --no-databricks  omit the default Databricks extra and CLI
#   --non-interactive, --verbose
#
# uv and git (only for source builds) are required; the installer offers to install
# them if missing. Node/npm are needed by the Claude/Codex/Pi harnesses, tmux
# by their terminal launchers, and bubblewrap (Linux only) to OS-sandbox those
# terminals — missing ones are warnings, not errors, unless building from
# source.

set -eu

# Package identity is distinct from inherited Python import names.
PACKAGE_NAME="triune"
VERSION=
# Databricks workspace login is included; --extra adds other integrations.
EXTRAS=
INCLUDE_DATABRICKS=true
DATABRICKS_CLI_VERSION=1.21.0
# SHA-256 values from this release's official SHA256SUMS manifest.
DATABRICKS_CLI_SHA256_LINUX_AMD64=5599f6a4c01535142cdb1aa16527ec68e6aa849bd7ce72581ec4ed491e9d16b7
DATABRICKS_CLI_SHA256_LINUX_ARM64=27440b096de110978ea8621ed936692bf88e6912ddadea810f7cac78850ceb02
DATABRICKS_CLI_SHA256_DARWIN_AMD64=968946e53e0b197870931c34d103e2e4317002314db6e04a11495af2554415c3
DATABRICKS_CLI_SHA256_DARWIN_ARM64=5c899a18bb280a33cb1814418fd1352a6a6e5487a2d9eb850c573114885c2f83
# Published releases and the source fallback; --repo selects another source.
RELEASE_REPO=MrStrenggeheim/triune
DEFAULT_SOURCE=https://github.com/MrStrenggeheim/triune.git@main
REPO_URL=
FORCE_SOURCE=false
RELEASE_TAG=
RELEASE_DIR=
BUILD_COMMIT=
PYTHON_VERSION="3.12"
# Web UI build toolchain; PNPM_VERSION matches package.json packageManager.
NODE_MIN_VERSION=22.13
PNPM_VERSION=11.15.1
NVM_VERSION=v0.40.3
LATER_NOTES=
INSTALL_URL=
NON_INTERACTIVE=false
VERBOSE=false
LEDGER_PROFILE=
ESC=$(printf '\033')
RESET=
BOLD=
DIM=
MAGENTA=
GREEN=
YELLOW=
RED=

use_terminal_ui() {
  [ -t 1 ] && [ "${TERM:-}" != "dumb" ]
}

init_style() {
  if use_terminal_ui && [ -z "${NO_COLOR:-}" ]; then
    RESET="${ESC}[0m"
    BOLD="${ESC}[1m"
    DIM="${ESC}[2m"
    # Brand accent — Otto's magenta-pink (#F43BA6), matching the Python CLI
    # palette in omnigent/inner/ui.py so the installer and the tool agree.
    MAGENTA="${ESC}[38;2;244;59;166m"
    GREEN="${ESC}[32m"
    YELLOW="${ESC}[33m"
    RED="${ESC}[31m"
  fi
}

# Modified for Triune; the same three tilted strokes identify the product.
print_banner() {
  use_terminal_ui || return 0
  printf '\n%s  /// Triune%s\n' "$MAGENTA" "$RESET"
  printf '%s  all your agents, one workspace%s\n\n' "$DIM" "$RESET"
}

usage() {
  printf 'Usage: install_oss.sh [--non-interactive] [--verbose] [--version TAG | --source | --repo URL] [--extra NAME] [--no-databricks]\n'
}

step() {
  printf '%s==>%s %s\n' "$MAGENTA" "$RESET" "$1"
}

verbose() {
  if [ "$VERBOSE" = true ]; then
    printf '%sDEBUG:%s %s\n' "$DIM" "$RESET" "$1" >&2
  fi
}

warn() {
  printf '%sWARNING:%s %s\n' "$YELLOW" "$RESET" "$1" >&2
}

fail() {
  printf '%sERROR:%s %s\n' "$RED" "$RESET" "$1" >&2
  exit 1
}

spinner_frame() {
  case $(($1 % 4)) in
    0) printf '-' ;;
    1) printf '%s' "\\" ;;
    2) printf '|' ;;
    *) printf '/' ;;
  esac
}

run_with_spinner() {
  label="$1"
  shift

  if [ "$VERBOSE" = true ]; then
    verbose "Running: $*"
    "$@"
    return
  fi

  if ! use_terminal_ui; then
    "$@"
    return
  fi

  log_file="${TMPDIR:-/tmp}/omnigent-oss-installer.$$.log"
  status_file="${TMPDIR:-/tmp}/omnigent-oss-installer.$$.status"
  rm -f "$log_file" "$status_file"

  (
    if "$@" >"$log_file" 2>&1; then
      printf '0\n' >"$status_file"
    else
      printf '%s\n' "$?" >"$status_file"
    fi
  ) &
  command_pid=$!

  frame=0
  while [ ! -f "$status_file" ]; do
    spinner="$(spinner_frame "$frame")"
    printf '\r\033[K%s%s%s %s%s%s' "$MAGENTA" "$spinner" "$RESET" "$BOLD" "$label" "$RESET"
    frame=$((frame + 1))
    sleep 0.1
  done

  wait "$command_pid" 2>/dev/null || true
  status="$(cat "$status_file")"
  rm -f "$status_file"

  if [ "$status" = 0 ]; then
    printf '\r\033[K%sok%s %s\n' "$GREEN" "$RESET" "$label"
    rm -f "$log_file"
    return
  fi

  printf '\r\033[K'
  warn "$label failed"
  cat "$log_file" >&2
  rm -f "$log_file"
  return "$status"
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --non-interactive)
        NON_INTERACTIVE=true
        ;;
      --verbose)
        VERBOSE=true
        ;;
      --no-databricks)
        INCLUDE_DATABRICKS=false
        ;;
      --source)
        FORCE_SOURCE=true
        ;;
      --repo)
        if [ "$#" -lt 2 ]; then
          usage >&2
          exit 1
        fi
        REPO_URL="$2"
        shift
        ;;
      --version)
        if [ "$#" -lt 2 ]; then
          usage >&2
          exit 1
        fi
        VERSION="$2"
        shift
        ;;
      --extra)
        if [ "$#" -lt 2 ]; then
          usage >&2
          exit 1
        fi
        # Accumulate repeated flags into one comma-separated list; a value that
        # is itself comma-separated (--extra a,b) just concatenates cleanly.
        if [ -n "$EXTRAS" ]; then
          EXTRAS="$EXTRAS,$2"
        else
          EXTRAS="$2"
        fi
        shift
        ;;
      *)
        usage >&2
        exit 1
        ;;
    esac
    shift
  done
  if [ "$INCLUDE_DATABRICKS" = true ] && ! has_databricks_extra; then
    EXTRAS="databricks${EXTRAS:+,$EXTRAS}"
  fi
}

has_databricks_extra() {
  case ",$EXTRAS," in
    *,databricks,*) return 0 ;;
    *) return 1 ;;
  esac
}

normalize_repo_url() {
  case "$REPO_URL" in
    https://github.com/*)
      github_archive_url
      ;;
    git+ssh://* | git+https://* | git+http://*)
      INSTALL_URL="$REPO_URL"
      ;;
    ssh://*)
      INSTALL_URL="git+$REPO_URL"
      ;;
    https://* | http://*)
      INSTALL_URL="git+$REPO_URL"
      ;;
    *@*:*)
      user_host="${REPO_URL%%:*}"
      repo_path="${REPO_URL#*:}"
      INSTALL_URL="git+ssh://$user_host/$repo_path"
      ;;
    *)
      fail "Unsupported --repo URL: $REPO_URL. Use https://..., ssh://..., or git@host:org/repo.git."
      ;;
  esac

  verbose "Repository install URL: $INSTALL_URL"
}

# Build GitHub sources from the commit's archive: it skips the full Git history.
github_archive_url() {
  repo_and_ref="${REPO_URL#https://github.com/}"
  ref=main
  case "$repo_and_ref" in
    *@*)
      ref="${repo_and_ref##*@}"
      repo_and_ref="${repo_and_ref%@*}"
      ;;
  esac
  repo_path="${repo_and_ref%.git}"
  if printf '%s' "$ref" | grep -Eq '^[0-9a-f]{40}$'; then
    BUILD_COMMIT="$ref"
  else
    # Prefer the peeled commit of an annotated tag over the tag object.
    BUILD_COMMIT="$(git ls-remote "https://github.com/$repo_path" "$ref" "$ref^{}" 2>/dev/null |
      awk '$2 ~ /\^\{\}$/ { peeled = $1 } NR == 1 { first = $1 } END { print (peeled != "" ? peeled : first) }')"
  fi
  [ -n "$BUILD_COMMIT" ] || fail "Could not resolve $ref in https://github.com/$repo_path."
  INSTALL_URL="https://github.com/$repo_path/archive/$BUILD_COMMIT.tar.gz"
}

# Pick a published release unless a source build was requested.
resolve_install_source() {
  if [ -z "$REPO_URL" ] && [ "$FORCE_SOURCE" = false ]; then
    if find_release; then
      step "Using Triune release $RELEASE_TAG"
      return
    fi
    [ -z "$VERSION" ] || fail "Triune release $VERSION was not found in https://github.com/$RELEASE_REPO/releases."
    warn "No published Triune release found; building from source instead."
  fi
  [ -z "$VERSION" ] || fail "--version selects a published release and cannot be combined with --source or --repo."
  [ -n "$REPO_URL" ] || REPO_URL="$DEFAULT_SOURCE"
  ensure_git
  normalize_repo_url
}

# Set RELEASE_TAG and download that release's SHA256SUMS into RELEASE_DIR.
find_release() {
  if [ -n "$VERSION" ]; then
    case "$VERSION" in
      triune-*) RELEASE_TAG="$VERSION" ;;
      *) RELEASE_TAG="triune-$VERSION" ;;
    esac
  else
    latest_url="$(curl -fsSLo /dev/null -w '%{url_effective}' "https://github.com/$RELEASE_REPO/releases/latest" 2>/dev/null)" || return 1
    case "$latest_url" in
      */releases/tag/triune-*) RELEASE_TAG="${latest_url##*/releases/tag/}" ;;
      *) return 1 ;;
    esac
  fi
  RELEASE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/triune-release.XXXXXX")"
  curl -fsSL "$(release_asset_url SHA256SUMS)" -o "$RELEASE_DIR/SHA256SUMS" 2>/dev/null
}

release_asset_url() {
  printf 'https://github.com/%s/releases/download/%s/%s' "$RELEASE_REPO" "$RELEASE_TAG" "$1"
}

# Download the release wheels listed in SHA256SUMS and verify every checksum.
download_release() {
  wheel_count=0
  while read -r _checksum wheel_name; do
    case "$wheel_name" in
      */* | "") fail "SHA256SUMS of $RELEASE_TAG lists an unexpected entry: $wheel_name" ;;
      *.whl) ;;
      *) fail "SHA256SUMS of $RELEASE_TAG lists a non-wheel file: $wheel_name" ;;
    esac
    curl -fsSL "$(release_asset_url "$wheel_name")" -o "$RELEASE_DIR/$wheel_name" ||
      fail "Could not download $wheel_name from release $RELEASE_TAG."
    wheel_count=$((wheel_count + 1))
  done <"$RELEASE_DIR/SHA256SUMS"
  [ "$wheel_count" -eq 3 ] || fail "Release $RELEASE_TAG should list three wheels in SHA256SUMS, found $wheel_count."
  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$RELEASE_DIR" && sha256sum -c --quiet SHA256SUMS) || fail "Checksum mismatch in release $RELEASE_TAG."
  elif command -v shasum >/dev/null 2>&1; then
    (cd "$RELEASE_DIR" && shasum -a 256 -c --quiet SHA256SUMS) || fail "Checksum mismatch in release $RELEASE_TAG."
  else
    fail "sha256sum or shasum is required to verify the release download."
  fi
}

release_wheel() {
  for wheel_path in "$RELEASE_DIR"/"$1"-*.whl; do
    [ -f "$wheel_path" ] || fail "Release $RELEASE_TAG has no $1 wheel."
    printf '%s' "$wheel_path"
    return
  done
}

cleanup_release_dir() {
  [ -z "$RELEASE_DIR" ] || rm -rf "$RELEASE_DIR"
}

# True only for a source build: that path builds the web UI with pnpm, so
# Node and pnpm are hard requirements. A release install needs neither.
building_from_source() {
  [ -n "$INSTALL_URL" ]
}

prompt_yes_no() {
  prompt="$1"

  if [ "$NON_INTERACTIVE" = true ]; then
    return 1
  fi

  if ! ( : </dev/tty ) 2>/dev/null; then
    return 1
  fi

  printf '%s [Y/n] ' "$prompt" >/dev/tty
  if ! IFS= read -r answer </dev/tty; then
    answer=
  fi

  case "$answer" in
    "" | y | Y | yes | YES | Yes)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

check_platform() {
  case "$(uname -s)" in
    Darwin | Linux)
      ;;
    *)
      fail "install_oss.sh supports macOS and Linux only."
      ;;
  esac
}

# Hard prerequisites. uv is always required (it performs the install). git is
# only needed for a from-source `--repo` install — a PyPI wheel install never
# touches git — so we check it only in that mode. The installer OFFERS to
# install each with a trusted one-line installer rather than just failing.
check_prerequisites() {
  ensure_uv
}

ensure_git() {
  if command -v git >/dev/null 2>&1; then
    step "git is available"
    return
  fi
  case "$(uname -s)" in
    Linux)
      install_cmd="$(linux_pkg_install_cmd git)"
      if [ -n "$install_cmd" ] && prompt_yes_no "git is required and not installed. Install it now ($install_cmd)?"; then
        # Run directly (not via run_with_spinner) so sudo can prompt for a password.
        sh -c "$install_cmd" || true
        command -v git >/dev/null 2>&1 && { step "git installed"; return; }
      fi
      ;;
    Darwin)
      warn "git is required. Install the Xcode command-line tools with: xcode-select --install"
      ;;
  esac
  fail "git is required. Install it, then rerun this installer."
}

# uv performs the install, so it's required; offer the official one-liner,
# and fall back to a fail-with-hint on decline/non-interactive/failure.
ensure_uv() {
  if command -v uv >/dev/null 2>&1; then
    OMNIGENT_LEDGER_DEP_UV=preexisting
    export OMNIGENT_LEDGER_DEP_UV
    step "uv is available"
    return
  fi
  installer='curl -LsSf https://astral.sh/uv/install.sh | sh'
  if prompt_yes_no "uv is required and not installed. Install it now ($installer)?"; then
    run_with_spinner "install uv" sh -c "$installer" || true
    # uv's installer drops the binary in ~/.local/bin (or ~/.cargo/bin) and
    # wires PATH for *future* shells; pull it onto PATH for the rest of this run.
    if ! command -v uv >/dev/null 2>&1; then
      for d in "$HOME/.local/bin" "$HOME/.cargo/bin"; do
        if [ -x "$d/uv" ]; then
          PATH="$d:$PATH"
          export PATH
          break
        fi
      done
    fi
    if command -v uv >/dev/null 2>&1; then
      OMNIGENT_LEDGER_DEP_UV=omnigent
      export OMNIGENT_LEDGER_DEP_UV
      step "Installed uv"
      return
    fi
    fail "uv installed but is not on PATH — open a new shell and rerun this installer."
  fi
  fail "uv is required. Install from https://docs.astral.sh/uv/getting-started/installation/, then rerun."
}

# ── Harness toolchain ────────────────────────────────────────────────
#
# Node 22+/npm power the Claude/Codex/Pi harnesses; the default PyPI install
# and the bare web UI don't need them, so a missing one is a warning here.
# With --repo (source build) npm is required up front, so it becomes an error.

# Report a missing prereq: fatal when building from source, otherwise a warning.
require_or_warn() {
  if building_from_source; then
    fail "$1"
  fi
  warn "$1"
}

# Node 22.13+ matches setup.py's web UI build floor (pnpm 11 needs it).
node_is_supported() {
  command -v node >/dev/null 2>&1 &&
    node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 13) ? 0 : 1)' >/dev/null 2>&1
}

# Offer a user-local Node.js 24 LTS through nvm; it needs no root and ships corepack.
install_node_with_nvm() {
  command -v bash >/dev/null 2>&1 || return 1
  prompt_yes_no "Install Node.js 24 LTS with nvm into ~/.nvm (no root needed)?" || return 1
  nvm_dir="${NVM_DIR:-$HOME/.nvm}"
  if [ ! -s "$nvm_dir/nvm.sh" ]; then
    run_with_spinner "install nvm $NVM_VERSION" sh -c \
      "curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/$NVM_VERSION/install.sh | bash" || return 1
  fi
  step "Installing Node.js 24 with nvm"
  node_bin_dir="$(NVM_DIR="$nvm_dir" bash -c '. "$NVM_DIR/nvm.sh" >/dev/null && nvm install 24 >/dev/null 2>&1 && nvm alias default 24 >/dev/null && dirname "$(nvm which 24)"')" || return 1
  PATH="$node_bin_dir:$PATH"
  export PATH
  step "Installed Node.js $(node --version); new shells load it through nvm"
}

check_node() {
  if node_is_supported; then
    OMNIGENT_LEDGER_DEP_NODE=preexisting
    export OMNIGENT_LEDGER_DEP_NODE
    step "Node.js $(node --version) is available"
    return
  fi
  if command -v node >/dev/null 2>&1; then
    problem="Node.js $(node --version) is older than $NODE_MIN_VERSION"
  else
    problem="Node.js is not installed"
  fi
  if install_node_with_nvm && node_is_supported; then
    return
  fi
  require_or_warn "$problem. Triune needs Node.js $NODE_MIN_VERSION+ for the Claude/Codex CLIs and source builds. Install it from https://nodejs.org or with nvm, then rerun."
}

# The source build needs pnpm, or corepack to fetch it; Node 25+ dropped corepack.
check_pnpm() {
  building_from_source || return 0
  if command -v pnpm >/dev/null 2>&1; then
    step "pnpm is available"
    return
  fi
  if command -v corepack >/dev/null 2>&1; then
    step "corepack is available (provides pnpm $PNPM_VERSION)"
    return
  fi
  if command -v npm >/dev/null 2>&1 &&
    prompt_yes_no "pnpm is missing (needed to build the web UI). Install pnpm $PNPM_VERSION with npm (no root needed)?"; then
    npm_prefix="$(npm prefix -g 2>/dev/null || true)"
    if [ -n "$npm_prefix" ] && [ -w "$npm_prefix" ] && { [ ! -e "$npm_prefix/lib/node_modules" ] || [ -w "$npm_prefix/lib/node_modules" ]; }; then
      run_with_spinner "install pnpm" npm install -g "pnpm@$PNPM_VERSION" || true
    else
      run_with_spinner "install pnpm into ~/.local" npm install -g --prefix "$HOME/.local" "pnpm@$PNPM_VERSION" || true
      path_contains "$HOME/.local/bin" || PATH="$HOME/.local/bin:$PATH"
      export PATH
    fi
  fi
  if command -v pnpm >/dev/null 2>&1; then
    step "pnpm $(pnpm --version) is available"
    return
  fi
  fail "pnpm is required to build the web UI. Install it with: npm install -g pnpm@$PNPM_VERSION (or npm install -g --prefix ~/.local pnpm@$PNPM_VERSION), then rerun."
}

check_npm() {
  if command -v npm >/dev/null 2>&1; then
    OMNIGENT_LEDGER_DEP_NPM=preexisting
    export OMNIGENT_LEDGER_DEP_NPM
    step "npm is available (installs the Claude/Codex/Pi harness CLIs on first run)"
  else
    require_or_warn "npm not found — needed to install the Claude/Codex/Pi harness CLIs (https://nodejs.org)."
  fi
}

# `triune claude` / `triune codex` launch through a local tmux terminal
# and won't start without it, so surface it up front and offer to install it.
# Emit the package-manager command that installs $1 on this Linux box, or
# nothing when no known package manager is present. Shared by the tmux and
# git install offers.
linux_pkg_install_cmd() {
  pkg="$1"
  if command -v apt-get >/dev/null 2>&1; then
    printf 'sudo apt-get install -y %s' "$pkg"
  elif command -v dnf >/dev/null 2>&1; then
    printf 'sudo dnf install -y %s' "$pkg"
  elif command -v yum >/dev/null 2>&1; then
    printf 'sudo yum install -y %s' "$pkg"
  elif command -v pacman >/dev/null 2>&1; then
    printf 'sudo pacman -S --noconfirm %s' "$pkg"
  elif command -v zypper >/dev/null 2>&1; then
    printf 'sudo zypper install -y %s' "$pkg"
  fi
}

check_tmux() {
  if command -v tmux >/dev/null 2>&1; then
    OMNIGENT_LEDGER_DEP_TMUX=preexisting
    export OMNIGENT_LEDGER_DEP_TMUX
    step "tmux is available"
    return
  fi

  case "$(uname -s)" in
    Darwin)
      if command -v brew >/dev/null 2>&1; then
        if prompt_yes_no "tmux is missing (needed for \`triune claude\` / \`triune codex\`). Install it with brew?"; then
          run_with_spinner "brew install tmux" brew install tmux || warn "brew install tmux failed — install tmux manually before \`triune claude\`."
          return
        fi
      fi
      warn "tmux not found — \`triune claude\` / \`triune codex\` need it. Install with: brew install tmux"
      ;;
    Linux)
      install_cmd="$(linux_pkg_install_cmd tmux)"
      if [ -n "$install_cmd" ] && prompt_yes_no "tmux is missing (needed for \`triune claude\` / \`triune codex\`). Install it now ($install_cmd)?"; then
        # Run directly (not via run_with_spinner) so sudo can prompt for a password.
        sh -c "$install_cmd" || warn "tmux install failed — run manually: $install_cmd"
        if command -v tmux >/dev/null 2>&1; then
          OMNIGENT_LEDGER_DEP_TMUX=omnigent
          export OMNIGENT_LEDGER_DEP_TMUX
          step "tmux installed"
        fi
        return
      fi
      if [ -n "$install_cmd" ]; then
        warn "tmux not found — \`triune claude\` / \`triune codex\` need it. Install with: $install_cmd"
      else
        warn "tmux not found — \`triune claude\` / \`triune codex\` need it. Install it with your package manager."
      fi
      ;;
  esac
  command -v tmux >/dev/null 2>&1 || note_later "Install tmux; agent terminals do not start without it."
}

# Remember a missing optional piece and repeat it after the install summary.
note_later() {
  LATER_NOTES="${LATER_NOTES}  - $1
"
}

# bwrap can be installed yet unusable, e.g. when AppArmor blocks user namespaces.
bwrap_is_usable() {
  bwrap --ro-bind / / --dev /dev --proc /proc true >/dev/null 2>&1
}

check_bwrap_usable() {
  if bwrap_is_usable; then
    step "bubblewrap can sandbox agent terminals"
    return
  fi
  warn "bubblewrap is installed but cannot create a sandbox for this user (user namespaces are blocked, e.g. by Ubuntu's AppArmor policy)."
  note_later "Ask an administrator to allow bubblewrap user namespaces; sandboxed agent terminals fail until then."
}

# The native `triune claude` / `triune codex` / `pi` harnesses wrap each
# agent terminal in a bubblewrap (`bwrap`) OS-sandbox; on Linux that isolation
# is mandatory and fail-loud, so a missing `bwrap` binary makes those terminals
# fail to start. macOS sandboxes with the built-in seatbelt backend and needs
# nothing here, so this check is Linux-only.
check_bubblewrap() {
  [ "$(uname -s)" = Linux ] || return 0

  if command -v bwrap >/dev/null 2>&1; then
    OMNIGENT_LEDGER_DEP_BWRAP=preexisting
    export OMNIGENT_LEDGER_DEP_BWRAP
    step "bubblewrap (bwrap) is available"
    check_bwrap_usable
    return
  fi

  install_cmd="$(linux_pkg_install_cmd bubblewrap)"
  if [ -n "$install_cmd" ] && prompt_yes_no "bubblewrap is missing (needed to sandbox native \`triune claude\` / \`triune codex\` terminals). Install it now ($install_cmd)?"; then
    # Run directly (not via run_with_spinner) so sudo can prompt for a password.
    sh -c "$install_cmd" || warn "bubblewrap install failed — run manually: $install_cmd"
    if command -v bwrap >/dev/null 2>&1; then
      OMNIGENT_LEDGER_DEP_BWRAP=omnigent
      export OMNIGENT_LEDGER_DEP_BWRAP
      check_bwrap_usable
      return
    fi
  fi
  note_later "Install bubblewrap; sandboxed agent terminals on Linux do not start without it."
  if [ -n "$install_cmd" ]; then
    warn "bubblewrap (bwrap) not found — native \`triune claude\` / \`triune codex\` terminals need it on Linux. Install with: $install_cmd"
  else
    warn "bubblewrap (bwrap) not found — native \`triune claude\` / \`triune codex\` terminals need it on Linux. Install it with your package manager."
  fi
}

install_omnigent() {
  # Extras apply to every install mode.
  extras_suffix=
  if [ -n "$EXTRAS" ]; then
    extras_suffix="[$EXTRAS]"
  fi
  # The SDK's prebuilt wheels embed a full Claude Code copy (about 380 MB); its
  # source package does not, and the SDK then uses the user's own `claude`.
  set -- --force -q --python "$PYTHON_VERSION" --no-binary-package claude-agent-sdk
  if building_from_source; then
    step "Installing Triune from source${extras_suffix:+ $extras_suffix} (Python $PYTHON_VERSION)"
    # Pair the backend with the SDKs from the same source; uv tool install
    # does not apply the checkout's tool.uv.sources mapping.
    set -- "$@" \
      --with "omnigent-client @ ${INSTALL_URL}#subdirectory=sdks/python-client" \
      --with "omnigent-ui-sdk @ ${INSTALL_URL}#subdirectory=sdks/ui"
    target="${PACKAGE_NAME}${extras_suffix} @ ${INSTALL_URL}"
    if [ -n "$BUILD_COMMIT" ]; then
      OMNIGENT_BUILD_COMMIT="$BUILD_COMMIT"
      export OMNIGENT_BUILD_COMMIT
    fi
  else
    step "Installing Triune $RELEASE_TAG${extras_suffix:+ $extras_suffix} (Python $PYTHON_VERSION)"
    run_with_spinner "download and verify release" download_release
    triune_wheel="$(release_wheel triune)"
    client_wheel="$(release_wheel omnigent_client)"
    ui_wheel="$(release_wheel omnigent_ui_sdk)"
    set -- "$@" \
      --with "omnigent-client @ file://$client_wheel" \
      --with "omnigent-ui-sdk @ file://$ui_wheel"
    target="${PACKAGE_NAME}${extras_suffix} @ file://$triune_wheel"
  fi
  run_with_spinner "uv tool install" uv tool install "$@" "$target"
}

install_databricks_cli() (
  case "$(uname -s)" in
    Darwin) databricks_os=darwin ;;
    Linux) databricks_os=linux ;;
    *) fail "The Databricks CLI requires macOS or Linux." ;;
  esac
  case "$(uname -m)" in
    x86_64) databricks_arch=amd64 ;;
    arm64 | aarch64) databricks_arch=arm64 ;;
    *) fail "Unsupported Databricks CLI architecture: $(uname -m)." ;;
  esac
  case "$databricks_os:$databricks_arch" in
    linux:amd64) databricks_sha256="$DATABRICKS_CLI_SHA256_LINUX_AMD64" ;;
    linux:arm64) databricks_sha256="$DATABRICKS_CLI_SHA256_LINUX_ARM64" ;;
    darwin:amd64) databricks_sha256="$DATABRICKS_CLI_SHA256_DARWIN_AMD64" ;;
    darwin:arm64) databricks_sha256="$DATABRICKS_CLI_SHA256_DARWIN_ARM64" ;;
  esac

  databricks_tmp="$(mktemp -d "${TMPDIR:-/tmp}/omnigent-databricks.XXXXXX")" || exit 1
  trap 'rm -rf "$databricks_tmp"' 0
  trap 'exit 1' 1 2 15
  databricks_archive="databricks_cli_${DATABRICKS_CLI_VERSION}_${databricks_os}_${databricks_arch}.zip"
  curl -fsSL "https://github.com/databricks/cli/releases/download/v${DATABRICKS_CLI_VERSION}/${databricks_archive}" \
    -o "$databricks_tmp/databricks.zip" || exit 1

  # Reuse uv's Python so fresh machines need neither unzip nor sudo.
  databricks_python="$(uv python find "$PYTHON_VERSION")" || exit 1
  "$databricks_python" -c '
import hashlib
import sys
import zipfile

with open(sys.argv[1], "rb") as download:
    digest = hashlib.file_digest(download, "sha256").hexdigest()
if digest != sys.argv[3]:
    raise SystemExit("Databricks CLI archive checksum mismatch.")
with zipfile.ZipFile(sys.argv[1]) as archive:
    archive.extract("databricks", sys.argv[2])
' "$databricks_tmp/databricks.zip" "$databricks_tmp" "$databricks_sha256" || exit 1
  chmod +x "$databricks_tmp/databricks" || exit 1
  "$databricks_tmp/databricks" auth login --help >/dev/null || exit 1
  mkdir -p "$1" || exit 1
  mv "$databricks_tmp/databricks" "$1/databricks" || exit 1
)

ensure_databricks_cli() {
  databricks_path="$PATH"
  if ! path_contains "$1"; then
    databricks_path="$1:$PATH"
  fi
  databricks_cli="$(PATH="$databricks_path" command -v databricks 2>/dev/null || true)"
  if [ -z "$databricks_cli" ] && { [ -e "$1/databricks" ] || [ -L "$1/databricks" ]; }; then
    databricks_cli="$1/databricks"
  fi
  if [ -n "$databricks_cli" ]; then
    if ! "$databricks_cli" auth login --help >/dev/null 2>&1; then
      fail "Databricks CLI at $databricks_cli cannot run auth login. Update it using https://docs.databricks.com/aws/en/dev-tools/cli/install, then rerun this installer, or use --no-databricks to install without workspace login dependencies."
    fi
    OMNIGENT_LEDGER_DEP_DATABRICKS=preexisting
    export OMNIGENT_LEDGER_DEP_DATABRICKS
    step "Databricks CLI is available at $databricks_cli"
    return
  fi

  if ! run_with_spinner "Install Databricks CLI $DATABRICKS_CLI_VERSION" install_databricks_cli "$1"; then
    fail "Databricks CLI installation failed. Check the error above and rerun this installer."
  fi
  OMNIGENT_LEDGER_DEP_DATABRICKS=omnigent
  export OMNIGENT_LEDGER_DEP_DATABRICKS
  step "Installed Databricks CLI at $1/databricks"
}

uv_tool_bin_dir() {
  uv tool dir --bin
}

path_contains() {
  dir="$1"

  case ":$PATH:" in
    *":$dir:"*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

pick_profile() {
  case "$(uname -s):${SHELL:-}" in
    Darwin:*/zsh)
      printf '%s/.zprofile\n' "$HOME"
      ;;
    Darwin:*/bash)
      printf '%s/.bash_profile\n' "$HOME"
      ;;
    Linux:*/zsh)
      printf '%s/.zshrc\n' "$HOME"
      ;;
    Linux:*/bash)
      printf '%s/.bashrc\n' "$HOME"
      ;;
    *)
      printf '%s/.profile\n' "$HOME"
      ;;
  esac
}

maybe_add_bin_to_path() {
  bin_dir="$1"

  if path_contains "$bin_dir"; then
    step "$bin_dir is already on PATH"
    return
  fi

  path_line="export PATH=\"$bin_dir:\$PATH\""
  profile="$(pick_profile)"
  begin_marker="# >>> Omnigent installer >>>"
  end_marker="# <<< Omnigent installer <<<"

  warn "$bin_dir is not on PATH."
  if [ "$NON_INTERACTIVE" = true ]; then
    warn "Add it with: $path_line"
    return
  fi

  if [ -f "$profile" ] && grep -F "$begin_marker" "$profile" >/dev/null 2>&1; then
    if grep -F "$path_line" "$profile" >/dev/null 2>&1; then
      LEDGER_PROFILE="$profile"
      step "PATH is already configured in $profile"
      return
    fi
    fail "$profile already has an Triune installer block. Update it manually to: $path_line"
  fi

  if ! prompt_yes_no "Add $bin_dir to PATH in $profile?"; then
    warn "Skipping PATH update. Current shell can run: $path_line"
    return
  fi

  mkdir -p "${profile%/*}"
  {
    printf '\n%s\n' "$begin_marker"
    printf '%s\n' "$path_line"
    printf '%s\n' "$end_marker"
  } >>"$profile"
  LEDGER_PROFILE="$profile"
  step "Added $bin_dir to PATH in $profile"
}

write_install_ledger() {
  bin_dir="$1"
  cli_path="$bin_dir/triune"
  if [ ! -x "$cli_path" ]; then
    cli_path="$(command -v triune 2>/dev/null || true)"
  fi
  if [ -z "$cli_path" ]; then
    warn "Could not write install ledger: triune command not found."
    return 0
  fi
  if [ -n "$LEDGER_PROFILE" ]; then
    OMNIGENT_LEDGER_PROFILE="$LEDGER_PROFILE"
    export OMNIGENT_LEDGER_PROFILE
  fi
  ledger_command_path="$PATH"
  if ! path_contains "$bin_dir"; then
    ledger_command_path="$bin_dir:$PATH"
  fi
  if PATH="$ledger_command_path" "$cli_path" _internal write-ledger --from-env >/dev/null 2>&1; then
    step "Recorded install ledger"
  else
    warn "Could not write install ledger; uninstall can backfill it later."
  fi
}

verify_omnigent() {
  bin_dir="$1"
  cli_path="$bin_dir/triune"

  if [ ! -x "$cli_path" ]; then
    cli_path="$(command -v triune 2>/dev/null || true)"
  fi

  if [ -z "$cli_path" ]; then
    fail "Triune installed, but the triune command was not found."
  fi

  "$cli_path" --help >/dev/null
  step "Verified $cli_path"

  # `omni` is a shorthand alias installed alongside `omnigent`; check it so a
  # packaging regression that drops it surfaces here rather than later.
  for alias_cmd in omnigent omni; do
    if [ ! -x "$bin_dir/$alias_cmd" ] && ! command -v "$alias_cmd" >/dev/null 2>&1; then
      warn "the $alias_cmd alias was not installed (expected a console-script entry point alongside triune)."
    fi
  done
}

# No setup step here by design: the first `omnigent` run configures a model
# credential and offers to install the harness CLI you pick.
print_next_steps() {
  bin_dir="$1"
  command_prefix=

  if ! path_contains "$bin_dir"; then
    command_prefix="PATH=\"$bin_dir:\$PATH\" "
  fi

  printf '\n%sTriune installed successfully.%s\n\n' "$BOLD" "$RESET"
  printf 'Start Triune and open it in your browser:\n'
  printf '  %s%striune start --server ""%s\n\n' "$command_prefix" "$MAGENTA" "$RESET"
  printf 'Or launch a specific coding harness:\n'
  printf '  %striune claude          # Claude Code\n' "$command_prefix"
  printf '  %striune codex           # Codex\n\n' "$command_prefix"
  printf 'Manage model credentials any time:\n'
  printf '  %striune setup\n\n' "$command_prefix"
  printf 'Uninstall the CLI but keep local history and credentials:\n'
  printf '  %striune uninstall --yes\n\n' "$command_prefix"
  if has_databricks_extra; then
    printf 'Connect to a Databricks-hosted Triune server:\n'
    printf '  %somnigent login <workspace-url>/omnigent\n\n' "$command_prefix"
    printf '%sDatabricks dependencies and CLI are installed. To use a workspace\n' "$DIM"
    printf 'as your model provider, select Databricks in triune setup.%s\n' "$RESET"
  fi
  if [ -n "$LATER_NOTES" ]; then
    printf '%sStill needed for agent terminals:%s\n%s\n' "$YELLOW" "$RESET" "$LATER_NOTES"
  fi
}

main() {
  trap cleanup_release_dir EXIT
  trap 'exit 1' HUP INT TERM
  init_style
  parse_args "$@"
  print_banner
  check_platform
  resolve_install_source
  check_prerequisites
  check_node
  check_npm
  check_pnpm
  check_tmux
  check_bubblewrap
  install_omnigent
  bin_dir="$(uv_tool_bin_dir)"
  verify_omnigent "$bin_dir"
  if has_databricks_extra; then
    ensure_databricks_cli "$bin_dir"
  fi
  maybe_add_bin_to_path "$bin_dir"
  write_install_ledger "$bin_dir"
  print_next_steps "$bin_dir"
}

main "$@"
