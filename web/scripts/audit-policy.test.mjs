import { afterEach, describe, expect, it } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { evaluateAudit } from "./audit-policy.mjs";

const scripts = dirname(fileURLToPath(import.meta.url));
const policy = JSON.parse(readFileSync(join(scripts, "audit-exceptions.json"), "utf8"));
const lockBytes = readFileSync(join(scripts, "../package-lock.json"));
const now = Date.parse("2026-11-19T00:00:00Z");
const clone = (v) => structuredClone(v);
function report(findings = {}) {
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
  for (const v of Object.values(findings)) { counts[v.severity]++; counts.total++; }
  return { auditReportVersion: 2, vulnerabilities: findings, metadata: { vulnerabilities: counts } };
}
const approved = () => report(clone(policy.expectedFindings));
const result = (r) => ({ stdout: JSON.stringify(r), status: r.metadata.vulnerabilities.high || r.metadata.vulnerabilities.critical ? 1 : 0 });
const input = () => ({ full: result(approved()), production: result(report()), lockBytes, policy: clone(policy), now });

describe("owner-approved development audit exception", () => {
  it("accepts only the bound dev graph and names the exception", () => {
    expect(evaluateAudit(input())).toMatchObject({ exceptionUsed: true, expiresAt: "2026-11-25T00:00:00Z" });
  });
  it("normal clean audits still pass after the exception expires", () => {
    const i = input(); i.full = result(report()); i.now = Date.parse(policy.expiresAt);
    expect(evaluateAudit(i)).toEqual({ result: "PASS", exceptionUsed: false });
  });
  for (const [name, change] of [
    ["expiry boundary", (i) => { i.now = Date.parse(policy.expiresAt); }],
    ["after expiry", (i) => { i.now = Date.parse(policy.expiresAt) + 1; }],
    ["missing approval", (i) => { delete i.policy.authorization; }],
    ["approval false", (i) => { i.policy.authorization.ownerApproved = false; }],
    ["future approval", (i) => { i.policy.authorization.approvedAt = "2026-11-20T00:00:00Z"; }],
    ["invalid clock", (i) => { i.now = NaN; }],
    ["extended deadline", (i) => { i.policy.expiresAt = "2026-11-26T00:00:00Z"; }],
    ["different advisory", (i) => { i.policy.advisory += "-other"; }],
    ["lockfile drift", (i) => { i.lockBytes = Buffer.concat([lockBytes, Buffer.from("\n")]); }],
    ["changed lock fingerprint", (i) => { i.policy.lockSha256 = "0".repeat(64); }],
    ["full fetch failure", (i) => { i.full = { stdout: '{"error":{"code":"E503"}}', status: 1 }; }],
    ["production fetch failure", (i) => { i.production.status = 2; }],
    ["malformed JSON", (i) => { i.full.stdout = "not JSON"; }],
    ["unknown report version", (i) => { const r = approved(); r.auditReportVersion = 3; i.full = result(r); }],
    ["contradictory tool exit", (i) => { i.full.status = 0; }],
    ["production exposure", (i) => { i.production = result(approved()); }],
    ["missing severity counts", (i) => { const r = approved(); delete r.metadata.vulnerabilities.high; i.full = result(r); }],
    ["missing findings", (i) => { const r = approved(); delete r.vulnerabilities; i.full = result(r); }],
    ["array findings", (i) => { const r = approved(); r.vulnerabilities = []; i.full = result(r); }],
    ["unexpected graph", (i) => { const r = approved(); r.vulnerabilities.vite.range = "changed"; i.full = result(r); }],
    ["unknown edge", (i) => { const r = approved(); r.vulnerabilities.vite.via = ["unknown"]; i.full = result(r); }],
    ["cyclic graph", (i) => { const r = approved(); r.vulnerabilities.vite.via = ["vite"]; i.full = result(r); }],
    ["malformed advisory", (i) => { const r = approved(); r.vulnerabilities.picomatch.via = [{}]; i.full = result(r); }],
    ["high severity hidden under low counts", (i) => {
      const f = clone(policy.expectedFindings); for (const v of Object.values(f)) v.severity = "low";
      i.full = result(report(f));
    }],
    ["another dependency location even if the manifest is broadened", (i) => {
      const r = approved(); r.vulnerabilities.fdir.nodes = ["node_modules/vite"];
      i.policy.expectedFindings = clone(r.vulnerabilities); i.full = result(r);
    }],
    ["a second advisory hidden in the manifest", (i) => {
      const r = approved(); r.vulnerabilities.picomatch.via[0].url = "https://github.com/advisories/GHSA-other";
      i.policy.expectedFindings = clone(r.vulnerabilities); i.full = result(r);
    }],
    ["another critical vulnerability", (i) => {
      const f = clone(policy.expectedFindings); f.other = { ...clone(f.picomatch), name: "other", severity: "critical" };
      i.full = result(report(f));
    }],
    ["another high vulnerability", (i) => {
      const f = clone(policy.expectedFindings); f.other = { ...clone(f.picomatch), name: "other" };
      i.full = result(report(f));
    }],
  ]) it(`blocks ${name}`, () => { const i = input(); change(i); expect(() => evaluateAudit(i)).toThrow(); });
});

