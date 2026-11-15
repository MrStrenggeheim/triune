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
- Large HTML and source-chat routes: `web/src/components/ChatAttachment.test.tsx` and `web/src/components/blocks/ChatMarkdown.fileLinks.test.tsx`.
- Original bytes, source deletion, session association and permission denial: `tests/server/routes/test_chat_attachments.py`.
- Upload a 740KiB+ HTML tool and render its fence; interact near its tail, then change Appearance and density.
- Hide/reveal, reload and inspect restored state; inspect source/downloads, then try its file ID from another chat and expect access denial.
- Open the self-contained export as a linked HTML file; verify controls and kit styles work without external assets.

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
