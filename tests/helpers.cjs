const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(setImmediate);
const constants = {
  nsMsgSearchAttrib: { Sender: 1, Subject: 2 },
  nsMsgSearchOp: { Is: 0, Contains: 1 },
  nsIMsgWindow: {},
};

function term(value = "old@example.com", changes = {}) {
  let nativeValue = { attrib: 1, str: value };
  return Object.assign({
    attrib: 1, op: 0, booleanAnd: false,
    matchAll: false, beginsGrouping: false, endsGrouping: false,
    get value() { return { ...nativeValue }; },
    set value(value) { nativeValue = { ...value }; },
  }, changes);
}

function filter(name = "Newsletters", terms = [term()], changes = {}) {
  let nativeTerms = terms.slice();
  const result = {
    filterName: name, enabled: true, filterType: 17,
    temporary: false, unparseable: false,
    actions: [{ type: "move", folder: "mailbox://fixture/News" }],
    restores: 0, appends: 0,
    get searchTerms() { return nativeTerms.slice(); },
    set searchTerms(value) { nativeTerms = value.slice(); this.restores++; },
    createTerm() { return term(""); },
    appendTerm(value) { this.appends++; nativeTerms.push(value); },
  };
  return Object.assign(result, changes);
}

function experiment(filters = [filter()]) {
  const list = {
    filters, saves: 0, failure: null,
    get filterCount() { return this.filters.length; },
    getFilterAt(index) { return this.filters[index]; },
    saveToDefaultFile() { this.saves++; if (this.failure) throw this.failure; },
  };
  const nativeFolder = { getEditableFilterList: () => list };
  const dialogs = [];
  const windows = new Map([[42, { MsgFilters: (...args) => dialogs.push(args) }]]);
  const context = {
    extension: {
      folderManager: { get: () => nativeFolder },
      windowManager: { get: id => ({ window: windows.get(id) }) },
    },
  };
  const sandbox = {
    Ci: constants,
    Cc: { "@mozilla.org/messenger/msgwindow;1": { createInstance: () => ({}) } },
    ExtensionCommon: { ExtensionAPI: class {} },
    Services: { obs: { notifyObservers() {} } },
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, "api/senderToFilter/implementation.js"), "utf8"), sandbox);
  const api = new sandbox.senderToFilter().getAPI(context).senderToFilter;
  return { api, list, filters, dialogs, windows, nativeFolder, context };
}

function background(overrides = {}) {
  const messages = JSON.parse(fs.readFileSync(path.join(root, "_locales/en/messages.json")));
  const listeners = {};
  const items = new Map();
  const calls = { adds: [], lists: [], notifications: [], aborts: [], new: [], manage: [], errors: [] };
  const storage = { ...overrides.storage };
  const browser = {
    runtime: { getURL: name => `moz-extension://fixture/${name}` },
    i18n: {
      getMessage(key, substitutions = []) {
        const values = Array.isArray(substitutions) ? substitutions : [substitutions];
        if (!messages[key]) throw new Error(`Missing translation ${key}`);
        return messages[key].message.replace(/\$(\d+)/g, (_, number) => values[Number(number) - 1] ?? "");
      },
    },
    storage: { local: { get: async () => ({ ...storage }), set: async values => Object.assign(storage, values) } },
    menus: {
      create(props, callback) {
        Promise.resolve().then(() => overrides.create?.(props)).then(() => {
          if (items.has(props.id)) throw new Error(`Duplicate menu id ${props.id}`);
          items.set(props.id, { ...props });
          callback();
        }).catch(error => {
          browser.runtime.lastError = error;
          callback();
          delete browser.runtime.lastError;
        });
      },
      async update(id, props) {
        await overrides.update?.(id, props);
        if (!items.has(id)) throw new Error(`Missing menu id ${id}`);
        Object.assign(items.get(id), props);
      },
      async remove(id) { items.delete(id); },
      async refresh() {},
      onShown: { addListener: fn => { listeners.shown = fn; } },
      onClicked: { addListener: fn => { listeners.clicked = fn; } },
      onHidden: { addListener: fn => { listeners.hidden = fn; } },
    },
    messengerUtilities: {
      parseMailboxString: overrides.parse || (async author => [{ email: author }]),
    },
    messages: {
      continueList: overrides.continueList || (async () => ({ id: null, messages: [] })),
      async abortList(id) { calls.aborts.push(id); },
    },
    senderToFilter: {
      async listFilters(folder, conditions) {
        calls.lists.push(plain({ folder, conditions }));
        return overrides.listFilters ? overrides.listFilters(folder, conditions) : [
          { index: 0, name: "Newsletters", enabled: true, eligible: true, present: "none" },
        ];
      },
      async addConditions(folder, target, conditions) {
        calls.adds.push(plain({ folder, target, conditions }));
        return overrides.addConditions ? overrides.addConditions(folder, target, conditions) :
          { status: "ok", added: conditions.map(c => c.value), existing: [] };
      },
      async openNewFilter(...args) { calls.new.push(plain(args)); },
      async openFilterManager(...args) { calls.manage.push(plain(args)); },
    },
    notifications: { async create(notification) { calls.notifications.push(plain(notification)); } },
  };
  const sandbox = { browser, console: { error: (...args) => calls.errors.push(args) } };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, "background.js"), "utf8"), sandbox);
  const defaultTab = { id: 7, windowId: 42 };
  return {
    browser, items, calls, storage,
    shown: (messages, tab = defaultTab, id = null) => listeners.shown({ contexts: ["message_list"], selectedMessages: { messages, id } }, tab),
    click: (menuItemId, extras = {}, tab = defaultTab) => listeners.clicked({ menuItemId, ...extras }, tab),
    hide: () => listeners.hidden(),
    row: prefix => [...items.values()].find(item => item.id.startsWith(prefix)),
  };
}

function message(author = "new@example.com", accountId = "account1", path = "/Inbox") {
  return { id: 1, author, folder: { accountId, path } };
}

module.exports = { root, plain, deferred, tick, term, filter, experiment, background, message };
