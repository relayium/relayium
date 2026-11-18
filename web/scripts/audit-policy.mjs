// Keep npm's high-severity gate, with one owner-approved, expiring dev exception.
// Raw reports and subprocess outcomes are retained even when evaluation refuses.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const levels = ["info", "low", "moderate", "high", "critical"];
const require = (ok, message) => { if (!ok) throw new Error(message); };
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const approvedNames = ["@sveltejs/vite-plugin-svelte", "fdir", "picomatch", "svelte-check", "tinyglobby", "vite", "vitest"];

function parseReport(raw, exit, label) {
  require(exit === 0 || exit === 1, `${label}: audit tool did not complete normally`);
  const report = JSON.parse(raw);
  require(object(report) && !Object.hasOwn(report, "error") && report.auditReportVersion === 2,
    `${label}: unsupported or failed audit report`);
  require(object(report.vulnerabilities) && object(report.metadata?.vulnerabilities),
    `${label}: missing findings or counts`);
  const counts = Object.fromEntries(levels.map((level) => [level, 0]));
  for (const [name, finding] of Object.entries(report.vulnerabilities)) {
    require(object(finding) && finding.name === name && levels.includes(finding.severity),
      `${label}: malformed finding`);
    require(Array.isArray(finding.via) && finding.via.length > 0 &&
      Array.isArray(finding.nodes) && finding.nodes.length > 0 &&
      finding.nodes.every((node) => typeof node === "string") &&
      typeof finding.isDirect === "boolean" && typeof finding.range === "string" &&
      Array.isArray(finding.effects) && finding.effects.every((effect) => typeof effect === "string"),
    `${label}: incomplete finding`);
    for (const via of finding.via) {
      require(typeof via === "string" ? Object.hasOwn(report.vulnerabilities, via) :
        object(via) && Number.isSafeInteger(via.source) && via.source > 0 &&
        typeof via.name === "string" && typeof via.dependency === "string" &&
        typeof via.title === "string" && typeof via.range === "string" &&
        typeof via.url === "string" && levels.includes(via.severity), `${label}: malformed advisory edge`);
      const sourceSeverity = typeof via === "string" ? report.vulnerabilities[via]?.severity : via.severity;
      require(levels.includes(sourceSeverity) && levels.indexOf(finding.severity) >= levels.indexOf(sourceSeverity),
        `${label}: severity does not cover its advisory edges`);
    }
    counts[finding.severity]++;
  }
  for (const level of levels) {
    require(report.metadata.vulnerabilities[level] === counts[level], `${label}: inconsistent severity counts`);
  }
  require(report.metadata.vulnerabilities.total === Object.keys(report.vulnerabilities).length,
    `${label}: inconsistent total count`);
  const high = counts.high + counts.critical;
  require(exit === (high ? 1 : 0), `${label}: audit exit and findings disagree`);
  return { report, high };
}

