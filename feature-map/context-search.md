# Contextual search

Find in a file, folder or conversation follows the last clicked or focused region, while integrated conversation search shares its query and selected occurrence between the left sidebar and compact chat bar.

## Sub-features

- `routing`: Ctrl/Cmd+F opens file find, folder content search or chat search according to the last interaction; hover alone does not change ownership.
- `scopes`: Current chat and All chats share authorized message snippets and chat-title results; commands retain their dedicated palette path.
- `controls`: scope and All/Final/User reuse the existing segmented controls and canonical explanatory tooltips.
- `navigation`: selecting a result reveals its exact message and occurrence, including older unloaded history, collapsed narration/prompts and exact original-source fallback.
- `synchronization`: the compact bar, sidebar selection, occurrence counter and stronger active highlight stay synchronized.
- `preservation`: typing in All chats leaves the active conversation unchanged; navigation preserves drafts and file-change guards.
- `sidebar`: opening Search temporarily reveals collapsed navigation, closing restores its previous visibility, and manually collapsing it leaves the bar usable.
- `bounded-service`: authorized message-level results use cancellation, bounded source windows and pagination, with loading, empty and actionable retry states; closed or unmounted content is revealed rather than marked unavailable.
- `results`: sidebar and palette share newest-first rows, ChatName: SenderName and date/time, one highlighted excerpt, and no harness badges or intervening chat headings.
- `message-types`: All searches message history; Final includes human inputs and confirmed final agent replies; User includes human inputs only.
- `mobile`: Search reuses navigation; selecting a result dismisses the drawer while retaining the compact bar.

## How to get to it (user POV)

- Click chat text or its composer and press Ctrl/Cmd+F to search Current chat.
- Use Search in the left sidebar or Ctrl/Cmd+F after interacting with navigation to search All chats; Ctrl/Cmd+K opens the global search and command palette.
- Click the query summary in the compact bar to reopen or focus the sidebar query without resetting the scope.
- Click a message result, or use Enter in Current chat and Previous/Next in the bar, to reveal an occurrence.
- Click the Explorer and press Ctrl/Cmd+F to open folder content search; interact with a file preview and use the same shortcut for file find.
- Press Escape with focus inside Search, or use either Close control, to restore navigation.

## Driving it with the repro environment

Preconditions: read the [verification skill](skills/verify-omnigent/SKILL.md), build this checkout and use an isolated server and host.

- Desktop and phone history loading, Unicode offsets, repeated occurrences, draft retention, explicit cross-chat navigation and sidebar restoration: `tests/e2e_ui/chat/test_context_search.py::test_context_search_navigates_exact_history_and_preserves_views`.
- File, Explorer and non-focusable chat-text shortcut routing: `tests/e2e_ui/chat/test_context_search.py::test_context_find_routes_file_explorer_and_plain_chat_text`.
- Platform modifiers, specialized input ownership, unsupported-file browser fallback and consumed/composing events: `web/src/hooks/useContextualFindHotkey.test.tsx`.
- Cancellation, scope/query changes, guarded navigation, pagination and stable All-chat results: `web/src/hooks/useContextSearchController.test.tsx`.
- Literal Unicode, repeated Markdown/code matches, bounded windows, virtual history, collapsed prompts and manual-scroll preservation: `web/src/lib/chatSearchHighlights.test.tsx` and `web/src/hooks/useChatSearchHighlights.test.tsx`.
- Authorized pagination, cursor binding, source offsets and result bounds: `tests/stores/test_message_search.py` and `tests/server/routes/test_sessions_shared_projects.py`.
- Built-app folded/final/source reveal, stable measured alignment, virtual remount and manual cancellation: `tests/browser_ui/chat/test_search_navigation.py`.
- Sidebar/palette result parity, title previews, type filters, tooltips and retained commands: `tests/browser_ui/chat/test_search_results.py`.
- Session-switcher shortcut compatibility: `web/src/shell/AppShell.test.tsx` and `web/src/shell/CommandPalette.test.tsx`.

## Gotchas

- File find, folder content search and chat search have separate queries; terminal and specialized editor shortcuts retain their owners.
- Ctrl/Cmd+Alt+S retains the sessions-only switcher; Ctrl/Cmd+K opens global search and commands in the unified workspace.
- Counters with a plus indicate a bounded source window or another result page, rather than an exact total.
- Results retain stored item/source identity; closed owners open before exact alignment.
- Source-only Markdown literals reveal the exact original text; never highlight a different repeated occurrence by guessing.
- Search scroll intent yields to manual input and suppresses competing deep-link navigation; background updates only repaint.
- Legacy unknown origin/finality remains searchable through All; missing phase is not promoted to a final reply.
- Current-chat rows omit the chat prefix; title hits open their chat without inventing a transcript occurrence.
- Search snippets render text only and do not load attachments, images or arbitrary HTML.
- Streaming and refreshed results update highlights without repeatedly moving the viewport; closing Search keeps the found location.
- Browser verification with seeded messages proves application integration, not live provider inference or physical native-wrapper behavior.
