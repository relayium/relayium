// Require full and production audits to pass the high-severity gate.
// Raw reports and subprocess outcomes are retained even when evaluation refuses.
import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const levels = ["info", "low", "moderate", "high", "critical"];
const require = (ok, message) => { if (!ok) throw new Error(message); };
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

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
  return high;
}

export function evaluateAudit({ full, production }) {
  const allHigh = parseReport(full.stdout, full.status, "full");
  const prodHigh = parseReport(production.stdout, production.status, "production");
  require(prodHigh === 0, "production high/critical vulnerabilities block release");
  require(allHigh === 0, "development high/critical vulnerabilities block release");
  return { result: "PASS", exceptionUsed: false };
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
  const verdict = evaluateAudit({ full, production });
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
