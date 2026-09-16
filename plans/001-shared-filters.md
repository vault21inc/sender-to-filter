# Plan 001: Keep complete filters synchronized across chosen accounts

**Status:** TODO — planning only

**Project:** /Users/thedaego/development/sender-to-filter

**Planned at:** commit c831217176ac46b2e317d72253196d88b5736a81, September 12, 2026

**Category / priority:** Feature / P2

**Effort / risk:** L / medium-high; approximately 8–12 focused development days, including native integration and recovery testing. This is an estimate, not a delivery commitment.

**Dependencies:** None; complete the native feasibility gate in Step 1 before implementing synchronization.

The user selected **complete-rule synchronization**, including actions, with a destination-folder choice for each account. This plan specifies that feature; it does not authorize executing it during the planning task.

## 1. Outcome and product decisions

A user chooses an existing filter, selects accounts, and creates a **shared filter**. The add-on maintains one shared definition and one ordinary Thunderbird filter in each selected account. Updating the shared rule or adding a sender updates those copies. Thunderbird continues to execute its own native filters.

For example, “Newsletters” can match the same senders and mark messages read in both Work and Personal, while moving messages to Work/Newsletters and Personal/Reading respectively.

| Property | Shared behavior |
|---|---|
| Filter name and user description | Same across accounts. Internal ownership metadata is separate from the user description. |
| Conditions and AND/OR choice | Same terms, operators, values, and order. Preserve native matching semantics. |
| Actions | Same supported action types, parameters, and action order. |
| Move/copy destinations | Explicit mapping for each account and each folder action. |
| Enabled state and execution triggers | Shared. Changing these in the shared editor affects every member. |
| Position among other filters | Account-specific. Preserve existing positions; insert new copies at the bottom by default, with an explicit position choice in the preview. |
| Unrelated filters | Retain their definitions, relative order, and logging settings. |

“Complete” means that a supported rule is copied in full. Never remove unsupported terms/actions to make a rule eligible.

Decisions:

1. The shared definition stored by the add-on is authoritative. There is no permanently privileged source account after creation.
2. Edits through the shared editor or shared sender menu propagate automatically as part of that action.
3. Edits made directly in Thunderbird's ordinary filter editor cause **Needs review**. Do not automatically import or overwrite them.
4. A change can succeed on some accounts and fail on others. Report that honestly and offer retry. Do not claim a transaction across accounts.
5. Shared filters operate within one Thunderbird profile. This is not synchronization between computers or server-side filtering.
6. Creating or updating a rule does not run it against existing messages. Its enabled state and normal Thunderbird triggers govern subsequent execution.
7. Disabling/uninstalling the add-on stops synchronization; native copies keep their last saved behavior. Re-enabling resumes inspection before any pending write.
8. Ordinary, unshared filters retain the current v1 behavior.

## 2. Verified baseline and load-bearing source facts

The checkout was clean at the commit above before writing this plan. There is one commit, “init,” and no existing plans directory. The current extension is version 1.0.0, Manifest V2, targeting Thunderbird 140–155. It has no npm dependencies or install step.

Current verification performed for this plan:

- npm run check: passed.
- npm test: 31 tests passed.
- No build, native-profile mutation, or interactive Thunderbird test was performed during planning.
- Existing VALIDATION.md records 13 native checks on 155.0.1 from the preceding implementation task. Those checks cover the original single-account feature, not this proposed feature.

### Current implementation

| File | Relevant behavior |
|---|---|
| /Users/thedaego/development/sender-to-filter/background.js:116 | Selection collects up to 100 messages and rejects mixed-account selections at lines 133–136. |
| /Users/thedaego/development/sender-to-filter/background.js:190 | One account's filters are loaded into an immutable, generation-checked menu snapshot. |
| /Users/thedaego/development/sender-to-filter/background.js:238 | A click invokes one addConditions call for one filter. |
| /Users/thedaego/development/sender-to-filter/api/senderToFilter/implementation.js:43 | Sender additions are restricted to a single condition or flat OR conditions. |
| /Users/thedaego/development/sender-to-filter/api/senderToFilter/implementation.js:66 | Native lists are resolved from the selected message's current folder. |
| /Users/thedaego/development/sender-to-filter/api/senderToFilter/implementation.js:104 | addConditions resolves by name/index, snapshots terms, appends synchronously, and restores terms on failure. |
| /Users/thedaego/development/sender-to-filter/api/senderToFilter/schema.json | Only Folder, Condition, name/index Target, listing, adding, and native-dialog methods exist. |
| /Users/thedaego/development/sender-to-filter/tests/helpers.cjs:44 | Node tests execute production scripts in a VM with native/browser fakes. |
| /Users/thedaego/development/sender-to-filter/scripts/test-thunderbird.py:46 | The native runner currently packages a hard-coded list of runtime paths. It must include new modules/pages. |
| /Users/thedaego/development/sender-to-filter/scripts/build.sh:14 | Production packaging has a separate hard-coded runtime allowlist. |
| /Users/thedaego/development/sender-to-filter/sender-to-filter-implementation-plan.md | Historical rev 2 design. Preserve it; the implemented code and README correct some of its assumptions. |

Current single-account mutation pattern:

~~~js
// api/senderToFilter/implementation.js:130–145
// Keep validation, mutation and save synchronous within this API
// call. There is no await that can interleave another batch.
mutationStarted = true;
for (const condition of toAdd) {
  const term = filter.createTerm();
  term.attrib = Sender;
  term.op = operators[condition.op];
  const value = term.value;
  value.attrib = Sender;
  value.str = condition.value;
  term.value = value;
  term.booleanAnd = false;
  filter.appendTerm(term);
}
list.saveToDefaultFile();
~~~

Preserve this separation: background orchestration uses async operations; each privileged live-list mutation/save has a short synchronous critical section. Menu generations and the mutation queue solve different problems; keep both.

Match the existing plain JavaScript, two-space indentation, double quotes, explicit result objects, browser.i18n messages, and dependency-free node:test conventions. Do not add a framework, bundler, or database.

### Thunderbird facts affecting the design

