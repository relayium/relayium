/**
 * 无障碍扫描共用的那一层：axe 注入、规则口径、允许清单、结果格式化。
 *
 * 单独成文件的理由和当初抽出 harness.mjs 一模一样：这套东西迟早要挂到
 * lan-transfer / mixed-link 的同意卡上去，抄第二份之后两份必然漂移，而漂移的那一份
 * 会安静地变成一个测不出东西的假绿。
 *
 * 这里不认识任何具体页面：目标表归 a11y-scan.mjs，共用的只有"怎么问 axe，以及
 * 怎么判一条结果算不算失败"。
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * 评审口径：WCAG 2.0 / 2.1 / 2.2 的 A 与 AA。
 *
 * 按 tag 圈定范围**不是**压制违规——它是一条写下来的、可被复核的验收线。真正的压制
 * 长成 `rules: { 'color-contrast': { enabled: false } }` 那样，这个文件里没有那种东西，
 * 允许清单也在结构上写不出来（见 loadAllowlist）。
 */
export const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/**
 * 在 WCAG A/AA 之外**逐条点名**加进来的 best-practice 规则。
 *
 * 每一条都得有理由；没有理由的不许进这张表——否则它就退化成"把 axe 全打开"，
 * 噪声会淹掉真问题，然后所有人开始往允许清单里塞东西。
 */
export const EXTRA_RULES = {
  "aria-dialog-name": "弹窗没有可访问名时，读屏只会念一句“对话框”，用户不知道自己进了什么",
  "aria-progressbar-name": "传输进度条报得出百分比，却报不出这是什么的进度",
  "aria-allowed-role": "挂在不允许该角色的元素上的 role，浏览器/读屏的处理各不相同",
  "landmark-one-main": "读屏用户跳到主内容靠的就是它",
  "landmark-unique": "两个同名地标等于没有地标",
  region: "落在所有地标之外的内容，用地标导航永远到不了",
  "heading-order": "标题层级是读屏用户的目录",
  "page-has-heading-one": "同上，没有 h1 的页面没有入口",
  "empty-heading": "空标题会在目录里留下一个念不出内容的条目",
  "link-in-text-block": "正文里只靠颜色区分的链接，色觉障碍用户看不出它是链接",
};

/** axe.min.js 的源码。只从 node_modules 读——它是开发依赖，永远不进产物。 */
export function readAxeSource() {
  try {
    return readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
  } catch (err) {
    throw new Error(`cannot read axe-core from node_modules (run \`npm ci\` in web/) — ${err.message}`);
  }
}

/** 装在 package.json 里的 axe 版本；报告要打印它，否则结果没法复现。 */
export function axeVersion() {
  return require("axe-core/package.json").version;
}

/**
 * 把 axe 注入这个标签页并跑一次。
 *
 * 注入走 CDP 的 Runtime.evaluate，**不是**往页面里插 `<script>`：插标签会撞上生产
 * 的 CSP（script-src 没有 'unsafe-inline'），而为了让扫描跑起来去松 CSP，等于用测试
 * 去削弱被测对象。DevTools 侧的求值不受页面 CSP 管，一行已发的响应头都不用动。
 *
 * 结果在**页面内**就收敛成一个小结构再回传：axe 的完整结果里 passes 那一堆能有几 MB，
 * 整个搬过 CDP 既慢又没用。
 */
export async function runAxe(tab, { context = "document", extraRuleIds = Object.keys(EXTRA_RULES) } = {}) {
  const injected = await tab.evaluate(
    `${readAxeSource()}\n;typeof window.axe !== "undefined" && typeof window.axe.run === "function";`,
  );
  if (injected !== true) throw new Error("axe did not install itself on window");

  const result = await tab.evaluate(`(async () => {
    const tags = ${JSON.stringify(WCAG_TAGS)};
    const extra = ${JSON.stringify(extraRuleIds)};
    const known = new Set(axe.getRules().map((r) => r.ruleId));
    // 打错一个规则名就静默少测一条规则 —— 那正是"看起来全绿"的来源，所以直接报错。
    const unknown = extra.filter((id) => !known.has(id));
    if (unknown.length) throw new Error("unknown axe rule id(s): " + unknown.join(", "));

    // 先按 tag 解析出规则 id 再显式合并 extra：axe 的 runOnly 一旦按 tag 圈定，
    // rules:{id:{enabled:true}} 是加不回被圈掉的规则的，只有按 rule 列表才作数。
    const ids = new Set(axe.getRules(tags).map((r) => r.ruleId));
    for (const id of extra) ids.add(id);

    const res = await axe.run(${context === "document" ? "document" : JSON.stringify(context)}, {
      runOnly: { type: "rule", values: [...ids] },
      resultTypes: ["violations", "incomplete"],
    });
    const pack = (list) => list.map((r) => ({
      id: r.id,
      impact: r.impact || "unknown",
      help: r.help,
      helpUrl: r.helpUrl,
      nodes: r.nodes.map((n) => ({
        target: n.target.flat(Infinity).join(" >>> "),
        html: (n.html || "").replace(/\\s+/g, " ").slice(0, 180),
        summary: (n.failureSummary || n.any?.[0]?.message || "").replace(/\\s+/g, " ").slice(0, 300),
      })),
    }));
    return {
      engine: res.testEngine?.version ?? "unknown",
      ruleCount: ids.size,
      violations: pack(res.violations),
      incomplete: pack(res.incomplete),
    };
  })()`);
  return result;
}

