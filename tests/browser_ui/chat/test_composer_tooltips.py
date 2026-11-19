"""Browser-only pointer contracts for the composer configuration tooltip."""

import pytest
from playwright.sync_api import Page, expect

from tests.browser_ui.chat._geometry_helpers import DESKTOP, PHONE, open_landing, open_live
from tests.browser_ui.chat.session_contract import ChatSessionContract, model_option

# Tooltip surface properties the host chip shares with the model pill.
_SURFACE_STYLE = """el => {
  const s = getComputedStyle(el);
  return [s.backgroundColor, s.color, s.fontSize, s.padding, s.borderRadius, s.boxShadow];
}"""


@pytest.mark.parametrize("viewport", [DESKTOP, PHONE], ids=["desktop", "phone"])
@pytest.mark.parametrize("landing", [True, False], ids=["landing", "in-session"])
def test_neutral_triggers_open_the_real_composer_controls(
    page: Page, chat_session_contract: ChatSessionContract, landing: bool, viewport: dict[str, int]
) -> None:
    chat = chat_session_contract
    chat.set_catalog(
        harness="claude-native",
        models=[model_option("sonnet", is_default=True)],
        selected_model="sonnet",
    )
    chat.update_session(permission_level=4, labels={"omnigent.wrapper": "claude-code-native-ui"})
    if not landing:
        for folder in ("", "/browser-workspace"):
            chat.contract.json(
                f"/v1/hosts/{chat.host_id}/filesystem{folder}",
                {"available": True, "data": [], "has_more": False},
            )
    (open_landing if landing else open_live)(page, chat, viewport)
    prefix = "new-chat-landing" if landing else "composer"
    draft = (
        page.get_by_test_id("new-chat-landing-input")
        if landing
        else page.get_by_label("Message the agent")
    )
    if viewport == PHONE:
        close = page.get_by_role("button", name="Close navigation", exact=True)
        if close.is_visible():
            close.click()
    draft.fill("Keep this draft")
    workspace = page.get_by_test_id(f"{prefix}-workspace-{'chip' if landing else 'dir'}")
    permission = page.get_by_test_id(f"{prefix}-permission-chip")
    model = page.get_by_test_id(
        "new-chat-landing-agent-select" if landing else "composer-config-gear"
    )
    attach = page.get_by_test_id(f"{prefix}-attach")
    for trigger in (workspace, permission, model, attach):
        expect(trigger).to_have_attribute("data-menu-feedback", "composer")
        expect(trigger).to_have_css("cursor", "pointer")
        expect(trigger).to_have_css("background-color", "rgba(0, 0, 0, 0)")

    workspace.hover()
    label = workspace.get_attribute("aria-label") or ""
    host, _, path = label.partition(": ")[2].partition(":")
    assert host and path, label
    hint = page.get_by_role("tooltip")
    expect(hint).to_contain_text(host)
    expect(hint).to_contain_text(path)
    workspace.press("Enter")
    dialog = page.get_by_role("dialog", name="Select workspace")
    expect(dialog.get_by_role("textbox", name="Current folder path")).to_be_visible()
    dialog.evaluate("el => Promise.all(el.getAnimations().map(a => a.finished))")
    box = dialog.bounding_box()
    assert box is not None
    for axis, size in (("x", "width"), ("y", "height")):
        assert box[axis] + box[size] / 2 == pytest.approx(viewport[size] / 2, abs=1)
    page.keyboard.press("Escape")
    expect(dialog).to_be_hidden()
    expect(workspace).to_be_focused()
    page.keyboard.press("Space")
    dialog.get_by_role("button", name="Cancel", exact=True).press("Enter")
    expect(dialog).to_be_hidden()
    expect(workspace).to_be_focused()

    permission.press("ArrowDown")
    expect(page.get_by_role("menuitemradio").first).to_be_visible()
    page.keyboard.press("Escape")
    expect(permission).to_be_focused()
    model.press("ArrowDown")
    expect(page.get_by_role("menu")).to_be_visible()
    page.keyboard.press("Escape")
    expect(model).to_be_focused()
    attach.hover()
    expect(page.get_by_role("tooltip")).to_have_text("Attach")
    colors = attach.evaluate("""el => {
      const sample = document.createElement("span");
      el.append(sample);
      const resolve = value => {
        sample.style.backgroundColor = value;
        return getComputedStyle(sample).backgroundColor;
      };
      const hover = resolve("var(--workspace-control-hover)");
      const press = resolve("color-mix(in srgb, var(--foreground) 14%, var(--muted))");
      sample.remove();
      return {hover, press};
    }""")
    expect(attach).to_have_css("background-color", colors["hover"])
    page.mouse.down()
    expect(attach).to_have_css("background-color", colors["press"])
    page.mouse.up()
    menu = page.get_by_test_id(f"{prefix}-add-menu")
    expect(menu).to_be_visible()
    menu_box = menu.bounding_box()
    assert menu_box is not None
    assert menu_box["x"] >= 23 and menu_box["x"] + menu_box["width"] <= viewport["width"] - 23
    if viewport == DESKTOP:
        assert menu_box["width"] < viewport["width"] - 48
    with page.expect_file_chooser():
        page.get_by_role("menuitem", name="Files and images").click()
    expect(draft).to_have_value("Keep this draft")
    assert not chat.event_posts


