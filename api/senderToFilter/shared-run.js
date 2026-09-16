/* MPL-2.0. Explicit manual runs; never edits rules or retries message actions. */
"use strict";
(function (exports) {
  exports.createSharedRunController = function (M, host) {
    const same = (a, b) => M.canonicalJson(a) === M.canonicalJson(b);
    const fail = code => { throw new M.ModelError(code); };
    const alive = control => { if (control.cancelled) fail("shared-run-cancelled"); };
    async function prepare(groups, selection, control) {
      const state = M.validateState({ schemaVersion: 1, groups: Object.fromEntries(groups.map(g => [g.id, g])) });
      const source = host.accountForList(selection.list);
      const current = host.listFilters(selection.list);
      if (!selection.filters.length || selection.filters.some(f => !current.includes(f))) fail("stale-selection");
      const wanted = new Map(), ordinary = [];
      for (const filter of selection.filters) {
        const marker = M.parseOwnership(filter.filterDesc || "");
        if (marker.status === "malformed") fail("malformed-marker");
        if (marker.status === "unmarked") { ordinary.push(filter); continue; }
        const g = state.groups[marker.groupId];
        if (!g?.members.some(m => m.id === marker.memberId && m.accountId === source.id)) fail("shared-run-unknown-link");
        if (g.operation) fail("unfinished-operation");
        wanted.set(g.id, g);
      }
      if (!wanted.size) fail("shared-run-no-selection");
      const observed = new Map(), jobs = new Map();
      async function inspect(id) {
        if (observed.has(id)) return observed.get(id);
        alive(control);
        const a = host.account(id), reason = host.reason(a); if (reason) fail(reason);
        if (host.openWindow(a, true)) fail("editor-open");
        const disk = host.read(a), list = host.live(a, disk.bytes);
        if (!same(host.snapshotList(list), disk.list)) fail("live-disk-conflict");
        const identityHash = await M.fingerprint(a.identity); alive(control);
        const value = { a, list, disk, identityHash, identity: M.canonicalJson(a.identity), filters: host.listFilters(list) };
        observed.set(id, value); return value;
      }
      function add(o, folder, filter, build = null) {
        if (!folder || folder.isServer || folder.server !== o.a.server) fail("shared-run-folder-unavailable");
        let job = jobs.get(folder.URI);
        if (!job) { job = { observed: o, folder, entries: [] }; jobs.set(folder.URI, job); }
        if (!job.entries.some(entry => entry.original === filter)) job.entries.push({
          original: filter, before: host.snapshot(filter), position: o.filters.indexOf(filter), build,
        });
      }
      const selectedSource = await inspect(source.id);
      if (selectedSource.list !== selection.list || selection.filters.some(f => !selectedSource.filters.includes(f))) fail("stale-selection");
      for (const g of wanted.values()) for (const member of g.members) {
        const o = await inspect(member.accountId);
        if (o.identityHash !== member.accountIdentityHash) fail("account-identity-changed");
        const owned = o.filters.filter(f => {
          const mark = M.parseOwnership(f.filterDesc || "");
          return mark.status === "marked" && mark.groupId === g.id && mark.memberId === member.id;
        });
        if (owned.length !== 1) fail(owned.length ? "duplicate-marker" : "missing-replica");
        const filter = owned[0], raw = host.snapshot(filter), marker = { groupId: g.id, memberId: member.id };
        const build = () => host.build(o.a, g.definition, member.folderMappings, marker);
        const rule = { ...raw, description: M.parseOwnership(raw.description).description };
        if (member.lastAppliedRevision !== g.revision || !same(raw, build().raw) ||
            await M.fingerprint(rule) !== member.lastAppliedFingerprint) fail("native-drift");
        alive(control); add(o, host.inbox(o.a), filter, build);
      }
      if (ordinary.length) {
        const o = await inspect(source.id);
        const folder = host.runFolder(selection.folder);
        for (const filter of ordinary) add(o, folder, filter);
      }
      for (const job of jobs.values()) job.entries.sort((a, b) => a.position - b.position);
      return { jobs: [...jobs.values()], selection };
    }
    function fresh(job, selection, control) {
      alive(control);
      if (selection.window?.closed) fail("shared-run-cancelled");
      const o = job.observed, a = host.account(o.a.id);
      if (M.canonicalJson(a.identity) !== o.identity || a.physicalKey !== o.a.physicalKey) fail("account-identity-changed");
      const reason = host.reason(a); if (reason) fail(reason);
      if (host.openWindow(a, true)) fail("editor-open");
      const live = host.live(a, o.disk.bytes);
      if (live !== o.list || !same(host.snapshotList(live), o.disk.list)) fail("live-disk-conflict");
      if (host.runFolder(job.folder) !== job.folder || job.folder.server !== a.server) fail("shared-run-folder-unavailable");
      return job.entries.map(entry => {
        if (!host.listFilters(live).includes(entry.original) || !same(host.snapshot(entry.original), entry.before)) fail("native-drift");
        if (!entry.build) return entry.original;
        const built = entry.build(); if (!same(built.raw, entry.before)) fail("dependency-changed");
        return built.filter;
      });
    }
    async function run(groups, selection, control) {
      let completed = 0, attempted = 0, total = 0, accountName = "";
      try {
        const plan = await prepare(groups, selection, control); total = plan.jobs.length;
        // A later account's preflight failure must not follow earlier actions.
        for (const job of plan.jobs) fresh(job, selection, control);
        for (const job of plan.jobs) {
          alive(control); accountName = job.observed.a.name;
          control.progress?.({ completed, total, accountName });
          const filters = fresh(job, selection, control);
          attempted++;
          await host.runFilters(job.folder, filters, job.observed.list, selection.window, control);
          alive(control); completed++;
        }
        return { ok: true, completed, total };
      } catch (error) {
        return { ok: false, completed, attempted, total, accountName,
          error: control.cancelled ? "shared-run-cancelled" : error instanceof M.ModelError ? error.code : "native-io-failed" };
      }
    }
    return { run };
  };
})(this);
