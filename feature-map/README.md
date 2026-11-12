# Triune feature map

This directory is the maintained source for verifying Triune's user-facing
behavior. Read this index before driving the app, then use the matching feature
file as the recipe. Humans, reproduction and resolution agents, and triage all
read the same files.

The map describes features from the user's point of view: what the feature is,
every way a user reaches it, how to drive it, and the traps that invalidate a
run. It deliberately omits implementation details such as selectors, test IDs,
CSS classes, and source paths. Discover those at run time from the code and
the referenced tests; they change faster than the user journey.

## Skills

Read the relevant skill file directly when its capability is needed:

- [Verify Triune](skills/verify-omnigent/SKILL.md): start an isolated test
  environment, drive user journeys, and capture evidence. Its executable helper
  is `feature-map/skills/verify-omnigent/scripts/verify-env`.

These skills live here with the map so the whole package can be included or
excluded in replay. Harnesses do not automatically discover this directory:
start from this README, then read the linked SKILL.md before using its helper.
No slash-command registration or symlink is required for agents to read it.
Feature recipes also link existing repository skills outside this package;
check that they exist at the checkout revision before using them.

## Baseline preconditions

- Launch the isolated environment from the [skill](skills/verify-omnigent/SKILL.md#launch). It
  starts a server, runner, and mock model server on private ports with its own
  config, data, Claude, and Codex directories.
- Run drives that reuse this instance through `verify-env run -- ...` (or, in CI,
  `python -m dev.repro_env exec -- ...`) so the process receives the
  environment's server, model, and runner URLs. Tests marked "own environment"
  and component tests use the separate commands in each feature file.
- Never drive an instance this run did not start. A host daemon, a developer
  server, or another agent's environment is out of bounds.

## Driving conventions

- Prefer an existing test over hand-driving. Each feature file names the tests
  that exercise its entry points. For E2E UI tests, use `--ui-skip-build` after
  building this checkout, recording enabled, and an output directory under the
  evidence location. Server and component tests do not use browser flags.
- Hand-drive only the entry points no test covers, using Playwright against
  `OMNIGENT_REPRO_SERVER_URL`. Use roles and accessible names first.
- Script model replies with the mock helpers in `tests/e2e_ui/conftest.py`
  (`configure_mock_llm`, `set_fallback_mock_llm`, `reset_mock_llm`) before
  each journey. Journeys share mock state, so run them one at a time.
- Start each recipe from a fresh session unless its preconditions say otherwise.

## Proof and coverage

- Capture the user action and the resulting state, not only the final screen.
- UI proof is a recording or screenshot that shows the discriminating state,
  plus a read-only cross-check through the product REST API when one exists.
- Terminal proof includes the transcript; CLI proof includes the command,
  output, and exit code.
- Record the feature file and entry point with every artifact.
- **A fix is verified only when every entry point listed for the feature has
  proof, or has a stated reason it does not apply.** Proving one convenient
  entry point does not cover the others.
- Report an unreachable entry point with the attempted route and the unmet
  prerequisite. Do not report it as verified through a different path.

### PR demo standard

Choose evidence for the changed behavior, not a video for every PR:

| Change | Default evidence in the PR's Demo section |
| --- | --- |
| Interactive UI or user-visible harness workflow | Short recording of the real app or terminal, ideally 30–90 seconds, showing the action and outcome. |
| Static visual change | Screenshots of the changed state; before/after when useful. |
| Nonvisual backend, docs or tests | Test results, logs or transcripts in Test Plan; Demo may be N/A. Video is optional. |

- Record the actual candidate build. For bugs, show before/after when practical
  and label each revision. Generated illustrations are explanations, not proof.
- Caption each capture with the commit, harness/version (or N/A), entry point,
  SDK/native transport, self-hosted/upstream Managed deployment, and mock or live provider/model.
  State the action, observed outcome and what remains untested. Managed means
  upstream Omnigent's managed deployment; a Triune instance using a hosted model gateway remains self-hosted.
- A real-app recording may use a scripted provider: label it **mock** and do not
  claim live compatibility. Reuse an authorized verification run; do not make
  paid live calls just to obtain a video. Media supplements tests and proves
  only the behavior shown, not other entry points or unshown recovery paths.
- Keep captures outside the tracked tree, redact private data, and upload them
  as GitHub attachments linked from Demo. Never commit PR-only evidence media.
- If recording or upload is unavailable, explain the limitation in Demo, link
  the available evidence, and give exact manual verification steps. Ask for
  upload help when needed; do not fabricate a capture or hide the missing proof.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the
user-visible behavior. It then uses exactly these four H2 sections in order:

1. `Sub-features` lists short, stable IDs with one line each. Include the
   states worth exercising (loading, empty, error, and feature-specific
   variants). Reproduction and resolution handoffs refer to these IDs.
2. `How to get to it (user POV)` lists every user entry point, grouped by
   surface. Two surfaces that share code but look different to a user are two
   entry points. A missing entry point is a map bug.
3. `Driving it with the repro environment` starts with `Preconditions:` and
   pairs each entry point with the test that exercises it, or with manual steps
   and the observable result when no test does.
4. `Gotchas` lists look-alike surfaces, per-harness differences, and traps that
   waste or invalidate a run.

`tests/dev/test_verify_omnigent_feature_map.py` checks this contract; see
[Keeping the map current](#keeping-the-map-current) for everything it enforces.

## Features

- [Unified workspace](./unified-workspace.md) covers dockable views, resource ownership, durable branches, communication, layout pins and migration.

- [Contextual search](./context-search.md) covers region-aware find, sidebar search, synchronized occurrence navigation and authorized message-level results.
- [Button tooltips](./tooltips.md) covers canonical hover/focus guidance, shortcuts, disabled reasons and duplicate suppression.
- [Chat attachments](./chat-attachments.md) covers persistent files, safe previews, native agent uploads and captured workspace references.

- [Independent workspaces](./workbench-workspaces.md) covers selected resource targets, persistent file/search state and independently owned manual terminals.
- [Chat activity](./chat-activity.md) covers agents, live shell sessions and retained command/shell history.

- [Mobile Workspace](./mobile-workspace.md) covers the separate chat menu and Workspace button, shared tool tabs and remembered mobile navigation.

- [Notifications](./notifications.md) covers shared popups, retained history, required prompts, archive recovery and transfer activity from conversation, file-viewer and Files drawer bells.

- [Workspace Explorer](./workspace-explorer.md) covers file operations, transfers, selection, recovery, Git status and the optional agent-change overlay on desktop and mobile within the selected session.

- [Workspace diffs](./workspace-diffs.md) covers Git working-tree, commit/range and captured agent-turn/session comparisons, historical comment restrictions and verification limits across desktop and phone viewers.

- [Session orchestration](./session-orchestration.md) covers private-owner
  messaging, top-level worker creation, polling results and sharing restrictions.

- [Workspace content search](./workspace-content-search.md) covers runner-backed
  text search, result navigation and its release flag.

- [Harness acceptance](./harness-acceptance.md) standardizes the SDK/native
  checklist, connects existing bench probes to user journeys, and records
  per-harness coverage gaps separately from observed results.

- [Markdown editor](./markdown-editor.md) defines the file-editor CUJ, fixed
  before/after recordings, load probes, and complementary persistence checks.

- [Custom agents](./custom-agents.md) covers Settings listing, creation, summary
  review, deletion, and capability gating.

- [Remote agent launch](./remote-agent-launch.md) covers registered-agent
  discovery and selection through `triune run --server`, interactive and
  one-shot host launch, existing-session boundaries, and failure diagnostics.

- [Composer](./composer.md) covers the session and new-session composers,
  the model/effort pill, the configuration gear, and slash commands.
- [Terminals](./terminals.md) covers the Chat/Terminal switcher, the agent
  terminal, shell terminals, and terminal reattachment.
- [Native harnesses](./native-harnesses.md) is the matrix of every native
  harness against launch, authentication, model and effort selection,
  approvals, resume, and terminal behavior, with native disconnect test boundaries.
- [Preferences and config defaults](./preferences.md) covers local user/project
  defaults, invocation overrides, related settings surfaces, and the boundary
  between explicit cloud save/import, the shared-preference foundation, and
  deferred automatic following.
- [Login and host authentication](./login-and-host-auth.md) covers
  `triune login`, host daemon credentials, Databricks auth modes, and embedded
  authentication for project writes.
- [Sessions](./sessions.md) covers the sidebar, whole-session and message forks,
  custom-agent targets, fork access checks, archive, reconnect, and resume.
- [Video recordings](./video-rendering.md) covers inline chat playback, remote
  recording links, file previews, and download fallbacks.

- [GitLab merge requests](./gitlab.md) covers the shared MR panel, composer,
  Canvas links, and native tracking.

- [Azure DevOps pull requests](./azure-devops.md) covers the shared panel,
  composer, associations, partial results, and Canvas links.

## Seed scope

The original five recipes form the seed set. Completing this set means checking
the listed entry points against current source and recording how to verify
them, including explicit gaps. It does not mean that every recipe has been
driven live or that the whole product is mapped. Keep the backlog below
separate from a weekly correction pass; add another feature only as a separately
scoped change.

## Not yet mapped

These user-facing areas have no feature file yet, so this list is the checklist
of what to map next. An area that is only partly mapped is listed too. When you
map an area, remove it here in the same change.

**Web and apps** (UI test areas):

- Chat transcript, errors, and MCP status: `tests/e2e_ui/chat/` (only the
  composer, side-chat, model-picker, harness-visibility, reconnect, and
  terminal journeys are mapped)
- Approvals, permission cards, and the inbox: `tests/e2e_ui/approvals/` (only
  native edit-tool approvals are mapped)
- Sub-agents and the agent info popover: `tests/e2e_ui/agents/` (only Claude-native
  discovery and idle-runner performance are mapped in Native harnesses)
- Files and the workspace browser: `tests/e2e_ui/files/`, `tests/browser_ui/files/` (Explorer operations, Git status, workspace diffs and content search are mapped; other file previews remain partly mapped)
- Comments: `tests/e2e_ui/comments/`
- Sharing and session permissions: `tests/e2e_ui/collaboration/`
- GitHub integration: `tests/e2e_ui/github/`
- Scheduled tasks: `tests/e2e_ui/scheduled/`
- In-app browser: `tests/e2e_ui/browser/` (session cookie sharing is covered in
  Sessions; other browser behavior remains unmapped)
- Desktop app: `tests/e2e_ui/desktop/`
- Web sign-in: `tests/e2e_ui/auth/`
- Branding and base-path deploys: `tests/e2e_ui/branding/`, `tests/e2e_ui/base_path/`
- Hotkeys: `tests/e2e_ui/hotkeys/`
- Message rendering: `tests/e2e_ui/messages/` (only per-harness render parity,
  Claude shell-command settlement, and refused-delivery persistence are mapped)
- Mobile layout: `tests/e2e_ui/mobile/` (only composer labels, the composer
  after an unacknowledged send, sidebar rename under the keyboard, and
  terminal touch scroll are mapped)
- Onboarding and host import review: `tests/e2e_ui/onboarding/` (only the
  import review modal's link to Harnesses is mapped)
- Visual snapshots: `tests/e2e_ui/visual/`

**CLI commands:**

- Setup and diagnostics: `triune setup`, `triune config`, `triune doctor`,
  `triune diagnose`, `triune debug`, `triune usage` (config defaults are
  mapped; credential configuration and the other commands remain unmapped)
- Install lifecycle: `triune upgrade`, `triune update`, `triune uninstall`
- Other running-agent and server workflows: `triune run` (local/native modes),
  `triune start`, `triune stop`,
  `triune server`, `triune attach`, `triune resume`, `triune session`,
  `triune import`
- Bundled agents and the Copilot harness: `triune polly`, `triune debby`,
  `triune copilot`
- Installing reusable agents: `triune agent`
- Integrations, extensions, and remote sandboxes: `triune integration`,
  `triune extensions`, `triune sandbox`

**Partly mapped:** embedded authentication covers project writes and supporting
account-context tests; other resource APIs and real identity-provider journeys
remain unmapped. Native disconnect recipes cover Codex transport/startup,
completed Claude children after handoff, and browser stream recovery, not live
reconnect across every harness. Network
interruptions for claude-native are tracked as scenario rows in
`docs/network-resilience.md`, driven by the resilience lab in
`tests/e2e/resilience/`. The
header-menu/custom-agent fork combination still needs a manual browser drive.

**No UI test lane yet:** Slack, the iOS and Android apps, policies and cost
budgets, MCP servers, sandbox providers, and smart routing.

## Keeping the map current

- **Every PR, enforced:** `tests/dev/test_verify_omnigent_feature_map.py` fails
  when a referenced test is renamed or removed, a feature file breaks the entry
  contract, a native harness has no matrix row, or a UI test area or CLI command
  is neither mapped nor listed under [Not yet mapped](#not-yet-mapped). It also
  checks that the harness acceptance checklist maps every registered bench
  probe; this is a documentation check, not a harness acceptance run. It runs
  in CI and in the E2E UI workflow, so UI-only PRs are checked too.
- **Every PR, advisory:** when a PR changes user-facing code, the Polly review
  adds a non-blocking note if the change adds or removes an entry point that the
  matching feature file does not reflect.
- **Weekly:** the feature-map upkeep workflow checks feature files against
  source and runs their referenced tests. Scheduled runs are report-only;
  opening an automatic correction PR requires an explicit
  apply run after validation. An incomplete or blocked pass must identify its
  gaps and must not publish corrections. A real product regression is reported,
  not documented away.
- **After review:** when a reviewer says a change missed a surface, add that
  surface to the feature file in the same change.
