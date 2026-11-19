# Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""Queue 31 browser regressions against the compiled production workspace."""

from __future__ import annotations

import json
from pathlib import Path
from urllib.parse import urlparse

import pytest
from playwright.sync_api import Locator, Page, Route, expect

from tests.browser_ui.chat.session_contract import message_item
from tests.browser_ui.chat.test_unified_workspace import WorkspaceJourney, _view
from tests.browser_ui.chat.test_unified_workspace import browser_errors as browser_errors
from tests.browser_ui.chat.test_unified_workspace import workspace_journey as workspace_journey


@pytest.fixture(
    params=[
        (1440, 1000, False),
        pytest.param(
            (390, 844, True),
            marks=pytest.mark.browser_context_args(has_touch=True, is_mobile=True),
        ),
    ],
    ids=["desktop", "touch"],
)
def surface(page: Page, request: pytest.FixtureRequest) -> tuple[int, int, bool]:
    width, height, touch = request.param
    page.set_viewport_size({"width": width, "height": height})
    return width, height, touch


def _artifact_html() -> bytes:
    rows = "".join(f'<p data-row="{index}">Artifact row {index}</p>' for index in range(1, 81))
    return f"""<!doctype html><html><body><main class="ta-root">
<button id="frame-outside">Frame outside target</button>
{rows}
<button id="artifact-tail">Artifact final row</button>
</main></body></html>""".encode()


def _seed_artifact(journey: WorkspaceJourney, *, file_id: str = "queue31-artifact") -> str:
    chat = journey.chats[0]
    title = "Queue 31 nested artifact"
    html = _artifact_html()
    base = f"/v1/sessions/{chat.session_id}/resources/files/{file_id}"
    chat.contract.json(
        base,
        {
            "id": file_id,
            "name": "queue31-artifact.html",
            "metadata": {"bytes": len(html), "content_type": "text/html"},
        },
    )
    chat.contract.route(
        chat.contract._matcher(f"{base}/content"),
        lambda route: route.fulfill(content_type="text/html;charset=utf-8", body=html),
    )
    fence = "```triune-artifact\n" + json.dumps({"file_id": file_id, "title": title}) + "\n```"
    chat.set_items(
        [
            message_item(
                "queue31-artifact-item", "assistant", fence, response_id="artifact-response"
            )
        ]
    )
    return title


def _open_palette(page: Page) -> Locator:
    page.get_by_role("button", name="Search or run a command", exact=True).click()
    palette = page.locator("[data-command-palette]")
    expect(palette).to_be_visible()
    expect(page.get_by_test_id("command-palette-input")).to_be_focused()
    return palette


def _close_animation(palette: Locator) -> dict[str, object]:
    return palette.evaluate(
        """element => {
          const animation = element.getAnimations().find(item =>
            item.effect?.getKeyframes().some(frame => frame.scale !== undefined));
          if (!animation) return {missing: true};
          animation.pause();
          const frames = animation.effect.getKeyframes().map(frame => ({
            offset: frame.offset, opacity: frame.opacity, scale: frame.scale
          }));
          return {playState: animation.playState, frames};
        }"""
    )


def _tap_point(page: Page, locator: Locator, touch: bool) -> None:
    bounds = locator.bounding_box()
    assert bounds is not None
    x = bounds["x"] + bounds["width"] / 2
    y = bounds["y"] + bounds["height"] / 2
    if touch:
        page.touchscreen.tap(x, y)
    else:
        page.mouse.click(x, y)


def _activate_file_action(viewer: Locator, label: str) -> None:
    direct = viewer.get_by_role("button", name=label, exact=True)
    if direct.is_visible():
        direct.click()
        return
    viewer.get_by_role("button", name="More actions", exact=True).click()
    viewer.page.get_by_role("menuitem", name=label, exact=True).click()


