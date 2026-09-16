const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto, createHash } = require("node:crypto");

function model(crypto = webcrypto) {
  const context = vm.createContext({ crypto, TextEncoder, TextDecoder });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../lib/shared-model.js"), "utf8"), context);
  return context.SenderToFilterSharedModel;
}
const M = model();
const plain = value => JSON.parse(JSON.stringify(value));
const clone = plain;
const id = number => `${number.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
const G = id(1), A = id(2), B = id(3), OP = id(4), SLOT = id(5), SLOT2 = id(6);
const H = number => `sha256:${number.toString(16).repeat(64)}`;
const NOW = "2026-09-16T18:00:00.000Z";
const LATER = "2026-09-16T18:00:01.000Z";
const folder = (accountId = "account1", name = "Newsletters") => ({ accountId, path: `/${name}` });
const empty = () => ({ schemaVersion: 1, groups: {} });
const definition = () => ({ name: "Newsletters", description: 'Notes "quoted" 日本語', enabled: false,
  filterType: 17, logic: "single", conditionText: "OR (from,is,old@example.com)",
  actions: [{ type: "MarkRead" }, { type: "MoveToFolder", slotId: SLOT }] });
const shape = changes => ({ matchAll: false, booleanAnd: false, beginsGrouping: 0, endsGrouping: 0, ...changes });

function nativeRule(rule = definition(), accountId = "account1") {
  return { name: rule.name, description: M.encodeDescription(rule.description), enabled: rule.enabled, filterType: rule.filterType,
    temporary: false, unparseable: false, unparsedBuffer: "",
    terms: [{ text: "from,is,old@example.com", attrib: 1, op: 0, arbitraryHeader: "", ...shape() }],
    actions: [{ type: 4 }, { type: 1, targetFolderUri: `mailbox://${accountId}/Newsletters` }] };
}
function replica(memberId = A, rule = definition()) {
  const first = memberId === A;
  return { accountId: first ? "account1" : "account2", accountIdentityHash: H(first ? 1 : 2), position: first ? 2 : 7,
    marker: { groupId: G, memberId }, rule: nativeRule(rule, first ? "account1" : "account2") };
}
function proposal() {
  const rule = definition();
  return { id: G, revision: 1, definition: rule,
    members: [A, B].map(memberId => {
      const snapshot = replica(memberId);
      return { id: memberId, accountId: snapshot.accountId, accountIdentityHash: snapshot.accountIdentityHash,
        folderMappings: { [SLOT]: folder(snapshot.accountId) }, positionHint: snapshot.position,
        lastAppliedRevision: null, lastAppliedFingerprint: null, status: "updating", lastInspectedAt: null };
    }),
    operation: { id: OP, kind: "create", desiredRevision: 1, beforeDefinition: null, startedAt: NOW,
      targets: [A, B].map(memberId => ({ memberId, mode: "create", before: null, after: replica(memberId),
        expectedListFingerprint: H(3), status: "pending" })) }, lastCompleted: null };
}
function readyState() {
  const group = proposal();
  group.operation = null;
  for (const member of group.members) Object.assign(member, {
    lastAppliedRevision: 1, lastAppliedFingerprint: H(4), status: "current", lastInspectedAt: NOW,
  });
  return { schemaVersion: 1, groups: { [G]: group } };
}
function update(state = readyState(), kind = "update") {
  const previous = state.groups[G];
  const group = clone(previous);
  group.revision++;
  group.members.forEach(member => { member.status = "updating"; });
  group.operation = { id: id(8), kind, desiredRevision: group.revision, beforeDefinition: clone(previous.definition), startedAt: LATER,
    targets: group.members.map(member => ({ memberId: member.id, mode: "replace", before: replica(member.id),
      after: replica(member.id), expectedListFingerprint: H(3), status: "pending" })) };
  return group;
}
const stateWith = group => ({ schemaVersion: 1, groups: { [group.id]: group } });
const observation = (snapshot, changes = {}) => ({ status: "ok", accountId: "account1", accountIdentityHash: H(1),
  listFingerprint: H(3), replicas: snapshot ? [clone(snapshot)] : [], blocker: null, ...changes });
function rejects(code, callback) {
  assert.throws(callback, error => error.code === code, `Expected ${code}`);
}
async function rejectsAsync(code, callback) {
  await assert.rejects(callback, error => error.code === code, `Expected ${code}`);
}
function deepFreeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

