const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), vm = require("node:vm");
const { setup, plain } = require("./shared-helpers.cjs");

// Small DOM test double; assertions exercise the real page and coordinator.
// Browser layout/keyboard checks are recorded separately in VALIDATION.md.
class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.listeners = {}; this.attributes = {}; this.dataset = {};
    this.value = ""; this.checked = false; this.disabled = false; this.hidden = false; this._text = "";
    this.classList = { toggle: (name, enabled) => { this.attributes[name] = enabled; } }; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(c => typeof c === "string" ? c : c.textContent).join(""); }
  set innerHTML(_value) { throw new Error("Untrusted text must never become HTML"); }
  append(...children) { this.children.push(...children); if (this.tagName === "select" && !this.value && this.options.length) this.value = this.options[0].value; }
  replaceChildren(...children) { this.children = []; this._text = ""; this.append(...children); }
  get options() { return this.children.filter(c => c.tagName === "option"); }
  addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  focus() { this.focused = true; }
  async fire(type) { for (const fn of this.listeners[type] || []) await fn({ preventDefault() {} }); }
}
function descendants(root) { return root.children.flatMap(c => typeof c === "string" ? [] : [c, ...descendants(c)]); }
async function page(h) {
  const c = h.coordinator(); await c.start(); const calls = [];
  const byId = new Map();
  const html = fs.readFileSync("options/shared-filters.html", "utf8");
  for (const [, tag, id] of html.matchAll(/<(\w+)[^>]*\bid="([^"]+)"/gu)) byId.set(id, new Element(tag));
  const body = new Element("body"), document = { body, title: "", createElement: tag => new Element(tag),
    getElementById: id => byId.get(id), querySelectorAll: () => [] };
  const locale = JSON.parse(fs.readFileSync("_locales/en/messages.json"));
  const url = "moz-extension://fixture/options/shared-filters.html";
  const browser = { i18n: { getMessage(key, values = []) { if (!Array.isArray(values)) values = [values];
    return (locale[key]?.message || "").replace(/\$(\d+)/gu, (_, n) => values[n - 1] || ""); } },
    runtime: { async sendMessage(message) { calls.push(plain(message)); return plain(await c.dispatch(message, { id: "self", url }, url, "self")); } } };
  vm.runInNewContext(fs.readFileSync("options/shared-filters.js", "utf8"), { document, browser, window: { addEventListener() {}, confirm: () => true }, console });
  async function settled() { for (let n = 0; n < 200; n++) { await new Promise(setImmediate); if (!body.attributes["aria-busy"]) return; } throw new Error("Page stayed busy"); }
  const el = id => byId.get(id);
  async function fire(target, type = "click") { await (typeof target === "string" ? el(target) : target).fire(type); await settled(); }
  function button(id, text) { const result = descendants(el(id)).find(e => e.tagName === "button" && e.textContent === text); assert.ok(result, text); return result; }
  await settled(); return { el, fire, button, calls, c };
}

test("manager create, preview, back and cancel are read-only until explicit save", async () => {
  const h = setup(), p = await page(h);
  async function draft() {
    await p.fire("new"); await p.fire(p.button("source", "Use this filter"));
    const second = p.el("members").children[1];
    const checkbox = descendants(second).find(e => e.tagName === "input" && e.type === "checkbox");
    checkbox.checked = true; await p.fire(checkbox, "change");
    p.el("name").value = "<img src=x onerror=alert(1)>";
    await p.fire("form", "submit");
    assert.equal(p.el("preview").hidden, false);
    assert.match(p.el("previewContent").textContent, /<img src=x onerror=alert\(1\)>/u);
    assert.deepEqual(h.writes, []); assert.equal(h.storageWrites.length, 0);
  }
  await draft(); await p.fire("back"); await p.fire("cancel"); assert.equal(h.storageWrites.length, 0);
  await draft(); await p.fire("save"); assert.deepEqual(h.writes, ["a", "b"]);
  assert.match(p.el("groups").textContent, /Up to date/u); assert.equal(p.el("editor").hidden, true);
});

test("manager native-edit cancellation preserves the group; unlink requires preview and save", async () => {
  const h = setup(); await h.seed(); h.writes.length = 0;
  h.host.edit = () => ({ canceled: true });
  const p = await page(h);
  await p.fire(p.button("groups", "Edit shared rule…")); await p.fire("nativeEdit"); await p.fire("cancel");
  assert.deepEqual(h.writes, []);
  await p.fire(p.button("groups", "Stop sharing this account")); await p.fire("form", "submit");
  assert.match(p.el("previewContent").textContent, /independent/u); assert.deepEqual(h.writes, []);
  await p.fire("save"); assert.deepEqual(h.writes, ["a"]);
  assert.equal(Object.values(p.c.view().state.groups)[0].members.length, 2);
  assert.equal(h.M.parseOwnership(h.accounts.get("a").disk.filters[0].description).status, "unmarked");
});

test("manager blocks incomplete mappings after a draft folder-action change", async () => {
  const h = setup(); const { group } = await h.seed(); h.writes.length = 0;
  const slotId = h.uuid();
  h.host.edit = () => ({ canceled: false, definition: { ...group.definition, actions: [{ type: "MoveToFolder", slotId }] },
    referenceMappings: { [slotId]: { accountId: "a", path: "/Missing" } }, mappingReviewRequired: true });
  const p = await page(h); await p.fire(p.button("groups", "Edit shared rule…")); await p.fire("nativeEdit");
  await p.fire("form", "submit"); assert.match(p.el("status").textContent, /destination/u);
  assert.equal(p.calls.filter(c => c.action === "preview").length, 0); assert.deepEqual(h.writes, []);
});

