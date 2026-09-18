const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), vm = require("node:vm");
const { deferred } = require("./helpers.cjs");

class Element {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.events = new Map(); this.attributes = new Map();
    this.classList = { toggle() {} };
  }
  append(...children) { children.forEach(child => this.appendChild(child)); }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  insertBefore(child, other) { child.parentNode = this; this.children.splice(this.children.indexOf(other), 0, child); }
  after(child) { child.parentNode = this.parentNode; this.parentNode.children.splice(this.parentNode.children.indexOf(this) + 1, 0, child); }
  remove() { this.parentNode?.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; }
  addEventListener(name, fn) { this.events.set(name, fn); }
  removeEventListener(name) { this.events.delete(name); }
  setAttribute(name, value) { this.attributes.set(name, value); }
}
function pane() {
  const root = new Element("html"), head = root.appendChild(new Element("head"));
  const header = root.appendChild(new Element("div")), get = header.appendChild(new Element("button"));
  const events = new Map(), observers = [];
  const doc = { documentURI: "about:3pane", head, getElementById: id => ({ folderPaneHeaderBar: header, folderPaneGetMessages: get })[id],
    createElementNS: (_ns, tag) => new Element(tag), defaultView: {
      addEventListener: (name, fn) => events.set(name, fn), removeEventListener: name => events.delete(name),
      ResizeObserver: class { constructor() { observers.push(this); } observe() { this.active = true; } disconnect() { this.active = false; } },
    } };
  return { doc, root, head, header, get, events, observers };
}
function fixture(runner = { run: async () => ({ ok: true, completed: 3, total: 3 }) }, readRunner = runner) {
  const panes = [pane(), pane()], requests = [], windows = panes.map(p => {
    const events = new Map(); return { events, document: { getElementById: () => ({ tabInfo: [{ chromeBrowser: { contentDocument: p.doc } }] }) },
      addEventListener: (key, fn) => events.set(key, fn), removeEventListener: key => events.delete(key) };
  });
  let listener, removed = 0, next = 0;
  const support = { registerWindowListener(_id, value) { listener = value; windows.forEach(value.onLoadWindow); return true; },
    unregisterWindowListener() { removed++; } };
  const scope = { ChromeUtils: { importESModule: () => ({ ExtensionSupport: support }) } };
  vm.runInNewContext(fs.readFileSync("api/senderToFilter/inbox-run.js", "utf8"), scope);
  const messages = JSON.parse(fs.readFileSync("_locales/en/messages.json"));
  const extension = { id: "fixture", rootURI: { resolve: p => `moz-extension://fixture/${p}` },
    localeData: { localizeMessage: (key, args = []) => (messages[key]?.message || "")
      .replace(/\$(\d+)/g, (_, n) => (Array.isArray(args) ? args : [args])[n - 1] ?? "") } };
  const controls = new scope.InboxRunControls(extension, { uuid: () => String(++next), request: id => requests.push(id), runner, readRunner });
  return { panes, windows, controls, requests, hook: () => listener, removed: () => removed };
}

test("Inbox toolbar lifecycle handles open/new tabs and cleans every listener and control on disable", () => {
  const h = fixture(); h.controls.start(); h.hook().onLoadWindow(h.windows[0]);
  assert.equal(h.controls.panes.size, 2); assert.equal(h.panes[0].header.children.length, 3);
  assert.deepEqual(h.panes[0].header.children.slice(0, 2).map(b => b.id), ["stf-mark-inboxes-read", "stf-run-inbox-filters"]);
  const extra = pane(); h.windows[0].events.get("DOMContentLoaded")({ target: extra.doc });
  assert.equal(h.controls.panes.size, 3);
  h.controls.request(extra.doc); const active = h.controls.active;
  h.controls.stop(); assert.equal(active.control.cancelled, true); assert.equal(h.controls.panes.size, 0);
  assert.equal(h.removed(), 1); assert.equal(h.controls.windows.size, 0);
  for (const p of [...h.panes, extra]) {
    assert.deepEqual(p.header.children, [p.get]); assert.equal(p.head.children.length, 0);
    assert.equal(p.events.size, 0); assert.ok(p.observers.every(o => !o.active));
  }
  assert.ok(h.windows.every(w => !w.events.has("DOMContentLoaded")));
  h.controls.start(); assert.equal(h.controls.panes.size, 2); h.controls.stop();
});

