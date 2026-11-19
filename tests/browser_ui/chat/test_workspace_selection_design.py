# Modified for Triune.
"""Approved workspace surfaces through the built SPA with sealed API contracts."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import pytest
from playwright.sync_api import Locator, Page, Request, Route, expect

from tests.browser_ui.chat._geometry_helpers import assert_activity_entry
from tests.browser_ui.chat.session_contract import list_payload, message_item
from tests.browser_ui.chat.test_iteration6 import _close_phone_navigation, _navigation
from tests.browser_ui.chat.test_unified_workspace import (
    WorkspaceJourney,
    _capture,
    _navigate_chat,
    _open,
    _view,
)
from tests.browser_ui.chat.test_unified_workspace import (
    browser_errors as browser_errors,
)
from tests.browser_ui.chat.test_unified_workspace import (
    workspace_journey as workspace_journey,
)
from tests.browser_ui.conftest import BrowserContract


def _close_navigation(page: Page) -> None:
    close = page.get_by_role("button", name="Close navigation", exact=True)
    if close.is_visible():
        if page.viewport_size["width"] < 768:
            expect(page.get_by_test_id("sidebar-scrim")).to_have_attribute("tabindex", "0")
            _close_phone_navigation(page)
        else:
            close.click()
    expect(page.get_by_role("button", name="Open navigation", exact=True)).to_be_visible()


def _large_inline_artifact_html(padding: int = 760 * 1024) -> bytes:
    """Uploaded kit controls with a tail beyond the large-source highlighting limit."""
    head = """<!doctype html><html><head><meta charset="utf-8"></head><body>
<main class="ta-root ta-stack" data-ta-init style="padding:12px">
<h1 class="ta-heading">Uploaded local tool</h1>
<label class="ta-field">Artifact draft<input class="ta-input" value="Initial draft"></label>
<label class="ta-choice"><input type="checkbox" aria-label="Saved checkbox">Include results</label>
<label class="ta-choice">
<input type="checkbox" aria-label="Saved mixed checkbox" data-ta-mixed>Mixed results</label>
<label class="ta-field">Level
<input type="range" min="0" max="100" step="5" value="20" aria-label="Saved level"></label>
<details><summary>Local details</summary><p>Restored disclosure content</p></details>
<p class="ta-list-row">Density follows Appearance</p>
<!--"""
    tail = """-->