test("manager retains corrupt-state errors after refresh and disables creation", async () => {
  const h = setup(); h.store[h.M.STORAGE_KEY] = { schemaVersion: 999, groups: {} };
  const p = await page(h); const first = p.el("status").textContent;
  assert.equal(p.el("new").disabled, true); assert.equal(p.el("status").attributes.error, true);
  await p.fire("refresh"); assert.equal(p.el("status").textContent, first); assert.equal(h.storageWrites.length, 0);
});

test("filter order preview follows insertion choices and matches the saved account lists", async () => {
  const h = setup(), b = h.accounts.get("b"), c = h.accounts.get("c");
  b.list.filters.push(h.wrap(h.rule("Later"))); b.disk = h.host.snapshotList(b.list);
  c.list.filters = []; c.disk = h.host.snapshotList(c.list);
  const p = await page(h); await p.fire("new"); await p.fire(p.button("source", "Use this filter"));
  const names = list => list.children.map(li => li.children[0].children[0].textContent);
  const listAt = index => descendants(p.el("members").children[index]).find(e => e.tagName === "ol");
  const panel = p.el("members").children[1], elements = descendants(panel);
  const selected = elements.find(e => e.type === "checkbox"), position = elements.find(e => e.type === "number");
  selected.checked = true; await p.fire(selected, "change");
  assert.deepEqual(names(listAt(1)), ["Other", "Later", "Letters"]);
  for (const [value, expected] of [["1", ["Letters", "Other", "Later"]], ["2", ["Other", "Letters", "Later"]]]) {
    position.value = value; await p.fire(position, "input");
    assert.deepEqual(names(listAt(1)), expected);
    assert.equal(listAt(1).children[Number(value) - 1].className, "filter-order-current");
  }
  for (const value of ["", "0", "4", "1.5"]) {
    position.value = value; await p.fire(position, "input");
    assert.deepEqual(names(listAt(1)), ["Other", "Later"]);
    assert.match(panel.textContent, /Enter a position from 1 to 3/u);
  }
  selected.checked = false; await p.fire(selected, "change");
  assert.equal(position.disabled, true, "an invalid position in an unselected account must not block the form");
  selected.checked = true; await p.fire(selected, "change");
  position.value = "2"; await p.fire(position, "input");
  p.el("name").value = "Letters <img src=x>"; await p.fire("name", "input");
  p.el("enabled").checked = true; await p.fire("enabled", "change");
  assert.deepEqual(names(listAt(1)), ["Other", "Letters <img src=x>", "Later"]);
  assert.doesNotMatch(listAt(1).children[1].textContent, /Disabled/u);
  assert.match(listAt(1).children[0].textContent, /Disabled/u);
  const emptyAccount = descendants(p.el("members").children[2]).find(e => e.type === "checkbox");
  emptyAccount.checked = true; await p.fire(emptyAccount, "change");
  assert.deepEqual(names(listAt(2)), ["Letters <img src=x>"]);
  const expected = [0, 1, 2].map(index => names(listAt(index)));
  await p.fire("form", "submit"); assert.deepEqual(h.writes, []); assert.equal(h.storageWrites.length, 0);
  await p.fire("save");
  assert.deepEqual([...h.accounts.values()].map(a => a.disk.filters.map(f => f.name)), expected);
  // Reopening reads the saved lists, including their newly assigned ownership.
  await p.fire(p.button("groups", "Edit shared rule…"));
  assert.deepEqual([0, 1, 2].map(index => names(listAt(index))), expected);
  assert.equal(listAt(1).children[1].className, "filter-order-current");
  assert.match(listAt(1).children[1].textContent, /Linked copy/u);
});

test("link preview hides insertion controls and keeps the selected existing filter in place", async () => {
  const h = setup(), b = h.accounts.get("b");
  b.list.filters.push(h.wrap(h.rule("Selected"))); b.disk = h.host.snapshotList(b.list);
  const p = await page(h); await p.fire("new"); await p.fire(p.button("source", "Use this filter"));
  const source = descendants(p.el("members").children[0]);
  const sourcePosition = source.find(e => e.type === "number");
  assert.equal(source.find(e => e.tagName === "label" && e.children.includes(sourcePosition)).hidden, true);
  assert.match(p.el("members").children[0].textContent, /Keeps its current position \(1\)/u);
  const panel = p.el("members").children[1], elements = descendants(panel);
  const checked = elements.find(e => e.type === "checkbox"), mode = elements.find(e => e.tagName === "select");
  const position = elements.find(e => e.type === "number"), positionLabel = elements.find(e => e.tagName === "label" && e.children.includes(position));
  const list = elements.find(e => e.tagName === "ol");
  checked.checked = true; await p.fire(checked, "change");
  position.value = "1"; await p.fire(position, "input");
  mode.value = "1"; await p.fire(mode, "change");
  assert.equal(positionLabel.hidden, true); assert.equal(position.disabled, true);
  assert.equal(list.children.length, 2); assert.equal(list.children[1].className, "filter-order-current");
  assert.match(list.children[1].textContent, /Letters.*Linked copy.*Replaces: Selected/u);
  assert.match(panel.textContent, /Keeps its current position \(2\)/u);
  mode.value = "create"; await p.fire(mode, "change");
  assert.equal(positionLabel.hidden, false); assert.equal(position.disabled, false);
  assert.equal(list.children.length, 3); assert.equal(list.children[0].className, "filter-order-current");
  mode.value = "1"; await p.fire(mode, "change");
  await p.fire("form", "submit"); assert.deepEqual(h.writes, []);
  await p.fire("save"); assert.deepEqual(b.disk.filters.map(f => f.name), ["Other", "Letters"]);
});