/**
 * 在**真场景脚本**里当场扫一格：违规立刻抛，incomplete 只打印。
 *
 * 和静态扫描器的分工是清楚的：静态那套扫的是"页面长什么样"，这一个扫的是"两个真
 * 浏览器之间跑到某个状态时长什么样"——同意卡、进行中的进度条、消息记录。那些状态
 * 静态扫描器**永远到不了**（它没有对端，也没有信令服务器），而它们恰好是这个产品
 * 里最需要读屏的地方：用户正在这里做信任决策。
 *
 * 这里**不读允许清单**，是有意的。允许清单是给静态目标记账用的，条目精确到目标名和
 * 选择器；把它也接到这里，等于给真场景开一条"可以静音"的口子，而这些状态本来就少、
 * 本来就该干净。所以这一层只有一种结果：有违规就红。
 */
export async function scanLiveState(tab, label, { context = "document" } = {}) {
  const res = await runAxe(tab, { context });
  const nodes = res.violations.flatMap((rule) => rule.nodes.map((node) => ({ rule, node })));
  if (nodes.length) {
    const detail = nodes.map((f) => formatFinding(f, "      ")).join("\n");
    throw new Error(`${label}: ${nodes.length} accessibility violation node(s)\n${detail}`);
  }
  const incomplete = res.incomplete.reduce((n, rule) => n + rule.nodes.length, 0);
  const rules = [...new Set(res.incomplete.map((r) => r.id))];
  console.log(
    `  \x1b[32m✓\x1b[0m ${label} — axe clean` +
      (incomplete ? ` ${DIM}(${incomplete} incomplete: ${rules.join(", ")} — needs a human, not a failure)${OFF}` : ""),
  );
  return res;
}

// ── 允许清单 ────────────────────────────────────────────────────────────────
//
// 一条被允许的违规必须精确到"哪个目标、哪条规则、哪个节点"，并且带理由、负责人和
// 到期日。三种情况一律判红：没被条目认领的违规、**这一轮什么都没匹配到**的陈旧条目、
// 过期条目。宽泛条目在校验阶段就被拒掉。
//
// 换句话说：这张表只能用来"记账"，不能用来"消音"。

const REQUIRED_KEYS = ["target", "rule", "selector", "reason", "owner", "expires"];
const RULE_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * 把 `expires` 解析成 UTC 当天的最后一刻；不是一个**真实存在**的日期就返回 null。
 *
 * 不能直接 `new Date("2026-02-31T23:59:59Z")`：JS 会悄悄把它规范化成 3 月 3 日，于是
 * 一个打错的到期日会安静地把有效期延后几天。到期日是这张表唯一的自动清理机制，
 * 它多活一天，被记账的违规就多活一天——所以这里回读年月日，对不上就判无效。
 *
 * 时区同样钉死在 UTC：用本地时区的话，同一条条目在不同机器上的过期时刻会差一天，
 * 也就会出现"我这儿是绿的"。
 */
export function parseExpiry(value) {
  const m = typeof value === "string" ? ISO_DATE.exec(value) : null;
  if (!m) return null;
  const [, y, mo, d] = m.map(Number);
  const at = new Date(Date.UTC(y, mo - 1, d, 23, 59, 59, 999));
  if (at.getUTCFullYear() !== y || at.getUTCMonth() !== mo - 1 || at.getUTCDate() !== d) return null;
  return at;
}

export function loadAllowlist(path, { today = new Date() } = {}) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`allowlist ${path} is not readable JSON — ${err.message}`);
  }
  if (!raw || !Array.isArray(raw.entries)) throw new Error(`allowlist ${path} must be an object with an "entries" array`);

  const problems = [];
  const entries = raw.entries.map((entry, i) => {
    const where = `entries[${i}]`;
    const keys = Object.keys(entry ?? {});
    for (const k of REQUIRED_KEYS) if (typeof entry?.[k] !== "string" || !entry[k].trim()) problems.push(`${where}.${k} is required and must be a non-empty string`);
    for (const k of keys) if (!REQUIRED_KEYS.includes(k)) problems.push(`${where}.${k} is not a recognised field`);
    // 宽泛条目 = 一条能盖住将来还没出现的问题的条目。它是允许清单最常见的腐烂方式。
    for (const k of ["target", "rule", "selector"]) {
      const v = entry?.[k];
      if (typeof v === "string" && (v.includes("*") || v.trim() === "")) problems.push(`${where}.${k} is too broad ("${v}") — entries must name one exact target/rule/node`);
    }
    if (typeof entry?.rule === "string" && !RULE_ID.test(entry.rule)) problems.push(`${where}.rule must be a single axe rule id, got "${entry.rule}"`);
    const expiry = parseExpiry(entry?.expires);
    if (!expiry) problems.push(`${where}.expires must be an existing calendar date in YYYY-MM-DD form, got "${entry?.expires}"`);
    return { ...entry, expiry, index: i, matched: 0 };
  });
  if (problems.length) throw new Error(`allowlist ${path} is invalid:\n    - ${problems.join("\n    - ")}`);

  const expired = entries.filter((e) => e.expiry < today);
  return { entries, expired };
}

