# Triune custom workspace fork

Triune is maintained in [MrStrenggeheim/triune](https://github.com/MrStrenggeheim/triune/tree/main) on `main`.
It derives from upstream [Omnigent](https://github.com/omnigent-ai/omnigent), with the inherited Apache baseline at `4646d0bbd9492eed3bff0e95d39f8ac85d1b1eb8`.
Upstream authorship, copyright and license notices remain intact.
The owner's new work uses PolyForm Noncommercial 1.0.0; see [LICENSE](../LICENSE) and [LICENSING.md](../LICENSING.md) for the exact scope and retained Apache material.

## Run it

Follow the [root quickstart](../README.md#quick-start) for a local browser installation or the existing Docker server stack.
The current distribution is source from this repository's `main`, including its backend, SDKs and frontend.
Use the quickstart's Triune installer or manual checkout recipe, which uses `uv.lock` and `pnpm-lock.yaml`.
Use `triune` as the primary CLI, for example `triune server`, `triune host` or `triune run`.
Native harnesses need their own installation/login, `tmux` and, on Linux, `bubblewrap`.
The browser/server recipe does not need Rust, Ruby or iOS tooling.
See [contributor setup](../CONTRIBUTING.md#development-setup) when changing code.

## Custom feature map

| Area | Repository documentation |
| --- | --- |
| Docked views, per-chat layouts and pins | [Unified workspace](../feature-map/unified-workspace.md) |
| Composer and model controls | [Composer](../feature-map/composer.md) |
| Feature verification entry points | [Feature map](../feature-map/README.md) |
| Shared appearance and interaction rules | [Design system](../design-system/triune/MASTER.md) |

## Configuration and updates

Triune retains the inherited `omnigent` Python package, `omnigent.*` API/schema/type/tool namespaces and `@omnigent/*` SDK package names for compatibility.
The `omnigent` and `omni` CLI aliases remain compatibility entry points; new instructions use `triune`.
Local user data and credentials still live under `~/.omnigent` by default, independently of the checkout.
Existing `OMNIGENT_*` environment variables, configuration keys and service identifiers retain their names; a branding change does not migrate state.
The VS Code extension displays Triune while retaining `omnigent.serverUrl`, `omnigent.open` and its existing view/panel IDs.
Keep this directory and Docker's generated `.env` private.
Docker stores database and artifact data in its existing named volumes; see the [deployment guide](../deploy/docker/README.md).

For an installer-based update, let running work finish, stop the local instance with `triune stop`, and rerun the Triune installer from the root quickstart.
For checkout-based updates, stop it and run `git pull --ff-only` on `main` from `https://github.com/MrStrenggeheim/triune.git`.
Repeat the quickstart's dependency-install and frontend-build commands, then start it again.
Upstream PyPI, Homebrew and desktop downloads do not contain this fork's changes.
Historical upstream design notes retain Omnigent names and commands as context; use this guide and maintained feature recipes for Triune.

`deploy/local/` contains the original operator's VPS release-management tools.
They are not required by either quickstart and still assume that operator's systemd installation.
Portable release automation, additional platform certification and the wider productionization audit are deferred.

## Development

Keep feature behavior, shared UI rules and setup instructions in this repository.
Record tasks in the fork's issues or the operator's supplied checklist; personal agent instructions and private KBs are optional.
Before submitting a change, run the relevant existing checks and the required Git hooks.

## File editing and navigation

Live workspace-file chips open the normal editable File Editor; rendered embeds and attachments without a live path retain their preview/lightbox.
Appearance → Open files from chat controls pane reuse and splitting, defaulting to a neighboring pane with one split when needed.
File headers keep one copyable Host/path, Comments, Diff and the three-dot menu; comments ownership is chosen inside the comments sidebar.
Notification and workspace-picker density follows Appearance, and notifications can hide read entries while preserving active Undo actions.
See the unified-workspace feature map for source mappings and desktop/mobile acceptance checks.

## Agent communication

Cross-chat agent communication and independent workers are enabled by default.
Settings → General → Agent communication stores a personal choice on the server and applies it to new actions immediately.
It does not disable ordinary subagents or cancel accepted work.
Administrators can set `OMNIGENT_FEATURES=-session_orchestration` to disable the capability for the deployment; that startup override requires a restart.
