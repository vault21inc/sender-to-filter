const { test } = require("node:test");
const assert = require("node:assert/strict");
const { background, message, deferred, tick } = require("./helpers.cjs");

test("invalid selection gives a visible reason; next valid selection re-enables menu", async () => {
  const h = background();
  await h.shown([message("bad address")]);
  assert.equal(h.items.get("stf-root").enabled, false);
  assert.match(h.items.get("stf-root").title, /No usable sender/);
  await h.shown([message()]);
  assert.equal(h.items.get("stf-root").enabled, true);
  await h.click(h.row("stf-filter-").id);
  assert.equal(h.calls.adds.length, 1);
  assert.equal(h.calls.notifications.length, 1);
});

test("mailbox parsing is awaited; invalid entries and duplicate senders are removed", async () => {
  const h = background({ parse: async () => [{ name: "Missing" }, { email: "NEW@example.com" },
    { email: "new@example.com" }, { email: "@bad" }, { email: "other@example.com" }] });
  await h.shown([message()]);
  assert.equal(h.calls.lists[0].conditions.length, 2);
  assert.match(h.row("stf-header-").title, /2 senders/);
  assert.match(h.row("stf-new-").title, /first sender only/);
});

test("mixed accounts and external messages never request or modify filters", async () => {
  const h = background();
  await h.shown([message(), message("b@example.com", "account2")]);
  assert.match(h.items.get("stf-root").title, /one account/);
  await h.shown([{ author: "external@example.com" }]);
  assert.match(h.items.get("stf-root").title, /account folder/);
  assert.equal(h.calls.lists.length, 0);
  assert.equal(h.calls.adds.length, 0);
});

test("101 messages are rejected and unfinished pagination is released", async () => {
  const h = background({ continueList: async () => ({ id: "remaining", messages: [message()] }) });
  await h.shown(Array.from({ length: 100 }, () => message()), undefined, "page1");
  assert.match(h.items.get("stf-root").title, /More than 100/);
  assert.deepEqual(h.calls.aborts, ["remaining"]);
  assert.equal(h.calls.lists.length, 0);
});

test("exactly 100 messages followed by an empty final page are accepted", async () => {
  const h = background();
  await h.shown(Array.from({ length: 100 }, () => message()), undefined, "lastPage");
  assert.equal(h.items.get("stf-root").enabled, true);
  assert.equal(h.calls.lists.length, 1);
  assert.equal(h.calls.aborts.length, 0);
});

test("domain toggle is persisted and deduplicates the next menu's domain values", async () => {
  const h = background();
  await h.shown([message()]);
  await h.click(h.row("stf-domain-").id, { checked: true });
  assert.equal(h.storage.domainMode, true);
  await h.shown([message(), message("b@example.com")]);
  assert.deepEqual(h.calls.lists.at(-1).conditions, [{ op: "contains", value: "@example.com" }]);
  assert.equal(h.row("stf-domain-").checked, true);
  const restarted = background({ storage: h.storage });
  await restarted.shown([message()]);
  assert.equal(restarted.calls.lists[0].conditions[0].op, "contains");
});

test("an old list completion cannot replace a newer menu or accept its old click", async () => {
  const pending = deferred();
  const started = deferred();
  const h = background({ listFilters: async (_, conditions) => {
    if (conditions[0].value === "a@example.com") { started.resolve(); await pending.promise; }
    return [{ index: 0, name: conditions[0].value, enabled: true, eligible: true, present: "none" }];
  } });
  const first = h.shown([message("a@example.com")]);
  await started.promise;
  h.hide();
  await h.shown([message("b@example.com")]);
  pending.resolve();
  await first;
  assert.equal(h.row("stf-filter-").title, "b@example.com");
  await h.click("stf-filter-1-0");
  assert.equal(h.calls.adds.length, 0);
  await h.click(h.row("stf-filter-").id);
  assert.equal(h.calls.adds[0].conditions[0].value, "b@example.com");
});

