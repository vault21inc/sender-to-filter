const { test } = require("node:test");
const assert = require("node:assert/strict");
const { setup, plain } = require("./shared-helpers.cjs");
const { experiment, filter } = require("./helpers.cjs");

test("native adapter preview is read-only and blocks all targets when a known dependency fails", async () => {
  const h = setup(), request = await h.request();
  h.accounts.get("b").dependencyFailure = true;
  const p = await h.native.prepareSharedChange({ previous: null, ...request, kind: "create", reviewed: false });
  assert.equal(p.ok, false); assert.equal(p.problems[0].code, "tag-unavailable"); assert.deepEqual(h.writes, []);
});

test("native adapter detects live edits, account replacement, open windows and aliasing before writing", async () => {
  for (const change of [h => { h.accounts.get("b").list.filters[0].data.enabled = true; },
    h => { h.accounts.get("b").window = true; }, h => { h.accounts.get("b").physicalKey = "a"; }]) {
    const h = setup(), request = await h.request(); change(h);
    const p = await h.native.prepareSharedChange({ previous: null, ...request, kind: "create", reviewed: false });
    assert.equal(p.ok, false); assert.deepEqual(h.writes, []);
  }
  const h = setup(), { c, group } = await h.seed();
  h.accounts.get("a").identity.host = "different.invalid";
  assert.equal((await c.scan()).observations[group.id][0].reason, "account-identity-changed");
});

test("account replacement after asynchronous inspection is refused at the final synchronous check", async () => {
  const h = setup(), { preview } = await h.create(), build = h.host.build;
  h.host.build = (...args) => {
    const built = build(...args), old = h.accounts.get("a");
    h.accounts.set("a", { ...old, identity: { ...old.identity, host: "replacement.invalid" } });
    return built;
  };
  const result = await h.native.applyReplica(preview.group, preview.group.members[0].id);
  assert.equal(result.status, "conflict"); assert.equal(result.errorCode, "account-identity-changed"); assert.deepEqual(h.writes, []);
});

test("native apply retains unrelated rules, logging, temporary objects, position and independent copies", async () => {
  const h = setup(), { c, preview } = await h.create();
  const temp = h.wrap({ ...h.rule("temporary"), temporary: true }); h.accounts.get("a").list.filters.splice(1, 0, temp);
  const unrelated = h.accounts.get("a").list.filters[2];
  await c.commit(preview.token);
  assert.equal(h.accounts.get("a").list.filters[1], temp); assert.equal(h.accounts.get("a").list.filters[2], unrelated);
  assert.equal(h.accounts.get("a").disk.loggingEnabled, true);
  assert.notEqual(h.accounts.get("a").list.filters[0].data.terms[0], h.accounts.get("b").list.filters[1].data.terms[0]);
});

test("native apply restores original reference on failed save and recognizes saved-after errors", async () => {
  for (const mode of ["before", "after"]) {
    const h = setup(), { c, preview } = await h.create(), original = h.accounts.get("a").list.filters[0];
    h.accounts.get("a").saveMode = mode;
    const view = await c.commit(preview.token), g = view.state.groups[preview.group.id];
    if (mode === "before") { assert.equal(h.accounts.get("a").list.filters[0], original); assert.equal(g.operation.targets[0].status, "failed"); }
    else { assert.equal(g.operation, null); assert.equal(g.lastCompleted.diagnostics[0].errorCode, "save-reported-error"); }
  }
});

test("uncertain persistence stops later accounts and does not claim a disk rollback", async () => {
  for (const mode of ["unreadable", "unrelated"]) {
    const h = setup(), { c, preview } = await h.create(); h.accounts.get("a").saveMode = mode;
    const view = await c.commit(preview.token);
    assert.equal(view.state.groups[preview.group.id].operation.targets[0].status, "uncertain");
    assert.deepEqual(h.writes, ["a"]);
  }
});

test("managed sender bypass is rejected even through a stale ordinary target", async () => {
  for (const desc of [" [stf-shared:v1:bad]", " [STF-SHARED:v2:unknown]"]) {
    const h = experiment([filter("Owned", undefined, { filterDesc: desc })]);
    assert.equal((await h.api.listFilters({ accountId: "a", path: "/" }, []) )[0].reason, "managed-target");
    const result = await h.api.addConditions({ accountId: "a", path: "/" }, { index: 0, name: "Owned" }, [{ op: "is", value: "new@example.com" }]);
    assert.equal(result.reason, "managed-target"); assert.equal(h.list.saves, 0);
  }
});

