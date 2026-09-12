# Sender to Filter — Thunderbird add-on implementation plan (rev 2)

## Context

Thunderbird can create a *new* filter from a message but has no way to append a sender to an *existing* filter. The user wants a right-click entry in the message list that does that. The MailExtension API has no filters namespace, so the add-on pairs a normal MailExtension with a small Experiment API that edits the internal `nsIMsgFilterList` the way Thunderbird's own FilterEditor does.

Rev 2 incorporates the September 12, 2026 feasibility review. Main changes: automatic edits are limited to filters whose logic can be preserved (pure OR or single-condition), every add is one validated batch with rollback on save failure, the menu lifecycle uses generation-checked immutable snapshots, multi-account selections are rejected, the address route uses the exact `Is` operator, and the target matrix now includes release 155.

Decisions with the user:

- Name **Sender to Filter**; menu label **Add Sender to Filter**.
- Picker: dynamically built submenu of the account's filters, plus "New filter from sender…" and "Manage filters…".
- Match rule: address mode adds `From is user@example.com` (exact parsed-address match, same operator the built-in editor uses). Domain mode adds `From contains @example.com`, labelled in the UI as a text match because `Contains` is a plain substring search on the From header.
- Targets: ESR 140, ESR 153, release 155 (155.0.1 shipped September 9, 2026). Manifest V2. Minimum 140.

Working location: new project at `~/development/sender-to-filter` (use `change_directory` first). Git init, MPL-2.0.

## Thunderbird internals this relies on

Verified against ESR 140 and ESR 153 sources (hg.mozilla.org release tags) and the GitHub mirror; line numbers are from 153 unless noted.

- **Term construction** (`mailnews/search/content/FilterEditor.js` ~l.109–134): `filter.createTerm()`, set `attrib = Ci.nsMsgSearchAttrib.Sender`, `op`, copy `term.value`, set `.attrib` and `.str`, assign back, `booleanAnd`, `filter.appendTerm(term)`. The built-in prefilled editor uses `op = Is`.
- **`Is` vs `Contains` on From** (`mailnews/search/src/nsMsgSearchTerm.cpp` `MatchRfc822String` ~l.1032): `Contains` short-circuits to a substring match on the decoded header text; every other operator parses the header and compares each name and address individually. So `Is user@example.com` is an exact address match and `Contains @example.com` also matches `x@example.com.evil` and display names.
- **Rollback path** (`mailnews/search/src/nsMsgFilter.cpp` `SetSearchTerms` ~l.366): assigning `filter.searchTerms = savedArray` replaces the list and clears the expression cache, exactly like `AppendTerm` does. The getter returns a clone of the array, so a snapshot taken before mutation is safe to restore.
- **Filter list** (`mail/base/content/mailWindowOverlay.js` `MsgFilters()` ~l.1294): `folder.getEditableFilterList(msgWindow)`, msgWindow created with `Cc["@mozilla.org/messenger/msgwindow;1"].createInstance(Ci.nsIMsgWindow)`. `saveToDefaultFile()` persists; the list object is the live one used for incoming mail.
- **Save exclusions** (`nsMsgFilterList.cpp` ~l.841, `nsMsgFilter.cpp` ~l.751, `FilterListDialog.js` ~l.914): `temporary` filters are skipped on save; `unparseable` filters are written back from their original buffer, so edits to them are silently lost. Thunderbird's own dialog refuses to edit unparseable filters.
- **Match-all** (`nsMsgLocalSearch.cpp` ~l.388, `nsMsgUtils.cpp` ~l.1382, `nsMsgFilterList.cpp` ~l.717): a term with `matchAll` always matches; the serializer writes the `ALL` token and the loader only recognises it when the whole condition string is `ALL`. Clearing the flag or ORing past it is not a valid conversion.
- **Grouping** (`nsIMsgSearchTerm.idl`, `nsMsgLocalSearch.cpp` ~l.322): terms carry `beginsGrouping` / `endsGrouping`; the expression builder honours them. The editor's "second term decides AND/OR" rule is a UI approximation only.
- **Folder resolution in Experiments** (`mail/components/extensions/ExtensionAccounts.sys.mjs` l.615 in 153, l.574 in 140): `context.extension.folderManager.get(accountId, path)`.
- **Window resolution**: `context.extension.windowManager.get(windowId).window` gives the native window for `MsgFilters()` and prompts.
- **Menus** (`mail/components/extensions/parent/ext-menus.js` l.794, `schemas/menus.json`): `message_list` context, `onShown` with `selectedMessages` (needs `messagesRead`), `parentId`, `menus.refresh()`.
- **Author parsing**: `messengerUtilities.parseMailboxString()` (added in 137, returns a Promise of `[{name, email}]`; entries may lack `email`).
- **Experiment shape** (`thunderbird/webext-examples` `manifest_v2/experiment.restart`): closure `(function (exports) { … })(this)`, class extending `ExtensionCommon.ExtensionAPI`, `getAPI(context)`, `onShutdown(isAppShutdown)` calling `Services.obs.notifyObservers(null, "startupcache-invalidate")` unless app shutdown. `ExtensionCommon`, `Services`, `Cc`, `Ci` are globals there. `MailServices` via `ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs")`.

