import { afterEach, describe, expect, it } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { evaluateAudit } from "./audit-policy.mjs";

const scripts = dirname(fileURLToPath(import.meta.url));
function report(findings = {}) {
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
  for (const v of Object.values(findings)) { counts[v.severity]++; counts.total++; }
  return { auditReportVersion: 2, vulnerabilities: findings, metadata: { vulnerabilities: counts } };
}
function finding(severity) {
  return { name: "pkg", severity, isDirect: true, range: "1.0.0",
    nodes: ["node_modules/pkg"], effects: [], via: [{ source: 1, name: "pkg",
      dependency: "pkg", title: "Example advisory", range: "1.0.0",
      url: "https://example.org/advisory", severity }] };
}
const affected = (severity = "high") => report({ pkg: finding(severity) });
const result = (r) => ({ stdout: JSON.stringify(r), status: r.metadata.vulnerabilities.high || r.metadata.vulnerabilities.critical ? 1 : 0 });

describe("audit findings", () => {
  for (const severity of ["high", "critical"]) {
    for (const scope of ["full", "production"]) {
      it(`blocks ${severity} findings in the ${scope} report`, () => {
        const audits = { full: result(report()), production: result(report()) };
        audits[scope] = result(affected(severity));
        expect(() => evaluateAudit(audits)).toThrow();
      });
    }
  }
  it("allows valid findings below the configured threshold", () => {
    expect(evaluateAudit({ full: result(affected("moderate")), production: result(report()) }))
      .toEqual({ result: "PASS", exceptionUsed: false });
  });
  for (const [label, change] of [
    ["version", r => { r.auditReportVersion = 3; }],
    ["missing counts", r => { delete r.metadata.vulnerabilities.high; }],
    ["inconsistent total", r => { r.metadata.vulnerabilities.total++; }],
    ["hidden high severity", r => { r.vulnerabilities.pkg.via[0].severity = "high"; }],
    ["missing findings", r => { delete r.vulnerabilities; }],
    ["incorrect findings shape", r => { r.vulnerabilities = []; }],
    ["missing advisory", r => { r.vulnerabilities.pkg.via = []; }],
    ["malformed advisory", r => { r.vulnerabilities.pkg.via = [{}]; }],
    ["unknown edge", r => { r.vulnerabilities.pkg.via = ["missing"]; }],
  ]) it(`rejects ${label} even with a zero tool exit`, () => {
    const r = affected("low"); change(r);
    expect(() => evaluateAudit({ full: { stdout: JSON.stringify(r), status: 0 }, production: result(report()) })).toThrow();
  });
  it("rejects an inconsistent exit status", () => {
    expect(() => evaluateAudit({ full: { stdout: JSON.stringify(report()), status: 1 }, production: result(report()) })).toThrow();
  });
});

const owned = [];
afterEach(() => { for (const dir of owned.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function cli({ full = result(affected()), production = result(report()), stderr = "", removeNpm = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "relayium-audit-policy-")); owned.push(root);
  const web = join(root, "web"), bin = join(root, "bin"), evidence = join(root, "evidence");
  mkdirSync(join(web, "scripts"), { recursive: true }); mkdirSync(bin);
  copyFileSync(join(scripts, "audit-policy.mjs"), join(web, "scripts/audit-policy.mjs"));
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
  it("rejects development findings and retains both raw reports", () => {
    const r = cli();
    expect(r.status).toBe(1);
    expect(readFileSync(join(r.evidence, "full.json"), "utf8")).toBe(result(affected()).stdout);
    expect(readFileSync(join(r.evidence, "production.json"), "utf8")).toBe(result(report()).stdout);
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
    ["production vulnerability", { production: result(affected()) }],
  ]) it(`fails closed for ${name} and keeps subprocess evidence`, () => {
    const r = cli(args); expect(r.status).toBe(1);
    expect(readFileSync(join(r.evidence, "full-exit.json"), "utf8")).toBeTruthy();
    expect(readFileSync(join(r.evidence, "production-exit.json"), "utf8")).toBeTruthy();
  });
});
