"use strict";
(async () => {
  const checks = [];
  let version;
  let shared;
  const check = (name, condition, details) => {
    if (!condition) throw new Error(name + (details ? `: ${JSON.stringify(details)}` : ""));
    checks.push(name);
  };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const wanted = value => ({ op: "is", value });
  try {
    const stage = await browser.nativeTest.sharedPhase();
    version = stage.version;
    const spaceChecks = await browser.nativeTest.checkSharedSpace();
    if (!Array.isArray(spaceChecks)) throw new Error(JSON.stringify(spaceChecks));
    checks.push(...spaceChecks.map(name => stage.phase === "restart" ? `restart: ${name}` : name));
    if (stage.phase === "restart") {
      shared = await browser.nativeTest.checkSharedPrerequisites("restart");
      checks.push(...shared.checks);
      const recovered = createSharedCoordinator({ model: SenderToFilterSharedModel, storage: browser.storage.local, native: browser.senderToFilter });
      const view = await recovered.start();
      check("production shared state and native replicas survive restart", Object.keys(view.state.groups).length === 1 &&
        Object.values(view.observations).flat().every(r => r.status === "current"), view);
      await browser.nativeTest.finish({ ok: shared.ok, version, checks, shared });
      return;
    }
    const fixture = await browser.nativeTest.setup();
    version = fixture.version;
    const folder = fixture.folder;
    const target = { index: 0, name: "Main" };
    const api = browser.senderToFilter;
    const before = await browser.nativeTest.inspect();
    const listed = await api.listFilters(folder, [wanted("new@example.com")]);
    check("production Experiment schema and namespace load", listed.length === 5);
    check("native AND and ALL filters are ineligible", listed.find(f => f.name === "AND").reason === "and-logic" &&
      listed.find(f => f.name === "ALL").reason === "match-all");
    check("disabled native filter stays eligible", listed.find(f => f.name === "Disabled").eligible);
    const added = await api.addConditions(folder, target, [wanted("new@example.com"), wanted("old@example.com")]);
    check("native batch result", added.status === "ok" && same(added.added, ["new@example.com"]) && same(added.existing, ["old@example.com"]));
    const after = await browser.nativeTest.inspect();
    check("saved rules reload with the same conditions", same(after.live, after.disk) && after.live.terms.length === 3, after);
    check("actions, enabled state and execution types preserved", after.live.actionCount === before.live.actionCount &&
      after.live.enabled === before.live.enabled && after.live.filterType === before.live.filterType);
    check("native Is matches the exact mailbox and excludes suffix matches", after.nativeMatch.exact && !after.nativeMatch.longer);
    check("native Is also matches an exactly equal display name", after.nativeMatch.displayName);
    const duplicate = await api.addConditions(folder, target, [wanted("new@example.com")]);
    const duplicateState = await browser.nativeTest.inspect();
    check("duplicate is a no-op on disk", duplicate.status === "ok" && duplicate.added.length === 0 && duplicateState.file === after.file);

    await browser.nativeTest.setFailingDestination(true);
    const failed = await api.addConditions(folder, target, [wanted("retry@example.com")]);
    await browser.nativeTest.setFailingDestination(false);
    const restored = await browser.nativeTest.inspect();
    check("real save failure is reported", failed.status === "error" && failed.added.length === 0, failed);
    check("save failure restores live rules and leaves original file unchanged", same(restored.live, after.live) && restored.file === after.file);
    const retry = await api.addConditions(folder, target, [wanted("retry@example.com")]);
    const retried = await browser.nativeTest.inspect();
    check("retry succeeds and persists exactly once", retry.status === "ok" && retry.added.length === 1 &&
      same(retried.live, retried.disk) && retried.live.terms.filter(t => t.value === "retry@example.com").length === 1);
    check("localization substitutions work in Thunderbird", browser.i18n.getMessage("notifyResult", ["2", "1", "Fixture"]) ===
      "Added 2, already present 1, to ‘Fixture’.");
    await api.enableFilterTags();
    const tagChecks = await browser.nativeTest.checkFilterTags();
    if (!Array.isArray(tagChecks)) throw new Error(JSON.stringify(tagChecks));
    checks.push(...tagChecks);
    if (stage.phase === "seed") {
      shared = await browser.nativeTest.checkSharedPrerequisites("seed");
      checks.push(...shared.checks);
      if (!shared.ok) throw new Error(shared.error);
      const fixture = await browser.nativeTest.setupSharedProduction();
      if (!Array.isArray(fixture)) throw new Error(JSON.stringify(fixture));
      const catalog = await api.inspectAccounts();
      const sourceAccount = catalog.accounts.find(a => a.accountId === fixture[0].accountId);
      check("production native adapter rejects hard-linked rules files", catalog.accounts.filter(a => a.name.includes("hardlink-")).every(a => a.reason === "shared-rules-file"));
      check("production native adapter recognizes independent accounts", !sourceAccount.reason &&
        !catalog.accounts.find(a => a.accountId === fixture[1].accountId).reason, catalog.accounts);
      const filter = sourceAccount.filters.find(f => f.name === "Shared production");
      check("production native rule export is eligible", !filter.reason, filter);
      const selector = { kind: "explicit", index: filter.index, name: filter.name, fingerprint: filter.fingerprint };
      const source = await api.readRule(fixture[0].accountId, selector);
      const slot = source.definition.actions.find(a => a.slotId).slotId;
      for (const mode of ["cancel", "close", "accept"]) {
        await browser.nativeTest.armSharedDraft(mode);
        const edited = await api.editRuleDraft(fixture[0].accountId, source.definition, source.mappings, null);
        check(`production detached native editor ${mode} obeys draft contract`, mode === "accept"
          ? !edited.canceled && edited.definition.name === source.definition.name + " edited" && !edited.mappingReviewRequired
          : edited.canceled, edited);
        const unchanged = await api.readRule(fixture[0].accountId, selector);
        check(`production detached native editor ${mode} leaves saved source unchanged`, unchanged.fingerprint === source.fingerprint);
      }
      const copySlot = crypto.randomUUID();
      const allActions = [{type:"MoveToFolder",slotId:slot},{type:"CopyToFolder",slotId:copySlot},
        {type:"AddTag",tagKey:catalog.tags[0].key},{type:"ChangePriority",priority:5},{type:"JunkScore",junkScore:100},
        ...["MarkRead","MarkUnread","MarkFlagged","Delete","StopExecution","KillThread","KillSubthread","WatchThread"].map(type=>({type}))];
      for (const filterType of [1,16,32,64,128,256]) {
        const prepared = await api.prepareSharedChange({previous:null,kind:"create",reviewed:false,
          definition:{...source.definition,name:`Action matrix ${filterType}`,filterType,actions:allActions},
          members:fixture.map(f=>({accountId:f.accountId,folderMappings:{[slot]:f,[copySlot]:f}}))});
        check(`production native preparation preserves all 13 actions for trigger ${filterType} on IMAP and POP`,
          prepared.ok && prepared.group.operation.targets.every(t=>t.after.rule.actions.length===13),prepared);
      }
      const coordinator = createSharedCoordinator({ model: SenderToFilterSharedModel, storage: browser.storage.local, native: api });
      await coordinator.start();
      const preview = await coordinator.preview({ definition: source.definition, members: [
        { accountId: fixture[0].accountId, selector, folderMappings: source.mappings },
        { accountId: fixture[1].accountId, folderMappings: { [slot]: fixture[1] } },
      ] });
      check("production cross-account preview succeeds without writes", preview.ok, preview);
      let view = await coordinator.commit(preview.token);
      let group = Object.values(view.state.groups)[0];
      check("production coordinator creates and verifies both saved copies", !group.operation && view.observations[group.id].every(r => r.status === "current"), view);
      await api.enableSharedFilterIndicators();
      const indicatorChecks = await browser.nativeTest.checkSharedFilterIndicators(fixture.map(f => f.accountId));
      if (!Array.isArray(indicatorChecks)) throw new Error(JSON.stringify(indicatorChecks));
      checks.push(...indicatorChecks);
      const ordinary = await api.addConditions({ accountId: fixture[0].accountId, path: "/" }, { index: 0, name: filter.name }, [wanted("bypass@example.com")]);
      check("ordinary sender API cannot bypass shared ownership", ordinary.status === "ineligible" && ordinary.reason === "managed-target", ordinary);
      const appended = await coordinator.append(group.id, group.revision, [wanted("shared@example.com")]);
      group = appended.state.groups[group.id];
      check("production shared sender append updates both accounts", appended.added.length === 1 && !group.operation &&
        appended.observations[group.id].every(r => r.status === "current"), appended);
      const duplicate = await coordinator.append(group.id, group.revision, [wanted("shared@example.com")]);
      check("production shared duplicate keeps revision unchanged", duplicate.added.length === 0 && duplicate.state.groups[group.id].revision === group.revision);
      await browser.nativeTest.duplicateSharedProduction(fixture[0].accountId);
      check("production duplicate markers block automatic synchronization", (await coordinator.scan()).observations[group.id][0].reason === "duplicate-marker");
      const duplicated = (await api.inspectAccounts()).accounts.find(a => a.accountId === fixture[0].accountId).filters[0];
      const repair = await coordinator.preview({groupId:group.id,revision:group.revision,resolve:true,definition:group.definition,
        members:group.members.map((m,i)=>({accountId:m.accountId,memberId:m.id,folderMappings:m.folderMappings,
          ...(i ? {} : {selector:{kind:"explicit",index:duplicated.index,name:duplicated.name,fingerprint:duplicated.fingerprint}})}))});
      check("production duplicate cleanup requires the selected-copy preview", repair.ok && repair.group.operation.targets[0].cleanup.length === 1,repair);
      view = await coordinator.commit(repair.token); group = view.state.groups[group.id];
      check("production duplicate cleanup keeps one managed copy and one independent copy", !group.operation &&
        (await api.inspectAccounts()).accounts.find(a => a.accountId === fixture[0].accountId).filters.filter(f => f.marker).length === 1);
      const unlink = await coordinator.preview({ groupId: group.id, revision: group.revision, resolve: true, definition: group.definition,
        members: group.members.map((m, i) => ({ accountId: m.accountId, memberId: m.id, folderMappings: m.folderMappings, detach: i === 1 })) });
      check("production unlink preview succeeds", unlink.ok, unlink);
      view = await coordinator.commit(unlink.token); group = view.state.groups[group.id];
      check("production unlink retains the native rule and removes membership", group.members.length === 1 && !group.operation &&
        (await api.inspectAccounts()).accounts.find(a => a.accountId === fixture[1].accountId).filters.some(f => f.name === group.definition.name && !f.marker));
      const runFixture = await browser.nativeTest.setupSharedRunFixtures();
      if (!Array.isArray(runFixture)) throw new Error(JSON.stringify(runFixture));
      const runSource = (await api.inspectAccounts()).accounts.find(a => a.accountId === runFixture[0].accountId).filters[0];
      const runSelector = { kind: "explicit", index: runSource.index, name: runSource.name, fingerprint: runSource.fingerprint };
      const runRule = await api.readRule(runFixture[0].accountId, runSelector);
      const runSlot = runRule.definition.actions.find(a => a.slotId).slotId;
      const runPreview = await coordinator.preview({ definition: runRule.definition, members: runFixture.slice(0, 2).map((f, i) => ({
        accountId: f.accountId, folderMappings: { [runSlot]: f }, ...(i ? {} : { selector: runSelector }),
      })) });
      if (!runPreview.ok) throw new Error(JSON.stringify(runPreview));
      const runView = await coordinator.commit(runPreview.token); let runGroup = runView.state.groups[runPreview.group.id];
      const runChecks = await browser.nativeTest.checkSharedManualRun(runFixture.map(f => f.accountId));
      if (!Array.isArray(runChecks)) throw new Error(JSON.stringify(runChecks));
      checks.push(...runChecks);
      check("manual message execution preserves shared rule state", (await api.inspectReplicas(runGroup)).every(r => r.status === "current"));
      const enabledPreview = await coordinator.preview({ groupId: runGroup.id, revision: runGroup.revision,
        // Only manual filtering: fixture insertion must not trigger delivery-time actions.
        definition: { ...runGroup.definition, enabled: true, filterType: 16 }, members: runGroup.members.map(m => ({
          accountId: m.accountId, memberId: m.id, folderMappings: m.folderMappings,
        })) });
      if (!enabledPreview.ok) throw new Error(JSON.stringify(enabledPreview));
      const enabledView = await coordinator.commit(enabledPreview.token); runGroup = enabledView.state.groups[runGroup.id];
      const enabledChecks = await browser.nativeTest.checkEnabledSharedRun(runFixture.map(f => f.accountId));
      if (!Array.isArray(enabledChecks)) throw new Error(JSON.stringify(enabledChecks));
      checks.push(...enabledChecks);
      check("Run all enabled preserves shared rule state", (await api.inspectReplicas(runGroup)).every(r => r.status === "current"));
      const cleanupRun = await coordinator.preview({ groupId: runGroup.id, revision: runGroup.revision, resolve: true,
        definition: runGroup.definition, members: runGroup.members.map(m => ({ memberId: m.id, accountId: m.accountId, folderMappings: m.folderMappings, detach: true })) });
      if (!cleanupRun.ok) throw new Error(JSON.stringify(cleanupRun));
      await coordinator.commit(cleanupRun.token);
    }
    await browser.nativeTest.finish({ ok: true, version, checks, ...(shared ? { shared } : {}) });
  } catch (error) {
    await browser.nativeTest.finish({ ok: false, version, checks, ...(shared ? { shared } : {}), error: String(error), stack: error.stack });
  }
})();
