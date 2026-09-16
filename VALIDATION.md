# Validation

## Shared filters — 1.2.0 candidate, September 16, 2026

The full model, native adapter, coordinator, manager and shared sender menu are implemented and included in `dist/sender-to-filter-1.2.0.xpi`. Baseline was `45502831acd1e96d2d35343c0e88e28cdfafde68` / 1.1.0. The historical checkpoints below describe earlier states, not the current runtime.

- `npm run check`: production syntax and JSON checks pass.
- `npm test`: **110 Node tests pass**, including the 33 pre-existing checks. Tests cover strict portable definitions, ownership, folder slots, exact snapshots, intent limits, crash/checkpoint recovery, storage failure before writes, partial/native I/O failure, uncertainty, stale previews/revisions, the shared/ordinary queue, drift/relink/unlink, duplicate cleanup, final account revalidation, mixed-account menus, partial-success notification counts and trusted runtime-message routing.
- Six manager/coordinator tests execute the production page logic and coordinator: create/preview/back/cancel do not write, explicit save does; native-edit cancellation preserves state; unlink preserves the rule; incomplete mappings block preview; corrupted state remains visible and preserved. Filter-order checks cover first/middle/last insertion previews and empty accounts, and confirm the chosen order matches the saved lists; linking preserves the selected position and hides the insertion control; reopening reads the saved lists. Invalid positions are not previewed, and unselected accounts cannot block form validation. HTML-like rule names are rendered as text.
- Eight native-list unit tests verify ownership-based labels (including same-name independent filters and malformed links), selection scope, recycled rows, preservation of native cells/data, already-open/loading windows, cleanup and reinitialization. They also exercise checked/unchecked interception, single-use requests, queued/active cancellation, restoring controls and clearing progress while preserving unrelated native runs. The latest cases cover separate selected/enabled counts and previews, folder changes, enabled filters hidden by search, missing folders, local enabled-run completion/failure/cancellation, native localization restoration and cleanup when another add-on wraps the same native update function.
- Four manual-run controller tests cover all linked Inboxes, ordinary/shared mixed selections with local order and no duplicate execution, complete preflight before any actions, account identity and rule changes, missing/duplicate/unknown copies, failure, cancellation and stopping later jobs without retry. A background bridge test verifies fresh durable state is read while holding the coordinator queue, and invalid state cannot start a run.
- The package test builds and opens the **actual XPI** with Python zipfile. It verifies the exact runtime inventory, byte-for-byte source hashes, manifest entry points and matching version. No fixtures, test-only Experiment, scripts, docs, plans or dependencies are in the production archive.
- `python3 tests/native_runner_test.py`: **8 runner checks pass** without launching Thunderbird.
- Native suite: **100 checks pass on each ESR version and 147 on release 156** on macOS. Each result covers the seed process and a separate restart of the same disposable profile, with successful exits and no timeout. ESR runs precede the later native-list, manual-run and sidebar features; their runtime checks were run on 156.

| Binary | Final evidence | Result |
|---|---|---|
| Thunderbird 140.0 ESR | `test-results/shared-esr140-check.json` and `.log` | 100 passed, headless |
| Thunderbird 153.0 ESR | `test-results/shared-esr153-check.json` and `.log` | 100 passed, headless |
| Thunderbird 156.0 release | `test-results/filter-run-ux156-check.json` and `.log` | 147 passed, visible-window mode |

The ESR applications came from Mozilla’s official release archive, were mounted read-only, and had their original application signatures verified. The runner launched only updater-free, locally signed temporary copies, using offline profiles containing synthetic accounts and no real credentials. Version numbers above are reported by the actual runtime. Intermediate headless 156 evidence is in `test-results/shared-implementation-check.json`.