test("one global Inbox run blocks repeat clicks across windows and consumes a captured request once", async () => {
  const gate = deferred(); let runs = 0;
  const h = fixture({ run: async control => { runs++; control.progress({ completed: 0, total: 3, accountName: "First" }); return gate.promise; } });
  h.controls.start(); h.controls.request(h.panes[0].doc); h.controls.request(h.panes[1].doc);
  assert.deepEqual(h.requests, ["1"]);
  assert.ok([...h.controls.panes.values()].every(p => Object.values(p.actions).every(a => a.button.disabled)));
  await h.controls.execute("wrong"); const run = h.controls.execute("1"); await h.controls.execute("1");
  assert.equal(runs, 1); assert.match(h.controls.message, /Inbox 1 of 3: First/);
  h.controls.cancel(); assert.equal(h.controls.active.control.cancelled, true);
  assert.match(h.controls.message, /Stopping after/);
  gate.resolve({ ok: false, completed: 1, attempted: 1, total: 3, error: "cancelled" }); await run;
  assert.match(h.controls.message, /Finished 1 of 3 Inboxes/);
  assert.ok([...h.controls.panes.values()].every(p => Object.values(p.actions).every(a => !a.button.disabled) && p.stop.hidden));
  h.controls.stop();
});

test("closing the initiating tab cancels pending work and stale tokens cannot run after re-enable", async () => {
  let runs = 0; const h = fixture({ run: async () => { runs++; return { ok: true, completed: 1 }; } });
  h.controls.start(); h.controls.request(h.panes[0].doc);
  h.panes[0].events.get("unload")(); await h.controls.execute("1");
  assert.equal(runs, 0); assert.equal(h.controls.panes.size, 1);
  h.controls.request(h.panes[1].doc); await h.controls.execute("1"); await h.controls.execute("2");
  assert.equal(runs, 1); h.controls.stop();
});

test("Mark All Read captures the requested action and excludes filter and read clicks across windows", async () => {
  const gate = deferred(); let filters = 0, reads = 0;
  const h = fixture({ run: async () => { filters++; return { ok: true, completed: 3 }; } },
    { run: async control => { reads++; control.progress({ completed: 1, total: 3, accountName: "Second" }); return gate.promise; } });
  h.controls.start();
  const first = h.controls.panes.get(h.panes[0].doc), second = h.controls.panes.get(h.panes[1].doc);
  first.actions.read.button.events.get("click")();
  second.actions.filters.button.events.get("click")(); second.actions.read.button.events.get("click")();
  assert.deepEqual(h.requests, ["1"]); assert.equal(h.controls.active.kind, "read");
  assert.equal(first.actions.read.label.textContent, "Marking…");
  assert.equal(second.actions.filters.label.textContent, "Run Filters");
  assert.ok([...h.controls.panes.values()].every(p => Object.values(p.actions).every(a => a.button.disabled)));
  const run = h.controls.execute("1"); await h.controls.execute("1");
  assert.equal(reads, 1); assert.equal(filters, 0); assert.match(h.controls.message, /Marking Inbox 2 of 3 read: Second/);
  gate.resolve({ ok: true, completed: 3 }); await run;
  assert.match(h.controls.message, /Marked all messages read in 3 Inbox/);
  assert.ok([...h.controls.panes.values()].every(p => Object.values(p.actions).every(a => !a.button.disabled)));
  second.actions.filters.button.events.get("click")(); await h.controls.execute("2");
  assert.equal(filters, 1); assert.equal(reads, 1); h.controls.stop();
});

test("Mark All Read errors and queued cancellation use read-specific status and release both controls", async () => {
  const h = fixture(undefined, { run: async () => ({ ok: false, completed: 1, attempted: 2, total: 3, error: "mark-read-failed" }) });
  h.controls.start(); h.controls.request(h.panes[0].doc, "read"); h.controls.cancel();
  assert.match(h.controls.message, /No messages were marked read.*Marking read stopped/);
  await h.controls.execute("1");
  h.controls.request(h.panes[0].doc, "read"); await h.controls.execute("2");
  assert.match(h.controls.message, /Marked 1 of 3 Inboxes read.*could not finish marking/);
  assert.doesNotMatch(h.controls.message, /filter/i);
  assert.ok([...h.controls.panes.values()].every(p => Object.values(p.actions).every(a => !a.button.disabled)));
  h.controls.stop();
});
