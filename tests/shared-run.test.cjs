const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), vm = require("node:vm");
const { setup, plain } = require("./shared-helpers.cjs");
async function fixture() {
  const h = setup(), { group } = await h.seed(), calls = [], folders = new Map();
  for (const a of h.accounts.values()) {
    a.server = { id: a.id }; a.list.folder = { server: a.server };
    folders.set(a.id, { URI: `${a.id}/Inbox`, server: a.server });
  }
  h.host.accountForList = list => [...h.accounts.values()].find(a => a.list === list);
  h.host.snapshot = filter => plain(filter.data);
  h.host.inbox = a => folders.get(a.id);
  h.host.runFolder = folder => { if (!folder) throw new h.M.ModelError("shared-run-folder-unavailable"); return folder; };
  h.host.runFilters = async (folder, filters) => { calls.push(plain({ folder: folder.URI, names: filters.map(f => f.data.name) })); };
  vm.runInContext(fs.readFileSync("api/senderToFilter/shared-run.js", "utf8"), h.scope);
  const runner = h.scope.createSharedRunController(h.M, h.host), a = h.accounts.get("a");
  const selection = { list: a.list, filters: [a.list.filters[0]], folder: { URI: "a/Other", server: a.server }, window: { closed: false } };
  return { ...h, group, groups: [group], runner, calls, folders, selection, control: { cancelled: false } };
}

test("shared manual run uses every linked Inbox and leaves rules and storage unchanged", async () => {
  const h = await fixture(), writes = h.writes.length, storageWrites = h.storageWrites.length;
  const result = await h.runner.run(h.groups, h.selection, h.control);
  assert.equal(result.ok, true); assert.equal(result.completed, 3);
  assert.deepEqual(h.calls, ["a", "b", "c"].map(id => ({ folder: `${id}/Inbox`, names: ["Letters"] })));
  assert.equal(h.writes.length, writes); assert.equal(h.storageWrites.length, storageWrites);
});

test("mixed selections merge once in Inbox order and keep ordinary filters on the chosen folder", async () => {
  for (const inbox of [true, false]) {
    const h = await fixture(); h.selection.filters.push(h.accounts.get("a").list.filters[1]);
    if (inbox) h.selection.folder = h.folders.get("a");
    assert.equal((await h.runner.run(h.groups, h.selection, h.control)).ok, true);
    assert.equal(h.calls.length, inbox ? 3 : 4);
    assert.deepEqual(h.calls[0], { folder: "a/Inbox", names: inbox ? ["Letters", "Other"] : ["Letters"] });
    if (!inbox) assert.deepEqual(h.calls[3], { folder: "a/Other", names: ["Other"] });
  }
});

test("all members are checked before any message action on missing, duplicate, changed or unlinked copies", async () => {
  const cases = [
    [h => h.folders.delete("b"), "shared-run-folder-unavailable"],
    [h => { h.groups = []; }, "shared-run-unknown-link"],
    [h => { h.accounts.get("b").identity.user = "changed"; }, "account-identity-changed"],
    [h => { const a = h.accounts.get("b"); a.list.filters[1].data.enabled = true; a.disk = h.host.snapshotList(a.list); }, "native-drift"],
    [h => { const a = h.accounts.get("b"); a.list.filters.pop(); a.disk = h.host.snapshotList(a.list); }, "missing-replica"],
    [h => { const a = h.accounts.get("b"); a.list.filters.push(h.wrap(a.list.filters[1].data)); a.disk = h.host.snapshotList(a.list); }, "duplicate-marker"],
    [h => { h.selection.filters[0].data.description = " [stf-shared:v2:unknown]"; }, "malformed-marker"],
  ];
  for (const [change, expected] of cases) {
    const h = await fixture(); change(h);
    const result = await h.runner.run(h.groups, h.selection, h.control);
    assert.equal(result.error, expected); assert.deepEqual(h.calls, []);
  }
});

test("manual run stops after a failure or cancellation without retrying or starting later accounts", async () => {
  for (const mode of ["failure", "cancel", "drift"]) {
    const h = await fixture(), original = h.host.runFilters;
    h.host.runFilters = async (...args) => {
      await original(...args);
      if (mode === "failure" && h.calls.length === 2) throw new h.M.ModelError("shared-run-filtering-failed");
      if (mode === "cancel") h.control.cancelled = true;
      if (mode === "drift") h.accounts.get("b").identity.user = "changed";
    };
    const result = await h.runner.run(h.groups, h.selection, h.control);
    assert.equal(result.ok, false); assert.equal(h.calls.length, mode === "failure" ? 2 : 1);
    assert.equal(result.completed, mode === "cancel" ? 0 : 1);
    assert.equal(result.error, mode === "failure" ? "shared-run-filtering-failed" : mode === "cancel" ? "shared-run-cancelled" : "account-identity-changed");
  }
});
