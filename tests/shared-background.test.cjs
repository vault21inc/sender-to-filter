const { test } = require("node:test");
const assert = require("node:assert/strict");
const { background, message, plain, deferred } = require("./helpers.cjs");
function fixture(overrides = {}) {
  const calls = [], row = { id: "group", revision: 7, name: "Shared & newsletters", count: 2, enabled: true,
    eligible: true, present: "all", pending: false };
  const shared = { start: async () => {}, scan: async () => ({ state: { groups: {} } }),
    view: () => ({ state: { groups: { group: {} } }, blocked: null }), menu: async () => [row],
    exclusive: async fn => { calls.push("ordinary-queued"); return fn(); },
    append: async (...args) => { calls.push(plain(args)); return { added: ["new@example.com"], existing: [],
      observations: { group: [{ status: "applied" }, { status: "failed" }] } }; }, ...overrides };
  return { app: background({ shared, listFilters: async () => [
    { index: 0, name: "Owned", reason: "managed-target", eligible: false, enabled: true, present: "none" },
    { index: 1, name: "Unshared", eligible: true, enabled: true, present: "none" },
  ] }), row, calls };
}
test("mixed-account selection offers one shared destination and disables the ordinary route", async () => {
  const { app, calls } = fixture(); await app.shown([message("new@example.com", "a"), message("new@example.com", "b")]);
  assert.equal(app.calls.lists.length, 0); assert.equal(app.row("stf-account-").enabled, false);
  assert.equal(app.row("stf-shared-").title, "Shared filters");
  const sharedRow = [...app.items.values()].find(r => /^stf-shared-\d+-0$/.test(r.id));
  assert.equal(sharedRow.checked, true); assert.match(sharedRow.title, /2 accounts/); assert.match(sharedRow.title, /&&/);
  await app.click(sharedRow.id); assert.deepEqual(calls[0], ["group", 7, [{ op: "is", value: "new@example.com" }]]);
  assert.match(app.calls.notifications[0].message, /1 of 2/);
});
test("owned copies are absent from ordinary rows and unshared saves use the global queue", async () => {
  const { app, calls } = fixture(); await app.shown([message()]);
  assert.equal([...app.items.values()].some(r => r.title === "Owned"), false);
  await app.click(app.row("stf-filter-").id); assert.equal(calls[0], "ordinary-queued"); assert.equal(app.calls.adds.length, 1);
  await app.click(app.row("stf-sharedmanage-").id); assert.equal(app.calls.options, 1);
});
test("partial shared groups are unchecked and unsupported AND/ALL rows cannot be clicked", async () => {
  const { app, row, calls } = fixture(); row.present = "none"; row.pending = true; row.eligible = false; row.reason = "sender-logic-unsupported";
  await app.shown([message()]); const sharedRow = [...app.items.values()].find(r => /^stf-shared-\d+-0$/.test(r.id));
  assert.equal(sharedRow.checked, false); assert.equal(sharedRow.enabled, false); await app.click(sharedRow.id); assert.equal(calls.length, 0);
});
test("shared rows retain generation/window validation and survive click-after-hide", async () => {
  const { app, calls } = fixture(); await app.shown([message()]); const first = [...app.items.values()].find(r => /^stf-shared-\d+-0$/.test(r.id));
  await app.shown([message("second@example.com")]); await app.click(first.id); assert.equal(calls.length, 0);
  const current = [...app.items.values()].find(r => /^stf-shared-\d+-0$/.test(r.id));
  await app.click(current.id, {}, { id: 7, windowId: 43 }); assert.equal(calls.length, 0);
  app.hide(); await app.click(current.id); assert.equal(calls.length, 1);
});
test("shared destinations never relax external-message and selection-size limits", async () => {
  const { app, calls } = fixture(); await app.shown([{ author: "new@example.com", folder: {} }]);
  assert.match(app.row("stf-problem-").title, /stored in an account/);
  await app.shown(Array.from({ length: 101 }, () => message())); assert.equal(app.calls.lists.length, 0); assert.equal(calls.length, 0);
});
