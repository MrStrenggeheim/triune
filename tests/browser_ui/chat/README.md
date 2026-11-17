# Browser chat contract

`chat_session_contract` renders the real built SPA at `handle.url` without an
Omnigent server, runner, database, or model. It sits on the strict
`browser_contract` guard, so any undeclared API, SSE, or WebSocket dependency
fails the test.

```python
def test_chat(page, chat_session_contract):
    chat = chat_session_contract
    chat.seed_transcript(40)  # 40 user/assistant turns with Markdown + code
    chat.set_catalog(
        harness="claude",
        models=[model_option("sonnet", is_default=True)],
        selected_model="sonnet",
    )
    page.goto(chat.url)
    chat.wait_for_stream()
    chat.emit_busy("turn-1")
    chat.emit_idle("turn-1")
```

The mutable handle exposes `session_id`, `url`, `event_posts`,
`upload_requests`, `skills`, `skill_requests`, and `session_patches`. Use
`set_items(...)` before navigation to replace history with arbitrary wire items,
or `seed_transcript(...)` to generate Markdown/code turns. Use
`update_session(...)` before or after navigation to override session wire fields,
including setting `host_id=None` and `workspace=None`. Use `set_health(...)` to
override per-session liveness fields such as `runner_online`.

Use `set_skills(...)` to replace the session's `/v1/skills` response. To exercise
loading UI, call `release = hold_skills()` before navigation, then call
`release()` after the request appears in `skill_requests`. Session PATCH bodies
are recorded in `session_patches`, merged into the mocked session, and reflected
by the PATCH response and later session GETs.

Event POSTs default to a queued acknowledgement, keeping the local turn busy so
another composer submission enters the client queue. Set `event_ack` to change
that response. Uploads are recorded and rejected by default; set
`reject_uploads = False` when a test intentionally exercises the successful
upload path. Binary upload records include `body_bytes`, `body_length`, and
`content_type`; successful uploads return the same file-resource shape as the
server.

Use the builders in `session_contract.py` for canonical list, transcript,
model-option, and `session.status` payloads. `emit()` accepts their named SSE
wire shape and can drive arbitrary scripted stream events after navigation.
The stream queues events emitted before its first connection once and never
replays prior events on reconnect, matching the server. Call `wait_for_stream()`
after navigation before emitting status or transcript events.

## Choosing coverage

Use this lane for DOM geometry, local drafts, picker labels/payloads, and UI
responses to scripted API or stream events. Keep viewport, font, theme, input,
and entry-point variants when consolidating; share a journey only when its
steps belong to the same workflow and leave a known state for the next step.

Keep server persistence, permissions, real uploads, dispatch, and native harness
lifecycle in E2E. A mocked status event proves browser rendering, not server
persistence: `tests/e2e_ui/chat/test_working_indicator_background_tasks.py` keeps
reload/reconnect coverage. Likewise, composer attachment checks complement the
real upload/ingestion tests in `tests/e2e/test_files_upload_e2e.py` and
`tests/e2e/test_image_upload_e2e.py`.


## Frozen reliability acceptance

Run these cases against one frozen built SPA and retain its assets throughout the journeys.
The browser-contract cases replace backend dependencies and do not prove native permissions or production latency.

| Boundary | Maintained case |
| --- | --- |
| Canonical ordering, desktop/phone older-window restore and retained cursors | `test_transcript_multiplex.py` |
| Fifty-layout retirement, exact reader restore, drafts and editor Undo | `test_triune_next_iteration.py::test_fifty_layouts_retire_while_preserving_draft_and_editor_undo` |
| Inbox insertion/refresh, draft/focus/selection and reading offset | `../test_inbox_reader.py` (desktop/phone, light/dark) |
| Native future-permission picker and observed label reload | `tests/e2e_ui/chat/test_codex_approval_mode_picker.py` |

From the repository root after building once:

```sh
.venv/bin/python -m pytest -p no:rerunfailures --browser-ui-skip-build tests/browser_ui/chat/test_transcript_multiplex.py 'tests/browser_ui/chat/test_triune_next_iteration.py::test_fifty_layouts_retire_while_preserving_draft_and_editor_undo' tests/browser_ui/test_inbox_reader.py
.venv/bin/python -m pytest --ui-skip-build --reruns 0 tests/e2e_ui/chat/test_codex_approval_mode_picker.py
```

For disclosure promotion, manually expand a provisional tool, group and Worked section, then allow canonical history and reopen the reader.
Each choice must survive promotion and reopening; another response reusing the same call ID must remain independent.
Permission browser mocks complement the native/server contract tests; they do not establish full host/server restart recovery.
