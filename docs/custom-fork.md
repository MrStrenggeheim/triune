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
Local activation snapshots live session runtimes, stops the services, verifies the new release and restores those conversations instead of waiting for them to become idle.
Running tasks request continuation through the existing recovery path; unanswered questions and approvals are never automatically accepted.
Session recovery retries retain the healthy release without repeating its service restart, while code/startup failures keep the existing backup and rollback behavior.

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

## Performance and retained views

Views retain drafts, buffers, undo state and terminal lifecycles while inactive presentation and view-owned polling pause.
Hidden chat streams detach without discarding their retained state; live streams obey the origin connection budget and reconcile missed items when shown again.
Visible panes and two recent hidden layout groups stay mounted briefly; older recoverable views retire while their saved layouts remain intact.
Editors, terminals and other views with local state remain resident until they can be restored safely.
Browser windows yield stream slots on blur or hide, and visible panes without a live slot catch up through bounded snapshots without capacity notices.
Stable resource boundaries and scoped subscriptions avoid updating unrelated chats when switching layouts or opening files.
File links add their tab before original capture completes; editing starts after the original is retained through the authenticated capture route.
Snapshots use binary artifacts with small versioned metadata, while existing captures remain readable.
Rich editor/preview modules load when used, and substantial JSON responses negotiate gzip without changing streaming or download protocols.

## Agent communication

Cross-chat agent communication and independent workers are enabled by default.
Settings → General → Agent communication stores a personal choice on the server and applies it to new actions immediately.
It does not disable ordinary subagents or cancel accepted work.
Peer cards show the trusted sender and source chat, a compact expandable message, and the shared message footer.
Orchestration defaults to the current chat and separates agents from shells, including completed work, with a shared category filter and supported Stop controls.
Its alternative Host/workspace source uses the existing combined selector and limits inventory to the chosen root.
Task rows retain dispatch-specific names, instructions and results; their buttons open the child or its originating Orchestration in tabs.
One task card tracks each dispatch, while a captured child report appears separately as an attributed Markdown reply with expansion and the shared footer.
Late report capture updates the existing stored item and loaded transcript; steering preserves the original task identity.
Orchestration rows open on click, render scoped Markdown and align natural-width status badges outside the colored surface.
Routine coverage diagnostics stay internal, and choosing Host/workspace starts from the selected chat's captured location.
The original composer shelf reuses existing question, approval, shell, agent and plan components without dropdown chevrons.
Queue and attention shelves share a gapless density-aware stack, with 200ms entrance/exit and immediate reduced-motion behavior.
Question popups retain drafts and distinguish Previous, Skip/Next, partial or empty Submit, and whole-request Decline.
Agent and shell popups reuse Orchestration's two-line rows, supported Stop status pills and exact-resource side-opening controls.
Native shell records retain captured output across completion and reload without promising an interactive connection or unsupported targeted control.
Only trusted human submissions use human message styling; framework recovery and other injected input retain explicit source wrappers.
Peer copies say sent to in the source chat and from in the receiving chat, with authorized destination/source links.
Touch tabs switch on one tap; stationary holds open their context menu, and held movement starts the existing dock placement preview.
Appearance uses compact density controls and schematic file destinations, while media cards fit their aspect ratio and the shared 256px image-height limit.
Native Codex command lifecycle events populate Shells, and structured asynchronous questions remain answerable after the turn ends or the page reloads without blocking a new message.
New managed Codex homes enable the native plan tool unless the user already configured it explicitly; actual plan updates populate the shelf.
Real Codex and Claude CLI journeys verify questions, approvals, task updates and delegation with an isolated scripted provider; this is transport/browser evidence, not a live-model claim.
Native child composers and steering are gated by current parent-runtime capabilities; readable history alone never enables input.
Claude native children and Codex runtimes without an external targeted-input API remain read-only rather than silently launching a replacement conversation.
Codex inputs carry their canonical message identity through the native echo so agent messages retain provenance and human quotations remain ordinary messages.
Peer file references require the captured sender scope and access to both chats and the source filesystem.
Ask Subchat creates a durable fork at the selection and opens its named tab before runner initialization finishes.
The draft contains a quote card and source annotation; inherited history appears only after Show history, while explicit forks keep their normal history view.
An inherited source is not serialized into the model input a second time, and quote captures retain navigation metadata without unrelated tool arguments or output.
The working shimmer crossfades static highlights through opacity, preserving reduced-motion behavior without repainting a moving text background every frame.
Administrators can set `OMNIGENT_FEATURES=-session_orchestration` to disable the capability for the deployment; that startup override requires a restart.

## Search and activity refinements

Contextual sidebar and palette results share authorized newest-first queries, actor/date headers and one-line highlighted excerpts.
All/Final/User uses the existing toggle; Final includes user messages and confirmed final agent replies.
Search opens collapsed owners and original source when needed, preserving manual scrolling and drafts rather than reporting valid matches unavailable.

Task, peer, final-reply and System cards share the compact accent-edge composition, Workflow navigation and static right/down disclosure.
Their timestamp/copy/link footer slots are omitted for now; ordinary human and assistant message actions remain unchanged.
One dispatch keeps one task card and an authoritative final report, with progress excluded from automatic replies.
Framework wake dispatch preserves System authority, including Claude's correlated native prompt receipt; internal inbox instructions do not add a redundant visible message.

Selected queued sends retain lifecycle ownership so old idle events cannot release other drafts.
Queues wrap within the composer width and use Comfortable geometry in both density modes.
Plan status uses shared accent checkbox visuals without becoming editable, and sidebar/rail/palette scrollbars are hidden without removing scrolling.

Offline shell history stays passive and readable, with typed authorization/routing failures preserved and safe notifications.
Shared shell labels retain acknowledged Stop and distinguish unknown outcomes from known success.
Provider notices use the existing composer popover with Open Agent CLI and UI-only Dismiss; no native answer or account purchase is inferred.
