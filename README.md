# Sender to Filter

Add senders to an existing Thunderbird message filter from the message-list context menu.

Right-click one or more messages, choose **Add Sender to Filter**, then choose a filter. The add-on adds the unique sender addresses in one batch and reports how many were added or already present. Existing conditions, actions, ordering, enabled state, and execution types are preserved.

Filters with a single condition or ungrouped OR conditions are supported. Filters with AND conditions, grouping, “match all messages,” no conditions, duplicate names, or temporary/unreadable definitions are shown as unsupported. **Manage filters…** opens Thunderbird's own editor route for those cases. An otherwise supported disabled filter can be updated and remains disabled.

**Install**

1. Download/build `sender-to-filter-1.0.0.xpi`.
2. In Thunderbird, open Add-ons and Themes, then the gear menu → Install Add-on From File.
3. Select the XPI and accept the installation permission.

For development, use Debug Add-ons → Load Temporary Add-on and select `manifest.json`. Reload the temporary add-on after changes. Thunderbird's Error Console shows startup and menu errors.

The add-on uses a small Experiment API because Thunderbird's public extension APIs do not expose message filters. Thunderbird consequently requests **full, unrestricted access to Thunderbird and your computer**. The implementation operates locally on the selected account's filters; it makes no network requests and has no telemetry. Disabling/uninstalling the add-on leaves previously saved filter additions in place.

The manifest targets Thunderbird **140 through 155**, covering ESR 140, ESR 153, and release 155. This version range is an intended compatibility scope. See `VALIDATION.md` for what was actually checked; a manifest declaration alone is not a runtime test.

**Matching behavior**

- Address mode adds Thunderbird's native **From is** condition, like its built-in new-filter editor. The comparison is case-insensitive and exact against parsed mailbox names and addresses. A display name equal to the supplied address can also match; this is Thunderbird's native behavior.
- **Match domain text in From** adds **From contains @example.com**. This is a substring search on decoded From text. It also matches `person@example.com.evil` or matching display-name text, and does not include `person@sub.example.com`. The toggle takes effect the next time the context menu opens and persists across restarts.
- The selection is limited to 100 messages and 100 unique sender addresses. Larger selections are rejected with an explanation. Malformed addresses, addresses without a dotted domain, address literals, and quoted local parts are skipped.
- Messages must be stored in folders of one account. Mixed-account selections and external/attached `.eml` messages are rejected. The destination is the filter list belonging to the first message's current folder, matching Thunderbird's built-in storage-location behavior; moving a message between accounts can therefore change the target.
- **New filter from…** uses only the first usable sender when several are selected and opens Thunderbird's native editor. The menu makes this limitation visible.
- Editing an incoming-enabled filter affects future filtering without requiring a restart. A disabled or manual-only filter retains its existing execution settings. Existing messages are not automatically filtered by an add.

**Build and check**

The extension has no third-party runtime dependencies and no npm install step.

```sh
npm run check
npm test
npm run build
```

Checks use Node.js 20+; packaging uses Bash, `jq`, and `zip`. The build includes only runtime files and writes `dist/sender-to-filter-1.0.0.xpi`. Unit tests, native-test Experiments, documentation, and the planning document are excluded.

Native checks require Python 3 and an installed Thunderbird executable:

```sh
python3 scripts/test-thunderbird.py --binary /Applications/Thunderbird.app/Contents/MacOS/thunderbird
```

The runner creates a fresh marked profile, configures it offline, seeds local test filters, loads the production Experiment through its real schema, and verifies persistence, native matching, duplicate handling, and rollback on a real file-save failure. It stops only its own test process and removes that profile. Results and logs are saved under `dist/`. It never opens your normal Thunderbird profile. Pass a different `--binary` to check another installed version.

The native tests simulate a write failure by selecting a destination whose parent is an existing regular file. Changing the existing file to mode `000` is not reliable because Thunderbird's safe writer can replace a file when its parent directory remains writable. File mtime and size are also not treated as proof of persistence; the tests reopen and inspect the saved rules.

**Implementation notes**

`background.js` handles message selection, parsing, localized menus, settings, and notifications. Menu mutations are serialized, and every actionable row carries a generation ID. A completed immutable snapshot survives hide-before-click event ordering; unfinished builds are cancelled on hide or superseded by a later show.

`api/senderToFilter/implementation.js` resolves the native folder and filter, rechecks eligibility, deduplicates operator/value pairs, and appends terms synchronously in a single batch. Existing term objects are never modified. Any exception during construction, append, or save restores the original term array via Thunderbird's setter, which also clears its expression cache. It reports rollback failures separately if restoration itself fails.

The Experiment depends on Thunderbird internals. Relevant references are the release versions of [nsMsgFilter.cpp](https://hg.mozilla.org/releases/comm-esr153/file/THUNDERBIRD_153_0esr_RELEASE/mailnews/search/src/nsMsgFilter.cpp), [FilterEditor.js](https://hg.mozilla.org/releases/comm-esr153/file/THUNDERBIRD_153_0esr_RELEASE/mailnews/search/content/FilterEditor.js), and [mailWindowOverlay.js](https://hg.mozilla.org/releases/comm-esr153/file/THUNDERBIRD_153_0esr_RELEASE/mail/base/content/mailWindowOverlay.js).

**Future work**

Converting AND/grouped/match-all filters, removing conditions, choosing other headers, a searchable picker, repainting an open filter manager, and publishing to addons.thunderbird.net are outside v1. Edits from an already-open filter editor and live mail arrival are included in the remaining manual validation checklist.

Licensed under MPL-2.0. See `LICENSE`.