def test_inline_artifact_owns_its_only_vertical_scrollbar(
    page: Page,
    workspace_journey: WorkspaceJourney,
    browser_errors: list[str],
    surface: tuple[int, int, bool],
    output_path: str,
) -> None:
    """The capped host stays fixed while the deepest production frame reaches its tail."""
    width, _, _ = surface
    title = _seed_artifact(workspace_journey)
    page.goto(workspace_journey.chats[0].url)
    artifact = _view(page, "Chat A").locator("[data-inline-preview]").filter(has_text=title)
    outer = artifact.get_by_title(title, exact=True)
    inner = outer.content_frame.frame_locator("iframe")
    tail = inner.get_by_role("button", name="Artifact final row", exact=True)
    expect(tail).to_be_attached()

    host_region = artifact.get_by_role("region", name=f"{title} preview", exact=True)
    host_before = host_region.evaluate("node => node.scrollTop")
    tail.scroll_into_view_if_needed()
    expect(tail).to_be_visible()
    outer_handle = outer.element_handle()
    assert outer_handle is not None
    outer_frame = outer_handle.content_frame()
    assert outer_frame is not None
    inner_frame = outer_frame.child_frames[0]
    geometry = {
        "viewportWidth": width,
        "host": host_region.evaluate(
            """node => ({scrollTop: node.scrollTop, clientHeight: node.clientHeight,
              scrollHeight: node.scrollHeight, overflowY: getComputedStyle(node).overflowY})"""
        ),
        "outer": outer_frame.evaluate(
            """() => ({bodyOverflow: getComputedStyle(document.body).overflow,
              scrollY, clientHeight: document.documentElement.clientHeight,
              scrollHeight: document.documentElement.scrollHeight})"""
        ),
        "inner": inner_frame.evaluate(
            """() => ({scrollY, clientHeight: document.documentElement.clientHeight,
              scrollHeight: document.documentElement.scrollHeight,
              tailBottom:
                document.querySelector('#artifact-tail').getBoundingClientRect().bottom})"""
        ),
    }
    assert geometry["host"]["overflowY"] == "hidden", geometry
    assert geometry["host"]["scrollTop"] == host_before == 0, geometry
    assert geometry["outer"]["bodyOverflow"] == "hidden", geometry
    assert geometry["outer"]["scrollY"] == 0, geometry
    assert geometry["inner"]["scrollHeight"] > geometry["inner"]["clientHeight"], geometry
    assert geometry["inner"]["scrollY"] > 0, geometry
    assert geometry["inner"]["tailBottom"] <= geometry["inner"]["clientHeight"] + 1, geometry
    Path(output_path).mkdir(parents=True, exist_ok=True)
    Path(output_path, "artifact-scroll-geometry.json").write_text(
        json.dumps(geometry, indent=2) + "\n"
    )
    assert browser_errors == []


def test_palette_exit_reverses_without_growth_and_close_paths_converge(
    page: Page,
    workspace_journey: WorkspaceJourney,
    browser_errors: list[str],
    surface: tuple[int, int, bool],
    output_path: str,
) -> None:
    """Escape and ordinary outside input use the same shrinking terminal state."""
    _, height, touch = surface
    chat = workspace_journey.chats[0]
    chat.contract.json(
        f"/v1/sessions/{chat.session_id}/resources/environments/default/search",
        {"data": [], "truncated": False},
    )
    page.goto(workspace_journey.chats[0].url)
    page.add_style_tag(
        content="[data-command-palette][data-state] { animation-duration: 2s !important; }"
    )
    palette = _open_palette(page)
    page.get_by_test_id("command-palette-input").fill("retained until close")
    page.get_by_test_id("command-palette-input").click()
    expect(palette).to_be_visible()
    page.keyboard.press("Escape")
    expect(palette).to_have_attribute("data-state", "closed")
    escape_motion = _close_animation(palette)
    assert not escape_motion.get("missing"), escape_motion
    escape_scales = [float(frame["scale"]) for frame in escape_motion["frames"]]
    assert escape_scales[0] == pytest.approx(1), escape_motion
    assert escape_scales[-1] == pytest.approx(0.95), escape_motion
    assert max(escape_scales) <= 1, escape_motion
    palette.evaluate("node => node.getAnimations().forEach(animation => animation.finish())")
    expect(palette).to_have_count(0)

    palette = _open_palette(page)
    outside = page.locator("[data-palette-dismiss-layer]")
    expect(outside).to_be_visible()
    if touch:
        page.touchscreen.tap(4, height - 4)
    else:
        page.mouse.click(4, height - 4)
    expect(palette).to_have_attribute("data-state", "closed")
    outside_motion = _close_animation(palette)
    outside_scales = [float(frame["scale"]) for frame in outside_motion["frames"]]
    assert outside_scales == escape_scales, (escape_motion, outside_motion)
    palette.evaluate("node => node.getAnimations().forEach(animation => animation.finish())")
    expect(palette).to_have_count(0)
    Path(output_path).mkdir(parents=True, exist_ok=True)
    Path(output_path, "palette-close-motion.json").write_text(
        json.dumps({"escape": escape_motion, "outside": outside_motion}, indent=2) + "\n"
    )
    assert browser_errors == []