test("module loads without browser APIs; serialization is stable without normalizing strings or arrays", () => {
  assert.equal(M.canonicalJson({ z: ["日本語", "a"], a: { y: 2, x: 1 } }), '{"a":{"x":1,"y":2},"z":["日本語","a"]}');
  assert.equal(M.canonicalJson({ b: 1, a: 2 }), M.canonicalJson({ a: 2, b: 1 }));
  assert.notEqual(M.canonicalJson(["a", "b"]), M.canonicalJson(["b", "a"]));
  assert.notEqual(M.canonicalJson("é"), M.canonicalJson("e\u0301"));
});

test("JSON boundaries reject ambiguous data without executing getters or toJSON", () => {
  let called = false;
  const getter = Object.defineProperty({}, "x", { enumerable: true, get() { called = true; return 1; } });
  const cyclic = {}; cyclic.self = cyclic;
  const sparse = []; sparse.length = 2;
  const decorated = [1]; decorated.extra = 2;
  for (const value of [undefined, NaN, Infinity, -0, 1n, () => {}, new Date(), new Map(), getter, cyclic, sparse, decorated,
    { x: undefined }, { toJSON() { called = true; return {}; } }, JSON.parse('{"__proto__":{}}'), "\ud800", "\udfff"]) {
    assert.throws(() => M.canonicalJson(value), error => error.name === "SharedModelError");
  }
  assert.equal(called, false);
  assert.equal(M.canonicalJson({ emoji: "📬" }), '{"emoji":"📬"}');
});

test("SHA-256 fingerprints match an independent digest and include every observed field", async () => {
  const input = { b: [1, "日本語"], a: true };
  const expected = "sha256:" + createHash("sha256").update('{"a":true,"b":[1,"日本語"]}').digest("hex");
  assert.equal(await M.fingerprint(input), expected);
  const original = nativeRule();
  for (const change of [
    rule => { rule.name += " renamed"; }, rule => { rule.description += " "; }, rule => { rule.enabled = true; },
    rule => { rule.filterType = 16; }, rule => { rule.terms[0].booleanAnd = true; },
    rule => { rule.terms[0].beginsGrouping = 1; }, rule => { rule.actions.reverse(); },
    rule => { rule.actions[1].targetFolderUri += "/Other"; },
  ]) {
    const modified = clone(original); change(modified);
    assert.notEqual(await M.fingerprint(original), await M.fingerprint(modified));
  }
});

test("persistent-list fingerprints preserve order and logging but exclude temporary runtime filters", async () => {
  const first = nativeRule(), second = { ...nativeRule(), name: "Other" };
  const list = { loggingEnabled: true, filters: [first, second] };
  const temporary = { ...nativeRule(), temporary: true, name: "Runtime only" };
  const original = await M.fingerprintList(list);
  assert.equal(original, await M.fingerprintList({ ...list, filters: [first, temporary, second] }));
  assert.notEqual(original, await M.fingerprintList({ ...list, loggingEnabled: false }));
  assert.notEqual(original, await M.fingerprintList({ ...list, filters: [second, first] }));
  assert.deepEqual(list.filters, [first, second]);
});

test("all supported discriminated actions validate and unsupported data is never dropped", () => {
  const rule = definition();
  rule.actions = [
    { type: "MoveToFolder", slotId: SLOT }, { type: "CopyToFolder", slotId: SLOT2 },
    { type: "AddTag", tagKey: "$label1" }, { type: "ChangePriority", priority: 5 }, { type: "JunkScore", junkScore: 100 },
    ...["MarkRead", "MarkUnread", "MarkFlagged", "Delete", "StopExecution", "KillThread", "KillSubthread", "WatchThread"]
      .map(type => ({ type })),
  ];
  assert.deepEqual(plain(M.validateDefinition(deepFreeze(rule))), rule);
  for (const action of [{ type: "Forward", address: "private@example.com" }, { type: "Custom" }, { type: "None" },
    { type: "AddTag", tagKey: "" }, { type: "ChangePriority", priority: 0 }, { type: "ChangePriority", priority: 7 },
    { type: "JunkScore", junkScore: 50 }, { type: "MarkRead", strValue: "unexpected" },
    { type: "MoveToFolder", targetFolderUri: "mailbox://untrusted/path" }]) {
    assert.throws(() => M.validateDefinition({ ...definition(), actions: [action] }), error => error.name === "SharedModelError");
  }
  const wrong = { ...definition(), actions: [{ type: "Forward", address: "private@example.com" }] };
  assert.throws(() => M.validateDefinition(wrong), error => !error.message.includes("private@example.com"));
});