<button class="ta-btn" id="artifact-tail">Run tail action</button>
<output aria-label="Artifact count">0</output>
<script>
window.artifactInstance=String(Date.now())+':'+String(Math.random());
window.artifactFormEdits=0;
document.querySelector('main').addEventListener('input',()=>window.artifactFormEdits++);
const saved=window.TriuneArtifactState.get();let count=Number(saved?.count)||0;
const output=document.querySelector('output');output.textContent=String(count);
document.querySelector('#artifact-tail').addEventListener('click',()=>{
  output.textContent=String(++count);window.TriuneArtifactState.set({count});
});
</script></main></body></html>"""
    return (head + "x" * padding + tail).encode()


@pytest.mark.parametrize(
    ("width", "padding"),
    [(1440, 760 * 1024), (390, 1024)],
    ids=["desktop-large-text", "mobile-highlighted-html"],
)
def test_uploaded_artifact_fence_retains_appearance_state_and_originals(
    page: Page,
    workspace_journey: WorkspaceJourney,
    output_path: str,
    tmp_path: Path,
    browser_errors: list[str],
    width: int,
    padding: int,
) -> None:
    """Sealed upload contract, portable exports and source-chat artifact controls."""
    from tests.browser_ui.chat._geometry_helpers import TOLERANCE, box

    chat, other = workspace_journey.chats
    chat.reject_uploads = False
    file_id, filename, title = "browser-upload-1", "large-local-tool.html", "Large local tool"
    html = _large_inline_artifact_html(padding).replace(
        b'style="padding:12px"', b'style="padding:12px;min-height:1400px"'
    )
    if padding > 512 * 1024:
        assert len(html) > 740 * 1024
    evidence = Path(output_path).resolve()
    if evidence.is_relative_to(Path(__file__).resolve().parents[3]):
        evidence = tmp_path / "artifact-proof"
    evidence.mkdir(parents=True, exist_ok=True)
    metadata_reads: list[str] = []
    content_reads: list[str] = []

    def dispatched_by_author() -> bool:
        return any(
            block.get("file_id") == file_id
            for event in chat.event_posts
            for block in event["body"].get("data", {}).get("content", [])
            if isinstance(block, dict)
        )

    def file_resource(route: Route) -> None:
        path = urlparse(route.request.url).path
        content = path.endswith("/content")
        (content_reads if content else metadata_reads).append(path)
        if path.startswith(f"/v1/sessions/{other.session_id}/") or not dispatched_by_author():
            route.fulfill(status=404, json={"error": {"message": "File not found"}})
        elif content:
            route.fulfill(content_type="text/html;charset=utf-8", body=html)
        else:
            route.fulfill(
                json={
                    "id": file_id,
                    "name": filename,
                    "metadata": {"bytes": len(html), "content_type": "text/html"},
                }
            )

    for source in (chat, other):
        for suffix in ("", "/content"):
            source.contract.route(
                source.contract._matcher(
                    f"/v1/sessions/{source.session_id}/resources/files/{file_id}{suffix}"
                ),
                file_resource,
            )
    page.context.grant_permissions(["clipboard-read", "clipboard-write"])
    page.set_viewport_size({"width": width, "height": 1000})
    page.emulate_media(reduced_motion="reduce")
    page.goto(chat.url)
    chat.wait_for_stream()
    composer = _view(page, "Chat A").get_by_label("Message the agent")
    expect(composer).to_be_visible(timeout=30_000)
    _view(page, "Chat A").locator('form.chat-composer-form input[type="file"]').set_input_files(
        {"name": filename, "mimeType": "text/html", "buffer": html}
    )
    composer.fill("Use the uploaded complete local tool.")
    with page.expect_response(
        lambda response: response.url.endswith(f"/{chat.session_id}/events")
    ):
        _view(page, "Chat A").get_by_role("button", name="Send", exact=True).click()
    assert len(chat.upload_requests) == 1
    assert html in chat.upload_requests[0]["body_bytes"]
    assert dispatched_by_author(), chat.event_posts
    chat.emit_idle()
    fence = "```triune-artifact\n" + json.dumps({"file_id": file_id, "title": title}) + "\n```"
    request = message_item(
        "artifact-request", "user", "Use the uploaded local tool.", response_id="artifact-turn"
    )
    request["content"].append({"type": "input_file", "file_id": file_id, "filename": filename})
    chat.set_items(
        [
            message_item("artifact-answer", "assistant", fence, response_id="artifact-turn"),
            request,
        ]
    )
    other.set_items(
        [
            message_item(
                "foreign-artifact",
                "assistant",
                "```triune-artifact\n"
                + json.dumps({"file_id": file_id, "title": "Denied local tool"})
                + "\n```",
                response_id="foreign-artifact-turn",
            )
        ]
    )
    page.reload()
    chat.wait_for_stream()
    view = page.get_by_role("tabpanel", name="Chat A", exact=True, include_hidden=True)
    artifact = view.locator("[data-triune-artifact]").filter(has_text=title)
    outer = artifact.get_by_title(title, exact=True)
    expect(outer).to_be_visible(timeout=30_000)
    toolbar = artifact.locator(":scope > header")
    expect(toolbar.get_by_role("button")).to_have_count(4)
    for label in ("Source", "Download artifact", "Expand artifact", "More"):
        expect(toolbar.get_by_role("button", name=label, exact=True)).to_be_enabled()
    for label, tooltip in (
        ("Source", "Show artifact source"),
        ("Download artifact", "Download artifact"),
    ):
        toolbar.get_by_role("button", name=label, exact=True).hover()
        expect(page.get_by_role("tooltip")).to_contain_text(tooltip)
        page.keyboard.press("Escape")
        expect(page.get_by_role("tooltip")).to_have_count(0)
    more = toolbar.get_by_role("button", name="More", exact=True)
    more.hover()
    assert more.get_attribute("title") is None
    assert more.get_attribute("aria-describedby") is None
    expect(page.get_by_role("tooltip")).to_have_count(0)
    expect(outer).to_have_attribute("sandbox", "allow-scripts")
    expect(outer).to_have_attribute("referrerpolicy", "no-referrer")
    inner = outer.content_frame.frame_locator("iframe")
    expect(inner.get_by_role("button", name="Run tail action")).to_be_visible()
    boot = inner.locator("body").evaluate("() => window.artifactInstance")
    outer_identity = outer.element_handle()
    body = artifact.get_by_role("region", name=f"{title} preview", exact=True)
    page.wait_for_function("""() => {
      const body = document.querySelector('[data-inline-preview] > [role="region"]');
      return body && body.scrollHeight > body.clientHeight;
    }""")

    def inline_geometry() -> dict:
        geometry = artifact.evaluate("""element => {
          const view = element.closest('[data-chat-surface], .side-chat-backdrop, ' +
            '[data-workbench-view], [data-resource-view]').getBoundingClientRect();
          const top = visualViewport?.offsetTop ?? 0;
          const height = visualViewport?.height ?? innerHeight;
          const header = element.querySelector(':scope > header');
          const body = element.querySelector(':scope > [role="region"]');
          return {available: Math.min(view.bottom, top + height) - Math.max(view.top, top),
            frame: element.getBoundingClientRect().toJSON(),
            header: header.getBoundingClientRect().toJSON(),
            body: body.getBoundingClientRect().toJSON(),
            borders: [getComputedStyle(element).borderTopWidth,
              getComputedStyle(header).borderBottomWidth, getComputedStyle(body).borderTopWidth],
            bodyPadding: getComputedStyle(body).padding,
            scrollHeight: body.scrollHeight, clientHeight: body.clientHeight};
        }""")
        assert geometry["frame"]["height"] == pytest.approx(
            geometry["available"] * 0.6, abs=TOLERANCE
        ), geometry
        assert geometry["borders"] == ["1px", "1px", "0px"], geometry
        assert geometry["bodyPadding"] == "0px", geometry
        assert geometry["body"]["y"] == pytest.approx(
            geometry["header"]["y"] + geometry["header"]["height"], abs=TOLERANCE
        ), geometry
        assert geometry["scrollHeight"] > geometry["clientHeight"], geometry
        return geometry

    initial_geometry = inline_geometry()
    body.evaluate("node => { node.scrollTop = 48; }")
    page.set_viewport_size({"width": width, "height": 760})
    page.wait_for_function("""() => {
      const frame = document.querySelector('[data-inline-preview][data-triune-artifact]');
      const view = frame.closest('[data-chat-surface], [data-workbench-view]');
      return frame.getBoundingClientRect().height <= view.getBoundingClientRect().height * .6 + 1;
    }""")
    resized_geometry = inline_geometry()
    assert box(artifact)["height"] < initial_geometry["frame"]["height"]
    assert body.evaluate("node => node.scrollTop") == 48
    assert outer.evaluate("(node, original) => node === original", outer_identity)
    assert inner.locator("body").evaluate("() => window.artifactInstance") == boot
    body.evaluate("node => { node.scrollTop = 0; }")
    page.set_viewport_size({"width": width, "height": 1000})
    expect(inner.locator("main")).to_have_attribute("data-density", "comfortable")
    inner.get_by_role("button", name="Run tail action").click()
    expect(inner.get_by_label("Artifact count")).to_have_text("1")
    inner.get_by_label("Artifact draft").fill("Draft survives Appearance and reload")
    inner.get_by_label("Saved checkbox", exact=True).check()
    mixed = inner.get_by_label("Saved mixed checkbox", exact=True)
    expect(mixed).to_have_js_property("indeterminate", True)
    mixed.evaluate(
        "node => { node.checked = true; node.dispatchEvent(new Event('change', {bubbles:true})); }"
    )
    level = inner.get_by_label("Saved level", exact=True)
    level.press("End")
    level.press("ArrowLeft")
    expect(level).to_have_value("95")
    form_edits = inner.locator("body").evaluate("() => window.artifactFormEdits")
    inner.get_by_text("Local details", exact=True).click()
    expect(inner.get_by_text("Restored disclosure content")).to_be_visible()
    _capture(page, str(evidence), "artifact-uploaded-interactive-tail")

    _close_navigation(page)
    _navigation(page).get_by_test_id("settings-button").click()
    page.get_by_test_id("settings-nav-appearance").click()
    expect(outer).to_be_hidden()
    page.get_by_test_id("ui-font-family-input").fill("Georgia")
    size = page.get_by_test_id("ui-font-size-input")
    size.fill("17")
    size.press("Enter")
    page.get_by_test_id("list-density-compact").click()
    page.get_by_test_id("color-theme-select").click()
    page.get_by_role("option", name="GitHub", exact=True).click()
    page.get_by_role("radiogroup", name="Mode", exact=True).get_by_role(
        "radio", name="Dark", exact=True
    ).click()
    root = inner.locator("main")
    expect(root).to_have_attribute("data-theme", "dark")
    expect(root).to_have_attribute("data-density", "compact")
    expect(root).to_have_css("font-size", "17px")
    expect(root).to_have_css("font-family", re.compile("Georgia"))
    expect(inner.get_by_label("Saved checkbox", exact=True)).to_be_checked()
    expect(mixed).to_have_js_property("indeterminate", True)
    expect(level).to_have_value("95")
    assert inner.locator("body").evaluate("() => window.artifactFormEdits") == form_edits
    appearance = root.evaluate("""node => {
        const style = getComputedStyle(node);
        return {fontFamily: style.fontFamily, fontSize: style.fontSize,
            mode: node.dataset.theme, density: node.dataset.density,
            primary: style.getPropertyValue('--ta-primary').trim()};
    }""")
    assert outer.evaluate("(node, original) => node === original", outer_identity)
    assert inner.locator("body").evaluate("() => window.artifactInstance") == boot
    _capture(page, str(evidence), "artifact-selected-appearance")
    if width < 768:
        page.get_by_role("button", name="Open navigation", exact=True).click()
    page.get_by_role("link", name="Back", exact=True).click()
    expect(page).to_have_url(chat.url)
    if width < 768:
        _close_navigation(page)
    expect(outer).to_be_visible()
    assert inner.locator("body").evaluate("() => window.artifactInstance") == boot
    expect(inner.get_by_label("Artifact draft")).to_have_value(
        "Draft survives Appearance and reload"
    )
    _capture(page, str(evidence), "artifact-appearance-without-reset")

    source_toggle = toolbar.get_by_role("button", name="Source", exact=True)
    source_toggle.click()
    expect(source_toggle).to_have_attribute("aria-pressed", "true")
    expect(outer).to_be_hidden()
    language = "text" if len(html) > 512 * 1024 else "html"
    source = artifact.locator(f'[data-language="{language}"]')
    expect(source.locator("pre")).to_be_visible()
    lines = source.locator("pre > code > span").all_text_contents()
    assert "\n".join(lines).encode() == html
    expect(source.locator("script, main, #artifact-tail")).to_have_count(0)
    if language == "html":
        expect(source.locator('[data-code-highlighted="true"]')).to_be_visible()
        expect(source.locator('pre code span[style*="--shiki-dark"]').first).to_be_attached()
    copy_source = source.get_by_role("button", name="Copy source", exact=True)
    copy_source.click()
    assert page.evaluate("navigator.clipboard.readText()").encode() == html
    wrap = source.get_by_role("button", name="Toggle word wrap", exact=True)
    expect(wrap).to_have_attribute("aria-pressed", "true")
    expect(source.locator("pre")).to_have_css("white-space", "pre-wrap")
    wrap.click()
    expect(wrap).to_have_attribute("aria-pressed", "false")
    expect(source.locator("pre")).to_have_css("white-space", "pre")
    assert page.evaluate("localStorage.getItem('omnigent:wrap:chat')") == "false"
    source_toggle.click()
    expect(source_toggle).to_have_attribute("aria-pressed", "false")
    assert outer.evaluate("(node, original) => node === original", outer_identity)
    assert inner.locator("body").evaluate("() => window.artifactInstance") == boot
    source_toggle.click()
    expect(wrap).to_have_attribute("aria-pressed", "false")
    _capture(page, str(evidence), "artifact-source-copy-wrap")
    source_toggle.click()
    footer = view.get_by_test_id("chat-attachment").filter(
        has=page.get_by_role("button", name=filename, exact=True)
    )
    with page.expect_download() as original_download:
        footer.get_by_role("button", name=f"Download {filename}", exact=True).click()
    original = original_download.value
    assert original.suggested_filename == filename
    assert Path(original.path()).read_bytes() == html
    original.save_as(evidence / "artifact-original.html")
    with page.expect_download() as export_download:
        toolbar.get_by_role("button", name="Download artifact", exact=True).click()
    exported = export_download.value
    assert exported.suggested_filename == f"{title}.html"
    complete = Path(exported.path()).read_text()
    assert "data-triune-kit-embedded" in complete
    assert "frame-src about:" in complete
    assert complete.count("data-triune-kit-embedded") == 1
    portable = evidence / "artifact-self-contained.html"
    exported.save_as(portable)
    with page.context.browser.new_context(offline=True) as offline:
        saved = offline.new_page()
        saved.goto(portable.as_uri())
        saved_inner = saved.frame_locator("iframe")
        expect(saved_inner.get_by_label("Artifact count")).to_have_text("1")
        expect(saved_inner.get_by_label("Artifact draft")).to_have_value(
            "Draft survives Appearance and reload"
        )
        expect(saved_inner.get_by_text("Restored disclosure content")).to_be_visible()
        expect(saved_inner.get_by_label("Saved checkbox", exact=True)).to_be_checked()
        expect(saved_inner.get_by_label("Saved mixed checkbox", exact=True)).to_have_js_property(
            "indeterminate", True
        )
        expect(saved_inner.get_by_label("Saved level", exact=True)).to_have_value("95")
        assert saved_inner.locator("body").evaluate("() => window.artifactFormEdits") == 0
        expect(saved_inner.locator("main")).to_have_attribute("data-theme", "dark")
        expect(saved_inner.locator("main")).to_have_attribute("data-density", "compact")
        expect(saved_inner.locator("main")).to_have_css("font-size", "17px")
        expect(saved_inner.locator("main")).to_have_css("font-family", re.compile("Georgia"))
        saved_inner.get_by_role("button", name="Run tail action").click()
        expect(saved_inner.get_by_label("Artifact count")).to_have_text("2")
        _capture(saved, str(evidence), "artifact-portable-offline")
    more.click()
    expect(page.get_by_role("menuitem")).to_have_count(2)
    with page.expect_popup() as opened:
        page.get_by_role("menuitem", name="Open in new window", exact=True).click()
    popup = opened.value
    expect(popup).to_have_url("about:blank")
    assert popup.evaluate("window.opener === null")
    expect(popup.locator("iframe")).to_have_attribute("sandbox", "allow-scripts")
    popup_inner = popup.frame_locator("iframe").frame_locator("iframe")
    expect(popup_inner.get_by_label("Artifact count")).to_have_text("1")
    expect(popup_inner.get_by_label("Artifact draft")).to_have_value(
        "Draft survives Appearance and reload"
    )
    _capture(popup, str(evidence), "artifact-new-window")
    popup.close()
    toolbar.get_by_role("button", name="Expand artifact", exact=True).click()
    expect(page.get_by_role("tab", name=title, exact=True)).to_have_count(1)
    docked = _view(page, title).locator("[data-triune-artifact]")
    expect(docked).to_have_attribute("data-triune-artifact", f"{chat.session_id}:{file_id}")
    expect(docked.locator(":scope > header")).to_have_count(0)
    preview_header = _view(page, title).locator("section > header")
    expect(preview_header.get_by_role("button", name="Source", exact=True)).to_be_visible()
    expect(docked.get_by_role("button", name="Expand artifact", exact=True)).to_have_count(0)
    expect(docked).to_have_css("max-height", "none")
    docked_inner = docked.locator("iframe").content_frame.frame_locator("iframe")
    expect(docked_inner.get_by_label("Artifact count")).to_have_text("1")
    expect(docked_inner.get_by_label("Artifact draft")).to_have_value(
        "Draft survives Appearance and reload"
    )
    preview_header.get_by_role("button", name="Source", exact=True).click()
    expect(docked.get_by_role("button", name="Toggle word wrap", exact=True)).to_have_attribute(
        "aria-pressed", "false"
    )
    _capture(page, str(evidence), "artifact-source-chat-preview-tab")
    page.get_by_role("button", name=f"Close {title}", exact=True).click()
    page.get_by_role("tab", name="Chat A", exact=True).click()
    more.click()
    page.get_by_role("menuitem", name="Open in tab", exact=True).click()
    expect(page.get_by_role("tab", name=title, exact=True)).to_have_count(1)
    page.get_by_role("button", name=f"Close {title}", exact=True).click()
    page.get_by_role("tab", name="Chat A", exact=True).click()
    page.reload()
    chat.wait_for_stream()
    expect(outer).to_be_visible(timeout=30_000)
    expect(inner.get_by_label("Saved checkbox", exact=True)).to_be_checked()
    expect(inner.get_by_label("Saved mixed checkbox", exact=True)).to_have_js_property(
        "indeterminate", True
    )
    expect(inner.get_by_label("Saved level", exact=True)).to_have_value("95")
    expect(inner.get_by_label("Artifact count")).to_have_text("1")
    expect(inner.get_by_label("Artifact draft")).to_have_value(
        "Draft survives Appearance and reload"
    )
    expect(inner.get_by_text("Restored disclosure content")).to_be_visible()
    expect(root).to_have_css("font-size", "17px")
    _capture(page, str(evidence), "artifact-reload-restored")
    _navigate_chat(page, other)
    denied = _view(page, "Chat B")
    expect(denied.get_by_role("alert").filter(has_text="File not found")).to_be_visible()
    expect(denied.get_by_title("Denied local tool", exact=True)).to_have_count(0)
    assert not any(f"/{other.session_id}/" in path for path in content_reads)
    assert any(f"/{other.session_id}/" in path for path in metadata_reads)
    _capture(page, str(evidence), "artifact-cross-chat-denied")
    (evidence / "artifact-proof.json").write_text(
        json.dumps(
            {
                "file_id": file_id,
                "bytes": len(html),
                "metadata_reads": metadata_reads,
                "content_reads": content_reads,
                "retained_instance": boot,
                "appearance": appearance,
                "source_language": language,
                "viewport_width": width,
                "inline_geometry": {"initial": initial_geometry, "resized": resized_geometry},
            },
            indent=2,
        )
        + "\n"
    )
    assert browser_errors == []


def test_mobile_composer_keeps_tabs_and_follows_appearance_density(
    page: Page,
    workspace_journey: WorkspaceJourney,
    browser_contract: BrowserContract,
    output_path: str,
    browser_errors: list[str],
) -> None:
    host = workspace_journey.chats[0].host_id
    for suffix in ("", "/workspace"):
        browser_contract.json(f"/v1/hosts/{host}/filesystem{suffix}", list_payload([]))
    page.set_viewport_size({"width": 390, "height": 844})
    page.goto(workspace_journey.chats[0].url)
    chat = _view(page, "Chat A")
    composer = chat.get_by_label("Message the agent")
    expect(composer).to_be_visible()
    composer.fill("Mobile draft stays here")
    selector = chat.get_by_test_id("composer-workspace-dir")
    expect(selector).to_be_visible()
    expect(selector.locator(".workspace-selector-details")).to_be_hidden()
    expect(selector).to_have_attribute("aria-label", "Change workspace: Browser host:/workspace")
    expect(page.get_by_role("combobox", name="Open views", exact=True)).to_have_count(0)
    expect(page.get_by_role("tablist", name="Views in main")).to_be_visible()

    geometry = chat.evaluate("""element => {
      const form = element.querySelector('.chat-composer-form');
      const card = form.querySelector('[data-composer-card]');
      const appbar = document.querySelector('.workbench-app-bar');
      const navigation = document.querySelector('.dock-pane:not([hidden]) .dock-pane-header');
      const header = element.querySelector('.workspace-control-header');
      return {
        appbar: appbar.getBoundingClientRect().height,
        navigation: navigation.getBoundingClientRect().height,
        viewHeader: header.getBoundingClientRect().height,
        gutter: form.getBoundingClientRect().bottom - card.getBoundingClientRect().bottom,
        belowForm: element.getBoundingClientRect().bottom - form.getBoundingClientRect().bottom,
      };
    }""")
    assert geometry == {
        "appbar": 48,
        "navigation": 48,
        "viewHeader": 48,
        "gutter": 8,
        "belowForm": 0,
    }, geometry
    page.evaluate("document.documentElement.dataset.listDensity = 'compact'")
    for row in (
        ".workbench-app-bar",
        ".dock-pane:not([hidden]) .dock-pane-header",
        ".workspace-control-header",
    ):
        assert page.locator(row).first.evaluate("el => el.getBoundingClientRect().height") == 36
    page.get_by_role("button", name="Open navigation", exact=True).click()
    entry = page.locator(".conversations-sidebar .sidebar-row").first
    expect(entry).to_have_css("padding-top", "2px")
    page.evaluate("document.documentElement.dataset.listDensity = 'comfortable'")
    expect(entry).to_have_css("padding-top", "6px")
    page.get_by_test_id("sidebar-scrim").click(position={"x": 385, "y": 500})
    expect(page.get_by_role("button", name="Open navigation", exact=True)).to_be_visible()
    _capture(page, output_path, "mobile-tabs-composer")

    selector.click()
    expect(page.get_by_role("dialog", name="Select workspace", exact=True)).to_be_visible()
    page.get_by_role("button", name="Cancel", exact=True).click()
    expect(composer).to_have_value("Mobile draft stays here")

    page.evaluate("""() => {
      document.documentElement.style.setProperty('--omnigent-safe-bottom', '20px');
      document.querySelector('.unified-workbench').dataset.iosNative = 'true';
    }""")
    assert (
        page.locator(".dock-workspace").evaluate(
            "el => window.innerHeight - el.getBoundingClientRect().bottom"
        )
        == 20
    )
    assert (
        chat.locator(".chat-composer-form").evaluate("el => getComputedStyle(el).paddingBottom")
        == "8px"
    )
    assert (
        chat.evaluate(
            "el => getComputedStyle(el.closest('.dock-view-slot'), '::after').borderBottomWidth"
        )
        == "0px"
    )
    assert chat.evaluate(
        """el => {
          const pane = getComputedStyle(el.closest('.dock-view-slot'));
          const shell = getComputedStyle(document.querySelector('.unified-workbench'));
          return pane.backgroundColor === shell.backgroundColor;
        }"""
    )

    page.evaluate("""() => {
      document.documentElement.style.removeProperty('--omnigent-safe-bottom');
      delete document.querySelector('.unified-workbench').dataset.iosNative;
    }""")
    page.set_viewport_size({"width": 1440, "height": 1000})
    expect(page.get_by_role("tablist", name="Views in main")).to_be_visible()
    expect(page.get_by_role("combobox", name="Open views", exact=True)).to_have_count(0)
    expect(composer).to_have_value("Mobile draft stays here")
    assert browser_errors == []


def _assert_picker(page: Page, host_id: str, root: str) -> Locator:
    dialog = page.get_by_role("dialog", name="Select workspace", exact=True)
    expect(dialog).to_be_visible()
    for section in ("Host", "Path"):
        region = dialog.get_by_role("region", name=section, exact=True)
        expect(region).to_be_in_viewport()
    expect(dialog.get_by_test_id(f"workspace-selection-host-{host_id}")).to_have_attribute(
        "aria-pressed", "true"
    )
    path = dialog.get_by_role("textbox", name="Current folder path", exact=True)
    expect(path).to_have_value(root)
    expect(path).to_be_focused()
    footer = dialog.get_by_test_id("workspace-selection-footer")
    expect(footer.get_by_role("button")).to_have_count(2)
    for label in ("Cancel", "Use workspace"):
        expect(dialog.get_by_role("button", name=label, exact=True)).to_have_count(1)
        expect(footer.get_by_role("button", name=label, exact=True)).to_be_in_viewport()
    header = dialog.get_by_test_id("workspace-picker-header")
    expect(header.get_by_role("button", name="Use workspace", exact=True)).to_have_count(0)
    expect(header.get_by_role("button", name="Cancel", exact=True)).to_have_count(0)
    return dialog


def test_combined_workspace_picker_changes_explorer_requests_and_cancel_retains_root(
    page: Page,
    workspace_journey: WorkspaceJourney,
    browser_contract: BrowserContract,
    output_path: str,
    browser_errors: list[str],
) -> None:
    journey = workspace_journey
    host_id = journey.chats[0].host_id
    created: list[dict[str, Any]] = []
    filesystem_requests: list[str] = []
    candidates = {
        root: {**journey.workspace, "id": f"workspace-{name}", "root": root}
        for name, root in (("desktop", "/candidate-desktop"), ("phone", "/candidate-phone"))
    }

    def create_workspace(request: Request) -> dict[str, Any]:
        body = request.post_data_json
        created.append(body)
        assert body["host_id"] == host_id
        return candidates[body["root"]]

    browser_contract.json("/v1/workbench-workspaces", create_workspace, method="POST")
    for root in ("", "/workspace", "/cancelled", *candidates):
        path = f"/v1/hosts/{host_id}/filesystem{root}"
        browser_contract.json(
            path,
            list_payload(
                [
                    {
                        "name": "folder",
                        "path": f"{root or '/home/fixture'}/folder",
                        "type": "directory",
                    }
                ]
            ),
        )
    for workspace in candidates.values():
        base = f"/v1/workbench-workspaces/{workspace['id']}"
        environment = f"{base}/resources/environments/default"
        browser_contract.json(base, workspace)
        browser_contract.json(environment, {"metadata": {"root": workspace["root"]}})
        browser_contract.json(
            f"{environment}/git",
            {**list_payload([]), "repositories": [], "source": "git", "root_is_repository": False},
        )
        browser_contract.json(f"{environment}/changes", list_payload([]))
        listing = list_payload(
            [{"name": "candidate.txt", "path": "candidate.txt", "type": "file"}]
        )
        for suffix in ("", "/", workspace["root"]):
            browser_contract.json(f"{environment}/filesystem{suffix}", listing)

    page.on(
        "request",
        lambda request: (
            filesystem_requests.append(urlparse(request.url).path)
            if "/resources/environments/default/filesystem" in request.url
            else None
        ),
    )
    page.set_viewport_size({"width": 1440, "height": 1000})
    page.goto(journey.chats[0].url)
    expect(_view(page, "Chat A").get_by_label("Message the agent")).to_be_visible()
    _close_navigation(page)
    _open(page, "Explorer")
    explorer = _view(page, "Explorer")
    expect(explorer.get_by_text("notes.py", exact=True)).to_be_visible()
    root = "/workspace"
    for name, width, height, next_root in (
        ("desktop", 1440, 1000, "/candidate-desktop"),
        ("phone", 390, 844, "/candidate-phone"),
    ):
        page.set_viewport_size({"width": width, "height": height})
        selector = explorer.get_by_role(
            "button", name=f"Select workspace: Browser host:{root}", exact=True
        )
        selector.click()
        dialog = _assert_picker(page, host_id, root)
        _capture(page, output_path, f"{name}-workspace-picker")
        dialog.get_by_role("textbox", name="Current folder path").fill("/cancelled")
        dialog.get_by_role("button", name="Add host…", exact=True).click()
        setup = page.get_by_role("dialog", name="Connect a host", exact=True)
        expect(setup).to_be_visible()
        expect(setup).to_contain_text("triune host --server")
        expect(setup).to_contain_text(journey.chats[0].contract.base_url)
        _capture(page, output_path, f"{name}-add-host-instructions")
        setup.get_by_role("button", name="Close", exact=True).click()
        expect(dialog.get_by_role("textbox", name="Current folder path")).to_have_value(
            "/cancelled"
        )
        dialog.get_by_role("button", name="Cancel", exact=True).click()
        expect(dialog).to_have_count(0)
        expect(selector).to_be_visible()
        assert len(created) == (0 if name == "desktop" else 1)
        assert not any("/workspace-cancelled/" in url for url in filesystem_requests)
        selector.click()
        dialog = _assert_picker(page, host_id, root)
        dialog.get_by_role("textbox", name="Current folder path").fill(next_root)
        with page.expect_request(
            lambda request, name=name: (
                f"/workbench-workspaces/workspace-{name}/resources/" in request.url
                and "/filesystem" in request.url
            )
        ):
            dialog.get_by_role("button", name="Use workspace", exact=True).click()
        expect(dialog).to_have_count(0)
        expect(explorer.get_by_text("candidate.txt", exact=True)).to_be_visible()
        expect(
            explorer.get_by_role(
                "button", name=f"Select workspace: Browser host:{next_root}", exact=True
            )
        ).to_be_visible()
        assert created[-1] == {"host_id": host_id, "root": next_root}
        assert any(f"/workspace-{name}/resources/" in url for url in filesystem_requests)
        _capture(page, output_path, f"{name}-explorer-confirmed-root")
        root = next_root
    assert journey.writes == []
    assert browser_errors == []


def test_settings_from_closed_navigation_retains_draft_and_approved_chrome(
    page: Page,
    workspace_journey: WorkspaceJourney,
    output_path: str,
    browser_errors: list[str],
) -> None:
    chat = workspace_journey.chats[0]
    page.set_viewport_size({"width": 1440, "height": 1000})
    page.goto(chat.url)
    composer = _view(page, "Chat A").get_by_label("Message the agent")
    expect(composer).to_be_visible()
    composer.fill("Draft survives settings on desktop and phone")
    _close_navigation(page)
    tab = page.get_by_role("tab", name="Chat A", exact=True)
    expect(tab.locator("svg.lucide-message-square")).to_have_count(1)
    expect(tab).to_have_attribute("aria-selected", "true")
    appbar = page.get_by_role("banner", name="Application")
    assert tab.evaluate(
        "el => getComputedStyle(el.parentElement).backgroundColor"
    ) != appbar.evaluate("el => getComputedStyle(el).backgroundColor")
    send = _view(page, "Chat A").get_by_role("button", name="Send", exact=True)
    expect(send).to_be_enabled()
    assert send.locator("svg").evaluate("el => getComputedStyle(el).color") == "rgb(255, 255, 255)"
    assert send.evaluate("el => getComputedStyle(el).backgroundColor") == "rgb(104, 81, 139)"
    close = page.get_by_role("button", name="Close Chat A", exact=True)
    assert close.get_attribute("title") is None
    assert close.get_attribute("data-tooltip") is None
    close.hover()
    expect(page.get_by_role("tooltip")).to_have_count(0)
    _capture(page, output_path, "desktop-approved-chrome")
    for name, width, height in (("desktop", 1440, 1000), ("phone", 390, 844)):
        page.set_viewport_size({"width": width, "height": height})
        _close_navigation(page)
        _navigation(page).get_by_test_id("settings-button").click()
        expect(page).to_have_url(
            re.compile(re.escape(chat.contract.base_url) + r"/settings(?:/general)?$")
        )
        expect(page.get_by_test_id("settings-group-composer")).to_be_visible()
        if name == "desktop":
            expect(page.get_by_test_id("settings-nav-general")).to_be_in_viewport()
            expect(page.get_by_test_id("settings-nav-appearance")).to_be_in_viewport()
        else:
            _close_navigation(page)
            chooser = page.get_by_role("combobox", name="Settings section", exact=True)
            expect(chooser).to_be_in_viewport()
            chooser.click()
            expect(page.get_by_role("option", name="Appearance", exact=True)).to_be_visible()
            page.keyboard.press("Escape")
        _capture(page, output_path, f"{name}-settings-navigation")
        heading_bounds = page.get_by_role("heading", name="General", level=1).bounding_box()
        appbar_bounds = appbar.bounding_box()
        (Path(output_path) / f"{name}-settings-geometry.json").write_text(
            json.dumps(
                {
                    "heading": heading_bounds,
                    "appbar": appbar_bounds,
                    "open_button": appbar.get_by_role("button", name="Open view").bounding_box(),
                },
                indent=2,
            )
            + "\n"
        )
        assert heading_bounds and appbar_bounds
        assert heading_bounds["y"] >= appbar_bounds["y"] + appbar_bounds["height"], (
            name,
            heading_bounds,
            appbar_bounds,
        )
        page.go_back()
        expect(page).to_have_url(chat.url)
        expect(composer).to_have_value("Draft survives settings on desktop and phone")
        expect(
            page.get_by_role(
                "button",
                name="Close navigation" if name == "desktop" else "Open navigation",
                exact=True,
            )
        ).to_be_visible()
        _capture(page, output_path, f"{name}-draft-after-settings")
    assert chat.event_posts == []
    assert browser_errors == []


def test_activity_sources_group_hosts_and_chats_and_agent_cli_is_discoverable(
    page: Page,
    workspace_journey: WorkspaceJourney,
    browser_contract: BrowserContract,
    output_path: str,
    browser_errors: list[str],
) -> None:
    journey = workspace_journey
    root = journey.workspace["root"]
    host_id = journey.chats[1].host_id
    journey.chats[1].update_session(workspace=root)
    browser_contract.json(f"/v1/hosts/{host_id}/filesystem", list_payload([]))
    browser_contract.json(f"/v1/hosts/{host_id}/filesystem{root}", list_payload([]))
    browser_contract.json("/v1/workbench-workspaces", journey.workspace, method="POST")
    browser_contract.json("/v1/workbench-workspaces", list_payload([journey.workspace]))
    page.set_viewport_size({"width": 1440, "height": 1000})
    page.goto(journey.chats[0].url)
    expect(_view(page, "Chat A").get_by_label("Message the agent")).to_be_visible()
    _close_navigation(page)
    page.get_by_role("button", name="Open view", exact=True).click()
    expect(page.get_by_role("menuitem", name="Existing shells", exact=True)).to_have_count(0)
    agent_cli = page.get_by_role("menuitem", name="Agent CLI", exact=True)
    expect(agent_cli).to_be_visible()
    expect(agent_cli.locator("svg.lucide-hat-glasses")).to_have_count(1)
    _capture(page, output_path, "desktop-open-menu-agent-cli")
    page.get_by_role("menuitem", name="Orchestration", exact=True).click()
    activity = _view(page, "Orchestration")
    source = activity.get_by_role("button", name="Choose orchestration source", exact=False)
    source.click()
    dialog = page.get_by_role("dialog", name="Orchestration source", exact=True)
    for group, option in (("Source", "Host / workspace"), ("Chats", "Chat B")):
        expect(
            dialog.get_by_role("group", name=group, exact=True).get_by_role(
                "option", name=option, exact=True
            )
        ).to_be_visible()
    _capture(page, output_path, "desktop-activity-grouped-sources")
    dialog.get_by_role("option", name="Chat B", exact=True).click()
    expect(dialog).to_have_count(0)
    expect(source).to_have_accessible_name("Choose orchestration source · Chat: Chat B")
    page.set_viewport_size({"width": 390, "height": 844})
    source.click()
    host = dialog.get_by_role("option", name="Host / workspace", exact=True)
    expect(host).to_be_in_viewport()
    expect(dialog.get_by_role("option", name="Chat B", exact=True)).to_be_in_viewport()
    _capture(page, output_path, "phone-activity-grouped-sources")
    host.click()
    picker = page.get_by_role("dialog", name="Select workspace", exact=True)
    expect(picker.get_by_role("textbox", name="Current folder path")).to_have_value(root)
    picker.get_by_role("button", name="Use workspace", exact=True).click()
    expect(picker).to_have_count(0)
    expect(dialog).to_have_count(0)
    expect(source).to_have_accessible_name(
        f"Choose orchestration source · Host: Browser host · {root}"
    )
    expect(activity.get_by_role("button", name="shell · fixture", exact=True)).to_be_visible()
    assert_activity_entry(
        activity.locator("[data-resource-row]").filter(has_text="shell · fixture")
    )
    assert journey.attachments == []
    assert journey.stops == []
    assert browser_errors == []