Native coverage includes the existing sender/tag behavior, all 50 initial shared prerequisites, production API/schema loading, independent IMAP/POP eligibility, rejection of hard-linked rules files, complete Unicode rule export, all 13 supported actions prepared for each of six execution bits on both account types, production detached-editor cancel/close/accept without saving the source, create and saved readback, ordinary-API ownership bypass rejection, sender append and duplicate no-op, explicitly selected duplicate-marker cleanup, unlink preserving the independent rule, and persisted production state after a real restart. Full action persistence/order was tested separately by the prerequisite fixtures; preparing an action for a trigger is not proof of mail delivery through that trigger.

The manager was also inspected in a local browser using synthetic fixtures: desktop light/dark appearance, a 390-pixel viewport without horizontal overflow, source selection, edit/preview/save and explicit account-qualified destinations. Those browser checks use a fake browser API and establish UI behavior/layout, not Thunderbird integration. Visible Thunderbird native dialogs were driven by the test harness; no manual user-profile testing is claimed.

The later filter-order UI refinement was checked in the local browser in desktop light and 390-pixel dark layouts. New copies appear among existing filters, disabled filters are labelled, long names wrap, and placement changes keep the highlighted row visible inside the scrollable list. Linking an existing filter hides the position field and highlights its retained position. Syntax, Node and actual-XPI package checks were rerun and the 1.2.0 XPI rebuilt.

The subsequent **Edit conditions and actions…** alignment fix scopes the layout to its reference-account row. Browser inspection of the production HTML/CSS with synthetic accounts measured both controls at 42 pixels high with identical vertical centers at a 1280-pixel viewport. In a 390-pixel dark preview, the button wraps below the dropdown without horizontal overflow. The focused manager tests and actual-XPI inventory/content check were rerun, and the 1.2.0 XPI rebuilt; no new native filtering run was needed for this HTML/CSS-only change.

Native Message Filters indicators were then verified in the isolated 156.0 application. Twelve additional checks cover two account windows, ordinary/shared/mixed selections, search with reused rows, checkbox behavior, reordering, badge placement without shifting the enabled column, and unchanged native rule data/file bytes before and after closing the manager. The actual chrome screenshot `test-results/shared-indicators156-check-shared-list.png` was inspected: the Shared badge and folder-only Run Now note are visible. The earlier 100-check visible 156 result remains in `test-results/shared-visible156-check.json`. No actual mail was processed by the indicator checks; Run Now’s single-folder behavior was confirmed in the installed application’s `FilterListDialog.js` source, which passes only the selected rows and one chosen folder to `applyFiltersToFolders`.

The subsequent user-requested manual-run feature changes that default for selected shared filters. The 123-check result includes the production native button, parent/background event bridge, durable group lookup, native filtering service and completion callback. Synthetic messages in two linked POP Inboxes are marked read and moved to their own mapped destinations even when the selected filter is disabled; other folders and an unlinked account remain untouched. Unchecking the new option exercises the original native handler on one chosen folder. A changed linked copy blocks all message actions, Stop cancels a queued request, and shared state remains current after execution. The inspected actual chrome screenshot is `test-results/shared-run156-check-shared-run.png`. This proves offline POP manual execution of those actions on 156, not network delivery, every action/trigger, IMAP message processing or ESR runtime behavior for the new controls.

The sidebar refinement uses Thunderbird's supported `spaces` API and bundled light/dark SVG icons without adding permissions. Eight further native assertions verify one labelled icon, opening/selecting the manager in a new tab, returning to it without duplicates, and reopening it after closure, both before and after process restart. The actual screenshot `test-results/shared-space156-check-shared-space.png` was inspected and shows the filter icon and manager page in Thunderbird. The earlier 123-check manual-run result remains available separately. An initial sidebar-harness attempt compared the loaded extension URL with the package's archive URI; correcting that test-only expectation produced the passing 131-check result.

