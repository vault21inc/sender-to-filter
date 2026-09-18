/* Test-only: production all-Inboxes button and real local message actions. */
"use strict";
(function (exports) {
  const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
  const { setTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
  Cu.importGlobalProperties(["IOUtils", "PathUtils"]);
  async function waitFor(predicate, label) {
    const end = Date.now() + 10000;
    while (Date.now() < end) { const value = predicate(); if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 20)); }
    throw new Error(`Timed out waiting for ${label}`);
  }
  exports.checkInboxRun = async (context, profile) => {
    const checks = [], accounts = [], check = (name, value, details) => {
      if (!value) throw new Error(name + (details ? `: ${JSON.stringify(details)}` : "")); checks.push(name);
    };
    const main = await waitFor(() => Services.wm.getMostRecentWindow("mail:3pane"), "main window");
    const tabmail = main.document.getElementById("tabmail"), original = tabmail.tabInfo.find(t => t.mode.name === "mail3PaneTab");
    tabmail.switchToTab(original);
    const pane = original.chromeBrowser.contentWindow, doc = pane.document;
    const button = await waitFor(() => doc.getElementById("stf-run-inbox-filters"), "Inbox filter button");
    const readButton = await waitFor(() => doc.getElementById("stf-mark-inboxes-read"), "Mark All Read button");
    const header = doc.getElementById("folderPaneHeaderBar"), folderPane = doc.getElementById("folderPane");
    const oldWidth = folderPane.style.width, oldHidden = header.hidden;
    header.hidden = false;
    let extra;
    const count = folder => folder.getTotalMessages(false);
    const action = Ci.nsMsgFilterAction;
    function addRule(list, name, type, enabled = true, filterType = Ci.nsMsgFilterType.Manual, destination = null) {
      const f = list.createFilter(name); f.enabled = enabled; f.filterType = filterType;
      list.parseCondition(f, "ALL");
      const a = f.createAction(); a.type = type; if (destination) a.targetFolderUri = destination.URI;
      f.appendAction(a); list.insertFilterAt(list.filterCount, f); return f;
    }
    function addMessage(folder, id) {
      folder.QueryInterface(Ci.nsIMsgLocalMailFolder).addMessage(`From - Fri Sep 18 12:00:00 2026\r\nFrom: fixture@example.invalid\r\nTo: inbox@example.invalid\r\nSubject: Inbox button fixture\r\nMessage-ID: <${id}@example.invalid>\r\nDate: Fri, 18 Sep 2026 12:00:00 +0000\r\nX-Mozilla-Status: 0000\r\nX-Mozilla-Status2: 00000000\r\n\r\nSynthetic local message.\r\n`);
    }
    try {
      for (let i = 0; i < 3; i++) {
        const path = PathUtils.join(profile, `inbox-button-${i}`);
        await IOUtils.makeDirectory(path, { permissions: 0o700 });
        const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile); file.initWithPath(path);
        const server = MailServices.accounts.createIncomingServer(`inbox-${i}`, `inbox-${i}.invalid`, "pop3");
        server.localPath = file; server.prettyName = `Inbox fixture ${i + 1}`;
        server.doBiff = false; server.loginAtStartUp = false; server.valid = true;
        const account = MailServices.accounts.createAccount(); account.incomingServer = server;
        const identity = MailServices.accounts.createIdentity(); identity.email = `inbox-${i}@example.invalid`; account.addIdentity(identity);
        const root = server.rootFolder;
        const local = root.QueryInterface(Ci.nsIMsgLocalMailFolder);
        for (const name of ["Inbox", "Other", "Filed"]) {
          let folder;
          try { folder = root.getChildNamed(name); } catch {}
          if (!folder) local.createLocalSubfolder(name);
        }
        const inbox = root.getChildNamed("Inbox"), other = root.getChildNamed("Other"), filed = root.getChildNamed("Filed");
        inbox.setFlag(Ci.nsMsgFolderFlags.Inbox);
        // addMessage is a delivery path and can run incoming filters itself.
        // Seed before installing the incoming-only eligibility sentinel.
        addMessage(inbox, `inbox-${i}`); addMessage(other, `other-${i}`);
        const list = server.getFilterList(null);
        addRule(list, "Disabled delete", action.Delete, false);
        addRule(list, "Incoming only", action.Delete, true, Ci.nsMsgFilterType.InboxRule);
        addRule(list, "First enabled manual", i === 1 ? action.MarkFlagged : action.MarkRead);
        const copy = addRule(list, "Shared local copy", action.CopyToFolder, true, Ci.nsMsgFilterType.Manual, filed);
        copy.filterDesc = ` [stf-shared:v1:11111111-1111-4111-8111-111111111111:${["22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444"][i]}]`;
        addRule(list, "Stop in local order", action.StopExecution);
        addRule(list, "Must not reach", action.Delete);
        list.saveToDefaultFile();
        const bytes = await IOUtils.readUTF8(list.defaultFile.path);
        accounts.push({ account, server, root, inbox, other, filed, list, bytes });
      }
      pane.displayFolder(accounts[0].other.URI);
      await waitFor(() => pane.gFolder === accounts[0].other, "non-Inbox selection");
      // The new profile's first-run modal otherwise covers the actual toolbar.
      main.document.querySelector("account-hub-container")?.modal?.close();
      folderPane.style.width = "520px";
      await waitFor(() => !button.classList.contains("stf-inbox-run-compact"), "label at wide sidebar");
      const get = doc.getElementById("folderPaneGetMessages").getBoundingClientRect();
      const run = button.getBoundingClientRect(), read = readButton.getBoundingClientRect();
      const write = doc.getElementById("folderPaneWriteMessage").getBoundingClientRect();
      check("native Inbox button sits between Get Messages and New Message with an explicit all-account tooltip",
        run.width > 0 && get.right <= run.left && run.right <= write.left && button.title.includes("all accounts") &&
        button.textContent === "Run Filters");
      check("native Mark All Read sits beside Run Filters with an explicit all-Inboxes label and tooltip",
        run.right <= read.left && read.right <= write.left && read.width > 0 && readButton.textContent === "Mark All Read" &&
        readButton.title.includes("all accounts’ Inboxes"));
      folderPane.style.width = "260px";
      await waitFor(() => button.classList.contains("stf-inbox-run-compact"), "compact sidebar button");
      check("native Inbox button fits a narrow sidebar with accessible scope", header.scrollWidth <= header.clientWidth &&
        button.getAttribute("aria-label").includes("all accounts") && readButton.classList.contains("stf-inbox-run-compact") &&
        readButton.getAttribute("aria-label").includes("all accounts’ Inboxes"));
      folderPane.style.width = "520px";
      extra = tabmail.openTab("mail3PaneTab", { folderURI: accounts[1].other.URI });
      const second = await waitFor(() => extra.chromeBrowser?.contentDocument.getElementById("stf-run-inbox-filters"), "button in new mail tab");
      const secondRead = await waitFor(() => extra.chromeBrowser?.contentDocument.getElementById("stf-mark-inboxes-read"), "read button in new mail tab");
      check("native Inbox button attaches once in existing and newly opened mail tabs", doc.querySelectorAll("#stf-run-inbox-filters").length === 1 &&
        second.ownerDocument.querySelectorAll("#stf-run-inbox-filters").length === 1);
      tabmail.switchToTab(original);
      button.click();
      check("native Inbox run locks both actions in every mail tab immediately", button.disabled && second.disabled && readButton.disabled && secondRead.disabled);
      doc.querySelector(".stf-inbox-run-stop").click();
      await waitFor(() => !button.disabled, "cancelled queued run");
      check("native Stop before dispatch processes no messages", accounts.every(a => count(a.inbox) === 1 && count(a.filed) === 0) &&
        doc.querySelector(".stf-inbox-run-message").textContent.includes("Filtering stopped"));
      button.click(); button.click(); second.click();
      await waitFor(() => !button.disabled, "all-Inboxes completion");
      check("native all-Inboxes action completes all three accounts", doc.querySelector(".stf-inbox-run-message").textContent.includes("3 Inbox(es)"));
      check("native all-Inboxes action runs each local shared copy exactly once despite repeated clicks", accounts.every(a => count(a.filed) === 1),
        accounts.map(a => ({ name: a.server.prettyName, inbox: count(a.inbox), filed: count(a.filed),
          messages: [...a.inbox.messages].map(h => ({ read: h.isRead, flagged: h.isFlagged })),
          rules: Array.from({ length: a.list.filterCount }, (_, i) => { const f = a.list.getFilterAt(i);
            return { name: f.filterName, enabled: f.enabled, type: f.filterType, terms: f.searchTerms.map(t => ({ matchAll: t.matchAll, attrib: t.attrib })) }; }) })));
      check("native all-Inboxes action excludes disabled and incoming-only filters and honors Stop Execution", accounts.every(a => count(a.inbox) === 1));
      const messages = accounts.map(a => [...a.inbox.messages][0]);
      check("native all-Inboxes action uses each account's own rules", messages[0].isRead && !messages[0].isFlagged &&
        messages[1].isFlagged && !messages[1].isRead && messages[2].isRead);
      check("native all-Inboxes action preserves the selected non-Inbox folder and its messages", pane.gFolder === accounts[0].other &&
        accounts.every(a => count(a.other) === 1 && ![...a.other.messages][0].isRead && ![...a.other.messages][0].isFlagged));
      for (const a of accounts) check(`native all-Inboxes action preserves saved rules for ${a.server.prettyName}`,
        await IOUtils.readUTF8(a.list.defaultFile.path) === a.bytes);
      // Mark All Read must work even on an account with no filters. Reset all
      // Inbox flags and keep unread messages in Other to establish its scope.
      for (const a of accounts) a.inbox.markMessagesRead([...a.inbox.messages], false);
      while (accounts[2].list.filterCount) accounts[2].list.removeFilter(accounts[2].list.getFilterAt(0));
      accounts[2].list.saveToDefaultFile();
      const savedRules = await Promise.all(accounts.map(a => IOUtils.readUTF8(a.list.defaultFile.path)));
      const filedRead = accounts.map(a => [...a.filed.messages][0].isRead);
      readButton.click();
      check("native Mark All Read locks both actions across tabs", readButton.disabled && secondRead.disabled && button.disabled && second.disabled);
      readButton.click(); secondRead.click(); button.click();
      await waitFor(() => !readButton.disabled, "all-Inboxes marked read");
      check("native Mark All Read completes every Inbox including accounts without filters",
        accounts.every(a => count(a.inbox) === 1 && [...a.inbox.messages][0].isRead) &&
        doc.querySelector(".stf-inbox-run-message").textContent.includes("Marked all messages read in 3 Inbox(es)"));
      check("native Mark All Read preserves other folders, flags and the selected folder",
        pane.gFolder === accounts[0].other && accounts.every((a, i) => ![...a.other.messages][0].isRead &&
          [...a.filed.messages][0].isRead === filedRead[i]) && [...accounts[1].inbox.messages][0].isFlagged);
      check("native Mark All Read never runs filter actions or changes saved rules",
        accounts.every(a => count(a.filed) === 1) &&
        (await Promise.all(accounts.map(a => IOUtils.readUTF8(a.list.defaultFile.path)))).every((bytes, i) => bytes === savedRules[i]));
      const bitmap = await main.browsingContext.currentWindowGlobal.drawSnapshot(new main.DOMRect(0, 0, Math.min(main.innerWidth, 1100), 550), 1, "white");
      const canvas = main.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
      canvas.width = bitmap.width; canvas.height = bitmap.height; canvas.getContext("2d").drawImage(bitmap, 0, 0);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
      await IOUtils.write(PathUtils.join(profile, "native-inbox-run.png"), new Uint8Array(await blob.arrayBuffer())); bitmap.close();
    } finally {
      if (extra && tabmail.tabInfo.includes(extra)) tabmail.closeTab(extra);
      folderPane.style.width = oldWidth; header.hidden = oldHidden;
      const local = MailServices.accounts.localFoldersServer;
      if (local) pane.displayFolder(local.rootFolder.URI);
      // Leave the disposable accounts available to outstanding folder events.
      // Removing their server preferences races Thunderbird's folder cache.
      for (const a of accounts) {
        while (a.list.filterCount) a.list.removeFilter(a.list.getFilterAt(0));
        a.list.saveToDefaultFile();
      }
    }
    return checks;
  };
})(this);