export function evaluateAudit({ full, production, lockBytes, policy, now = Date.now() }) {
  const all = parseReport(full.stdout, full.status, "full");
  const prod = parseReport(production.stdout, production.status, "production");
  require(prod.high === 0, "production high/critical vulnerabilities block release");
  if (all.high === 0) return { result: "PASS", exceptionUsed: false };

  require(object(policy) && policy.schema === 1 && policy.authorization?.ownerApproved === true,
    "exception lacks explicit owner authorization");
  // These are bounds, not caller-selectable allowlist identifiers or deadlines.
  require(policy.advisory === "https://github.com/advisories/GHSA-fc5q-39xc-vjpf" &&
    policy.package === "picomatch" && policy.version === "4.0.7" &&
    policy.expiresAt === "2026-11-25T00:00:00Z", "unexpected exception identity or deadline");
  const approved = Date.parse(policy.authorization.approvedAt);
  require(Number.isFinite(now) && Number.isFinite(approved) && approved <= now &&
    now < Date.parse(policy.expiresAt), "exception is expired or has an invalid approval time");
  require(policy.lockSha256 === "ac02c59503c8e77310838ee70eb0446dd027cd9b8788ed3d1e36fe44313d53f0" &&
    createHash("sha256").update(lockBytes).digest("hex") === policy.lockSha256,
    "lockfile drift: exception cannot apply");
  require(Object.keys(prod.report.vulnerabilities).length === 0,
    "exception requires a clean production dependency audit");
  const expected = policy.expectedFindings;
  require(object(expected) && Object.keys(expected).length === 7 && all.high === 7,
    "unexpected exception finding count");
  require(isDeepStrictEqual(Object.keys(all.report.vulnerabilities).sort(), approvedNames),
    "unexpected affected package set");
  const reachesApproved = (name, visiting = new Set()) => {
    require(!visiting.has(name), "cyclic audit graph");
    const next = new Set(visiting).add(name);
    const finding = all.report.vulnerabilities[name];
    require(finding.severity === "high", "unexpected advisory severity");
    for (const via of finding.via) {
      if (typeof via === "string") reachesApproved(via, next);
      else require(name === "picomatch" && via.url === policy.advisory &&
        via.source === 1247710 && via.name === "picomatch" && via.dependency === "picomatch" &&
        via.severity === "high" && via.range === "<=4.0.7", "unapproved advisory");
    }
  };
  for (const name of approvedNames) reachesApproved(name);
  const lock = JSON.parse(lockBytes.toString("utf8"));
  require(lock.lockfileVersion === 3 && object(lock.packages), "unsupported lockfile shape");
  const actual = {};
  for (const [name, finding] of Object.entries(all.report.vulnerabilities)) {
    // npm's proposed remediation may change; it never grants this exception.
    const { fixAvailable, ...identity } = finding;
    actual[name] = identity;
    require(finding.nodes.length === 1 && finding.nodes[0] === `node_modules/${name}`,
      "unexpected affected dependency location");
    for (const node of finding.nodes) {
      const pkg = lock.packages[node];
      require(pkg?.dev === true && !pkg.devOptional, "affected node is not strictly development-only");
      if (name === policy.package) require(pkg.version === policy.version, "unexpected vulnerable version");
    }
  }
  require(isDeepStrictEqual(actual, expected), "audit graph changed or contains another vulnerability");
  return { result: "PASS_WITH_APPROVED_EXCEPTION", exceptionUsed: true,
    advisory: policy.advisory, expiresAt: policy.expiresAt, lockSha256: policy.lockSha256 };
}

export function runAudit({ webRoot, evidenceDir }) {
  mkdirSync(evidenceDir, { recursive: true });
  const collect = (name, args) => {
    const result = spawnSync("npm", ["audit", "--json", "--audit-level=high", ...args],
      { cwd: webRoot, encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    writeFileSync(join(evidenceDir, `${name}.json`), result.stdout ?? "", { flag: "wx" });
    writeFileSync(join(evidenceDir, `${name}.stderr`), result.stderr ?? "", { flag: "wx" });
    writeFileSync(join(evidenceDir, `${name}-exit.json`), JSON.stringify({ status: result.status,
      signal: result.signal, error: result.error?.code ?? null }), { flag: "wx" });
    return result;
  };
  const full = collect("full", []);
  const production = collect("production", ["--omit=dev"]);
  require(!full.error && !production.error && !full.signal && !production.signal, "audit subprocess failed");
  require(![full, production].some((r) => /\bnpm (?:ERR!|error)(?:\s|$)/i.test(r.stderr ?? "")),
    "npm reported an audit tool error");
  const verdict = evaluateAudit({ full, production,
    lockBytes: readFileSync(join(webRoot, "package-lock.json")),
    policy: JSON.parse(readFileSync(join(webRoot, "scripts/audit-exceptions.json"), "utf8")) });
  writeFileSync(join(evidenceDir, "verdict.json"), JSON.stringify(verdict, null, 2) + "\n", { flag: "wx" });
  return verdict;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    require(process.argv.length === 4 && process.argv[2] === "--evidence-dir", "usage: audit-policy.mjs --evidence-dir DIR");
    const verdict = runAudit({ webRoot: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
      evidenceDir: resolve(process.argv[3]) });
    console.log(JSON.stringify(verdict));
    if (verdict.exceptionUsed) console.warn(`Approved DEV-ONLY audit exception: ${verdict.advisory}; expires ${verdict.expiresAt}`);
  } catch (error) {
    console.error(`Audit blocked: ${error.message}`);
    process.exitCode = 1;
  }
}
