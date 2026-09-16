const { test } = require("node:test");
const assert = require("node:assert/strict");
const { setup, plain } = require("./shared-helpers.cjs");
const { deferred } = require("./helpers.cjs");

test("intent storage failure causes zero native saves and never publishes desired state in memory", async () => {
  const h = setup(), { c, preview } = await h.create(); h.storage.failure = () => true;
  await assert.rejects(c.commit(preview.token));
  assert.deepEqual(h.writes, []); assert.deepEqual(plain(c.view().state.groups), {}); assert.equal(h.store[h.M.STORAGE_KEY], undefined);
});

test("each native-save/checkpoint boundary recovers from durable state without duplicating successful saves", async () => {
  for (const failureAt of [2, 3, 4, 5]) {
    const h = setup(), { c, preview } = await h.create();
    h.storage.failure = (_value, count) => count === failureAt;
    await assert.rejects(c.commit(preview.token));
    const oldWrites = [...h.writes]; h.storage.failure = null;
    const restarted = h.coordinator(), view = await restarted.start();
    assert.equal(Object.values(view.state.groups)[0].operation, null);
    assert.deepEqual(h.writes, ["a", "b", "c"]);
    assert.equal(new Set(oldWrites).size, oldWrites.length);
    for (const a of h.accounts.values()) assert.equal(a.disk.filters.filter(f => f.name === "Letters").length, 1);
  }
});

test("known I/O failure survives restart and read-only scans; explicit retry preserves earlier successes", async () => {
  const h = setup(), { c, preview } = await h.create(); h.accounts.get("b").saveMode = "before";
  await c.commit(preview.token); assert.deepEqual(h.writes, ["a", "b", "c"]);
  const fresh = h.coordinator(); await fresh.start(); await fresh.scan(); await fresh.scan();
  assert.deepEqual(h.writes, ["a", "b", "c"]);
  h.accounts.get("b").saveMode = null;
  const g = Object.values(fresh.view().state.groups)[0]; await fresh.retry(g.id, g.revision);
  assert.deepEqual(h.writes, ["a", "b", "c", "b"]); assert.equal(fresh.view().state.groups[g.id].operation, null);
});

test("startup and explicit retry preflight every member before resuming an earlier pending save", async () => {
  const h = setup(), { c, group } = await h.seed(); h.writes.length = 0;
  const p = await c.preview({ groupId: group.id, revision: group.revision, definition: { ...group.definition, name: "Updated" },
    members: group.members.map(m => ({ accountId: m.accountId, memberId: m.id, folderMappings: m.folderMappings })) });
  const apply = h.native.applyReplica;
  h.native.applyReplica = async () => { throw new Error("crashed-before-first-save"); };
  await assert.rejects(c.commit(p.token), /crashed-before-first-save/u);
  h.native.applyReplica = apply;
  const b = h.accounts.get("b"), copy = b.list.filters.find(f => f.data.name === group.definition.name);
  copy.data.enabled = !copy.data.enabled; b.disk = h.host.snapshotList(b.list);
  const restarted = h.coordinator(), view = await restarted.start();
  assert.deepEqual(h.writes, []); assert.equal(view.state.groups[group.id].operation.targets[1].status, "conflict");
  await restarted.retry(group.id, group.revision + 1); assert.deepEqual(h.writes, []);
});

test("preview expires on desired-state or native drift before any new intent is stored", async () => {
  const h = setup(), { c, preview } = await h.create(); h.mutate("a", r => { r.name = "Changed"; });
  await assert.rejects(c.commit(preview.token), e => e.code === "stale-preview");
  assert.equal(h.storageWrites.length, 0); assert.deepEqual(h.writes, []);
});

