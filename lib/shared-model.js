/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use strict";

// Portable data and transitions only. This module never reads storage, resolves
// folders, opens native lists, or authorizes an uninspected native write.
(function (exports) {
  const STORAGE_KEY = "sharedFiltersV1";
  const SCHEMA_VERSION = 1;
  const MAX_INTENT_BYTES = 4 * 1024 * 1024;
  const UUID_TEXT = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
  const UUID = new RegExp(`^${UUID_TEXT}(?![\\s\\S])`, "u");
  // Unlike $, the final assertion cannot match before a trailing newline.
  const MARKER = new RegExp(` \\[stf-shared:v1:(${UUID_TEXT}):(${UUID_TEXT})\\](?![\\s\\S])`, "iu");
  const HASH = /^sha256:[0-9a-f]{64}(?![\s\S])/u;
  const EXECUTION_BITS = Object.freeze({ InboxRule: 1, Manual: 16, PostPlugin: 32, PostOutgoing: 64, Archive: 128, Periodic: 256 });
  const EXECUTION_MASK = Object.values(EXECUTION_BITS).reduce((mask, bit) => mask | bit, 0);
  const ACTION_FIELDS = Object.freeze({
    MoveToFolder: "slotId", CopyToFolder: "slotId", AddTag: "tagKey",
    ChangePriority: "priority", JunkScore: "junkScore", MarkRead: null,
    MarkUnread: null, MarkFlagged: null, Delete: null, StopExecution: null,
    KillThread: null, KillSubthread: null, WatchThread: null,
  });
  // nsMsgFilterCore.idl; the adapter also validates the installed native values.
  const NATIVE_ACTIONS = Object.freeze({ MoveToFolder: 1, ChangePriority: 2, Delete: 3, MarkRead: 4,
    KillThread: 5, WatchThread: 6, MarkFlagged: 7, StopExecution: 11, JunkScore: 14,
    CopyToFolder: 16, AddTag: 17, KillSubthread: 18, MarkUnread: 19 });
  const TARGET_STATUSES = ["pending", "applied", "failed", "conflict", "unavailable", "uncertain"];
  const MEMBER_STATUSES = ["current", "updating", "pending-retry", "needs-review", "unavailable", "uncertain"];
  const KINDS = ["create", "update", "repair", "detach"];
  const MODES = ["create", "adopt", "replace", "detach"];
  const memberStatus = { pending: "updating", applied: "current", failed: "pending-retry",
    conflict: "needs-review", unavailable: "unavailable", uncertain: "uncertain" };
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const own = (object, key) => Object.hasOwn(object, key);

  class ModelError extends Error {
    constructor(code, path = "value") {
      // Never interpolate rule contents, account endpoints or folder URIs.
      super(`${code} at ${path}`);
      this.name = "SharedModelError";
      this.code = code;
      this.path = path;
    }
  }
  const fail = (code, path) => { throw new ModelError(code, path); };
  const requireValue = (condition, code, path) => { if (!condition) fail(code, path); };

  function wellFormed(value) {
    for (let i = 0; i < value.length; i++) {
      const unit = value.charCodeAt(i);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = value.charCodeAt(++i);
        if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
    }
    return true;
  }

  function canonicalJson(value) {
    const ancestors = new Set();
    function visit(item, depth) {
      requireValue(depth <= 64, "json-depth", "value");
      if (item === null || typeof item === "boolean") return JSON.stringify(item);
      if (typeof item === "string") {
        requireValue(wellFormed(item), "invalid-unicode", "value");
        return JSON.stringify(item);
      }
      if (typeof item === "number") {
        requireValue(Number.isFinite(item) && !Object.is(item, -0), "invalid-number", "value");
        return JSON.stringify(item);
      }
      requireValue(typeof item === "object" && !ancestors.has(item), "not-json", "value");
      const prototype = Object.getPrototypeOf(item);
      requireValue(Array.isArray(item) || prototype === null || Object.getPrototypeOf(prototype) === null,
        "not-json-object", "value");
      requireValue(Object.getOwnPropertySymbols(item).length === 0, "not-json", "value");
      ancestors.add(item);
      try {
        const descriptors = Object.getOwnPropertyDescriptors(item);
        const keys = Object.keys(descriptors);
        for (const key of keys) {
          requireValue(!["__proto__", "constructor", "prototype"].includes(key) && wellFormed(key), "invalid-key", "value");
          const descriptor = descriptors[key];
          requireValue(own(descriptor, "value") && (descriptor.enumerable || Array.isArray(item) && key === "length"),
            "not-json", "value");
        }
        if (Array.isArray(item)) {
          requireValue(keys.length === item.length + 1, "not-json-array", "value");
          const parts = [];
          for (let i = 0; i < item.length; i++) {
            requireValue(own(descriptors, i), "not-json-array", "value");
            parts.push(visit(descriptors[i].value, depth + 1));
          }
          return `[${parts.join(",")}]`;
        }
        return `{${keys.sort().map(key => `${JSON.stringify(key)}:${visit(descriptors[key].value, depth + 1)}`).join(",")}}`;
      } finally {
        ancestors.delete(item);
      }
    }
    return visit(value, 0);
  }

  const copy = value => JSON.parse(canonicalJson(value));
  const same = (a, b) => canonicalJson(a) === canonicalJson(b);
  const jsonByteLength = value => encoder.encode(canonicalJson(value)).byteLength;
  function record(value, keys, path, optional = []) {
    requireValue(value !== null && typeof value === "object" && !Array.isArray(value), "expected-object", path);
    requireValue(keys.every(key => own(value, key)) && Object.keys(value).every(key => keys.includes(key) || optional.includes(key)),
      "invalid-fields", path);
  }
  function string(value, path, allowEmpty = true) {
    requireValue(typeof value === "string" && wellFormed(value) && !value.includes("\0") && (allowEmpty || value.length > 0),
      "invalid-string", path);
  }
  const boolean = (value, path) => requireValue(typeof value === "boolean", "expected-boolean", path);
  const integer = (value, min, path, max = Number.MAX_SAFE_INTEGER) =>
    requireValue(Number.isSafeInteger(value) && value >= min && value <= max, "invalid-integer", path);
  const oneOf = (value, values, path) => requireValue(values.includes(value), "invalid-enum", path);
  const uuid = (value, path) => requireValue(typeof value === "string" && UUID.test(value), "invalid-uuid", path);
  const hash = (value, path) => requireValue(typeof value === "string" && HASH.test(value), "invalid-fingerprint", path);
  const array = (value, path, min = 0) => requireValue(Array.isArray(value) && value.length >= min, "invalid-array", path);
  const unique = (values, path) => requireValue(new Set(values).size === values.length, "duplicate-identity", path);
  function timestamp(value, path) {
    requireValue(typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value,
      "invalid-timestamp", path);
  }
  const errorCode = (value, path) => requireValue(typeof value === "string" && /^[a-z][a-z0-9-]{0,79}(?![\s\S])/u.test(value), "invalid-error-code", path);

  function validateFolder(value, path = "folder") {
    record(value, ["accountId", "path"], path);
    string(value.accountId, `${path}.accountId`, false);
    string(value.path, `${path}.path`, false);
    requireValue(value.path.startsWith("/") && value.path !== "/", "root-or-invalid-folder", path);
  }
  const folderAction = action => action.type === "MoveToFolder" || action.type === "CopyToFolder";

  function validateAction(value, path, materialized = false) {
    requireValue(value && own(ACTION_FIELDS, value.type), "unsupported-action", path);
    const field = materialized && folderAction(value) ? "destination" : ACTION_FIELDS[value.type];
    record(value, ["type", ...(field ? [field] : [])], path);
    if (field === "slotId") uuid(value.slotId, `${path}.slotId`);
    if (field === "destination") validateFolder(value.destination, `${path}.destination`);
    if (field === "tagKey") string(value.tagKey, `${path}.tagKey`, false);
    if (field === "priority") integer(value.priority, 2, `${path}.priority`, 6);
    if (field === "junkScore") oneOf(value.junkScore, [0, 100], `${path}.junkScore`);
  }

  function rule(value, path = "definition", materialized = false) {
    record(value, ["name", "description", "enabled", "filterType", "logic", "conditionText", "actions"], path);
    string(value.name, `${path}.name`, false);
    string(value.description, `${path}.description`);
    boolean(value.enabled, `${path}.enabled`);
    integer(value.filterType, 1, `${path}.filterType`, EXECUTION_MASK);
    requireValue((value.filterType & ~EXECUTION_MASK) === 0, "unsupported-execution-bits", `${path}.filterType`);
    oneOf(value.logic, ["single", "or", "and", "all"], `${path}.logic`);
    string(value.conditionText, `${path}.conditionText`, false);
    requireValue((value.logic === "all") === (value.conditionText === "ALL"), "inconsistent-all", path);
    // The native adapter must parse and round-trip this text, and prove its
    // advertised logic and scope. JS does not implement a second native parser.
    array(value.actions, `${path}.actions`, 1);
    value.actions.forEach((action, i) => validateAction(action, `${path}.actions[${i}]`, materialized));
    if (!materialized) unique(value.actions.filter(folderAction).map(action => action.slotId), `${path}.actions`);
  }
  function validateDefinition(value) {
    const result = copy(value);
    rule(result);
    return result;
  }

  function mappings(definition, value, path = "folderMappings") {
    const slots = definition.actions.filter(folderAction).map(action => action.slotId);
    record(value, slots, path);
    for (const slot of slots) validateFolder(value[slot], `${path}.${slot}`);
  }
  function materializeDefinition(definition, folderMappings) {
    const result = validateDefinition(definition);
    const selected = copy(folderMappings);
    mappings(result, selected);
    result.actions = result.actions.map(action => folderAction(action)
      ? { type: action.type, destination: selected[action.slotId] } : action);
    return result;
  }

  function reconcileFolderSlots(previous, previousMappings, edited, freshSlotIds = []) {
    const draft = copy(edited);
    rule(draft, "edited", true);
    const oldActions = previous === null ? [] : materializeDefinition(previous, previousMappings).actions.filter(folderAction);
    const folderActions = draft.actions.filter(folderAction);
    const unchanged = previous !== null && same(oldActions, folderActions);
    const slots = unchanged ? previous.actions.filter(folderAction).map(action => action.slotId) : copy(freshSlotIds);
    array(slots, "freshSlotIds");
    requireValue(slots.length === folderActions.length, "slot-count", "freshSlotIds");
    slots.forEach((slot, i) => uuid(slot, `freshSlotIds[${i}]`));
    unique(slots, "freshSlotIds");
    if (!unchanged && previous) {
      const oldIds = previous.actions.filter(folderAction).map(action => action.slotId);
      requireValue(slots.every(slot => !oldIds.includes(slot)), "reused-changed-slot", "freshSlotIds");
    }
    const referenceMappings = {};
    let index = 0;
    draft.actions = draft.actions.map(action => {
      if (!folderAction(action)) return action;
      const slotId = slots[index++];
      referenceMappings[slotId] = action.destination;
      return { type: action.type, slotId };
    });
    return { definition: validateDefinition(draft), referenceMappings, mappingReviewRequired: !unchanged &&
      (oldActions.length > 0 || folderActions.length > 0) };
  }

  function classifyConditions(value) {
    const terms = copy(value);
    array(terms, "terms");
    for (const [i, term] of terms.entries()) {
      const path = `terms[${i}]`;
      record(term, ["booleanAnd", "matchAll", "beginsGrouping", "endsGrouping"], path);
      boolean(term.booleanAnd, path);
      boolean(term.matchAll, path);
      for (const flag of ["beginsGrouping", "endsGrouping"]) {
        if (typeof term[flag] !== "boolean") integer(term[flag], 0, `${path}.${flag}`);
      }
    }
    let reason = null, logic = null;
    if (!terms.length) reason = "no-terms";
    else if (terms.some(term => term.beginsGrouping || term.endsGrouping)) reason = "grouped";
    else if (terms.some(term => term.matchAll)) {
      if (terms.length === 1) logic = "all";
      else reason = "mixed-all";
    } else if (terms.length === 1) logic = "single";
    else if (terms.slice(1).every(term => term.booleanAnd)) logic = "and";
    else if (terms.slice(1).every(term => !term.booleanAnd)) logic = "or";
    else reason = "mixed-connectors";
    return { shareable: reason === null, senderAddable: logic === "single" || logic === "or", logic, reason };
  }
  const canAppendSenders = definition => ["single", "or"].includes(validateDefinition(definition).logic);

  function parseOwnership(description) {
    string(description, "description");
    const match = MARKER.exec(description);
    if (match) return { status: "marked", description: description.slice(0, match.index),
      groupId: match[1].toLowerCase(), memberId: match[2].toLowerCase() };
    return { status: description.includes(" [stf-shared:") ? "malformed" : "unmarked", description };
  }
  function appendOwnership(description, groupId, memberId) {
    string(description, "description");
    uuid(groupId, "groupId");
    uuid(memberId, "memberId");
    return `${description} [stf-shared:v1:${groupId}:${memberId}]`;
  }
  function encodeDescription(description) {
    string(description, "description");
    return Array.from(encoder.encode(description), byte => String.fromCharCode(byte)).join("");
  }
  function decodeDescription(bytes) {
    string(bytes, "descriptionBytes");
    requireValue([...bytes].every(char => char.charCodeAt(0) <= 255), "not-byte-string", "descriptionBytes");
    try { return decoder.decode(Uint8Array.from(bytes, char => char.charCodeAt(0))); }
    catch { fail("invalid-description-encoding", "descriptionBytes"); }
  }

  async function fingerprint(value) {
    const bytes = encoder.encode(canonicalJson(value));
    const digest = await exports.crypto.subtle.digest("SHA-256", bytes);
    return `sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")}`;
  }
  async function fingerprintList(value) {
    const observed = copy(value);
    record(observed, ["loggingEnabled", "filters"], "list");
    boolean(observed.loggingEnabled, "list.loggingEnabled");
    array(observed.filters, "list.filters");
    observed.filters.forEach((filter, i) => boolean(filter?.temporary, `list.filters[${i}].temporary`));
    return fingerprint({ kind: "persistent-list", schemaVersion: SCHEMA_VERSION, loggingEnabled: observed.loggingEnabled,
      filters: observed.filters.filter(filter => !filter.temporary) });
  }

  function marker(value, path) {
    if (value === null) return;
    record(value, ["groupId", "memberId"], path);
    uuid(value.groupId, `${path}.groupId`);
    uuid(value.memberId, `${path}.memberId`);
  }
  function nativeRule(value, path) {
    record(value, ["name", "description", "enabled", "filterType", "temporary", "unparseable", "unparsedBuffer", "terms", "actions"], path);
    string(value.name, `${path}.name`);
    string(value.description, `${path}.description`);
    requireValue([...value.description].every(char => char.charCodeAt(0) <= 255), "not-byte-string", `${path}.description`);
    boolean(value.enabled, `${path}.enabled`);
    // Before snapshots may contain unsupported native edits. Never drop those
    // fields to force the rule into the supported portable-definition schema.
    integer(value.filterType, 0, `${path}.filterType`, 0x7fffffff);
    boolean(value.temporary, `${path}.temporary`);
    boolean(value.unparseable, `${path}.unparseable`);
    string(value.unparsedBuffer, `${path}.unparsedBuffer`);
    for (const key of ["terms", "actions"]) {
      array(value[key], `${path}.${key}`);
      value[key].forEach((item, i) => requireValue(item !== null && typeof item === "object" && !Array.isArray(item),
        "invalid-native-observation", `${path}.${key}[${i}]`));
    }
    for (const term of value.terms) {
      for (const key of ["text", "arbitraryHeader"]) string(term[key], `${path}.terms.${key}`);
      for (const key of ["attrib", "op"]) integer(term[key], -0x80000000, `${path}.terms.${key}`, 0x7fffffff);
      boolean(term.booleanAnd, `${path}.terms.booleanAnd`);
      boolean(term.matchAll, `${path}.terms.matchAll`);
      for (const key of ["beginsGrouping", "endsGrouping"]) {
        if (typeof term[key] !== "boolean") integer(term[key], 0, `${path}.terms.${key}`);
      }
    }
    for (const action of value.actions) integer(action.type, -0x80000000, `${path}.actions.type`, 0x7fffffff);
  }

  function afterMatchesDefinition(after, definition, path) {
    requireValue(after.name === definition.name && after.description === encodeDescription(definition.description) &&
      after.enabled === definition.enabled && after.filterType === definition.filterType, "after-definition-mismatch", path);
    const shape = classifyConditions(after.terms.map(({ booleanAnd, matchAll, beginsGrouping, endsGrouping }) =>
      ({ booleanAnd, matchAll, beginsGrouping, endsGrouping })));
    const text = shape.logic === "all" ? "ALL" : after.terms.map(term =>
      `${term.booleanAnd ? "AND" : "OR"} (${term.text})`).join(" ");
    requireValue(shape.shareable && shape.logic === definition.logic && text === definition.conditionText,
      "after-condition-mismatch", path);
    requireValue(after.actions.length === definition.actions.length, "after-actions-mismatch", path);
    after.actions.forEach((actual, i) => {
      const wanted = definition.actions[i];
      requireValue(actual.type === NATIVE_ACTIONS[wanted.type], "after-actions-mismatch", path);
      const field = folderAction(wanted) ? "targetFolderUri" : wanted.type === "AddTag" ? "strValue" : ACTION_FIELDS[wanted.type];
      record(actual, ["type", ...(field ? [field] : [])], `${path}.actions[${i}]`);
      if (field === "targetFolderUri") {
        string(actual.targetFolderUri, `${path}.actions[${i}].targetFolderUri`, false);
        // Resolving this URI from the member's FolderRef is a native-adapter
        // obligation; pages cannot submit arbitrary native URI destinations.
      } else if (field) requireValue(actual[field] === wanted[ACTION_FIELDS[wanted.type]], "after-action-value-mismatch", path);
    });
  }
  function replica(value, path = "replica") {
    record(value, ["accountId", "accountIdentityHash", "position", "marker", "rule"], path);
    string(value.accountId, `${path}.accountId`, false);
    hash(value.accountIdentityHash, `${path}.accountIdentityHash`);
    integer(value.position, 0, `${path}.position`);
    marker(value.marker, `${path}.marker`);
    nativeRule(value.rule, `${path}.rule`);
    requireValue(!value.rule.temporary, "temporary-replica", path);
  }
  function validateReplica(value) {
    const result = copy(value);
    replica(result);
    return result;
  }
  const sameReplica = (left, right) => left === null || right === null ? left === right :
    same({ ...left, position: 0 }, { ...right, position: 0 });

  function target(value, path = "target") {
    record(value, ["memberId", "mode", "before", "after", "expectedListFingerprint", "status"], path, ["errorCode", "cleanup"]);
    uuid(value.memberId, `${path}.memberId`);
    oneOf(value.mode, MODES, `${path}.mode`);
    oneOf(value.status, TARGET_STATUSES, `${path}.status`);
    hash(value.expectedListFingerprint, `${path}.expectedListFingerprint`);
    if (own(value, "errorCode")) errorCode(value.errorCode, `${path}.errorCode`);
    replica(value.after, `${path}.after`);
    if (value.mode === "create") requireValue(value.before === null, "creation-has-before", path);
    else replica(value.before, `${path}.before`);
    if (value.before) {
      requireValue(value.before.accountId === value.after.accountId && value.before.accountIdentityHash === value.after.accountIdentityHash,
        "account-binding-changed", path);
      requireValue(value.before.position === value.after.position, "existing-placement-changed", path);
      if (value.mode === "adopt") requireValue(value.before.marker === null, "adoption-already-marked", path);
      else requireValue(value.before.marker?.memberId === value.memberId, "missing-before-ownership", path);
      if (value.mode === "replace") requireValue(same(value.before.marker, value.after.marker), "ownership-changed", path);
    }
    if (value.mode === "detach") {
      requireValue(value.after.marker === null && same(value.before.rule, value.after.rule) && value.before.position === value.after.position,
        "detach-changes-rule", path);
    } else {
      requireValue(value.after.marker?.memberId === value.memberId && !value.after.rule.unparseable && !value.after.rule.unparsedBuffer,
        "invalid-after-ownership-or-rule", path);
    }
    if (own(value, "cleanup")) {
      array(value.cleanup, `${path}.cleanup`, 1);
      requireValue(value.before !== null, "cleanup-without-selection", path);
      for (const other of value.cleanup) {
        replica(other, `${path}.cleanup`);
        requireValue(other.accountId === value.after.accountId && other.accountIdentityHash === value.after.accountIdentityHash &&
          same(other.marker, value.after.marker || value.before.marker), "cleanup-binding-mismatch", path);
      }
      unique([value.before.position, ...value.cleanup.map(r => r.position)], `${path}.cleanup`);
    }
  }

  function member(value, definition, revision, path) {
    record(value, ["id", "accountId", "accountIdentityHash", "folderMappings", "positionHint", "lastAppliedRevision",
      "lastAppliedFingerprint", "status", "lastInspectedAt"], path);
    uuid(value.id, `${path}.id`);
    string(value.accountId, `${path}.accountId`, false);
    hash(value.accountIdentityHash, `${path}.accountIdentityHash`);
    mappings(definition, value.folderMappings, `${path}.folderMappings`);
    integer(value.positionHint, 0, `${path}.positionHint`);
    oneOf(value.status, MEMBER_STATUSES, `${path}.status`);
    if (value.lastAppliedRevision !== null) integer(value.lastAppliedRevision, 1, `${path}.lastAppliedRevision`, revision);
    if (value.lastAppliedFingerprint !== null) hash(value.lastAppliedFingerprint, `${path}.lastAppliedFingerprint`);
    requireValue((value.lastAppliedRevision === null) === (value.lastAppliedFingerprint === null), "incomplete-applied-state", path);
    if (value.status === "current") requireValue(value.lastAppliedRevision === revision && value.lastInspectedAt !== null,
      "stale-current-member", path);
    if (value.lastInspectedAt !== null) timestamp(value.lastInspectedAt, `${path}.lastInspectedAt`);
  }
  function summary(value, revision, path) {
    if (value === null) return;
    record(value, ["id", "kind", "revision", "completedAt", "appliedCount", "detachedCount", "diagnostics"], path);
    uuid(value.id, `${path}.id`);
    oneOf(value.kind, KINDS, `${path}.kind`);
    integer(value.revision, 1, `${path}.revision`, revision);
    timestamp(value.completedAt, `${path}.completedAt`);
    integer(value.appliedCount, 1, `${path}.appliedCount`);
    integer(value.detachedCount, 0, `${path}.detachedCount`, value.appliedCount);
    array(value.diagnostics, `${path}.diagnostics`);
    requireValue(value.diagnostics.length <= value.appliedCount, "oversized-summary", path);
    value.diagnostics.forEach((item, i) => {
      record(item, ["memberId", "errorCode"], `${path}.diagnostics[${i}]`);
      uuid(item.memberId, path);
      errorCode(item.errorCode, path);
    });
    unique(value.diagnostics.map(item => item.memberId), `${path}.diagnostics`);
  }

  function assertIntentSize(group) {
    const { id, revision, definition, members, operation } = group;
    const size = jsonByteLength({ id, revision, definition, members, operation });
    requireValue(size <= MAX_INTENT_BYTES, "intent-too-large", "operation");
    return size;
  }
  function assertCheckpointCapacity(group) {
    // Reserve bounded checkpoint growth before publishing intent. Otherwise a
    // save could succeed but adding its hash/timestamp/diagnostic would exceed
    // the journal limit and make every subsequent recovery checkpoint fail.
    const largest = copy(group);
    for (const member of largest.members) Object.assign(member, {
      lastAppliedRevision: group.revision, lastAppliedFingerprint: `sha256:${"f".repeat(64)}`,
      positionHint: Number.MAX_SAFE_INTEGER, status: "pending-retry", lastInspectedAt: "+275760-09-13T00:00:00.000Z",
    });
    for (const item of largest.operation.targets) Object.assign(item, {
      status: "unavailable", errorCode: "e".repeat(80),
    });
    return assertIntentSize(largest);
  }
  function group(value, key) {
    const path = "group";
    record(value, ["id", "revision", "definition", "members", "operation", "lastCompleted"], path);
    uuid(value.id, `${path}.id`);
    requireValue(value.id === key, "group-key-mismatch", path);
    integer(value.revision, 1, `${path}.revision`);
    rule(value.definition);
    array(value.members, `${path}.members`, 1);
    value.members.forEach((item, i) => member(item, value.definition, value.revision, `${path}.members[${i}]`));
    unique(value.members.map(item => item.id), `${path}.members`);
    unique(value.members.map(item => item.accountId), `${path}.members`);
    summary(value.lastCompleted, value.revision, `${path}.lastCompleted`);
    if (value.operation === null) return;
    const op = value.operation;
    record(op, ["id", "kind", "desiredRevision", "beforeDefinition", "targets", "startedAt"], "operation");
    uuid(op.id, "operation.id");
    oneOf(op.kind, KINDS, "operation.kind");
    requireValue(op.desiredRevision === value.revision, "operation-revision-mismatch", "operation");
    if (op.kind === "create") requireValue(op.beforeDefinition === null && value.revision === 1, "invalid-creation", "operation");
    else rule(op.beforeDefinition, "operation.beforeDefinition");
    timestamp(op.startedAt, "operation.startedAt");
    array(op.targets, "operation.targets", 1);
    requireValue(same(op.targets.map(item => item.memberId), value.members.map(item => item.id)), "target-membership-order", "operation.targets");
    op.targets.forEach((item, i) => {
      const path = `operation.targets[${i}]`;
      target(item, path);
      const binding = value.members[i];
      for (const snapshot of [item.before, item.after].filter(Boolean)) {
        requireValue(snapshot.accountId === binding.accountId && snapshot.accountIdentityHash === binding.accountIdentityHash &&
          (!snapshot.marker || snapshot.marker.groupId === value.id), "replica-binding-mismatch", path);
      }
      if (op.kind === "create") oneOf(item.mode, ["create", "adopt"], path);
      if (item.mode !== "detach") {
        afterMatchesDefinition(item.after.rule, value.definition, path);
      }
      requireValue(binding.status === memberStatus[item.status], "checkpoint-status-mismatch", path);
      if (item.status === "applied") requireValue(binding.lastAppliedRevision === value.revision, "checkpoint-revision-mismatch", path);
    });
    assertIntentSize(value);
  }

  function validateState(value) {
    const result = copy(value);
    record(result, ["schemaVersion", "groups"], "state");
    requireValue(result.schemaVersion === SCHEMA_VERSION, "unknown-schema-version", "state.schemaVersion");
    requireValue(result.groups !== null && typeof result.groups === "object" && !Array.isArray(result.groups), "invalid-groups", "state.groups");
    for (const [key, value] of Object.entries(result.groups)) group(value, key);
    return result;
  }
  function loadState(value, knownGroupIds = []) {
    try {
      array(knownGroupIds, "knownGroupIds");
      knownGroupIds.forEach(id => uuid(id, "knownGroupIds"));
      if (value === undefined && knownGroupIds.length === 0) {
        return { status: "ready", initialized: true, state: { schemaVersion: SCHEMA_VERSION, groups: {} } };
      }
      requireValue(value !== undefined, "missing-state", "state");
      return { status: "ready", initialized: false, state: validateState(value) };
    } catch (error) {
      return { status: "blocked", code: error instanceof ModelError ? error.code : "invalid-state", state: null, preserved: value };
    }
  }

  function resolveOwnership(descriptions, state, accountValue) {
    const stored = validateState(state);
    const account = copy(accountValue);
    record(account, ["accountId", "accountIdentityHash"], "account");
    string(account.accountId, "account.accountId", false);
    hash(account.accountIdentityHash, "account.accountIdentityHash");
    array(descriptions, "descriptions");
    const parsed = descriptions.map(parseOwnership);
    const counts = new Map();
    for (const item of parsed.filter(item => item.status === "marked")) {
      const key = `${item.groupId}:${item.memberId}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return parsed.map(item => {
      if (item.status === "unmarked") return { ...item, status: "unmanaged" };
      if (item.status === "malformed") return { ...item, status: "conflict", reason: "malformed-marker" };
      if (counts.get(`${item.groupId}:${item.memberId}`) > 1) return { ...item, status: "conflict", reason: "duplicate-marker" };
      const member = stored.groups[item.groupId]?.members.find(member => member.id === item.memberId);
      if (!member) return { ...item, status: "unlinked" };
      if (member.accountId !== account.accountId || member.accountIdentityHash !== account.accountIdentityHash) {
        return { ...item, status: "conflict", reason: "account-identity-changed" };
      }
      return { ...item, status: "managed" };
    });
  }

  function classifyRecovery(targetValue, observationValue) {
    const intended = copy(targetValue), observed = copy(observationValue);
    target(intended);
    const outcome = (status, action, reason = null) => ({ status, action, reason, stop: status === "conflict" || status === "uncertain" });
    if (observed.status === "unavailable" || observed.status === "unreadable") {
      record(observed, ["status"], "observation");
      return observed.status === "unavailable" ? outcome("unavailable", "wait", "account-unavailable") :
        outcome("uncertain", "wait", "disk-unreadable");
    }
    record(observed, ["status", "accountId", "accountIdentityHash", "listFingerprint", "replicas", "blocker"], "observation", ["cleanupPending"]);
    if (own(observed, "cleanupPending")) {
      boolean(observed.cleanupPending, "observation.cleanupPending");
      requireValue(Boolean(intended.cleanup), "unexpected-cleanup-observation", "observation");
    }
    oneOf(observed.status, ["ok"], "observation.status");
    string(observed.accountId, "observation.accountId", false);
    hash(observed.accountIdentityHash, "observation.accountIdentityHash");
    hash(observed.listFingerprint, "observation.listFingerprint");
    array(observed.replicas, "observation.replicas");
    observed.replicas.forEach((item, i) => replica(item, `observation.replicas[${i}]`));
    if (observed.accountId !== intended.after.accountId || observed.accountIdentityHash !== intended.after.accountIdentityHash) {
      return outcome("conflict", "review", "account-identity-changed");
    }
    if (observed.blocker !== null) {
      errorCode(observed.blocker, "observation.blocker");
      return observed.blocker === "editor-open" ? outcome("pending", "wait", observed.blocker) : outcome("conflict", "review", observed.blocker);
    }
    if (observed.replicas.length > 1) return outcome("conflict", "review", "ambiguous-replica");
    const current = observed.replicas[0] || null;
    if (!observed.cleanupPending && sameReplica(current, intended.after)) return outcome("applied", "checkpoint");
    if (current === null && intended.before !== null) return outcome("conflict", "review", "missing-replica");
    if (!sameReplica(current, intended.before)) return outcome("conflict", "review", "native-drift");
    if (intended.status === "applied") return outcome("conflict", "review", "changed-after-apply");
    if (observed.listFingerprint !== intended.expectedListFingerprint || current && current.position !== intended.before.position) {
      return outcome("pending", "reprepare", "list-changed");
    }
    return outcome(intended.status === "failed" ? "failed" : "pending", "retry");
  }

  function beginChange(stateValue, proposedValue, expectedRevision) {
    const state = validateState(stateValue), proposed = copy(proposedValue);
    group(proposed, proposed.id);
    const previous = state.groups[proposed.id];
    requireValue(proposed.operation !== null, "missing-intent", "group.operation");
    if (!previous) {
      requireValue(expectedRevision === null && proposed.revision === 1 && proposed.operation.kind === "create", "stale-revision", "group");
      requireValue(proposed.lastCompleted === null, "invalid-creation-summary", "group");
    } else {
      requireValue(previous.revision === expectedRevision && proposed.revision === previous.revision + 1, "stale-revision", "group");
      requireValue(previous.operation === null, "unfinished-operation", "group");
      requireValue(proposed.operation.id !== previous.lastCompleted?.id, "reused-operation-id", "operation.id");
      requireValue(proposed.operation.kind !== "create" && same(proposed.operation.beforeDefinition, previous.definition), "before-definition-mismatch", "group");
      requireValue(same(proposed.lastCompleted, previous.lastCompleted), "summary-changed", "group");
      if (["repair", "detach"].includes(proposed.operation.kind)) {
        requireValue(same(proposed.definition, previous.definition), "repair-changes-definition", "group");
      }
      for (const old of previous.members) {
        const next = proposed.members.find(item => item.id === old.id);
        requireValue(next && next.accountId === old.accountId && next.accountIdentityHash === old.accountIdentityHash,
          "member-removed-without-detach", "group.members");
        requireValue(next.lastAppliedRevision === old.lastAppliedRevision && next.lastAppliedFingerprint === old.lastAppliedFingerprint &&
          next.lastInspectedAt === old.lastInspectedAt, "applied-history-changed", "group.members");
      }
    }
    requireValue(proposed.operation.targets.every(item => item.status === "pending" && !own(item, "errorCode")), "nonpending-new-intent", "operation");
    proposed.operation.targets.forEach(item => {
      const old = previous?.members.find(member => member.id === item.memberId);
      if (item.cleanup) requireValue(old && ["repair", "detach"].includes(proposed.operation.kind), "unreviewed-cleanup", "operation");
      // A new reviewed repair may explicitly recreate/relink a missing member.
      // Recovery of an existing replacement never changes its recorded mode.
      oneOf(item.mode, old ? proposed.operation.kind === "repair" ? MODES : ["replace", "detach"] : ["create", "adopt"],
        "operation.targets.mode");
      const next = proposed.members.find(member => member.id === item.memberId);
      if (!old) requireValue(next.lastAppliedRevision === null && next.lastAppliedFingerprint === null && next.lastInspectedAt === null,
        "new-member-has-history", "group.members");
      requireValue(next.positionHint === item.after.position, "placement-mismatch", "operation.targets");
    });
    assertCheckpointCapacity(proposed);
    state.groups[proposed.id] = proposed;
    return validateState(state);
  }

  function pendingGroup(state, groupId, operationId) {
    uuid(groupId, "groupId");
    uuid(operationId, "operationId");
    const group = state.groups[groupId];
    requireValue(group?.operation?.id === operationId, "stale-operation", "operationId");
    return group;
  }
  async function checkpoint(stateValue, groupId, operationId, memberId, resultValue) {
    const state = validateState(stateValue), result = copy(resultValue);
    const group = pendingGroup(state, groupId, operationId);
    const item = group.operation.targets.find(target => target.memberId === memberId);
    requireValue(Boolean(item), "unknown-member", "memberId");
    record(result, ["status", "inspectedAt"], "result", ["snapshot", "errorCode"]);
    oneOf(result.status, TARGET_STATUSES.filter(status => status !== "pending"), "result.status");
    timestamp(result.inspectedAt, "result.inspectedAt");
    if (own(result, "errorCode")) errorCode(result.errorCode, "result.errorCode");
    const member = group.members.find(member => member.id === memberId);
    if (result.status === "applied") {
      replica(result.snapshot, "result.snapshot");
      requireValue(sameReplica(result.snapshot, item.after), "unverified-after-state", "result.snapshot");
      member.lastAppliedRevision = group.revision;
      member.lastAppliedFingerprint = await fingerprint(item.after.rule);
      member.positionHint = result.snapshot.position;
    } else {
      requireValue(!own(result, "snapshot") && own(result, "errorCode"), "invalid-failure-result", "result");
      requireValue(item.status !== "applied" || result.status !== "failed", "applied-target-regression", "result");
    }
    item.status = result.status;
    if (own(result, "errorCode")) item.errorCode = result.errorCode;
    else delete item.errorCode;
    member.status = memberStatus[result.status];
    member.lastInspectedAt = result.inspectedAt;
    return validateState(state);
  }

  function finishOperation(stateValue, groupId, operationId, completedAt) {
    const state = validateState(stateValue);
    const group = pendingGroup(state, groupId, operationId);
    timestamp(completedAt, "completedAt");
    const op = group.operation;
    requireValue(op.targets.every(item => item.status === "applied"), "unfinished-operation", "operation");
    const detached = op.targets.filter(item => item.mode === "detach").map(item => item.memberId);
    const completed = { id: op.id, kind: op.kind, revision: group.revision, completedAt,
      appliedCount: op.targets.length, detachedCount: detached.length,
      diagnostics: op.targets.filter(item => item.errorCode).map(item => ({ memberId: item.memberId, errorCode: item.errorCode })) };
    group.members = group.members.filter(member => !detached.includes(member.id));
    group.operation = null;
    group.lastCompleted = completed;
    if (!group.members.length) delete state.groups[groupId];
    return { state: validateState(state), summary: completed };
  }

  function operationProgress(groupValue) {
    const value = copy(groupValue);
    group(value, value.id);
    const counts = Object.fromEntries(TARGET_STATUSES.map(status => [status, 0]));
    for (const item of value.operation?.targets || []) counts[item.status]++;
    return { counts, complete: value.operation !== null && counts.applied === value.operation.targets.length,
      stop: counts.conflict > 0 || counts.uncertain > 0 };
  }

  exports.SenderToFilterSharedModel = Object.freeze({
    STORAGE_KEY, SCHEMA_VERSION, MAX_INTENT_BYTES, EXECUTION_BITS, ModelError,
    canonicalJson, jsonByteLength, fingerprint, fingerprintList, validateDefinition, validateReplica,
    validateState, loadState, materializeDefinition, reconcileFolderSlots, classifyConditions, canAppendSenders,
    parseOwnership, appendOwnership, encodeDescription, decodeDescription, resolveOwnership,
    assertIntentSize, classifyRecovery, beginChange, checkpoint, finishOperation, operationProgress,
  });
})(this);
