/* MPL-2.0. Explicit, ordered actions on each account's own Inbox. */
"use strict";
(function (exports) {
  const MAIN_WINDOW = "chrome://messenger/content/messenger.xhtml";
  const HTML = "http://www.w3.org/1999/xhtml";
  const fail = code => { throw new Error(code); };
  // The native toolbar lays out its children in reverse DOM order.
  const ACTIONS = {
    read: { id: "stf-mark-inboxes-read", prefix: "inboxRead" },
    filters: { id: "stf-run-inbox-filters", prefix: "inboxRun" },
  };
  const inboxAccounts = mail => Array.from(mail.accounts.accounts)
    .filter(account => ["imap", "pop3"].includes(account.incomingServer.type))
    .map(account => ({ id: account.key, name: account.incomingServer.prettyName, server: account.incomingServer }));
  function accountInbox(mail, account) {
    const server = account.server;
    if (mail.accounts.getAccount(account.id)?.incomingServer !== server) fail("account-changed");
    if (server.rootFolder !== server.rootMsgFolder) fail("deferred-account");
    const folder = server.rootFolder.getFolderWithFlags(Ci.nsMsgFolderFlags.Inbox);
    if (!folder || folder.isServer || folder.flags & Ci.nsMsgFolderFlags.Virtual || folder.server !== server ||
        !folder.canFileMessages) fail("inbox-unavailable");
    return folder;
  }

  // Kept independent of shared-group expansion: every local copy runs once in
  // its own account, with the same eligibility as Thunderbird's folder command.
  exports.createInboxRunController = function (host) {
    return {
      async run(control) {
        let completed = 0, attempted = 0, total = 0, accountName = "";
        const alive = () => { if (control.cancelled) fail("cancelled"); };
        try {
          alive();
          const jobs = [], folders = new Set();
          for (const account of host.accounts()) {
            alive();
            accountName = account.name;
            const job = host.prepare(account);
            if (!job) continue;
            if (folders.has(job.folder.URI)) fail("duplicate-inbox");
            folders.add(job.folder.URI); jobs.push(job);
          }
          total = jobs.length;
          // Check every account before any message action can take place.
          for (const job of jobs) host.validate(job);
          for (const job of jobs) {
            alive(); accountName = job.account.name;
            host.validate(job);
            control.progress?.({ completed, total, accountName });
            alive(); attempted++;
            await host.apply(job);
            completed++;
          }
          alive();
          return { ok: true, completed, attempted, total };
        } catch (error) {
          return { ok: false, completed, attempted, total, accountName,
            error: control.cancelled ? "cancelled" : error.message };
        }
      },
    };
  };

  exports.createInboxRunHost = function () {
    const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
    const filters = list => Array.from({ length: list.filterCount }, (_, i) => list.getFilterAt(i));
    const eligible = filter => filter.enabled && !filter.temporary && !filter.unparseable &&
      Boolean(filter.filterType & Ci.nsMsgFilterType.Manual);
    function available(account) {
      const folder = accountInbox(MailServices, account);
      for (const win of Services.wm.getEnumerator(null)) {
        const uri = win.document.documentURI;
        if (uri === "chrome://messenger/content/FilterEditor.xhtml") fail("editor-open");
        if (uri === "chrome://messenger/content/FilterListDialog.xhtml" && win.gRunningFilters) fail("already-running");
      }
      return folder;
    }
    return {
      accounts: () => inboxAccounts(MailServices),
      prepare(account) {
        const list = account.server.getFilterList(null), selected = filters(list).filter(eligible);
        if (!selected.length) return null;
        return { account, folder: available(account), list, filters: selected };
      },
      validate(job) {
        if (available(job.account) !== job.folder || job.account.server.getFilterList(null) !== job.list) fail("account-changed");
        const current = filters(job.list).filter(eligible);
        if (current.length !== job.filters.length || current.some((f, i) => f !== job.filters[i])) fail("filters-changed");
      },
      apply(job) {
        const list = MailServices.filters.getTempFilterList(job.folder);
        list.loggingEnabled = job.list.loggingEnabled; list.logStream = job.list.logStream;
        job.filters.forEach((filter, i) => list.insertFilterAt(i, filter));
        // A dedicated message window avoids borrowing the selected tab's folder
        // or interrupting unrelated Get Messages operations when stopping.
        const msgWindow = Cc["@mozilla.org/messenger/msgwindow;1"].createInstance(Ci.nsIMsgWindow);
        return new Promise((resolve, reject) => {
          MailServices.filters.applyFiltersToFolders(list, [job.folder], msgWindow, {
            onStopOperation(status) {
              if ((status & 0x80000000) === 0) resolve();
              else reject(new Error("filtering-failed"));
            },
          });
        });
      },
    };
  };

  exports.createInboxReadHost = function () {
    const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
    return {
      accounts: () => inboxAccounts(MailServices),
      prepare: account => ({ account, folder: accountInbox(MailServices, account) }),
      validate(job) {
        if (accountInbox(MailServices, job.account) !== job.folder) fail("account-changed");
      },
      apply(job) {
        try {
          const msgWindow = Cc["@mozilla.org/messenger/msgwindow;1"].createInstance(Ci.nsIMsgWindow);
          // Use Thunderbird's folder operation, independent of the selected tab
          // and of whether the account has filters. IMAP synchronization is
          // managed by Thunderbird, just as with its native Mark Folder Read.
          job.folder.markAllMessagesRead(msgWindow);
        } catch { fail("mark-read-failed"); }
      },
    };
  };

  exports.InboxRunControls = class {
    constructor(extension, execution) {
      this.extension = extension; this.execution = execution;
      this.windows = new Map(); this.panes = new Map(); this.active = null; this.message = "";
      this.listenerId = `${extension.id}-inbox-run`;
      this.support = ChromeUtils.importESModule("resource:///modules/ExtensionSupport.sys.mjs").ExtensionSupport;
    }
    text(key, values) { return this.extension.localeData.localizeMessage(key, values); }
    start() {
      if (!this.support.registerWindowListener(this.listenerId, { chromeURLs: [MAIN_WINDOW],
        onLoadWindow: win => this.attach(win), onUnloadWindow: win => this.detach(win) })) {
        throw new Error("Could not register the Inbox action buttons.");
      }
    }
    attach(win) {
      if (this.windows.has(win)) return;
      const loaded = event => this.attachPane(win, event.target);
      this.windows.set(win, loaded);
      win.addEventListener("DOMContentLoaded", loaded, true);
      for (const tab of win.document.getElementById("tabmail")?.tabInfo || []) {
        this.attachPane(win, tab.chromeBrowser?.contentDocument);
      }
    }
    attachPane(win, doc) {
      if (!doc || doc.documentURI !== "about:3pane" || this.panes.has(doc)) return;
      const header = doc.getElementById("folderPaneHeaderBar"), get = doc.getElementById("folderPaneGetMessages");
      if (!header || !get) return;
      const element = (tag, className) => {
        const node = doc.createElementNS(HTML, tag); node.className = className; return node;
      };
      const actions = {};
      for (const [kind, config] of Object.entries(ACTIONS)) {
        const button = element("button", "button button-flat stf-inbox-run");
        button.id = config.id; button.type = "button";
        const icon = element("span", "stf-inbox-run-icon"); icon.setAttribute("aria-hidden", "true");
        const label = element("span", "stf-inbox-run-label");
        button.append(icon, label); button.setAttribute("tabindex", "1");
        const click = () => this.request(doc, kind);
        actions[kind] = { button, label, click };
        header.insertBefore(button, get); button.addEventListener("click", click);
      }
      const style = element("style", "stf-inbox-run-style");
      style.textContent = `
        .stf-inbox-run { display: inline-flex; align-items: center; justify-content: center; gap: 4px;
          flex: 0 0 auto; white-space: nowrap; padding-inline: 6px; }
        .stf-inbox-run-icon { display: inline-block; inline-size: var(--folder-pane-icon-size, 16px);
          block-size: var(--folder-pane-icon-size, 16px); background-color: currentColor; }
        #stf-run-inbox-filters .stf-inbox-run-icon {
          mask: url("${this.extension.rootURI.resolve("icons/run-filters.svg")}") center / contain no-repeat; }
        #stf-mark-inboxes-read .stf-inbox-run-icon {
          mask: url("${this.extension.rootURI.resolve("icons/mark-all-read.svg")}") center / contain no-repeat; }
        .stf-inbox-run-compact { padding-inline: 4px; }
        .stf-inbox-run-compact .stf-inbox-run-label { display: none; }
        .stf-inbox-run-status { flex: 0 0 auto; padding: 4px 8px; font-size: .9em; overflow-wrap: anywhere;
          background-color: var(--sidebar-background); }
        .stf-inbox-run-status[hidden], .stf-inbox-run-stop[hidden] { display: none; }
        .stf-inbox-run-stop { margin-inline-start: 4px; }
      `;
      const note = element("div", "stf-inbox-run-status");
      const status = element("span", "stf-inbox-run-message");
      status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
      const stop = element("button", "button button-flat stf-inbox-run-stop");
      stop.type = "button"; stop.textContent = this.text("inboxRunStop"); stop.title = this.text("inboxRunStopHelp");
      note.append(status, stop);
      const cancel = () => this.cancel(), unload = () => this.detachPane(doc);
      const state = { win, doc, actions, note, status, stop, style, cancel, unload };
      this.panes.set(doc, state);
      doc.head.appendChild(style); header.after(note); stop.addEventListener("click", cancel);
      doc.defaultView.addEventListener("unload", unload, { once: true });
      state.resize = new doc.defaultView.ResizeObserver(entries => {
        for (const { button } of Object.values(actions)) {
          button.classList.toggle("stf-inbox-run-compact", entries[0].contentRect.width < 480);
        }
      });
      state.resize.observe(header); this.refresh();
    }
    refresh() {
      for (const state of this.panes.values()) {
        const busy = Boolean(this.active);
        for (const [kind, { button, label }] of Object.entries(state.actions)) {
          const { prefix } = ACTIONS[kind], running = this.active?.kind === kind;
          button.disabled = busy;
          label.textContent = this.text(`${prefix}${running ? "Running" : "Label"}`);
          button.title = running ? this.message : this.text(`${prefix}Tooltip`);
          button.setAttribute("aria-label", this.text(`${prefix}Tooltip`));
          button.setAttribute("aria-busy", String(running));
        }
        state.note.hidden = !this.message;
        state.status.textContent = this.message;
        state.stop.hidden = !busy;
        state.stop.disabled = Boolean(this.active?.control.cancelled);
      }
      this.execution.changed?.();
    }
    request(doc, kind = "filters") {
      if (this.active || !this.panes.has(doc) || !Object.hasOwn(ACTIONS, kind)) return;
      const { prefix } = ACTIONS[kind];
      const active = { id: this.execution.uuid(), doc, kind, started: false, control: { cancelled: false } };
      active.control.progress = ({ completed, total, accountName }) => {
        if (this.active !== active) return;
        this.message = this.text(`${prefix}Progress`, [String(completed + 1), String(total), accountName]);
        this.refresh();
      };
      this.active = active; this.message = this.text(`${prefix}Checking`); this.refresh();
      try { Promise.resolve(this.execution.request(active.id)).catch(() => this.cancel(active.id, "unavailable")); }
      catch { this.cancel(active.id, "unavailable"); }
    }
    async execute(id) {
      const active = this.active;
      if (!active || active.id !== id || active.started) return;
      active.started = true;
      let result;
      try {
        const runner = active.kind === "read" ? this.execution.readRunner : this.execution.runner;
        result = await runner.run(active.control);
      } catch { result = { ok: false, completed: 0, attempted: 0, total: 0, error: "unavailable" }; }
      this.finish(active, result);
    }
    cancel(id = this.active?.id, reason = "cancelled") {
      const active = this.active; if (!active || active.id !== id) return;
      active.control.cancelled = true;
      if (!active.started) this.finish(active, { ok: false, completed: 0, attempted: 0, total: 0, error: reason });
      else { this.message = this.text("inboxRunStopping"); this.refresh(); }
    }
    finish(active, result) {
      if (this.active !== active) return;
      this.active = null;
      const { prefix } = ACTIONS[active.kind];
      const fallback = active.kind === "read" ? "mark_read_failed" : "filtering_failed";
      const error = result.ok ? "" : this.text(`${prefix}Error_${String(result.error).replaceAll("-", "_")}`) || this.text(`${prefix}Error_${fallback}`);
      this.message = result.ok ? this.text(`${prefix}${result.completed ? "Complete" : "Empty"}`, String(result.completed)) :
        this.text(`${prefix}${result.attempted ? "Partial" : "NotStarted"}`,
          [error, String(result.completed), String(result.total), result.accountName || ""]);
      this.refresh();
    }
    detachPane(doc) {
      const state = this.panes.get(doc); if (!state) return;
      if (this.active?.doc === doc) this.cancel();
      this.panes.delete(doc); state.resize.disconnect();
      for (const { button, click } of Object.values(state.actions)) {
        button.removeEventListener("click", click); button.remove();
      }
      state.stop.removeEventListener("click", state.cancel);
      doc.defaultView.removeEventListener("unload", state.unload);
      state.note.remove(); state.style.remove();
    }
    detach(win) {
      const loaded = this.windows.get(win); if (!loaded) return;
      win.removeEventListener("DOMContentLoaded", loaded, true); this.windows.delete(win);
      for (const [doc, state] of this.panes) if (state.win === win) this.detachPane(doc);
    }
    stop() {
      this.support.unregisterWindowListener(this.listenerId);
      for (const win of this.windows.keys()) this.detach(win);
    }
  };
})(this);
