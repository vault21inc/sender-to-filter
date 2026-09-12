/* Test-only Experiment. Never included by scripts/build.sh. */
"use strict";
(function (exports) {
  const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
  const { setTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
  Cu.importGlobalProperties(["IOUtils", "PathUtils"]);
  let folder, list, originalFile, msgWindow;

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
      return { nativeTest: {
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
