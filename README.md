<div align="center">

# <img src="web/public/triune-logo.svg" alt="" height="38" valign="middle" /> Triune

An agent workspace for chats, files and terminals.

[Repository](https://github.com/MrStrenggeheim/triune) · [Issues](https://github.com/MrStrenggeheim/triune/issues) · [Licensing](LICENSING.md)

</div>

Triune combines your agent harnesses with a dockable workspace, file editing, search and server control.
Use Claude Code, Codex and other supported harnesses with your own accounts and credentials.

- Arrange chats, files, previews and terminals in remembered layouts.
- Browse and edit workspace files with Git diffs, search, uploads and downloads.
- Open subchats, quote context and review agent activity.
- Keep generated attachments, manual terminal history and notifications in the workspace.
- Use the same interface on desktop and mobile, with the existing violet theme and three tilted strokes mark.

## Requirements

Linux, macOS or WSL2. The installer checks each tool and offers to install missing ones.

| Tool | Used for | Installer |
| --- | --- | --- |
| curl, uv | Download and install | uv: offers to install (no root) |
| Node.js 22.13+ | Claude/Codex CLIs; source builds | Offers Node 24 via nvm (no root) |
| tmux | Agent terminals | Offers your package manager (sudo) |
| bubblewrap (Linux) | Sandboxed agent terminals | Offers your package manager (sudo) and tests it |
| Claude Code, Codex | Agents | Install and sign in yourself |
| Git, pnpm 11.15.1 | Source builds only | pnpm: uses corepack or offers npm (no root) |

- The installer uses the latest [release](https://github.com/MrStrenggeheim/triune/releases) and verifies its checksums.
- Build `main` from source instead: add `-s -- --source` after `sh`.
- It ends with a list of anything still missing.

## Run on your machine

```sh
curl -fsSL https://raw.githubusercontent.com/MrStrenggeheim/triune/main/scripts/install.sh | sh
triune start --server ""
```

- Your browser opens `http://localhost:6767`.
- Open a new terminal first if the installer changed PATH.
- Stop with `triune stop`.

## Run on a remote server (SSH)

### 1. Install and start on the server

Use your normal login shell, so Node and your agent CLIs are on PATH.

```sh
curl -fsSL https://raw.githubusercontent.com/MrStrenggeheim/triune/main/scripts/install.sh | sh
triune start --server "" --no-open
```

Note the printed port; it is `6767` unless that port is taken.

### 2. Connect from your computer

**SSH tunnel**

```sh
ssh -N -L 6767:localhost:6767 user@server
```

Open `http://localhost:6767`.

**Tailscale** (when Tailscale runs on the server)

```sh
triune stop
export OMNIGENT_WS_ALLOWED_ORIGINS=https://<machine>.<tailnet>.ts.net
triune start --server "" --no-open
tailscale serve --bg 6767
```

Open `https://<machine>.<tailnet>.ts.net` on any device in your tailnet.
See [deploy/tailscale](deploy/tailscale/README.md) for details.

> [!WARNING]
> Other users on a shared server can reach its local ports.
> On shared machines, enable [login](deploy/README.md#auth) before you start Triune.

### 3. Optional: run as a service

Start Triune at boot and restart it after crashes:

```sh
triune stop
triune host enable --server ""
loginctl enable-linger "$USER"
```

- Run these in the same shell and with the same `OMNIGENT_*` variables as step 1; the service keeps them.
- `loginctl enable-linger` keeps the service running after you log out; some servers need an administrator for it.
- Logs: `journalctl --user -u omnigent-host -f`
- Remove: `triune host disable`

On macOS, `triune host enable` installs a launchd agent instead.

<details>
<summary>Manual installation and development</summary>

Install Git, [uv](https://docs.astral.sh/uv/getting-started/installation/), Node.js **22.13+** and pnpm **11.15.1** first.
On WSL2, clone inside the Linux filesystem.

```sh
git clone https://github.com/MrStrenggeheim/triune.git
cd triune
OMNIGENT_SKIP_WEB_UI=true uv sync --locked --no-dev
pnpm install --frozen-lockfile --filter web
pnpm --dir web run build
. .venv/bin/activate
triune start --server "" --no-open
```

- `OMNIGENT_SKIP_WEB_UI=true` skips the Python build's own web UI step; the next two commands build it once.
- For development checks, run `OMNIGENT_SKIP_WEB_UI=true uv sync --locked --group dev` and `just hooks`.
- See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) for repository guidance.

</details>

## Public deployment

For access from the internet, use authentication, a reverse proxy and TLS.
Start with the [deployment guide](deploy/README.md) or the [Docker setup](deploy/docker/README.md).
Provider credentials and local `.env` files belong to your installation; never commit them.

## Compatibility

`triune` is the primary command; `omnigent` and `omni` remain compatibility aliases.
Existing `omnigent` Python imports, `OMNIGENT_*` settings, protocol identifiers and `.omnigent` state remain supported.
The product name changes without silently resetting saved chats, agent connections, credentials or UI preferences.
Do not run two copies against the same state directory at once.

## Licensing and origin

Triune is independently maintained by [MrStrenggeheim](https://github.com/MrStrenggeheim).
It is based on [Omnigent](https://github.com/omnigent-ai/omnigent); original code and the previously published custom baseline retain Apache-2.0 and applicable third-party terms.
New own Triune additions use **PolyForm Noncommercial 1.0.0**, permitting its specified noncommercial uses with the required attribution notice.
The existing Apache-licensed SDKs retain their own license declarations.

[LICENSING.md](LICENSING.md) explains the boundaries and required reference to Triune.
[LICENSE](LICENSE), [NOTICE](NOTICE) and [MODIFICATIONS.md](MODIFICATIONS.md) ship with this distribution.
Commercial uses outside the new license's permitted purposes require separate permission for the new additions.