test("ordinary and shared writes share one queue, including awaited checkpoint writes", async () => {
  const h = setup(), { c, preview } = await h.create(), gate = deferred();
  const original = h.storage.set; let entered = false;
  h.storage.set = async value => { if (!entered) { entered = true; await gate.promise; } return original(value); };
  const pending = c.commit(preview.token);
  const ordinary = c.exclusive(() => { h.writes.push("ordinary"); });
  await new Promise(setImmediate); assert.deepEqual(h.writes, []);
  gate.resolve(); await Promise.all([pending, ordinary]); assert.deepEqual(h.writes, ["a", "b", "c", "ordinary"]);
});

test("shared sender append counts senders once, keeps duplicate revision and rejects stale queued clicks", async () => {
  const h = setup(), { c, group } = await h.seed();
  const first = c.append(group.id, group.revision, [{ op: "is", value: "new@example.com" }]);
  const stale = c.append(group.id, group.revision, [{ op: "is", value: "late@example.com" }]);
  const result = await first; await assert.rejects(stale, e => e.code === "stale-revision");
  assert.equal(result.added.length, 1); const next = result.state.groups[group.id];
  const duplicate = await c.append(next.id, next.revision, [{ op: "is", value: "new@example.com" }]);
  assert.equal(duplicate.state.groups[group.id].revision, next.revision); assert.equal(duplicate.added.length, 0);
  assert.deepEqual(h.writes, ["a", "b", "c", "a", "b", "c"]);
});

test("native drift blocks ordinary edits; explicit reviewed repair retains the complete intended definition", async () => {
  const h = setup(), { c, group } = await h.seed(); h.mutate("a", r => { r.enabled = true; });
  const result = await c.append(group.id, group.revision, [{ op: "is", value: "new@example.com" }]);
  assert.equal(result.ok, false); assert.deepEqual(h.writes, ["a", "b", "c"]);
  const p = await c.preview({ groupId: group.id, revision: group.revision, resolve: true, definition: group.definition,
    members: group.members.map(m => ({ accountId: m.accountId, memberId: m.id, folderMappings: m.folderMappings })) });
  assert.equal(p.ok, true); await c.commit(p.token); assert.equal(h.accounts.get("a").disk.filters[0].enabled, false);
});

test("explicit stop-sharing resolves an unfinished intent while retaining rules and membership until cleanup saves", async () => {
  const h = setup(), { c, preview } = await h.create(); h.accounts.get("b").saveMode = "before";
  await c.commit(preview.token); const group = c.view().state.groups[preview.group.id];
  // Remove the unavailable creation first through explicit, verified absence.
  await c.forgetUnavailable(group.id, group.revision, group.members[1].id);
  const current = c.view().state.groups[group.id];
  const p = await c.preview({ groupId: current.id, revision: current.revision, resolve: true, definition: current.definition,
    members: current.members.map(m => ({ accountId: m.accountId, memberId: m.id, folderMappings: m.folderMappings, detach: true })) });
  assert.equal(p.ok, true); await c.commit(p.token);
  assert.equal(c.view().state.groups[group.id], undefined);
  assert.equal(h.accounts.get("a").disk.filters[0].name, "Letters");
  assert.equal(h.M.parseOwnership(h.accounts.get("a").disk.filters[0].description).status, "unmarked");
});

test("corrupt storage is preserved and untrusted runtime senders cannot read or mutate groups", async () => {
  const h = setup(); h.store[h.M.STORAGE_KEY] = { schemaVersion: 999, groups: {} };
  const c = h.coordinator(); assert.equal((await c.start()).blocked, "unknown-schema-version");
  assert.equal(h.storageWrites.length, 0);
  const url = "moz-extension://test/options/shared-filters.html", request = { channel: "stf-shared", action: "load" };
  for (const sender of [{ id: "other", url }, { id: "self", url: "https://example.com" }, { id: "self", url: url + "/other" }])
    assert.equal(await c.dispatch(request, sender, url, "self"), undefined);
  const response = await c.dispatch(request, { id: "self", url }, url, "self");
  assert.equal(response.data.blocked, "unknown-schema-version");
});
