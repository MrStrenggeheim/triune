# Interactive HTML artifacts

Uploaded HTML renders inline through an explicit artifact fence and in the existing HTML attachment preview, with isolated local interactions and the optional Triune kit.

## Sub-features

- `inline`: a `triune-artifact` fence identifies one authorized uploaded HTML file in its source chat.
- `complete`: complete HTML renders beyond the ordinary 512KiB text-preview limit, within the existing 50MiB attachment bound.
- `kit`: `.ta-root` or `data-triune-kit="1"` receives versioned first-party styles, helpers and icons.
- `appearance`: palette, density and UI typography update without remounting the document.
- `state`: native form, disclosure and scroll state survive remount/reload; explicit application JSON is bounded to 16KiB.
- `controls`: source, original download, self-contained export and isolated full-window viewing use shared controls.
- `retention`: hidden retained frames keep context while supported timer/animation work pauses.
- `isolation`: an opaque sandbox prevents app DOM, cookie and storage access; external networking remains blocked.
- `states`: missing files, denied access, malformed references, loading and document errors remain visible.
- `usable-height`: inline documents receive the current usable body limit through `TriuneArtifact.maximumBodyHeight` and `--ta-max-body-height`; shorter documents keep natural height.
- `dedicated-header`: HTML and SVG dedicated preview views reuse one outer header for source/preview and their downloads; inline artifacts retain their own controls.

## How to get to it (user POV)

- Agent output: upload complete HTML with the supported upload tool or `triune attach-file`, then include its returned file ID in the source chat:

````markdown
```triune-artifact
{"file_id":"authorized-upload-id","title":"Optional title"}
```
````

- Attachments: open an uploaded HTML file's existing preview to use the same interactive document boundary.
- Toolbar: inspect Source, download original or self-contained HTML, or open the isolated full-window view.
- Appearance: change theme, accent, density or font while the artifact is open.
- Linked files: open a self-contained export through the normal File Editor/HTML preview.
- Phones: use the same artifact and controls within the narrow chat layout.

## Driving it with the repro environment

Preconditions: follow the [verification skill](skills/verify-omnigent/SKILL.md), build the checkout once and use temporary HTML files with an isolated authenticated chat.

- Script execution and opaque browser boundary: `tests/browser_ui/chat/test_inline_artifact_boundary.py` uses a browser document without the Triune SPA/server.
- Canonical fences, code examples and invalid path/URL references: `web/src/artifacts/artifactProtocol.test.ts`.
- Source/channel validation, bounded resize/state, retained identity and viewer-scoped restoration: `web/src/artifacts/ArtifactFrame.test.tsx`.
- Document preparation, kit injection and self-contained export: `web/src/artifacts/artifactDocument.test.ts`.
- Mixed controls: `test_kit_control_row_keeps_labeled_controls_aligned` in the browser boundary test measures default/sm/xs geometry, wrapping and large fonts directly from generated kit CSS.
- Large HTML and source-chat routes: `web/src/components/ChatAttachment.test.tsx` and `web/src/components/blocks/ChatMarkdown.fileLinks.test.tsx`.
- Original bytes, source deletion, session association and permission denial: `tests/server/routes/test_chat_attachments.py`.
- Upload a 740KiB+ HTML tool and render its fence; interact near its tail, then change Appearance and density.
- Hide/reveal, reload and inspect restored state; inspect source/downloads, then try its file ID from another chat and expect access denial.
- Open the self-contained export as a linked HTML file; verify controls and kit styles work without external assets.

### Kit control rows

- Use `.ta-control-row` for buttons beside labeled fields; labels stay in normal flow and controls align at the bottom of each wrapped line.
- Match `.ta-btn--sm` with `.ta-input--sm`/`.ta-select--sm`, or the corresponding `--xs` classes: default/sm/xs minima are 32/28/24px, growing for larger text and 44px coarse targets.
- Keep `.ta-row` for centered content; button variants share geometry, and field size classes preserve the field radius.