test("a menu build superseded while creating rows leaves no orphan or stale rows", async () => {
  const pending = deferred();
  const started = deferred();
  let delayOnce = true;
  const h = background({ create: async props => {
    if (delayOnce && props.id.startsWith("stf-filter-")) {
      delayOnce = false; started.resolve(); await pending.promise;
    }
  } });
  const first = h.shown([message("a@example.com")]);
  await started.promise;
  const second = h.shown([message("b@example.com")]);
  pending.resolve();
  await Promise.all([first, second]);
  assert.equal([...h.items.keys()].some(id => /^stf-filter-1-/.test(id)), false);
  assert.equal([...h.items.keys()].filter(id => id.startsWith("stf-filter-")).length, 1);
  await h.click(h.row("stf-filter-").id);
  assert.equal(h.calls.adds[0].conditions[0].value, "b@example.com");
});

test("hide cancels a pending build but preserves a completed snapshot for click-after-hide", async () => {
  const pending = deferred();
  const started = deferred();
  const h = background({ listFilters: async () => { started.resolve(); return pending.promise; } });
  const building = h.shown([message()]);
  await started.promise;
  h.hide();
  pending.resolve([]);
  await building;
  await tick();
  assert.equal(h.items.get("stf-root").enabled, false);
  assert.equal(h.row("stf-new-"), undefined);
  const completed = background();
  await completed.shown([message()]);
  const id = completed.row("stf-filter-").id;
  completed.hide();
  await completed.click(id);
  assert.equal(completed.calls.adds.length, 1);
});

test("stale action IDs and clicks from another window are ignored", async () => {
  const h = background();
  await h.shown([message()]);
  const old = h.row("stf-manage-").id;
  await h.shown([message("b@example.com")]);
  await h.click(old);
  await h.click(h.row("stf-manage-").id, {}, { id: 8, windowId: 99 });
  assert.equal(h.calls.manage.length, 0);
  await h.click(h.row("stf-manage-").id);
  assert.equal(h.calls.manage[0][0], 42);
});

test("an in-flight batch keeps its own target while another menu is shown", async () => {
  const pending = deferred();
  const h = background({ addConditions: async () => pending.promise });
  await h.shown([message("a@example.com")]);
  const clicking = h.click(h.row("stf-filter-").id);
  await h.shown([message("b@example.com", "account2")]);
  pending.resolve({ status: "ok", added: ["a@example.com"], existing: [] });
  await clicking;
  assert.equal(h.calls.adds[0].folder.accountId, "account1");
  assert.equal(h.calls.adds[0].conditions[0].value, "a@example.com");
  assert.equal(h.calls.notifications.length, 1);
});

test("unsupported rows cannot be activated; partial and disabled labels are accurate", async () => {
  const h = background({ listFilters: async () => [
    { index: 0, name: "A & B", enabled: false, eligible: true, present: "some" },
    { index: 1, name: "ALL", enabled: true, eligible: false, reason: "match-all", present: "none" },
  ] });
  await h.shown([message()]);
  assert.match(h.row("stf-filter-").title, /A && B.*some already present.*disabled/);
  const blocked = [...h.items.values()].find(item => item.title?.startsWith("ALL"));
  assert.equal(blocked.enabled, false);
  await h.click(blocked.id);
  assert.equal(h.calls.adds.length, 0);
});

test("accounts without filters retain working new and manage routes", async () => {
  const h = background({ listFilters: async () => [] });
  await h.shown([message()]);
  assert.equal(h.items.get("stf-root").enabled, true);
  await h.click(h.row("stf-new-").id);
  await h.click(h.row("stf-manage-").id);
  assert.equal(h.calls.new[0][2], "new@example.com");
  assert.equal(h.calls.manage.length, 1);
});

test("menu creation errors do not poison subsequent menu updates", async () => {
  let failOnce = true;
  const h = background({ create: props => {
    if (failOnce && props.id.startsWith("stf-filter-")) { failOnce = false; throw new Error("Injected menu error"); }
  } });
  await h.shown([message()]);
  assert.equal(h.items.get("stf-root").enabled, false);
  await h.shown([message()]);
  assert.equal(h.items.get("stf-root").enabled, true);
  await h.click(h.row("stf-filter-").id);
  assert.equal(h.calls.adds.length, 1);
});
