/* MPL-2.0. Shared-filter adapter. The injected host owns XPCOM and file I/O. */
"use strict";
(function (exports) {
  exports.createSharedAdapter = function (M, host, normalizeConditions) {
    const clone = value => JSON.parse(M.canonicalJson(value));
    const same = (a, b) => M.canonicalJson(a) === M.canonicalJson(b);
    const fail = code => { throw new M.ModelError(code); };
    const safeCode = error => error instanceof M.ModelError ? error.code : "native-io-failed";
    const currentTime = () => new Date().toISOString();
    function split(raw) {
      const mark = M.parseOwnership(raw.description);
      if (mark.status === "malformed") fail("malformed-marker");
      return { marker: mark.status === "marked" ? { groupId: mark.groupId, memberId: mark.memberId } : null,
        rule: { ...raw, description: mark.description } };
    }
    const join = replica => ({ ...replica.rule, description: replica.marker ?
      M.appendOwnership(replica.rule.description, replica.marker.groupId, replica.marker.memberId) : replica.rule.description });
    async function inspect(accountId, expectedIdentity = null) {
      const a = host.account(accountId);
      const identity = await M.fingerprint(a.identity);
      if (expectedIdentity && identity !== expectedIdentity) fail("account-identity-changed");
      const reason = host.reason(a); if (reason) fail(reason);
      if (host.openWindow(a)) fail("editor-open");
      const disk = host.read(a);
      // Never initialize a missing account list during discovery. Existing
      // normalized files may be loaded only after the byte-preserving probe.
      if (disk.bytes) {
        const live = host.live(a, disk.bytes);
        if (!same(host.snapshotList(live), disk.list)) fail("live-disk-conflict");
      }
      const fingerprint = await M.fingerprintList(disk.list);
      const replicas = disk.list.filters.map((raw, position) => ({ accountId, accountIdentityHash: identity, position, ...split(raw) }));
      return { a, disk, fingerprint, identity, replicas };
    }
    function selected(observed, selector) {
      if (selector?.kind === "owned") {
        const found = observed.replicas.filter(r => r.marker?.groupId === selector.groupId && r.marker?.memberId === selector.memberId);
        if (found.length !== 1) fail(found.length ? "duplicate-marker" : "missing-replica");
        return found[0];
      }
      if (selector?.kind !== "explicit" || !Number.isSafeInteger(selector.index)) fail("invalid-selector");
      const r = observed.replicas[selector.index];
      if (!r || r.rule.name !== selector.name) fail("stale-selection");
      return r;
    }
    async function readRule(accountId, selector) {
      const observed = await inspect(accountId);
      const r = selected(observed, clone(selector));
      const fingerprint = await M.fingerprint(r.rule);
      if (selector.kind === "explicit" && selector.fingerprint !== fingerprint) fail("stale-selection");
      const exported = host.exportRule(join(r));
      const rebuilt = host.build(observed.a, exported.definition, exported.mappings, r.marker);
      if (!same(split(rebuilt.raw).rule, r.rule)) fail("condition-round-trip");
      return { ...exported, snapshot: r, fingerprint, listFingerprint: observed.fingerprint };
    }
    async function inspectAccounts() {
      const result = [];
      for (const accountId of host.accounts()) {
        let a;
        try {
          a = host.account(accountId);
          const o = await inspect(accountId);
          const filters = [];
          for (const r of o.replicas) {
            let reason = null;
            try { const e = host.exportRule(join(r));
              if (!same(split(host.build(a, e.definition, e.mappings, r.marker).raw).rule, r.rule)) fail("condition-round-trip");
            } catch (error) { reason = safeCode(error); }
            filters.push({ index: r.position, name: r.rule.name, enabled: r.rule.enabled, marker: r.marker,
              fingerprint: await M.fingerprint(r.rule), reason });
          }
          result.push({ accountId, name: a.name, type: a.type, identity: o.identity, reason: null, filters });
        } catch (error) {
          result.push({ accountId, name: a?.name || accountId, type: a?.type || "unknown", reason: safeCode(error), filters: [] });
        }
      }
      return { accounts: result, folders: host.folderChoices(), tags: host.tagChoices?.() || [] };
    }
    async function observeTarget(target) {
      const o = await inspect(target.after.accountId, target.after.accountIdentityHash);
      const marker = target.mode === "detach" ? target.before.marker : target.after.marker;
      const marked = o.replicas.filter(r => same(r.marker, marker));
      let candidates = marked;
      let blocker = null;
      let cleanupPending = false;
      if (target.cleanup) {
        const before = [target.before, ...target.cleanup];
        if (o.fingerprint === target.expectedListFingerprint && before.every(r => same(o.replicas[r.position], r))) {
          candidates = [o.replicas[target.before.position]];
          cleanupPending = true;
        } else {
          // All extra copies must retain their complete rules with only their
          // ownership removed. Match each once, even when copies are identical.
          const remaining = o.replicas.filter(r => !r.marker);
          const wanted = target.mode === "detach" ? [target.after, ...target.cleanup] : target.cleanup;
          let chosen = null;
          for (const r of wanted) {
            const i = remaining.findIndex(current => same(current.rule, r.rule));
            if (i < 0) { blocker = "duplicate-cleanup-changed"; break; }
            const [found] = remaining.splice(i, 1); if (r === target.after) chosen = found;
          }
          if (!blocker) candidates = target.mode === "detach" ? marked.length ? marked : [chosen] : marked;
        }
      }
      if (!target.cleanup && !candidates.length && ["adopt", "detach"].includes(target.mode)) {
        const expected = target.mode === "adopt" ? target.before : target.after;
        candidates = o.replicas.filter(r => !r.marker && same(r.rule, expected.rule));
      }
      return { o, observation: { status: "ok", accountId: o.a.id, accountIdentityHash: o.identity,
        listFingerprint: o.fingerprint, replicas: candidates, blocker, ...(target.cleanup ? { cleanupPending } : {}) } };
    }
    async function inspectReplicas(groupValue) {
      const g = M.validateState({ schemaVersion: 1, groups: { [groupValue.id]: groupValue } }).groups[groupValue.id];
      const results = [];
      for (const member of g.members) {
        try {
          if (g.operation) {
            const target = g.operation.targets.find(t => t.memberId === member.id);
            const { observation } = await observeTarget(target);
            if (target.mode !== "detach") {
              const a = host.account(member.accountId);
              if (!same(split(host.build(a, g.definition, member.folderMappings, target.after.marker).raw),
                { marker: target.after.marker, rule: target.after.rule })) fail("dependency-changed");
            }
            results.push({ memberId: member.id, ...M.classifyRecovery(target, observation), inspectedAt: currentTime(),
              snapshot: observation.replicas.length === 1 ? observation.replicas[0] : null });
          } else {
            const o = await inspect(member.accountId, member.accountIdentityHash);
            const r = selected(o, { kind: "owned", groupId: g.id, memberId: member.id });
            const expected = split(host.build(o.a, g.definition, member.folderMappings, r.marker).raw).rule;
            const matches = same(r.rule, expected) && await M.fingerprint(r.rule) === member.lastAppliedFingerprint;
            results.push({ memberId: member.id, status: matches ? "current" : "conflict", reason: matches ? null : "native-drift",
              inspectedAt: currentTime(), snapshot: r });
          }
        } catch (error) {
          const reason = safeCode(error);
          results.push({ memberId: member.id, status: reason === "account-unavailable" ? "unavailable" : "conflict",
            reason, inspectedAt: currentTime(), snapshot: null });
        }
      }
      return results;
    }
    async function prepare(changeValue) {
      const change = clone(changeValue), previous = change.previous;
      if (previous) M.validateState({ schemaVersion: 1, groups: { [previous.id]: previous } });
      const definition = M.validateDefinition(change.definition);
      const id = previous?.id || host.uuid();
      if (!Array.isArray(change.members) || !change.members.length) fail("no-members");
      const members = [], targets = [], problems = [], previousRules = [], physical = new Set();
      for (const entry of change.members) {
        try {
          const old = previous?.members.find(m => m.id === entry.memberId);
          if (old && old.accountId !== entry.accountId) fail("account-binding-changed");
          const o = await inspect(entry.accountId, old?.accountIdentityHash);
          if (physical.has(o.a.physicalKey)) fail("shared-rules-file");
          physical.add(o.a.physicalKey);
          const memberId = old?.id || host.uuid();
          const owned = o.replicas.filter(r => same(r.marker, { groupId: id, memberId }));
          const selector = entry.create && change.reviewed ? null : entry.selector || (old ? { kind: "owned", groupId: id, memberId } : null);
          let before = null;
          if (selector) {
            before = selected(o, selector);
            if (selector.kind === "explicit" && await M.fingerprint(before.rule) !== selector.fingerprint) fail("stale-selection");
            if (before.marker && !same(before.marker, { groupId: id, memberId })) fail("already-owned");
          }
          if (old && !change.reviewed && (!before || await M.fingerprint(before.rule) !== old.lastAppliedFingerprint)) fail("native-drift");
          const mode = entry.detach ? "detach" : before ? before.marker ? "replace" : "adopt" : "create";
          const cleanup = owned.filter(r => r !== before);
          if (mode === "create" && owned.length) fail("replica-already-exists");
          if (cleanup.length && (!old || !change.reviewed || selector?.kind !== "explicit")) fail("duplicate-marker");
          if (entry.detach && !old) fail("unknown-member");
          if (mode === "create" && old && !change.reviewed) fail("missing-replica");
          if (mode !== "detach" && (mode !== "replace" || before.rule.name !== definition.name) &&
            o.replicas.some(r => r !== before && !cleanup.includes(r) && r.rule.name === definition.name)) fail("name-collision");
          const position = before ? before.position : entry.position ?? o.replicas.length;
          if (!Number.isSafeInteger(position) || position < 0 || position > o.replicas.length) fail("invalid-position");
          const after = mode === "detach" ? { ...before, marker: null } : {
            accountId: entry.accountId, accountIdentityHash: o.identity, position,
            ...split(host.build(o.a, definition, entry.folderMappings, { groupId: id, memberId }).raw),
          };
          members.push({ id: memberId, accountId: entry.accountId, accountIdentityHash: o.identity,
            folderMappings: entry.folderMappings, positionHint: position, lastAppliedRevision: old?.lastAppliedRevision ?? null,
            lastAppliedFingerprint: old?.lastAppliedFingerprint ?? null, status: "updating", lastInspectedAt: old?.lastInspectedAt ?? null });
          targets.push({ memberId, mode, before, after, expectedListFingerprint: o.fingerprint, status: "pending",
            ...(cleanup.length ? { cleanup } : {}) });
          if (before) {
            try { previousRules.push({ memberId, ...host.exportRule(join(before)) }); }
            catch { previousRules.push({ memberId, unsupported: true }); }
          }
        } catch (error) { problems.push({ accountId: entry.accountId, code: safeCode(error) }); }
      }
      if (problems.length) return { ok: false, problems };
      const group = { id, revision: previous ? previous.revision + 1 : 1, definition, members,
        operation: { id: host.uuid(), kind: change.kind || (previous ? "update" : "create"), desiredRevision: previous ? previous.revision + 1 : 1,
          beforeDefinition: previous?.definition || null, targets, startedAt: currentTime() }, lastCompleted: previous?.lastCompleted || null };
      const state = { schemaVersion: 1, groups: previous ? { [id]: previous } : {} };
      M.beginChange(state, group, previous?.revision ?? null);
      return { ok: true, group, previousRules };
    }
    async function applyReplica(groupValue, memberId) {
      const g = M.validateState({ schemaVersion: 1, groups: { [groupValue.id]: groupValue } }).groups[groupValue.id];
      const target = g.operation?.targets.find(t => t.memberId === memberId);
      if (!target) fail("unknown-target");
      const member = g.members.find(m => m.id === memberId);
      const result = (status, errorCode, snapshot) => ({ status, inspectedAt: currentTime(),
        ...(errorCode ? { errorCode } : {}), ...(snapshot ? { snapshot } : {}) });
      try {
        const { o, observation } = await observeTarget(target);
        const decision = M.classifyRecovery(target, observation);
        if (decision.status === "applied") return result("applied", null, observation.replicas[0]);
        if (decision.action === "wait" || decision.action === "review") return result(decision.status === "pending" ? "failed" : decision.status, decision.reason);
        // Fresh native candidates are reconstructed from validated portable data;
        // persisted raw URIs are comparison evidence, never write instructions.
        const built = target.mode === "detach" ? null : host.build(o.a, g.definition, member.folderMappings, target.after.marker);
        if (built && !same(split(built.raw), { marker: target.after.marker, rule: target.after.rule })) fail("dependency-changed");
        const current = observation.replicas[0] || null;
        const position = current?.position ?? target.after.position;
        if (position > o.replicas.length) fail("placement-changed");
        if (!current && o.replicas.some(r => r.rule.name === target.after.rule.name)) fail("name-collision");
        // No await from this final compare through replacement, save and readback.
        const freshAccount = host.account(member.accountId);
        if (!same(freshAccount.identity, o.a.identity) || freshAccount.physicalKey !== o.a.physicalKey) fail("account-identity-changed");
        const reason = host.reason(freshAccount); if (reason) fail(reason);
        if (host.openWindow(freshAccount)) fail("editor-open");
        const live = host.live(freshAccount, o.disk.bytes);
        if (!same(host.snapshotList(live), o.disk.list)) fail("live-disk-conflict");
        const persistent = host.listFilters(live).filter(f => !f.temporary);
        const all = host.listFilters(live);
        const original = current ? persistent[position] : null;
        const liveIndex = position < persistent.length ? all.indexOf(persistent[position]) : all.length;
        const expected = clone(o.disk.list);
        const after = { ...target.after, position };
        if (current) expected.filters[position] = join(after); else expected.filters.splice(position, 0, join(after));
        const originalDescription = original?.filterDesc;
        const cleanup = (target.cleanup || []).map(r => ({ filter: persistent[r.position], description: join(r).description, r }));
        for (const { r } of cleanup) expected.filters[r.position] = { ...join(r), description: r.rule.description };
        let attempted = false, savedError = null;
        try {
          attempted = true;
          for (const { filter, r } of cleanup) filter.filterDesc = r.rule.description;
          if (target.mode === "detach") original.filterDesc = target.after.rule.description;
          else {
            built.filter.filterList = live;
            if (original) live.setFilterAt(liveIndex, built.filter); else live.insertFilterAt(liveIndex, built.filter);
          }
          live.saveToDefaultFile();
        } catch (error) { savedError = error; }
        let saved;
        try { saved = host.read(freshAccount); } catch { /* An unreadable result is uncertain, never a claimed rollback. */ }
        if (saved && same(saved.list, expected)) return result("applied", savedError ? "save-reported-error" : null, after);
        if (attempted) {
          try {
            for (const { filter, description } of cleanup) filter.filterDesc = description;
            if (target.mode === "detach") original.filterDesc = originalDescription;
            else if (original) live.setFilterAt(liveIndex, original);
            else if (host.listFilters(live).includes(built.filter)) live.removeFilter(built.filter);
          } catch { return result("uncertain", "live-restore-failed"); }
        }
        return saved && same(saved.list, o.disk.list) ? result("failed", "save-failed") : result("uncertain", "persistence-uncertain");
      } catch (error) {
        const code = safeCode(error);
        return result(code === "account-unavailable" ? "unavailable" : code === "editor-open" ? "failed" : "conflict", code);
      }
    }
    async function appendRule(groupValue, conditions) {
      const g = M.validateState({ schemaVersion: 1, groups: { [groupValue.id]: groupValue } }).groups[groupValue.id];
      const batch = normalizeConditions(conditions);
      for (const member of g.members) {
        try { const a = host.account(member.accountId); return host.append(a, g.definition, member.folderMappings, batch); }
        catch (error) { if (safeCode(error) !== "account-unavailable") throw error; }
      }
      fail("account-unavailable");
    }
    async function editRuleDraft(accountId, definition, mappings, windowId) {
      const o = await inspect(accountId);
      return host.edit(o.a, M.validateDefinition(definition), clone(mappings), windowId);
    }
    return { inspectAccounts, readRule, inspectReplicas, prepareSharedChange: prepare, applyReplica, appendRule, editRuleDraft };
  };
})(this);
