# Changelog

## 1.2.0

- Synchronize complete supported filters across explicitly selected IMAP/POP accounts, including actions, enabled state, execution triggers and per-account folder destinations.
- Add the shared-filter manager with source/link previews, detached native editing, conflict review, explicit duplicate/missing-copy recovery and marker-only unlinking.
- Add a light/dark filter icon to Thunderbird's Spaces Toolbar that opens the shared-filter manager in a tab and returns to it on later clicks.
- Preview each account’s filter order with the new or linked copy highlighted, update insertion placement as it changes, and show the position field only when creating a copy.
- Align **Edit conditions and actions…** with the reference-account dropdown, with matching control heights and wrapping on narrow screens.
- Mark shared copies in Thunderbird’s native Message Filters window and distinguish unrecognized shared links.
- Make manual runs process included shared filters in each linked account's Inbox by default, with a prechecked scope checkbox and an unchecked single-folder option. Preserve local order and destinations, preflight every copy before processing messages, and report progress, cancellation and partial failures without automatic retry.
- Clarify manual filtering with **Run automatically**, a counted **Run selected filters** button and filter/folder previews. Add a separate **Run all enabled filters** action covering the current account's full list, including search-hidden rules, with the same shared-account scope option and preserved selection/search/flags.
- Add shared sender destinations for mixed-account selections while preserving ordinary filter behavior and rejecting managed-copy bypasses.
- Persist desired changes before native writes, checkpoint each account, verify saved files through private copies and recover interrupted operations without duplicating successful saves.
- Extend strict schemas, localization, package checks, failure/restart tests and native integration across ESR 140/153 and release 156.
- Isolate macOS test applications as well as profiles: remove updaters only from the disposable copy, disable updates there and refuse sandboxed startup. This prevents a pending update in the installed application from being invoked by later tests.

## 1.1.0

- Add **New Tag…** beside each **Tag Message** dropdown in Thunderbird's filter editor.
- Reuse Thunderbird's name/color dialog and select the created tag while preserving other actions and unsaved filter edits.
- Support already-open editors, multiple windows, and added/changed action rows; remove controls when the add-on is disabled.
- Verify real tag/filter dialogs, cancellation, duplicate names, selection preservation, and saved tag actions in an offline disposable profile.

## 1.0.0

- Add senders to compatible existing message filters from the message-list context menu.
- Support exact native From comparisons and an optional domain-text mode.
- Reject unsupported filter logic and mixed-account or oversized selections.
- Save additions in one batch with live-state rollback on failure.
- Include generation-checked menus, localized feedback, built-in editor routes, packaging, and automated checks.