## File layout

```
sender-to-filter/
  manifest.json
  background.js
  api/senderToFilter/schema.json
  api/senderToFilter/implementation.js
  _locales/en/messages.json
  icons/icon-32.png  icons/icon-64.png     (optional; build script tolerates absence)
  scripts/build.sh
  README.md  LICENSE  CHANGELOG.md  .gitignore
```

## manifest.json

- `manifest_version: 2`, `name: "__MSG_extensionName__"`, `description: "__MSG_extensionDescription__"`, `version: "1.0.0"`, `default_locale: "en"`.
- `browser_specific_settings.gecko`: `id: "sender-to-filter@vault21inc.com"`, `strict_min_version: "140.0"`, `strict_max_version: "155.*"`.
- `background: { scripts: ["background.js"] }`.
- `permissions`: `menus`, `messagesRead`, `accountsRead`, `notifications`, `storage`.
- `experiment_apis.senderToFilter`: `schema: "api/senderToFilter/schema.json"`, `parent: { scopes: ["addon_parent"], paths: [["senderToFilter"]], script: "api/senderToFilter/implementation.js" }`. The implementation exports `exports.senderToFilter = class …`.

## Experiment API contract (single source of truth)

Namespace `senderToFilter`. All functions `async`. Shared types:

```
Folder      = { accountId: string, path: string }
Condition   = { op: "is" | "contains", value: string }     // value already normalised, lower-cased
FilterInfo  = { index: int, name: string, enabled: bool, eligible: bool,
                reason?: "temporary"|"unparseable"|"match-all"|"grouped"|"and-logic"|"no-terms"|"duplicate-name",
                present: "all" | "some" | "none" }        // relative to the conditions passed in
AddResult   = { status: "ok" | "not-found" | "ineligible" | "error",
                added: string[], existing: string[], message?: string }
```

| Function | Parameters | Returns |
|---|---|---|
| `listFilters(folder, conditions)` | `Folder`, `Condition[]` (may be empty) | `FilterInfo[]` in list order |
| `addConditions(folder, target, conditions)` | `Folder`, `{index, name}`, `Condition[]` | `AddResult` |
| `openNewFilter(windowId, folder, emailAddress)` | | `void`; calls `win.MsgFilters(emailAddress, folder)` |
| `openFilterManager(windowId, folder)` | | `void`; calls `win.MsgFilters(undefined, folder)` |

There is no confirmation prompt and no `force` flag in v1. Filters that would need a semantic rewrite are reported ineligible and shown disabled; the user can use "Manage filters…" for those.

### Eligibility (`isEligible(filter, list)`), evaluated in `listFilters` and again immediately before writing

A filter is eligible only if all hold:

1. `!filter.temporary` and `!filter.unparseable`.
2. `filter.searchTerms.length >= 1` (`no-terms` otherwise).
3. No term has `matchAll` (`match-all`).
4. No term has `beginsGrouping` or `endsGrouping` (`grouped`).
5. Either exactly one term, or every term from index 1 onward has `booleanAnd == false` (`and-logic` otherwise). Term 0's connector is ignored by both the editor and the matcher.
6. Its name is unique in the list (`duplicate-name`), so name plus index can be re-verified at write time.

Disabled filters (`enabled == false`) stay eligible; the add must not change `enabled` or `filterType`.

### `present` computation

A condition is present if some existing term has `attrib == Sender`, the same operator (`Is` for `is`, `Contains` for `contains`), and `value.str` equal case-insensitively. `present` is `all`, `some`, or `none` across the passed conditions.

### `addConditions` algorithm

