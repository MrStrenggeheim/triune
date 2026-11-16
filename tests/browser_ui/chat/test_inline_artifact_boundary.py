# Modified for Triune.
"""Browser boundary for source-generated artifacts without SPA or backend execution."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

from playwright.sync_api import Page, expect

_WEB = Path(__file__).resolve().parents[3] / "web"


def _document(html: str, state: object) -> str:
    script = (
        "import {readFileSync} from 'node:fs';"
        "import {buildArtifactDocument} from './src/artifacts/artifactDocument.ts';"
        "const {html,state}=JSON.parse(readFileSync(0,'utf8'));"
        "process.stdout.write(buildArtifactDocument(html,{channel:'boundary-test',state}));"
    )
    return subprocess.check_output(
        ["node", "--experimental-strip-types", "--input-type=module", "-e", script],
        cwd=_WEB,
        input=json.dumps({"html": html, "state": state}),
        text=True,
    )


def test_complete_artifact_isolation_state_and_inactive_work(page: Page) -> None:
    requests: list[str] = []

    def host(route):
        requests.append(route.request.url)
        route.fulfill(content_type="text/html", body="<p id=host>Private host</p>")

    page.route("https://artifact-host.test/**", host)
    page.goto("https://artifact-host.test/")
    page.evaluate(
        "() => {localStorage.setItem('host-secret','private'); window.messages=[];"
        "addEventListener('message',e=>messages.push(e.data));}"
    )
    html = (
        """<html><body><main class="ta-root">
<input id="draft" value="Original"><input id="password" type="password" value="never-persist-this">
<img id="local"
src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">
<script>
window.initial=TriuneArtifactState.get();window.ticks=0;window.paused=false;window.probe={};
window.timeoutTicks=0;function pulse(){timeoutTicks++;setTimeout(pulse,10)}pulse();
try{probe.parent=parent.document.body.innerHTML}catch(e){probe.parent='denied'}
try{probe.top=top.document.body.innerHTML}catch(e){probe.top='denied'}
try{probe.storage=localStorage.getItem('host-secret')}catch(e){probe.storage='denied'}
fetch('https://artifact-host.test/secret').catch(()=>{});
new Image().src='https://artifact-host.test/image';
setInterval(()=>ticks++,10);
addEventListener('triune-artifact:visibility',e=>paused=!e.detail.active);
</script>"""
        + "<!--"
        + "x" * (760 * 1024)
        + "-->"
        + """
<button id="tail" onclick="this.dataset.clicked='yes';
TriuneArtifactState.set({count:9})">Tail action</button>
</main></body></html>"""
    )
    outer = _document(html, {"count": 3})
    page.evaluate(
        "html=>{window.frame=document.createElement('iframe');frame.sandbox='allow-scripts';frame.srcdoc=html;document.body.append(frame)}",
        outer,
    )
    inner = page.frame_locator("iframe").frame_locator("iframe")
    expect(inner.locator("#tail")).to_be_visible()
    artifact = page.frames[-1]
    assert artifact.evaluate("initial") == {"count": 3}
    assert artifact.evaluate("probe") == {"parent": "denied", "top": "denied", "storage": "denied"}
    artifact.wait_for_function("document.querySelector('#local').naturalWidth===1")
    inner.locator("#tail").click()
    expect(inner.locator("#tail")).to_have_attribute("data-clicked", "yes")
    inner.locator("#draft").fill("Restored draft")
    page.wait_for_function(
        "messages.some(m=>m.type==='triune-artifact:state'"
        "&&m.value.form?.[0]?.value==='Restored draft')"
    )
    state = page.evaluate("messages.filter(m=>m.type==='triune-artifact:state').at(-1).value")
    assert "never-persist-this" not in json.dumps(state)
    page.evaluate(
        "frame.contentWindow.postMessage({type:'triune-artifact:update',channel:'boundary-test',active:false},'*')"
    )
    artifact.wait_for_function("paused")
    ticks = artifact.evaluate("ticks")
    timeout_ticks = artifact.evaluate("timeoutTicks")
    page.wait_for_timeout(60)
    assert artifact.evaluate("ticks") == ticks
    assert artifact.evaluate("timeoutTicks") == timeout_ticks
    page.evaluate(
        "frame.contentWindow.postMessage({type:'triune-artifact:update',channel:'boundary-test',active:true,theme:{mode:'dark',density:'compact',variables:{'--ta-font':'monospace','--ta-ui':'17px'}}},'*')"
    )
    artifact.wait_for_function("before=>ticks>before", arg=ticks)
    expect(inner.locator("main")).to_have_attribute("data-theme", "dark")
    assert artifact.locator("main").evaluate("n=>n.style.getPropertyValue('--ta-ui')") == "17px"
    artifact.evaluate("()=>{try{location.href='https://artifact-host.test/navigation'}catch{}}")
    page.wait_for_timeout(60)
    assert requests == ["https://artifact-host.test/"]
    page.evaluate("html=>frame.srcdoc=html", _document(html, state))
    expect(inner.locator("#draft")).to_have_value("Restored draft")
    assert page.frames[-1].evaluate("initial") == {"count": 9}


def test_kit_control_row_keeps_labeled_controls_aligned(page: Page) -> None:
    css = (_WEB / "src/artifacts/kit/triune-artifact.css").read_text()
    for size, minimum in (("", 32), ("sm", 28), ("xs", 24)):
        modifier = f"--{size}" if size else ""
        page.set_content(f"""<style>{css}</style><main class="ta-root">
