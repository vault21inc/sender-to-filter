/* Test-only native dialog checks. Runs only after the disposable-profile guard. */
"use strict";
(function (exports) {
  const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
  const { setTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
  Cu.importGlobalProperties(["IOUtils", "PathUtils"]);
  async function waitFor(test, label) {
    const end = Date.now() + 5000;
    while (Date.now() < end) { const value = test(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 20)); }
    throw new Error(`Timed out waiting for ${label}`);
  }
  exports.checkSharedFilterIndicators = async (context, accountIds, profile) => {
    const checks = [], windows = [];
    const check = (name, condition, details) => { if (!condition) throw new Error(`${name}${details ? ": " + JSON.stringify(details) : ""}`); checks.push(name); };
    const root = context.extension.folderManager.get(accountIds[0], "/");
    const list = root.getEditableFilterList(null), managed = list.getFilterAt(0);
    const originals = Array.from({ length: list.filterCount }, (_, i) => list.getFilterAt(i));
    const saved = await IOUtils.readUTF8(list.defaultFile.path);
    const before = { name: managed.filterName, description: managed.filterDesc, enabled: managed.enabled };
    const local = list.createFilter("Local only"); local.temporary = true; local.filterType = 17;
    local.searchTerms = managed.searchTerms; local.enabled = false;
    const action = local.createAction(); action.type = Ci.nsMsgFilterAction.MarkRead; local.appendAction(action);
    list.insertFilterAt(list.filterCount, local);
    const main = await waitFor(() => Services.wm.getMostRecentWindow("mail:3pane"), "main mail window");
    const badge = row => row.querySelector(".stf-shared-filter-badge");
    const open = async accountId => {
      const win = main.openDialog("chrome://messenger/content/FilterListDialog.xhtml", "", "chrome,dialog=no,resizable",
        { folder: context.extension.folderManager.get(accountId, "/") });
      windows.push(win);
      await waitFor(() => win.document.readyState === "complete" && win.document.querySelector(".stf-shared-filter-badge"), "shared filter badge");
      return win;
    };
    try {
      const win = await open(accountIds[0]), other = await open(accountIds[1]);
      const rows = win.document.getElementById("filterList"), note = win.document.querySelector(".stf-shared-run-scope");
      check("native filter lists label shared copies in both account windows", badge(rows.itemChildren[0]).getAttribute("value") === "Shared" &&
        other.document.querySelectorAll(".stf-shared-filter-badge").length === 1);
      check("native ordinary filters have no shared badge", !badge(rows.itemChildren[1]));
      rows.selectItem(rows.itemChildren[0]); await waitFor(() => !note.hidden, "shared run scope");
      const across = win.document.querySelector(".stf-shared-run-options checkbox");
      check("native shared selection defaults to linked account Inboxes", across.checked && note.textContent.includes("Inbox in each linked account"));
      const run = win.document.getElementById("runFiltersButton"), all = win.document.getElementById("stf-run-all-enabled");
      check("native run labels distinguish highlighted rows from automatic checkboxes", run.label === "Run selected filters (1)" &&
        win.document.getElementById("activeColumn").getAttribute("label") === "Run automatically" && note.textContent.includes(managed.filterName));
      across.checked = false; across.dispatchEvent(new win.Event("command", { bubbles: true }));
      check("native unchecked preview excludes linked-account Inboxes", note.textContent.startsWith("Will run:") && !note.textContent.includes("each linked account"));
      across.checked = true; across.dispatchEvent(new win.Event("command", { bubbles: true }));
      rows.selectItem(rows.itemChildren[1]); await waitFor(() => note.textContent.includes("Local only"), "ordinary selection");
      check("native ordinary selection previews the highlighted filter", !note.hidden && !note.textContent.includes("each linked account"));
      rows.addItemToSelection(rows.itemChildren[0]); await waitFor(() => !note.hidden, "mixed selection");
      check("native mixed selection previews both filter scopes and updates the count", run.label === "Run selected filters (2)" &&
        note.textContent.includes("Local only") && note.textContent.includes("each linked account"));

      local.enabled = true; win.toggleFilter(rows.itemChildren[1], true);
      await waitFor(() => all.label.includes(String(Number(managed.enabled) + 1)), "enabled count");
      const allLabel = all.label;

      const search = win.document.getElementById("searchBox"); search.value = "Local only"; win.rebuildFilterList();
      await waitFor(() => rows.itemChildren.length === 1 && !badge(rows.itemChildren[0]), "recycled ordinary row");
      check("native search removes stale shared labels from reused rows", rows.itemChildren[0]._filter === local &&
        !rows.itemChildren[0].hasAttribute("aria-label"));
      check("native Run all enabled includes account filters hidden by search", all.label === allLabel &&
        (!managed.enabled || win.document.querySelector(".stf-run-all-preview").textContent.includes(managed.filterName)));
      win.toggleFilter(rows.itemChildren[0], false);
      search.value = ""; win.rebuildFilterList(); await waitFor(() => badge(rows.itemChildren[0]), "restored shared row");
      const row = rows.itemChildren[0];
      check("native name and enabled cells keep their expected positions", row.firstElementChild.getAttribute("value") === before.name &&
        row.firstElementChild.nextElementSibling.localName === "checkbox");
      win.toggleFilter(row); check("native enabled toggle still controls the original filter", managed.enabled !== before.enabled);
      win.toggleFilter(row);
      list.removeFilter(managed); list.insertFilterAt(list.filterCount, managed); win.rebuildFilterList();
      await waitFor(() => badge(rows.itemChildren[rows.itemChildren.length - 1]) && !badge(rows.itemChildren[0]), "reordered badge");
      check("native shared label follows the filter when reordered", rows.itemChildren.at(-1)._filter === managed);
      list.removeFilter(managed); list.insertFilterAt(0, managed); win.rebuildFilterList();
      await waitFor(() => badge(rows.itemChildren[0]), "restored order"); rows.selectItem(rows.itemChildren[0]);
      await waitFor(() => !note.hidden, "visible run scope");
      const markedRow = rows.itemChildren[0], nameBox = markedRow.firstElementChild.getBoundingClientRect();
      const badgeBox = badge(markedRow).getBoundingClientRect(), checkBox = markedRow.children[1].getBoundingClientRect();
      const ordinaryBox = rows.itemChildren[1].children[1].getBoundingClientRect();
      check("native shared badge fits before the name without shifting enabled checkboxes", badgeBox.width > 0 &&
        badgeBox.right <= nameBox.left && nameBox.right <= checkBox.left && Math.abs(checkBox.left - ordinaryBox.left) < 1);
      const allBox = all.getBoundingClientRect(), runBox = run.getBoundingClientRect(), columnBox = win.document.getElementById("activeColumn").getBoundingClientRect();
      check("native indicator rendering preserves saved names, descriptions and rule bytes", managed.filterName === before.name &&
        managed.filterDesc === before.description && managed.enabled === before.enabled && await IOUtils.readUTF8(list.defaultFile.path) === saved);
      const bitmap = await win.browsingContext.currentWindowGlobal.drawSnapshot(new win.DOMRect(0, 0, win.innerWidth, win.innerHeight), 1, "white");
      const canvas = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
      canvas.width = bitmap.width; canvas.height = bitmap.height; canvas.getContext("2d").drawImage(bitmap, 0, 0);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
      await IOUtils.write(PathUtils.join(profile, "native-shared-filter-list.png"), new Uint8Array(await blob.arrayBuffer())); bitmap.close();
      check("native longer run labels and automatic heading fit the dialog", allBox.width > 0 && runBox.right <= win.innerWidth &&
        allBox.right <= win.innerWidth && columnBox.width >= 10 * parseFloat(win.getComputedStyle(win.document.getElementById("activeColumn")).fontSize),
        { allBox, runBox, columnBox, width: win.innerWidth });
    } finally {
      managed.filterName = before.name; managed.filterDesc = before.description; managed.enabled = before.enabled;
      while (list.filterCount) list.removeFilter(list.getFilterAt(0));
      originals.forEach((filter, i) => list.insertFilterAt(i, filter));
      for (const win of windows) win.close();
    }
    check("native manager close preserves the original saved rules", await IOUtils.readUTF8(list.defaultFile.path) === saved);
    return checks;
  };
})(this);
