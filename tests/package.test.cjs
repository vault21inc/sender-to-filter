const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");

test("production XPI contains the complete matching runtime and no test or development payload", () => {
  execFileSync("bash", ["scripts/build.sh"], { cwd: root });
  const source = JSON.parse(fs.readFileSync(path.join(root, "manifest.json")));
  const archive = `dist/sender-to-filter-${source.version}.xpi`;
  const contents = JSON.parse(execFileSync("python3", ["-c", `
import hashlib, json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
 assert z.testzip() is None
 print(json.dumps({n:hashlib.sha256(z.read(n)).hexdigest() for n in z.namelist() if not n.endswith('/')}))
`, archive], { cwd: root, encoding: "utf8" }));
  const expected = [];
  function walk(file) { const full = path.join(root, file); if (fs.statSync(full).isDirectory()) {
    for (const child of fs.readdirSync(full)) if (child !== ".DS_Store") walk(`${file}/${child}`);
  } else expected.push(file); }
  for (const file of ["manifest.json", "background.js", "api", "lib", "options", "_locales", "LICENSE", "icons"]) walk(file);
  assert.deepEqual(Object.keys(contents).sort(), expected.sort());
  for (const file of expected) assert.equal(contents[file], crypto.createHash("sha256").update(fs.readFileSync(path.join(root, file))).digest("hex"), file);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "package.json"))).version, source.version);
  for (const file of [...source.background.scripts, source.options_ui.page,
    source.experiment_apis.senderToFilter.schema, source.experiment_apis.senderToFilter.parent.script,
    "api/senderToFilter/shared.js", "api/senderToFilter/shared-native.js", "options/shared-filters.js", "options/shared-filters.css"]) assert.ok(contents[file], file);
  assert.deepEqual(Object.keys(source.experiment_apis), ["senderToFilter"]);
  assert.equal(source.options_ui.open_in_tab, true);
  assert.ok(!Object.keys(contents).some(file => /(^|\/)(tests|native|scripts|plans|node_modules)(\/|$)/u.test(file)));
});
