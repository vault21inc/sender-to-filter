/* MPL-2.0. The manager sends domain requests; it never writes shared storage. */
"use strict";
(() => {
  const $ = id => document.getElementById(id);
  const text = (key, values) => browser.i18n.getMessage(key, values);
  const clone = value => JSON.parse(JSON.stringify(value));
  const node = (tag, value, className) => { const e = document.createElement(tag); if (value !== undefined) e.textContent = value;
    if (className) e.className = className; return e; };
  const button = (key, action) => { const b = node("button", text(key)); b.type = "button"; b.addEventListener("click", () => guarded(action)); return b; };
  const option = (value, label) => { const e = node("option", label); e.value = value; return e; };
  const label = (key, input) => { const e = node("label"); e.append(node("span", text(key)), input); return e; };
  const actionNames = { MoveToFolder: "sharedMove", CopyToFolder: "sharedCopy", AddTag: "sharedTag", ChangePriority: "sharedPriority", JunkScore: "sharedJunk",
    MarkRead: "sharedMarkRead", MarkUnread: "sharedMarkUnread", MarkFlagged: "sharedStar", Delete: "sharedDelete", StopExecution: "sharedStop",
    KillThread: "sharedIgnoreThread", KillSubthread: "sharedIgnoreSubthread", WatchThread: "sharedWatchThread" };
  let view, catalog = { accounts: [], folders: [] }, draft = null, prepared = null, rows = [], busy = false;
  const accountName = id => catalog.accounts.find(a => a.accountId === id)?.name || text("sharedUnavailableAccount");
  const folderLabel = ref => ref ? `${accountName(ref.accountId)} — ${ref.path}` : text("sharedChooseFolder");
  function errorText(code) { return text(`sharedError_${String(code).replaceAll("-", "_")}`) || text("sharedErrorGeneric"); }
  function status(message, error = false) { $("status").textContent = message; $("status").classList.toggle("error", error); }
  async function request(action, payload = {}) {
    const response = await browser.runtime.sendMessage({ channel: "stf-shared", action, payload });
    if (!response?.ok) throw new Error(errorText(response?.error));
    return response.data;
  }
  async function guarded(action) {
    if (busy) return;
    busy = true; document.body.setAttribute("aria-busy", "true");
    try { await action(); } catch (error) { status(error.message || text("sharedErrorGeneric"), true); $("status").focus(); }
    finally { busy = false; document.body.removeAttribute("aria-busy"); }
  }
  function conditions(def) {
    if (def.logic === "all") return [text("sharedAllMessages")];
    // Presentation only. Native parsing/round-trip validation owns semantics.
    const source = def.conditionText, result = [];
    let start = -1, depth = 0, quoted = false, escaped = false;
    for (let i = 0; i < source.length; i++) {
      const char = source[i];
      if (escaped) { escaped = false; continue; }
      if (char === "\\" && quoted) { escaped = true; continue; }
      if (char === '"') quoted = !quoted;
      if (quoted) continue;
      if (char === "(") { if (!depth) start = i + 1; depth++; }
      if (char === ")" && --depth === 0 && start >= 0) result.push(source.slice(start, i));
    }
    return result.map(line => { const [header, op, ...value] = line.split(",");
      return `${header.replace(/^"|"$/g, "")} ${op.replaceAll(" ", " ")} ${value.join(",")}`; });
  }
  function ruleSummary(def, mappings = {}) {
    const box = node("div", undefined, "rule");
    box.append(node("strong", text(def.logic === "and" ? "sharedMatchAll" : def.logic === "all" ? "sharedAllMessages" : "sharedMatchAny")));
    const list = node("ul"); for (const condition of conditions(def)) list.append(node("li", condition)); box.append(list);
    const actions = node("ul");
    for (const a of def.actions) {
      const payload = a.slotId ? folderLabel(mappings[a.slotId]) : a.tagKey
        ? catalog.tags?.find(tag => tag.key === a.tagKey)?.name || a.tagKey : a.priority ?? a.junkScore;
      actions.append(node("li", `${text(actionNames[a.type])}${payload === undefined ? "" : `: ${payload}`}`));
    }
    box.append(actions);
    const triggers = [[1, "sharedIncoming"], [16, "sharedManual"], [32, "sharedAfterJunk"], [64, "sharedOutgoing"], [128, "sharedArchive"], [256, "sharedPeriodic"]]
      .filter(([bit]) => def.filterType & bit).map(([, key]) => text(key));
    box.append(node("p", `${text(def.enabled ? "sharedEnabled" : "sharedDisabled")} · ${triggers.join(", ")}`, "hint"));
    if (def.description) box.append(node("p", def.description));
    return box;
  }
  function showGroups() {
    const area = $("groups"); area.replaceChildren();
    if (view.blocked) { status(errorText(view.blocked), true); $("new").disabled = true; return; }
    const groups = Object.values(view.state.groups);
    if (!groups.length) { const empty = node("div", undefined, "panel"); empty.append(node("h2", text("sharedEmptyTitle")), node("p", text("sharedEmptyHelp"))); area.append(empty); }
    for (const g of groups) {
      const card = node("article", undefined, "card");
      card.append(node("h2", g.definition.name), node("p", text("sharedMemberCount", String(g.members.length)), "hint"));
      const table = node("table"), head = node("tr");
      for (const key of ["sharedAccount", "sharedStatus", "sharedActions"]) head.append(node("th", text(key)));
      const thead = node("thead"); thead.append(head); table.append(thead); const body = node("tbody");
      for (const m of g.members) {
        const observed = view.observations[g.id]?.find(r => r.memberId === m.id);
        const state = observed?.status === "applied" ? "current" : observed?.status || m.status;
        const row = node("tr"), details = node("td"), actions = node("td"), bar = node("div", undefined, "toolbar");
        details.append(node("span", text(`sharedStatus_${state.replaceAll("-", "_")}`) || text("sharedStatus_needs_review"), "badge"));
        if (observed?.reason) details.append(node("p", errorText(observed.reason), "hint"));
        if (observed?.inspectedAt) details.append(node("p", new Date(observed.inspectedAt).toLocaleString(), "hint"));
        bar.append(button("sharedUseAccount", async () => {
          const exported = await request("source", { accountId: m.accountId, selector: { kind: "owned", groupId: g.id, memberId: m.id } });
          await openDraft(g, true); draft.definition = exported.definition;
          for (const entry of draft.members) entry.folderMappings = entry.accountId === m.accountId ? exported.mappings : {};
          fillForm(); status(text("sharedReviewMappings"));
        }));
        bar.append(button("sharedUnlinkAccount", async () => { await openDraft(g, true); draft.members.find(e => e.memberId === m.id).detach = true; renderMembers(); }));
        const absentCreation = g.operation?.targets.some(t => t.memberId === m.id && t.mode === "create") &&
          observed?.snapshot === null && ["retry", "reprepare"].includes(observed.action);
        if (absentCreation || ["account-unavailable", "missing-replica"].includes(observed?.reason)) bar.append(button("sharedForget", async () => {
          if (!window.confirm(text("sharedForgetConfirm", accountName(m.accountId)))) return;
          view = await request("forget", { id: g.id, revision: g.revision, memberId: m.id }); showGroups();
        }));
        actions.append(bar); row.append(node("td", accountName(m.accountId)), details, actions); body.append(row);
      }
      table.append(body); card.append(table);
      const bar = node("div", undefined, "toolbar");
      const edit = button("sharedEdit", () => openDraft(g, false)); edit.disabled = Boolean(g.operation); bar.append(edit);
      bar.append(button("sharedResolve", () => openDraft(g, true)));
      if (g.operation) bar.append(button("sharedRetry", async () => { view = await request("retry", { id: g.id, revision: g.revision }); showGroups(); status(text("sharedStatusRefreshed")); }));
      bar.append(button("sharedUnlinkGroup", async () => { await openDraft(g, true); draft.members.forEach(m => { m.detach = true; }); renderMembers(); }));
      card.append(bar); area.append(card);
    }
  }
  async function refresh() {
    [view, catalog] = await Promise.all([request("load"), request("accounts")]); showGroups();
    if (!view.blocked) status(text("sharedStatusRefreshed"));
  }
  async function openDraft(group = null, resolve = false) {
    if (group) catalog = await request("accounts");
    prepared = null; $("preview").hidden = true; $("editor").hidden = false; $("source").hidden = Boolean(group);
    $("groups").hidden = true; $("editorTitle").textContent = text(group ? resolve ? "sharedResolve" : "sharedEdit" : "sharedNew");
    draft = group ? { groupId: group.id, revision: group.revision, resolve, definition: clone(group.definition),
      members: group.members.map(m => ({ accountId: m.accountId, memberId: m.id, folderMappings: clone(m.folderMappings) })) } : null;
    $("form").hidden = !group;
    if (group) fillForm(); else {
      const source = $("source"); source.replaceChildren();
      const account = node("select"), filter = node("select");
      for (const a of catalog.accounts) { const opt = option(a.accountId, a.name + (a.reason ? ` — ${errorText(a.reason)}` : "")); opt.disabled = Boolean(a.reason); account.append(opt); }
      account.value = catalog.accounts.find(a => !a.reason)?.accountId || "";
      function filters() { filter.replaceChildren(); for (const f of catalog.accounts.find(a => a.accountId === account.value)?.filters || []) {
        const opt = option(String(f.index), f.name + (f.marker ? ` — ${text("sharedAlreadyLinked")}` : f.reason ? ` — ${errorText(f.reason)}` : ""));
        opt.disabled = Boolean(f.reason || f.marker); filter.append(opt);
      } filter.value = [...filter.options].find(o => !o.disabled)?.value || ""; }
      account.addEventListener("change", filters); filters();
      source.append(label("sharedSourceAccount", account), label("sharedSourceFilter", filter), button("sharedLoadSource", async () => {
        const f = catalog.accounts.find(a => a.accountId === account.value)?.filters.find(f => String(f.index) === filter.value);
        if (!f || f.reason || f.marker) throw new Error(text("sharedChooseSource"));
        const selector = { kind: "explicit", index: f.index, name: f.name, fingerprint: f.fingerprint };
        const read = await request("source", { accountId: account.value, selector });
        draft = { resolve: false, definition: read.definition,
          members: [{ accountId: account.value, selector, folderMappings: read.mappings }], sourceId: account.value };
        $("source").hidden = true; $("form").hidden = false; fillForm();
      }));
    }
    $("editorTitle").tabIndex = -1; $("editorTitle").focus();
  }
  function fillForm() {
    $("name").value = draft.definition.name; $("description").value = draft.definition.description; $("enabled").checked = draft.definition.enabled;
    $("ruleSummary").replaceChildren(ruleSummary(draft.definition, draft.members[0]?.folderMappings));
    $("reference").replaceChildren();
    for (const m of draft.members) if (catalog.accounts.some(a => a.accountId === m.accountId && !a.reason)) $("reference").append(option(m.accountId, accountName(m.accountId)));
    renderMembers();
  }
  function renderFilterOrder(row, reveal = false) {
    const { account, existing, mode, position, orderList, orderHint } = row;
    const creating = mode.value === "create", detaching = mode.value.startsWith("detach");
    const name = $("name").value.trim() || text("sharedUnnamedFilter");
    const entries = account.filters.map(f => ({ ...f }));
    let active = -1;
    if (creating) {
      const value = Number(position.value);
      if (Number.isSafeInteger(value) && value >= 1 && value <= entries.length + 1) {
        active = value - 1;
        entries.splice(active, 0, { name, enabled: $("enabled").checked });
        orderHint.textContent = text("sharedOrderNewPosition", [String(value), String(entries.length)]);
      } else orderHint.textContent = text("sharedOrderInvalidPosition", String(entries.length + 1));
    } else {
      const selected = ["owned", "detach"].includes(mode.value)
        ? entries.filter(f => f.marker?.groupId === draft.groupId && f.marker?.memberId === existing?.memberId)
        : entries.filter(f => String(f.index) === mode.value.replace("detach:", ""));
      if (selected.length === 1) {
        active = entries.indexOf(selected[0]);
        if (!detaching) {
          entries[active].previousName = entries[active].name !== name ? entries[active].name : null;
          entries[active].name = name; entries[active].enabled = $("enabled").checked;
        }
      }
      orderHint.textContent = active >= 0 ? text("sharedOrderKeptPosition", String(active + 1)) : text("sharedOrderUnchanged");
    }
    orderList.replaceChildren();
    for (const [index, entry] of entries.entries()) {
      const highlighted = index === active;
      const item = node("li", undefined, highlighted ? "filter-order-current" : "");
      const content = node("div", undefined, "filter-order-entry");
      content.append(node("span", entry.name, "filter-order-name"));
      if (highlighted) content.append(node("span", text(creating ? "sharedOrderNewCopy" : detaching ? "sharedOrderIndependentCopy" : "sharedOrderLinkedCopy"), "badge"));
      if (!entry.enabled) content.append(node("span", text("sharedDisabled"), "badge"));
      item.append(content);
      if (entry.previousName) item.append(node("span", text("sharedOrderReplaces", entry.previousName), "hint"));
      orderList.append(item);
    }
    // Scroll only this list, keeping its highlighted row and neighbours visible.
    const highlighted = orderList.children[active];
    if (reveal && highlighted && orderList.clientHeight) orderList.scrollTop = Math.max(0,
      highlighted.offsetTop - (orderList.clientHeight - highlighted.offsetHeight) / 2);
  }
  function renderMembers() {
    const area = $("members"); area.replaceChildren(); rows = [];
    const accounts = [...catalog.accounts];
    for (const m of draft.members) if (!accounts.some(a => a.accountId === m.accountId)) accounts.push({ accountId: m.accountId, name: accountName(m.accountId), reason: "account-unavailable", filters: [] });
    for (const account of accounts) {
      const existing = draft.members.find(m => m.accountId === account.accountId);
      const panel = node("div", undefined, "panel"), checked = node("input"); checked.type = "checkbox";
      checked.checked = Boolean(existing); checked.disabled = Boolean(existing?.memberId || draft.sourceId === account.accountId || account.reason);
      const heading = node("label", undefined, "check"); heading.append(checked, node("span", account.name)); panel.append(heading);
      if (account.reason) panel.append(node("p", errorText(account.reason), "hint"));
      const controls = node("div", undefined, "grid"), mode = node("select");
      if (existing?.memberId) {
        mode.append(option("owned", text("sharedKeepLinked")), option("detach", text("sharedUnlinkAccount")));
        if (draft.resolve) mode.append(option("create", text("sharedRecreate")));
      } else mode.append(option("create", text("sharedCreateCopy")));
      if (!existing?.memberId || draft.resolve) for (const f of account.filters) {
        if (!f.marker && !f.reason) mode.append(option(String(f.index), text("sharedLinkExisting", f.name)));
        else if (existing?.memberId && f.marker?.groupId === draft.groupId && f.marker?.memberId === existing.memberId) {
          mode.append(option(String(f.index), text("sharedSelectLinked", [f.name, String(f.index + 1)])));
          mode.append(option(`detach:${f.index}`, text("sharedSelectUnlink", [f.name, String(f.index + 1)])));
        }
      }
      mode.value = existing?.detach ? existing.selector ? `detach:${existing.selector.index}` : "detach" : existing?.create ? "create" :
        existing?.selector ? String(existing.selector.index) : existing?.memberId ? "owned" : "create";
      if (draft.sourceId === account.accountId) mode.disabled = true;
      controls.append(label("sharedAccountAction", mode));
      const position = node("input"); position.type = "number"; position.min = "1"; position.max = String(account.filters.length + 1);
      position.required = true;
      position.value = String((existing?.position ?? account.filters.length) + 1);
      const positionLabel = label("sharedPosition", position); controls.append(positionLabel);
      const mapping = {};
      draft.definition.actions.forEach((a, index) => {
        if (!a.slotId) return;
        const select = node("select"); select.append(option("", text("sharedChooseFolder")));
        catalog.folders.forEach((f, i) => select.append(option(String(i), f.label)));
        const ref = existing?.folderMappings[a.slotId] || catalog.folders.find(f => f.accountId === account.accountId && f.path === draft.members[0]?.folderMappings[a.slotId]?.path);
        const i = catalog.folders.findIndex(f => f.accountId === ref?.accountId && f.path === ref?.path);
        select.value = i < 0 ? "" : String(i); mapping[a.slotId] = select;
        const l = node("label"); l.append(node("span", `${text(actionNames[a.type])} (${index + 1})`), select); controls.append(l);
      });
      const order = node("div", undefined, "filter-order"), orderTitle = node("p", text("sharedOrderTitle"), "filter-order-title");
      orderTitle.id = `filter-order-title-${rows.length}`;
      const orderHint = node("p", undefined, "hint"); orderHint.id = `filter-order-hint-${rows.length}`;
      orderHint.setAttribute("role", "status"); orderHint.setAttribute("aria-live", "polite");
      const orderList = node("ol", undefined, "filter-order-list"); orderList.tabIndex = 0;
      orderList.setAttribute("aria-labelledby", orderTitle.id); orderList.setAttribute("aria-describedby", orderHint.id);
      position.setAttribute("aria-describedby", orderHint.id);
      order.append(orderTitle, orderHint, orderList);
      const row = { account, checked, mode, position, mapping, existing, orderList, orderHint };
      const update = () => { controls.hidden = !checked.checked; order.hidden = !checked.checked || Boolean(account.reason);
        position.disabled = !checked.checked || mode.value !== "create"; positionLabel.hidden = mode.value !== "create";
        for (const select of Object.values(mapping)) select.disabled = mode.value.startsWith("detach");
        renderFilterOrder(row, true); };
      checked.addEventListener("change", update); mode.addEventListener("change", update);
      position.addEventListener("input", () => renderFilterOrder(row, true));
      panel.append(controls, order); area.append(panel); rows.push(row); update();
    }
  }
  function collect() {
    draft.definition.name = $("name").value.trim(); draft.definition.description = $("description").value; draft.definition.enabled = $("enabled").checked;
    const members = [];
    for (const row of rows.filter(r => r.checked.checked)) {
      const entry = { accountId: row.account.accountId, ...(row.existing?.memberId ? { memberId: row.existing.memberId } : {}), folderMappings: {} };
      for (const [slot, select] of Object.entries(row.mapping)) {
        const f = catalog.folders[Number(select.value)];
        if (row.mode.value.startsWith("detach")) { entry.folderMappings = clone(row.existing.folderMappings); break; }
        if (select.value === "" || !f) throw new Error(text("sharedChooseAllFolders"));
        entry.folderMappings[slot] = { accountId: f.accountId, path: f.path };
      }
      if (row.mode.value.startsWith("detach")) entry.detach = true;
      if (row.mode.value === "create") { entry.position = Number(row.position.value) - 1; entry.create = Boolean(entry.memberId); }
      else if (!["owned", "detach"].includes(row.mode.value)) {
        const f = row.account.filters.find(f => String(f.index) === row.mode.value.replace("detach:", ""));
        if (!f) throw new Error(text("sharedChooseSource"));
        entry.selector = { kind: "explicit", index: f.index, name: f.name, fingerprint: f.fingerprint };
      }
      members.push(entry);
    }
    draft.members = members;
    const { sourceId, ...request } = draft; return request;
  }
  function showPreview(result) {
    prepared = result; const area = $("previewContent"); area.replaceChildren();
    const g = result.group; area.append(node("h3", g.definition.name));
    for (const [i, m] of g.members.entries()) {
      const target = g.operation.targets[i], box = node("div", undefined, "panel");
      box.append(node("h3", `${accountName(m.accountId)} · ${text(`sharedMode_${target.mode}`)}`));
      if (target.mode === "detach") box.append(node("p", text("sharedUnlinkHelp")));
      else { box.append(ruleSummary(g.definition, m.folderMappings)); box.append(node("p", text("sharedPreviewPosition", String(target.after.position + 1)), "hint")); }
      if (target.before && target.mode !== "detach") {
        const details = node("details"); details.append(node("summary", text("sharedBefore", target.before.rule.name)));
        details.append(node("p", text("sharedBeforeHelp")));
        const before = result.previousRules?.find(r => r.memberId === m.id);
        if (before?.definition) details.append(ruleSummary(before.definition, before.mappings));
        else details.append(node("p", text("sharedUnsupportedBefore")));
        box.append(details);
      }
      if (target.cleanup) {
        box.append(node("p", text("sharedCleanupHelp")));
        const list = node("ul");
        for (const r of target.cleanup) list.append(node("li", text("sharedCleanupCopy", [r.rule.name, String(r.position + 1)])));
        box.append(list);
      }
      area.append(box);
    }
    $("editor").hidden = true; $("preview").hidden = false; $("previewTitle").tabIndex = -1; $("previewTitle").focus();
  }
  function closeEditor() { draft = null; prepared = null; $("editor").hidden = true; $("preview").hidden = true; $("groups").hidden = false; }
  document.querySelectorAll("[data-i18n]").forEach(e => { e.textContent = text(e.dataset.i18n); }); document.title = text("sharedTitle");
  $("refresh").addEventListener("click", () => guarded(refresh));
  $("new").addEventListener("click", () => guarded(async () => { await refresh(); await openDraft(); }));
  $("name").addEventListener("input", () => rows.forEach(row => renderFilterOrder(row)));
  $("enabled").addEventListener("change", () => rows.forEach(row => renderFilterOrder(row)));
  $("cancel").addEventListener("click", closeEditor); $("back").addEventListener("click", () => { prepared = null; $("preview").hidden = true; $("editor").hidden = false; });
  $("form").addEventListener("submit", event => { event.preventDefault(); void guarded(async () => {
    const data = await request("preview", collect());
    if (!data.ok) throw new Error(data.problems.map(p => `${accountName(p.accountId)}: ${errorText(p.code)}`).join("\n"));
    showPreview(data); status(text("sharedReadyToSave"));
  }); });
  $("nativeEdit").addEventListener("click", () => guarded(async () => {
    collect(); const member = draft.members.find(m => m.accountId === $("reference").value);
    if (!member) throw new Error(text("sharedChooseReference"));
    const edited = await request("edit", { accountId: member.accountId, definition: draft.definition, mappings: member.folderMappings });
    if (edited.canceled) return;
    draft.definition = edited.definition;
    if (edited.mappingReviewRequired) for (const m of draft.members) m.folderMappings = m === member ? edited.referenceMappings : {};
    fillForm(); status(text(edited.mappingReviewRequired ? "sharedReviewMappings" : "sharedDraftChanged"));
  }));
  $("sameFolders").addEventListener("click", () => guarded(async () => {
    const selected = rows.filter(r => r.checked.checked); if (!selected.length) return;
    for (const row of selected.slice(1)) for (const [slot, input] of Object.entries(row.mapping)) input.value = selected[0].mapping[slot].value;
    status(text("sharedDestinationsCopied"));
  }));
  $("save").addEventListener("click", () => guarded(async () => {
    if (!prepared) return; const token = prepared.token; prepared = null;
    view = await request("commit", { token }); closeEditor(); showGroups(); status(text("sharedSaved"));
  }));
  window.addEventListener("focus", () => { if (!draft && !busy) void guarded(refresh); });
  void guarded(refresh);
})();
