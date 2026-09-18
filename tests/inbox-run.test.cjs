const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), vm = require("node:vm");
const { deferred, background } = require("./helpers.cjs");

function fixture(overrides = {}) {
  const applied = [], prepared = [], validated = [];
  const accounts = ["one", "two", "three"].map(id => ({ id, name: id, server: { type: "pop3" } }));
  const host = {
    accounts: () => accounts,
    prepare(account) { prepared.push(account.id); return { account, folder: { URI: account.id }, filters: [account.id] }; },
    validate(job) { validated.push(job.account.id); },
    async apply(job) { applied.push(job.account.id); },
    ...overrides,
  };
  const scope = {}; vm.runInNewContext(fs.readFileSync("api/senderToFilter/inbox-run.js", "utf8"), scope);
  return { host, accounts, applied, prepared, validated, runner: scope.createInboxRunController(host), scope };
}

test("all-Inboxes run preflights every account and applies one at a time in account order", async () => {
  const h = fixture(), gate = deferred(), progress = [];
  h.host.apply = async job => {
    if (!h.applied.length) { assert.deepEqual(h.prepared, ["one", "two", "three"]); await gate.promise; }
    h.applied.push(job.account.id);
  };
  const run = h.runner.run({ progress: value => progress.push(value.accountName) });
  assert.deepEqual(progress, ["one"]); assert.deepEqual(h.applied, []);
  gate.resolve(); const result = await run;
  assert.equal(result.ok, true); assert.equal(result.completed, 3);
  assert.deepEqual(h.applied, ["one", "two", "three"]);
});

test("preflight errors and duplicate Inbox targets prevent every message action", async () => {
  for (const duplicate of [false, true]) {
    const h = fixture(); h.host.prepare = account => {
      if (!duplicate && account.id === "three") throw new Error("inbox-unavailable");
      return { account, folder: { URI: duplicate ? "same" : account.id } };
    };
    const result = await h.runner.run({});
    assert.equal(result.ok, false); assert.equal(result.attempted, 0); assert.deepEqual(h.applied, []);
    assert.equal(result.error, duplicate ? "duplicate-inbox" : "inbox-unavailable");
  }
});

test("Stop finishes the active Inbox then prevents later accounts and never retries", async () => {
  const h = fixture(), gate = deferred(), control = {};
  h.host.apply = async job => { h.applied.push(job.account.id); await gate.promise; };
  const run = h.runner.run(control); control.cancelled = true; gate.resolve();
  const result = await run;
  assert.equal(result.error, "cancelled"); assert.equal(result.completed, 1); assert.equal(result.attempted, 1);
  assert.deepEqual(h.applied, ["one"]);
});

test("native failures report partial work and do not run later Inboxes", async () => {
  const h = fixture(); h.host.apply = async job => {
    h.applied.push(job.account.id); if (job.account.id === "two") throw new Error("filtering-failed");
  };
  const result = await h.runner.run({});
  assert.equal(result.ok, false); assert.equal(result.completed, 1); assert.equal(result.attempted, 2);
  assert.equal(result.accountName, "two"); assert.deepEqual(h.applied, ["one", "two"]);
});

test("empty accounts are skipped; cancellation before execution processes nothing", async () => {
  const h = fixture({ prepare: () => null }); const result = await h.runner.run({});
  assert.equal(result.ok, true); assert.equal(result.completed, 0); assert.deepEqual(h.applied, []);
  const cancelled = fixture(); assert.equal((await cancelled.runner.run({ cancelled: true })).error, "cancelled");
  assert.deepEqual(cancelled.prepared, []);
});

test("changed later accounts are rejected before they run", async () => {
  const h = fixture(); h.host.validate = job => {
    if (h.applied.length && job.account.id === "two") throw new Error("account-changed");
  };
  const result = await h.runner.run({});
  assert.equal(result.error, "account-changed"); assert.equal(result.completed, 1); assert.equal(result.attempted, 1);
  assert.deepEqual(h.applied, ["one"]);
});

test("Inbox runs hold the coordinator queue and cancel failed dispatches", async () => {
  const calls = [], cancelled = []; let locked = false, fail = false;
  const app = background({ shared: { start: async () => {}, exclusive: async fn => {
    if (fail) throw new Error("queue failed"); locked = true; try { return await fn(); } finally { locked = false; }
  } }, runInboxFilters: async id => { assert.equal(locked, true); calls.push(id); },
  cancelInboxRun: async id => cancelled.push(id) });
  await app.requestInboxRun("first"); fail = true; await app.requestInboxRun("second");
  assert.deepEqual(calls, ["first"]); assert.deepEqual(cancelled, ["second"]);
});

