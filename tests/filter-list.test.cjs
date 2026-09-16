const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), vm = require("node:vm");
const { webcrypto } = require("node:crypto");

class Element {
  constructor(tag) { this.tagName = this.localName = tag; this.children = []; this.attributes = new Map(); this.events = new Map();
    this.classList = { add: value => { this.className = value; } }; }
  appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
  remove() { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; }
  setAttribute(key, value) { this.attributes.set(key, value); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  removeAttribute(key) { this.attributes.delete(key); }
  addEventListener(key, fn) { this.events.set(key, fn); }
  removeEventListener(key) { this.events.delete(key); }
}
const marker = " [stf-shared:v1:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222]";
function fixture(execution = {}) {
  const native = new Element("richlistitem");
  native._filter = { filterName: "Ads", filterDesc: marker, enabled: true };
  native.appendChild(new Element("label")).setAttribute("value", "Ads"); native.appendChild(new Element("checkbox"));
  const ordinary = new Element("richlistitem");
  ordinary._filter = { filterName: "Ads", filterDesc: "", enabled: false };
  ordinary.appendChild(new Element("label")).setAttribute("value", "Ads"); ordinary.appendChild(new Element("checkbox"));
  const list = new Element("richlistbox"); list.appendChild(native); list.appendChild(ordinary);
  Object.defineProperty(list, "itemChildren", { get: () => list.children }); list.selectedItems = [native];
  const footer = new Element("vbox"), runRow = footer.appendChild(new Element("hbox"));
  const run = runRow.appendChild(new Element("button")), head = new Element("head"), events = new Map();
  run.setAttribute("data-l10n-id", "filter-run-filters-button"); run.setAttribute("label", "Run Now"); run.setAttribute("accesskey", "R");
  const picker = new Element("menulist"); picker._folder = { prettyName: "Inbox", server: { prettyName: "test@example.invalid" } };
  const ids = { filterList: list, runFiltersButton: run, runFiltersFolder: picker, folderPickerPrefix: new Element("label"),
    activeColumn: new Element("treecol"),
    "statusbar-progresspanel": new Element("hbox"), statusText: new Element("label") };
  ids.activeColumn.setAttribute("data-l10n-id", "filter-active-column"); ids.activeColumn.setAttribute("label", "Enabled");
  ids.folderPickerPrefix.setAttribute("value", "Run selected filter(s) on:");
  const filters = [native._filter, ordinary._filter];
  const nativeList = { get filterCount() { return filters.length; }, getFilterAt: index => filters[index] };
  const observers = [];
  const win = { gCurrentFilterList: nativeList, gRunFiltersFolder: picker,
    updateButtons() { run.disabled = !list.selectedItems.length || !picker._folder; picker.disabled = false; },
    document: { readyState: "complete", head, getElementById: id => ids[id] || null,
    createElementNS: (_ns, tag) => new Element(tag), createXULElement: tag => new Element(tag) },
    addEventListener: (key, fn) => events.set(key, fn), removeEventListener: key => events.delete(key),
    MutationObserver: class { constructor(fn) { this.update = fn; observers.push(this); } observe() { this.active = true; } disconnect() { this.active = false; } } };
  let listener, registrations = 0, removals = 0;
  const support = { registerWindowListener(_id, value) { listener = value; registrations++; value.onLoadWindow(win); return true; },
    unregisterWindowListener() { removals++; } };
  const scope = vm.createContext({ TextEncoder, TextDecoder, crypto: webcrypto,
    ChromeUtils: { importESModule: () => ({ ExtensionSupport: support }) } });
  for (const path of ["lib/shared-model.js", "api/senderToFilter/filter-list.js"]) vm.runInContext(fs.readFileSync(path, "utf8"), scope);
  const messages = JSON.parse(fs.readFileSync("_locales/en/messages.json", "utf8"));
  const controls = new scope.FilterListIndicators({ id: "fixture", localeData: { localizeMessage: (key, args = []) => {
    if (!Array.isArray(args)) args = [args]; return (messages[key]?.message || "").replace(/\$(\d+)/gu, (_, n) => args[n - 1] || "");
  } } }, scope.SenderToFilterSharedModel, { uuid: () => "run-id", ...execution });
  return { controls, native, ordinary, list, filters, footer, head, win, events, observers, run, picker,
    cross: () => footer.children.find(e => e.className === "stf-shared-run-options").children[0],
    stop: () => footer.children.find(e => e.className === "stf-shared-run-options").children[1],
    all: () => footer.children.find(e => e.className === "stf-run-all-row").children[0],
    allPreview: () => footer.children.find(e => e.className === "stf-run-all-row").children[1],
    counts: () => ({ registrations, removals }), hook: () => listener,
    note: () => footer.children.find(child => child.tagName === "p"), update: () => observers.at(-1).update() };
}

test("native shared labels follow ownership, preserve native cells and show the run scope", () => {
  const h = fixture(), original = JSON.stringify(h.native._filter), cells = h.native.children.slice();
  h.controls.start();
  assert.deepEqual(h.native.children.slice(0, 2), cells);
  assert.equal(h.native.children[2].getAttribute("value"), "Shared");
  assert.equal(h.ordinary.children.length, 2, "a same-name ordinary filter is not shared");
  assert.equal(h.native.getAttribute("aria-label"), "Ads — Shared");
  assert.equal(h.note().hidden, false); assert.match(h.note().textContent, /Inbox in each linked account/u);
  h.list.selectedItems = [h.ordinary]; h.list.events.get("select")(); assert.match(h.note().textContent, /Will run:.*Ads.*Inbox on test@example.invalid/u);
  h.list.selectedItems = [h.ordinary, h.native]; h.list.events.get("select")(); assert.equal(h.note().hidden, false);
  h.list.selectedItems = []; h.list.events.get("select")(); assert.match(h.note().textContent, /Highlight one or more/u);
  h.update(); h.update(); assert.equal(h.native.children.length, 3);
  assert.equal(JSON.stringify(h.native._filter), original);
  assert.equal(h.native.children[0].getAttribute("value"), "Ads");
  h.controls.stop(); assert.deepEqual(h.native.children, cells); assert.equal(h.native.getAttribute("aria-label"), null);
  assert.equal(h.note(), undefined); assert.equal(h.head.children.length, 0); assert.equal(h.list.events.size, 0);
});

test("selection counts, enabled counts and folder previews stay distinct and restore native labels on unload", () => {
  const h = fixture(), originalUpdate = h.win.updateButtons, column = h.win.document.getElementById("activeColumn");
  h.ordinary._filter.filterName = "School <test>"; h.controls.start();
  assert.equal(column.getAttribute("label"), "Run automatically");
  assert.equal(column.getAttribute("data-l10n-id"), null);
  assert.equal(h.run.getAttribute("label"), "Run selected filters (1)");
  assert.equal(h.all().getAttribute("label"), "Run all enabled filters (1)");
  h.list.selectedItems = [h.ordinary]; h.list.events.get("select")();
  assert.match(h.note().textContent, /Will run: “School <test>” → Inbox on test@example.invalid/u);
  assert.doesNotMatch(h.allPreview().textContent, /School/u);
  h.ordinary._filter.enabled = true; h.update();
  assert.equal(h.run.getAttribute("label"), "Run selected filters (1)");
  assert.equal(h.all().getAttribute("label"), "Run all enabled filters (2)");
  assert.match(h.allPreview().textContent, /including filters hidden by search.*Ads.*linked account.*School.*Inbox on test@example.invalid/u);
  h.picker._folder = { prettyName: "Other", server: { prettyName: "test@example.invalid" } }; h.win.updateButtons();
  assert.match(h.note().textContent, /Other on test@example.invalid/u);
  h.list.selectedItems = []; h.list.events.get("select")();
  assert.equal(h.run.getAttribute("label"), "Run selected filters (0)"); assert.equal(h.run.disabled, true);
  assert.equal(h.all().disabled, false); assert.equal(h.picker.disabled, false);
  h.win.gRunningFilters = true; h.win.updateButtons(); assert.equal(h.all().disabled, true);
  h.win.gRunningFilters = false; h.win.updateButtons(); assert.equal(h.all().disabled, false);
  h.filters.forEach(filter => { filter.enabled = false; }); h.update();
  assert.equal(h.all().disabled, true); assert.match(h.allPreview().textContent, /No filters are checked/u);
  h.controls.stop();
  assert.equal(h.win.updateButtons, originalUpdate);
  assert.equal(h.run.getAttribute("label"), "Run Now"); assert.equal(h.run.getAttribute("accesskey"), "R");
  assert.equal(h.run.getAttribute("data-l10n-id"), "filter-run-filters-button");
  assert.equal(column.getAttribute("label"), "Enabled"); assert.equal(column.getAttribute("data-l10n-id"), "filter-active-column");
  assert.equal(h.win.document.getElementById("folderPickerPrefix").getAttribute("value"), "Run selected filter(s) on:");
  h.controls.start(); const inner = h.win.updateButtons;
  const laterWrapper = function (...args) { return inner.apply(this, args); }; h.win.updateButtons = laterWrapper;
  h.controls.stop(); h.win.updateButtons();
  assert.equal(h.win.updateButtons, laterWrapper, "cleanup preserves another add-on's later wrapper");
  assert.equal(h.run.getAttribute("label"), "Run Now", "a retained wrapper stops updating removed controls");
});

test("Run all enabled includes search-hidden filters in account order and shared scope without changing selection or flags", async () => {
  const requests = [], runs = [];
  const h = fixture({ request: id => requests.push(id), runner: { async run(groups, selection) {
    runs.push(selection); return { ok: true, completed: 2, total: 2 };
  } } });
  const hidden = { filterName: "Hidden local", filterDesc: "", enabled: true };
  h.filters.unshift(hidden); h.list.selectedItems = [h.ordinary]; h.native.remove();
  const before = JSON.stringify(h.filters), selected = h.list.selectedItems.slice(); h.controls.start();
  const all = h.all(), event = { preventDefault() {}, stopImmediatePropagation() {} };
  assert.equal(all.getAttribute("label"), "Run all enabled filters (2)");
  assert.match(h.allPreview().textContent, /Hidden local.*Inbox on test@example.invalid/u);
  all.events.get("command")(event); all.events.get("command")(event);
  assert.deepEqual(requests, ["run-id"]); assert.equal(all.disabled, true);
  await h.controls.execute("run-id", []);
  assert.deepEqual(Array.from(runs[0].filters), [hidden, h.native._filter]);
  assert.deepEqual(h.list.selectedItems, selected); assert.equal(JSON.stringify(h.filters), before);
  assert.equal(all.disabled, false); h.controls.stop();
});

test("unchecked Run all enabled uses one chosen folder, guards missing folders, and handles cancellation and failure", async () => {
  const runs = []; let settle, fail = false;
  const h = fixture({ request() { throw new Error("must not request a cross-account run"); },
    runLocal(selection, control) {
      runs.push(selection);
      if (fail) throw new Error("filtering failed");
      return new Promise(resolve => { settle = resolve; control.abort = resolve; });
    } });
  h.ordinary._filter.enabled = true; h.list.selectedItems = []; h.controls.start();
  h.cross().checked = false; h.cross().events.get("command")();
  const folder = h.picker._folder, event = { preventDefault() {}, stopImmediatePropagation() {} };
  h.picker._folder = null; h.win.updateButtons();
  assert.equal(h.all().disabled, true); assert.match(h.allPreview().textContent, /choose a folder/u);
  h.all().events.get("command")(event); assert.equal(runs.length, 0);
  h.picker._folder = folder; h.win.updateButtons(); h.all().events.get("command")(event);
  assert.equal(runs.length, 1); assert.equal(runs[0].folder, folder);
  assert.deepEqual(Array.from(runs[0].filters), h.filters); assert.equal(h.run.disabled, true);
  h.stop().events.get("command")(); await new Promise(setImmediate);
  assert.equal(h.win.gRunningFilters, false); assert.match(h.note().textContent, /partly processed/u);
  h.all().events.get("command")(event); settle(); await new Promise(setImmediate);
  assert.match(h.note().textContent, /Finished.*1 folder/u); assert.equal(h.all().disabled, false);
  fail = true; h.all().events.get("command")(event); await new Promise(setImmediate);
  assert.match(h.note().textContent, /filtering failure/u); assert.equal(h.all().disabled, false);
  assert.deepEqual(h.list.selectedItems, []); h.controls.stop();
});

test("Run Now intercepts only checked shared selections and consumes each native request once", async () => {
  const requests = [], runs = [];
  const h = fixture({ request: id => requests.push(id), runner: { async run(groups, selected) {
    runs.push(selected); return { ok: true, completed: 2, total: 2 };
  } } });
  h.controls.start(); assert.equal(h.cross().checked, true); assert.equal(h.run.disabled, false); assert.equal(h.picker.disabled, true);
  function command() { const event = { stopped: false, prevented: false, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
    h.run.events.get("command")(event); return event; }
  h.cross().checked = false; h.cross().events.get("command")();
  assert.equal(command().stopped, false); assert.equal(h.picker.disabled, false); assert.deepEqual(requests, []);
  h.cross().checked = true; h.list.selectedItems = [h.ordinary]; h.list.events.get("select")();
  assert.equal(command().stopped, false); assert.deepEqual(requests, []);
  h.list.selectedItems = [h.native, h.ordinary]; h.list.events.get("select")();
  const event = command(); assert.equal(event.stopped, true); assert.equal(event.prevented, true);
  assert.equal(h.win.gRunningFilters, true); assert.equal(h.run.disabled, true);
  h.win.progressMeterVisible = true; h.win.document.getElementById("statusText").setAttribute("value", "Moving messages…");
  await h.controls.execute(requests[0], []); await h.controls.execute(requests[0], []);
  assert.equal(runs.length, 1); assert.equal(runs[0].filters.length, 2);
  assert.equal(h.win.gRunningFilters, false); assert.match(h.note().textContent, /Finished.*2/u);
  assert.equal(h.win.progressMeterVisible, false); assert.equal(h.win.document.getElementById("statusText").getAttribute("value"), "");
  h.controls.stop(); assert.equal(h.run.events.size, 0);
});

test("Stop cancels queued requests and active runs, and restores native controls", async () => {
  let calls = 0, aborts = 0;
  const h = fixture({ request() {}, runner: { run(groups, selection, control) {
    calls++; return new Promise(resolve => { control.abort = () => { aborts++; resolve({ ok: false, completed: 0, attempted: 1, total: 2, error: "shared-run-cancelled" }); }; });
  } } }); h.controls.start();
  const event = { preventDefault() {}, stopImmediatePropagation() {} };
  h.run.events.get("command")(event); h.stop().events.get("command")();
  await h.controls.execute("run-id", []); assert.equal(calls, 0); assert.equal(h.win.gRunningFilters, false);
  h.run.events.get("command")(event); const running = h.controls.execute("run-id", []);
  h.stop().events.get("command")(); await running;
  assert.equal(aborts, 1); assert.equal(calls, 1); assert.equal(h.win.gRunningFilters, false);
  assert.match(h.note().textContent, /partly processed/u); h.controls.stop();
});

test("recycled native rows lose stale badges and malformed links are distinguished", () => {
  const h = fixture(); h.controls.start();
  h.native._filter = { filterName: "Ordinary", filterDesc: "" }; h.native.children[0].setAttribute("value", "Ordinary"); h.update();
  assert.equal(h.native.children.length, 2); assert.equal(h.native.getAttribute("aria-label"), null);
  h.native._filter.filterDesc = " [stf-shared:v2:unknown]"; h.update();
  assert.equal(h.native.children[2].getAttribute("value"), "Shared link issue");
  h.native.remove(); h.update(); assert.equal(h.native.children.length, 2);
  h.controls.stop();
});

test("native indicators attach once to open windows and clean up loading windows and reinitialization", () => {
  const h = fixture(); h.controls.start(); h.hook().onLoadWindow(h.win);
  assert.equal(h.observers.length, 1);
  const loading = { ...h.win, document: { readyState: "loading" } };
  h.hook().onLoadWindow(loading); assert.ok(h.events.has("load"));
  h.win.gRunningFilters = true;
  h.controls.stop(); assert.equal(h.events.size, 0); assert.equal(h.observers[0].active, false);
  assert.equal(h.win.gRunningFilters, true, "unrelated native runs keep their completion state when the add-on stops");
  h.win.gRunningFilters = false;
  assert.deepEqual(h.counts(), { registrations: 1, removals: 1 });
  h.controls.start(); assert.equal(h.native.children.length, 3);
  h.hook().onUnloadWindow(h.win); assert.equal(h.native.children.length, 2);
  h.controls.stop();
});
