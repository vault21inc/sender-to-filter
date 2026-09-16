const fs = require("node:fs"), vm = require("node:vm"), path = require("node:path");
const { webcrypto } = require("node:crypto");
const { root, plain } = require("./helpers.cjs");
function setup() {
  const scope = vm.createContext({ TextEncoder, TextDecoder, crypto: webcrypto, Date });
  for (const file of ["lib/shared-model.js", "lib/shared-coordinator.js", "api/senderToFilter/shared.js"])
    vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), scope);
  const M = scope.SenderToFilterSharedModel;
  const fail = code => { throw new M.ModelError(code); };
  let serial = 10;
  const uuid = () => `${(++serial).toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
  const accounts = new Map(), writes = [], store = {}, storageWrites = [];
  const storage = { failure: null, async get() { return plain(store); }, async set(value) {
    storageWrites.push(plain(value)); if (storage.failure?.(value, storageWrites.length)) throw new Error("quota");
    Object.assign(store, plain(value));
  } };
  const rule = name => ({ name, description: "", enabled: false, filterType: 17, temporary: false, unparseable: false, unparsedBuffer: "",
    terms: [{ text: "from,is,old@example.com", attrib: 1, op: 0, arbitraryHeader: "", booleanAnd: false, matchAll: false, beginsGrouping: 0, endsGrouping: 0 }], actions: [{ type: 4 }] });
  const wrap = raw => {
    const f = { data: plain(raw) };
    Object.defineProperties(f, { temporary: { get: () => f.data.temporary }, filterDesc: { get: () => f.data.description, set: v => { f.data.description = v; } } });
    return f;
  };
  for (const id of ["a", "b", "c"]) {
    const saved = { loggingEnabled: true, filters: id === "a" ? [rule("Letters"), rule("Other")] : [rule("Other")] };
    const account = { id, name: id, type: "imap", physicalKey: id, identity: { key: id, host: `${id}.invalid`, user: "user", type: "imap", port: 993 },
      disk: plain(saved), blocked: null, window: false, saveMode: null, readFailure: false };
    account.list = { filters: saved.filters.map(wrap), loggingEnabled: true,
      setFilterAt(i, filter) { this.filters[i] = filter; }, insertFilterAt(i, filter) { this.filters.splice(i, 0, filter); },
      removeFilter(filter) { this.filters.splice(this.filters.indexOf(filter), 1); },
      saveToDefaultFile() {
        writes.push(id);
        if (account.saveMode === "before") throw new Error("disk full");
        account.disk = host.snapshotList(this);
        if (account.saveMode === "unrelated") account.disk.filters[0].enabled = true;
        if (account.saveMode === "unreadable") account.readFailure = true;
        if (account.saveMode === "after") throw new Error("reported failure");
      },
    };
    accounts.set(id, account);
  }
  const host = { uuid, accounts: () => [...accounts.keys()],
    account: id => { if (!accounts.has(id)) fail("account-unavailable"); return accounts.get(id); }, reason: a => a.blocked,
    read: a => { if (a.readFailure) fail("read-failed"); return { list: plain(a.disk), bytes: JSON.stringify(a.disk) }; },
    openWindow: a => a.window,
    live: (a, bytes) => { if (JSON.stringify(a.disk) !== bytes) fail("rules-changed-during-inspection"); return a.list; },
    listFilters: list => list.filters, snapshotList: list => ({ loggingEnabled: list.loggingEnabled, filters: list.filters.filter(f => !f.temporary).map(f => plain(f.data)) }),
    build(a, d, mappings, marker) {
      if (a.dependencyFailure) fail("tag-unavailable");
      M.materializeDefinition(d, mappings);
      const raw = { ...rule(d.name), description: M.encodeDescription(d.description), enabled: d.enabled, filterType: d.filterType,
        terms: d.conditionText.split(" OR ").map((text, i) => ({ ...rule("").terms[0], text: text.replace(/^OR \(/u, "").replace(/^\(/u, "").replace(/\)$/u, "") })),
        actions: d.actions.map(action => action.type === "MarkRead" ? { type: 4 } : action.type === "MarkUnread" ? { type: 19 } :
          { type: action.type === "MoveToFolder" ? 1 : 16, targetFolderUri: `mailbox://${mappings[action.slotId].accountId}${mappings[action.slotId].path}` }) };
      if (marker) raw.description = M.appendOwnership(raw.description, marker.groupId, marker.memberId);
      return { raw, filter: wrap(raw) };
    },
    exportRule(raw) { return { definition: { name: raw.name, description: M.parseOwnership(raw.description).description,
      enabled: raw.enabled, filterType: raw.filterType, logic: raw.terms.length === 1 ? "single" : "or",
      conditionText: raw.terms.map(t => `OR (${t.text})`).join(" "), actions: [{ type: "MarkRead" }] }, mappings: {} }; },
    append(a, d, mappings, conditions) { const added = conditions.filter(c => !d.conditionText.includes(`from,${c.op},${c.value})`));
      return { definition: { ...d, logic: added.length ? "or" : d.logic,
        conditionText: d.conditionText + added.map(c => ` OR (from,${c.op},${c.value})`).join("") },
        added: added.map(c => c.value), existing: conditions.filter(c => !added.includes(c)).map(c => c.value) }; },
    folderChoices: () => [],
  };
  const native = scope.createSharedAdapter(M, host, x => x);
  const coordinator = () => scope.createSharedCoordinator({ model: M, storage, native, uuid });
  async function request() {
    const info = (await native.inspectAccounts()).accounts.find(a => a.accountId === "a").filters[0];
    const selector = { kind: "explicit", index: 0, name: info.name, fingerprint: info.fingerprint };
    const read = await native.readRule("a", selector);
    return { definition: read.definition, members: [{ accountId: "a", selector, folderMappings: {} }, { accountId: "b", folderMappings: {} }, { accountId: "c", folderMappings: {} }] };
  }
  async function create() { const c = coordinator(); await c.start(); const p = await c.preview(await request()); if (!p.ok) throw new Error(JSON.stringify(p)); return { c, preview: p }; }
  async function seed() { const { c, preview } = await create(); await c.commit(preview.token); return { c, group: Object.values(c.view().state.groups)[0] }; }
  const mutate = (id, callback) => { const a = accounts.get(id); callback(a.list.filters[0].data); a.disk = host.snapshotList(a.list); };
  return { M, scope, native, host, accounts, writes, storage, store, storageWrites, coordinator, request, create, seed, mutate, rule, wrap, uuid };
}
module.exports = { setup, plain };
