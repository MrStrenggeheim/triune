# Triune workspace design system

A compact developer workspace built from Triune's existing components.
The approved workspace specification governs behavior; later owner corrections govern appearance.

## Basis

- Audited upstream `v0.20.0`: semantic theme tokens, Radix controls, compact navigation, shared tooltips and typography.
- Approved specification: docked views, explicit ownership, violet defaults, 48px headers, density and mobile accessibility.
- UI/UX Pro Max: semantic surfaces, state clarity, stable geometry, restrained feedback, shared icons and visible keyboard focus.
- Generated landing-page patterns, replacement fonts and suggested palettes do not fit this application and are excluded.

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
Narrow composer workspace controls collapse to an icon and chevron while retaining their accessible full location.
The shell owns the device bottom safe area once; the mobile composer adds only an 8px content gutter.
Remove pane docking menus and the app-bar Layout control; pin belongs immediately before each tab close control.
Keep the chat content action menu as three dots; place the existing Chat/Terminal switch immediately before it.
Keep conversation breadcrumbs in the view header.
Center empty guidance within the entire available content area.

Navigation keeps rows, expansion, selection and scroll during background refresh.
Load authorized hierarchy metadata ahead of expansion; leaves have neither chevrons nor empty-child rows.
Actions appear on row hover, keyboard focus or an open action menu, with a reachable touch alternative.
Running, approval, draft and unread indicators coexist in the trailing row group.
Parents alone have a trailing child-count/chevron; children use shallow indentation.
Hover actions truncate titles before controls instead of covering labels or status.

The composer activity dock is disabled until the owner requests another design.
Activity data and the dedicated Activity view remain available.

## Reuse rule

Reuse a complete existing component and interaction before assembling primitives.
Extend the owning shared component when a missing state is broadly useful.
Do not add runtime dependencies, replacement icon sets, fonts or page-specific palettes.

Appearance density controls header height and sidebar entry padding through the shared density tokens.

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
All native scrolling uses the shared slim treatment; preserve specialized transcript and terminal scroll behavior.
Background color changes mark full surface edges without an additional border; equal-colored panes retain necessary separators.
The native bottom gesture area shares the chat surface and has no exterior pane divider.

Each chat owns a remembered layout by default; explicit Open to side or sidebar drag adds it to the current layout.
Do not replace another chat's saved arrangement during explicit embedded opening.
Layout miniatures, Inbox consolidation and composer spacing redesign are deferred.

Before delivery, compare integrated desktop/mobile screenshots with these rules and run affected shared-component checks.
Every implementation report includes action/expected-result acceptance steps and names remaining limitations separately.

## Current cycle refinements

- Pin changes persistence only: retain pane geometry, support resizing and interpolate other chat layouts into the free areas.
- Pinned tabs show a filled primary pin permanently; active state remains the primary bottom strip.
- Dock resize indicators reuse the sidebar handle's thin paint and hover/active tones while retaining practical hit areas.
- Tab insertion uses a vertical primary marker; split preview uses the actual resulting half-pane footprint and shared file-drop surfaces.
- Detection zones stay invisible; context-clicking a tab opens the shared view controls menu.
- Overflowing surfaces reuse the transcript-style overlay scrollbar; content that fits has no track.
- Composer and tab strips show no scrollbars; overflowing tabs scroll behind a right-side fade.
- Sidebar counts represent all unique descendants; guides and expander hover/cursor follow shared tree styles.
- Add host is directly reachable in every workspace picker and reuses the existing server-specific CLI instructions.
- Inline chip clicks open beside the originating chat; context menus expose other valid destinations and file actions.
- Rendered in-chat previews keep their large modal/lightbox behavior and supported zoom/pan/close controls.
- Shared buttons do not move vertically when pressed; modal close glyphs do not get redundant Close tooltips.
- Search trigger and popup center on the full application width independently of adjacent controls.
- Comfortable/Compact use the existing visual preference-card pattern, illustrating 48px and 36px header/list density.
