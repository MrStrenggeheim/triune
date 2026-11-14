# Modified for Triune.
"""E2E: TeX math in chat and markdown FileViewer Preview stays complete.

The FileViewer's Preview mode showed TeX source (``$$``, ``\\text``,
``\\frac``) as literal text while the chat renderer formatted the same
content as KaTeX math, so math rendering was inconsistent between the two
markdown surfaces. This drives both surfaces with the same document: the
chat transcript (seeded via ``external_assistant_message`` — no LLM run)
must render a KaTeX display block, and the file preview (seeded via the
filesystem PUT endpoint) must render the same block instead of the raw
delimiters. Regular markdown (the heading) must keep rendering either way.
"""

from __future__ import annotations

import re
from collections.abc import Iterator

import httpx
import pytest
from playwright.sync_api import Locator, Page, expect

from tests.e2e_ui.conftest import switch_markdown_view_mode

_AGENT_NAME = "hello_world"
_ASSISTANT = '[data-testid="message-bubble"][data-role="assistant"]'
_FILE_PATH = "amdahl.md"

# Single-dollar prose stays prose; only the display blocks are asserted as math.
_DISPLAY_EXPRESSIONS = (
    r"\mathbb E[T]=\frac{1}{\lambda}",
    r"\text{Speedup} = \frac{1}{(1-P) + \frac{P}{N}}",
    r"\sqrt{\frac{1+x^2}{\sqrt{1+y^2}}}",
    r"e^{x^2}+\sum_{i=1}^{n}i^2",
    r"\underbrace{a+b+\cdots+z}_{\text{26 terms}}",
    "=".join([r"\frac{1}{\sqrt{x^2+1}}"] * 24),
)
_MARKDOWN_CONTENT = "\n".join(
    [
        "# Amdahl's Law",
        "",
        *(f"$$\n{expression}\n$$\n" for expression in _DISPLAY_EXPRESSIONS),
        "",
        r"- $P$: fraction that can run in parallel",
        r"- $N$: number of processors",
        r"- $1-P$: serial fraction",
        "",
    ]
)

_PROSE_MARKER = "fraction that can run in parallel"


def _assert_display_math_layout(surface: Locator) -> list[dict]:
    """Measure rendered glyph boxes and both scroll axes after math fonts load."""
    blocks = surface.locator(".katex-display")
    expect(blocks).to_have_count(len(_DISPLAY_EXPRESSIONS))
    surface.page.evaluate("document.fonts.ready")
    geometry = blocks.evaluate_all(
        """elements => elements.map(element => {
            const box = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            const glyphs = [...element.querySelectorAll('.katex-html *')].flatMap(node => {
                if (node.tagName.toLowerCase() === 'svg') return [node.getBoundingClientRect()];
                return [...node.childNodes]
                    .filter(child => child.nodeType === Node.TEXT_NODE && child.textContent.trim())
                    .map(child => {
                        const range = document.createRange();
                        range.selectNodeContents(child);
                        return range.getBoundingClientRect();
                    });
            }).filter(rect => rect.width && rect.height);
            const scrollLeft = element.scrollLeft;
            element.scrollLeft = element.scrollWidth;
            const reachableScrollLeft = element.scrollLeft;
            element.scrollLeft = scrollLeft;
            return {
                overflowX: style.overflowX, overflowY: style.overflowY,
                clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
                clientHeight: element.clientHeight, scrollHeight: element.scrollHeight,
                glyphCount: glyphs.length, reachableScrollLeft,
                topClearance: Math.min(...glyphs.map(rect => rect.top)) - box.top,
                bottomClearance: box.bottom - Math.max(...glyphs.map(rect => rect.bottom)),
            };
        })"""
    )
    for expression, measured in zip(_DISPLAY_EXPRESSIONS, geometry, strict=True):
        assert measured["overflowX"] == "auto", (expression, measured)
        assert measured["overflowY"] == "hidden", (expression, measured)
        assert measured["glyphCount"] > 0, (expression, measured)
        assert measured["topClearance"] >= -1, (expression, measured)
        assert measured["bottomClearance"] >= -1, (expression, measured)
        assert measured["scrollHeight"] <= measured["clientHeight"] + 1, (expression, measured)
    assert geometry[0]["scrollWidth"] <= geometry[0]["clientWidth"] + 1, geometry[0]
    assert geometry[-1]["scrollWidth"] > geometry[-1]["clientWidth"], geometry[-1]
    assert geometry[-1]["reachableScrollLeft"] > 0, geometry[-1]
    return geometry