The manual-filtering UX refinement adds **Run automatically**, counted **Run selected filters** and **Run all enabled filters** buttons, and separate filter/folder previews. Sixteen further native assertions verify labels and layout, counts independent of search/selection, a usable enabled-run action with no selected rows, execution of hidden enabled rules in list order with Stop Execution, exclusion of disabled selected/shared rules, preserved search/selection/flags/rule bytes, mixed shared-Inbox/local-folder processing and the unchecked single-folder scope. Production shared state remains current afterward. Actual screenshots `test-results/filter-run-ux156-check-shared-list.png` and `test-results/filter-run-ux156-check-shared-run.png` were inspected. The 147-check result includes successful seed/restart exits in isolated application copies. During harness development, the column-width assertion was corrected to use the native font size, and enabled fixtures were set to manual-only triggers so inserting synthetic messages could not run incoming rules before the button was tested. This remains offline POP manual-execution evidence, not network delivery or new ESR/platform qualification.

### Remaining qualification

1. Install the production XPI in a disposable profile and manually exercise its right-click menus, manager tab and disable/re-enable lifecycle, including multiple mail windows and long/many filter names. Automated integration uses the same runtime files plus a test-only Experiment, not an installed marketplace package.
2. Deliver actual mail through enabled native incoming filters and verify all intended actions/triggers, plus manual execution on connected IMAP Inboxes. Existing messages are never run automatically by shared synchronization; manual-run tests explicitly process synthetic offline POP messages.
3. Run the native/UI suites on Windows and Linux and rerun the new native-list/manual-run/sidebar cases on ESR 140/153. macOS covers normalized aliases and physical hard links. On macOS/Linux, ambiguous file metadata is disambiguated through the system’s synchronous `/bin/test -ef` identity check; when that check is unavailable, the adapter blocks ambiguous files. This path is verified on macOS only.
4. Validate interactions with third-party filter backends/terms/actions and platform-specific native dialogs before broad deployment. Unsupported rules and nonstandard backends are deliberately blocked.

### Test-runner incident and correction

An early macOS sandboxed launch aborted during application registration before the harness ran. Its report identified the Python-launched test process; the normal Thunderbird process remained running. The runner now rejects that sandbox before profile creation or launch.

A later direct launch of the installed application encountered its pending Mozilla update. Local macOS logs identify `org.mozilla.updater`: at **14:29:46 EDT on September 16**, it registered `/Library/LaunchDaemons/org.mozilla.updater.plist` and its privileged helper. The daemon was removed about two seconds later; background registration was removed at 14:30:03. The installed application changed from 155.0.1 to 156.0. This unintended application-update side effect explains the Thunderbird installation prompt and Login Items notification; it was not a new add-on dependency. No claim is made that the installed application remained unchanged throughout development.

The correction isolates the application as well as the profile: copy the bundle, exclude both updater executables, set DisableAppUpdate/DisableTelemetry policies, ad-hoc sign/verify only that temporary copy, and launch it with `--no-remote` and a fresh marked profile. The source application is never modified by the corrected runner. Tests reject stale results, nonzero exits and timeouts and terminate only the child they launched. Both profile and copied application are removed afterward. Runner tests verify these boundaries.

No normal-profile accounts/messages/filters were used for feature tests. No commit, push, publication or 1.2.0 installation into the normal profile was performed. Logs retain native synthetic-folder notification and headless/shutdown diagnostics; all listed assertions and process exits passed.

## Historical checkpoints

**Shared-filter model — September 16, 2026 (Step 2)**

`lib/shared-model.js` implements the portable model without browser storage, native-list access, or account writes. It is not referenced by the manifest or included in the production XPI. Version 1.1.0 runtime behavior is unchanged.

