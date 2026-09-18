/* MPL-2.0. Shared-copy indicators and explicit native-window manual runs. */
"use strict";
(function (exports) {
  const MANAGER = "chrome://messenger/content/FilterListDialog.xhtml";
  const HTML = "http://www.w3.org/1999/xhtml";

  exports.FilterListIndicators = class {
    constructor(extension, model, execution = {}) {
      this.extension = extension; this.model = model; this.windows = new Map();
      this.execution = execution; this.active = null;
      this.listenerId = `${extension.id}-shared-filter-list`;
      this.support = ChromeUtils.importESModule("resource:///modules/ExtensionSupport.sys.mjs").ExtensionSupport;
    }
    text(key, values) { return this.extension.localeData.localizeMessage(key, values); }
    error(code) { return this.text(`sharedError_${String(code).replaceAll("-", "_")}`) || this.text("sharedErrorGeneric"); }
    start() {
      if (!this.support.registerWindowListener(this.listenerId, { chromeURLs: [MANAGER],
        onLoadWindow: win => this.attach(win), onUnloadWindow: win => this.detach(win) })) {
        throw new Error("Could not register the shared filter indicators.");
      }
    }
    kind(filter) {
      try {
        const status = this.model.parseOwnership(filter?.filterDesc || "").status;
        return status === "marked" ? "shared" : status === "malformed" ? "review" : null;
      } catch { return null; }
    }
    enabledFilters(win) {
      const list = win.gCurrentFilterList, result = [];
      for (let i = 0; i < (list?.filterCount || 0); i++) {
        const filter = list.getFilterAt(i); if (filter.enabled) result.push(filter);
      }
      return result;
    }
    folder(win) { return win.gRunFiltersFolder?._folder || win.gRunFiltersFolder?.selectedItem?._folder; }
    needsFolder(filters, across) { return filters.some(filter => !across || !this.kind(filter)); }
    targets(win, filters, across) {
      const shared = [], local = [], result = [];
      for (const filter of filters) (across && this.kind(filter) ? shared : local).push(`“${filter.filterName}”`);
      if (shared.length) result.push(this.text("sharedNativeRunSharedTarget", shared.join(", ")));
      if (local.length) {
        const folder = this.folder(win), parts = [], seen = new Set();
        for (let f = folder; f && !f.isServer && !seen.has(f); f = f.parent) {
          seen.add(f); parts.unshift(f.prettyName || f.name);
        }
        const destination = folder ? this.text("sharedNativeRunFolder", [parts.join("/"), folder.server.prettyName])
          : this.text("sharedNativeRunChooseFolder");
        result.push(this.text("sharedNativeRunLocalTarget", [local.join(", "), destination]));
      }
      return result.join("; ");
    }
    refresh() { for (const state of this.windows.values()) state.display?.(); }
    attach(win) {
      if (this.windows.has(win)) return;
      const state = { rows: new Map() }; this.windows.set(win, state);
      state.load = () => {
        const doc = win.document, list = doc.getElementById("filterList"), run = doc.getElementById("runFiltersButton");
        if (!list || !run) return;
        state.list = list;
        state.run = run;
        state.nativeLabels = new Map();
        const label = (element, text, tooltip) => {
          if (!element) return;
          const attributes = ["data-l10n-id", "data-l10n-args", "label", "value", "accesskey", "tooltiptext"];
          state.nativeLabels.set(element, new Map(attributes.map(key => [key, element.getAttribute(key)])));
          element.removeAttribute("data-l10n-id"); element.removeAttribute("data-l10n-args"); element.removeAttribute("accesskey");
          element.setAttribute(element.localName === "label" ? "value" : "label", text);
          if (tooltip) element.setAttribute("tooltiptext", tooltip);
        };
        label(run, this.text("sharedNativeRunSelected", "0"), this.text("sharedNativeRunSelectedHelp"));
        label(doc.getElementById("activeColumn"), this.text("sharedNativeAutomatic"), this.text("sharedNativeAutomaticHelp"));
        label(doc.getElementById("folderPickerPrefix"), this.text("sharedNativeRunFolderLabel"));
        state.style = doc.createElementNS(HTML, "style");
        state.style.textContent = `
          #filterList .stf-shared-filter-badge { order: -1; flex: 0 0 auto; margin-inline: 6px;
            padding: 0 6px; border: 1px solid currentColor; border-radius: 9px; font-size: .85em; }
          .stf-shared-run-scope { margin: 5px 4px 0; font-size: .9em; }
          .stf-shared-run-scope, .stf-run-all-preview { overflow-wrap: anywhere; max-height: 5em; overflow-y: auto; }
          .stf-shared-run-scope[hidden] { display: none; }
          .stf-shared-run-options { margin: 5px 0 0; }
          .stf-shared-run-options[hidden] { display: none; }
          #activeColumn { width: 11em !important; }
          .stf-run-all-row { margin-top: 8px; gap: 8px; }
          .stf-run-all-preview { flex: 1; min-width: 0; margin: 0 4px; font-size: .9em; }
        `;
        (doc.head || doc.documentElement).appendChild(state.style);
        state.note = doc.createElementNS(HTML, "p"); state.note.className = "stf-shared-run-scope";
        state.note.setAttribute("role", "status"); state.note.setAttribute("aria-live", "polite");
        state.options = doc.createXULElement("hbox"); state.options.classList.add("stf-shared-run-options");
        state.options.setAttribute("align", "center");
        state.cross = doc.createXULElement("checkbox"); state.cross.checked = true;
        state.cross.setAttribute("label", this.text("sharedNativeRunAcross"));
        state.cross.setAttribute("tooltiptext", this.text("sharedNativeRunAcrossHelp"));
        state.stop = doc.createXULElement("button"); state.stop.setAttribute("label", this.text("sharedNativeRunStop"));
        state.options.appendChild(state.cross); state.options.appendChild(state.stop);
        state.allRow = doc.createXULElement("hbox"); state.allRow.classList.add("stf-run-all-row"); state.allRow.setAttribute("align", "center");
        state.all = doc.createXULElement("button"); state.all.id = "stf-run-all-enabled";
        state.all.setAttribute("tooltiptext", this.text("sharedNativeRunAllHelp"));
        state.allPreview = doc.createElementNS(HTML, "p"); state.allPreview.className = "stf-run-all-preview";
        state.allRow.appendChild(state.all); state.allRow.appendChild(state.allPreview);
        const footer = run.parentNode.parentNode;
        footer.appendChild(state.note); footer.appendChild(state.allRow); footer.appendChild(state.options);
        state.display = () => {
          const selected = Array.from(list.selectedItems || [], row => row._filter), enabled = this.enabledFilters(win);
          const hasShared = [...selected, ...enabled].some(filter => this.kind(filter));
          const busy = Boolean(this.active || win.gRunningFilters || this.execution.isBusy?.()), across = state.cross.checked;
          const ready = filters => filters.length && (!this.needsFolder(filters, across) || (this.folder(win) && win.gCanFilterAfterTheFact !== false));
          const selectedTargets = this.targets(win, selected, across), enabledTargets = this.targets(win, enabled, across);
          const previewKey = `${selectedTargets}\n${enabledTargets}`;
          if (state.previewKey !== previewKey) state.message = null;
          state.previewKey = previewKey;
          run.setAttribute("label", this.text("sharedNativeRunSelected", String(selected.length)));
          state.all.setAttribute("label", this.text("sharedNativeRunAll", String(enabled.length)));
          state.allPreview.textContent = enabled.length ? this.text("sharedNativeRunAllPreview", enabledTargets) : this.text("sharedNativeRunNoneEnabled");
          state.note.hidden = false;
          state.options.hidden = !hasShared && !state.busy;
          state.cross.hidden = !hasShared;
          state.stop.hidden = !state.busy;
          state.cross.disabled = busy;
          state.all.disabled = busy || !ready(enabled);
          if (state.busy) { this.lock(win, state); return; }
          state.note.textContent = state.message || (win.gRunningFilters ? this.text("sharedNativeRunLocalProgress") : selected.length
            ? this.text("sharedNativeRunPreview", selectedTargets) : this.text("sharedNativeRunSelectRows"));
          run.disabled = busy || !ready(selected);
          // Either action may need the picker, even with no highlighted row.
          const local = this.needsFolder([...selected, ...enabled], across);
          const picker = doc.getElementById("runFiltersFolder"), prefix = doc.getElementById("folderPickerPrefix");
          if (picker) picker.disabled = busy || !local || win.gCanFilterAfterTheFact === false;
          if (prefix) prefix.disabled = picker?.disabled;
        };
        state.selection = () => { state.message = null; if (!state.busy) win.updateButtons?.(); state.display(); };
        // Native folder changes, account changes and run completion all update
        // these controls. Restore the original function when the add-on stops.
        state.nativeUpdate = win.updateButtons;
        state.updateButtons = function (...args) {
          const result = state.nativeUpdate?.apply(this, args); if (!state.detached) state.display(); return result;
        };
        win.updateButtons = state.updateButtons;
        state.command = event => {
          if (this.active || win.gRunningFilters || this.execution.isBusy?.()) { event.preventDefault(); event.stopImmediatePropagation(); return; }
          const filters = Array.from(list.selectedItems || [], row => row._filter);
          if (!state.cross.checked || !filters.some(filter => this.kind(filter))) {
            state.message = null;
            // The native handler starts after this capture listener returns.
            Promise.resolve().then(() => { if (!win.closed && this.windows.has(win)) state.display(); });
            return;
          }
          event.preventDefault(); event.stopImmediatePropagation();
          this.begin(win, state, filters, true);
        };
        state.allCommand = event => {
          event.preventDefault(); event.stopImmediatePropagation();
          const filters = this.enabledFilters(win);
          this.begin(win, state, filters, state.cross.checked && filters.some(filter => this.kind(filter)));
        };
        state.stopCommand = () => { if (this.active?.win === win) this.cancel(this.active.id); };
        state.cross.addEventListener("command", state.selection);
        state.stop.addEventListener("command", state.stopCommand);
        state.all.addEventListener("command", state.allCommand);
        run.addEventListener("command", state.command, true);
        state.update = () => {
          // Our decoration also changes the DOM. Observe only native redraws.
          state.observer.disconnect();
          try {
            const current = new Set(list.itemChildren);
            for (const [row, control] of state.rows) if (!current.has(row) || !this.kind(row._filter)) {
              this.clearRow(row, control); state.rows.delete(row);
            }
            for (const row of current) {
              const kind = this.kind(row._filter); if (!kind) continue;
              let control = state.rows.get(row);
              if (!control) {
                const badge = doc.createXULElement("label"); badge.classList.add("stf-shared-filter-badge");
                // Native code requires name and checkbox to remain the first
                // two children. CSS places this third child before the name.
                row.appendChild(badge);
                control = { badge, originalAria: row.getAttribute("aria-label") }; state.rows.set(row, control);
              }
              const label = this.text(kind === "shared" ? "sharedNativeBadge" : "sharedNativeReviewBadge");
              control.badge.setAttribute("value", label);
              control.badge.setAttribute("tooltiptext", this.text(kind === "shared" ? "sharedNativeTooltip" : "sharedNativeReviewTooltip"));
              control.aria = `${row._filter.filterName} — ${label}`;
              row.setAttribute("aria-label", control.aria);
            }
            state.display();
          } finally {
            state.observer.observe(list, { childList: true, subtree: true, attributes: true, attributeFilter: ["value", "label", "aria-checked"] });
          }
        };
        state.observer = new win.MutationObserver(state.update);
        list.addEventListener("select", state.selection);
        state.update();
      };
      if (win.document.readyState === "complete") state.load();
      else win.addEventListener("load", state.load, { once: true });
    }
    begin(win, state, filters, shared) {
      if (this.active || win.gRunningFilters || this.execution.isBusy?.() || !filters.length) return;
      if ((!shared || this.needsFolder(filters, true)) && (!this.folder(win) || win.gCanFilterAfterTheFact === false)) return;
      try {
        const id = this.execution.uuid();
        const control = { cancelled: false, progress: p => {
          if (win.closed || !this.windows.has(win)) return;
          state.note.textContent = this.text("sharedNativeRunProgress", [p.accountName, String(p.completed + 1), String(p.total)]);
        } };
        this.active = { id, win, state, control, selection: { window: win, list: win.gCurrentFilterList, filters, folder: this.folder(win) } };
        state.busy = true; state.message = null; win.gRunningFilters = true;
        state.note.textContent = this.text(shared ? "sharedNativeRunChecking" : "sharedNativeRunLocalProgress");
        this.lock(win, state); this.refresh();
        if (shared) Promise.resolve(this.execution.request(id)).catch(() => this.cancel(id, "shared-run-state-unavailable"));
        else this.executeLocal(this.active);
      } catch {
        if (this.active?.win === win) this.cancel(this.active.id, "native-io-failed");
        else { state.message = this.text("sharedNativeRunNotStarted", this.error("native-io-failed")); state.display(); }
      }
    }
    async executeLocal(active) {
      active.started = true;
      let result;
      try {
        await this.execution.runLocal(active.selection, active.control);
        result = active.control.cancelled ? { ok: false, completed: 0, attempted: 1, total: 1, error: "shared-run-cancelled" }
          : { ok: true, completed: 1, attempted: 1, total: 1 };
      } catch { result = { ok: false, completed: 0, attempted: 1, total: 1, error: "shared-run-filtering-failed" }; }
      this.finish(active, result);
    }
    clearRow(row, control) {
      control.badge.remove();
      if (row.getAttribute("aria-label") === control.aria) {
        if (control.originalAria === null) row.removeAttribute("aria-label");
        else row.setAttribute("aria-label", control.originalAria);
      }
    }
    lock(win, state) {
      state.disabled ||= new Map();
      for (const id of ["serverMenu", "searchBox", "filterList", "newButton", "copyToNewButton", "editButton", "deleteButton",
        "reorderTopButton", "reorderUpButton", "reorderDownButton", "reorderBottomButton", "runFiltersFolder", "runFiltersButton"]) {
        const element = win.document.getElementById(id); if (!element) continue;
        if (!state.disabled.has(element)) state.disabled.set(element, element.disabled);
        element.disabled = true;
      }
    }
    async execute(id, groups) {
      const active = this.active;
      if (!active || active.id !== id || active.started) return { ok: false, error: "shared-run-cancelled" };
      active.started = true;
      let result;
      try { result = await this.execution.runner.run(groups, active.selection, active.control); }
      catch { result = { ok: false, completed: 0, attempted: 0, total: 0, error: "native-io-failed" }; }
      this.finish(active, result); return result;
    }
    cancel(id, reason = "shared-run-cancelled") {
      const active = this.active; if (!active || active.id !== id) return;
      active.control.cancelled = true; active.control.abort?.();
      if (!active.started) this.finish(active, { ok: false, completed: 0, attempted: 0, total: 0, error: reason });
      else if (!active.win.closed) active.state.note.textContent = this.text("sharedNativeRunStopping");
    }
    clearProgress(win) {
      // Match the native completion handler, including late status messages.
      win.gRunningFilters = false;
      const panel = win.document.getElementById("statusbar-progresspanel");
      if (panel) panel.collapsed = true;
      win.progressMeterVisible = false;
      win.document.getElementById("statusText")?.setAttribute("value", "");
    }
    finish(active, result) {
      if (this.active !== active) return; this.active = null;
      const { win, state } = active; state.busy = false;
      if (win.closed || !this.windows.has(win)) { this.refresh(); return; }
      this.clearProgress(win);
      for (const [element, disabled] of state.disabled || []) element.disabled = disabled;
      state.disabled?.clear(); win.updateButtons?.();
      state.message = result.ok ? this.text("sharedNativeRunComplete", String(result.completed)) : !result.attempted
        ? this.text("sharedNativeRunNotStarted", this.error(result.error))
        : this.text("sharedNativeRunPartial", [String(result.completed), String(result.total), this.error(result.error)]);
      this.refresh();
    }
    detach(win) {
      const state = this.windows.get(win); if (!state) return;
      const ownRun = this.active?.win === win;
      if (ownRun) this.cancel(this.active.id);
      state.detached = true;
      this.windows.delete(win); win.removeEventListener("load", state.load);
      state.observer?.disconnect(); state.list?.removeEventListener("select", state.selection);
      state.run?.removeEventListener("command", state.command, true);
      state.cross?.removeEventListener("command", state.selection); state.stop?.removeEventListener("command", state.stopCommand);
      state.all?.removeEventListener("command", state.allCommand);
      if (win.updateButtons === state.updateButtons) win.updateButtons = state.nativeUpdate;
      for (const [element, attributes] of state.nativeLabels || []) for (const [key, value] of attributes) {
        if (value === null) element.removeAttribute(key); else element.setAttribute(key, value);
      }
      if (!win.closed) {
        for (const [element, disabled] of state.disabled || []) element.disabled = disabled;
        if (ownRun) this.clearProgress(win);
        if (!win.gRunningFilters) win.updateButtons?.();
      }
      for (const [row, control] of state.rows) this.clearRow(row, control);
      state.rows.clear(); state.note?.remove(); state.options?.remove(); state.allRow?.remove(); state.style?.remove();
    }
    stop() {
      this.support.unregisterWindowListener(this.listenerId);
      for (const win of this.windows.keys()) this.detach(win);
    }
  };
})(this);
