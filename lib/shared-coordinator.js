/* MPL-2.0. One queue and one durable storage key for all add-on filter writes. */
"use strict";
(function (exports) {
  exports.createSharedCoordinator = function ({ model: M, storage, native, now = () => new Date().toISOString(), uuid = () => crypto.randomUUID() }) {
    let state = null, blocked = null, queue = Promise.resolve(), initialized = false;
    let observations = {}, previews = new Map();
    const clone = value => JSON.parse(M.canonicalJson(value));
    const fail = code => { throw new M.ModelError(code); };
    function exclusive(action) {
      const result = queue.then(action);
      queue = result.catch(() => {});
      return result;
    }
    function requireReady() { if (!initialized || blocked) fail(blocked || "initializing"); }
    function getGroup(id, revision) {
      requireReady();
      const group = state.groups[id];
      if (!group || group.revision !== revision) fail("stale-revision");
      return group;
    }
    async function persist(next) {
      const validated = M.validateState(next);
      await storage.set({ [M.STORAGE_KEY]: validated });
      state = validated;
    }
    async function inspectAll() {
      requireReady();
      const next = {};
      for (const g of Object.values(state.groups)) next[g.id] = await native.inspectReplicas(clone(g));
      observations = next;
      return view();
    }
    function view() {
      return { blocked, state: state ? clone(state) : null, observations: clone(observations) };
    }
    async function run(groupId, retryFailures = true) {
      let group = state.groups[groupId];
      if (!group?.operation) return;
      if (!retryFailures && M.operationProgress(group).stop) return;
      const opId = group.operation.id;
      const preflight = await native.inspectReplicas(clone(group));
      const blocker = preflight.find(r => ["conflict", "uncertain"].includes(r.status));
      if (blocker) {
        // Inspect the whole group before resuming any member. A conflict found
        // on a later account must stop an earlier still-pending write too.
        await persist(await M.checkpoint(state, groupId, opId, blocker.memberId, {
          status: blocker.status, inspectedAt: blocker.inspectedAt,
          errorCode: blocker.reason || "needs-review",
        }));
        return;
      }
      for (const target of group.operation.targets) {
        group = state.groups[groupId];
        let result;
        if (!retryFailures && ["failed", "unavailable"].includes(target.status)) {
          const observed = (await native.inspectReplicas(clone(group))).find(r => r.memberId === target.memberId);
          if (observed?.status !== "applied") continue;
          result = { status: "applied", inspectedAt: observed.inspectedAt, snapshot: observed.snapshot };
        } else result = await native.applyReplica(clone(group), target.memberId);
        const next = await M.checkpoint(state, groupId, opId, target.memberId, result);
        // If this write fails, state still contains the last durable intent.
        // Stop here; the next explicit retry can discover the saved after state.
        await persist(next);
        if (["conflict", "uncertain"].includes(result.status)) break;
      }
      group = state.groups[groupId];
      if (M.operationProgress(group).complete) await persist(M.finishOperation(state, groupId, opId, now()).state);
    }
    async function start() {
      return exclusive(async () => {
        if (initialized) return view();
        const saved = await storage.get(M.STORAGE_KEY);
        const loaded = M.loadState(saved[M.STORAGE_KEY]);
        blocked = loaded.status === "blocked" ? loaded.code : null;
        state = loaded.state; initialized = true;
        if (blocked) return view();
        await inspectAll();
        for (const group of Object.values(state.groups)) if (group.operation) await run(group.id, false);
        return inspectAll();
      });
    }
    function memberEntries(g) {
      return g.members.map(m => ({ accountId: m.accountId, memberId: m.id, folderMappings: m.folderMappings }));
    }
    async function preview(requestValue) {
      return exclusive(async () => {
        requireReady();
        const request = clone(requestValue);
        let previous = null, basis = null;
        if (request.groupId) {
          const actual = getGroup(request.groupId, request.revision);
          basis = clone(actual);
          if (actual.operation && !request.resolve) fail("unfinished-operation");
          previous = clone(actual);
          // Explicit reviewed resolution replaces an unfinished journal in the
          // SAME storage write as its successor. No native writes precede it.
          if (request.resolve) previous.operation = null;
        }
        const definition = M.validateDefinition(request.definition);
        if (!Array.isArray(request.members)) fail("invalid-members");
        const change = { previous, definition, members: request.members,
          kind: !previous ? "create" : request.members.some(m => m.detach) ? "detach" :
            request.resolve && M.canonicalJson(definition) === M.canonicalJson(previous.definition) ? "repair" : "update",
          reviewed: Boolean(request.resolve) };
        const prepared = await native.prepareSharedChange(change);
        if (!prepared.ok) return prepared;
        const token = uuid();
        // Bound sensitive transient previews and expire them without timers.
        for (const [key, value] of previews) if (Date.now() - value.createdAt > 10 * 60 * 1000) previews.delete(key);
        if (previews.size >= 10) previews.delete(previews.keys().next().value);
        previews.set(token, { group: prepared.group, basis, previous, createdAt: Date.now() });
        return { ok: true, token, group: clone(prepared.group), previousRules: prepared.previousRules || [] };
      });
    }
    async function commit(token) {
      return exclusive(async () => {
        requireReady();
        const prepared = previews.get(token); previews.delete(token);
        if (!prepared || Date.now() - prepared.createdAt > 10 * 60 * 1000) fail("preview-expired");
        const { group, basis, previous } = prepared;
        if (basis && M.canonicalJson(state.groups[group.id]) !== M.canonicalJson(basis)) fail("stale-preview");
        if (!basis && state.groups[group.id]) fail("stale-preview");
        const observed = await native.inspectReplicas(clone(group));
        if (observed.some(r => !["retry", "checkpoint"].includes(r.action))) fail("stale-preview");
        const base = clone(state);
        if (previous) base.groups[group.id] = previous;
        const next = M.beginChange(base, group, previous?.revision ?? null);
        await persist(next);
        await run(group.id);
        return inspectAll();
      });
    }
    function retry(id, revision) {
      return exclusive(async () => { const group = getGroup(id, revision);
        if (group.operation) await run(id); return inspectAll(); });
    }
    function append(id, revision, conditions) {
      return exclusive(async () => {
        let group = getGroup(id, revision);
        const result = await native.appendRule(clone(group), clone(conditions));
        if (!result.added.length) {
          if (group.operation) await run(id);
          await inspectAll();
          return { ...view(), added: [], existing: result.existing, groupId: id };
        }
        if (group.operation) fail("unfinished-operation");
        const prepared = await native.prepareSharedChange({ previous: clone(group), definition: result.definition,
          members: memberEntries(group), kind: "update", reviewed: false });
        if (!prepared.ok) return { ...prepared, added: [], existing: result.existing };
        await persist(M.beginChange(state, prepared.group, revision));
        await run(id); await inspectAll();
        return { ...view(), added: result.added, existing: result.existing, groupId: id };
      });
    }
    async function menu(conditions) {
      return exclusive(async () => {
        requireReady(); await inspectAll();
        const rows = [];
        for (const g of Object.values(state.groups)) {
          const statuses = observations[g.id] || [];
          const current = statuses.length === g.members.length && statuses.every(r => r.status === "current") && !g.operation;
          let eligible = M.canAppendSenders(g.definition), present = "none";
          if (eligible) {
            try { const checked = await native.appendRule(clone(g), clone(conditions));
              present = !checked.added.length ? "all" : checked.existing.length ? "some" : "none";
            } catch { eligible = false; }
          }
          const blockedMember = statuses.some(s => ["conflict", "uncertain", "unavailable"].includes(s.status));
          rows.push({ id: g.id, revision: g.revision, name: g.definition.name, count: g.members.length,
            enabled: g.definition.enabled, eligible: eligible && !blockedMember && (!g.operation || present === "all"),
            present: current ? present : "none", pending: !current,
            reason: !M.canAppendSenders(g.definition) ? "sender-logic-unsupported" : blockedMember ? "needs-review" : null });
        }
        return rows;
      });
    }
    function forgetUnavailable(id, revision, memberId) {
      return exclusive(async () => {
        const group = getGroup(id, revision);
        const observations = await native.inspectReplicas(clone(group));
        const observed = observations.find(r => r.memberId === memberId);
        const target = group.operation?.targets.find(t => t.memberId === memberId);
        const absentCreation = target?.mode === "create" && observed?.snapshot === null &&
          (["retry", "reprepare"].includes(observed.action) || observed.reason === "changed-after-apply");
        if (!observed || !absentCreation && !["account-unavailable", "missing-replica"].includes(observed.reason)) fail("cleanup-required");
        const next = clone(state), g = next.groups[id];
        g.members = g.members.filter(m => m.id !== memberId);
        g.revision++;
        for (const m of g.members) if (m.status === "current") m.lastAppliedRevision = g.revision;
        if (g.operation) {
          g.operation.targets = g.operation.targets.filter(t => t.memberId !== memberId);
          g.operation.id = uuid(); g.operation.desiredRevision = g.revision;
          if (g.operation.kind === "create") { g.operation.kind = "update"; g.operation.beforeDefinition = clone(g.definition); }
        }
        if (!g.members.length) delete next.groups[id];
        await persist(next);
        if (state.groups[id]?.operation && M.operationProgress(state.groups[id]).complete) {
          await persist(M.finishOperation(state, id, state.groups[id].operation.id, now()).state);
        }
        return inspectAll();
      });
    }
    // Pages receive whitelisted domain actions, never raw privileged write intents.
    async function dispatch(message, sender, managerURL, extensionId) {
      if (sender?.id !== extensionId || sender.url?.split(/[?#]/u)[0] !== managerURL ||
          !message || message.channel !== "stf-shared" || typeof message.action !== "string") return undefined;
      try {
        const p = message.payload || {};
        switch (message.action) {
          case "load": return { ok: true, data: await exclusive(async () => blocked ? view() : inspectAll()) };
          case "accounts": return { ok: true, data: await exclusive(() => native.inspectAccounts()) };
          case "source": return { ok: true, data: await exclusive(() => native.readRule(p.accountId, p.selector)) };
          case "edit": return { ok: true, data: await native.editRuleDraft(p.accountId, M.validateDefinition(p.definition), clone(p.mappings), p.windowId ?? null) };
          case "preview": return { ok: true, data: await preview(p) };
          case "commit": return { ok: true, data: await commit(p.token) };
          case "retry": return { ok: true, data: await retry(p.id, p.revision) };
          case "forget": return { ok: true, data: await forgetUnavailable(p.id, p.revision, p.memberId) };
          default: fail("unknown-request");
        }
      } catch (error) { return { ok: false, error: error instanceof M.ModelError ? error.code : "operation-failed" }; }
    }
    return { start, view, scan: () => exclusive(inspectAll), exclusive, preview, commit, retry, append, menu, dispatch, forgetUnavailable };
  };
})(this);
