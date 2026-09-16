# Implementation plans

Generated September 12, 2026 using the improve skill. The user requested a plan for synchronizing complete Thunderbird filter rules across chosen accounts, including account-specific folder destinations.

Baseline refreshed and implementation authorized September 16, 2026.

| Plan | Title | Priority | Effort | Depends on | Status |
|---|---|---|---|---|---|
| [001](001-shared-filters.md) | Keep complete filters synchronized across chosen accounts | P2 | L | Native prerequisite gate in Step 1 | IMPLEMENTED — 1.2.0 local package; manual qualification remains |

The current implementation baseline is commit `45502831acd1e96d2d35343c0e88e28cdfafde68`, version 1.1.0, with a clean checkout, passing JavaScript syntax checks, and 33 passing Node tests before implementation. Version 1.1.0 supplies native tag creation; shared filters target 1.2.0 after validation. The original September 12 planning baseline was `c831217176ac46b2e317d72253196d88b5736a81`.

Execute the seven steps in order: native proof; model/identity; privileged adapter; coordinator/recovery; management UI; sender-menu integration; package and release validation. Step 1 must establish persistent identity, safe cloning, detached editing, and nonmutating disk inspection before production writes are enabled.

All seven implementation steps are present in the 1.2.0 runtime and package. The current suite has 110 Node tests, eight runner tests, and 147 native checks on Thunderbird 156, including production creation, complete action preparation, detached editing, append, duplicate-marker repair, unlink, process restart, native shared-copy labels, actual manual filtering of synthetic POP messages and the sidebar manager launcher. Manual filtering now distinguishes **Run automatically**, **Run selected filters (N)** and **Run all enabled filters (N)**, with separate name/folder previews and full-account enabled runs that preserve selection and search. Both run buttons use the prechecked shared-account scope: linked Inboxes by default, the chosen folder when unchecked. A filter icon in the Spaces Toolbar opens or returns to the shared manager tab. The earlier ESR 140/153 runs contain 100 checks each and predate these native-list/manual-run/sidebar extensions. Runtime evidence is recorded by version in `VALIDATION.md`. The manager has browser visual checks in light/dark and a narrow viewport, plus integration tests against the real coordinator, including its contextual filter-order preview.

The remaining qualification is production-XPI installation and interactive lifecycle/menu use in disposable profiles, actual network-mail delivery, and Windows/Linux runtime checks. No normal Thunderbird profile was used for filter testing, and no commit/push/publication was performed. One early launch encountered the installed app’s pending Mozilla update; the isolated application runner now prevents that path. See `VALIDATION.md` for the incident and evidence boundaries.

This is a selected feature plan, not a general codebase audit. Server-side rules, other add-ons, the user's accounts, and current incoming-mail behavior were not audited. Existing single-account native-test evidence does not prove the proposed feature.

Considered and rejected: identity based only on names; symlinked whole rules files; an additional message-processing engine; automatic bidirectional merge; and promises of a cross-account atomic transaction. Sender-only synchronization was not selected by the user.

A delivery copy of plan 001 is also saved at:
`/Users/thedaego/Documents/Codex/2026-09-12/rev/outputs/sender-to-filter-shared-filters-plan.md`

The canonical plan is this repository's `plans/001-shared-filters.md`; the delivery copy is historical and is not kept in sync. Update the status here as implementation progresses. Commits, pushes, publication, and installation into a normal Thunderbird profile require separate authorization.