const owned = [];
afterEach(() => { for (const dir of owned.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function cli({ full = result(approved()), production = result(report()), stderr = "", removeNpm = false, badPolicy = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "relayium-audit-policy-")); owned.push(root);
  const web = join(root, "web"), bin = join(root, "bin"), evidence = join(root, "evidence");
  mkdirSync(join(web, "scripts"), { recursive: true }); mkdirSync(bin);
  copyFileSync(join(scripts, "audit-policy.mjs"), join(web, "scripts/audit-policy.mjs"));
  writeFileSync(join(web, "scripts/audit-exceptions.json"), badPolicy ? "oops" : JSON.stringify(policy));
  writeFileSync(join(web, "package-lock.json"), lockBytes);
  const replies = join(root, "replies.json"); writeFileSync(replies, JSON.stringify({ full, production, stderr }));
  if (!removeNpm) writeFileSync(join(bin, "npm"), `#!${process.execPath}\n` +
    `import fs from 'node:fs';\nconst v=JSON.parse(fs.readFileSync(${JSON.stringify(replies)},'utf8'));\n` +
    `const a=process.argv.slice(2); if(JSON.stringify(a)!==JSON.stringify(['audit','--json','--audit-level=high',...(a.includes('--omit=dev')?['--omit=dev']:[])]))process.exit(9);\n` +
    `const r=a.includes('--omit=dev')?v.production:v.full; process.stdout.write(r.stdout); process.stderr.write(v.stderr); process.exitCode=r.status;\n`, { mode: 0o755 });
  // Node treats extensionless scripts as CJS without a package marker.
  writeFileSync(join(bin, "package.json"), '{"type":"module"}');
  const out = spawnSync(process.execPath, [join(web, "scripts/audit-policy.mjs"), "--evidence-dir", evidence],
    { env: { ...process.env, PATH: bin }, encoding: "utf8", timeout: 5000 });
  return { ...out, evidence };
}
describe("real audit CLI subprocess and evidence boundary", () => {
  it("collects both raw reports and transparently reports approved use (or expiry)", () => {
    const r = cli();
    const active = Date.now() < Date.parse(policy.expiresAt);
    expect(r.status).toBe(active ? 0 : 1);
    expect(readFileSync(join(r.evidence, "full.json"), "utf8")).toBe(result(approved()).stdout);
    expect(readFileSync(join(r.evidence, "production.json"), "utf8")).toBe(result(report()).stdout);
    if (active) expect(JSON.parse(readFileSync(join(r.evidence, "verdict.json"), "utf8")).exceptionUsed).toBe(true);
  });
  it("clean audit succeeds without consuming an exception", () => {
    const r = cli({ full: result(report()) }); expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ result: "PASS", exceptionUsed: false });
  });
  for (const [name, args] of [
    ["npm unavailable", { removeNpm: true }],
    ["non-audit npm exit", { full: { stdout: "{}", status: 42 } }],
    ["malformed npm JSON", { full: { stdout: "{", status: 1 } }],
    ["network error report", { full: { stdout: '{"error":{"code":"E503"}}', status: 1 } }],
    ["tool error alongside old findings", { stderr: "npm error E503 audit service unavailable" }],
    ["production vulnerability", { production: result(approved()) }],
    ["malformed authorization policy", { badPolicy: true }],
  ]) it(`fails closed for ${name} and keeps subprocess evidence`, () => {
    const r = cli(args); expect(r.status).toBe(1);
    expect(readFileSync(join(r.evidence, "full-exit.json"), "utf8")).toBeTruthy();
    expect(readFileSync(join(r.evidence, "production-exit.json"), "utf8")).toBeTruthy();
  });
});