<div class="ta-control-row">
  <button class="ta-btn ta-btn{modifier}">Apply</button>
  <button class="ta-btn ta-btn--secondary ta-btn{modifier}">Apply</button>
  <label class="ta-field"><span class="ta-label">Preferred appearance</span>
    <select class="ta-select ta-select{modifier}"><option>Light</option></select>
  </label>
  <label class="ta-field"><span class="ta-label">Name</span>
    <input class="ta-input ta-input{modifier}" value="Example">
  </label>
</div></main>""")
        for width, font_size in ((1024, 13), (320, 14), (1024, 26), (320, 26)):
            page.set_viewport_size({"width": width, "height": 800})
            page.locator("main").evaluate(
                "(root, size) => root.style.setProperty('--ta-ui', `${size}px`)", font_size
            )
            geometry = page.locator(".ta-control-row").evaluate("""row => {
              const rect = node => {
                const {top, bottom, height} = node.getBoundingClientRect();
                return {top, bottom, height};
              };
              return {
                controls: [...row.querySelectorAll('button, input, select')].map(rect),
                fields: [...row.querySelectorAll('.ta-field')].map(field => ({
                  label: rect(field.querySelector('.ta-label')),
                  control: rect(field.querySelector('input, select')),
                  position: getComputedStyle(field.querySelector('.ta-label')).position
                })),
                lineHeight: parseFloat(getComputedStyle(row.querySelector('button')).lineHeight),
                overflow: document.documentElement.scrollWidth > innerWidth
              };
            }""")
            controls = geometry["controls"]
            height = controls[0]["height"]
            assert height >= minimum and height >= geometry["lineHeight"] + 1.9, geometry
            assert all(abs(control["height"] - height) < 0.1 for control in controls), geometry
            assert controls[0] == controls[1], geometry
            if width == 1024:
                assert all(
                    abs(control["top"] - controls[0]["top"]) < 0.1 for control in controls
                ), geometry
                assert all(
                    abs(control["bottom"] - controls[0]["bottom"]) < 0.1 for control in controls
                ), geometry
                if font_size == 13:
                    assert height == minimum, geometry
            assert not geometry["overflow"], geometry
            for field in geometry["fields"]:
                assert field["position"] == "static", geometry
                assert field["label"]["bottom"] < field["control"]["top"], geometry


def test_kit_native_checkbox_range_and_progress(page: Page) -> None:
    """Exercise source assets directly; no SPA, server, credentials or models."""
    css = (_WEB / "src/artifacts/kit/triune-artifact.css").read_text()
    helper = (_WEB / "src/artifacts/kit/triune-artifact.js").read_text()
    page.set_content(f"""<style>{css}</style><main class="ta-root">
