# Triune custom workspace fork

Triune is maintained in [MrStrenggeheim/triune](https://github.com/MrStrenggeheim/triune/tree/main) on `main`.
It derives from upstream [Omnigent](https://github.com/omnigent-ai/omnigent), with the inherited Apache baseline at `4646d0bbd9492eed3bff0e95d39f8ac85d1b1eb8`.
Upstream authorship, copyright and license notices remain intact.
The owner's new work uses PolyForm Noncommercial 1.0.0; see [LICENSE](../LICENSE) and [LICENSING.md](../LICENSING.md) for the exact scope and retained Apache material.

## Run it

Follow the [root installation guide](../README.md#install) for a local browser installation or the existing Docker server stack.
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
| Markdown editor mount lifecycle | [Markdown editor](../feature-map/markdown-editor.md) |
| Feature verification entry points | [Feature map](../feature-map/README.md) |
| Shared appearance and interaction rules | [Design system](../design-system/triune/MASTER.md) |

## Configuration and updates

Triune retains the inherited `omnigent` Python package, `omnigent.*` API/schema/type/tool namespaces and `@omnigent/*` SDK package names for compatibility.
The `omnigent` and `omni` CLI aliases remain compatibility entry points; new instructions use `triune`.
Local user data and credentials still live under `~/.omnigent` by default, independently of the checkout.
Existing `OMNIGENT_*` environment variables, configuration keys and service identifiers retain their names; a branding change does not migrate state.
The browser build links a Triune web app manifest with standalone display and existing brand icons.
The server rebases its identity, launch URL and scope to the configured deployment prefix, retaining the canonical home address without a trailing slash.
For `/omnigent`, all three manifest values are `/omnigent`, keeping Knowledge's `/knowledge/` outside Triune's scope.
Existing installations with another inferred identity may need reinstalling; a separately installed portal with scope `/` still overlaps applications on this origin.
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

## Durable inputs and interactive outputs

Unread native follow-ups share one hint below the working indicator and return to ordinary transcript order on exact consumption receipts.
Permission controls retain their selected mode label; only a running Codex turn adds a short next-turn note in hover and menu guidance.
The Goal control follows Plan in the attention shelf, and an active goal keeps that shelf available.
Tool readers cap input/output boxes at 320px or the smaller owning-view allowance, retaining expansion and full copying across updates.
Notification feed descriptions expand from two lines; preview footers follow Comfortable/Compact density, and dedicated previews reuse one type-aware header.
The packaged runtime tool catalog centralizes selection guidance, actual availability and filesystem-scope distinctions across supported harness delivery channels.
Native input and upload receipts retain observed identities and turn ownership; child execution metadata comes only from actual native records.

Composer drafts retain their text, attached bytes and captured context across reloads in viewer-scoped browser storage.
Accepted follow-ups use a durable server queue and dispatch in order after eligible turn completion, including with every browser/app closed.
Failed delivery, changed execution scope and revoked access require review; queued drafts and files stay private until their original author dispatches them.

Uploaded HTML can render inline with an explicit `triune-artifact` code fence containing `{"file_id":"uploaded-id","title":"Optional title"}`.
The shared isolated viewer retains complete bytes, local interactions and bounded state, with highlighted source and a portable self-contained download.
Its More menu opens a Triune view tab or an isolated new window; ordinary attachment downloads retain the original bytes.
The first-party artifact kit supplies Appearance-aware native controls without external CDNs.
Native checkbox, mixed-state checkbox, range and progress controls retain their form behavior and restored state.
Its versioned assets and manifest ship beneath `artifacts/kit/`; see the [artifact feature map](../feature-map/artifacts.md).
Inline HTML and Mermaid previews cap at 60% of the visible owning view, scroll internally and retain Expand controls.
Standalone file, editor and expanded previews retain their own scroll area without that cap.

The packaged UI capability catalog and `sys_ui_capabilities` describe available rendering formats, tools, scopes and fallbacks.
Harness adapters deliver product guidance through their supported startup/discovery channels while preserving author configuration.
Mermaid diagrams use one shared Appearance-aware theme and retain source, expansion and download controls.
Native shapes, depth washes, contrasting labels and contextual label backings carry through SVG export.

## File editing and navigation

Live workspace-file chips open the normal editable File Editor; rendered embeds and attachments without a live path retain their preview/lightbox.
Appearance → Open files from chat controls pane reuse and splitting, defaulting to a neighboring pane with one split when needed.
File headers keep one copyable Host/path, Comments, Diff and the three-dot menu; comments ownership is chosen inside the comments sidebar.
Notification and workspace-picker density follows Appearance, and notifications can hide read entries while preserving active Undo actions.
See the unified-workspace feature map for source mappings and desktop/mobile acceptance checks.

## Performance and retained views

### Conversation ownership and negotiated recovery

The workspace declares the union of visible conversation IDs after a layout commit.
Each tab holds one membership per authorized visible conversation; moving a pane preserves its membership and reader state.
Chat controls target their conversation's registry entry, and subchats filter inherited history before the shared row projection.

Servers with the SQLite change journal advertise feed version 2.
Set `TRIUNE_TRANSCRIPT_FEED=canary` for per-browser opt-in, `2` for a negotiated default, or `1` for compatibility mode.
During a canary, `localStorage.setItem("triune:transcript-feed", "2")` before connecting enrolls the browser.
Set `TRIUNE_TRANSCRIPT_CANARY_CHAT` to enroll tabs opened directly on one named conversation.
The previous client and SSE paths remain available to compatible clients.

The versioned feed sends the initial window once, applies contiguous journal revisions for appends and amendments, and fences retired memberships by subscription ID.
A slow referenced tool result can hydrate separately from its ordered header.
Codex MCP calls retain stable call and result identities; shell inventory publishes independently of chat previews.
The local journal is additive and its changes commit with their corresponding item mutations.

An optional timed observation run requires both `TRIUNE_STREAM_OBSERVE_UNTIL_MS` (UTC epoch milliseconds) and `TRIUNE_STREAM_OBSERVE_DIR` (private directory).
Expiry stops new collection automatically.
Browser receipts contain digest IDs, stages, positions, revisions and viewport order; the server batches physical write measurements outside the critical section.
Use synthetic content for screenshot checks.


Views retain drafts, buffers, undo state and terminal lifecycles while inactive presentation and view-owned polling pause.
Hidden chat memberships detach without discarding retained state and reconcile missed items when shown again.
On servers advertising `transcript_stream:1`, one updates WebSocket per browser tab carries list watches, independently authorized transcript memberships and presence.
Visible multiplex memberships survive window blur; hidden view leases detach, while legacy SSE retains origin-slot and focus arbitration.
The server produces structured events once for WebSocket and SSE adapters, and the browser parses WebSocket events without converting them back into SSE bytes.
Membership queues bound events, serialized bytes and residence time; physical writes have a deadline, and expensive authorization or list reads run outside the physical writer.
Authorization is refreshed after any writer wait; revoked or rebound memberships cannot publish queued frames under an earlier check.
Ready senders take FIFO turns; the final fresh authorization handoff is capped at one second and a physical socket write at five seconds.
The 8 MiB serialized-event budget covers maximum tool output including JSON escaping.
For larger saved items, the browser negotiates an ordered reference on WebSocket or SSE and retrieves the complete body by session, item ID, position and SHA-256 before advancing its checkpoint.
The exact read repeats session and referenced-source authorization, streams 64 KiB chunks and rejects changed content.
Saved items reconcile by exact ID and committed conversation position; pending previews retain explicit anchors until their own committed identity replaces them.
Missing positioned activity updates insert once in canonical order; loaded cards enrich in place, while unpositioned legacy updates retain bounded recovery and truthful failure notices.
Reconnect resumes from position, revision and stream-epoch cursors: trusted same-epoch recovery point-reads tracked old-card changes and replays the appended tail.
Failed multiplex subscriptions retain increasing retry delays until validated synchronization completes; opening a local response alone does not reset backoff.
Readiness heartbeats wait for an already-requested history synchronization instead of restarting it; live checkpoint gaps still trigger recovery after synchronization completes.
An explicit binding/attempt synchronization owner accepts only validated replay completion and bounds incomplete synchronization independently of heartbeat traffic.
Ancillary resource snapshots no longer hold the live tail; canonical replay still preserves its captured high-water boundary and rejects incomplete recovery.
Content-free convergence diagnostics correlate received, accepted and displayed identities across reloads, with bounded retention and authenticated viewer scope.
Chat and subchat project pending inputs and settled work in the same chronological order, with inherited rows filtered by the saved fork boundary.
Established rail and grid sessions reuse the full scoped conversation surface and composer; the first question in a pending rail tab creates its fork.
Interrupt confirmation belongs to the runner and the observed turn; a failed or uncertain request keeps the conversation readable and offers a scoped status check before another attempt.
Displayed samples come from committed visible DOM rows; they do not equate store publication with screen presentation or claim physical display timing.
Fallback history reads cancel on focus return, hiding or disposal and have a fifteen-second deadline, so pending snapshots cannot prevent live observation from resuming.
Pending snapshots retain accepted input identities independently of position; reconnect merges their local copies and consumes each exact receipt once, preserving repeated intentional inputs.
The bounded mutation journal coalesces changed identities; expired/untracked mutations and untrusted cursors still require an authoritative reset.
Reset replaces committed membership while preserving drafts, uploads and unmatched previews; unchanged heartbeats cause no history reads or replay.
Revision tracking is process-local and workspace-scoped; writes bypassing its mutation hooks require explicit invalidation or reset.
Older servers use SSE after bounded capability negotiation of 750ms; host-routed sessions retain their existing SSE routing.
Descendant activity reads project only required scalar metadata and labels in batches, preserving authorization, ordering, nulls and incomplete-coverage semantics.
Matched backup measurements retain exact response hashes and query counts while eliminating general row hydration and execution-override decoding for descendants.
Visible panes and two recent hidden layout groups stay mounted briefly; older recoverable views retire while their saved layouts remain intact.
Editors, terminals and other views with local state remain resident until they can be restored safely.
Stable resource boundaries and scoped subscriptions avoid updating unrelated chats when switching layouts or opening files.
File links add their tab before original capture completes; editing starts after the original is retained through the authenticated capture route.
Snapshots use binary artifacts with small versioned metadata, while existing captures remain readable.
Rich editor/preview modules load when used, and substantial JSON responses negotiate gzip without changing streaming or download protocols.

## Agent communication

Cross-chat agent communication and independent workers are enabled by default.
Settings → General → Agent communication stores a personal choice on the server and applies it to new actions immediately.
It does not disable ordinary subagents or cancel accepted work.
Peer cards show the trusted sender and source chat through the shared compact expandable message card.
Orchestration defaults to the current chat and separates agents from shells, including completed work, with a shared category filter and supported Stop controls.
Its alternative Host/workspace source uses the existing combined selector and limits inventory to the chosen root.
Task rows retain dispatch-specific instructions and results; their buttons open the child or its originating Orchestration in tabs.
Cards, peer messages, Orchestration and shelf rows share one current agent name, independent short task and latest proven Instruction/Reply preview from authorized caches.
One canonical activity card tracks each child agent and updates in place across steering and lifecycle events, retaining its stable key and absorbed source aliases.
The latest preview follows exact child-source positions and explicit finality; progress and unknown assistant finality never become Reply.
Captured reports retain their assignment identity and attributed Markdown presentation.
Late report capture updates the existing stored item and loaded transcript; steering preserves the original task identity.
Orchestration rows open on click, render scoped Markdown and align natural-width status badges outside the colored surface.
Routine coverage diagnostics stay internal, and choosing Host/workspace starts from the selected chat's captured location.
The original composer shelf reuses existing question, approval, shell, agent and plan components without dropdown chevrons.
Queue and attention shelves share a gapless density-aware stack, with 200ms entrance/exit and immediate reduced-motion behavior.
Each moving shelf paints one continuous surface beneath the next layer's rounded corners.
Settled shelves auto-hide without deleting plans or resources; the conversation menu can reopen the shelf, plan or Orchestration.
New questions and approvals restore automatic attention; manual visibility remains local to the retained view and resets on remount.
Each actual question batch has one needs-input entry and one card that becomes its answered receipt.
Pending and answered in-chat cards retain drafts and header pagination; expanded answered bodies show only the answer.
Shelf question popups show the bold question, answers and one row of Previous, Decline and counted Skip/Next/Submit actions, bounded by composer width.
Optional provider categories precede the original question; submissions and correlated native echoes do not create duplicate human-message cards.
Submit and Decline apply to the batch, retaining supported partial or empty answers.
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
Quote-created drafts contain a quote card and source annotation.
Every durable subchat starts with inherited history behind Show history, while explicit forks retain their normal full-history view.
The first new child question follows the existing automatic naming preference without using copied parent questions or overriding manual names.
An inherited source is not serialized into the model input a second time, and quote captures retain navigation metadata without unrelated tool arguments or output.
The working shimmer crossfades static highlights through opacity, preserving reduced-motion behavior without repainting a moving text background every frame.
Administrators can set `OMNIGENT_FEATURES=-session_orchestration` to disable the capability for the deployment; that startup override requires a restart.

## Search and activity refinements

Contextual sidebar and palette results share authorized newest-first queries, actor/date headers and one-line highlighted excerpts.
All/Final/User uses the existing toggle; Final includes user messages and confirmed final agent replies.
Search opens collapsed owners and original source when needed, preserving manual scrolling and drafts rather than reporting valid matches unavailable.

Task, peer, final-reply and System cards share the compact accent-edge composition, Workflow navigation and static right/down disclosure.
Their timestamp/copy/link footer slots are omitted for now; ordinary human and assistant message actions remain unchanged.
Expanding a shared card retains its leading icon, status and controls in a stable header while the complete body opens below.
Completed-turn work includes native task and reply cards; missing live activity items recover from authorized canonical history.
Each child keeps one stable activity card and assignment-specific final reports, with progress excluded from automatic replies.
Child cards reuse the tool-call expander and command, file and subagent counts; questions, approvals and final parent answers retain separate boundaries.
Exact source reveal opens both tool and Worked folds while preserving canonical card aliases.
Framework wake dispatch preserves System authority, including Claude's correlated native prompt receipt; internal inbox instructions do not add a redundant visible message.
Reusable native children create task cards from committed assignments rather than empty session creation, preserving each assignment and its final report.

Selected queued sends retain lifecycle ownership so old idle events cannot release other drafts.
Queued previews keep text and bounded attachment summaries on one line and retain complete text/files through Edit.
Shelf outer radii match the composer; inner control radii derive from the shared radius and equal edge insets.
Active plan entries use the same unchecked box as pending, with the shared active border and accessible In progress text; completed entries stay checked and read-only.
Sidebar/rail/palette scrollbars are hidden without removing scrolling.

Offline shell history stays passive and readable, with typed authorization/routing failures preserved and safe notifications.
Shared shell labels retain acknowledged Stop and distinguish unknown outcomes from known success.
Exceptional provider Notices and a compact Usage control live in the conversation header.
Usage prioritizes observed context, compact session totals and reported quota windows; token/cache accounting and observation details expand on demand.
Interactive popup surfaces use opaque theme colors so their text and controls remain readable in dark mobile views.
Information retains agent/session details, MCP controls, policies and version diagnostics.

## Iteration6 source status

Iteration6 activated as `0.20.0-9dc3656856a6` from `9dc3656856a63f341c77311c267285f5ba370236` on 2026-11-16 at 23:10:34 UTC.
The activation receipt verifies healthy service interpreters, 634 exact candidate3/wheel assets and three restored runtimes.
Evidence lives under `artifacts/iteration6-20261116/`: `activation.json`, `verification-summary.json` and `browser-preparation/followup/aggregate-results.json`.

| Request | Source behavior |
| --- | --- |
| `MOBILE-SAFE-TOP-6` | Match native top paint, browser theme-color and standalone status paint to the resolved application bar; reserve safe insets once. |
| `MOBILE-COMPACT-SHELF-6` | Use 4px/2px Comfortable/Compact shelf spacing and 8px/4px mobile composer gutters, retaining 44px shelf controls and continuous moving paint. |
| `STARTUP-DESTINATION-6` | Appearance → On startup defaults to Continue last session: restore the saved layout owner on cold home launch; explicit links and New chat win. |
| `PLAN-ACTIVE-BOX-6` | Pending and active share an unchecked box; active changes only its border, preserves status text and remains read-only. |
| `POPUP-VERTICAL-ANCHOR-6` | Match the popup's row-edge gap to the visible control inset on the actual opening side, retaining collision handling. |
| `MOBILE-IMAGE-GESTURES-6` | Pinch from 1× to 8× and pan within bounds; only fresh gestures starting at Fit navigate or dismiss. |
| `SIDEBAR-STATUS-ROLLUP-6` | Collapsed parents include currently revealable descendants; expanded parents remain own-only, under the original two status-group priorities. |
| `MOBILE-PLUS-SIZE-6` | Restore the top-bar Open button's 28px mobile face with transparent hit expansion; desktop spacing and tab-strip plus retain their existing roles. |
| `ACTIVITY-RECOVERY-6` | Insert missing positioned activity once; recover tracked old-card changes by authorized point reads, retaining full reset when mutation coverage is unavailable. |
| `RESOURCE-ROW-RESPONSIVE-6` | Ellipsize resource text, collapse narrow status labels to accessible icons and move message-card controls below text when needed. |

The status groups remain blocking problem > needs input > draft, and running/starting > unread; each empty group collapses independently.
Rollup excludes children outside the current revealable section, including filtered, archived and delegation-only metadata; incomplete membership or personal/error evidence stays unknown.
Startup falls back to New chat when the saved owner is unavailable, preserving its layout and draft.

Acceptance is mapped in [Unified workspace](../feature-map/unified-workspace.md), [Composer](../feature-map/composer.md), [Sessions](../feature-map/sessions.md), [Chat activity](../feature-map/chat-activity.md) and [Chat attachments](../feature-map/chat-attachments.md).
Nine unique iteration6 browser cases and two separate transcript-sync cases passed across retained candidates; overlapping source checks are not additional unique coverage.
Native-inset emulation and Chromium touch injection do not establish physical iOS/Android, keyboard or installed-PWA behavior.

## Integration7 delivery

The following eleven items activated as `0.20.0-5638ac603960` from source `5638ac603960f19ce0012dccae8b29352b4bf539`.
Activation at 23:46 UTC verified both service interpreters, all 635 tested/package assets and restoration of three active runtimes.
Evidence: `artifacts/overnight-20261116/activation.json`, `verification-summary.json` and `loading-audit/candidate2-cold-comparison.json`.

| Request | Delivered behavior |
| --- | --- |
| `LIST-REFETCH-7` | Batch affected list query keys for child sort updates; retain broad reconciliation for root sorts and structural membership changes. |
| `LIST-COST-7` | Omit compressed execution-only fields from list, watched-row and descendant reads; normal session reads retain full state and authorization. |
| `FOCUS-LEASE-7` | Change focused send ownership without rebinding observation for continuously visible panes; detach after the last visible owner leaves. |
| `LAYOUT-WRITES-7` | Save a title batch once across shared, saved and pinned layouts; skip unchanged titles and repeated focused-tab selection. |
| `TAB-OBSERVERS-7` | Keep overflow/alignment observers attached across selection and ordinary renders while preserving immediate geometry updates and cleanup. |
| `MERMAID-LAZY-7` | Load the engine inside the first asynchronous diagram render; preserve existing serialization, fonts, appearance, source and export. |
| `DRAFT-HYDRATION-7` | Require successful hydration before scoped saves; failed reads preserve unread durable work and retain new edits/files locally. |
| `DRAFT-MERGE-7` | Merge per-entry changes in one IndexedDB transaction; preserve unrelated drafts and reject stale edits to observed deleted IDs. |
| `DRAFT-SCOPE-7` | Retain hydration edits, files, removals and promotions under their captured account/server owner; publish only the active owner's state. |
| `QUEUE-LIFECYCLE-7` | Reject superseded lifecycle publications before queued-input admission; selected sends retain their own turn ownership. |
| `QUEUE-OBSERVERS-7` | Retire empty observers, retain pending compaction observation and recover enqueue races; shutdown stops replacement delivery tasks. |

Implementation evidence: `artifacts/overnight-20261116/{list-refetch/handoff.json,backend-audit/implementation-handoff.txt,frontend-audit/implementation-handoff.json,frontend-audit/geometry-handoff.json,loading-audit/IMPLEMENTATION.md,persistence-fixes/REPORT.txt,race-audit/implementation/HANDOFF.txt}`.
The parent owns the combined build, browser acceptance and release checks.

- Same-ID draft edits use the last serialized writer; no live cross-tab refresh or cross-device synchronization is added.
- Unavailable storage retains unsaved bytes in this process only; closing it cannot promise durability.
- Scoped refetches retain cancellation, root-wide reconciliation and access revocation; component work counts do not prove production latency or heap savings.
- Deferred Mermaid loading shifts cost to first use; engine-load failure retains the existing error/source UI, with recovery verified after asset restoration and reload only.
- Ownerless transcript-model retirement remains an open decision; saved layouts, reader state, drafts, send state and editor/terminal ownership retain their existing protection.
- `APPROVAL-RECEIPT-7` was excluded from integration7; its later protocol is described below.
- Branch-query/index changes delivered separately in stability8 below.

## Stability8 delivery

Release `0.20.0-7f207db84d8a` activated on 2026-11-17 at 00:03:01 UTC with 635 exact UI assets and three restored runtimes.
`BRANCH-QUERY-8` adds the covering label index and bounded inverse-branch reads; installed SQLite revision `bq1a2b3c4d5e` and the index were verified.
`SHELL-VALIDATION-8` runs pure shell validation off the event loop while preserving capture ordering, cancellation and both redaction passes.
The 55 branch and 42 shell checks passed before packaging; bounded timing and thread samples establish no general production speedup or hard GIL limit.
Evidence: `artifacts/overnight-20261116/stability8/{verification-summary.json,activation.json,installed-index.json}`.

## Receipt privacy follow-up

New question receipt IDs derive from the sanitized request, excluding secret defaults from persisted digests as well as receipt text.
Structured and legacy-preview cases preserve provider-bound data; existing saved receipts are unchanged.
This correction is independent of the unfinished `APPROVAL-RECEIPT-7` delivery protocol.

## Native ingestion metadata follow-up

`NATIVE-INGEST-9` uses fresh light metadata for message resource provenance and optional subagent-return ancestry checks.
Full session reads and each original authorization/binding check remain; no request-wide conversation cache or native transport batching is added.
The synthetic 20-item probes retain identical receipts, item hashes, positions and SQL counts while reducing unused execution decoding.
Alternating point-read CPU controls show the clearest benefit with large policy metadata and a small overhead for empty state; no production latency claim is made.
Evidence: `artifacts/overnight-20261116/native-ingest/{HANDOFF.txt,measured-merits.json}`.

## Highlighting payload follow-up

`INITIAL-CHUNKS-9` leaves Shiki themes and WASM behind their existing dynamic imports, retaining the shared core/engine group and Streamdown compatibility rule.
Sealed cold-browser samples download 1,953,366 fewer decoded JavaScript bytes with the same 122 initial requests; core still evaluates and first use fetches the required data.
The payload reduction establishes no latency improvement; desktop/phone highlighting, failure/reload, diagram entry points and Monaco initialization were checked separately.
The unchanged baseline's TipTap mount failure remains a separate investigation.
Evidence: `artifacts/overnight-20261116/initial-chunks/{handoff.md,counts.json}`.

## Exact approval delivery follow-up

`APPROVAL-RECEIPT-7` reserves a durable attempt before forwarding a runner/scaffold verdict and requires a receipt tied to the exact pending Future and process identities.
Retries query that original receipt; acceptance commits its redacted question receipt and count changes before publishing resolution.
Receipt-release progress survives restart and retries metadata cleanup without resending answers; local/native waiters retain their separate resolution paths.
The additive `ad1b2c3d4e5f` migration follows `bq1a2b3c4d5e`; unknown delivery remains held rather than inferred from text, time or a generic HTTP success.
`APPROVAL-UNKNOWN-REVIEW-17` adds Delivery unknown to the shared approval card, with a metadata-only review dialog and Recheck delivery on desktop, mobile, Inbox and standalone approval pages.
Recheck uses the existing authenticated elicitation GET with the original attempt ID; only its exact trusted receipt settles the hold, and access or runner changes during the request keep it held.
The action never resends an answer, grants a new decision or removes an unknown hold; parent integration and release verification remain pending.
An empty reconnect snapshot keeps unknown delivery held; a stale copy of the same attempt cannot reopen a card after its resolution event.
Independent source review and 105 combined integration checks passed; synthetic ASGI/restart proofs do not establish live-provider or multi-process hard-kill behavior.
Evidence: `artifacts/overnight-20261116/race-audit/implementation/APPROVAL-HANDOFF.md` and `approval-review/FOLLOWUP.md`.

## Conditional view loading

`LAZY-PR-10` shares one lazy PR implementation across docked views, the compatibility rail and the mobile drawer.
`LAZY-AUTOMATIONS-10` defers the docked scheduling page while retaining its existing direct route and resident search, filter and dialog state.
Both use the shared chunk-error boundary with automatic reload disabled locally, keeping unrelated editors and composer drafts mounted when an asset is unavailable.
Manual Refresh remains a deliberate document reload; sole-copy editor changes and unsent PR comments are not promised to survive it.
The isolated PR candidate defers 337,122 decoded bytes but increases initial requests from 122 to 134; the Automations candidate separately defers 85,113 bytes.
These isolated byte deltas must not be summed as the combined release result; the exact combined bundle has its own acceptance evidence.

`BACKEND-COST-10` omits unused execution metadata during descendant prompt discovery, preserving fresh traversal, paging, tenant scope and durable approval restoration.
Synthetic active traversal removes 48 execution-column conversions and 24 policy/notices parses with identical response bytes and SQL counts.
Snapshot unit doubles now explicitly model empty durable journals and saved-input queues; actual ledger behavior remains covered by SQLite/ASGI approval tests.
Evidence: `artifacts/overnight-20261116/{cold-followup/lazy-pr/handoff.md,lazy-automations/handoff.md,backend-cost10/HANDOFF.txt,stability10}`.

## Streaming and pending-input work

`STREAM-CONTENT-11` uses an explicit entry-owned operation for already placed native preview content, retaining the immutable item/tool index and canonical placement.
Membership changes, pending-input changes, replay/reset, canonical edits and final replacement retain the general normalization path.
The 5,000-item, 100-flush probe reduces normalization/index rebuilding from 100 calls to one and full item-map copies to zero; array copies and renderer discovery scans remain linear.
The existing multiplex browser scenarios now also exercise optimistic input, repeated indexed updates, replay, a skipped chunk and authoritative final replacement.

`TITLE-ROUTING-11` runs the fresh background-title runner lookup off the event loop while retaining the captured workspace and event-loop HTTP dispatch.
Its injected 80 ms SQLite-delay control reduces the heartbeat pause from 84.7 to 5.6 ms; this is a boundary check, not production latency evidence.

`PENDING-QUERY-11` adds an index matching pending-input filtering and submission order, preserving existing indexes, queue states, cursor semantics and tenant predicates.
Migration `pq1a2b3c4d5e` follows `ad1b2c3d4e5f`; existing split conversation databases ensure the same index at startup.
The synthetic 30,000-row store probe avoids the previous full-history scan; index storage and write maintenance are the tradeoff.
Evidence: `artifacts/overnight-20261116/{stream-content/HANDOFF.md,title-routing/handoff.json,pending-query/implementation-manifest.json,stability11}`.

## Transcript discovery reuse

`PROJECTION-ANALYSIS-12` reuses routing-chip and subagent-card discovery across certified native-preview content replacements.
Each immutable raw transcript array receives an opaque structure stamp; only the validated content helper propagates it, and the stamp retains no source-array or parent links.
Per-surface bubble caches reuse discovery only, while structural changes receive fresh stamps and cacheless projection remains a cold oracle.
An eight-update, 261-block warmed probe reduces 6,264 repeated discovery visits to zero after initial analysis, with identical output and positive invalidation checks.
Canonical filtering, prefix/lifecycle guards, continued-turn marking and source-array copies retain their existing work; no bounded whole-rendering or production latency claim follows.
Evidence: `artifacts/overnight-20261116/projection-analysis/{comparison.json,candidate-files.json}` and `stability12/`.

## Reused native child runner ownership

`CHILD-RUNNER-13` reconciles an existing Codex child's runner binding when its current parent runner registers the same native thread again.
`CLAUDE-CHILD-RUNNER-15` extends the same transactional checks to an ordinary Claude child's exact native subagent identity.
The registration must carry trusted authority for the parent's current binding; the store checks the persisted parent/native identity and unchanged child binding before writing only the runner field.
Ordinary native children retain their conversation, dispatch and transcript identity; side chats and independently hosted children do not acquire this shared-runner authority.

## Native input replay identity

`INPUT-LIVE-DEDUP-16` reconciles optimistic sends with canonical user items at live insertion, reset and late HTTP acknowledgement.
Server-matched native messages retain an optional `input_stable_id` alongside their native item ID; external producers cannot assert that alias, and ambiguous FIFO settlement cannot create it.
Exact identities preserve separate intentional identical sends, uploaded files and stable rendering keys without matching browser message text.
`RESOURCE-UPDATE-RECOVERY-16` keeps ordinary terminal metadata in canonical replay while excluding it from missing-subagent recovery.
The shared transcript browser journey and focused store/server cases cover these boundaries; see [canonical transcript acceptance](../feature-map/unified-workspace.md#canonical-transcript-and-navigation-acceptance).
The existing exact-runner checks still gate shell observations and provenance-bearing events.
This repairs reused-child shell inventory after parent runner replacement; it does not infer general transcript completeness or repair historical rows by guessing identity.
Source, authorization/concurrency evidence and activation are recorded separately in `artifacts/overnight-20261116/{event-rejections,stability13,sibling-child-audit,stability15}`.

## Exact history cursor lookup

`CURSOR-LOOKUP-14` projects the primary-key timestamp alongside position when resolving an exact item ID.
This lets SQLite seek through the existing primary-key prefix instead of scanning a covering position index, retaining the same tenant/conversation predicates, cursor errors and page results.
The private 1,000/10,000-item cases use 38 VM instructions at both sizes versus approximately 4,000/40,000 before; deployed read-only plans confirm the same index choice.
The change adds no index, schema migration, planner hint or response cache, and does not establish a production latency improvement.
Cold synchronization still performs an authoritative full-history reset when no cursor exists; a bounded initial window requires a separate membership/count/recovery contract.
Evidence: `artifacts/overnight-20261116/{history-read-audit/REPORT.md,history-read-audit/implementation/comparison.json,stability14/cursor-plan-before.json}`.

## Codex next-turn permissions

`PERMISSION-INTERRUPT` replaces terminal permission injection with the loaded native runtime's structured settings RPC.
The picker configures native execution for subsequent turns, including while another turn runs; Stop remains a separate user action for urgent restrictions.
Scheduling uses the calling turn’s applied permission scope and checks all configured Triune guardrails.
See [agent scheduling](AUTOMATIONS.md) for binding and approval behavior.
The runtime handshake must report Codex 0.164.0 or newer, and native profile discovery must explicitly allow the selected built-in profile.
The native forwarder's observed configuration owns labels and restart arguments; delayed PATCH replies cannot overwrite newer observations.
Timeouts after dispatch report an unknown outcome without rollback, relaunch, automatic resume or guessed menu input.
Unknown custom profiles clear the built-in preset label instead of retaining a misleading previous value.
Source validation and isolated CLI/TUI/browser evidence are recorded in `artifacts/reliability-audit-20261117/permission-control/`; activation is separate.

### Permission protocol compatibility

The public and runner mutation route is `POST /v1/sessions/{id}/codex/next-turn-permissions/v1`.
Requests explicitly name protocol `codex-next-turn-permissions/v1`, scope `subsequent_turns` and the preset `mode`.
Both hops validate acknowledgement protocol, scope, mode and accepted status; neither falls back to a legacy PATCH or runner event.
Legacy `approval_mode` PATCHes and `codex_approval_mode_change` runner events are rejected before native mutation, even when an extra scope marker is supplied.
This remains safe when a cached client outlives a server rollback or a remote runner is older.
Future observations use `session.codex_next_turn_permissions_v1` and `omnigent.codex_native.next_turn_permissions_v1`; the old current-scope label/event receives only an Unknown invalidation.
Actual `86aca953c` server/runner probes returned 404 for the new route without side effects; its unknown runner event returned 200, while a marked legacy event still attempted Escape.
Compatibility evidence and the integration delta from the functional candidate are under `artifacts/reliability-audit-20261117/permission-control/compatibility/`.

## Session layout, transcript and settings

The header layout menu redistributes open views and retains each session's tabs and drafts.
Dragging a divider resizes its two neighbors.
Settings → Appearance → Chat defaults controls whether answers follow the reader at the bottom; new profiles hold their position.

A chat mention inserts a link immediately.
New sessions reconcile their first message with the item ID returned by the server.
Large saved events can travel as authorized item references; the client applies the complete item before advancing its transcript checkpoint.

See [Unified workspace](../feature-map/unified-workspace.md), [Composer](../feature-map/composer.md), [Chat activity](../feature-map/chat-activity.md) and [Native harnesses](../feature-map/native-harnesses.md).
