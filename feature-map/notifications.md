# Notifications

Notifications combine brief popups, retained history, required prompts and file-transfer activity behind the Notifications bell, so users can revisit messages and finish actions after the popup collapses without interrupting their current session or file view.

## Sub-features

- `popups`: show at most three ordinary popups plus all required prompts; ordinary messages, success and information default to 10 seconds, warnings to 12 seconds and errors to 15 seconds.
- `history`: retain up to 100 settled entries during the current app run, with active transfers, loading operations, pending actions and required prompts protected from eviction and clearing.
- `unread`: show an unread count and an activity indicator on the bell; opening the center marks existing entries seen and new arrivals remain seen while it is open.
- `groups`: show required prompts under Needs attention, active work under In progress and settled messages in recent history, with an empty state when no entries remain.
- `collapse`: hide a popup without deleting its history or valid actions; opening the center replaces the popup stack, and closing it leaves ordinary messages in history.
- `actions`: disable duplicate activation while an action runs, retire completed one-shot actions, preserve newer operation updates and show callback failures with retry available.
- `progress`: show upload and ZIP-download progress, preparation, cancellation, completion and errors; chunk updates do not extend the initial popup countdown, and settled transfers reveal a new completion or error popup.
- `archive-recovery`: preserve project Undo in history; session archive offers brief Undo followed by Restore in history, with View archived available for navigation.
- `clear`: remove individual settled entries or clear completed notifications without discarding active operations or required prompts.
- `required-prompts`: keep prompts such as terminal clipboard consent available until their owning flow resolves or removes them.
- `layout`: use the same card presentation and width for popups and history, adapt to the active layout and expose only one open center when several headers have bells.
- `geometry`: popup/history cards use symmetric density-derived insets, centered icon/close surfaces and one timestamp/action grid; coarse-pointer actions retain 44px targets.
- `close`: card and center reuse the shared CloseButton, preserving hide/remove semantics and independent focus/hover feedback.
- `shared-notices`: Explorer failures, connection results, harness setup results, stream-capacity warnings, sandbox attention, certificate refresh and desktop updates use the shared notification store and cards.
- `scope-lifetime`: chat/host notices retain history when their view closes, with obsolete controls and active progress retired; hiding a popup while its scope remains active preserves valid actions.

## How to get to it (user POV)

- Conversation header, desktop web: open a session and click Notifications beside the other header actions; the shared header also exposes the bell on the new-session page.
- Conversation header, mobile web: open a session and tap Notifications in its header; close the sidebar first if it covers the conversation.
- Mobile full-screen file viewer: open a file from Files, Changes or a file link, then tap Notifications in the viewer's header without returning to chat.
- Files or Changes drawer: open Workspace → Files or Changes and tap Notifications in the drawer header; the desktop Files/Changes push panel also exposes this bell.
- Popup stack: trigger an operation such as copying a path, archiving a project or session, unpinning a session, or uploading files; use its action or Hide notification directly.
- Retained activity and recovery: open any available bell, use a transfer's Cancel upload or Cancel download, use project Undo or session Restore, or choose View archived.
- History controls: use Remove notification on a settled card, Clear completed notifications in the center header, or Close notifications; required prompts retain their own decision controls.

## Driving it with the repro environment

Preconditions: follow the [verification skill](skills/verify-omnigent/SKILL.md), use an isolated session with an online writable runner or host for transfers, and create only temporary files, projects and sessions for recovery checks.

The entries below map current scenarios to user surfaces; a test's presence is coverage to run, not evidence that its latest revision passed.

| Entry point                                                      | Test or manual drive                                                                                                                                                                               | Observable result                                                                                                                                                                                                            |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop conversation header and project popup                    | `tests/e2e_ui/sessions/test_sidebar_project_context_menu.py::test_project_notification_collapses_to_history_and_keeps_undo[chromium-desktop]`                                                      | Archive a temporary project, let its popup collapse, open Notifications and use Undo; the project is restored and its API record is no longer archived.                                                                      |
| Mobile conversation header and project popup                     | The same project scenario with `[chromium-phone-dark]`.                                                                                                                                            | Close the sidebar, open the bell and restore from history in a phone-width dark browser; popup and center fit the viewport and use the same width.                                                                           |
| Desktop transfer popup and header history                        | `tests/e2e_ui/files/test_explorer_file_operations.py::test_upload_continues_while_viewing_another_file`, variants `[chromium-continue]`, `[chromium-cancel]` and `[chromium-cancel-from-center]`.  | Start a held upload, open another file, then complete it or cancel from the popup/history; downloaded bytes match on completion and the unfinished destination is absent after cancellation.                                 |
| Mobile Files drawer and full-screen file viewer                  | The upload-navigation scenario with `[chromium-phone-center]`.                                                                                                                                     | Open the drawer bell while uploading, close the center, open another file, reopen the center from the full-screen viewer and cancel; both bells reach the same activity and cancellation removes the unfinished destination. |
| Desktop Files/Changes push panel and mobile Changes drawer       | Manual: start a transfer from Files, open each panel's bell, then switch between Files and Changes and reopen Notifications.                                                                       | The same activity remains available and only one center opens; the phone-center scenario exercises the Files drawer, not the separate Changes route or desktop push-panel bell.                                              |
| New-session header                                               | Manual: create a notice in a session, navigate to New session without reloading, and open Notifications.                                                                                           | Existing history remains accessible without selecting a conversation.                                                                                                                                                        |
| Session archive from row, bulk selection or header menu          | Use the entry-point recipes in [Sessions](sessions.md); `web/src/shell/archiveUndoToast.test.tsx` covers the brief Undo deadline and later Restore.                                                | Undo restores the archived batch during its brief window; after collapse, history offers Restore for that captured batch without promising its former runner is still alive.                                                 |
| Unpin popup and retained Undo                                    | `tests/e2e_ui/sessions/test_sidebar_pin_unpin.py::test_undo_unpin_restores_pinned_slot` covers immediate popup Undo; `web/src/shell/unpinUndoToast.test.tsx` covers the adapter.                   | Undo returns the session to its previous Pinned position; manually repeat from notification history to check the retained action.                                                                                            |
| Shared popup/history controls and multiple bells                 | `web/src/components/ui/toast.test.tsx` covers hide/history, retained actions, hover pause, required prompts, the visible-popup limit, shared width, clearing and one open center across two bells. | Hiding keeps history, clearing preserves active work, and opening either bell yields one center; these component checks do not prove every header's browser route.                                                           |
| Explorer error retention beside Files and open previews          | `tests/e2e_ui/files/test_explorer_file_operations.py::test_explorer_drop_into_collapsed_and_expanded_folders`                                                                                      | A rejected move collapses from its popup and remains in bell history.                                                                                                                                                        |
| View-owned warning lifecycle                                     | `web/src/hooks/useNotificationNotice.test.tsx`, `web/src/components/DbcertBanner.test.tsx`, `web/src/pages/ChatIndicators.test.tsx`                                                                | StrictMode preserves notices, progress does not restart expiry, and scope changes retire stale actions.                                                                                                                      |
| Required terminal clipboard prompt and asynchronous copy failure | `web/src/components/blocks/TerminalView.test.tsx` and `web/src/components/ArcaShutdownToast.test.tsx`; manually trigger consent and a denied clipboard copy in a supported browser.                | The required decision remains reachable; an unsuccessful copy does not remove the notice that lets the user retry.                                                                                                           |

