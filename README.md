# Sender to Filter

Share complete Thunderbird filters across chosen accounts, add senders from messages, and create tags directly in the filter editor.

Right-click one or more messages, choose **Add Sender to Filter**, then choose a filter. The add-on adds the unique sender addresses in one batch and reports how many were added or already present. Existing conditions, actions, ordering, enabled state, and execution types are preserved.

Sender additions support filters with a single condition or ungrouped OR conditions. Filters with AND conditions, grouping, “match all messages,” no conditions, duplicate names, or temporary/unreadable definitions are shown as unsupported. **Manage filters…** opens Thunderbird's own editor route for those cases. An otherwise supported disabled filter can be updated and remains disabled.

In Thunderbird's **Filter Rules** dialog, choose a **Tag Message** action and click **New Tag…** beside its dropdown. Enter a name and color in Thunderbird's native dialog. The new tag is selected for that action immediately, while your other actions and unsaved filter edits stay intact. This works in editors opened from Thunderbird's menus as well as from this add-on, including editors already open when the add-on starts.

Cancelling the tag dialog creates nothing. Once created, a tag is available throughout Thunderbird and remains available even if you cancel the filter editor. Filter changes are saved only when you accept the filter dialog. Creating tags does not depend on the sender-addition eligibility rules above.

**Run filters on every Inbox**

Click **Run Filters** beside **Get Messages**, before **New Message**, at the top of the folder pane. In a narrow sidebar the button shows its filter/play icon; its tooltip and accessible name say **Run filters on all accounts’ Inboxes**.

One click runs each independent IMAP/POP account’s enabled manual filters against that account’s Inbox, in its own saved filter order. This includes ordinary filters and each account’s local shared copies, once each. It does not expand shared groups or depend on the selected folder, message, or account. Disabled, temporary, unparseable and incoming-only filters are excluded; accounts with no eligible filters need no run. Local Folders, news/feed and other account types are not targets. A participating deferred POP/Global Inbox account, missing Inbox, open Filter Rules editor or active Message Filters run blocks execution with an explanation.

Accounts run sequentially. Progress appears below the toolbar, and the button is disabled in every mail tab/window until the run finishes. **Stop** finishes the current Inbox and skips the remaining accounts; it does not undo processed messages. Errors report partial work without automatically retrying message actions. Saved filters, enabled states and shared definitions are not changed. As with Thunderbird’s native manual filtering, matching messages receive the actions configured in those rules.

**Mark every Inbox read**

Click **Mark All Read** beside **Run Filters** to mark all messages in every independent IMAP/POP account’s Inbox as read, including accounts with no filters. This uses Thunderbird’s native folder operation. Other folders, flags, filter rules and the selected folder stay unchanged; IMAP read flags synchronize through Thunderbird normally, including after reconnecting when used offline.

Both toolbar actions are disabled across mail tabs/windows while either runs. The status below the toolbar reports completion or partial work. **Stop** skips any remaining Inboxes. As with Run Filters, unavailable Inboxes and deferred POP/Global Inbox accounts prevent the action from starting and show an explanation. Narrow sidebars show compact icons with tooltips that explicitly identify the all-account Inbox scope.

**Install**

1. Download/build `sender-to-filter-1.2.0.xpi`.
2. In Thunderbird, open Add-ons and Themes, then the gear menu → Install Add-on From File.
3. Select the XPI and accept the installation permission.

For development, use Debug Add-ons → Load Temporary Add-on and select `manifest.json`. Reload the temporary add-on after changes. Thunderbird's Error Console shows startup and menu errors.

The add-on uses an Experiment API because Thunderbird's public extension APIs do not expose message filters or controls inside the native filter editor. Thunderbird consequently requests **full, unrestricted access to Thunderbird and your computer**. The implementation uses Thunderbird's services for filter, tag and message operations; it uses no external service and has no telemetry. Disabling/uninstalling the add-on removes its controls and leaves saved filter changes, created tags and processed messages in place.