@pytest.mark.parametrize("turns", [0, 1], ids=["new-session", "existing-session"])
def test_pill_uses_one_tooltip_and_suppresses_it_while_picker_is_open(
    page: Page, chat_session_contract, turns: int
) -> None:
    chat_session_contract.seed_transcript(turns)
    chat_session_contract.set_catalog(
        harness="claude-native",
        models=[
            {
                "id": "sonnet",
                "model": "system.ai.claude-sonnet-5",
                "displayName": "Sonnet 5",
                "isDefault": True,
                "source": {
                    "kind": "databricks",
                    "label": "Workspace",
                    "name": "oss",
                    "host": "ws.example.com",
                },
            }
        ],
        selected_model="sonnet",
    )
    page.goto(chat_session_contract.url)
    if turns:
        expect(page.get_by_text("Request 1", exact=False)).to_be_visible()

    pill = page.get_by_test_id("composer-config-gear")
    expect(pill).to_be_visible()
    tooltip = page.get_by_test_id("composer-config-gear-tooltip")
    picker = page.get_by_test_id("composer-agent-menu")

    pill.hover()
    page.wait_for_timeout(100)
    pill.click()
    expect(picker).to_be_visible()
    page.wait_for_timeout(1_000)
    expect(picker).to_be_visible()
    expect(page.locator('[data-slot="tooltip-content"]')).to_have_count(0)

    page.keyboard.press("Escape")
    expect(picker).not_to_be_visible()
    expect(tooltip).not_to_be_visible()

    page.mouse.move(0, 0)
    pill.hover()
    expect(tooltip).to_be_visible()
    expect(page.locator('[data-slot="tooltip-content"]')).to_have_count(1)
    expect(tooltip).to_contain_text("Harness: Claude")
    expect(tooltip).to_contain_text("Model: Default")
    expect(tooltip).to_contain_text("Connection: Databricks · oss")

    pill.click()
    expect(picker).to_be_visible()
    expect(tooltip).not_to_be_visible()
    expect(page.locator('[data-slot="tooltip-content"]')).to_have_count(0)

    page.keyboard.press("Escape")
    expect(picker).not_to_be_visible()
    expect(tooltip).not_to_be_visible()

    page.mouse.move(0, 0)
    pill.hover()
    expect(tooltip).to_be_visible()


def test_host_chip_tooltip_names_the_host_and_matches_the_pill(
    page: Page, chat_session_contract
) -> None:
    # An editor sees the host menu rather than the owner-only workspace switcher.
    chat_session_contract.update_session(permission_level=2)
    chat_session_contract.set_catalog(
        harness="claude-native",
        models=[model_option("sonnet", is_default=True)],
        selected_model="sonnet",
    )
    page.goto(chat_session_contract.url)

    host = page.get_by_test_id("composer-host-select")
    expect(host).to_be_visible()
    assert host.get_attribute("title") is None
    host_tooltip = page.get_by_test_id("composer-host-tooltip")
    menu = page.get_by_test_id("composer-host-menu")

    host.hover()
    expect(host_tooltip).to_be_visible()
    expect(host_tooltip).to_contain_text("Host: Browser host")
    expect(host_tooltip).to_contain_text("Status: Connected")
    expect(page.locator('[data-slot="tooltip-content"]')).to_have_count(1)
    host_style = host_tooltip.evaluate(_SURFACE_STYLE)

    host.click()
    expect(menu).to_be_visible()
    expect(host_tooltip).not_to_be_visible()
    page.keyboard.press("Escape")
    expect(menu).not_to_be_visible()
    expect(host_tooltip).not_to_be_visible()

    page.mouse.move(0, 0)
    page.get_by_test_id("composer-config-gear").hover()
    pill_tooltip = page.get_by_test_id("composer-config-gear-tooltip")
    expect(pill_tooltip).to_be_visible()
    assert pill_tooltip.evaluate(_SURFACE_STYLE) == host_style


@pytest.mark.parametrize("theme", ["light", "dark"])
def test_button_tooltips_share_white_surface_and_centered_gap(
    page: Page, chat_session_contract, theme: str
) -> None:
    chat_session_contract.update_session(permission_level=2)
    page.emulate_media(color_scheme=theme)
    page.add_init_script(f"localStorage.setItem('web-theme', '{theme}')")
    chat_session_contract.set_catalog(
        harness="claude-native",
        models=[model_option("sonnet", is_default=True)],
        selected_model="sonnet",
    )
    page.goto(chat_session_contract.url)
    composer = page.get_by_label("Message the agent")
    expect(composer).to_be_visible()
    composer.fill("Keep this draft unsent.")
    triggers = [
        page.get_by_test_id("composer-config-gear"),
        page.get_by_test_id("composer-host-select"),
        page.get_by_role("button", name="Send", exact=True),
    ]
    styles = []
    for trigger in triggers:
        page.mouse.move(0, 0)
        trigger.hover()
        tooltip = page.locator('[data-slot="tooltip-content"]').filter(visible=True)
        expect(tooltip).to_have_count(1)
        expect(tooltip).to_have_css("background-color", "rgb(255, 255, 255)")
        assert trigger.get_attribute("title") is None
        expect(tooltip).to_have_attribute("data-align", "center")
        assert tooltip.get_attribute("data-side") in {"top", "bottom"}
        # Wait for the tooltip's opening scale animation before measuring its box.
        expect(tooltip).to_have_css("transform", "none")
        anchor = trigger.bounding_box()
        box = tooltip.bounding_box()
        assert anchor is not None and box is not None
        assert abs((anchor["x"] + anchor["width"] / 2) - (box["x"] + box["width"] / 2)) <= 1
        gap = (
            anchor["y"] - box["y"] - box["height"]
            if tooltip.get_attribute("data-side") == "top"
            else box["y"] - anchor["y"] - anchor["height"]
        )
        assert abs(gap - 8) <= 1, {"anchor": anchor, "tooltip": box}
        styles.append(tooltip.evaluate(_SURFACE_STYLE))
    assert styles[0] == styles[1] == styles[2]
    assert not chat_session_contract.event_posts
