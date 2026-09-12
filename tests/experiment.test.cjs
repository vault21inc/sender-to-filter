const { test } = require("node:test");
const assert = require("node:assert/strict");
const { term, filter, experiment, plain } = require("./helpers.cjs");

const folder = { accountId: "account1", path: "/Inbox" };
const target = { index: 0, name: "Newsletters" };
const condition = (value = "new@example.com", op = "is") => ({ op, value });

test("one batch preserves all original terms, actions, execution types and disabled state", async () => {
  const old = term("old@example.com", { booleanAnd: true });
  const f = filter("Newsletters", [old], { enabled: false });
  const actions = f.actions;
  const h = experiment([f]);
  const result = await h.api.addConditions(folder, target, [condition(), condition("NEW@example.com"), condition("old@example.com")]);
  assert.deepEqual(plain(result), { status: "ok", added: ["new@example.com"], existing: ["old@example.com"] });
  assert.equal(h.list.saves, 1);
  assert.equal(f.searchTerms.length, 2);
  assert.equal(f.searchTerms[0], old);
  assert.equal(old.booleanAnd, true);
  assert.equal(f.searchTerms[1].booleanAnd, false);
  assert.equal(f.searchTerms[1].op, 0);
  assert.equal(f.actions, actions);
  assert.equal(f.enabled, false);
  assert.equal(f.filterType, 17);
});

test("duplicate batches never save and operator identity matters", async () => {
  const f = filter("Newsletters", [term("old@example.com", { op: 1 })]);
  const h = experiment([f]);
  assert.equal((await h.api.addConditions(folder, target, [condition("old@example.com")])).added.length, 1);
  const firstSaveCount = h.list.saves;
  const result = await h.api.addConditions(folder, target, [condition("OLD@example.com")]);
  assert.deepEqual(plain(result.existing), ["old@example.com"]);
  assert.deepEqual(plain(result.added), []);
  assert.equal(h.list.saves, firstSaveCount);
});

test("eligibility is checked on both listing and writing", async t => {
  const cases = [
    ["temporary", () => filter("Newsletters", [term()], { temporary: true })],
    ["unparseable", () => filter("Newsletters", [], { unparseable: true })],
    ["no-terms", () => filter("Newsletters", [])],
    ["match-all", () => filter("Newsletters", [term("", { matchAll: true })])],
    ["grouped", () => filter("Newsletters", [term("old@example.com", { beginsGrouping: true })])],
    ["and-logic", () => filter("Newsletters", [term(), term("other@example.com", { booleanAnd: true })])],
    ["and-logic", () => filter("Newsletters", [term(), term("b@example.com"), term("c@example.com", { booleanAnd: true })])],
    ["duplicate-name", () => filter()],
  ];
  for (const [reason, create] of cases) await t.test(reason, async () => {
    const h = experiment([create()]);
    if (reason === "duplicate-name") h.list.filters.push(filter());
    const info = await h.api.listFilters(folder, [condition()]);
    assert.equal(info[0].eligible, false);
    assert.equal(info[0].reason, reason);
    const result = await h.api.addConditions(folder, target, [condition()]);
    assert.equal(result.status, "ineligible");
    assert.equal(result.reason, reason);
    assert.equal(h.list.saves, 0);
    assert.equal(h.filters[0].appends, 0);
  });
});

test("present distinguishes all, some, none and an empty query", async () => {
  const h = experiment();
  assert.equal((await h.api.listFilters(folder, [condition("old@example.com")]))[0].present, "all");
  assert.equal((await h.api.listFilters(folder, [condition("old@example.com"), condition()]))[0].present, "some");
  assert.equal((await h.api.listFilters(folder, [condition()]))[0].present, "none");
  assert.equal((await h.api.listFilters(folder, []))[0].present, "none");
});

test("save failure restores native term references; retry adds and saves exactly once", async () => {
  const h = experiment();
  const f = h.filters[0];
  const original = f.searchTerms;
  h.list.failure = new Error("Unwritable destination");
  const failed = await h.api.addConditions(folder, target, [condition(), condition("third@example.com")]);
  assert.equal(failed.status, "error");
  assert.deepEqual(plain(failed.added), []);
  assert.equal(f.searchTerms.length, original.length);
  assert.equal(f.searchTerms[0], original[0]);
  assert.equal(f.restores, 1);
  assert.equal((await h.api.listFilters(folder, [condition()]))[0].present, "none");
  h.list.failure = null;
  assert.equal((await h.api.addConditions(folder, target, [condition()])).status, "ok");
  assert.equal(f.searchTerms.length, 2);
});

test("a failure halfway through append also rolls back", async () => {
  const h = experiment();
  const f = h.filters[0];
  const original = f.searchTerms[0];
  const append = f.appendTerm;
  f.appendTerm = function (value) {
    append.call(this, value);
    if (this.appends === 2) throw new Error("Injected append failure");
  };
  const result = await h.api.addConditions(folder, target, [condition(), condition("third@example.com")]);
  assert.equal(result.status, "error");
  assert.equal(f.searchTerms.length, 1);
  assert.equal(f.searchTerms[0], original);
  assert.equal(h.list.saves, 0);
});

test("invalid and empty values cannot create universal or malformed conditions", async () => {
  for (const input of [condition(""), condition("@"), condition("a@invalid"), condition("a@example.com", "bogus"),
    condition("@example.com.evil", "is"), condition("a@example.com", "contains"), condition("a\nb@example.com")]) {
    const h = experiment();
    assert.equal((await h.api.addConditions(folder, target, [input])).status, "error");
    assert.equal(h.list.saves, 0);
    assert.equal(h.filters[0].appends, 0);
  }
  const h = experiment();
  const result = await h.api.addConditions(folder, target, [condition("@Example.com", "contains"), condition("@example.com", "contains")]);
  assert.equal(result.added.length, 1);
  assert.equal(h.filters[0].searchTerms[1].op, 1);
});

test("a moved unique name is resolved; deleted and newly ineligible targets are refused", async () => {
  const h = experiment();
  h.list.filters.unshift(filter("Another"));
  assert.equal((await h.api.addConditions(folder, target, [condition()])).status, "ok");
  assert.equal(h.list.filters[0].searchTerms.length, 1);
  h.list.filters[1].temporary = true;
  assert.equal((await h.api.addConditions(folder, target, [condition("third@example.com")])).status, "ineligible");
  h.list.filters.pop();
  assert.equal((await h.api.addConditions(folder, target, [condition()])).status, "not-found");
});

test("dialog methods use the explicitly invoking window and fail for a closed window", async () => {
  const h = experiment();
  await h.api.openNewFilter(42, folder, "NEW@example.com");
  await h.api.openFilterManager(42, folder);
  assert.deepEqual(h.dialogs.map(args => args[0]), ["new@example.com", undefined]);
  assert.equal(h.dialogs[0][1], h.nativeFolder);
  await assert.rejects(h.api.openFilterManager(99, folder), /window is no longer available/);
});
