# Validation

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