def test_palette_first_outside_input_covers_the_real_nested_artifact_frame(
    page: Page,
    workspace_journey: WorkspaceJourney,
    browser_errors: list[str],
    surface: tuple[int, int, bool],
) -> None:
    """A coordinate inside the deepest frame dismisses on the first mouse click or tap."""
    _, _, touch = surface
    if touch:
        # A phone-width palette covers the frame; a touch tablet leaves an outside region.
        page.set_viewport_size({"width": 1024, "height": 768})
    title = _seed_artifact(workspace_journey, file_id="queue31-palette-artifact")
    page.goto(workspace_journey.chats[0].url)
    artifact = _view(page, "Chat A").locator("[data-inline-preview]").filter(has_text=title)
    deepest = artifact.get_by_title(title, exact=True).content_frame.locator("iframe")
    expect(
        deepest.content_frame.get_by_role("button", name="Frame outside target", exact=True)
    ).to_be_visible()
    palette = _open_palette(page)
    palette_box, frame_box = palette.bounding_box(), deepest.bounding_box()
    assert palette_box is not None and frame_box is not None
    # Pick a point inside the deepest frame and below the palette.
    x = frame_box["x"] + frame_box["width"] / 2
    y = max(frame_box["y"] + 12, palette_box["y"] + palette_box["height"] + 24)
    assert y < frame_box["y"] + frame_box["height"] - 4, (palette_box, frame_box)
    if touch:
        page.touchscreen.tap(x, y)
    else:
        page.mouse.click(x, y)
    expect(palette).to_have_count(0)
    assert browser_errors == []


def test_reload_rereads_external_html_in_place_and_protects_unsaved_source(
    page: Page,
    workspace_journey: WorkspaceJourney,
    browser_errors: list[str],
    surface: tuple[int, int, bool],
) -> None:
    """Reload updates an open preview snapshot but refuses to replace a dirty editor."""
    journey = workspace_journey
    chat = journey.chats[0]
    environment = "/v1/workbench-workspaces/workspace-files/resources/environments/default"
    html_path = "preview.html"
    journey.files[html_path] = "<h1>External snapshot one</h1>"
    html_reads: list[str] = []

    def html_content(route: Route) -> None:
        html_reads.append(urlparse(route.request.url).path)
        content = journey.files[html_path]
        route.fulfill(
            json={
                "object": "session.environment.filesystem.file_content",
                "path": html_path,
                "content": content,
                "encoding": "utf-8",
                "content_type": "text/html",
                "bytes": len(content),
            }
        )

    chat.contract.route(
        chat.contract._matcher(f"{environment}/filesystem/{html_path}"), html_content
    )
    page.goto(f"{chat.url}?file={html_path}&workspace={journey.workspace['id']}")
    viewer = _view(page, html_path)
    preview = viewer.frame_locator('iframe[title="HTML preview"]')
    expect(
        preview.get_by_role("heading", name="External snapshot one", exact=True)
    ).to_be_visible()
    viewer_node = viewer.element_handle()
    journey.files[html_path] = "<h1>External snapshot two</h1>"
    _activate_file_action(viewer, "Reload file")
    expect(
        preview.get_by_role("heading", name="External snapshot two", exact=True)
    ).to_be_visible()
    assert viewer_node and viewer_node.evaluate("node => node.isConnected")
    assert len(html_reads) == 2, html_reads

    page.goto(f"{chat.url}?file=notes.py&workspace={journey.workspace['id']}")
    source = _view(page, "notes.py")
    editor = source.locator(".monaco-editor")
    expect(editor).to_be_visible(timeout=30_000)
    journey.reject_writes = True
    source.locator(".view-lines").click()
    page.keyboard.press("ControlOrMeta+Home")
    page.keyboard.type("unsaved_reload_guard = True\n")
    expect(source.get_by_text("Save failed", exact=True)).to_be_visible(timeout=15_000)
    journey.files["notes.py"] = "external_disk_version = True\n"
    _activate_file_action(source, "Reload file")
    expect(
        page.locator("[data-notification-card]").filter(has_text="Save your changes")
    ).to_contain_text("Save your changes before reloading this file.")
    expect(source.locator(".view-lines")).to_contain_text("unsaved_reload_guard")
    expect(source.locator(".view-lines")).not_to_contain_text("external_disk_version")
    assert browser_errors == []