Model coverage in `web/src/lib/notifications.test.ts` verifies expiry, overlapping pointer/focus pauses, retained actions, failed async actions, progress updates without renewed expiry, completion during cancellation, required-prompt retention, history limits and callbacks that keep their own popup open.
For visual acceptance, archive a temporary named chat and compare popup/history in Comfortable and Compact, light and dark, and a coarse-pointer viewport.
Expect balanced icon/title/dismiss alignment, equal outer insets, readable time/actions without overlap, and visible close focus/hover.
These geometry checks belong in the parent's candidate-browser pass; component tests alone do not establish painted spacing.
Transfer component coverage in `web/src/shell/ExplorerActions.test.tsx` verifies staging cleanup and the Cancelling and cleaning up… state; a completion already revealed by an operation must survive its cancellation callback returning.
Run component and model tests with `cd web && pnpm exec vitest run src/lib/notifications.test.ts src/components/ui/toast.test.tsx src/shell/ExplorerActions.test.tsx src/shell/archiveUndoToast.test.tsx src/shell/unpinUndoToast.test.tsx src/components/ArcaShutdownToast.test.tsx src/components/blocks/TerminalView.test.tsx`.
Run the named browser scenarios through the verification environment with recording enabled and `--ui-skip-build` after the matching candidate bundle is built; use the scenario variants above to distinguish the two mobile overlay routes from the conversation header.

Recorded evidence inspected on 2026-11-07 is under `/home/agent/apps/omnigent/evidence/explorer-workspace-final/20261107T161717Z/`: its log reports seven passing cases covering desktop and phone-dark project popup/history Undo, all four upload-navigation variants and Explorer file operations.
The phone-center variant has a recording plus Files drawer and full-screen viewer activity screenshots, covering both mobile overlay bells and cancellation from the shared history; the earlier passing three-case run remains under `/home/agent/apps/omnigent/evidence/explorer-workspace-final/20261107T161425Z/`.
No physical iOS, Android or Electron wrapper verification is established by these component tests or Chromium captures.

## Gotchas

- Notification history lives in memory for the current app run; it survives in-app navigation, not a browser reload, and is not a synchronized notification inbox.
- Form validation, loading/empty states and recorded transcript errors remain with their owning content; they are not separate floating notification systems.
- The desktop updater's native overlay is a separate renderer that uses the shared notification card; its history is not synchronized with the main app renderer.
- Browser or operating-system notifications about idle agents and the session unread dot are separate features from the in-app Notifications bell.
- Loading notices, required prompts and notices explicitly configured to stay open do not use the ordinary expiry; unpin and session archive have shorter action-specific durations.
- Hovering or focusing an ordinary popup pauses its countdown, but session archive's live Undo has an absolute five-second cap and then becomes Restore even while hovered.
- Project Undo, session archive Undo/Restore and unpin Undo have different semantics; later Restore returns archived rows without guaranteeing that their original runners or worktrees still exist.
- Hiding a transfer or closing the center does not cancel it; cancellation is explicit and keeps files that already completed while removing the unfinished upload's staging data.
- Closing the center collapses ordinary popups into history; required prompts remain available, and custom prompts can contain their own controls rather than the standard card buttons.
- Some extensions own their header and omit the standard conversation header; desktop terminal push panels can also cover that header, so verify the actual route instead of assuming a bell is always visible.
- Opening a file can replace the mobile Files drawer with a full-screen viewer; prove the bell in each surface, and check that switching surfaces does not create duplicate centers.
- Light/dark screenshots and a phone-width Chromium viewport do not establish physical-device keyboard, clipboard permission, safe-area or native-wrapper behavior.
