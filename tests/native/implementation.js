/* Test-only Experiment. Never included by scripts/build.sh. */
"use strict";
(function (exports) {
  const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
  const { setTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
  Cu.importGlobalProperties(["IOUtils", "PathUtils"]);
  let folder, list, originalFile, msgWindow;

  async function waitFor(predicate, label) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const result = predicate();
      if (result) return result;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`Timed out waiting for ${label}`);
  }

  async function checkFilterTags() {
    await assertDisposable();
    const { ExtensionSupport } = ChromeUtils.importESModule("resource:///modules/ExtensionSupport.sys.mjs");
    const checks = [];
    const check = (name, passed) => {
      if (!passed) throw new Error(name);
      checks.push(name);
    };
    const tagURL = "chrome://messenger/content/newTagDialog.xhtml";
    const editorURL = "chrome://messenger/content/FilterEditor.xhtml";
    const tag1 = "STF existing one", tag2 = "STF existing two";
    MailServices.tags.addTag(tag1, "#123456", "");
    MailServices.tags.addTag(tag2, "#654321", "");
    const key1 = MailServices.tags.getKeyForTag(tag1), key2 = MailServices.tags.getKeyForTag(tag2);
    const filter = list.createFilter("Tag fixture");
    filter.enabled = false;
    filter.filterType = Ci.nsMsgFilterType.InboxRule | Ci.nsMsgFilterType.Manual;
    const source = list.getFilterNamed("Main");
    filter.searchTerms = source.searchTerms;
    for (const key of [key1, key2]) {
      const action = filter.createAction();
      action.type = Ci.nsMsgFilterAction.AddTag;
      action.strValue = key;
      filter.appendAction(action);
    }
    const star = filter.createAction();
    star.type = Ci.nsMsgFilterAction.MarkFlagged;
    filter.appendAction(star);
    list.insertFilterAt(list.filterCount, filter);
    list.saveToDefaultFile();
    const originalTerms = filter.searchTerms.map(term => term.termAsString);
    const originalType = filter.filterType;
    const main = await waitFor(() => Services.wm.getMostRecentWindow("mail:3pane"), "main window");
    const editors = [];
    async function openEditor() {
      const args = { filterList: list, filter };
      const win = main.openDialog(editorURL, "", "chrome,dialog=no,resizable", args);
      editors.push(win);
      await waitFor(() => win.document.readyState === "complete" &&
        win.document.querySelectorAll(".stf-new-tag-button").length === 2, "filter tag buttons");
      return { win, args };
    }
    const menus = win => [...win.document.querySelectorAll("ruleactiontarget-tag menulist")];
    function driveTagDialog(editor, action) {
      let opened = false, failure;
      const listener = "sender-to-filter-native-tag-dialog";
      ExtensionSupport.registerWindowListener(listener, {
        chromeURLs: [tagURL],
        onLoadWindow(win) {
          // Let the native load handler initialize its form first.
          setTimeout(() => {
            opened = true;
            try { action(win); } catch (error) { failure = error; win.close(); }
          }, 0);
        },
      });
      try {
        editor.document.querySelector(".stf-new-tag-button").dispatchEvent(
          new editor.Event("command", { bubbles: true }));
      } finally {
        ExtensionSupport.unregisterWindowListener(listener);
      }
      if (failure) throw failure;
      if (!opened) throw new Error("New Tag button did not open the native dialog");
    }
    const fill = (win, name, color) => {
      win.document.getElementById("name").value = name;
      win.document.getElementById("tagColorPicker").value = color;
      win.document.getElementById("name").dispatchEvent(new win.Event("input", { bubbles: true }));
    };
    try {
      const { win: first, args } = await openEditor();
      const { win: second } = await openEditor();
      first.document.getElementById("filterName").value = "Unsaved tag draft";
      const beforeMenus = menus(first).map(menu => menu.value).join();
      const beforeCount = MailServices.tags.getAllTags().length;
      driveTagDialog(first, win => {
        check("native new-tag dialog starts with blank-name acceptance disabled",
          win.document.querySelector("dialog").getButton("accept").disabled);
        fill(win, "Cancelled tag", "#aabbcc");
        win.document.querySelector("dialog").cancelDialog();
      });
      check("cancelling tag creation preserves tags, selections and unsaved filter name",
        MailServices.tags.getAllTags().length === beforeCount && menus(first).map(menu => menu.value).join() === beforeMenus &&
        first.document.getElementById("filterName").value === "Unsaved tag draft");

      const createdName = "STF R&D <Caldwell>";
      driveTagDialog(first, win => {
        let duplicateReported = false;
        win.alertForExistingTag = async () => { duplicateReported = true; };
        fill(win, tag1, "#aabbcc");
        const event = new win.Event("dialogaccept", { bubbles: true, cancelable: true });
        win.document.dispatchEvent(event);
        check("native duplicate-name validation leaves existing tag unchanged", event.defaultPrevented && duplicateReported &&
          MailServices.tags.getAllTags().length === beforeCount && MailServices.tags.getColorForKey(key1) === "#123456");
        fill(win, createdName, "#A1B2C3");
        win.document.querySelector("dialog").acceptDialog();
      });
      const createdKey = MailServices.tags.getKeyForTag(createdName);
      check("creating a tag selects its native key and preserves its name and color", !!createdKey &&
        menus(first)[0].value === createdKey && MailServices.tags.getColorForKey(createdKey).toUpperCase() === "#A1B2C3" &&
        menus(first)[0].selectedItem.label === createdName);
      check("other tag rows and other open editors retain their selections", menus(first)[1].value === key2 &&
        menus(second)[0].value === key1 && menus(second)[1].value === key2 &&
        [...menus(second)[0].menupopup.children].some(item => item.value === createdKey));
      check("creating a tag does not save or modify the underlying filter", filter.filterName === "Tag fixture" &&
        filter.getActionAt(0).strValue === key1 && first.document.getElementById("filterName").value === "Unsaved tag draft");
      second.document.querySelector("dialog").cancelDialog();

      // Capture the actual chrome UI for visual review, not a recreated mockup.
      const buttonBox = first.document.querySelector(".stf-new-tag-button").getBoundingClientRect();
      const menuBox = menus(first)[0].getBoundingClientRect();
      check("new-tag button is visible beside the tag dropdown", buttonBox.width > 0 && menuBox.width > 0 &&
        buttonBox.left >= menuBox.right && buttonBox.top < menuBox.bottom && buttonBox.right <= first.innerWidth);
      const bitmap = await first.browsingContext.currentWindowGlobal.drawSnapshot(
        new first.DOMRect(0, 0, first.innerWidth, first.innerHeight), 1, "white");
      const canvas = first.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext("2d").drawImage(bitmap, 0, 0);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
      await IOUtils.write(PathUtils.join(await assertDisposable(), "native-filter-tags.png"), new Uint8Array(await blob.arrayBuffer()));
      bitmap.close();

      const rows = first.document.getElementById("filterActionList");
      const actionRow = rows.lastElementChild;
      actionRow.setAttribute("value", "addtagtomessage");
      await waitFor(() => first.document.querySelectorAll(".stf-new-tag-button").length === 3, "changed action type");
      actionRow.setAttribute("value", "markasflagged");
      await waitFor(() => first.document.querySelectorAll(".stf-new-tag-button").length === 2, "restored action type");
      rows.firstElementChild.addRow();
      const addedRow = rows.children[1];
      addedRow.setAttribute("value", "addtagtomessage");
      await waitFor(() => first.document.querySelectorAll(".stf-new-tag-button").length === 3, "new action row");
      addedRow.removeRow();
      await waitFor(() => first.document.querySelectorAll(".stf-new-tag-button").length === 2, "removed action row");
      check("new and changed action rows gain one button and removed rows clean up", true);

      first.document.querySelector("dialog").acceptDialog();
      check("native filter acceptance keeps other actions, conditions, triggers and disabled state", args.refresh &&
        filter.filterName === "Unsaved tag draft" && filter.getActionAt(0).strValue === createdKey &&
        filter.getActionAt(1).strValue === key2 && filter.getActionAt(2).type === Ci.nsMsgFilterAction.MarkFlagged &&
        filter.actionCount === 3 && filter.filterType === originalType && !filter.enabled &&
        JSON.stringify(filter.searchTerms.map(term => term.termAsString)) === JSON.stringify(originalTerms));
      list.saveToDefaultFile();
      const savedFile = await IOUtils.readUTF8(originalFile.path);
      const scratch = originalFile.clone();
      scratch.leafName = "tag-check-copy.dat";
      await IOUtils.writeUTF8(scratch.path, savedFile);
      const saved = MailServices.filters.OpenFilterList(scratch, folder, null).getFilterNamed("Unsaved tag draft");
      check("new tag action survives a native rules-file save and reload", saved.getActionAt(0).strValue === createdKey &&
        saved.getActionAt(1).strValue === key2 && saved.actionCount === 3 && !saved.enabled);

      const { win: cancelled } = await openEditor();
      driveTagDialog(cancelled, win => {
        fill(win, "STF tag survives filter cancel", "#778899");
        win.document.querySelector("dialog").acceptDialog();
      });
      cancelled.document.querySelector("dialog").cancelDialog();
      check("cancelling the filter retains the created tag without saving filter edits",
        !!MailServices.tags.getKeyForTag("STF tag survives filter cancel") && filter.getActionAt(0).strValue === createdKey &&
        await IOUtils.readUTF8(originalFile.path) === savedFile);
      return checks;
    } finally {
      for (const win of editors) if (!win.closed) win.close();
    }
  }

  async function assertDisposable() {
    const profile = Services.dirsvc.get("ProfD", Ci.nsIFile).path;
    const marker = PathUtils.join(profile, "sender-to-filter-test-profile");
    if (!await IOUtils.exists(marker) || await IOUtils.readUTF8(marker) !== "disposable\n") {
      throw new Error("Native tests require a profile created by scripts/test-thunderbird.py.");
    }
    return profile;
  }

  exports.nativeTest = class extends ExtensionCommon.ExtensionAPI {
    getAPI(context) {
      let draftDriver = null;
      return { nativeTest: {
        async checkInboxRun() {
          const profile = await assertDisposable(), scope = { ChromeUtils, Ci, Cc, Cu, Services };
          Services.scriptloader.loadSubScriptWithOptions(context.extension.rootURI.resolve("native/inbox-run.js"), {
            target: scope, charset: "UTF-8", allowUnsafeURL: true,
          });
          try { return await scope.checkInboxRun(context, profile); }
          catch (error) { return { error: String(error), stack: error.stack }; }
        },
        async checkSharedSpace() {
          const profile = await assertDisposable(), scope = { ChromeUtils, Ci, Cc, Cu, Services };
          Services.scriptloader.loadSubScriptWithOptions(context.extension.rootURI.resolve("native/shared-space.js"), {
            target: scope, charset: "UTF-8", allowUnsafeURL: true,
          });
          try { return await scope.checkSharedSpace(context, profile); }
          catch (error) { return { error: String(error), stack: error.stack }; }
        },
        async setupSharedRunFixtures() {
          const profile = await assertDisposable(), scope = { ChromeUtils, Ci, Cc, Cu, Services };
          Services.scriptloader.loadSubScriptWithOptions(context.extension.rootURI.resolve("native/shared.js"), {
            target: scope, charset: "UTF-8", allowUnsafeURL: true,
          });
          try { return await scope.setupSharedRunFixtures(profile); }
          catch (error) { return { error: String(error), stack: error.stack }; }
        },
        async checkSharedManualRun(accountIds) {
          const profile = await assertDisposable(), scope = { ChromeUtils, Ci, Cc, Cu, Services };
          Services.scriptloader.loadSubScriptWithOptions(context.extension.rootURI.resolve("native/shared-run.js"), {
            target: scope, charset: "UTF-8", allowUnsafeURL: true,
          });
          try { return await scope.checkSharedManualRun(context, accountIds, profile); }
          catch (error) { return { error: String(error), stack: error.stack }; }
        },
        async checkEnabledSharedRun(accountIds) {
          const profile = await assertDisposable(), scope = { ChromeUtils, Ci, Cc, Cu, Services };
          Services.scriptloader.loadSubScriptWithOptions(context.extension.rootURI.resolve("native/shared-run.js"), {
            target: scope, charset: "UTF-8", allowUnsafeURL: true,
          });
          try { return await scope.checkEnabledSharedRun(context, accountIds, profile); }
          catch (error) { return { error: String(error), stack: error.stack }; }
        },
        async checkSharedFilterIndicators(accountIds) {
          const profile = await assertDisposable();
          const scope = { ChromeUtils, Ci, Cc, Cu, Services };
          Services.scriptloader.loadSubScriptWithOptions(context.extension.rootURI.resolve("native/filter-list.js"), {
            target: scope, charset: "UTF-8", allowUnsafeURL: true,
          });
          try { return await scope.checkSharedFilterIndicators(context, accountIds, profile); }
          catch (error) { return { error: String(error), stack: error.stack }; }
        },
        async armSharedDraft(mode) {
          await assertDisposable();
          const { ExtensionSupport } = ChromeUtils.importESModule("resource:///modules/ExtensionSupport.sys.mjs");
          const id = "stf-production-draft-test";
          if (draftDriver) ExtensionSupport.unregisterWindowListener(id);
          draftDriver = { mode, opened: false, error: null };
          ExtensionSupport.registerWindowListener(id, {
            chromeURLs: ["chrome://messenger/content/FilterEditor.xhtml"],
            onLoadWindow(win) {
              setTimeout(() => {
                draftDriver.opened = true;
                try {
                  win.document.getElementById("filterName").value += " edited";
                  if (mode === "accept") win.document.querySelector("dialog").acceptDialog();
                  else if (mode === "cancel") win.document.querySelector("dialog").cancelDialog();
                  else win.close();
                } catch (error) { draftDriver.error = String(error); win.close(); }
                ExtensionSupport.unregisterWindowListener(id);
              }, 0);
            },
          });
        },
        async checkFilterTags() {
          try { return await checkFilterTags(); }
          catch (error) { return { error: String(error), stack: error.stack }; }
        },
        async setupSharedProduction() {
          const profile = await assertDisposable();
          const scope = { ChromeUtils, Ci, Cc, Cu, Services };
          Services.scriptloader.loadSubScriptWithOptions(context.extension.rootURI.resolve("native/shared.js"), {
            target: scope, charset: "UTF-8", allowUnsafeURL: true,
          });
          try { return await scope.setupSharedProduction(profile); }
          catch (error) { return { error: String(error), stack: error.stack }; }
        },
        async duplicateSharedProduction(accountId) {
          await assertDisposable();
          const scope = { ChromeUtils, Ci, Cc, Cu, Services };
          Services.scriptloader.loadSubScriptWithOptions(context.extension.rootURI.resolve("native/shared.js"), {
            target: scope, charset: "UTF-8", allowUnsafeURL: true,
          });
          scope.duplicateSharedProduction(accountId);
        },
        async sharedPhase() {
          const profile = await assertDisposable();
          return {
            version: Services.appinfo.version,
            phase: !Services.prefs.getBoolPref("sender-to-filter.test.shared", false) ? "disabled" :
              await IOUtils.exists(PathUtils.join(profile, "shared-native-expected.json")) ? "restart" : "seed",
          };
        },
        async checkSharedPrerequisites(phase) {
          const profile = await assertDisposable();
          if (!Services.prefs.getBoolPref("sender-to-filter.test.shared", false) || !["seed", "restart"].includes(phase)) {
            throw new Error("Shared checks require --shared and a known phase.");
          }
          try {
            const scope = { ChromeUtils, Ci, Cc, Cu, Services };
            // Match Thunderbird's Experiment loader for this fixed bundled
            // resource. No caller-supplied script URI is accepted.
            Services.scriptloader.loadSubScriptWithOptions(context.extension.rootURI.resolve("native/shared.js"), {
              target: scope, charset: "UTF-8", allowUnsafeURL: true,
            });
            return await scope.runSharedNative(profile, phase);
          } catch (error) {
            return { ok: false, phase, checks: [], error: `Shared harness load: ${error}`, stack: error?.stack };
          }
        },
        async setup() {
          await assertDisposable();
          Services.io.offline = true;
          if (!MailServices.accounts.accounts.some(account => account.incomingServer?.type === "none")) {
            MailServices.accounts.createLocalMailAccount();
          }
          folder = MailServices.accounts.localFoldersServer.rootFolder;
          msgWindow = Cc["@mozilla.org/messenger/msgwindow;1"].createInstance(Ci.nsIMsgWindow);
          list = folder.getEditableFilterList(msgWindow);
          for (const [name, kind] of [["Main", "or"], ["Single", "single"], ["Disabled", "disabled"],
            ["AND", "and"], ["ALL", "all"]]) {
            const filter = list.createFilter(name);
            filter.enabled = kind !== "disabled";
            // Incoming is a mask that also includes legacy JavaScript filter
            // types; fixtures must be actual InboxRule filters to serialize.
            filter.filterType = Ci.nsMsgFilterType.InboxRule | Ci.nsMsgFilterType.Manual;
            const action = filter.createAction();
            action.type = Ci.nsMsgFilterAction.MarkRead;
            filter.appendAction(action);
            const values = ["old@example.com"];
            if (kind === "or" || kind === "and") values.push("other@example.com");
            for (const email of values) {
              const term = filter.createTerm();
              term.attrib = Ci.nsMsgSearchAttrib.Sender;
              term.op = Ci.nsMsgSearchOp.Is;
              const value = term.value;
              value.attrib = term.attrib;
              value.str = email;
              term.value = value;
              term.booleanAnd = kind === "and" || kind === "single";
              term.matchAll = kind === "all";
              filter.appendTerm(term);
            }
            list.insertFilterAt(list.filterCount, filter);
          }
          list.saveToDefaultFile();
          originalFile = list.defaultFile.clone();
          const converted = context.extension.folderManager.convert(folder);
          return { folder: { accountId: converted.accountId, path: converted.path }, version: Services.appinfo.version };
        },

        async inspect() {
          await assertDisposable();
          const live = list.getFilterNamed("Main");
          const reloaded = MailServices.filters.OpenFilterList(originalFile, folder, msgWindow).getFilterNamed("Main");
          const summarize = filter => ({
            enabled: filter.enabled, filterType: filter.filterType, actionCount: filter.actionCount,
            terms: filter.searchTerms.map(term => ({ op: term.op, value: term.value.str, and: term.booleanAnd })),
          });
          const added = live.searchTerms.find(term => term.value.str === "new@example.com");
          return {
            live: summarize(live), disk: summarize(reloaded),
            file: await IOUtils.readUTF8(originalFile.path),
            nativeMatch: added ? {
              exact: added.matchRfc822String("New Sender <new@example.com>", "UTF-8"),
              longer: added.matchRfc822String("New Sender <new@example.com.evil>", "UTF-8"),
              displayName: added.matchRfc822String('"new@example.com" <other@example.net>', "UTF-8"),
            } : null,
          };
        },

        async setFailingDestination(fail) {
          await assertDisposable();
          if (fail) {
            // Use a regular file as the parent: even writers that create
            // missing directories cannot make this destination writable.
            const unavailable = originalFile.clone();
            unavailable.append("rules.dat");
            list.defaultFile = unavailable;
          } else {
            list.defaultFile = originalFile;
          }
        },

        async finish(result) {
          const profile = await assertDisposable();
          await IOUtils.writeJSON(PathUtils.join(profile, "native-result.json"), result);
          // Only this marked disposable-profile process is ever stopped.
          setTimeout(() => Services.startup.quit(Services.startup.eForceQuit), 100);
        },
      } };
    }
  };
})(this);