test("only supported nonzero execution bits and exact ALL semantics are accepted", () => {
  for (const filterType of [1, 16, 32, 64, 128, 256, 497]) M.validateDefinition({ ...definition(), filterType });
  for (const filterType of [0, -1, 2, 4, 8, 15, 31, 512, 1.5, "17"]) {
    assert.throws(() => M.validateDefinition({ ...definition(), filterType }));
  }
  M.validateDefinition({ ...definition(), logic: "all", conditionText: "ALL" });
  rejects("inconsistent-all", () => M.validateDefinition({ ...definition(), conditionText: "ALL" }));
  rejects("inconsistent-all", () => M.validateDefinition({ ...definition(), logic: "all" }));
  assert.throws(() => M.validateDefinition({ ...definition(), actions: [] }));
});

test("sharing and sender addition have different condition-shape eligibility", () => {
  const cases = [
    [[shape({ booleanAnd: true })], "single", true, null],
    [[shape({ booleanAnd: true }), shape()], "or", true, null],
    [[shape(), shape({ booleanAnd: true })], "and", false, null],
    [[shape({ matchAll: true })], "all", false, null],
    [[], null, false, "no-terms"],
    [[shape({ beginsGrouping: 1 })], null, false, "grouped"],
    [[shape({ matchAll: true }), shape()], null, false, "mixed-all"],
    [[shape(), shape(), shape({ booleanAnd: true })], null, false, "mixed-connectors"],
  ];
  for (const [terms, logic, senderAddable, reason] of cases) {
    const before = clone(terms);
    assert.deepEqual(plain(M.classifyConditions(terms)), { shareable: reason === null, senderAddable, logic, reason });
    assert.deepEqual(terms, before);
  }
  assert.equal(M.canAppendSenders(definition()), true);
  assert.equal(M.canAppendSenders({ ...definition(), logic: "and" }), false);
  assert.equal(M.canAppendSenders({ ...definition(), logic: "all", conditionText: "ALL" }), false);
});

test("ownership suffixes preserve the exact description and accept UUID case without changing it", () => {
  for (const prefix of ["", " ", 'Notes "quoted" 日本語\n', "literal [stf-shared: reminder] text", "\ufeffLeading BOM"]) {
    const native = M.encodeDescription(prefix);
    const tagged = M.appendOwnership(native, G, A);
    const parsed = M.parseOwnership(tagged);
    assert.equal(parsed.status, "marked");
    assert.equal(parsed.description, native);
    assert.equal(M.decodeDescription(parsed.description), prefix);
    assert.equal(parsed.groupId, G);
  }
  const group = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  const marked = M.appendOwnership("text", group, A).replace(group, group.toUpperCase());
  assert.equal(M.parseOwnership(marked).groupId, group);
  assert.equal(M.parseOwnership("literal [stf-shared: reminder] text").description, "literal [stf-shared: reminder] text");
});

test("malformed, future-version and trailing-data markers are never stripped or treated as owned", () => {
  const valid = M.appendOwnership("description", G, A);
  for (const text of [valid + "\n", valid + " trailing", valid.replace(":v1:", ":v2:"), valid.slice(0, -1),
    valid.replace(G, "not-a-uuid"), valid.replace(G, "00000000-0000-0000-0000-000000000000")]) {
    const parsed = M.parseOwnership(text);
    assert.equal(parsed.status, "malformed");
    assert.equal(parsed.description, text);
  }
  assert.equal(M.parseOwnership("Just a description").status, "unmarked");
});

test("native description codec rejects undecodable bytes and preserves BOM, whitespace and UTF-8", () => {
  const text = '\ufeff  日本語, café, 📬, "quotes"\n';
  const bytes = M.encodeDescription(text);
  assert.deepEqual([...bytes].map(char => char.charCodeAt(0)), [...Buffer.from(text)]);
  assert.equal(M.decodeDescription(bytes), text);
  rejects("invalid-description-encoding", () => M.decodeDescription("\xff"));
  rejects("not-byte-string", () => M.decodeDescription("日本語"));
  rejects("invalid-string", () => M.encodeDescription("\ud800"));
});

