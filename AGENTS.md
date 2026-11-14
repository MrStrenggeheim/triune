# Agent guidance

Guidance for AI agents (Claude Code, Copilot, Cursor, etc.) working in this
repository. See `CONTRIBUTING.md` for the full contributor workflow.

## Project instructions

These instructions and the linked repository documents are self-contained.
Follow any personal instructions supplied by the operator; a private knowledge
base or a particular home directory is not required to work on this fork.

## Local customizations

This checkout maintains changes on top of official release tags. Read
[the fork guide](docs/custom-fork.md) for startup commands, the upstream base
and the map of custom features. Keep that guide and the relevant feature map
current when changing a customization.
Keep each customization in a focused commit. Never edit installed package files.

## Reuse and design

Read `design-system/triune/MASTER.md` before changing workspace UI.

- Before changing UI, compare existing equivalents and reuse the complete shared component, tokens and interaction; verify sibling typography, tooltip shape, colors and focus/hover states against `design-system/triune/MASTER.md`.
- Search for and reuse existing helpers before adding code. Refactor an existing
  implementation if that avoids duplication.
- Treat local extensions as part of the whole product: reuse existing UI components, styles and interaction patterns, extend shared primitives when necessary, and preserve navigation and selection during background refreshes.
- Use descriptive names; avoid unexplained abbreviations and single-letter names.

## Test changes

Before adding test setup, read [the test guide](tests/README.md) and
[primitive catalog](tests/_helpers/README.md), then inspect the nearest scenario.
Reuse sufficient coverage unchanged or extend a compatible scenario. Keep input
matrices at the lowest reliable layer; retain E2E for distinct process, transport
or browser boundaries. Reuse primitives with explicit caller inputs and keep
faults and assertions in the test. Explain new setup or a separate E2E in the
PR's Test Plan (Repro uses `evidence`; Resolve uses `test_audit`). Count helper changes in
test LOC; fewer lines alone do not establish adequate coverage.

- Add a unit test for non-trivial functions, methods, and exported APIs. Add
  coverage when changed behavior needs it.
- Run the relevant tests before submitting. Document unrelated pre-existing
  failures in the PR description.

## Dependency changes

When raising a dependency floor or adding a dependency, keep it installable from
package mirrors that embargo new releases (see the dependency notes in
`CONTRIBUTING.md`) and run `just check-internal-mirror` when you can reach the
Databricks PyPI proxy. If a mirror lacks the version you need, keep the floor
below it and pin the newer release only in `uv.lock`; do not work around the
mirror with a local or temporary index. Never add the `dependency-floor-approved`
label yourself; a human maintainer adds it after checking the mirror.

## Committing

The `pre-commit` hooks are the local gate, and CI runs the same checks. They
run on `git commit` and again on `git push` only after they are installed:
`just ensure` does that (or `just hooks` on its own), once per clone. Worktrees
share the clone's `.git`, so one install covers them all.

- Never pass `--no-verify`. A hook failure is a finding to fix, not a gate to
  skip; the push hook will fail on the same commits anyway.
- Files written through shell heredocs or scripts are unformatted until a hook
  or `just lint` touches them. Before pushing web changes, run
  `cd web && pnpm exec prettier --check .` and read its exit code; do not judge
  hook output by grepping it.
- To check by hand, `just lint` runs the hooks over staged files and
  `just lint-all` over the whole tree. Fix what they report, re-stage, commit.

## Local development shortcuts

Use `just` for common tasks; run `just --list` for grouped recipes.

- `just ensure` — install/check prerequisites, including the git hooks
- `just run-ios` / `just run-android` — build/run mobile apps
- `just dev` / `just dev-mobile` — start the Triune dev pod
- `just electron-dev` / `just electron-build` — Electron desktop shell
- `just lint` / `just lint-all` — run pre-commit; `just hooks` — install the git hooks
- `just normalize-locks` — rewrite lockfile registries to PyPI/npmjs.org

## Pull requests

When you open a pull request, fill in the repo's PR template at
`.github/pull_request_template.md` (case-sensitive on Linux — note the lowercase
filename). Keep every section and checkbox row so reviewers can skim them,
except the optional Changelog section as described below.

- **Summary** — what changed and why.
- **Test Plan** — how you verified it.
- **Demo** — a **video or images** showing the change. Expected on contributor
  PRs for UI / frontend changes (check the "UI / frontend change" box under
  *Type of change*) so reviewers can see the new behaviour without checking out
  the branch. Use `N/A` for non-visual changes.
- **Type of change** / **Test coverage** — check all that apply (at least one
  each).
- **Coverage notes** — required if you checked "Manual verification completed"
  or "Not applicable".
- **Release notes** — choose exactly one Yes/No checkbox and keep both rows.
  Choose Yes only for outstanding user-facing features, bug fixes, UX changes,
  and breaking changes. Breaking changes must choose Yes. Features behind a
  feature flag are eligible only once the flag is enabled for users. Choose No
  for small fixes or improvements, features behind disabled flags, and internal
  changes with no user impact. This is the author's recommendation for
  maintainers curating the release notes.
