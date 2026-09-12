"use strict";
(async () => {
  const checks = [];
  let version;
  const check = (name, condition, details) => {
    if (!condition) throw new Error(name + (details ? `: ${JSON.stringify(details)}` : ""));
    checks.push(name);
  };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const wanted = value => ({ op: "is", value });
  try {
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
    await browser.nativeTest.finish({ ok: true, version, checks });
  } catch (error) {
    await browser.nativeTest.finish({ ok: false, version, checks, error: String(error), stack: error.stack });
  }
})();