def test_answered_card_keeps_independent_single_line_previews_and_adaptive_count(
    page: Page,
    workspace_journey: WorkspaceJourney,
    browser_errors: list[str],
    surface: tuple[int, int, bool],
    output_path: str,
) -> None:
    """Long question and answer beginnings survive beside navigation at both widths."""
    width, _, _ = surface
    question_one = "Which production regression should remain visible " + "question-detail " * 24
    answer_one = "Keep the nested-frame and reload evidence " + "answer-detail " * 24
    question_two = "How should the second verification start " + "next-question " * 24
    answer_two = "Start with touch geometry and preserve context " + "next-answer " * 24
    receipt = {
        "id": "queue31-question-receipt",
        "type": "resource_event",
        "status": "completed",
        "response_id": "queue31-question-response",
        "resource_type": "question_batch",
        "event_type": "session.question.answered",
        "resource": {
            "version": 1,
            "session_id": workspace_journey.chats[0].session_id,
            "elicitation_id": "queue31-question",
            "submission_id": "queue31-submission",
            "action": "accept",
            "questions": [
                {"id": "first", "question": question_one, "answered": True, "answer": answer_one},
                {"id": "second", "question": question_two, "answered": True, "answer": answer_two},
            ],
        },
    }
    workspace_journey.chats[0].set_items([receipt])
    page.goto(workspace_journey.chats[0].url)
    card = _view(page, "Chat A").get_by_test_id("approval-card")
    expect(card).to_have_attribute("data-state", "responded")
    progress = card.get_by_test_id("ask-user-question-progress")
    expect(progress).to_have_text("Question 1 of 2")

    def measure() -> dict[str, object]:
        return card.evaluate(
            """element => {
              const title = element.querySelector('.question-preview');
              const answer = element.querySelector('.resource-description > span');
              const prefix = element.querySelector('.question-page-prefix');
              const row = element.querySelector('[data-resource-row]');
              const data = node => {
                const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
                return {text: node.textContent, width: rect.width, height: rect.height,
                  clientWidth: node.clientWidth, scrollWidth: node.scrollWidth,
                  lineHeight: parseFloat(style.lineHeight), overflow: style.overflow,
                  whiteSpace: style.whiteSpace, textOverflow: style.textOverflow};
              };
              return {title: data(title), answer: data(answer), prefix: data(prefix),
                row: row.getBoundingClientRect().toJSON()};
            }"""
        )

    first = measure()
    assert question_one[:44] in first["title"]["text"], first
    assert answer_one[:42] in first["answer"]["text"], first
    for key in ("title", "answer"):
        assert first[key]["height"] <= first[key]["lineHeight"] + 1, first
        assert first[key]["scrollWidth"] > first[key]["clientWidth"], first
    if width < 512:
        assert first["prefix"]["width"] == pytest.approx(1), first
        assert first["prefix"]["height"] == pytest.approx(1), first
    else:
        assert first["prefix"]["width"] > 1, first

    card.get_by_role("button", name="Next question", exact=True).click()
    expect(progress).to_have_text("Question 2 of 2")
    second = measure()
    assert question_two[:38] in second["title"]["text"], second
    assert answer_two[:40] in second["answer"]["text"], second
    assert second["row"]["height"] == pytest.approx(first["row"]["height"], abs=1), (
        first,
        second,
    )
    Path(output_path).mkdir(parents=True, exist_ok=True)
    Path(output_path, "answered-card-geometry.json").write_text(
        json.dumps({"first": first, "second": second}, indent=2) + "\n"
    )
    assert browser_errors == []