test("ownership needs registered group/member/account identity and detects duplicates independently of names/order", () => {
  const state = readyState();
  const a = M.appendOwnership("Renamed filter description", G, A);
  const b = M.appendOwnership("Other", G, B);
  const account = { accountId: "account1", accountIdentityHash: H(1) };
  assert.equal(M.resolveOwnership([a], state, account)[0].status, "managed");
  assert.deepEqual(M.resolveOwnership([b, a], state, account).map(item => item.status), ["conflict", "managed"]);
  for (const entry of M.resolveOwnership([a, a], state, account)) assert.equal(entry.reason, "duplicate-marker");
  assert.equal(M.resolveOwnership([a], empty(), account)[0].status, "unlinked");
  assert.equal(M.resolveOwnership([a], state, { ...account, accountIdentityHash: H(9) })[0].reason, "account-identity-changed");
  assert.equal(M.resolveOwnership([a + "\n"], state, account)[0].reason, "malformed-marker");
  assert.equal(M.resolveOwnership(["Same name but no marker"], state, account)[0].status, "unmanaged");
});

test("missing storage initializes only without known groups; corrupt and future data are preserved", () => {
  assert.deepEqual(plain(M.loadState(undefined)), { status: "ready", initialized: true, state: empty() });
  assert.equal(M.loadState(undefined, [G]).code, "missing-state");
  for (const raw of [null, "bad JSON", [], { schemaVersion: 2, groups: {} }, { schemaVersion: 1 },
    { ...empty(), extra: true }, { schemaVersion: 1, groups: [] }]) {
    const result = M.loadState(raw);
    assert.equal(result.status, "blocked");
    assert.equal(result.state, null);
    assert.equal(result.preserved, raw);
  }
  const raw = readyState(), loaded = M.loadState(raw);
  assert.equal(loaded.status, "ready");
  loaded.state.groups[G].definition.name = "Only the copy";
  assert.equal(raw.groups[G].definition.name, "Newsletters");
});

test("state schemas reject inconsistent identity, revision, membership and journal state", () => {
  const mutations = [
    g => { g.id = id(99); }, g => { g.revision = 0; },
    g => { g.members[1].id = A; }, g => { g.members[1].accountId = "account1"; },
    g => { g.operation.targets.reverse(); }, g => { g.operation.desiredRevision = 2; },
    g => { g.operation.targets[0].after.marker.groupId = id(99); },
    g => { g.operation.targets[0].after.accountIdentityHash = H(9); },
    g => { g.operation.targets[0].after.rule.name = "Wrong desired definition"; },
    g => { g.members[0].status = "current"; },
    g => { g.members[0].lastAppliedFingerprint = H(4); },
    g => { g.operation.startedAt = "yesterday"; },
    g => { g.operation.targets[0].errorCode = "Private file /Users/example"; },
    g => { g.operation.unknown = "silently ignored?"; },
  ];
  for (const mutate of mutations) {
    const value = proposal(); mutate(value);
    assert.throws(() => M.validateState(stateWith(value)), error => error.name === "SharedModelError");
  }
});

test("folder mappings are explicit per account and per action, without source-URI fallback", () => {
  const def = definition();
  def.actions.push({ type: "CopyToFolder", slotId: SLOT2 });
  const selected = { [SLOT]: folder("account2", "Reading"), [SLOT2]: folder("local", "Archive") };
  const materialized = M.materializeDefinition(def, selected);
  assert.deepEqual(plain(materialized.actions.slice(1)), [
    { type: "MoveToFolder", destination: selected[SLOT] }, { type: "CopyToFolder", destination: selected[SLOT2] },
  ]);
  materialized.actions[1].destination.path = "/Changed";
  assert.equal(selected[SLOT].path, "/Reading");
  for (const map of [{}, { [SLOT]: folder() }, { ...selected, [id(99)]: folder() },
    { ...selected, [SLOT]: { accountId: "account1", path: "/" } },
    { ...selected, [SLOT]: { targetFolderUri: "mailbox://opaque" } }]) {
    assert.throws(() => M.materializeDefinition(def, map));
  }
  rejects("duplicate-identity", () => M.validateDefinition({ ...def,
    actions: [{ type: "MoveToFolder", slotId: SLOT }, { type: "CopyToFolder", slotId: SLOT }] }));
});

