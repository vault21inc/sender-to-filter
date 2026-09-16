/* Test-only native feasibility probes. Never shipped in the production XPI. */
"use strict";
(function (exports) {
  const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
  const { ExtensionSupport } = ChromeUtils.importESModule("resource:///modules/ExtensionSupport.sys.mjs");
  const { setTimeout, clearTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
  Cu.importGlobalProperties(["IOUtils", "PathUtils", "TextEncoder"]);
  const ACTION = Ci.nsMsgFilterAction;
  const EDITOR = "chrome://messenger/content/FilterEditor.xhtml";
  const MANAGER = "chrome://messenger/content/FilterListDialog.xhtml";
  const GROUP = "11111111-1111-4111-8111-111111111111";
  const MEMBER = ["22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];
  const actionFields = new Map([
    [ACTION.MoveToFolder, "targetFolderUri"], [ACTION.CopyToFolder, "targetFolderUri"],
    [ACTION.AddTag, "strValue"], [ACTION.ChangePriority, "priority"], [ACTION.JunkScore, "junkScore"],
    ...["MarkRead", "MarkUnread", "MarkFlagged", "Delete", "StopExecution", "KillThread", "KillSubthread", "WatchThread"]
      .map(name => [ACTION[name], null]),
  ]);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const filters = list => Array.from({ length: list.filterCount }, (_, i) => list.getFilterAt(i));
  const nativeFile = path => {
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(path);
    return file;
  };
  // filterDesc is ACString: preserve its native bytes, including UTF-8 text.
  const byteString = text => Array.from(new TextEncoder().encode(text), byte => String.fromCharCode(byte)).join("");
  const suffix = member => ` [stf-shared:v1:${GROUP}:${member}]`;

  function termSnapshot(term) {
    return {
      text: term.termAsString, attrib: term.attrib, op: term.op,
      booleanAnd: term.booleanAnd, matchAll: term.matchAll,
      beginsGrouping: term.beginsGrouping, endsGrouping: term.endsGrouping,
      arbitraryHeader: term.arbitraryHeader,
    };
  }

  function actionSnapshot(action) {
    if (!actionFields.has(action.type)) throw new Error("unsupported-action");
    const field = actionFields.get(action.type);
    return { type: action.type, ...(field ? { [field]: action[field] } : {}) };
  }

  function snapshot(filter) {
    return {
      name: filter.filterName, description: filter.filterDesc,
      enabled: filter.enabled, filterType: filter.filterType,
      temporary: filter.temporary, unparseable: filter.unparseable,
      terms: filter.searchTerms.map(termSnapshot),
      actions: Array.from({ length: filter.actionCount }, (_, i) => actionSnapshot(filter.getActionAt(i))),
    };
  }

  const listSnapshot = (list, persistentOnly = false) => ({
    loggingEnabled: list.loggingEnabled,
    filters: filters(list).filter(filter => !persistentOnly || !filter.temporary).map(snapshot),
  });

  function conditionText(filter) {
    const terms = filter.searchTerms;
    if (filter.temporary || filter.unparseable || !terms.length) throw new Error("unsupported-rule");
    if (terms.some(term => term.beginsGrouping || term.endsGrouping)) throw new Error("grouped");
    if (terms.some(term => term.matchAll)) {
      if (terms.length !== 1) throw new Error("mixed-all");
      return "ALL";
    }
    if (terms.slice(1).some(term => term.booleanAnd !== terms[1].booleanAnd)) throw new Error("mixed-connectors");
    if (terms.some(term => term.attrib === Ci.nsMsgSearchAttrib.Custom ||
        term.attrib === Ci.nsMsgSearchAttrib.HdrProperty || term.attrib === Ci.nsMsgSearchAttrib.Uint32HdrProperty)) {
      throw new Error("unsupported-term");
    }
    return terms.map(term => `${term.booleanAnd ? "AND" : "OR"} (${term.termAsString})`).join(" ");
  }

  function clone(source, list, destination = null) {
    const text = conditionText(source);
    const actions = Array.from({ length: source.actionCount }, (_, i) => actionSnapshot(source.getActionAt(i)));
    const candidate = list.createFilter(source.filterName);
    list.parseCondition(candidate, text);
    if (conditionText(candidate) !== text || !same(source.searchTerms.map(termSnapshot), candidate.searchTerms.map(termSnapshot))) {
      throw new Error("condition-round-trip");
    }
    candidate.filterDesc = source.filterDesc;
    candidate.enabled = source.enabled;
    candidate.filterType = source.filterType;
    for (const data of actions) {
      const action = candidate.createAction();
      action.type = data.type;
      const field = actionFields.get(data.type);
      if (field) action[field] = field === "targetFolderUri" && destination ? destination.URI : data[field];
      candidate.appendAction(action);
    }
    return candidate;
  }

  async function bytes(file) {
    return await IOUtils.exists(file.path) ? Array.from(await IOUtils.read(file.path)) : null;
  }

  // All loader side effects are confined to this private directory. The caller
  // receives JSON observations only, never a scratch list to install on a server.
  async function inspectFile(file, rootFolder, profile) {
    const before = await bytes(file);
    const directory = nativeFile(PathUtils.join(profile, "shared-inspection"));
    directory.createUnique(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
    const scratch = directory.clone();
    scratch.append("msgFilterRules.dat");
    let result;
    try {
      if (before !== null) {
        scratch.create(Ci.nsIFile.NORMAL_FILE_TYPE, 0o600);
        await IOUtils.write(scratch.path, new Uint8Array(before));
      }
      try {
        const parsed = MailServices.filters.OpenFilterList(scratch, rootFolder, null);
        const observed = listSnapshot(parsed);
        const rewritten = !same(before, await bytes(scratch));
        // OpenFilterList can silently accept a truncated attribute and return
        // an incomplete list. Success alone is not proof of lossless parsing.
        // Serialize only back into our scratch file and require exact bytes.
        parsed.defaultFile = scratch;
        parsed.saveToDefaultFile();
        const normalized = !same(before, await bytes(scratch));
        result = {
          status: before === null || before.length === 0 ? "empty" : rewritten ? "migration-required" :
            observed.filters.some(filter => filter.unparseable) ? "unparseable" : normalized ? "normalization-required" : "ok",
          snapshot: observed,
        };
      } catch (error) {
        result = { status: "parse-error", error: error.name };
      }
    } finally {
      directory.remove(true);
      if (!same(before, await bytes(file))) throw new Error("inspection-mutated-original");
    }
    return result;
  }

  function rulesFile(server) {
    const file = server.localPath.clone();
    file.append("msgFilterRules.dat");
    file.normalize();
    return file;
  }

  function accountReason(account, selected = []) {
    const server = account.incomingServer;
    if (!["imap", "pop3"].includes(server.type)) return "unsupported-account";
    if (server.rootFolder !== server.rootMsgFolder) return "deferred-source";
    if (MailServices.accounts.accounts.some(other => other.incomingServer?.type === "pop3" &&
        other.incomingServer.rootFolder !== other.incomingServer.rootMsgFolder &&
        other.incomingServer.rootMsgFolder === server.rootFolder)) return "deferred-destination";
    if (selected.some(other => other.incomingServer === server || rulesFile(other.incomingServer).equals(rulesFile(server)))) {
      return "shared-rules-file";
    }
    return null;
  }

  function hasLiveWindow(list) {
    for (const win of Services.wm.getEnumerator(null)) {
      const uri = win.document.documentURI;
      if (uri !== EDITOR && uri !== MANAGER) continue;
      const affected = win.arguments?.[0]?.filterList || win.gCurrentFilterList;
      if (!affected || affected === list) return true;
    }
    return false;
  }

  async function waitFor(predicate, label) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const result = predicate();
      if (result) return result;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`Timed out waiting for ${label}`);
  }

  async function makeAccount(profile, label, type, directory = label, deferredTo = null) {
    const path = PathUtils.join(profile, "shared-fixtures", directory);
    await IOUtils.makeDirectory(path, { ignoreExisting: true, createAncestors: true, permissions: 0o700 });
    const server = MailServices.accounts.createIncomingServer(label, `${label}.invalid`, type);
    server.localPath = nativeFile(path);
    server.prettyName = `Shared fixture ${label}`;
    server.doBiff = false;
    server.loginAtStartUp = false;
    server.valid = true;
    if (deferredTo) server.QueryInterface(Ci.nsIPop3IncomingServer).deferredToAccount = deferredTo.key;
    const account = MailServices.accounts.createAccount();
    account.incomingServer = server;
    const identity = MailServices.accounts.createIdentity();
    identity.fullName = `Shared fixture ${label}`;
    identity.email = `${label}@example.invalid`;
    account.addIdentity(identity);
    return { account, server, root: server.rootFolder };
  }

  function appendTerm(filter, text, { and = false, all = false, header = null } = {}) {
    const term = filter.createTerm();
    term.attrib = header ? Ci.nsMsgSearchAttrib.OtherHeader + 1 : Ci.nsMsgSearchAttrib.Subject;
    term.op = Ci.nsMsgSearchOp.Contains;
    if (header) term.arbitraryHeader = header;
    const value = term.value;
    value.attrib = term.attrib;
    value.str = text;
    term.value = value;
    term.booleanAnd = and;
    term.matchAll = all;
    filter.appendTerm(term);
    return term;
  }

  function makeRule(list, name, logic = "single", actionNames = ["MarkRead"], destination = null) {
    const filter = list.createFilter(name);
    filter.enabled = false;
    filter.filterType = Ci.nsMsgFilterType.InboxRule | Ci.nsMsgFilterType.Manual;
    filter.filterDesc = byteString('Notes "quoted" (café) 日本語');
    if (logic === "all") list.parseCondition(filter, "ALL");
    else {
      appendTerm(filter, 'a "quoted" value (café) 日本語', { and: logic === "and" });
      if (logic === "or" || logic === "and") {
        appendTerm(filter, "second (value)", { and: logic === "and", header: "X-STF-Test" });
      }
    }
    for (const name of actionNames) {
      const action = filter.createAction();
      action.type = ACTION[name];
      switch (name) {
        case "MoveToFolder": case "CopyToFolder": action.targetFolderUri = destination.URI; break;
        case "AddTag": action.strValue = "$label1"; break;
        case "ChangePriority": action.priority = Ci.nsMsgPriority.high; break;
        case "JunkScore": action.junkScore = 100; break;
      }
      filter.appendAction(action);
    }
    return filter;
  }

  // Drive the real modal contract used by the proposed shared editor. The
  // observer is test-only and removed on every exit, including dialog failures.
  function editModal(main, list, filter, mode, check) {
    const args = { filterList: list, filter };
    let opened = false, failure, timer;
    const listener = "sender-to-filter-shared-native-editor";
    ExtensionSupport.registerWindowListener(listener, {
      chromeURLs: [EDITOR],
      onLoadWindow(win) {
        opened = true;
        timer = setTimeout(() => { failure = new Error("shared-editor-timeout"); win.close(); }, 5000);
        setTimeout(() => {
          try {
            check("native editor exposes its affected list", hasLiveWindow(list));
            win.document.getElementById("filterName").value = `${filter.filterName} edited`;
            if (mode === "accept") win.document.querySelector("dialog").acceptDialog();
            else if (mode === "cancel") win.document.querySelector("dialog").cancelDialog();
            else win.close();
          } catch (error) {
            failure = error;
            win.close();
          }
        }, 0);
      },
    });
    try {
      main.openDialog(EDITOR, "", "chrome,modal,titlebar,centerscreen,resizable", args);
    } finally {
      clearTimeout(timer);
      ExtensionSupport.unregisterWindowListener(listener);
    }
    if (failure) throw failure;
    if (!opened) throw new Error("native-editor-not-opened");
    return args;
  }

  exports.runSharedNative = async function (profile, phase) {
    const checks = [];
    const check = (name, passed) => {
      if (!passed) throw new Error(name);
      checks.push(`shared: ${name}`);
    };
    try {
      const expectedPath = PathUtils.join(profile, "shared-native-expected.json");
      if (phase === "restart") {
        const expected = await IOUtils.readJSON(expectedPath);
        check("restart runs in a different Thunderbird process", expected.processId !== Services.appinfo.processID);
        for (const saved of expected.accounts) {
          const account = MailServices.accounts.getAccount(saved.accountId);
          check(`${saved.type} account identity survives restart`, account?.incomingServer.key === saved.serverKey);
          const inspected = await inspectFile(rulesFile(account.incomingServer), account.incomingServer.rootFolder, profile);
          check(`${saved.type} complete rules and ownership survive restart`, inspected.status === "ok" &&
            same(inspected.snapshot, saved.snapshot));
          const live = account.incomingServer.getEditableFilterList(null);
          check(`${saved.type} restarted live list agrees with inspected disk`, same(listSnapshot(live, true), saved.snapshot));
        }
        return { ok: true, phase, checks };
      }

      Services.io.offline = true;
      Services.prefs.setStringPref("mailnews.customHeaders", "X-STF-Test");
      const imap = await makeAccount(profile, "imap", "imap");
      const pop = await makeAccount(profile, "pop", "pop3");
      const fixtures = [imap, pop];
      for (const fixture of fixtures) {
        fixture.destination = fixture.root.addSubfolder("Shared destination");
        fixture.list = fixture.server.getEditableFilterList(null);
        check(`${fixture.server.type} resolves a distinct standard live list`, !accountReason(fixture.account) &&
          fixture.list === fixture.server.getFilterList(null) && fixture.list.defaultFile.equals(rulesFile(fixture.server)));
      }
      check("IMAP and POP have independent rules files", !rulesFile(imap.server).equals(rulesFile(pop.server)));

      const alias = await makeAccount(profile, "alias", "imap", "imap-alias");
      check("physical rules-file aliases are rejected", accountReason(alias.account, [imap.account]) === "shared-rules-file");
      check("same incoming server cannot be enrolled twice", accountReason(imap.account, [imap.account]) === "shared-rules-file");
      check("Local Folders cannot be a member", accountReason(MailServices.accounts.accounts.find(account =>
        account.incomingServer.type === "none")) === "unsupported-account");
      const deferredTarget = await makeAccount(profile, "deferred-target", "pop3");
      const deferred = await makeAccount(profile, "deferred-source", "pop3", "deferred-source", deferredTarget.account);
      check("deferred POP source and destination are rejected", accountReason(deferred.account) === "deferred-source" &&
        accountReason(deferredTarget.account) === "deferred-destination");

      const allowedNames = ["MoveToFolder", "CopyToFolder", "AddTag", "MarkRead", "MarkUnread", "MarkFlagged",
        "ChangePriority", "JunkScore", "Delete", "StopExecution", "KillThread", "KillSubthread", "WatchThread"];
      const sources = [
        ...["single", "or", "and", "all"].map(logic => makeRule(imap.list, `Logic ${logic}`, logic)),
        ...allowedNames.map(name => makeRule(imap.list, `Action ${name}`, "single", [name], imap.destination)),
        makeRule(imap.list, "Action order", "or", ["CopyToFolder", "AddTag", "MarkFlagged", "MoveToFolder"], imap.destination),
      ];
      for (const [index, fixture] of fixtures.entries()) {
        fixture.list.loggingEnabled = true;
        for (const source of sources) {
          const copy = clone(source, fixture.list, fixture.destination);
          copy.filterDesc += suffix(MEMBER[index]);
          // Each rule gets an independent marker for a real shared group. These
          // fixtures probe persistence; only the selected editor rule uses GROUP.
          if (source.filterName !== "Logic single") copy.filterDesc = copy.filterDesc.replace(GROUP, Services.uuid.generateUUID().toString().slice(1, -1));
          fixture.list.insertFilterAt(fixture.list.filterCount, copy);
        }
        fixture.list.saveToDefaultFile();
        const saved = await inspectFile(fixture.list.defaultFile, fixture.root, profile);
        check(`${fixture.server.type} single/OR/AND/ALL, Unicode, quotes and headers round-trip`, saved.status === "ok" &&
          same(saved.snapshot.filters.slice(0, 4), listSnapshot(fixture.list, true).filters.slice(0, 4)));
        check(`${fixture.server.type} all 13 supported actions and their order round-trip`,
          same(saved.snapshot, listSnapshot(fixture.list, true)));
        check(`${fixture.server.type} description bytes and ownership suffix survive reload`,
          saved.snapshot.filters[0].description === sources[0].filterDesc + suffix(MEMBER[index]));
        check(`${fixture.server.type} folder actions use its chosen destination`, saved.snapshot.filters
          .flatMap(filter => filter.actions).filter(action => "targetFolderUri" in action)
          .every(action => action.targetFolderUri === fixture.destination.URI));
      }

      const source = imap.list.getFilterNamed("Logic or");
      const isolated = clone(source, pop.list);
      const original = snapshot(source);
      const changed = isolated.searchTerms[0];
      const value = changed.value;
      value.str = "changed independently";
      changed.value = value;
      changed.booleanAnd = !changed.booleanAnd;
      isolated.getActionAt(0).type = ACTION.MarkUnread;
      check("clones share no mutable terms, values or actions", same(snapshot(source), original) &&
        isolated.searchTerms[0] !== source.searchTerms[0] && isolated.getActionAt(0) !== source.getActionAt(0));

      for (const reason of ["temporary", "unparseable", "grouped", "mixed-all", "mixed-connectors", "unsupported-action"]) {
        const invalid = makeRule(imap.list, "Rejected fixture", "or");
        if (reason === "temporary" || reason === "unparseable") invalid[reason] = true;
        if (reason === "grouped") invalid.searchTerms[0].beginsGrouping = 1;
        if (reason === "mixed-all") invalid.searchTerms[0].matchAll = true;
        if (reason === "mixed-connectors") appendTerm(invalid, "third", { and: true });
        if (reason === "unsupported-action") invalid.getActionAt(0).type = ACTION.Forward;
        let rejected = false;
        try { clone(invalid, pop.list); } catch { rejected = true; }
        check(`${reason} is rejected without mutating a live list`, rejected && pop.list.filterCount === sources.length);
      }

      const inspectionDirectory = PathUtils.join(profile, "shared-inspection-inputs");
      await IOUtils.makeDirectory(inspectionDirectory, { permissions: 0o700 });
      const valid = await IOUtils.readUTF8(imap.list.defaultFile.path);
      let prompts = 0;
      const observer = { observe(win, topic) {
        if (topic !== "domwindowopened") return;
        win.addEventListener("load", () => { prompts++; win.close(); }, { once: true });
      } };
      Services.ww.registerNotification(observer);
      try {
        for (const [name, content] of [["missing", null], ["empty", ""],
          ["old-format", valid.replace(/version="\d+"/, 'version="6"')],
          ["corrupt", 'version="9"\nlogging="no"\nname="unterminated']]) {
          const file = nativeFile(PathUtils.join(inspectionDirectory, `${name}.dat`));
          if (content !== null) await IOUtils.writeUTF8(file.path, content);
          const observed = await inspectFile(file, imap.root, profile);
          check(`${name} inspection preserves original bytes/existence without prompts`, prompts === 0 &&
            (content === null ? !file.exists() : same(await bytes(file), Array.from(new TextEncoder().encode(content)))));
          check(`${name} is classified before any live-list load`, name === "missing" || name === "empty"
            ? observed.status === "empty" : observed.status !== "ok");
        }
      } finally {
        Services.ww.unregisterNotification(observer);
      }

      const liveList = imap.list;
      const beforeList = listSnapshot(liveList);
      const beforeFile = await bytes(liveList.defaultFile);
      const temporary = makeRule(liveList, "Temporary runtime rule");
      temporary.temporary = true;
      liveList.insertFilterAt(1, temporary);
      const oldFilter = liveList.getFilterAt(0);
      const replacement = clone(oldFilter, liveList);
      replacement.filterName += " replaced";
      liveList.setFilterAt(0, replacement);
      liveList.saveToDefaultFile();
      const replaced = await inspectFile(liveList.defaultFile, imap.root, profile);
      check("fresh replacement preserves unrelated order, logging and temporary entries", liveList.getFilterAt(1) === temporary &&
        replaced.snapshot.loggingEnabled === beforeList.loggingEnabled &&
        same(replaced.snapshot.filters.slice(1), beforeList.filters.slice(1)));
      liveList.setFilterAt(0, oldFilter);
      liveList.saveToDefaultFile();
      const savedFile = liveList.defaultFile;
      const failureFile = savedFile.clone();
      failureFile.append("rules.dat");
      let failed = false;
      try {
        liveList.defaultFile = failureFile;
        liveList.setFilterAt(0, replacement);
        liveList.saveToDefaultFile();
      } catch {
        failed = true;
        liveList.setFilterAt(0, oldFilter);
      } finally {
        liveList.defaultFile = savedFile;
      }
      check("replacement save failure restores original object and disk bytes", failed &&
        liveList.getFilterAt(0) === oldFilter && liveList.getFilterAt(1) === temporary &&
        same(listSnapshot(liveList, true), beforeList) && same(await bytes(savedFile), beforeFile));
      liveList.removeFilter(temporary);

      const main = await waitFor(() => Services.wm.getMostRecentWindow("mail:3pane"), "main mail window");
      const managed = liveList.getFilterAt(0);
      const description = managed.filterDesc;
      const accepted = editModal(main, liveList, managed, "accept", check);
      check("ownership survives ordinary native editor acceptance", accepted.refresh && accepted.newFilter === managed &&
        managed.filterDesc === description);
      liveList.saveToDefaultFile();
      const edited = await inspectFile(savedFile, imap.root, profile);
      check("native editor ownership persists on disk", edited.snapshot.filters[0].description === description);

      for (const mode of ["cancel", "close", "accept"]) {
        const originalState = listSnapshot(liveList);
        const originalBytes = await bytes(savedFile);
        const detachedList = MailServices.filters.getTempFilterList(imap.root);
        detachedList.defaultFile = null;
        const draft = clone(managed, detachedList);
        const result = editModal(main, detachedList, draft, mode, check);
        check(`detached editor ${mode} never writes or changes the real list`,
          same(listSnapshot(liveList), originalState) && same(await bytes(savedFile), originalBytes) &&
          !detachedList.defaultFile && (mode === "accept" ? result.refresh && result.newFilter === draft : !result.refresh));
      }
      check("closed editors no longer block the affected list", !hasLiveWindow(liveList));
      const manager = main.openDialog(MANAGER, "", "chrome,dialog=no,resizable", { folder: imap.root });
      try {
        await waitFor(() => manager.document.readyState === "complete" && manager.gCurrentFilterList, "filter manager");
        check("native filter manager exposes its affected list", hasLiveWindow(liveList) && manager.gCurrentFilterList === liveList);
      } finally {
        manager.close();
      }

      const expected = { processId: Services.appinfo.processID, accounts: [] };
      for (const fixture of fixtures) {
        fixture.list.saveToDefaultFile();
        expected.accounts.push({ accountId: fixture.account.key, serverKey: fixture.server.key,
          type: fixture.server.type, snapshot: listSnapshot(fixture.list, true) });
      }
      await IOUtils.writeJSON(expectedPath, expected);
      Services.prefs.savePrefFile(null);
      return { ok: true, phase, checks, requiresRestart: true };
    } catch (error) {
      return { ok: false, phase, checks, error: String(error), stack: error.stack };
    }
  };
  exports.setupSharedProduction = async function (profile) {
    const result = [];
    for (const type of ["imap", "pop3"]) {
      const fixture = await makeAccount(profile, `production-${type}`, type);
      if (type === "imap") fixture.root.QueryInterface(Ci.nsIMsgImapMailFolder)
        .createClientSubfolderInfo("SharedDestination", "/", 0, true);
      else fixture.root.QueryInterface(Ci.nsIMsgLocalMailFolder).createLocalSubfolder("SharedDestination");
      const destination = fixture.root.getChildNamed("SharedDestination");
      const list = fixture.server.getEditableFilterList(null);
      if (type === "imap") list.insertFilterAt(0, makeRule(list, "Shared production", "single", ["MarkRead", "MoveToFolder"], destination));
      list.saveToDefaultFile();
      result.push({ accountId: fixture.account.key, path: "/SharedDestination" });
    }
    if (["Darwin", "Linux"].includes(Services.appinfo.OS)) {
      const first = await makeAccount(profile, "hardlink-first", "imap");
      const second = await makeAccount(profile, "hardlink-second", "imap");
      const list = first.server.getEditableFilterList(null);
      list.insertFilterAt(0, makeRule(list, "Hard-link fixture")); list.saveToDefaultFile();
      const executable = nativeFile("/bin/ln"), process = Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);
      const destination = second.server.localPath.clone(); destination.append("msgFilterRules.dat");
      process.init(executable); process.runw(true, [list.defaultFile.path, destination.path], 2);
      if (process.exitValue !== 0) throw new Error("hardlink-fixture-failed");
    }
    Services.prefs.savePrefFile(null);
    return result;
  };
  exports.duplicateSharedProduction = function (accountId) {
    const account = MailServices.accounts.getAccount(accountId);
    if (!account.incomingServer.prettyName.startsWith("Shared fixture production-")) throw new Error("not-a-production-fixture");
    const list = account.incomingServer.getFilterList(null);
    const copy = clone(list.getFilterAt(0), list);
    list.insertFilterAt(list.filterCount, copy);
    list.saveToDefaultFile();
  };
  exports.setupSharedRunFixtures = async function (profile) {
    const result = [];
    for (const label of ["run-first", "run-second", "run-unlinked"]) {
      const f = await makeAccount(profile, label, "pop3");
      for (const name of ["Inbox", "Other", "Filed"]) {
        let folder;
        try { folder = f.root.getChildNamed(name); } catch {}
        if (!folder) f.root.QueryInterface(Ci.nsIMsgLocalMailFolder).createLocalSubfolder(name);
      }
      f.root.getChildNamed("Inbox").setFlag(Ci.nsMsgFolderFlags.Inbox);
      const list = f.server.getEditableFilterList(null);
      if (label === "run-first") list.insertFilterAt(0, makeRule(list, "Run across Inboxes", "all", ["MarkRead", "MoveToFolder"], f.root.getChildNamed("Filed")));
      list.saveToDefaultFile();
      result.push({ accountId: f.account.key, path: "/Filed" });
    }
    Services.prefs.savePrefFile(null); return result;
  };
})(this);
