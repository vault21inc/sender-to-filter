const { test } = require("node:test");
const assert = require("node:assert/strict");
const { setup, plain } = require("./shared-helpers.cjs");
const { background } = require("./helpers.cjs");
test("native run requests use freshly read shared state while holding the coordinator queue", async () => {
  const h = setup(); const { group } = await h.seed(); let locked = false; const runs = [], cancelled = [];
  const app = background({ model: h.M, storage: plain(h.store), shared: { start: async () => {},
    exclusive: async fn => { locked = true; try { return await fn(); } finally { locked = false; } } },
    runSharedFilters: async (id, groups) => { assert.equal(locked, true); runs.push([id, groups]); },
    cancelSharedRun: async id => cancelled.push(id),
  });
  await app.requestSharedRun("native-click"); assert.equal(runs.length, 1); assert.equal(runs[0][1][0].id, group.id);
  app.storage[h.M.STORAGE_KEY] = { schemaVersion: 999, groups: {} };
  await app.requestSharedRun("blocked-click"); assert.equal(runs.length, 1); assert.deepEqual(cancelled, ["blocked-click"]);
});