test("folder slots survive unrelated action insertion but changed/reordered destinations require new mappings", () => {
  const previous = definition();
  previous.actions.push({ type: "CopyToFolder", slotId: SLOT2 });
  const selected = { [SLOT]: folder(), [SLOT2]: folder("account1", "Copies") };
  const edited = plain(M.materializeDefinition(previous, selected));
  edited.actions.unshift({ type: "MarkFlagged" });
  const retained = M.reconcileFolderSlots(previous, selected, edited);
  assert.equal(retained.mappingReviewRequired, false);
  assert.deepEqual(plain(retained.referenceMappings), selected);
  assert.deepEqual(plain(retained.definition.actions.filter(a => a.slotId).map(a => a.slotId)), [SLOT, SLOT2]);
  edited.actions.reverse();
  const rebuilt = M.reconcileFolderSlots(previous, selected, edited, [id(10), id(11)]);
  assert.equal(rebuilt.mappingReviewRequired, true);
  assert.deepEqual(plain(rebuilt.referenceMappings), { [id(10)]: selected[SLOT2], [id(11)]: selected[SLOT] });
  rejects("reused-changed-slot", () => M.reconcileFolderSlots(previous, selected, edited, [SLOT, SLOT2]));
  rejects("slot-count", () => M.reconcileFolderSlots(previous, selected, edited));
  edited.actions = [{ type: "MarkRead" }];
  assert.equal(M.reconcileFolderSlots(previous, selected, edited).mappingReviewRequired, true);
  const first = M.reconcileFolderSlots(null, {}, M.materializeDefinition(definition(), { [SLOT]: folder() }), [id(12)]);
  assert.equal(first.mappingReviewRequired, true);
});

test("intent size uses actual UTF-8 JSON bytes, includes member mappings, and enforces the 4 MiB boundary", () => {
  const simple = { id: G, revision: 1, definition: { padding: "" }, members: [], operation: {} };
  const padding = M.MAX_INTENT_BYTES - M.assertIntentSize(simple);
  simple.definition.padding = "a".repeat(padding);
  assert.equal(M.assertIntentSize(simple), M.MAX_INTENT_BYTES);
  simple.definition.padding += "é";
  rejects("intent-too-large", () => M.assertIntentSize(simple));
  const value = { unicode: "日本語📬", escape: '"\\\n' };
  assert.equal(M.jsonByteLength(value), Buffer.byteLength(JSON.stringify(value)));
  const oversized = proposal();
  const text = "subject,contains," + "日本語".repeat(170000);
  oversized.definition.conditionText = `OR (${text})`;
  for (const target of oversized.operation.targets) {
    Object.assign(target.after.rule.terms[0], { text, attrib: 0, op: 0 });
  }
  rejects("intent-too-large", () => M.validateState(stateWith(oversized)));
});

test("identities, fingerprints and diagnostic codes reject trailing newlines", () => {
  rejects("invalid-uuid", () => M.appendOwnership("description", G + "\n", A));
  const badHash = proposal(); badHash.members[0].accountIdentityHash += "\n";
  rejects("invalid-fingerprint", () => M.validateState(stateWith(badHash)));
  const badCode = proposal(); badCode.operation.targets[0].errorCode = "save-failed\n";
  rejects("invalid-error-code", () => M.validateState(stateWith(badCode)));
});

test("intent publication reserves enough space for later hashes, timestamps and failure diagnostics", () => {
  const prepared = proposal();
  prepared.members.pop(); prepared.operation.targets.pop();
  const available = M.MAX_INTENT_BYTES - M.assertIntentSize(prepared);
  const padding = "a".repeat(Math.floor((available - 10) / 2));
  prepared.definition.conditionText = `OR (from,is,old@example.com${padding})`;
  prepared.operation.targets[0].after.rule.terms[0].text += padding;
  assert.ok(M.assertIntentSize(prepared) <= M.MAX_INTENT_BYTES);
  rejects("intent-too-large", () => M.beginChange(empty(), prepared, null));
});