The manifest targets Thunderbird **140 through 156**, covering ESR 140, ESR 153, and release 156. This version range is an intended compatibility scope. See `VALIDATION.md` for what was actually checked; a manifest declaration alone is not a runtime test.

**Matching behavior**

- Address mode adds Thunderbird's native **From is** condition, like its built-in new-filter editor. The comparison is case-insensitive and exact against parsed mailbox names and addresses. A display name equal to the supplied address can also match; this is Thunderbird's native behavior.
- **Match domain text in From** adds **From contains @example.com**. This is a substring search on decoded From text. It also matches `person@example.com.evil` or matching display-name text, and does not include `person@sub.example.com`. The toggle takes effect the next time the context menu opens and persists across restarts.
- The selection is limited to 100 messages and 100 unique sender addresses. Larger selections are rejected with an explanation. Malformed addresses, addresses without a dotted domain, address literals, and quoted local parts are skipped.
- For ordinary filters, messages must belong to one account; the destination follows the first message’s current folder. When shared groups exist, mixed-account selections can target a shared group. External/attached `.eml` messages remain unsupported. The shared group’s account count describes where the rule changes, not where the selected messages came from.
- **New filter from…** uses only the first usable sender when several are selected and opens Thunderbird's native editor. The menu makes this limitation visible.
- Editing an incoming-enabled filter affects future filtering without requiring a restart. A disabled or manual-only filter retains its existing execution settings. Existing messages are not automatically filtered by an add.

**Build and check**

The extension has no third-party runtime dependencies and no npm install step.

```sh
npm run check
npm test
npm run build
```

Checks use Node.js 20+; packaging uses Bash, `jq`, and `zip`. The build includes only runtime files and writes `dist/sender-to-filter-1.2.0.xpi`. Unit tests, native-test Experiments, documentation, and the planning document are excluded.

`dist/` contains installable `.xpi` packages. `test-results/` holds local native-test JSON reports, diagnostic logs and screenshots referenced by `VALIDATION.md`. Both directories are generated and ignored by Git.

Native checks require Python 3 and an installed Thunderbird executable:

```sh
python3 scripts/test-thunderbird.py --binary /Applications/Thunderbird.app/Contents/MacOS/thunderbird
```

On macOS, the runner first copies the application into its temporary directory, excludes Mozilla’s updater executables, disables updates by policy, and ad-hoc signs only the disposable copy. It then creates a fresh marked profile, configures it offline, seeds local test filters, loads the production Experiment through its real schema, and verifies persistence, native matching, duplicate handling, and rollback on a real file-save failure. It also opens real filter/tag dialogs to check creation, cancellation, duplicate names, multiple editors, dynamic action rows, and saved tag actions. It stops only its own test process and removes the profile and temporary application copy. Results, logs, and screenshots are saved under `test-results/` by default; `--output` can select a different result path. It never opens your normal Thunderbird profile. Pass a different `--binary` to check another installed version.

The native tests simulate a write failure by selecting a destination whose parent is an existing regular file. Changing the existing file to mode `000` is not reliable because Thunderbird's safe writer can replace a file when its parent directory remains writable. File mtime and size are also not treated as proof of persistence; the tests reopen and inspect the saved rules.

The complete shared-filter suite adds production integration and restart checks:

```sh
python3 tests/native_runner_test.py
python3 scripts/test-thunderbird.py --binary /Applications/Thunderbird.app/Contents/MacOS/thunderbird --shared --output test-results/shared-native-check.json
```

`--shared` adds offline IMAP/POP fixtures, complete-rule cloning, all supported action/trigger preparation, ownership/alias checks, private-copy inspection, production draft editing, create/append/repair/unlink, native shared labels, and real manual filtering of synthetic local messages through both run buttons. A second Thunderbird process verifies restart persistence. The runner removes the disposable profile after both processes finish. Add `--visible` to show its test windows; current release checks use visible mode, with earlier ESR checks in headless mode. On macOS, run from a normal terminal or approved unsandboxed execution: the runner refuses Codex's seatbelt sandbox because macOS application registration aborts there. Runner unit tests start no Thunderbird processes.

