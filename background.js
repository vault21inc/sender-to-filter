/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use strict";

(() => {
  const ROOT = "stf-root";
  const MAX_MESSAGES = 100;
  const reasonKeys = {
    temporary: "reasonTemporary", unparseable: "reasonUnparseable",
    "match-all": "reasonMatchAll", grouped: "reasonGrouped", "and-logic": "reasonAndLogic",
    "no-terms": "reasonNoTerms", "duplicate-name": "reasonDuplicateName",
  };
  const text = (key, substitutions) => browser.i18n.getMessage(key, substitutions);
  // A literal ampersand must not turn a sender/filter name into an access key.
  const menuText = value => String(value).replace(/[\r\n\t]/g, " ").replaceAll("&", "&&");
  let currentGen = 0;
  let current = null;
  let menuOpen = false;
  let domainMode = false;
  let childIds = [];
  let menuQueue = Promise.resolve();

  function createMenu(properties) {
    return new Promise((resolve, reject) => {
      browser.menus.create(properties, () => {
        const error = browser.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve();
      });
    });
  }

  const ready = (async () => {
    const saved = await browser.storage.local.get("domainMode");
    domainMode = saved.domainMode === true;
    await createMenu({ id: ROOT, title: text("menuRoot"), contexts: ["message_list"], enabled: false });
  })();
  ready.catch(error => console.error("Sender to Filter could not start:", error));

  const active = gen => gen === currentGen && menuOpen;

  function queueMenu(operation) {
    const next = menuQueue.then(operation);
    // A failed operation must not permanently poison future menu builds.
    menuQueue = next.catch(() => {});
    return next;
  }

  function freezeSnapshot(snapshot) {
    Object.freeze(snapshot.folder);
    for (const key of ["senders", "conditions", "filters"]) {
      snapshot[key].forEach(Object.freeze);
      Object.freeze(snapshot[key]);
    }
    return Object.freeze(snapshot);
  }

  function rowsFor(snapshot) {
    const { gen, senders, conditions, filters } = snapshot;
    const prefix = senders.length === 1 ? text("headerSingle", senders[0].email)
      : text("headerMulti", String(senders.length));
    const domain = !snapshot.domainMode ? "" : conditions.length === 1
      ? text("headerDomainSingle", conditions[0].value)
      : text("headerDomainMulti", String(conditions.length));
    const rows = [{ id: `stf-header-${gen}`, title: prefix + domain, enabled: false }];
    for (const filter of filters) {
      let title = filter.name;
      if (filter.present === "some") title += text("suffixSome");
      if (!filter.enabled) title += text("suffixDisabled");
      if (!filter.eligible) title += text("suffixUnsupported", text(reasonKeys[filter.reason]));
      rows.push({
        id: `stf-filter-${gen}-${filter.index}`, title,
        type: "checkbox", checked: filter.present === "all", enabled: filter.eligible,
      });
    }
    rows.push(
      { id: `stf-separator-mode-${gen}`, type: "separator" },
      { id: `stf-domain-${gen}`, title: text("menuDomainToggle"), type: "checkbox", checked: snapshot.domainMode },
      { id: `stf-separator-actions-${gen}`, type: "separator" },
      { id: `stf-new-${gen}`, title: text(senders.length > 1 ? "menuNewFilterFirstOnly" : "menuNewFilter", senders[0].email) },
      { id: `stf-manage-${gen}`, title: text("menuManage") },
    );
    return rows;
  }

  function render(gen, snapshot = null, problem = null) {
    return queueMenu(async () => {
      if (!active(gen)) return;
      await browser.menus.update(ROOT, { enabled: false, title: menuText(text("menuRoot")) });
      // Menu mutations are serialized. A newer build cannot create its rows
      // halfway through removal of the previous set.
      for (const id of childIds) await browser.menus.remove(id);
      childIds = [];
      if (!active(gen)) return;
      const rows = snapshot ? rowsFor(snapshot) : problem
        ? [{ id: `stf-problem-${gen}`, title: text(problem), enabled: false }] : [];
      for (const row of rows) {
        if (!active(gen)) return;
        await createMenu({ ...row, ...(row.title ? { title: menuText(row.title) } : {}), parentId: ROOT });
        childIds.push(row.id);
      }
      if (!active(gen)) return;
      current = snapshot;
      // A disabled submenu cannot expose its explanatory child; put the
      // reason on its root as well so the limitation is visible immediately.
      await browser.menus.update(ROOT, {
        enabled: Boolean(snapshot),
        title: menuText(problem ? `${text("menuRoot")} — ${text(problem)}` : text("menuRoot")),
      });
      if (active(gen)) await browser.menus.refresh();
    });
  }

  async function selection(info, gen) {
    let page = info.selectedMessages;
    let remainingId = page?.id;
    const messages = [];
    try {
      while (page) {
        remainingId = page.id;
        if (!active(gen)) return null;
        messages.push(...page.messages);
        if (messages.length > MAX_MESSAGES) return { problem: "rowTooMany" };
        if (!remainingId) break;
        // Fetch one more page even at exactly 100: an outstanding page can be
        // empty. An unfinished list alone is not proof of a 101st message.
        page = await browser.messages.continueList(remainingId);
      }
      if (!messages.length) return { problem: "rowNoSender" };
      if (messages.some(message => !message.folder)) return { problem: "rowExternalMessage" };
      const folder = messages[0].folder;
      if (messages.some(message => message.folder.accountId !== folder.accountId)) {
        return { problem: "rowMixedAccounts" };
      }
      return { messages, folder: { accountId: folder.accountId, path: folder.path } };
    } finally {
      if (remainingId) await browser.messages.abortList(remainingId).catch(() => {});
    }
  }

  function normalizeEmail(email) {
    if (typeof email !== "string") return null;
    email = email.trim().toLowerCase();
    if (email.length > 320) return null;
    const parts = email.split("@");
    if (parts.length !== 2 || !parts[0] || /[\s<>(),;:"\x00-\x1f\x7f]/u.test(parts[0])) return null;
    const labels = parts[1].split(".");
    if (labels.length < 2 || labels.some(label =>
      !/^[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?$/u.test(label))) return null;
    return email;
  }

  async function onShown(info, tab) {
    const gen = ++currentGen;
    current = null;
    menuOpen = info.contexts.includes("message_list");
    if (!menuOpen) return;
    try {
      await ready;
      await render(gen);
      if (!active(gen)) return;
      const selected = await selection(info, gen);
      if (!selected || !active(gen)) return;
      if (selected.problem) return await render(gen, null, selected.problem);
      const mode = domainMode;
      const uniqueSenders = new Map();
      for (const message of selected.messages) {
        if (!active(gen)) return;
        let mailboxes;
        try {
          mailboxes = await browser.messengerUtilities.parseMailboxString(message.author || "");
        } catch {
          continue;
        }
        for (const mailbox of mailboxes) {
          const email = normalizeEmail(mailbox.email);
          if (email && !uniqueSenders.has(email)) uniqueSenders.set(email, { name: mailbox.name || "", email });
        }
      }
      const senders = [...uniqueSenders.values()];
      // A From field can itself contain multiple mailboxes. Apply the same
      // bound before crossing the privileged API, even for <=100 messages.
      if (senders.length > MAX_MESSAGES) return await render(gen, null, "rowTooManySenders");
      if (!senders.length) return await render(gen, null, "rowNoSender");
      const conditions = [...new Set(senders.map(sender => mode ? `@${sender.email.split("@")[1]}` : sender.email))]
        .map(value => ({ op: mode ? "contains" : "is", value }));
      if (!active(gen)) return;
      const filters = await browser.senderToFilter.listFilters(selected.folder, conditions);
      if (!active(gen)) return;
      const snapshot = freezeSnapshot({
        gen, windowId: tab.windowId, tabId: tab.id, folder: selected.folder,
        senders, conditions, filters, domainMode: mode,
      });
      await render(gen, snapshot);
    } catch (error) {
      console.error("Sender to Filter could not build its menu:", error);
      if (active(gen)) await render(gen, null, "rowLoadError").catch(() => {});
    }
  }

  async function notify(message) {
    try {
      await browser.notifications.create({
        type: "basic", title: text("extensionName"), message,
        iconUrl: browser.runtime.getURL("icons/icon.svg"),
      });
    } catch (error) {
      console.error("Sender to Filter could not show a notification:", error);
    }
  }

  async function onClicked(info, tab) {
    const match = /^stf-(filter|domain|new|manage)-(\d+)(?:-(\d+))?$/.exec(String(info.menuItemId));
    const snapshot = current;
    if (!match || !snapshot || Number(match[2]) !== snapshot.gen || snapshot.gen !== currentGen ||
        tab?.windowId !== snapshot.windowId || tab?.id !== snapshot.tabId) return;
    try {
      switch (match[1]) {
        case "domain": {
          const previous = domainMode;
          domainMode = typeof info.checked === "boolean" ? info.checked : !snapshot.domainMode;
          try {
            await browser.storage.local.set({ domainMode });
          } catch (error) {
            domainMode = previous;
            throw error;
          }
          break;
        }
        case "new":
          await browser.senderToFilter.openNewFilter(snapshot.windowId, snapshot.folder, snapshot.senders[0].email);
          break;
        case "manage":
          await browser.senderToFilter.openFilterManager(snapshot.windowId, snapshot.folder);
          break;
        case "filter": {
          const filter = snapshot.filters.find(item => item.index === Number(match[3]));
          if (!filter?.eligible) return;
          const result = await browser.senderToFilter.addConditions(snapshot.folder,
            { index: filter.index, name: filter.name }, snapshot.conditions);
          if (result.status === "ok") {
            await notify(text("notifyResult", [String(result.added.length), String(result.existing.length), filter.name]));
          } else if (result.status === "ineligible") {
            await notify(text("notifyIneligible", [filter.name, text(reasonKeys[result.reason])]));
          } else if (result.status === "not-found") {
            await notify(text("notifyNotFound", filter.name));
          } else {
            await notify(text("notifyError", result.message || text("errorUnknown")));
          }
          break;
        }
      }
    } catch (error) {
      await notify(text("notifyError", String(error.message || error)));
    }
  }

  browser.menus.onShown.addListener(onShown);
  browser.menus.onClicked.addListener(onClicked);
  browser.menus.onHidden.addListener(() => {
    menuOpen = false;
    const gen = currentGen;
    // Keep the immutable snapshot for platforms that deliver click after hide,
    // but cancel unfinished builds and leave the next menu initially disabled.
    void queueMenu(async () => {
      await ready;
      if (gen === currentGen && !menuOpen) await browser.menus.update(ROOT, { enabled: false });
    }).catch(() => {});
  });
})();
