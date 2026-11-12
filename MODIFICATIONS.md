# Triune modifications

Triune is an independently maintained agent workspace based on Omnigent.
This record and the retained Git history identify inherited material and our changes.

| Source boundary | Reference |
| --- | --- |
| Upstream base | Omnigent `v0.20.0`, https://github.com/omnigent-ai/omnigent |
| Imported custom baseline | `4646d0bbd9492eed3bff0e95d39f8ac85d1b1eb8` |
| New product repository | https://github.com/MrStrenggeheim/triune, branch `main` |

The baseline includes the custom dockable workspace, independent resource views, Explorer, search, attachments, terminals, notifications and workspace controls.
Those previously Apache-licensed features retain their original permissions.

## Triune product changes — 2026-11-12

- Rebrand application, onboarding, CLI and current documentation as Triune.
- Preserve the approved three tilted strokes mark, accent palette and shared UI components.
- Add the primary `triune` command while preserving legacy command aliases, Python imports, environment variables and saved state compatibility.
- Install the backend and both SDKs from the Triune repository at the same ref.
- Keep the upstream Apache license and notices, and apply PolyForm Noncommercial 1.0.0 to new own material with required Triune attribution.
- Route live workspace-file references to the File Editor with configurable pane reuse, captured-original downloads and compact comment controls.
- Retain Explorer and transcript geometry through layout changes, reduce scrollbar rescans, and restore sidebar hierarchy and Git indicator consistency.
- Reuse shared density, notifications, workspace pickers and view-opening controls, and recover subchat quote creation without duplicating a failed child.

[LICENSING.md](LICENSING.md) defines scope and the required notice.
Git diffs against the imported baseline identify exact modified paths and lines.