**Implementation notes**

`background.js` handles message selection, parsing, localized menus, settings, and notifications. Menu mutations are serialized, and every actionable row carries a generation ID. A completed immutable snapshot survives hide-before-click event ordering; unfinished builds are cancelled on hide or superseded by a later show.

`api/senderToFilter/implementation.js` resolves the native folder and filter, rechecks eligibility, deduplicates operator/value pairs, and appends terms synchronously in a single batch. Existing term objects are never modified. Any exception during construction, append, or save restores the original term array via Thunderbird's setter, which also clears its expression cache. It reports rollback failures separately if restoration itself fails.

The Experiment also listens for native filter-editor windows and observes action rows to add **New Tag…** buttons. It reuses Thunderbird's tag dialog and tag service, refreshes open action dropdowns without changing their selections, and selects the new key only in the invoking action. Window listeners, row observers, and buttons are removed on shutdown. Tag creation does not write the filter list.

The Experiment depends on Thunderbird internals. Relevant references are the release versions of [nsMsgFilter.cpp](https://hg.mozilla.org/releases/comm-esr153/file/THUNDERBIRD_153_0esr_RELEASE/mailnews/search/src/nsMsgFilter.cpp), [FilterEditor.js](https://hg.mozilla.org/releases/comm-esr153/file/THUNDERBIRD_153_0esr_RELEASE/mailnews/search/content/FilterEditor.js), and [mailWindowOverlay.js](https://hg.mozilla.org/releases/comm-esr153/file/THUNDERBIRD_153_0esr_RELEASE/mail/base/content/mailWindowOverlay.js).

**Shared filters (1.2.0)**

Click the filter icon in Thunderbird's left **Spaces Toolbar** to open **Manage shared filters** in a tab. Clicking it again returns to that manager tab; closing the tab lets the next click open it again. The icon supports light and dark themes. You can also open the manager from **Manage shared filters…** in the message menu or the add-on’s options page.

1. Choose an existing supported source filter and the accounts to include. The source account is included.
2. For each additional account, choose **Create a copy** or explicitly link an existing filter. The numbered **Filter order preview** highlights the copy among that account’s other filters. Change **Insert new filter at position** to place a new copy; linked filters keep their existing positions. Choose every move/copy destination; the account name is shown beside each folder. Local Folders and another account can be explicit destinations.
3. Review the complete rule, enabled state, triggers, destinations, existing rule being replaced, and local positions. Save to apply the reviewed change.

Each group shares conditions, actions and their order, name, description, enabled state, and execution triggers. Filter positions stay local; earlier filters can change which messages reach the shared rule. Creating or changing a rule does not run it against existing messages. Sharing is confined to this Thunderbird profile.

Thunderbird’s **Message Filters** window marks linked copies with a **Shared** badge. The badge does not rename the filter or change its enabled checkbox. Hover over it for guidance, and use **Manage shared filters…** for synchronization status and edits across linked accounts. Unrecognized ownership markers display **Shared link issue**.

The **Run automatically** column controls automatic filtering at each filter's configured times. **Run selected filters (N)** runs only the highlighted rows, including unchecked filters; its count and **Will run** preview show the names and folder scope. With no highlighted rows, the button is disabled and a selection hint appears.

**Run all enabled filters (N)** is a separate action: it takes every checked filter in the current account's complete list, including filters hidden by search, in list order. Its own preview shows those filters and their scope. It does not change the highlighted rows, search, enabled states or saved rules.

**Run shared filters across all linked accounts (Inboxes)** is checked by default and applies to both run buttons. Each included shared filter runs on the **Inbox in each account linked to that filter**, using that account's copy and mapped destinations. Ordinary filters run only on the chosen **Folder for this account**. Uncheck the option to run all included filters only on that chosen folder. The picker is enabled whenever either run action needs it. When ordinary and shared filters target the same Inbox, they run together once in their local list order.

Before a cross-account run processes any messages, the add-on checks every linked copy and Inbox. Missing or changed copies, incomplete synchronization and open filter editors block the run and show an explanation. Accounts run sequentially with progress and a **Stop filtering** button; the new local **Run all enabled filters** action also supports Stop. Stopping or encountering an error can leave messages already processed; the result reports completed folders and possible partial work, with no automatic retry. Shared synchronization itself never runs existing messages.

**Edit shared rule…** opens a draft. **Edit conditions and actions…** uses Thunderbird’s native editor with the selected reference account. Cancel/close writes nothing; native OK only accepts the draft. The manager’s preview and Save publish it. Changing or reordering folder actions requires reviewing mappings again.

Independent IMAP and POP3 accounts are supported. Deferred POP/Global Inbox sources and destinations, shared or aliased rules files, custom filter backends, Local Folders as a member, RSS, NNTP, EWS, and virtual/unified targets are excluded. New accounts are never enrolled automatically. A file whose physical identity cannot be confirmed is blocked.

Supported rule shapes are a single condition, flat OR, flat AND, and ALL. Sender-menu additions support only single/OR; AND/ALL remain editable in the manager. Grouping, mixed connectors, custom/DB-property terms, unparseable rules and unsupported actions are rejected in full. Standard conditions must be valid in every selected account and execution context; configured custom message headers are preserved.

| Actions | Independent IMAP | Independent POP3 | Supported execution contexts |
|---|---|---|---|
| Move, copy (explicit folder mappings) | Yes | Yes | Incoming, manual, after junk, outgoing, archive, periodic |
| Tag, priority, junk score | Yes | Yes | Same six contexts |
| Mark read/unread, star, delete | Yes | Yes | Same six contexts |
| Stop execution, ignore thread/subthread, watch thread | Yes | Yes | Same six contexts |
| Forward, reply/template, POP-server-specific, custom, unknown | No | No | Deferred |

This table follows Thunderbird’s native action widgets. Native preparation checks all six contexts on both account types, and persistence tests cover all 13 supported actions. Actual incoming-mail execution remains a separate manual check in `VALIDATION.md`.

When groups exist, **This account** and **Shared filters** are separate menu sections. Managed copies cannot be changed through the ordinary sender API. One shared click deduplicates senders once and updates the group’s chosen accounts. A checked shared row means every copy was verified current; partial results remain unchecked.

The manager reports each account independently. A successful save on one account is retained if another fails. **Retry pending accounts** reuses the recorded intent and does not duplicate successful copies. Read-only status scans never overwrite drift. Account/folder/tag changes can trigger bounded retries of known failures; conflicts and uncertain persistence require review.

For **Needs review**, choose **Use this account’s version**, restore the shared definition through **Review and resolve…**, or stop sharing. Missing copies require explicit relinking/recreation. For duplicate ownership, explicitly choose the intended copy; the preview lists additional copies whose markers will be removed while their rules remain intact. A deleted/unavailable account can be removed from membership without claiming its unavailable native file was changed.

**Stop sharing this account/group** leaves native rules in place and removes ownership only after saved-file verification. Rules continue to run. Disable/uninstall stops synchronization and removes editor controls; saved native copies and tags remain. Do not remove the shared-state storage as a reset: corrupt/unknown data is preserved with writes blocked, and orphaned ownership markers are never silently adopted.

`lib/shared-model.js` validates portable definitions, identities, fingerprints and the bounded recovery journal. `lib/shared-coordinator.js` owns durable intent/checkpoints and the queue shared with ordinary sender writes. The native adapter builds independent rules, compares live state with scratch-file observations, saves one account at a time, and verifies the saved result. No cross-account atomic transaction is promised. Inspection of old, corrupt or differently formatted rule files may require an ordinary Thunderbird save before sharing.

See [Plan 001](plans/001-shared-filters.md) for the refreshed baseline, implementation record and remaining release qualification. Publishing to addons.thunderbird.net, network-mail delivery validation and installation into a normal profile are separate from this local implementation.

Licensed under MPL-2.0. See `LICENSE`.