- `npm run check` passes, including the new model's syntax check.
- `node --test tests/shared-model.test.cjs`: **32 model checks** pass. `npm test`: **65 total Node checks** pass, including the 33 existing checks.
- Coverage includes all 13 typed actions; sharing versus sender-add eligibility; exact Unicode/byte-string ownership handling; account binding and duplicate markers; deterministic SHA-256 and persistent-list fingerprints; explicit folder slots and reordered actions; corrupt/future storage preservation; verified after-state consistency; UTF-8 intent limits with checkpoint capacity reserved; explicit repair versus ordinary retry; missing/conflicting replicas; partial success and JSON restart recovery; stale operation results; immutable inputs across an asynchronous digest; and retaining members until detach cleanup is verified.
- These tests use plain data in an isolated JS context and independent digest vectors. They establish model behavior, not storage durability, native account writes, UI behavior, or end-to-end synchronization. Those remain Steps 3–7.
- `git diff --check` passes. Thunderbird was not launched for Step 2. The native results below are from Step 1 and were not rerun for this pure-model change.

**Shared-filter prerequisites — September 16, 2026 (Step 1)**

Plan 001 now uses baseline `45502831acd1e96d2d35343c0e88e28cdfafde68`, version 1.1.0, and targets 1.2.0 for the future complete feature. Step 1 is test-only; production synchronization, the manager, and shared sender actions are not implemented.

- At the Step 1 checkpoint, production syntax checks and all **33 existing Node checks** passed.
- `npm run build` passes. Inspection of the actual 1.1.0 XPI confirms every packaged file matches baseline runtime bytes, with no native test Experiment, fixtures, scripts, or plans included. Shared probes do not change the shipped add-on. Harness syntax checks and `git diff --check` also pass.
- `python3 tests/native_runner_test.py`: **7 checks** pass without starting Thunderbird. These verify marked-profile enforcement, stale-result rejection, timeout/crash handling, explicit profile isolation, visible mode, and the macOS sandbox guard.
- `python3 scripts/test-thunderbird.py --binary /Applications/Thunderbird.app/Contents/MacOS/thunderbird --shared --output test-results/shared-native-check.json`: **74 native checks** pass on **155.0.1**, including 24 existing checks and 50 shared prerequisites. Both the initial process and a fresh restart process exited successfully.
- New native checks cover distinct IMAP/POP rules files; physical path aliases and deferred POP rejection; single/OR/AND/ALL terms with quotes, parentheses, Unicode and a configured header; all 13 planned action types and action order; explicit destinations; independent mutable objects; ownership-description bytes; native editor acceptance; detached cancel/close/accept; open manager/editor detection; replacement/rollback preserving unrelated entries, temporary entries and logging; private inspection of missing/empty/old/corrupt files; and restart readback.

The native parser can silently accept a truncated attribute. Inspection therefore reserializes only its private scratch copy and rejects changed bytes. Exact-byte comparison is conservative: manually formatted files may need an ordinary Thunderbird save before they can be shared. The native description field is an ACString byte string; the fixture explicitly encodes UTF-8 descriptions before appending ASCII ownership markers. The fixed bundled helper is loaded using Thunderbird's Experiment-loader options, not an arbitrary caller URL.

Evidence: `test-results/shared-native-check.json` and `.log`; the `.png` remains the existing tag-editor screenshot. The dialogs were driven programmatically in headless mode. ESR 140/153, visible human review, and incoming-message execution were not tested. Action serialization does not prove every account/trigger compatibility combination. Logs retain a native folder-notification error during synthetic account setup and headless/shutdown diagnostics; all asserted checks and both process exits passed.

The initial sandboxed macOS launch aborted in `_RegisterApplication` with SIGABRT before producing harness results. Its report identified the Python-launched test instance; the normal Thunderbird process remained running. The runner now refuses this sandbox before profile creation or app launch. Successful native runs used approved execution outside that sandbox and only fresh marked disposable profiles.

**Native tag creation — version 1.1.0**

September 16, 2026 — version 1.1.0, creating tags in the native filter editor.

**Checks passed at that checkpoint**

