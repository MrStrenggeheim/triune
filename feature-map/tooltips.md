# Button tooltips

Buttons across chat, composers, workspaces and settings share one tooltip style and accessible hover/focus guidance.

## Sub-features

- `surface`: one white panel with subtle border/shadow; standalone controls retain an 8px gap, while header/shelf controls match the outer row-edge gap to the visible control inset.
- `content`: a short action label followed by its shortcut when available; complicated controls can include a brief description.
- `single`: an explicitly configured tooltip takes precedence over automatic button guidance, with no duplicate native title popup.
- `menus`: guidance stays closed while its menu is open and during the return-focus handoff.
- `keyboard`: focus reveals the same guidance without changing button, menu or selection behavior.
- `disabled`: existing disabled-action explanations remain available with accessible labels.
- `disclosures`: expandable controls share Expand/Collapse guidance without overriding their actual open state.

## How to get to it (user POV)

- Hover or keyboard-focus an action in the existing/new-chat composer, chat header, Explorer, file preview or Settings.
- Hover the model and machine selectors, open their menus, close them and move back to inspect the guidance.
- Hover a control with a keyboard shortcut, such as content search or a queued-message action.
- Hover an unavailable action to read its reason.

## Driving it with the repro environment

Preconditions: use the [verification skill](skills/verify-omnigent/SKILL.md); browser-contract journeys below use a built SPA and their own explicitly mocked APIs.

- Existing/new-chat model hover, menu suppression and host guidance: `tests/browser_ui/chat/test_composer_tooltips.py`.
- Standalone white tooltip surface, centered placement and 8px gap in light/dark: `tests/browser_ui/chat/test_composer_tooltips.py::test_button_tooltips_share_white_surface_and_centered_gap`.
- Shared primitive, shortcuts, native-title deduplication and keyboard behavior: `web/src/components/ui/tooltip.test.tsx`.
- Header/shelf actual-side geometry, resize and collision behavior: `web/src/components/ui/anchored-popup.test.tsx`; iteration6 candidate popup journey: `tests/browser_ui/chat/test_iteration6.py::test_queue_plan_popup_and_synthetic_safe_top_follow_density`.
- Disabled explanations: `web/src/components/DisabledActionTooltip.test.tsx`.
- Real Explorer hover/focus without row movement: `tests/e2e_ui/files/test_workbench_ownership.py::test_explorer_size_and_menu_share_space_on_hover_and_focus`.
- File-reference guidance and retained preview/download: `tests/e2e_ui/files/test_chat_attachments.py::test_inline_file_reference_keeps_filename_and_original_preview`.

## Gotchas

- Rich interactive panels, such as the chat information panel, remain interactive content rather than being replaced by a read-only tooltip.
- Shortcut text must describe an actual supported shortcut; unavailable shortcuts are omitted.
- Touch retains explicit button/menu actions; hovering is not required to use a feature.
- Keep visible labels, accessible names and disabled reasons meaningful after native-title removal.
- Viewport collision handling can flip above/below or adjust a panel near the screen edge.
- Row-anchored geometry follows the mounted popup's actual side; standalone tooltips and side submenus retain their own spacing.