test("after snapshots must retain desired condition shape, complete action order and payloads", () => {
  const changes = [
    rule => { rule.terms[0].text = "from,is,different@example.com"; },
    rule => { rule.terms[0].beginsGrouping = 1; },
    rule => { rule.terms[0].booleanAnd = true; },
    rule => { rule.terms[0].matchAll = true; },
    rule => { rule.actions.pop(); },
    rule => { rule.actions.reverse(); },
    rule => { rule.actions[0].strValue = "unknown data"; },
    rule => { rule.actions[1].targetFolderUri = ""; },
    rule => { rule.actions[0].type = -1; },
    rule => { rule.unparseable = true; },
    rule => { rule.description = "Unicode 日本語 without byte encoding"; },
  ];
  for (const change of changes) {
    const prepared = proposal(); change(prepared.operation.targets[0].after.rule);
    assert.equal(M.loadState(stateWith(prepared)).status, "blocked");
  }
  const typed = proposal();
  typed.definition.actions.push({ type: "AddTag", tagKey: "$label1" }, { type: "ChangePriority", priority: 5 },
    { type: "JunkScore", junkScore: 100 });
  for (const target of typed.operation.targets) {
    target.after.rule.actions.push({ type: 17, strValue: "$label1" }, { type: 2, priority: 5 }, { type: 14, junkScore: 100 });
  }
  M.validateState(stateWith(typed));
  for (const [index, field, value] of [[2, "strValue", "$label2"], [3, "priority", 2], [4, "junkScore", 0]]) {
    const wrong = clone(typed); wrong.operation.targets[0].after.rule.actions[index][field] = value;
    rejects("after-action-value-mismatch", () => M.validateState(stateWith(wrong)));
  }
});

test("new reviewed repairs can recreate or adopt a missing member; ordinary updates cannot", () => {
  const previous = readyState();
  for (const mode of ["create", "adopt"]) {
    const repair = update(previous, "repair");
    const target = repair.operation.targets[0];
    target.mode = mode;
    target.before = mode === "create" ? null : { ...replica(), marker: null };
    assert.equal(M.beginChange(previous, repair, 1).groups[G].operation.targets[0].mode, mode);
    const ordinary = clone(repair); ordinary.operation.kind = "update";
    rejects("invalid-enum", () => M.beginChange(previous, ordinary, 1));
  }
  const moved = update(previous);
  moved.operation.targets[0].after.position++;
  rejects("existing-placement-changed", () => M.beginChange(previous, moved, 1));
});

test("native before snapshots retain unsupported custom fields and unparsed bytes for conflict comparison", () => {
  const prepared = update();
  const before = prepared.operation.targets[0].before.rule;
  before.actions = [{ type: -1, customId: "foreign-addon", strValue: "opaque value" }];
  before.terms[0].beginsGrouping = 2;
  before.unparseable = true;
  before.unparsedBuffer = 'name="native bytes"\n';
  const state = M.validateState(stateWith(prepared));
  assert.deepEqual(plain(state.groups[G].operation.targets[0].before.rule), before);
  const target = state.groups[G].operation.targets[0];
  assert.equal(M.classifyRecovery(target, observation(target.before)).action, "retry");
  const changed = clone(target.before); changed.rule.actions[0].strValue = "edited";
  assert.equal(M.classifyRecovery(target, observation(changed)).reason, "native-drift");
});

test("recovery recognizes saved after state without repeating writes, even after checkpoint failure", () => {
  const target = update().operation.targets[0];
  target.after.rule.terms.push({ text: "from,is,new@example.com", attrib: 1, op: 0, arbitraryHeader: "", ...shape() });
  const movedAfter = clone(target.after); movedAfter.position = 99;
  const result = M.classifyRecovery(target, observation(movedAfter, { listFingerprint: H(8) }));
  assert.deepEqual(plain(result), { status: "applied", action: "checkpoint", reason: null, stop: false });
  target.status = "failed";
  assert.equal(M.classifyRecovery(target, observation(target.after)).status, "applied");
});

test("recovery retries only exact before state and requires re-preparation after list/position changes", () => {
  const target = update().operation.targets[0];
  target.after.rule.terms.push({ text: "from,is,new@example.com", attrib: 1, op: 0, arbitraryHeader: "", ...shape() });
  assert.equal(M.classifyRecovery(target, observation(target.before)).action, "retry");
  assert.equal(M.classifyRecovery(target, observation(target.before, { listFingerprint: H(9) })).action, "reprepare");
  const movedBefore = clone(target.before); movedBefore.position++;
  assert.equal(M.classifyRecovery(target, observation(movedBefore)).action, "reprepare");
  target.status = "failed";
  assert.equal(M.classifyRecovery(target, observation(target.before)).status, "failed");
  target.status = "applied";
  assert.equal(M.classifyRecovery(target, observation(target.before)).reason, "changed-after-apply");
});