test("native host uses each account's enabled manual rules in order without expanding shared markers", async () => {
  const { scope } = fixture();
  const manual = { filterName: "manual", enabled: true, filterType: 16 };
  const shared = { filterName: "shared", enabled: true, filterType: 17, filterDesc: " [stf-shared:fixture]" };
  const rules = [manual, { enabled: false, filterType: 16 }, { enabled: true, filterType: 1 },
    shared, { enabled: true, filterType: 16, temporary: true }, { enabled: true, filterType: 16, unparseable: true }];
  const list = { filterCount: rules.length, getFilterAt: i => rules[i], loggingEnabled: true, logStream: {} };
  const server = { type: "imap", prettyName: "Test", getFilterList: () => list };
  const inbox = { URI: "test-inbox", server, flags: 0, canFileMessages: true };
  server.rootFolder = server.rootMsgFolder = { getFolderWithFlags: () => inbox };
  const native = { key: "account1", incomingServer: server }, inserted = [], calls = [];
  const temp = { insertFilterAt: (i, filter) => inserted.splice(i, 0, filter) };
  scope.ChromeUtils = { importESModule: () => ({ MailServices: {
    accounts: { accounts: [native, { key: "local", incomingServer: { type: "none" } }], getAccount: () => native },
    filters: { getTempFilterList: folder => { assert.equal(folder, inbox); return temp; },
      applyFiltersToFolders: (list, folders, win, listener) => { calls.push({ list, folders, win }); listener.onStopOperation(0); } },
  } }) };
  scope.Ci = { nsMsgFilterType: { Manual: 16 }, nsMsgFolderFlags: { Inbox: 4096, Virtual: 32 }, nsIMsgWindow: {} };
  scope.Cc = { "@mozilla.org/messenger/msgwindow;1": { createInstance: () => ({ dedicated: true }) } };
  scope.Services = { wm: { getEnumerator: () => [] } };
  const host = scope.createInboxRunHost(), accounts = host.accounts();
  assert.equal(accounts.length, 1); const job = host.prepare(accounts[0]);
  assert.deepEqual(Array.from(job.filters), [manual, shared]); host.validate(job); await host.apply(job);
  assert.deepEqual(inserted, [manual, shared]); assert.equal(calls.length, 1);
  assert.equal(calls[0].folders[0], inbox); assert.equal(temp.logStream, list.logStream);
  manual.enabled = false; assert.throws(() => host.validate(job), /filters-changed/);
});

function readFixture() {
  const { scope } = fixture(), calls = [];
  const accounts = ["imap", "pop3", "imap", "none", "rss", "nntp"].map((type, i) => {
    const server = { type, prettyName: `Account ${i}`, getFilterList() { throw new Error("Mark read must not consult filters"); } };
    const inbox = { URI: `inbox-${i}`, server, flags: 4096, canFileMessages: true,
      markAllMessagesRead(win) { assert.equal(win.dedicated, true); calls.push(i); } };
    server.rootFolder = server.rootMsgFolder = { getFolderWithFlags: flag => {
      assert.equal(flag, 4096); return inbox;
    } };
    return { key: String(i), incomingServer: server, inbox };
  });
  scope.ChromeUtils = { importESModule: () => ({ MailServices: {
    accounts: { accounts, getAccount: id => accounts.find(a => a.key === id) },
  } }) };
  scope.Ci = { nsMsgFolderFlags: { Inbox: 4096, Virtual: 32 }, nsIMsgWindow: {} };
  scope.Cc = { "@mozilla.org/messenger/msgwindow;1": { createInstance: () => ({ dedicated: true }) } };
  const host = scope.createInboxReadHost();
  return { accounts, calls, host, runner: scope.createInboxRunController(host) };
}

test("native mark-read targets every IMAP/POP Inbox regardless of filters and never targets other account types", async () => {
  const h = readFixture(), result = await h.runner.run({});
  assert.equal(result.ok, true); assert.equal(result.completed, 3); assert.deepEqual(h.calls, [0, 1, 2]);
});

test("mark-read preflight rejects missing, virtual, deferred and changed Inboxes before any read changes", async () => {
  for (const problem of ["missing", "virtual", "deferred", "changed"]) {
    const h = readFixture(), account = h.accounts[2];
    if (problem === "missing") account.incomingServer.rootFolder.getFolderWithFlags = () => null;
    if (problem === "virtual") account.inbox.flags |= 32;
    if (problem === "deferred") account.incomingServer.rootMsgFolder = {};
    if (problem === "changed") {
      const prepare = h.host.prepare;
      h.host.prepare = a => { const job = prepare(a); if (a.id === "2") account.incomingServer = {}; return job; };
    }
    const result = await h.runner.run({});
    assert.equal(result.ok, false, problem); assert.equal(result.attempted, 0, problem); assert.deepEqual(h.calls, []);
  }
});

test("native mark-read failure reports partial work and leaves subsequent accounts untouched", async () => {
  const h = readFixture();
  h.accounts[1].inbox.markAllMessagesRead = () => { throw new Error("Native failure"); };
  const result = await h.runner.run({});
  assert.equal(result.error, "mark-read-failed"); assert.equal(result.completed, 1); assert.equal(result.attempted, 2);
  assert.deepEqual(h.calls, [0]);
});
