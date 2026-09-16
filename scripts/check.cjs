const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
for (const dir of ["api/senderToFilter", "lib", "options"]) {
  for (const name of fs.readdirSync(dir).filter(name => name.endsWith(".js"))) execFileSync(process.execPath, ["--check", `${dir}/${name}`], { stdio: "inherit" });
}
execFileSync(process.execPath, ["--check", "background.js"], { stdio: "inherit" });
for (const path of ["manifest.json", "api/senderToFilter/schema.json", "_locales/en/messages.json"]) JSON.parse(fs.readFileSync(path));