@pytest.fixture
def tex_markdown_session(seeded_session: tuple[str, str]) -> Iterator[tuple[str, str]]:
    """Seed the TeX document as a workspace file and as a chat message.

    :param seeded_session: ``(base_url, session_id)`` for a runner-bound session.
    :returns: the same ``(base_url, session_id)`` after both are seeded.
    """
    base_url, session_id = seeded_session
    file_url = (
        f"{base_url}/v1/sessions/{session_id}"
        f"/resources/environments/default/filesystem/{_FILE_PATH}"
    )
    put_resp = httpx.put(
        file_url,
        json={"content": _MARKDOWN_CONTENT, "encoding": "utf-8"},
        timeout=10.0,
    )
    put_resp.raise_for_status()
    msg_resp = httpx.post(
        f"{base_url}/v1/sessions/{session_id}/events",
        json={
            "type": "external_assistant_message",
            "data": {"agent": _AGENT_NAME, "text": _MARKDOWN_CONTENT},
        },
        timeout=10.0,
    )
    msg_resp.raise_for_status()
    yield (base_url, session_id)


@pytest.mark.parametrize("width", [390, 1280], ids=["mobile", "desktop"])
def test_markdown_preview_renders_tex_like_chat(
    page: Page,
    tex_markdown_session: tuple[str, str],
    width: int,
) -> None:
    """The file preview renders `$$` display math as KaTeX, matching chat."""
    base_url, session_id = tex_markdown_session
    page.set_viewport_size({"width": width, "height": 844})

    # Chat surface: the same document renders its display equation as KaTeX.
    page.goto(f"{base_url}/c/{session_id}")
    bubble = page.locator(_ASSISTANT, has_text=_PROSE_MARKER).first
    expect(bubble).to_be_visible(timeout=30_000)
    expect(bubble.locator(".katex-display").first).to_be_visible(timeout=30_000)
    expect(bubble.locator(".katex-html > span").first).to_have_css("display", "inline-block")
    _assert_display_math_layout(bubble)

    # File surface: open the seeded file and switch to Preview mode.
    page.get_by_role("button", name="Open view", exact=True).click()
    page.get_by_role("menuitem", name="Explorer", exact=True).click()
    file_button = page.get_by_role("button", name=re.compile(rf"^{re.escape(_FILE_PATH)}\b"))
    expect(file_button).to_be_visible(timeout=30_000)
    file_button.click()

    # Two FileViewer instances mount with the same test id (mobile push-panel
    # and desktop rail); target the visible one.
    file_viewer = page.locator('[data-testid="file-viewer"]:visible')
    expect(file_viewer).to_be_visible()
    switch_markdown_view_mode(page, file_viewer, "Preview")

    preview = file_viewer.locator(".markdown-preview")
    expect(preview).to_be_visible(timeout=10_000)

    # Regular markdown keeps rendering: the heading is parsed, not dumped.
    expect(preview.locator("h1")).to_contain_text("Amdahl's Law")

    # The bug: no KaTeX output — the preview showed the raw `$$ … \frac … $$`
    # source as literal text instead of one rendered display block.
    expect(preview.locator(".katex-display").first).to_be_visible(timeout=10_000)
    expect(preview.locator(".katex-html > span").first).to_have_css("display", "inline-block")
    _assert_display_math_layout(preview)

    # With the equation rendered, its raw `$$` delimiters no longer appear as
    # literal preview text.
    expect(preview.get_by_text("$$")).to_have_count(0)