test("missing managed copies are never recreated; only a recorded creation can resume from absence", () => {
  const replacement = update().operation.targets[0];
  assert.equal(M.classifyRecovery(replacement, observation(null)).reason, "missing-replica");
  const creation = proposal().operation.targets[0];
  assert.equal(M.classifyRecovery(creation, observation(null)).action, "retry");
  assert.equal(M.classifyRecovery(creation, observation(null, { listFingerprint: H(9) })).action, "reprepare");
  creation.status = "applied";
  assert.equal(M.classifyRecovery(creation, observation(null)).reason, "changed-after-apply");
  const adoption = { ...creation, status: "pending", mode: "adopt", before: { ...replica(), marker: null } };
  assert.equal(M.classifyRecovery(adoption, observation(null)).reason, "missing-replica");
});

test("identity conflicts, missing markers, ambiguous candidates and unreadable persistence stop recovery", () => {
  const target = update().operation.targets[0];
  const unmarked = { ...clone(target.after), marker: null };
  const observations = [
    observation(target.after, { accountIdentityHash: H(9) }), observation(unmarked),
    observation(target.after, { replicas: [target.after, target.after] }),
    observation(target.after, { blocker: "malformed-marker" }),
    observation(target.after, { blocker: "live-disk-conflict" }), { status: "unreadable" },
  ];
  for (const current of observations) assert.equal(M.classifyRecovery(target, current).stop, true);
  assert.deepEqual(plain(M.classifyRecovery(target, { status: "unavailable" })),
    { status: "unavailable", action: "wait", reason: "account-unavailable", stop: false });
  assert.equal(M.classifyRecovery(target, observation(target.after, { blocker: "editor-open" })).action, "wait");
});

test("creation publishes one independent desired state/intent without changing its inputs", () => {
  const before = deepFreeze(empty()), proposed = deepFreeze(proposal());
  const started = M.beginChange(before, proposed, null);
  assert.deepEqual(plain(before), empty());
  assert.deepEqual(plain(started), stateWith(proposed));
  started.groups[G].definition.name = "Only the returned state";
  assert.equal(proposed.definition.name, "Newsletters");
});

test("new changes reject stale revisions, unfinished intent, forged history and silent member removal", () => {
  const previous = readyState(), next = update(previous);
  assert.equal(M.beginChange(previous, next, 1).groups[G].revision, 2);
  rejects("stale-revision", () => M.beginChange(previous, next, 0));
  const pending = M.beginChange(empty(), proposal(), null);
  rejects("unfinished-operation", () => M.beginChange(pending, update(pending), 1));
  const removed = update(previous);
  removed.members.pop(); removed.operation.targets.pop();
  rejects("member-removed-without-detach", () => M.beginChange(previous, removed, 1));
  const forged = update(previous); forged.members[0].lastAppliedFingerprint = H(9);
  rejects("applied-history-changed", () => M.beginChange(previous, forged, 1));
  const newHistory = proposal();
  newHistory.members[0].lastAppliedRevision = 1; newHistory.members[0].lastAppliedFingerprint = H(4);
  rejects("new-member-has-history", () => M.beginChange(empty(), newHistory, null));
});

test("partial success survives JSON restart, failure, retry and completion without rolling back earlier members", async () => {
  const intended = proposal();
  const started = M.beginChange(empty(), intended, null);
  let state = await M.checkpoint(started, G, OP, A, { status: "applied", inspectedAt: NOW, snapshot: replica(A) });
  assert.equal(started.groups[G].members[0].lastAppliedRevision, null);
  state = await M.checkpoint(state, G, OP, B, { status: "failed", inspectedAt: NOW, errorCode: "save-failed" });
  const progress = M.operationProgress(state.groups[G]);
  assert.equal(progress.counts.applied, 1);
  assert.equal(progress.counts.failed, 1);
  assert.equal(progress.stop, false);
  rejects("unfinished-operation", () => M.finishOperation(state, G, OP, LATER));
  const restarted = M.loadState(JSON.parse(JSON.stringify(state))).state;
  assert.equal(M.classifyRecovery(restarted.groups[G].operation.targets[0], observation(replica(A))).action, "checkpoint");
  const savedAfterError = { status: "applied", inspectedAt: LATER, snapshot: replica(B), errorCode: "save-reported-error" };
  state = await M.checkpoint(restarted, G, OP, B, savedAfterError);
  const finished = M.finishOperation(state, G, OP, LATER);
  assert.equal(finished.state.groups[G].operation, null);
  assert.equal(finished.summary.appliedCount, 2);
  assert.equal(finished.summary.diagnostics[0].errorCode, "save-reported-error");
  assert.equal(finished.state.groups[G].members[0].lastAppliedRevision, 1);
  assert.equal(finished.state.groups[G].members[0].lastAppliedFingerprint, await M.fingerprint(replica(A).rule));
  assert.equal("beforeDefinition" in finished.summary, false);
  assert.ok(state.groups[G].operation, "finishing returns a new state for the later storage write");
});