- **Changelog** — if Release notes is Yes, write one line describing the change
  for users, including compatibility impact for breaking changes. If No, delete
  this section; the complete changelog still credits the PR using its title.

Generate the description from the actual diff and this session's context — lead
with the motivation, then the change. Don't pass a `--body` that skips these
sections.

### Demo media

Do not commit screenshots or recordings created only as PR or issue evidence.
Upload them as GitHub attachments and embed the attachment URLs in the PR's
Demo section or issue comments. Keep local captures outside the tracked tree,
and redact private data before uploading.

Commit media only when it serves maintained documentation, product assets, or
test baselines, not merely to obtain a public demo URL. If attachment upload is
unavailable, explain the limitation and ask for help instead of committing the
files as a workaround.

## Request backlog

Use the task checklist supplied by the operator or the fork's GitHub issues.
Private deployment notes are optional context, not project prerequisites.
Record new requests received during work immediately, including deferred discussions.
Before completing a turn, reconcile every unchecked request with implementation and verification; report outstanding items explicitly.

### Small implementation passes

- Treat this thread as intake: record each request once with an ID, acceptance condition and state (queued, implementing, verifying, delivered or blocked); keep proposals separate from approved work.
- Group related requests into the smallest independently useful pass; state its scope and next queue briefly, without requiring the owner to organize them.
- Before delegating, identify existing components to reuse and define behavior, shared interfaces and focused checks.
- Give each subagent a bounded task, explicit file ownership, acceptance checks and a concise handoff (files, results, risks); keep shared-file integration and delivery with the parent.
- Run independent tasks in parallel when useful; avoid overlapping edits and duplicate checks.
- Keep the built SPA unchanged during real-server browser journeys; rebuilding can remove hashed assets referenced by running servers.
- Finish shared-checkout verification before commits whose hooks temporarily stash unstaged files; source files and tests must stay consistent during a check.
- Once a pass enters verification, queue new requests and minor refinements for the next pass and name them in the implementation report; extend the current pass for material failures or explicit owner priority.
- Use focused tests during development, then one integrated verification and build per stable candidate; repeat affected checks after fixes, retain required hooks and activate only with authorization.
- Before reporting completion, reconcile the backlog and record commit, checks and activation state; finish ready passes without waiting for unrelated work.

## Finishing a task

When you finish a task, print instructions to the user on how to test it: the
commands to run, the inputs to provide, or the steps to reproduce so they can
verify the result themselves. Prefer verification that is best performed by a
human, such as concrete manual behavior checks, rather than only listing unit
test commands. Don't leave the user guessing how to confirm the work — tell
them exactly what to do.
Every implementation report must include a short owner-facing acceptance checklist with concrete actions and expected visible outcomes, affected desktop/mobile or appearance variants, activation state and outstanding limitations.

To drive the app yourself and prove a user-facing change on every entry point a
user can reach, start with `feature-map/README.md`, then read the relevant maps and linked skills.

## Deprecating features

When deprecating a feature, note the version in which it is expected to be
removed so we can clean it up when that version ships. Call out the deprecation
version in code (e.g. a `@deprecated` tag or comment naming the target release)
and in the PR/commit description, so there's a clear marker to act on later.

## Code comments

Keep comments short and focused on the code, not on the change history.

- **Keep them brief** — prefer one or two lines. Avoid comments longer than
  three lines; if you need more, the code likely needs refactoring or a doc
  string, not a wall of inline commentary.
- **Describe the scenario, not the PR** — explain *what* the code handles or
  *why* it exists, in terms a future reader needs. Don't reference PR numbers,
  issue numbers, or ticket IDs (e.g. `#1646`, `fixes JIRA-123`); the scenario
  should be clear without chasing external links.

## Database query names

Application stores use `make_named_managed_session_maker` and give every
session a stable semantic operation name. The session-level name must describe
the caller's intent rather than repeat SQL syntax; use a nested
`query_name_scope` only when one transaction needs distinct names for important
subqueries. Because the named session covers implicit flush and commit, don't
add an explicit `flush()` only to make a query name observable.

## Framework-owned instructions

Keep runtime lifecycle and metadata instructions separate from portable agent
instructions:

- Agent-spec and per-request instructions are user-authored. Framework-owned
  instructions are additive runtime behavior and are appended after them in
  `omnigent/runtime/prompt.py`.
- Keep the canonical instruction text and lifecycle gate in the owning framework
  module. Harness adapters should only transport the composed instructions; do
  not duplicate policy across adapters or add lifecycle metadata to `AgentSpec`.
- If framework instructions grow beyond a small ordered list, introduce a
  structured `FrameworkInstructions` value at the prompt-composition boundary.

## Product and licensing

The product is Triune; its primary command is `triune`.
Preserve legacy import, environment, protocol and saved-state identifiers unless a tested migration explicitly replaces them.
Read LICENSING.md before adding or copying source: inherited Apache rights and notices remain, while new own material uses PolyForm Noncommercial 1.0.0 unless separately marked.
Keep the three tilted strokes mark, selected accent and shared design components unchanged during branding work.