- Production JavaScript syntax checks and 33 Node.js checks. The new checks cover startup isolation, one-time listener registration, already-open/loading editor attachment, cleanup on disable, and reinitialization. These lifecycle checks use mocks.
- 24 checks inside a real **Thunderbird 155.0.1** process in a fresh, offline, disposable profile, including the 13 existing sender/filter checks below.
- Real filter and tag dialogs verified blank-name handling, duplicate-name rejection, cancellation, tag name/color creation, automatic key selection, preservation of other rows and other open editors, unsaved-filter preservation, added/changed/removed action rows, native filter acceptance, saved-rule reload, and keeping a created tag after cancelling the filter edit.
- The native layout check confirms the button is visible beside the dropdown. The captured chrome screenshot was inspected: both tag actions have a visible **New Tag…** button, with the action selectors and row controls intact.

Historical evidence is in `test-results/native-check-1.1.0.json`, `.log`, and `.png`. The tag-action reload uses a scratch copy of the disposable profile's rules file. The native runner packages the production files with test-only additions; `npm run build` excludes those additions from the installable XPI.

The new feature has runtime evidence on 155.0.1 only. ESR 140/153 and interactive disable/re-enable with an open tag dialog still need runtime checks. The earlier source inspections below apply to the original sender feature. No normal user profile was opened or changed.

**Original sender feature**

September 12, 2026 — initial implementation of the revision 2 plan.

**Automated checks passed**

- JavaScript syntax checks for the production background and Experiment.
- 31 Node.js checks against the production code: eligibility, preservation of original term references/actions/settings, batch deduplication, operator identity, rollback after append/save failures, retry, target revalidation, dialog window routing, pagination, account restrictions, domain settings, invalid selections, menu callback failures, overlapping builds, stale clicks, and hide-before-click ordering.
- 13 checks inside a real **Thunderbird 155.0.1** process using a fresh, offline, disposable profile: production schema/namespace loading, native eligibility, batch return values, saved-rule reloads, action/settings preservation, From matching, duplicate file no-ops, real file-save failure, live rollback, successful retry, and localization substitutions.

The native save-failure fixture points at a path whose parent is an existing regular file. The expected save exception occurred, the original file stayed unchanged, the live term list was restored, and retry saved exactly one new condition. A missing parent directory alone did not reliably force failure. The test fixture uses `InboxRule | Manual`; the broader `Incoming` constant also contains legacy script filter bits and is not a valid fixture type for this persistence test.

The `Is` comparison was checked against an exact mailbox, a longer address/domain, and a display name exactly equal to the requested address. The display-name case matches in Thunderbird and is documented in the README.

**Compatibility evidence**

| Version | Evidence |
|---|---|
| 140 ESR | Relevant API/term/editor source inspected at `THUNDERBIRD_140_0esr_RELEASE`; runtime testing pending. |
| 153 ESR | Relevant API/term/editor/persistence source inspected at `THUNDERBIRD_153_0esr_RELEASE`; runtime testing pending. |
| 155 release | Installed application APIs inspected and native checks passed on runtime-reported version 155.0.1. |

The manifest range permits 140 through 155. It is not evidence that every intervening release or platform was tested.

**Manual checks still needed**

1. Install the production XPI in disposable profiles for ESR 140 and ESR 153 and run the native harness against those installed binaries.
2. Inspect the actual right-click menu layout and checkbox behavior, including many/long filter names, supported disabled filters, and the domain toggle.
3. Exercise New/Manage dialogs in two windows and verify window ownership. Verify native context behavior for external `.eml` messages; outside the message-list context the entry can be absent.
4. Test POP global inbox, IMAP folders, unified folders, and saved searches spanning accounts. Confirm target filter ownership after moving messages between accounts.
5. Receive mail through an enabled incoming filter and verify its actual action without restarting. The automated native harness verifies saved conditions and native term matching, not network delivery or the full incoming-mail pipeline.
6. Edit the same filter from an already-open native editor, then reopen the manager and inspect both changes. Repainting an open manager is outside v1.
7. Disable, re-enable, and restart with the production add-on, and inspect OS notifications and error-console output in normal interactive use.

No existing user profile, account, message, or filter was used for testing. No commit, push, or publication was performed. The supplied planning document was preserved.