<form><label class="ta-choice">
<input id="check" name="choice" type="checkbox" data-ta-mixed>Choose</label>
<label class="ta-field">Amount
<input id="range" name="amount" type="range" min="10" max="50" step="5" value="20">
</label>
<input id="disabled" aria-label="Disabled amount" type="range" value="70" disabled>
<progress id="progress" aria-label="Progress" value="20" max="50"></progress>
<progress id="usage" class="ta-progress--usage" aria-label="Usage" value="40" max="100"></progress>
<button type="reset">Reset</button></form></main>""")
    page.add_script_tag(content=helper)
    page.evaluate("""() => {
      TriuneArtifact.init(document.querySelector('main'));
      window.submits = 0; window.inputs = 0; window.changes = 0;
      document.querySelector('form').addEventListener('submit', e => {
        e.preventDefault(); submits++;
      });
      document.querySelector('form').addEventListener('input', () => inputs++);
      document.querySelector('form').addEventListener('change', () => changes++);
    }""")
    for theme in ("light", "dark"):
        for density in ("comfortable", "compact"):
            page.locator("main").evaluate(
                "(root, values) => { root.dataset.theme=values[0]; "
                "root.dataset.density=values[1]; }",
                [theme, density],
            )
            geometry = page.evaluate("""() => {
              const style = id => getComputedStyle(document.getElementById(id));
              const rect = id => document.getElementById(id).getBoundingClientRect();
              return {checkbox:[rect('check').width,rect('check').height,
                  style('check').borderRadius],
                rangeHeight:rect('range').height,
                choiceHeight:document.querySelector('.ta-choice').getBoundingClientRect().height,
                progressHeight:rect('progress').height, usageHeight:rect('usage').height,
                progressRadius:style('progress').borderRadius,
                usageRadius:style('usage').borderRadius,
                coarse:matchMedia('(any-pointer: coarse)').matches,
                fill:document.querySelector('#range').style.getPropertyValue('--ta-range-progress'),
                appearance:style('range').appearance, disabledOpacity:style('disabled').opacity,
                overflow:document.documentElement.scrollWidth > innerWidth};
            }""")
            assert geometry["checkbox"] == [16, 16, "4px"], geometry
            assert geometry["rangeHeight"] >= (44 if geometry["coarse"] else 24), geometry
            assert geometry["choiceHeight"] >= (44 if geometry["coarse"] else 32), geometry
            assert geometry["progressHeight"] == 4 and geometry["usageHeight"] == 3, geometry
            assert geometry["usageRadius"] == "0px", geometry
            assert geometry["fill"] == "25%" and geometry["appearance"] == "none", geometry
            assert geometry["disabledOpacity"] == "0.5" and not geometry["overflow"], geometry
    assert page.locator("#check").evaluate("n => n.indeterminate")
    page.locator("#check").focus()
    page.keyboard.press("Space")
    expect(page.locator("#check")).to_be_checked()
    assert not page.locator("#check").evaluate("n => n.indeterminate")
    page.locator("#range").focus()
    page.keyboard.press("ArrowRight")
    expect(page.locator("#range")).to_have_value("25")
    assert (
        page.locator("#range").evaluate("n => n.style.getPropertyValue('--ta-range-progress')")
        == "37.5%"
    )
    assert page.evaluate("new FormData(document.querySelector('form')).get('amount')") == "25"
    before = page.evaluate("[inputs, changes]")
    page.evaluate("""() => { document.querySelector('#range').value='50';
      dispatchEvent(new Event('triune-artifact:restored')); }""")
    assert (
        page.locator("#range").evaluate("n => n.style.getPropertyValue('--ta-range-progress')")
        == "100%"
    )
    assert page.evaluate("[inputs, changes]") == before
    page.get_by_role("button", name="Reset").click()
    expect(page.locator("#range")).to_have_value("20")
    assert (
        page.locator("#range").evaluate("n => n.style.getPropertyValue('--ta-range-progress')")
        == "25%"
    )
    assert page.evaluate("submits") == 0
    page.emulate_media(forced_colors="active")
    assert page.locator("#check").evaluate("n => getComputedStyle(n).appearance") == "auto"
    page.emulate_media(forced_colors="none")
