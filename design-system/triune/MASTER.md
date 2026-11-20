# Triune workspace design system

A compact developer workspace built from Triune's existing components.
The approved workspace specification governs behavior; later owner corrections govern appearance.
Iteration6 refinements describe source; [the fork guide](../../docs/custom-fork.md#iteration6-source-status) distinguishes them from the installed release.

## Basis

- Audited upstream `v0.20.0`: semantic theme tokens, Radix controls, compact navigation, shared tooltips and typography.
- Approved specification: docked views, explicit ownership, violet defaults, 48px headers, density and mobile accessibility.
- UI/UX Pro Max: semantic surfaces, state clarity, stable geometry, restrained feedback, shared icons and visible keyboard focus.
- Generated landing-page patterns, replacement fonts and suggested palettes do not fit this application and are excluded.

## Reuse and owner approval

Treat this specification at a Git revision as the entry point for design decisions.
The registry supplies values, production components supply interactions, and stories exercise those components with fixture data.
The small visualization kit consumes generated tokens for sandboxed HTML.
Use the production React components for product development and product mockups.

Use the [ui-ux skill](https://github.com/prangishviliAbe/agent-skills/tree/72580c2903bd8e9c769a398cb3c12c00353cc91d/ui-ux) for the design and visual QA pass.
An intent brief supplies the task and constraints; the app supplies the visual context.
Inspect nearby components, render the real caller, and fix optical and interaction defects before owner review.

1. **Find the owner.** Run `python3 -m dev.design_catalog workspace` from the repository root, or open **Design review → Start here → Interactions** in Storybook.
   Both read the [task directory](interactions.json), which names the owner, production caller, story and focused test.
   For an uncatalogued interaction, trace an existing caller first.
2. **Reuse or repair.** Supply content, commands and state to the existing component.
   Parents arrange siblings, groups own joined edges and the component that paints an inset surface owns its derived radius.
   Extend the shared owner when a specified state is missing and verify existing callers.
3. **Review a design difference.** Use one interactive comparison per independently decidable change, with related appearances or surfaces as states of that comparison.
   Render the same production composite and fixture in Current and Proposed, including the open menus and dialogs.
   Provide proportional guides, relevant viewport and input modes, and identify the exact difference.
4. **Record the decision.** For an accepted change, record the owner decision, date, ticket, exact candidate revision or artifact digest, and accepted surface and states here.
   Record partial acceptance explicitly and link the decision in the queue item.
   The commit containing the decision versions the specification; an updated example that changes the decision returns to review.
5. **Verify and deliver.** Run the owning tests, compare affected complete surfaces with reviewed baselines and check keyboard, touch, focus return and geometry where relevant.
   Promote changed visual baselines only for the accepted scope.
   Implementation and release follow the normal delivery queue.

### Current scope of owner review

Earlier scoped approvals in this document still apply.
The first collection of the whole application is a working reference pending owner review.
In uncovered areas preserve the existing production surface and bring any new product choice to the owner.

| Owner decision | Accepted scope | Reference for implementation |
| --- | --- | --- |
| ACTIVITY-ENTRY-27, 2026-11-18 | Proposed agent and shell entry geometry, nested actions and narrow Stop treatment | Queued activity-entry artifact, SHA-256 `04949f1d4ba831dac09897e255b4f6a2b5681f9bc6a926cfdf882f1007d2c162` |
| BUTTON-UNIFY-28, 2026-11-18 | Composer at rest, hover and press only | Button artifact, SHA-256 `86ea83c0e6165c4ea00a177405693698448517178906b2a4764387dad5648ab3` |
| UX review 1 · embedded workspace directory row, 2026-11-18 | Folder and file rows in the embedded picker: 28 px Compact and 36 px Comfortable on desktop, 44 px for either density on touch; keep the reviewed insets, icon spacing and enabled/disabled appearance | `WorkspacePickerEntry` at `b71684ab1`; review artifact SHA-256 `5376b4a5e3ae87b59cb3d9070162bf2b4680e1885ea131d071c13263a97dc649` |
| BUTTON-UNIFY-28 · Medium, 2026-11-19 | At default Appearance, 32 px button, 1 px reserved border, 8 px padding, 6 px gap and 14 px icon/label band. Shift only the label up 0.5 px. Preserve viewport-specific UI type. | Accepted Medium artifact, SHA-256 `61ecdd59531b8f65154cbade5664bb360bbf12193b1ff0f702cf1e18ca880a31` |
| BUTTON-UNIFY-28 · ordinary ghost menu triggers, 2026-11-19 | Use the composer's hover and press feedback. Show a distinct open fill after release. Held feedback takes precedence while pressed. Stop, nested actions and specialized controls keep their existing roles. | File Viewer's Diff comparison in the approved shared Button artifact, SHA-256 `4f71d0f0da07d7c67046ffd50829d9d2e41900622d02fa045c395e4d1ba3fc12` |

The owner rejected the replacement popup contents and workspace selector in the button artifact.
Mount the production menus and `WorkspaceSelectionDialog` when reviewing button changes.
Keep earlier scoped composer decisions on their own ticket.

### Review sequence and open tickets

Prepare the source inventory across the app, then review one component at a time in its normal callers.
Generate the React inventory with `node web/scripts/review-inventory.mjs --storybook-index URL_OR_FILE --out INVENTORY.json` against the matching Storybook build's `index.json`.
Read one packet with `node web/scripts/review-inventory.mjs --inventory INVENTORY.json --component WorkspacePickerEntry`.
It lists declared options, usage sites, story coverage and unresolved expressions.
Use the artifact kit's versioned manifest and native renderer sources for their respective surfaces.
Batch implementation by shared owner and affected surface, beginning with approved, broadly reused controls.
Migrate callers and verify each batch end to end before picking up another family.
Group routine reuse under the existing approval. Ask once for each new visible interaction.
Show one representative example in context and give the recommendation in one to three sentences.
A reply of “approve” covers the stated scope. Apply a short correction to the shared component and show just the revised behavior.
Keep variant inventories, measurement guides and test evidence available for drill-down.
Distinguish production callers, supported story-only variants and dynamic combinations that require a fixture.
Group identical repetitions visually and retain their source locations.

Keep open product and reliability requirements in the implementation queue.
Tag each open ticket with its review areas on the checkbox line, for example `<!-- ux: composer, transcript -->`.
Use `all` for a cross-cutting requirement.
Run `python3 -m dev.design_queue QUEUE.md --area workspace-picker` before sharing that review and again before merge.
Repeat `--area` for affected callers, including behavior such as Stop, scrolling or delivery when those paths change.
The command checks every open ticket for routing and lists relevant ticket IDs and lines; read their full acceptance criteria.
Record which requirements the candidate covers and which still need implementation or runtime verification.

For the next ten UI edits, record the family, reuse/extension/bypass, and any correction to a previously decided rule in the existing ticket.

## Tokens and components

| Role                     | Canonical implementation                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------- |
| View headers and content | `--workspace-content`; white in light mode, neutral `#18181b` in dark mode                  |
| Sidebar     | `--workspace-chrome`; pale selected-accent wash                                             |
| Application bar          | `--workspace-appbar`; medium-light accent wash, distinct from tabs                             |
| Overlay                  | Existing popover/dialog tokens; opaque readable foreground                                  |
| Normal text              | Existing system/Geist typography and `--foreground`                                         |
| Secondary text           | `--muted-foreground`; never use disabled opacity for ordinary text                          |
| Selected tab             | Content surface; primary bottom strip identifies the active tab |
| Pane focus               | Active-tab primary bottom strip; no pane perimeter or top accent line                                      |
| Keyboard focus           | Existing `--ring` treatment; preserve visible focus                                         |
| Header geometry          | 48px Comfortable; 36px Compact, from the shared Appearance density                                                                |
| Header action            | `HeaderActionButton`, 24px glyph surface; header target is row height minus 4px                                |
| Tab-strip add action     | Shared 24px fine-pointer width with row-aligned height; narrow/coarse targets retain the 44px minimum          |
| Sidebar toggle           | `SidebarToggle` with `SidebarPanelIcon`, filled segment when open                           |
| Search modes             | Existing `SegmentedControl`, consistent scope/category sizing                               |
| Switches                 | Shared `Switch`; off, on and disabled must remain distinguishable                           |
| Tooltip                  | Canonical centered tooltip; no conversation metadata hover cards                            |
| Density                  | Existing shared list tokens; vertically centered disclosure and label                       |
| Motion                   | Immediate tab and disclosure state changes; no hover animation                              |
| Scrolling                | Existing slim scrollbar treatment; fixed headers never scroll vertically                    |

## Approved theme and interactive states

The owner approved these surface and control roles on 2026-11-11.
All chrome mixes use the existing selected accent, including saved preset and custom preferences.
The default violet primary is deep purple `#68518b` with white text in both modes.
Other selected palettes retain their primary and readable foreground preferences.

| State or role                   | Shared treatment                                                                    |
| ------------------------------- | ----------------------------------------------------------------------------------- |
| Chrome at rest                  | `--workspace-chrome`: 10% accent mixed into content                                 |
| Application bar | `--workspace-appbar`: 28% accent mixed into content |
| Tab bar and active tab | Content surface; focused active tab has a 3px primary bottom strip |
| Hover on content                | `--workspace-hover-on-content`: 8% accent mixed into content                        |
| Hover on chrome                 | `--workspace-hover-on-chrome`: 6% foreground mixed into chrome                      |
| Focused tab hover               | Retain active strip; shared content-hover fill for the hovered tab                  |
| Primary action, including Send  | Shared primary fill and foreground; hover adds 5% black, press adds 10% black       |
| Secondary action                | White with dark text and a neutral border; neutral dark counterpart with light text |
| Secondary hover / press / open  | Add 6% / 10% / 10% foreground to the secondary surface                              |
| Keyboard focus                  | Keep the shared visible focus ring independently of hover or selection              |
| Disabled action                 | Shared disabled treatment; Send uses muted fill/text, with no pointer interaction   |
| Busy Send and interrupt         | Preserve busy/disabled semantics and the destructive interrupt variant              |

Primary hover and press keep text opaque rather than fading the entire control.
Use the matching surface-hover token for icon actions and rows.
Keep the active bottom strip visible while hovering a tab; apply state feedback without tab or disclosure animation.

`index.css` publishes the workspace tokens independently of the workbench styles.
Import `workbenchSurfaces.css` after the existing shell and dock CSS to give docked roots, headers and content opaque shared surfaces.
Docked content is excluded from the global dark-card glass decoration; code, diff, selection and overlay surfaces retain their specialized roles.

## Composition

Each tab contains its label and its own close control.
Desktop tab/container headers and view headers remain separate rows, including single-tab panes.
Mobile reuses horizontally scrolling tabs, including views from other panes; only the selected view is shown.
The composer workspace trigger shows a muted monitor and folder, a connected dot on online hosts and the folder basename.
It collapses to the folder icon when the action row hides its labels, retaining the accessible full location.
The shell owns device safe-area insets once; native top clearance uses the application-bar paint and bottom clearance uses the content surface.
Browser `theme-color` follows the resolved opaque application-bar color, and the standalone status shim paints that surface across the reserved top inset.
Main and side-chat mobile composers add an 8px Comfortable or 4px Compact content gutter.
The app bar places Layout presets immediately before Notifications.
Mouse hover or keyboard focus replaces the tab type icon with its pin control, without reserving another slot.
Touch tabs switch on the first tap; pinning remains available through the shared context menu.
Keep the chat content action menu as three dots; place the existing Chat/Terminal switch immediately before it.
Keep conversation breadcrumbs in the view header.
Center empty guidance within the entire available content area.

Navigation keeps rows, expansion, selection and scroll during background refresh.
Load authorized hierarchy metadata ahead of expansion; leaves have neither chevrons nor empty-child rows.
Actions appear on row hover, keyboard focus or an open action menu, with a reachable touch alternative.
The trailing status area retains two independent groups: blocking problem > needs input > draft, and running/starting > unread; empty groups reserve no space.
Collapsed parents combine their own facts with all descendants revealable in the current filtered sidebar section; expanded parents show only their own facts.
Intermediate disclosure does not change ancestor membership; filtered, archived, differently filed and delegation-only children contribute nothing unless that row can reveal them.
Missing authorized membership, draft/read hydration or latest-error evidence remains unknown, with partial coverage exposed accessibly.
Parents alone have a trailing child-count/chevron; children use shallow indentation.
Hover actions truncate titles before controls instead of covering labels or status.

The custom ConversationActivityDock was removed.
The approved original composer shelf groups questions, approvals, shells, agents and plan progress above the input, using existing forms and popovers.
Shelf buttons have no chevrons; labels collapse under measured space pressure while icons and counts remain visible.
Activity data and the dedicated Activity view remain available.

## Reuse rule

Reuse a complete existing component and interaction before assembling primitives.
Extend the owning shared component when a missing state is broadly useful.
Do not add runtime dependencies, replacement icon sets, fonts or page-specific palettes.

Appearance density controls header height and sidebar entry padding through the shared density tokens.

## Executable design contract

`web/src/lib/designContract.ts` owns registered roles, geometry, exceptions and artifact aliases; `themePalette.ts` owns palette values.
The existing palette generator exports the app contract, density tokens and versioned first-party artifact kit; its `--check` mode rejects stale outputs.
Use complete shared components before native adapters, and retain Badge's pill, Tooltip's 7px corners and named legacy shape exceptions.

Content/chrome hover, passive grouping, nested controls, close controls, press and selection have separate shared roles.
Close hover mixes foreground over the row-hover surface so it stays visibly stronger across palettes; press deepens that same neutral surface.
Keep the primary selected strip visible through hover and press.
`--focus-color` follows the selected primary; `--ring` preserves the existing focus geometry and independent invalid/destructive cues.

Use `CloseButton` for close appearance while keeping dismissal, propagation and async guards in the owning feature.
Its default 24px surface centers the 14px glyph inside a separate target of at least 44px on coarse pointers.
Shared coarse header primitives retain 48px height; docked application headers follow the 48px/36px density setting with targets contained in their row.
Dialogs balance their top/right close insets.
Popup composites use the shared inset, item-gap, text-gap and footer-gap roles independently of generic list density.
Composer menus and hints center on the trigger, flip as space permits, and stay inside a 24px viewport gutter at every pane width.
The combined workspace selector retains its screen-centered dialog.
Header and shelf popups measure their outer gap from the owning row edge, matching the visible control's inset on the actual opening side.
Use the shelf's outer paint owner and exclude its negative overlap; retain Radix collision handling, horizontal alignment and standalone popup spacing.

The isolated artifact kit consumes generated aliases and explicit host-provided theme values, with no external CDN or full SPA stylesheet.
Its manifest declares native form semantics and optional tabs, disclosure and tooltip helpers; it does not imply complete React/Radix behavior parity.

## Current answer focus and idle shelf

Question answer rows own one keyboard focus surface, including their native selection input and free-form editor.
The inner editor and selection input have no independent focus ring.
Choice cards and ordinary focus borders use `--workspace-control-active-border`; the distinct keyboard ring remains 3px at the existing half-opacity.
The composer retains its named shadow-only focus exception.

Completed plans and settled resources do not reserve an automatic shelf.
Pending and active plan entries share the unchecked `CheckboxVisual`; active changes only the border to `--workspace-control-active-border` and retains accessible In progress text.
Completed entries stay checked; plan markers remain decorative and read-only.
The existing chat menu can show/hide activity, open the recorded plan, or open Orchestration resources; a new pending question or approval reveals attention again.
Manual hiding preserves pending answer drafts, and remounted chat views return to automatic visibility.

## Implementation guardrails

The latest approved owner decisions above govern every implementation pass.
Before adding or changing a control, inspect existing equivalents and reuse the complete shared component.
Compare typography, colors, sizing, tooltip shape and hover/focus behavior with sibling controls before calling it complete.
Do not introduce local hex colors, bespoke buttons, extra fonts or new dependencies to solve a missing shared state.
Extend the shared owner when behavior is missing; record any necessary departure in the delivery report.

Composer selectors use the same UI typography, normal weight and foreground; effort/thinking may be lighter within a selector.
Preserve existing composer padding, gaps and hit targets; microphone relocation is the only approved reordering in that row.
The workspace trigger uses approved B: computer icon, lighter Host, middle dot, foreground path and chevron on one line; mobile labels remain compact.
Tooltips are arrowless and canonical, and appear only for additional meaning, hidden details or shortcuts.
Consistency applies where a tooltip is useful; do not add one to every control or infer that an accessible label requires a tooltip.
Composer quotes and their move/remove controls have no hover tooltip; keep accessible labels and normal focus/hover styling.
All native scrolling uses the shared slim treatment; preserve specialized transcript and terminal scroll behavior.
Background color changes mark full surface edges without an additional border; equal-colored panes retain necessary separators.
The native bottom gesture area shares the chat surface and has no exterior pane divider.

Each chat owns a remembered layout by default; explicit Open to side or sidebar drag adds it to the current layout.
Appearance → On startup defaults to Continue last session, restoring the saved layout owner on a cold, unqualified home launch.
Explicit links, New chat and navigation during restoration take precedence; an unavailable owner falls back to the landing composer without deleting its saved layout or draft.
Every durable subchat opens adjacent without confirmation and starts with inherited history collapsed behind Show history.
Quote-created drafts keep only the quote and source annotation; explicit Fork retains full-history presentation.
Preserve typed text around inserted quotes and keep internal context serialization outside editable content.
Do not replace another chat's saved arrangement during explicit embedded opening.
Layout miniatures, Inbox consolidation and composer spacing redesign are deferred.

Before delivery, compare integrated desktop/mobile screenshots with these rules and run affected shared-component checks.
Every implementation report includes action/expected-result acceptance steps and names remaining limitations separately.

## Current cycle refinements

- Pin changes persistence only: retain pane geometry, support resizing and interpolate other chat layouts into the free areas.
- Pinned tabs show a filled type icon at rest and a filled pin on hover/focus; active state remains the primary bottom strip.
- Dock resize indicators reuse the sidebar handle's thin paint and hover/active tones while retaining practical hit areas.
- Shared dock and terminal splits allow 20–80% resizing; retain existing saved positions within those bounds.
- Tab insertion uses a vertical primary marker; split preview uses the actual resulting half-pane footprint and shared file-drop surfaces.
- Detection zones stay invisible; context-clicking a tab opens the shared view controls menu.
- Overflowing surfaces reuse the transcript-style overlay scrollbar; content that fits has no track.
- Composer and tab strips show no scrollbars; overflowing tabs scroll behind a right-side fade.
Sidebar navigation, TurnRail and the command-palette list also hide native and overlay bars while preserving scrolling and keyboard focus.
- Sidebar counts represent all unique descendants; guides and expander hover/cursor follow shared tree styles.
- Add host is directly reachable in every workspace picker and reuses the existing server-specific CLI instructions.
- Live workspace-file chips open the normal File Editor; folder references remain inline code.
- Rendered previews and attachments without a live file retain preview/lightbox behavior.
- File opening defaults to reusing a neighboring pane, splitting once when none exists; Appearance also offers Same pane, Always split and Reuse pane.
- Rendered in-chat previews keep their large modal/lightbox behavior and supported zoom/pan/close controls.
- Shared buttons do not move vertically when pressed; modal close glyphs do not get redundant Close tooltips.
- Search trigger and popup center on the full application width independently of adjacent controls.
- On desktop, the primary + Open button sits immediately right of centered Search; mobile Open restores its 28px square face and the same menu.
- Mobile Open expands its transparent hit area into free row space without overlapping neighbors; its width is 32px and height is header height minus 4px.
- Comfortable/Compact use a compact shared segmented selector; file destinations use pane schematics with solid outlines and contained selection marks.
- File Editor headers show one copyable Host/path, Comments, Diff and the shared three-dot menu; the comments conversation selector belongs inside the comments sidebar.
- Notifications and workspace-picker headers and entries follow the same density tokens; read-notification visibility is an explicit saved filter.
- Keep mobile search centered on the app and expand its text within the measured space between controls.
- The tab add control is a subtle shared icon button after the last tab; empty content centers larger muted guidance and a primary Open view button.

## Retained resource behavior

Keep resource identity, drafts, undo, selection and process ownership stable when views hide or move.
Visibility controls presentation work and view-owned observation; it never implies stopping an agent, terminal or pending save.
Shared navigation, search and file-action contexts keep their identity until their meaning changes.
Show a file tab and shared loading feedback while retaining its original, then mount the editable viewer after capture succeeds.
Capture errors use the notification system and an explicit Retry action in that view.

## Agent communication

Agent task, reply, peer and System cards reuse ActivityRow's compact composition and slim accent edge.
Bold the actual agent name and preserve the existing sent to/from annotation and linked chat name.
Keep one title line, one compact excerpt line and vertically centered semantic status and controls.
Controls are Open chat, Workflow/Orchestration, then disclosure; use the same ghost hover and Sidebar right/down chevron states without animation.
Omit timestamp, Copy and Copy link footers and their reserved space from these card types for now; ordinary human and assistant footers stay intact.
Keep one activity card per child agent and update it in place; preserve assignment provenance without separate steering cards.
An absent activity item with canonical identity and position inserts once at that position; later enrichment retains the loaded card's identity instead of reporting a false recovery failure.
Same-epoch recovery point-reads tracked old-card changes before replaying the appended tail; expired or untracked mutations still require an authoritative reset.
Use a short capitalized task summary rather than the raw handoff as the title; steering preserves a valid original summary.
Returned answers use one attributed Markdown reply per dispatch at its chronological arrival, with the same compact card and expansion.
Preserve authoritative adapter finality and exact source references; progress cannot replace a shorter final report.
Do not repeat the task prompt as both title and preview or add an empty completion reply.
A chat button opens the named child beside its parent; Workflow opens the spawning chat's Orchestration and consumes its focus request.
Use Orchestration with the Workflow icon for the view, while retaining internal compatibility identifiers.
Its default list contains separate Agents and Shells sections, including settled work, each ordered by observed activity.
Use the shared All/Agents/Shells control in the header and two-line resource entries with state and supported controls on the right.
Resource entries reuse semantic status pills with an icon and label in a stable trailing column; the whole row opens without a redundant Open action.
Colored status pills fit their icon and text; any width reserved for alignment belongs to the uncolored outer column.
Narrow resource rows keep title details and previews on one ellipsized line and collapse status text to its accessible icon at 440px or less.
Compact message-card headers retain one row, truncate the text column and show compact status icons while preserving reachable controls and accessible status labels.
Open resources in tabs; retain graph in the existing menu, without inspector modals or status-group hierarchies.
Routine capture diagnostics, History coverage and Messages do not appear in Orchestration.
Workspace selection starts from the captured source chat's Host and path; confirmation alone changes its source.
Real errors remain visible; source attribution comes from trusted records, never from a text prefix.

## Mobile, shelves and message origin

Human message styling requires trusted human-submission metadata.
Framework instructions use System wrappers; agent communication retains its attributed wrapper, and unclassified imported input uses External input.
Quoting framework text in a genuine human submission does not change its origin.

Queue and attention shelves share one gapless stack above the composer.
Both entrance and exit take 200ms, moving behind the composer while the hidden slot collapses; reduced motion is immediate.
Background count changes do not replay entrance or reset forms, drafts or transcript position.
Queue gaps and shelf insets use `--list-gap`: 4px Comfortable and 2px Compact, while narrow/coarse shelf controls retain 44px targets.
Queue, attention shelf and composer share constrained width; queued text and attachment summaries stay on one ellipsized line.
Every shelf shares the composer's outer radius and equal horizontal/vertical edge insets.
Derive the inner control radius from that outer radius minus inset and border spacing, clamped at zero.
The composer retains its shadow-only focus cue while adjacent controls use the shared focus treatment.
Sending a selected queued item reserves its admission independently of old-turn idle and network-finally events.

Agent and shell popups reuse the Orchestration two-line resource row, icon tile and natural-width status pill.
The first line names the resource; the second shows its task or latest captured output, with one-line ellipsis.
Keep both supported navigation controls: open the exact resource beside, and focus its originating Orchestration.
For supported live resources, row hover reveals a pale-red Stop pill with a filled square; pill hover uses destructive fill and white foreground.
Touch exposes Stop through the shared menu, without requiring hover.
Native history is read-only captured output unless the runtime explicitly provides an interactive attachment capability.
The agent's primary CLI is an agent resource, never a stoppable auxiliary shell entry.
Captured shell history remains readable when the runtime is offline without launching a runner; availability, ACL and replica-routing failures retain distinct semantics.
Use one shell outcome mapper: Completed for known success, Failed, acknowledged Stopped, Declined, or Ended for confirmed termination with unknown outcome.
Unknown and Disconnected do not imply termination; badges transition colors without delaying status/Stop visibility.

Question popups show only the bold original question, existing answer controls and one action row.
Previous may be an accessible chevron-only control; counted Skip/Next navigate and final Submit sends the batch, while Decline rejects it.
Keep in-chat card attribution and header pagination separate; expanded answered bodies omit the repeated question.
Closing a question popup preserves its answers and pending state.

Stationary touch hold opens existing context menus at 500ms within 10px.
Tabs arm dragging at 300ms, then movement beyond 10px starts the existing dock preview; early movement remains scrolling.
Moving after a held menu begins dragging with the same contact; cancellation and release cannot activate a tab or menu item accidentally.
Native safe-area clearance belongs to one owner, and nested sidebar fills start to the right of their hierarchy guide.

In-chat image cards and images share their aspect ratio and a 256px media-height cap; footers add only their required height.
The lightbox supports midpoint-anchored two-finger pinch zoom from 1× to 8× and bounded pan; lifting either contact continues pan without a jump.
Only a fresh single-contact gesture starting at Fit navigates horizontally or dismisses vertically; zoomed drags and pinch continuations retain pan ownership.
Cancellation, lost capture, resizing and image changes clear stale gestures; selection resets to Fit while desktop wheel zoom and original downloads remain available.
Keep footer controls usable on tiny or very tall images; center the fitted image within the footer's minimum card width.
Allocate footer width naturally to filename and full captured path, wrapping under pressure without fixed half-width limits or a size separator.
Display equations retain horizontal scrolling and enough vertical clearance for complete glyphs without a vertical scrollbar.

## Search results and navigation

Sidebar search and the palette's message/chat results reuse one authorized query and two-line result component, ordered newest first with stable ties.
The header contains ChatName: SenderName and right-aligned date/time; current-chat scope omits ChatName.
The second line is one highlighted excerpt; title hits highlight the chat title and preview its latest message.
Do not insert chat-group headings, harness badges or action results into sidebar message/chat search; preserve dedicated palette commands.

Reuse the existing segmented toggle for All / Final / User with canonical explanatory tooltips.
All searches eligible chat history; Final includes user messages and confirmed final agent replies; User contains user messages only.
Index/render source identity and adapter finality govern filtering and exact occurrence navigation.

Search selection and Previous/Next load and reveal the owning containers, wait for measured layout and align the exact match under cancellable scroll ownership.
Closed or unmounted content is pending reveal, not unavailable.
Manual scrolling cancels pending alignment; background updates never focus or scroll.
Keep the compact query/count/navigation/close bar without the redundant In this chat label.

Runtime notices reuse the composer shelf and its existing compact popover.
Show trusted provider information with supported actions, Open Agent CLI and UI-only Dismiss; notifications never fabricate a question response or spend credits.
Framework completion/blocked/resolved wake instructions retain System origin through dispatch, echo and reload rather than ordinary human submission.
