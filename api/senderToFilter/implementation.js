/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use strict";

(function (exports) {
  const { Sender } = Ci.nsMsgSearchAttrib;
  const operators = { is: Ci.nsMsgSearchOp.Is, contains: Ci.nsMsgSearchOp.Contains };

  function validDomain(domain) {
    const labels = domain.split(".");
    return labels.length >= 2 && labels.every(label =>
      /^[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?$/u.test(label)
    );
  }

  function normalizeConditions(conditions) {
    if (!Array.isArray(conditions) || conditions.length > 100) {
      throw new Error("Expected at most 100 sender conditions.");
    }
    const unique = new Map();
    for (const condition of conditions) {
      const op = condition?.op;
      const value = typeof condition?.value === "string"
        ? condition.value.trim().toLowerCase() : "";
      const parts = value.split("@");
      const local = parts[0];
      if (!Object.hasOwn(operators, op) || value.length > 320 || parts.length !== 2 ||
          !validDomain(parts[1]) ||
          (op === "contains" ? local !== "" : !local || /[\s<>(),;:"\x00-\x1f\x7f]/u.test(local))) {
        throw new Error("A condition must contain a usable email address or @domain text.");
      }
      unique.set(`${op}:${value}`, { op, value });
    }
    return [...unique.values()];
  }

  function enumerate(list) {
    return Array.from({ length: list.filterCount }, (_, index) => list.getFilterAt(index));
  }

  function ineligibleReason(filter, filters, terms) {
    if (filter.temporary) return "temporary";
    if (filter.unparseable) return "unparseable";
    if (!terms.length) return "no-terms";
    if (terms.some(term => term.matchAll)) return "match-all";
    if (terms.some(term => term.beginsGrouping || term.endsGrouping)) return "grouped";
    // The first connector does not join two terms. Never rewrite it or any
    // existing term: the snapshot below is shallow and must remain untouched.
    if (terms.slice(1).some(term => term.booleanAnd)) return "and-logic";
    if (filters.filter(other => other.filterName === filter.filterName).length !== 1) {
      return "duplicate-name";
    }
    return null;
  }

  function isPresent(terms, condition) {
    return terms.some(term => term.attrib === Sender && term.op === operators[condition.op] &&
      typeof term.value?.str === "string" &&
      term.value.str.toLowerCase() === condition.value);
  }

  const FILTER_EDITOR = "chrome://messenger/content/FilterEditor.xhtml";
  const TAG_DIALOG = "chrome://messenger/content/newTagDialog.xhtml";

  class FilterTagControls {
    constructor(extension) {
      this.extension = extension;
      this.windows = new Map();
      this.listenerId = `${extension.id}-filter-tags`;
      this.support = ChromeUtils.importESModule("resource:///modules/ExtensionSupport.sys.mjs").ExtensionSupport;
      this.tags = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs").MailServices.tags;
    }

    text(key) {
      return this.extension.localeData.localizeMessage(key);
    }

    start() {
      if (!this.support.registerWindowListener(this.listenerId, {
        chromeURLs: [FILTER_EDITOR],
        onLoadWindow: win => this.attach(win),
        onUnloadWindow: win => this.detach(win),
      })) {
        throw new Error("Could not register the filter tag controls.");
      }
    }

    attach(win) {
      if (this.windows.has(win)) return;
      const state = { controls: new Map(), observer: null, pending: null };
      this.windows.set(win, state);
      state.load = () => {
        const list = win.document.getElementById("filterActionList");
        if (!list) return;
        const update = () => {
          for (const [target, control] of state.controls) {
            if (!list.contains(target)) {
              control.button.removeEventListener("command", control.command);
              control.button.remove();
              state.controls.delete(target);
            }
          }
          for (const target of list.querySelectorAll("ruleactiontarget-tag")) {
            if (state.controls.has(target)) continue;
            const menu = target.querySelector("menulist");
            if (!menu) continue;
            const button = win.document.createXULElement("button");
            button.classList.add("stf-new-tag-button");
            button.setAttribute("label", this.text("filterNewTag"));
            button.setAttribute("tooltiptext", this.text("filterNewTagTooltip"));
            const command = event => {
              event.stopPropagation();
              this.createTag(win, state, target, menu, button);
            };
            button.addEventListener("command", command);
            state.controls.set(target, { button, command, menu });
            target.appendChild(button);
          }
        };
        state.observer = new win.MutationObserver(update);
        state.observer.observe(list, { childList: true, subtree: true });
        update();
      };
      if (win.document.readyState === "complete") state.load();
      else win.addEventListener("load", state.load, { once: true });
    }

    refreshMenus() {
      const tags = this.tags.getAllTags();
      for (const [win, state] of this.windows) {
        for (const [target, { menu }] of state.controls) {
          if (!target.isConnected) continue;
          const selected = menu.value;
          const popup = menu.menupopup;
          const fragment = win.document.createDocumentFragment();
          for (const tag of tags) {
            const item = win.document.createXULElement("menuitem");
            item.setAttribute("label", tag.tag);
            item.setAttribute("value", tag.key);
            if (tag.color) item.style.color = tag.color;
            fragment.appendChild(item);
          }
          popup.replaceChildren(fragment);
          menu.value = selected;
        }
      }
    }

    createTag(win, state, target, menu, button) {
      if (state.pending || !target.isConnected || !this.windows.has(win)) return;
      const args = {
        okCallback: (name, color) => {
          // An add-on disable or removed action must not leave a live callback.
          if (!this.windows.has(win) || !target.isConnected) return false;
          let key;
          try {
            this.tags.addTag(name, color, "");
            key = this.tags.getKeyForTag(name);
          } catch (error) {
            console.error("Sender to Filter could not create the tag:", error);
            Services.prompt.alert(win, this.text("extensionName"), this.text("filterTagCreateError"));
            return false;
          }
          try {
            this.refreshMenus();
            menu.value = key;
            win.checkActionsReorder();
          } catch (error) {
            console.error("Sender to Filter could not select the new tag:", error);
            Services.prompt.alert(win, this.text("extensionName"), this.text("filterTagSelectError"));
          }
          return true;
        },
      };
      state.pending = args;
      button.disabled = true;
      try {
        win.openDialog(TAG_DIALOG, "", "chrome,modal,titlebar,centerscreen,resizable=no", args);
      } catch (error) {
        console.error("Sender to Filter could not open the tag dialog:", error);
        Services.prompt.alert(win, this.text("extensionName"), this.text("filterTagCreateError"));
      } finally {
        state.pending = null;
        button.disabled = false;
        if (menu.isConnected) menu.focus();
      }
    }

    detach(win) {
      const state = this.windows.get(win);
      if (!state) return;
      this.windows.delete(win);
      win.removeEventListener("load", state.load);
      state.observer?.disconnect();
      for (const { button, command } of state.controls.values()) {
        button.removeEventListener("command", command);
        button.remove();
      }
      state.controls.clear();
      if (state.pending) {
        for (const child of Services.wm.getEnumerator(null)) {
          if (child.document.documentURI === TAG_DIALOG && child.arguments?.[0] === state.pending) child.close();
        }
      }
    }

    stop() {
      this.support.unregisterWindowListener(this.listenerId);
      for (const win of this.windows.keys()) this.detach(win);
    }
  }

  exports.senderToFilter = class extends ExtensionCommon.ExtensionAPI {
    getAPI(context) {
      const resolveFolder = folder => {
        if (!folder || typeof folder.accountId !== "string" || typeof folder.path !== "string") {
          throw new Error("The selected message has no usable account folder.");
        }
        const nativeFolder = context.extension.folderManager.get(folder.accountId, folder.path);
        if (!nativeFolder) throw new Error("The message folder is no longer available.");
        return nativeFolder;
      };
      const getList = folder => {
        const msgWindow = Cc["@mozilla.org/messenger/msgwindow;1"].createInstance(Ci.nsIMsgWindow);
        return resolveFolder(folder).getEditableFilterList(msgWindow);
      };
      const getWindow = windowId => {
        const win = context.extension.windowManager.get(windowId)?.window;
        if (!win || win.closed || typeof win.MsgFilters !== "function") {
          throw new Error("The Thunderbird window is no longer available. Open the menu in a mail window.");
        }
        return win;
      };

      return {
        senderToFilter: {
          enableFilterTags: async () => {
            if (this.filterTags) return;
            const controls = new FilterTagControls(context.extension);
            controls.start();
            this.filterTags = controls;
          },

          async listFilters(folder, conditions) {
            const wanted = normalizeConditions(conditions);
            const filters = enumerate(getList(folder));
            return filters.map((filter, index) => {
              const terms = filter.searchTerms;
              const reason = ineligibleReason(filter, filters, terms);
              // Unsupported/unparseable terms need not have usable values.
              const count = reason ? 0 : wanted.filter(c => isPresent(terms, c)).length;
              return {
                index, name: filter.filterName, enabled: filter.enabled,
                eligible: !reason, ...(reason ? { reason } : {}),
                present: count === 0 ? "none" : count === wanted.length ? "all" : "some",
              };
            });
          },

          async addConditions(folder, target, conditions) {
            let filter;
            let snapshot;
            let existing = [];
            let mutationStarted = false;
            try {
              const wanted = normalizeConditions(conditions);
              const list = getList(folder);
              const filters = enumerate(list);
              filter = Number.isInteger(target?.index) ? filters[target.index] : null;
              if (!filter || filter.filterName !== target?.name) {
                const matches = filters.filter(candidate => candidate.filterName === target?.name);
                filter = matches.length === 1 ? matches[0] : null;
              }
              if (!filter) return { status: "not-found", added: [], existing };

              snapshot = filter.searchTerms;
              const reason = ineligibleReason(filter, filters, snapshot);
              if (reason) return { status: "ineligible", reason, added: [], existing };
              const toAdd = wanted.filter(condition => {
                if (!isPresent(snapshot, condition)) return true;
                existing.push(condition.value);
                return false;
              });
              if (!toAdd.length) return { status: "ok", added: [], existing };

              // Keep validation, mutation and save synchronous within this API
              // call. There is no await that can interleave another batch.
              mutationStarted = true;
              for (const condition of toAdd) {
                const term = filter.createTerm();
                term.attrib = Sender;
                term.op = operators[condition.op];
                const value = term.value;
                value.attrib = Sender;
                value.str = condition.value;
                term.value = value;
                term.booleanAnd = false;
                filter.appendTerm(term);
              }
              list.saveToDefaultFile();
              return { status: "ok", added: toAdd.map(c => c.value), existing };
            } catch (error) {
              let message = String(error?.message || error);
              if (mutationStarted) {
                try {
                  // Setter restores the original term references AND clears
                  // Thunderbird's expression cache. Splicing the getter cannot.
                  filter.searchTerms = snapshot;
                } catch (rollbackError) {
                  message += `; restoring the original filter also failed: ${rollbackError.message || rollbackError}`;
                }
              }
              return { status: "error", added: [], existing, message };
            }
          },

          async openNewFilter(windowId, folder, emailAddress) {
            const [condition] = normalizeConditions([{ op: "is", value: emailAddress }]);
            getWindow(windowId).MsgFilters(condition.value, resolveFolder(folder));
          },

          async openFilterManager(windowId, folder) {
            getWindow(windowId).MsgFilters(undefined, resolveFolder(folder));
          },
        },
      };
    }

    onShutdown(isAppShutdown) {
      this.filterTags?.stop();
      this.filterTags = null;
      if (!isAppShutdown) Services.obs.notifyObservers(null, "startupcache-invalidate");
    }
  };
})(this);
