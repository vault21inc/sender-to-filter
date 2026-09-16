/* Test-only: actual message actions in disposable offline POP account folders. */
"use strict";
(function (exports) {
  const { setTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
  Cu.importGlobalProperties(["IOUtils", "PathUtils"]);
  async function waitFor(predicate, label) {
    const end = Date.now() + 10000;
    while (Date.now() < end) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
    throw new Error(`Timed out waiting for ${label}`);
  }
  function localRule(list, name, type, enabled = true) {
    const filter = list.createFilter(name); list.parseCondition(filter, "ALL"); filter.enabled = enabled; filter.filterType = 16;
    const action = filter.createAction(); action.type = type; filter.appendAction(action);
    list.insertFilterAt(list.filterCount, filter); return filter;
  }
  async function screenshot(win, profile) {
    await win.document.l10n.translateElements([win.document.getElementById("countBox")]);
    const bitmap = await win.browsingContext.currentWindowGlobal.drawSnapshot(new win.DOMRect(0, 0, win.innerWidth, win.innerHeight), 1, "white");
    const canvas = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    canvas.width = bitmap.width; canvas.height = bitmap.height; canvas.getContext("2d").drawImage(bitmap, 0, 0);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
    await IOUtils.write(PathUtils.join(profile, "native-shared-run.png"), new Uint8Array(await blob.arrayBuffer())); bitmap.close();
  }
  exports.checkSharedManualRun = async (context, accountIds, profile) => {
    const checks = [], check = (name, value, details) => { if (!value) throw new Error(`${name}${details ? ": " + JSON.stringify(details) : ""}`); checks.push(name); };
    const roots = accountIds.map(id => context.extension.folderManager.get(id, "/"));
    const inboxes = roots.map(root => root.getChildNamed("Inbox")), others = roots.map(root => root.getChildNamed("Other"));
    const filed = roots.map(root => root.getChildNamed("Filed"));
    const count = folder => folder.getTotalMessages(false);
    let serial = 0;
    function add(folder) {
      folder.QueryInterface(Ci.nsIMsgLocalMailFolder).addMessage(`From - Wed Sep 16 12:00:00 2026\r\nFrom: fixture@example.invalid\r\nTo: test@example.invalid\r\nSubject: Shared run fixture\r\nMessage-ID: <stf-run-${++serial}@example.invalid>\r\nDate: Wed, 16 Sep 2026 12:00:00 +0000\r\nX-Mozilla-Status: 0000\r\nX-Mozilla-Status2: 00000000\r\n\r\nSynthetic local message.\r\n`);
    }
    inboxes.forEach(add); others.forEach(add);
    const main = Services.wm.getMostRecentWindow("mail:3pane");
    const win = main.openDialog("chrome://messenger/content/FilterListDialog.xhtml", "", "chrome,dialog=no,resizable", { folder: roots[0] });
    const secondList = roots[1].getEditableFilterList(null), second = secondList.getFilterAt(0), enabled = second.enabled;
    try {
      await waitFor(() => win.document.readyState === "complete" && win.document.querySelector(".stf-shared-run-options checkbox"), "shared run checkbox");
      const cross = win.document.querySelector(".stf-shared-run-options checkbox"), stop = win.document.querySelector(".stf-shared-run-options button");
      const note = win.document.querySelector(".stf-shared-run-scope"), run = win.document.getElementById("runFiltersButton");
      const rows = win.document.getElementById("filterList");
      const command = element => element.dispatchEvent(new win.Event("command", { bubbles: true, cancelable: true }));
      const choose = checked => { cross.checked = checked; command(cross); };
      const sourceList = win.gCurrentFilterList, added = [], originalBytes = await IOUtils.readUTF8(sourceList.defaultFile.path);
      try {
        added.push(localRule(sourceList, "Enabled first", Ci.nsMsgFilterAction.MarkRead));
        added.push(localRule(sourceList, "Enabled stop", Ci.nsMsgFilterAction.StopExecution));
        added.push(localRule(sourceList, "Enabled last", Ci.nsMsgFilterAction.MarkFlagged));
        added.push(localRule(sourceList, "Disabled selected", Ci.nsMsgFilterAction.Delete, false));
        sourceList.saveToDefaultFile(); const saved = await IOUtils.readUTF8(sourceList.defaultFile.path);
        const search = win.document.getElementById("searchBox"); search.value = "Disabled selected"; win.rebuildFilterList();
        rows.selectItem(rows.itemChildren[0]); win.setRunFolder(others[0]);
        const all = win.document.getElementById("stf-run-all-enabled");
        check("native Run all enabled counts hidden enabled rules independently of a disabled highlighted row", all.label === "Run all enabled filters (3)" &&
          run.label === "Run selected filters (1)" && win.document.querySelector(".stf-run-all-preview").textContent.includes("Enabled first"));
        rows.clearSelection();
        check("native Run all enabled remains available with no highlighted rows", run.disabled && !all.disabled && !win.gRunFiltersFolder.disabled);
        rows.selectItem(rows.itemChildren[0]); command(all);
        await waitFor(() => !win.gRunningFilters && note.textContent.includes("Finished running filters"), "local enabled run");
        const header = [...others[0].messages][0];
        check("native Run all enabled executes hidden rules in list order including Stop Execution", count(others[0]) === 1 && header.isRead && !header.isFlagged);
        check("native Run all enabled excludes disabled selected and shared filters", count(inboxes[0]) === 1 && count(inboxes[1]) === 1 && count(filed[0]) === 0 && count(filed[1]) === 0);
        check("native local enabled run preserves other accounts and reports one completed folder", ![...others[1].messages][0].isRead && note.textContent.includes("1 folder(s)"));
        check("native Run all enabled preserves search, selection, enabled flags and saved rules", search.value === "Disabled selected" &&
          rows.selectedItems.length === 1 && rows.selectedItems[0]._filter === added[3] && !added[3].enabled &&
          added.slice(0, 3).every(filter => filter.enabled) && await IOUtils.readUTF8(sourceList.defaultFile.path) === saved);
      } finally {
        added.forEach(filter => sourceList.removeFilter(filter)); sourceList.saveToDefaultFile();
        win.document.getElementById("searchBox").value = ""; win.rebuildFilterList();
      }
      check("native enabled-run fixtures restore the original source rule bytes", await IOUtils.readUTF8(sourceList.defaultFile.path) === originalBytes);
      rows.selectItem(rows.itemChildren[0]); win.setRunFolder(others[0]); command(cross);
      check("native shared run is prechecked and ignores the selected folder for shared copies", cross.checked && win.gRunFiltersFolder.disabled && !run.disabled);
      command(run);
      await waitFor(() => note.textContent.includes("Finished running filters"), "cross-account completion: " + note.textContent);
      check("native shared run moves matching Inbox mail into each account's mapped destination", count(inboxes[0]) === 0 && count(inboxes[1]) === 0 && count(filed[0]) === 1 && count(filed[1]) === 1);
      check("native shared run preserves non-Inbox and unlinked-account mail", others.every(folder => count(folder) === 1) && count(inboxes[2]) === 1 && count(filed[2]) === 0);
      check("native shared run executes ordered actions on disabled selected filters", !second.enabled && [...filed[0].messages, ...filed[1].messages].every(header => header.isRead));
      check("native shared run restores controls and reports completed folders", !win.gRunningFilters && !run.disabled && note.textContent.includes("2 folder(s)") &&
        !win.progressMeterVisible && win.document.getElementById("statusText").getAttribute("value") === "");

      await screenshot(win, profile);

      choose(false); check("native unchecked scope re-enables the selected-folder picker", !win.gRunFiltersFolder.disabled);
      command(run); await waitFor(() => !win.gRunningFilters && count(others[0]) === 0, "native local run");
      check("native unchecked Run Now uses only the selected folder", count(filed[0]) === 2 && count(others[1]) === 1 && count(filed[1]) === 1);

      inboxes.slice(0, 2).forEach(add); second.enabled = !enabled; secondList.saveToDefaultFile(); choose(true);
      command(run); await waitFor(() => note.textContent.startsWith("No filters were run."), "drift preflight");
      check("native shared drift preflight prevents actions on every account", count(inboxes[0]) === 1 && count(inboxes[1]) === 1 && count(filed[0]) === 2 && count(filed[1]) === 1);
      second.enabled = enabled; secondList.saveToDefaultFile();
      command(run); command(stop);
      await waitFor(() => !win.gRunningFilters && note.textContent.includes("stopped"), "cancel before execution");
      check("native Stop cancels a queued shared run without processing messages", count(inboxes[0]) === 1 && count(inboxes[1]) === 1);
    } finally { second.enabled = enabled; secondList.saveToDefaultFile(); win.close(); }
    return checks;
  };
  exports.checkEnabledSharedRun = async (context, accountIds, profile) => {
    const checks = [], check = (name, value, details) => { if (!value) throw new Error(`${name}${details ? ": " + JSON.stringify(details) : ""}`); checks.push(name); };
    const roots = accountIds.slice(0, 2).map(id => context.extension.folderManager.get(id, "/"));
    const inboxes = roots.map(root => root.getChildNamed("Inbox")), filed = roots.map(root => root.getChildNamed("Filed"));
    const other = roots[0].getChildNamed("Other"), count = folder => folder.getTotalMessages(false);
    let serial = 0;
    const add = folder => folder.QueryInterface(Ci.nsIMsgLocalMailFolder).addMessage(`From - Wed Sep 16 12:00:00 2026\r\nFrom: fixture@example.invalid\r\nTo: test@example.invalid\r\nSubject: Enabled run fixture\r\nMessage-ID: <stf-enabled-${++serial}@example.invalid>\r\nDate: Wed, 16 Sep 2026 12:00:00 +0000\r\nX-Mozilla-Status: 0000\r\nX-Mozilla-Status2: 00000000\r\n\r\nSynthetic local message.\r\n`);
    add(other);
    const list = roots[0].getEditableFilterList(null), added = [], saved = await IOUtils.readUTF8(list.defaultFile.path);
    const before = filed.map(count), win = Services.wm.getMostRecentWindow("mail:3pane").openDialog(
      "chrome://messenger/content/FilterListDialog.xhtml", "", "chrome,dialog=no,resizable", { folder: roots[0] });
    try {
      await waitFor(() => win.document.readyState === "complete" && win.document.getElementById("stf-run-all-enabled"), "enabled shared controls");
      added.push(localRule(list, "Star local messages", Ci.nsMsgFilterAction.MarkFlagged));
      added.push(localRule(list, "Disabled selected", Ci.nsMsgFilterAction.Delete, false));
      list.saveToDefaultFile(); const withFixtures = await IOUtils.readUTF8(list.defaultFile.path); win.rebuildFilterList();
      const rows = win.document.getElementById("filterList"), all = win.document.getElementById("stf-run-all-enabled");
      const note = win.document.querySelector(".stf-shared-run-scope"), cross = win.document.querySelector(".stf-shared-run-options checkbox");
      const command = element => element.dispatchEvent(new win.Event("command", { bubbles: true, cancelable: true }));
      rows.selectItem(rows.itemChildren.at(-1)); win.setRunFolder(other);
      check("native enabled mixed run previews linked Inboxes and the chosen local folder", cross.checked && all.label === "Run all enabled filters (2)" &&
        win.document.querySelector(".stf-run-all-preview").textContent.includes("Inbox in each linked account") &&
        win.document.querySelector(".stf-run-all-preview").textContent.includes("Other on"));
      await screenshot(win, profile);
      command(all); await waitFor(() => !win.gRunningFilters && note.textContent.includes("Finished running filters"), "enabled shared run");
      check("native Run all enabled runs shared copies across linked Inboxes and ordinary rules on the chosen folder", inboxes.every(folder => count(folder) === 0) &&
        filed.every((folder, i) => count(folder) === before[i] + 1) && count(other) === 1 && [...other.messages][0].isFlagged && note.textContent.includes("3 folder(s)"),
        { inboxes: inboxes.map(count), filed: filed.map(count), before, other: count(other), flags: [...other.messages].map(h => h.flags), note: note.textContent });
      inboxes.forEach(add); cross.checked = false; command(cross); command(all);
      await waitFor(() => !win.gRunningFilters && note.textContent.includes("Finished running filters"), "unchecked enabled shared run");
      check("native unchecked Run all enabled runs shared and ordinary rules only on the chosen folder", inboxes.every(folder => count(folder) === 1) &&
        count(other) === 0 && count(filed[0]) === before[0] + 2 && count(filed[1]) === before[1] + 1 && note.textContent.includes("1 folder(s)"));
      check("native both enabled runs preserve selection and rule bytes", rows.selectedItems[0]._filter === added[1] &&
        !added[1].enabled && list.getFilterAt(0).enabled && await IOUtils.readUTF8(list.defaultFile.path) === withFixtures);
    } finally { added.forEach(filter => list.removeFilter(filter)); list.saveToDefaultFile(); win.close(); }
    check("native enabled shared fixtures restore the source rules", await IOUtils.readUTF8(list.defaultFile.path) === saved);
    return checks;
  };
})(this);