- Thunderbird exposes account listing and account lifecycle events through the existing accountsRead permission. Account rootFolder is available within this extension's version range. Use native incoming-server filter lists for new shared operations, independently of where a selected message is stored. [Accounts API](https://webextension-api.thunderbird.net/en/mv2/accounts.html)
- The inspected nsIMsgFilter interface has filterName, filterDesc, terms, actions, enabled, and filterType, but no persistent per-filter UUID. The filter list's listId is a process-local sequence such as List1; it is not persistent identity. [Filter interface](https://hg.mozilla.org/releases/comm-esr153/file/THUNDERBIRD_153_0esr_RELEASE/mailnews/search/public/nsIMsgFilter.idl), [filter-list implementation](https://hg.mozilla.org/releases/comm-esr153/file/THUNDERBIRD_153_0esr_RELEASE/mailnews/search/src/nsMsgFilterList.cpp)
- filterDesc is written as the native description attribute. Use a strictly framed ASCII suffix for ownership and verify persistence/editor preservation before committing to that strategy. Never invent additional msgFilterRules.dat attributes. [Filter persistence](https://hg.mozilla.org/releases/comm-esr153/file/THUNDERBIRD_153_0esr_RELEASE/mailnews/search/src/nsMsgFilter.cpp#l751)
- Native OpenFilterList is not a read-only parser: it can create a missing file, rewrite an older format, or back up and truncate a corrupt file when given a message window. New inspection/readback paths must parse a private scratch copy with a null message window, never the account's original file. [Filter-service loader](https://hg.mozilla.org/releases/comm-esr153/file/THUNDERBIRD_153_0esr_RELEASE/mailnews/search/src/nsMsgFilterService.cpp#l126)
- Native flat conditions can be serialized from termAsString and booleanAnd and loaded into a fresh filter with list.parseCondition. ALL has a dedicated parser path. The inspected MsgTermListToString does not serialize grouping flags; grouped filters therefore remain unsupported. [Term serializer](https://hg.mozilla.org/releases/comm-esr153/file/THUNDERBIRD_153_0esr_RELEASE/mailnews/base/src/nsMsgUtils.cpp#l1382), [condition parser](https://hg.mozilla.org/releases/comm-esr153/file/THUNDERBIRD_153_0esr_RELEASE/mailnews/search/src/nsMsgFilterList.cpp#l717)
- Native FilterEditor accepts a supplied filter and list and signals successful acceptance through args.refresh and args.newFilter. Use a detached draft, never a live replica, for the shared editing route. [Editor initialization and acceptance](https://hg.mozilla.org/releases/comm-esr153/file/THUNDERBIRD_153_0esr_RELEASE/mailnews/search/content/FilterEditor.js#l71)
- Native action values are type-specific; reading every property from every action can throw. Move/copy uses targetFolderUri, priority uses priority, junk classification uses junkScore, and tagging uses strValue. [Action interface](https://hg.mozilla.org/releases/comm-esr153/file/THUNDERBIRD_153_0esr_RELEASE/mailnews/search/public/nsIMsgFilter.idl#l16)
- Deferred POP delivery can run both the originating account's filters and the destination account's filters. The native editor also disables after-junk filters on a deferred source account. Avoid duplicate application by excluding deferred accounts from the first release, as specified below. [Incoming-server ownership](https://hg.mozilla.org/releases/comm-esr153/file/THUNDERBIRD_153_0esr_RELEASE/mailnews/base/src/nsMsgIncomingServer.cpp#l903), [POP filtering path](https://raw.githubusercontent.com/mozilla/releases-comm-central/master/mailnews/local/src/nsParseMailbox.cpp)
- Address mode's native From is comparison can also match an identical display name. Domain mode remains a substring comparison against decoded From text. Keep the existing documentation and tests.

Cached ESR 153 release sources and the installed 155 application files were read during planning. Current online account/tag/storage documentation was also consulted. Revalidate native behavior on supported binaries in Step 1; source inspection is not runtime compatibility proof.

## 3. First-release support boundary

### Account eligibility

Support IMAP and POP3 accounts with their own inbox/filter pipeline, using Thunderbird's standard local filter-list backend.

Resolve accountId through MailServices.accounts.getAccount(accountId).incomingServer. For actual mutation, obtain server.getEditableFilterList(msgWindow), and confirm it corresponds to the standard live server list and an ordinary default rules file. Reject custom/separate editable backends. Account discovery and disk inspection follow the nonmutating loader protocol in Section 6 before requesting a previously unloaded live list.

For this release:

- Deferred POP accounts are displayed with an explanation and cannot be group members. Detect native deferral through server.rootFolder versus server.rootMsgFolder, not account labels.
- Accounts serving as another POP account's deferred destination are also excluded as members.
- Local Folders can be a move/copy destination, but not a shared-rule member.
- RSS, NNTP, EWS, extension-defined accounts, Unified Inbox, and virtual/search folders are not member targets.
- New accounts are never automatically enrolled.
- Reject a group whose distinct member accounts resolve to the same incoming server or the same physical rules file, including aliased paths. Validate file/list identity rather than assuming account IDs imply distinct storage.
- If a supported account is later changed to use deferral, mark affected groups Needs review before further writes.

This restriction avoids silently processing mail from accounts the user did not select and avoids installing the same rule twice in one POP delivery path. Expanding support for Global Inbox is a separate integration task.

### Rule eligibility

Sharing and sender addition are separate capabilities.

| Shape | Can share/edit as a complete rule | Can append senders from the context menu |
|---|---|---|
| One ordinary condition | Yes | Yes |
| Flat OR conditions | Yes | Yes |
| Flat AND conditions | Yes | No: point to shared editor |
| Exactly one ALL term | Yes | No: point to shared editor |
| Mixed connectors, grouping, ALL plus other terms | No | No |
| No terms, temporary, unparseable, legacy script filter | No | No |
| Third-party custom terms/actions or DB-property terms | No in this release | No |

Support native standard conditions that pass each target's search-scope validity check and round-trip without changes. This includes user-configured message-header conditions when Thunderbird can resolve them; do not create global custom-header preferences automatically. Preserve literal account addresses in conditions; do not reinterpret To/From values as account-relative placeholders.

Allow only known, nonzero execution bits: InboxRule, Manual, PostPlugin, PostOutgoing, Archive, Periodic, subject to target/action compatibility. Never use the Incoming aggregate as a value to assign; it includes legacy JavaScript bits.

Supported actions:

- MoveToFolder and CopyToFolder, using explicit folder slots.
- AddTag, using the profile's existing tag key.
- MarkRead, MarkUnread, MarkFlagged.
- ChangePriority and JunkScore, preserving validated native values.
- Delete, StopExecution, KillThread, KillSubthread, WatchThread, when valid for all selected accounts/triggers.

Defer Forward, Reply/template, POP server-specific actions, Custom, unknown action types, and invalid/uninitialized actions. Reject the entire rule with the particular unsupported action named. This is a capability boundary, not permission to drop actions.

Use native filter scope and term validity rules corresponding to FilterEditor.getFilterScope/getAvailable. Add an explicit action compatibility table based on the native action widgets and verify its supported combinations. A rule that cannot run equivalently on every selected account cannot be created as a group.

Filter positions remain local. Equal definitions cannot guarantee equal overall processing if earlier account-specific filters move/delete messages or stop execution. Explain this next to position selection; do not rearrange other filters automatically.

## 4. User flows

### Create a shared filter

Add **Manage shared filters…** to the context menu and expose the same page through options_ui with open_in_tab: true.

1. Choose a source account and existing filter. Show its complete rule, enabled state, and triggers. Disable unsupported sources with a reason.
2. Choose target accounts. The source account is included and its existing filter will become managed.
3. Each additional account explicitly chooses **Create a copy** or **Link an existing filter**. Similar names are suggestions only; they are never proof of identity.
4. Linking an existing filter shows its current rule and the changes that will replace it. Preserve its current position. Creating a copy defaults to the bottom and permits a position choice without moving unrelated filters.
5. Choose a destination for each account and each move/copy action. Suggest an existing same-relative-path folder only within that member's account, and require the mapping to appear in the accepted preview. Do not create folders automatically.
6. Preview the rule, affected accounts, exact account-qualified destinations, enabled state, triggers, and placements. A same-name collision must be explicitly linked or resolved by changing the shared name.
7. **Create shared filter** persists the operation intent and applies the copies. Show per-account results.

Folder mappings may explicitly target another supported account or Local Folders. Offer **Use this exact folder for every account** only as a deliberate choice with the destination account visible. Never copy an opaque source URI to every target as a default.

### Edit a shared rule

The page provides **Edit rule…**, an enabled toggle, account membership, and folder mappings.

Open Thunderbird's native FilterEditor on a fresh detached filter in a temporary list associated with a reference member account. The user chooses the reference account when needed; default to the first available member. Closing/canceling the dialog writes no native list and changes no stored group.

On acceptance, export the draft, validate it against all members, show the per-account result, and require the page's **Save shared rule** action. The native dialog edits only the draft; its OK button does not synchronize.

For folder actions, retain slot IDs only if the ordered folder-action subsequence (type and reference destination) is unchanged. If it changes, rebuild the affected slots and require mapping review. Never associate old mappings merely by the overall action array index after an edit/reorder.

An ALL or AND rule remains editable here. Adding a sender must not convert its logic.

### Add senders

With no shared groups, retain the current menu layout and single-account restrictions.

When shared groups exist, show **This account** and **Shared filters** sections/submenus. Exclude recognized managed copies from ordinary single-account mutation rows; show each shared group once, labelled with its account count.

Shared groups are deliberate destinations and may receive sender additions from any stored message, including selections spanning accounts. For mixed-account selections:

- Parse and deduplicate all usable senders with the existing 100-message/100-unique-sender limits.
- Disable the ordinary This account route with its existing explanation.
- Permit eligible shared-group rows because the group explicitly defines the destination accounts.
- Continue rejecting selections containing external/attached messages without a usable folder.

A shared click captures groupId, group revision, menu generation, window/tab, and normalized conditions. Recheck the group revision after entering the mutation queue. The displayed account count describes where the rule changes, not the origins of selected messages.

A checked row means all requested conditions are present in the canonical definition and every member is verified current. Partial/pending/conflict rows must not look fully checked. Clicking never removes conditions. If the canonical conditions already exist but a copy is pending, route to retry without creating another definition revision.

Report both condition counts and account results, e.g. “Added 2 senders to Newsletters; updated 2 of 3 accounts. Personal needs retry.” Never multiply the sender count by the account count.

### Handle drift, failure, and unlinking

The manager shows **Up to date**, **Updating**, **Pending retry**, **Needs review**, **Account unavailable**, or **Persistence uncertain** with per-account detail and the last inspection time.

On an external edit, offer:

- **Use this account's version**: import its complete supported definition as a draft, review mappings, then publish it to the group.
- **Restore the shared version**: preview the replacement against the newly observed version and explicitly apply it.
- **Stop sharing this account**: keep the current native filter as an independent rule and remove only this add-on's ownership marker.

Missing or duplicated markers require explicit relinking to a selected filter or explicit recreation. Never recreate a previously managed filter automatically just because it disappeared: the user may have deleted it intentionally.

**Stop sharing the group** leaves the current filters in place and removes their markers. Explain that the rules continue to run. Deleting native filters and automatically reverting every member to pre-sharing state are outside this release.

A detached/unlinked member with a missing account can be removed from the membership record without pretending to have changed an unavailable native file. Complete marker cleanup before discarding a still-accessible member's record.

## 5. Persistent identity and data model

Use one versioned browser.storage.local key, sharedFiltersV1. Keep domainMode unchanged. One background coordinator owns writes; options pages send typed runtime messages and do not write the storage key themselves. An absent key with no known groups initializes an empty state; corrupt data or an unknown schema version disables shared mutations and preserves the stored value for explicit recovery. Never silently reset it. Unknown ownership markers after storage loss remain unlinked native copies.

Conceptual schema (turn these types into explicit Experiment schemas and runtime validators):

~~~ts
SharedState = {
  schemaVersion: 1,
  groups: Record<GroupId, SharedGroup>
};

SharedGroup = {
  id: UUID,
  revision: number,
  definition: RuleDefinition,       // desired rule; can be ahead of a failed member
  members: Member[],
  operation: Operation | null,     // at most one unfinished operation per group
  lastCompleted: OperationSummary | null
};

RuleDefinition = {
  name: string,
  description: string,             // user text, without ownership suffix
  enabled: boolean,
  filterType: number,
  logic: "single" | "or" | "and" | "all",
  conditionText: string,           // native format, generated/validated in Experiment
  actions: ActionDefinition[]     // ordered; folder actions refer to stable slot IDs
};

Member = {
  id: UUID,                       // persistent replica identity
  accountId: string,
  accountIdentityHash: string,    // server key/type/endpoint/user/port identity
  folderMappings: Record<SlotId, FolderRef>,
  positionHint: number,           // placement only, never identity
  lastAppliedRevision: number | null,
  lastAppliedFingerprint: string | null,
  status: string,
  lastInspectedAt: string | null
};

FolderRef = { accountId: string, path: string };

Operation = {
  id: UUID,
  kind: "create" | "update" | "repair" | "detach",
  desiredRevision: number,
  beforeDefinition: RuleDefinition | null,
  targets: TargetOperation[],     // immutable ordered intent for each member
  startedAt: string
};

TargetOperation = {
  memberId: UUID,
  mode: "create" | "adopt" | "replace" | "detach",
  before: ReplicaSnapshot | null,
  after: ReplicaSnapshot | null,
  expectedListFingerprint: string,
  status: "pending" | "applied" | "failed" | "conflict" | "unavailable" | "uncertain",
  errorCode?: string
};
~~~

ReplicaSnapshot includes the complete materialized rule, exact user description, marker, account identity, and position. The operation also contains enough member/folder-mapping state to finish creation or detachment after a restart. Target before/after definitions, rather than a remembered status alone, are the authority for recovery.

Ownership suffix:

~~~text
<exact user description> [stf-shared:v1:<group UUID>:<member UUID>]
~~~

Use valid UUIDs and a strict end-anchored parser. Keep the original description prefix byte-for-byte; stripping the exact recognized suffix must restore it. Test empty descriptions, Unicode, quotes, and descriptions resembling markers. Recognize ownership only when the suffix and the persisted group/member/account binding agree.

Rules:

- Names, array indices, and listId are not persistent identities.
- Duplicate markers within an account are conflicts.
- Markers on unknown/unregistered filters are **unlinked shared copies** and are not automatically adopted.
- Match account identity in addition to accountId; deleting/recreating an account must not attach the old group to a new server.
- Account display-name changes only update labels.
- Compute fingerprints from deterministic complete native snapshots, including user name/description, enabled/type, term data/connectors, and action data/order. Ownership is checked independently. Do not normalize arbitrary strings, reorder terms, or sort actions.
- Use a separate persistent-list fingerprint including order and logging settings for preview concurrency checks. Temporary runtime filters are excluded from disk comparisons but must remain untouched in live memory.
- Do not log full rule definitions, folder URIs, message bodies, or account connection details. Error codes plus account/filter display names are sufficient for user feedback.

For bounded storage, retain the unfinished operation and only a compact last-completed summary. Reject an operation whose UTF-8 JSON intent exceeds 4 MiB before writing any native list. Handle storage quota errors explicitly; do not add unlimitedStorage merely to bypass an avoidable journal size problem.

## 6. Privileged API and native editing design

Keep the existing namespace, adding explicit methods and schema types. Put shared-rule native helpers in api/senderToFilter/shared.js, loaded into the Experiment's own scope using an extension-local URI. Verify the loading approach on the supported native versions; do not introduce a second Experiment namespace.

Recommended contracts:

| Method | Contract |
|---|---|
| inspectAccounts(accountIds?) | Return account identity/capabilities/deferral eligibility and available native filter summaries. Read only. |
| readRule(accountId, selector) | Resolve an explicitly selected unmanaged source/adoption candidate or a managed UUID pair; return a complete RuleSnapshot and list fingerprint. |
| inspectReplicas(bindings) | Return actual native and saved-rule fingerprints plus ownership and dependency status. No writes. |
| editRuleDraft(windowId, referenceAccountId, definition, mappings) | Open a detached native editor and return accepted draft or canceled. Never write a real list. |
| prepareSharedChange(change) | Accept create/update/append-senders/repair/detach intent with groupId, expectedRevision, current definition, member bindings, explicit adoption selectors, and the requested draft or sender batch. Revalidate every member, build detached candidates, and return the proposed canonical definition, preview, and immutable per-target before/after plan. No real-list writes. |
| applyReplica(targetOperation) | Revalidate ownership/account/before state immediately, apply one account's target, save and read back, return a structured persistence result. |
| detachReplica(targetOperation) | Use the same persistence engine to remove only the recognized ownership suffix. |

Implement selectors as either a group/member UUID binding or an explicit unmanaged name/index plus observed complete fingerprint. Never fall back from a missing managed UUID to a name match.

Preparation may return a short-lived in-memory preview token, but the journal must contain validated JSON intent sufficient to re-prepare after restart. Never persist an XPCOM object or rely on an expiring token for recovery.

For append-senders, preparation materializes the current canonical rule into a detached native filter, rechecks the existing sender-add eligibility, deduplicates the new batch using the current operator/value rules, appends fresh native terms, and exports the next complete definition. It does not edit a replica first and then copy it. Apply the 100-condition limit to the new batch, not to the entire accumulated rule; the operation-size limit bounds persisted intent. If nothing changes, retain the revision and inspect/retry incomplete members only.

The unprivileged coordinator must pass only validated data; the Experiment independently validates every argument and native capability. Resolve all files from the selected account's native list. Do not accept arbitrary filesystem paths, executable code, raw script filter definitions, or caller-supplied native URIs.

### Nonmutating inspection and saved-file verification

Implement one shared readback helper and use it in inspection, preview, conflict detection, and post-save verification:

1. Resolve the standard rules-file location from the native server/list. For an account whose live list has not been loaded, the standard server's localPath plus the native filename msgFilterRules.dat is the discovery path; reject nonstandard backends before using it. Never take a path from a page or message.
2. Read the original file's bytes without creating it. Record existence and a content hash. Treat absence or an empty new-account file as an empty prospective list for preview.
3. Create a private unique scratch directory/file, with restricted permissions. Copy the observed bytes there and call OpenFilterList(scratchFile, rootFolder, null). All automatic parser migrations and any scratch defaultFile remain confined to that directory.
4. Reject parse errors, unexpected normalization, and format-migration requirements for an existing account file. If native parsing rewrites the scratch copy, ask the user to open that account's ordinary Message Filters once so Thunderbird can handle its migration, then retry. Do not silently migrate the original during a preview.
5. Export the parsed snapshot, discard the parsed list, and remove scratch artifacts in finally. Never assign this scratch list as an account's live/editable list.
6. Before initializing/using the live list, ensure an existing original still matches the inspected bytes. A missing new-account rules file may be initialized only after the operation intent is durable.
7. Compare live and saved definitions before writing. Unexplained differences are an edit conflict, not permission to flush unsaved native state.

Use a complete observational snapshot for unrelated rules too: names/descriptions/types, terms including grouping flags and serialized values, action fields, order, and logging. Copy unparseable buffers only for comparison, never execute or rewrite them yourself. If the account list contains state that cannot survive the native save/reload cycle unchanged, block that account's save rather than silently losing unrelated data.

A scratch copy is temporary verification data, not a backup or an alternate filter engine. Verify that inspections of missing, old-format, and corrupt inputs leave the original bytes and existence unchanged and never show a recovery prompt.

### Rule cloning

For a supported flat rule:

1. Read native terms and generate the condition string using each term's native termAsString and connector, or exactly ALL for the singleton case.
2. Parse into a fresh filter using the native list parser.
3. Verify term count, actual parsed fields/operators/values/connectors, and serialization round-trip. Native parsing can return without producing a complete intended rule; success alone is not proof.
4. Construct fresh action objects, setting only properties valid for that type. Resolve folder slots to verified real target folders and then their native URIs.
5. Assign the name, description plus ownership suffix, enabled state, and validated filterType.
6. Verify the candidate through native serialization/reload tests before using this path on live accounts.

Do not share mutable term, value, or action objects between account copies. The original single-account rollback only snapshots terms; that is insufficient for complete-rule synchronization.

### Detached native editor

Use MailServices.filters.getTempFilterList(referenceRootFolder), a newly built rule, and FilterEditor.xhtml's existing args.filter / args.filterList contract. Use args.refresh/newFilter only after the modal editor returns. Cancel/close returns canceled. The temporary filter/list must not point at a writable defaultFile belonging to a real account.

The manager's enabled switch supplies the enabled state because the native editor is primarily for conditions/actions/triggers. Check all account capabilities again after accepting the draft.

### Open native windows

Before preparation and immediately before a live write, inspect native mailnews:filtereditor and mailnews:filterlist windows. If a window refers to an affected list, return editor-open and defer the operation until it closes. If a window's affected list cannot be determined reliably, conservatively defer shared writes while it remains open.

This protects against stale editors and filter-manager references when replacing a live filter object. The add-on's detached draft window is not a live replica and is closed before applying. Do not monkey-patch Thunderbird's editor or silently refresh/close user windows.

## 7. Save, failure, and restart protocol

Use a single add-on mutation queue across all groups and ordinary add operations, because different groups can share an account's rules file. Do not hold that queue while the user is editing a draft. Reading menus remains independent.

There is no atomic transaction combining storage.local with several rules files.

### Start a change

1. Acquire the mutation queue and check the requested group revision.
2. Inspect every target: account identity/capability, ownership, list fingerprint, native editor state, folder destinations, tags, condition/action validity, and the actual saved rule.
3. If a known blocker exists, return a complete per-account preview with **zero native writes**. Do not publish a new desired revision yet.
4. Prepare all before/after snapshots. For adoption, the observed pre-existing rule is the before snapshot; for creation, before is absent.
5. Persist the new desired definition/revision and the complete operation intent together in one sharedFiltersV1 storage update. If that fails, perform zero native writes.
6. Apply targets sequentially in deterministic membership order, checkpointing each verified result back to storage.
7. Retain the operation while any target is unfinished. Clear it only after all targets are reconciled and the final storage write succeeds.

Use a revision check for manager actions and menu actions. A stale action is rejected with “The shared filter changed; reopen and try again.”

### Apply one account

Prepare disk snapshots before the final compare. Keep live replacement and save synchronous; guarded saved-file verification can follow while the add-on mutation queue remains held:

1. Re-resolve the account/list and compare the actual current rule and persistent-list state to the prepared expectations. Re-find the position by identity. Do not use a stale saved index.
2. If the intended after state already exists with the correct ownership, return already-applied without saving.
3. Otherwise require the exact before state, create a completely fresh native candidate, and retain the original list entry/reference and position.
4. Replace only the target entry at its current index, or insert a new entry at the approved position. Ensure its filterList points at the real list before saving.
5. Call saveToDefaultFile once for that account operation.
6. Read and parse a private scratch copy of the saved file using the Section 6 helper. Verify the owned copy's complete fingerprint and intended persistent order. Also compare all unrelated persisted rules and logging settings to their before values. Do not call OpenFilterList on the original for verification.
7. Return applied only after verification succeeds.

Perform required asynchronous preparation before this critical section; do not introduce an await between the final compare and the mutation/save. If disk-readback plumbing needs an asynchronous stage, guard it with the mutation queue and revalidate after the await before any subsequent mutation. No UI prompt or editor should be opened inside the critical section.

### Classify failures truthfully

- If a save throws and disk is still the before state, restore the original live entry/reference, report failed, and leave that member pending.
- If a save reports an error but readback proves the complete intended after state is present, reconcile it as applied and retain the diagnostic.
- If disk is neither provably before nor after, or cannot be read, restore the original live entry when possible, mark **Persistence uncertain**, and stop further writes for that operation. Do not claim rollback of disk, and do not blindly rewrite the whole list.
- A normal per-account I/O failure can leave earlier accounts updated and allow later independent targets to proceed. A newly detected ownership/edit conflict or uncertain persistence stops further writes for that operation.
- If a storage checkpoint fails after a successful native save, stop further writes. Keep the prior durable intent; restart/retry can detect the saved after state.
- Never roll back already-successful accounts automatically just because another account fails. Their filters may already have processed mail.

### Recovery and retry

On startup/re-enable, read storage before enabling shared mutations. For each unfinished target:

| Observed state | Recovery |
|---|---|
| Matches intended after, correct marker/account | Mark applied; do not write again. |
| Matches before | Retry the already-authorized intent when no blocker exists. |
| Neither | Needs review; do not overwrite. |
| New creation has no copy and before was absent | May retry creation after validating the recorded account/name/list conditions. |
| Previously managed copy disappeared | Needs review; never assume this was an unfinished creation. |
| Account unavailable | Keep record and intent; require return of the same identity or explicit removal. |
| Duplicate/malformed marker | Needs review; no name fallback. |

Read the current list afresh so that unrelated changes made since the operation do not get overwritten. A changed full-list fingerprint requires re-preparation; if only unrelated rules changed and the managed before/after state still agrees, preserve them and the current replica position. Changes to intended membership/placement require a new reviewed preview.

Only retry and recovery/resolution operations may act on a group with unfinished work. Block ordinary new edits until pending intent is resolved. Allow an explicit “stop sharing this account” resolution to cancel that member's remaining propagation and journal its marker cleanup; do not erase the record before cleanup completes.

Read-only inspections run at background startup, manager open/focus, before preparing a menu action, before every write, and on account/folder/tag events. Also run a coalesced 60-second read-only scan of enrolled accounts while the persistent background is active. Inspect once after re-enable before replaying durable unfinished intent; ordinary scan ticks never create a new revision or retry a known I/O failure. Retry known failures on explicit Retry or a relevant dependency-recovery event with bounded backoff, and do not repeat unchanged notifications. Do not poll messages or repeatedly reload whole folder trees. There is no assumed public filters.onChanged event.

Folder/tag/account events invalidate cached status and trigger inspection, not automatic adoption of native edits. An unambiguous folder rename/move event may be proposed as a mapping repair. If a mapping cannot be resolved after a restart, require the user to select the folder again; never guess by display name.

## 8. Files and scope

Existing files to modify during implementation:

- /Users/thedaego/development/sender-to-filter/background.js
- /Users/thedaego/development/sender-to-filter/api/senderToFilter/implementation.js
- /Users/thedaego/development/sender-to-filter/api/senderToFilter/schema.json
- /Users/thedaego/development/sender-to-filter/manifest.json
- /Users/thedaego/development/sender-to-filter/_locales/en/messages.json
- /Users/thedaego/development/sender-to-filter/package.json
- /Users/thedaego/development/sender-to-filter/scripts/build.sh
- /Users/thedaego/development/sender-to-filter/scripts/test-thunderbird.py
- /Users/thedaego/development/sender-to-filter/tests/helpers.cjs
- /Users/thedaego/development/sender-to-filter/tests/background.test.cjs
- /Users/thedaego/development/sender-to-filter/tests/experiment.test.cjs
- /Users/thedaego/development/sender-to-filter/tests/native/implementation.js
- /Users/thedaego/development/sender-to-filter/tests/native/schema.json
- /Users/thedaego/development/sender-to-filter/tests/native/background.js
- /Users/thedaego/development/sender-to-filter/README.md
- /Users/thedaego/development/sender-to-filter/CHANGELOG.md
- /Users/thedaego/development/sender-to-filter/VALIDATION.md

New files:

- /Users/thedaego/development/sender-to-filter/lib/shared-model.js — pure validation, materialization metadata, state transitions.
- /Users/thedaego/development/sender-to-filter/lib/shared-coordinator.js — queue, storage, revisions, retries, message routing.
- /Users/thedaego/development/sender-to-filter/api/senderToFilter/shared.js — native account/rule/persistence helpers.
- /Users/thedaego/development/sender-to-filter/options/shared-filters.html
- /Users/thedaego/development/sender-to-filter/options/shared-filters.js
- /Users/thedaego/development/sender-to-filter/options/shared-filters.css
- /Users/thedaego/development/sender-to-filter/tests/shared-model.test.cjs
- /Users/thedaego/development/sender-to-filter/tests/shared-coordinator.test.cjs
- /Users/thedaego/development/sender-to-filter/tests/shared-experiment.test.cjs
- /Users/thedaego/development/sender-to-filter/tests/shared-ui.test.cjs
- /Users/thedaego/development/sender-to-filter/tests/package.test.cjs

Load the pure/coordinator scripts before background.js through manifest.background.scripts. Use an explicit namespace/factory pattern testable from node:vm; avoid implicit imports that work in only one runtime.

Out of scope: rewriting the historical plan, changing LICENSE/icons, changing email/domain semantics, generalized AND-to-OR conversion, server-side mail rules, remote sync, telemetry, installation in the user's normal profile, deleting native filters, publishing, commits, or pushes.

No new permission is assumed necessary for the proposed core paths. Existing messagesRead supports tag-list inspection in the current API; verify it on all target versions. Use account/folder APIs only for reading choices/events and existing Experiment privileges for native filters.

## 9. Implementation sequence and verification gates

All commands below run from /Users/thedaego/development/sender-to-filter. Implementation occurs only after a separate request to proceed. Keep logical changes reviewable; do not commit or push without the user's authorization.

Before editing, run:

~~~sh
git rev-parse HEAD
git status --short
git diff --stat c831217176ac46b2e317d72253196d88b5736a81 -- background.js api manifest.json package.json scripts tests README.md VALIDATION.md CHANGELOG.md
npm run check
npm test
~~~

Expected baseline: HEAD as recorded or understood subsequent commits, no unexpected source differences, 31 passing tests. Planning files may be untracked. Reconcile legitimate drift with the code excerpts; never overwrite unrelated work.

### Step 1 — Prove native prerequisites in disposable profiles

Extend the native fixture/harness with separately identified shared-rule checks before enabling production mutations:

- Create at least two distinct offline fixture account filter lists; include an IMAP and nondeferred POP server without real credentials/network delivery.
- Prove filterDesc ownership survives save/reload/restart and ordinary native editor acceptance.
- Prove read-only inspection of missing, old-format, and corrupt rule files preserves original bytes/existence and never prompts, migrates, or truncates the real file.
- Prove complete cloning of single/OR/AND/ALL conditions and every allowed action; quotes, parentheses, Unicode, and header conditions must round-trip.
- Prove copies do not share mutable terms/actions/values.
- Prove account-root resolution selects each account's real rules file and rejects two nominal accounts sharing a physical rules file.
- Prove fresh-entry replacement and rollback preserve unrelated filters, temporary entries, order, and logging.
- Prove opening/canceling/accepting a detached native editor never saves a real list.
- Prove open-native-window detection and capability rejection.
- Prove existing-regular-file-as-parent failure injection still causes a real save failure.

The existing runner must stay restricted to a marked, offline, disposable profile. Do not use chmod 000 or missing-directory behavior as reliable failure fixtures.

Verify:

~~~sh
npm run check
npm test
python3 scripts/test-thunderbird.py --binary /Applications/Thunderbird.app/Contents/MacOS/thunderbird --output dist/shared-native-check.json
~~~

Expected: all existing checks pass, JSON ok is true, and named new native checks pass. Repeat with operator-supplied ESR 140 and ESR 153 binaries before claiming support. Interactive detached-editor checks may require a separate visible disposable-profile run; identify them as pending until actually performed.

If description markers or native cloning fail, stop this feature's implementation and revise the identity/serialization design. Do not silently substitute name matching or edit rules files directly.

### Step 2 — Define the portable model and ownership rules

Create shared-model.js and its tests. Implement strict versioned schemas, discriminated actions, identity-marker parsing, deterministic fingerprints, folder slots, size limits, and pure recovery/state transitions. Separate sharing eligibility from sender-add eligibility.

Verify:

~~~sh
node --test tests/shared-model.test.cjs
npm test
~~~

Expected: deterministic serialization and every model/identity/recovery case passes. No production account writes are possible at this step.

### Step 3 — Implement the native adapter

Add shared.js, expose the schema methods, and adapt fake native lists to model multiple accounts, typed actions, complete snapshots, marker duplication, list replacement, saved-state readback, and failures.

The existing addConditions method must refuse a recognized managed/marked target with a structured managed-target result, even if an old menu tries the single-account route. Update the API schema and background response handling together.

Verify:

~~~sh
node --test tests/experiment.test.cjs tests/shared-experiment.test.cjs
npm run check
python3 scripts/test-thunderbird.py --binary /Applications/Thunderbird.app/Contents/MacOS/thunderbird --output dist/shared-native-check.json
~~~

Expected: v1 unshared behavior still passes; managed bypasses are rejected; native shared checks pass. Each API write has fresh account/ownership/before-state validation.

### Step 4 — Implement synchronization and recovery

Create shared-coordinator.js. Add the global mutation queue, one-key storage updates, desired revisions, durable intents, per-target checkpoints, startup reconciliation, blocked-group behavior, and coalesced read-only scans. Route ordinary add operations through the same queue to serialize writes to common account files.

Use fake storage and native adapters with controllable failures and interleavings. Crash tests should reconstruct a fresh coordinator from only durable storage plus fake saved native lists; they must not rely on the previous instance's memory.

Verify:

~~~sh
node --test tests/shared-coordinator.test.cjs
npm test
~~~

Expected: all crash boundaries, storage failures, native conflicts, retries, and cross-group concurrency cases pass; successful targets never duplicate their rule or repeat a no-op save.

### Step 5 — Build the manager and detached editing flow

Add options_ui and the accessible management page. Route typed runtime requests through the coordinator. Validate sender.id and allowed extension-page URLs; do not register external-message handlers or accept arbitrary operations from unrelated contexts.

Use native controls, labels, keyboard focus, localized text, and an aria-live status area. Render account names, rules, and errors through textContent, never unsanitized HTML. Cover light/dark modes and a narrow window. Keep hashes, UUIDs, raw URIs, journal terms, and native implementation details out of normal user flows.

Implement create/link preview, destination mapping, detached editing/cancel, enabled/triggers, per-account status, conflict resolutions, and unlink cleanup.

Verify:

~~~sh
node --test tests/shared-ui.test.cjs tests/shared-coordinator.test.cjs
npm run check
~~~

Expected: preview/cancel causes zero mutations; invalid mapping/collision blocks save; keyboard interaction and text rendering cases pass. Complete visible disposable-profile checks for the actual native modal and both Thunderbird windows.

### Step 6 — Integrate shared sender actions

Update selection/menu snapshot shapes so mixed-account selections can target shared groups without opening the ordinary single-account route. Preserve generation checking, serialized menu mutations, hide-before-click behavior, domain persistence, and parsing limits.

Add group revision and complete account-result information to snapshots/results. Managed native copies cannot be modified independently through old IDs or alternate API calls.

Verify:

~~~sh
node --test tests/background.test.cjs tests/shared-coordinator.test.cjs tests/shared-experiment.test.cjs
npm test
~~~

Expected: v1 tests still cover the no-shared-group case; new tests prove cross-account sender deduplication, shared target scope, revision races, no double counting, and no local-route bypass.

### Step 7 — Package, document, and validate

Bump manifest.json and package.json together to 1.1.0 when the feature is complete. Extend the build and native-runner runtime allowlists to include lib/ and options/. Expand npm run check to cover all production JavaScript, including the new helper and options scripts.

Add package.test.cjs to read a built XPI using Python's standard zipfile support. It must inspect the actual archive, not infer correctness from source filenames.

Document supported accounts/rules/actions, shared versus local positions, failure states, native-editor conflicts, domain/address semantics, uninstall/unlink behavior, and remaining runtime evidence. Preserve the distinction between tests, packaged artifacts, and a live mail-delivery test.

Verify in this order:

~~~sh
npm run check
npm run build
npm test
python3 scripts/test-thunderbird.py --binary /Applications/Thunderbird.app/Contents/MacOS/thunderbird --output dist/shared-native-check.json
git diff --check
git status --short
~~~

Expected: all commands succeed; package tests validate dist/sender-to-filter-1.1.0.xpi; no test-only Experiment is in the archive; only in-scope source/docs and ignored dist artifacts changed.

## 10. Required regression matrix

Use the current experiment.test.cjs and background.test.cjs VM patterns. Add meaningful behavior tests, not tests that merely mirror object construction.

| Area | Required cases |
|---|---|
| Identity | Same names in different accounts; reorder; rename; duplicate marker; marker removal; unknown marker; account removal/recreation; user description preserved; native editor persistence. |
| Complete rules | Supported single/OR/AND/ALL; rejected mixed/grouped/ALL-plus-terms; enabled/type/name/description; all supported action properties/order; mutable-object isolation. |
| Destinations | Per-account same-path mapping; missing folder; explicit shared Local Folders destination; two move/copy slots; reordered slots; virtual/root/non-fileable folder rejection; folder moved/renamed while draft open. |
| Capability | IMAP/POP standard lists; account aliases sharing one physical list/file; deferred source/destination refusal; Local Folders member refusal; separate/custom backend; unavailable tag/header; custom action/term; disallowed execution bits. |
| Creation/adoption | Missing target; explicit adoption of differing rule; same-name collision; source adoption; placement preview; old unmanaged description restored on failed adoption. |
| Native writes | Scratch parser leaves missing/old/corrupt originals untouched; target A succeeds, B fails, C succeeds; list save exactly once per changed account; no save for no-op; unrelated filter data/order/logging preserved; real disk readback; uncertain disk state stops writes. |
| Recovery | Crash before intent, after intent, after save/before checkpoint, after checkpoint, before final completion; failed intent/checkpoint writes; recreate coordinator from durable state only. |
| Conflict | Native edit before preview, between preview/save, between members; native window open; older menu/group revision; no silent name fallback; explicit import/restore uses newly observed before state. |
| Concurrency | Two rapid clicks; two windows; two groups touching one account; ordinary add interleaving with shared sync; queue recovers after rejection; storage events do not create a sync loop. |
| Lifecycle | Startup scan; disable/re-enable; account removal; missing/corrupt/unknown-version storage; pending unlink cleanup; orphaned markers after storage loss; no automatic enrollment. |
| Menu | No-group v1 behavior; mixed accounts shared-only; invalid external selection; exactly 100 and 101 messages; 100 unique senders; domain dedup; no all-checked state while a member is stale; checked click does not remove. |
| UI/package | Cancel and close do not write; explicit final preview; keyboard/focus; dark/light; escaped labels; new scripts load from built XPI; native harness packages same production paths; no tests/native or planning files included. |

Native tests must reload actual saved rules and, for selected fixtures, restart the disposable process. Add fault injection around real saves and coordinator checkpoints. Pure JS mocks alone cannot prove native persistence.

End-to-end acceptance uses disposable IMAP/POP test accounts or a local test mail server with synthetic messages: receive a matching message in two accounts, observe each native action and mapped destination, add a sender through the shared menu, restart, and repeat. Also demonstrate that an earlier local stop/move rule can affect execution; do not promise to override it.

## 11. Done criteria and honest release gates

Implementation is complete only when:

- [ ] All original no-group behaviors remain covered and pass.
- [ ] The manager can create, link, edit, inspect, repair, retry, and stop sharing supported complete rules.
- [ ] Context-menu sender additions propagate to every selected member or report exact per-account failure.
- [ ] Every supported action/condition is verified through native save/reload.
- [ ] There is no path that modifies a recognized managed copy through the old one-account API.
- [ ] All durable-intent crash boundaries and partial-save scenarios pass automated tests.
- [ ] Identity markers survive native editor acceptance and restart on every claimed target version.
- [ ] Folder/account/tag changes and native editor drift never trigger silent replacement or guesswork.
- [ ] npm run check, npm run build, npm test, native checks, and git diff --check pass.
- [ ] Package tests prove the actual XPI includes required runtime files and excludes fixtures/plans.
- [ ] Visible manager/menu/native-draft checks and synthetic incoming-mail tests are recorded.
- [ ] VALIDATION.md records versions, commands, and pending checks without treating the manifest as evidence.
- [ ] The plans/README.md status reflects the actual result.

If ESR binaries or interactive test facilities are unavailable, mark those gates pending and do not describe the feature as fully verified for that environment. Continue independent implementation/testing; ask for the missing environment only when it becomes the remaining gate.

## 12. Stop conditions and maintenance notes

Stop the affected implementation path and report concrete evidence if:

- Identity markers fail to persist or an existing native editor erases them.
- A supported native rule changes meaning or loses fields on round-trip.
- Detached editing touches the live account list or writes a real rules file.
- Native save/readback cannot distinguish before, after, and uncertain state, or a supposedly read-only probe creates/migrates/truncates the original file.
- A target resolves to a nonstandard or shared/deferred pipeline outside the stated support boundary.
- An API needed for a claimed Thunderbird version is absent.
- Implementation requires touching files outside scope or overwriting unrelated user changes.

Resolve routine implementation choices within this design; these conditions are for failed design assumptions, not automatic requests for approval on every edit.

Review future changes especially for: supported native action tables; new Thunderbird filter flags; marker preservation; account/folder identity after migration; storage schema evolution; global queue use by every new mutation path; and independent runtime allowlists in production packaging and the native harness.

Deferred follow-ups: Global Inbox membership with coverage/double-execution tests; Forward/Reply/custom action portability; multi-device configuration sync; optional removal of native copies; grouping support only if native persistence can preserve it.

## 13. Alternatives considered

- **Same-name copies without ownership markers:** rejected; rename/reorder/recreation can target the wrong rule.
- **Symlinking or copying entire rules files:** rejected; folder destinations and unrelated account filters differ.
- **Bidirectional automatic merging of native edits:** deferred; there is no unambiguous winner for conflicting actions, deletions, or trigger changes.
- **Watching new messages and applying actions in the add-on:** rejected; unnecessary second filter engine with different behavior and permissions.
- **Only synchronize sender conditions:** not selected; the user explicitly requested complete rules.
- **A cross-account all-or-nothing save guarantee:** rejected; the relevant native APIs do not offer a transaction spanning files and extension storage.