```html
<div class="ta-control-row">
  <button class="ta-btn ta-btn--sm">Apply</button>
  <button class="ta-btn ta-btn--secondary ta-btn--sm">Reset</button>
  <label class="ta-field">
    <span class="ta-label">Appearance</span>
    <select class="ta-select ta-select--sm">
      <option>Light</option>
      <option>Dark</option>
    </select>
  </label>
</div>
```

### Kit native form controls

Checkboxes inside a kit root use the app's 16px surface, 4px corners, check and mixed glyphs.
Wrap each checkbox in `.ta-choice` so its label supplies the coarse target; `data-ta-mixed` initializes native `indeterminate` once.
All native ranges in an opted-in root use the app's 6px track and 12px thumb with native min/max/step/value, labels and disabled state.
`TriuneArtifact.init(root)` updates range fill on input, change and reset; call `TriuneArtifact.refresh(root)` after silent programmatic writes.
Native `<progress>` uses the app's 4px rounded track; `.ta-progress--usage` selects the flat 3px usage track.
Omit progress value when the amount is unknown.
The adapters keep native keyboard, form and input/change behavior and support forced-colors.

```html
<main class="ta-root" data-ta-init>
  <label class="ta-choice"><input type="checkbox" name="include" data-ta-mixed>Include results</label>
  <label class="ta-field"><span class="ta-label">Amount</span><input type="range" name="amount" min="0" max="100" value="40"></label>
  <progress class="ta-progress--usage" aria-label="Usage" value="40" max="100"></progress>
</main>
```

Source checks: `web/src/artifacts/kit/formControls.test.ts` and `test_kit_native_checkbox_range_and_progress` in the source browser boundary.

### Integration7 Mermaid loading candidate

Adjacent Mermaid previews defer their engine until first diagram rendering in the [integration7 delivery](../docs/custom-fork.md#integration7-delivery).
Highlighting themes and WASM retain dynamic imports while Shiki core/engines stay grouped; `shikiManualChunk.test.ts` guards that boundary.
HTML artifact isolation, kit injection and document restoration retain their existing owners.
Checks: `web/src/components/ai-elements/mermaidTheme.test.tsx`, `web/src/components/ai-elements/mermaidPresentation.test.ts`, `web/src/components/ai-elements/MermaidError.test.tsx` and `web/src/shell/MermaidPreview.theme.test.tsx`.
Built-SPA entry points and failed-chunk recovery: `tests/browser_ui/files/test_mermaid_lazy_loading.py`.

- Cold-load an empty page, then open the first diagram: engine loading moves to first use; measure the combined SPA before claiming initial-load savings.
- Open diagrams from chat, reasoning, File Preview and TipTap on desktop/phone in light/dark: fonts, appearance, SVG export, source and expansion retain their behavior.
- Block the engine chunk: expect the existing error card and preserved source; restore the asset and reload to verify recovery.

The standalone source probe postpones engine requests while increasing first-use cost; it does not establish full-SPA or production-network savings.
Same-document retry after a failed module import remains unproven; a stale removed chunk can require a new document/build.

## Gotchas

- Ordinary `html` fences remain code; only an explicit artifact fence requests execution.
- Arbitrary server paths and URLs do not substitute for authorized file identities.
- Uploaded bytes survive source deletion; Download original preserves those bytes exactly.
- Self-contained export embeds the kit once and captures current theme/typography.
- Fresh installs serve kit assets under `artifacts/kit/1.0.0/` beneath the app base path; CDNs are unnecessary.
- Inline scripts/styles and data/blob media are available; external scripts, fetch, images and frame navigation are blocked.
- There is no privileged host API.
- `window.TriuneArtifactState.set(value)` saves bounded JSON; `.get()` restores it on initialization.
- Password/file inputs are excluded from automatic restoration; arbitrary heap state requires explicit serialization.
- Browser phone emulation does not establish physical mobile-wrapper behavior.
