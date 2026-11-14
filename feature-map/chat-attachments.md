# Chat attachments

Users preview and download conversation files through authenticated, session-owned resources.
Generated attachments keep their original bytes; workspace references use their source message's captured filesystem and snapshot on first preview or download.

## Sub-features

- `footer-alignment`: file icon, metadata block, size and controls center together on single-line and wrapped footers.
- `responsive-footer`: wide media cards put filename, metadata and original download on one row; narrow cards retain two rows without horizontal overflow.
- `image-geometry`: image and card fit the original ratio under a shared 256px media-height cap; footer paths use available width without fixed half-width limits.
- `uploads`: the composer accepts ordinary files up to 50 MB independently of model interpretation; supported native filesystem delivery remains available within its quotas.
- `images`: raster images and SVG render in image elements, open in the shared lightbox and download as originals.
- `documents`: PDF uses the existing PDF viewer; Markdown uses the existing rendered preview; source code and structured text use bounded highlighted or plain text.
- `html`: isolated HTML preview has an opaque sandbox and restrictive content policy, with source and original download.
- `media`: browser-supported audio/video plays with controls; unsupported codecs retain download access and a clear error.
- `other-files`: Office documents, archives and other binaries retain a compact filename/type/size card and download.
- `native`: `triune attach-file PATH --session CHAT --server URL` uploads locally authorized bytes; native agents can use their session environment variable.
- `generated`: Codex viewed/generated images, supported inline byte outputs, native provider image-generation results and `upload_file` results become durable file references.
- `scope`: message references retain their original workspace/environment, owner and filesystem generation; switching workspace never reinterprets a path.
- `security`: arbitrary Markdown paths cannot read the server filesystem; traversal, outward symlinks and cross-session file IDs are refused.
- `persistence`: explicit uploads survive deletion of their source, reload and reconnect; authorized workspace-reference snapshots survive source deletion after their first preview.
- `presentation`: inline references show only the filename, a descriptive file-type icon and a full-path tooltip; explicit attachments use compact rows below message text.
- `states`: loading, malformed data, missing files, unsupported previews and size limits remain visible without breaking the conversation.

## How to get to it (user POV)

- Composer: attach, paste or drop files, then send; open a file's label or use its download control in the user message.
- Assistant: click an attached image to enlarge it, open a file label for its preview, or download the original.
- Native agent: run `triune attach-file output/report.pdf`; supply `--session` and `--server` outside an agent session.
- SDK agent: use `upload_file` for a workspace file; the result card remains outside folded tool details.
- Markdown: local images, file links and path citations open the original message's authorized resource; explicitly attach temporary files outside the workspace.
- Phone: use the same cards and dialogs within the narrow conversation layout.

## Driving it with the repro environment

Preconditions: follow the [verification skill](skills/verify-omnigent/SKILL.md) with temporary files and an isolated host; the native Codex case uses the real CLI and a mock model.

- Desktop/phone upload and native CLI attachment, zoom, exact download, text/isolated HTML preview and reload: `tests/e2e_ui/files/test_chat_attachments.py::test_chat_attachments_preview_download_and_persist`.
- Local Markdown image, table formula, workspace switch and source deletion: `tests/e2e_ui/files/test_chat_attachments.py::test_local_markdown_image_and_table_math_use_captured_workspace`.
- Real Codex viewed image, source deletion and reload: `tests/e2e_ui/files/test_chat_attachments.py::test_codex_viewed_image_becomes_a_persistent_chat_attachment`.
- All file families, session ownership, traversal/symlink checks and durable reference snapshots: `tests/server/routes/test_chat_attachments.py`.
- Provider byte persistence, malformed/oversized isolation, MIME and model replay: `tests/runtime/test_chat_attachment_outputs.py` and `tests/runtime/test_content_resolver.py`.
- Native viewed/generated events and local-reader bounds: `tests/native/test_attachment_upload.py`.
- Filename-only path chips, original Markdown preview/download and deleted-source reload: `tests/e2e_ui/files/test_chat_attachments.py::test_inline_file_reference_keeps_filename_and_original_preview`.
- File card, sandbox, media controls, errors and query identity: `web/src/components/ChatAttachment.test.tsx`.
- Image fitting, lightbox and responsive footer geometry: `web/src/components/SessionImage.test.tsx`, `web/src/components/ImageLightbox.test.tsx` and `tests/browser_ui/chat/test_current_refinement_iteration.py`.
- Live file-only messages and stream finalization: `web/src/lib/blockStream.test.ts`; fork references: `tests/stores/test_chat_attachment_fork.py`.

## Gotchas

- Preview/download availability does not promise that the selected model can interpret the contents.
- Use explicit attachment registration for delivery that must survive immediate deletion; a Markdown path is snapshotted only after an authorized preview/download.
- Messages written before captured scopes existed require explicit attachments; they do not silently bind to today's workspace.
- URL-only remote provider outputs are not fetched by the server; attach downloaded bytes through the agent's authorized tools.
- SVG remains an image; HTML never receives application-origin privileges.
- Text previews show at most 512 KiB, while downloads preserve the complete stored file.
- Native wrappers need separate physical-device acceptance; phone-width web evidence is not an iOS/Android binary test.
