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
