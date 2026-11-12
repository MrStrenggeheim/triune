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

## Install

For Linux, macOS or WSL2:

```sh
curl -fsSL https://raw.githubusercontent.com/MrStrenggeheim/triune/main/scripts/install.sh | sh
```

The installer builds the web interface and installs Triune and matching SDKs from this repository's `main` branch.
It checks prerequisites and offers supported missing tools; optional Databricks integration is omitted by default.
A source build requires Node.js **22.13+** and pnpm **11.15.1**, with Git and uv available.
For native agent terminals, install `tmux` and, on Linux, `bubblewrap`.
Install and sign in to your preferred agent harness separately.

Open a new terminal if the installer changes PATH, then start Triune:

```sh
triune start --server ""
```

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

The environment variable lets the following explicit frontend commands handle the interface build once.
Use the localhost address printed by the server.
For development checks, run `OMNIGENT_SKIP_WEB_UI=true uv sync --locked --group dev` and `just hooks`.
See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) for repository guidance.

</details>

## Your own server

The local command runs the server and host on your machine.
Remote access needs authentication, a suitable reverse proxy and TLS; use the existing [deployment guide](deploy/README.md).
For a source-based container setup, use [deploy/docker](deploy/docker/README.md).
Provider credentials and local `.env` files belong to your installation and must not be committed.

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
