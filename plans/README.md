# Implementation plans

Generated September 12, 2026 using the improve skill. The user requested a plan for synchronizing complete Thunderbird filter rules across chosen accounts, including account-specific folder destinations.

| Plan | Title | Priority | Effort | Depends on | Status |
|---|---|---|---|---|---|
| [001](001-shared-filters.md) | Keep complete filters synchronized across chosen accounts | P2 | L | Native prerequisite gate in Step 1 | TODO |

The plan is grounded in commit `c831217176ac46b2e317d72253196d88b5736a81`. The checkout was clean before adding these planning files. JavaScript syntax checks and all 31 current tests passed during planning. No extension source code was modified.

Execute the seven steps in order: native proof; model/identity; privileged adapter; coordinator/recovery; management UI; sender-menu integration; package and release validation. Step 1 must establish persistent identity, safe cloning, detached editing, and nonmutating disk inspection before production writes are enabled.

This is a selected feature plan, not a general codebase audit. Server-side rules, other add-ons, the user's accounts, and current incoming-mail behavior were not audited. Existing single-account native-test evidence does not prove the proposed feature.

Considered and rejected: identity based only on names; symlinked whole rules files; an additional message-processing engine; automatic bidirectional merge; and promises of a cross-account atomic transaction. Sender-only synchronization was not selected by the user.

A delivery copy of plan 001 is also saved at:
`/Users/thedaego/Documents/Codex/2026-09-12/rev/outputs/sender-to-filter-shared-filters-plan.md`

The canonical plan is this repository's `plans/001-shared-filters.md`. Update its status here when implementation actually begins or finishes. Do not commit, push, publish, or install into a normal Thunderbird profile as part of planning.