/**
 * 把一个目标的违规分成"被认领的"和"要判红的"，同时给认领它的条目记一笔。
 *
 * 只对 violations 生效。incomplete 是"机器算不出来，要人看"，用允许清单去认领它会
 * 让那些条目永远匹配得上，也就永远不会因为陈旧而暴露。
 */
export function applyAllowlist(targetId, violations, allowlist) {
  const failures = [];
  const allowed = [];
  for (const rule of violations) {
    for (const node of rule.nodes) {
      const hit = allowlist.entries.find(
        (e) => e.target === targetId && e.rule === rule.id && e.selector === node.target,
      );
      if (hit) {
        hit.matched++;
        allowed.push({ targetId, rule, node, entry: hit });
      } else {
        failures.push({ targetId, rule, node });
      }
    }
  }
  return { failures, allowed };
}

// ── 输出 ────────────────────────────────────────────────────────────────────

const RED = "\x1b[31m";
const YEL = "\x1b[33m";
const DIM = "\x1b[2m";
const OFF = "\x1b[0m";

/** 一条可以直接照着修的失败行：规则、影响面、选择器、节点、axe 的说明链接。 */
export function formatFinding({ rule, node }, indent = "    ") {
  return [
    `${indent}${rule.id} ${DIM}(${rule.impact})${OFF} — ${rule.help}`,
    `${indent}  at: ${node.target}`,
    `${indent}  ${DIM}${node.html}${OFF}`,
    node.summary ? `${indent}  ${node.summary}` : null,
    `${indent}  ${DIM}${rule.helpUrl}${OFF}`,
  ].filter(Boolean).join("\n");
}

/**
 * incomplete 默认**只聚合**，不逐节点展开。
 *
 * 展开的话这一屏就有三百多条，其中 273 条是同一句"背景是渐变，算不出对比度"——那不是
 * 三百个问题，是一个。把它们逐条列出来只会把真正要修的 violation 冲下屏幕，然后所有人
 * 学会跳过这段输出，连带跳过 violation。低噪声不是少测，是别把同一件事说三百遍。
 *
 * 完整数据一条不少地留在 --json 的机读产物里；要在终端看全，用 --verbose-incomplete。
 */
const INCOMPLETE_SAMPLES = 2;

export function printIncomplete(byTarget, { verbose = false } = {}) {
  const total = [...byTarget.values()].reduce((n, list) => n + list.length, 0);
  if (!total) return total;
  console.log(`\n${YEL}INCOMPLETE — axe could not decide; a human must (not a failure) (${total})${OFF}`);
  if (verbose) {
    for (const [targetId, list] of byTarget) {
      if (!list.length) continue;
      console.log(`\n  ${targetId}`);
      for (const f of list) console.log(formatFinding(f));
    }
    return total;
  }
  console.log(`  ${DIM}aggregated; --verbose-incomplete expands every node, --json keeps them all${OFF}`);
  for (const [targetId, list] of byTarget) {
    if (!list.length) continue;
    const byRule = new Map();
    for (const f of list) {
      if (!byRule.has(f.rule.id)) byRule.set(f.rule.id, { impact: f.rule.impact, reasons: new Map(), samples: [] });
      const bucket = byRule.get(f.rule.id);
      // 按"为什么算不出来"再分一层：真正要人看的是原因，不是节点。
      const reason = (f.node.summary.replace(/^Fix any of the following:\s*/, "") || "no reason given").slice(0, 90);
      bucket.reasons.set(reason, (bucket.reasons.get(reason) ?? 0) + 1);
      if (bucket.samples.length < INCOMPLETE_SAMPLES) bucket.samples.push(f.node.target);
    }
    console.log(`\n  ${targetId}`);
    for (const [ruleId, bucket] of byRule) {
      const n = [...bucket.reasons.values()].reduce((a, b) => a + b, 0);
      console.log(`    ${ruleId} ${DIM}(${bucket.impact})${OFF} × ${n}`);
      for (const [reason, count] of bucket.reasons) console.log(`      ${count}× ${reason}`);
      console.log(`      ${DIM}e.g. ${bucket.samples.join(" | ")}${OFF}`);
    }
  }
  return total;
}

/** 按目标分组打印，因为修的时候就是一个页面一个页面修的。 */
export function printGrouped(label, byTarget, color) {
  const total = [...byTarget.values()].reduce((n, list) => n + list.length, 0);
  if (!total) return total;
  console.log(`\n${color}${label} (${total})${OFF}`);
  for (const [targetId, list] of byTarget) {
    if (!list.length) continue;
    console.log(`\n  ${targetId}`);
    for (const f of list) console.log(formatFinding(f));
  }
  return total;
}

export const colors = { RED, YEL, DIM, OFF };
