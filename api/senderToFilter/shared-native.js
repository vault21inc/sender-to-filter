/* MPL-2.0. Native plumbing for shared.js; never accepts a caller file path. */
"use strict";
(function (exports) {
  exports.createSharedNativeHost = function (context, M) {
    const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
    const { MailUtils } = ChromeUtils.importESModule("resource:///modules/MailUtils.sys.mjs");
    const actionNames = ["MoveToFolder", "CopyToFolder", "AddTag", "ChangePriority", "JunkScore", "MarkRead",
      "MarkUnread", "MarkFlagged", "Delete", "StopExecution", "KillThread", "KillSubthread", "WatchThread"];
    const fields = { MoveToFolder: "targetFolderUri", CopyToFolder: "targetFolderUri", AddTag: "strValue",
      ChangePriority: "priority", JunkScore: "junkScore", Forward: "strValue", Reply: "strValue",
      Label: "label", Custom: "strValue" };
    // XPCOM constants are lazy; Object.entries can see only constants another
    // window happened to access. Resolve each known value explicitly, including
    // unsupported actions retained in before snapshots.
    const names = new Map([...actionNames, "None", "Forward", "Reply", "Label", "Custom", "DeleteFromPop3Server",
      "LeaveOnPop3Server", "FetchBodyFromPop3Server"].map(name => [Ci.nsMsgFilterAction[name], name]));
    const fail = code => { throw new M.ModelError(code); };
    const same = (a, b) => M.canonicalJson(a) === M.canonicalJson(b);
    const listFilters = list => Array.from({ length: list.filterCount }, (_, i) => list.getFilterAt(i));
    const uuid = () => Services.uuid.generateUUID().toString().slice(1, -1);
    function terms(filter) {
      return filter.searchTerms.map(term => ({ text: term.termAsString, attrib: term.attrib, op: term.op,
        booleanAnd: term.booleanAnd, matchAll: term.matchAll, beginsGrouping: term.beginsGrouping,
        endsGrouping: term.endsGrouping, arbitraryHeader: term.arbitraryHeader,
        ...(term.attrib === Ci.nsMsgSearchAttrib.Custom ? { customId: term.customId } : {}),
        ...([Ci.nsMsgSearchAttrib.HdrProperty, Ci.nsMsgSearchAttrib.Uint32HdrProperty].includes(term.attrib)
          ? { hdrProperty: term.hdrProperty } : {}) }));
    }
    function snapshot(filter) {
      const actions = Array.from({ length: filter.actionCount }, (_, i) => {
        const action = filter.getActionAt(i), name = names.get(action.type);
        if (!name) fail("unknown-native-action");
        const field = fields[name];
        return { type: action.type, ...(field ? { [field]: action[field] } : {}),
          ...(name === "Custom" ? { customId: action.customId } : {}) };
      });
      return { name: filter.filterName, description: filter.filterDesc, enabled: filter.enabled,
        filterType: filter.filterType, temporary: filter.temporary, unparseable: filter.unparseable,
        unparsedBuffer: filter.unparsedBuffer, terms: terms(filter), actions };
    }
    const snapshotList = list => ({ loggingEnabled: list.loggingEnabled,
      filters: listFilters(list).filter(filter => !filter.temporary).map(snapshot) });
    function bytes(file) {
      if (!file.exists()) return null;
      if (!file.isFile() || file.fileSize > 32 * 1024 * 1024) fail("rules-file-unreadable");
      const stream = Cc["@mozilla.org/network/file-input-stream;1"].createInstance(Ci.nsIFileInputStream);
      const binary = Cc["@mozilla.org/binaryinputstream;1"].createInstance(Ci.nsIBinaryInputStream);
      try { stream.init(file, 0x01, 0, 0); binary.setInputStream(stream); return binary.readBytes(binary.available()); }
      finally { try { binary.close(); } catch { stream.close(); } }
    }
    function write(file, value) {
      const stream = Cc["@mozilla.org/network/file-output-stream;1"].createInstance(Ci.nsIFileOutputStream);
      try { stream.init(file, 0x02 | 0x08 | 0x20, 0o600, 0); stream.write(value, value.length); }
      finally { stream.close(); }
    }
    function rulesFile(server) {
      const directory = server.localPath.clone(); directory.normalize();
      const file = directory.clone(); file.append("msgFilterRules.dat");
      if (file.exists()) file.normalize();
      return file;
    }
    const accounts = () => Array.from(MailServices.accounts.accounts);
    function sameFile(first, second) {
      if (first.equals(second)) return true;
      if (!first.exists() || !second.exists() || first.fileSize !== second.fileSize ||
          first.lastModifiedTime !== second.lastModifiedTime) return false;
      // Normalized paths catch symbolic aliases. Hard links require filesystem
      // identity: the OS test utility compares device/inode without opening or
      // changing contents. No shell, user command or downloaded helper is used.
      if (!["Darwin", "Linux"].includes(Services.appinfo.OS)) fail("file-identity-unavailable");
      const executable = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      executable.initWithPath("/bin/test");
      const process = Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);
      process.init(executable);
      process.runw(true, [first.path, "-ef", second.path], 3);
      if (![0, 1].includes(process.exitValue)) fail("file-identity-unavailable");
      return process.exitValue === 0;
    }
    function account(id) {
      const native = MailServices.accounts.getAccount(id);
      if (!native?.incomingServer) fail("account-unavailable");
      const server = native.incomingServer;
      const file = rulesFile(server);
      return { id, name: server.prettyName, type: server.type, server, root: server.rootFolder, file,
        identity: { key: server.key, type: server.type, host: server.hostname ?? server.hostName,
          user: server.username ?? server.userName, port: server.port },
        physicalKey: file.path };
    }
    function reason(a) {
      if (!["imap", "pop3"].includes(a.type)) return "unsupported-account";
      if (a.root !== a.server.rootMsgFolder) return "deferred-source";
      for (const other of accounts()) {
        const s = other.incomingServer;
        if (s.type === "pop3" && s.rootFolder !== s.rootMsgFolder && s.rootMsgFolder === a.root) return "deferred-destination";
        if (other.key !== a.id && (s === a.server || sameFile(rulesFile(s), a.file))) return "shared-rules-file";
      }
      return null;
    }
    function read(a) {
      const before = bytes(a.file);
      const directory = Services.dirsvc.get("TmpD", Ci.nsIFile); directory.append("stf-inspect");
      directory.createUnique(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
      const file = directory.clone(); file.append("msgFilterRules.dat");
      try {
        if (before !== null) write(file, before);
        const list = MailServices.filters.OpenFilterList(file, a.root, null);
        const result = snapshotList(list);
        list.defaultFile = file; list.saveToDefaultFile();
        if (before && bytes(file) !== before) fail("rules-normalization-required");
        if (bytes(a.file) !== before) fail("rules-changed-during-inspection");
        return { bytes: before, list: result };
      } finally { directory.remove(true); }
    }
    function openWindow(a, allowManagers = false) {
      for (const win of Services.wm.getEnumerator(null)) {
        if (allowManagers && win.document.documentURI === "chrome://messenger/content/FilterListDialog.xhtml") continue;
        if (!["chrome://messenger/content/FilterEditor.xhtml", "chrome://messenger/content/FilterListDialog.xhtml"]
          .includes(win.document.documentURI)) continue;
        const list = win.arguments?.[0]?.filterList || win.gCurrentFilterList;
        if (!list || list.folder?.server === a.server) return true;
      }
      return false;
    }
    function live(a, expectedBytes) {
      if (bytes(a.file) !== expectedBytes) fail("rules-changed-during-inspection");
      const list = a.server.getEditableFilterList(null);
      if (list !== a.server.getFilterList(null) || !list.defaultFile?.equals(a.file)) fail("nonstandard-filter-backend");
      return list;
    }
    function folder(ref) {
      let result;
      try { result = context.extension.folderManager.get(ref.accountId, ref.path); }
      catch { fail("folder-unavailable"); }
      if (!result || result.isServer || !result.canFileMessages || result.flags & Ci.nsMsgFolderFlags.Virtual ||
          !["imap", "pop3", "none"].includes(result.server.type)) fail("folder-unavailable");
      return result;
    }
    function runFolder(result) {
      if (!result || result.isServer || !result.canFileMessages || result.flags & Ci.nsMsgFolderFlags.Virtual ||
          !["imap", "pop3"].includes(result.server.type)) fail("shared-run-folder-unavailable");
      return result;
    }
    function folderRef(uri) {
      const native = MailUtils.getExistingFolder(uri);
      if (!native) fail("folder-unavailable");
      const result = context.extension.folderManager.convert(native);
      const ref = { accountId: result.accountId, path: result.path };
      folder(ref);
      return ref;
    }
    function conditionText(observed) {
      const shape = M.classifyConditions(observed.terms.map(({ booleanAnd, matchAll, beginsGrouping, endsGrouping }) =>
        ({ booleanAnd, matchAll, beginsGrouping, endsGrouping })));
      if (!shape.shareable || observed.temporary || observed.unparseable) fail(shape.reason || "unsupported-rule");
      return { logic: shape.logic, conditionText: shape.logic === "all" ? "ALL" : observed.terms.map(t =>
        `${t.booleanAnd ? "AND" : "OR"} (${t.text})`).join(" ") };
    }
    function exportRule(observed) {
      const marker = M.parseOwnership(observed.description);
      if (marker.status === "malformed") fail("malformed-marker");
      const mappings = {};
      const actions = observed.actions.map(action => {
        const type = names.get(action.type);
        if (!actionNames.includes(type)) fail("unsupported-action");
        if (["MoveToFolder", "CopyToFolder"].includes(type)) {
          const slotId = uuid(); mappings[slotId] = folderRef(action.targetFolderUri); return { type, slotId };
        }
        const field = type === "AddTag" ? "tagKey" : fields[type];
        return { type, ...(field ? { [field]: action[fields[type]] } : {}) };
      });
      const definition = M.validateDefinition({ name: observed.name, description: M.decodeDescription(marker.description),
        enabled: observed.enabled, filterType: observed.filterType, ...conditionText(observed), actions });
      return { definition, mappings };
    }
    function build(a, definition, mappings, marker = null) {
      const def = M.validateDefinition(definition), concrete = M.materializeDefinition(def, mappings);
      const list = MailServices.filters.getTempFilterList(a.root); list.defaultFile = null;
      const filter = list.createFilter(def.name);
      list.parseCondition(filter, def.conditionText);
      const observed = { ...snapshot(filter), temporary: false, unparseable: false };
      if (!same(conditionText(observed), { logic: def.logic, conditionText: def.conditionText })) fail("condition-round-trip");
      // Match FilterEditor.getFilterScope and each selected execution context.
      const validity = Cc["@mozilla.org/mail/search/validityManager;1"].getService(Ci.nsIMsgSearchValidityManager);
      const scopes = new Set();
      if (def.filterType & 1) scopes.add(a.server.filterScope);
      if (def.filterType & ~1) scopes.add(a.server.filterScope === Ci.nsMsgSearchScope.offlineMailFilter
        ? Ci.nsMsgSearchScope.offlineMail : Ci.nsMsgSearchScope.onlineManual);
      for (const term of filter.searchTerms) {
        if (term.matchAll) continue;
        if ([Ci.nsMsgSearchAttrib.Custom, Ci.nsMsgSearchAttrib.HdrProperty, Ci.nsMsgSearchAttrib.Uint32HdrProperty].includes(term.attrib)) fail("unsupported-term");
        const attrib = term.attrib > Ci.nsMsgSearchAttrib.OtherHeader ? Ci.nsMsgSearchAttrib.OtherHeader : term.attrib;
        if (attrib === Ci.nsMsgSearchAttrib.OtherHeader && !Services.prefs.getStringPref("mailnews.customHeaders", "")
          .split(":").map(value => value.trim().toLowerCase()).includes(term.arbitraryHeader.toLowerCase())) fail("custom-header-unavailable");
        for (const scope of scopes) if (!validity.getTable(scope).getAvailable(attrib, term.op)) fail("term-unavailable");
      }
      filter.filterDesc = M.encodeDescription(def.description);
      if (marker) filter.filterDesc = M.appendOwnership(filter.filterDesc, marker.groupId, marker.memberId);
      filter.enabled = def.enabled; filter.filterType = def.filterType;
      // Native widgets permit these 13 actions for both supported mail scopes
      // for all six triggers; POP-only, news-only and custom actions are excluded.
      for (const data of concrete.actions) {
        const action = filter.createAction(); action.type = Ci.nsMsgFilterAction[data.type];
        if (!Number.isInteger(action.type)) fail("unsupported-action");
        const field = fields[data.type];
        if (data.destination) action.targetFolderUri = folder(data.destination).URI;
        else if (data.type === "AddTag") {
          if (!MailServices.tags.getAllTags().some(tag => tag.key === data.tagKey)) fail("tag-unavailable");
          action.strValue = data.tagKey;
        } else if (field) action[field] = data[field];
        filter.appendAction(action);
      }
      return { filter, list, raw: snapshot(filter) };
    }
    function append(a, definition, mappings, conditions) {
      const built = build(a, definition, mappings);
      if (!M.canAppendSenders(definition)) fail("sender-logic-unsupported");
      const added = [], existing = [];
      for (const c of conditions) {
        const op = c.op === "is" ? Ci.nsMsgSearchOp.Is : Ci.nsMsgSearchOp.Contains;
        if (built.filter.searchTerms.some(t => t.attrib === Ci.nsMsgSearchAttrib.Sender && t.op === op && t.value.str.toLowerCase() === c.value)) {
          existing.push(c.value); continue;
        }
        const t = built.filter.createTerm(); t.attrib = Ci.nsMsgSearchAttrib.Sender; t.op = op;
        const value = t.value; value.attrib = t.attrib; value.str = c.value; t.value = value; t.booleanAnd = false;
        built.filter.appendTerm(t); added.push(c.value);
      }
      return { definition: M.validateDefinition({ ...definition, ...conditionText(snapshot(built.filter)) }), added, existing };
    }
    function edit(a, definition, mappings, windowId) {
      const built = build(a, definition, mappings);
      const win = windowId === null ? Services.wm.getMostRecentWindow("mail:3pane") : context.extension.windowManager.get(windowId)?.window;
      if (!win || win.closed) fail("window-unavailable");
      const args = { filterList: built.list, filter: built.filter };
      win.openDialog("chrome://messenger/content/FilterEditor.xhtml", "", "chrome,modal,titlebar,centerscreen,resizable", args);
      if (!args.refresh || !args.newFilter) return { canceled: true };
      const exported = exportRule(snapshot(args.newFilter));
      const reconciled = M.reconcileFolderSlots(definition, mappings, M.materializeDefinition(exported.definition, exported.mappings),
        exported.definition.actions.filter(action => action.slotId).map(action => action.slotId));
      return { canceled: false, ...reconciled };
    }
    return { uuid, accounts: () => accounts().map(a => a.key), account, reason, read, bytes: a => bytes(a.file),
      snapshot, snapshotList, listFilters, live, openWindow, build, exportRule, append, edit,
      accountForList(list) {
        const found = accounts().find(a => a.incomingServer === list.folder?.server);
        if (!found) fail("account-unavailable"); return account(found.key);
      },
      inbox: a => runFolder(a.root.getFolderWithFlags(Ci.nsMsgFolderFlags.Inbox)), runFolder,
      runFilters(folder, filters, sourceList, win, control) {
        const list = MailServices.filters.getTempFilterList(folder);
        list.loggingEnabled = sourceList.loggingEnabled; list.logStream = sourceList.logStream;
        filters.forEach((filter, index) => list.insertFilterAt(index, filter));
        return new Promise((resolve, reject) => {
          control.abort = () => { try { win.getInterface(Ci.nsIWebNavigation).stop(Ci.nsIWebNavigation.STOP_ALL); } catch {} };
          try {
            MailServices.filters.applyFiltersToFolders(list, [folder], win.gFilterListMsgWindow, {
              onStopOperation(status) {
                control.abort = null;
                if ((status & 0x80000000) === 0) resolve();
                else reject(new M.ModelError("shared-run-filtering-failed"));
              },
            });
          } catch (error) { control.abort = null; reject(error); }
        });
      },
      tagChoices: () => MailServices.tags.getAllTags().map(tag => ({ key: tag.key, name: tag.tag })),
      folderChoices() {
        const result = [];
        for (const native of accounts()) {
          const visit = node => {
            if (!node.isServer) try {
              const ref = folderRef(node.URI); result.push({ ...ref, label: `${native.incomingServer.prettyName} — ${ref.path}` });
            } catch { /* Non-fileable/virtual destinations are not choices. */ }
            for (const child of node.subFolders) visit(child);
          };
          if (["imap", "pop3", "none"].includes(native.incomingServer.type)) visit(native.incomingServer.rootFolder);
        }
        return result;
      },
    };
  };
})(this);