test("missing managed replicas are conflicts, and unrelated list changes preserve their new order on retry", async () => {
  const h = setup(), { c, preview } = await h.create(); h.accounts.get("b").saveMode = "before";
  await c.commit(preview.token); let g = c.view().state.groups[preview.group.id];
  const a = h.accounts.get("b"); a.saveMode = null;
  a.list.filters.unshift(h.wrap(h.rule("Inserted"))); a.disk = h.host.snapshotList(a.list);
  await c.retry(g.id, g.revision); g = c.view().state.groups[g.id];
  assert.equal(g.operation, null); assert.equal(a.disk.filters[0].name, "Inserted");
  h.accounts.get("a").list.filters.shift(); h.accounts.get("a").disk = h.host.snapshotList(h.accounts.get("a").list);
  assert.equal((await c.scan()).observations[g.id][0].reason, "missing-replica");
});

test("duplicate ownership requires an explicit preview and preserves other copies as independent rules", async () => {
  for (const detach of [false, true]) {
    const h = setup(), { c, group } = await h.seed(), a = h.accounts.get("a");
    const duplicate = h.wrap(a.list.filters[0].data);
    a.list.filters.push(duplicate); a.disk = h.host.snapshotList(a.list);
    const observed = await c.scan(); assert.equal(observed.observations[group.id][0].reason, "duplicate-marker");
    const members = group.members.map(m => ({ accountId: m.accountId, memberId: m.id, folderMappings: m.folderMappings }));
    const rejected = await c.preview({ groupId: group.id, revision: group.revision, resolve: true, definition: group.definition, members });
    assert.equal(rejected.ok, false);
    const catalog = await h.native.inspectAccounts(), selected = catalog.accounts[0].filters[0];
    members[0].selector = { kind: "explicit", index: selected.index, name: selected.name, fingerprint: selected.fingerprint };
    members[0].detach = detach;
    const p = await c.preview({ groupId: group.id, revision: group.revision, resolve: true, definition: group.definition, members });
    assert.equal(p.ok, true); assert.equal(p.group.operation.targets[0].cleanup.length, 1);
    const before = plain(a.disk), writes = h.writes.length;
    a.saveMode = "before"; await c.commit(p.token);
    assert.deepEqual(a.disk, before); assert.equal(h.M.parseOwnership(duplicate.filterDesc).status, "marked");
    a.saveMode = null;
    const current = c.view().state.groups[group.id];
    // Simulate a crash after the native save, before its checkpoint.
    let once = true; h.storage.failure = () => { if (once) { once = false; return true; } return false; };
    await assert.rejects(c.retry(current.id, current.revision), /quota/u);
    const savedWrites = h.writes.length;
    h.storage.failure = null;
    const restarted = h.coordinator(), view = await restarted.start();
    assert.equal(view.state.groups[group.id].operation, null);
    assert.equal(h.writes.length, savedWrites); assert.ok(savedWrites > writes);
    assert.equal(a.disk.filters.length, before.filters.length);
    assert.equal(h.M.parseOwnership(duplicate.filterDesc).status, "unmarked");
    assert.deepEqual({ ...a.disk.filters[2], description: before.filters[2].description }, before.filters[2]);
    assert.equal(a.disk.filters.filter(r => h.M.parseOwnership(r.description).status === "marked").length, detach ? 0 : 1);
  }
});

test("duplicate cleanup refuses changed copies between preview and commit", async () => {
  const h = setup(), { c, group } = await h.seed(), a = h.accounts.get("a");
  a.list.filters.push(h.wrap(a.list.filters[0].data)); a.disk = h.host.snapshotList(a.list);
  const f = (await h.native.inspectAccounts()).accounts[0].filters[0];
  const p = await c.preview({ groupId: group.id, revision: group.revision, resolve: true, definition: group.definition,
    members: group.members.map((m, i) => ({ accountId: m.accountId, memberId: m.id, folderMappings: m.folderMappings,
      ...(i ? {} : { selector: { kind: "explicit", index: f.index, name: f.name, fingerprint: f.fingerprint } }) })) });
  assert.equal(p.ok, true);
  a.list.filters[2].data.enabled = !a.list.filters[2].data.enabled; a.disk = h.host.snapshotList(a.list);
  const writes = h.writes.length;
  await assert.rejects(c.commit(p.token), /stale-preview/u); assert.equal(h.writes.length, writes);
});
