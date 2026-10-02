// npm run check: typecheck, syntax-check every browser module, and refuse to ship secrets.
import { execSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const run = (cmd) => execSync(cmd, { stdio: "inherit" });
run("npx tsc --noEmit -p .");

const web = ["apps/web/app.js", "apps/web/sw.js", ...readdirSync("apps/web/modules").filter((f) => f.endsWith(".js")).map((f) => join("apps/web/modules", f))];
for (const f of web) run(`node --check ${f}`);

// Secret scan over tracked files: API keys and the like must live in .env only.
const files = execSync("git ls-files", { encoding: "utf8" }).split("\n").filter((f) => f && !/\.(png|jpg|webp|ico|lock)$|package-lock\.json|vendor\//.test(f));
const PATTERNS = [/AQ\.Ab8[A-Za-z0-9_-]{20,}/, /sk-ant-[A-Za-z0-9_-]{30,}/, /nvapi-[A-Za-z0-9_-]{30,}/, /AIza[0-9A-Za-z_-]{35}/, /ghp_[A-Za-z0-9]{36}/, /-----BEGIN (RSA |EC )?PRIVATE KEY-----/, /BIRUNI_INITIAL_PIN=\d{4,}/];
const hits = [];
for (const f of files) {
  let txt;
  try { txt = readFileSync(f, "utf8"); } catch { continue; }
  for (const p of PATTERNS) if (p.test(txt)) hits.push(`${f}: matches ${p}`);
}
if (hits.length) {
  console.error("Possible secrets in tracked files:\n" + hits.join("\n"));
  process.exit(1);
}
console.log(`check: typecheck ok, ${web.length} browser files ok, ${files.length} files scanned for secrets`);