1. Resolve folder via `folderManager.get`; get the editable list with a fresh msgWindow. Wrap the whole body in try/catch; any throw returns `error` (never propagate).
2. Locate target: `list.getFilterAt(index)` whose `filterName === name`; if that fails, fall back to `getFilterNamed(name)` only if the name is unique; else `not-found`.
3. Re-run eligibility; return `ineligible` with `reason` if it fails.
4. Partition conditions into `existing` (already present) and `toAdd`. If `toAdd` is empty return `ok` with `added: []` and no save.
5. `snapshot = filter.searchTerms` (clone of the term array; no existing term object is modified by this add, so restoring the array is a full rollback).
6. For each `toAdd`: create the term (`Sender`, op, value), `booleanAnd = false`, `appendTerm`.
7. `list.saveToDefaultFile()`. On throw: `filter.searchTerms = snapshot`, return `error` with `added: []`, `existing`, and the exception message. The live list and disk are then unchanged.
8. Return `ok` with `added` and `existing`.

`saveToDefaultFile` throwing on an unwritable file is the assumed failure mode; verification step 3 confirms it. If it turns out to fail silently, compare the file mtime and size before and after the call and treat an unchanged file as failure.

## background.js

All state lives in an immutable per-menu snapshot:

```
Snapshot = { gen, windowId, folder, senders: [{name,email}], conditions: Condition[], filters: FilterInfo[], domainMode }
```

`currentGen` (integer) and `current` (Snapshot or null) are module-level. `domainMode` is read from `storage.local` at startup (default false) and persisted on toggle.

Startup: `menus.create({ id: "stf-root", title: browser.i18n.getMessage("menuRoot"), contexts: ["message_list"], enabled: false })`. Child items are created per show and removed on the next show.

`menus.onShown(info, tab)` when `info.contexts` includes `message_list`:

1. `const gen = ++currentGen; current = null;` Remove all existing child items, set `stf-root` `enabled: false`, `await menus.refresh()`. Stale rows are never clickable while a build runs.
2. Gather messages: `info.selectedMessages.messages`, then `messages.continueList` while `id` is non-null. Stop at 100; if more remain, build a disabled row "More than 100 messages selected" and finish (root stays disabled).
3. Reject if any message lacks `folder`, or if `folder.accountId` differs across messages: disabled explanatory row, finish. Use `messages[0].folder` as the target.
4. Parse authors with `parseMailboxString`; keep entries with an email matching a permissive `local@domain.tld` check; dedupe emails case-insensitively. Build `conditions`: address mode gives `{op:"is", value: email}`; domain mode gives `{op:"contains", value: "@" + domain}` deduped by domain. Zero conditions: disabled row "No usable sender address", finish.
5. `filters = await senderToFilter.listFilters(folder, conditions)`.
6. If `gen !== currentGen`, abort without touching the menu (a newer build owns it).
7. Create rows under `stf-root`:
   - Disabled header: single sender `"Sender: user@example.com"`, multiple `"3 senders selected"`, domain mode appends `"(domain: @example.com)"` or `"(N domains)"`.
   - One row per filter, `id: "stf-filter-" + gen + "-" + index`, `type: "checkbox"`, `checked: present === "all"`, title = name, plus suffixes: `" (some already present)"` when `some`, `" (disabled)"` when not enabled, `" — unsupported: <reason>"` and `enabled: false` when ineligible.
   - Separator; checkbox `stf-domain-toggle` "Match whole domain (text match)" checked per `domainMode`.
   - Separator; `stf-new` "New filter from sender…" (title includes the first sender's address, suffix "(first sender only)" when several); `stf-manage` "Manage filters…".
8. `current = snapshot; menus.update("stf-root", {enabled: true}); await menus.refresh()`.

`menus.onClicked(info, tab)`:

- Parse `menuItemId`. For `stf-filter-<gen>-<index>`: ignore if `!current || gen !== current.gen`. Otherwise call `addConditions(current.folder, {index, name: current.filters[index].name}, current.conditions)` and show one notification: "Added 2, already present 1, to 'Newsletters'", or the `ineligible`/`not-found`/`error` message.
- `stf-domain-toggle`: flip, persist. Takes effect on the next show.
- `stf-new`: `openNewFilter(tab.windowId, current.folder, current.senders[0].email)`.
- `stf-manage`: `openFilterManager(tab.windowId, current.folder)`.

`menus.onHidden`: no-op (snapshot stays valid for the click that follows hide).

## Localization

`_locales/en/messages.json` keys: `extensionName`, `extensionDescription`, `menuRoot`, `headerSingle`, `headerMulti`, `headerDomainSingle`, `headerDomainMulti`, `rowTooMany`, `rowMixedAccounts`, `rowNoSender`, `rowExternalMessage`, `suffixSome`, `suffixDisabled`, `suffixUnsupported`, `reasonTemporary`, `reasonUnparseable`, `reasonMatchAll`, `reasonGrouped`, `reasonAndLogic`, `reasonNoTerms`, `reasonDuplicateName`, `menuDomainToggle`, `menuNewFilter`, `menuNewFilterFirstOnly`, `menuManage`, `notifyResult`, `notifyIneligible`, `notifyNotFound`, `notifyError`. Background code reads them with `browser.i18n.getMessage`.

## Build and install

`scripts/build.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
command -v jq >/dev/null || { echo "jq required"; exit 1; }
command -v zip >/dev/null || { echo "zip required"; exit 1; }
v=$(jq -r .version manifest.json)
mkdir -p dist
rm -f "dist/sender-to-filter-$v.xpi"
inputs=(manifest.json background.js api _locales)
[ -d icons ] && inputs+=(icons)
zip -r -X "dist/sender-to-filter-$v.xpi" "${inputs[@]}" -x '*.DS_Store'
```

No signing is required. Development install: Add-ons Manager > gear > Debug Add-ons > Load Temporary Add-on > `manifest.json`; reload after edits. Experiment errors surface in Tools > Developer Tools > Error Console. README explains the Experiment install warning, the address vs domain semantics, the 100-message cap, and which filters are unsupported and why.

## Verification

Use disposable profiles on Thunderbird 140 ESR, 153 ESR, and 155 release. Seed each with a POP account, an IMAP account, Local Folders, a unified Inbox, and a saved search spanning accounts. Before each destructive test, back up `msgFilterRules.dat`.

1. **Simple OR add**: filter with two `From is` OR terms and a move action. Add a sender. Check the editor shows "Match any", three conditions, action, order, enabled state, and execution types unchanged; check `msgFilterRules.dat`; restart and re-check; send mail from the new sender to an incoming-enabled filter and confirm it fires.
2. **Single-term filter** (term 0 with `booleanAnd` true): add a sender; editor shows "Match any"; matching works for both senders.
3. **Eligibility matrix**: match-all, pure AND (2+ terms), mixed connectors, grouped, temporary, unparseable, duplicate-name, disabled. Each ineligible one is greyed with its reason and cannot be clicked; the disabled-but-eligible one accepts the add and stays disabled.
4. **Duplicate**: re-add the same sender; result reports existing, file unchanged (compare hash).
5. **Save failure**: `chmod 000 msgFilterRules.dat`, add a sender; expect `error`, editor and file unchanged, no term in memory (re-open menu: `present` is `none`). Restore permissions, retry, expect `ok` with the term added once.
6. **Batch**: select five messages (two sharing a sender, one whose address is already present, one with a malformed From); expect added 2, existing 1, and the malformed one dropped from the header count.
7. **Domain mode**: toggle, add; term is `From contains @example.com`; toggle persists across restart; two senders on one domain add one condition.
8. **Selection edge cases**: 101 messages shows the cap row; messages from two accounts in the unified Inbox show the mixed-accounts row; an `.eml` opened from disk shows the external-message row; after any of those, right-click a normal message and confirm the root is enabled again.
9. **Race**: add an artificial 2 s delay in `listFilters`, right-click message A then quickly message B; confirm only B's rows appear and clicking them targets B's senders. Repeat across two 3-pane windows and confirm dialogs open on the invoking window.
10. **Editor open**: with Message Filters open on the same account, add a sender; confirm no error, and the change appears after closing and reopening the dialog. Then edit a filter in the dialog and close it; confirm the add-on's change survives (both paths share one list object).
11. **New/Manage routes**: "New filter from sender…" opens the editor prefilled with `From is <address>`; "Manage filters…" opens the manager on the right account.
12. **Lifecycle**: disable, re-enable, restart; no console errors, menu returns.
13. **Clean build**: `scripts/build.sh` on a fresh clone produces the XPI; install it in each profile.

## Out of scope for v1 (README "future work")

- Converting AND, grouped, or match-all filters (the user is pointed to Manage filters…).
- Matching on To/Cc, removing a sender, or a searchable popup picker.
- Repainting an open Message Filters dialog.
- Publishing to addons.thunderbird.net.