test("checkpoints reject stale results and unverified saved rules; conflicts and uncertainty stop further writes", async () => {
  const state = M.beginChange(empty(), proposal(), null);
  const wrong = replica(); wrong.rule.actions.reverse();
  await rejectsAsync("unverified-after-state", () => M.checkpoint(state, G, OP, A, { status: "applied", inspectedAt: NOW, snapshot: wrong }));
  await rejectsAsync("stale-operation", () => M.checkpoint(state, G, id(99), A, { status: "applied", inspectedAt: NOW, snapshot: replica() }));
  for (const status of ["conflict", "uncertain"]) {
    const changed = await M.checkpoint(state, G, OP, A, { status, inspectedAt: NOW, errorCode: "native-state-changed" });
    assert.equal(M.operationProgress(changed.groups[G]).stop, true);
    assert.equal(state.groups[G].operation.targets[0].status, "pending");
  }
  const saved = await M.checkpoint(state, G, OP, A, { status: "applied", inspectedAt: NOW, snapshot: replica() });
  await rejectsAsync("applied-target-regression", () => M.checkpoint(saved, G, OP, A, { status: "failed", inspectedAt: NOW, errorCode: "save-failed" }));
});

test("checkpoint snapshots are captured before awaiting the digest", async () => {
  let release;
  const delayed = model({ subtle: { digest: async (...args) => {
    await new Promise(resolve => { release = resolve; });
    return webcrypto.subtle.digest(...args);
  } } });
  const state = M.beginChange(empty(), proposal(), null);
  const result = { status: "applied", inspectedAt: NOW, snapshot: replica() };
  const pending = delayed.checkpoint(state, G, OP, A, result);
  state.groups[G].definition.name = "racing mutation";
  result.snapshot.rule.name = "racing result";
  release();
  const recorded = await pending;
  assert.equal(recorded.groups[G].definition.name, "Newsletters");
  assert.equal(recorded.groups[G].members[0].lastAppliedFingerprint, await M.fingerprint(replica().rule));
});

test("detaching keeps each native rule intact and retains membership until cleanup is verified", async () => {
  const previous = readyState(), next = update(previous, "detach");
  for (const target of next.operation.targets) {
    target.mode = "detach";
    target.after.marker = null;
  }
  const corrupt = clone(next); corrupt.operation.targets[0].after.rule.enabled = true;
  rejects("detach-changes-rule", () => M.beginChange(previous, corrupt, 1));
  let state = M.beginChange(previous, next, 1);
  const firstAfter = next.operation.targets[0].after;
  assert.equal(M.classifyRecovery(next.operation.targets[0], observation(firstAfter)).status, "applied");
  state = await M.checkpoint(state, G, next.operation.id, A, { status: "applied", inspectedAt: LATER, snapshot: firstAfter });
  assert.equal(state.groups[G].members.length, 2);
  rejects("unfinished-operation", () => M.finishOperation(state, G, next.operation.id, LATER));
  state = await M.checkpoint(state, G, next.operation.id, B,
    { status: "applied", inspectedAt: LATER, snapshot: next.operation.targets[1].after });
  const finished = M.finishOperation(state, G, next.operation.id, LATER);
  assert.equal(finished.state.groups[G], undefined);
  assert.equal(finished.summary.detachedCount, 2);
  assert.deepEqual(next.operation.targets[0].before.rule, next.operation.targets[0].after.rule);
  assert.equal(previous.groups[G].members.length, 2);
});

test("detaching one member keeps the other and a compact completion record", async () => {
  const previous = readyState(), next = update(previous, "detach");
  next.operation.targets[0].mode = "detach";
  next.operation.targets[0].after.marker = null;
  let state = M.beginChange(previous, next, 1);
  for (const target of next.operation.targets) {
    state = await M.checkpoint(state, G, next.operation.id, target.memberId,
      { status: "applied", inspectedAt: LATER, snapshot: target.after });
  }
  const finished = M.finishOperation(state, G, next.operation.id, LATER);
  assert.deepEqual(plain(finished.state.groups[G].members.map(member => member.id)), [B]);
  assert.equal(finished.state.groups[G].members[0].lastAppliedRevision, 2);
  assert.equal(finished.state.groups[G].lastCompleted.detachedCount, 1);
});
